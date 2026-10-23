'use strict';

// A2 - QuarantineSink on ZTech's EXISTING database.
//
// Invalid provider payloads land here and nowhere else. They may contain third-party
// website text, so they are stored like other research data: same database, same
// retention window, pruned at startup.
//
// The port method is `put(item)` (see the module's ports/quarantine.ts).

const TABLE = 'prospect_research_quarantine';
const DEFAULT_MAX_PAYLOAD_BYTES = 256 * 1024;
const DEFAULT_RETENTION_MS = 720 * 60 * 60 * 1000; // matches RESEARCH_DEFAULTS.freshness.staleAfterHours

const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS ${TABLE} (
    id           TEXT PRIMARY KEY,
    provider_id  TEXT NOT NULL,
    operation    TEXT NOT NULL,
    reason       TEXT NOT NULL,
    received_at  TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    truncated    INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS ${TABLE}_received ON ${TABLE}(received_at)`
];

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value, fallback) {
  return typeof value === 'string' && value !== '' ? value : fallback;
}

/** Truncate to a byte budget without splitting a UTF-8 sequence. */
function truncateUtf8(value, maxBytes) {
  const buf = Buffer.from(value, 'utf8');
  if (buf.length <= maxBytes) return { text: value, truncated: false };
  let end = maxBytes;
  // Walk back off any continuation bytes so the stored text stays valid UTF-8.
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return { text: buf.subarray(0, end).toString('utf8'), truncated: true };
}

class SqlQuarantineSink {
  /**
   * @param {any} accountStore the app's existing AccountStore instance
   * @param {{ maxPayloadBytes?: number, retentionMs?: number, now?: () => number }} [options]
   */
  constructor(accountStore, options) {
    if (!accountStore || typeof accountStore !== 'object') {
      throw new Error('prospect-research: accountStore is required');
    }
    if (typeof accountStore.saveDB !== 'function') {
      throw new Error('prospect-research: accountStore.saveDB is required');
    }
    const opts = isPlainObject(options) ? options : {};
    this.accountStore = accountStore;
    this.maxPayloadBytes = Number.isInteger(opts.maxPayloadBytes) && opts.maxPayloadBytes > 0
      ? opts.maxPayloadBytes
      : DEFAULT_MAX_PAYLOAD_BYTES;
    this.retentionMs = Number.isInteger(opts.retentionMs) && opts.retentionMs > 0
      ? opts.retentionMs
      : DEFAULT_RETENTION_MS;
    this.now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    this.schemaPromise = null;
  }

  async ready() {
    await this.accountStore.ready;
    if (!this.accountStore.db) {
      throw new Error('prospect-research: accountStore database is not open');
    }
    if (!this.schemaPromise) {
      this.schemaPromise = this.#ensureSchema();
    }
    await this.schemaPromise;
    return this;
  }

  #ensureSchema() {
    const db = this.#db();
    for (const sql of SCHEMA_SQL) db.run(sql);
    this.accountStore.saveDB();
  }

  #db() {
    const db = this.accountStore.db;
    if (!db) throw new Error('prospect-research: accountStore database is not open');
    return db;
  }

  #rows(sql, params) {
    const result = this.#db().exec(sql, params);
    if (!result || result.length === 0) return [];
    const { columns, values } = result[0];
    return values.map((row) => {
      const obj = {};
      for (let i = 0; i < columns.length; i += 1) obj[columns[i]] = row[i];
      return obj;
    });
  }

  /** QuarantineSink.put */
  async put(item) {
    await this.ready();
    if (!isPlainObject(item)) throw new Error('prospect-research: quarantine item must be an object');

    let serialized;
    try {
      serialized = JSON.stringify(item.payload === undefined ? null : item.payload);
    } catch {
      serialized = '"[unserializable payload]"';
    }
    if (serialized === undefined) serialized = 'null';

    const kept = truncateUtf8(serialized, this.maxPayloadBytes);
    const at = text(item.at, new Date(this.now()).toISOString());
    const id = `q_${this.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

    this.#db().run(
      `INSERT INTO ${TABLE} (id, provider_id, operation, reason, received_at, payload_json, truncated)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        text(item.providerId, 'unknown'),
        text(item.operation, 'unknown'),
        text(item.reason, 'unknown'),
        at,
        kept.text,
        kept.truncated ? 1 : 0
      ]
    );
    this.accountStore.saveDB();
    return { id, truncated: kept.truncated };
  }

  /** Newest first. Payload text is returned as stored, plus its truncated flag. */
  async list(limit) {
    await this.ready();
    const max = Number.isInteger(limit) && limit >= 1 && limit <= 200 ? limit : 50;
    return this.#rows(
      `SELECT id, provider_id, operation, reason, received_at, payload_json, truncated
         FROM ${TABLE} ORDER BY received_at DESC, rowid DESC LIMIT ?`,
      [max]
    );
  }

  async count() {
    await this.ready();
    const rows = this.#rows(`SELECT COUNT(*) AS n FROM ${TABLE}`, []);
    return rows.length === 0 ? 0 : Number(rows[0].n) || 0;
  }

  /** Same retention as research data. Returns how many rows were removed. */
  async prune() {
    await this.ready();
    const cutoff = new Date(this.now() - this.retentionMs).toISOString();
    this.#db().run(`DELETE FROM ${TABLE} WHERE received_at < ?`, [cutoff]);
    const removed = this.#db().getRowsModified();
    if (removed > 0) this.accountStore.saveDB();
    return removed;
  }
}

module.exports = {
  DEFAULT_MAX_PAYLOAD_BYTES,
  DEFAULT_RETENTION_MS,
  SqlQuarantineSink,
  SCHEMA_SQL,
  TABLE
};
