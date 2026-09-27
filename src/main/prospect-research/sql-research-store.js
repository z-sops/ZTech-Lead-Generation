'use strict';

// A1 - ResearchStateStore on ZTech's EXISTING database.
//
// No second database. This reuses AccountStore's sql.js handle
// (src/main/accountStore.js) and its synchronous whole-file saveDB() flush.
// The module's own StaleRecordError class is imported from the prebuilt bundle so
// that `e instanceof StaleRecordError` in research-coordinator.ts:220 keeps
// working across the boundary. Do not throw a locally-defined look-alike and do
// not match on err.name.
//
// Durability: AccountStore.saveDB() (accountStore.js:1445) is synchronous
// (db.export() -> writeFileSync -> renameSync) and there is no debounce or
// quit-time flush, so calling it inside insert()/update() means the transition is
// on disk in whatsapp.db before the returned promise resolves - and therefore
// before the first Zuni-SEO call of that transition. Do not coalesce these writes.

const { StaleRecordError } = require('./prospect-research.cjs');

const TABLE = 'prospect_research';
const TERMINAL_PHASES = ['complete', 'partial', 'failed'];

const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS ${TABLE} (
    id              TEXT PRIMARY KEY,
    lead_ref        TEXT NOT NULL,
    provider_id     TEXT NOT NULL,
    phase           TEXT NOT NULL,
    next_attempt_at TEXT,
    updated_at      TEXT NOT NULL,
    version         INTEGER NOT NULL,
    record_json     TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ${TABLE}_lead ON ${TABLE}(lead_ref, updated_at)`,
  `CREATE INDEX IF NOT EXISTS ${TABLE}_due  ON ${TABLE}(phase, next_attempt_at)`
];

function terminalPlaceholders() {
  return TERMINAL_PHASES.map(() => '?').join(', ');
}

class SqlResearchStateStore {
  /** @param {any} accountStore the app's existing AccountStore instance */
  constructor(accountStore) {
    if (!accountStore || typeof accountStore !== 'object') {
      throw new Error('prospect-research: accountStore is required');
    }
    if (typeof accountStore.saveDB !== 'function') {
      throw new Error('prospect-research: accountStore.saveDB is required');
    }
    this.accountStore = accountStore;
    this.schemaPromise = null;
  }

  /** Awaits the real database, then creates the table/indexes once. */
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
    const db = this.accountStore.db;
    if (!db) throw new Error('prospect-research: accountStore database is not open');
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

  #toRecord(row) {
    try {
      return JSON.parse(row.record_json);
    } catch (err) {
      throw new Error(`prospect-research: record ${row.id} is not valid JSON`);
    }
  }

  async insert(record) {
    await this.ready();
    if (!record || typeof record !== 'object') {
      throw new Error('prospect-research: insert requires a record');
    }
    if (typeof record.id !== 'string' || record.id === '') {
      throw new Error('prospect-research: record id is required');
    }
    this.#db().run(
      `INSERT INTO ${TABLE} (id, lead_ref, provider_id, phase, next_attempt_at, updated_at, version, record_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.leadRef,
        record.providerId,
        record.phase,
        record.nextAttemptAt === undefined ? null : record.nextAttemptAt,
        record.updatedAt,
        record.version,
        JSON.stringify(record)
      ]
    );
    this.accountStore.saveDB();
  }

  async update(record) {
    await this.ready();
    if (!record || typeof record !== 'object') {
      throw new Error('prospect-research: update requires a record');
    }
    if (typeof record.id !== 'string' || record.id === '') {
      throw new Error('prospect-research: record id is required');
    }
    const expectedVersion = record.version - 1;
    this.#db().run(
      `UPDATE ${TABLE}
          SET lead_ref = ?, provider_id = ?, phase = ?, next_attempt_at = ?,
              updated_at = ?, version = ?, record_json = ?
        WHERE id = ? AND version = ?`,
      [
        record.leadRef,
        record.providerId,
        record.phase,
        record.nextAttemptAt === undefined ? null : record.nextAttemptAt,
        record.updatedAt,
        record.version,
        JSON.stringify(record),
        record.id,
        expectedVersion
      ]
    );
    if (this.#db().getRowsModified() !== 1) {
      // The bundle's own class, so the coordinator's instanceof check re-reads.
      throw new StaleRecordError(record.id);
    }
    this.accountStore.saveDB();
  }

  async get(id) {
    await this.ready();
    if (typeof id !== 'string' || id === '') return null;
    const rows = this.#rows(`SELECT * FROM ${TABLE} WHERE id = ? LIMIT 1`, [id]);
    return rows.length === 0 ? null : this.#toRecord(rows[0]);
  }

  async latestForLead(leadRef) {
    await this.ready();
    if (typeof leadRef !== 'string' || leadRef === '') return null;
    const rows = this.#rows(
      `SELECT * FROM ${TABLE} WHERE lead_ref = ? ORDER BY updated_at DESC`,
      [leadRef]
    );
    let best = null;
    for (const row of rows) {
      const record = this.#toRecord(row);
      if (best === null) {
        best = record;
        continue;
      }
      const a = typeof record.createdAt === 'string' ? record.createdAt : '';
      const b = typeof best.createdAt === 'string' ? best.createdAt : '';
      if (a > b) best = record;
    }
    return best;
  }

  async listActive() {
    await this.ready();
    const rows = this.#rows(
      `SELECT * FROM ${TABLE}
        WHERE phase NOT IN (${terminalPlaceholders()})
        ORDER BY updated_at ASC, rowid ASC`,
      TERMINAL_PHASES.slice()
    );
    return rows.map((row) => this.#toRecord(row));
  }
}

module.exports = {
  SqlResearchStateStore,
  SCHEMA_SQL,
  TABLE,
  TERMINAL_PHASES
};
