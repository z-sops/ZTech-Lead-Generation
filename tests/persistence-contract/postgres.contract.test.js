'use strict';

/**
 * The persistence contract suite, run against a REAL PostgreSQL 16.
 *
 * The same suite file, the same assertions, the same fixtures as the desktop
 * runner. The two backends must produce identical results.
 *
 * The connection comes from the environment:
 *
 *   ZTECH_PG_URL        a full connection string. When it is absent the suite
 *                       is SKIPPED, and the skip says so - it never pretends
 *                       to have run.
 *   ZTECH_PG_WORKSPACE  the workspace the store is bound to (default 'default')
 *
 * A PostgreSQL 16 service container is started by the CI job that runs this.
 */

const test = require('node:test');
const { after } = require('node:test');
const { Pool } = require('pg');
const { PostgresStore } = require('../../packages/lead-intelligence-postgres/src/PostgresStore');
const { describePersistenceContract } = require('./contract-suite');

const URL = process.env.ZTECH_PG_URL || '';
/** The F2 architecture scopes every tenant table by a uuid. */
const WORKSPACE = process.env.ZTECH_PG_WORKSPACE || '11111111-1111-4111-8111-111111111111';

if (!URL) {
  test('[postgres] the persistence contract (skipped: no PostgreSQL is configured)', { skip: 'set ZTECH_PG_URL to run the contract against a real PostgreSQL' }, () => {});
} else {
  let pool = null;
  let scoped = null;

  /**
   * A store on a clean schema. The schema is dropped and rebuilt for every
   * test, so no test can see another test's rows.
   */
  async function create() {
    if (!pool) {
      pool = new Pool({ connectionString: URL });
      scoped = new Pool({ connectionString: URL, options: '-c search_path=li_test' });
    }
    await pool.query('DROP SCHEMA IF EXISTS li_test CASCADE');
    await pool.query('CREATE SCHEMA li_test');
    const store = new PostgresStore({ pool: scoped, workspaceId: WORKSPACE, logger: { warn() {} } });
    await store.migrate();
    return store;
  }

  /**
   * Make the newest packet unreadable. A JSONB column cannot hold broken
   * text - that is the point of the type - so the payload becomes a document
   * that is not a packet, which the store reports as a corrupt row exactly
   * like the desktop does.
   */
  async function corrupt(store) {
    await store.run("UPDATE li_evidence_packets SET packet_json = '\"not a packet\"'::jsonb WHERE packet_id = 'pkt_2'");
  }

  /** A raw insert, for the transaction test. */
  async function insertSearch(store, { search_id, name }) {
    await store.run('INSERT INTO li_saved_searches (workspace_id, search_id, name, definition_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [WORKSPACE, search_id, name, JSON.stringify({ filter: null }), '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z']);
  }

  describePersistenceContract({
    label: 'postgres',
    create,
    corrupt,
    insertSearch,
    workspaceId: WORKSPACE,
  });

  after(async () => {
    if (pool) {
      await pool.query('DROP SCHEMA IF EXISTS li_test CASCADE');
      await pool.end();
    }
    if (scoped) await scoped.end();
  });
}
