'use strict';

const { clone } = require('../core/objects');
const { ConflictError, NotFoundError, DuplicateActiveJobError } = require('../core/errors');
const { ACTIVE_STATES } = require('../contracts/constants');
const { packetMeta, normalizePitchListQuery } = require('./contract');

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

class MemoryStore {
  constructor() {
    this.jobs = new MemJobs();
    this.packets = new MemPackets();
    this.changes = new MemChanges();
    this.savedSearches = new MemKeyed('search_id');
    this.segments = new MemSegments();
    this.pitches = new MemPitches();
    this.approvals = new MemApprovals();
    this.enrichmentJobs = new MemEnrichmentJobs();
    this.enrichmentObservations = new MemEnrichmentObservations();
  }

  async purgeLead(leadId) {
    const pitchIds = [...this.pitches.rows.values()].filter((p) => p.lead_id === String(leadId)).map((p) => p.pitch_id);
    await this.approvals.deleteForPitches(pitchIds);
    await this.pitches.deleteByLead(leadId);
    await this.changes.deleteByLead(leadId);
    await this.packets.deleteByLead(leadId);
    await this.jobs.deleteByLead(leadId);
    await this.segments.deleteLeadMemberships(leadId);
    await this.enrichmentJobs.deleteByLead(leadId);
    await this.enrichmentObservations.deleteByLead(leadId);
  }
}

module.exports = { MemoryStore };
