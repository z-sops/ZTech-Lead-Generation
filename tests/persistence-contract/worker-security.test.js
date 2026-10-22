'use strict';

/**
 * The M4 P1 worker security: H1, H2, H3, H4, H5, H6 and H7.
 *
 * Every assertion here runs against a REAL PostgreSQL 16 with the REAL
 * roles, and most of them are made by ATTEMPTING the operation and
 * observing the refusal, not by reading the migration.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const {
  freshDatabase, dropDatabase, roleUrl, ROLES,
} = require('./lib/postgres');
const {
  assertRuntimeRoles, TENANT_TABLES, WORKER_ROLE,
} = require('../../packages/lead-intelligence-postgres/src/assertRoles');

const A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const B = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';

if (!process.env.ZTECH_PG_URL) {
  test('[security] the worker security suite (skipped: no PostgreSQL is configured)', { skip: 'set ZTECH_PG_URL' }, () => {});
} else {
  const DATABASE = 'ztech_p1sec';
  let db = null;
  const pools = [];

  function workerPool() {
    const p = new Pool({ connectionString: roleUrl(ROLES.worker, DATABASE), options: '-c search_path=li' });
    p.on('error', () => {});
    pools.push(p);
    return p;
  }

  async function identityCredential(workerId, ttl = 300) {
    const r = await db.controlPool.query('SELECT li.issue_worker_identity($1, $2) AS token', [workerId, ttl]);
    return r.rows[0].token;
  }

  async function insertJob(opts = {}) {
    const jobId = opts.jobId || crypto.randomUUID();
    await db.owner.query(
      `INSERT INTO li.job_queue (job_id, workspace_id, job_type, idempotency_key, payload, state, job_class)
       VALUES ($1, $2, $3, $4, '{}'::jsonb, 'queued', $5)`,
      [jobId, opts.workspaceId || A, opts.jobType || 'research', `key-${jobId}`, opts.className || 'noop'],
    );
    return jobId;
  }

  /** Queue a job, claim it as a worker, and get its execution credential. */
  async function claimWithToken(workerId, jobType = 'research') {
    const worker = workerPool();
    const identity = await identityCredential(workerId);
    const jobId = await insertJob({ jobType });
    const claim = (await worker.query('SELECT * FROM li.claim_job($1, $2)', [identity, 120])).rows[0];
    if (!claim || claim.job_id !== jobId) {
      throw new Error(`the worker did not claim the job it queued (${claim && claim.job_id} vs ${jobId})`);
    }
    const jobToken = (await worker.query('SELECT li.request_job_token($1, $2, $3, $4) AS t',
      [claim.job_id, claim.fencing_token, identity, 120])).rows[0].t;
    return { worker, identity, claim, jobToken, jobId };
  }

  test.before(async () => {
    db = await freshDatabase(DATABASE, { workspace: A, workspaces: [A, B] });
  });

  // Each test starts with an EMPTY queue, so a claim always takes the job
  // the test queued and no test can see another test's jobs.
  test.beforeEach(async () => {
    await db.owner.query('TRUNCATE li.job_queue');
  });

  test.after(async () => {
    await Promise.all(pools.map((p) => p.end().catch(() => {})));
    if (db) await dropDatabase(DATABASE, [db.pool, db.owner, db.controlPool, db.platformPool, db.identityPool, db.admin]);
  });

  // ---------------------------------------------------------------- H1
  test('H1: the identity service may NOT grant a workspace to the worker role', async () => {
    const before = await db.owner.query(
      'SELECT count(*)::int AS n FROM li.workspace_grants WHERE role_name = $1', [WORKER_ROLE],
    );
    const r = await db.identityPool.query('SELECT li.grant_workspace($1, $2) AS granted', [B, WORKER_ROLE]);
    assert.equal(r.rows[0].granted, false, 'the grant was refused');
    const after = await db.owner.query(
      'SELECT count(*)::int AS n FROM li.workspace_grants WHERE role_name = $1', [WORKER_ROLE],
    );
    assert.equal(after.rows[0].n, before.rows[0].n, 'and NO grant row was created or changed');
    // A workspace the worker was never granted: nothing is created there.
    const fresh = await db.owner.query(
      'SELECT count(*)::int AS n FROM li.workspace_grants WHERE role_name = $1 AND workspace_id = $2', [WORKER_ROLE, B],
    );
    const appGrant = await db.owner.query(
      'SELECT count(*)::int AS n FROM li.workspace_grants WHERE role_name = $1 AND workspace_id = $2', [ROLES.app, B],
    );
    assert.ok(fresh.rows[0].n <= appGrant.rows[0].n, 'the worker holds no more grants than the customer');
  });

  // ---------------------------------------------------------------- H2
  test('H2: the control plane may NOT issue a workspace token for the worker role', async () => {
    await assert.rejects(
      db.controlPool.query('SELECT li.issue_workspace_token($1, $2, $3, $4, 60)', [A, WORKER_ROLE, db.sessionId, db.userId]),
      /worker role/i,
      'the issuance was refused, even with a valid grant and a valid session',
    );
    await assert.rejects(
      db.identityPool.query('SELECT li.issue_workspace_token($1, $2, $3, $4, 60)', [A, WORKER_ROLE, db.sessionId, db.userId]),
      /worker role/i,
      'and the identity service may not do it either',
    );
  });

  // ---------------------------------------------------------------- H3
  test('H3: the worker may NOT execute the legacy workspace-context function', async () => {
    const may = await db.owner.query(
      "SELECT has_function_privilege($1, 'li.set_workspace(uuid,text)', 'EXECUTE') AS may", [WORKER_ROLE],
    );
    assert.equal(may.rows[0].may, false, 'the privilege is gone');
    const worker = workerPool();
    await assert.rejects(
      worker.query('SELECT li.set_workspace($1, $2)', [A, 'anything']),
      /permission denied/i,
      'the call is refused with a permission denial',
    );
  });

  test('H3: the customer path still works: ztech_app opens its authorised workspace', async () => {
    const token = await db.mintToken(A, ROLES.app);
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT li.set_workspace($1, $2)', [A, token]);
      const r = await client.query('SELECT li.current_workspace() AS ws');
      assert.equal(r.rows[0].ws, A, 'the customer opened its own workspace');
      await client.query('COMMIT');
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  test('H4: the token is still bound to its role, at the function level', async () => {
    // The worker no longer holds the privilege, so the binding is proved
    // with a role that DOES: the platform role's token, presented as the
    // customer role, is refused by the function's own role check.
    await db.owner.query(
      'INSERT INTO li.workspace_grants (role_name, workspace_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [ROLES.platform, A],
    );
    const platformToken = await db.mintToken(A, ROLES.platform);
    await assert.rejects(
      db.pool.query('SELECT li.set_workspace($1, $2)', [A, platformToken]),
      /another role/i,
      'a token bound to another role may not be used',
    );
  });

  // ---------------------------------------------------------------- H7
  test('H7: the worker holds NO DML on the legacy tenant business tables', async () => {
    const dml = await db.owner.query(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'li' AND c.relkind = 'r' AND c.relname <> ALL($1)
          AND (c.relacl::TEXT LIKE ('%' || $2 || '=r/%') OR c.relacl::TEXT LIKE ('%' || $2 || '=a/%')
               OR c.relacl::TEXT LIKE ('%' || $2 || '=w/%') OR c.relacl::TEXT LIKE ('%' || $2 || '=d/%'))`,
      [['job_queue', 'li_market_rules'], WORKER_ROLE],
    );
    assert.deepEqual(dml.rows.map((r) => r.relname), [], 'no legacy table grants the worker anything');
    // And the reference data is retained.
    const market = await db.owner.query(
      "SELECT has_table_privilege($1, 'li.li_market_rules', 'SELECT') AS may", [WORKER_ROLE],
    );
    assert.equal(market.rows[0].may, true, "the platform's reference data is still readable");
  });

  test('H7: the worker may NOT read the legacy business tables at all', async () => {
    const worker = workerPool();
    for (const table of ['li_research_jobs', 'li_mailboxes', 'li_saved_searches', 'li_suppressions']) {
      await assert.rejects(
        worker.query(`SELECT count(*) FROM li.${table}`),
        /permission denied/i,
        `the worker may not read li.${table}`,
      );
    }
  });

  test('the worker may NOT read the signing secret, nor write the context', async () => {
    const worker = workerPool();
    await assert.rejects(worker.query('SELECT secret FROM li.control_plane_secret'), /permission denied/i);
    await assert.rejects(worker.query('SELECT * FROM li.workspace_context'), /permission denied/i);
    await assert.rejects(
      worker.query('INSERT INTO li.workspace_context (backend_pid, xid, role_name, workspace_id) VALUES (1, pg_current_xact_id(), $1, $2)', [WORKER_ROLE, A]),
      /permission denied/i,
    );
  });

  // ---------------------------------------------------------------- the worker credential
  test('a forged worker identity is refused', async () => {
    const worker = workerPool();
    await assert.rejects(
      worker.query('SELECT li.claim_job($1, $2)', ['forged-identity', 120]),
      /not valid|malformed/i,
      'a forged identity is refused',
    );
    const [payload, signature] = 'deadbeef.cafe'.split('.');
    await assert.rejects(
      worker.query('SELECT li.claim_job($1, $2)', [`${payload}.${signature}`, 120]),
      /not valid|malformed/i,
      'a tampered identity is refused',
    );
  });

  test('an EXPIRED worker identity is refused', async () => {
    const worker = workerPool();
    // A credential that is correctly SIGNED but whose expiry has passed.
    // It is signed by the migration role, which is the only role that may
    // read the signing secret, exactly as the control plane would.
    const sign = async (workerId, expiresAt) => {
      const issued = Math.floor(Date.now() / 1000);
      const payload = `${workerId}|${issued}|${expiresAt}|identity`;
      const r = await db.owner.query(
        `SELECT li.to_hex(pg_catalog.convert_to($1, 'UTF8')) || '.'
                || li.to_hex(li.hmac_sha256(s.secret, pg_catalog.convert_to($1, 'UTF8'))) AS token
           FROM li.control_plane_secret s WHERE s.singleton`,
        [payload],
      );
      return r.rows[0].token;
    };

    const expired = await sign('worker-expired-identity', Math.floor(Date.now() / 1000) - 60);
    await assert.rejects(
      worker.query('SELECT li.claim_job($1, $2)', [expired, 120]),
      /expired/i,
      'an expired identity is refused',
    );

    const live = await sign('worker-live-identity', Math.floor(Date.now() / 1000) + 300);
    const claim = await worker.query('SELECT * FROM li.claim_job($1, $2)', [live, 120]);
    assert.ok(Array.isArray(claim.rows), 'and a live, correctly signed identity is accepted');
  });

  test("a worker may not CLAIM a job with another worker's identity", async () => {
    const worker = workerPool();
    const identity = await identityCredential('worker-real');
    const other = await identityCredential('worker-other');
    await insertJob({ jobType: 'research' });
    const first = (await worker.query('SELECT * FROM li.claim_job($1, $2)', [identity, 120])).rows[0];
    assert.ok(first, 'the job was claimed');
    // The OTHER identity may not renew or take the lease.
    await assert.rejects(
      worker.query('SELECT li.renew_lease($1, $2, $3, $4)', [first.job_id, first.fencing_token, other, 120]),
      /does not hold the lease/i,
      'another worker may not renew the lease',
    );
  });

  // ---------------------------------------------------------------- the job context
  test('the job context is JOB scoped: another job of the same workspace is invisible', async () => {
    const { worker, claim, jobToken } = await claimWithToken('worker-scope');
    const otherJob = await insertJob({ jobType: 'research', workspaceId: A });
    const client = await worker.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT li.set_workspace_for_job($1, $2)', [claim.job_id, jobToken]);
      const mine = await client.query('SELECT job_id FROM li.job_queue');
      assert.equal(mine.rows.length, 1, 'exactly one job is visible');
      assert.equal(mine.rows[0].job_id, claim.job_id, "and it is the worker's own job");
      const theirs = await client.query('SELECT job_id FROM li.job_queue WHERE job_id = $1', [otherJob]);
      assert.equal(theirs.rows.length, 0, 'another job of the SAME workspace is not visible');
      // And a direct write to it affects zero rows.
      const wrote = await client.query("UPDATE li.job_queue SET state = 'succeeded' WHERE job_id = $1", [otherJob]);
      assert.equal(wrote.rowCount, 0, 'and it may not be written');
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  test('CROSS-WORKSPACE access is denied', async () => {
    const { worker, claim, jobToken } = await claimWithToken('worker-cross');
    const foreignJob = await insertJob({ jobType: 'research', workspaceId: B });
    const client = await worker.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT li.set_workspace_for_job($1, $2)', [claim.job_id, jobToken]);
      const theirs = await client.query('SELECT job_id FROM li.job_queue WHERE job_id = $1', [foreignJob]);
      assert.equal(theirs.rows.length, 0, 'a job of another workspace is invisible');
      const wrote = await client.query("UPDATE li.job_queue SET state = 'succeeded' WHERE job_id = $1", [foreignJob]);
      assert.equal(wrote.rowCount, 0, 'and it may not be written');
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  test('the job context is TRANSACTION scoped: it does not survive the transaction', async () => {
    const { worker, claim, jobToken } = await claimWithToken('worker-tx');
    const client = await worker.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT li.set_workspace_for_job($1, $2)', [claim.job_id, jobToken]);
      const inside = await client.query('SELECT li.current_job() AS job');
      assert.equal(inside.rows[0].job, claim.job_id, 'inside the transaction the job is visible');
      await client.query('COMMIT');
      const outside = await client.query('SELECT li.current_job() AS job');
      assert.equal(outside.rows[0].job, null, 'after the transaction the authority is GONE');
      const rows = await client.query('SELECT job_id FROM li.job_queue');
      assert.equal(rows.rows.length, 0, 'and the queue is invisible again');
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  test("a POOLED connection does not carry one job's authority into another", async () => {
    const { worker, claim, jobToken } = await claimWithToken('worker-pool');
    const client = await worker.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT li.set_workspace_for_job($1, $2)', [claim.job_id, jobToken]);
      await client.query('COMMIT');
      // The same connection, a NEW transaction: the context is not there.
      await client.query('BEGIN');
      const carried = await client.query('SELECT li.current_job() AS job');
      assert.equal(carried.rows[0].job, null, 'the pooled connection carries no authority');
      await client.query('COMMIT');
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  test('the job context CLEARS a previous session context on the same backend', async () => {
    // A backend that already carries a SESSION context must not keep it when
    // a job context replaces it. The session fields are cleared in the
    // ON CONFLICT branch, and the context_kind is replaced.
    const { worker, claim, jobToken } = await claimWithToken('worker-replace');
    const client = await worker.connect();
    try {
      const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      // A session-shaped context row for THIS backend, as the owner.
      await db.owner.query(
        `INSERT INTO li.workspace_context (backend_pid, xid, role_name, workspace_id, expires_at, session_id, user_id, context_kind)
         VALUES ($1, pg_current_xact_id(), $2, $3, now() + interval '5 minutes', $4, $5, 'session')
         ON CONFLICT (backend_pid) DO UPDATE SET session_id = EXCLUDED.session_id, user_id = EXCLUDED.user_id`,
        [pid, WORKER_ROLE, A, db.sessionId, db.userId],
      );
      const before = await db.owner.query(
        'SELECT context_kind, session_id, user_id, job_id FROM li.workspace_context WHERE backend_pid = $1', [pid],
      );
      assert.equal(before.rows.length, 1, 'the session-shaped context row is in place');
      assert.equal(before.rows[0].context_kind, 'session', 'and it IS a session context');
      await client.query('BEGIN');
      await client.query('SELECT li.set_workspace_for_job($1, $2)', [claim.job_id, jobToken]);
      // The workspace authority is gone INSIDE the transaction.
      const ws = await client.query('SELECT li.current_workspace() AS ws');
      assert.equal(ws.rows[0].ws, null, 'the workspace authority is gone');
      await client.query('COMMIT');
      // The row is read from outside the transaction, so the replacement is
      // committed first: the session context was REPLACED, not extended.
      const row = await db.owner.query(
        'SELECT context_kind, session_id, user_id, job_id FROM li.workspace_context WHERE backend_pid = $1', [pid],
      );
      assert.equal(row.rows[0].context_kind, 'job', 'the context is a job context');
      assert.equal(row.rows[0].session_id, null, 'the session was CLEARED');
      assert.equal(row.rows[0].user_id, null, 'the user was CLEARED');
      assert.equal(row.rows[0].job_id, claim.job_id, 'and the job is bound');
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  test('a job context exposes NO legacy workspace-wide data', async () => {
    const { worker, claim, jobToken } = await claimWithToken('worker-nolegacy');
    // H7 removed the privilege, so the refusal is STRONGER than an empty
    // result: the worker may not read the legacy tables AT ALL. A refused
    // statement aborts a transaction, so this is checked outside one.
    for (const table of ['li_saved_searches', 'li_mailboxes', 'li_research_jobs']) {
      await assert.rejects(
        worker.query(`SELECT count(*)::int AS n FROM li.${table}`),
        /permission denied/i,
        `the worker may not read li.${table}`,
      );
    }
    const client = await worker.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT li.set_workspace_for_job($1, $2)', [claim.job_id, jobToken]);
      const ws = await client.query('SELECT li.current_workspace() AS ws');
      assert.equal(ws.rows[0].ws, null, 'and li.current_workspace() is NULL under a job context');
      const job = await client.query('SELECT li.current_job() AS job');
      assert.equal(job.rows[0].job, claim.job_id, 'while the job itself is the context');
      await client.query('COMMIT');
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  // ---------------------------------------------------------------- the customer role
  test('the customer role may NOT claim or execute jobs', async () => {
    await assert.rejects(
      db.pool.query('SELECT li.claim_job($1, $2)', ['anything', 120]),
      /permission denied/i,
      'the customer may not claim a job',
    );
    await assert.rejects(
      db.pool.query('SELECT li.set_workspace_for_job($1, $2)', ['00000000-0000-0000-0000-000000000000', 'anything']),
      /permission denied/i,
      'the customer may not open a job context',
    );
    await assert.rejects(
      db.pool.query('SELECT li.write_job_result($1, $2, $3, $4, $5)', ['00000000-0000-0000-0000-000000000000', 1, 'succeeded', '{}', null]),
      /permission denied/i,
      'the customer may not write a result',
    );
  });

  // ---------------------------------------------------------------- the catalogue
  test('assertRuntimeRoles() passes, as the customer AND as the worker', async () => {
    const asApp = await assertRuntimeRoles(db.pool);
    assert.deepEqual(asApp.problems, [], 'the customer role satisfies every assertion');
    assert.equal(asApp.ok, true);
    const worker = workerPool();
    const asWorker = await assertRuntimeRoles(worker);
    assert.deepEqual(asWorker.problems, [], 'the worker role satisfies every assertion');
    assert.equal(asWorker.ok, true);
  });

  test('the catalogue REJECTS a deliberately unsafe fixture', async () => {
    // The queue loses its policy: the assertion must notice.
    await db.owner.query('DROP POLICY tenant_isolation ON li.job_queue');
    const result = await assertRuntimeRoles(db.pool);
    assert.equal(result.ok, false, 'the assertion does not pass for an unprotected table');
    assert.ok(
      result.problems.some((p) => /policy/i.test(p)),
      `and it says why: ${JSON.stringify(result.problems)}`,
    );
    // Put it back.
    await db.owner.query(
      `CREATE POLICY tenant_isolation ON li.job_queue
         USING (li.job_row_authorized(job_id, workspace_id, fencing_token))
         WITH CHECK (li.job_row_authorized(job_id, workspace_id, fencing_token))`,
    );
    const restored = await assertRuntimeRoles(db.pool);
    assert.deepEqual(restored.problems, [], 'and the assertion passes again once it is repaired');
  });

  test('the tenant inventory includes the queue', () => {
    assert.ok(TENANT_TABLES.includes('job_queue'), 'job_queue is a protected tenant table');
  });
}
