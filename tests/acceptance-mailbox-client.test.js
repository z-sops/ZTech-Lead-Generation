'use strict';

// Windows acceptance blocker (8 Oct 2026): Settings > Mailboxes > "Save client" cleared the secret,
// showed "Internal error" and stayed "Not set". Root cause: main.js built the mailbox persistence on
// `new Store()` while `Store` was only declared inside initServices, so every client save / read
// threw a ReferenceError (-> publicError "Internal error") and nothing was stored.
//
// These tests run the REAL persistence module (as main.js now wires it), the REAL credential vault
// (with a stand-in for Electron's safeStorage), a disk-like electron-store double, the REAL
// MailboxService + mailbox IPC and the REAL Settings > Mailboxes renderer block. No network.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const LI = path.join(root, 'src', 'main', 'lead-intelligence');
const credentialVault = require(path.join(root, 'src', 'main', 'credentialVault.js'));
const { createMailboxPersistence } = require(path.join(LI, 'mailbox', 'mailboxPersistence.js'));
const { MemoryStore } = require(path.join(LI, 'persistence', 'MemoryStore.js'));
const { MailboxService } = require(path.join(LI, 'mailbox', 'MailboxService.js'));
const { registerMailboxIpc, MAILBOX_CHANNELS_IPC } = require(path.join(LI, 'mailbox', 'mailbox-ipc.js'));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const CLIENT_ID = '123456789012-abcdefghij.apps.googleusercontent.com';
const SECRET = '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n';

/** Electron safeStorage stand-in: reversible, and the ciphertext never contains the plaintext. */
function safeStorage({ available = true, failEncrypt = false, failDecrypt = false } = {}) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s) => { if (failEncrypt) throw new Error('boom'); return Buffer.from(s.split('').reverse().join('') + '#x', 'utf8'); },
    decryptString: (b) => { if (failDecrypt) throw new Error('boom'); const t = b.toString('utf8'); return t.slice(0, -2).split('').reverse().join(''); },
  };
}

/** electron-store double backed by a JSON "file" that survives a restart (a new instance). */
function diskStore({ failWrite = false } = {}) {
  const disk = { json: '{}' };
  const factory = () => ({
    get: (k, d) => { const o = JSON.parse(disk.json); return o[k] === undefined ? d : o[k]; },
    set: (k, v) => { if (failWrite) throw new Error('EPERM: operation not permitted'); const o = JSON.parse(disk.json); o[k] = v; disk.json = JSON.stringify(o); },
  });
  return { disk, factory };
}

function mainSide({ disk = diskStore(), ss = safeStorage() } = {}) {
  credentialVault.setSafeStorageForTests(ss);
  const logs = [];
  const deps = createMailboxPersistence({ storeFactory: disk.factory, vault: credentialVault, openExternal: () => {} });
  const svc = new MailboxService({
    store: new MemoryStore(), clock: () => new Date('2026-10-08T10:00:00.000Z'), fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }),
    tokenStore: deps.tokenStore, clientConfig: deps.clientConfig, operator: 'Zee', logger: { warn: (m) => logs.push(m) },
  });
  const handlers = {};
  registerMailboxIpc({ ipcMain: { handle: (c, f) => { handlers[c] = f; } }, mailboxes: svc, isTrustedSender: () => true, logger: { warn: (m) => logs.push(m) } });
  const results = [];
  const inv = (ch) => async (p) => { const r = await handlers[ch]({}, p === undefined ? {} : p); results.push(r); return r; };
  const api = {
    capabilities: inv(MAILBOX_CHANNELS_IPC.CAPABILITIES), list: inv(MAILBOX_CHANNELS_IPC.LIST), connect: inv(MAILBOX_CHANNELS_IPC.CONNECT),
    setGoogleClient: inv(MAILBOX_CHANNELS_IPC.GOOGLE_CLIENT), marketRules: inv(MAILBOX_CHANNELS_IPC.MARKET_LIST),
  };
  return { disk, svc, api, results, logs, deps };
}

/* ---- the REAL Settings > Mailboxes renderer block on a DOM double ---- */
const rendererSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'renderer.js'), 'utf8');
const START = '// === F26.6 Mailboxes: connected mailboxes, pacing limits and market rules ===';
const block = rendererSource.slice(rendererSource.indexOf(START), rendererSource.indexOf('// === END F26.6 Mailboxes ==='));
const HELPERS = ['function trustEl(', 'function trustDate('].map((sig) => { const i = rendererSource.indexOf(sig); return rendererSource.slice(i, rendererSource.indexOf('\n}\n', i) + 3); }).join('\n');
class El {
  constructor(tag, id) { this.tagName = String(tag).toUpperCase(); this.id = id || ''; this.children = []; this.attributes = {}; this.listeners = {}; this.className = ''; this.disabled = false; this.type = ''; this.value = ''; this._text = ''; this.dataset = {}; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  appendChild(c) { this.children.push(c); return c; }
  append(...cs) { cs.forEach((c) => this.appendChild(c)); }
  replaceChildren(...cs) { this.children = []; this._text = ''; cs.forEach((c) => this.appendChild(c)); }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return this.attributes[k] ?? null; }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  click() { for (const fn of this.listeners.click || []) fn({}); }
  all() { return this.children.flatMap((c) => [c, ...c.all()]); }
}
function ui(api) {
  const reg = new Map();
  const document = { getElementById(id) { if (!reg.has(id)) reg.set(id, new El(id.startsWith('btn-') ? 'button' : 'div', id)); return reg.get(id); }, createElement: (t) => new El(t) };
  const u = new Function('document', 'window', `${HELPERS}\n${block}\nreturn { load: f266MailboxesLoad, init: f266MailboxesInit };`)(document, { ztechLeadIntel: { mailboxes: api } });
  u.init();
  const el = (id) => document.getElementById(id);
  const btn = (host, label) => el(host).all().find((n) => n.tagName === 'BUTTON' && n.textContent === label) || null;
  return { u, el, btn };
}
const flush = async () => { for (let i = 0; i < 40; i += 1) await new Promise((r) => setImmediate(r)); };
async function saveViaUi(m) {
  const v = ui(m.api);
  await v.u.load();
  await flush();
  v.el('mailbox-google-client-id').value = CLIENT_ID;
  v.el('mailbox-google-client-secret').value = SECRET;
  v.el('btn-mailbox-save-client').click();
  await flush();
  return v;
}

/* ================================ success path ================================ */

test('1-8. Save client: secret sealed, id stored, read-back configured, UI "Saved", survives a restart, Connect enabled, secret never returned or logged', async () => {
  const m = mainSide();
  const v = await saveViaUi(m);
  // 1-3. persisted: the id in clear, the secret sealed (never the plaintext).
  const stored = JSON.parse(m.disk.disk.json).mailboxOAuth.google;
  assert.strictEqual(stored.clientId, CLIENT_ID);
  assert.ok(credentialVault.isSealed(stored.clientSecret), 'the secret is sealed');
  assert.ok(!m.disk.disk.json.includes(SECRET), 'the plaintext secret is nowhere in the settings file');
  // 4. read-back: configured, without the secret.
  const caps = await m.svc.providers();
  const gmail = caps.find((p) => p.provider === 'gmail');
  assert.strictEqual(gmail.clientConfigured, true);
  assert.strictEqual(gmail.clientId, CLIENT_ID);
  // 5. the renderer shows Saved; the secret field is empty.
  assert.strictEqual(v.el('mailbox-client-state').textContent, 'Saved');
  assert.strictEqual(v.el('mailbox-google-client-secret').value, '');
  assert.ok(!/Internal error/.test(v.el('mailbox-status').textContent));
  // 7. Connect Gmail becomes available.
  assert.strictEqual(v.btn('mailbox-provider-rows', 'Connect Gmail').disabled, false);
  // 6. an app restart (new persistence over the same settings file) still reads it as configured.
  const restarted = mainSide({ disk: m.disk });
  const again = (await restarted.svc.providers()).find((p) => p.provider === 'gmail');
  assert.strictEqual(again.clientConfigured, true);
  const v2 = ui(restarted.api);
  await v2.u.load();
  await flush();
  assert.strictEqual(v2.el('mailbox-client-state').textContent, 'Saved');
  // 8. the secret is never returned to the renderer or logged.
  const everything = JSON.stringify({ results: [...m.results, ...restarted.results], logs: [...m.logs, ...restarted.logs] });
  assert.ok(!everything.includes(SECRET), 'no IPC result and no log line carries the secret');
  assert.ok(!everything.includes('enc:v1:'), 'nor its sealed form');
});

/* ================================ failure paths ================================ */

for (const [name, opts, code, text] of [
  ['secure storage unavailable', { ss: safeStorage({ available: false }) }, 'MAILBOX_VAULT_UNAVAILABLE', /Windows secure storage is not available/],
  ['encryption fails', { ss: safeStorage({ failEncrypt: true }) }, 'MAILBOX_VAULT_FAILED', /could not be encrypted/],
  ['the settings file cannot be written', { disk: diskStore({ failWrite: true }) }, 'MAILBOX_SETTINGS_WRITE_FAILED', /could not be written to ZTech's settings file/],
  ['the saved value cannot be read back', { ss: safeStorage({ failDecrypt: true }) }, 'MAILBOX_CLIENT_NOT_SAVED', /could not be read back/],
]) {
  test(`F. ${name}: status stays "Not set" and the UI shows the real reason (${code})`, async () => {
    const m = mainSide(opts);
    const v = await saveViaUi(m);
    const res = m.results.find((r) => r && r.ok === false);
    assert.ok(res, 'the save is refused');
    assert.strictEqual(res.error.code, code);
    assert.ok(text.test(res.error.message), res.error.message);
    assert.strictEqual(v.el('mailbox-client-state').textContent, 'Not set');
    assert.ok(text.test(v.el('mailbox-status').textContent), 'the UI shows: ' + v.el('mailbox-status').textContent);
    assert.ok(!/Internal error/.test(v.el('mailbox-status').textContent));
    assert.strictEqual(v.btn('mailbox-provider-rows', 'Connect Gmail').disabled, true);
    const g = (await m.svc.providers()).find((p) => p.provider === 'gmail');
    assert.strictEqual(g.clientConfigured, false);
    if (!opts.disk) {
      const file = JSON.parse(m.disk.disk.json);
      assert.ok(!file.mailboxOAuth || !file.mailboxOAuth.google, 'nothing half-saved is left behind');
    }
    assert.ok(!JSON.stringify({ r: m.results, l: m.logs }).includes(SECRET), 'the secret is never echoed in an error or a log');
  });
}

test('F5. an unexpected failure in the client store is "not saved", never "Internal error"', async () => {
  const m = mainSide();
  m.svc.clientConfig = { get: () => null, set: () => { throw new ReferenceError('Store is not defined'); }, clear: () => {} };
  const res = await m.api.setGoogleClient({ clientId: CLIENT_ID, clientSecret: SECRET });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error.code, 'MAILBOX_CLIENT_NOT_SAVED');
  assert.ok(!/Internal error/.test(res.error.message));
});

test('F6. a read-back that reveals a different secret is not "Saved", and nothing is left behind', async () => {
  const ss = safeStorage();
  const decrypt = ss.decryptString;
  ss.decryptString = (b) => decrypt(b) + 'X'; // decrypts, but not to what was typed
  const m = mainSide({ ss });
  const res = await m.api.setGoogleClient({ clientId: CLIENT_ID, clientSecret: SECRET });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error.code, 'MAILBOX_CLIENT_NOT_SAVED');
  const file = JSON.parse(m.disk.disk.json);
  assert.ok(!file.mailboxOAuth || !file.mailboxOAuth.google, 'the unreadable client was rolled back');
});

test('F7. a stored client that can no longer be decrypted reads as "Not set", never a crash', async () => {
  const disk = diskStore();
  const m = mainSide({ disk });
  assert.strictEqual((await m.api.setGoogleClient({ clientId: CLIENT_ID, clientSecret: SECRET })).ok, true);
  // e.g. the settings file copied to another Windows account: DPAPI cannot open it there.
  const after = mainSide({ disk, ss: safeStorage({ failDecrypt: true }) });
  assert.strictEqual(after.deps.clientConfig.get(), null);
  const caps = await after.api.capabilities();
  assert.strictEqual(caps.ok, true, 'status read still answers');
  const gmail = caps.data.find((p) => p.provider === 'gmail');
  assert.strictEqual(gmail.clientConfigured, false);
});

test('F8. the service itself refuses "Saved" when the store accepts the write but keeps nothing', async () => {
  const m = mainSide();
  m.svc.clientConfig = { get: () => null, set: () => {}, clear: () => {} };
  const res = await m.api.setGoogleClient({ clientId: CLIENT_ID, clientSecret: SECRET });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error.code, 'MAILBOX_CLIENT_NOT_SAVED');
});

test('F9. a store error whose text contains the secret is never logged or returned', async () => {
  const m = mainSide();
  m.svc.clientConfig = { get: () => null, set: ({ clientSecret }) => { throw new Error(`bad value ${clientSecret}`); }, clear: () => {} };
  const res = await m.api.setGoogleClient({ clientId: CLIENT_ID, clientSecret: SECRET });
  assert.strictEqual(res.ok, false);
  assert.ok(m.logs.length > 0, 'the failure is logged (by code)');
  assert.ok(!JSON.stringify({ r: m.results, l: m.logs }).includes(SECRET));
});

test('F10. a failed re-save keeps the earlier working client exactly as it was', async () => {
  const ss = safeStorage();
  const m = mainSide({ ss });
  assert.strictEqual((await m.api.setGoogleClient({ clientId: CLIENT_ID, clientSecret: SECRET })).ok, true);
  const before = JSON.parse(m.disk.disk.json).mailboxOAuth.google;
  const decrypt = ss.decryptString;
  ss.decryptString = (b) => { const t = decrypt(b); return t === 'GOCSPX-second-secret' ? t + 'X' : t; };
  const res = await m.api.setGoogleClient({ clientId: CLIENT_ID, clientSecret: 'GOCSPX-second-secret' });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error.code, 'MAILBOX_CLIENT_NOT_SAVED');
  assert.deepStrictEqual(JSON.parse(m.disk.disk.json).mailboxOAuth.google, before, 'earlier client restored');
  assert.deepStrictEqual(m.deps.clientConfig.get(), { clientId: CLIENT_ID, clientSecret: SECRET });
});

test('F11. only known vault reasons are shown; any other vault text is not echoed', () => {
  const { persistenceError } = require(path.join(LI, 'mailbox', 'mailboxPersistence.js'));
  assert.ok(/\(encryption failed\)/.test(persistenceError(new Error('vault: encryption failed'), 'x').message));
  const e = persistenceError(new Error(`vault: weird ${SECRET}`), 'x');
  assert.strictEqual(e.code, 'MAILBOX_VAULT_FAILED');
  assert.ok(!e.message.includes(SECRET) && /unexpected vault error/.test(e.message));
});

/* ===== acceptance run 2: "has an invalid format" with no field and no reason ===== */

async function uiSave(m, id, secret) {
  const v = ui(m.api);
  await v.u.load();
  await flush();
  const before = m.results.length;
  v.el('mailbox-google-client-id').value = id;
  v.el('mailbox-google-client-secret').value = secret;
  v.el('btn-mailbox-save-client').click();
  await flush();
  return { v, calls: m.results.slice(before).length, status: v.el('mailbox-status').textContent, state: v.el('mailbox-client-state').textContent };
}

test('P1. values pasted with quotes, line breaks or hidden characters are cleaned and saved', async () => {
  for (const [id, secret] of [
    [`"${CLIENT_ID}"`, `"${SECRET}"`], // copied from $env:GOOGLE_CLIENT_ID="..."
    [` ${CLIENT_ID}\r\n`, `${SECRET}\n`],
    [`﻿${CLIENT_ID}​`, `​${SECRET}`],
    [`'${CLIENT_ID}'`, `'${SECRET}'`],
  ]) {
    const m = mainSide();
    const r = await uiSave(m, id, secret);
    assert.strictEqual(r.state, 'Saved', `saved for ${JSON.stringify(id)}: ${r.status}`);
    assert.deepStrictEqual(m.deps.clientConfig.get(), { clientId: CLIENT_ID, clientSecret: SECRET });
    assert.strictEqual(r.v.el('mailbox-google-client-id').value, CLIENT_ID);
  }
});

test('P2. a value that cannot be a Google client is refused before saving, with a reason that names the field', async () => {
  const cases = [
    ['123456789012-abcdefghij', SECRET, /Client ID must be the whole ID ending in \.apps\.googleusercontent\.com/],
    ['Client ID: 123456789012-abcdefghij.apps.googleusercontent.com', SECRET, /Client ID contains a character that is not allowed/],
    [CLIENT_ID, 'GOCSPX-has a space', /Client secret contains a space or line break/],
    [CLIENT_ID, 'short', /Client secret is not the right length/],
    ['abcd.apps.googleusercontent.com', SECRET, /Client ID is not the right length/], // the service needs 8-200 before the ending
    ['$env:GOOGLE_CLIENT_ID="123456789012-abcdefghij.apps.googleusercontent.com"', SECRET, /Paste only the Client ID itself/],
    [CLIENT_ID, '$env:GOOGLE_CLIENT_SECRET="GOCSPX-x"', /Paste only the Client secret itself/],
  ];
  for (const [id, secret, re] of cases) {
    const m = mainSide();
    const r = await uiSave(m, id, secret);
    assert.ok(re.test(r.status), `${JSON.stringify(id)}: ${r.status}`);
    assert.ok(!/has an invalid format|Internal error/.test(r.status));
    assert.strictEqual(r.calls, 0, 'nothing was sent to the main process');
    assert.notStrictEqual(r.state, 'Saved');
    assert.strictEqual(r.v.el('mailbox-google-client-secret').value, '', 'the secret field is still emptied');
    assert.ok(!r.status.includes(SECRET) && !r.status.includes(secret), 'the secret is never echoed');
  }
});

test('P3. a refusal from the main process names the field, never "has an invalid format" alone', async () => {
  const m = mainSide();
  const v = ui({ ...m.api, setGoogleClient: async () => ({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid payload', errors: [{ path: '$.clientId', message: 'has an invalid format' }] } }) });
  await v.u.load();
  await flush();
  v.el('mailbox-google-client-id').value = CLIENT_ID;
  v.el('mailbox-google-client-secret').value = SECRET;
  v.el('btn-mailbox-save-client').click();
  await flush();
  assert.strictEqual(v.el('mailbox-status').textContent, 'Client ID has an invalid format.');
});

test('P3b. a refusal from the service itself (8-character minimum before the ending) is labelled too', async () => {
  const m = mainSide();
  const res = await m.api.setGoogleClient({ clientId: 'abcd.apps.googleusercontent.com', clientSecret: SECRET });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error.errors[0].path, '$.clientId', 'the service refusal carries the field');
});

test('P4. the hint does not say a personal Gmail account needs an Internal Workspace app', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.ok(!html.includes('(an Internal app in your Google Workspace)'));
  assert.ok(/Personal Gmail: an External app in Testing, with your own address added as a test user/.test(html));
});

test('S. main.js wires the tested module, and every `new Store()` left in main.js has its Store in scope', () => {
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  assert.ok(/function mailboxDepsFromStore\(\) \{[\s\S]*?createMailboxPersistence\(\{/.test(main), 'mailbox persistence comes from the tested module');
  const lines = main.split('\n');
  lines.forEach((line, i) => {
    if (!/new Store\(/.test(line)) return;
    const before = lines.slice(Math.max(0, i - 4), i + 1).join('\n');
    assert.ok(/const Store = require\('electron-store'\)/.test(before), `line ${i + 1}: new Store() without a Store in scope`);
  });
});

(async () => {
  let passed = 0;
  let failed = 0;
  for (const { name, fn } of tests) {
    try { await fn(); passed += 1; console.log('ok - ' + name); } catch (err) { failed += 1; console.log('FAIL - ' + name); console.log(String(err && err.stack ? err.stack : err)); }
  }
  credentialVault.setSafeStorageForTests(undefined);
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
