'use strict';

const path = require('path');
const assert = require('assert');

const loggerPath = require.resolve(path.join(__dirname, '..', 'src', 'main', 'logger.js'));
require.cache[loggerPath] = {
  id: loggerPath,
  filename: loggerPath,
  loaded: true,
  exports: {
    logger: {
      info() {},
      warn() {},
      error() {},
      ok() {},
      getLogDir() { return ''; },
      getLogFiles() { return []; },
      exportLogs() { return ''; }
    }
  }
};

const clientPath = path.join(__dirname, '..', 'src', 'main', 'coreClawClient.js');
const fs = require('fs');
const clientSource = fs.readFileSync(clientPath, 'utf8');
const { CoreClawClient } = require(clientPath);

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('ok - ' + name);
  } catch (err) {
    failures.push({ name, err });
    console.log('FAIL - ' + name + ': ' + err.message);
  }
}

const FAKE_KEY = 'sk-test-SECRET-do-not-leak';
let capturedTimeoutMs = null;
const realFetch = global.fetch;
const realTimeout = AbortSignal.timeout;

function jsonResponse(body, status, statusText) {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { 'content-type': 'application/json' }
  });
}

function textResponse(text, status, statusText) {
  return new Response(text, {
    status,
    statusText,
    headers: { 'content-type': 'text/plain' }
  });
}

global.fetch = async (url, opts) => {
  if (opts && opts.signal && opts.signal.aborted) {
    const err = new Error('The operation was aborted due to timeout');
    err.name = 'TimeoutError';
    throw err;
  }
  const u = String(url);
  if (opts && opts.headers && opts.headers.Authorization !== `Bearer ${FAKE_KEY}`) {
    throw new Error('authorization header contract changed');
  }
  if (u.includes('/ok200')) return jsonResponse({ code: 0, data: { run_slug: 'run-1' } }, 200, 'OK');
  if (u.includes('/err400')) return jsonResponse({ code: 400, message: 'bad request detail' }, 400, 'Bad Request');
  if (u.includes('/err401')) return jsonResponse({ message: 'unauthorized' }, 401, 'Unauthorized');
  if (u.includes('/err429')) return jsonResponse({ code: 429, message: 'rate limited' }, 429, 'Too Many Requests');
  if (u.includes('/err500text')) return textResponse('boom-internal-secret', 500, 'Internal Server Error');
  if (u.includes('/malformed')) return new Response('{not-json', { status: 200, headers: { 'content-type': 'application/json' } });
  if (u.includes('/apiterr200')) return jsonResponse({ code: 1, message: 'provider says no' }, 200, 'OK');
  throw new Error('unexpected url in test: ' + u);
};

function makeClient() {
  const client = new CoreClawClient();
  client.setApiKey(FAKE_KEY);
  return client;
}

async function run() {
  const client = makeClient();

  const ok = await client.request('GET', '/ok200');
  test('200 JSON success preserved', () => {
    assert.strictEqual(ok.success, true);
    assert.deepStrictEqual(ok.data, { run_slug: 'run-1' });
  });

  const r400 = await client.request('GET', '/err400');
  test('400 JSON error: provider message + code + status preserved', () => {
    assert.strictEqual(r400.success, false);
    assert.strictEqual(r400.error, 'bad request detail');
    assert.strictEqual(r400.httpStatus, 400);
    assert.strictEqual(r400.code, 400);
  });

  const r401 = await client.request('GET', '/err401');
  test('401 JSON error: provider message + status preserved', () => {
    assert.strictEqual(r401.success, false);
    assert.strictEqual(r401.error, 'unauthorized');
    assert.strictEqual(r401.httpStatus, 401);
    assert.ok(!('code' in r401), 'no code invented when body has none');
  });

  const r429 = await client.request('GET', '/err429');
  test('429 JSON error: provider message + code preserved', () => {
    assert.strictEqual(r429.success, false);
    assert.strictEqual(r429.error, 'rate limited');
    assert.strictEqual(r429.httpStatus, 429);
    assert.strictEqual(r429.code, 429);
  });

  const r500 = await client.request('GET', '/err500text');
  test('500 non-JSON: controlled HTTP error, body not exposed', () => {
    assert.strictEqual(r500.success, false);
    assert.ok(/^HTTP 500/.test(r500.error), 'expected HTTP 500 prefix, got: ' + r500.error);
    assert.strictEqual(r500.httpStatus, 500);
    assert.ok(!String(r500.error).includes('boom-internal-secret'), 'raw body must not leak');
  });

  const malformed = await client.request('GET', '/malformed');
  test('malformed JSON on 200: controlled error, fragment not leaked', () => {
    assert.strictEqual(malformed.success, false);
    assert.strictEqual(malformed.error, '响应不是有效的 JSON');
    assert.strictEqual(malformed.httpStatus, 200);
    assert.ok(!String(malformed.error).includes('not-json'), 'raw fragment must not leak');
  });

  const apiErr = await client.request('GET', '/apiterr200');
  test('200 JSON API-level error (code!==0) behavior preserved', () => {
    assert.strictEqual(apiErr.success, false);
    assert.strictEqual(apiErr.error, 'provider says no');
    assert.deepStrictEqual(apiErr.raw, { code: 1, message: 'provider says no' });
  });

  AbortSignal.timeout = (ms) => {
    capturedTimeoutMs = ms;
    return AbortSignal.abort();
  };
  const timedOut = await client.request('GET', '/ok200');
  AbortSignal.timeout = realTimeout;
  test('timeout remains 30 seconds', () => {
    assert.strictEqual(capturedTimeoutMs, 30000);
    assert.ok(clientSource.includes('REQUEST_TIMEOUT_MS = 30000'), 'source must keep 30000 ms constant');
    assert.ok(clientSource.includes('AbortSignal.timeout(REQUEST_TIMEOUT_MS)'), 'timeout wiring preserved');
    assert.strictEqual(timedOut.success, false);
  });

  const noKey = new CoreClawClient();
  const noKeyRes = await noKey.request('GET', '/ok200');
  test('missing API key behavior preserved', () => {
    assert.strictEqual(noKeyRes.success, false);
    assert.strictEqual(noKeyRes.error, '未设置 API Key');
  });

  test('no secrets in any returned error', () => {
    for (const res of [ok, r400, r401, r429, r500, malformed, apiErr, timedOut, noKeyRes]) {
      assert.ok(!JSON.stringify(res).includes(FAKE_KEY), 'API key leaked into result');
    }
  });

  test('response.ok is checked before success handling', () => {
    assert.ok(clientSource.includes('if (!response.ok)'), 'response.ok guard present');
    assert.ok(clientSource.indexOf('if (!response.ok)') < clientSource.indexOf("error: '响应不是有效的 JSON'"), 'ok check precedes success-path handling');
  });

  console.log('');
  console.log(passed + ' passed, ' + failures.length + ' failed');
  global.fetch = realFetch;
  AbortSignal.timeout = realTimeout;
  if (failures.length) process.exit(1);
}

run().catch(err => {
  console.error('SUITE ERROR: ' + err.stack);
  global.fetch = realFetch;
  AbortSignal.timeout = realTimeout;
  process.exit(1);
});
