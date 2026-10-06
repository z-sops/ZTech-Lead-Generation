'use strict';

// I4 - LIVE integration: the real supervisor launches the REAL OI service.
//
// Opt-in, because it needs the OI repo and its venv on this machine:
//   PowerShell:  $env:ZTECH_OI_TEST_FOLDER = 'G:\ZTech-Services\opportunity-intelligence'; node tests\i4-oi-live-integration.test.js
// Without ZTECH_OI_TEST_FOLDER every test is reported as skipped and passes.
//
// It proves, against the real Python process:
//   - the supervisor spawns OI, OI echoes the instance id, the state becomes running;
//   - OI refuses an API call without the token (401) and one with a foreign Host (421);
//   - the gateway's call (with the in-memory token) succeeds and OI reports which keys
//     it loaded - a stored key reaches OI's environment and nothing else does;
//   - shutdown leaves no process listening.
// No research is run, so no provider is contacted and no credit is spent.

const path = require('path');
const assert = require('assert');
const http = require('http');

const root = path.join(__dirname, '..');
const OP = path.join(root, 'src', 'main', 'lead-intelligence', 'opportunity');
const vault = require(path.join(root, 'src', 'main', 'credentialVault.js'));
const { OpportunityServiceSupervisor } = require(path.join(OP, 'OpportunityServiceSupervisor'));
const { OpportunityIntelligenceGateway } = require(path.join(OP, 'OpportunityIntelligenceGateway'));
const { createOiProviderConfig } = require(path.join(OP, 'oiProviderConfig'));

const FOLDER = process.env.ZTECH_OI_TEST_FOLDER || '';
let passed = 0;
let skipped = 0;
const failures = [];
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

function rawGet(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function makeStore(initial) {
  const data = JSON.parse(JSON.stringify(initial));
  const walk = (p, create) => {
    const parts = p.split('.');
    let o = data;
    for (const k of parts.slice(0, -1)) {
      if (o[k] === undefined || typeof o[k] !== 'object') { if (!create) return [null, null]; o[k] = {}; }
      o = o[k];
    }
    return [o, parts.at(-1)];
  };
  return {
    get(p) { const [o, k] = walk(p, false); return o ? o[k] : undefined; },
    set(p, v) { const [o, k] = walk(p, true); o[k] = JSON.parse(JSON.stringify(v)); },
    delete(p) { const [o, k] = walk(p, false); if (o) delete o[k]; },
  };
}

test('live: managed launch, token enforced by the real OI, stored key loaded, clean shutdown', async () => {
  const ss = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'dpapi',
    encryptString: (p) => Buffer.from('enc:' + p, 'utf8'),
    decryptString: (b) => b.toString('utf8').slice(4),
  };
  vault.setSafeStorageForTests(ss);
  const store = makeStore({ settings: { oi: { folder: FOLDER, mode: 'managed' } } });
  const providerConfig = createOiProviderConfig({ store, safeStorage: ss, logger: { warn() {} } });
  // A placeholder value: OI only records that a key is present. No research is run.
  providerConfig.setKey('brave', 'live-test-placeholder-not-a-real-key');
  const gateway = new OpportunityIntelligenceGateway({ config: { baseUrl: 'http://127.0.0.1:8099' }, logger: { warn() {} } });
  const lines = [];
  const supervisor = new OpportunityServiceSupervisor({
    gateway, providerConfig, store,
    logger: { info: (m) => lines.push(m), warn: (m) => lines.push(m) },
    options: { preferredPort: 0 }, // always a fresh free port: never collide with a dev OI on 8099
  });
  try {
    await supervisor.apply();
    assert.strictEqual(supervisor.state, 'running', `state ${supervisor.state}: ${supervisor.message}\n${supervisor.logText()}`);
    const port = supervisor.port;

    const health = await rawGet(port, '/v1/health');
    assert.strictEqual(health.status, 200);
    assert.strictEqual(JSON.parse(health.body).instance_id, supervisor.instanceId, 'OI echoes the instance id ZTech generated');

    assert.strictEqual((await rawGet(port, '/v1/engine')).status, 401, 'no token -> 401 from the real OI');
    assert.strictEqual((await rawGet(port, '/v1/engine', { authorization: 'Bearer wrong' })).status, 401);
    assert.strictEqual((await rawGet(port, '/v1/health', { host: 'evil.example' })).status, 421, 'foreign Host -> 421');

    const engine = await gateway.describeEngine();
    assert.strictEqual(engine.ok, true, engine.error);
    assert.strictEqual(engine.configuration.search, 'brave', 'the stored key reached OI');
    assert.strictEqual(engine.configuration.x_api, false, 'nothing that was not stored');

    const text = supervisor.logText();
    assert.ok(text.includes('local auth  required'), 'the launcher reports auth on');
    assert.ok(!text.includes('live-test-placeholder-not-a-real-key'));
    assert.ok(!text.includes(supervisor.token));

    await supervisor.shutdown();
    await new Promise((r) => setTimeout(r, 300));
    let refused = false;
    try { await rawGet(port, '/v1/health'); } catch { refused = true; }
    assert.ok(refused, 'nothing is listening after shutdown');
  } finally {
    await supervisor.shutdown();
    vault.setSafeStorageForTests(undefined);
  }
});

(async () => {
  for (const { name, fn } of queue) {
    if (!FOLDER) {
      skipped += 1;
      passed += 1;
      console.log('ok - ' + name + ' # SKIP set ZTECH_OI_TEST_FOLDER to run');
      continue;
    }
    try {
      await fn();
      passed += 1;
      console.log('ok - ' + name);
    } catch (err) {
      failures.push({ name, err });
      console.log('FAIL - ' + name + ': ' + err.message);
    }
  }
  for (const f of failures) console.error(f.err && f.err.stack);
  if (skipped) console.log(`(${skipped} live test(s) skipped)`);
  console.log(`${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
