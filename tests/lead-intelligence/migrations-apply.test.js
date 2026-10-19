'use strict';

// F0 (audit gap G-11 / G-12): "Test database migrations" was an explicit F0
// requirement and there was no test that applied the Lead Intelligence
// migrations to a real database and proved the outcome.
//
// This suite proves:
//   1. all 13 migrations apply to a fresh database and record contiguous versions;
//   2. applying them again is a no-op (idempotency);
//   3. a FAILING migration is rolled back and leaves the schema at the last
//      good version - the store must never be left half-migrated;
//   4. every migration file on disk is represented in the MIGRATIONS list, and
//      the versions are contiguous with no gaps.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'src', 'main', 'lead-intelligence', 'migrations');
const PERSISTENCE_DIR = path.join(__dirname, '..', '..', 'src', 'main', 'lead-intelligence', 'persistence');

async function newDatabase() {
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  return new SQL.Database();
}

function tableNames(db) {
  const result = db.exec("SELECT name FROM sqlite_master WHERE type='table'");
  if (!result.length) return [];
  return result[0].values.map((r) => r[0]);
}

function appliedVersions(db) {
  const result = db.exec('SELECT version FROM li_schema_migrations ORDER BY version');
  if (!result.length) return [];
  return result[0].values.map((r) => Number(r[0]));
}

test('migrations: every migration file on disk is registered, with contiguous versions', () => {
  const { MIGRATIONS } = require(path.join(PERSISTENCE_DIR, 'migrations.js'));

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  assert.ok(files.length >= 13, 'at least 13 migration files exist (' + files.length + ')');

  const registeredNames = MIGRATIONS.map((m) => m.name);
  for (const file of files) {
    assert.ok(registeredNames.includes(file), 'migration file is registered: ' + file);
  }

  const versions = MIGRATIONS.map((m) => m.version);
  assert.deepEqual(versions, versions.map((_, i) => i + 1), 'versions are 1..N with no gaps');
  assert.equal(new Set(versions).size, versions.length, 'no duplicate versions');
  for (const m of MIGRATIONS) {
    assert.ok(typeof m.sql === 'string' && m.sql.trim().length > 0, 'migration ' + m.version + ' carries SQL');
  }
});

test('migrations: a fresh database migrates to head and records every version', async () => {
  const { SqlJsStore } = require(path.join(PERSISTENCE_DIR, 'SqlJsStore.js'));
  const db = await newDatabase();
  const store = new SqlJsStore({ db, persist: () => {} });

  await store.migrate();

  const versions = appliedVersions(db);
  assert.deepEqual(versions, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);

  const tables = tableNames(db);
  for (const expected of [
    'li_research_jobs', 'li_evidence_packets', 'li_research_changes',
    'li_pitch_drafts', 'li_outreach_approvals', 'li_enrichment_observations',
    'li_outreach_sends', 'li_oi_associations', 'li_oi_refresh_requests',
    'li_suppressions', 'li_contact_consents', 'li_contact_provenance',
    'li_trust_events', 'li_recipient_refs', 'li_mailboxes', 'li_mailbox_sent',
    'li_market_rules', 'li_reply_reviews', 'li_sequences', 'li_sequence_steps',
    'li_sequence_events', 'li_sequence_gaps', 'li_sequence_control',
    'li_reply_routes',
  ]) {
    assert.ok(tables.includes(expected), 'table created by the migrations: ' + expected);
  }
  db.close();
});

test('migrations: running migrate() again changes nothing', async () => {
  const { SqlJsStore } = require(path.join(PERSISTENCE_DIR, 'SqlJsStore.js'));
  const db = await newDatabase();
  const store = new SqlJsStore({ db, persist: () => {} });

  await store.migrate();
  const firstTables = tableNames(db).sort();

  let persisted = 0;
  const store2 = new SqlJsStore({ db, persist: () => { persisted += 1; } });
  await store2.migrate();

  assert.equal(persisted, 0, 'a no-op migration does not trigger a database write');
  assert.deepEqual(appliedVersions(db), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13], 'no duplicate version rows');
  assert.deepEqual(tableNames(db).sort(), firstTables, 'the schema is unchanged');
  db.close();
});

test('migrations: a failing migration is rolled back and the schema stays at the last good version', async () => {
  const migrationsPath = require.resolve(path.join(PERSISTENCE_DIR, 'migrations.js'));
  const { MIGRATIONS } = require(migrationsPath);

  // Inject a deliberately broken migration AFTER the real ones, so the store
  // applies 1..13 and then fails on 14.
  const broken = Object.freeze({
    version: 14,
    name: '999_broken_for_test.sql',
    sql: 'CREATE TABLE li_broken_for_test (id TEXT PRIMARY KEY); THIS IS NOT VALID SQL;',
  });
  const patched = require.cache[migrationsPath];
  patched.exports = { MIGRATIONS: Object.freeze([...MIGRATIONS, broken]) };

  // Load a FRESH copy of the store so it picks up the patched MIGRATIONS.
  const storePath = require.resolve(path.join(PERSISTENCE_DIR, 'SqlJsStore.js'));
  delete require.cache[storePath];
  const { SqlJsStore } = require(storePath);

  const db = await newDatabase();
  const store = new SqlJsStore({ db, persist: () => {} });

  await assert.rejects(
    () => store.migrate(),
    (err) => {
      assert.equal(err.code, 'MIGRATION_FAILED');
      assert.equal(err.details && err.details.version, 14, 'the failing version is reported');
      return true;
    }
  );

  assert.deepEqual(appliedVersions(db), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
    'the failed version was not recorded');
  const tables = tableNames(db);
  assert.ok(!tables.includes('li_broken_for_test'),
    'the failed migration left no partial table behind');
  assert.ok(tables.includes('li_reply_routes'), 'the last good migration is still applied');

  // Restore the module state for any later test in this process.
  patched.exports = { MIGRATIONS };
  db.close();
});
