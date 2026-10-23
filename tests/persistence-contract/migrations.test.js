'use strict';

/**
 * The PostgreSQL migrations (M1, acceptance criterion 3).
 *
 * "The migration is idempotent."
 *
 * Applying the migrations twice changes nothing: the second run applies
 * nothing, and the schema it leaves behind is the same schema. The test
 * applies the whole set twice, and then applies each migration file on its
 * own again, because a migration that is not idempotent on its own is a
 * migration that can fail on a partially migrated database.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { MIGRATIONS } = require('../../packages/lead-intelligence-postgres/src/index');
const { freshDatabase, dropDatabase, withSetupLock, skip } = require('./lib/postgres');

const URL = process.env.ZTECH_PG_URL || '';

const DATABASE = 'ztech_migrations';

async function withSchema(fn) {
  const db = await freshDatabase(DATABASE, { workspace: '11111111-1111-4111-8111-111111111111' });
  try {
    return await fn(db.owner, db.pool, db.controlPool);
  } finally {
    await dropDatabase(DATABASE, [db.pool, db.owner, db.admin]);
  }
}

async function schemaOf(pool) {
  const res = await pool.query(
    "SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'li' ORDER BY table_name, column_name",
  );
  return res.rows.map((r) => `${r.table_name}.${r.column_name}:${r.data_type}`).join('\n');
}

test('the migrations are applied one version at a time, and recorded', { skip }, async () => {
  await withSchema(async (scoped, runtime, controlPool) => {
    const { PostgresStore } = require('../../packages/lead-intelligence-postgres/src/PostgresStore');
    const store = new PostgresStore({ pool: scoped, controlPool, workspaceId: '11111111-1111-4111-8111-111111111111', logger: { warn() {} } });
    await store.migrate();
    const applied = await scoped.query('SELECT version FROM li_schema_migrations ORDER BY version');
    assert.deepEqual(applied.rows.map((r) => Number(r.version)), MIGRATIONS.map((m) => m.version));
  });
});

test('applying every migration again changes nothing', { skip }, async () => {
  await withSchema(async (scoped, runtime, controlPool) => {
    await withSetupLock(scoped, async () => { for (const m of MIGRATIONS) await scoped.query(m.sql); });
    const before = await schemaOf(scoped);
    const appliedBefore = await scoped.query('SELECT version FROM li_schema_migrations ORDER BY version');
    await withSetupLock(scoped, async () => { for (const m of MIGRATIONS) await scoped.query(m.sql); });
    const after = await schemaOf(scoped);
    const appliedAfter = await scoped.query('SELECT version FROM li_schema_migrations ORDER BY version');
    assert.equal(after, before, 'the schema is the same');
    assert.deepEqual(appliedAfter.rows, appliedBefore.rows, 'no version is recorded twice');
  });
});

test('each migration on its own is idempotent', { skip }, async () => {
  await withSchema(async (scoped, runtime, controlPool) => {
    for (const m of MIGRATIONS) {
      await scoped.query(m.sql);
      await scoped.query(m.sql);
    }
    const tables = await scoped.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'li' AND table_type = 'BASE TABLE' ORDER BY table_name",
    );
    const names = tables.rows.map((r) => r.table_name);
    for (const m of MIGRATIONS) {
      const created = m.sql.match(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?:\w+\.)?(\w+)/i);
      if (created) assert.ok(names.includes(created[1]), `${created[1]} exists after its migration ran twice`);
    }
  });
});

test('the store applies the migrations once and records the versions', { skip }, async () => {
  await withSchema(async (scoped, runtime, controlPool) => {
    const { PostgresStore } = require('../../packages/lead-intelligence-postgres/src/PostgresStore');
    const store = new PostgresStore({ pool: scoped, controlPool, workspaceId: '11111111-1111-4111-8111-111111111111', logger: { warn() {} } });
    const first = await store.migrate();
    assert.deepEqual(first.applied, MIGRATIONS.map((m) => m.version));
    assert.equal(first.changed, true);
    const before = await schemaOf(scoped);
    const second = await store.migrate();
    assert.equal(second.changed, false, 'the second run applies nothing');
    assert.equal(await schemaOf(scoped), before, 'the schema is unchanged');
    const versions = await scoped.query('SELECT COUNT(*)::int AS n FROM li_schema_migrations');
    assert.equal(versions.rows[0].n, MIGRATIONS.length, 'no version is recorded twice');
  });
});
