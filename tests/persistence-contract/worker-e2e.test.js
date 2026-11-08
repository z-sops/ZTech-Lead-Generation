'use strict';

/**
 * The M4 P1 worker END-TO-END integration test.
 *
 * This test instantiates the ACTUAL Worker class with a REAL pg.Pool
 * connected as the ztech_worker role, against a disposable PostgreSQL
 * database with the full migration suite applied. It demonstrates the
 * complete lifecycle from queue to completion, proving that the
 * database-authorised pathways work end-to-end.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const { Worker } = require('../../packages/lead-intelligence-worker/src/worker');
const { IdentityProvider } = require('../../packages/lead-intelligence-worker/src/identity');
const { executeNoop } = require('../../packages/lead-intelligence-worker/src/noop');
const {
  freshDatabase, dropDatabase, roleUrl, ROLES,
} = require('./lib/postgres');

const A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const B = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';

if (!process.env.ZTECH_PG_URL) {
  test('[worker-e2e] the end-to-end worker suite (skipped: no PostgreSQL is configured)', { skip: 'set ZTECH_PG_URL' }, () => {});
} else {
  const DATABASE = 'ztech_worker_e2e';
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

  test.before(async () => {
    db = await freshDatabase(DATABASE, { workspace: A, workspaces: [A, B] });
  });

  test.beforeEach(async () => {
    await db.owner.query('TRUNCATE li.job_queue');
  });

  test.after(async () => {
    await Promise.all(pools.map((p) => p.end().catch(() => {})));
    if (db) await dropDatabase(DATABASE, [db.pool, db.owner, db.controlPool, db.platformPool, db.identityPool, db.admin]);
  });

  test('E2E: the Worker class claims, executes and completes a no-op job with real PostgreSQL', async () => {
    const workerId = 'worker-e2e-test';
    const identityToken = await identityCredential(workerId);

    const pool = workerPool();

    const config = {
      workerId,
      databaseUrl: roleUrl(ROLES.worker, DATABASE),
      identityToken,
      leaseSeconds: 120,
      heartbeatSeconds: 30,
      tokenTtlSeconds: 120,
      pollIntervalMs: 50,
      maxJobsPerRun: 1,
    };

    const identity = new IdentityProvider(config);
    const logger = { debug() {}, info() {}, warn() {}, error() {} };

    const jobId = await insertJob({ jobType: 'research', className: 'noop' });

    const worker = new Worker({
      pool,
      config,
      identity,
      logger,
      executor: executeNoop,
    });

    await worker.loop();

    const row = await db.owner.query(
      'SELECT job_id, state, result, fencing_token, lease_owner, lease_expires_at, attempt_count, last_error FROM li.job_queue WHERE job_id = $1',
      [jobId],
    );
    assert.equal(row.rows.length, 1, 'the job row exists');
    const job = row.rows[0];
    assert.equal(job.state, 'succeeded', 'the job state is succeeded');
    assert.ok(job.result, 'the result JSON is present');
    const result = typeof job.result === 'string' ? JSON.parse(job.result) : job.result;
    assert.equal(result.status, 'ok', 'the result status is ok');
    assert.equal(result.detail.executed, 'noop', 'the detail confirms no-op execution');
    assert.equal(Number(job.fencing_token), 1, 'the fencing token advanced to 1');
    assert.equal(job.lease_owner, null, 'the lease owner is cleared on completion');
    assert.equal(job.lease_expires_at, null, 'the lease expiry is cleared on completion');
    assert.equal(Number(job.attempt_count), 1, 'the attempt count is 1');
    assert.equal(job.last_error, null, 'no error is recorded');

    assert.equal(worker.processed, 1, 'the worker processed exactly one job');
    assert.equal(worker.running, false, 'the worker loop stopped');
    assert.equal(worker.stopping, false, 'the worker was not asked to stop');
  });

  test('E2E: multiple jobs in same workspace processed sequentially', async () => {
    const workerId = 'worker-e2e-multi-same-ws';
    const identityToken = await identityCredential(workerId);

    const pool = workerPool();

    const config = {
      workerId,
      databaseUrl: roleUrl(ROLES.worker, DATABASE),
      identityToken,
      leaseSeconds: 120,
      heartbeatSeconds: 30,
      tokenTtlSeconds: 120,
      pollIntervalMs: 50,
      maxJobsPerRun: 2,
    };

    const identity = new IdentityProvider(config);
    const logger = { debug() {}, info() {}, warn() {}, error() {} };

    const jobId1 = await insertJob({ jobType: 'research', className: 'noop' });
    const jobId2 = await insertJob({ jobType: 'research', className: 'noop', workspaceId: A });

    const worker = new Worker({
      pool,
      config,
      identity,
      logger,
      executor: executeNoop,
    });

    await worker.loop();

    const rows = await db.owner.query(
      'SELECT job_id, state FROM li.job_queue WHERE job_id IN ($1, $2) ORDER BY job_id',
      [jobId1, jobId2],
    );
    assert.equal(rows.rows.length, 2);
    for (const row of rows.rows) {
      assert.equal(row.state, 'succeeded', `job ${row.job_id} succeeded`);
    }
    assert.equal(worker.processed, 2, 'the worker processed both jobs');
  });

  test('E2E: worker claims and executes jobs from multiple workspaces end-to-end', async () => {
    const workerId = 'worker-e2e-crossws';
    const identityToken = await identityCredential(workerId);

    const pool = workerPool();

    const config = {
      workerId,
      databaseUrl: roleUrl(ROLES.worker, DATABASE),
      identityToken,
      leaseSeconds: 120,
      heartbeatSeconds: 30,
      tokenTtlSeconds: 120,
      pollIntervalMs: 50,
      maxJobsPerRun: 2,
    };

    const identity = new IdentityProvider(config);
    const logger = { debug() {}, info() {}, warn() {}, error() {} };

    const jobIdA = await insertJob({ jobType: 'research', className: 'noop', workspaceId: A });
    const jobIdB = await insertJob({ jobType: 'research', className: 'noop', workspaceId: B });

    const worker = new Worker({
      pool,
      config,
      identity,
      logger,
      executor: executeNoop,
    });

    await worker.loop();

    const rowA = await db.owner.query('SELECT state, result FROM li.job_queue WHERE job_id = $1', [jobIdA]);
    const rowB = await db.owner.query('SELECT state, result FROM li.job_queue WHERE job_id = $1', [jobIdB]);

    assert.equal(rowA.rows[0].state, 'succeeded', 'job in workspace A succeeded');
    assert.equal(rowB.rows[0].state, 'succeeded', 'job in workspace B succeeded');
    assert.equal(worker.processed, 2, 'the worker processed both jobs');

    const resultA = typeof rowA.rows[0].result === 'string' ? JSON.parse(rowA.rows[0].result) : rowA.rows[0].result;
    const resultB = typeof rowB.rows[0].result === 'string' ? JSON.parse(rowB.rows[0].result) : rowB.rows[0].result;
    assert.equal(resultA.status, 'ok');
    assert.equal(resultB.status, 'ok');
  });

  test('E2E: graceful shutdown stops claims and cancels in-flight job cooperatively', async () => {
    const workerId = 'worker-e2e-shutdown';
    const identityToken = await identityCredential(workerId);

    const pool = workerPool();

    const config = {
      workerId,
      databaseUrl: roleUrl(ROLES.worker, DATABASE),
      identityToken,
      leaseSeconds: 120,
      heartbeatSeconds: 30,
      tokenTtlSeconds: 120,
      pollIntervalMs: 50,
      maxJobsPerRun: 1,
    };

    const identity = new IdentityProvider(config);
    const logger = { debug() {}, info() {}, warn() {}, error() {} };

    const jobId = await insertJob({ jobType: 'research', className: 'noop' });

    let heartbeatCalls = 0;
    const originalHeartbeatOnce = Worker.prototype.heartbeatOnce;
    Worker.prototype.heartbeatOnce = async function(job) {
      heartbeatCalls += 1;
      return originalHeartbeatOnce.call(this, job);
    };

    const worker = new Worker({
      pool,
      config,
      identity,
      logger,
      executor: async (job) => {
        worker.stop();
        await new Promise((resolve) => setTimeout(resolve, 100));
        return executeNoop(job);
      },
    });

    await worker.loop();

    // The job is cancelled cooperatively when stop() is called during execution
    assert.equal(worker.processed, 0, 'the job was cancelled, not processed');
    const row = await db.owner.query('SELECT state FROM li.job_queue WHERE job_id = $1', [jobId]);
    assert.equal(row.rows[0].state, 'leased', 'the job remains leased (not completed)');
    assert.equal(worker.current, null, 'no job is current after completion');
    assert.equal(worker.heartbeat, null, 'heartbeat timer is cleared');
    assert.equal(worker._heartbeatPromise, null, 'no heartbeat promise is pending');
    assert.equal(worker.heartbeatInFlight, false, 'heartbeat in-flight flag is false');

    Worker.prototype.heartbeatOnce = originalHeartbeatOnce;
  });

  test('E2E: the worker refuses to start with a privileged role', async () => {
    const privilegedPool = new Pool({ connectionString: roleUrl(ROLES.migrator, DATABASE), options: '-c search_path=li' });
    pools.push(privilegedPool);

    const identityToken = await identityCredential('worker-e2e-badrole');

    const config = {
      workerId: 'worker-e2e-badrole',
      databaseUrl: roleUrl(ROLES.migrator, DATABASE),
      identityToken,
      leaseSeconds: 120,
      heartbeatSeconds: 30,
      tokenTtlSeconds: 120,
      pollIntervalMs: 50,
      maxJobsPerRun: 1,
    };

    const identity = new IdentityProvider(config);
    const logger = { debug() {}, info() {}, warn() {}, error() {} };

    const worker = new Worker({
      pool: privilegedPool,
      config,
      identity,
      logger,
      executor: executeNoop,
    });

    const identityCheck = await require('../../packages/lead-intelligence-worker/src/db').assertWorkerIdentity(privilegedPool);
    assert.equal(identityCheck.ok, false, 'the startup check rejects the migrator role');
    assert.ok(identityCheck.problems.some((p) => /never connect as ztech_migrator/i.test(p)), 'the rejection reason mentions the forbidden role');
  });

  test('E2E: a chargeable job is never claimed in P1', async () => {
    const workerId = 'worker-e2e-chargeable';
    const identityToken = await identityCredential(workerId);

    const pool = workerPool();

    const config = {
      workerId,
      databaseUrl: roleUrl(ROLES.worker, DATABASE),
      identityToken,
      leaseSeconds: 120,
      heartbeatSeconds: 30,
      tokenTtlSeconds: 120,
      pollIntervalMs: 50,
      maxJobsPerRun: 0,
    };

    const identity = new IdentityProvider(config);
    const logger = { debug() {}, info() {}, warn() {}, error() {} };

    const jobId = await insertJob({ jobType: 'research', className: 'chargeable' });

    const worker = new Worker({
      pool,
      config,
      identity,
      logger,
      executor: executeNoop,
    });

    // With maxJobsPerRun: 0, the worker runs indefinitely. We need to stop it after a short delay.
    const loopPromise = worker.loop();
    await new Promise((resolve) => setTimeout(resolve, 500));
    worker.stop();
    await loopPromise;

    const row = await db.owner.query('SELECT state FROM li.job_queue WHERE job_id = $1', [jobId]);
    assert.equal(row.rows[0].state, 'queued', 'the chargeable job remains queued');
    assert.equal(worker.processed, 0, 'the worker processed zero jobs');
  });
}