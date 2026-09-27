'use strict';

const { newId, stableHash } = require('../core/ids');
const { ProviderError, ConflictError, DuplicateActiveJobError } = require('../core/errors');
const { normalizeDomain } = require('../core/urls');
const { assertTransition, isActive } = require('./stateMachine');
const { validateProviderResult } = require('../providers/ProspectResearchProvider');
const { buildEvidencePacket, validateEvidencePacket } = require('../contracts/evidencePacket');

/**
 * ResearchCoordinator — owns the persisted research state machine.
 *
 * Restart / reload / outage safety:
 * - Every state change is persisted (compare-and-set on job.version) BEFORE the next
 *   provider call. provider_job_id is stored as soon as the provider accepts the job.
 * - tick() resumes any job that is due (requested/preflight/started, or polling/pending
 *   whose next_attempt_at has passed). recover() is tick() at startup.
 * - The provider receives idempotencyKey = job_id, so a crash between "provider accepted"
 *   and "provider_job_id persisted" does not create a second provider job when the
 *   provider honours idempotency keys (VERIFY for Zuni-SEO; see docs/INTEGRATION_POINTS.md).
 * - One active job per (lead, domain, provider): enforced in the store (unique index).
 */

function requestKeyFor(leadId, domainKey, providerId) {
  return stableHash('research', String(leadId), domainKey || '', providerId);
}

class ResearchCoordinator {
  constructor({
    store,
    providers,
    freshness,
    clock = () => new Date(),
    identityForLead = async () => ({ identity: null, view: null }),
    onPacketStored = async () => {},
    retry = {},
    pollIntervalMs = 15000,
    maxPollDurationMs = 2 * 60 * 60 * 1000,
    limitedPageThreshold,
    logger = console,
  }) {
    this.store = store;
    this.providers = providers;
    this.freshness = freshness;
    this.clock = clock;
    this.identityForLead = identityForLead;
    this.onPacketStored = onPacketStored;
    this.retry = { maxAttempts: 5, baseDelayMs: 30000, maxDelayMs: 15 * 60 * 1000, ...retry };
    this.pollIntervalMs = pollIntervalMs;
    this.maxPollDurationMs = maxPollDurationMs;
    this.limitedPageThreshold = limitedPageThreshold;
    this.logger = logger;
    this._inflight = new Set();
    this._ticking = false;
  }

  _now() { return this.clock(); }
  _nowIso() { return this._now().toISOString(); }
  _later(ms) { return new Date(this._now().getTime() + ms).toISOString(); }

  _backoffMs(attempts) {
    return Math.min(this.retry.maxDelayMs, this.retry.baseDelayMs * 2 ** Math.max(0, attempts - 1));
  }

  _newJob({ leadId, providerId, domain, state, options = {}, errorCode = null, errorMessage = null }) {
    const now = this._nowIso();
    return {
      job_id: newId('rjob'),
      lead_id: String(leadId),
      provider_id: providerId,
      request_key: requestKeyFor(leadId, domain ? domain.key : null, providerId),
      requested_domain: domain ? domain.host : null,
      domain_key: domain ? domain.key : null,
      state,
      provider_job_id: null,
      attempts: 0,
      poll_count: 0,
      next_attempt_at: null,
      last_error_code: errorCode,
      last_error_message: errorMessage,
      packet_id: null,
      options,
      created_at: now,
      updated_at: now,
      started_at: null,
      finished_at: state === 'blocked' ? now : null,
      version: 1,
    };
  }

  /** Create (or return the already-active) job for this request. Never duplicates. */
  async createJob({ leadId, providerId, domain, options }) {
    const key = requestKeyFor(leadId, domain.key, providerId);
    const existing = await this.store.jobs.findActive(key);
    if (existing) return { job: existing, created: false };
    const job = this._newJob({ leadId, providerId, domain, state: 'requested', options });
    try {
      await this.store.jobs.insert(job);
    } catch (e) {
      if (e instanceof DuplicateActiveJobError) {
        const again = await this.store.jobs.findActive(key);
        if (again) return { job: again, created: false };
      }
      throw e;
    }
    return { job, created: true };
  }

  /** Persist a blocked attempt so the profile can show why research did not run. */
  async createBlockedJob({ leadId, providerId, domain = null, code, message }) {
    const job = this._newJob({ leadId, providerId, domain, state: 'blocked', errorCode: code, errorMessage: message });
    await this.store.jobs.insert(job);
    return job;
  }

  async _transition(job, to, patch = {}) {
    assertTransition(job.state, to);
    const next = { ...job, ...patch, state: to, updated_at: this._nowIso(), version: job.version + 1 };
    if (['complete', 'partial', 'failed', 'blocked'].includes(to)) {
      next.finished_at = this._nowIso();
      next.next_attempt_at = null;
    }
    await this.store.jobs.update(next, job.version);
    return next;
  }

  _isDue(job) {
    if (['requested', 'preflight', 'started'].includes(job.state)) return true;
    if (['polling', 'pending'].includes(job.state)) return !job.next_attempt_at || job.next_attempt_at <= this._nowIso();
    return false;
  }

  /**
   * Drive one job forward until it is waiting (polling/pending not yet due) or finished.
   * Safe to call concurrently: a second call for the same job returns immediately.
   */
  async advance(jobId) {
    if (this._inflight.has(jobId)) return null;
    this._inflight.add(jobId);
    try {
      let job = await this.store.jobs.get(jobId);
      for (let guard = 0; job && guard < 12 && this._isDue(job); guard += 1) {
        const next = await this._step(job);
        if (!next || next.version === job.version) break;
        job = next;
      }
      return job;
    } catch (e) {
      if (e instanceof ConflictError && e.code === 'CONFLICT') {
        // Another writer won; the job continues from its stored state on the next tick.
        return this.store.jobs.get(jobId);
      }
      throw e;
    } finally {
      this._inflight.delete(jobId);
    }
  }

  async _step(job) {
    const provider = this.providers.get(job.provider_id);
    if (!provider && isActive(job.state)) {
      if (job.state === 'requested') job = await this._transition(job, 'preflight');
      return this._toBlocked(job, 'PROVIDER_NOT_CONFIGURED', 'The research provider is not configured.');
    }
    try {
      switch (job.state) {
        case 'requested':
          return await this._transition(job, 'preflight');
        case 'preflight':
          return await this._preflightAndStart(job, provider);
        case 'started':
          return await this._transition(job, 'polling', { next_attempt_at: this._nowIso() });
        case 'polling':
          return await this._poll(job, provider);
        case 'pending':
          if (job.provider_job_id) return await this._transition(job, 'polling', { next_attempt_at: this._nowIso() });
          return await this._transition(job, 'preflight');
        default:
          return job;
      }
    } catch (e) {
      if (e instanceof ConflictError) throw e;
      // The step may have persisted intermediate states (e.g. preflight -> started)
      // before failing; always handle the error against the stored version.
      const current = (await this.store.jobs.get(job.job_id)) || job;
      return this._handleError(current, e);
    }
  }

  async _preflightAndStart(job, provider) {
    const pre = await provider.preflight({ domain: job.requested_domain });
    if (!pre || !pre.ok) {
      const code = (pre && pre.code) || 'PREFLIGHT_FAILED';
      if (pre && pre.blocking) return this._toBlocked(job, code, 'The research provider is not usable with the current configuration.');
      if (pre && pre.retryable) return this._toPendingOrFail(job, code, 'The research provider is temporarily unavailable.');
      return this._transition(job, 'failed', { last_error_code: code, last_error_message: 'The research provider refused the request.' });
    }
    const r = await provider.startResearch({ domain: job.requested_domain, idempotencyKey: job.job_id, options: job.options || {} });
    const started = await this._transition(job, 'started', {
      provider_job_id: r.providerJobId,
      started_at: this._nowIso(),
      attempts: 0,
      last_error_code: null,
      last_error_message: null,
    });
    if (r.status === 'complete' || r.status === 'partial') return this._finish(started, provider);
    if (r.status === 'failed') {
      return this._transition(started, 'failed', { last_error_code: 'PROVIDER_JOB_FAILED', last_error_message: 'The research provider reported that the job failed.' });
    }
    return this._transition(started, 'polling', { next_attempt_at: this._later(this.pollIntervalMs), poll_count: 0 });
  }

  async _poll(job, provider) {
    const r = await provider.pollResearch(job.provider_job_id);
    if (r.status === 'running') {
      const startedMs = Date.parse(job.started_at || job.created_at);
      if (this._now().getTime() - startedMs > this.maxPollDurationMs) {
        return this._transition(job, 'failed', { last_error_code: 'PROVIDER_TIMEOUT', last_error_message: 'Research did not finish within the allowed time.' });
      }
      return this._transition(job, 'polling', {
        next_attempt_at: this._later(this.pollIntervalMs),
        poll_count: (job.poll_count || 0) + 1,
        attempts: 0,
      });
    }
    if (r.status === 'complete' || r.status === 'partial') return this._finish(job, provider);
    return this._transition(job, 'failed', { last_error_code: 'PROVIDER_JOB_FAILED', last_error_message: 'The research provider reported that the job failed.' });
  }

  async _finish(job, provider) {
    const result = await provider.fetchResult(job.provider_job_id, { requestedDomain: job.requested_domain });
    const check = validateProviderResult(result);
    if (!check.valid) {
      this.logger.warn && this.logger.warn(`[lead-intelligence] provider ${provider.id} returned a malformed result for job ${job.job_id}`);
      return this._transition(job, 'failed', { last_error_code: 'MALFORMED_RESULT', last_error_message: 'The research provider returned data that does not match the contract.' });
    }
    const rd = normalizeDomain(result.requestedDomain);
    if (!rd.ok || rd.key !== job.domain_key) {
      return this._transition(job, 'failed', { last_error_code: 'DOMAIN_MISMATCH', last_error_message: 'The research result is for a different website than the lead.' });
    }
    const { identity, view } = (await this.identityForLead(job.lead_id)) || {};
    const packet = buildEvidencePacket({
      leadId: job.lead_id,
      jobId: job.job_id,
      identity: identity || null,
      provider: { id: provider.id, name: provider.name },
      result,
      freshness: this.freshness,
      now: this._now(),
      leadView: view || null,
      limitedPageThreshold: this.limitedPageThreshold,
    });
    const v = validateEvidencePacket(packet);
    if (!v.valid) {
      this.logger.warn && this.logger.warn(`[lead-intelligence] packet for job ${job.job_id} failed validation: ${v.errors.slice(0, 3).map((e) => `${e.path} ${e.message}`).join('; ')}`);
      return this._transition(job, 'failed', { last_error_code: 'PACKET_INVALID', last_error_message: 'The research result could not be turned into valid evidence.' });
    }
    await this.store.packets.insert(packet);
    const finalState = packet.research_status === 'failed' ? 'failed' : packet.research_status;
    const done = await this._transition(job, finalState, {
      packet_id: packet.packet_id,
      last_error_code: finalState === 'failed' ? 'RESEARCH_OUTCOME_FAILED' : null,
      last_error_message: finalState === 'failed' ? 'The research provider could not assess the website.' : null,
    });
    try {
      const previous = await this.store.packets.previousForLead(job.lead_id, packet.packet_id);
      await this.onPacketStored({ previous, packet });
    } catch (e) {
      this.logger.warn && this.logger.warn(`[lead-intelligence] post-packet processing failed for ${packet.packet_id}: ${e && e.message}`);
    }
    return done;
  }

  async _toBlocked(job, code, message) {
    return this._transition(job, 'blocked', { last_error_code: code, last_error_message: message });
  }

  async _toPendingOrFail(job, code, message) {
    const attempts = (job.attempts || 0) + 1;
    if (attempts >= this.retry.maxAttempts) {
      return this._transition(job, 'failed', { attempts, last_error_code: 'RETRIES_EXHAUSTED', last_error_message: `${message} Retries exhausted.` });
    }
    return this._transition(job, 'pending', {
      attempts,
      next_attempt_at: this._later(this._backoffMs(attempts)),
      last_error_code: code,
      last_error_message: message,
    });
  }

  async _handleError(job, err) {
    if (!isActive(job.state)) return job;
    if (err instanceof ProviderError) {
      if (err.blocking) return this._toBlocked(job, err.code, err.message);
      if (err.retryable) return this._toPendingOrFail(job, err.code, err.message);
      return this._transition(job, 'failed', { last_error_code: err.code, last_error_message: err.message });
    }
    this.logger.error && this.logger.error(`[lead-intelligence] unexpected error in job ${job.job_id}: ${err && err.stack}`);
    return this._transition(job, 'failed', { last_error_code: 'INTERNAL_ERROR', last_error_message: 'Research stopped because of an internal error.' });
  }

  /** Advance every due job, then mark expired results stale. Non-overlapping. */
  async tick() {
    if (this._ticking) return { skipped: true };
    this._ticking = true;
    try {
      const due = await this.store.jobs.listDue(this._nowIso());
      for (const job of due) {
        try {
          await this.advance(job.job_id);
        } catch (e) {
          this.logger.error && this.logger.error(`[lead-intelligence] tick failed for ${job.job_id}: ${e && e.message}`);
        }
      }
      const staled = await this.markStale();
      return { advanced: due.length, staled };
    } finally {
      this._ticking = false;
    }
  }

  async recover() {
    return this.tick();
  }

  async markStale() {
    let n = 0;
    const now = this._now();
    for (const job of await this.store.jobs.listByStates(['complete', 'partial'])) {
      if (!job.packet_id) continue;
      const meta = await this.store.packets.getMeta(job.packet_id);
      if (meta && this.freshness.isExpiredAt(meta.expires_at, now)) {
        try {
          await this._transition(job, 'stale');
          n += 1;
        } catch (e) {
          if (!(e instanceof ConflictError)) throw e;
        }
      }
    }
    return n;
  }
}

module.exports = { ResearchCoordinator, requestKeyFor };
