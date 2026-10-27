'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Worker } = require('../packages/lead-intelligence-worker/src/worker');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function job(id) {
  return { job_id: id, job_type: 'research', job_class: 'noop', fencing_token: 1, payload: {} };
}

function makePool(options = {}) {
  const queue = [...(options.jobs || [])];
  const writes = [];
  const issued = new Map();
  const client = {
    async query(sql, params = []) {
      if (sql.includes('claim_job')) return { rows: queue.length ? [queue.shift()] : [] };
      if (sql.includes('renew_lease')) {
        if (options.renew) await options.renew(params[0]);
        return { rows: [{ renew_lease: 'ok' }] };
      }
      if (sql.includes('request_job_token')) {
        const id = params[0];
        const index = (issued.get(id) || 0) + 1;
        issued.set(id, index);
        const token = options.token ? await options.token(id, index) : `token-${id}-${index}`;
        return { rows: [{ request_job_token: token }] };
      }
      if (sql.includes('SELECT state FROM li.job_queue')) return { rows: [{ state: 'running' }] };
      if (sql.includes('write_job_result')) {
        writes.push(params);
        return { rows: [{ write_job_result: 1 }] };
      }
      return { rows: [] };
    },
    release() {},
  };
  return { pool: { connect: async () => client }, writes, issued };
}

function createWorker(pool, executor, callbacks, configOverrides = {}) {
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  return new Worker({
    pool,
    config: {
      workerId: 'race-test', leaseSeconds: 120, heartbeatSeconds: 30,
      tokenTtlSeconds: 120, pollIntervalMs: 1, maxJobsPerRun: 2,
      ...configOverrides,
    },
    identity: { get: async () => 'test-identity' },
    logger,
    executor,
    setIntervalImpl: (callback) => {
      callbacks.push(callback);
      return { unref() {} };
    },
    clearIntervalImpl: () => {},
  });
}

async function turn() {
  await new Promise((resolve) => setImmediate(resolve));
}

test('R1: delayed failed renewal drains before the worker can claim job B', async () => {
  const aStarted = deferred();
  const aFinish = deferred();
  const renewEntered = deferred();
  const renewRelease = deferred();
  const a = job('A');
  const b = job('B');
  const { pool, writes } = makePool({
    jobs: [a, b],
    renew: async (id) => {
      if (id === 'A') {
        renewEntered.resolve();
        await renewRelease.promise;
      }
    },
  });
  const callbacks = [];
  let bExecuted = false;
  const worker = createWorker(pool, async ({ jobId }) => {
    if (jobId === 'A') {
      aStarted.resolve();
      await aFinish.promise;
    } else {
      bExecuted = true;
    }
    return { status: 'ok' };
  }, callbacks);

  const loop = worker.loop();
  await aStarted.promise;
  callbacks[0]();
  await renewEntered.promise;
  aFinish.resolve();
  await turn();
  assert.equal(worker.current.job_id, 'A', 'A remains active until renewal settles');
  assert.equal(bExecuted, false, 'B has not started during A cleanup');

  renewRelease.reject(new Error('lease rejected'));
  await loop;
  assert.equal(worker.stopping, true, 'renewal failure stops new claims');
  assert.equal(bExecuted, false, 'B never ran after A lost authority');
  assert.ok(writes.some((params) => params[0] === 'A'), 'A completion is recorded');
});

test('R2: pending credential refresh drains before job B begins', async () => {
  const aStarted = deferred();
  const aFinish = deferred();
  const refreshEntered = deferred();
  const refreshRelease = deferred();
  const a = job('A');
  const b = job('B');
  const { pool, writes } = makePool({
    jobs: [a, b],
    token: async (id, index) => {
      if (id === 'A' && index === 2) {
        refreshEntered.resolve();
        await refreshRelease.promise;
        return 'token-A-refreshed';
      }
      return `token-${id}-${index}`;
    },
  });
  const callbacks = [];
  let bExecuted = false;
  const worker = createWorker(pool, async ({ jobId }) => {
    if (jobId === 'A') {
      aStarted.resolve();
      await aFinish.promise;
    } else {
      bExecuted = true;
    }
    return { status: 'ok' };
  }, callbacks);

  const loop = worker.loop();
  await aStarted.promise;
  worker.jobTokenExpiresAt = 0;
  callbacks[0]();
  await refreshEntered.promise;
  aFinish.resolve();
  await turn();
  assert.equal(bExecuted, false, 'B waits for the old credential refresh');
  assert.equal(worker.current.job_id, 'A');

  refreshRelease.resolve();
  await loop;
  assert.equal(bExecuted, true, 'B runs after A refresh settles');
  assert.equal(worker.jobToken, 'token-B-1', 'B retains its own credential');
  assert.equal(worker.authorityLost, false, 'old refresh did not revoke B');
  assert.ok(writes.some((params) => params[0] === 'B' && params[2] === 'succeeded'));
});

test('R3: repeated heartbeat tick retains original pending Promise until drained', async () => {
  const aStarted = deferred();
  const aFinish = deferred();
  const renewEntered = deferred();
  const renewRelease = deferred();
  const a = job('A');
  const { pool } = makePool({
    renew: async (id) => {
      if (id === 'A') {
        renewEntered.resolve();
        await renewRelease.promise;
      }
    },
  });
  const callbacks = [];
  const worker = createWorker(pool, async () => {
    aStarted.resolve();
    await aFinish.promise;
    return { status: 'ok' };
  }, callbacks);
  const running = worker.runJob(a);
  await aStarted.promise;
  callbacks[0]();
  await renewEntered.promise;
  const original = worker._heartbeatPromise;
  assert.ok(original, 'actual outstanding operation is tracked');
  callbacks[0]();
  assert.strictEqual(worker._heartbeatPromise, original, 'second tick did not overwrite handle');
  aFinish.resolve();
  await turn();
  assert.equal(worker.current.job_id, 'A', 'cleanup still awaits original operation');
  renewRelease.resolve();
  await running;
  assert.equal(worker._heartbeatPromise, null, 'handle cleared only after settlement');
  assert.equal(worker.heartbeatInFlight, false);
  assert.equal(worker.current, null);
});
