'use strict';

/**
 * The PostgreSQL reply-route repository (M1).
 *
 * A route is a SUGGESTION about a reply's category. Nothing in the trust
 * policy, the gates or the scheduler reads it: a category, suggested or
 * confirmed, never suppresses, permits, sends, schedules or resumes.
 *
 * The table has NO text column - not a subject, not a snippet, not a body -
 * only ids, closed codes and times.
 */

const ROUTE_COLS = ['event_id', 'lead_id', 'mailbox_id', 'kind', 'suggested', 'rule_id', 'input', 'confidence', 'confirmed', 'confirmed_by', 'confirmed_at', 'routed_at'];

const MAX_LIST = 500;
const freeze = (r) => (r ? Object.freeze({ ...r }) : null);
const clampLimit = (n) => Math.max(1, Math.min(MAX_LIST, Number.isInteger(n) ? n : MAX_LIST));
const clampOffset = (n) => (Number.isInteger(n) && n > 0 ? n : 0);

class PgReplyRoutes {
  constructor(store) { this.s = store; }

  async _get(id) {
    return freeze(await this.s.one('li_reply_routes', `SELECT ${ROUTE_COLS.join(', ')} FROM li_reply_routes WHERE event_id = ? AND workspace_id = ?`, [String(id), this.s.workspaceId]));
  }

  async put(rec) {
    const v = { ...rec };
    await this.s.insert('li_reply_routes', ROUTE_COLS, ROUTE_COLS.map((c) => (v[c] === undefined ? null : v[c])), { onConflict: '*', returning: false });
    return this._get(v.event_id);
  }

  async get(eventId) {
    return this._get(eventId);
  }

  async confirm(eventId, { category, by, at }) {
    await this.s.run('UPDATE li_reply_routes SET confirmed = ?, confirmed_by = ?, confirmed_at = ? WHERE event_id = ? AND workspace_id = ?', [category, by, at, String(eventId), this.s.workspaceId]);
    return this._get(eventId);
  }

  async forLead(leadId, limit) {
    const list = await this.s.q('li_reply_routes', `SELECT ${ROUTE_COLS.join(', ')} FROM li_reply_routes WHERE lead_id = ? AND workspace_id = ? ORDER BY routed_at DESC, event_id DESC LIMIT ?`, [String(leadId), this.s.workspaceId, clampLimit(limit)]);
    return list.map(freeze);
  }

  async list({ kinds = null, limit, offset = 0 } = {}) {
    const ks = kinds || [];
    const where = ks.length ? ` WHERE kind IN (${ks.map(() => '?').join(',')}) AND workspace_id = ?` : ' WHERE workspace_id = ?';
    const params = ks.length ? [...ks, this.s.workspaceId] : [this.s.workspaceId];
    const list = await this.s.q('li_reply_routes', `SELECT ${ROUTE_COLS.join(', ')} FROM li_reply_routes${where} ORDER BY routed_at DESC, event_id DESC LIMIT ? OFFSET ?`, [...params, clampLimit(limit), clampOffset(offset)]);
    return list.map(freeze);
  }

  async deleteByLead(leadId) {
    await this.s.run('DELETE FROM li_reply_routes WHERE lead_id = ? AND workspace_id = ?', [String(leadId), this.s.workspaceId]);
  }
}

module.exports = { PgReplyRoutes };
