'use strict';

/**
 * The persistence contract suite, run against the DESKTOP's sql.js store.
 *
 * This is the reference: the desktop's behaviour is the one the PostgreSQL
 * store has to match. The suite itself is in contract-suite.js and is shared
 * verbatim with the PostgreSQL runner.
 */

const initSqlJs = require('sql.js');
const { SqlJsStore } = require('../../src/main/lead-intelligence/persistence/SqlJsStore');
const { describePersistenceContract } = require('./contract-suite');

let SQL = null;

async function create() {
  if (!SQL) SQL = await initSqlJs();
  const db = new SQL.Database();
  const store = new SqlJsStore({ db, persist: () => {}, logger: { warn() {} } });
  await store.migrate();
  return store;
}

/**
 * Make the newest packet unreadable. The desktop's column is TEXT, so broken
 * text is exactly what a corrupted file contains.
 */
async function corrupt(store) {
  store.db.run("UPDATE li_evidence_packets SET packet_json = '{broken' WHERE packet_id = 'pkt_2'");
}

/** A raw insert, for the transaction test. */
async function insertSearch(store, { search_id, name }) {
  store.db.run('INSERT INTO li_saved_searches (search_id, name, definition_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    [search_id, name, JSON.stringify({ filter: null }), '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z']);
}

describePersistenceContract({
  label: 'sqlite',
  create,
  corrupt,
  insertSearch,
  // The desktop's single local workspace. Its data and its schema are unchanged.
  workspaceId: 'local',
});
