'use strict';

/**
 * The M4 P1 job queue: claiming, leases, fencing and recovery.
 *
 * Everything runs against a REAL PostgreSQL 16, with the REAL roles:
 * the worker connects as ztech_worker, the control plane as ztech_control,
 * and the rows are written by the migration role. Nothing here is mocked.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const { freshDatabase, dropDatabase, roleUrl, ROLES } = require('./lib/postgres');

const A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const B = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';

if (!process.env.ZTECH_PG_URL) {
  test('[queue] the job queue suite (skipped: no PostgreSQL is configured)', { skip: 'set ZTECH_PG_URL' }, () => {});
} else {
  const DATABASE = 'ztech_queue';
  let db = null;
  const pools = [];

  /** A worker pool, and a control-plane identity credential. */
  function workerPool() {
    const p = new Pool({ connectionString: roleUrl(ROLES.worker, DATABASE), options: '-c search_path=li' });
    p.on('error', () => {});
    pools.push(p);
    return p;
  }

  async function identityCredential(workerId, ttl = 300) {
    const r = await db.controlPool.query(
      'SELECT li.issue_worker_identity($1, $2) AS token', [workerId, ttl],
    );
    return r.rows[0].token;
  }

  /** Insert a job, as the migration role. */
  async function insertJob(opts = {}) {
    const jobId = opts.jobId || crypto.randomUUID();
    await db.owner.query(
      `INSERT INTO li.job_queue (job_id, workspace_id, job_type, idempotency_key, payload, state, job_class,
                                 priority, max_attempts, next_attempt_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, 'queued', $6, $7, $8, COALESCE($9::timestamptz, now()))`,
      [jobId, opts.workspaceId || A, opts.jobType || 'research', `key-${jobId}`,
        JSON.stringify(opts.payload || {}), opts.className || 'noop', opts.priority || 100,
        opts.maxAttempts || 5, opts.due || null],
    );
    return jobId;
  }

  /** Expire a job's lease. The lease and its owner move together. */
  async function expireLease(jobId, owner = 'worker-gone') {
    await db.owner.query(
      `UPDATE li.job_queue SET state = 'leased', lease_owner = $2,
              lease_expires_at = now() - interval '1 second'
        WHERE job_id = $1`, [jobId, owner],
    );
  }

  test.before(async () => {
    db = await freshDatabase(DATABASE, { workspace: A, workspaces: [A, B] });
  });

  // Each test starts with an EMPTY queue, so the counts are exact and no
  // test can see another test's jobs.
  test.beforeEach(async () => {
    await db.owner.query('TRUNCATE li.job_queue');
  });

  test.after(async () => {
    await Promise.all(pools.map((p) => p.end().catch(() => {})));
    if (db) await dropDatabase(DATABASE, [db.pool, db.owner, db.controlPool, db.platformPool, db.identityPool, db.admin]);
  });

  test('the queue exists, with row-level security enabled AND forced', async () => {
    const policy = await db.owner.query(
      `SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
              (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation') AS policies
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'li' AND c.relname = 'job_queue'`,
    );
    assert.equal(policy.rows[0].rls, true, 'row-level security is enabled');
    assert.equal(policy.rows[0].forced, true, 'row-level security is FORCED');
    assert.equal(Number(policy.rows[0].policies), 1, 'and it carries the tenant_isolation policy');
  });

  test('a claim takes the job, the lease and the fencing token', async () => {
    const worker = workerPool();
    const jobId = await insertJob({ jobType: 'research' });
    const token = await identityCredential('worker-alpha');
    const r = await worker.query('SELECT * FROM li.claim_job($1, $2)', [token, 120]);
    assert.equal(r.rows.length, 1, 'the job was claimed');
    assert.equal(r.rows[0].job_id, jobId, 'and it is the job that was queued');
    assert.equal(Number(r.rows[0].fencing_token), 1, 'the fencing token advanced to 1');
    assert.equal(Number(r.rows[0].attempt_count), 1, 'the attempt was counted');
    const row = await db.owner.query('SELECT state, lease_owner, lease_expires_at FROM li.job_queue WHERE job_id = $1', [jobId]);
    assert.equal(row.rows[0].state, 'leased', 'the job is leased');
    assert.equal(row.rows[0].lease_owner, 'worker-alpha', 'the lease belongs to the VERIFIED identity');
    assert.ok(new Date(row.rows[0].lease_expires_at) > new Date(), 'the lease expires in the future');
  });

  test('CONCURRENT claims never take the same job', async () => {
    const jobId = await insertJob({ jobType: 'research' });
    const token = await identityCredential('worker-race');
    const eight = [1, 2, 3, 4, 5, 6, 7, 8].map(() => workerPool());
    const results = await Promise.all(eight.map((p) => p.query('SELECT * FROM li.claim_job($1, $2)', [token, 120])));
    const claimed = results.flatMap((r) => r.rows);
    const mine = claimed.filter((r) => r.job_id === jobId);
    assert.equal(mine.length, 1, 'exactly ONE worker obtained the job');
    assert.equal(new Set(claimed.map((r) => r.job_id)).size, claimed.length, 'no job was claimed twice');
  });

  test('TEN jobs are distributed across competing workers with no duplicate ownership', async () => {
    const ids = [];
    for (let i = 0; i < 10; i += 1) ids.push(await insertJob({ jobType: 'research', priority: 100 - i }));
    const token = await identityCredential('worker-ten');
    const five = [1, 2, 3, 4, 5].map(() => workerPool());
    // Each worker claims until the queue is empty.
    const claimed = await Promise.all(five.map(async (p) => {
      const mine = [];
      for (;;) {
        const r = await p.query('SELECT * FROM li.claim_job($1, $2)', [token, 120]);
        if (!r.rows.length) break;
        mine.push(...r.rows);
      }
      return mine;
    }));
    const all = claimed.flat();
    assert.equal(all.length, 10, 'every job was claimed');
    assert.equal(new Set(all.map((r) => r.job_id)).size, 10, 'and no job was claimed twice');
    for (const id of ids) {
      assert.ok(all.some((r) => r.job_id === id), 'each of the ten jobs was taken');
    }
    const held = await db.owner.query("SELECT count(*)::int AS n FROM li.job_queue WHERE state = 'leased'");
    assert.equal(held.rows[0].n, 10, 'ten jobs are held');
  });

  test('a stale fencing token cannot write, and the current one can', async () => {
    const worker = workerPool();
    const jobId = await insertJob({ jobType: 'research' });
    const token = await identityCredential('worker-fence');
    const claim = (await worker.query('SELECT * FROM li.claim_job($1, $2)', [token, 120])).rows[0];
    assert.equal(claim.job_id, jobId, 'the worker claimed the job that was queued');
    const jobToken = (await worker.query('SELECT li.request_job_token($1, $2, $3, $4) AS t',
      [jobId, claim.fencing_token, token, 120])).rows[0].t;

    const client = await worker.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT li.set_workspace_for_job($1, $2)', [jobId, jobToken]);
      const stale = await client.query('SELECT li.write_job_result($1, $2, $3, $4, $5)',
        [jobId, Number(claim.fencing_token) - 1, 'succeeded', '{}', null]);
      assert.equal(Number(stale.rows[0].write_job_result), 0, 'a stale fencing token writes ZERO rows');
      const fresh = await client.query('SELECT li.write_job_result($1, $2, $3, $4, $5)',
        [jobId, claim.fencing_token, 'succeeded', '{"ok":true}', null]);
      assert.equal(Number(fresh.rows[0].write_job_result), 1, 'the current fencing token writes the row');
      await client.query('COMMIT');
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
    const row = await db.owner.query('SELECT state FROM li.job_queue WHERE job_id = $1', [jobId]);
    assert.equal(row.rows[0].state, 'succeeded', 'the job succeeded');
  });

  test('the lease may be renewed, and a renewal with a stale token is refused', async () => {
    const worker = workerPool();
    const jobId = await insertJob({ jobType: 'research' });
    const token = await identityCredential('worker-heartbeat');
    const claim = (await worker.query('SELECT * FROM li.claim_job($1, $2)', [token, 120])).rows[0];
    assert.equal(claim.job_id, jobId, 'the worker claimed the job that was queued');
    const before = (await db.owner.query('SELECT lease_expires_at FROM li.job_queue WHERE job_id = $1', [jobId])).rows[0].lease_expires_at;
    await worker.query('SELECT li.renew_lease($1, $2, $3, $4)', [jobId, claim.fencing_token, token, 300]);
    const after = (await db.owner.query('SELECT lease_expires_at FROM li.job_queue WHERE job_id = $1', [jobId])).rows[0].lease_expires_at;
    assert.ok(new Date(after) > new Date(before), 'the lease was extended');
    await assert.rejects(
      worker.query('SELECT li.renew_lease($1, $2, $3, $4)', [jobId, Number(claim.fencing_token) - 1, token, 300]),
      /fencing token/i,
      'a stale fencing token may not renew the lease',
    );
  });

  test('an expired lease is recovered, and the job is requeued', async () => {
    const worker = workerPool();
    const jobId = await insertJob({ jobType: 'research' });
    const token = await identityCredential('worker-expired');
    await worker.query('SELECT * FROM li.claim_job($1, $2)', [token, 120]);
    await expireLease(jobId);
    const recovered = await worker.query('SELECT * FROM li.recover_expired_leases(50)');
    const row = recovered.rows.find((r) => r.job_id === jobId);
    assert.ok(row, 'the expired job was reported');
    assert.equal(row.action, 'requeued', 'and it was requeued');
    const after = await db.owner.query('SELECT state, lease_owner, fencing_token, last_error FROM li.job_queue WHERE job_id = $1', [jobId]);
    assert.equal(after.rows[0].state, 'queued', 'the job is queued again');
    assert.equal(after.rows[0].lease_owner, null, 'the lease is gone');
    assert.equal(Number(after.rows[0].fencing_token), 2, 'the fencing token advanced, so the old holder is dead');
    assert.match(after.rows[0].last_error, /lease expired/i, 'and the reason is recorded');
  });

  test('a CHARGEABLE job is DEFERRED, never requeued: P1 may not invent an outcome', async () => {
    const worker = workerPool();
    const jobId = await insertJob({ jobType: 'research', className: 'chargeable' });
    const token = await identityCredential('worker-chargeable');
    const claim = await worker.query('SELECT * FROM li.claim_job($1, $2)', [token, 120]);
    assert.equal(claim.rows.filter((r) => r.job_id === jobId).length, 0, 'a chargeable job is never claimed in P1');
    await expireLease(jobId);
    const recovered = await worker.query('SELECT * FROM li.recover_expired_leases(50)');
    const row = recovered.rows.find((r) => r.job_id === jobId);
    assert.ok(row, 'the chargeable job was reported');
    assert.equal(row.action, 'deferred_to_p2', 'and it was DEFERRED to P2');
    const after = await db.owner.query('SELECT state FROM li.job_queue WHERE job_id = $1', [jobId]);
    assert.notEqual(after.rows[0].state, 'queued', 'it was NOT requeued');
  });

  test('the retry limit is honoured: a job that keeps expiring fails', async () => {
    const worker = workerPool();
    const jobId = await insertJob({ jobType: 'research', maxAttempts: 1 });
    const token = await identityCredential('worker-limit');
    await worker.query('SELECT * FROM li.claim_job($1, $2)', [token, 120]);
    await expireLease(jobId);
    const recovered = await worker.query('SELECT * FROM li.recover_expired_leases(50)');
    const row = recovered.rows.find((r) => r.job_id === jobId);
    assert.equal(row.action, 'failed_retry_limit', 'the job failed rather than looping');
    const after = await db.owner.query('SELECT state FROM li.job_queue WHERE job_id = $1', [jobId]);
    assert.equal(after.rows[0].state, 'failed', 'the job is failed');
  });

  test('the queue refuses an illegal state and a non-positive amount', async () => {
    await assert.rejects(
      db.owner.query("INSERT INTO li.job_queue (job_id, workspace_id, job_type, idempotency_key, payload, state) VALUES (gen_random_uuid(), $1, 'x', 'k', '{}', 'not-a-state')", [A]),
      /job_queue_state_valid/,
      'an illegal state is refused',
    );
    await assert.rejects(
      db.owner.query("INSERT INTO li.job_queue (job_id, workspace_id, job_type, idempotency_key, payload, state, job_class, max_attempts) VALUES (gen_random_uuid(), $1, 'x', 'k', '{}', 'queued', 'noop', 0)", [A]),
      /job_queue_max_attempts_valid/,
      'a retry limit below one is refused',
    );
    await assert.rejects(
      db.owner.query("INSERT INTO li.job_queue (job_id, workspace_id, job_type, idempotency_key, payload, state, job_class) VALUES (gen_random_uuid(), $1, 'x', 'k', '{}', 'queued', 'chargeable-unknown')", [A]),
      /job_queue_class_valid/,
      'an unknown job class is refused',
    );
  });
}
