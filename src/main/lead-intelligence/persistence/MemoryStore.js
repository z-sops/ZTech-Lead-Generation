'use strict';

const { clone } = require('../core/objects');
const { ConflictError, NotFoundError, DuplicateActiveJobError, LiError } = require('../core/errors');
const { ACTIVE_STATES } = require('../contracts/constants');
const { MemSuppressions, MemConsents, MemProvenance, MemTrustEvents, MemRecipientRefs } = require('./trustRepos');
const { MemMailboxes, MemMailboxSent, MemMarketRules, MemReplyReviews } = require('./mailboxRepos');
const { MemSequences } = require('./sequenceRepos');
const { MAILBOX_ID_RE } = require('../mailbox/mailboxContract');
const { packetMeta, normalizePitchListQuery, ACTIVITY_TYPES, normalizeActivityQuery, normalizeSendRecord, normalizeSendQuery } = require('./contract');

/** In-memory implementation of the repository contract. Used by tests and dev tools. */

const byNewest = (a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0);
const byCaptured = (a, b) => (a.captured_at < b.captured_at ? 1 : a.captured_at > b.captured_at ? -1 : byNewest(a, b));

class MemJobs {
  constructor() { this.rows = new Map(); }

  async insert(job) {
    if (this.rows.has(job.job_id)) throw new ConflictError('Job id already exists');
    if (ACTIVE_STATES.includes(job.state)) {
      for (const j of this.rows.values()) {
        if (j.request_key === job.request_key && ACTIVE_STATES.includes(j.state)) throw new DuplicateActiveJobError(job.request_key);
      }
    }
    this.rows.set(job.job_id, clone(job));
    return clone(job);
  }

  async update(job, expectedVersion) {
    const cur = this.rows.get(job.job_id);
    if (!cur) throw new NotFoundError('Research job', job.job_id);
    if (cur.version !== expectedVersion) throw new ConflictError('Research job was changed by another operation', { jobId: job.job_id });
    if (ACTIVE_STATES.includes(job.state)) {
      for (const j of this.rows.values()) {
        if (j.job_id !== job.job_id && j.request_key === job.request_key && ACTIVE_STATES.includes(j.state)) throw new DuplicateActiveJobError(job.request_key);
      }
    }
    this.rows.set(job.job_id, clone(job));
    return clone(job);
  }

  async get(id) { return this.rows.has(id) ? clone(this.rows.get(id)) : null; }

  async findActive(requestKey) {
    for (const j of this.rows.values()) if (j.request_key === requestKey && ACTIVE_STATES.includes(j.state)) return clone(j);
    return null;
  }

  async listByLead(leadId) {
    return [...this.rows.values()].filter((j) => j.lead_id === String(leadId)).sort(byNewest).map(clone);
  }

  async listDue(nowIso) {
    return [...this.rows.values()]
      .filter((j) => ['requested', 'preflight', 'started'].includes(j.state)
        || (['polling', 'pending'].includes(j.state) && (!j.next_attempt_at || j.next_attempt_at <= nowIso)))
      .sort((a, b) => (a.created_at < b.created_at ? -1 : 1))
      .map(clone);
  }

  async listByStates(states) {
    return [...this.rows.values()].filter((j) => states.includes(j.state)).map(clone);
  }

  async latestPerLead() {
    const out = new Map();
    for (const j of [...this.rows.values()].sort(byNewest)) if (!out.has(j.lead_id)) out.set(j.lead_id, clone(j));
    return out;
  }

  async deleteByLead(leadId) {
    for (const [id, j] of this.rows) if (j.lead_id === String(leadId)) this.rows.delete(id);
  }
}

class MemPackets {
  constructor() { this.rows = new Map(); }

  async insert(packet) {
    if (this.rows.has(packet.packet_id)) throw new ConflictError('Packet id already exists');
    this.rows.set(packet.packet_id, clone(packet));
    return packetMeta(packet);
  }

  async get(id) { return this.rows.has(id) ? clone(this.rows.get(id)) : null; }

  _forLead(leadId) { return [...this.rows.values()].filter((p) => p.lead_id === String(leadId)).sort(byCaptured); }

  async latestForLead(leadId) {
    const list = this._forLead(leadId);
    return list.length ? clone(list[0]) : null;
  }

  async previousForLead(leadId, packetId) {
    const list = this._forLead(leadId);
    const idx = list.findIndex((p) => p.packet_id === packetId);
    if (idx === -1) return null;
    return list[idx + 1] ? clone(list[idx + 1]) : null;
  }

  async listMetaByLead(leadId) { return this._forLead(leadId).map(packetMeta); }

  async getMeta(id) { return this.rows.has(id) ? packetMeta(this.rows.get(id)) : null; }

  async latestMetaPerLead() {
    const out = new Map();
    for (const p of [...this.rows.values()].sort(byCaptured)) if (!out.has(p.lead_id)) out.set(p.lead_id, packetMeta(p));
    return out;
  }

  async deleteByLead(leadId) {
    for (const [id, p] of this.rows) if (p.lead_id === String(leadId)) this.rows.delete(id);
  }
}

class MemChanges {
  constructor() { this.rows = new Map(); }
  async insertMany(changes) { for (const c of changes) if (!this.rows.has(c.change_id)) this.rows.set(c.change_id, clone(c)); return changes.length; }
  async listByLead(leadId) {
    return [...this.rows.values()].filter((c) => c.lead_id === String(leadId))
      .sort((a, b) => (a.detectedAt < b.detectedAt ? 1 : -1)).map(clone);
  }
  async deleteByLead(leadId) { for (const [id, c] of this.rows) if (c.lead_id === String(leadId)) this.rows.delete(id); }
}

class MemKeyed {
  constructor(idField) { this.idField = idField; this.rows = new Map(); }
  async upsert(rec) { this.rows.set(rec[this.idField], clone(rec)); return clone(rec); }
  async get(id) { return this.rows.has(id) ? clone(this.rows.get(id)) : null; }
  async list() { return [...this.rows.values()].sort((a, b) => (a.name || '').localeCompare(b.name || '')).map(clone); }
  async delete(id) { return this.rows.delete(id); }
}

class MemSegments extends MemKeyed {
  constructor() { super('segment_id'); this.memberRows = new Map(); }
  async delete(id) { this.memberRows.delete(id); return super.delete(id); }
  async addMembers(id, leadIds, atIso) {
    if (!this.memberRows.has(id)) this.memberRows.set(id, new Map());
    const m = this.memberRows.get(id);
    for (const l of leadIds) if (!m.has(String(l))) m.set(String(l), atIso);
    return m.size;
  }
  async removeMembers(id, leadIds) {
    const m = this.memberRows.get(id);
    if (!m) return 0;
    for (const l of leadIds) m.delete(String(l));
    return m.size;
  }
  async members(id) { return [...(this.memberRows.get(id) || new Map()).keys()]; }
  async deleteLeadMemberships(leadId) { for (const m of this.memberRows.values()) m.delete(String(leadId)); }
}

class MemPitches extends MemKeyed {
  constructor() { super('pitch_id'); }
  async latestForLead(leadId) {
    const list = [...this.rows.values()].filter((p) => p.lead_id === String(leadId))
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
    return list.length ? clone(list[0]) : null;
  }
  /**
   * F12 Batch 1: the same contract as SqlPitches.list - read-only enumeration, the same
   * {rows, total, limit, offset, status} envelope, the same status validation and the
   * same updated_at DESC / pitch_id DESC ordering, so a test that passes here describes
   * the real SQL store's behaviour.
   */
  async list(query) {
    const { status, limit, offset } = normalizePitchListQuery(query);
    const all = [...this.rows.values()].filter((p) => (status === null ? true : p.status === status))
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1
        : a.pitch_id < b.pitch_id ? 1 : a.pitch_id > b.pitch_id ? -1 : 0));
    return { rows: all.slice(offset, offset + limit).map(clone), total: all.length, limit, offset, status };
  }
  /** I6: same contract as SqlPitches.listByLead. */
  async listByLead(leadId, limit = 500) {
    const n = Math.max(1, Math.min(500, Number.isInteger(limit) ? limit : 500));
    return [...this.rows.values()].filter((p) => p.lead_id === String(leadId))
      .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : a.pitch_id < b.pitch_id ? 1 : -1))
      .slice(0, n).map(clone);
  }
  async deleteByLead(leadId) { for (const [id, p] of this.rows) if (p.lead_id === String(leadId)) this.rows.delete(id); }
}

class MemApprovals {
  constructor() { this.rows = []; }
  async insert(rec) { this.rows.push(clone(rec)); return clone(rec); }
  async latestForPitch(pitchId) {
    const list = this.rows.filter((a) => a.pitch_id === pitchId).sort((a, b) => (a.approved_at < b.approved_at ? 1 : -1));
    return list.length ? clone(list[0]) : null;
  }
  async deleteForPitches(ids) { const s = new Set(ids); this.rows = this.rows.filter((a) => !s.has(a.pitch_id)); }
}

const E_ACTIVE = ['requested', 'running', 'pending'];

class MemEnrichmentJobs {
  constructor() { this.rows = new Map(); }

  _activeClash(job) {
    if (!E_ACTIVE.includes(job.state)) return false;
    for (const j of this.rows.values()) {
      if (j.job_id !== job.job_id && j.lead_id === job.lead_id && E_ACTIVE.includes(j.state)) return true;
    }
    return false;
  }

  async insert(job) {
    if (this.rows.has(job.job_id)) throw new ConflictError('Job id already exists');
    if (this._activeClash(job)) throw new DuplicateActiveJobError(`enrich:${job.lead_id}`);
    this.rows.set(job.job_id, clone(job));
    return clone(job);
  }

  async update(job, expectedVersion) {
    const cur = this.rows.get(job.job_id);
    if (!cur) throw new NotFoundError('Enrichment job', job.job_id);
    if (cur.version !== expectedVersion) throw new ConflictError('Enrichment job was changed by another operation', { jobId: job.job_id });
    if (this._activeClash(job)) throw new DuplicateActiveJobError(`enrich:${job.lead_id}`);
    this.rows.set(job.job_id, clone(job));
    return clone(job);
  }

  async get(id) { return this.rows.has(id) ? clone(this.rows.get(id)) : null; }

  async findActiveForLead(leadId) {
    for (const j of this.rows.values()) if (j.lead_id === String(leadId) && E_ACTIVE.includes(j.state)) return clone(j);
    return null;
  }

  async listByLead(leadId) {
    return [...this.rows.values()].filter((j) => j.lead_id === String(leadId)).sort(byNewest).map(clone);
  }

  async listDue(nowIso) {
    return [...this.rows.values()]
      .filter((j) => j.state === 'requested' || j.state === 'running' || (j.state === 'pending' && (!j.next_attempt_at || j.next_attempt_at <= nowIso)))
      .sort((a, b) => (a.created_at < b.created_at ? -1 : 1))
      .map(clone);
  }

  async listByStates(states) { return [...this.rows.values()].filter((j) => states.includes(j.state)).map(clone); }

  async deleteByLead(leadId) { for (const [id, j] of this.rows) if (j.lead_id === String(leadId)) this.rows.delete(id); }
}

class MemEnrichmentObservations {
  constructor() { this.rows = new Map(); }

  async upsertMany(list) {
    for (const o of list) {
      const cur = this.rows.get(o.observation_id);
      if (cur) this.rows.set(o.observation_id, { ...cur, collected_at: o.collected_at, job_id: o.job_id });
      else this.rows.set(o.observation_id, { ...clone(o), first_seen_at: o.collected_at });
    }
    return list.length;
  }

  async listByLead(leadId) {
    return [...this.rows.values()].filter((o) => o.lead_id === String(leadId)).sort((a, b) => (a.observation_id < b.observation_id ? -1 : 1)).map(clone);
  }

  async listAllGrouped() {
    const out = new Map();
    for (const o of this.rows.values()) {
      if (!out.has(o.lead_id)) out.set(o.lead_id, []);
      out.get(o.lead_id).push(clone(o));
    }
    return out;
  }

  async deleteByLead(leadId) { for (const [id, o] of this.rows) if (o.lead_id === String(leadId)) this.rows.delete(id); }
}

/* --------------------------- outreach activity (F15) --------------------------- */

/**
 * Append-only activity ledger. Mirrors SqlActivity exactly: same closed type allowlist,
 * same newest-first ordering with activity_id as the tie-breaker, same bounded paging,
 * and - like the SQL version - activity rows survive purgeLead, because a historical
 * event must not disappear when the lead it referred to is purged.
 */
/** I3: mirror of SqlOiAssociations - seven columns, idempotent on research_id. */
const OI_ASSOC_COLS = ['research_id', 'lead_id', 'snapshot_id', 'entity_key', 'status', 'generated_at', 'recorded_at'];

class MemOiAssociations {
  constructor() { this.rows = new Map(); }

  async listAll() {
    return [...this.rows.values()]
      .sort((a, b) => (a.lead_id < b.lead_id ? -1 : a.lead_id > b.lead_id ? 1
        : a.recorded_at < b.recorded_at ? 1 : a.recorded_at > b.recorded_at ? -1
          : a.research_id < b.research_id ? 1 : -1))
      .map((r) => ({ ...r }));
  }

  async put(rec, { keep = 50 } = {}) {
    const id = String(rec.research_id);
    if (!this.rows.has(id)) {
      const row = {};
      for (const c of OI_ASSOC_COLS) row[c] = rec[c] === undefined || rec[c] === null ? null : String(rec[c]);
      this.rows.set(id, row);
    }
    const lead = String(rec.lead_id);
    const mine = [...this.rows.values()].filter((r) => r.lead_id === lead)
      .sort((a, b) => (a.recorded_at < b.recorded_at ? 1 : a.recorded_at > b.recorded_at ? -1 : a.research_id < b.research_id ? 1 : -1));
    for (const r of mine.slice(keep)) this.rows.delete(r.research_id);
    return this.rows.has(id) ? { ...this.rows.get(id) } : null;
  }

  async deleteByLead(leadId) {
    for (const [k, r] of this.rows) if (r.lead_id === String(leadId)) this.rows.delete(k);
  }
}

/** I5 (migration 007): the in-memory twin of SqlOiRefreshRequests - same contract. */
class MemOiRefreshRequests {
  constructor() { this.rows = new Map(); }

  async pendingForLead(leadId) {
    const r = [...this.rows.values()].find((x) => x.lead_id === String(leadId) && x.state === 'pending');
    return r ? { ...r } : null;
  }

  async listAllPending() {
    return [...this.rows.values()].filter((x) => x.state === 'pending').sort((a, b) => (a.lead_id < b.lead_id ? -1 : 1)).map((r) => ({ ...r }));
  }

  async listByLead(leadId, limit = 20) {
    return [...this.rows.values()].filter((x) => x.lead_id === String(leadId))
      .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : a.request_id < b.request_id ? 1 : -1))
      .slice(0, limit).map((r) => ({ ...r }));
  }

  async open(rec) {
    const id = String(rec.request_id);
    if (this.rows.has(id)) throw new Error('UNIQUE constraint failed: li_oi_refresh_requests.request_id');
    if (await this.pendingForLead(rec.lead_id)) throw new Error('UNIQUE constraint failed: li_oi_refresh_requests.lead_id');
    const r = { request_id: id, lead_id: String(rec.lead_id), state: 'pending', research_id: null, error_code: null, created_at: String(rec.created_at), updated_at: String(rec.created_at) };
    this.rows.set(id, r);
    return { ...r };
  }

  async close(requestId, { state, research_id = null, error_code = null, updated_at }, { keep = 20 } = {}) {
    if (state !== 'succeeded' && state !== 'failed') throw new Error('close() takes succeeded or failed');
    const r = this.rows.get(String(requestId));
    if (!r) return null;
    if (r.state === 'pending') Object.assign(r, { state, research_id: research_id == null ? null : String(research_id), error_code: error_code == null ? null : String(error_code), updated_at: String(updated_at) });
    const done = [...this.rows.values()].filter((x) => x.lead_id === r.lead_id && x.state !== 'pending')
      .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : a.request_id < b.request_id ? 1 : -1));
    for (const x of done.slice(keep)) this.rows.delete(x.request_id);
    return this.rows.has(r.request_id) ? { ...r } : null;
  }

  async deleteByLead(leadId) {
    for (const [k, r] of this.rows) if (r.lead_id === String(leadId)) this.rows.delete(k);
  }
}

class MemActivity {
  constructor() { this.rows = new Map(); }

  async append(rec) {
    if (!ACTIVITY_TYPES.includes(rec.activity_type)) {
      throw new LiError('VALIDATION_FAILED', 'Invalid activity: activity_type');
    }
    this.rows.set(rec.activity_id, {
      activity_id: rec.activity_id,
      lead_id: rec.lead_id,
      pitch_id: rec.pitch_id ?? null,
      activity_type: rec.activity_type,
      metadata: clone(rec.metadata || {}),
      created_at: rec.created_at
    });
    return clone(this.rows.get(rec.activity_id));
  }

  _sorted() {
    return [...this.rows.values()].sort((a, b) => {
      if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
      return a.activity_id < b.activity_id ? 1 : a.activity_id > b.activity_id ? -1 : 0;
    });
  }

  async list(query) {
    const { limit, offset, leadId, pitchId } = normalizeActivityQuery(query);
    let all = this._sorted();
    if (leadId) all = all.filter((r) => r.lead_id === leadId);
    if (pitchId) all = all.filter((r) => r.pitch_id === pitchId);
    return {
      rows: clone(all.slice(offset, offset + limit)),
      total: all.length,
      limit,
      offset,
      leadId,
      pitchId
    };
  }

  async latestForPitch(pitchId, activityType) {
    const match = this._sorted().find((r) => r.pitch_id === String(pitchId) && r.activity_type === activityType);
    return match ? clone(match) : null;
  }
}

/* ------------------------------ sends (F19) ------------------------------ */

/**
 * F19 in-memory send ledger. Mirrors SqlSends exactly: the same closed channel/state
 * allowlists, the same `record` -> `accept`/`fail`/`block` lifecycle, the same refusal to
 * record anything but 'attempted' up front, and the same at-most-one-ACCEPTED-per-key rule
 * - here enforced with a scan because an in-memory Map has no partial unique index.
 *
 * It reproduces the SQL rule's INTENT rather than its mechanism, and returns the same
 * ALREADY_ACCEPTED signal so a caller cannot tell the two stores apart.
 */
class MemSends {
  constructor() { this.rows = new Map(); }

  _acceptedForKey(key) {
    for (const r of this.rows.values()) if (r.idempotency_key === key && r.state === 'accepted') return r;
    return null;
  }

  async findAccepted(idempotencyKey) {
    const match = this._acceptedForKey(String(idempotencyKey));
    return match ? clone(match) : null;
  }

  async record(rec) {
    const n = normalizeSendRecord(rec);
    if (!n.ok) throw new LiError('VALIDATION_FAILED', n.error);
    if (n.value.state !== 'attempted') {
      throw new LiError('VALIDATION_FAILED', 'A send attempt must be recorded as attempted before it can change state');
    }
    if (rec.mailbox_id != null && (typeof rec.mailbox_id !== 'string' || !MAILBOX_ID_RE.test(rec.mailbox_id))) {
      throw new LiError('VALIDATION_FAILED', 'send: mailbox_id');
    }
    this.rows.set(rec.send_id, {
      send_id: rec.send_id,
      lead_id: rec.lead_id,
      pitch_id: rec.pitch_id,
      channel: n.value.channel,
      content_hash: rec.content_hash,
      idempotency_key: rec.idempotency_key,
      state: 'attempted',
      provider_id: n.value.provider_id,
      provider_message_id: n.value.provider_message_id,
      failure_code: null,
      failure_message: null,
      mailbox_id: rec.mailbox_id == null ? null : rec.mailbox_id,
      created_at: rec.created_at,
      updated_at: rec.updated_at
    });
    return clone(this.rows.get(rec.send_id));
  }

  async mailboxSendTimes(mailboxId, sinceIso) {
    return [...this.rows.values()]
      .filter((r) => r.mailbox_id === String(mailboxId) && r.created_at >= String(sinceIso) && r.state === 'accepted')
      .map((r) => r.created_at).sort();
  }

  async accept({ sendId, providerId, providerMessageId, at }) {
    const current = this.rows.get(String(sendId));
    if (!current) return { ok: true, row: null };
    const winner = this._acceptedForKey(current.idempotency_key);
    if (winner && winner.send_id !== String(sendId)) return { ok: false, code: 'ALREADY_ACCEPTED', row: clone(winner) };
    if (current.state === 'attempted') {
      current.state = 'accepted';
      current.provider_id = providerId === undefined ? null : providerId;
      current.provider_message_id = providerMessageId === undefined ? null : providerMessageId;
      current.updated_at = at;
    }
    return { ok: true, row: clone(current) };
  }

  async fail({ sendId, failureCode, failureMessage, at }) {
    const current = this.rows.get(String(sendId));
    if (current && current.state === 'attempted') {
      current.state = 'failed';
      current.failure_code = failureCode === undefined ? null : failureCode;
      current.failure_message = failureMessage === undefined ? null : failureMessage;
      current.updated_at = at;
    }
    return current ? clone(current) : null;
  }

  async block({ sendId, failureCode, failureMessage, at }) {
    const current = this.rows.get(String(sendId));
    if (current && current.state === 'attempted') {
      current.state = 'blocked';
      current.failure_code = failureCode === undefined ? null : failureCode;
      current.failure_message = failureMessage === undefined ? null : failureMessage;
      current.updated_at = at;
    }
    return current ? clone(current) : null;
  }

  async get(sendId) {
    const r = this.rows.get(String(sendId));
    return r ? clone(r) : null;
  }

  _sorted() {
    return [...this.rows.values()].sort((a, b) => {
      if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
      return a.send_id < b.send_id ? 1 : a.send_id > b.send_id ? -1 : 0;
    });
  }

  async list(query) {
    const { limit, offset, leadId, pitchId } = normalizeSendQuery(query);
    let all = this._sorted();
    if (leadId) all = all.filter((r) => r.lead_id === leadId);
    if (pitchId) all = all.filter((r) => r.pitch_id === pitchId);
    return { rows: all.slice(offset, offset + limit).map((r) => clone(r)), total: all.length, limit, offset };
  }
}

class MemoryStore {
  constructor() {
    this.jobs = new MemJobs();
    this.packets = new MemPackets();
    this.changes = new MemChanges();
    this.savedSearches = new MemKeyed('search_id');
    this.segments = new MemSegments();
    this.pitches = new MemPitches();
    this.approvals = new MemApprovals();
    this.activity = new MemActivity();
    this.sends = new MemSends();
    this.enrichmentJobs = new MemEnrichmentJobs();
    this.enrichmentObservations = new MemEnrichmentObservations();
    this.oiAssociations = new MemOiAssociations();
    this.oiRefreshRequests = new MemOiRefreshRequests();
    // F26.5 Compliance & Trust Foundation: twins of the migration 008 repositories.
    this.suppressions = new MemSuppressions();
    this.consents = new MemConsents();
    this.provenance = new MemProvenance();
    this.trustEvents = new MemTrustEvents();
    this.recipientRefs = new MemRecipientRefs();
    // F26.6 Native Mailbox Transport: twins of the migration 010 repositories.
    this.mailboxes = new MemMailboxes();
    this.mailboxSent = new MemMailboxSent();
    this.marketRules = new MemMarketRules();
    this.replyReviews = new MemReplyReviews();
    // F28 (migration 012): follow-up sequences, their steps, the sequence audit and Pause all.
    this.sequences = new MemSequences();
  }

  async purgeLead(leadId) {
    const pitchIds = [...this.pitches.rows.values()].filter((p) => p.lead_id === String(leadId)).map((p) => p.pitch_id);
    await this.approvals.deleteForPitches(pitchIds);
    // F28: the lead's sequences and steps go with it (and the approvals of the step pitches);
    // the append-only sequence audit stays, like the send ledger.
    await this.approvals.deleteForPitches(this.sequences.deleteByLead(leadId));
    await this.pitches.deleteByLead(leadId);
    await this.changes.deleteByLead(leadId);
    await this.packets.deleteByLead(leadId);
    await this.jobs.deleteByLead(leadId);
    await this.segments.deleteLeadMemberships(leadId);
    await this.enrichmentJobs.deleteByLead(leadId);
    await this.enrichmentObservations.deleteByLead(leadId);
    await this.oiAssociations.deleteByLead(leadId);
    await this.oiRefreshRequests.deleteByLead(leadId);
    // F26.5: lead data goes; address-keyed suppressions, trust events and refs stay.
    await this.provenance.deleteByLead(leadId);
    await this.consents.deleteByLead(leadId);
  }
}

module.exports = { MemoryStore };
