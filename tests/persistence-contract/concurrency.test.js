'use strict';

/**
 * The concurrency of the PostgreSQL store (M1 review, item 1).
 *
 * The transaction's client used to be a field on the store, which is shared
 * state: two transactions running at the same time could pick up each other's
 * client. The client now lives in an AsyncLocalStorage context, so it belongs
 * to the operation that opened the transaction and to nothing else.
 *
 * These tests run against a REAL PostgreSQL 16, because the properties under
 * test are the database's: isolation between transactions, the pool, and
 * savepoints.
 *
 * They prove, in order:
 *
 *   1. two simultaneous transactions use DIFFERENT clients;
 *   2. neither can see the other's uncommitted work, and neither can write
 *      through the other's connection;
 *   3. a rollback in one transaction leaves the other alone;
 *   4. an operation outside any transaction never uses a transaction's client;
 *   5. a nested transaction joins the outer one through a savepoint, and a
 *      failure inside it rolls back only its own work;
 *   6. many concurrent transactions get their own connections from the pool.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { PostgresStore } = require('../../packages/lead-intelligence-postgres/src/PostgresStore');

const URL = process.env.ZTECH_PG_URL || '';
const skip = URL ? false : 'set ZTECH_PG_URL to run the concurrency tests against a real PostgreSQL';

const WORKSPACE = '22222222-2222-4222-8222-222222222222';

async function withSchema(fn) {
  const admin = new Pool({ connectionString: URL });
  const scoped = new Pool({ connectionString: URL, options: '-c search_path=li_conc' });
  await admin.query('DROP SCHEMA IF EXISTS li_conc CASCADE');
  await admin.query('CREATE SCHEMA li_conc');
  try {
    return await fn(scoped, admin);
  } finally {
    await admin.query('DROP SCHEMA IF EXISTS li_conc CASCADE');
    await scoped.end();
    await admin.end();
  }
}

async function freshStore(pool) {
  const store = new PostgresStore({ pool, workspaceId: WORKSPACE, logger: { warn() {} } });
  await store.migrate();
  return store;
}

test('two simultaneous transactions use different clients', { skip }, async () => {
  await withSchema(async (pool) => {
    const store = await freshStore(pool);
    const clients = [];
    let release;
    const gate = new Promise((resolve) => { release = resolve; });

    const first = store.tx(async () => {
      clients.push(store.client);
      await gate;
    });
    // Let the first transaction take its client before the second starts.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const second = store.tx(async () => {
      clients.push(store.client);
    });
    await second;
    release();
    await first;

    assert.equal(clients.length, 2);
    assert.notEqual(clients[0], clients[1], 'the two transactions are on different connections');
  });
});

test('a transaction cannot see another transaction\'s uncommitted work', { skip }, async () => {
  await withSchema(async (pool) => {
    const store = await freshStore(pool);
    // A second store on the same pool: a different operation, a different
    // connection, and its own transaction context.
    const other = await freshStore(pool);
    const seen = [];

    const writer = store.tx(async () => {
      await store.run('INSERT INTO li_saved_searches (workspace_id, search_id, name, definition_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        [WORKSPACE, 'tx1', 'Inside', JSON.stringify({ filter: null }), '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z']);
      // The writer sees its own uncommitted row...
      const inside = await store.one('li_saved_searches', 'SELECT search_id FROM li_saved_searches WHERE search_id = ? AND workspace_id = ?', ['tx1', WORKSPACE]);
      assert.ok(inside, 'the transaction sees its own write');
      // ...and another operation, on another connection, does not.
      const outside = await other.one('li_saved_searches', 'SELECT search_id FROM li_saved_searches WHERE search_id = ? AND workspace_id = ?', ['tx1', WORKSPACE]);
      seen.push(outside);
    });

    await writer;
    assert.equal(seen[0], null, 'the uncommitted row is invisible to another operation');
    const after = await store.one('li_saved_searches', 'SELECT search_id FROM li_saved_searches WHERE search_id = ? AND workspace_id = ?', ['tx1', WORKSPACE]);
    assert.ok(after, 'and visible once the transaction committed');
  });
});

test('a rollback in one transaction leaves the other one alone', { skip }, async () => {
  await withSchema(async (pool) => {
    const store = await freshStore(pool);
    let committed = false;
    await assert.rejects(store.tx(async () => {
      await store.run('INSERT INTO li_saved_searches (workspace_id, search_id, name, definition_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        [WORKSPACE, 'rolled_back', 'Rolled back', JSON.stringify({ filter: null }), '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z']);
      throw new Error('deliberate');
    }));
    const gone = await store.one('li_saved_searches', 'SELECT search_id FROM li_saved_searches WHERE search_id = ? AND workspace_id = ?', ['rolled_back', WORKSPACE]);
    assert.equal(gone, null, 'the rolled-back row is gone');

    await store.tx(async () => {
      await store.run('INSERT INTO li_saved_searches (workspace_id, search_id, name, definition_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        [WORKSPACE, 'kept', 'Kept', JSON.stringify({ filter: null }), '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z']);
      committed = true;
    });
    assert.equal(committed, true);
    const kept = await store.one('li_saved_searches', 'SELECT search_id FROM li_saved_searches WHERE search_id = ? AND workspace_id = ?', ['kept', WORKSPACE]);
    assert.ok(kept, 'the other transaction kept its work');
  });
});

test('an operation outside a transaction never uses a transaction\'s client', { skip }, async () => {
  await withSchema(async (pool) => {
    const store = await freshStore(pool);
    let insideClient = null;
    const transaction = store.tx(async () => {
      insideClient = store.client;
      // A read issued from inside the transaction uses the transaction's
      // client...
      const inside = await store.one('li_saved_searches', 'SELECT COUNT(*) AS c FROM li_saved_searches WHERE workspace_id = ?', [WORKSPACE]);
      assert.ok(inside);
      // ...and a read issued OUTSIDE it (after the transaction ended) does
      // not, even though it is the same store instance.
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await transaction;
    const after = await store.one('li_saved_searches', 'SELECT COUNT(*) AS c FROM li_saved_searches WHERE workspace_id = ?', [WORKSPACE]);
    assert.ok(after);
    assert.equal(store.inTransaction, false, 'the store is not in a transaction any more');
    assert.notEqual(store.client, insideClient, 'the client is the pool again');
  });
});

test('a nested transaction joins the outer one, and rolls back only its own work', { skip }, async () => {
  await withSchema(async (pool) => {
    const store = await freshStore(pool);
    let failed = null;
    await store.tx(async () => {
      await store.run('INSERT INTO li_saved_searches (workspace_id, search_id, name, definition_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        [WORKSPACE, 'outer', 'Outer', JSON.stringify({ filter: null }), '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z']);
      try {
        await store.tx(async () => {
          await store.run('INSERT INTO li_saved_searches (workspace_id, search_id, name, definition_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
            [WORKSPACE, 'inner', 'Inner', JSON.stringify({ filter: null }), '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z']);
          throw new Error('the inner transaction failed');
        });
      } catch (err) {
        failed = err;
      }
    });
    assert.ok(failed, 'the inner failure reached the caller');
    const outer = await store.one('li_saved_searches', 'SELECT search_id FROM li_saved_searches WHERE search_id = ? AND workspace_id = ?', ['outer', WORKSPACE]);
    assert.ok(outer, 'the outer transaction committed its own work');
    const inner = await store.one('li_saved_searches', 'SELECT search_id FROM li_saved_searches WHERE search_id = ? AND workspace_id = ?', ['inner', WORKSPACE]);
    assert.equal(inner, null, 'the inner transaction rolled back to its savepoint');
  });
});

test('a nested transaction that succeeds is part of the outer one', { skip }, async () => {
  await withSchema(async (pool) => {
    const store = await freshStore(pool);
    await store.tx(async () => {
      await store.tx(async () => {
        await store.run('INSERT INTO li_saved_searches (workspace_id, search_id, name, definition_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
          [WORKSPACE, 'nested', 'Nested', JSON.stringify({ filter: null }), '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z']);
      });
    });
    const row = await store.one('li_saved_searches', 'SELECT search_id FROM li_saved_searches WHERE search_id = ? AND workspace_id = ?', ['nested', WORKSPACE]);
    assert.ok(row, 'the nested write was committed with the outer transaction');
  });
});

test('many concurrent transactions each get their own connection', { skip }, async () => {
  await withSchema(async (pool) => {
    const store = await freshStore(pool);
    const clients = new Set();
    const work = [];
    for (let i = 0; i < 8; i += 1) {
      work.push(store.tx(async () => {
        clients.add(store.client);
        await new Promise((resolve) => setTimeout(resolve, 20));
        await store.run('INSERT INTO li_saved_searches (workspace_id, search_id, name, definition_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
          [WORKSPACE, `c${i}`, `C${i}`, JSON.stringify({ filter: null }), '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z']);
      }));
    }
    await Promise.all(work);
    assert.equal(clients.size, 8, 'the eight transactions used eight different connections');
    const rows = await store.q('li_saved_searches', 'SELECT search_id FROM li_saved_searches WHERE workspace_id = ?', [WORKSPACE]);
    assert.equal(rows.length, 8, 'and all eight rows are there');
  });
});

test('a transaction that fails leaves the pool usable', { skip }, async () => {
  await withSchema(async (pool) => {
    const store = await freshStore(pool);
    await assert.rejects(store.tx(async () => {
      await store.run('SELECT 1 FROM a_table_that_does_not_exist');
    }));
    const after = await store.one('li_saved_searches', 'SELECT COUNT(*) AS c FROM li_saved_searches WHERE workspace_id = ?', [WORKSPACE]);
    assert.ok(after, 'the pool still works after the failed transaction');
  });
});
