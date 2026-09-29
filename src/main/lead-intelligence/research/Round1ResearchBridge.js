'use strict';

const { stableId } = require('../core/ids');
const { pick } = require('../core/objects');
const { normalizeDomain } = require('../core/urls');
const { NotFoundError } = require('../core/errors');
const { toLeadView, identityFromView } = require('../contracts/leadView');
const { buildEvidencePacket, validateEvidencePacket } = require('../contracts/evidencePacket');
const { validateProviderResult } = require('../providers/ProspectResearchProvider');
const { round1PacketMapper } = require('../round1PacketMapper');
const { detectChanges } = require('./changeDetection');
const { RESEARCH_STATES } = require('../contracts/constants');

/**
 * Option A — the round-1 prospect-research engine stays the ONLY research engine.
 * This bridge reads round-1's research records and turns completed results into
 * lead-intelligence EvidencePackets. It never starts, polls or retries research and
 * never talks to Zuni-SEO; round-1 owns all of that.
 *
 * round1 port (INTEGRATION POINT — QwenCoder implements it over the round-1 bundle /
 * its `prospect_research` table; nothing here assumes a function exists):
 *   getLatest(leadId)   -> raw record | null        newest research record of one lead
 *   listByLead(leadId)  -> raw record[]             newest first (history)
 *   listLatestPerLead() -> Map<leadId, raw record>  one query for lists/filters
 *
 * VERIFY (QwenCoder): ROUND1_RECORD_PATHS and ROUND1_STATE_MAP must be checked against a
 * real `prospect_research` row and round-1's state names. Add the real path / state to
 * the FRONT of each list; do not change the EvidencePacket.
 *
 * A10: the paths below now lead with the GENUINE Round-1 record shape written by the
 * round-1 coordinator (camelCase `record_json`: leadRef, phase, website, providerJobId,
 * createdAt, updatedAt, finishedAt, failureReason, failureMessage). The older
 * snake_case aliases are kept behind them, so nothing that read before still reads.
 * The result mapping itself is NOT here: it is the injected mapper.
 */
const ROUND1_RECORD_PATHS = Object.freeze({
  recordId: ['id', 'record_id', 'recordId', 'request_id', 'requestId'],
  leadId: ['leadRef', 'lead_ref', 'lead_id', 'leadId', 'number_id', 'numberId'],
  providerJobId: ['providerJobId', 'provider_job_id', 'job_id', 'jobId', 'zuni_job_id'],
  state: ['phase', 'state', 'status'],
  domain: ['website', 'domain', 'requested_domain', 'requestedDomain', 'url', 'target_url'],
  createdAt: ['createdAt', 'created_at', 'requested_at', 'requestedAt'],
  updatedAt: ['updatedAt', 'updated_at'],
  completedAt: ['finishedAt', 'completed_at', 'completedAt', 'finished_at', 'finishedAt'],
  errorCode: ['failureReason', 'failure_reason', 'error_code', 'errorCode', 'last_error_code', 'lastErrorCode'],
  errorMessage: ['failureMessage', 'failure_message', 'error_message', 'errorMessage', 'last_error_message', 'lastErrorMessage'],
  result: ['packet', 'result', 'result_json', 'resultJson', 'envelope', 'envelope_json', 'payload'],
});

const ROUND1_STATE_MAP = Object.freeze({
  requested: 'requested', queued: 'requested', created: 'requested',
  preflight: 'preflight',
  started: 'started', accepted: 'started',
  running: 'polling', polling: 'polling', in_progress: 'polling',
  pending: 'pending', retry: 'pending', retrying: 'pending', waiting: 'pending',
  complete: 'complete', completed: 'complete', done: 'complete', succeeded: 'complete',
  partial: 'partial',
  failed: 'failed', error: 'failed', quarantined: 'failed', invalid: 'failed',
  blocked: 'blocked', unauthorized: 'blocked',
  stale: 'stale', expired: 'stale',
});

const PROVIDER = Object.freeze({ id: 'round1-zuni-seo', name: 'Zuni-SEO (prospect research)' });

function mapState(raw) {
  const s = ROUND1_STATE_MAP[String(raw || '').toLowerCase()];
  return s && RESEARCH_STATES.includes(s) ? s : 'unknown';
}

function parseMaybeJson(v) {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return undefined;
  }
}

function isoOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const ms = typeof v === 'number' ? v : Date.parse(v);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** Normalise a raw round-1 record into the fields this bridge needs. */
function normalizeRound1Record(raw, paths = ROUND1_RECORD_PATHS) {
  if (!raw || typeof raw !== 'object') return null;
  const P = { ...ROUND1_RECORD_PATHS, ...(paths || {}) };
  const get = (k) => pick(raw, P[k]);
  const recordId = get('recordId') ?? get('providerJobId');
  const leadId = get('leadId');
  if (recordId === undefined || leadId === undefined) return null;
  const rawState = get('state');
  return {
    recordId: String(recordId),
    leadId: String(leadId),
    providerJobId: get('providerJobId') == null ? null : String(get('providerJobId')),
    rawState: rawState == null ? null : String(rawState),
    state: mapState(rawState),
    domain: get('domain') == null ? null : String(get('domain')),
    createdAt: isoOrNull(get('createdAt')),
    updatedAt: isoOrNull(get('updatedAt')),
    completedAt: isoOrNull(get('completedAt')),
    errorCode: get('errorCode') == null ? null : String(get('errorCode')).slice(0, 100),
    errorMessage: get('errorMessage') == null ? null : String(get('errorMessage')).slice(0, 300),
    result: parseMaybeJson(get('result')),
  };
}

function jobIdFor(recordId) {
  return stableId('r1job', recordId);
}

/** Job-like view of a round-1 record, same shape as the module's own jobs. */
function jobFromRecord(rec, packetId = null) {
  const created = rec.createdAt || rec.updatedAt || rec.completedAt || new Date(0).toISOString();
  return {
    job_id: jobIdFor(rec.recordId),
    lead_id: rec.leadId,
    provider_id: PROVIDER.id,
    requested_domain: rec.domain,
    state: rec.state,
    provider_job_id: rec.providerJobId,
    attempts: 0,
    next_attempt_at: null,
    last_error_code: rec.errorCode,
    last_error_message: rec.errorMessage,
    packet_id: packetId,
    options: {},
    created_at: created,
    updated_at: rec.updatedAt || created,
    finished_at: rec.completedAt,
  };
}

class Round1ResearchBridge {
  constructor({ round1, store, leadSource, freshness, fieldMap, recordPaths, clock = () => new Date(), logger = console, limitedPageThreshold, mapper = round1PacketMapper }) {
    for (const m of ['getLatest', 'listByLead', 'listLatestPerLead']) {
      if (!round1 || typeof round1[m] !== 'function') throw new TypeError(`round1 port is missing ${m}()`);
    }
    if (typeof mapper !== 'function') throw new TypeError('mapper must be a function');
    this.round1 = round1;
    this.store = store;
    this.leadSource = leadSource;
    this.freshness = freshness;
    this.fieldMap = fieldMap;
    this.recordPaths = recordPaths;
    this.clock = clock;
    this.logger = logger;
    this.limitedPageThreshold = limitedPageThreshold;
    this._mapper = mapper;
    this._syncing = new Map();
  }

  _norm(raw) {
    return normalizeRound1Record(raw, this.recordPaths);
  }

  /** Research-state reader used by contexts/profile (replaces li_research_jobs in round1 mode). */
  stateReader() {
    return {
      latestPerLead: async () => {
        const out = new Map();
        for (const [leadId, raw] of await this.round1.listLatestPerLead()) {
          const rec = this._norm(raw);
          if (rec) out.set(String(leadId), jobFromRecord(rec));
        }
        return out;
      },
      listByLead: async (leadId) => (await this.round1.listByLead(String(leadId))).map((r) => this._norm(r)).filter(Boolean).map((r) => jobFromRecord(r)),
    };
  }

  async _alreadySynced(leadId, jobId) {
    const metas = await this.store.packets.listMetaByLead(leadId);
    return metas.find((m) => m.job_id === jobId) || null;
  }

  /**
   * Turn the lead's newest completed round-1 result into an EvidencePacket (idempotent).
   * @returns {Promise<{synced: boolean, packet_id?: string, reason?: string}>}
   */
  async syncLead(leadId) {
    const key = String(leadId);
    if (this._syncing.has(key)) return this._syncing.get(key);
    const p = this._sync(key).finally(() => this._syncing.delete(key));
    this._syncing.set(key, p);
    return p;
  }

  async _sync(leadId) {
    const rec = this._norm(await this.round1.getLatest(leadId));
    if (!rec) return { synced: false, reason: 'NO_RECORD' };
    if (rec.leadId !== leadId) return { synced: false, reason: 'LEAD_MISMATCH' };
    if (!['complete', 'partial', 'failed'].includes(rec.state)) return { synced: false, reason: `STATE_${rec.state.toUpperCase()}` };
    if (!rec.result || typeof rec.result !== 'object') return { synced: false, reason: 'NO_RESULT' };

    const jobId = jobIdFor(rec.recordId);
    const existing = await this._alreadySynced(leadId, jobId);
    if (existing) return { synced: false, reason: 'ALREADY_SYNCED', packet_id: existing.packet_id };

    const raw = await this.leadSource.getLead(leadId);
    if (!raw) throw new NotFoundError('Lead', leadId);
    const view = toLeadView(raw, this.fieldMap);
    const d = normalizeDomain(rec.domain || view.website || '');
    if (!d.ok) return this._reject(rec, 'INVALID_DOMAIN');

    let result;
    try {
      result = this._mapper(rec, { requestedDomain: d.host, providerJobId: rec.providerJobId || rec.recordId });
    } catch {
      return this._reject(rec, 'MALFORMED_RESULT');
    }
    if (!validateProviderResult(result).valid) return this._reject(rec, 'MALFORMED_RESULT');
    const rd = normalizeDomain(result.requestedDomain);
    if (!rd.ok || rd.key !== d.key) return this._reject(rec, 'DOMAIN_MISMATCH');

    const packet = buildEvidencePacket({
      leadId,
      jobId,
      identity: identityFromView(view),
      provider: PROVIDER,
      result,
      freshness: this.freshness,
      now: this.clock(),
      leadView: view,
      limitedPageThreshold: this.limitedPageThreshold,
    });
    if (!validateEvidencePacket(packet).valid) return this._reject(rec, 'PACKET_INVALID');
    await this.store.packets.insert(packet);
    try {
      const previous = await this.store.packets.previousForLead(leadId, packet.packet_id);
      if (previous) {
        const changes = detectChanges(previous, packet, { now: this.clock() });
        if (changes.length) await this.store.changes.insertMany(changes);
      }
    } catch (e) {
      if (this.logger.warn) this.logger.warn(`[lead-intelligence] change detection failed for ${packet.packet_id}: ${e && e.message}`);
    }
    return { synced: true, packet_id: packet.packet_id };
  }

  _reject(rec, reason) {
    if (this.logger.warn) this.logger.warn(`[lead-intelligence] round-1 record ${rec.recordId} not converted: ${reason}`);
    return { synced: false, reason };
  }

  /** Sync every lead whose newest round-1 record is finished and not yet converted. */
  async syncAll() {
    const metas = await this.store.packets.latestMetaPerLead();
    let synced = 0;
    let skipped = 0;
    for (const [leadId, raw] of await this.round1.listLatestPerLead()) {
      const rec = this._norm(raw);
      if (!rec || !['complete', 'partial', 'failed'].includes(rec.state)) { skipped += 1; continue; }
      const meta = metas.get(String(leadId));
      if (meta && meta.job_id === jobIdFor(rec.recordId)) { skipped += 1; continue; }
      try {
        const r = await this.syncLead(String(leadId));
        if (r.synced) synced += 1; else skipped += 1;
      } catch (e) {
        skipped += 1;
        if (this.logger.warn) this.logger.warn(`[lead-intelligence] round-1 sync failed for lead ${leadId}: ${e && e.code ? e.code : 'ERROR'}`);
      }
    }
    return { synced, skipped };
  }

  /** Read-only port for runtime use — does NOT mutate or control the Round-1 engine. */
  getLatest(leadId) {
    return this.round1.getLatest(leadId);
  }

  listByLead(leadId) {
    return this.round1.listByLead(leadId);
  }

  listLatestPerLead() {
    return this.round1.listLatestPerLead();
  }
}

module.exports = { Round1ResearchBridge, normalizeRound1Record, jobFromRecord, ROUND1_RECORD_PATHS, ROUND1_STATE_MAP, ROUND1_PROVIDER: PROVIDER, round1PacketMapper };
