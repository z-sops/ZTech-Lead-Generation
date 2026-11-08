'use strict';

/**
 * The context forgery suite (M2, correction C1).
 *
 * THE VULNERABILITY THIS SUITE EXISTS FOR
 * ---------------------------------------
 * The first implementation of the workspace context kept it in the custom
 * setting `app.workspace_id`, and the row-level security policy compared
 * the row's workspace with `current_setting('app.workspace_id')`.
 *
 * A custom setting is ordinary configuration. ANY role may write one:
 *
 *     SELECT set_config('app.workspace_id', '<another tenant>', false);
 *
 * so a session that was authorised for workspace A could simply write
 * workspace B's id into the setting, and the policy - which trusted the
 * setting - would hand it B's rows. The policy trusted a value the caller
 * controlled. That was a complete cross-tenant breach: read AND write.
 *
 * PostgreSQL 16 cannot close that door by locking the setting down:
 * `REVOKE SET ON PARAMETER` applies to KNOWN parameters, and a custom
 * placeholder is not one. The setting stays writable, and it must not be
 * trusted.
 *
 * So the context does not live in a setting any more. It lives in a table
 * the runtime roles cannot write, and it is opened with a TOKEN that only
 * the control plane can issue. This suite proves that:
 *
 *   1. a forged setting has NO effect - the policy does not read it;
 *   2. the context table cannot be written by a runtime role;
 *   3. a runtime role may not issue a token, so it may not choose its
 *      tenant;
 *   4. a token is bound to its workspace, to its role and to its lifetime;
 *   5. a role that is granted MANY workspaces still reaches only the one
 *      it holds a token for - the grant is a ceiling, not the authority.
 *
 * Everything here runs as the RUNTIME role, in a real PostgreSQL 16, with
 * raw SQL - not through the store - so the only thing that can stop it is
 * the database.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { freshDatabase, dropDatabase, roleUrl, ROLES, skip } = require('./lib/postgres');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const T1 = '2026-09-01T00:00:00.000Z';

if (!process.env.ZTECH_PG_URL) {
  test('[forgery] the context forgery suite (skipped: no PostgreSQL is configured)', { skip: 'set ZTECH_PG_URL' }, () => {});
} else {
  const DATABASE = 'ztech_forgery';
  let db = null;
  let app = null;
  let worker = null;

  const INSERT_JOB = 'INSERT INTO li.li_research_jobs (workspace_id, job_id, lead_id, provider_id, request_key, state, options_json, created_at, updated_at, version) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, 1)';

  /** Run fn inside a transaction with a context, on the runtime role. */
  async function withContext(pool, workspace, token, fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT li.set_workspace($1, $2)', [workspace, token]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  test('the setup: two tenants, one runtime role granted BOTH', async () => {
    db = await freshDatabase(DATABASE, { workspaces: [A, B] });
    app = new Pool({ connectionString: roleUrl(ROLES.app, DATABASE), options: '-c search_path=li' });
    worker = new Pool({ connectionString: roleUrl(ROLES.worker, DATABASE), options: '-c search_path=li' });
    // The role is granted BOTH workspaces: this is the "shared role" case.
    const grants = await db.owner.query('SELECT role_name, workspace_id FROM li.workspace_grants WHERE role_name = $1 ORDER BY workspace_id', [ROLES.app]);
    assert.equal(grants.rows.length, 2, 'the runtime role is granted both workspaces');
    // A row for each tenant, written by the migration role.
    await db.owner.query(INSERT_JOB, [A, 'job_a', 'L-A', 'fake', 'key-a', 'requested', JSON.stringify({}), T1]);
    await db.owner.query(INSERT_JOB, [B, 'job_b', 'L-B', 'fake', 'key-b', 'requested', JSON.stringify({}), T1]);
  });

  test('the context is NOT a setting: a forged setting has no effect', async () => {
    const token = await db.mintToken(A, ROLES.app);
    const seen = await withContext(app, A, token, async (client) => {
      // The forgery: write the other tenant's id into the setting, in every
      // way a caller can.
      const forged = await client.query("SELECT set_config('app.workspace_id', $1, false) AS v", [B]);
      assert.equal(forged.rows[0].v, B, 'the setting really was written - PostgreSQL does not stop a caller from writing a custom setting');
      // And the isolation does not care.
      const rows = await client.query('SELECT job_id FROM li.li_research_jobs ORDER BY job_id');
      return rows.rows.map((r) => r.job_id);
    });
    assert.deepEqual(seen, ['job_a'], 'the forged setting changed nothing: the session still sees only its own tenant');
  });

  test('a forged setting does not open a write either', async () => {
    const token = await db.mintToken(A, ROLES.app);
    await withContext(app, A, token, async (client) => {
      await client.query("SELECT set_config('app.workspace_id', $1, false)", [B]);
      const updated = await client.query("UPDATE li.li_research_jobs SET state = 'failed' WHERE job_id = 'job_b'");
      assert.equal(updated.rowCount, 0, 'the other tenant\'s row was not touched');
    });
    const check = await db.owner.query('SELECT state FROM li.li_research_jobs WHERE job_id = $1', ['job_b']);
    assert.equal(check.rows[0].state, 'requested', 'and the row is unchanged');
  });

  test('a direct SET, a prepared statement and a connection reuse are all refused', async () => {
    const token = await db.mintToken(A, ROLES.app);
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT li.set_workspace($1, $2)', [A, token]);
      // 1. a direct SET
      await client.query(`SET app.workspace_id = '${B}'`);
      // 2. a prepared statement, with the value as a parameter
      await client.query('SELECT set_config($1, $2, false)', ['app.workspace_id', B]);
      // 3. the transaction-local form
      await client.query('SELECT set_config($1, $2, true)', ['app.workspace_id', B]);
      const rows = await client.query('SELECT job_id FROM li.li_research_jobs');
      assert.deepEqual(rows.rows.map((r) => r.job_id), ['job_a'], 'none of the three changed what the session can see');
      await client.query('COMMIT');
      // 4. the same connection, in a new transaction
      const after = await client.query('SELECT job_id FROM li.li_research_jobs');
      assert.deepEqual(after.rows, [], 'and a reused connection carries no context at all');
    } finally {
      client.release();
    }
  });

  test('the context table cannot be written by the runtime role', async () => {
    const token = await db.mintToken(A, ROLES.app);
    const attempts = [
      ['INSERT INTO li.workspace_context (backend_pid, xid, role_name, workspace_id) VALUES (1, pg_current_xact_id(), $1, $2)', [ROLES.app, B]],
      ['UPDATE li.workspace_context SET workspace_id = $1 WHERE role_name = $2', [B, ROLES.app]],
      ['DELETE FROM li.workspace_context', []],
      ['TRUNCATE li.workspace_context', []],
    ];
    for (const [sql, params] of attempts) {
      // Each one in its own transaction: a refused statement aborts the
      // transaction it is in.
      const client = await app.connect();
      try {
        await client.query('BEGIN');
        await assert.rejects(
          client.query(sql, params),
          /permission denied|must be owner/i,
          `refused: ${sql.slice(0, 40)}`,
        );
      } finally {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
      }
    }
    // And the context is still A's, and only A's.
    const seen = await withContext(app, A, token, async (client) => {
      const rows = await client.query('SELECT job_id FROM li.li_research_jobs');
      return rows.rows.map((r) => r.job_id);
    });
    assert.deepEqual(seen, ['job_a']);
  });

  test('the runtime role may not issue a token', async () => {
    const client = await app.connect();
    try {
      await assert.rejects(
        client.query('SELECT li.issue_workspace_token($1, $2, $3, $4, 300)', [B, ROLES.app, db.sessionId, db.userId]),
        /permission denied/i,
        'a session may not ask for its own token',
      );
    } finally {
      client.release();
    }
  });

  test('a token is bound to its workspace', async () => {
    const tokenA = await db.mintToken(A, ROLES.app);
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await assert.rejects(
        client.query('SELECT li.set_workspace($1, $2)', [B, tokenA]),
        /another workspace|not valid/i,
        'a token for A may not open a context for B',
      );
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  test('a token is bound to its role', async () => {
    // The worker role may not open a WORKSPACE context at all: the
    // privilege is revoked, and the function refuses the role in its own
    // body as defence in depth. The refusal is therefore one layer
    // STRONGER than it was, and the assertion accepts it - but the
    // assertion still demands a refusal, and it now also proves WHY.
    const may = await db.owner.query(
      "SELECT has_function_privilege($1, 'li.set_workspace(uuid,text)', 'EXECUTE') AS may", [ROLES.worker],
    );
    assert.equal(may.rows[0].may, false, 'the worker role may not execute the workspace-context function');

    const tokenApp = await db.mintToken(A, ROLES.app);
    const client = await worker.connect();
    try {
      await client.query('BEGIN');
      await assert.rejects(
        client.query('SELECT li.set_workspace($1, $2)', [A, tokenApp]),
        /permission denied|another role|not valid/i,
        "another role may not use this role's token",
      );
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  test('a token is bound to its role, at the function level', async () => {
    // The role binding lives INSIDE the function, and it is proved with a
    // role that still holds the privilege: the platform role is granted
    // the workspace, a token is minted for it, and it is presented as the
    // customer role. The function must refuse it.
    await db.owner.query(
      'INSERT INTO li.workspace_grants (role_name, workspace_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [ROLES.platform, A],
    );
    const tokenPlatform = await db.mintToken(A, ROLES.platform);
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await assert.rejects(
        client.query('SELECT li.set_workspace($1, $2)', [A, tokenPlatform]),
        /another role|not valid/i,
        "another role may not use this role's token",
      );
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  test('a tampered token is refused', async () => {
    const token = await db.mintToken(A, ROLES.app);
    const [payload, signature] = token.split('.');
    // Flip one character of the signature.
    const flipped = (signature[0] === 'a' ? 'b' : 'a') + signature.slice(1);
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await assert.rejects(
        client.query('SELECT li.set_workspace($1, $2)', [A, `${payload}.${flipped}`]),
        /not valid/i,
        'a token whose signature was changed is refused',
      );
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  test('an expired token is refused', async () => {
    const token = await db.mintToken(A, ROLES.app, 1);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await assert.rejects(
        client.query('SELECT li.set_workspace($1, $2)', [A, token]),
        /expired/i,
        'a token that has run out is refused',
      );
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  test('a role granted MANY workspaces reaches only the one it holds a token for', async () => {
    // The sharpest test: the role is granted A and B, and the session holds
    // a token for A. B is unreachable - not because the role lacks the
    // grant, but because the session has no token for B.
    const token = await db.mintToken(A, ROLES.app);
    const seen = await withContext(app, A, token, async (client) => {
      const rows = await client.query('SELECT job_id FROM li.li_research_jobs ORDER BY job_id');
      return rows.rows.map((r) => r.job_id);
    });
    assert.deepEqual(seen, ['job_a'], 'workspace B is out of reach, although the role is granted it');
    // And there is no way for the session to get a token for B.
    const client = await app.connect();
    try {
      await assert.rejects(client.query('SELECT li.issue_workspace_token($1, $2, $3, $4, 300)', [B, ROLES.app, db.sessionId, db.userId]), /permission denied/i);
    } finally {
      client.release();
    }
  });

  test('the context is dropped by a rollback', async () => {
    const token = await db.mintToken(A, ROLES.app);
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT li.set_workspace($1, $2)', [A, token]);
      const inside = await client.query('SELECT count(*)::int AS n FROM li.li_research_jobs');
      assert.equal(inside.rows[0].n, 1, 'inside the transaction the context is in force');
      await client.query('ROLLBACK');
      const after = await client.query('SELECT count(*)::int AS n FROM li.li_research_jobs');
      assert.equal(after.rows[0].n, 0, 'and the rollback took the context with it');
    } finally {
      client.release();
    }
  });

  test('the cleanup', async () => {
    if (app) await app.end();
    if (worker) await worker.end();
    if (db) await dropDatabase(DATABASE, [db.pool, db.owner, db.controlPool, db.platformPool, db.admin]);
  });
}
