'use strict';

/**
 * F26.6: mailbox repositories (migration 010), in their SqlJs and Memory twins.
 *
 * Retention: mailbox rows, provider-stored sent ids and market rules are NOT lead data, so
 * purgeLead leaves them. Disconnecting a mailbox removes its row; its past sends keep their
 * mailbox_id (history), and li_mailbox_sent rows stay so a late reply still resolves.
 */

const { requireValid, normalizeMailboxRecord, normalizeMarketRule, normalizeLimits } = require('../mailbox/mailboxContract');

const MAILBOX_COLS = ['mailbox_id', 'provider', 'email_address', 'display_name', 'status', 'status_code', 'paused_until', 'daily_cap', 'hourly_cap', 'min_gap_seconds', 'window_start', 'window_end', 'window_days', 'time_zone', 'is_default', 'sync_cursor', 'connected_at', 'updated_at'];
const SENT_COLS = ['send_id', 'mailbox_id', 'provider_message_id', 'stored_message_id', 'thread_id', 'recorded_at'];
const RULE_COLS = ['country_code', 'rule', 'note', 'reviewed_by', 'reviewed_at'];
const SENT_ID_MAX = 300;

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
const strOrNull = (v, max = SENT_ID_MAX) => (v == null || v === '' ? null : String(v).slice(0, max));

function normalizeSent(rec) {
  if (!rec || typeof rec.send_id !== 'string' || !rec.send_id) throw new TypeError('mailbox sent: send_id');
  if (typeof rec.mailbox_id !== 'string' || !rec.mailbox_id) throw new TypeError('mailbox sent: mailbox_id');
  if (typeof rec.recorded_at !== 'string') throw new TypeError('mailbox sent: recorded_at');
  return {
    send_id: rec.send_id, mailbox_id: rec.mailbox_id, provider_message_id: strOrNull(rec.provider_message_id),
    stored_message_id: strOrNull(rec.stored_message_id), thread_id: strOrNull(rec.thread_id), recorded_at: rec.recorded_at,
  };
}

/* =============================== SQL =============================== */

class SqlMailboxes {
  constructor(store) { this.s = store; }

  /** Insert a newly connected mailbox, or refresh identity on reconnect (limits kept). */
  async upsert(rec) {
    const v = requireValid(normalizeMailboxRecord(rec));
    return this.s.tx(() => {
      const existing = sqlRow(this.s.db, 'SELECT mailbox_id FROM li_mailboxes WHERE provider = ? AND email_address = ?', [v.provider, v.email_address]);
      if (existing) {
        this.s.db.run('UPDATE li_mailboxes SET display_name = ?, status = ?, status_code = ?, paused_until = NULL, updated_at = ? WHERE mailbox_id = ?',
          [v.display_name, v.status, v.status_code, v.updated_at, existing.mailbox_id]);
        return freeze(sqlRow(this.s.db, `SELECT ${MAILBOX_COLS.join(', ')} FROM li_mailboxes WHERE mailbox_id = ?`, [existing.mailbox_id]));
      }
      const first = sqlRow(this.s.db, 'SELECT COUNT(*) AS n FROM li_mailboxes').n === 0;
      const row = { ...v, is_default: first ? 1 : v.is_default };
      this.s.db.run(`INSERT INTO li_mailboxes (${MAILBOX_COLS.join(', ')}) VALUES (${ph(MAILBOX_COLS)})`, MAILBOX_COLS.map((c) => row[c]));
      return freeze(sqlRow(this.s.db, `SELECT ${MAILBOX_COLS.join(', ')} FROM li_mailboxes WHERE mailbox_id = ?`, [v.mailbox_id]));
    });
  }

  async get(mailboxId) {
    return freeze(sqlRow(this.s.db, `SELECT ${MAILBOX_COLS.join(', ')} FROM li_mailboxes WHERE mailbox_id = ?`, [String(mailboxId)]));
  }

  async list() {
    return sqlRows(this.s.db, `SELECT ${MAILBOX_COLS.join(', ')} FROM li_mailboxes ORDER BY is_default DESC, connected_at ASC, mailbox_id ASC`).map(freeze);
  }

  async getDefault() {
    return freeze(sqlRow(this.s.db, `SELECT ${MAILBOX_COLS.join(', ')} FROM li_mailboxes WHERE is_default = 1 LIMIT 1`));
  }

  async setStatus(mailboxId, { status, status_code = null, paused_until = null, updated_at }) {
    const current = await this.get(mailboxId);
    if (!current) return null;
    requireValid(normalizeMailboxRecord({ ...current, status, status_code, paused_until, updated_at }));
    return this.s.tx(() => {
      this.s.db.run('UPDATE li_mailboxes SET status = ?, status_code = ?, paused_until = ?, updated_at = ? WHERE mailbox_id = ?',
        [status, status_code, paused_until, updated_at, String(mailboxId)]);
      return freeze(sqlRow(this.s.db, `SELECT ${MAILBOX_COLS.join(', ')} FROM li_mailboxes WHERE mailbox_id = ?`, [String(mailboxId)]));
    });
  }

  async setLimits(mailboxId, patch, updatedAt) {
    const current = await this.get(mailboxId);
    if (!current) return null;
    const limits = requireValid(normalizeLimits(patch, current));
    const tz = patch && patch.time_zone !== undefined ? patch.time_zone : current.time_zone;
    const v = requireValid(normalizeMailboxRecord({ ...current, ...limits, time_zone: tz, updated_at: updatedAt }));
    return this.s.tx(() => {
      this.s.db.run('UPDATE li_mailboxes SET daily_cap = ?, hourly_cap = ?, min_gap_seconds = ?, window_start = ?, window_end = ?, window_days = ?, time_zone = ?, updated_at = ? WHERE mailbox_id = ?',
        [v.daily_cap, v.hourly_cap, v.min_gap_seconds, v.window_start, v.window_end, v.window_days, v.time_zone, v.updated_at, v.mailbox_id]);
      return freeze(sqlRow(this.s.db, `SELECT ${MAILBOX_COLS.join(', ')} FROM li_mailboxes WHERE mailbox_id = ?`, [v.mailbox_id]));
    });
  }

  async setDefault(mailboxId, updatedAt) {
    if (!(await this.get(mailboxId))) return null;
    return this.s.tx(() => {
      this.s.db.run('UPDATE li_mailboxes SET is_default = CASE WHEN mailbox_id = ? THEN 1 ELSE 0 END, updated_at = CASE WHEN mailbox_id = ? THEN ? ELSE updated_at END', [String(mailboxId), String(mailboxId), updatedAt]);
      return freeze(sqlRow(this.s.db, `SELECT ${MAILBOX_COLS.join(', ')} FROM li_mailboxes WHERE mailbox_id = ?`, [String(mailboxId)]));
    });
  }

  async setSyncCursor(mailboxId, cursor, updatedAt) {
    return this.s.tx(() => {
      this.s.db.run('UPDATE li_mailboxes SET sync_cursor = ?, updated_at = ? WHERE mailbox_id = ?', [strOrNull(cursor, 64), updatedAt, String(mailboxId)]);
      return this.s.db.getRowsModified() > 0;
    });
  }

  /** Remove a mailbox. If it was the default, the oldest remaining mailbox becomes the default. */
  async remove(mailboxId) {
    return this.s.tx(() => {
      const was = sqlRow(this.s.db, 'SELECT is_default FROM li_mailboxes WHERE mailbox_id = ?', [String(mailboxId)]);
      this.s.db.run('DELETE FROM li_mailboxes WHERE mailbox_id = ?', [String(mailboxId)]);
      const removed = this.s.db.getRowsModified() > 0;
      if (removed && was && was.is_default === 1) {
        this.s.db.run('UPDATE li_mailboxes SET is_default = 1 WHERE mailbox_id = (SELECT mailbox_id FROM li_mailboxes ORDER BY connected_at ASC, mailbox_id ASC LIMIT 1)');
      }
      return removed;
    });
  }
}

class SqlMailboxSent {
  constructor(store) { this.s = store; }

  async record(rec) {
    const v = normalizeSent(rec);
    return this.s.tx(() => {
      // Upsert on send_id only. NOT "INSERT OR REPLACE": that would silently delete ANOTHER send's
      // row on a stored-id clash, where the unique (mailbox_id, stored_message_id) index must refuse.
      this.s.db.run(`INSERT INTO li_mailbox_sent (${SENT_COLS.join(', ')}) VALUES (${ph(SENT_COLS)})
        ON CONFLICT(send_id) DO UPDATE SET mailbox_id = excluded.mailbox_id, provider_message_id = excluded.provider_message_id,
        stored_message_id = excluded.stored_message_id, thread_id = excluded.thread_id, recorded_at = excluded.recorded_at`, SENT_COLS.map((c) => v[c]));
      return freeze(sqlRow(this.s.db, `SELECT ${SENT_COLS.join(', ')} FROM li_mailbox_sent WHERE send_id = ?`, [v.send_id]));
    });
  }

  async get(sendId) {
    return freeze(sqlRow(this.s.db, `SELECT ${SENT_COLS.join(', ')} FROM li_mailbox_sent WHERE send_id = ?`, [String(sendId)]));
  }

  /** The send whose PROVIDER-STORED Message-ID is one of `ids` in this mailbox, or null. */
  async findByStoredIds(mailboxId, ids) {
    const list = (Array.isArray(ids) ? ids : []).filter((x) => typeof x === 'string' && x).slice(0, 50);
    if (!list.length) return null;
    return freeze(sqlRow(this.s.db,
      `SELECT ${SENT_COLS.join(', ')} FROM li_mailbox_sent WHERE mailbox_id = ? AND stored_message_id IN (${list.map(() => '?').join(', ')}) ORDER BY recorded_at DESC LIMIT 1`,
      [String(mailboxId), ...list]));
  }
}

class SqlMarketRules {
  constructor(store) { this.s = store; }

  async set(rec) {
    const v = requireValid(normalizeMarketRule(rec));
    return this.s.tx(() => {
      this.s.db.run(`INSERT OR REPLACE INTO li_market_rules (${RULE_COLS.join(', ')}) VALUES (${ph(RULE_COLS)})`, RULE_COLS.map((c) => v[c]));
      return freeze(sqlRow(this.s.db, `SELECT ${RULE_COLS.join(', ')} FROM li_market_rules WHERE country_code = ?`, [v.country_code]));
    });
  }

  async get(code) {
    return freeze(sqlRow(this.s.db, `SELECT ${RULE_COLS.join(', ')} FROM li_market_rules WHERE country_code = ?`, [String(code || '').toUpperCase()]));
  }

  async list() {
    return sqlRows(this.s.db, `SELECT ${RULE_COLS.join(', ')} FROM li_market_rules ORDER BY country_code ASC`).map(freeze);
  }

  async remove(code) {
    return this.s.tx(() => {
      this.s.db.run('DELETE FROM li_market_rules WHERE country_code = ?', [String(code || '').toUpperCase()]);
      return this.s.db.getRowsModified() > 0;
    });
  }
}

/* ============================= MEMORY ============================== */

const sortBy = (...keys) => (a, b) => {
  for (const [k, dir] of keys) {
    if (a[k] === b[k]) continue;
    return (a[k] < b[k] ? -1 : 1) * (dir === 'desc' ? -1 : 1);
  }
  return 0;
};

class MemMailboxes {
  constructor() { this.rows = new Map(); }

  async upsert(rec) {
    const v = requireValid(normalizeMailboxRecord(rec));
    const existing = [...this.rows.values()].find((r) => r.provider === v.provider && r.email_address === v.email_address);
    if (existing) {
      Object.assign(existing, { display_name: v.display_name, status: v.status, status_code: v.status_code, paused_until: null, updated_at: v.updated_at });
      return freeze(existing);
    }
    const row = { ...v, is_default: this.rows.size === 0 ? 1 : v.is_default };
    this.rows.set(v.mailbox_id, row);
    return freeze(row);
  }

  async get(mailboxId) { return freeze(this.rows.get(String(mailboxId)) || null); }

  async list() {
    return [...this.rows.values()].sort(sortBy(['is_default', 'desc'], ['connected_at', 'asc'], ['mailbox_id', 'asc'])).map(freeze);
  }

  async getDefault() { return freeze([...this.rows.values()].find((r) => r.is_default === 1) || null); }

  async setStatus(mailboxId, { status, status_code = null, paused_until = null, updated_at }) {
    const r = this.rows.get(String(mailboxId));
    if (!r) return null;
    requireValid(normalizeMailboxRecord({ ...r, status, status_code, paused_until, updated_at }));
    Object.assign(r, { status, status_code, paused_until, updated_at });
    return freeze(r);
  }

  async setLimits(mailboxId, patch, updatedAt) {
    const r = this.rows.get(String(mailboxId));
    if (!r) return null;
    const limits = requireValid(normalizeLimits(patch, r));
    const tz = patch && patch.time_zone !== undefined ? patch.time_zone : r.time_zone;
    const v = requireValid(normalizeMailboxRecord({ ...r, ...limits, time_zone: tz, updated_at: updatedAt }));
    Object.assign(r, { daily_cap: v.daily_cap, hourly_cap: v.hourly_cap, min_gap_seconds: v.min_gap_seconds, window_start: v.window_start, window_end: v.window_end, window_days: v.window_days, time_zone: v.time_zone, updated_at: v.updated_at });
    return freeze(r);
  }

  async setDefault(mailboxId, updatedAt) {
    if (!this.rows.has(String(mailboxId))) return null;
    for (const r of this.rows.values()) {
      const on = r.mailbox_id === String(mailboxId);
      r.is_default = on ? 1 : 0;
      if (on) r.updated_at = updatedAt;
    }
    return freeze(this.rows.get(String(mailboxId)));
  }

  async setSyncCursor(mailboxId, cursor, updatedAt) {
    const r = this.rows.get(String(mailboxId));
    if (!r) return false;
    r.sync_cursor = strOrNull(cursor, 64);
    r.updated_at = updatedAt;
    return true;
  }

  async remove(mailboxId) {
    const r = this.rows.get(String(mailboxId));
    if (!r) return false;
    this.rows.delete(String(mailboxId));
    if (r.is_default === 1) {
      const next = [...this.rows.values()].sort(sortBy(['connected_at', 'asc'], ['mailbox_id', 'asc']))[0];
      if (next) next.is_default = 1;
    }
    return true;
  }
}

class MemMailboxSent {
  constructor() { this.rows = new Map(); }
  async record(rec) {
    const v = normalizeSent(rec);
    if (v.stored_message_id && [...this.rows.values()].some((r) => r.send_id !== v.send_id && r.mailbox_id === v.mailbox_id && r.stored_message_id === v.stored_message_id)) {
      throw new Error('UNIQUE constraint failed: li_mailbox_sent.mailbox_id, li_mailbox_sent.stored_message_id');
    }
    this.rows.set(v.send_id, v);
    return freeze(v);
  }
  async get(sendId) { return freeze(this.rows.get(String(sendId)) || null); }
  async findByStoredIds(mailboxId, ids) {
    const list = new Set((Array.isArray(ids) ? ids : []).filter((x) => typeof x === 'string' && x).slice(0, 50));
    const hits = [...this.rows.values()].filter((r) => r.mailbox_id === String(mailboxId) && r.stored_message_id && list.has(r.stored_message_id)).sort(sortBy(['recorded_at', 'desc']));
    return freeze(hits[0] || null);
  }
}

class MemMarketRules {
  constructor() { this.rows = new Map(); }
  async set(rec) { const v = requireValid(normalizeMarketRule(rec)); this.rows.set(v.country_code, v); return freeze(v); }
  async get(code) { return freeze(this.rows.get(String(code || '').toUpperCase()) || null); }
  async list() { return [...this.rows.values()].sort(sortBy(['country_code', 'asc'])).map(freeze); }
  async remove(code) { return this.rows.delete(String(code || '').toUpperCase()); }
}

module.exports = {
  SqlMailboxes, SqlMailboxSent, SqlMarketRules, MemMailboxes, MemMailboxSent, MemMarketRules,
  MAILBOX_TABLE_COLUMNS: Object.freeze({ li_mailboxes: MAILBOX_COLS, li_mailbox_sent: SENT_COLS, li_market_rules: RULE_COLS }),
};
