'use strict';

/**
 * The persistence contract suite, run against a REAL PostgreSQL 16.
 *
 * The same suite file, the same assertions, the same fixtures as the desktop
 * runner. The two backends must produce identical results.
 *
 * The store connects as the RUNTIME role (`ztech_app`) - not as the owner -
 * so the row-level security is in force for every assertion here, and the
 * workspace context is set on the transaction that runs the query.
 *
 * The connection comes from the environment:
 *
 *   ZTECH_PG_URL        a full connection string. When it is absent the suite
 *                       is SKIPPED, and the skip says so - it never pretends
 *                       to have run.
 *   ZTECH_PG_WORKSPACE  the workspace the store is bound to (a uuid)
 */

const test = require('node:test');
const { after } = require('node:test');
const { PostgresStore } = require('../../packages/lead-intelligence-postgres/src/PostgresStore');
const { describePersistenceContract } = require('./contract-suite');
const { freshDatabase, dropDatabase, truncateAll, skip } = require('./lib/postgres');

const DATABASE = 'ztech_contract';
const WORKSPACE = process.env.ZTECH_PG_WORKSPACE || '11111111-1111-4111-8111-111111111111';

if (!process.env.ZTECH_PG_URL) {
  test('[postgres] the persistence contract (skipped: no PostgreSQL is configured)', { skip: 'set ZTECH_PG_URL to run the contract against a real PostgreSQL' }, () => {});
} else {
  let db = null;

  /**
   * A store on a clean database. The rows are emptied between the tests, so
   * no test can see another test's rows.
   */
  async function create() {
    if (!db) db = await freshDatabase(DATABASE, { workspace: WORKSPACE });
    await truncateAll(db.owner);
    const store = new PostgresStore({ pool: db.pool, controlPool: db.controlPool, workspaceId: WORKSPACE, logger: { warn() {} } });
    return store;
  }

  /**
   * Make the newest packet unreadable. A JSONB column cannot hold broken
   * text - that is the point of the type - so the payload becomes a document
   * that is not a packet, which the store reports as a corrupt row exactly
   * like the desktop does.
   *
   * It runs inside a transaction, because the row-level security needs the
   * workspace context - and the context is set on the transaction.
   */
  async function corrupt(store) {
    await store.tx(async () => {
      await store.run("UPDATE li_evidence_packets SET packet_json = '\"not a packet\"'::jsonb WHERE packet_id = 'pkt_2'");
    });
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
    if (db) await dropDatabase(DATABASE, [db.pool, db.owner, db.admin]);
  });
}
