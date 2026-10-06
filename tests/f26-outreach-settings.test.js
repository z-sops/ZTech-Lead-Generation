'use strict';

// F26 - Outreach Settings writer, status, verification and IPC.
//
// Executes the real outreachSettings over a dot-path electron-store double, with the
// REAL F22-F25 readers and resolvers (readResendConfig, evaluateResendCapability,
// readWhatsAppConfig, evaluateWhatsAppConfig, readBusinessProfile) and the real
// credentialVault (safeStorage stubbed). Provider checks use a fake fetch: no network.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const OUT = path.join(root, 'src', 'main', 'lead-intelligence', 'outreach');
const vault = require(path.join(root, 'src', 'main', 'credentialVault.js'));
const mod = require(path.join(OUT, 'outreachSettings'));
const { createOutreachSettings, RESEND_DOMAINS_URL, CHECKED_AT } = mod;
const { OUTREACH_SETTINGS_CHANNELS: CH, registerOutreachSettingsIpc } = require(path.join(OUT, 'outreach-settings-ipc'));
const resend = require(path.join(OUT, 'email', 'resendConfig'));
const wa = require(path.join(OUT, 'whatsapp', 'whatsappConfig'));
const { readBusinessProfile } = require(path.join(OUT, 'businessProfile'));
const { ENDPOINT: META_GRAPH } = require(path.join(OUT, 'whatsapp', 'MetaCloudWhatsAppProvider'));
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');

let passed = 0;
const failures = [];
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

function makeStore(initial = {}) {
  const data = JSON.parse(JSON.stringify(initial));
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
    get(p, d) { const [o, k] = walk(p, false); return o && o[k] !== undefined ? o[k] : (d === undefined ? undefined : d); },
    set(p, v) { const [o, k] = walk(p, true); o[k] = JSON.parse(JSON.stringify(v)); },
    delete(p) { const [o, k] = walk(p, false); if (o) delete o[k]; },
  };
}

function safeStorage({ available = true, backend = 'dpapi' } = {}) {
  return {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptString: (p) => Buffer.from('enc:' + p, 'utf8'),
    decryptString: (b) => { const t = b.toString('utf8'); if (!t.startsWith('enc:')) throw new Error('x'); return t.slice(4); },
  };
}

function resp(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

function setup({ store = makeStore(), ss = safeStorage(), fetchImpl = null, now = '2026-10-06T10:00:00.000Z' } = {}) {
  vault.setSafeStorageForTests(ss);
  const calls = [];
  const changes = [];
  const fetchLog = [];
  const f = fetchImpl || (async () => resp(500, {}));
  const s = createOutreachSettings({
    store, safeStorage: ss, clock: () => new Date(now),
    fetchImpl: async (url, init) => { fetchLog.push({ url, init }); return f(url, init); },
    onChange: (w) => changes.push(w),
  });
  const handlers = {};
  registerOutreachSettingsIpc({ ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } }, settings: s, isTrustedSender: (e) => !(e && e.untrusted), logger: { warn() {} } });
  const call = async (ch, payload, ev = {}) => { const r = await handlers[ch](ev, payload); calls.push(r); return r; };
  return { s, store, call, calls, changes, fetchLog };
}

const RKEY = 're_live_SECRET_abcdefghijklmnop';
const MKEY = 'EAAGsecretTOKEN0123456789abcdefghij';
function scan(v, needles) { const t = JSON.stringify(v); for (const n of needles) assert.ok(!t.includes(n), 'leaked ' + n.slice(0, 6)); }

const GOOD_EMAIL = { enabled: true, fromName: 'Sales Team', fromAddress: 'hello@mail.example-shop.pk', replyTo: 'support@example-shop.pk', domain: 'mail.example-shop.pk', signature: 'Thanks,\nThe team' };
const GOOD_WA = { enabled: true, fromNumber: '+92 300 1234567', phoneNumberId: '123456789012345', businessAccountId: '987654321098765' };

// --- tests --------------------------------------------------------------------

test('1. an unconfigured install reads back empty and every channel refuses with the first thing to fix', async () => {
  const { call } = setup();
  const st = (await call(CH.STATUS, {})).data;
  assert.deepStrictEqual(st.business, { representativeName: '', companyName: '', valueProposition: '', callToAction: '' });
  assert.strictEqual(st.email.enabled, false);
  assert.strictEqual(st.email.capability.code, resend.RESEND_REFUSALS.PROVIDER_NOT_SELECTED);
  assert.strictEqual(st.whatsapp.capability.code, wa.WHATSAPP_REFUSALS.PROVIDER_NOT_SELECTED);
  assert.deepStrictEqual(st.email.verification, { status: 'unknown', checkedAt: null });
  assert.strictEqual(st.whatsapp.templates, 'unsupported');
});

test('2. business profile round-trips through the real readBusinessProfile', async () => {
  const { call, store } = setup();
  const res = await call(CH.SAVE_BUSINESS, { representativeName: ' Ayesha ', companyName: 'Example Shop', valueProposition: 'Line one\r\nLine two', callToAction: 'Reply to book a call.' });
  assert.strictEqual(res.ok, true);
  const p = readBusinessProfile(store);
  assert.deepStrictEqual(p, { sender_name: 'Ayesha', sender_company: 'Example Shop', value_proposition: 'Line one\nLine two', call_to_action: 'Reply to book a call.' });
  for (const bad of [{ representativeName: 'a'.repeat(81) }, { companyName: 'two\nlines' }, { callToAction: 'x\u0001' }]) {
    const before = JSON.stringify(store.data);
    assert.strictEqual((await call(CH.SAVE_BUSINESS, bad)).ok, false, JSON.stringify(bad).slice(0, 30));
    assert.strictEqual(JSON.stringify(store.data), before, 'nothing partial is written');
  }
});

test('3. email settings land on the keys readResendConfig reads; capability walks the existing refusals', async () => {
  const { call, store } = setup();
  assert.strictEqual((await call(CH.SAVE_EMAIL, GOOD_EMAIL)).ok, true);
  let cfg = resend.readResendConfig(store);
  assert.strictEqual(cfg.fromAddress, 'hello@mail.example-shop.pk');
  assert.strictEqual(cfg.domain, 'mail.example-shop.pk');
  assert.strictEqual(cfg.replyTo, 'support@example-shop.pk');
  assert.strictEqual(cfg.providerSelected, true);
  assert.strictEqual(store.get('settings').emailEnabled, true);
  let st = (await call(CH.STATUS, {})).data;
  assert.strictEqual(st.email.capability.code, resend.RESEND_REFUSALS.CREDENTIAL_MISSING, 'enabled does not bypass the verdict');
  await call(CH.SET_KEY, { provider: 'resend', key: RKEY });
  st = (await call(CH.STATUS, {})).data;
  assert.strictEqual(st.email.keyStored, true);
  assert.strictEqual(st.email.capability.code, resend.RESEND_REFUSALS.DOMAIN_NOT_VERIFIED);
  assert.deepStrictEqual(st.email.capability, (({ canSend, code, message }) => ({ canSend, code, message }))(resend.evaluateResendCapability(resend.readResendConfig(store))));
  scan(st, [RKEY]);
});

test('4. email validation: invalid values refused by the existing validators; From must be on the domain', async () => {
  const { call } = setup();
  const cases = [
    { ...GOOD_EMAIL, fromAddress: 'not-an-email' },
    { ...GOOD_EMAIL, replyTo: 'nope' },
    { ...GOOD_EMAIL, domain: 'bad domain' },
    { ...GOOD_EMAIL, fromName: 'two\nlines' },
    { ...GOOD_EMAIL, fromAddress: 'hello@other.pk' },
    { ...GOOD_EMAIL, signature: 'x'.repeat(501) },
    { ...GOOD_EMAIL, enabled: 'yes' },
    { ...GOOD_EMAIL, extra: 1 },
  ];
  for (const c of cases) assert.strictEqual((await call(CH.SAVE_EMAIL, c)).ok, false, JSON.stringify(c).slice(0, 60));
  const r = await call(CH.SAVE_EMAIL, { ...GOOD_EMAIL, fromAddress: 'hello@other.pk' });
  assert.match(r.error.message, /must be on the sending domain/);
  assert.strictEqual((await call(CH.SAVE_EMAIL, { ...GOOD_EMAIL, fromAddress: 'a@sub.mail.example-shop.pk' })).ok, true, 'a subdomain of the sending domain is accepted');
});

test('5. WhatsApp settings land on the keys readWhatsAppConfig reads; the number is normalised to E.164', async () => {
  const { call, store } = setup();
  assert.strictEqual((await call(CH.SAVE_WHATSAPP, GOOD_WA)).ok, true);
  const cfg = wa.readWhatsAppConfig(store);
  assert.strictEqual(cfg.fromNumber, '+923001234567');
  assert.strictEqual(cfg.phoneNumberId, '123456789012345');
  assert.strictEqual(cfg.accountConfigured, true);
  assert.strictEqual(cfg.providerSelected, true);
  await call(CH.SET_KEY, { provider: 'meta-cloud', key: MKEY });
  const st = (await call(CH.STATUS, {})).data;
  assert.strictEqual(st.whatsapp.capability.code, wa.WHATSAPP_REFUSALS.NUMBER_NOT_VERIFIED);
  for (const bad of [{ ...GOOD_WA, fromNumber: '0300 1234567 (0)' }, { ...GOOD_WA, fromNumber: '+44 (0)20 7123 4567' }, { ...GOOD_WA, phoneNumberId: 'abc' }, { ...GOOD_WA, businessAccountId: '12-34' }]) {
    assert.strictEqual((await call(CH.SAVE_WHATSAPP, bad)).ok, false, JSON.stringify(bad));
  }
});

test('6. keys: sealed at rest, never returned, refused without a secure keystore, cleared on request', async () => {
  const { call, store, calls } = setup();
  assert.deepStrictEqual((await call(CH.SET_KEY, { provider: 'resend', key: RKEY })).data, { ok: true, stored: true });
  assert.deepStrictEqual((await call(CH.SET_KEY, { provider: 'meta-cloud', key: MKEY })).data, { ok: true, stored: true });
  assert.ok(store.get('providers').resend.credentials.apiKey.startsWith('enc:v1:'));
  assert.ok(store.get('providers')['meta-cloud'].credentials.apiKey.startsWith('enc:v1:'));
  assert.ok(!JSON.stringify(store.data).includes(RKEY) && !JSON.stringify(store.data).includes(MKEY));
  for (const bad of ['short', 'has space key-123', 'x'.repeat(2049)]) assert.strictEqual((await call(CH.SET_KEY, { provider: 'resend', key: bad })).ok, false);
  assert.strictEqual((await call(CH.SET_KEY, { provider: 'coreclaw', key: RKEY })).ok, false, 'only the two outreach providers');
  await call(CH.CLEAR_KEY, { provider: 'resend' });
  assert.strictEqual(resend.readResendConfig(store).keyConfigured, false);
  for (const opts of [{ available: false }, { backend: 'basic_text' }]) {
    const t = setup({ ss: safeStorage(opts) });
    const r = await t.call(CH.SET_KEY, { provider: 'resend', key: RKEY });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error.code, 'OUTREACH_KEYSTORE_UNAVAILABLE');
  }
  scan(calls, [RKEY, MKEY]);
});

test('7. changing the domain resets verification to unknown and checkedAt to null; an unchanged save keeps it', async () => {
  const { call, store } = setup();
  await call(CH.SAVE_EMAIL, GOOD_EMAIL);
  const st0 = store.get('settings');
  store.set('settings', { ...st0, emailDomainVerification: 'verified', [CHECKED_AT.email]: '2026-10-05T09:00:00.000Z' });
  await call(CH.SAVE_EMAIL, { ...GOOD_EMAIL, fromName: 'New name' });
  assert.strictEqual(store.get('settings').emailDomainVerification, 'verified', 'same domain keeps the check');
  await call(CH.SAVE_EMAIL, { ...GOOD_EMAIL, domain: 'example-shop.pk', fromAddress: 'hi@example-shop.pk' });
  assert.strictEqual(store.get('settings').emailDomainVerification, 'unknown');
  assert.strictEqual(store.get('settings')[CHECKED_AT.email], null);
  const st = (await call(CH.STATUS, {})).data;
  assert.deepStrictEqual(st.email.verification, { status: 'unknown', checkedAt: null });
});

test('8. changing the WhatsApp number, phone-number ID or business account ID resets verification', async () => {
  for (const change of [{ fromNumber: '+923009999999' }, { phoneNumberId: '111' }, { businessAccountId: '222' }]) {
    const { call, store } = setup();
    await call(CH.SAVE_WHATSAPP, GOOD_WA);
    store.set('settings', { ...store.get('settings'), whatsappNumberVerification: 'verified', [CHECKED_AT.whatsapp]: '2026-10-05T09:00:00.000Z' });
    await call(CH.SAVE_WHATSAPP, { ...GOOD_WA, enabled: false });
    assert.strictEqual(store.get('settings').whatsappNumberVerification, 'verified', 'same number keeps the check (formatting differences included)');
    await call(CH.SAVE_WHATSAPP, { ...GOOD_WA, ...change });
    assert.strictEqual(store.get('settings').whatsappNumberVerification, 'unknown', JSON.stringify(change));
    assert.strictEqual(store.get('settings')[CHECKED_AT.whatsapp], null);
  }
});

test('9. Resend check: one GET to /domains with the key; the result is reduced to state + checkedAt only', async () => {
  const body = { data: [{ id: 'd_1', name: 'mail.example-shop.pk', status: 'verified', region: 'us-east-1', records: [{ value: 'SECRET-DKIM' }] }, { name: 'other.pk', status: 'failed' }] };
  const { call, store, fetchLog } = setup({ fetchImpl: async () => resp(200, body) });
  await call(CH.SAVE_EMAIL, GOOD_EMAIL);
  await call(CH.SET_KEY, { provider: 'resend', key: RKEY });
  const r = await call(CH.VERIFY, { provider: 'resend' });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(Object.keys(r.data).sort(), ['checkedAt', 'message', 'status']);
  assert.strictEqual(r.data.status, 'verified');
  assert.strictEqual(r.data.checkedAt, '2026-10-06T10:00:00.000Z');
  scan(r, ['SECRET-DKIM', 'us-east-1', 'd_1', RKEY]);
  assert.strictEqual(fetchLog.length, 1);
  assert.strictEqual(fetchLog[0].url, RESEND_DOMAINS_URL);
  assert.strictEqual(fetchLog[0].init.method, 'GET');
  assert.strictEqual(fetchLog[0].init.redirect, 'error');
  assert.strictEqual(fetchLog[0].init.headers.authorization, `Bearer ${RKEY}`);
  assert.strictEqual(store.get('settings').emailDomainVerification, 'verified');
  assert.strictEqual(store.get('settings')[CHECKED_AT.email], '2026-10-06T10:00:00.000Z');
  const st = (await call(CH.STATUS, {})).data;
  assert.strictEqual(st.email.capability.canSend, true, 'the existing resolver now allows email');
  assert.deepStrictEqual(st.email.verification, { status: 'verified', checkedAt: '2026-10-06T10:00:00.000Z' });
});

test('10. Resend status mapping, not-found, rejected key and an unreachable provider', async () => {
  const cases = [
    [resp(200, { data: [{ name: 'mail.example-shop.pk', status: 'pending' }] }), 'pending'],
    [resp(200, { data: [{ name: 'mail.example-shop.pk', status: 'not_started' }] }), 'pending'],
    [resp(200, { data: [{ name: 'mail.example-shop.pk', status: 'temporary_failure' }] }), 'failed'],
    [resp(200, { data: [{ name: 'mail.example-shop.pk', status: 'weird' }] }), 'unknown'],
    [resp(200, { data: [{ name: 'someone-else.pk', status: 'verified' }] }), 'failed'],
    [resp(401, { message: 'invalid key' }), 'unknown'],
  ];
  for (const [answer, expected] of cases) {
    const { call } = setup({ fetchImpl: async () => answer });
    await call(CH.SAVE_EMAIL, GOOD_EMAIL);
    await call(CH.SET_KEY, { provider: 'resend', key: RKEY });
    assert.strictEqual((await call(CH.VERIFY, { provider: 'resend' })).data.status, expected);
  }
  // unreachable / 5xx: nothing is changed, the previous state stays
  for (const f of [async () => { throw new Error('ECONNRESET'); }, async () => resp(503, {})]) {
    const { call, store } = setup({ fetchImpl: f });
    await call(CH.SAVE_EMAIL, GOOD_EMAIL);
    await call(CH.SET_KEY, { provider: 'resend', key: RKEY });
    store.set('settings', { ...store.get('settings'), emailDomainVerification: 'verified', [CHECKED_AT.email]: '2026-10-01T00:00:00.000Z' });
    const r = await call(CH.VERIFY, { provider: 'resend' });
    assert.strictEqual(r.data.status, 'verified');
    assert.strictEqual(r.data.checkedAt, '2026-10-01T00:00:00.000Z');
    assert.match(r.data.message, /Nothing was changed/);
  }
});

test('11. Meta check: one GET to the phone-number object; verified only for OUR number, not restricted', async () => {
  const ok = { display_phone_number: '+92 300 1234567', code_verification_status: 'VERIFIED', status: 'CONNECTED', id: '123456789012345', verified_name: 'Secret Biz' };
  const { call, store, fetchLog } = setup({ fetchImpl: async () => resp(200, ok) });
  await call(CH.SAVE_WHATSAPP, GOOD_WA);
  await call(CH.SET_KEY, { provider: 'meta-cloud', key: MKEY });
  const r = await call(CH.VERIFY, { provider: 'meta-cloud' });
  assert.strictEqual(r.data.status, 'verified');
  scan(r, ['Secret Biz', 'CONNECTED', MKEY]);
  assert.strictEqual(fetchLog.length, 1);
  assert.ok(fetchLog[0].url.startsWith(`${META_GRAPH}/123456789012345?`), 'the same Graph version the sender uses');
  assert.strictEqual(fetchLog[0].init.method, 'GET');
  assert.strictEqual(store.get('settings').whatsappNumberVerification, 'verified');
  assert.strictEqual((await call(CH.STATUS, {})).data.whatsapp.capability.canSend, true);
  const map = [
    [{ ...ok, display_phone_number: '+92 300 7654321' }, 'failed'],
    [{ ...ok, status: 'BANNED' }, 'failed'],
    [{ ...ok, code_verification_status: 'NOT_VERIFIED' }, 'pending'],
    [{ ...ok, code_verification_status: 'EXPIRED' }, 'pending'],
    [{}, 'unknown'],
  ];
  for (const [b, expected] of map) assert.strictEqual(mod.mapMetaNumber(b, '+923001234567'), expected, JSON.stringify(b));
  for (const [status, expected] of [[404, 'failed'], [400, 'failed'], [401, 'unknown']]) {
    const t = setup({ fetchImpl: async () => resp(status, { error: { message: 'x' } }) });
    await t.call(CH.SAVE_WHATSAPP, GOOD_WA);
    await t.call(CH.SET_KEY, { provider: 'meta-cloud', key: MKEY });
    assert.strictEqual((await t.call(CH.VERIFY, { provider: 'meta-cloud' })).data.status, expected, String(status));
  }
});

test('12. verify refuses before any network call when the configuration is not ready', async () => {
  const { call, fetchLog } = setup({ fetchImpl: async () => resp(200, {}) });
  assert.match((await call(CH.VERIFY, { provider: 'resend' })).error.message, /domain first/);
  await call(CH.SAVE_EMAIL, GOOD_EMAIL);
  assert.match((await call(CH.VERIFY, { provider: 'resend' })).error.message, /API key first/);
  assert.match((await call(CH.VERIFY, { provider: 'meta-cloud' })).error.message, /sending number/);
  assert.strictEqual(fetchLog.length, 0);
});

test('13. every write notifies (for live apply); refused writes notify nobody', async () => {
  const { call, changes } = setup({ fetchImpl: async () => resp(200, { data: [] }) });
  await call(CH.SAVE_BUSINESS, { companyName: 'X' });
  await call(CH.SAVE_EMAIL, GOOD_EMAIL);
  await call(CH.SAVE_WHATSAPP, GOOD_WA);
  await call(CH.SET_KEY, { provider: 'resend', key: RKEY });
  await call(CH.CLEAR_KEY, { provider: 'resend' });
  await call(CH.SAVE_EMAIL, { ...GOOD_EMAIL, fromAddress: 'bad' });
  assert.deepStrictEqual(changes, ['business', 'email', 'whatsapp', 'email', 'email']);
});

test('14. IPC: trusted sender only, closed payloads, no key in any response', async () => {
  const { call, calls } = setup();
  for (const ch of Object.values(CH)) assert.strictEqual((await call(ch, {}, { untrusted: true })).ok, false, ch);
  assert.strictEqual((await call(CH.SAVE_BUSINESS, { companyName: 'x', apiKey: RKEY })).ok, false);
  assert.strictEqual((await call(CH.VERIFY, { provider: 'resend', url: 'http://evil' })).ok, false);
  await call(CH.SET_KEY, { provider: 'resend', key: RKEY });
  await call(CH.STATUS, {});
  scan(calls, [RKEY]);
});

test('15. no hard-coded identity, no polling, no send in the F26 sources', () => {
  for (const f of ['outreachSettings.js', 'outreach-settings-ipc.js']) {
    const src = fs.readFileSync(path.join(OUT, f), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.ok(!/zunitech|ztech\.|zee\b|\+92\d|@[a-z0-9-]+\.(com|pk)/i.test(code), f + ' holds no identity');
    assert.ok(!/setInterval/.test(code), f + ' never polls');
    assert.ok(!/method:\s*'POST'|\/messages\b|\/emails\b/.test(code), f + ' never sends');
  }
});

test('16. main.js registers the channels outside the LI-runtime guard; preload exposes write-only methods', () => {
  const ready = mainSource.slice(mainSource.indexOf('app.whenReady().then('), mainSource.indexOf("app.on('will-quit'"));
  assert.ok(ready.includes('registerOutreachSettingsIpcHandlers();'));
  const fn = mainSource.slice(mainSource.indexOf('function registerOutreachSettingsIpcHandlers('), mainSource.indexOf('function registerOpportunityIntelIpcHandlers('));
  assert.ok(!/if \(!leadIntelRuntime\) return/.test(fn));
  // F26 settings live on appAPI next to settings:save/load - NOT on the ztechLeadIntel
  // outreach bridge, whose F14-F19 guards forbid any provider/whatsapp surface.
  const start = preloadSource.indexOf('outreachSettings: Object.freeze({');
  const block = preloadSource.slice(start, preloadSource.indexOf('\n  }),', start));
  const appApi = preloadSource.slice(preloadSource.indexOf("exposeInMainWorld('appAPI'"), preloadSource.indexOf("exposeInMainWorld('ztechLeadIntel'"));
  assert.ok(appApi.includes('outreachSettings: Object.freeze({'), 'on appAPI');
  for (const m of ['status:', 'saveBusiness:', 'saveEmail:', 'saveWhatsApp:', 'setKey:', 'clearKey:', 'verify:']) assert.ok(block.includes(m), m);
  assert.ok(!/getKey|revealKey|readKey/.test(block));
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
