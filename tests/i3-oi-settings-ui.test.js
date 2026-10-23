'use strict';

// I3/I4 - Opportunity Intelligence Settings UI.
//
// The real renderer block is lifted from renderer.js and executed against a DOM double.
// Its preload API is wired to the REAL main-process handlers (oi-config + oi-service)
// over the real oiProviderConfig, the real supervisor and the real gateway; only spawn,
// fetch, the folder check and the clock are doubles. After every interaction the whole
// DOM - text, input values, attributes, dataset - is scanned for the key.

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { EventEmitter } = require('events');

const root = path.join(__dirname, '..');
const OP = path.join(root, 'src', 'main', 'lead-intelligence', 'opportunity');
const vault = require(path.join(root, 'src', 'main', 'credentialVault.js'));
const { createOiProviderConfig } = require(path.join(OP, 'oiProviderConfig'));
const { registerOiConfigIpc, OI_CONFIG_CHANNELS } = require(path.join(OP, 'oi-config-ipc'));
const { registerOiServiceIpc, OI_SERVICE_CHANNELS } = require(path.join(OP, 'oi-service-ipc'));
const { OpportunityServiceSupervisor } = require(path.join(OP, 'OpportunityServiceSupervisor'));
const { OpportunityIntelligenceGateway } = require(path.join(OP, 'OpportunityIntelligenceGateway'));
const rendererSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'renderer.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');

let passed = 0;
const failures = [];
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

const START = '// === I3/I4 Opportunity Intelligence settings ===';
const END = '// === 保存采集结果到号码库 ===';
const block = rendererSource.slice(rendererSource.indexOf(START), rendererSource.indexOf(END));
const blockCode = block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

class FakeEl {
  constructor(doc, tag, id) {
    this.ownerDocument = doc;
    this.tagName = String(tag).toUpperCase();
    this.id = id || '';
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.dataset = {};
    this.listeners = {};
    this.className = '';
    this.disabled = false;
    this.type = '';
    this.value = '';
    this.placeholder = '';
    this.autocomplete = '';
    this.maxLength = -1;
    this._text = '';
  }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  set innerHTML(v) { throw new Error('innerHTML must not be used by the OI settings block'); }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  append(...cs) { cs.forEach((c) => this.appendChild(c)); }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  async fire(type) { for (const fn of this.listeners[type] || []) await fn({}); }
  descendants() { return this.children.flatMap((c) => [c, ...c.descendants()]); }
}

function makeDoc() {
  const doc = {
    registry: new Map(),
    activeElement: null,
    getElementById(id) {
      if (this.registry.has(id)) return this.registry.get(id);
      for (const el of this.registry.values()) {
        const hit = el.descendants().find((d) => d.id === id);
        if (hit) return hit;
      }
      const el = new FakeEl(this, 'div', id);
      this.registry.set(id, el);
      return el;
    },
    createElement(tag) { return new FakeEl(this, tag); },
    all() { return [...this.registry.values()].flatMap((e) => [e, ...e.descendants()]); },
  };
  return doc;
}

function makeStore(initial = {}) {
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
    data,
    get(p) { const [o, k] = walk(p, false); return o ? o[k] : undefined; },
    set(p, v) { const [o, k] = walk(p, true); o[k] = JSON.parse(JSON.stringify(v)); },
    delete(p) { const [o, k] = walk(p, false); if (o) delete o[k]; },
  };
}

const FOLDER = '/srv/ZTech-Services/opportunity-intelligence';
const KEY = 'BSA-ui-test-SECRET-0123456789';

function mainSide({ store = makeStore(), folder = FOLDER } = {}) {
  const ss = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'dpapi', encryptString: (p) => Buffer.from('enc:' + p), decryptString: (b) => b.toString().slice(4) };
  vault.setSafeStorageForTests(ss);
  const providerConfig = createOiProviderConfig({ store, safeStorage: ss, logger: { warn() {} } });
  const children = [];
  const spawnImpl = (command, args, options) => {
    const c = new EventEmitter();
    c.pid = 9000 + children.length;
    c.stdout = new EventEmitter();
    c.stderr = new EventEmitter();
    c.kill = () => { c.killed = true; setImmediate(() => c.emit('exit', null)); };
    c.options = options;
    children.push(c);
    return c;
  };
  const fetchImpl = async (url, init = {}) => {
    const c = children.at(-1);
    const alive = c && !c.killed;
    if (!alive) throw new Error('ECONNREFUSED');
    if (url.endsWith('/v1/health')) return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ status: 'ok', schema_version: '1.0', instance_id: c.options.env.ZTECH_OI_INSTANCE_ID }) };
    const conf = { search: c.options.env.BRAVE_API_KEY ? 'brave' : null, llm: { configured: false }, meta_ad_library: { configured: false }, x_api: false, google_ads_transparency_via_serpapi: false };
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ engine: 'ztech-opportunity-intelligence', schema_version: '1.0', providers: [], configuration: conf }) };
  };
  const gateway = new OpportunityIntelligenceGateway({ config: { baseUrl: 'http://127.0.0.1:8099' }, fetchImpl, logger: { warn() {} } });
  const fsImpl = { existsSync: () => true, readFileSync: () => 'name = "ztech-opportunity-intelligence"' };
  const supervisor = new OpportunityServiceSupervisor({
    gateway, providerConfig, store, spawnImpl, fetchImpl, findPort: async () => 8099, killTreeImpl() {},
    platform: 'linux', baseEnv: { PATH: '/usr/bin' }, fsImpl, logger: { info() {}, warn() {} },
    options: { configDebounceMs: 0, readyPollMs: 1 },
  });
  const handlers = {};
  const ipcMain = { handle: (ch, fn) => { handlers[ch] = fn; } };
  let clipboard = null;
  registerOiConfigIpc({ ipcMain, config: providerConfig, isTrustedSender: () => true, serviceView: () => supervisor.healthView(), reported: () => supervisor.reportedConfiguration(), logger: { warn() {} } });
  registerOiServiceIpc({ ipcMain, supervisor, isTrustedSender: () => true, pickFolder: async () => folder, copyText: (t) => { clipboard = t; }, logger: { warn() {} } });
  const sent = [];
  const inv = (ch, payload) => { sent.push({ ch, payload }); return handlers[ch]({}, payload); };
  // Exactly the preload surface.
  const api = {
    status: () => inv(OI_CONFIG_CHANNELS.STATUS, {}),
    setKey: (provider, key) => inv(OI_CONFIG_CHANNELS.SET_KEY, { provider, key }),
    clearKey: (provider) => inv(OI_CONFIG_CHANNELS.CLEAR_KEY, { provider }),
    setSetting: (name, value) => inv(OI_CONFIG_CHANNELS.SET_SETTING, { name, value }),
    chooseFolder: () => inv(OI_SERVICE_CHANNELS.CHOOSE_FOLDER, {}),
    setMode: (mode) => inv(OI_SERVICE_CHANNELS.SET_MODE, { mode }),
    start: () => inv(OI_SERVICE_CHANNELS.START, {}),
    stop: () => inv(OI_SERVICE_CHANNELS.STOP, {}),
    restart: () => inv(OI_SERVICE_CHANNELS.RESTART, {}),
    copyLog: () => inv(OI_SERVICE_CHANNELS.COPY_LOG, {}),
  };
  return { api, store, supervisor, children, sent, get clipboard() { return clipboard; } };
}

function makeUi(api) {
  const doc = makeDoc();
  const toasts = [];
  for (const id of ['btn-oi-choose-folder', 'btn-oi-start', 'btn-oi-stop', 'btn-oi-restart', 'btn-oi-copy-log', 'btn-oi-save-settings', 'oi-service-mode']) doc.getElementById(id);
  const timers = [];
  const ui = new Function('document', 'window', 'safeAsync', 'toast', 'setTimeout', 'clearTimeout',
    block + '\nreturn { loadOiSettings, saveOiKey, clearOiKey, saveOiSettings };')(
    doc, { ztechLeadIntel: api ? { opportunitySettings: api } : {} }, (fn) => fn, (m, t) => toasts.push({ m, t }),
    (fn) => { timers.push(fn); return timers.length; }, () => {});
  return { doc, ui, toasts, timers, el: (id) => doc.getElementById(id) };
}

function scanDom(doc, needles) {
  for (const el of doc.all()) {
    const parts = [el.textContent, el.value, el.placeholder, JSON.stringify(el.attributes), JSON.stringify(el.dataset)];
    for (const n of needles) for (const p of parts) assert.ok(!String(p).includes(n), `leaked into #${el.id || el.tagName}: ${n.slice(0, 8)}`);
  }
}

const settle = () => new Promise((r) => setTimeout(r, 30));

test('1. the block builds six password rows with stored / loaded chips, never innerHTML', async () => {
  const m = mainSide();
  const u = makeUi(m.api);
  await u.ui.loadOiSettings();
  for (const id of ['brave', 'serper', 'serpapi', 'meta', 'x', 'llm']) {
    const input = u.el(`oi-key-${id}`);
    assert.strictEqual(input.tagName, 'INPUT');
    assert.strictEqual(input.type, 'password');
    assert.strictEqual(input.autocomplete, 'off');
    assert.strictEqual(u.el(`oi-key-state-${id}`).textContent, 'Not set');
  }
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(blockCode));
  assert.strictEqual(u.el('oi-service-state').textContent, 'Not set up');
  assert.strictEqual(u.el('oi-service-folder').textContent, 'No OI folder chosen.');
});

test('2. Save sends the key once, empties the field, and the key never appears anywhere in the DOM', async () => {
  const m = mainSide();
  const u = makeUi(m.api);
  await u.ui.loadOiSettings();
  u.el('oi-key-brave').value = '  ' + KEY + '  ';
  await u.ui.saveOiKey('brave');
  assert.deepStrictEqual(m.sent.filter((s) => s.ch === OI_CONFIG_CHANNELS.SET_KEY).map((s) => s.payload), [{ provider: 'brave', key: KEY }]);
  assert.strictEqual(u.el('oi-key-brave').value, '');
  assert.strictEqual(u.el('oi-key-state-brave').textContent, 'Stored');
  assert.strictEqual(u.el('oi-key-clear-brave').disabled, false);
  scanDom(u.doc, [KEY]);
  for (const s of m.sent.filter((x) => x.ch === OI_CONFIG_CHANNELS.STATUS)) assert.ok(!JSON.stringify(s).includes(KEY));
});

test('3. a refused key is reported, the field is still emptied, nothing is stored', async () => {
  const m = mainSide();
  const u = makeUi(m.api);
  await u.ui.loadOiSettings();
  u.el('oi-key-x').value = 'has a space in it';
  await u.ui.saveOiKey('x');
  assert.strictEqual(u.el('oi-key-x').value, '');
  assert.strictEqual(u.el('oi-key-state-x').textContent, 'Not set');
  assert.ok(u.toasts.some((t) => t.t === 'error' && /spaces/.test(t.m)));
});

test('4. choosing a folder starts the managed service; state, basename and loaded chips follow', async () => {
  const m = mainSide();
  const u = makeUi(m.api);
  await u.ui.loadOiSettings();
  u.el('oi-key-brave').value = KEY;
  await u.ui.saveOiKey('brave');
  await u.el('btn-oi-choose-folder').fire('click');
  await settle();
  await u.ui.loadOiSettings();
  assert.strictEqual(u.el('oi-service-state').textContent, 'Running');
  assert.strictEqual(u.el('oi-service-folder').textContent, 'Folder: opportunity-intelligence');
  assert.strictEqual(u.el('oi-key-loaded-brave').textContent, 'Loaded by OI');
  assert.strictEqual(u.el('oi-key-loaded-serper').textContent, 'Not loaded');
  assert.strictEqual(u.el('btn-oi-stop').disabled, false);
  assert.strictEqual(u.el('btn-oi-start').disabled, true);
  assert.strictEqual(m.children.at(-1).options.env.BRAVE_API_KEY, KEY, 'the key reached the managed child');
  scanDom(u.doc, [KEY, FOLDER, '8099', '127.0.0.1', m.children.at(-1).options.env.ZTECH_OI_AUTH_TOKEN]);
});

test('5. Stop, Start, mode switch to external and Copy log', async () => {
  const m = mainSide({ store: makeStore({ settings: { oi: { folder: FOLDER } } }) });
  await m.supervisor.apply();
  const u = makeUi(m.api);
  await u.el('btn-oi-stop').fire('click');
  assert.strictEqual(u.el('oi-service-state').textContent, 'Stopped');
  assert.strictEqual(u.el('btn-oi-start').disabled, false);
  await u.el('btn-oi-start').fire('click');
  await settle();
  await u.ui.loadOiSettings();
  assert.strictEqual(u.el('oi-service-state').textContent, 'Running');
  m.children.at(-1).stdout.emit('data', 'uvicorn up\n');
  await u.el('btn-oi-copy-log').fire('click');
  assert.ok(m.clipboard.includes('uvicorn up'), 'the log went to the clipboard in main');
  assert.ok(!u.doc.all().some((e) => e.textContent.includes('uvicorn up')), 'the log text is not put on the page');
  u.el('oi-service-mode').value = 'external';
  await u.el('oi-service-mode').fire('change');
  assert.strictEqual(u.el('oi-service-state').textContent, 'External');
  assert.match(u.el('oi-keys-note').textContent, /NOT passed to an external/);
  assert.strictEqual(u.el('btn-oi-start').disabled, true, 'no service controls in external mode');
});

test('6. non-secret settings round-trip; invalid values are refused with the reason', async () => {
  const m = mainSide();
  const u = makeUi(m.api);
  await u.ui.loadOiSettings();
  u.el('oi-setting-meta_countries').value = 'pk, ae';
  u.el('oi-setting-llm_model').value = 'gpt-4o-mini';
  await u.ui.saveOiSettings();
  assert.strictEqual(u.el('oi-setting-meta_countries').value, 'PK,AE');
  assert.strictEqual(u.el('oi-setting-llm_model').value, 'gpt-4o-mini');
  u.el('oi-setting-llm_base_url').value = 'http://api.example.com';
  await u.ui.saveOiSettings();
  assert.ok(u.toasts.some((t) => /HTTPS/.test(t.m)));
});

test('7. no bridge (older preload / failed init) renders unavailable without throwing', async () => {
  const u = makeUi(null);
  await u.ui.loadOiSettings();
  assert.strictEqual(u.el('oi-service-state').textContent, 'Unavailable');
});

test('8. the block only uses the opportunitySettings bridge and holds no read-back path', () => {
  assert.ok(!/ztechLeadIntel\.(research|outreach|opportunity\b)/.test(blockCode));
  assert.ok(!/getKey|revealKey|readKey|\.value\s*=\s*[^'"]*key/i.test(blockCode.replace(/input\.value = '';/g, '')));
  assert.ok(!/setInterval/.test(blockCode), 'a bounded timeout chain, never an interval');
  assert.ok(/OI_POLL_MAX = 30/.test(blockCode));
});

test('9. markup: the group sits between Website research and Network, and is in the Settings index', () => {
  const s = htmlSource.slice(htmlSource.indexOf('id="view-settings"'));
  const iR = s.indexOf('id="settings-group-research"');
  const iO = s.indexOf('id="settings-group-intelligence"');
  const iN = s.indexOf('id="settings-group-network"');
  assert.ok(iR < iO && iO < iN);
  assert.ok(/data-settings-jump="intelligence">Opportunity Intelligence</.test(htmlSource));
  assert.ok(!/<input[^>]*id="oi-key-/.test(htmlSource), 'key inputs are built by the renderer, not hard-coded');
  for (const m of ['chooseFolder:', 'setMode:', 'start:', 'stop:', 'restart:', 'copyLog:']) assert.ok(preloadSource.includes(m), m);
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
