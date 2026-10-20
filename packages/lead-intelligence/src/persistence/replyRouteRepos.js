'use strict';

/**
 * F29: Reply Router repositories (migration 013), SqlJs and Memory twins.
 *
 * Idempotent on event_id: the first route recorded for a message stays (a re-read of the same
 * message by a later sync changes nothing). Only a human confirmation updates a row, and only
 * its confirmed / confirmed_by / confirmed_at. No text is stored: there is no column for it.
 */

const { normalizeRoute, ROUTE_COLS, REPLY_CATEGORIES } = require('../replies/replyRouteContract');
const { ValidationError } = require('../core/errors');

const MAX_LIST = 500;

function sqlRows(db, sql, params = []) {
  const st = db.prepare(sql);
  try {
    st.bind(params);
    const out = [];
    while (st.step()) out.push(st.getAsObject());
    return out;
  } finally {
    st.free();
  }
}
const sqlRow = (db, sql, params) => sqlRows(db, sql, params)[0] || null;
const ph = (cols) => cols.map(() => '?').join(', ');
const freeze = (r) => (r ? Object.freeze({ ...r }) : null);
const clampLimit = (n) => Math.max(1, Math.min(MAX_LIST, Number.isInteger(n) ? n : MAX_LIST));
const clampOffset = (n) => (Number.isInteger(n) && n > 0 ? n : 0);
const byNewest = (a, b) => (a.routed_at < b.routed_at ? 1 : a.routed_at > b.routed_at ? -1 : (a.event_id < b.event_id ? 1 : -1));

function checkConfirm({ category, by, at }) {
  if (!REPLY_CATEGORIES.includes(category) || typeof by !== 'string' || !by || by.length > 200 || typeof at !== 'string' || !Number.isFinite(Date.parse(at))) {
    throw new ValidationError('Invalid confirmation', [{ path: '$.category', message: 'invalid' }]);
  }
}

class SqlReplyRoutes {
  constructor(store) { this.s = store; }

  _get(id) { return freeze(sqlRow(this.s.db, `SELECT ${ROUTE_COLS.join(', ')} FROM li_reply_routes WHERE event_id = ?`, [String(id)])); }

  /** Record a route once. Returns { row, created }. */
  async put(rec) {
    const v = normalizeRoute(rec);
    return this.s.tx(() => {
      this.s.db.run(`INSERT OR IGNORE INTO li_reply_routes (${ROUTE_COLS.join(', ')}) VALUES (${ph(ROUTE_COLS)})`, ROUTE_COLS.map((c) => v[c]));
      const created = this.s.db.getRowsModified() > 0;
      return { row: this._get(v.event_id), created };
    });
  }

  async get(eventId) { return this._get(eventId); }

  async confirm(eventId, { category, by, at }) {
    checkConfirm({ category, by, at });
    return this.s.tx(() => {
      this.s.db.run('UPDATE li_reply_routes SET confirmed = ?, confirmed_by = ?, confirmed_at = ? WHERE event_id = ?', [category, by, at, String(eventId)]);
      return this.s.db.getRowsModified() > 0 ? this._get(eventId) : null;
    });
  }

  async forLead(leadId, limit) {
    return sqlRows(this.s.db, `SELECT ${ROUTE_COLS.join(', ')} FROM li_reply_routes WHERE lead_id = ? ORDER BY routed_at DESC, event_id DESC LIMIT ?`, [String(leadId), clampLimit(limit)]).map(freeze);
  }

  /** Newest first; `kinds` limits the kinds returned. */
  async list({ kinds = null, limit, offset = 0 } = {}) {
    const ks = Array.isArray(kinds) && kinds.length ? kinds.map(String) : null;
    const where = ks ? `WHERE kind IN (${ks.map(() => '?').join(', ')})` : '';
    return sqlRows(this.s.db, `SELECT ${ROUTE_COLS.join(', ')} FROM li_reply_routes ${where} ORDER BY routed_at DESC, event_id DESC LIMIT ? OFFSET ?`, [...(ks || []), clampLimit(limit), clampOffset(offset)]).map(freeze);
  }

  /** Inside purgeLead's transaction: the lead's routes go with the lead (trust events stay). */
  _deleteByLeadSql(leadId) {
    this.s.db.run('DELETE FROM li_reply_routes WHERE lead_id = ?', [String(leadId)]);
  }
}

class MemReplyRoutes {
  constructor() { this.rows = new Map(); }

  async put(rec) {
    const v = normalizeRoute(rec);
    const prev = this.rows.get(v.event_id);
    if (prev) return { row: freeze(prev), created: false };
    this.rows.set(v.event_id, v);
    return { row: freeze(v), created: true };
  }

  async get(eventId) { return freeze(this.rows.get(String(eventId)) || null); }

  async confirm(eventId, { category, by, at }) {
    checkConfirm({ category, by, at });
    const prev = this.rows.get(String(eventId));
    if (!prev) return null;
    const next = { ...prev, confirmed: category, confirmed_by: by, confirmed_at: at };
    this.rows.set(prev.event_id, next);
    return freeze(next);
  }

  async forLead(leadId, limit) {
    return [...this.rows.values()].filter((r) => r.lead_id === String(leadId)).sort(byNewest).slice(0, clampLimit(limit)).map(freeze);
  }

  async list({ kinds = null, limit, offset = 0 } = {}) {
    const ks = Array.isArray(kinds) && kinds.length ? new Set(kinds.map(String)) : null;
    const from = clampOffset(offset);
    return [...this.rows.values()].filter((r) => !ks || ks.has(r.kind)).sort(byNewest).slice(from, from + clampLimit(limit)).map(freeze);
  }

  deleteByLead(leadId) {
    for (const [k, r] of this.rows) if (r.lead_id === String(leadId)) this.rows.delete(k);
  }
}

module.exports = { SqlReplyRoutes, MemReplyRoutes, REPLY_ROUTE_COLUMNS: ROUTE_COLS };
