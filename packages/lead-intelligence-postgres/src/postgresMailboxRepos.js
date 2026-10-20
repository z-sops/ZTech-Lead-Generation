'use strict';

/**
 * The PostgreSQL mailbox repositories (M1): the connected mailboxes, what the
 * provider stored for each send, the per-country market rules and the human
 * review of a verified reply.
 *
 * li_market_rules is GLOBAL - a market rule is the same in every workspace -
 * so it carries no workspace and the store reads every workspace's copy. That
 * is the only table in this group without a workspace.
 */

const MAILBOX_COLS = ['mailbox_id', 'provider', 'email_address', 'display_name', 'status', 'status_code', 'paused_until', 'daily_cap', 'hourly_cap', 'min_gap_seconds', 'window_start', 'window_end', 'window_days', 'time_zone', 'is_default', 'sync_cursor', 'connected_at', 'updated_at'];
const SENT_COLS = ['send_id', 'mailbox_id', 'provider_message_id', 'stored_message_id', 'thread_id', 'recipient_address', 'recorded_at'];
const RULE_COLS = ['country_code', 'rule', 'note', 'reviewed_by', 'reviewed_at'];
const REVIEW_COLS = ['review_id', 'event_id', 'channel', 'normalized_address', 'outcome', 'reviewed_by', 'reviewed_at'];

const SENT_ID_MAX = 300;
const freeze = (r) => (r ? Object.freeze({ ...r }) : null);
const strOrNull = (v, max = SENT_ID_MAX) => (v == null || v === '' ? null : String(v).slice(0, max));

class PgMailboxes {
  constructor(store) { this.s = store; }

  async upsert(rec) {
    const v = { ...rec };
    const existing = await this.s.one('li_mailboxes', 'SELECT mailbox_id FROM li_mailboxes WHERE provider = ? AND email_address = ? AND workspace_id = ?', [v.provider, v.email_address, this.s.workspaceId]);
    if (existing) {
      await this.s.run('UPDATE li_mailboxes SET display_name = ?, status = ?, status_code = ?, paused_until = NULL, updated_at = ? WHERE mailbox_id = ? AND workspace_id = ?', [
        v.display_name ?? null, v.status, v.status_code ?? null, v.updated_at, existing.mailbox_id, this.s.workspaceId,
      ]);
      return freeze(await this.s.one('li_mailboxes', `SELECT ${MAILBOX_COLS.join(', ')} FROM li_mailboxes WHERE mailbox_id = ? AND workspace_id = ?`, [existing.mailbox_id, this.s.workspaceId]));
    }
    const first = await this.s.one('li_mailboxes', 'SELECT COUNT(*) AS n FROM li_mailboxes WHERE workspace_id = ?', [this.s.workspaceId]);
    const row = { ...v, is_default: first && Number(first.n) === 0 ? 1 : (v.is_default ?? 0) };
    const values = MAILBOX_COLS.map((c) => (row[c] === undefined ? null : row[c]));
    // The sending window is a time of day, not an instant: it is kept as the
    // text it is, exactly as the desktop keeps it.
    for (const c of ['window_start', 'window_end']) {
      if (values[MAILBOX_COLS.indexOf(c)] !== null) values[MAILBOX_COLS.indexOf(c)] = String(values[MAILBOX_COLS.indexOf(c)]);
    }
    await this.s.insert('li_mailboxes', MAILBOX_COLS, values);
    return freeze(await this.s.one('li_mailboxes', `SELECT ${MAILBOX_COLS.join(', ')} FROM li_mailboxes WHERE mailbox_id = ? AND workspace_id = ?`, [v.mailbox_id, this.s.workspaceId]));
  }

  async get(mailboxId) {
    return freeze(await this.s.one('li_mailboxes', `SELECT ${MAILBOX_COLS.join(', ')} FROM li_mailboxes WHERE mailbox_id = ? AND workspace_id = ?`, [String(mailboxId), this.s.workspaceId]));
  }

  async list() {
    const list = await this.s.q('li_mailboxes', `SELECT ${MAILBOX_COLS.join(', ')} FROM li_mailboxes WHERE workspace_id = ? ORDER BY is_default DESC, connected_at ASC, mailbox_id ASC`, [this.s.workspaceId]);
    return list.map(freeze);
  }

  async getDefault() {
    return freeze(await this.s.one('li_mailboxes', `SELECT ${MAILBOX_COLS.join(', ')} FROM li_mailboxes WHERE is_default = true AND workspace_id = ? LIMIT 1`, [this.s.workspaceId]));
  }

  async setStatus(mailboxId, { status, status_code = null, paused_until = null, updated_at }) {
    await this.s.run('UPDATE li_mailboxes SET status = ?, status_code = ?, paused_until = ?, updated_at = ? WHERE mailbox_id = ? AND workspace_id = ?', [
      status, status_code, paused_until, updated_at, String(mailboxId), this.s.workspaceId,
    ]);
    return this.get(mailboxId);
  }

  async setLimits(mailboxId, patch, updatedAt) {
    const v = patch || {};
    await this.s.run('UPDATE li_mailboxes SET daily_cap = ?, hourly_cap = ?, min_gap_seconds = ?, window_start = ?, window_end = ?, window_days = ?, time_zone = ?, updated_at = ? WHERE mailbox_id = ? AND workspace_id = ?', [
      v.daily_cap, v.hourly_cap, v.min_gap_seconds, v.window_start, v.window_end, v.window_days, v.time_zone, updatedAt, String(mailboxId), this.s.workspaceId,
    ]);
    return this.get(mailboxId);
  }

  async setDefault(mailboxId, updatedAt) {
    await this.s.run('UPDATE li_mailboxes SET is_default = CASE WHEN mailbox_id = ? THEN true ELSE false END, updated_at = CASE WHEN mailbox_id = ? THEN ? ELSE updated_at END WHERE workspace_id = ?', [String(mailboxId), String(mailboxId), updatedAt, this.s.workspaceId]);
    return this.get(mailboxId);
  }

  async setSyncCursor(mailboxId, cursor, updatedAt) {
    await this.s.run('UPDATE li_mailboxes SET sync_cursor = ?, updated_at = ? WHERE mailbox_id = ? AND workspace_id = ?', [strOrNull(cursor, 64), updatedAt, String(mailboxId), this.s.workspaceId]);
    return this.get(mailboxId);
  }

  async remove(mailboxId) {
    const was = await this.s.one('li_mailboxes', 'SELECT is_default FROM li_mailboxes WHERE mailbox_id = ? AND workspace_id = ?', [String(mailboxId), this.s.workspaceId]);
    await this.s.run('DELETE FROM li_mailboxes WHERE mailbox_id = ? AND workspace_id = ?', [String(mailboxId), this.s.workspaceId]);
    if (was && Number(was.is_default) === 1) {
      await this.s.run('UPDATE li_mailboxes SET is_default = true WHERE mailbox_id = (SELECT mailbox_id FROM li_mailboxes WHERE workspace_id = ? ORDER BY connected_at ASC, mailbox_id ASC LIMIT 1)', [this.s.workspaceId]);
    }
    return true;
  }
}

class PgMailboxSent {
  constructor(store) { this.s = store; }

  async record(rec) {
    const v = {
      send_id: rec.send_id,
      mailbox_id: rec.mailbox_id,
      provider_message_id: strOrNull(rec.provider_message_id),
      stored_message_id: strOrNull(rec.stored_message_id),
      thread_id: strOrNull(rec.thread_id),
      recipient_address: strOrNull(rec.recipient_address),
      recorded_at: rec.recorded_at,
    };
    await this.s.insert('li_mailbox_sent', SENT_COLS, SENT_COLS.map((c) => v[c] ?? null), { onConflict: '*', returning: false });
    return freeze(await this.s.one('li_mailbox_sent', `SELECT ${SENT_COLS.join(', ')} FROM li_mailbox_sent WHERE send_id = ? AND workspace_id = ?`, [v.send_id, this.s.workspaceId]));
  }

  async get(sendId) {
    return freeze(await this.s.one('li_mailbox_sent', `SELECT ${SENT_COLS.join(', ')} FROM li_mailbox_sent WHERE send_id = ? AND workspace_id = ?`, [String(sendId), this.s.workspaceId]));
  }

  async findByStoredIds(mailboxId, ids) {
    const list = (Array.isArray(ids) ? ids : []).filter((x) => typeof x === 'string' && x).slice(0, 50);
    if (!list.length) return null;
    return freeze(await this.s.one('li_mailbox_sent', `SELECT ${SENT_COLS.join(', ')} FROM li_mailbox_sent WHERE mailbox_id = ? AND stored_message_id IN (${list.map(() => '?').join(', ')}) AND workspace_id = ? ORDER BY recorded_at DESC LIMIT 1`, [String(mailboxId), ...list, this.s.workspaceId]));
  }
}

class PgMarketRules {
  constructor(store) { this.s = store; }

  async set(rec) {
    const v = { ...rec, country_code: String(rec.country_code || '').toUpperCase() };
    await this.s.insert('li_market_rules', RULE_COLS, RULE_COLS.map((c) => v[c]), { onConflict: 'country_code', update: ['rule', 'note', 'reviewed_by', 'reviewed_at'] });
    return freeze(await this.s.one('li_market_rules', `SELECT ${RULE_COLS.join(', ')} FROM li_market_rules WHERE country_code = ?`, [v.country_code]));
  }

  async get(code) {
    return freeze(await this.s.one('li_market_rules', `SELECT ${RULE_COLS.join(', ')} FROM li_market_rules WHERE country_code = ?`, [String(code || '').toUpperCase()]));
  }

  async list() {
    const list = await this.s.q('li_market_rules', `SELECT ${RULE_COLS.join(', ')} FROM li_market_rules ORDER BY country_code ASC`);
    return list.map(freeze);
  }

  async remove(code) {
    const n = await this.s.run('DELETE FROM li_market_rules WHERE country_code = ?', [String(code || '').toUpperCase()]);
    return n > 0;
  }
}

class PgReplyReviews {
  constructor(store) { this.s = store; }

  async put(rec) {
    const v = { ...rec };
    await this.s.insert('li_reply_reviews', REVIEW_COLS, REVIEW_COLS.map((c) => v[c]), { onConflict: 'event_id', update: ['outcome', 'reviewed_by', 'reviewed_at'] });
    return freeze(await this.s.one('li_reply_reviews', `SELECT ${REVIEW_COLS.join(', ')} FROM li_reply_reviews WHERE event_id = ? AND workspace_id = ?`, [v.event_id, this.s.workspaceId]));
  }

  async forEvent(eventId) {
    return freeze(await this.s.one('li_reply_reviews', `SELECT ${REVIEW_COLS.join(', ')} FROM li_reply_reviews WHERE event_id = ? AND workspace_id = ?`, [String(eventId), this.s.workspaceId]));
  }

  async latestFor({ channel, address }) {
    return freeze(await this.s.one('li_reply_reviews', `SELECT ${REVIEW_COLS.join(', ')} FROM li_reply_reviews WHERE channel = ? AND normalized_address = ? AND workspace_id = ? ORDER BY reviewed_at DESC, review_id DESC LIMIT 1`, [channel, address, this.s.workspaceId]));
  }
}

module.exports = { PgMailboxes, PgMailboxSent, PgMarketRules, PgReplyReviews };
