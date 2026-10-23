'use strict';

// Research-service lifecycle regression.
//
// A8 recreates the research service when the Zuni-SEO base URL changes. The
// prospect-research:* handlers are registered ONCE (Electron refuses a
// second ipcMain.handle for a channel), so they must reach the CURRENT service
// on every call - not the instance that existed when they were registered.
//
// The bug this pins: the handlers captured researchService.gateway/.keys at
// registration. After a recreate, set-api-key wrote the key through the closed
// original service while settings:load asked the replacement, whose credential
// source had already cached "no key" - so research.hasApiKey read false until
// restart.
//
// The main.js lifecycle code (recreateResearchService, the handler registration
// and the settings:load handler) is lifted verbatim and run against the REAL
// registerResearchIpc and the REAL ZuniSeoCredentialSource (both instances share
// one secrets directory, exactly as in the app). Only Electron, the gateway and
// the settings store are doubles. No network.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const researchDir = path.join(root, 'src', 'main', 'prospect-research');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const ipcSource = fs.readFileSync(path.join(researchDir, 'research-ipc.js'), 'utf8');
const { registerResearchIpc, ALL_CHANNELS, CHANNELS } = require(path.join(researchDir, 'research-ipc.js'));
const { ZuniSeoCredentialSource, setSafeStorageForTests } = require(path.join(researchDir, 'credential-source.js'));
const credentialVault = require(path.join(root, 'src', 'main', 'credentialVault.js'));

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from !== -1 && to !== -1, 'slice markers found: ' + start);
  return source.slice(from, to);
}

// From recreateResearchService through the end of registerResearchIpcHandlers.
function lifecycleRegion() {
  const start = mainSource.indexOf('async function recreateResearchService()');
  const reg = mainSource.indexOf('function registerResearchIpcHandlers()');
  assert.ok(start !== -1 && reg > start, 'lifecycle functions located');
  const end = mainSource.indexOf('\n}', reg);
  return mainSource.slice(start, end + 2);
}

const SETTINGS_LOAD = between(mainSource, "ipcMain.handle('settings:load'", '// 采集结果管理');
const KEY = 'zsk_lifecycle_regression_key_0123456789';
const TRUSTED = { trusted: true };
const UNTRUSTED = { trusted: false };

const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'gnome_libsecret',
  encryptString: (plain) => Buffer.from('enc:' + plain, 'utf8'),
  decryptString: (buf) => buf.toString('utf8').slice(4)
};

function makeHarness() {
  const secretsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ztech-lifecycle-'));
  const handlers = {};
  const registrations = [];
  const ipcMain = {
    handle(channel, fn) {
      registrations.push(channel);
      if (handlers[channel]) throw new Error(`Attempted to register a second handler for '${channel}'`);
      handlers[channel] = fn;
    }
  };
  const services = [];
  const trustedSenderCalls = [];
  const logs = [];

  function makeService() {
    const n = services.length + 1;
    const calls = [];
    const credentials = new ZuniSeoCredentialSource({ secretsDir });
    const keys = {};
    for (const method of ['getApiKey', 'setApiKey', 'clearApiKey', 'hasApiKey']) {
      keys[method] = (...args) => { calls.push('keys.' + method); return credentials[method](...args); };
    }
    let releaseClose = null;
    const service = {
      n,
      calls,
      closed: false,
      holdClose: false,
      keys,
      gateway: {
        get providerHealth() { calls.push('gateway.providerHealth'); return { state: 'not_checked', service: n }; },
        start: async () => { calls.push('gateway.start'); },
        requestResearch: async (req) => { calls.push('gateway.requestResearch'); return { leadRef: req.leadRef, service: n }; },
        getResearch: async (ref) => { calls.push('gateway.getResearch'); return { leadRef: ref, availability: 'not_checked', service: n }; },
        importArtifact: async () => { calls.push('gateway.importArtifact'); return null; },
        credentialsChanged: async () => { calls.push('gateway.credentialsChanged'); return { state: 'ready' }; }
      },
      quarantine: { prune: async () => {} },
      close() {
        calls.push('close');
        service.closed = true;
        if (!service.holdClose) return Promise.resolve();
        return new Promise((resolve) => { releaseClose = resolve; });
      },
      release() { if (releaseClose) releaseClose(); }
    };
    services.push(service);
    return service;
  }

  class FakeStore {
    get(key, fallback) {
      return key === 'settings' ? { research: { baseUrl: 'https://research.lifecycle.test/', transport: 'rest' } } : fallback;
    }
  }

  const sandboxRequire = (id) => {
    if (id === 'electron-store') return FakeStore;
    throw new Error('unexpected require in the lifted code: ' + id);
  };

  const prospectResearch = {
    readResearchSettings: (raw) => ({ baseUrl: raw.baseUrl, transport: raw.transport })
  };

  const body = [
    'let researchService = null;',
    'let researchTrustedSender = null;',
    'function initResearch() { researchService = makeService(); }',
    'function startResearch() { if (researchService) researchService.gateway.start(); }',
    lifecycleRegion(),
    SETTINGS_LOAD,
    'return { initResearch, recreateResearchService, registerResearchIpcHandlers, current: () => researchService };'
  ].join('\n');

  const factory = new Function(
    'ipcMain', 'require', 'makeService', 'createTrustedSender', 'registerResearchIpc', 'RESEARCH_CHANNELS',
    'logger', 'isDev', 'path', '__dirname', 'process', 'mainWindow', 'dialog', 'accountStore',
    'prospectResearch', 'providerManager', 'loadProviderCredentials', 'canRevealCredential', 'credentialVault',
    body
  );
  const main = factory(
    ipcMain, sandboxRequire, makeService,
    (getWindow, options) => {
      trustedSenderCalls.push(options);
      return (event) => Boolean(event) && event.trusted === true;
    },
    registerResearchIpc, ALL_CHANNELS,
    { info: (...a) => logs.push(['info', ...a]), warn: (...a) => logs.push(['warn', ...a]), error: (...a) => logs.push(['error', ...a]) },
    false, path, root, { env: {} }, null, null,
    {
      queryNumbers: async ({ id }) => ({ rows: [{ id, title: 'Lifecycle Lead', website: 'https://lead.lifecycle.test/' }] }),
      getCollectedNumbers: async () => [{ id: 'lead-2', title: 'Lifecycle Lead', phone: '+1 555 0100', website: 'https://lead.lifecycle.test/' }]
    },
    prospectResearch,
    { resolveCollectionProvider: () => ({ providerId: 'provider-under-test' }) },
    () => null, () => false,
    { reveal: (value) => value }
  );
  const invoke = (channel, event, ...args) => handlers[channel](event, ...args);
  const settingsLoad = () => handlers['settings:load']({});
  return { main, services, handlers, registrations, invoke, settingsLoad, trustedSenderCalls, logs };
}

let passed = 0;
let failed = 0;
const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

test('1. set-api-key after a recreate is visible to settings:load from the CURRENT service', async () => {
  const h = makeHarness();
  h.main.initResearch();
  h.main.registerResearchIpcHandlers();
  const original = h.main.current();

  // Use the initial service through the existing handlers.
  assert.deepStrictEqual(await h.invoke(CHANNELS.keyStatus, TRUSTED), { configured: false });
  assert.strictEqual((await h.invoke(CHANNELS.get, TRUSTED, 'lead-1')).service, 1, 'served by the initial service');
  assert.strictEqual((await h.settingsLoad()).research.hasApiKey, false);

  // The base URL changed: A8 recreates the service.
  await h.main.recreateResearchService();
  const replacement = h.main.current();
  assert.notStrictEqual(replacement, original, 'a new service instance is current');
  assert.strictEqual(original.closed, true, 'the original service was closed');

  // The renderer reloads settings right after the save, before it writes the key.
  assert.strictEqual((await h.settingsLoad()).research.hasApiKey, false, 'no key yet');

  // Save the key through the existing handler.
  const set = await h.invoke(CHANNELS.setApiKey, TRUSTED, KEY);
  assert.deepStrictEqual(set, { configured: true, provider: 'ready' }, 'the envelope is unchanged');

  const load = await h.settingsLoad();
  assert.strictEqual(load.research.hasApiKey, true, 'settings:load reports the key from the current service');
  assert.deepStrictEqual(Object.keys(load), ['hasApiKey', 'hasTaskKey', 'proxyUrl', 'research'], 'settings:load envelope unchanged');
  assert.deepStrictEqual(await h.invoke(CHANNELS.keyStatus, TRUSTED), { configured: true }, 'key-status agrees');
  assert.ok(!JSON.stringify(load).includes(KEY) && !JSON.stringify(set).includes(KEY), 'the key never comes back');
});

test('2. the original service is no longer the source of truth after a recreate', async () => {
  const h = makeHarness();
  h.main.initResearch();
  h.main.registerResearchIpcHandlers();
  const original = h.main.current();
  await h.invoke(CHANNELS.keyStatus, TRUSTED);
  await h.main.recreateResearchService();
  const replacement = h.main.current();
  const before = original.calls.length;

  await h.invoke(CHANNELS.setApiKey, TRUSTED, KEY);
  await h.invoke(CHANNELS.keyStatus, TRUSTED);
  await h.invoke(CHANNELS.get, TRUSTED, 'lead-2');
  await h.invoke(CHANNELS.request, TRUSTED, 'lead-2', false);
  await h.invoke(CHANNELS.list, TRUSTED);
  await h.invoke(CHANNELS.providerHealth, TRUSTED);
  await h.invoke(CHANNELS.clearApiKey, TRUSTED);

  assert.deepStrictEqual(original.calls.slice(before), [], 'nothing reaches the closed original service');
  for (const call of ['keys.setApiKey', 'gateway.credentialsChanged', 'keys.hasApiKey', 'gateway.getResearch', 'gateway.requestResearch', 'gateway.providerHealth', 'keys.clearApiKey']) {
    assert.ok(replacement.calls.includes(call), 'current service handled ' + call);
  }
  assert.strictEqual((await h.settingsLoad()).research.hasApiKey, false, 'clear went through the current service too');
});

test('3. a second recreate keeps following the current service', async () => {
  const h = makeHarness();
  h.main.initResearch();
  h.main.registerResearchIpcHandlers();
  await h.main.recreateResearchService();
  await h.main.recreateResearchService();
  assert.strictEqual(h.services.length, 3);
  assert.strictEqual((await h.invoke(CHANNELS.get, TRUSTED, 'lead-3')).service, 3, 'served by the third instance');
  await h.invoke(CHANNELS.setApiKey, TRUSTED, KEY);
  assert.strictEqual((await h.settingsLoad()).research.hasApiKey, true);
  assert.ok(!h.services[0].calls.includes('keys.setApiKey') && !h.services[1].calls.includes('keys.setApiKey'), 'earlier instances untouched');
});

test('4. the research channels are registered exactly once and never re-registered', async () => {
  const h = makeHarness();
  h.main.initResearch();
  h.main.registerResearchIpcHandlers();
  await h.main.recreateResearchService();
  const research = h.registrations.filter((c) => c.startsWith('prospect-research:'));
  // The existing set, unchanged: seven A-series channels plus the F7 read-only list.
  assert.deepStrictEqual(research, [
    'prospect-research:request', 'prospect-research:get', 'prospect-research:list',
    'prospect-research:import-artifact', 'prospect-research:provider-health',
    'prospect-research:set-api-key', 'prospect-research:clear-api-key', 'prospect-research:key-status'
  ], 'the same channels, once each, in the same order');
  assert.deepStrictEqual(research, ALL_CHANNELS, 'exactly the module channel list');
});

test('5. while the service is being replaced, handlers refuse instead of using the closing one', async () => {
  const h = makeHarness();
  h.main.initResearch();
  h.main.registerResearchIpcHandlers();
  const original = h.main.current();
  original.holdClose = true;
  const pending = h.main.recreateResearchService();
  assert.strictEqual(h.main.current(), null, 'mid-recreate there is no current service');
  const before = original.calls.length;
  await assert.rejects(() => h.invoke(CHANNELS.setApiKey, TRUSTED, KEY), /research service is not available/i);
  await assert.rejects(() => h.invoke(CHANNELS.keyStatus, TRUSTED), /research service is not available/i);
  assert.deepStrictEqual(original.calls.slice(before), [], 'the closing service is not used');
  original.release();
  await pending;
  assert.deepStrictEqual(await h.invoke(CHANNELS.keyStatus, TRUSTED), { configured: false }, 'works again once replaced');
});

test('6. the trusted-sender check still guards every channel, before any service access', async () => {
  const h = makeHarness();
  h.main.initResearch();
  h.main.registerResearchIpcHandlers();
  await h.main.recreateResearchService();
  const current = h.main.current();
  const before = current.calls.length;
  for (const channel of ALL_CHANNELS) {
    await assert.rejects(() => h.invoke(channel, UNTRUSTED, KEY), /Untrusted sender\./, channel + ' rejects an untrusted sender');
  }
  assert.deepStrictEqual(current.calls.slice(before), [], 'an untrusted call never touches the service');
  assert.strictEqual(h.trustedSenderCalls.length, 1, 'one trusted-sender predicate, built once');
  const opts = h.trustedSenderCalls[0];
  assert.strictEqual(opts.isDev, false);
  assert.strictEqual(opts.indexPath, path.join(root, 'index.html'), 'the production index path is unchanged');
  assert.strictEqual(typeof opts.onReject, 'function');
  // Statically: main still hands registerResearchIpc the createTrustedSender predicate,
  // and research-ipc.js still runs it first.
  const reg = between(mainSource, 'function registerResearchIpcHandlers()', 'logger.info(\'research\', `registered');
  assert.ok(reg.includes('researchTrustedSender = createTrustedSender(() => mainWindow, {'), 'predicate built by createTrustedSender');
  assert.ok(reg.includes('isTrustedSender: researchTrustedSender,'), 'and passed to registerResearchIpc');
  assert.ok(ipcSource.includes('trusted = d.isTrustedSender(event) === true;'), 'the guard is unchanged');
  assert.ok(ipcSource.includes("throw new Error('Untrusted sender.');"), 'the refusal is unchanged');
});

(async () => {
  setSafeStorageForTests(fakeSafeStorage);
  credentialVault.setSafeStorageForTests(fakeSafeStorage);
  try {
    for (const [name, fn] of tests) {
      try {
        await fn();
        passed++;
        console.log('ok - ' + name);
      } catch (err) {
        failed++;
        console.log('FAIL - ' + name);
        console.log(String((err && err.stack) || err));
      }
    }
  } finally {
    setSafeStorageForTests(null);
    credentialVault.setSafeStorageForTests(null);
  }
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
