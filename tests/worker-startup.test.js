'use strict';

/**
 * The worker startup orchestrator (scripts/start-worker.js).
 *
 * These tests prove the startup FAILS CLOSED before any database connection
 * is made: a missing base URL, a missing worker credential, a missing worker
 * identity, or a missing control-plane credential each stop the worker before
 * it can claim a single job. The full claim/execute lifecycle is covered by
 * tests/persistence-contract/worker-e2e.test.js against real PostgreSQL.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('../scripts/start-worker');

const ENV_KEYS = [
  'ZTECH_PG_URL',
  'ZTECH_PG_PASSWORD_ZTECH_WORKER',
  'ZTECH_PG_PASSWORD_ZTECH_CONTROL',
  'ZTECH_WORKER_ID',
  'ZTECH_WORKER_IDENTITY_TOKEN',
  'ZTECH_WORKER_IDENTITY_URL',
];

function withEnv(env, fn) {
  const saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  Object.assign(process.env, env);
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    });
}

test('startup refuses to run without a base PostgreSQL URL', async () => {
  await withEnv({}, async () => {
    await assert.rejects(
      () => start(),
      /ZTECH_PG_URL is required/,
      'a missing base URL stops the worker before it connects',
    );
  });
});

test('startup refuses to run without a worker role credential', async () => {
  await withEnv({ ZTECH_PG_URL: 'postgres://ztech:ztech@127.0.0.1:5432/ztech' }, async () => {
    await assert.rejects(
      () => start(),
      /Missing worker credential: ZTECH_PG_PASSWORD_ZTECH_WORKER/,
      'a missing worker credential stops the worker',
    );
  });
});

test('startup refuses a malformed worker role credential', async () => {
  await withEnv({
    ZTECH_PG_URL: 'postgres://ztech:ztech@127.0.0.1:5432/ztech',
    ZTECH_PG_PASSWORD_ZTECH_WORKER: 'short',
  }, async () => {
    await assert.rejects(
      () => start(),
      /Malformed worker credential/,
      'a malformed worker credential stops the worker',
    );
  });
});

test('startup requires a worker identity when no identity token is supplied', async () => {
  await withEnv({
    ZTECH_PG_URL: 'postgres://ztech:ztech@127.0.0.1:5432/ztech',
    ZTECH_PG_PASSWORD_ZTECH_WORKER: 'a-worker-credential-2026',
  }, async () => {
    await assert.rejects(
      () => start(),
      /ZTECH_WORKER_ID is required/,
      'the worker identity is required to mint an identity credential',
    );
  });
});

test('startup requires the control-plane credential to mint an identity credential', async () => {
  await withEnv({
    ZTECH_PG_URL: 'postgres://ztech:ztech@127.0.0.1:5432/ztech',
    ZTECH_PG_PASSWORD_ZTECH_WORKER: 'a-worker-credential-2026',
    ZTECH_WORKER_ID: 'worker-startup-test',
  }, async () => {
    await assert.rejects(
      () => start(),
      /Missing control-plane credential/,
      'the control-plane credential is required to mint the identity credential',
    );
  });
});

test('a supplied identity token skips the control-plane minting path', async () => {
  // With a pre-minted identity token, the startup proceeds past credential
  // collection and identity minting and reaches the worker's main(), which
  // then fails on the (unreachable) database — proving the control-plane
  // credential was NOT required.
  await withEnv({
    ZTECH_PG_URL: 'postgres://ztech:ztech@127.0.0.1:5432/ztech',
    ZTECH_PG_PASSWORD_ZTECH_WORKER: 'a-worker-credential-2026',
    ZTECH_WORKER_ID: 'worker-startup-test',
    ZTECH_WORKER_IDENTITY_TOKEN: 'a-pre-minted-identity-token',
  }, async () => {
    await assert.rejects(
      () => start(),
      (err) => !/control-plane credential/.test(String(err.message)),
      'the control-plane credential is not required when a token is supplied',
    );
  });
});
