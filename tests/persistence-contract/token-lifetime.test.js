'use strict';

/**
 * The token lifetime suite (M2, correction C4).
 *
 * THE PROBLEM THIS SUITE EXISTS FOR
 * -------------------------------
 * `li.set_workspace()` checks the token's expiry when it OPENS the
 * context. It did not check it afterwards. So a context that was opened
 * with a token that was still valid could be used for as long as the
 * transaction lived - and a transaction can live for a very long time. The
 * credential had expired, and the access had not.
 *
 * That is the shape of an indefinite authenticated access: a session opens
 * a context with a short-lived token, and then keeps working with it.
 *
 * What this suite proves:
 *
 *   1. a context does not outlive the token that opened it - the expiry is
 *      in the context record, the record is in a table the runtime role
 *      cannot write, and it is checked on EVERY read;
 *   2. a transaction that is still open when the token expires loses its
 *      access: a SELECT sees nothing, an UPDATE changes nothing, and an
 *      INSERT is refused;
 *   3. the loss is not a lockout: a fresh token opens a fresh context, and
 *      the session works again;
 *   4. a token may not be issued with a lifetime longer than the maximum,
 *      which is what bounds the life of a context;
 *   5. the ordinary transaction behaviour is untouched: a rollback takes
 *      the context with it, a nested SAVEPOINT keeps it, and a reused
 *      connection carries none.
 *
 * Everything runs against a real PostgreSQL 16, as the runtime role.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { freshDatabase, dropDatabase, roleUrl, ROLES, skip } = require('./lib/postgres');

const A = '11111111-1111-4111-8111-111111111111';
const T1 = '2026-09-01T00:00:00.000Z';

if (!process.env.ZTECH_PG_URL) {
  test('[lifetime] the token lifetime suite (skipped: no PostgreSQL is configured)', { skip: 'set ZTECH_PG_URL' }, () => {});
} else {
  const DATABASE = 'ztech_lifetime';
  let db = null;
  let app = null;

  const INSERT_JOB = 'INSERT INTO li.li_research_jobs (workspace_id, job_id, lead_id, provider_id, request_key, state, options_json, created_at, updated_at, version) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, 1)';

  /** The sleep, so the token really does expire while the transaction is open. */
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  test('the setup: a tenant, a row, and a role that can open a context', async () => {
    db = await freshDatabase(DATABASE, { workspaces: [A] });
    app = new Pool({ connectionString: roleUrl(ROLES.app, DATABASE), options: '-c search_path=li' });
    await db.owner.query(INSERT_JOB, [A, 'job_a', 'L-A', 'fake', 'key-a', 'requested', JSON.stringify({}), T1]);
  });

  test('the context carries the expiry of the token that opened it', async () => {
    const token = await db.mintToken(A, ROLES.app, 60);
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT li.set_workspace($1, $2)', [A, token]);
      // The row is read after the COMMIT: the context belongs to the
      // transaction, and an uncommitted row is invisible to another one.
      await client.query('COMMIT');
      const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const row = (await db.owner.query(
        'SELECT expires_at, xid IS NOT NULL AS has_xid FROM li.workspace_context WHERE backend_pid = $1',
        [pid],
      )).rows[0];
      assert.ok(row, 'the context row is there');
      assert.ok(row.expires_at instanceof Date, 'and it carries the expiry');
      const seconds = Math.round((row.expires_at.getTime() - Date.now()) / 1000);
      assert.ok(seconds > 0 && seconds <= 60, `and the expiry is the token's own (${seconds}s)`);
    } finally {
      client.release();
    }
  });

  test('a token may not be issued with a lifetime longer than the maximum', async () => {
    await assert.rejects(
      db.mintToken(A, ROLES.app, 301),
      /lifetime/i,
      'the maximum is enforced by the database, not by the caller',
    );
    const maximum = (await db.owner.query('SELECT li.max_token_lifetime() AS n')).rows[0].n;
    assert.ok(maximum > 0 && maximum <= 3600, `the maximum is a sane, explicit number (${maximum}s)`);
  });

  test('a transaction that is open when the token expires loses its access', async () => {
    // A token that lives for one second.
    const token = await db.mintToken(A, ROLES.app, 1);
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT li.set_workspace($1, $2)', [A, token]);

      // 1. Before the expiry, the context works.
      const before = await client.query('SELECT job_id FROM li.li_research_jobs');
      assert.deepEqual(before.rows.map((r) => r.job_id), ['job_a'], 'inside the lifetime the context is in force');

      // 2. Let the token expire, with the transaction still open.
      await wait(1500);

      // 3. The context is gone, and the transaction has lost its access.
      const current = await client.query('SELECT li.current_workspace() AS ws');
      assert.equal(current.rows[0].ws, null, 'the context is gone: the credential has expired');

      const after = await client.query('SELECT job_id FROM li.li_research_jobs');
      assert.deepEqual(after.rows, [], 'a SELECT sees nothing');

      const updated = await client.query("UPDATE li.li_research_jobs SET state = 'failed' WHERE job_id = 'job_a'");
      assert.equal(updated.rowCount, 0, 'an UPDATE changes nothing');

      await assert.rejects(
        client.query(
          'INSERT INTO li.li_research_jobs (workspace_id, job_id, lead_id, provider_id, request_key, state, options_json, created_at, updated_at, version) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, 1)',
          [A, 'job_new', 'L-A', 'fake', 'key-new', 'requested', JSON.stringify({}), T1],
        ),
        /row-level security|violates row-level security policy/i,
        'and an INSERT is refused',
      );
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    // The row was not changed.
    const truth = await db.owner.query('SELECT state FROM li.li_research_jobs WHERE job_id = $1', ['job_a']);
    assert.equal(truth.rows[0].state, 'requested', 'the row is unchanged');
  });

  test('the loss of access is not a lockout: a fresh token opens a fresh context', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT li.set_workspace($1, $2)', [A, await db.mintToken(A, ROLES.app, 60)]);
      const rows = await client.query('SELECT job_id FROM li.li_research_jobs');
      assert.deepEqual(rows.rows.map((r) => r.job_id), ['job_a'], 'the session works again with a new token');
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  });

  test('a rollback takes the context with it', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT li.set_workspace($1, $2)', [A, await db.mintToken(A, ROLES.app, 60)]);
      const inside = await client.query('SELECT count(*)::int AS n FROM li.li_research_jobs');
      assert.equal(inside.rows[0].n, 1, 'inside the transaction the context is in force');
      await client.query('ROLLBACK');
      const after = await client.query('SELECT count(*)::int AS n FROM li.li_research_jobs');
      assert.equal(after.rows[0].n, 0, 'and the rollback took the context with it');
    } finally {
      client.release();
    }
  });

  test('a nested SAVEPOINT keeps the context', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT li.set_workspace($1, $2)', [A, await db.mintToken(A, ROLES.app, 60)]);
      await client.query('SAVEPOINT ztech_inner');
      const inside = await client.query('SELECT count(*)::int AS n FROM li.li_research_jobs');
      assert.equal(inside.rows[0].n, 1, 'the context survives the savepoint');
      await client.query('RELEASE SAVEPOINT ztech_inner');
      const after = await client.query('SELECT count(*)::int AS n FROM li.li_research_jobs');
      assert.equal(after.rows[0].n, 1, 'and after it is released');
      await client.query('COMMIT');
      const done = await client.query('SELECT count(*)::int AS n FROM li.li_research_jobs');
      assert.equal(done.rows[0].n, 0, 'and the transaction is over, so there is no context at all');
    } finally {
      client.release();
    }
  });

  test('a reused connection carries no context', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT li.set_workspace($1, $2)', [A, await db.mintToken(A, ROLES.app, 60)]);
      const inside = await client.query('SELECT count(*)::int AS n FROM li.li_research_jobs');
      assert.equal(inside.rows[0].n, 1);
      await client.query('COMMIT');
      const after = await client.query('SELECT count(*)::int AS n FROM li.li_research_jobs');
      assert.equal(after.rows[0].n, 0, 'the next transaction on the same connection has no context');
    } finally {
      client.release();
    }
  });

  test('the cleanup', async () => {
    if (app) await app.end();
    if (db) await dropDatabase(DATABASE, [db.pool, db.owner, db.controlPool, db.platformPool, db.admin]);
  });
}
