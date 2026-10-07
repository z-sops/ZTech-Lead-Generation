'use strict';

// F26.6 - Settings > Mailboxes (work-order test 10, provider-independent part). The REAL renderer
// block runs against a DOM double; its bridge is wired to the REAL mailbox IPC handlers over a REAL
// MailboxService with a fake Google (no network). Checks: Microsoft shows only its notice (no connect
// control), the client secret field is emptied and never echoed, records shown are sanitized,
// limits/market rules go through the closed IPC, nothing here can send.

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const http = require('http');

const root = path.join(__dirname, '..');
const LI = path.join(root, 'src', 'main', 'lead-intelligence');
const rendererSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'renderer.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const { MemoryStore } = require(path.join(LI, 'persistence', 'MemoryStore.js'));
const { MailboxService } = require(path.join(LI, 'mailbox', 'MailboxService.js'));
const { GoogleOAuth, GMAIL_SCOPES, GOOGLE } = require(path.join(LI, 'mailbox', 'gmail', 'GoogleOAuth.js'));
const { registerMailboxIpc, MAILBOX_CHANNELS_IPC } = require(path.join(LI, 'mailbox', 'mailbox-ipc.js'));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const START = '// === F26.6 Mailboxes: connected mailboxes, pacing limits and market rules ===';
const END = '// === END F26.6 Mailboxes ===';
const block = rendererSource.slice(rendererSource.indexOf(START), rendererSource.indexOf(END));
const code = block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const TRUST_HELPERS = ['function trustEl(', 'function trustDate('].map((sig) => {
  const i = rendererSource.indexOf(sig);
  return rendererSource.slice(i, rendererSource.indexOf('\n}\n', i) + 3);
}).join('\n');

const SECRET = 'GOCSPX-ui-secret-never-echoed';
const CLIENT_ID = '99887766-uitest.apps.googleusercontent.com';

class FakeEl {
  constructor(tag, id) { this.tagName = String(tag).toUpperCase(); this.id = id || ''; this.children = []; this.attributes = {}; this.listeners = {}; this.className = ''; this.disabled = false; this.type = ''; this.value = ''; this._text = ''; this.dataset = {}; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  set innerHTML(v) { throw new Error('innerHTML must not be used'); }
  appendChild(c) { this.children.push(c); return c; }
  append(...cs) { cs.forEach((c) => this.appendChild(c)); }
  replaceChildren(...cs) { this.children = []; this._text = ''; cs.forEach((c) => this.appendChild(c)); }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  click() { for (const fn of this.listeners.click || []) fn({}); }
  all() { return this.children.flatMap((c) => [c, ...c.all()]); }
}

function fakeGoogle() {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push(String(url));
    const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
    if (String(url) === GOOGLE.TOKEN_URL) return json(200, { access_token: 'ya29.ui', refresh_token: '1//ui-refresh', scope: GMAIL_SCOPES.join(' ') });
    if (String(url) === `${GOOGLE.GMAIL_API}/profile`) return json(200, { emailAddress: 'dana@ridgeline.example' });
    return json(200, {});
  };
  return { fetch, calls };
}
const browser = (url) => {
  const u = new URL(url);
  setImmediate(() => http.get(`${u.searchParams.get('redirect_uri')}/?code=c&state=${u.searchParams.get('state')}`, (r) => r.resume()));
};

function mainSide() {
  const store = new MemoryStore();
  let client = null;
  const google = fakeGoogle();
  const svc = new MailboxService({
    store, clock: () => new Date('2026-10-07T06:00:00.000Z'), fetch: google.fetch,
    tokenStore: { get: () => null, set: () => {}, remove: () => {} },
    clientConfig: { get: () => client, set: (c) => { client = c; }, clear: () => { client = null; } },
    googleOAuth: new GoogleOAuth({ fetch: google.fetch, openExternal: browser, timeoutMs: 3000 }),
    operator: 'Zee', defaultTimeZone: 'Asia/Karachi',
  });
  const handlers = {};
  registerMailboxIpc({ ipcMain: { handle: (c, f) => { handlers[c] = f; } }, mailboxes: svc, isTrustedSender: () => true, logger: { warn() {} } });
  const sent = [];
  const results = [];
  const inv = (ch) => async (p) => { sent.push({ ch, p }); const r = await handlers[ch]({}, p === undefined ? {} : p); results.push(r); return r; };
  const api = {
    capabilities: inv(MAILBOX_CHANNELS_IPC.CAPABILITIES), list: inv(MAILBOX_CHANNELS_IPC.LIST), connect: inv(MAILBOX_CHANNELS_IPC.CONNECT),
    disconnect: inv(MAILBOX_CHANNELS_IPC.DISCONNECT), setDefault: inv(MAILBOX_CHANNELS_IPC.DEFAULT), setLimits: inv(MAILBOX_CHANNELS_IPC.LIMITS),
    setGoogleClient: inv(MAILBOX_CHANNELS_IPC.GOOGLE_CLIENT), marketRules: inv(MAILBOX_CHANNELS_IPC.MARKET_LIST),
    setMarketRule: inv(MAILBOX_CHANNELS_IPC.MARKET_SET), removeMarketRule: inv(MAILBOX_CHANNELS_IPC.MARKET_REMOVE),
  };
  return { api, sent, results, store, svc, google };
}

function makeUi(api) {
  const reg = new Map();
  const document = {
    getElementById(id) {
      if (!reg.has(id)) reg.set(id, new FakeEl(id.startsWith('btn-') ? 'button' : 'div', id));
      return reg.get(id);
    },
    createElement(tag) { return new FakeEl(tag); },
  };
  const ui = new Function('document', 'window', `${TRUST_HELPERS}\n${block}\nreturn { load: f266MailboxesLoad, init: f266MailboxesInit, get state() { return f266State; } };`)(
    document, { ztechLeadIntel: { mailboxes: api } });
  ui.init();
  const el = (id) => document.getElementById(id);
  const btn = (hostId, label) => el(hostId).all().find((n) => n.tagName === 'BUTTON' && n.textContent === label) || null;
  return { ui, el, btn };
}
const flush = async (n = 30) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r)); };

test('10a. markup and code rules: own Settings group, textContent only, no timers, mailbox bridge only, no send', () => {
  const group = htmlSource.slice(htmlSource.indexOf('id="settings-group-mailboxes"'), htmlSource.indexOf('id="settings-group-whatsapp"'));
  assert.ok(/<input type="password" id="mailbox-google-client-secret"[^>]*autocomplete="off"/.test(group), 'the secret is a password field, never autofilled');
  assert.ok(group.includes('does not do bulk mailbox sending'), 'the frozen policy wording is shown');
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML|document\.write/.test(code));
  assert.ok(!/setInterval|setTimeout/.test(code));
  assert.ok(!/\.(send|outreachSend|handoff|approve)\(/.test(code), 'the block never sends');
  assert.ok(!/ztechLeadIntel\.(outreach|trust)|appAPI/.test(code), 'only the mailbox bridge');
  assert.ok(rendererSource.indexOf(END) < rendererSource.indexOf('\nf12OutreachInit();\n'), 'declared above the init calls (no TDZ)');
});

test('10b. Microsoft 365 shows only "verification required before activation" - no connect control; Gmail waits for a client', async () => {
  const m = mainSide();
  const u = makeUi(m.api);
  await u.ui.load();
  await flush();
  const providers = u.el('mailbox-provider-rows');
  assert.ok(providers.textContent.includes('Microsoft 365 — verification required before activation'));
  const buttons = providers.all().filter((n) => n.tagName === 'BUTTON').map((b) => b.textContent);
  assert.deepStrictEqual(buttons, ['Connect Gmail'], 'no Microsoft control exists');
  assert.strictEqual(u.btn('mailbox-provider-rows', 'Connect Gmail').disabled, true, 'disabled until a Google client is saved');
  assert.ok(providers.textContent.includes('Save your Google OAuth client first.'));
  assert.ok(!m.sent.some((s) => s.ch === MAILBOX_CHANNELS_IPC.CONNECT));
});

test('10c. the client secret is sent once, the field is emptied, and it never comes back to the page', async () => {
  const m = mainSide();
  const u = makeUi(m.api);
  await u.ui.load();
  await flush();
  u.el('mailbox-google-client-id').value = CLIENT_ID;
  u.el('mailbox-google-client-secret').value = SECRET;
  u.el('btn-mailbox-save-client').click();
  await flush();
  assert.strictEqual(u.el('mailbox-google-client-secret').value, '', 'emptied whatever happens');
  const setCall = m.sent.find((s) => s.ch === MAILBOX_CHANNELS_IPC.GOOGLE_CLIENT);
  assert.deepStrictEqual(setCall.p, { clientId: CLIENT_ID, clientSecret: SECRET });
  assert.strictEqual(u.el('mailbox-client-state').textContent, 'Saved');
  assert.strictEqual(u.btn('mailbox-provider-rows', 'Connect Gmail').disabled, false);
  assert.ok(!JSON.stringify(m.results).includes(SECRET), 'no IPC result carries the secret');
});

test('10d. connecting shows a sanitized record: address, Needs check, the Step 1A note, pacing - and no secret', async () => {
  const m = mainSide();
  await m.svc.setGoogleClient({ clientId: CLIENT_ID, clientSecret: SECRET });
  const u = makeUi(m.api);
  await u.ui.load();
  await flush();
  u.btn('mailbox-provider-rows', 'Connect Gmail').click();
  await flush(200);
  const rows = u.el('mailbox-rows').textContent;
  assert.ok(rows.includes('dana@ridgeline.example'));
  assert.ok(rows.includes('Needs check'));
  assert.ok(rows.includes('Sending from Gmail waits for its real-mailbox verification'));
  assert.ok(rows.includes('Sent in the last 24 hours: 0 of 30.'));
  assert.ok(rows.includes('Default'));
  assert.ok(!/ya29|1\/\/ui-refresh|GOCSPX/.test(JSON.stringify(m.results)), 'nothing secret crossed IPC');
  assert.ok(!u.el('mailbox-rows').all().some((n) => n.tagName === 'BUTTON' && /send/i.test(n.textContent)), 'no send control in Settings');
});

test('10e. limits are edited through the closed IPC; a refused value shows the main-process reason', async () => {
  const m = mainSide();
  await m.svc.setGoogleClient({ clientId: CLIENT_ID, clientSecret: SECRET });
  await m.svc.connect({ provider: 'gmail' });
  const u = makeUi(m.api);
  await u.ui.load();
  await flush();
  const inputs = u.el('mailbox-rows').all().filter((n) => n.tagName === 'INPUT');
  inputs[0].value = '20';
  inputs[1].value = '25';
  u.btn('mailbox-rows', 'Save limits').click();
  await flush();
  assert.ok(/hourly cap cannot exceed the daily cap/.test(u.el('mailbox-status').textContent), u.el('mailbox-status').textContent);
  const fresh = u.el('mailbox-rows').all().filter((n) => n.tagName === 'INPUT');
  fresh[0].value = '20';
  fresh[1].value = '5';
  u.btn('mailbox-rows', 'Save limits').click();
  await flush();
  const [mb] = await m.svc.list();
  assert.strictEqual(mb.limits.dailyCap, 20);
  assert.strictEqual(mb.limits.hourlyCap, 5);
});

test('10f. disconnect asks once more; market rules need a code and a note and are reviewed by the operator', async () => {
  const m = mainSide();
  await m.svc.setGoogleClient({ clientId: CLIENT_ID, clientSecret: SECRET });
  await m.svc.connect({ provider: 'gmail' });
  const u = makeUi(m.api);
  await u.ui.load();
  await flush();
  u.btn('mailbox-rows', 'Disconnect…').click();
  assert.ok(u.el('mailbox-rows').textContent.includes('Disconnect this mailbox?'));
  assert.ok(!m.sent.some((s) => s.ch === MAILBOX_CHANNELS_IPC.DISCONNECT), 'nothing happens before the confirmation');
  u.btn('mailbox-rows', 'Disconnect').click();
  await flush();
  assert.ok(u.el('mailbox-rows').textContent.includes('No mailbox connected.'));

  assert.ok(u.el('market-rule-rows').textContent.includes('consent is required everywhere'));
  u.el('market-rule-country').value = 'u';
  u.el('btn-market-rule-save').click();
  await flush();
  assert.ok(!m.sent.some((s) => s.ch === MAILBOX_CHANNELS_IPC.MARKET_SET));
  u.el('market-rule-country').value = 'us';
  u.el('market-rule-rule').value = 'opt_out_allowed';
  u.el('market-rule-note').value = 'Reviewed CAN-SPAM';
  u.el('btn-market-rule-save').click();
  await flush();
  assert.deepStrictEqual(m.sent.find((s) => s.ch === MAILBOX_CHANNELS_IPC.MARKET_SET).p, { countryCode: 'US', rule: 'opt_out_allowed', note: 'Reviewed CAN-SPAM' });
  const t = u.el('market-rule-rows').textContent;
  assert.ok(t.includes('US') && t.includes('Opt-out allowed') && t.includes('reviewed by Zee'));
});

(async () => {
  let passed = 0;
  let failed = 0;
  for (const { name, fn } of tests) {
    try { await fn(); passed += 1; console.log('ok - ' + name); } catch (err) { failed += 1; console.log('FAIL - ' + name); console.log(String(err && err.stack ? err.stack : err)); }
  }
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
