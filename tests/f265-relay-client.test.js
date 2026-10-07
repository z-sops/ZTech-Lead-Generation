'use strict';

// F26.5 - the Hosted Trust Relay client against a FAKE relay (lock item 9). The server itself is
// F26.5b; this proves the desktop side of the contract: off by default, pull -> verify ->
// intake -> ack -> cursor, restart-safe, and no lead / research / pitch data in any request.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

globalThis.fetch = async () => { throw new Error('F26.5 TEST GUARD: real network is forbidden'); };

const root = path.join(__dirname, '..');
const LI = path.join(root, 'src', 'main', 'lead-intelligence');
const { RelayClient, buildRelayClient, normalizeRelayUrl } = require(path.join(LI, 'trust', 'RelayClient.js'));
const { deriveRelayKeys, recipientRefFor, signEvent } = require(path.join(LI, 'trust', 'relaySignature.js'));
const { grantTrust } = require('./trust-fixture');
const { NOW, HOUR, LEAD_EMAIL, LEAD_PHONE, OFFER, runtime, approved, iso } = require('./f265-harness');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const SECRET = 'relay-shared-secret-for-tests-only-0123456789';
const BASE = 'https://relay.example.test';
const keys = deriveRelayKeys(SECRET);

/** A fake relay: a queue of events, cursor = index, records every request it receives. */
function fakeRelay({ failAck = false, raw = null } = {}) {
  const state = { events: [], acked: new Set(), requests: [] };
  const fetchImpl = async (url, init) => {
    state.requests.push({ url, method: init.method, headers: init.headers, body: init.body || null });
    const u = new URL(url);
    const reply = (status, body) => ({ ok: status < 400, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
    if (init.headers.Authorization !== `Bearer ${require('crypto').createHmac('sha256', SECRET).update('ztech-relay-v1 auth').digest('hex')}`) return reply(401, {});
    if (u.pathname === '/v1/events' && init.method === 'GET') {
      if (raw) return reply(200, raw);
      const after = Number(u.searchParams.get('after') || 0);
      const limit = Number(u.searchParams.get('limit'));
      const batch = state.events.slice(after, after + limit).map((e) => e.wire);
      return reply(200, { events: batch, next_cursor: String(after + batch.length) });
    }
    if (u.pathname === '/v1/events/ack' && init.method === 'POST') {
      if (failAck) return reply(503, {});
      for (const id of JSON.parse(init.body).event_ids) state.acked.add(id);
      return reply(200, { ok: true });
    }
    return reply(404, {});
  };
  let n = 0;
  const push = (fields, { forge = false } = {}) => {
    const e = Object.assign({ event_id: 'rly_' + (++n), received_at: iso(NOW - HOUR), recipient_ref: null }, fields);
    e.signature = signEvent(keys.signKey, e);
    if (forge) e.signature = 'f'.repeat(64);
    state.events.push({ wire: e });
    return e;
  };
  return { state, fetchImpl, push };
}
function memCursor() { let c = null; return { get: () => c, set: (v) => { c = v; }, peek: () => c }; }

test('9a. OFF by default: no URL, no secret, a short secret or a non-https URL builds no client and calls nothing', async () => {
  const { li } = runtime();
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { ok: true, status: 200, text: async () => '{}' }; };
  for (const cfg of [
    { url: '', getSecret: () => SECRET },
    { url: BASE, getSecret: () => null },
    { url: BASE, getSecret: () => 'short' },
    { url: 'http://relay.example.test', getSecret: () => SECRET },
    { url: 'https://user:pw@relay.example.test', getSecret: () => SECRET },
    { url: BASE },
  ]) assert.strictEqual(buildRelayClient({ ...cfg, trust: li.trust, fetchImpl }), null, JSON.stringify(cfg.url));
  assert.strictEqual(calls, 0);
  assert.strictEqual(li.trust.relayKeys, null, 'no keys, so every relay event would be refused');
  assert.strictEqual(normalizeRelayUrl('http://127.0.0.1:8787/'), 'http://127.0.0.1:8787', 'loopback http only for development');
  const rt = fs.readFileSync(path.join(LI, 'lead-intelligence-runtime.js'), 'utf8');
  assert.ok(/let relay = null;\s*\n\s*if \(li\.trust && trustRelay\)/.test(rt), 'the runtime builds a relay only when one is configured');
});

test('9b. pull -> verify -> intake -> ack -> cursor: an unsubscribe and a bounce suppress; the batch is acknowledged', async () => {
  const { li, store } = runtime();
  const relay = fakeRelay();
  const cursor = memCursor();
  const client = new RelayClient({ baseUrl: BASE, secret: SECRET, trust: li.trust, fetchImpl: relay.fetchImpl, cursorStore: cursor });
  const ref = recipientRefFor(keys.refKey, 'email', LEAD_EMAIL);
  await store.recipientRefs.ensure({ recipient_ref: ref, channel: 'email', normalized_address: LEAD_EMAIL, created_at: iso(NOW - 2 * HOUR) });
  const a = relay.push({ kind: 'unsubscribe', channel: 'email', recipient_ref: ref });
  const b = relay.push({ kind: 'bounce', channel: 'email', recipient_ref: ref });
  const r = await client.pullOnce();
  assert.deepStrictEqual(r, { ok: true, pulled: 2, applied: 2, rejected: 0 });
  assert.deepStrictEqual([...relay.state.acked].sort(), [a.event_id, b.event_id].sort());
  assert.strictEqual(cursor.peek(), '2');
  assert.strictEqual((await store.suppressions.find({ channel: 'email', address: LEAD_EMAIL })).reason, 'unsubscribe');
});

test('9c. a forged event is rejected with no effect and NOT acknowledged; the cursor holds so nothing is skipped', async () => {
  const { li, store } = runtime();
  const relay = fakeRelay();
  const cursor = memCursor();
  const client = new RelayClient({ baseUrl: BASE, secret: SECRET, trust: li.trust, fetchImpl: relay.fetchImpl, cursorStore: cursor });
  const ref = recipientRefFor(keys.refKey, 'whatsapp', LEAD_PHONE);
  const forged = relay.push({ kind: 'complaint', channel: 'whatsapp', recipient_ref: ref }, { forge: true });
  const good = relay.push({ kind: 'whatsapp_inbound', channel: 'whatsapp', recipient_ref: ref });
  const r = await client.pullOnce();
  assert.deepStrictEqual(r, { ok: false, code: 'RELAY_EVENTS_REJECTED', pulled: 2, applied: 1, rejected: 1 });
  assert.deepStrictEqual([...relay.state.acked], [good.event_id], 'only the accepted event is acknowledged');
  assert.ok(!relay.state.acked.has(forged.event_id), 'a refused event stays at the relay: a clock or key problem never deletes an opt-out');
  assert.strictEqual(cursor.peek(), null, 'the cursor does not move past a refused event');
  assert.strictEqual(await store.suppressions.find({ channel: 'whatsapp', address: LEAD_PHONE }), null);
  assert.strictEqual((await store.consents.listByLead('L1'))[0].source, 'relay');
});

test('9d. survives restarts: a new client resumes after the stored cursor; a re-delivery after a lost ack changes nothing', async () => {
  const { li, store } = runtime();
  const relay = fakeRelay({ failAck: true });
  const cursor = memCursor();
  const ref = recipientRefFor(keys.refKey, 'email', LEAD_EMAIL);
  await store.recipientRefs.ensure({ recipient_ref: ref, channel: 'email', normalized_address: LEAD_EMAIL, created_at: iso(NOW - 2 * HOUR) });
  relay.push({ kind: 'complaint', channel: 'email', recipient_ref: ref });
  const first = new RelayClient({ baseUrl: BASE, secret: SECRET, trust: li.trust, fetchImpl: relay.fetchImpl, cursorStore: cursor });
  const r1 = await first.pullOnce();
  assert.strictEqual(r1.ok, false);
  assert.strictEqual(r1.code, 'RELAY_HTTP_503');
  assert.strictEqual(cursor.peek(), null, 'the cursor does not move past an unacknowledged batch');
  // "Restart": a brand-new client over the same store and cursor; the relay re-delivers.
  const relay2 = fakeRelay();
  relay2.state.events = relay.state.events;
  const second = new RelayClient({ baseUrl: BASE, secret: SECRET, trust: li.trust, fetchImpl: relay2.fetchImpl, cursorStore: cursor });
  const r2 = await second.pullOnce();
  assert.deepStrictEqual(r2, { ok: true, pulled: 1, applied: 0, rejected: 0 }, 'the re-delivered event is a duplicate');
  assert.strictEqual((await store.trustEvents.list()).total, 1);
  assert.strictEqual((await store.suppressions.list()).total, 1);
  relay2.push({ kind: 'reply', channel: 'email', recipient_ref: ref });
  const r3 = await second.pullOnce();
  assert.deepStrictEqual(r3, { ok: true, pulled: 1, applied: 0, rejected: 0 });
  assert.strictEqual(cursor.peek(), '2');
});

test('9e. malformed, oversized and unreachable relays are reported as codes, never thrown and never applied', async () => {
  const { li, store } = runtime();
  const cases = [
    [fakeRelay({ raw: 'not json' }).fetchImpl, 'RELAY_RESPONSE_INVALID'],
    [fakeRelay({ raw: { events: 'nope' } }).fetchImpl, 'RELAY_RESPONSE_INVALID'],
    [fakeRelay({ raw: { events: [], next_cursor: 'bad cursor!' } }).fetchImpl, 'RELAY_RESPONSE_INVALID'],
    [fakeRelay({ raw: 'x'.repeat(600 * 1024) }).fetchImpl, 'RELAY_RESPONSE_TOO_LARGE'],
    [async () => { throw new Error('ECONNREFUSED'); }, 'RELAY_UNREACHABLE'],
  ];
  for (const [fetchImpl, code] of cases) {
    const c = new RelayClient({ baseUrl: BASE, secret: SECRET, trust: li.trust, fetchImpl, cursorStore: memCursor() });
    assert.strictEqual((await c.pullOnce()).code, code);
  }
  const wrong = new RelayClient({ baseUrl: BASE, secret: SECRET.replace(/.$/, 'X'), trust: li.trust, fetchImpl: fakeRelay().fetchImpl });
  assert.strictEqual((await wrong.pullOnce()).code, 'RELAY_HTTP_401');
  assert.strictEqual((await store.trustEvents.list()).total, 0);
});

test('9f. NO lead, research or pitch data in any relay request - every URL, header and body is scanned', async () => {
  const { li, store } = runtime();
  const relay = fakeRelay();
  const client = new RelayClient({ baseUrl: BASE, secret: SECRET, trust: li.trust, fetchImpl: relay.fetchImpl, cursorStore: memCursor() });
  li.outreach.setRelayLinks(client);
  const pitch = await approved(li);
  await grantTrust(store, { email: LEAD_EMAIL, now: iso(NOW) });
  await li.outreach.send({ pitchId: pitch.pitch_id, channel: 'email' });
  const ref = recipientRefFor(keys.refKey, 'email', LEAD_EMAIL);
  relay.push({ kind: 'reply', channel: 'email', recipient_ref: ref });
  relay.push({ kind: 'unsubscribe', channel: 'email', recipient_ref: ref });
  await client.pullOnce();
  await client.pullOnce();
  assert.ok(relay.state.requests.length >= 3);
  const banned = [LEAD_EMAIL, LEAD_PHONE, LEAD_PHONE.slice(1), 'Acme', 'acme.example', pitch.subject, pitch.pitch_id, 'L1', OFFER.sender_company, OFFER.postal_address, SECRET, 'research', 'packet', 'pitch', 'lead'];
  for (const req of relay.state.requests) {
    const wire = JSON.stringify(req).toLowerCase();
    for (const b of banned) assert.ok(!wire.includes(String(b).toLowerCase()), `request carries "${b}": ${wire.slice(0, 200)}`);
    if (req.body) assert.deepStrictEqual(Object.keys(JSON.parse(req.body)), ['event_ids'], 'the only body is a list of event ids');
    assert.deepStrictEqual(new URL(req.url).searchParams.size === undefined ? [] : [...new URL(req.url).searchParams.keys()].filter((k) => !['limit', 'after'].includes(k)), []);
  }
  assert.strictEqual((await store.suppressions.find({ channel: 'email', address: LEAD_EMAIL })).reason, 'unsubscribe');
});

test('9g. linkFor is pure and matches the ref the relay computes; the renderer-facing trust view never shows it', async () => {
  const { li, store } = runtime();
  const client = new RelayClient({ baseUrl: BASE + '/', secret: SECRET, trust: li.trust, fetchImpl: fakeRelay().fetchImpl });
  const link = client.linkFor('email', ' HELLO@acme.example.com ');
  assert.deepStrictEqual(link, { url: `${BASE}/u/${recipientRefFor(keys.refKey, 'email', LEAD_EMAIL)}`, recipientRef: recipientRefFor(keys.refKey, 'email', LEAD_EMAIL) });
  assert.strictEqual(client.linkFor('email', 'not an address'), null);
  assert.strictEqual(await store.recipientRefs.resolve(link.recipientRef), null, 'linkFor writes nothing');
  const view = JSON.stringify(await li.trust.leadTrust({ leadId: 'L1' }));
  assert.ok(!/rref_/.test(view));
});

test('9i. a store failure inside a timed pull is logged, never an unhandled rejection', async () => {
  const { li } = runtime();
  const relay = fakeRelay();
  relay.push({ kind: 'reply', channel: 'email', recipient_ref: 'rref_' + 'e'.repeat(64) });
  const warns = [];
  const badCursor = { get: () => null, set: () => { throw new Error('disk full'); } };
  const c = new RelayClient({ baseUrl: BASE, secret: SECRET, trust: li.trust, fetchImpl: relay.fetchImpl, cursorStore: badCursor, logger: { warn: (m) => warns.push(m) } });
  let unhandled = 0;
  const onUnhandled = () => { unhandled += 1; };
  process.on('unhandledRejection', onUnhandled);
  const realSetInterval = global.setInterval;
  global.setInterval = () => ({ unref() {} });
  try { c.start(); } finally { global.setInterval = realSetInterval; }
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r));
  process.off('unhandledRejection', onUnhandled);
  assert.strictEqual(unhandled, 0);
  assert.ok(warns.some((w) => /RELAY_PULL_ERROR/.test(w)), warns.join('|'));
});

test('9h. one pull at a time; start() never polls faster than once a minute and stop() clears it', async () => {
  const { li } = runtime();
  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = async () => { await gate; return { ok: true, status: 200, text: async () => JSON.stringify({ events: [], next_cursor: null }) }; };
  const c = new RelayClient({ baseUrl: BASE, secret: SECRET, trust: li.trust, fetchImpl: slow });
  const p1 = c.pullOnce();
  assert.deepStrictEqual(await c.pullOnce(), { ok: false, code: 'RELAY_PULL_IN_PROGRESS' });
  release();
  assert.strictEqual((await p1).ok, true);
  const realSetInterval = global.setInterval;
  let interval = null;
  global.setInterval = (fn, ms) => { interval = ms; return { unref() {} }; };
  try { c.start(10); } finally { global.setInterval = realSetInterval; }
  assert.strictEqual(interval, 60000);
  c.stop();
  assert.strictEqual(c.timer, null);
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
