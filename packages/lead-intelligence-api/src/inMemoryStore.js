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
};

function getWorkspaceMap(collection, workspaceId) {
  if (!STORAGE[collection].has(workspaceId)) {
    STORAGE[collection].set(workspaceId, new Map());
  }
  return STORAGE[collection].get(workspaceId);
}

class InMemoryJobs {
  constructor(store) { this.store = store; }

  async create(job) {
    const map = getWorkspaceMap('jobs', this.store.workspaceId);
    const id = job.job_id || `job_${crypto.randomUUID()}`;
    const rec = {
      ...job,
      job_id: id,
      workspace_id: this.store.workspaceId,
      created_at: job.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    map.set(id, rec);
    return rec;
  }

  async get(id) {
    const map = getWorkspaceMap('jobs', this.store.workspaceId);
    return map.get(id) || null;
  }

  async update(id, updates) {
    const map = getWorkspaceMap('jobs', this.store.workspaceId);
    const existing = map.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...updates, updated_at: new Date().toISOString() };
    map.set(id, updated);
    return updated;
  }

  async list() {
    const map = getWorkspaceMap('jobs', this.store.workspaceId);
    return Array.from(map.values()).sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
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

module.exports = { InMemoryStoreForApi, STORAGE };
