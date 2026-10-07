'use strict';

/**
 * F26.5: the five trust repositories, in their two twin implementations.
 *
 *   Sql*  - on ZTech's existing sql.js Database (SqlJsStore), against migration 008.
 *   Mem*  - the in-memory twin (MemoryStore) with identical semantics, used by tests.
 *
 * Every write is validated by trust/trustContract.js first, so neither store can hold a value
 * the other would refuse. The repos hold ONLY what the contract allows: codes, ids, normalized
 * addresses, short notes and timestamps. No pitch text, research or credentials.
 *
 * Retention (what purgeLead removes):
 *   - provenance and consents are LEAD data      -> removed with the lead.
 *   - suppressions, trust events, recipient refs -> address-keyed and KEPT. A suppression that
 *     vanished with the lead would let the same address be contacted again after a re-import.
 */

const {
  DEFAULT_WORKSPACE_ID, normalizeAddress, requireValid,
  normalizeSuppressionRecord, normalizeConsentRecord, normalizeProvenanceRecord,
  normalizeTrustEventRecord, normalizeRecipientRefRecord, TRUST_EVENT_KINDS,
} = require('../trust/trustContract');

const SUPPRESSION_COLS = ['suppression_id', 'scope', 'workspace_id', 'channel', 'normalized_address', 'reason', 'source', 'created_at'];
const CONSENT_COLS = ['consent_id', 'lead_id', 'channel', 'normalized_address', 'method', 'evidence_note', 'recorded_by', 'consented_at', 'recorded_at', 'source', 'event_id'];
const PROVENANCE_COLS = ['lead_id', 'field', 'source_kind', 'source_ref', 'collected_at', 'backfilled', 'recorded_at'];
const EVENT_COLS = ['row_id', 'event_id', 'kind', 'channel', 'recipient_ref', 'normalized_address', 'source', 'state', 'reject_code', 'received_at', 'recorded_at'];
const REF_COLS = ['recipient_ref', 'channel', 'normalized_address', 'created_at'];

const LIST_MAX = 100;

function clampLimit(limit, fallback = 20) {
  const n = Number(limit);
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return Math.min(n, LIST_MAX);
}
function clampOffset(offset) {
  const n = Number(offset);
  return Number.isInteger(n) && n >= 0 ? Math.min(n, 100000) : 0;
}

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
const placeholders = (cols) => cols.map(() => '?').join(', ');
const freeze = (r) => (r ? Object.freeze({ ...r }) : null);

/* =============================== SQL =============================== */

class SqlSuppressions {
  constructor(store) { this.s = store; }

  /** Idempotent: suppressing an already-suppressed (scope, workspace, channel, address) returns the existing row. */
  async add(rec) {
    const v = requireValid(normalizeSuppressionRecord(rec));
    return this.s.tx(() => {
      this.s.db.run(`INSERT OR IGNORE INTO li_suppressions (${SUPPRESSION_COLS.join(', ')}) VALUES (${placeholders(SUPPRESSION_COLS)})`,
        SUPPRESSION_COLS.map((c) => v[c]));
      const created = this.s.db.getRowsModified() > 0;
      const row = sqlRow(this.s.db,
        `SELECT ${SUPPRESSION_COLS.join(', ')} FROM li_suppressions WHERE scope = ? AND IFNULL(workspace_id, '') = ? AND channel = ? AND normalized_address = ?`,
        [v.scope, v.workspace_id || '', v.channel, v.normalized_address]);
      return { row: freeze(row), created };
    });
  }

  /** The suppression that applies to this address in this workspace (a global row wins), or null. */
  async find({ channel, address, workspaceId = DEFAULT_WORKSPACE_ID }) {
    const a = normalizeAddress(channel, address);
    if (!a) return null;
    return freeze(sqlRow(this.s.db,
      `SELECT ${SUPPRESSION_COLS.join(', ')} FROM li_suppressions WHERE channel = ? AND normalized_address = ? `
      + "AND (scope = 'global' OR (scope = 'workspace' AND workspace_id = ?)) "
      + "ORDER BY CASE scope WHEN 'global' THEN 0 ELSE 1 END, created_at ASC, suppression_id ASC LIMIT 1",
      [channel, a, String(workspaceId)]));
  }

  async listForAddress({ channel, address }) {
    const a = normalizeAddress(channel, address);
    if (!a) return [];
    return sqlRows(this.s.db,
      `SELECT ${SUPPRESSION_COLS.join(', ')} FROM li_suppressions WHERE channel = ? AND normalized_address = ? ORDER BY created_at ASC, suppression_id ASC`,
      [channel, a]).map(freeze);
  }

  async list({ limit, offset } = {}) {
    const total = sqlRow(this.s.db, 'SELECT COUNT(*) AS n FROM li_suppressions').n;
    const rows = sqlRows(this.s.db,
      `SELECT ${SUPPRESSION_COLS.join(', ')} FROM li_suppressions ORDER BY created_at DESC, suppression_id DESC LIMIT ? OFFSET ?`,
      [clampLimit(limit), clampOffset(offset)]).map(freeze);
    return { rows, total };
  }

  /**
   * Only a MANUAL suppression the user made can be lifted (an honest mistake). An unsubscribe,
   * bounce or complaint is the recipient's or the provider's fact and is never removable here.
   */
  async removeManual(suppressionId) {
    return this.s.tx(() => {
      this.s.db.run("DELETE FROM li_suppressions WHERE suppression_id = ? AND reason = 'manual' AND source = 'user'", [String(suppressionId)]);
      return this.s.db.getRowsModified() > 0;
    });
  }
}

class SqlConsents {
  constructor(store) { this.s = store; }

  async record(rec) {
    const v = requireValid(normalizeConsentRecord(rec));
    return this.s.tx(() => {
      this.s.db.run(`INSERT INTO li_contact_consents (${CONSENT_COLS.join(', ')}) VALUES (${placeholders(CONSENT_COLS)})`, CONSENT_COLS.map((c) => v[c]));
      return freeze(sqlRow(this.s.db, `SELECT ${CONSENT_COLS.join(', ')} FROM li_contact_consents WHERE consent_id = ?`, [v.consent_id]));
    });
  }

  /** The newest consent recorded for this exact address on this channel, or null. */
  async latestFor({ channel, address }) {
    const a = normalizeAddress(channel, address);
    if (!a) return null;
    return freeze(sqlRow(this.s.db,
      `SELECT ${CONSENT_COLS.join(', ')} FROM li_contact_consents WHERE channel = ? AND normalized_address = ? ORDER BY consented_at DESC, recorded_at DESC, consent_id DESC LIMIT 1`,
      [channel, a]));
  }

  async listByLead(leadId, limit = 20) {
    return sqlRows(this.s.db,
      `SELECT ${CONSENT_COLS.join(', ')} FROM li_contact_consents WHERE lead_id = ? ORDER BY recorded_at DESC, consent_id DESC LIMIT ?`,
      [String(leadId), clampLimit(limit)]).map(freeze);
  }

  _deleteByLeadSql(leadId) { this.s.db.run('DELETE FROM li_contact_consents WHERE lead_id = ?', [String(leadId)]); }
}

class SqlProvenance {
  constructor(store) { this.s = store; }

  /**
   * A captured fact REPLACES what was there. A backfilled row is only ever written where no
   * row exists, so a backfill can never overwrite a real capture.
   */
  async put(rec, { ifAbsent = false } = {}) {
    return (await this.putMany([rec], { ifAbsent }))[0];
  }

  /**
   * Several provenance rows in ONE transaction (one save of the database file). `ifAbsent`
   * writes a captured row only where none exists, so a later save that merely repeats a value
   * never re-attributes a field that was already there.
   */
  async putMany(recs, { ifAbsent = false } = {}) {
    const values = (Array.isArray(recs) ? recs : []).map((r) => requireValid(normalizeProvenanceRecord(r)));
    if (!values.length) return [];
    return this.s.tx(() => values.map((v) => {
      const verb = v.backfilled || ifAbsent ? 'INSERT OR IGNORE' : 'INSERT OR REPLACE';
      this.s.db.run(`${verb} INTO li_contact_provenance (${PROVENANCE_COLS.join(', ')}) VALUES (${placeholders(PROVENANCE_COLS)})`, PROVENANCE_COLS.map((c) => v[c]));
      const written = this.s.db.getRowsModified() > 0;
      const row = sqlRow(this.s.db, `SELECT ${PROVENANCE_COLS.join(', ')} FROM li_contact_provenance WHERE lead_id = ? AND field = ?`, [v.lead_id, v.field]);
      return { row: freeze(row), written };
    }));
  }

  /** The lead ids that already have at least one provenance row (for the one-time backfill). */
  async leadIds() {
    return new Set(sqlRows(this.s.db, 'SELECT DISTINCT lead_id FROM li_contact_provenance').map((r) => r.lead_id));
  }

  async listByLead(leadId) {
    return sqlRows(this.s.db,
      `SELECT ${PROVENANCE_COLS.join(', ')} FROM li_contact_provenance WHERE lead_id = ? ORDER BY field ASC`, [String(leadId)]).map(freeze);
  }

  _deleteByLeadSql(leadId) { this.s.db.run('DELETE FROM li_contact_provenance WHERE lead_id = ?', [String(leadId)]); }
}

class SqlTrustEvents {
  constructor(store) { this.s = store; }

  /**
   * Append-only and idempotent by event_id. A second accepted event with a known event_id is a
   * no-op that returns the first row. A rejected row is always appended (it is outside the
   * unique index) so a forged copy can never shadow the genuine event.
   */
  async append(rec) {
    const v = requireValid(normalizeTrustEventRecord(rec));
    return this.s.tx(() => {
      this.s.db.run(`INSERT OR IGNORE INTO li_trust_events (${EVENT_COLS.join(', ')}) VALUES (${placeholders(EVENT_COLS)})`, EVENT_COLS.map((c) => v[c]));
      const created = this.s.db.getRowsModified() > 0;
      const row = created
        ? sqlRow(this.s.db, `SELECT ${EVENT_COLS.join(', ')} FROM li_trust_events WHERE row_id = ?`, [v.row_id])
        : sqlRow(this.s.db, `SELECT ${EVENT_COLS.join(', ')} FROM li_trust_events WHERE event_id = ? AND state != 'rejected'`, [v.event_id]);
      return { row: freeze(row), created };
    });
  }

  async get(eventId) {
    return freeze(sqlRow(this.s.db, `SELECT ${EVENT_COLS.join(', ')} FROM li_trust_events WHERE event_id = ? AND state != 'rejected'`, [String(eventId)]));
  }

  /** The newest accepted event of the given kinds for this address, or null. */
  async latestFor({ channel, address, kinds = TRUST_EVENT_KINDS }) {
    const a = normalizeAddress(channel, address);
    const ks = (Array.isArray(kinds) ? kinds : []).filter((k) => TRUST_EVENT_KINDS.includes(k));
    if (!a || !ks.length) return null;
    return freeze(sqlRow(this.s.db,
      `SELECT ${EVENT_COLS.join(', ')} FROM li_trust_events WHERE channel = ? AND normalized_address = ? AND state != 'rejected' `
      + `AND kind IN (${ks.map(() => '?').join(', ')}) ORDER BY received_at DESC, row_id DESC LIMIT 1`,
      [channel, a, ...ks]));
  }

  async list({ limit, offset } = {}) {
    const total = sqlRow(this.s.db, 'SELECT COUNT(*) AS n FROM li_trust_events').n;
    const rows = sqlRows(this.s.db,
      `SELECT ${EVENT_COLS.join(', ')} FROM li_trust_events ORDER BY recorded_at DESC, row_id DESC LIMIT ? OFFSET ?`,
      [clampLimit(limit), clampOffset(offset)]).map(freeze);
    return { rows, total };
  }
}

class SqlRecipientRefs {
  constructor(store) { this.s = store; }

  /** Idempotent per (channel, address): the first ref minted for an address is kept forever. */
  async ensure(rec) {
    const v = requireValid(normalizeRecipientRefRecord(rec));
    return this.s.tx(() => {
      this.s.db.run(`INSERT OR IGNORE INTO li_recipient_refs (${REF_COLS.join(', ')}) VALUES (${placeholders(REF_COLS)})`, REF_COLS.map((c) => v[c]));
      return freeze(sqlRow(this.s.db, `SELECT ${REF_COLS.join(', ')} FROM li_recipient_refs WHERE channel = ? AND normalized_address = ?`, [v.channel, v.normalized_address]));
    });
  }

  async resolve(recipientRef) {
    return freeze(sqlRow(this.s.db, `SELECT ${REF_COLS.join(', ')} FROM li_recipient_refs WHERE recipient_ref = ?`, [String(recipientRef)]));
  }

  async forAddress({ channel, address }) {
    const a = normalizeAddress(channel, address);
    if (!a) return null;
    return freeze(sqlRow(this.s.db, `SELECT ${REF_COLS.join(', ')} FROM li_recipient_refs WHERE channel = ? AND normalized_address = ?`, [channel, a]));
  }
}

/* ============================= MEMORY ============================== */

const byDesc = (...keys) => (a, b) => {
  for (const k of keys) {
    if (a[k] === b[k]) continue;
    return String(a[k]) < String(b[k]) ? 1 : -1;
  }
  return 0;
};

class MemSuppressions {
  constructor() { this.rows = new Map(); }
  _key(v) { return [v.scope, v.workspace_id || '', v.channel, v.normalized_address].join('|'); }

  async add(rec) {
    const v = requireValid(normalizeSuppressionRecord(rec));
    const existing = [...this.rows.values()].find((r) => this._key(r) === this._key(v));
    if (existing) return { row: freeze(existing), created: false };
    this.rows.set(v.suppression_id, { ...v });
    return { row: freeze(v), created: true };
  }

  async find({ channel, address, workspaceId = DEFAULT_WORKSPACE_ID }) {
    const a = normalizeAddress(channel, address);
    if (!a) return null;
    const hits = [...this.rows.values()]
      .filter((r) => r.channel === channel && r.normalized_address === a && (r.scope === 'global' || r.workspace_id === String(workspaceId)))
      .sort((x, y) => (x.scope === y.scope ? (x.created_at === y.created_at ? (x.suppression_id < y.suppression_id ? -1 : 1) : (x.created_at < y.created_at ? -1 : 1)) : (x.scope === 'global' ? -1 : 1)));
    return freeze(hits[0] || null);
  }

  async listForAddress({ channel, address }) {
    const a = normalizeAddress(channel, address);
    if (!a) return [];
    return [...this.rows.values()].filter((r) => r.channel === channel && r.normalized_address === a)
      .sort((x, y) => (x.created_at === y.created_at ? (x.suppression_id < y.suppression_id ? -1 : 1) : (x.created_at < y.created_at ? -1 : 1))).map(freeze);
  }

  async list({ limit, offset } = {}) {
    const all = [...this.rows.values()].sort(byDesc('created_at', 'suppression_id'));
    const o = clampOffset(offset);
    return { rows: all.slice(o, o + clampLimit(limit)).map(freeze), total: all.length };
  }

  async removeManual(suppressionId) {
    const r = this.rows.get(String(suppressionId));
    if (!r || r.reason !== 'manual' || r.source !== 'user') return false;
    this.rows.delete(String(suppressionId));
    return true;
  }
}

class MemConsents {
  constructor() { this.rows = new Map(); }

  async record(rec) {
    const v = requireValid(normalizeConsentRecord(rec));
    if (this.rows.has(v.consent_id)) throw new Error('UNIQUE constraint failed: li_contact_consents.consent_id');
    this.rows.set(v.consent_id, { ...v });
    return freeze(v);
  }

  async latestFor({ channel, address }) {
    const a = normalizeAddress(channel, address);
    if (!a) return null;
    const hits = [...this.rows.values()].filter((r) => r.channel === channel && r.normalized_address === a)
      .sort(byDesc('consented_at', 'recorded_at', 'consent_id'));
    return freeze(hits[0] || null);
  }

  async listByLead(leadId, limit = 20) {
    return [...this.rows.values()].filter((r) => r.lead_id === String(leadId))
      .sort(byDesc('recorded_at', 'consent_id')).slice(0, clampLimit(limit)).map(freeze);
  }

  async deleteByLead(leadId) {
    for (const [k, r] of this.rows) if (r.lead_id === String(leadId)) this.rows.delete(k);
  }
}

class MemProvenance {
  constructor() { this.rows = new Map(); }

  async put(rec, { ifAbsent = false } = {}) {
    return (await this.putMany([rec], { ifAbsent }))[0];
  }

  async putMany(recs, { ifAbsent = false } = {}) {
    const values = (Array.isArray(recs) ? recs : []).map((r) => requireValid(normalizeProvenanceRecord(r)));
    return values.map((v) => {
      const key = `${v.lead_id}|${v.field}`;
      if ((v.backfilled || ifAbsent) && this.rows.has(key)) return { row: freeze(this.rows.get(key)), written: false };
      this.rows.set(key, { ...v });
      return { row: freeze(v), written: true };
    });
  }

  async leadIds() {
    return new Set([...this.rows.values()].map((r) => r.lead_id));
  }

  async listByLead(leadId) {
    return [...this.rows.values()].filter((r) => r.lead_id === String(leadId))
      .sort((a, b) => (a.field < b.field ? -1 : 1)).map(freeze);
  }

  async deleteByLead(leadId) {
    for (const [k, r] of this.rows) if (r.lead_id === String(leadId)) this.rows.delete(k);
  }
}

class MemTrustEvents {
  constructor() { this.rows = new Map(); }

  async append(rec) {
    const v = requireValid(normalizeTrustEventRecord(rec));
    if (this.rows.has(v.row_id)) throw new Error('UNIQUE constraint failed: li_trust_events.row_id');
    if (v.state !== 'rejected') {
      const existing = [...this.rows.values()].find((r) => r.event_id === v.event_id && r.state !== 'rejected');
      if (existing) return { row: freeze(existing), created: false };
    }
    this.rows.set(v.row_id, { ...v });
    return { row: freeze(v), created: true };
  }

  async get(eventId) {
    return freeze([...this.rows.values()].find((r) => r.event_id === String(eventId) && r.state !== 'rejected') || null);
  }

  async latestFor({ channel, address, kinds = TRUST_EVENT_KINDS }) {
    const a = normalizeAddress(channel, address);
    const ks = (Array.isArray(kinds) ? kinds : []).filter((k) => TRUST_EVENT_KINDS.includes(k));
    if (!a || !ks.length) return null;
    const hits = [...this.rows.values()]
      .filter((r) => r.channel === channel && r.normalized_address === a && r.state !== 'rejected' && ks.includes(r.kind))
      .sort(byDesc('received_at', 'row_id'));
    return freeze(hits[0] || null);
  }

  async list({ limit, offset } = {}) {
    const all = [...this.rows.values()].sort(byDesc('recorded_at', 'row_id'));
    const o = clampOffset(offset);
    return { rows: all.slice(o, o + clampLimit(limit)).map(freeze), total: all.length };
  }
}

class MemRecipientRefs {
  constructor() { this.rows = new Map(); }

  async ensure(rec) {
    const v = requireValid(normalizeRecipientRefRecord(rec));
    const existing = [...this.rows.values()].find((r) => r.channel === v.channel && r.normalized_address === v.normalized_address);
    if (existing) return freeze(existing);
    if (this.rows.has(v.recipient_ref)) throw new Error('UNIQUE constraint failed: li_recipient_refs.recipient_ref');
    this.rows.set(v.recipient_ref, { ...v });
    return freeze(v);
  }

  async resolve(recipientRef) { return freeze(this.rows.get(String(recipientRef)) || null); }

  async forAddress({ channel, address }) {
    const a = normalizeAddress(channel, address);
    if (!a) return null;
    return freeze([...this.rows.values()].find((r) => r.channel === channel && r.normalized_address === a) || null);
  }
}

module.exports = {
  SqlSuppressions, SqlConsents, SqlProvenance, SqlTrustEvents, SqlRecipientRefs,
  MemSuppressions, MemConsents, MemProvenance, MemTrustEvents, MemRecipientRefs,
  TRUST_TABLE_COLUMNS: Object.freeze({
    li_suppressions: SUPPRESSION_COLS, li_contact_consents: CONSENT_COLS, li_contact_provenance: PROVENANCE_COLS,
    li_trust_events: EVENT_COLS, li_recipient_refs: REF_COLS,
  }),
};
