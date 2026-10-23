'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const vault = require(path.join(root, 'src', 'main', 'credentialVault.js'));

const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const rendererSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'renderer.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const vaultSource = fs.readFileSync(path.join(root, 'src', 'main', 'credentialVault.js'), 'utf8');

let passed = 0;
let failed = 0;
const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

function makeSafeStorage(options = {}) {
  return {
    isEncryptionAvailable: () => options.available !== false,
    encryptString: (plaintext) => {
      if (options.failEncrypt) throw new Error('injected encrypt failure');
      return Buffer.from('enc:' + plaintext, 'utf8');
    },
    decryptString: (buffer) => {
      const text = buffer.toString('utf8');
      if (options.failDecrypt || !text.startsWith('enc:')) throw new Error('injected decrypt failure');
      return text.slice(4);
    }
  };
}

function makeStore(initial) {
  const data = Object.assign({}, initial);
  const calls = [];
  return {
    data,
    calls,
    get: (key, fallback) => (Object.prototype.hasOwnProperty.call(data, key) ? data[key] : fallback),
    set: (key, value) => {
      data[key] = value;
      calls.push(key);
    }
  };
}

function extractRegion(source, startMarker, endMarker) {
  const s = source.indexOf(startMarker);
  assert.ok(s > -1, 'start marker present: ' + startMarker);
  const e = source.indexOf(endMarker, s + startMarker.length);
  assert.ok(e > s, 'end marker after start: ' + endMarker);
  return source.slice(s, e);
}

test('1. seal emits enc:v1: base64 payload and unseal roundtrips the plaintext', () => {
  vault.setSafeStorageForTests(makeSafeStorage());
  const sealed = vault.seal('my-secret-value');
  assert.ok(sealed.startsWith('enc:v1:'), 'sealed value carries the enc:v1: prefix');
  const payload = sealed.slice('enc:v1:'.length);
  assert.match(payload, /^[A-Za-z0-9+/]+={0,2}$/, 'payload is base64');
  assert.strictEqual(vault.unseal(sealed), 'my-secret-value', 'roundtrip yields the original plaintext');
  vault.setSafeStorageForTests(null);
});

test('2. isSealed only recognizes the enc:v1: prefix', () => {
  vault.setSafeStorageForTests(makeSafeStorage());
  assert.strictEqual(vault.SEALED_PREFIX, 'enc:v1:');
  assert.strictEqual(vault.isSealed(vault.seal('x')), true);
  assert.strictEqual(vault.isSealed('plaintext-key'), false);
  assert.strictEqual(vault.isSealed('enc:v2:AAAA'), false);
  assert.strictEqual(vault.isSealed(''), false);
  assert.strictEqual(vault.isSealed(null), false);
  vault.setSafeStorageForTests(null);
});

test('3. seal fails with a controlled error when encryption is unavailable', () => {
  vault.setSafeStorageForTests(makeSafeStorage({ available: false }));
  assert.strictEqual(vault.isAvailable(), false);
  assert.throws(() => vault.seal('value'), (err) => err.message === 'vault: encryption unavailable');
  assert.throws(() => vault.unseal('enc:v1:AAAA'), (err) => err.message === 'vault: encryption unavailable');
  vault.setSafeStorageForTests(null);
});

test('4. seal surfaces encrypt failures as controlled vault errors', () => {
  vault.setSafeStorageForTests(makeSafeStorage({ failEncrypt: true }));
  assert.throws(() => vault.seal('value'), (err) => err.message === 'vault: encryption failed');
  assert.throws(() => vault.seal(123), (err) => err.message === 'vault: plaintext must be a string');
  vault.setSafeStorageForTests(null);
});

test('5. unseal rejects non-sealed and malformed payloads before decrypting', () => {
  vault.setSafeStorageForTests(makeSafeStorage({ failDecrypt: true }));
  assert.throws(() => vault.unseal('plain'), (err) => err.message === 'vault: value is not sealed');
  assert.throws(() => vault.unseal('enc:v1:not base64!'), (err) => err.message === 'vault: sealed payload is malformed');
  assert.throws(() => vault.unseal('enc:v1:'), (err) => err.message === 'vault: sealed payload is malformed');
  assert.throws(() => vault.unseal('enc:v1:AAAA'), (err) => err.message === 'vault: decryption failed');
  vault.setSafeStorageForTests(null);
});

test('6. reveal passes through plaintext and empty strings, decrypts sealed values', () => {
  vault.setSafeStorageForTests(makeSafeStorage());
  assert.strictEqual(vault.reveal(''), '');
  assert.strictEqual(vault.reveal('legacy-plaintext-key'), 'legacy-plaintext-key');
  assert.strictEqual(vault.reveal(vault.seal('roundtrip')), 'roundtrip');
  vault.setSafeStorageForTests(null);
});

test('7. isPresent: empty false, plaintext true, sealed true, broken sealed conservative true', () => {
  vault.setSafeStorageForTests(makeSafeStorage());
  assert.strictEqual(vault.isPresent(''), false);
  assert.strictEqual(vault.isPresent(null), false);
  assert.strictEqual(vault.isPresent('plaintext'), true);
  assert.strictEqual(vault.isPresent(vault.seal('stored')), true);
  vault.setSafeStorageForTests(makeSafeStorage({ failDecrypt: true }));
  const broken = 'enc:v1:QUJD';
  assert.strictEqual(vault.isPresent(broken), true, 'undecryptable sealed blob still counts as present');
  vault.setSafeStorageForTests(null);
});

test('8. planCredentialUpdate implements set / keep / clear as three distinct actions', () => {
  vault.setSafeStorageForTests(makeSafeStorage());
  const setPlan = vault.planCredentialUpdate('old', { value: 'new-key' });
  assert.strictEqual(setPlan.action, 'set');
  assert.ok(setPlan.next.startsWith('enc:v1:'), 'set action seals the new value');
  assert.strictEqual(setPlan.plaintext, 'new-key');
  assert.strictEqual(vault.unseal(setPlan.next), 'new-key');
  const keepPlan = vault.planCredentialUpdate('enc:v1:OLD', { value: '' });
  assert.strictEqual(keepPlan.action, 'keep');
  assert.strictEqual(keepPlan.next, 'enc:v1:OLD', 'blank input never overwrites stored value');
  const keepMissing = vault.planCredentialUpdate('', {});
  assert.strictEqual(keepMissing.action, 'keep');
  assert.strictEqual(keepMissing.next, '');
  const clearPlan = vault.planCredentialUpdate('enc:v1:OLD', { clear: true, value: 'ignored' });
  assert.strictEqual(clearPlan.action, 'clear');
  assert.strictEqual(clearPlan.next, '', 'explicit clear wins over any typed value');
  vault.setSafeStorageForTests(null);
});

test('9. migration seals provider records, drops matched legacy plaintext, seals proxy, providers before settings', () => {
  vault.setSafeStorageForTests(makeSafeStorage());
  const store = makeStore({
    providers: { 'pid-1': { providerId: 'pid-1', credentials: { apiKey: 'plain-a', taskKey: 'plain-t' } } },
    settings: { apiKey: 'plain-a', taskKey: 'plain-t', proxyUrl: 'http://127.0.0.1:7890' }
  });
  const result = vault.migrateStoredCredentials(store, 'pid-1');
  assert.strictEqual(result.status, 'complete');
  assert.strictEqual(result.sealed, 3, 'two provider credentials plus proxyUrl sealed');
  assert.strictEqual(result.removed, 2, 'both matched legacy settings keys removed');
  assert.deepStrictEqual(store.calls, ['providers', 'settings'], 'providers written before settings');
  const creds = store.data.providers['pid-1'].credentials;
  assert.ok(creds.apiKey.startsWith('enc:v1:') && creds.taskKey.startsWith('enc:v1:'), 'provider credentials sealed');
  assert.strictEqual(vault.unseal(creds.apiKey), 'plain-a');
  assert.strictEqual(vault.unseal(creds.taskKey), 'plain-t');
  assert.strictEqual(store.data.settings.apiKey, undefined, 'legacy plaintext apiKey removed');
  assert.strictEqual(store.data.settings.taskKey, undefined, 'legacy plaintext taskKey removed');
  assert.ok(store.data.settings.proxyUrl.startsWith('enc:v1:'), 'proxyUrl sealed');
  assert.strictEqual(vault.unseal(store.data.settings.proxyUrl), 'http://127.0.0.1:7890');
  vault.setSafeStorageForTests(null);
});

test('10. migration is a true no-op on an empty store: complete with zero writes', () => {
  vault.setSafeStorageForTests(makeSafeStorage());
  const store = makeStore({});
  const before = JSON.stringify(store.data);
  const result = vault.migrateStoredCredentials(store, 'pid-1');
  assert.strictEqual(result.status, 'complete');
  assert.strictEqual(result.sealed, 0);
  assert.strictEqual(result.removed, 0);
  assert.deepStrictEqual(store.calls, [], 'no store writes when there is nothing to migrate');
  assert.strictEqual(JSON.stringify(store.data), before, 'store bytes unchanged');
  vault.setSafeStorageForTests(null);
});

test('11. already-sealed values are left byte-identical and never re-encrypted', () => {
  vault.setSafeStorageForTests(makeSafeStorage());
  const sealedKey = vault.seal('stored-key');
  const sealedProxy = vault.seal('http://127.0.0.1:7890');
  const store = makeStore({
    providers: { 'pid-1': { credentials: { apiKey: sealedKey, taskKey: '' } } },
    settings: { proxyUrl: sealedProxy }
  });
  const result = vault.migrateStoredCredentials(store, 'pid-1');
  assert.strictEqual(result.status, 'complete');
  assert.strictEqual(result.sealed, 0);
  assert.strictEqual(result.removed, 0);
  assert.deepStrictEqual(store.calls, [], 'sealed data must not be rewritten');
  assert.strictEqual(store.data.providers['pid-1'].credentials.apiKey, sealedKey, 'sealed key byte-identical');
  assert.strictEqual(store.data.settings.proxyUrl, sealedProxy, 'sealed proxy byte-identical');
  vault.setSafeStorageForTests(null);
});

test('12. migration defers byte-preserved when encryption is unavailable', () => {
  vault.setSafeStorageForTests(makeSafeStorage({ available: false }));
  const initial = {
    providers: { 'pid-1': { credentials: { apiKey: 'plain-a', taskKey: 'plain-t' } } },
    settings: { apiKey: 'plain-a', proxyUrl: 'http://127.0.0.1:7890' }
  };
  const store = makeStore(initial);
  const before = JSON.stringify(store.data);
  const result = vault.migrateStoredCredentials(store, 'pid-1');
  assert.strictEqual(result.status, 'deferred');
  assert.strictEqual(result.reason, 'encryption-unavailable');
  assert.deepStrictEqual(store.calls, [], 'deferred migration never writes');
  assert.strictEqual(JSON.stringify(store.data), before, 'plaintext byte-preserved for a later attempt');
  vault.setSafeStorageForTests(null);
});

test('13. migration reports a controlled failure for an invalid store', () => {
  vault.setSafeStorageForTests(makeSafeStorage());
  const result = vault.migrateStoredCredentials({}, 'pid-1');
  assert.strictEqual(result.status, 'failed');
  assert.strictEqual(result.reason, 'invalid-store');
  assert.strictEqual(result.sealed, 0);
  assert.strictEqual(result.removed, 0);
  assert.strictEqual(vault.migrateStoredCredentials(null, 'pid-1').reason, 'invalid-store');
  vault.setSafeStorageForTests(null);
});

test('14. migration preserves mismatched legacy plaintext instead of guessing (Rule F)', () => {
  vault.setSafeStorageForTests(makeSafeStorage());
  const store = makeStore({
    providers: { 'pid-1': { credentials: { apiKey: 'counterpart-differs', taskKey: 't2' } } },
    settings: { apiKey: 'legacy-only', taskKey: 't2' }
  });
  const result = vault.migrateStoredCredentials(store, 'pid-1');
  assert.strictEqual(result.status, 'complete');
  assert.strictEqual(result.sealed, 2, 'provider values still sealed');
  assert.strictEqual(result.removed, 1, 'only the matching key was removed');
  assert.strictEqual(store.data.settings.apiKey, 'legacy-only', 'mismatched plaintext byte-preserved');
  assert.strictEqual(store.data.settings.taskKey, undefined, 'matching plaintext removed');
  vault.setSafeStorageForTests(null);
});

test('15. migration seals a legacy key into an empty counterpart, then removes the plaintext copy', () => {
  vault.setSafeStorageForTests(makeSafeStorage());
  const store = makeStore({
    providers: { 'pid-1': { credentials: { apiKey: '', taskKey: '' } } },
    settings: { apiKey: 'only-copy' }
  });
  const result = vault.migrateStoredCredentials(store, 'pid-1');
  assert.strictEqual(result.status, 'complete');
  assert.strictEqual(result.sealed, 1);
  assert.strictEqual(result.removed, 1);
  const sealed = store.data.providers['pid-1'].credentials.apiKey;
  assert.ok(sealed.startsWith('enc:v1:'), 'counterpart now holds the sealed value');
  assert.strictEqual(vault.unseal(sealed), 'only-copy', 'no data lost during the move');
  assert.strictEqual(store.data.settings.apiKey, undefined, 'plaintext copy deleted only after verification');
  vault.setSafeStorageForTests(null);
});

test('16. static main: settings:save seals before any write, three-state credentials, exact proxy envelope', () => {
  const saveRegion = extractRegion(mainSource, "ipcMain.handle('settings:save'", "ipcMain.handle('settings:load'");
  assert.ok(saveRegion.includes('const proxyResult = await applyProxyConfiguration(nextSettings.proxyUrl);'), 'proxy applied from validated settings');
  assert.ok(saveRegion.includes('return { success: true, proxyApplied: proxyResult.applied };'), 'success envelope preserved');
  assert.ok(saveRegion.includes('providerManager.setCredentials(activeProviderId'), 'settings->credential persistence preserved');
  assert.ok(saveRegion.includes("store.set('settings', settingsRecord)"), 'writes the redacted settings record');
  assert.ok(!saveRegion.includes("store.set('settings', nextSettings)"), 'never writes raw validated payload');
  assert.ok(saveRegion.includes('credentialVault.planCredentialUpdate('), 'credential updates go through the planner');
  assert.ok((saveRegion.split('credentialVault.planCredentialUpdate(').length - 1) === 2, 'both credential fields planned');
  assert.ok(saveRegion.includes('clear: nextSettings.clearApiKey'), 'explicit clear flag honored for apiKey');
  assert.ok(saveRegion.includes('clear: nextSettings.clearTaskKey'), 'explicit clear flag honored for taskKey');
  assert.ok(saveRegion.includes('apiKey: plannedApiKey.next'), 'stored apiKey is the sealed/kept value, not input');
  assert.ok(saveRegion.includes('taskKey: plannedTaskKey.next'), 'stored taskKey is the sealed/kept value, not input');
  assert.ok(saveRegion.includes('proxySealed = nextSettings.proxyUrl ? credentialVault.seal(nextSettings.proxyUrl') , 'proxyUrl sealed at rest');
  assert.ok(saveRegion.includes('settingsRecord.proxyUrl = proxySealed;'), 'settings record stores the sealed proxy');
  const sealIdx = saveRegion.indexOf('credentialVault.seal(');
  const providersIdx = saveRegion.indexOf('persistProviderCredentials(store, activeProviderId');
  const settingsIdx = saveRegion.indexOf("store.set('settings', settingsRecord)");
  assert.ok(sealIdx > -1 && providersIdx > sealIdx, 'sealing happens before the providers write');
  assert.ok(settingsIdx > providersIdx, 'providers written before settings (crash-safe order)');
  const validateRegion = extractRegion(mainSource, 'function validateSettingsPayload', 'function validateSubmitShape');
  assert.ok(validateRegion.includes('clearApiKey: false, clearTaskKey: false'), 'clear flags default to false');
  assert.ok(validateRegion.includes("typeof value !== 'boolean'"), 'clear flags validated as booleans');
  assert.ok(validateRegion.includes('MAX_KEY_LENGTH'), 'plaintext-only length limit retained');
});

test('17. static main: settings:load returns presence flags and revealed proxy only', () => {
  const loadRegion = extractRegion(mainSource, "ipcMain.handle('settings:load'", '// 采集结果管理');
  // A8 extends the envelope with non-secret research settings plus a presence flag.
  // The Zuni-SEO key itself is never returned.
  assert.ok(loadRegion.includes('hasApiKey,'), 'provider presence flag retained');
  assert.ok(loadRegion.includes('hasTaskKey,'), 'task key presence flag retained');
  assert.ok(loadRegion.includes('proxyUrl,'), 'revealed proxy retained');
  assert.ok(loadRegion.includes('research: { ...researchSettings, hasApiKey: researchHasKey }'),
    'research settings exposed as baseUrl/transport plus a presence flag only');
  assert.ok(!loadRegion.includes('apiKey: researchService'), 'the Zuni-SEO key is never returned');
  assert.ok(!loadRegion.includes('getApiKey()'), 'the key is never read out for the renderer');
  assert.ok(loadRegion.includes('await researchService.keys.hasApiKey()'), 'presence is read, not the key');
  assert.ok(loadRegion.includes('credentialVault.reveal('), 'proxyUrl revealed in main');
  assert.ok(!loadRegion.includes('apiKey:'), 'no raw apiKey field returned');
  assert.ok(!loadRegion.includes('taskKey:'), 'no raw taskKey field returned');
  assert.ok(mainSource.includes('function canRevealCredential('), 'decrypt-failure aware presence helper exists');
  const canReveal = extractRegion(mainSource, 'function canRevealCredential', 'function initServices');
  assert.ok(canReveal.includes('logger.warn('), 'decrypt failures logged without values');
  assert.ok(!/api.?[Kk]ey\s*:\s*['"]/.test(canReveal), 'helper logs no credential material');
});

test('18. static main: test-connection useStored branch is vault-driven and provider-neutral', () => {
  const connRegion = extractRegion(mainSource, 'async function handleTestConnection', 'ipcMain.handle(');
  assert.ok(mainSource.indexOf('async function handleTestConnection') < mainSource.indexOf("ipcMain.handle('provider:test-connection'"), 'handler defined before registration');
  assert.ok(connRegion.includes('if (p.useStored === true) {'), 'useStored branch exists first');
  assert.ok(connRegion.includes('credentialVault.reveal('), 'stored values unsealed in main');
  assert.ok(connRegion.includes('adapter.testConnection({ apiKey, taskKey })'), 'provider interface unchanged');
  assert.ok(connRegion.includes('No stored credentials'), 'controlled missing-credentials message');
  assert.ok(connRegion.includes('Stored credentials could not be decrypted'), 'controlled decrypt-failure message');
  assert.ok(connRegion.includes('Invalid params: apiKey'), 'typed-key validation retained');
  assert.ok(!/coreclaw/i.test(connRegion), 'branch carries no provider-specific identity');
});

test('19. static main: startup migration + proxy unseal wired; vault performs no logging', () => {
  assert.ok(mainSource.includes("require('./src/main/credentialVault')"), 'vault required once');
  const initRegion = extractRegion(mainSource, 'function initServices()', 'function registerIpcHandlers()');
  assert.ok(initRegion.includes('credentialVault.migrateStoredCredentials(store, adapter.providerId)'), 'migration runs after legacy migration');
  assert.ok(initRegion.indexOf('migrateLegacySettingsToProviders') < initRegion.indexOf('credentialVault.migrateStoredCredentials'), 'legacy migration still runs first');
  assert.ok(initRegion.includes('credentialVault.reveal(raw)'), 'stored credentials revealed for the in-memory provider only');
  assert.ok(initRegion.includes('providerManager.setCredentials(adapter.providerId, plaintext)'), 'plaintext handed only to the provider manager');
  assert.ok(initRegion.includes('migration.status'), 'migration outcome logged by status');
  assert.ok(initRegion.includes("reason: migration.reason || 'unknown'"), 'deferred reason logged as status metadata');
  const startupRegion = extractRegion(mainSource, 'app.whenReady()', "app.on('window-all-closed'");
  assert.ok(startupRegion.includes('credentialVault.reveal(rawProxyUrl)'), 'stored proxy unsealed at startup');
  assert.ok(startupRegion.includes("logger.warn('proxy', 'stored proxy could not be decrypted');"), 'decrypt failure logged without the value');
  assert.ok(startupRegion.includes('applyProxyConfiguration(storedProxyUrl);'), 'startup proxy application unchanged');
  assert.ok(!/(logger|console)\s*\./.test(vaultSource), 'vault logs nothing (no logger/console)');
  assert.ok(!/coreclaw/i.test(vaultSource), 'vault contains no provider identity');
  assert.ok(!vaultSource.includes('require(') || vaultSource.includes("require('electron')"), 'vault requires only electron for safeStorage');
});

test('20. static renderer/preload/html: no plaintext echo, useStored fallbacks, explicit clear controls', () => {
  assert.ok(preloadSource.includes('testConnection: (apiKey, taskKey, providerId, useStored) => ipcRenderer.invoke(\'provider:test-connection\', { providerId, apiKey, taskKey, useStored })'), 'preload forwards useStored');
  assert.ok(!rendererSource.includes('settings.apiKey'), 'renderer never reads a raw apiKey');
  assert.ok(!rendererSource.includes('settings.taskKey'), 'renderer never reads a raw taskKey');
  assert.ok(rendererSource.includes('settings.hasApiKey'), 'presence flag drives gating');
  assert.ok(rendererSource.includes('settings.hasTaskKey'), 'presence flag drives gating');
  assert.strictEqual(rendererSource.split('testConnection(undefined, undefined, undefined, true)').length - 1, 2, 'both test buttons fall back to stored credentials');
  assert.ok(rendererSource.includes('clearApiKey: true'), 'clear button sends explicit apiKey clear');
  assert.ok(rendererSource.includes('clearTaskKey: true'), 'clear button sends explicit taskKey clear');
  assert.strictEqual(rendererSource.split('if (result && result.success === true) loadSettings();').length - 1, 3, 'successful saves reload to scrub plaintext inputs');
  assert.ok(rendererSource.includes("document.getElementById('btn-clear-apikey').disabled = !settings.hasApiKey;"), 'clear button gated on presence');
  assert.ok(rendererSource.includes("document.getElementById('btn-clear-taskkey').disabled = !settings.hasTaskKey;"), 'clear button gated on presence');
  assert.strictEqual(rendererSource.split('if (!settings.hasApiKey) return;').length - 1, 2, 'history/result guards use presence flags');
  assert.match(htmlSource, /<button[^>]*id="btn-clear-apikey"[^>]*\bdisabled\b/, 'API key clear button starts disabled');
  assert.match(htmlSource, /<button[^>]*id="btn-clear-taskkey"[^>]*\bdisabled\b/, 'task key clear button starts disabled');
});

console.log('RUNTIME-REQUIRED (not unit-testable without launching Electron):');
console.log('  - safeStorage.isEncryptionAvailable() on the target Windows host');
console.log('  - real DPAPI encryptString/decryptString roundtrip');
console.log('  - migration against a genuine userData config.json');
console.log('  - live settings:load / settings:save / clear-flag IPC flows');
console.log('  - live provider:test-connection with useStored=true');
console.log('  - collection authorization after credential migration');
console.log('  - encrypted proxyUrl applied at startup');
console.log('  - corrupted-credential behavior in the running app');
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
