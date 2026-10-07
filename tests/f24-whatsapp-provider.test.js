'use strict';

// ============================================================ F24
// WHATSAPP PLUG & PLAY PROVIDER - the safety contract (§22 matrix A-AB).
//
// F24 adds the ONE official adapter behind the existing WhatsAppProvider interface, a
// bounded configuration parser + capability resolver, and the 1b configuration check in
// the EXISTING F19/F20 send boundary. These tests prove, in the order the phase
// specification lists them:
//
//   configuration -> capability resolver -> existing Prepare -> existing send boundary
//     -> WhatsAppProvider interface -> configured adapter (injected transport) ->
//     normalized provider result.
//
// NO REAL WHATSAPP MESSAGE IS SENT ANYWHERE IN THIS FILE. Every provider path runs
// through an injected transport spy, and the tests assert exact invocation counts so an
// accidental second call - or any call at all when configuration is incomplete - is loud.
// The current installation's honest state (no provider selected, no credential, no
// connected number, no verified sender) is pinned by tests A-E and the unconfigured-state
// test: capability unavailable, zero invocations.

const fs = require('fs');
const { withTrustOffer, grantTrustForLeadsSync } = require('./trust-fixture'); // F26.5
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const serviceSource = read(path.join('src', 'main', 'lead-intelligence', 'outreach', 'OutreachService.js'));
const whatsappConfigSource = read(path.join('src', 'main', 'lead-intelligence', 'outreach', 'whatsapp', 'whatsappConfig.js'));
const adapterSource = read(path.join('src', 'main', 'lead-intelligence', 'outreach', 'whatsapp', 'MetaCloudWhatsAppProvider.js'));
const providerBaseSource = read(path.join('src', 'main', 'lead-intelligence', 'outreach', 'whatsapp', 'WhatsAppProvider.js'));
const sendConfigSource = read(path.join('src', 'main', 'lead-intelligence', 'outreach', 'whatsapp', 'sendConfig.js'));
const ipcSource = read(path.join('src', 'main', 'lead-intelligence', 'outreach-ipc.js'));
const preloadSource = read('preload.js');
const rendererSource = read(path.join('src', 'renderer', 'renderer.js'));
const htmlSource = read('index.html');
const mainSource = read('main.js');
const migrationsSource = read(path.join('src', 'main', 'lead-intelligence', 'persistence', 'migrations.js'));

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// §18 HARD NETWORK GUARD: no test in this file may ever reach a real provider. Any code
// path that forgets to inject the spy transport and falls through to the default transport
// fails loudly here instead of touching the network.
globalThis.fetch = async () => { throw new Error('F24 TEST GUARD: real network is forbidden in this suite'); };

const { MetaCloudWhatsAppProvider, WHATSAPP_TRANSPORT_ERRORS, ENDPOINT } =
  require(path.join(root, 'src', 'main', 'lead-intelligence', 'outreach', 'whatsapp', 'MetaCloudWhatsAppProvider.js'));
const { WhatsAppProvider } =
  require(path.join(root, 'src', 'main', 'lead-intelligence', 'outreach', 'whatsapp', 'WhatsAppProvider.js'));
const { readWhatsAppConfig, evaluateWhatsAppConfig, emptyWhatsAppConfig, WHATSAPP_REFUSALS, NUMBER_VERIFICATION_STATUSES } =
  require(path.join(root, 'src', 'main', 'lead-intelligence', 'outreach', 'whatsapp', 'whatsappConfig.js'));
const { renderPitchText } =
  require(path.join(root, 'src', 'main', 'lead-intelligence', 'outreach', 'PitchGenerator.js'));
const { MemoryStore } = require(path.join(root, 'src', 'main', 'lead-intelligence', 'persistence', 'MemoryStore.js'));
const { createLeadIntelligence } = require(path.join(root, 'src', 'main', 'lead-intelligence', 'index.js'));
const { round1PacketMapper } = require(path.join(root, 'src', 'main', 'lead-intelligence', 'round1PacketMapper.js'));
const { round1Record, zuniV1Packet } = require(path.join(root, 'tests', 'lead-intelligence', 'fixtures', 'round1Record.js'));
const { registerOutreachIpc, CHANNELS } = require(path.join(root, 'src', 'main', 'lead-intelligence', 'outreach-ipc.js'));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const CLOCK_ISO = '2026-10-05T10:00:00.000Z';
const CAPTURED_AT = '2026-10-01T10:00:00.000Z';
const clock = () => new Date(CLOCK_ISO);
const SILENT = { info() {}, warn() {}, error() {} };

// The secret value that must never escape the main-process configuration boundary.
const ACCESS_TOKEN = 'EAAG_f24_whatsapp_token_must_never_leak_88';
const PHONE_NUMBER_ID = '1122334455667788';
const BUSINESS_ACCOUNT_ID = '102233445566778899';
const FROM_NUMBER = '+923001111111';
const LEAD_PHONE = '+923001234567';

const OFFER = {
  sender_name: 'Dana',
  sender_company: 'Ridgeline Supply',
  value_proposition: 'We help local businesses fix the website issues found in an audit like this one.',
  call_to_action: 'Would a short call next week be useful to go through these points?',
};

const lead = (o) => Object.assign({
  id: 'L1', title: 'Acme Bakery', website: 'https://acme.example.com', email: 'hello@acme.example.com',
  phone: LEAD_PHONE, address: '12 Road', qualification: 'qualified',
}, o);

/** Configuration source double: reads from a plain object, counts every `set`. */
function fakeConfigStore(settings = {}, providers = null) {
  const data = { settings, providers: providers || undefined };
  const calls = { set: 0, gets: [] };
  return {
    calls,
    data,
    get(key, fallback) {
      calls.gets.push(key);
      const v = data[key];
      return v === undefined ? fallback : v;
    },
    set(key, value) {
      calls.set += 1;
      data[key] = value;
    },
  };
}

/**
 * A COMPLETE, verified Plug & Play WhatsApp configuration - none of it hard-coded in
 * product source; it exists only inside this test's injected configuration. Neutral
 * numbers and identifiers on purpose: nothing here is a developer's personal number.
 */
const FULL_SETTINGS = Object.freeze({
  whatsappProvider: 'meta-cloud',
  whatsappEnabled: true,
  whatsappFromNumber: FROM_NUMBER,
  whatsappPhoneNumberId: PHONE_NUMBER_ID,
  whatsappBusinessAccountId: BUSINESS_ACCOUNT_ID,
  whatsappNumberVerification: 'verified',
});
const FULL_PROVIDERS = Object.freeze({ 'meta-cloud': { credentials: { apiKey: ACCESS_TOKEN } } });

const configuredStore = (overrides = {}) =>
  fakeConfigStore(Object.assign({}, FULL_SETTINGS, overrides), overrides.providers !== undefined ? overrides.providers : FULL_PROVIDERS);

/** A transport spy: records every request, answers with the given responder. */
function spyTransport(responder) {
  const calls = [];
  const transport = async (request) => {
    calls.push(request);
    if (responder) return responder(request);
    return { status: 200, body: { messages: [{ id: 'wamid.F24_OK' }] } };
  };
  return { calls, transport };
}

/** The F24 provider wired the only way tests are allowed to wire it: injected transport. */
function makeMeta(spy) {
  return new MetaCloudWhatsAppProvider({
    transport: spy.transport,
    getAccessToken: () => ACCESS_TOKEN,
    getPhoneNumberId: () => PHONE_NUMBER_ID,
  });
}

/** The provider PLUS a capture of every message the send boundary handed it. */
function makeMetaCapturing(spy) {
  const provider = makeMeta(spy);
  const seen = [];
  const original = provider.send.bind(provider);
  provider.send = async (message) => { seen.push(message); return original(message); };
  return { provider, seen };
}

function makeRuntime(leads, { whatsappProvider = null, whatsapp = null, whatsappConfigStore = undefined, emailProvider = null, email = null, emailConfigStore = undefined } = {}) {
  const store = new MemoryStore();
  // F26.5 declared update: every fixture lead carries the trust facts a successful send now
  // needs (recorded consent; for WhatsApp also a relay inbound opening the 24h window).
  grantTrustForLeadsSync(store, leads, clock());
  const records = Object.values(leads).map((l) => {
    const host = new URL(l.website).host;
    return round1Record({
      id: 'rec_' + l.id, leadRef: l.id, domain: host, providerJobId: 'job_' + l.id,
      packet: zuniV1Packet({ domain: host, capturedAt: CAPTURED_AT }),
      createdAt: CAPTURED_AT, updatedAt: CAPTURED_AT,
    });
  });
  const li = createLeadIntelligence({
    store,
    leadSource: { getLead: async (id) => leads[String(id)] || null, listLeads: async () => Object.values(leads) },
    round1: {
      async getLatest(leadId) { return records.find((r) => r.leadRef === leadId) || null; },
      async listByLead(leadId) { return records.filter((r) => r.leadRef === leadId); },
      async listLatestPerLead() { return new Map(records.map((r) => [r.leadRef, r])); },
    },
    config: {
      research: { mode: 'round1' },
      freshness: { completeMaxAgeDays: 30, partialMaxAgeDays: 7 },
      outreach: { allowedQualification: ['qualified'], allowPartialEvidence: false, requireIcpFit: false },
      offer: withTrustOffer(OFFER), // F26.5 declared update: + postal_address (sender identity)
      // The instance-level switch, mirroring the email one; tests inject it explicitly.
      whatsapp: Object.assign({ enabled: true, fromNumber: FROM_NUMBER }, whatsapp || {}),
      email: Object.assign({ enabled: false, fromAddress: null }, email || {}),
    },
    clock,
    logger: SILENT,
    round1ResultMapper: round1PacketMapper,
    emailProvider,
    emailConfigStore,
    whatsappProvider,
    whatsappConfigStore,
  });
  return { li, store };
}

async function runLead(li, leadId) {
  await li.research.sync({ leadId });
  const pitch = await li.outreach.generate({ leadId });
  await li.outreach.approve({ pitchId: pitch.pitch_id });
  const gate = await li.outreach.gate({ pitchId: pitch.pitch_id });
  return { pitch, gate };
}

const activityJson = async (li) => JSON.stringify(await li.outreach.activityList({ limit: 100 }));
const payloadOf = (request) => JSON.parse(request.body);
const errMsg = (e) => String(e && e.message);

// ============================================================ A-E. no invocation without configuration

test('A. no WhatsApp provider selected -> unavailable, no provider invocation', async () => {
  // The resolver, on its own: an unconfigured snapshot names no supported provider.
  const resolved = evaluateWhatsAppConfig(readWhatsAppConfig(fakeConfigStore({})));
  assert.strictEqual(resolved.canSend, false);
  assert.strictEqual(resolved.code, WHATSAPP_REFUSALS.PROVIDER_NOT_SELECTED);

  // And through the real send boundary: settings present, provider id absent.
  const spy = spyTransport();
  const { li } = makeRuntime({ L1: lead({}) }, {
    whatsappProvider: makeMeta(spy), whatsappConfigStore: fakeConfigStore({ whatsappEnabled: true, whatsappFromNumber: FROM_NUMBER }),
  });
  const { pitch } = await runLead(li, 'L1');
  await assert.rejects(() => li.outreach.sendWhatsApp({ pitchId: pitch.pitch_id }),
    (e) => e.code === 'WHATSAPP_PROVIDER_NOT_SELECTED');
  assert.strictEqual(spy.calls.length, 0, 'the transport was never invoked');
  assert.ok((await activityJson(li)).includes('OUTREACH_SEND_BLOCKED'), 'the refusal is recorded as a blocked attempt');
});

test('B. missing credential -> unavailable, no provider invocation', async () => {
  const resolved = evaluateWhatsAppConfig(readWhatsAppConfig(configuredStore({ providers: {} })));
  assert.strictEqual(resolved.canSend, false);
  assert.strictEqual(resolved.code, WHATSAPP_REFUSALS.CREDENTIAL_MISSING);

  const spy = spyTransport();
  const { li } = makeRuntime({ L1: lead({}) }, {
    whatsappProvider: makeMeta(spy), whatsappConfigStore: configuredStore({ providers: {} }),
  });
  const { pitch } = await runLead(li, 'L1');
  await assert.rejects(() => li.outreach.sendWhatsApp({ pitchId: pitch.pitch_id }),
    (e) => e.code === 'WHATSAPP_CREDENTIAL_MISSING');
  assert.strictEqual(spy.calls.length, 0, 'the transport was never invoked');

  // A stored-but-unreadable credential is its own distinct fact.
  const unreadable = evaluateWhatsAppConfig(Object.assign(emptyWhatsAppConfig(), {
    providerSelected: true, keyConfigured: true, keyReadable: false,
  }));
  assert.strictEqual(unreadable.code, WHATSAPP_REFUSALS.CREDENTIAL_INVALID);
});

test('C. missing account configuration -> unavailable, no provider invocation', async () => {
  const resolved = evaluateWhatsAppConfig(readWhatsAppConfig(configuredStore({ whatsappPhoneNumberId: '' })));
  assert.strictEqual(resolved.canSend, false);
  assert.strictEqual(resolved.code, WHATSAPP_REFUSALS.ACCOUNT_MISSING);

  const spy = spyTransport();
  const { li } = makeRuntime({ L1: lead({}) }, {
    whatsappProvider: makeMeta(spy), whatsappConfigStore: configuredStore({ whatsappBusinessAccountId: '' }),
  });
  const { pitch } = await runLead(li, 'L1');
  await assert.rejects(() => li.outreach.sendWhatsApp({ pitchId: pitch.pitch_id }),
    (e) => e.code === 'WHATSAPP_ACCOUNT_MISSING');
  assert.strictEqual(spy.calls.length, 0, 'the transport was never invoked');
});

test('D. missing or malformed sender number -> unavailable, no provider invocation', async () => {
  const missing = evaluateWhatsAppConfig(readWhatsAppConfig(configuredStore({ whatsappFromNumber: '' })));
  assert.strictEqual(missing.canSend, false);
  assert.strictEqual(missing.code, WHATSAPP_REFUSALS.SENDER_NUMBER_MISSING);
  const malformed = evaluateWhatsAppConfig(readWhatsAppConfig(configuredStore({ whatsappFromNumber: 'not-a-number' })));
  assert.strictEqual(malformed.canSend, false);
  assert.strictEqual(malformed.code, WHATSAPP_REFUSALS.SENDER_NUMBER_INVALID);

  const spy = spyTransport();
  const { li } = makeRuntime({ L1: lead({}) }, {
    whatsappProvider: makeMeta(spy),
    // The instance switch still names a number (the same settings in production), while
    // the configuration source says otherwise: the configuration check is the one that
    // must refuse, before any transport could exist.
    whatsappConfigStore: configuredStore({ whatsappFromNumber: '' }),
  });
  const { pitch } = await runLead(li, 'L1');
  await assert.rejects(() => li.outreach.sendWhatsApp({ pitchId: pitch.pitch_id }),
    (e) => e.code === 'WHATSAPP_SENDER_NUMBER_MISSING');
  assert.strictEqual(spy.calls.length, 0, 'the transport was never invoked');
});

test('E. an unverified sender where verification is required -> unavailable', async () => {
  const pending = evaluateWhatsAppConfig(readWhatsAppConfig(configuredStore({ whatsappNumberVerification: 'pending' })));
  assert.strictEqual(pending.canSend, false);
  assert.strictEqual(pending.code, WHATSAPP_REFUSALS.NUMBER_NOT_VERIFIED);
  const failed = evaluateWhatsAppConfig(readWhatsAppConfig(configuredStore({ whatsappNumberVerification: 'failed' })));
  assert.strictEqual(failed.code, WHATSAPP_REFUSALS.NUMBER_VERIFICATION_FAILED);

  const spy = spyTransport();
  const { li } = makeRuntime({ L1: lead({}) }, {
    whatsappProvider: makeMeta(spy), whatsappConfigStore: configuredStore({ whatsappNumberVerification: 'pending' }),
  });
  const { pitch } = await runLead(li, 'L1');
  await assert.rejects(() => li.outreach.sendWhatsApp({ pitchId: pitch.pitch_id }),
    (e) => e.code === 'WHATSAPP_NUMBER_NOT_VERIFIED');
  assert.strictEqual(spy.calls.length, 0, 'the transport was never invoked');

  // A stale "verified" left behind after the number was cleared reads back as unknown,
  // never as verified.
  const cleared = readWhatsAppConfig(configuredStore({ whatsappFromNumber: '', whatsappNumberVerification: 'verified' }));
  assert.strictEqual(cleared.numberVerification, NUMBER_VERIFICATION_STATUSES.UNKNOWN);
});

test('the current installation state is honestly UNAVAILABLE (no configuration at all)', () => {
  const config = readWhatsAppConfig(fakeConfigStore({}));
  assert.strictEqual(config.providerSelected, false);
  assert.strictEqual(config.keyConfigured, false);
  assert.strictEqual(config.accountConfigured, false);
  assert.strictEqual(config.senderConfigured, false);
  assert.strictEqual(config.numberVerification, NUMBER_VERIFICATION_STATUSES.UNKNOWN);
  const verdict = evaluateWhatsAppConfig(config);
  assert.strictEqual(verdict.canSend, false);
  assert.strictEqual(verdict.code, WHATSAPP_REFUSALS.PROVIDER_NOT_SELECTED);
  assert.ok(verdict.message && verdict.message.length > 0, 'and it carries a factual reason');
});

// ============================================================ F-K. the configured provider path

test('F. fully configured injected provider -> capability available and exactly ONE transport invocation', async () => {
  const spy = spyTransport();
  const cfg = configuredStore();
  const { provider, seen } = makeMetaCapturing(spy);
  const { li } = makeRuntime({ L1: lead({}) }, { whatsappProvider: provider, whatsappConfigStore: cfg });
  const { pitch } = await runLead(li, 'L1');

  const status = await li.outreach.getWhatsAppProviderStatus();
  assert.strictEqual(status.capability.canSend, true, 'the configuration resolver approves');
  assert.strictEqual(cfg.calls.set, 0, 'the configuration source was written to ZERO times');

  const result = await li.outreach.sendWhatsApp({ pitchId: pitch.pitch_id });
  assert.strictEqual(spy.calls.length, 1, 'exactly one provider invocation');
  assert.strictEqual(seen.length, 1, 'exactly one message reached the provider');
  assert.strictEqual(result.outcome, 'accepted');
  assert.strictEqual(result.providerId, 'meta-cloud', 'the ledger names the provider that accepted it');
  assert.strictEqual(result.providerAcknowledged, true, 'acknowledgement is the single truthful claim');
});

test('G. exactly one fake transport invocation, counted at the transport itself', async () => {
  const spy = spyTransport();
  const { li } = makeRuntime({ L1: lead({}) }, { whatsappProvider: makeMeta(spy), whatsappConfigStore: configuredStore() });
  const { pitch } = await runLead(li, 'L1');
  await li.outreach.sendWhatsApp({ pitchId: pitch.pitch_id });
  assert.strictEqual(spy.calls.length, 1);
  // A repeated identical confirmation is a replay and contacts nobody.
  const again = await li.outreach.sendWhatsApp({ pitchId: pitch.pitch_id });
  assert.strictEqual(again.outcome, 'replayed');
  assert.strictEqual(spy.calls.length, 1, 'still exactly one invocation in total');
});

test('H. the transport receives the correct recipient - the STORED lead number', async () => {
  const spy = spyTransport();
  const { li } = makeRuntime({ L1: lead({}) }, { whatsappProvider: makeMeta(spy), whatsappConfigStore: configuredStore() });
  const { pitch } = await runLead(li, 'L1');
  await li.outreach.sendWhatsApp({ pitchId: pitch.pitch_id });
  const payload = payloadOf(spy.calls[0]);
  assert.strictEqual(payload.to, LEAD_PHONE, 'the stored lead number, exactly');
  assert.strictEqual(payload.messaging_product, 'whatsapp');
  assert.strictEqual(payload.type, 'text', 'the shipped plain-text message contract, unchanged');
});

test('I. the transport receives the configured sender number and sending account', async () => {
  const spy = spyTransport();
  const { provider, seen } = makeMetaCapturing(spy);
  const { li } = makeRuntime({ L1: lead({}) }, { whatsappProvider: provider, whatsappConfigStore: configuredStore() });
  const { pitch } = await runLead(li, 'L1');
  const result = await li.outreach.sendWhatsApp({ pitchId: pitch.pitch_id });

  // OUR sending number, from configuration - never the lead's number.
  assert.strictEqual(seen[0].from, FROM_NUMBER, 'the boundary passed the configured sending number');
  assert.notStrictEqual(seen[0].from, LEAD_PHONE, 'sender and recipient are separate facts');
  // The sending account identity: the configured phone-number id in the request path,
  // and the credential only in the Authorization header.
  const request = spy.calls[0];
  assert.strictEqual(request.url, `${ENDPOINT}/${PHONE_NUMBER_ID}/messages`, 'the configured account id identifies the sender');
  assert.strictEqual(request.headers.Authorization, `Bearer ${ACCESS_TOKEN}`, 'the token authenticates the request');
  // The stable send key rides along as a correlation fact.
  assert.strictEqual(request.headers['X-ZTech-Send-Key'], result.idempotencyKey, 'the stable send key rides with the request');
  assert.strictEqual(payloadOf(request).recipient_type, 'individual');
});

test('J. the exact approved Prepare message equals the provider message, byte for byte', async () => {
  const spy = spyTransport();
  const { provider, seen } = makeMetaCapturing(spy);
  const { li } = makeRuntime({ L1: lead({}) }, { whatsappProvider: provider, whatsappConfigStore: configuredStore() });
  const { pitch } = await runLead(li, 'L1');

  const prep = await li.outreach.prepare({ pitchId: pitch.pitch_id, channel: 'whatsapp' });
  assert.strictEqual(prep.content.body, renderPitchText(pitch), 'the canonical approved body is untouched');
  assert.strictEqual(prep.content.finalBody, undefined, 'no second body exists for WhatsApp - nothing is appended');

  await li.outreach.sendWhatsApp({ pitchId: pitch.pitch_id });
  assert.strictEqual(seen[0].body, prep.content.body, 'byte-for-byte: what Prepare showed IS what the provider received');
  assert.strictEqual(payloadOf(spy.calls[0]).text.body, prep.content.body, 'and that is the exact text on the wire');
  assert.strictEqual(seen[0].to, prep.recipient.contact, 'to the candidate Prepare displayed');
});

test('K. an accepted provider response is normalized as acceptance, never as delivery', async () => {
  const spy = spyTransport(() => ({ status: 200, body: { messages: [{ id: 'wamid.F24_REAL_9' }] }, messaging_product: 'whatsapp' }));
  const { li } = makeRuntime({ L1: lead({}) }, { whatsappProvider: makeMeta(spy), whatsappConfigStore: configuredStore() });
  const { pitch } = await runLead(li, 'L1');

  const result = await li.outreach.sendWhatsApp({ pitchId: pitch.pitch_id });
  assert.strictEqual(result.outcome, 'accepted');
  assert.strictEqual(result.providerMessageId, 'wamid.F24_REAL_9', 'the factual provider id, unmodified');
  assert.strictEqual(result.providerStatus, 'queued', 'only the acknowledgement status is passed through');
  assert.strictEqual(result.deliveryStatus, 'unknown');
  assert.strictEqual(result.openStatus, 'unknown');
  assert.strictEqual(result.clickStatus, 'unknown');
});

test('L. the factual providerMessageId persists through the existing ledger and activity', async () => {
  const spy = spyTransport(() => ({ status: 200, body: { messages: [{ id: 'wamid.F24_LEDGER_4' }] } }));
  const { li } = makeRuntime({ L1: lead({}) }, { whatsappProvider: makeMeta(spy), whatsappConfigStore: configuredStore() });
  const { pitch } = await runLead(li, 'L1');

  await li.outreach.sendWhatsApp({ pitchId: pitch.pitch_id });
  const sends = await li.outreach.sendList({ limit: 10 });
  assert.strictEqual(sends.total, 1, 'one ledger row for one accepted send');
  const row = sends.rows[0];
  assert.strictEqual(row.state, 'accepted');
  assert.strictEqual(row.channel, 'whatsapp');
  assert.strictEqual(row.providerId, 'meta-cloud');
  assert.strictEqual(row.providerMessageId, 'wamid.F24_LEDGER_4', 'the factual id is what history shows');
  const activity = await activityJson(li);
  assert.ok(activity.includes('OUTREACH_SEND_ACCEPTED'), 'the acceptance is in the activity ledger');
  assert.ok(activity.includes('wamid.F24_LEDGER_4'), 'with the factual provider id');
});

test('M. provider failures are normalized to stable codes with safe messages', async () => {
  const cases = [
    { status: 401, body: { error: { message: 'Invalid OAuth access token', type: 'OAuthException' } }, code: 'WHATSAPP_PROVIDER_AUTH_FAILED' },
    { status: 429, body: { error: { message: 'rate limited' } }, code: 'WHATSAPP_PROVIDER_RATE_LIMITED' },
    { status: 400, body: { error: { message: 'Invalid parameter: to', code: 100 } }, code: 'WHATSAPP_PROVIDER_INVALID_RECIPIENT' },
    { status: 400, body: { error: { message: 'Invalid parameter: from', code: 100 } }, code: 'WHATSAPP_PROVIDER_INVALID_SENDER' },
    { status: 400, body: { error: { message: 'Re-engagement message required', code: 131047 } }, code: 'WHATSAPP_PROVIDER_TEMPLATE_REJECTED' },
    { status: 500, body: { error: { message: 'raw provider detail should not leak' } }, code: 'WHATSAPP_PROVIDER_UNAVAILABLE' },
    { status: 200, body: {}, code: 'WHATSAPP_PROVIDER_BAD_RESPONSE' },
  ];
  for (const c of cases) {
    const spy = spyTransport(() => ({ status: c.status, body: c.body }));
    const { li } = makeRuntime({ L1: lead({}) }, { whatsappProvider: makeMeta(spy), whatsappConfigStore: configuredStore() });
    const { pitch } = await runLead(li, 'L1');

    await assert.rejects(() => li.outreach.sendWhatsApp({ pitchId: pitch.pitch_id }),
      (e) => {
        assert.strictEqual(e.code, c.code, `status ${c.status} maps to ${c.code}, got ${e.code}`);
        assert.ok(!/raw provider detail|Invalid OAuth/.test(errMsg(e)), 'no raw provider text reaches the caller');
        return true;
      });
    const sends = await li.outreach.sendList({ limit: 10 });
    assert.strictEqual(sends.rows[0].state, 'failed', 'the failure is recorded as failed, not accepted');
    assert.strictEqual(sends.rows[0].failureCode, c.code, 'with the stable ZTech code');
    assert.strictEqual(sends.rows[0].providerMessageId, null, 'and no provider id was fabricated');
    assert.strictEqual(spy.calls.length, 1, 'one invocation, no automatic retry');
  }
});

// ============================================================ N-O. secret isolation

test('N. the access token never appears in the status, Prepare, result, ledger, activity or IPC', async () => {
  const spy = spyTransport();
  const cfg = configuredStore();
  const loggerCalls = [];
  const logger = { info: (...a) => loggerCalls.push(a), warn: (...a) => loggerCalls.push(a), error: (...a) => loggerCalls.push(a) };
  const store = new MemoryStore();
  grantTrustForLeadsSync(store, { L1: lead({}) }, clock()); // F26.5 declared update: consent + open session
  const li = createLeadIntelligence({
    store,
    leadSource: { getLead: async (id) => (id === 'L1' ? lead({}) : null), listLeads: async () => [lead({})] },
    round1: {
      async getLatest(leadId) {
        return leadId === 'L1' ? round1Record({ id: 'rec_L1', leadRef: 'L1', domain: 'acme.example.com', providerJobId: 'job_L1', packet: zuniV1Packet({ domain: 'acme.example.com', capturedAt: CAPTURED_AT }), createdAt: CAPTURED_AT, updatedAt: CAPTURED_AT }) : null;
      },
      async listByLead(leadId) { return leadId === 'L1' ? [await this.getLatest(leadId)] : []; },
      async listLatestPerLead() { return new Map([['L1', await this.getLatest('L1')]]); },
    },
    config: {
      research: { mode: 'round1' },
      freshness: { completeMaxAgeDays: 30, partialMaxAgeDays: 7 },
      outreach: { allowedQualification: ['qualified'], allowPartialEvidence: false, requireIcpFit: false },
      offer: withTrustOffer(OFFER), // F26.5 declared update: + postal_address
      whatsapp: { enabled: true, fromNumber: FROM_NUMBER },
      email: { enabled: false, fromAddress: null },
    },
    clock,
    logger,
    round1ResultMapper: round1PacketMapper,
    whatsappProvider: makeMeta(spy),
    whatsappConfigStore: cfg,
  });
  const { pitch } = await runLead(li, 'L1');

  const status = await li.outreach.getWhatsAppProviderStatus();
  const prep = await li.outreach.prepare({ pitchId: pitch.pitch_id, channel: 'whatsapp' });
  const result = await li.outreach.sendWhatsApp({ pitchId: pitch.pitch_id });
  const sends = await li.outreach.sendList({ limit: 10 });
  const activity = await li.outreach.activityList({ limit: 100 });

  for (const [name, value] of Object.entries({ status, prep, result, sends, activity })) {
    const json = JSON.stringify(value);
    assert.ok(!json.includes(ACCESS_TOKEN), `${name} carries no access token`);
    assert.ok(!/Bearer |Authorization/i.test(json), `${name} carries no authorization material`);
  }
  // The booleans survive: the scrub hides the secret, never the fact.
  assert.strictEqual(status.keyConfigured, true, 'the credential PRESENCE fact still crosses the boundary');
  assert.strictEqual(prep.sender.keyConfigured, true, 'and Prepare can still say "Credential: Configured"');
  // The renderer/preload/IPC/markup surface names no endpoint, no header scheme, no token.
  for (const [name, src] of [['renderer', rendererSource], ['preload', preloadSource],
    ['ipc', ipcSource], ['html', htmlSource], ['service', serviceSource]]) {
    assert.ok(!/graph\.facebook/.test(src), `${name} names no WhatsApp endpoint`);
    assert.ok(!/Bearer |Authorization/i.test(stripComments(src)), `${name} carries no authorization scheme`);
    assert.ok(!src.includes(ACCESS_TOKEN), `${name} carries no token value`);
  }
  // The adapter itself holds no token literal either - it is read at send time.
  assert.ok(!adapterSource.includes(ACCESS_TOKEN), 'the adapter source contains no baked-in token');
  // And nothing that was logged carries it either.
  assert.ok(!JSON.stringify(loggerCalls).includes(ACCESS_TOKEN), 'the token never reaches a log line');

  // Through the IPC boundary: even a payload that TRIED to carry a token under a
  // credential-shaped key is scrubbed before it reaches the renderer.
  const handlers = new Map();
  const stub = {
    generate: async () => ({}), get: async () => ({}), latestForLead: async () => null,
    update: async () => ({}), approve: async () => ({}), gate: async () => ({}),
    list: async () => ({ rows: [], total: 0 }),
    send: async () => ({}), sendEmail: async () => ({}), sendWhatsApp: async () => ({}),
    sendList: async () => ({ rows: [], total: 0, limit: 0, offset: 0 }),
    prepare: async () => ({
      leadId: 'L1', pitchId: 'p1', channel: 'whatsapp', sender: { accessToken: ACCESS_TOKEN, keyConfigured: true },
      recipient: { state: 'candidate', contact: LEAD_PHONE, verified: false },
    }),
  };
  registerOutreachIpc({
    ipcMain: { handle: (c, f) => handlers.set(c, f), removeHandler: () => {} },
    outreach: stub,
    isTrustedSender: () => true,
    logger: SILENT,
  });
  const response = await handlers.get(CHANNELS.OUTREACH_PREPARE)({}, { pitchId: 'p1', channel: 'whatsapp' });
  const wire = JSON.stringify(response);
  assert.ok(!wire.includes(ACCESS_TOKEN), 'the IPC response carries no token even from a hostile payload');
  assert.strictEqual(response.data.sender.keyConfigured, true, 'the presence fact survives the scrub');
});

test('O. the access token never appears in the renderer source or the rendered DOM', async () => {
  // Source-level: the renderer knows nothing about tokens, endpoints or this provider id.
  for (const banned of [ACCESS_TOKEN, 'graph.facebook']) {
    assert.ok(!rendererSource.includes(banned), 'renderer source contains no ' + banned);
  }
  assert.ok(!/Bearer\s+[A-Za-z0-9._-]{10,}/.test(rendererSource), 'renderer has no credential-shaped literal');
  assert.ok(!rendererSource.includes('meta-cloud'), 'the provider choice is configuration, never a renderer literal');

  // DOM-level: render the WhatsApp preparation panel and read every word it shows.
  const p = await loadPreparePanel({
    outreach: {
      prepare: () => okResponse(previewWithSender()),
      outreachSend: () => okResponse({ outcome: 'accepted' }),
    },
  });
  p.f18OpenPrepare('p1');
  await settle();
  p.f18SetChannel('whatsapp');
  await settle();
  const body = p.doc.getElementById('f18-prepare-body');
  const text = body.textContent;
  assert.ok(text.includes('WhatsApp provider'), 'the provider row is rendered');
  assert.ok(text.includes('Account'), 'the account row is rendered');
  assert.ok(text.includes('Sender number'), 'the sender-number row is rendered');
  assert.ok(text.includes('Number status'), 'the number-status row is rendered');
  assert.ok(text.includes('Credential'), 'the credential row is rendered');
  assert.ok(text.includes('Capability'), 'the capability row is rendered');
  assert.ok(text.includes('Why'), 'the why row is rendered');
  assert.ok(text.includes('Unavailable'), 'the current honest capability verdict is shown');
  assert.ok(!text.includes(ACCESS_TOKEN), 'no token exists anywhere in the DOM');
  assert.ok(!text.includes('EAAG'), 'nor any token-shaped fragment');
});

// ============================================================ P-R. idempotency, replay, manual retry

test('P. a repeated identical send does not cause a second transport invocation', async () => {
  const spy = spyTransport();
  const { li } = makeRuntime({ L1: lead({}) }, { whatsappProvider: makeMeta(spy), whatsappConfigStore: configuredStore() });
  const { pitch } = await runLead(li, 'L1');

  const first = await li.outreach.sendWhatsApp({ pitchId: pitch.pitch_id });
  assert.strictEqual(first.outcome, 'accepted');
  assert.strictEqual(spy.calls.length, 1);

  const second = await li.outreach.sendWhatsApp({ pitchId: pitch.pitch_id });
  assert.strictEqual(second.outcome, 'replayed', 'the recorded outcome is replayed, honestly labelled');
  assert.strictEqual(second.providerMessageId, first.providerMessageId, 'and it reports the SAME provider id');
  assert.strictEqual(spy.calls.length, 1, 'the provider was contacted exactly once');
  const sends = await li.outreach.sendList({ limit: 10 });
  assert.strictEqual(sends.total, 1, 'no duplicate ledger row was created');
});

test('Q. manual retry after a genuine failure re-enters the same controlled boundary', async () => {
  let attempt = 0;
  const spy = spyTransport(() => {
    attempt += 1;
    return attempt === 1
      ? { status: 503, body: { error: { message: 'later' } } }
      : { status: 200, body: { messages: [{ id: 'wamid.F24_AFTER_RETRY' }] } };
  });
  const { li } = makeRuntime({ L1: lead({}) }, { whatsappProvider: makeMeta(spy), whatsappConfigStore: configuredStore() });
  const { pitch } = await runLead(li, 'L1');

  await assert.rejects(() => li.outreach.sendWhatsApp({ pitchId: pitch.pitch_id }),
    (e) => e.code === 'WHATSAPP_PROVIDER_UNAVAILABLE');
  assert.strictEqual(spy.calls.length, 1);

  // A human retries: the SAME boundary runs again (gate, capability, approval all
  // re-checked) and the provider is invoked once more - permitted because the first
  // attempt was recorded as failed, never as accepted.
  const retry = await li.outreach.sendWhatsApp({ pitchId: pitch.pitch_id });
  assert.strictEqual(retry.outcome, 'accepted');
  assert.strictEqual(spy.calls.length, 2, 'one invocation per human attempt, nothing automatic');

  const sends = await li.outreach.sendList({ limit: 10 });
  assert.strictEqual(sends.total, 2, 'both attempts are in the ledger');
  const states = sends.rows.map((r) => r.state).sort();
  assert.deepStrictEqual(states, ['accepted', 'failed'], 'one failed row and one accepted row');
  const activity = await activityJson(li);
  assert.ok(activity.includes('OUTREACH_SEND_ATTEMPTED'), 'every attempt is auditable');
});

test('R. duplicate confirmation does not produce a duplicate provider invocation', async () => {
  const spy = spyTransport();
  const { li } = makeRuntime({ L1: lead({}) }, { whatsappProvider: makeMeta(spy), whatsappConfigStore: configuredStore() });
  const { pitch } = await runLead(li, 'L1');
  await li.outreach.sendWhatsApp({ pitchId: pitch.pitch_id });
  await li.outreach.sendWhatsApp({ pitchId: pitch.pitch_id });
  await li.outreach.sendWhatsApp({ pitchId: pitch.pitch_id });
  assert.strictEqual(spy.calls.length, 1, 'three confirmations, one invocation');
  assert.strictEqual((await li.outreach.sendList({ limit: 10 })).total, 1, 'and one ledger row');
});

// ============================================================ S-T. no fallback, both directions

test('S. a WhatsApp failure never invokes email', async () => {
  const emailSpy = spyTransport();
  const { ResendEmailProvider } = require(path.join(root, 'src', 'main', 'lead-intelligence', 'outreach', 'email', 'ResendEmailProvider.js'));
  const email = new ResendEmailProvider({ transport: emailSpy.transport, getApiKey: () => 're_fake_f24' });
  const waSpy = spyTransport(() => ({ status: 500, body: { error: { message: 'nope' } } }));
  const { li } = makeRuntime({ L1: lead({}) }, {
    whatsappProvider: makeMeta(waSpy), whatsappConfigStore: configuredStore(),
    emailProvider: email, emailConfigStore: null, email: { enabled: true, fromAddress: 'sender@verified-domain.test' },
  });
  const { pitch } = await runLead(li, 'L1');

  await assert.rejects(() => li.outreach.sendWhatsApp({ pitchId: pitch.pitch_id }),
    (e) => {
      assert.ok(/WHATSAPP/.test(e.code), 'the WHATSAPP failure is what a human gets: ' + e.code);
      assert.ok(!/EMAIL/.test(e.code), 'no email code leaks into a WhatsApp failure');
      return true;
    });
  assert.strictEqual(emailSpy.calls.length, 0, 'the fully configured email transport was NOT used as a fallback');
});

test('T. an email failure never invokes the WhatsApp transport', async () => {
  const waSpy = spyTransport();
  const emailSpy = spyTransport(() => ({ status: 500, body: {} }));
  const { ResendEmailProvider } = require(path.join(root, 'src', 'main', 'lead-intelligence', 'outreach', 'email', 'ResendEmailProvider.js'));
  const email = new ResendEmailProvider({ transport: emailSpy.transport, getApiKey: () => 're_fake_f24' });
  const { li } = makeRuntime({ L1: lead({}) }, {
    whatsappProvider: makeMeta(waSpy), whatsappConfigStore: configuredStore(),
    emailProvider: email, emailConfigStore: null, email: { enabled: true, fromAddress: 'sender@verified-domain.test' },
  });
  const { pitch } = await runLead(li, 'L1');

  await assert.rejects(() => li.outreach.send({ pitchId: pitch.pitch_id, channel: 'email' }),
    (e) => {
      assert.ok(/EMAIL/.test(e.code), 'the EMAIL failure is what a human gets: ' + e.code);
      assert.ok(!/WHATSAPP/.test(e.code), 'no WhatsApp code leaks into an email failure');
      return true;
    });
  assert.strictEqual(waSpy.calls.length, 0, 'the WhatsApp provider was never contacted');
});

// ============================================================ U-AB. invariants

test('U. provider configuration does not affect Ready membership', async () => {
  const cfg = fakeConfigStore({});
  const { li } = makeRuntime({ L1: lead({}), L2: lead({ id: 'L2', title: 'Beta Co' }) }, {
    whatsappProvider: makeMeta(spyTransport()), whatsappConfigStore: cfg,
  });
  await runLead(li, 'L1');
  await runLead(li, 'L2');

  const before = await li.outreach.ready({});
  const beforeIds = before.rows.map((r) => r.pitch.pitch_id).sort();

  // Flip ONLY the WhatsApp configuration to fully verified, in place.
  cfg.data.settings = Object.assign({}, FULL_SETTINGS);
  cfg.data.providers = { 'meta-cloud': { credentials: { apiKey: ACCESS_TOKEN } } };

  const after = await li.outreach.ready({});
  assert.deepStrictEqual(after.rows.map((r) => r.pitch.pitch_id).sort(), beforeIds,
    'the same pitches are Ready, in the same membership, after configuration changes');
  const ctx = await li.contexts.getContext('L1');
  assert.strictEqual(ctx.view.qualification_status, 'qualified', 'qualification is untouched');
});

test('V. the stored lead phone stays a CANDIDATE; the configured sender number is a separate fact', async () => {
  const spy = spyTransport();
  const { li } = makeRuntime({ L1: lead({}) }, { whatsappProvider: makeMeta(spy), whatsappConfigStore: configuredStore() });
  const { pitch } = await runLead(li, 'L1');

  const prep = await li.outreach.prepare({ pitchId: pitch.pitch_id, channel: 'whatsapp' });
  assert.strictEqual(prep.recipient.state, 'candidate', 'the recipient is reported honestly');
  assert.strictEqual(prep.recipient.verified, false, 'preparation never invents verification');
  // OUR number being verified says nothing about THEIR number.
  assert.strictEqual(prep.sender.numberVerification, 'verified');
  assert.strictEqual(prep.recipient.contact, LEAD_PHONE);
  assert.strictEqual(prep.sender.fromNumber, FROM_NUMBER);
  assert.notStrictEqual(prep.recipient.contact, prep.sender.fromNumber, 'recipient and sender are distinct facts');
  // The gate verdict the panel carries is still readiness, unrelated to either number.
  assert.strictEqual(prep.readiness.decision, 'allowed');
});

test('W. provider acceptance is never displayed as delivered/read/seen/clicked', async () => {
  const spy = spyTransport(() => ({ status: 200, body: { messages: [{ id: 'wamid.F24_WORDS_1' }] } }));
  const { li } = makeRuntime({ L1: lead({}) }, { whatsappProvider: makeMeta(spy), whatsappConfigStore: configuredStore() });
  const { pitch } = await runLead(li, 'L1');

  const result = await li.outreach.sendWhatsApp({ pitchId: pitch.pitch_id });
  const sends = await li.outreach.sendList({ limit: 10 });
  const activity = await li.outreach.activityList({ limit: 100 });

  assert.strictEqual(result.deliveryStatus, 'unknown');
  assert.strictEqual(result.openStatus, 'unknown');
  assert.strictEqual(result.clickStatus, 'unknown');
  for (const row of sends.rows) {
    for (const banned of ['delivered', 'opened', 'read', 'clicked', 'received']) {
      assert.ok(!(banned in row), `the ledger row carries no "${banned}" claim`);
    }
  }
  const words = `${JSON.stringify(result)} ${JSON.stringify(sends)} ${JSON.stringify(activity)}`;
  assert.ok(!/\bDelivered\b|\bOpened\b|\bClicked\b|\bRead\b/.test(words),
    'no delivery/open/read/click word appears as a reported state');
});

test('X. no automatic retry: one attempt is one invocation, with no retry loop anywhere', async () => {
  const adapterCode = stripComments(adapterSource);
  const serviceCode = stripComments(serviceSource);
  assert.strictEqual((adapterCode.match(/this\._transport\(/g) || []).length, 1,
    'exactly ONE transport invocation site exists in the adapter');
  assert.ok(!/while\s*\(|for\s*\(.*attempt|\.retry\s*\(/.test(adapterCode), 'the adapter has no retry loop');
  assert.ok(!/setInterval/.test(adapterCode), 'the adapter starts no interval');
  assert.strictEqual((adapterCode.match(/setTimeout\(/g) || []).length, 1,
    'the only timer in the adapter is the single request timeout');
  assert.ok(!/setInterval|node-cron/.test(serviceCode), 'the send boundary schedules nothing');
  // And the send boundary itself still has exactly one provider call site.
  assert.strictEqual((serviceCode.match(/this\.whatsappProvider\.send\(/g) || []).length, 1,
    'the boundary contacts the provider in exactly one place');
});

test('Y. no scheduler and no queue anywhere in the F24 path', () => {
  for (const [name, src] of [['adapter', adapterSource], ['whatsappConfig', whatsappConfigSource], ['service', serviceSource]]) {
    assert.ok(!/setInterval\s*\(/.test(stripComments(src)), name + ' starts no interval');
    assert.ok(!/\b(node-cron|agenda|bull|bee-queue)\b/.test(src), name + ' pulls in no scheduler library');
  }
  assert.ok(!/\b(queue|batch|outbox)\w*\s*\(/i.test(stripComments(adapterSource)), 'the adapter has no queue or batch method');
  assert.ok(!/\b(queue|batch|outbox)\w*\s*\(/i.test(stripComments(serviceSource)), 'the service has no queue or batch method');
});

test('Z. Campaigns remains disabled', () => {
  const nav = [...htmlSource.matchAll(/<button[^>]*class="[^"]*nav-item[^"]*"[^>]*>[\s\S]*?<span class="nav-label">Campaigns<\/span>/g)];
  assert.ok(nav.length >= 1, 'the Campaigns nav item exists');
  for (const block of nav) {
    assert.ok(/\bdisabled\b/.test(block[0]), 'Campaigns stays disabled');
    assert.ok(/nav-item-soon/.test(block[0]), 'Campaigns keeps its later-release state');
    assert.ok(/aria-disabled="true"/.test(block[0]), 'and its aria-disabled state');
  }
  for (const banned of ['sendBatch', 'sendAll', 'scheduleSend']) {
    assert.ok(!adapterSource.includes(banned), `the adapter defines no ${banned}`);
  }
  assert.ok(!/campaign/i.test(stripComments(adapterSource)), 'the adapter contains no campaign logic');
  assert.ok(!/campaign/i.test(stripComments(serviceSource)), 'the service contains no campaign logic');
});

test('AA. no real network: requiring and constructing the adapter makes ZERO network calls', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  try {
    globalThis.fetch = async () => { fetchCalls += 1; return { status: 200, text: async () => '{}' }; };
    // A fresh require through the module cache would be needed to re-run the module body,
    // so the strongest available claim is made: construct the adapter (which performs no
    // I/O by contract) and validate a message - neither may touch the network.
    const inert = new MetaCloudWhatsAppProvider({
      transport: null, getAccessToken: () => ACCESS_TOKEN, getPhoneNumberId: () => PHONE_NUMBER_ID,
    });
    assert.strictEqual(inert.live, true, 'it presents itself as a live adapter');
    assert.strictEqual(typeof inert.send, 'function', 'it implements the provider contract');
    assert.strictEqual(inert.validate({ to: LEAD_PHONE, from: FROM_NUMBER, body: 'hello' }).valid, true,
      'validation is pure and touches no network');
    assert.deepStrictEqual(await inert.getStatus('wamid_x'), { messageId: 'wamid_x', status: 'unknown' });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.strictEqual(fetchCalls, 0, 'requiring or constructing the transport made ZERO network calls');
  // And the unconfigured boundary refuses BEFORE any transport could exist.
  const spy = spyTransport();
  const { li } = makeRuntime({ L1: lead({}) }, { whatsappProvider: makeMeta(spy), whatsappConfigStore: fakeConfigStore({}) });
  const { pitch } = await runLead(li, 'L1');
  await assert.rejects(() => li.outreach.sendWhatsApp({ pitchId: pitch.pitch_id }));
  assert.strictEqual(spy.calls.length, 0, 'with no configuration the transport is never reached');
});

test('AB. no database mutation and no schema migration for F24', async () => {
  const spy = spyTransport();
  const cfg = configuredStore();
  const { li } = makeRuntime({ L1: lead({}) }, { whatsappProvider: makeMeta(spy), whatsappConfigStore: cfg });
  const { pitch } = await runLead(li, 'L1');

  await li.outreach.sendWhatsApp({ pitchId: pitch.pitch_id });
  assert.strictEqual(cfg.calls.set, 0, 'the configuration source was never written from the send path');

  const migrationDir = path.join(root, 'src', 'main', 'lead-intelligence', 'migrations');
  const files = fs.readdirSync(migrationDir);
  // 005_whatsapp_send.sql is the pre-existing F20 send-ledger migration, tracked long
  // before F24; F24 must add NOTHING. The new provider/configuration concepts may not
  // appear in any migration.
  assert.deepStrictEqual(files.filter((f) => /meta|cloud|business|profile|config/i.test(f)), [],
    'no migration file was added for the WhatsApp provider, its configuration or the profile');
  for (const f of files) {
    const sql = fs.readFileSync(path.join(migrationDir, f), 'utf8');
    assert.ok(!/meta-cloud|access.?token|whatsappFromNumber|businessRepresentative/i.test(sql),
      `${f} contains no F24 provider, token or business-profile concept`);
  }
  assert.ok(!/meta-cloud|access.?token/i.test(migrationsSource), 'the migration runner knows nothing about the provider');
  // The credential lives in electron-store, never in the database.
  assert.ok(!/meta-cloud|whatsappProvider/i.test(migrationsSource), 'the schema carries no provider configuration concept');
});

// ============================================================ beyond the matrix

test('AA2. the status payload carries exactly the §16 facts and nothing else', async () => {
  const { li } = makeRuntime({}, { whatsappProvider: makeMeta(spyTransport()), whatsappConfigStore: configuredStore() });
  const status = await li.outreach.getWhatsAppProviderStatus();
  for (const key of ['providerId', 'providerDisplay', 'providerSelected', 'keyConfigured', 'keyReadable',
    'accountConfigured', 'senderConfigured', 'fromNumber', 'numberVerification', 'capability']) {
    assert.ok(key in status, 'the status reports ' + key);
  }
  assert.strictEqual(status.providerSelected, true);
  assert.strictEqual(status.accountConfigured, true);
  assert.strictEqual(status.fromNumber, FROM_NUMBER, 'our sending number, as a safe display value');
  assert.strictEqual(status.numberVerification, 'verified');
  assert.strictEqual(status.capability.canSend, true);
  assert.ok(!JSON.stringify(status).includes(ACCESS_TOKEN), 'and never the token');
});

test('AA3. the adapter contains no business rules - only its contract and errors', () => {
  const code = stripComments(adapterSource);
  const requires = [...code.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
  assert.deepStrictEqual(requires.sort(), ['../../core/errors', './WhatsAppProvider'],
    'it imports ONLY the provider contract and the error type - no store, no lead source, no gate');
  for (const banned of [/getContext/, /outreach\./, /store\./, /\bpitch\b/i, /renderPitch/i, /generate/i,
    /approve/i, /ready\(/, /channel/i]) {
    assert.ok(!banned.test(code), 'the transport makes no business decision: ' + banned);
  }
  // It submits the body it was given, and nothing else.
  assert.ok(/body: message\.body/.test(code), 'the body is passed through, never rewritten');
  assert.ok(!/replace\(|toUpperCase\(|split\(/.test(code), 'no text transformation exists in the transport');
});

test('AA4. the base provider contract is untouched and stays non-live by default', () => {
  assert.strictEqual(new WhatsAppProvider().live, false, 'the base provider is not live by construction');
  assert.ok(/get live\(\)\s*\{\s*return false;/.test(providerBaseSource), 'live defaults to false on the base provider');
  assert.strictEqual(new WhatsAppProvider().id, 'abstract');
  // The ONE adapter opts in deliberately, exactly as F20 requires.
  assert.strictEqual(new MetaCloudWhatsAppProvider({}).live, true);
  assert.strictEqual(new MetaCloudWhatsAppProvider({}).id, 'meta-cloud');
});

test('AA5. the configuration layer is pure: no transport, no I/O, no provider construction', () => {
  const code = stripComments(whatsappConfigSource.slice(whatsappConfigSource.indexOf('function readWhatsAppConfig')));
  for (const banned of [/\bfetch\s*\(/, /XMLHttpRequest/, /require\(['"]https?['"]\)/, /axios/, /\bnew\s+Store/, /\.send\(/]) {
    assert.ok(!banned.test(code), 'the configuration layer performs no transport call: ' + banned);
  }
  // It reads only `settings` and `providers` - never a lead, never a pitch.
  assert.ok(!/lead|pitch|recipient/i.test(code), 'the configuration layer reads no outreach data');
});

// ============================================================ renderer harness (§16 status rows + O)

const F18_MARKER = '// === F18 Outreach:';
const F19_MARKER = '// === F19 Outreach:';
const F12_MARKER = '// === F12 Outreach:';
const F15_MARKER = '// === F15 Outreach:';
const F18_RENDERER = rendererSource.slice(rendererSource.indexOf(F18_MARKER), rendererSource.indexOf(F15_MARKER));
const F19_RENDERER = rendererSource.slice(rendererSource.indexOf(F19_MARKER), rendererSource.indexOf(F12_MARKER));
assert.ok(F18_RENDERER.length > 500 && F19_RENDERER.length > 500, 'the renderer blocks are located');

function makeDoc() {
  const listeners = new WeakMap();
  const registry = [];
  const make = (tag) => {
    const el = {
      tagName: String(tag).toUpperCase(), className: '', children: [], hidden: false, disabled: false,
      attrs: {}, _text: '', id: null, type: '',
      get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); },
      set textContent(v) { this._text = String(v); this.children = []; },
      setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = v; },
      getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
      appendChild(c) { c.__parent = this; this.children.push(c); return c; },
      replaceChildren(...c) { this.children = c; this._text = ''; },
      addEventListener(type, fn) { listeners.set(el, (listeners.get(el) || []).concat([{ type, fn }])); },
      fire(type) { if (this.disabled) return; for (const l of (listeners.get(this) || [])) if (l.type === type) l.fn({ type }); },
      remove() {
        const ix = registry.indexOf(this);
        if (ix !== -1) registry.splice(ix, 1);
        const parent = this.__parent;
        if (parent) parent.children = parent.children.filter((x) => x !== this);
        this.children = [];
      },
      byTag(tag) {
        const want = String(tag).toUpperCase();
        const out = [];
        const walk = (n) => { for (const c of n.children) { if (c.tagName === want) out.push(c); walk(c); } };
        walk(this);
        return out;
      },
      classList: { add() {}, remove() {}, contains() { return false; } },
    };
    registry.push(el);
    return el;
  };
  const body = make('body');
  return {
    body,
    createElement: make,
    getElementById: (id) => { for (let i = registry.length - 1; i >= 0; i--) if (registry[i].id === id) return registry[i]; return null; },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
  };
}

function loadPreparePanel(api) {
  const doc = makeDoc();
  const sandbox = {
    document: doc, console, Promise, Date, JSON, Math, Object, Array, Number, String,
    Boolean, Error, Set, Map, RegExp, isNaN, parseInt, parseFloat,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.ztechLeadIntel = api;
  sandbox.f11LeadIntel = () => sandbox.ztechLeadIntel;
  sandbox.f11Unwrap = (res) => {
    if (res && res.ok === true) return res.data;
    const e = new Error((res && res.error && res.error.message) || 'The request failed.');
    e.code = (res && res.error && res.error.code) || 'ERROR';
    throw e;
  };
  sandbox.f11Status = (text, tone) => { const el = doc.createElement('span'); el.textContent = text; el.setAttribute('data-state', tone); return el; };
  sandbox.f11AlertBox = (err) => { const el = doc.createElement('div'); el.textContent = (err && err.code ? err.code + ': ' : '') + (err && err.message || ''); return el; };
  sandbox.f11El = (tag, cls, text) => { const el = doc.createElement(tag); el.className = cls || ''; el.textContent = text === undefined ? '' : String(text); return el; };
  const names = Object.keys(sandbox);
  const fn = new Function(...names, F18_RENDERER + '\n' + F19_RENDERER +
    '\nreturn { f18OpenPrepare, f18ClosePrepare, f18SetChannel, f18PrepareLoad, f18PrepareRenderFooter, f18PrepareState, f19SendState, f19ResetSend, f19OpenSendConfirm, f19ConfirmSend };');
  const loaded = fn.apply(null, names.map((n) => sandbox[n]));
  loaded.doc = doc;
  return loaded;
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const okResponse = (data) => ({ ok: true, data });

/** A WhatsApp preparation response with the F24 sender profile, as the real service returns. */
const previewWithSender = (delivery = null, sender = null) => ({
  leadId: 'L1', pitchId: 'p1', channel: 'whatsapp', leadName: 'Acme Bakery',
  recipient: { state: 'candidate', contact: LEAD_PHONE, verified: false, verifiedSource: null },
  content: {
    subject: 'A few notes on acme.example.com', body: 'The pitch body text.',
    bodySource: 'renderPitchText', evidenceReferences: [],
    transformationNote: 'No WhatsApp-specific message transformation exists in this build.',
  },
  readiness: { decision: 'allowed', reasons: [], warnings: [], channel: 'email' },
  delivery: delivery || {
    channel: 'whatsapp', canSend: false, emailEnabled: false, providerConfigured: true,
    providerLive: true, blockedCode: 'WHATSAPP_PROVIDER_NOT_SELECTED',
    blockedMessage: 'No WhatsApp provider is selected.',
    deliveryStatus: 'unknown', openStatus: 'unknown', clickStatus: 'unknown',
  },
  sender: sender || {
    providerId: 'meta-cloud', providerDisplay: 'WhatsApp Cloud API', providerSelected: false,
    fromNumber: null, senderConfigured: false, accountConfigured: false,
    numberVerification: 'unknown', keyConfigured: false, keyReadable: false, configured: false,
  },
  contactFacts: { channels: { whatsapp: { state: 'candidate', contact: LEAD_PHONE, verified: false, verifiedSource: null } } },
});

test('S16. the Prepare panel renders the §16 status rows with honest values, no token', async () => {
  const p = await loadPreparePanel({ outreach: { prepare: () => okResponse(previewWithSender()), outreachSend: () => okResponse({}) } });
  p.f18OpenPrepare('p1');
  await settle();
  p.f18SetChannel('whatsapp');
  await settle();
  const text = p.doc.getElementById('f18-prepare-body').textContent;
  assert.ok(text.includes('Not configured'), 'an unconfigured provider reads "Not configured"');
  assert.ok(text.includes('Missing'), 'a missing account and credential read "Missing"');
  assert.ok(text.includes('Unknown'), 'an unknown number status reads "Unknown"');
  assert.ok(text.includes('Unavailable'), 'capability is unavailable');
  assert.ok(text.includes('No WhatsApp provider is selected.'), 'the WHY line shows the factual reason verbatim');
});

// ============================================================ runner

(async () => {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      passed += 1;
      console.log('ok - ' + t.name);
    } catch (err) {
      failed += 1;
      console.log('FAIL - ' + t.name);
      console.log((err && err.stack) || err);
    }
  }
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
