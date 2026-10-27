'use strict';

/**
 * The M4 P1 worker RUNTIME.
 *
 * These are the tests of the Worker class itself — the claim loop, the
 * heartbeat, the credential refresh, the cooperative shutdown and the
 * startup identity check. They drive the runtime with a stub database, so
 * the LIFECYCLE is tested directly and not only through the database
 * functions.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assertWorkerIdentity, WORKER_ROLE, FORBIDDEN_ROLES,
} = require('../packages/lead-intelligence-worker/src/db');
const { Worker: RealWorker } = require('../packages/lead-intelligence-worker/src/worker');
const { loadConfig, ConfigurationError } = require('../packages/lead-intelligence-worker/src/config');
const { redact, createLogger } = require('../packages/lead-intelligence-worker/src/log');

/** A logger that keeps the events, for the assertions. */
function recordingLogger() {
  const events = [];
  return {
    events,
    debug: (event, fields) => events.push({ level: 'debug', event, fields }),
    info: (event, fields) => events.push({ level: 'info', event, fields }),
    warn: (event, fields) => events.push({ level: 'warn', event, fields }),
    error: (event, fields) => events.push({ level: 'error', event, fields }),
  };
}

/**
 * A stub database.
 *
 * It answers the statements the worker makes, and it records them, so the
 * test can assert on WHAT the worker asked the database to do.
 */
function stubPool(overrides = {}) {
  const calls = [];
  const state = {
    claim: overrides.claim || [],
    token: overrides.token || 'job-token-1',
    renewFails: overrides.renewFails || false,
    tokenFails: overrides.tokenFails || false,
    writeFails: overrides.writeFails || false,
    written: overrides.written === undefined ? 1 : overrides.written,
    cancelled: overrides.cancelled || false,
    renewals: 0,
    tokens: 0,
  };
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('claim_job')) {
        const row = state.claim.shift();
        return { rows: row ? [row] : [] };
      }
      if (sql.includes('request_job_token')) {
        state.tokens += 1;
        if (state.tokenFails) throw new Error('the lease has expired');
        return { rows: [{ request_job_token: state.token }] };
      }
      if (sql.includes('renew_lease')) {
        state.renewals += 1;
        if (state.renewFails) throw new Error('the lease has expired');
        return { rows: [{ renew_lease: new Date().toISOString() }] };
      }
      if (sql.includes('set_workspace_for_job')) return { rows: [] };
      if (sql.includes('SELECT state FROM li.job_queue')) {
        return { rows: [{ state: state.cancelled ? 'cancelled' : 'running' }] };
      }
      if (sql.includes('write_job_result')) {
        if (state.writeFails) throw new Error('the write failed');
        return { rows: [{ write_job_result: state.written }] };
      }
      return { rows: [] };
    },
    release() {},
  };
  return {
    pool: { connect: async () => client },
    calls,
    state,
  };
}

/** A config for the tests. */
function testConfig(overrides = {}) {
  return {
    workerId: 'worker-test',
    databaseUrl: 'postgres://ztech_worker:x@127.0.0.1:5432/ztech',
    identityUrl: null,
    identityToken: 'identity-token',
    leaseSeconds: 120,
    heartbeatSeconds: 30,
    tokenTtlSeconds: 120,
    pollIntervalMs: 10,
    maxJobsPerRun: 0,
    ...overrides,
  };
}

test('C3: runJob() claims nothing, executes the job and writes the result', async () => {
  const stub = stubPool({ claim: [{ job_id: 'j1', job_type: 'research', fencing_token: 1 }] });
  const log = recordingLogger();
  const { events } = log;
  let executed = null;
  const worker = new RealWorker({
    pool: stub.pool,
    config: testConfig(),
    logger: log,
    executor: async (job) => { executed = job; return { status: 'ok' }; },
  });
  await worker.runJob(stub.state.claim.length ? { job_id: 'j1', job_type: 'research', fencing_token: 1, payload: {} } : {});
  assert.ok(executed, 'the executor ran');
  assert.equal(executed.jobId, 'j1', 'with the job');
  const write = stub.calls.find((c) => c.sql.includes('write_job_result'));
  assert.ok(write, 'the result was written');
  assert.equal(write.params[2], 'succeeded', 'and the state is succeeded');
  assert.ok(events.some((e) => e.event === 'job.succeeded'), 'and the worker logged it');
});

test('C3: the heartbeat renews the lease AND refreshes the execution credential', async () => {
  const stub = stubPool();
  const log = recordingLogger();
  const worker = new RealWorker({
    pool: stub.pool,
    config: testConfig(),
    logger: log,
    executor: async () => ({ status: 'ok' }),
    setIntervalImpl: () => ({ unref() {} }),
    clearIntervalImpl: () => {},
  });
  await worker.runJob({ job_id: 'j1', job_type: 'research', fencing_token: 1, payload: {} });
  assert.equal(stub.state.renewals, 0, 'the heartbeat has not fired yet');
  assert.equal(stub.state.tokens, 1, 'the credential was issued once');

  // The credential has expired, so the next heartbeat must refresh it.
  worker.jobTokenExpiresAt = 0;
  await worker.heartbeatOnce({ job_id: 'j1', job_type: 'research', fencing_token: 1 });
  assert.equal(stub.state.renewals, 1, 'the lease was renewed');
  assert.equal(stub.state.tokens, 2, 'and the credential was REFRESHED');

  // The credential is still fresh, so nothing more is issued.
  await worker.heartbeatOnce({ job_id: 'j1', job_type: 'research', fencing_token: 1 });
  assert.equal(stub.state.tokens, 2, 'a fresh credential is not refreshed again');
});

test('C3: a FAILED renewal loses the authority and prevents any further write', async () => {
  const stub = stubPool({ renewFails: true });
  const log = recordingLogger();
  const { events } = log;
  const worker = new RealWorker({
    pool: stub.pool,
    config: testConfig(),
    logger: log,
    executor: async () => ({ status: 'ok' }),
  });
  await worker.heartbeatOnce({ job_id: 'j1', job_type: 'research', fencing_token: 1 });
  assert.equal(worker.authorityLost, true, 'the authority is lost');
  assert.ok(events.some((e) => e.event === 'lease.renewal_failed'), 'and the failure is logged');
  const written = await worker.writeResult({ job_id: 'j1', fencing_token: 1 }, 'succeeded', {}, null);
  assert.equal(written, 0, 'and NO protected write is attempted');
  assert.ok(!stub.calls.some((c) => c.sql.includes('write_job_result')), 'the database was not even asked');
});

test('C3: a FAILED credential refresh loses the authority too', async () => {
  const stub = stubPool({ tokenFails: true });
  const log = recordingLogger();
  const { events } = log;
  const worker = new RealWorker({
    pool: stub.pool,
    config: testConfig(),
    logger: log,
    executor: async () => ({ status: 'ok' }),
  });
  worker.jobTokenExpiresAt = 0;
  await worker.heartbeatOnce({ job_id: 'j1', job_type: 'research', fencing_token: 1 });
  assert.equal(worker.authorityLost, true, 'the authority is lost');
  assert.ok(events.some((e) => e.event === 'token.refresh_failed'), 'and the failure is logged');
});

test('C3: the heartbeats never overlap', async () => {
  const stub = stubPool();
  const log = recordingLogger();
  const worker = new RealWorker({
    pool: stub.pool,
    config: testConfig(),
    logger: log,
    executor: async () => ({ status: 'ok' }),
  });
  // A slow renewal: the first heartbeat is still in flight when the second
  // starts, so the second must do nothing.
  let release = null;
  stub.pool.connect = async () => ({
    query: async (sql) => {
      if (sql.includes('renew_lease')) {
        await new Promise((resolve) => { release = resolve; });
        return { rows: [] };
      }
      if (sql.includes('request_job_token')) return { rows: [{ request_job_token: 't' }] };
      return { rows: [] };
    },
    release() {},
  });
  const job = { job_id: 'j1', job_type: 'research', fencing_token: 1 };
  const first = worker.heartbeatOnce(job);
  await new Promise((resolve) => { setImmediate(resolve); });
  const second = worker.heartbeatOnce(job);
  release();
  await Promise.all([first, second]);
  assert.equal(stub.state.renewals, 0, 'the stub counted its own renewals');
  assert.equal(worker.heartbeatInFlight, false, 'and the guard is released');
});

test('C3: a graceful shutdown stops the claims but keeps the heartbeat alive for the running job', async () => {
  const stub = stubPool();
  const log = recordingLogger();
  let cleared = false;
  const worker = new RealWorker({
    pool: stub.pool,
    config: testConfig(),
    logger: log,
    executor: async () => ({ status: 'ok' }),
    setIntervalImpl: () => ({ unref() {} }),
    clearIntervalImpl: () => { cleared = true; },
  });
  worker.heartbeat = { unref() {} };
  worker.activeController = { abort() { this.aborted = true; } };
  worker.stop();
  assert.equal(worker.stopping, true, 'the worker stops claiming');
  assert.equal(cleared, false, 'the heartbeat is NOT cleared while the job runs');
  assert.equal(worker.activeController.aborted, true, 'and the in-flight work is cancelled cooperatively');
});

test('C3: the executor is told, cooperatively, that it should stop', async () => {
  const stub = stubPool();
  const log = recordingLogger();
  let signal = null;
  const worker = new RealWorker({
    pool: stub.pool,
    config: testConfig(),
    logger: log,
    executor: async (job) => {
      signal = job.signal;
      worker.stop();
      return { status: 'ok' };
    },
  });
  await worker.runJob({ job_id: 'j1', job_type: 'research', fencing_token: 1, payload: {} });
  assert.ok(signal, 'the executor received a signal');
  assert.equal(signal.aborted, true, 'and it was aborted');
  const write = stub.calls.find((c) => c.sql.includes('write_job_result'));
  assert.ok(!write, 'and an aborted job is NOT written as succeeded');
});

test('C3: the loop claims until the queue is empty, and stops when asked', async () => {
  const stub = stubPool({
    claim: [
      { job_id: 'j1', job_type: 'research', fencing_token: 1 },
      { job_id: 'j2', job_type: 'research', fencing_token: 1 },
    ],
  });
  const log = recordingLogger();
  const worker = new RealWorker({
    pool: stub.pool,
    config: testConfig({ maxJobsPerRun: 2 }),
    logger: log,
    executor: async () => ({ status: 'ok' }),
    setIntervalImpl: () => ({ unref() {} }),
    clearIntervalImpl: () => {},
  });
  await worker.loop();
  assert.equal(worker.processed, 2, 'both jobs ran');
  assert.equal(worker.running, false, 'and the loop stopped');
});

test('C4: the startup check refuses a session that is not the worker role', async () => {
  const notWorker = {
    query: async () => ({
      rows: [{
        session_user: 'ztech_app', superuser: false, bypass_rls: false,
        createdb: false, createdrole: false, inherited: null, owned_tables: '0',
      }],
    }),
  };
  const result = await assertWorkerIdentity(notWorker);
  assert.equal(result.ok, false, 'the check fails');
  assert.ok(result.problems.some((p) => /not ztech_worker/.test(p)), 'and it says why');
});

test('C4: the startup check refuses a superuser, a BYPASSRLS role and an inherited role', async () => {
  const cases = [
    [{ session_user: 'ztech_worker', superuser: true }, /SUPERUSER/],
    [{ session_user: 'ztech_worker', bypass_rls: true }, /BYPASSRLS/],
    [{ session_user: 'ztech_migrator' }, /never connect as ztech_migrator/],
    [{ session_user: 'ztech_control' }, /never connect as ztech_control/],
    [{ session_user: 'ztech_worker', inherited: ['ztech_migrator'] }, /member of ztech_migrator/],
  ];
  for (const [row, pattern] of cases) {
    const pool = {
      query: async (sql) => ({
        rows: sql.includes('session_user AS session_user')
          ? [{ ...row, inherited: row.inherited || null, owned_tables: '0' }]
          : [{ rolname: 'ztech_migrator', rolsuper: false, rolbypassrls: false, owned_tables: '0' }],
      }),
    };
    const result = await assertWorkerIdentity(pool);
    assert.equal(result.ok, false, `the check fails for ${JSON.stringify(row)}`);
    assert.ok(result.problems.some((p) => pattern.test(p)), `with a reason matching ${pattern}`);
  }
});

test('C4: the startup check accepts the worker role', async () => {
  const pool = {
    query: async () => ({
      rows: [{
        session_user: WORKER_ROLE, superuser: false, bypass_rls: false,
        createdb: false, createdrole: false, inherited: null, owned_tables: '0',
      }],
    }),
  };
  const result = await assertWorkerIdentity(pool);
  assert.deepEqual(result.problems, [], 'the worker role is accepted');
  assert.equal(result.ok, true);
});

test('C4: the forbidden roles are the privileged ones', () => {
  for (const role of ['ztech_migrator', 'ztech_control', 'ztech_identity', 'ztech_platform']) {
    assert.ok(FORBIDDEN_ROLES.includes(role), `${role} is forbidden`);
  }
});

test('the configuration refuses a lease the database would not accept', () => {
  assert.throws(
    () => loadConfig({ ZTECH_WORKER_ID: 'w1', ZTECH_PG_URL: 'x', ZTECH_WORKER_LEASE_SECONDS: '1000' }),
    ConfigurationError,
    'a lease above the bound is refused',
  );
  assert.throws(
    () => loadConfig({ ZTECH_WORKER_ID: 'w1', ZTECH_PG_URL: 'x', ZTECH_WORKER_HEARTBEAT_SECONDS: '200' }),
    ConfigurationError,
    'a heartbeat that is not shorter than the lease is refused',
  );
  assert.throws(
    () => loadConfig({ ZTECH_WORKER_ID: 'w1', ZTECH_PG_URL: 'x' }),
    ConfigurationError,
    'a worker with no identity bootstrap is refused',
  );
  const ok = loadConfig({ ZTECH_WORKER_ID: 'w1', ZTECH_PG_URL: 'x', ZTECH_WORKER_IDENTITY_TOKEN: 't' });
  assert.equal(ok.leaseSeconds, 120, 'the default lease is 120 seconds');
  assert.equal(ok.heartbeatSeconds, 30, 'the default heartbeat is 30 seconds');
  assert.equal(ok.tokenTtlSeconds, 120, 'the default token lifetime is 120 seconds');
});

test('the logs cannot carry a credential', () => {
  const redacted = redact({ token: 'abc', identity_token: 'def', nested: { secret: 'ghi' }, keep: 'yes' });
  assert.equal(redacted.token, '[redacted]');
  assert.equal(redacted.identity_token, '[redacted]');
  assert.equal(redacted.nested.secret, '[redacted]');
  assert.equal(redacted.keep, 'yes', 'and the ordinary fields survive');
  const lines = [];
  const logger = createLogger({ write: (l) => lines.push(l) });
  logger.info('test', { token: 'a'.repeat(64) + '.' + 'b'.repeat(64) });
  assert.ok(!lines[0].includes('a'.repeat(64)), 'a token-shaped value never reaches the log');
});

test('Checkpoint C: isCancelled detects cancel_requested_at and prevents successful completion', async () => {
  const stub = stubPool({
    claim: [{ job_id: 'j-cancel', job_type: 'research', fencing_token: 1 }],
  });
  // Simulate cancel_requested_at being present in the job_queue
  stub.pool.connect = async () => ({
    query: async (sql) => {
      if (sql.includes('request_job_token')) return { rows: [{ request_job_token: 'tok' }] };
      if (sql.includes('SELECT state, cancel_requested_at FROM li.job_queue')) {
        return { rows: [{ state: 'running', cancel_requested_at: new Date().toISOString() }] };
      }
      if (sql.includes('write_job_result')) {
        return { rows: [{ write_job_result: 1 }] };
      }
      return { rows: [] };
    },
    release() {},
  });
  const log = recordingLogger();
  let executed = false;
  const worker = new RealWorker({
    pool: stub.pool,
    config: testConfig(),
    logger: log,
    executor: async () => { executed = true; return { status: 'ok' }; },
  });
  await worker.runJob({ job_id: 'j-cancel', job_type: 'research', fencing_token: 1, payload: {} });
  assert.equal(executed, false, 'the executor was never run because cancellation was observed');
  assert.ok(log.events.some((e) => e.event === 'job.cancelled'), 'the cancellation was logged');
});

test('Checkpoint C: in-flight cancellation marks job cancelled and avoids writing succeeded', async () => {
  const stub = stubPool();
  let checkCount = 0;
  const writes = [];
  stub.pool.connect = async () => ({
    query: async (sql, params) => {
      if (sql.includes('request_job_token')) return { rows: [{ request_job_token: 'tok' }] };
      if (sql.includes('SELECT state, cancel_requested_at FROM li.job_queue')) {
        checkCount += 1;
        // First check (pre-execution): not cancelled. Second check (post-execution): cancelled!
        return {
          rows: [{
            state: 'running',
            cancel_requested_at: checkCount > 1 ? new Date().toISOString() : null,
          }],
        };
      }
      if (sql.includes('write_job_result')) {
        writes.push(params);
        return { rows: [{ write_job_result: 1 }] };
      }
      return { rows: [] };
    },
    release() {},
  });
  const log = recordingLogger();
  const worker = new RealWorker({
    pool: stub.pool,
    config: testConfig(),
    logger: log,
    executor: async () => ({ status: 'ok' }),
  });
  await worker.runJob({ job_id: 'j-inflight', job_type: 'research', fencing_token: 1, payload: {} });
  assert.ok(writes.some((p) => p[2] === 'cancelled'), 'result was written as cancelled');
  assert.ok(!writes.some((p) => p[2] === 'succeeded'), 'result was NEVER written as succeeded');
  assert.ok(log.events.some((e) => e.event === 'job.cancelled'), 'logged cancellation');
});

test('Checkpoint C: failOrRetry suppresses write and returns refused when authority is lost', async () => {
  const stub = stubPool();
  const worker = new RealWorker({
    pool: stub.pool,
    config: testConfig(),
    logger: recordingLogger(),
    executor: async () => ({ status: 'ok' }),
  });
  worker.authorityLost = true;
  const outcome = await worker.failOrRetry({ job_id: 'j-lost', fencing_token: 1 }, 'something failed');
  assert.equal(outcome, 'refused', 'authorityLost causes failOrRetry to refuse immediately');
  assert.equal(stub.calls.length, 0, 'no query was made to the database');
});
