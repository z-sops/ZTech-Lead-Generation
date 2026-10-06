'use strict';

// F26 - Outreach Settings UI (Business profile, Email, WhatsApp).
//
// The real renderer block is lifted from renderer.js and executed against a DOM double.
// Its preload API is wired to the REAL main-process handlers (outreach-settings-ipc over
// the real outreachSettings, the real F22-F25 readers and the real credentialVault);
// only safeStorage, fetch and the clock are doubles. After every interaction the whole
// DOM - text, input values, attributes, dataset - is scanned for keys and raw provider
// fields.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const OUT = path.join(root, 'src', 'main', 'lead-intelligence', 'outreach');
const vault = require(path.join(root, 'src', 'main', 'credentialVault.js'));
const { createOutreachSettings } = require(path.join(OUT, 'outreachSettings'));
const { registerOutreachSettingsIpc, OUTREACH_SETTINGS_CHANNELS: CH } = require(path.join(OUT, 'outreach-settings-ipc'));
const rendererSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'renderer.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

let passed = 0;
const failures = [];
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

const START = '// === F26 Outreach settings ===';
const END = '// === I3/I4 Opportunity Intelligence settings ===';
const block = rendererSource.slice(rendererSource.indexOf(START), rendererSource.indexOf(END));
const blockCode = block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const groupHtml = (name) => {
  const start = htmlSource.indexOf(`id="settings-group-${name}"`);
  return htmlSource.slice(start, htmlSource.indexOf('</section>', start));
};

class FakeEl {
  constructor(doc, tag, id) {
    this.ownerDocument = doc;
    this.tagName = String(tag).toUpperCase();
    this.id = id || '';
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.listeners = {};
    this.disabled = false;
    this.checked = false;
    this.value = '';
    this._text = '';
  }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  set innerHTML(v) { throw new Error('innerHTML must not be used by the F26 settings block'); }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  async fire(type) { for (const fn of this.listeners[type] || []) await fn({}); }
}

function makeDoc() {
  return {
    registry: new Map(),
    activeElement: null,
    getElementById(id) {
      if (!this.registry.has(id)) this.registry.set(id, new FakeEl(this, 'div', id));
      return this.registry.get(id);
    },
    createElement(tag) { return new FakeEl(this, tag); },
    all() { return [...this.registry.values()]; },
  };
}

function makeStore() {
  const data = {};
  const walk = (p, create) => {
    const parts = p.split('.');
    let o = data;
    for (const k of parts.slice(0, -1)) {
      if (o[k] === undefined || typeof o[k] !== 'object' || o[k] === null) { if (!create) return [null, null]; o[k] = {}; }
      o = o[k];
    }
    return [o, parts.at(-1)];
  };
  return {
    data,
    get(p, d) { const [o, k] = walk(p, false); return o && o[k] !== undefined ? o[k] : d; },
    set(p, v) { const [o, k] = walk(p, true); o[k] = JSON.parse(JSON.stringify(v)); },
    delete(p) { const [o, k] = walk(p, false); if (o) delete o[k]; },
  };
}

const RKEY = 're_ui_test_SECRET_0123456789';
const MKEY = 'EAAG_ui_test_SECRET_0123456789';
const RAW = ['d_raw_77', 'SECRET-DKIM', 'us-east-1', 'Secret Biz', 'CONNECTED'];
const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });
const RESEND_OK = { data: [{ id: 'd_raw_77', name: 'mail.shop-example.test', status: 'verified', region: 'us-east-1', records: [{ value: 'SECRET-DKIM' }] }] };
const META_OK = { display_phone_number: '+1 202 555 0143', code_verification_status: 'VERIFIED', status: 'CONNECTED', id: '123456789012345', verified_name: 'Secret Biz' };

function mainSide() {
  const ss = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'dpapi', encryptString: (p) => Buffer.from('enc:' + p), decryptString: (b) => b.toString().slice(4) };
  vault.setSafeStorageForTests(ss);
  const store = makeStore();
  const fetchLog = [];
  const applies = [];
  const settings = createOutreachSettings({
    store, safeStorage: ss, clock: () => new Date('2026-10-06T10:00:00.000Z'),
    fetchImpl: async (url) => { fetchLog.push(url); return resp(200, url.includes('resend') ? RESEND_OK : META_OK); },
    onChange: (w) => applies.push(w),
  });
  const handlers = {};
  registerOutreachSettingsIpc({ ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } }, settings, isTrustedSender: () => true, logger: { warn() {} } });
  const sent = [];
  const inv = (ch, payload) => { sent.push({ ch, payload }); return handlers[ch]({}, payload); };
  // Exactly the preload surface (preload.js appAPI.outreachSettings).
  const api = {
    status: () => inv(CH.STATUS, {}),
    saveBusiness: (p) => inv(CH.SAVE_BUSINESS, p || {}),
    saveEmail: (p) => inv(CH.SAVE_EMAIL, p || {}),
    saveWhatsApp: (p) => inv(CH.SAVE_WHATSAPP, p || {}),
    setKey: (channel, key) => inv(CH.SET_KEY, { channel, key }),
    clearKey: (channel) => inv(CH.CLEAR_KEY, { channel }),
    verify: (channel) => inv(CH.VERIFY, { channel }),
  };
  return { api, store, fetchLog, applies, sent, handlers };
}

function makeUi(api) {
  const doc = makeDoc();
  const toasts = [];
  const timers = [];
  const ui = new Function('document', 'window', 'safeAsync', 'toast', 'setTimeout', 'setInterval',
    block + '\nreturn { loadOutreachSettings, saveOutreachSection, saveOutreachKey, clearOutreachKey, verifyOutreach };')(
    doc, { appAPI: api ? { outreachSettings: api } : {} }, (fn) => fn, (m, t) => toasts.push({ m, t }),
    (fn) => { timers.push(fn); return 1; }, (fn) => { timers.push(fn); return 1; });
  return { doc, ui, toasts, timers, el: (id) => doc.getElementById(id) };
}

function scanDom(doc, needles) {
  for (const el of doc.all()) {
    const parts = [el.textContent, el.value, JSON.stringify(el.attributes), JSON.stringify(el.dataset)];
    for (const n of needles) for (const p of parts) assert.ok(!String(p).includes(n), `leaked into #${el.id}: ${n.slice(0, 8)}`);
  }
}

function fill(u, section, values) {
  for (const [k, v] of Object.entries(values)) {
    if (k === 'enabled') u.el(`outreach-${section}-enabled`).checked = v;
    else u.el(`outreach-${section}-${k}`).value = v;
  }
}

const EMAIL = { enabled: true, fromName: 'Shop Example', domain: 'mail.shop-example.test', fromAddress: 'hello@mail.shop-example.test', replyTo: '', signature: '' };
const WA = { enabled: true, fromNumber: '+12025550143', phoneNumberId: '123456789012345', businessAccountId: '998877665544' };

test('1. the HTML groups: password key fields, Check buttons, templates notice, no identity', () => {
  for (const s of ['email', 'whatsapp']) {
    const g = groupHtml(s);
    assert.ok(new RegExp(`<input type="password" id="outreach-${s}-key"[^>]*autocomplete="off"`).test(g), `${s} key is a write-only password field`);
    assert.ok(g.includes(`id="btn-outreach-${s}-verify"`));
    assert.ok(g.includes(`id="outreach-${s}-capability"`));
  }
  assert.ok(/Message templates[\s\S]*Not supported yet/.test(groupHtml('whatsapp')), 'D3 notice present');
  const all = ['business', 'email', 'whatsapp'].map(groupHtml).join('\n');
  assert.ok(!/zunitech|ztech\.|zee\b|\+92\d|@[a-z0-9-]+\.(com|pk)/i.test(all + blockCode), 'no hard-coded identity');
  assert.ok(!/value="[^"]+"/.test(all.replace(/<option[^>]*>/g, '')), 'no prefilled values');
});

test('2. the block never uses innerHTML, never polls, names channels not providers', () => {
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(blockCode));
  assert.ok(!/setInterval|setTimeout/.test(blockCode), 'verification is user-triggered only');
  assert.ok(!/resend|meta-cloud|graph\.facebook|api\.resend|Bearer/i.test(blockCode.replace(/Resend API key/g, '')), 'no provider ids, endpoints or auth schemes');
  assert.ok(rendererSource.includes('loadOutreachSettings();'), 'loaded with the Settings workspace');
});

test('3. initial render: Not set / Not checked / Not ready with the real capability reason; zero provider calls', async () => {
  const m = mainSide();
  const u = makeUi(m.api);
  await u.ui.loadOutreachSettings();
  for (const s of ['email', 'whatsapp']) {
    assert.strictEqual(u.el(`outreach-${s}-key-state`).textContent, 'Not set');
    assert.strictEqual(u.el(`outreach-${s}-verify-state`).textContent, 'Not checked');
    assert.strictEqual(u.el(`outreach-${s}-verify-checked`).textContent, 'Never checked.');
    assert.strictEqual(u.el(`outreach-${s}-capability`).textContent, 'Not ready');
    assert.ok(u.el(`outreach-${s}-capability-message`).textContent.length > 5, 'the reason is shown');
    assert.strictEqual(u.el(`btn-outreach-${s}-clear-key`).disabled, true);
    assert.strictEqual(u.el(`outreach-${s}-enabled`).checked, false);
  }
  assert.strictEqual(u.el('outreach-whatsapp-templates').textContent, 'Not supported yet');
  assert.strictEqual(m.fetchLog.length, 0);
  assert.strictEqual(u.timers.length, 0);
});

test('4. Business profile saves, refills and applies live', async () => {
  const m = mainSide();
  const u = makeUi(m.api);
  fill(u, 'business', { representativeName: 'Dana', companyName: 'Ridgeline Supply', valueProposition: 'We fix audit issues.', callToAction: 'A short call?' });
  await u.ui.saveOutreachSection('business');
  assert.strictEqual(u.el('outreach-business-status').textContent, 'Business profile saved.');
  assert.strictEqual(m.store.get('settings').businessCompanyName, 'Ridgeline Supply');
  assert.deepStrictEqual(m.applies, ['business']);
  const u2 = makeUi(m.api);
  await u2.ui.loadOutreachSettings();
  assert.strictEqual(u2.el('outreach-business-companyName').value, 'Ridgeline Supply');
});

test('5. Email end to end: save, key (write-only), Check domain -> Verified + checkedAt, Ready to send; no secret or raw field in the DOM', async () => {
  const m = mainSide();
  const u = makeUi(m.api);
  fill(u, 'email', EMAIL);
  await u.ui.saveOutreachSection('email');
  assert.strictEqual(u.el('outreach-email-status').textContent, 'Email settings saved.');
  u.el('outreach-email-key').value = RKEY;
  await u.ui.saveOutreachKey('email');
  assert.strictEqual(u.el('outreach-email-key').value, '', 'field emptied');
  assert.strictEqual(u.el('outreach-email-key-state').textContent, 'Stored');
  assert.strictEqual(u.el('btn-outreach-email-clear-key').disabled, false);
  assert.deepStrictEqual(m.sent.find((x) => x.ch === CH.SET_KEY).payload, { channel: 'email', key: RKEY });
  assert.strictEqual(m.fetchLog.length, 0, 'saving never checks');
  await u.ui.verifyOutreach('email');
  assert.strictEqual(m.fetchLog.length, 1, 'one check per click');
  assert.strictEqual(u.el('outreach-email-verify-state').textContent, 'Verified');
  assert.ok(u.el('outreach-email-verify-checked').textContent.startsWith('Last checked '));
  assert.strictEqual(u.el('outreach-email-capability').textContent, 'Ready to send');
  scanDom(u.doc, [RKEY, ...RAW]);
});

test('6. changing the sending domain resets the chip to Not checked / Never checked', async () => {
  const m = mainSide();
  const u = makeUi(m.api);
  fill(u, 'email', EMAIL);
  await u.ui.saveOutreachSection('email');
  u.el('outreach-email-key').value = RKEY;
  await u.ui.saveOutreachKey('email');
  await u.ui.verifyOutreach('email');
  fill(u, 'email', { domain: 'other-example.test', fromAddress: 'hi@other-example.test' });
  await u.ui.saveOutreachSection('email');
  assert.strictEqual(u.el('outreach-email-verify-state').textContent, 'Not checked');
  assert.strictEqual(u.el('outreach-email-verify-checked').textContent, 'Never checked.');
  assert.strictEqual(u.el('outreach-email-capability').textContent, 'Not ready');
});

test('7. a refused save shows main\'s message, toasts, and writes nothing', async () => {
  const m = mainSide();
  const u = makeUi(m.api);
  fill(u, 'email', { ...EMAIL, fromAddress: 'hello@elsewhere-example.test' });
  await u.ui.saveOutreachSection('email');
  assert.match(u.el('outreach-email-status').textContent, /sending domain/);
  assert.strictEqual(u.toasts.at(-1).t, 'error');
  assert.strictEqual((m.store.get('settings') || {}).emailDomain, undefined);
  assert.strictEqual(m.applies.length, 0);
});

test('8. key field is emptied even when the key is refused; an empty field sends nothing', async () => {
  const m = mainSide();
  const u = makeUi(m.api);
  u.el('outreach-whatsapp-key').value = 'has space key-123';
  await u.ui.saveOutreachKey('whatsapp');
  assert.strictEqual(u.el('outreach-whatsapp-key').value, '');
  assert.strictEqual(u.el('outreach-whatsapp-key-state').textContent, 'Not set');
  const before = m.sent.length;
  await u.ui.saveOutreachKey('whatsapp');
  assert.strictEqual(m.sent.length, before, 'no call for an empty field');
  scanDom(u.doc, ['has space key-123']);
});

test('9. WhatsApp end to end: save, token, Check number -> Verified; changing the number resets; clear key', async () => {
  const m = mainSide();
  const u = makeUi(m.api);
  fill(u, 'whatsapp', WA);
  await u.ui.saveOutreachSection('whatsapp');
  u.el('outreach-whatsapp-key').value = MKEY;
  await u.ui.saveOutreachKey('whatsapp');
  await u.ui.verifyOutreach('whatsapp');
  assert.strictEqual(u.el('outreach-whatsapp-verify-state').textContent, 'Verified');
  assert.strictEqual(u.el('outreach-whatsapp-capability').textContent, 'Ready to send');
  assert.strictEqual(u.el('outreach-whatsapp-templates').textContent, 'Not supported yet');
  scanDom(u.doc, [MKEY, ...RAW]);
  fill(u, 'whatsapp', { fromNumber: '+12025550199' });
  await u.ui.saveOutreachSection('whatsapp');
  assert.strictEqual(u.el('outreach-whatsapp-verify-state').textContent, 'Not checked');
  await u.ui.clearOutreachKey('whatsapp');
  assert.strictEqual(u.el('outreach-whatsapp-key-state').textContent, 'Not set');
  assert.strictEqual(u.el('outreach-whatsapp-status').textContent, 'Key cleared.');
});

test('10. no API -> Unavailable; IPC refuses a provider id where a channel is expected', async () => {
  const u = makeUi(null);
  await u.ui.loadOutreachSettings();
  assert.strictEqual(u.el('outreach-email-capability').textContent, 'Unavailable');
  const m = mainSide();
  for (const ch of [CH.SET_KEY, CH.CLEAR_KEY, CH.VERIFY]) {
    const r = await m.handlers[ch]({}, { channel: 'resend', key: RKEY });
    assert.strictEqual(r.ok, false, ch);
    const r2 = await m.handlers[ch]({}, { provider: 'resend', key: RKEY });
    assert.strictEqual(r2.ok, false, ch + ' (old field name)');
  }
});

test('11. F26 follow-up: replacing or clearing a key resets the chip to Not checked / Never checked and Not ready, with no check', async () => {
  for (const [section, values, key] of [['email', EMAIL, RKEY], ['whatsapp', WA, MKEY]]) {
    const m = mainSide();
    const u = makeUi(m.api);
    fill(u, section, values);
    await u.ui.saveOutreachSection(section);
    u.el(`outreach-${section}-key`).value = key;
    await u.ui.saveOutreachKey(section);
    await u.ui.verifyOutreach(section);
    assert.strictEqual(u.el(`outreach-${section}-capability`).textContent, 'Ready to send');
    const checks = m.fetchLog.length;
    u.el(`outreach-${section}-key`).value = key + '_rotated';
    await u.ui.saveOutreachKey(section);
    assert.strictEqual(u.el(`outreach-${section}-verify-state`).textContent, 'Not checked');
    assert.strictEqual(u.el(`outreach-${section}-verify-checked`).textContent, 'Never checked.');
    assert.strictEqual(u.el(`outreach-${section}-capability`).textContent, 'Not ready');
    await u.ui.verifyOutreach(section);
    await u.ui.clearOutreachKey(section);
    assert.strictEqual(u.el(`outreach-${section}-verify-state`).textContent, 'Not checked');
    assert.strictEqual(m.fetchLog.length, checks + 1, 'only the explicit Check reached the provider');
    scanDom(u.doc, [key, key + '_rotated']);
  }
});

(async () => {
  for (const { name, fn } of queue) {
    try { await fn(); passed++; console.log('ok - ' + name); } catch (e) { failures.push(name); console.log('FAIL - ' + name + '\n' + (e && e.stack)); }
  }
  console.log(`${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
