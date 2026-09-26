'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const rendererSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'renderer.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const adapterSource = fs.readFileSync(path.join(root, 'src', 'main', 'providers', 'coreclawAdapter.js'), 'utf8');
const managerSource = fs.readFileSync(path.join(root, 'src', 'main', 'providers', 'providerManager.js'), 'utf8');
const contractSource = fs.readFileSync(path.join(root, 'src', 'main', 'providers', 'collectionProvider.js'), 'utf8');

let passed = 0;
let failed = 0;
const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

function count(src, needle) {
  return src.split(needle).length - 1;
}

function mainChannels(src) {
  return [...src.matchAll(/ipcMain\.handle\('([^']+)'/g)].map(m => m[1]);
}

function preloadChannels(src) {
  return [...src.matchAll(/invoke\('([^']+)'/g)].map(m => m[1]);
}

test('1. all legacy coreclaw:* main handlers removed', () => {
  assert.strictEqual(count(mainSource, "ipcMain.handle('coreclaw:"), 0, 'no coreclaw:* handlers remain');
  assert.strictEqual(count(mainSource, 'legacyProviderId'), 0, 'legacy alias variable fully removed');
  assert.strictEqual(count(mainSource, 'handleGetStore'), 0, 'store dispatch helper removed');
});

test('2. collection:store handler and preload APIs removed', () => {
  assert.strictEqual(count(mainSource, "ipcMain.handle('collection:store'"), 0, 'main handler removed');
  assert.strictEqual(count(preloadSource, "invoke('collection:store'"), 0, 'preload getStore removed');
  assert.strictEqual(count(preloadSource, 'getStore'), 0, 'no getStore symbol in preload');
});

test('3. provider.setCredentials preload API removed', () => {
  assert.strictEqual(count(preloadSource, "invoke('provider:set-credentials'"), 0, 'preload no longer exposes setCredentials');
  assert.ok(!/setCredentials\s*:/.test(preloadSource), 'no setCredentials key in preload object');
});

test('4. adapter.getStore removed, required interface methods intact', () => {
  assert.strictEqual(count(adapterSource, 'async getStore()'), 0, 'adapter getStore removed');
  const required = ['setCredentials', 'testConnection', 'submitCollection', 'getJobState', 'getJobResults', 'getJobHistory'];
  for (const method of required) {
    assert.ok(adapterSource.includes(`async ${method}(`) || adapterSource.includes(`${method}(`),
      'required method missing: ' + method);
  }
  assert.ok(adapterSource.includes('setCredentials(credentials)'), 'sync setCredentials definition present');
  assert.ok(contractSource.includes("'setCredentials'"), 'interface contract unchanged');
});

test('5. zero live renderer/html references to removed APIs', () => {
  assert.ok(!rendererSource.includes('appAPI.collection.getStore'), 'renderer does not call getStore');
  assert.ok(!rendererSource.includes('appAPI.provider.setCredentials'), 'renderer does not call setCredentials');
  assert.ok(!rendererSource.includes('coreclaw:'), 'renderer references no legacy channels');
  assert.ok(!htmlSource.includes('getStore') && !htmlSource.includes('coreclaw:'), 'html references none');
});

test('6. all 19 live main IPC channels present exactly once', () => {
  // B6.2 declared lock update: channel count 18 -> 19. The single addition is
  // collector:update-lead, the audited write path for the user-owned lead
  // fields (qualification/tags/notes), validated by validateLeadUpdatePayload
  // and delegated to accountStore.setLeadUserFields. No other channel moved.
  const expected = [
    'provider:set-credentials', 'provider:test-connection',
    'collection:submit', 'collection:job-status', 'collection:job-result', 'collection:job-history',
    'settings:save', 'settings:load',
    'collector:get-numbers', 'collector:add-numbers', 'collector:export-numbers',
    'collector:delete-numbers', 'collector:storage-status',
    'collector:get-jobs',
    'collector:update-lead',
    'logs:export', 'logs:dir', 'logs:report',
    'proxy:detect'
  ];
  const actual = mainChannels(mainSource);
  assert.deepStrictEqual(actual.slice().sort(), expected.slice().sort(), 'main channel set changed');
  for (const ch of expected) {
    assert.strictEqual(count(mainSource, `ipcMain.handle('${ch}'`), 1, 'channel must exist once: ' + ch);
  }
});

test('7. preload channel set matches main; only documented exception', () => {
  const main = new Set(mainChannels(mainSource));
  const preload = [...new Set(preloadChannels(preloadSource))];
  for (const ch of preload) {
    assert.ok(main.has(ch), 'preload channel missing in main: ' + ch);
  }
  const notExposed = [...main].filter(ch => !preload.includes(ch));
  assert.deepStrictEqual(notExposed, ['provider:set-credentials'],
    'only provider:set-credentials may remain unexposed (retained provider-neutral handler, out of removal scope)');
});

test('8. renderer still uses every exposed flow', () => {
  const rendererUses = [
    'appAPI.provider.testConnection',
    'appAPI.collection.submit', 'appAPI.collection.getStatus', 'appAPI.collection.getResult', 'appAPI.collection.getHistory',
    'appAPI.settings.save', 'appAPI.settings.load',
    'appAPI.proxy.detect',
    'appAPI.collector.getNumbers', 'appAPI.collector.addNumbers', 'appAPI.collector.exportNumbers',
    'appAPI.collector.deleteNumbers', 'appAPI.collector.storageStatus',
    'appAPI.collector.getJobs',
    'appAPI.collector.updateLead',
    'appAPI.logs.exportLogs'
  ];
  for (const use of rendererUses) {
    assert.ok(rendererSource.includes(use), 'renderer flow missing: ' + use);
  }
  assert.ok(rendererSource.includes('window.appAPI'), 'modern appAPI namespace in use');
});

test('9. provider architecture unchanged: registry + sole adapter, no ranking', () => {
  assert.ok(mainSource.includes('providerManager.register(new CoreClawAdapter())'), 'adapter registration preserved');
  assert.ok(mainSource.includes("this.providerId = 'coreclaw'") === false, 'providerId lives in adapter file');
  assert.ok(adapterSource.includes("this.providerId = 'coreclaw'"), 'providerId unchanged');
  assert.ok(mainSource.includes('providerManager.resolveCollectionProvider('), 'resolution still via registry');
  const providerFiles = managerSource + contractSource + adapterSource;
  assert.ok(!/priority|rank|failover|pricing|score|preferred/i.test(providerFiles), 'no ranking/priority/failover/pricing/score keywords');
  assert.ok(mainSource.includes('providerManager.setCredentials(activeProviderId'), 'settings->credential persistence preserved');
});

test('10. removed symbols absent repo-wide except out-of-scope client method', () => {
  const files = ['main.js', 'preload.js', 'src/renderer/renderer.js', 'index.html',
    'src/main/providers/coreclawAdapter.js', 'src/main/providers/providerManager.js'];
  for (const rel of files) {
    const src = fs.readFileSync(path.join(root, rel), 'utf8');
    assert.ok(!src.includes('legacyProviderId'), rel + ' must not reference legacyProviderId');
    assert.ok(!src.includes("ipcMain.handle('coreclaw:"), rel + ' must not register legacy channels');
  }
  const clientSource = fs.readFileSync(path.join(root, 'src', 'main', 'coreClawClient.js'), 'utf8');
  const clientGetStoreCallers = clientSource.split('this.client.getStore()').length - 1;
  assert.strictEqual(clientGetStoreCallers, 0, 'no callers of client.getStore remain (adapter removed)');
});

console.log('RUNTIME-REQUIRED (not unit-testable without launching Electron):');
console.log('  - full IPC surface exercised against a live main process');
console.log('');

for (const [name, fn] of tests) {
  try {
    fn();
    passed++;
    console.log('ok - ' + name);
  } catch (err) {
    failed++;
    console.log('FAIL - ' + name);
    console.log(String((err && err.stack) || err));
  }
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
