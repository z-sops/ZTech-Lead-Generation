'use strict';

/**
 * Apply the PostgreSQL schema migrations to a development database, once each.
 *
 * Shared by `scripts/setup-dev-db.js` (first setup and every re-run) and
 * `scripts/migrate-dev-db.js` (apply only what is new). The rules:
 *
 *   - One dedicated client holds a transaction-level-free advisory lock for the
 *     whole run, so two runners can never apply migrations at the same time.
 *     The lock, every migration and the unlock use THAT client: separate
 *     pool.query() calls are not guaranteed to reach the same backend.
 *   - Each migration and its ledger row (li_schema_migrations) commit in ONE
 *     transaction: a failure rolls both back, and the run stops there.
 *   - A version already in the ledger is skipped, so re-running is safe.
 *   - A database whose `li` schema already holds tables but whose ledger is
 *     EMPTY was set up by a script that did not record versions (before
 *     2026-11). Nothing is replayed onto it: the run fails closed and says
 *     how to continue. Guessing which migrations ran is how data is lost.
 *
 * The client must be connected as the migration role with `search_path=li`,
 * exactly as the deployment and the test harness connect.
 */

const { MIGRATIONS } = require('../../packages/lead-intelligence-postgres/src/index');

/** A fixed key for pg_advisory_lock: "ZTECHMIG" as a 64-bit number. */
const MIGRATION_LOCK_KEY = '6505891338829187399';

class MigrationStateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MigrationStateError';
  }
}

async function ensureLedger(client) {
  await client.query(
    'CREATE TABLE IF NOT EXISTS li_schema_migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL)',
  );
}

/** Tables in `li` other than the ledger itself. */
async function liTableCount(client) {
  const result = await client.query(
    `SELECT count(*)::int AS n
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'li' AND c.relkind IN ('r', 'p') AND c.relname <> 'li_schema_migrations'`,
  );
  return result.rows[0].n;
}

/**
 * @param {import('pg').Pool} pool a pool connected as the migration role, search_path=li
 * @param {{log?: (line: string) => void, migrations?: Array<{version: number, sql: string}>}} [options]
 * @returns {Promise<{applied: number[], skipped: number[]}>}
 */
async function applyPendingMigrations(pool, options = {}) {
  const log = options.log || ((line) => console.log(line));
  const migrations = options.migrations || MIGRATIONS;
  const client = await pool.connect();
  let locked = false;
  try {
    await client.query('SELECT pg_advisory_lock($1::bigint)', [MIGRATION_LOCK_KEY]);
    locked = true;

    await ensureLedger(client);
    const ledger = await client.query('SELECT version FROM li_schema_migrations ORDER BY version');
    const done = new Set(ledger.rows.map((row) => Number(row.version)));

    if (done.size === 0 && (await liTableCount(client)) > 0) {
      throw new MigrationStateError(
        'The li schema already has tables but no migration record. This database was set up by an older script '
        + 'that did not record which migrations ran, so none are replayed onto it. Use a new development database '
        + '(set ZTECH_DEV_DATABASE, e.g. ztech_dev_2) or drop this development database, then run the setup again.',
      );
    }

    const applied = [];
    const skipped = [];
    for (const migration of migrations) {
      if (done.has(migration.version)) {
        skipped.push(migration.version);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO li_schema_migrations (version, applied_at) VALUES ($1, now())',
          [migration.version],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        err.migrationVersion = migration.version;
        throw err;
      }
      applied.push(migration.version);
      log(`  Applied migration ${migration.version}`);
    }
    if (skipped.length) log(`  Already applied (skipped): ${skipped.join(', ')}`);
    return { applied, skipped };
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock($1::bigint)', [MIGRATION_LOCK_KEY]).catch(() => {});
    client.release();
  }
}

module.exports = { applyPendingMigrations, MigrationStateError, MIGRATION_LOCK_KEY };
