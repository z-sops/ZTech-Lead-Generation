'use strict';

const { stableId, newId } = require('../core/ids');
const { NotFoundError, ProviderError, ConflictError, DuplicateActiveJobError, ValidationError } = require('../core/errors');
const { normalizeDomain } = require('../core/urls');
const { toLeadView } = require('../contracts/leadView');
const { FIELD_NAMES, normalizeFieldValue, LEAD_FIELD_FOR } = require('./catalog');
const { validateEnrichmentResult } = require('./EnrichmentProvider');
const { selectFields } = require('./selection');

/**
 * EnrichmentService — persisted, resumable provider waterfall.
 *
 * Job states:  requested -> running -> complete | partial | no_result | failed | blocked
 *                              |  ^
 *                              v  |
 *                            pending      (a step is waiting to retry; next_attempt_at)
 *              complete | partial | no_result -> stale   (older than maxAgeDays)
 *
 * Step states (one step per provider, in waterfall order):
 *   queued -> running -> done | failed | blocked | retry_wait
 *   queued -> skipped (not registered / NOT_CONFIGURED / UNAVAILABLE / no supported field / missing input)
 *   queued -> not_needed (all fields found, or provider-call limit reached)
 *
 * Waterfall rules:
 *   - A field found by an earlier provider is not requested from later providers.
 *   - NOT_FOUND does not stop the waterfall for that field.
 *   - One provider's failure (auth, quota, timeout, outage, bad data) never fails the job;
 *     the waterfall continues with the next provider.
 *   - Stops when every requested field is found, providers run out, or
 *     config.maxProviderCalls is reached.
 *   - Every state change is persisted before the next provider call; after a restart,
 *     tick() resumes at the first unfinished step (a step left "running" is re-run —
 *     enrichment calls are reads).
 */

const ACTIVE = ['requested', 'running', 'pending'];
const TRANSITIONS = Object.freeze({
  requested: ['running', 'blocked'],
  running: ['running', 'pending', 'complete', 'partial', 'no_result', 'failed', 'blocked'],
  pending: ['running', 'failed'],
  complete: ['stale'],
  partial: ['stale'],
  no_result: ['stale'],
  failed: [],
  blocked: [],
  stale: [],
});
const DONEISH = ['done', 'failed', 'blocked', 'skipped', 'not_needed'];

function withTimeout(promise, ms, controller) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ProviderError('PROVIDER_TIMEOUT', 'Enrichment provider timed out', { retryable: true }));
      }, ms);
      if (timer.unref) timer.unref();
    }),
  ]).finally(() => clearTimeout(timer));
}

function observationId(o) {
  return stableId('obs', o.lead_id, o.provider_id, o.field, o.status, JSON.stringify(o.value), o.source_ref || '');
}

class EnrichmentService {
  constructor({ store, registry, leadSource, fieldMap, clock = () => new Date(), config = {}, logger = console }) {
    this.store = store;
    this.registry = registry;
    this.leadSource = leadSource;
    this.fieldMap = fieldMap;
    this.clock = clock;
    this.logger = logger;
    const defined = (o) => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => v !== undefined && v !== null));
    this.cfg = {
      maxAgeDays: 90,
      timeoutMs: 20000,
      maxProviderCalls: 10,
      defaultFields: FIELD_NAMES,
      ...defined(config),
      retry: { maxAttempts: 3, baseDelayMs: 30000, maxDelayMs: 10 * 60 * 1000, ...defined(config.retry) },
    };
    this._inflight = new Set();
    this._kicks = new Set();
    this._ticking = false;
  }

  _now() { return this.clock(); }
  _iso() { return this._now().toISOString(); }

  async _view(leadId) {
    const raw = await this.leadSource.getLead(leadId);
    if (!raw) throw new NotFoundError('Lead', leadId);
    return toLeadView(raw, this.fieldMap);
  }

  _fields(fields) {
    const list = fields && fields.length ? [...new Set(fields)] : [...this.cfg.defaultFields];
    const bad = list.filter((f) => !FIELD_NAMES.includes(f));
    if (bad.length) throw new ValidationError('unknown enrichment fields', bad.map((f) => ({ path: '$.fields', message: `unknown field ${f}` })));
    return list;
  }

  _providerOrder() {
    return this.registry.orderedIds();
  }

  async _selection(leadId, fields) {
    const obs = await this.store.enrichmentObservations.listByLead(String(leadId));
    return selectFields(obs, { now: this._now(), maxAgeDays: this.cfg.maxAgeDays, providerOrder: this._providerOrder(), fields });
  }

  /**
   * @returns {Promise<{outcome: 'started'|'already_active'|'fresh'|'blocked', job?: object, reason?: object}>}
   */
  async request({ leadId, fields, force = false }) {
    const view = await this._view(leadId);
    const wanted = this._fields(fields);

    const active = await this.store.enrichmentJobs.findActiveForLead(view.id);
    if (active) return { outcome: 'already_active', job: publicEnrichmentJob(active) };

    if (!force) {
      const sel = await this._selection(view.id, wanted);
      if (wanted.every((f) => sel[f].status === 'FOUND' && !sel[f].stale)) return { outcome: 'fresh' };
    }

    const candidates = this._providerOrder().filter((id) => {
      const p = this.registry.get(id);
      return p && p.capabilities().fields.some((f) => wanted.includes(f));
    });
    const now = this._iso();
    const base = {
      job_id: newId('ejob'), lead_id: view.id, fields: wanted, next_attempt_at: null, last_error_code: null,
      created_at: now, updated_at: now, finished_at: null, version: 1,
    };
    if (!candidates.length) {
      const job = { ...base, state: 'blocked', steps: [], last_error_code: 'NO_PROVIDER_CONFIGURED', finished_at: now };
      await this.store.enrichmentJobs.insert(job);
      return { outcome: 'blocked', job: publicEnrichmentJob(job), reason: { code: 'NO_PROVIDER_CONFIGURED', message: 'No configured enrichment provider supports the requested fields.' } };
    }
    const job = {
      ...base,
      state: 'requested',
      steps: candidates.map((id) => ({ provider_id: id, state: 'queued', fields_requested: [], fields_found: [], fields_not_found: [], rejected: [], attempts: 0, error_code: null, started_at: null, finished_at: null })),
    };
    try {
      await this.store.enrichmentJobs.insert(job);
    } catch (e) {
      if (e instanceof DuplicateActiveJobError) {
        const again = await this.store.enrichmentJobs.findActiveForLead(view.id);
        if (again) return { outcome: 'already_active', job: publicEnrichmentJob(again) };
      }
      throw e;
    }
    this._kick(job.job_id);
    return { outcome: 'started', job: publicEnrichmentJob(job) };
  }

  _kick(jobId) {
    const p = this.advance(jobId)
      .catch((e) => this.logger.error && this.logger.error(`[lead-intelligence] enrichment advance failed for ${jobId}: ${e && e.message}`))
      .finally(() => this._kicks.delete(p));
    this._kicks.add(p);
  }

  async idle() {
    while (this._kicks.size) await Promise.allSettled([...this._kicks]);
  }

  async _save(job, to, patch = {}) {
    if (to !== job.state && !(TRANSITIONS[job.state] || []).includes(to)) {
      const e = new ConflictError(`Invalid enrichment transition ${job.state} -> ${to}`);
      e.code = 'INVALID_TRANSITION';
      throw e;
    }
    const next = { ...job, ...patch, state: to, updated_at: this._iso(), version: job.version + 1 };
    if (['complete', 'partial', 'no_result', 'failed', 'blocked'].includes(to)) {
      next.finished_at = this._iso();
      next.next_attempt_at = null;
    }
    await this.store.enrichmentJobs.update(next, job.version);
    return next;
  }

  _due(job) {
    if (job.state === 'requested' || job.state === 'running') return true;
    return job.state === 'pending' && (!job.next_attempt_at || job.next_attempt_at <= this._iso());
  }

  async advance(jobId) {
    if (this._inflight.has(jobId)) return null;
    this._inflight.add(jobId);
    try {
      let job = await this.store.enrichmentJobs.get(jobId);
      for (let guard = 0; job && guard < 50 && this._due(job); guard += 1) {
        const next = await this._step(job);
        if (!next || next.version === job.version) break;
        job = next;
      }
      return job;
    } catch (e) {
      if (e instanceof ConflictError && e.code === 'CONFLICT') return this.store.enrichmentJobs.get(jobId);
      throw e;
    } finally {
      this._inflight.delete(jobId);
    }
  }

  async _step(job) {
    if (job.state === 'requested' || job.state === 'pending') return this._save(job, 'running', { next_attempt_at: null });
    return this._runNextStep(job);
  }

  _foundInJob(job) {
    return new Set(job.steps.flatMap((s) => s.fields_found));
  }

  async _runNextStep(job) {
    const found = this._foundInJob(job);
    const remaining = job.fields.filter((f) => !found.has(f));
    const steps = job.steps.map((s) => ({ ...s }));
    const idx = steps.findIndex((s) => !DONEISH.includes(s.state));
    const calls = steps.filter((s) => s.attempts > 0).length;

    if (!remaining.length || idx === -1 || (calls >= this.cfg.maxProviderCalls && steps[idx].attempts === 0)) {
      for (const s of steps) if (s.state === 'queued') s.state = 'not_needed';
      return this._finish(job, steps);
    }

    const step = steps[idx];
    const skip = async (code) => {
      step.state = 'skipped';
      step.error_code = code;
      step.finished_at = this._iso();
      return this._save(job, 'running', { steps });
    };

    const provider = this.registry.get(step.provider_id);
    if (!provider) return skip('NOT_REGISTERED');
    const status = await this.registry.statusOf(provider);
    if (status.state === 'NOT_CONFIGURED') return skip('NOT_CONFIGURED');
    if (status.state === 'UNAVAILABLE') return skip('UNAVAILABLE');

    const caps = provider.capabilities();
    const supported = remaining.filter((f) => caps.fields.includes(f));
    if (!supported.length) return skip('NO_SUPPORTED_FIELDS');

    const view = await this._view(job.lead_id);
    const d = view.website ? normalizeDomain(view.website) : { ok: false };
    const lead = { lead_id: view.id, name: view.name, domain: d.ok ? d.host : null, phone: view.phone, city: view.city, country: view.country };
    const missing = caps.requires.find((r) => (r === 'lead_id' ? false : !lead[r]));
    if (missing) return skip(`MISSING_INPUT_${missing.toUpperCase()}`);

    step.state = 'running';
    step.attempts += 1;
    step.fields_requested = supported;
    step.started_at = step.started_at || this._iso();
    let current = await this._save(job, 'running', { steps });

    const controller = new AbortController();
    let result;
    try {
      result = await withTimeout(Promise.resolve().then(() => provider.enrich({ lead, fields: supported, signal: controller.signal })), this.cfg.timeoutMs, controller);
    } catch (err) {
      return this._stepError(current, idx, err);
    }

    const steps2 = current.steps.map((s) => ({ ...s }));
    const s2 = steps2[idx];
    const check = validateEnrichmentResult(result);
    if (!check.valid) {
      s2.state = 'failed';
      s2.error_code = 'INVALID_RESULT';
      s2.finished_at = this._iso();
      return this._save(current, 'running', { steps: steps2 });
    }

    const collectedAt = this._iso();
    const byId = new Map();
    const rejected = [];
    for (const item of result.fields) {
      if (!supported.includes(item.field)) {
        rejected.push({ field: String(item.field).slice(0, 100), reason: 'FIELD_NOT_REQUESTED' });
        continue;
      }
      let value = null;
      if (item.status === 'FOUND') {
        const n = normalizeFieldValue(item.field, item.value);
        if (!n.ok) {
          rejected.push({ field: item.field, reason: n.reason });
          continue;
        }
        value = n.value;
      }
      const o = {
        lead_id: view.id,
        job_id: current.job_id,
        field: item.field,
        status: item.status,
        value,
        provider_id: provider.id,
        tier: caps.tier,
        source_ref: item.source_ref == null ? null : String(item.source_ref),
        provider_confidence: item.provider_confidence || null,
        collected_at: collectedAt,
      };
      o.observation_id = observationId(o);
      o.provenance_id = stableId('prov', o.observation_id);
      byId.set(o.observation_id, o);
    }
    const observations = [...byId.values()];
    if (observations.length) await this.store.enrichmentObservations.upsertMany(observations);

    s2.state = 'done';
    s2.fields_found = [...new Set(observations.filter((o) => o.status === 'FOUND').map((o) => o.field))];
    s2.fields_not_found = [...new Set(observations.filter((o) => o.status === 'NOT_FOUND').map((o) => o.field))].filter((f) => !s2.fields_found.includes(f));
    s2.rejected = rejected.slice(0, 50);
    s2.error_code = null;
    s2.finished_at = this._iso();
    current = await this._save(current, 'running', { steps: steps2 });
    return current;
  }

  async _stepError(job, idx, err) {
    const steps = job.steps.map((s) => ({ ...s }));
    const s = steps[idx];
    s.finished_at = this._iso();
    if (err instanceof ProviderError) {
      s.error_code = err.code;
      if (err.blocking) {
        s.state = 'blocked';
        return this._save(job, 'running', { steps });
      }
      if (err.retryable) {
        if (s.attempts < this.cfg.retry.maxAttempts) {
          s.state = 'retry_wait';
          s.finished_at = null;
          const delay = Math.min(this.cfg.retry.maxDelayMs, this.cfg.retry.baseDelayMs * 2 ** (s.attempts - 1));
          return this._save(job, 'pending', { steps, next_attempt_at: new Date(this._now().getTime() + delay).toISOString(), last_error_code: err.code });
        }
        s.state = 'failed';
        s.error_code = `RETRIES_EXHAUSTED:${err.code}`;
        return this._save(job, 'running', { steps });
      }
      s.state = 'failed';
      return this._save(job, 'running', { steps });
    }
    if (this.logger.error) this.logger.error(`[lead-intelligence] enrichment provider ${s.provider_id} threw an unexpected error: ${err && err.message}`);
    s.state = 'failed';
    s.error_code = 'PROVIDER_ERROR';
    return this._save(job, 'running', { steps });
  }

  async _finish(job, steps) {
    const found = new Set(steps.flatMap((s) => s.fields_found));
    const anyAnswer = steps.some((s) => s.state === 'done');
    const anyCalled = steps.some((s) => s.attempts > 0);
    let state;
    let code = null;
    if (job.fields.every((f) => found.has(f))) state = 'complete';
    else if (found.size) state = 'partial';
    else if (anyAnswer) state = 'no_result';
    else if (!anyCalled) { state = 'blocked'; code = 'NO_PROVIDER_AVAILABLE'; }
    else { state = 'failed'; code = 'ALL_PROVIDERS_FAILED'; }
    return this._save(job, state, { steps, last_error_code: code });
  }

  async tick() {
    if (this._ticking) return { skipped: true };
    this._ticking = true;
    try {
      const due = await this.store.enrichmentJobs.listDue(this._iso());
      for (const j of due) {
        try {
          await this.advance(j.job_id);
        } catch (e) {
          if (this.logger.error) this.logger.error(`[lead-intelligence] enrichment tick failed for ${j.job_id}: ${e && e.message}`);
        }
      }
      let staled = 0;
      const cutoff = this._now().getTime() - this.cfg.maxAgeDays * 24 * 60 * 60 * 1000;
      for (const j of await this.store.enrichmentJobs.listByStates(['complete', 'partial', 'no_result'])) {
        if (j.finished_at && Date.parse(j.finished_at) <= cutoff) {
          try {
            await this._save(j, 'stale');
            staled += 1;
          } catch (e) {
            if (!(e instanceof ConflictError)) throw e;
          }
        }
      }
      return { advanced: due.length, staled };
    } finally {
      this._ticking = false;
    }
  }

  recover() {
    return this.tick();
  }

  /** Field-level enrichment view for the Lead Profile. */
  async profile({ leadId }) {
    const view = await this._view(leadId);
    const fields = await this._selection(view.id, FIELD_NAMES);
    const jobs = await this.store.enrichmentJobs.listByLead(view.id);
    const values = Object.values(fields);
    return {
      lead_id: view.id,
      fields,
      summary: {
        found: values.filter((f) => f.status === 'FOUND').length,
        not_found: values.filter((f) => f.status === 'NOT_FOUND').length,
        unknown: values.filter((f) => f.status === 'UNKNOWN').length,
        stale: values.filter((f) => f.stale).length,
        conflicts: values.filter((f) => f.conflict).length,
      },
      latest_job: jobs[0] ? publicEnrichmentJob(jobs[0]) : null,
      jobs: jobs.slice(0, 20).map(publicEnrichmentJob),
      max_age_days: this.cfg.maxAgeDays,
    };
  }

  async status({ leadId }) {
    const view = await this._view(leadId);
    const jobs = await this.store.enrichmentJobs.listByLead(view.id);
    return { lead_id: view.id, job: jobs[0] ? publicEnrichmentJob(jobs[0]) : null };
  }

  async providers() {
    return this.registry.statuses();
  }

  /**
   * Values usable to fill empty lead-view fields for ICP. Only fresh, non-conflicting
   * FOUND values are returned; the Lead Library value always takes precedence.
   * @param {object[]} observations observations of ONE lead
   */
  enrichedForIcp(observations) {
    const sel = selectFields(observations, { now: this._now(), maxAgeDays: this.cfg.maxAgeDays, providerOrder: this._providerOrder(), fields: Object.keys(LEAD_FIELD_FOR) });
    const out = {};
    for (const [field, v] of Object.entries(sel)) {
      if (v.status !== 'FOUND' || v.stale || v.conflict) continue;
      out[LEAD_FIELD_FOR[field]] = {
        value: v.selected.value,
        enrichment_field: field,
        provider_id: v.selected.provider_id,
        provenance_id: v.selected.provenance_id,
        observation_id: v.selected.observation_id,
        source_ref: v.selected.source_ref,
        collected_at: v.selected.collected_at,
      };
    }
    return out;
  }
}

function publicEnrichmentJob(j) {
  return {
    job_id: j.job_id,
    lead_id: j.lead_id,
    state: j.state,
    fields: j.fields,
    steps: j.steps.map((s) => ({
      provider_id: s.provider_id, state: s.state, fields_requested: s.fields_requested, fields_found: s.fields_found,
      fields_not_found: s.fields_not_found, rejected: s.rejected, attempts: s.attempts, error_code: s.error_code,
      started_at: s.started_at, finished_at: s.finished_at,
    })),
    next_attempt_at: j.next_attempt_at,
    last_error_code: j.last_error_code,
    created_at: j.created_at,
    updated_at: j.updated_at,
    finished_at: j.finished_at,
  };
}

module.exports = { EnrichmentService, publicEnrichmentJob, ENRICHMENT_ACTIVE_STATES: ACTIVE, ENRICHMENT_TRANSITIONS: TRANSITIONS };
