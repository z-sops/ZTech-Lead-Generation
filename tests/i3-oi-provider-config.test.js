'use strict';

// I3 - Opportunity Intelligence provider configuration.
//
// Executes the real oiProviderConfig + the real credentialVault (safeStorage stubbed)
// + the real registerOiConfigIpc handlers over a dot-path electron-store double.
// Every IPC response is deep-scanned: no key may ever come back.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const vault = require(path.join(root, 'src', 'main', 'credentialVault.js'));
const OP = path.join(root, 'src', 'main', 'lead-intelligence', 'opportunity');
const cfgMod = require(path.join(OP, 'oiProviderConfig'));
const { OI_CONFIG_CHANNELS, registerOiConfigIpc } = require(path.join(OP, 'oi-config-ipc'));
const { createOiProviderConfig, SECRET_IDS, reportedFromEngine } = cfgMod;
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');

let passed = 0;
const failures = [];
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

function safeStorage({ available = true, backend = 'dpapi' } = {}) {
  return {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptString: (p) => Buffer.from('enc:' + p, 'utf8'),
    decryptString: (b) => {
      const t = b.toString('utf8');
      if (!t.startsWith('enc:')) throw new Error('bad');
      return t.slice(4);
    }
  };
}

// electron-store double with dot-path get/set/delete, like the real one.
function makeStore() {
  const data = {};
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
    data,
    get(p) { const [o, k] = walk(p, false); return o ? o[k] : undefined; },
    set(p, v) { const [o, k] = walk(p, true); o[k] = JSON.parse(JSON.stringify(v)); },
    delete(p) { const [o, k] = walk(p, false); if (o) delete o[k]; }
  };
}

function setup(opts = {}) {
  const ss = safeStorage(opts);
  vault.setSafeStorageForTests(ss);
  const store = makeStore();
  const config = createOiProviderConfig({ store, safeStorage: ss, logger: { warn() {} } });
  const handlers = {};
  registerOiConfigIpc({
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } },
    config,
    isTrustedSender: (e) => !(e && e.untrusted),
    serviceView: () => opts.serviceView || null,
    reported: () => opts.reported || null,
    logger: { warn() {} }
  });
  const call = (ch, payload, event = {}) => handlers[ch](event, payload);
  return { store, config, handlers, call };
}

const KEY = 'BSAxyzSECRET-0123456789abcdef';

function deepScan(value, needles) {
  const text = JSON.stringify(value);
  for (const n of needles) assert.ok(!text.includes(n), 'leaked: ' + n.slice(0, 6) + '…');
}

test('1. catalog is closed: six secrets and four non-secret settings, LinkedIn absent', () => {
  assert.deepStrictEqual([...SECRET_IDS].sort(), ['brave', 'llm', 'meta', 'serpapi', 'serper', 'x']);
  assert.deepStrictEqual([...cfgMod.SETTING_IDS].sort(), ['llm_base_url', 'llm_model', 'meta_countries', 'search_provider']);
  assert.deepStrictEqual(Object.values(cfgMod.OI_SECRET_PROVIDERS).map((p) => p.env).sort(),
    ['BRAVE_API_KEY', 'LLM_API_KEY', 'META_ACCESS_TOKEN', 'SERPAPI_API_KEY', 'SERPER_API_KEY', 'X_BEARER_TOKEN']);
  assert.ok(!SECRET_IDS.includes('linkedin'));
});

test('2. set-key seals into electron-store and never echoes the key', async () => {
  const { store, call } = setup();
  const res = await call(OI_CONFIG_CHANNELS.SET_KEY, { provider: 'brave', key: KEY });
  assert.deepStrictEqual(res, { ok: true, data: { ok: true, stored: true } });
  const sealed = store.get('oi.credentials.brave');
  assert.ok(typeof sealed === 'string' && sealed.startsWith('enc:v1:'), 'sealed at rest');
  assert.ok(!JSON.stringify(store.data).includes(KEY), 'no plaintext anywhere in the store');
});

test('3. status returns booleans only; reported comes from OI engine configuration', async () => {
  const { call } = setup({ reported: { search: 'brave', llm: { configured: false }, meta_ad_library: { configured: false }, x_api: false, google_ads_transparency_via_serpapi: false } });
  await call(OI_CONFIG_CHANNELS.SET_KEY, { provider: 'brave', key: KEY });
  const res = await call(OI_CONFIG_CHANNELS.STATUS, {});
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(res.data.providers.brave, { stored: true, readable: true, reported: true });
  assert.deepStrictEqual(res.data.providers.serper, { stored: false, readable: false, reported: false });
  assert.strictEqual(res.data.linkedin, 'unsupported');
  deepScan(res, [KEY]);
});

test('4. reported is null for every provider while OI has not answered', () => {
  const r = reportedFromEngine(null);
  for (const id of SECRET_IDS) assert.strictEqual(r[id], null);
});

test('5. clear-key removes the sealed value', async () => {
  const { store, call } = setup();
  await call(OI_CONFIG_CHANNELS.SET_KEY, { provider: 'meta', key: KEY });
  const res = await call(OI_CONFIG_CHANNELS.CLEAR_KEY, { provider: 'meta' });
  assert.deepStrictEqual(res.data, { ok: true, stored: false });
  assert.strictEqual(store.get('oi.credentials.meta'), undefined);
});

test('6. invalid keys and unknown providers are refused; nothing is stored', async () => {
  const { store, call } = setup();
  const bad = ['short', 'has space inside key', 'line\nbreak-key-123', 'tab\tkey-0123456', 'ctrl\u0001key-012345', '=startsWithEq-12345', 'x'.repeat(513)];
  for (const key of bad) {
    const res = await call(OI_CONFIG_CHANNELS.SET_KEY, { provider: 'brave', key });
    assert.strictEqual(res.ok, false, JSON.stringify(key).slice(0, 20));
    deepScan(res, [key.length > 6 ? key : '\u0000']);
  }
  for (const p of [{ provider: 'linkedin', key: KEY }, { provider: 'brave', key: KEY, extra: 1 }, { provider: 'brave' }, { key: KEY },
    { provider: 'brave', key: KEY, baseUrl: 'http://evil' }]) {
    const res = await call(OI_CONFIG_CHANNELS.SET_KEY, p);
    assert.strictEqual(res.ok, false, JSON.stringify(Object.keys(p)));
    deepScan(res, [KEY]);
  }
  assert.strictEqual(store.get('oi.credentials'), undefined);
});

test('7. no secure keystore -> refused, nothing stored (Windows DPAPI missing, Linux basic_text)', async () => {
  for (const opts of [{ available: false }, { backend: 'basic_text' }]) {
    const { store, call } = setup(opts);
    const res = await call(OI_CONFIG_CHANNELS.SET_KEY, { provider: 'x', key: KEY });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error.code, 'OI_KEYSTORE_UNAVAILABLE');
    assert.strictEqual(store.get('oi.credentials.x'), undefined);
  }
});

test('8. untrusted senders are refused on every channel', async () => {
  const { call } = setup();
  for (const ch of Object.values(OI_CONFIG_CHANNELS)) {
    const res = await call(ch, {}, { untrusted: true });
    assert.strictEqual(res.ok, false, ch);
    assert.strictEqual(res.error.code, 'FORBIDDEN');
  }
});

test('9. non-secret settings: validated, normalised, unset by default (no PK or any market assumed)', async () => {
  const { config, call } = setup();
  assert.deepStrictEqual(config.status().settings, { search_provider: '', meta_countries: '', llm_base_url: '', llm_model: '' });
  assert.deepStrictEqual(config.childEnv(), {}, 'an unconfigured product passes nothing; OI applies its own defaults');
  assert.strictEqual((await call(OI_CONFIG_CHANNELS.SET_SETTING, { name: 'meta_countries', value: ' pk, ae ,PK' })).data.value, 'PK,AE');
  assert.strictEqual((await call(OI_CONFIG_CHANNELS.SET_SETTING, { name: 'search_provider', value: 'serper' })).data.value, 'serper');
  assert.strictEqual((await call(OI_CONFIG_CHANNELS.SET_SETTING, { name: 'llm_base_url', value: 'https://api.example.com/v1/' })).data.value, 'https://api.example.com/v1');
  assert.strictEqual((await call(OI_CONFIG_CHANNELS.SET_SETTING, { name: 'llm_base_url', value: 'http://localhost:11434/v1' })).ok, true);
  for (const [name, value] of [['meta_countries', 'Pakistan'], ['search_provider', 'google'], ['llm_base_url', 'http://api.example.com'],
    ['llm_base_url', 'https://u:p@api.example.com'], ['llm_model', 'two words'], ['nope', 'x']]) {
    assert.strictEqual((await call(OI_CONFIG_CHANNELS.SET_SETTING, { name, value })).ok, false, name + '=' + value);
  }
  assert.strictEqual((await call(OI_CONFIG_CHANNELS.SET_SETTING, { name: 'meta_countries', value: '' })).data.value, '');
  assert.strictEqual(config.status().settings.meta_countries, '');
});

test('10. childEnv carries only what was configured, under OI\'s own variable names', async () => {
  const { config, call } = setup();
  await call(OI_CONFIG_CHANNELS.SET_KEY, { provider: 'brave', key: KEY });
  await call(OI_CONFIG_CHANNELS.SET_KEY, { provider: 'llm', key: KEY + 'L' });
  await call(OI_CONFIG_CHANNELS.SET_SETTING, { name: 'meta_countries', value: 'PK' });
  assert.deepStrictEqual(config.childEnv(), { BRAVE_API_KEY: KEY, LLM_API_KEY: KEY + 'L', META_AD_COUNTRIES: 'PK' });
  assert.deepStrictEqual(config.secretValues().sort(), [KEY, KEY + 'L'].sort());
});

test('11. an unreadable sealed key is reported readable:false and is not passed to OI', () => {
  const { store, config } = setup();
  store.set('oi.credentials.serpapi', 'enc:v1:' + Buffer.from('not-enc').toString('base64'));
  assert.deepStrictEqual(config.status().providers.serpapi, { stored: true, readable: false, reported: null });
  assert.deepStrictEqual(config.childEnv(), {});
});

test('12. every change notifies listeners (the supervisor restarts on this in managed mode)', async () => {
  const { config, call } = setup();
  const seen = [];
  config.onChange((w) => seen.push(w));
  await call(OI_CONFIG_CHANNELS.SET_KEY, { provider: 'brave', key: KEY });
  await call(OI_CONFIG_CHANNELS.CLEAR_KEY, { provider: 'brave' });
  await call(OI_CONFIG_CHANNELS.SET_SETTING, { name: 'llm_model', value: 'gpt-4o-mini' });
  await call(OI_CONFIG_CHANNELS.SET_KEY, { provider: 'brave', key: 'bad key' });
  assert.deepStrictEqual(seen.map((s) => s.kind), ['key', 'key', 'setting'], 'a refused save notifies nobody');
});

test('13. the module makes no network call and has no "test key" path', () => {
  const src = fs.readFileSync(path.join(OP, 'oiProviderConfig.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const banned of [/\bfetch\(/, /require\(['"]https?['"]\)/, /net\.request/, /testKey|test-key|testConnection/]) {
    assert.ok(!banned.test(src), String(banned));
  }
});

test('14. main.js registers the config channels outside the LI-runtime guard; preload exposes write-only methods', () => {
  const ready = mainSource.slice(mainSource.indexOf('app.whenReady().then('), mainSource.indexOf("app.on('before-quit'"));
  assert.ok(ready.includes('registerOiConfigIpcHandlers();'));
  const fn = mainSource.slice(mainSource.indexOf('function registerOiConfigIpcHandlers('), mainSource.indexOf('function registerOpportunityIntelIpcHandlers('));
  assert.ok(!/if \(!leadIntelRuntime\) return/.test(fn), 'Settings works even when the LI runtime did not start');
  const block = preloadSource.slice(preloadSource.indexOf('opportunitySettings:'), preloadSource.indexOf('}));', preloadSource.indexOf('opportunitySettings:')));
  for (const m of ['status:', 'setKey:', 'clearKey:', 'setSetting:']) assert.ok(block.includes(m), m);
  assert.ok(!/getKey|revealKey|readKey/.test(block), 'no read-back method exists');
});

(async () => {
  for (const { name, fn } of queue) {
    try {
      await fn();
      passed += 1;
      console.log('ok - ' + name);
    } catch (err) {
      failures.push({ name, err });
      console.log('FAIL - ' + name + ': ' + err.message);
    }
  }
  vault.setSafeStorageForTests(undefined);
  for (const f of failures) console.error(f.err && f.err.stack);
  console.log(`${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
