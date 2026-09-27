'use strict';

const { newId } = require('../core/ids');
const { NotFoundError, ValidationError } = require('../core/errors');
const { assertFilter, matchLead, resultRow } = require('./filters');

function cleanName(name) {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 120) {
    throw new ValidationError('name is invalid', [{ path: '$.name', message: 'must be 1..120 characters' }]);
  }
  return name.trim();
}

/** Saved Searches: a named filter stored in the existing DB; results computed live. */
class SavedSearchService {
  constructor({ store, contexts, clock = () => new Date() }) {
    this.store = store;
    this.contexts = contexts;
    this.clock = clock;
  }

  async save({ searchId, name, filter }) {
    assertFilter(filter);
    const now = this.clock().toISOString();
    const existing = searchId ? await this.store.savedSearches.get(searchId) : null;
    if (searchId && !existing) throw new NotFoundError('Saved search', searchId);
    const rec = {
      search_id: existing ? existing.search_id : newId('srch'),
      name: cleanName(name),
      filter,
      created_at: existing ? existing.created_at : now,
      updated_at: now,
    };
    return this.store.savedSearches.upsert(rec);
  }

  async list() { return this.store.savedSearches.list(); }

  async get(searchId) {
    const s = await this.store.savedSearches.get(searchId);
    if (!s) throw new NotFoundError('Saved search', searchId);
    return s;
  }

  async delete(searchId) {
    const ok = await this.store.savedSearches.delete(searchId);
    if (!ok) throw new NotFoundError('Saved search', searchId);
    return { deleted: true };
  }

  /** Run a saved search (by id) or an ad-hoc filter against the current Lead Library. */
  async run({ searchId, filter }) {
    const f = searchId ? (await this.get(searchId)).filter : assertFilter(filter || {});
    const ctxs = await this.contexts.listContexts({ targetId: f.target_id });
    const rows = ctxs.filter((c) => matchLead(f, c).matched).map(resultRow);
    return { search_id: searchId || null, total: rows.length, evaluated_at: this.clock().toISOString(), rows };
  }
}

/**
 * Segments.
 *  dynamic: stores a filter; members = leads matching it right now.
 *  static:  stores lead id references only (li_segment_members); members = those ids
 *           that still exist in the Lead Library. No lead data is copied.
 */
class SegmentService {
  constructor({ store, contexts, leadSource, clock = () => new Date() }) {
    this.store = store;
    this.contexts = contexts;
    this.leadSource = leadSource;
    this.clock = clock;
  }

  async save({ segmentId, name, kind, filter }) {
    if (kind !== 'static' && kind !== 'dynamic') throw new ValidationError('kind is invalid', [{ path: '$.kind', message: 'must be static or dynamic' }]);
    if (kind === 'dynamic') assertFilter(filter || {});
    if (kind === 'static' && filter !== undefined && filter !== null) {
      throw new ValidationError('static segments do not take a filter', [{ path: '$.filter', message: 'is not allowed for static segments' }]);
    }
    const now = this.clock().toISOString();
    const existing = segmentId ? await this.store.segments.get(segmentId) : null;
    if (segmentId && !existing) throw new NotFoundError('Segment', segmentId);
    if (existing && existing.kind !== kind) {
      throw new ValidationError('segment kind cannot change', [{ path: '$.kind', message: 'create a new segment instead' }]);
    }
    return this.store.segments.upsert({
      segment_id: existing ? existing.segment_id : newId('seg'),
      name: cleanName(name),
      kind,
      filter: kind === 'dynamic' ? (filter || {}) : null,
      created_at: existing ? existing.created_at : now,
      updated_at: now,
    });
  }

  async list() { return this.store.segments.list(); }

  async get(segmentId) {
    const s = await this.store.segments.get(segmentId);
    if (!s) throw new NotFoundError('Segment', segmentId);
    return s;
  }

  async delete(segmentId) {
    const ok = await this.store.segments.delete(segmentId);
    if (!ok) throw new NotFoundError('Segment', segmentId);
    return { deleted: true };
  }

  async _static(segmentId) {
    const seg = await this.get(segmentId);
    if (seg.kind !== 'static') throw new ValidationError('only static segments have manual members', [{ path: '$.segmentId', message: 'segment is dynamic' }]);
    return seg;
  }

  async addLeads(segmentId, leadIds) {
    await this._static(segmentId);
    const ids = [...new Set(leadIds.map(String))];
    const missing = [];
    for (const id of ids) if (!(await this.leadSource.getLead(id))) missing.push(id);
    if (missing.length) throw new ValidationError('some leads do not exist', missing.slice(0, 20).map((id) => ({ path: '$.leadIds', message: `unknown lead ${id}` })));
    const size = await this.store.segments.addMembers(segmentId, ids, this.clock().toISOString());
    await this.store.segments.upsert({ ...(await this.get(segmentId)), updated_at: this.clock().toISOString() });
    return { size };
  }

  async removeLeads(segmentId, leadIds) {
    await this._static(segmentId);
    const size = await this.store.segments.removeMembers(segmentId, [...new Set(leadIds.map(String))]);
    return { size };
  }

  /** Current members, evaluated against the live Lead Library. */
  async members(segmentId) {
    const seg = await this.get(segmentId);
    const targetId = seg.kind === 'dynamic' ? seg.filter.target_id : undefined;
    const ctxs = await this.contexts.listContexts({ targetId });
    if (seg.kind === 'dynamic') {
      const rows = ctxs.filter((c) => matchLead(seg.filter, c).matched).map(resultRow);
      return { segment_id: seg.segment_id, kind: seg.kind, total: rows.length, rows, missing_lead_ids: [], evaluated_at: this.clock().toISOString() };
    }
    const ids = await this.store.segments.members(segmentId);
    const byId = new Map(ctxs.map((c) => [c.view.id, c]));
    const rows = ids.filter((id) => byId.has(id)).map((id) => resultRow(byId.get(id)));
    return {
      segment_id: seg.segment_id,
      kind: seg.kind,
      total: rows.length,
      rows,
      missing_lead_ids: ids.filter((id) => !byId.has(id)),
      evaluated_at: this.clock().toISOString(),
    };
  }

  /** Lead ids for export/other features, without building rows. */
  async memberIds(segmentId) {
    return (await this.members(segmentId)).rows.map((r) => r.lead_id);
  }
}

module.exports = { SavedSearchService, SegmentService };
