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

module.exports = { InMemoryStoreForApi, STORAGE };
