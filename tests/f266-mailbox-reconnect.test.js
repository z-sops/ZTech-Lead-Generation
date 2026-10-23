'use strict';

// F26.6 acceptance fix (15 Oct 2026) - Gmail RECONNECT semantics, against a Google fake that models
// the behaviour the earlier fakes did not: revocation is GRANT-WIDE. Google: "Revocation removes all
// OAuth 2.0 scopes previously granted to a project, invalidating any issued access or refresh tokens".
//
// Observed on Windows: the Testing-mode refresh token expired after 7 days -> Reconnect needed ->
// Connect Gmail (new refresh token) -> Needs check -> Check mailbox -> Reconnect needed again,
// because _connectGmail revoked the superseded token, which ended the grant the NEW token belonged to.
//
// Covers: A-H of the acceptance work order (old token, reconnect, persistence, no revoke, needs_check,
// Check exchanges the new token, Ready, restart), explicit Disconnect, connect-persistence failure,
// token read-back, the access-token cache, and vault read failures that must not look like an
// expired Google sign-in.

const assert = require('assert');
const http = require('http');
const path = require('path');

const root = path.join(__dirname, '..');
const LI = path.join(root, 'src', 'main', 'lead-intelligence');
const { MemoryStore } = require(path.join(LI, 'persistence', 'MemoryStore.js'));
const { MailboxService } = require(path.join(LI, 'mailbox', 'MailboxService.js'));
const { GoogleOAuth, GMAIL_SCOPES, GOOGLE } = require(path.join(LI, 'mailbox', 'gmail', 'GoogleOAuth.js'));
const { createMailboxPersistence } = require(path.join(LI, 'mailbox', 'mailboxPersistence.js'));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const CLIENT = Object.freeze({ clientId: '1234567890-abcdefg.apps.googleusercontent.com', clientSecret: 'GOCSPX-never-leaks-0002' });
const EMAIL = 'dana@ridgeline.example';
const NOW = Date.parse('2026-10-15T07:00:00.000Z'); // 12:00 Karachi, Thursday

/**
 * A Google that keeps GRANTS: one grant per (client, account) consent. Every refresh token belongs to
 * a grant; revoking ANY token of a grant invalidates every token of that grant (as Google documents).
 * A token can also expire on its own (Testing mode: 7 days). Gmail endpoints accept an access token
 * only while its grant is alive. Records every call; no network.
 */
function grantGoogle() {
  const st = { calls: [], grants: [], n: 0, sent: new Map(), expired: new Set() };
  const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const grantOf = (tok) => st.grants.find((g) => g.refresh.has(tok) || g.access.has(tok));
  const live = (tok) => { const g = grantOf(tok); return Boolean(g && g.alive && !st.expired.has(tok)); };
  st.issueRefreshTokens = () => [...st.grants.flatMap((g) => [...g.refresh])];
  st.expire = (tok) => st.expired.add(tok);
  st.revokes = () => st.calls.filter((c) => c.url.startsWith(GOOGLE.REVOKE_URL)).map((c) => new URLSearchParams(c.init.body).get('token'));
  st.refreshes = () => st.calls.filter((c) => c.url === GOOGLE.TOKEN_URL && new URLSearchParams(c.init.body).get('grant_type') === 'refresh_token')
    .map((c) => new URLSearchParams(c.init.body).get('refresh_token'));
  st.fetch = async (url, init = {}) => {
    const u = String(url);
    st.calls.push({ url: u, init });
    if (u === GOOGLE.TOKEN_URL) {
      const f = new URLSearchParams(init.body);
      if (f.get('grant_type') === 'authorization_code') {
        // A new consent after a revoke (or the first one) creates a fresh live grant.
        let g = st.grants.find((x) => x.alive);
        if (!g) { g = { alive: true, refresh: new Set(), access: new Set() }; st.grants.push(g); }
        st.n += 1;
        const refresh = `1//refresh-${st.n}-never-leaks`;
        const access = `ya29.access-${st.n}-never-leaks`;
        g.refresh.add(refresh); g.access.add(access);
        return json(200, { access_token: access, refresh_token: refresh, scope: GMAIL_SCOPES.join(' '), token_type: 'Bearer', expires_in: 3599 });
      }
      const rt = f.get('refresh_token');
      if (!live(rt)) return json(400, { error: 'invalid_grant', error_description: 'REMOTE TEXT MUST NOT LEAK' });
      st.n += 1;
      const access = `ya29.access-${st.n}-never-leaks`;
      grantOf(rt).access.add(access);
      return json(200, { access_token: access, scope: GMAIL_SCOPES.join(' '), expires_in: 3599 });
    }
    if (u.startsWith(GOOGLE.REVOKE_URL)) {
      const g = grantOf(new URLSearchParams(init.body).get('token'));
      if (g) g.alive = false; // GRANT-WIDE: every refresh and access token of this grant dies
      return json(200, {});
    }
    const bearer = String((init.headers && init.headers.Authorization) || '').replace(/^Bearer /, '');
    if (!live(bearer)) return json(401, { error: { errors: [{ reason: 'authError', message: 'REMOTE TEXT' }] } });
    const api = u.slice(GOOGLE.GMAIL_API.length);
    if (api === '/profile') return json(200, { emailAddress: 'Dana@Ridgeline.Example', historyId: '900' });
    if (api === '/messages/send') {
      const raw = JSON.parse(init.body).raw;
      const text = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      const headers = {};
      for (const line of text.split('\r\n\r\n')[0].split('\r\n')) { const i = line.indexOf(':'); headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim(); }
      const id = `msg${st.sent.size + 1}`;
      st.sent.set(id, { ...headers, 'message-id': `<CAstored-${id}@mail.gmail.com>` });
      return json(200, { id, threadId: `t-${id}`, labelIds: ['SENT'] });
    }
    const m = api.match(/^\/messages\/([A-Za-z0-9_-]+)\?format=metadata&(.*)$/);
    if (m) {
      const msg = st.sent.get(m[1]);
      if (!msg) return json(404, {});
      const names = [...m[2].matchAll(/metadataHeaders=([^&]+)/g)].map((x) => decodeURIComponent(x[1]).toLowerCase());
      return json(200, { id: m[1], threadId: `t-${m[1]}`, labelIds: ['SENT'], payload: { headers: names.filter((n) => msg[n] !== undefined).map((n) => ({ name: n, value: msg[n] })) } });
    }
    return json(404, {});
  };
  return st;
}

/** The "browser": follows the consent URL straight to the loopback redirect, as Google would. */
function browser() {
  const opened = [];
  return {
    opened,
    open: (url) => {
      opened.push(url);
      const u = new URL(url);
      setImmediate(() => http.get(`${u.searchParams.get('redirect_uri')}/?code=auth-code&state=${u.searchParams.get('state')}`, (r) => r.resume()).on('error', () => {}));
    },
  };
}

/** The REAL main-process persistence (mailboxPersistence.js) over an electron-store-like map and a fake vault. */
function realPersistence(disk = new Map()) {
  const vault = {
    isAvailable: () => true,
    seal: (s) => 'sealed:' + Buffer.from(String(s)).toString('base64'),
    reveal: (s) => { if (!String(s).startsWith('sealed:')) throw new Error('vault: decryption failed'); return Buffer.from(String(s).slice(7), 'base64').toString(); },
  };
  const electronStore = { get: (k, d) => (disk.has(k) ? JSON.parse(disk.get(k)) : d), set: (k, v) => disk.set(k, JSON.stringify(v)) };
  const p = createMailboxPersistence({ storeFactory: () => electronStore, vault, openExternal: () => {} });
  p.clientConfig.set(CLIENT);
  return { ...p, disk, vault };
}

/** One "app run": a fresh MailboxService over a persistent store + persistent token file. */
function appRun({ google, store, persistence, clock = () => new Date(NOW), logger = null, tokenStore = null }) {
  const b = browser();
  const svc = new MailboxService({
    store, clock, tokenStore: tokenStore || persistence.tokenStore, clientConfig: persistence.clientConfig, fetch: google.fetch,
    googleOAuth: new GoogleOAuth({ fetch: google.fetch, openExternal: b.open, timeoutMs: 3000 }),
    operator: 'Zee', defaultTimeZone: 'Asia/Karachi', logger,
  });
  return { svc, browser: b };
}

const later = (ms) => () => new Date(NOW + ms);
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

/* ===================================================================================== */

test('A-H. expired OLD token -> reconnect issues NEW -> NEW persisted, OLD not revoked -> Needs check -> Check exchanges NEW -> Ready -> survives restart and checks again', async () => {
  const google = grantGoogle();
  const store = new MemoryStore();
  const persistence = realPersistence();

  // 8 Oct: first connect + Check -> Ready (token OLD)
  const run1 = appRun({ google, store, persistence });
  const m = await run1.svc.connect({ provider: 'gmail' });
  const OLD = persistence.tokenStore.get(m.mailboxId);
  assert.ok(OLD && OLD.startsWith('1//refresh-'));
  assert.strictEqual((await run1.svc.check({ mailboxId: m.mailboxId })).mailbox.status, 'ready');

  // 15 Oct: Testing-mode 7-day expiry -> the next use marks Reconnect needed
  google.expire(OLD);
  const run2 = appRun({ google, store, persistence, clock: later(7 * DAY) });
  await assert.rejects(run2.svc.check({ mailboxId: m.mailboxId }), (e) => e.code === 'MAILBOX_RECONNECT_NEEDED');
  assert.strictEqual((await store.mailboxes.get(m.mailboxId)).status, 'reconnect_needed');

  // B-E: reconnect
  const view = await run2.svc.connect({ provider: 'gmail' });
  assert.strictEqual(view.mailboxId, m.mailboxId, 'the same mailbox is reconnected');
  const NEW = persistence.tokenStore.get(m.mailboxId);
  assert.ok(NEW && NEW !== OLD, 'C. the NEW refresh token is persisted (through the real vault + settings store)');
  assert.deepStrictEqual(google.revokes(), [], 'D. a successful reconnect revokes nothing (revocation is grant-wide)');
  assert.strictEqual(view.status, 'needs_check', 'E. the reconnected mailbox needs its own Check');

  // F-G: Check mailbox right away (the earlier failed check does not make it "too soon")
  const checked = await run2.svc.check({ mailboxId: m.mailboxId });
  assert.strictEqual(checked.check.passed, true);
  assert.strictEqual(checked.mailbox.status, 'ready', 'G. Ready');
  assert.ok(google.refreshes().includes(NEW), 'F. Check exchanged the NEW refresh token for an access token');

  // H: app restart -> a brand-new service reads NEW from disk; Check and the send gate still work
  const run3 = appRun({ google, store, persistence: realPersistence(persistence.disk), clock: later(7 * DAY + 5 * MIN) });
  assert.strictEqual(run3.svc.tokenStore.get(m.mailboxId), NEW, 'H. the NEW token survives a restart');
  assert.strictEqual((await run3.svc.check({ mailboxId: m.mailboxId })).mailbox.status, 'ready');
  assert.strictEqual((await run3.svc.sendGate(m.mailboxId, { pacing: false })).allowed, true);

  // limits and the reply cursor are kept across the reconnect (the user's own settings)
  assert.strictEqual((await store.mailboxes.get(m.mailboxId)).sync_cursor, '900');
});

test('the OLD behaviour, reproduced: revoking the superseded token kills the NEW one (why the fix is needed)', async () => {
  const google = grantGoogle();
  const store = new MemoryStore();
  const persistence = realPersistence();
  const run = appRun({ google, store, persistence });
  const m = await run.svc.connect({ provider: 'gmail' });
  const OLD = persistence.tokenStore.get(m.mailboxId);
  await run.svc.connect({ provider: 'gmail' });
  const NEW = persistence.tokenStore.get(m.mailboxId);
  await new GoogleOAuth({ fetch: google.fetch, openExternal: () => {} }).revoke(OLD); // what the old code did
  await assert.rejects(new GoogleOAuth({ fetch: google.fetch, openExternal: () => {} }).accessToken({ ...CLIENT, refreshToken: NEW }),
    (e) => e.code === 'MAILBOX_RECONNECT_NEEDED', 'the new token is dead after revoking the old one');
});

test('explicit Disconnect still revokes the current grant (best effort), removes the local token and the row', async () => {
  const google = grantGoogle();
  const store = new MemoryStore();
  const persistence = realPersistence();
  const run = appRun({ google, store, persistence });
  const m = await run.svc.connect({ provider: 'gmail' });
  await run.svc.connect({ provider: 'gmail' }); // reconnect first: revokes nothing
  const current = persistence.tokenStore.get(m.mailboxId);
  assert.deepStrictEqual(google.revokes(), []);
  assert.deepStrictEqual(await run.svc.disconnect({ mailboxId: m.mailboxId }), { mailboxId: m.mailboxId, disconnected: true });
  assert.deepStrictEqual(google.revokes(), [current], 'Disconnect revokes the CURRENT token');
  assert.strictEqual(persistence.tokenStore.get(m.mailboxId), null, 'local token removed');
  assert.deepStrictEqual(await run.svc.list(), [], 'row removed');
});

test('reconnect persistence failure: the new grant is cancelled, the old token is NOT restored, and the mailbox says Reconnect needed', async () => {
  const google = grantGoogle();
  const store = new MemoryStore();
  const persistence = realPersistence();
  const run = appRun({ google, store, persistence });
  const m = await run.svc.connect({ provider: 'gmail' });
  await run.svc.check({ mailboxId: m.mailboxId });
  assert.strictEqual((await store.mailboxes.get(m.mailboxId)).status, 'ready');

  const broken = { ...persistence.tokenStore, set: () => { throw new Error('vault: encryption failed'); } };
  const run2 = appRun({ google, store, persistence, tokenStore: broken, clock: later(2 * MIN) });
  await assert.rejects(run2.svc.connect({ provider: 'gmail' }), (e) => e.code === 'MAILBOX_CONNECT_FAILED' && /connected again/.test(e.message) && !/vault/.test(e.message));
  assert.strictEqual(google.revokes().length, 1, 'the new grant is revoked: no live grant without a stored token');
  assert.strictEqual(persistence.tokenStore.get(m.mailboxId), null, 'the old token (now invalid at Google) is forgotten, not restored');
  const row = await store.mailboxes.get(m.mailboxId);
  assert.strictEqual(row.status, 'reconnect_needed', 'the mailbox does not keep claiming Ready on a dead grant');
  assert.strictEqual(row.status_code, 'MAILBOX_RECONNECT_NEEDED');
  assert.strictEqual((await run2.svc.sendGate(m.mailboxId)).allowed, false);

  // ...and a clean reconnect afterwards works end to end
  const run3 = appRun({ google, store, persistence, clock: later(4 * MIN) });
  assert.strictEqual((await run3.svc.connect({ provider: 'gmail' })).status, 'needs_check');
  assert.strictEqual((await run3.svc.check({ mailboxId: m.mailboxId })).mailbox.status, 'ready');
});

test('first-connect persistence failure revokes the grant and leaves no row and no token', async () => {
  const google = grantGoogle();
  const store = new MemoryStore();
  const persistence = realPersistence();
  const broken = { ...persistence.tokenStore, set: () => { throw new Error('vault: encryption failed'); } };
  const run = appRun({ google, store, persistence, tokenStore: broken });
  await assert.rejects(run.svc.connect({ provider: 'gmail' }), (e) => e.code === 'MAILBOX_CONNECT_FAILED' && /Nothing was connected/.test(e.message));
  assert.strictEqual(google.revokes().length, 1);
  assert.deepStrictEqual(await run.svc.list(), []);
});

test('a token that is "saved" but cannot be read back is treated as not saved (read-back check)', async () => {
  const google = grantGoogle();
  const store = new MemoryStore();
  const persistence = realPersistence();
  // A store whose write silently does not stick (e.g. a settings file that cannot be written).
  const lossy = { ...persistence.tokenStore, set: () => {} };
  const run = appRun({ google, store, persistence, tokenStore: lossy });
  await assert.rejects(run.svc.connect({ provider: 'gmail' }), (e) => e.code === 'MAILBOX_CONNECT_FAILED');
  assert.deepStrictEqual(await run.svc.list(), [], 'no mailbox row without a readable credential');
  assert.strictEqual(google.revokes().length, 1);
});

test('reconnect clears the cached access token of the old grant', async () => {
  const google = grantGoogle();
  const store = new MemoryStore();
  const persistence = realPersistence();
  const run = appRun({ google, store, persistence });
  const m = await run.svc.connect({ provider: 'gmail' });
  await run.svc.check({ mailboxId: m.mailboxId }); // caches an access token of grant #1
  assert.strictEqual(run.svc._accessCache.has(m.mailboxId), true);
  await run.svc.connect({ provider: 'gmail' });
  assert.strictEqual(run.svc._accessCache.has(m.mailboxId), false, 'nothing from the old grant is reused');
  const before = google.refreshes().length;
  await run.svc.check({ mailboxId: m.mailboxId });
  assert.strictEqual(google.refreshes().length, before + 1, 'the next Check refreshes with the NEW token');
});

test('a vault/decryption failure reads as its own code, never as an expired Google sign-in, and never calls Google', async () => {
  const google = grantGoogle();
  const store = new MemoryStore();
  const persistence = realPersistence();
  const run = appRun({ google, store, persistence });
  const m = await run.svc.connect({ provider: 'gmail' });
  const logs = [];
  const unreadable = { ...persistence.tokenStore, get: () => { throw new Error('vault: decryption failed'); } };
  const run2 = appRun({ google, store, persistence, tokenStore: unreadable, logger: { warn: (x) => logs.push(x) }, clock: later(2 * MIN) });
  const calls = google.calls.length;
  await assert.rejects(run2.svc.check({ mailboxId: m.mailboxId }), (e) => e.code === 'MAILBOX_RECONNECT_NEEDED' && /secure storage/.test(e.message));
  const row = await store.mailboxes.get(m.mailboxId);
  assert.strictEqual(row.status, 'reconnect_needed');
  assert.strictEqual(row.status_code, 'MAILBOX_TOKEN_UNREADABLE');
  assert.ok(!google.calls.slice(calls).some((c) => c.url === GOOGLE.TOKEN_URL), 'Google was not asked');
  assert.ok(logs.some((l) => /could not be read/.test(l)) && !logs.some((l) => /refresh-|sealed:/.test(l)), 'logged without any secret');
  // a missing token keeps the plain code
  const empty = { ...persistence.tokenStore, get: () => null };
  const run3 = appRun({ google, store, persistence, tokenStore: empty, clock: later(4 * MIN) });
  await assert.rejects(run3.svc.check({ mailboxId: m.mailboxId }), (e) => e.code === 'MAILBOX_RECONNECT_NEEDED');
  assert.strictEqual((await store.mailboxes.get(m.mailboxId)).status_code, 'MAILBOX_RECONNECT_NEEDED');
});

test('the renderer explains the new status code; no token value reaches any sanitized view', async () => {
  const fs = require('fs');
  const src = fs.readFileSync(path.join(root, 'src', 'renderer', 'renderer.js'), 'utf8');
  assert.ok(/MAILBOX_TOKEN_UNREADABLE:\s*'/.test(src));
  const google = grantGoogle();
  const store = new MemoryStore();
  const persistence = realPersistence();
  const run = appRun({ google, store, persistence });
  const m = await run.svc.connect({ provider: 'gmail' });
  await run.svc.connect({ provider: 'gmail' });
  const json = JSON.stringify([await run.svc.list(), await run.svc.get(m.mailboxId)]);
  for (const t of google.issueRefreshTokens()) assert.ok(!json.includes(t));
  assert.ok(!/never-leaks|sealed:/.test(json));
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
