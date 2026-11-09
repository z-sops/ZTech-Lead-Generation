'use strict';

const crypto = require('node:crypto');

/**
 * InMemoryStoreForApi
 *
 * Implements the exact same repository seam as PostgresStore for tenant data,
 * providing zero-external-dependency persistence for local development, demos,
 * and test environments while preserving full workspace-scoped isolation.
 */
class InMemoryStoreForApi {
  constructor({ workspaceId, sessionId = null, userId = null } = {}) {
    this.workspaceId = String(workspaceId || '');
    this.sessionId = sessionId;
    this.userId = userId;

    this.jobs = new InMemoryJobs(this);
    this.packets = new InMemoryPackets(this);
    this.savedSearches = new InMemorySavedSearches(this);
    this.pitches = new InMemoryPitches(this);
    this.approvals = new InMemoryApprovals(this);
    this.suppressions = new InMemorySuppressions(this);
    this.researchJobs = new InMemoryResearchQueue(this);
    this.crm = new InMemoryCrm(this);
    this.competitors = new InMemoryCompetitorWatches(this);
  }

  async tx(fn) {
    // In-memory operations are synchronous transactions
    return fn();
  }

  isSuppressed(channel, address) {
    return this.suppressions.isSuppressed(channel, address);
  }
}

// Global in-memory storage partitioned by workspaceId
const STORAGE = {
  jobs: new Map(),           // workspaceId -> Map<job_id, job>
  packets: new Map(),        // workspaceId -> Map<packet_id, packet>
  savedSearches: new Map(),  // workspaceId -> Map<search_id, search>
  pitches: new Map(),        // workspaceId -> Map<pitch_id, pitch>
  approvals: new Map(),      // workspaceId -> Map<approval_id, approval>
  suppressions: new Map(),   // workspaceId -> Map<channel:address, boolean>
  researchJobs: new Map(),   // workspaceId -> Map<job_id, researchJob>
  crmAccounts: new Map(),    // workspaceId -> Map<account_id, account>
  crmNotes: new Map(),       // workspaceId -> Map<note_id, note>
  crmActivity: new Map(),    // workspaceId -> Map<activity_id, activity>
  competitorWatches: new Map(), // workspaceId -> Map<watch_id, watch>
};

function getWorkspaceMap(collection, workspaceId) {
  if (!STORAGE[collection].has(workspaceId)) {
    STORAGE[collection].set(workspaceId, new Map());
  }
  return STORAGE[collection].get(workspaceId);
}

class InMemoryJobs {
  constructor(store) { this.store = store; }

  async insert(job) {
    const map = getWorkspaceMap('jobs', this.store.workspaceId);
    const id = job.job_id || `job_${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const rec = {
      ...job,
      job_id: id,
      workspace_id: this.store.workspaceId,
      created_at: job.created_at || now,
      updated_at: now,
      version: 1,
      lead_id: job.lead_id ?? '',
      provider_id: job.provider_id ?? '',
      request_key: job.request_key ?? '',
      requested_domain: job.requested_domain ?? null,
      domain_key: job.domain_key ?? null,
      state: job.state ?? 'started',
      provider_job_id: job.provider_job_id ?? null,
      attempts: job.attempts ?? 0,
      poll_count: job.poll_count ?? 0,
      next_attempt_at: job.next_attempt_at ?? null,
      last_error_code: job.last_error_code ?? null,
      last_error_message: job.last_error_message ?? null,
      packet_id: job.packet_id ?? null,
      options: job.options ?? job.options_json ?? {},
      started_at: job.started_at ?? null,
      finished_at: job.finished_at ?? null,
    };
    map.set(id, rec);
    return rec;
  }

  async get(id) {
    const map = getWorkspaceMap('jobs', this.store.workspaceId);
    return map.get(id) || null;
  }

  async update(job, expectedVersion) {
    const map = getWorkspaceMap('jobs', this.store.workspaceId);
    const existing = map.get(job.job_id);
    if (!existing) return null;
    if (existing.version !== expectedVersion) {
      const err = new Error('Research job was changed by another operation');
      err.name = 'ConflictError';
      throw err;
    }
    const now = new Date().toISOString();
    const updated = {
      ...existing,
      ...job,
      job_id: existing.job_id,
      workspace_id: existing.workspace_id,
      created_at: existing.created_at,
      version: existing.version + 1,
      updated_at: now,
      options: job.options ?? job.options_json ?? existing.options,
    };
    map.set(job.job_id, updated);
    return updated;
  }

  async list() {
    const map = getWorkspaceMap('jobs', this.store.workspaceId);
    return Array.from(map.values()).sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  }

  async listByLead(leadId) {
    const map = getWorkspaceMap('jobs', this.store.workspaceId);
    return Array.from(map.values()).filter((j) => String(j.lead_id) === String(leadId)).sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  }
}

class InMemoryPackets {
  constructor(store) { this.store = store; }

  async insert(packet) {
    const map = getWorkspaceMap('packets', this.store.workspaceId);
    const id = packet.packet_id || `packet_${crypto.randomUUID()}`;
    const rec = {
      ...packet,
      packet_id: id,
      workspace_id: this.store.workspaceId,
      created_at: packet.created_at || new Date().toISOString(),
    };
    map.set(id, rec);
    return rec;
  }

  async get(id) {
    const map = getWorkspaceMap('packets', this.store.workspaceId);
    return map.get(id) || null;
  }

  async latestForLead(leadId) {
    const map = getWorkspaceMap('packets', this.store.workspaceId);
    const matches = Array.from(map.values()).filter((p) => p.lead_id === leadId);
    if (!matches.length) return null;
    matches.sort((a, b) => (b.captured_at || b.created_at || '').localeCompare(a.captured_at || a.created_at || ''));
    return matches[0];
  }
}

class InMemorySavedSearches {
  constructor(store) { this.store = store; }

  async upsert(rec) {
    const map = getWorkspaceMap('savedSearches', this.store.workspaceId);
    const id = rec.search_id || `search_${crypto.randomUUID()}`;
    const saved = {
      ...rec,
      search_id: id,
      workspace_id: this.store.workspaceId,
      created_at: rec.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    map.set(id, saved);
    return saved;
  }

  async get(id) {
    const map = getWorkspaceMap('savedSearches', this.store.workspaceId);
    return map.get(id) || null;
  }

  async list() {
    const map = getWorkspaceMap('savedSearches', this.store.workspaceId);
    return Array.from(map.values()).sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  }

  async delete(id) {
    const map = getWorkspaceMap('savedSearches', this.store.workspaceId);
    return map.delete(id);
  }
}

class InMemoryPitches {
  constructor(store) { this.store = store; }

  async upsert(pitch) {
    const map = getWorkspaceMap('pitches', this.store.workspaceId);
    const id = pitch.pitch_id || `pitch_${crypto.randomUUID()}`;
    const saved = {
      ...pitch,
      pitch_id: id,
      workspace_id: this.store.workspaceId,
      created_at: pitch.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    map.set(id, saved);
    return saved;
  }

  async get(id) {
    const map = getWorkspaceMap('pitches', this.store.workspaceId);
    return map.get(id) || null;
  }

  async latestForLead(leadId) {
    const map = getWorkspaceMap('pitches', this.store.workspaceId);
    const matches = Array.from(map.values()).filter((p) => p.lead_id === leadId);
    if (!matches.length) return null;
    matches.sort((a, b) => (b.updated_at || b.created_at || '').localeCompare(a.updated_at || a.created_at || ''));
    return matches[0];
  }

  async list() {
    const map = getWorkspaceMap('pitches', this.store.workspaceId);
    return { rows: Array.from(map.values()), total: map.size };
  }
}

class InMemoryApprovals {
  constructor(store) { this.store = store; }

  async insert(rec) {
    const map = getWorkspaceMap('approvals', this.store.workspaceId);
    const id = rec.approval_id || `appr_${crypto.randomUUID()}`;
    const saved = {
      ...rec,
      approval_id: id,
      workspace_id: this.store.workspaceId,
      approved_at: rec.approved_at || new Date().toISOString(),
    };
    map.set(id, saved);
    return saved;
  }

  async latestForPitch(pitchId) {
    const map = getWorkspaceMap('approvals', this.store.workspaceId);
    const matches = Array.from(map.values()).filter((a) => a.pitch_id === pitchId);
    if (!matches.length) return null;
    matches.sort((a, b) => (b.approved_at || '').localeCompare(a.approved_at || ''));
    return matches[0];
  }
}

class InMemorySuppressions {
  constructor(store) { this.store = store; }

  async add(channel, address) {
    const map = getWorkspaceMap('suppressions', this.store.workspaceId);
    map.set(`${channel}:${String(address).toLowerCase().trim()}`, true);
  }

  isSuppressed(channel, address) {
    const map = getWorkspaceMap('suppressions', this.store.workspaceId);
    return map.has(`${channel}:${String(address).toLowerCase().trim()}`);
  }
}

class InMemoryResearchQueue {
  constructor(store) { this.store = store; }

  async enqueue({ jobId, jobType, idempotencyKey, payload }) {
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('the payload must be a JSON object');
    }
    if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > 16384) {
      throw new Error('the payload is larger than 16 KiB');
    }
    const map = getWorkspaceMap('researchJobs', this.store.workspaceId);
    const now = new Date().toISOString();
    for (const item of map.values()) {
      if (item.job_type === jobType && item.idempotency_key === idempotencyKey) {
        return { ...item, deduplicated: true };
      }
    }
    const rec = {
      job_id: jobId,
      workspace_id: this.store.workspaceId,
      job_type: jobType,
      idempotency_key: idempotencyKey,
      payload,
      state: 'queued',
      job_class: 'noop',
      created_at: now,
      updated_at: now,
      attempt_count: 0,
      max_attempts: 5,
      cancel_requested_at: null,
    };
    map.set(jobId, rec);
    return { ...rec, deduplicated: false };
  }

  async list({ limit = 50 } = {}) {
    const map = getWorkspaceMap('researchJobs', this.store.workspaceId);
    return Array.from(map.values())
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
      .slice(0, limit);
  }

  async get({ jobId }) {
    const map = getWorkspaceMap('researchJobs', this.store.workspaceId);
    const rec = map.get(jobId);
    return rec ? { ...rec } : null;
  }

  async result({ jobId }) {
    const map = getWorkspaceMap('researchJobs', this.store.workspaceId);
    const rec = map.get(jobId);
    if (!rec) return null;
    return {
      job_id: rec.job_id, state: rec.state, finished_at: rec.finished_at || null,
      result: rec.state === 'succeeded' ? rec.result || null : null,
    };
  }

  async cancel({ jobId }) {
    const map = getWorkspaceMap('researchJobs', this.store.workspaceId);
    const rec = map.get(jobId);
    if (!rec) return { job_id: jobId, action: 'not_found', state: null, cancel_requested_at: null };
    const now = new Date().toISOString();
    if (rec.state === 'succeeded' || rec.state === 'failed' || rec.state === 'cancelled') {
      return { job_id: jobId, action: 'unchanged', state: rec.state, cancel_requested_at: rec.cancel_requested_at };
    }
    if (rec.state === 'queued') {
      Object.assign(rec, { state: 'cancelled', cancel_requested_at: now, finished_at: now, updated_at: now });
      return { job_id: jobId, action: 'cancelled', state: 'cancelled', cancel_requested_at: now };
    }
    // leased or running: record the request, the worker observes it cooperatively
    rec.cancel_requested_at = rec.cancel_requested_at || now;
    rec.updated_at = now;
    return { job_id: jobId, action: 'cancel_requested', state: rec.state, cancel_requested_at: rec.cancel_requested_at };
  }
}

/**
 * The CRM (Phase 3) with the same seam as PgCrm. Notes and activity are
 * append-only here too; the version check mirrors the SQL one.
 */
const CRM_ACCOUNT_COLUMNS = [
  'account_id', 'name', 'website', 'phone', 'address', 'stage', 'lost_reason', 'owner_user_id',
  'estimated_value_cents', 'currency', 'next_step', 'next_step_at', 'source', 'source_job_id',
  'source_business_id', 'source_url', 'research_score', 'created_by', 'created_at', 'updated_by',
  'updated_at', 'archived_at', 'version',
];

class InMemoryCrm {
  constructor(store) { this.store = store; }

  accounts() { return getWorkspaceMap('crmAccounts', this.store.workspaceId); }

  async createAccount(rec) {
    const map = this.accounts();
    if (rec.source_business_id && [...map.values()].some((a) => a.source_business_id === rec.source_business_id)) {
      const err = new Error('duplicate key value violates unique constraint "li_crm_accounts_source_business"');
      err.code = '23505';
      throw err;
    }
    // Every column present, as a database row would have it.
    const row = { ...Object.fromEntries(CRM_ACCOUNT_COLUMNS.map((c) => [c, null])), ...rec };
    map.set(row.account_id, row);
    return { ...row };
  }

  async getAccount(accountId) {
    const row = this.accounts().get(accountId);
    return row ? { ...row } : null;
  }

  async findBySourceBusiness(businessId) {
    const row = [...this.accounts().values()].find((a) => a.source_business_id === businessId);
    return row ? { ...row } : null;
  }

  async listAccounts(query) {
    const q = (query.q || '').toLowerCase();
    let rows = [...this.accounts().values()].filter((a) => {
      if (!query.includeArchived && a.archived_at) return false;
      if (query.stage && a.stage !== query.stage) return false;
      if (query.unassigned && a.owner_user_id) return false;
      if (!query.unassigned && query.ownerUserId && a.owner_user_id !== query.ownerUserId) return false;
      if (q && !a.name.toLowerCase().includes(q) && !String(a.website || '').toLowerCase().includes(q)) return false;
      return true;
    });
    rows.sort((x, y) => (y.updated_at.localeCompare(x.updated_at)) || x.account_id.localeCompare(y.account_id));
    rows = rows.slice(query.offset, query.offset + query.limit + 1);
    return { rows: rows.slice(0, query.limit).map((r) => ({ ...r })), more: rows.length > query.limit };
  }

  async updateAccount(accountId, version, patch) {
    const row = this.accounts().get(accountId);
    if (!row || row.version !== version) return null;
    Object.assign(row, patch, { version: row.version + 1 });
    return { ...row };
  }

  async addNote(rec) {
    getWorkspaceMap('crmNotes', this.store.workspaceId).set(rec.note_id, { ...rec });
    return { ...rec };
  }

  async listNotes(accountId, limit = 100) {
    return [...getWorkspaceMap('crmNotes', this.store.workspaceId).values()]
      .filter((n) => n.account_id === accountId)
      .sort((x, y) => y.created_at.localeCompare(x.created_at) || x.note_id.localeCompare(y.note_id))
      .slice(0, limit).map((n) => ({ ...n }));
  }

  async addActivity(rec) {
    getWorkspaceMap('crmActivity', this.store.workspaceId).set(rec.activity_id, { ...rec, detail: rec.detail || {} });
    return { ...rec };
  }

  async listActivity(accountId, limit = 100) {
    return [...getWorkspaceMap('crmActivity', this.store.workspaceId).values()]
      .filter((a) => a.account_id === accountId)
      .sort((x, y) => y.at.localeCompare(x.at) || x.activity_id.localeCompare(y.activity_id))
      .slice(0, limit).map((a) => ({ ...a }));
  }

  async pipelineSummary() {
    const by = new Map();
    for (const a of this.accounts().values()) {
      if (a.archived_at) continue;
      const e = by.get(a.stage) || { stage: a.stage, accounts: 0, value_cents: 0 };
      e.accounts += 1;
      e.value_cents += a.estimated_value_cents || 0;
      by.set(a.stage, e);
    }
    return [...by.values()];
  }
}

class InMemoryCompetitorWatches {
  constructor(store) { this.store = store; }

  map() { return getWorkspaceMap('competitorWatches', this.store.workspaceId); }

  async create(rec) {
    const map = this.map();
    if ([...map.values()].some((w) => !w.archived_at && w.query.toLowerCase() === rec.query.toLowerCase() && w.country === rec.country)) {
      const err = new Error('duplicate key value violates unique constraint "li_competitor_watches_unique"');
      err.code = '23505';
      throw err;
    }
    const row = { page_id: null, account_id: null, archived_at: null, ...rec };
    map.set(row.watch_id, row);
    return { ...row };
  }

  async get(watchId) {
    const w = this.map().get(watchId);
    return w ? { ...w } : null;
  }

  async list({ includeArchived = false } = {}) {
    return [...this.map().values()].filter((w) => includeArchived || !w.archived_at)
      .sort((a, b) => b.created_at.localeCompare(a.created_at)).map((w) => ({ ...w }));
  }

  async archive(watchId, at) {
    const w = this.map().get(watchId);
    if (!w || w.archived_at) return null;
    w.archived_at = at;
    return { ...w };
  }
}

module.exports = { InMemoryStoreForApi, STORAGE };
