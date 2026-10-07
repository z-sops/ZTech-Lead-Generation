'use strict';

// F26.6 - Native Mailbox Transport: connect (Gmail, against a FAKE Google - no live call), the
// Microsoft fail-closed interface, MailboxService, the mailbox IPC surface, the market gate on every
// email path, and mailbox-source trust intake. Work-order test 1 (connect) plus tests 2-6 of the
// provider-independent part. Gmail send / read-back / sync wait for Step 1A and are NOT here.

const assert = require('assert');
const http = require('http');
const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..');
const LI = path.join(root, 'src', 'main', 'lead-intelligence');
const { MemoryStore } = require(path.join(LI, 'persistence', 'MemoryStore.js'));
const { MailboxService } = require(path.join(LI, 'mailbox', 'MailboxService.js'));
const { GoogleOAuth, GMAIL_SCOPES, GOOGLE } = require(path.join(LI, 'mailbox', 'gmail', 'GoogleOAuth.js'));
const { GraphMailboxTransport } = require(path.join(LI, 'mailbox', 'graph', 'GraphMailboxTransport.js'));
const { registerMailboxIpc, MAILBOX_CHANNELS_IPC } = require(path.join(LI, 'mailbox', 'mailbox-ipc.js'));
const { transportPolicyOf, TRUST_CODES } = require(path.join(LI, 'trust', 'TrustPolicy.js'));
const { LEAD_EMAIL, runtime, approved, iso, NOW, HOUR, reply, allowMarket, lead } = require('./f265-harness');
const { grantTrust } = require('./trust-fixture');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const CLIENT = Object.freeze({ clientId: '1234567890-abcdefg.apps.googleusercontent.com', clientSecret: 'GOCSPX-never-leaks-0001' });
const REFRESH = '1//refresh-token-never-leaks';
const ACCESS = 'ya29.access-token-never-leaks';
const SECRETS = [CLIENT.clientSecret, REFRESH, ACCESS];

/** A fake Google: token, revoke and profile endpoints. Records every call; no network. */
function fakeGoogle({ scope = GMAIL_SCOPES.join(' '), email = 'Dana@Ridgeline.Example', refresh = REFRESH, tokenStatus = 200 } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
    if (String(url) === GOOGLE.TOKEN_URL) {
      const form = new URLSearchParams(init.body);
      if (tokenStatus !== 200) return json(tokenStatus, { error: 'invalid_grant', error_description: 'REMOTE TEXT MUST NOT LEAK' });
      if (form.get('grant_type') === 'authorization_code') {
        assert.strictEqual(form.get('code'), 'auth-code-xyz');
        assert.ok(/^[A-Za-z0-9_-]{43,128}$/.test(form.get('code_verifier')), 'a PKCE verifier is sent to the token endpoint');
        assert.ok(/^http:\/\/127\.0\.0\.1:\d+$/.test(form.get('redirect_uri')), 'loopback redirect');
        return json(200, { access_token: ACCESS, refresh_token: refresh || undefined, scope, token_type: 'Bearer', expires_in: 3599 });
      }
      return json(200, { access_token: ACCESS, scope, expires_in: 3599 });
    }
    if (String(url).startsWith(GOOGLE.REVOKE_URL)) return json(200, {});
    if (String(url) === `${GOOGLE.GMAIL_API}/profile`) {
      assert.strictEqual(init.headers.Authorization, `Bearer ${ACCESS}`);
      return json(200, { emailAddress: email, messagesTotal: 1, historyId: '123' });
    }
    return json(404, {});
  };
  return { fetch, calls };
}

/** The "browser": follows the consent URL straight to the loopback redirect, as Google would. */
function fakeBrowser({ tamperState = false, deny = false } = {}) {
  const opened = [];
  const open = (url) => {
    opened.push(url);
    const u = new URL(url);
    const redirect = u.searchParams.get('redirect_uri');
    const state = tamperState ? 'forged' : u.searchParams.get('state');
    const q = deny ? `error=access_denied&state=${state}` : `code=auth-code-xyz&state=${state}`;
    setImmediate(() => {
      http.get(`${redirect}/favicon.ico`, (r) => r.resume()).on('error', () => {});
      http.get(`${redirect}/?${q}`, (r) => r.resume()).on('error', () => {});
    });
  };
  return { open, opened };
}

function memTokens() {
  const m = new Map();
  return { m, get: (id) => m.get(id) || null, set: (id, t) => { m.set(id, t); }, remove: (id) => { m.delete(id); } };
}
function memClient(initial = CLIENT) {
  let v = initial;
  return { get: () => v, set: (x) => { v = x; }, clear: () => { v = null; } };
}

function service({ google = fakeGoogle(), browser = fakeBrowser(), client = memClient(), store = new MemoryStore(), now = () => new Date(NOW), tokens = memTokens(), timeoutMs = 3000 } = {}) {
  const svc = new MailboxService({
    store, clock: now, tokenStore: tokens, clientConfig: client, fetch: google.fetch,
    googleOAuth: new GoogleOAuth({ fetch: google.fetch, openExternal: browser.open, timeoutMs }),
    operator: 'Zee', defaultTimeZone: 'Asia/Karachi',
  });
  return { svc, tokens, google, browser, store, client };
}

function ipcFor(svc, { trusted = true } = {}) {
  const handlers = {};
  const logs = [];
  registerMailboxIpc({ ipcMain: { handle: (c, f) => { handlers[c] = f; } }, mailboxes: svc, isTrustedSender: () => trusted, logger: { warn: (m) => logs.push(m) } });
  return { call: (ch, p) => handlers[ch]({}, p), handlers, logs };
}

const noSecret = (obj, label) => {
  const json = JSON.stringify(obj);
  for (const s of SECRETS) assert.ok(!json.includes(s), `${label}: carries no secret`);
  assert.ok(!/refresh_?token|access_?token|code_verifier|client_?secret/i.test(json), `${label}: no secret-shaped key`);
};

/* ============================== test 1: connect ============================== */

test('1a. Gmail connect: system browser + loopback 127.0.0.1 + PKCE S256 + state; token sealed in main; the record is sanitized and NOT Ready', async () => {
  const { svc, tokens, google, browser } = service();
  const view = await svc.connect({ provider: 'gmail' });
  assert.strictEqual(browser.opened.length, 1);
  const u = new URL(browser.opened[0]);
  assert.strictEqual(u.origin + u.pathname, GOOGLE.AUTH_URL);
  assert.strictEqual(u.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(/^[A-Za-z0-9_-]{43}$/.test(u.searchParams.get('code_challenge')));
  assert.ok(u.searchParams.get('state').length >= 32);
  assert.deepStrictEqual(u.searchParams.get('scope').split(' '), [...GMAIL_SCOPES], 'exactly gmail.send + gmail.metadata');
  assert.ok(!/readonly|modify|mail\.google\.com|compose/.test(u.searchParams.get('scope')), 'no broader Gmail scope');
  assert.ok(/^http:\/\/127\.0\.0\.1:\d+$/.test(u.searchParams.get('redirect_uri')));
  assert.ok(!u.searchParams.has('client_secret'), 'the secret is never in the browser URL');
  assert.strictEqual(view.emailAddress, 'dana@ridgeline.example');
  assert.strictEqual(view.status, 'needs_check', 'a connected mailbox is not Ready until its Check mailbox passes');
  assert.strictEqual(view.statusCode, 'MAILBOX_PROVIDER_STEP1_PENDING');
  assert.strictEqual(view.isDefault, true);
  assert.strictEqual(view.limits.timeZone, 'Asia/Karachi');
  assert.ok(/^mbx_[a-f0-9]{24}$/.test(view.mailboxId));
  assert.strictEqual(tokens.m.get(view.mailboxId), REFRESH, 'the refresh token went to the main-only token store');
  noSecret(view, 'connect result');
  assert.deepStrictEqual(google.calls.map((c) => c.url), [GOOGLE.TOKEN_URL, `${GOOGLE.GMAIL_API}/profile`], 'token exchange, then getProfile - nothing else, no send');
});

test('1b. Microsoft connect is refused with MAILBOX_PROVIDER_UNVERIFIED before any OAuth step: no browser, no scope, no network', async () => {
  const { svc, google, browser } = service();
  await assert.rejects(svc.connect({ provider: 'microsoft365' }), (e) => e.code === 'MAILBOX_PROVIDER_UNVERIFIED' && e.message === 'Microsoft 365 — verification required before activation');
  assert.strictEqual(browser.opened.length, 0, 'no browser opened');
  assert.strictEqual(google.calls.length, 0, 'nothing contacted');
  const src = fs.readFileSync(path.join(LI, 'mailbox', 'graph', 'GraphMailboxTransport.js'), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.ok(!/Mail\.(Send|Read|ReadBasic|ReadWrite)|graph\.microsoft\.com|login\.microsoftonline|fetch|scope/i.test(src), 'the Graph transport requests no scope and reaches no endpoint');
  const ipc = ipcFor(svc);
  const r = await ipc.call(MAILBOX_CHANNELS_IPC.CONNECT, { provider: 'microsoft365' });
  assert.deepStrictEqual(r, { ok: false, error: { code: 'MAILBOX_PROVIDER_UNVERIFIED', message: 'Microsoft 365 — verification required before activation' } });
});

test('1c. Microsoft exposes identity and interface only: not live, no transport policy (strict default), every method refuses', async () => {
  const g = new GraphMailboxTransport();
  assert.strictEqual(g.id, 'microsoft365');
  assert.strictEqual(g.live, false, 'the F19 capability interlock refuses it before any trust check');
  assert.ok(!Object.getOwnPropertyNames(GraphMailboxTransport.prototype).includes('transportPolicy'), 'it declares no unsubscribe-header or cold-email claim of its own');
  assert.deepStrictEqual(transportPolicyOf(g), { requiresPriorRelationship: true, enforcesUnsubscribeHeaders: true }, 'so the strict default applies');
  assert.deepStrictEqual({ ...g.capability }, { code: 'MAILBOX_PROVIDER_UNVERIFIED', canConnect: false, canSend: false, canSyncReplies: false, unsubscribeHeaderSupport: 'unknown' });
  for (const m of ['connect', 'send', 'syncReplies']) await assert.rejects(g[m]({}), (e) => e.code === 'MAILBOX_PROVIDER_UNVERIFIED', m);
  assert.strictEqual(g.validate({}).valid, false);
});

test('1d. a grant missing a scope, a refused consent, a forged state and a missing client are refused; nothing is stored', async () => {
  const partial = service({ google: fakeGoogle({ scope: GMAIL_SCOPES[0] }) });
  await assert.rejects(partial.svc.connect({ provider: 'gmail' }), (e) => e.code === 'MAILBOX_SCOPE_MISSING');
  assert.strictEqual(partial.tokens.m.size, 0);
  assert.ok(partial.google.calls.some((c) => c.url.startsWith(GOOGLE.REVOKE_URL)), 'the partial grant is revoked');
  assert.strictEqual((await partial.store.mailboxes.list()).length, 0);

  const denied = service({ browser: fakeBrowser({ deny: true }) });
  await assert.rejects(denied.svc.connect({ provider: 'gmail' }), (e) => e.code === 'MAILBOX_AUTH_REFUSED');
  // A request with a forged state is ignored (400), so it can neither complete nor cancel the
  // sign-in; the wait ends at the timeout.
  const forged = service({ browser: fakeBrowser({ tamperState: true }), timeoutMs: 400 });
  await assert.rejects(forged.svc.connect({ provider: 'gmail' }), (e) => e.code === 'MAILBOX_AUTH_TIMEOUT');
  assert.strictEqual(forged.google.calls.length, 0, 'a forged state never reaches the token endpoint');

  const noClient = service({ client: memClient(null) });
  await assert.rejects(noClient.svc.connect({ provider: 'gmail' }), (e) => e.code === 'MAILBOX_CLIENT_NOT_CONFIGURED');
  assert.strictEqual(noClient.browser.opened.length, 0);

  const noRefresh = service({ google: fakeGoogle({ refresh: null }) });
  await assert.rejects(noRefresh.svc.connect({ provider: 'gmail' }), (e) => e.code === 'MAILBOX_AUTH_FAILED');
  assert.strictEqual(noRefresh.tokens.m.size, 0);
});

test('1e. reconnecting the same address reuses its mailbox_id; disconnect revokes, forgets the token and removes the row', async () => {
  const { svc, tokens, google } = service();
  const a = await svc.connect({ provider: 'gmail' });
  const b = await svc.connect({ provider: 'gmail' });
  assert.strictEqual(b.mailboxId, a.mailboxId);
  assert.strictEqual(tokens.m.size, 1);
  const r = await svc.disconnect({ mailboxId: a.mailboxId });
  assert.deepStrictEqual(r, { mailboxId: a.mailboxId, disconnected: true });
  const revoke = google.calls.find((c) => c.url.startsWith(GOOGLE.REVOKE_URL));
  assert.ok(revoke && new URLSearchParams(revoke.init.body).get('token') === REFRESH, 'the refresh token is revoked at Google');
  assert.strictEqual(tokens.m.size, 0);
  assert.deepStrictEqual(await svc.list(), []);
  await assert.rejects(svc.disconnect({ mailboxId: a.mailboxId }), (e) => e.code === 'MAILBOX_NOT_FOUND');
});

test('1f. only one sign-in at a time; a second Connect while the browser is open is refused', async () => {
  let release;
  const slow = { opened: [], open: (url) => { slow.opened.push(url); release = () => fakeBrowser().open(url); } };
  const { svc } = service({ browser: slow });
  const first = svc.connect({ provider: 'gmail' });
  await new Promise((r) => setTimeout(r, 20));
  await assert.rejects(svc.connect({ provider: 'gmail' }), (e) => e.code === 'MAILBOX_CONNECT_IN_PROGRESS');
  release();
  await first;
});

test('1g. secure storage: no vault = refused before any consent; a failed save revokes the grant and leaves no orphan; an unreadable token never blocks disconnect', async () => {
  const noVault = memTokens();
  noVault.available = () => false;
  const a = service({ tokens: noVault });
  await assert.rejects(a.svc.connect({ provider: 'gmail' }), (e) => e.code === 'MAILBOX_VAULT_UNAVAILABLE');
  assert.strictEqual(a.browser.opened.length, 0, 'no consent is asked for a token that could not be kept');

  const failing = memTokens();
  failing.set = () => { throw new Error('vault: encryption failed'); };
  const b = service({ tokens: failing });
  await assert.rejects(b.svc.connect({ provider: 'gmail' }), (e) => e.code === 'MAILBOX_CONNECT_FAILED' && !/vault/.test(e.message));
  assert.ok(b.google.calls.some((c) => c.url.startsWith(GOOGLE.REVOKE_URL) && new URLSearchParams(c.init.body).get('token') === REFRESH), 'the new grant is revoked');
  assert.deepStrictEqual(await b.svc.list(), []);

  const c = service();
  const m = await c.svc.connect({ provider: 'gmail' });
  c.tokens.get = () => { throw new Error('vault: decryption failed'); };
  assert.deepStrictEqual(await c.svc.disconnect({ mailboxId: m.mailboxId }), { mailboxId: m.mailboxId, disconnected: true });
  assert.deepStrictEqual(await c.svc.list(), []);
});

test('1h. a reconnect that issues a new refresh token revokes the superseded one', async () => {
  const store = new MemoryStore();
  const tokens = memTokens();
  const first = service({ store, tokens, google: fakeGoogle({ refresh: '1//first-grant' }) });
  const m = await first.svc.connect({ provider: 'gmail' });
  const second = service({ store, tokens, google: fakeGoogle({ refresh: '1//second-grant' }) });
  await second.svc.connect({ provider: 'gmail' });
  assert.strictEqual(tokens.m.get(m.mailboxId), '1//second-grant');
  assert.ok(second.google.calls.some((c) => c.url.startsWith(GOOGLE.REVOKE_URL) && new URLSearchParams(c.init.body).get('token') === '1//first-grant'));
});

/* ======================== 2-3. capability, readiness, pacing ======================== */

test('2. the send gate: Gmail is refused while Step 1A is pending even for a Ready mailbox; then status; then pacing', async () => {
  const { svc, store } = service();
  const m = await svc.connect({ provider: 'gmail' });
  let g = await svc.sendGate(m.mailboxId);
  assert.strictEqual(g.allowed, false);
  assert.strictEqual(g.code, 'MAILBOX_PROVIDER_STEP1_PENDING', 'capability first: no Gmail mailbox sends before Step 1A');
  await store.mailboxes.setStatus(m.mailboxId, { status: 'ready', status_code: null, updated_at: iso(NOW) });
  g = await svc.sendGate(m.mailboxId);
  assert.strictEqual(g.code, 'MAILBOX_PROVIDER_STEP1_PENDING', 'a Ready status cannot override provider capability');
});

test('3. pacing is keyed by mailbox_id: one mailbox at its cap never blocks another; counts come from the ledger', async () => {
  const store = new MemoryStore();
  const now = () => new Date('2026-10-07T06:00:00.000Z'); // 11:00 Karachi, Wednesday
  const a = service({ store, now, google: fakeGoogle({ email: 'a@ridgeline.example' }) });
  const ma = await a.svc.connect({ provider: 'gmail' });
  const b = service({ store, now, google: fakeGoogle({ email: 'b@ridgeline.example' }) });
  const mb = await b.svc.connect({ provider: 'gmail' });
  await a.svc.setLimits({ mailboxId: ma.mailboxId, limits: { dailyCap: 1, hourlyCap: 1 } });
  await store.sends.record({ send_id: 's1', lead_id: 'L1', pitch_id: 'p1', channel: 'email', content_hash: 'h'.repeat(64), idempotency_key: 'k1', state: 'attempted', provider_id: 'gmail', provider_message_id: null, mailbox_id: ma.mailboxId, created_at: '2026-10-07T05:59:00.000Z', updated_at: '2026-10-07T05:59:00.000Z' });
  const [va, vb] = await Promise.all([a.svc.get(ma.mailboxId), a.svc.get(mb.mailboxId)]);
  assert.strictEqual(va.pacing.allowed, false);
  assert.strictEqual(va.pacing.reason, 'daily_cap');
  assert.strictEqual(va.pacing.sentToday, 1);
  assert.ok(va.pacing.nextAllowedAt);
  assert.strictEqual(vb.pacing.allowed, true, 'the other mailbox is unaffected');
  assert.strictEqual(vb.pacing.sentToday, 0);
});

test('3b. limits from the renderer: camelCase only, ZTech maximums enforced, hourly never above daily', async () => {
  const { svc } = service();
  const m = await svc.connect({ provider: 'gmail' });
  const ok = await svc.setLimits({ mailboxId: m.mailboxId, limits: { dailyCap: 50, hourlyCap: 10, minGapSeconds: 120, windowStart: '10:00', windowEnd: '16:00', windowDays: '1,2,3', timeZone: 'Europe/London' } });
  assert.deepStrictEqual(ok.limits, { dailyCap: 50, hourlyCap: 10, minGapSeconds: 120, windowStart: '10:00', windowEnd: '16:00', windowDays: '1,2,3', timeZone: 'Europe/London' });
  for (const bad of [{ dailyCap: 201 }, { hourlyCap: 11, dailyCap: 10 }, { minGapSeconds: 30 }, { daily_cap: 5 }, { timeZone: 'Nowhere/Land' }, { status: 'ready' }]) {
    await assert.rejects(svc.setLimits({ mailboxId: m.mailboxId, limits: bad }), (e) => e.code === 'VALIDATION_FAILED', JSON.stringify(bad));
  }
});

/* ============================ 4. IPC surface ============================ */

test('4a. IPC: untrusted senders are refused; schemas are closed; there is no send channel', async () => {
  const { svc } = service();
  const untrusted = ipcFor(svc, { trusted: false });
  for (const ch of Object.values(MAILBOX_CHANNELS_IPC)) {
    const r = await untrusted.call(ch, {});
    assert.strictEqual(r.ok, false, ch);
    assert.strictEqual(r.error.code, 'FORBIDDEN', ch);
  }
  const ipc = ipcFor(svc);
  assert.strictEqual((await ipc.call(MAILBOX_CHANNELS_IPC.LIST, { extra: 1 })).ok, false, 'closed schema');
  assert.strictEqual((await ipc.call(MAILBOX_CHANNELS_IPC.CONNECT, { provider: 'gmail', token: 'x' })).ok, false, 'a token key is refused');
  assert.strictEqual((await ipc.call(MAILBOX_CHANNELS_IPC.CONNECT, { provider: 'smtp' })).ok, false);
  assert.strictEqual((await ipc.call(MAILBOX_CHANNELS_IPC.LIMITS, { mailboxId: 'mbx_aaaaaaaaaaaa', limits: { dailyCap: 500 } })).ok, false);
  assert.ok(!Object.values(MAILBOX_CHANNELS_IPC).some((c) => /send|sync|queue|schedule|batch/.test(c)), 'no send, sync, queue or schedule channel');
});

test('4b. IPC: the Google client secret goes in once and never comes back - not in a result, an error or a log', async () => {
  const { svc, client } = service({ client: memClient(null) });
  const ipc = ipcFor(svc);
  const set = await ipc.call(MAILBOX_CHANNELS_IPC.GOOGLE_CLIENT, { ...CLIENT });
  assert.deepStrictEqual(set, { ok: true, data: { clientConfigured: true, clientId: CLIENT.clientId } });
  assert.strictEqual(client.get().clientSecret, CLIENT.clientSecret, 'stored in main');
  const caps = await ipc.call(MAILBOX_CHANNELS_IPC.CAPABILITIES, {});
  assert.strictEqual(caps.ok, true);
  assert.deepStrictEqual(caps.data.map((p) => [p.provider, p.canConnect, p.canSend, p.canSyncReplies, p.unsubscribeHeaderSupport]), [['gmail', true, false, false, 'unknown'], ['microsoft365', false, false, false, 'unknown']]);
  assert.strictEqual(caps.data[1].notice, 'Microsoft 365 — verification required before activation');
  const bad = await ipc.call(MAILBOX_CHANNELS_IPC.GOOGLE_CLIENT, { clientId: 'not-a-client', clientSecret: CLIENT.clientSecret });
  assert.strictEqual(bad.ok, false);
  const both = await ipc.call(MAILBOX_CHANNELS_IPC.GOOGLE_CLIENT, { clear: true, clientSecret: CLIENT.clientSecret });
  assert.strictEqual(both.ok, false);
  const m = await ipc.call(MAILBOX_CHANNELS_IPC.CONNECT, { provider: 'gmail' });
  const list = await ipc.call(MAILBOX_CHANNELS_IPC.LIST, {});
  for (const [label, v] of [['set', set], ['caps', caps], ['bad', bad], ['both', both], ['connect', m], ['list', list], ['logs', ipc.logs]]) noSecret(v, label);
  const cleared = await ipc.call(MAILBOX_CHANNELS_IPC.GOOGLE_CLIENT, { clear: true });
  assert.deepStrictEqual(cleared.data, { clientConfigured: false, clientId: null });
});

test('4c. a Google error never surfaces remote text; an invalid_grant asks for a reconnect', async () => {
  const g = fakeGoogle({ tokenStatus: 400 });
  const oauth = new GoogleOAuth({ fetch: g.fetch, openExternal: () => {} });
  await assert.rejects(oauth.accessToken({ ...CLIENT, refreshToken: REFRESH }), (e) => e.code === 'MAILBOX_RECONNECT_NEEDED' && !/REMOTE TEXT/.test(e.message));
  const { svc } = service({ google: fakeGoogle({ tokenStatus: 400 }) });
  const r = await ipcFor(svc).call(MAILBOX_CHANNELS_IPC.CONNECT, { provider: 'gmail' });
  assert.strictEqual(r.ok, false);
  assert.ok(!/REMOTE TEXT/.test(JSON.stringify(r)));
});

test('4d. the renderer bridge and main.js keep secrets in main: sealed storage, Google-only opener, no mailbox send method', () => {
  const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
  const block = preload.slice(preload.indexOf('mailboxes: Object.freeze({'), preload.indexOf('\n  }),', preload.indexOf('mailboxes: Object.freeze({')));
  const methods = [...block.matchAll(/(\w+):\s*\(/g)].map((m) => m[1]);
  assert.deepStrictEqual(methods, ['capabilities', 'list', 'connect', 'disconnect', 'setDefault', 'setLimits', 'setGoogleClient', 'marketRules', 'setMarketRule', 'removeMarketRule']);
  assert.ok(!methods.some((m) => /send|sync|token|secret/i.test(m)));
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const deps = main.slice(main.indexOf('function mailboxDepsFromStore()'), main.indexOf('/**', main.indexOf('function mailboxDepsFromStore()')));
  assert.ok(/credentialVault\.seal\(String\(refreshToken\)\)/.test(deps), 'refresh tokens are sealed');
  assert.ok(/clientSecret: credentialVault\.seal\(clientSecret\)/.test(deps), 'the client secret is sealed');
  assert.ok(!/logger\./.test(deps), 'nothing in the token/secret path is logged');
});

/* ======================= 5. market gate on every email path ======================= */

test('5a. market gate: no rule / unknown country = consent required, on the provider send AND the handoff', async () => {
  const o = { urls: [], open: (u) => { o.urls.push(u); } };
  const rt = runtime({ openExternal: o.open, leads: { L1: lead({ country: 'Atlantis' }) } });
  const pitch = await approved(rt.li);
  await assert.rejects(rt.li.outreach.handoff({ pitchId: pitch.pitch_id, kind: 'mailto' }), (e) => e.code === TRUST_CODES.MARKET);
  await allowMarket(rt.store, 'US');
  await assert.rejects(rt.li.outreach.handoff({ pitchId: pitch.pitch_id, kind: 'mailto' }), (e) => e.code === TRUST_CODES.MARKET, 'a US rule never applies to an unrecognised country');
  const prep = await rt.li.outreach.prepare({ pitchId: pitch.pitch_id, channel: 'email' });
  assert.deepStrictEqual(prep.trust.market, { countryCode: null, rule: 'consent_required', reviewed: false });
  assert.strictEqual(o.urls.length, 0);
});

test('5b. a reviewed consent_required rule stays strict; opt_out_allowed passes; consent passes anywhere', async () => {
  const o = { urls: [], open: (u) => { o.urls.push(u); } };
  const rt = runtime({ openExternal: o.open });
  const pitch = await approved(rt.li);
  await rt.store.marketRules.set({ country_code: 'US', rule: 'consent_required', note: 'Reviewed: stay strict', reviewed_by: 'Zee', reviewed_at: iso(NOW - HOUR) });
  await assert.rejects(rt.li.outreach.handoff({ pitchId: pitch.pitch_id, kind: 'copy' }), (e) => e.code === TRUST_CODES.MARKET);
  await grantTrust(rt.store, { email: LEAD_EMAIL, now: iso(NOW - HOUR) });
  const r = await rt.li.outreach.handoff({ pitchId: pitch.pitch_id, kind: 'copy' });
  assert.strictEqual(r.sent, false, 'a recorded consent satisfies the market gate in any market');
});

test('5c. a verified reply from a connected mailbox (source "mailbox") counts; a user-entered one never does', async () => {
  const o = { urls: [], open: (u) => { o.urls.push(u); } };
  const rt = runtime({ openExternal: o.open });
  const pitch = await approved(rt.li);
  await reply(rt.store, { source: 'user' });
  await assert.rejects(rt.li.outreach.handoff({ pitchId: pitch.pitch_id, kind: 'copy' }), (e) => e.code === TRUST_CODES.MARKET);
  await reply(rt.store, { source: 'mailbox' });
  const r = await rt.li.outreach.handoff({ pitchId: pitch.pitch_id, kind: 'copy' });
  assert.strictEqual(r.sent, false);
  const lt = await rt.li.trust.leadTrust({ leadId: 'L1' });
  assert.ok(lt.channels.email.verifiedReply, 'the lead trust view shows the verified mailbox reply');
});

test('5d. order: transport before market - Resend with no consent still says EMAIL_TRANSPORT_NOT_ALLOWED_FOR_COLD', async () => {
  const rt = runtime();
  const pitch = await approved(rt.li);
  await assert.rejects(rt.li.outreach.send({ pitchId: pitch.pitch_id, channel: 'email' }), (e) => e.code === TRUST_CODES.EMAIL_COLD);
  const rows = (await rt.li.outreach.activityList({ limit: 10 })).rows.filter((r) => r.activity_type === 'OUTREACH_SEND_BLOCKED');
  assert.strictEqual(rows.length, 1);
});

test('5e. market rules from Settings: the reviewer is the operator (never the renderer); a note is required', async () => {
  const { svc } = service();
  const ipc = ipcFor(svc);
  const r = await ipc.call(MAILBOX_CHANNELS_IPC.MARKET_SET, { countryCode: 'gb', rule: 'consent_required', note: 'PECR: consent for individuals' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.data.reviewedBy, 'Zee');
  assert.strictEqual(r.data.countryCode, 'GB');
  assert.strictEqual((await ipc.call(MAILBOX_CHANNELS_IPC.MARKET_SET, { countryCode: 'GB', rule: 'opt_out_allowed', note: 'x', reviewedBy: 'someone' })).ok, false, 'reviewedBy is not accepted from the renderer');
  assert.strictEqual((await ipc.call(MAILBOX_CHANNELS_IPC.MARKET_SET, { countryCode: 'GB', rule: 'cold_ok', note: 'reviewed' })).ok, false);
  assert.deepStrictEqual((await ipc.call(MAILBOX_CHANNELS_IPC.MARKET_LIST, {})).data.map((x) => x.countryCode), ['GB']);
  assert.deepStrictEqual((await ipc.call(MAILBOX_CHANNELS_IPC.MARKET_REMOVE, { countryCode: 'GB' })).data, { countryCode: 'GB', removed: true });
});

/* ===================== 6. mailbox-source trust intake (main-only) ===================== */

test('6a. a mailbox reply counts ONLY when it cites a provider-STORED Message-ID of that mailbox; an unsubscribe reply suppresses (source mailbox); idempotent', async () => {
  const rt = runtime();
  const base = { kind: 'reply', channel: 'email', address: LEAD_EMAIL, received_at: iso(NOW - HOUR), mailbox_id: 'mbx_aaaaaaaaaaaa' };
  // Nothing stored yet: same sender, plausible references - still not a reply.
  let r = await rt.li.trust.intake({ ...base, event_id: 'mbxevt_0', reference_ids: ['<ztech-supplied@ridgeline.example>'] }, { source: 'mailbox' });
  assert.deepStrictEqual(r, { accepted: false, state: 'rejected', code: 'REPLY_NOT_MATCHED' });
  await rt.store.mailboxSent.record({ send_id: 's1', mailbox_id: 'mbx_aaaaaaaaaaaa', provider_message_id: '18c', stored_message_id: '<CAstored@mail.gmail.com>', thread_id: 't1', recorded_at: iso(NOW - 2 * HOUR) });
  r = await rt.li.trust.intake({ ...base, event_id: 'mbxevt_00', reference_ids: ['<ztech-supplied@ridgeline.example>'] }, { source: 'mailbox' });
  assert.strictEqual(r.code, 'REPLY_NOT_MATCHED', 'the id ZTech attempted is never trusted');
  r = await rt.li.trust.intake({ ...base, event_id: 'mbxevt_01', mailbox_id: 'mbx_bbbbbbbbbbbb', reference_ids: ['<CAstored@mail.gmail.com>'] }, { source: 'mailbox' });
  assert.strictEqual(r.code, 'REPLY_NOT_MATCHED', 'another mailbox\'s stored id never matches');
  const r1 = await rt.li.trust.intake({ ...base, event_id: 'mbxevt_1', reference_ids: ['<other@x>', '<CAstored@mail.gmail.com>'] }, { source: 'mailbox' });
  assert.deepStrictEqual(r1, { accepted: true, state: 'stored' });
  const r2 = await rt.li.trust.intake({ event_id: 'mbxevt_2', kind: 'unsubscribe', channel: 'email', address: LEAD_EMAIL, received_at: iso(NOW - HOUR) }, { source: 'mailbox' });
  assert.strictEqual(r2.state, 'applied');
  const sup = await rt.store.suppressions.find({ channel: 'email', address: LEAD_EMAIL.toLowerCase(), workspaceId: 'default' });
  assert.ok(sup, 'suppressed');
  assert.strictEqual(sup.source, 'mailbox', 'recorded with its true source');
  const again = await rt.li.trust.intake({ event_id: 'mbxevt_2', kind: 'unsubscribe', channel: 'email', address: LEAD_EMAIL, received_at: iso(NOW - HOUR) }, { source: 'mailbox' });
  assert.strictEqual(again.duplicate, true);
});

test('6b. a mailbox can never report a bounce, a complaint or a WhatsApp event (bounces are deferred)', async () => {
  const rt = runtime();
  for (const [kind, channel] of [['bounce', 'email'], ['complaint', 'email'], ['whatsapp_inbound', 'whatsapp'], ['reply', 'whatsapp']]) {
    const r = await rt.li.trust.intake({ event_id: 'mbxevt_' + kind + channel, kind, channel, address: channel === 'email' ? LEAD_EMAIL : '+923001234567', received_at: iso(NOW - HOUR) }, { source: 'mailbox' });
    assert.strictEqual(r.accepted, false, kind + '/' + channel);
  }
  assert.strictEqual(await rt.store.suppressions.find({ channel: 'email', address: LEAD_EMAIL.toLowerCase(), workspaceId: 'default' }), null);
});

test('6c. no renderer path can claim source "mailbox": the trust IPC never forwards a source', () => {
  const src = fs.readFileSync(path.join(LI, 'trust', 'trust-ipc.js'), 'utf8');
  assert.ok(!/'mailbox'/.test(src) && !/source\s*:/.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '').replace(/source:\s*'user'/g, '')), 'the trust IPC sets no mailbox source');
  const mipc = fs.readFileSync(path.join(LI, 'mailbox', 'mailbox-ipc.js'), 'utf8');
  assert.ok(!/intake/.test(mipc), 'the mailbox IPC cannot write trust events');
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
