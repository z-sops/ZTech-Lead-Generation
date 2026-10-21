'use strict';

/**
 * The cross-tenant denial suite (M2).
 *
 * The mission: a customer in workspace A must never be able to read, modify,
 * delete, reference or control workspace B's records - **even when the
 * application-level workspace filters are missing or wrong**.
 *
 * So these tests do NOT use the store's filters. They connect as the RUNTIME
 * role (`ztech_app`, which is not the owner, is not a superuser and has no
 * BYPASSRLS) and run raw SQL against the database. The only thing that stops
 * them is the DATABASE.
 *
 * The two workspaces are independent tenants of the same database.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { freshDatabase, dropDatabase, roleUrl, ROLES, skip } = require('./lib/postgres');

const A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const T1 = '2026-09-01T00:00:00.000Z';

if (!process.env.ZTECH_PG_URL) {
  test('[denial] the cross-tenant denial suite (skipped: no PostgreSQL is configured)', { skip: 'set ZTECH_PG_URL' }, () => {});
} else {
  const DATABASE = 'ztech_denial';
  let db = null;
  let bSession = null;
  let pool = null;

  /** A transaction with workspace A's context, on the runtime role. */
  async function asA(fn) {
    return pool.connect().then(async (client) => {
      try {
        await client.query('BEGIN');
        await client.query('SELECT li.set_workspace($1, $2)', [A, await db.mintToken(A, ROLES.app)]);
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    });
  }

  /** A transaction with workspace B's context, on the runtime role. */
  async function asB(fn) {
    return pool.connect().then(async (client) => {
      try {
        await client.query('BEGIN');
        await client.query('SELECT li.set_workspace($1, $2)', [B, await db.mintToken(B, ROLES.app, 300, bSession.sessionId, bSession.userId)]);
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    });
  }

  /** A transaction with NO context at all. */
  async function withoutContext(fn) {
    return pool.connect().then(async (client) => {
      try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    });
  }

  test('the denial suite is set up: two tenants, one runtime role', async () => {
    db = await freshDatabase(DATABASE, { workspaces: [A, B] });
    bSession = await db.sessionFor(B);
    pool = new Pool({ connectionString: roleUrl(ROLES.app, DATABASE), options: '-c search_path=li' });
    // A row for workspace B, written by the owner (the deployment's migrator).
    await db.owner.query(
      'INSERT INTO li.li_research_jobs (workspace_id, job_id, lead_id, provider_id, request_key, state, options_json, created_at, updated_at, version) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, 1)',
      [B, 'rjob_b', 'L-B', 'fake', 'key-b', 'requested', JSON.stringify({}), T1],
    );
    const seen = await asA(async (client) => (await client.query('SELECT job_id FROM li.li_research_jobs')).rows);
    assert.deepEqual(seen, [], 'workspace A cannot see workspace B\'s row');
    const owner = await db.owner.query('SELECT job_id FROM li.li_research_jobs');
    assert.equal(owner.rows.length, 1, 'but the row is really there');
  });

  test('SELECT: another tenant\'s row is invisible', async () => {
    const rows = await asA(async (client) => (await client.query('SELECT * FROM li.li_research_jobs WHERE job_id = $1', ['rjob_b'])).rows);
    assert.equal(rows.length, 0);
    const counted = await asA(async (client) => (await client.query('SELECT count(*)::int AS n FROM li.li_research_jobs')).rows[0].n);
    assert.equal(counted, 0, 'and it is not counted either');
  });

  test('INSERT: a tenant may not write a row into another tenant\'s workspace', async () => {
    await assert.rejects(asA(async (client) => client.query(
      'INSERT INTO li.li_research_jobs (workspace_id, job_id, lead_id, provider_id, request_key, state, options_json, created_at, updated_at, version) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, 1)',
      [B, 'rjob_injected', 'L-B', 'fake', 'key-x', 'requested', JSON.stringify({}), T1],
    )), /row-level security|violates row-level security policy/);
    const owner = await db.owner.query('SELECT job_id FROM li.li_research_jobs WHERE job_id = $1', ['rjob_injected']);
    assert.equal(owner.rows.length, 0, 'the row was not written');
  });

  test('UPDATE: a tenant may not modify another tenant\'s row', async () => {
    const res = await asA(async (client) => client.query("UPDATE li.li_research_jobs SET state = 'failed' WHERE job_id = $1", ['rjob_b']));
    assert.equal(res.rowCount, 0, 'no row was changed');
    const owner = await db.owner.query('SELECT state FROM li.li_research_jobs WHERE job_id = $1', ['rjob_b']);
    assert.equal(owner.rows[0].state, 'requested', 'and the row is unchanged');
  });

  test('DELETE: a tenant may not delete another tenant\'s row', async () => {
    const res = await asA(async (client) => client.query('DELETE FROM li.li_research_jobs WHERE job_id = $1', ['rjob_b']));
    assert.equal(res.rowCount, 0, 'no row was deleted');
    const owner = await db.owner.query('SELECT count(*)::int AS n FROM li.li_research_jobs');
    assert.equal(owner.rows[0].n, 1, 'and the row is still there');
  });

  test('UPSERT: a tenant may not write over another tenant\'s row', async () => {
    await assert.rejects(asA(async (client) => client.query(
      'INSERT INTO li.li_research_jobs (workspace_id, job_id, lead_id, provider_id, request_key, state, options_json, created_at, updated_at, version) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, 1) '
      + 'ON CONFLICT (workspace_id, job_id) DO UPDATE SET state = $9',
      [B, 'rjob_b', 'L-B', 'fake', 'key-b', 'requested', JSON.stringify({}), T1, 'failed'],
    )), /row-level security|violates row-level security policy/);
    const owner = await db.owner.query('SELECT state FROM li.li_research_jobs WHERE job_id = $1', ['rjob_b']);
    assert.equal(owner.rows[0].state, 'requested', 'the other tenant\'s row is unchanged');
  });

  test('a JOIN cannot bring the other tenant\'s row into the result', async () => {
    const rows = await asA(async (client) => client.query(
      'SELECT p.pitch_id, j.job_id FROM li.li_pitch_drafts p JOIN li.li_research_jobs j ON j.lead_id = p.lead_id',
    ));
    assert.deepEqual(rows.rows, [], 'the join sees nothing of the other tenant');
  });

  test('an aggregate cannot leak the other tenant\'s rows', async () => {
    const agg = await asA(async (client) => client.query(
      'SELECT count(*)::int AS n, max(created_at) AS newest, sum(attempts) AS attempts FROM li.li_research_jobs',
    ));
    assert.equal(agg.rows[0].n, 0);
    assert.equal(agg.rows[0].newest, null, 'and no value is derived from the other tenant');
  });

  test('a tenant may hold the same primary key as another tenant', async () => {
    // The key is (workspace_id, id), so the two rows do not collide.
    await asA(async (client) => client.query(
      'INSERT INTO li.li_research_jobs (workspace_id, job_id, lead_id, provider_id, request_key, state, options_json, created_at, updated_at, version) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, 1)',
      [A, 'rjob_b', 'L-A', 'fake', 'key-a', 'requested', JSON.stringify({}), T1],
    ));
    const a = await asA(async (client) => (await client.query('SELECT job_id FROM li.li_research_jobs')).rows);
    assert.equal(a.length, 1, 'workspace A sees its own row');
    const b = await asB(async (client) => (await client.query('SELECT job_id, lead_id FROM li.li_research_jobs')).rows);
    assert.equal(b.length, 1);
    assert.equal(b[0].lead_id, 'L-B', 'workspace B sees only its own');
  });

  test('a tenant may not REFERENCE another tenant\'s record', async () => {
    // The composite foreign key is workspace-aware: a step may only point at
    // a sequence of the SAME workspace.
    await db.owner.query(
      'INSERT INTO li.li_sequences (workspace_id, sequence_id, lead_id, mailbox_id, first_send_id, first_pitch_id, thread_id, first_subject, recipient_address, first_accepted_at, status, created_at, updated_at) '
      + "VALUES ($1, 'seq_bbbbbbbb', 'L-B', 'mbx_bbbbbbbb', 's-b', 'p-b', 'th-b', 'subject', 'a@b.test', $2, 'draft', $2, $2)",
      [B, T1],
    );
    await assert.rejects(asA(async (client) => client.query(
      'INSERT INTO li.li_sequence_steps (workspace_id, sequence_id, step_no, pitch_id, delay_days, state, limit_strikes, draft_json, updated_at) VALUES ($1, $2, 1, $3, 3, $4, 0, $5, $6)',
      [A, 'seq_bbbbbbbb', 'sp-x', 'waiting', JSON.stringify({ pitch_id: 'sp-x', kind: 'followup' }), T1],
    )), /foreign key|violates foreign key constraint/);
    const owner = await db.owner.query('SELECT count(*)::int AS n FROM li.li_sequence_steps');
    assert.equal(owner.rows[0].n, 0, 'the reference was not created');
  });

  test('a missing context sees nothing and writes nothing', async () => {
    const rows = await withoutContext(async (client) => (await client.query('SELECT * FROM li.li_research_jobs')).rows);
    assert.deepEqual(rows, [], 'no row is visible without a context');
    await assert.rejects(withoutContext(async (client) => client.query(
      'INSERT INTO li.li_research_jobs (workspace_id, job_id, lead_id, provider_id, request_key, state, options_json, created_at, updated_at, version) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, 1)',
      [A, 'rjob_nocontext', 'L-A', 'fake', 'key-nc', 'requested', JSON.stringify({}), T1],
    )), /row-level security|violates row-level security policy/);
  });

  test('an invalid context fails closed', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // A context that is not a uuid. The policy's function returns NULL, so
      // nothing matches - it never widens the access.
      await client.query("SELECT set_config('app.workspace_id', 'not-a-uuid', true)");
      const rows = await client.query('SELECT * FROM li.li_research_jobs');
      assert.deepEqual(rows.rows, [], 'nothing is visible');
      await assert.rejects(client.query(
        'INSERT INTO li.li_research_jobs (workspace_id, job_id, lead_id, provider_id, request_key, state, options_json, created_at, updated_at, version) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, 1)',
        [A, 'rjob_badctx', 'L-A', 'fake', 'key-bc', 'requested', JSON.stringify({}), T1],
      ), /row-level security|violates row-level security policy/);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  test('a mismatched context may not write into another workspace', async () => {
    await assert.rejects(asA(async (client) => client.query(
      'INSERT INTO li.li_research_jobs (workspace_id, job_id, lead_id, provider_id, request_key, state, options_json, created_at, updated_at, version) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, 1)',
      [B, 'rjob_mismatch', 'L-B', 'fake', 'key-mm', 'requested', JSON.stringify({}), T1],
    )), /row-level security|violates row-level security policy/);
  });

  test('the context does not survive the transaction', async () => {
    // The context belongs to ONE transaction, so a pooled connection cannot
    // carry one tenant's context into the next operation.
    const rows = await pool.connect().then(async (client) => {
      try {
        await client.query('BEGIN');
        await client.query('SELECT li.set_workspace($1, $2)', [A, await db.mintToken(A, ROLES.app)]);
        const inside = await client.query('SELECT count(*)::int AS n FROM li.li_research_jobs');
        await client.query('COMMIT');
        const after = await client.query('SELECT count(*)::int AS n FROM li.li_research_jobs');
        return { inside: inside.rows[0].n, after: after.rows[0].n };
      } finally {
        client.release();
      }
    });
    assert.equal(rows.inside, 1, 'inside the transaction the context is in force');
    assert.equal(rows.after, 0, 'after it the connection has no context at all');
  });

  test('the cleanup', async () => {
    if (pool) await pool.end();
    if (db) await dropDatabase(DATABASE, [db.pool, db.owner, db.admin]);
  });
}
