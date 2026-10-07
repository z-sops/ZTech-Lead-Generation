'use strict';

// ============================================================ F23
// PLUG & PLAY EMAIL DELIVERY PROVIDER - the safety contract.
//
// F23 adds the REAL Resend transport boundary behind the existing EmailProvider contract,
// plus bounded Plug & Play sender-profile configuration. These tests prove, in the order
// the phase specification lists them:
//
//   EmailProvider contract -> ResendEmailProvider (injected transport, zero network) ->
//   normalized provider result / normalized provider errors -> the EXISTING F19/F20 send
//   ledger and activity semantics, unchanged.
//
// NO REAL EMAIL IS SENT ANYWHERE IN THIS FILE. Every provider path runs through an
// injected transport spy, and the tests assert exact invocation counts so an accidental
// second call - or any call at all when configuration is incomplete - is loud.
//
// The current installation's honest state (no credential, no verified domain) is pinned
// by tests A-E: capability unavailable, zero invocations. Tests may inject a fully
// configured fake profile to exercise the provider path; nothing here manipulates the
// production configuration.

const fs = require('fs');
const { withTrustOffer, grantTrustForLeadsSync } = require('./trust-fixture'); // F26.5
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const serviceSource = read(path.join('src', 'main', 'lead-intelligence', 'outreach', 'OutreachService.js'));
const resendConfigSource = read(path.join('src', 'main', 'lead-intelligence', 'outreach', 'email', 'resendConfig.js'));
const providerSource = read(path.join('src', 'main', 'lead-intelligence', 'outreach', 'email', 'ResendEmailProvider.js'));
const emailProviderSource = read(path.join('src', 'main', 'lead-intelligence', 'outreach', 'email', 'EmailProvider.js'));
const ipcSource = read(path.join('src', 'main', 'lead-intelligence', 'outreach-ipc.js'));
const preloadSource = read('preload.js');
const rendererSource = read(path.join('src', 'renderer', 'renderer.js'));
const htmlSource = read('index.html');
const migrationsSource = read(path.join('src', 'main', 'lead-intelligence', 'persistence', 'migrations.js'));

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// §21 HARD NETWORK GUARD: no test in this file may ever reach a real provider. Any code
// path that forgets to inject the spy transport and falls through to the default transport
// fails loudly here instead of touching the network.
globalThis.fetch = async () => { throw new Error('F23 TEST GUARD: real network is forbidden in this suite'); };

const { ResendEmailProvider, RESEND_TRANSPORT_ERRORS } =
  require(path.join(root, 'src', 'main', 'lead-intelligence', 'outreach', 'email', 'ResendEmailProvider.js'));
const { renderPitchText } =
  require(path.join(root, 'src', 'main', 'lead-intelligence', 'outreach', 'PitchGenerator.js'));
const { MemoryStore } = require(path.join(root, 'src', 'main', 'lead-intelligence', 'persistence', 'MemoryStore.js'));
const { createLeadIntelligence } = require(path.join(root, 'src', 'main', 'lead-intelligence', 'index.js'));
const { round1PacketMapper } = require(path.join(root, 'src', 'main', 'lead-intelligence', 'round1PacketMapper.js'));
const { round1Record, zuniV1Packet } = require(path.join(root, 'tests', 'lead-intelligence', 'fixtures', 'round1Record.js'));
const { WhatsAppProvider } = require(path.join(root, 'src', 'main', 'lead-intelligence', 'outreach', 'whatsapp', 'WhatsAppProvider.js'));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const CLOCK_ISO = '2026-10-04T10:00:00.000Z';
const CAPTURED_AT = '2026-10-01T10:00:00.000Z';
const clock = () => new Date(CLOCK_ISO);
const SILENT = { info() {}, warn() {}, error() {} };

// The secret value that must never escape the main-process configuration boundary.
const TRANSPORT_KEY = 're_f23_transport_key_must_never_leak_77';

const OFFER = {
  sender_name: 'Ada',
  sender_company: 'Northwind Trading',
  value_proposition: 'We help local businesses fix the website issues found in an audit like this one.',
  call_to_action: 'Would a short call next week be useful to go through these points?',
};

const lead = (o) => Object.assign({
  id: 'L1', title: 'Acme Bakery', website: 'https://acme.example.com', email: 'hello@acme.example.com',
  phone: '+923001234567', address: '12 Road', qualification: 'qualified',
}, o);

/** Configuration source double: reads from a plain object, counts every `set`. */
function fakeConfigStore(settings = {}, providers = null) {
  const data = { settings, providers: providers || undefined };
  const calls = { set: 0 };
  return {
    calls,
    data,
    get(key, fallback) {
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
 * A COMPLETE, verified Plug & Play sender profile - none of it hard-coded in product
 * source; it exists only inside this test's injected configuration. Neutral identities on
 * purpose: nothing here is a developer's identity.
 */
const FULL_SETTINGS = Object.freeze({
  emailProvider: 'resend',
  emailEnabled: true,
  emailFromName: 'Acme Robotics',
  emailFromAddress: 'sender@verified-domain.test',
  emailReplyTo: 'reply@verified-domain.test',
  emailDomain: 'verified-domain.test',
  emailDomainVerification: 'verified',
  emailSignature: '--\nAcme Robotics Ltd',
});

const configuredStore = (overrides = {}) =>
  fakeConfigStore(Object.assign({}, FULL_SETTINGS, overrides),
    { resend: { credentials: { apiKey: TRANSPORT_KEY } } });

/** A transport spy: records every request, answers with the given responder. */
function spyTransport(responder) {
  const calls = [];
  const transport = async (request) => {
    calls.push(request);
    if (responder) return responder(request);
    return { status: 200, body: { id: 're_msg_1' } };
  };
  return { calls, transport };
}

/** The F23 provider wired the only way tests are allowed to wire it: injected transport. */
function makeResend(spy) {
  // NOTE: `spy` is the {calls, transport} bundle - the TRANSPORT FUNCTION is what gets
  // injected. Passing the bundle object would silently fall back to the real transport.
  return new ResendEmailProvider({ transport: spy.transport, getApiKey: () => TRANSPORT_KEY });
}

function makeRuntime(leads, { emailProvider = null, email = null, emailConfigStore = undefined, whatsappProvider = null } = {}) {
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
      whatsapp: { enabled: true, fromNumber: '+923001111111' },
      // F23: the send boundary's build-level switch comes from the same Plug & Play
      // settings the product reads; tests inject it explicitly.
      email: Object.assign({ enabled: true, fromAddress: 'sender@verified-domain.test' }, email || {}),
    },
    clock,
    logger: SILENT,
    round1ResultMapper: round1PacketMapper,
    emailProvider,
    emailConfigStore,
    whatsappProvider,
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

// ============================================================ A-E. no invocation without configuration

test('A. missing provider configuration -> no provider invocation', async () => {
  const spy = spyTransport();
  const { li } = makeRuntime({ L1: lead({}) }, {
    emailProvider: makeResend(spy), emailConfigStore: fakeConfigStore({}),
  });
  const { pitch } = await runLead(li, 'L1');

  await assert.rejects(() => li.outreach.send({ pitchId: pitch.pitch_id, channel: 'email' }),
    (e) => e.code === 'EMAIL_PROVIDER_NOT_SELECTED');
  assert.strictEqual(spy.calls.length, 0, 'the transport was never invoked');
  assert.ok((await activityJson(li)).includes('OUTREACH_SEND_BLOCKED'), 'the refusal is recorded as a blocked attempt');
});

test('B. missing credential -> no provider invocation', async () => {
  const spy = spyTransport();
  const { li } = makeRuntime({ L1: lead({}) }, {
    emailProvider: makeResend(spy), emailConfigStore: fakeConfigStore(FULL_SETTINGS),
  });
  const { pitch } = await runLead(li, 'L1');

  await assert.rejects(() => li.outreach.send({ pitchId: pitch.pitch_id, channel: 'email' }),
    (e) => e.code === 'EMAIL_CREDENTIAL_MISSING');
  assert.strictEqual(spy.calls.length, 0, 'the transport was never invoked');
});

test('C. missing sender -> no provider invocation', async () => {
  const spy = spyTransport();
  const { li } = makeRuntime({ L1: lead({}) }, {
    emailProvider: makeResend(spy), emailConfigStore: configuredStore({ emailFromAddress: '' }),
  });
  const { pitch } = await runLead(li, 'L1');

  await assert.rejects(() => li.outreach.send({ pitchId: pitch.pitch_id, channel: 'email' }),
    (e) => e.code === 'EMAIL_SENDER_MISSING');
  assert.strictEqual(spy.calls.length, 0, 'the transport was never invoked');
});

test('D. invalid from address -> no provider invocation', async () => {
  const spy = spyTransport();
  const { li } = makeRuntime({ L1: lead({}) }, {
    emailProvider: makeResend(spy), emailConfigStore: configuredStore({ emailFromAddress: 'not-an-address' }),
  });
  const { pitch } = await runLead(li, 'L1');

  await assert.rejects(() => li.outreach.send({ pitchId: pitch.pitch_id, channel: 'email' }),
    (e) => e.code === 'EMAIL_SENDER_INVALID');
  assert.strictEqual(spy.calls.length, 0, 'the transport was never invoked');

  // And a sender DISPLAY NAME carrying a line break is refused at the same boundary:
  // header-shaped text never reaches message construction, let alone the provider.
  const spy2 = spyTransport();
  const { li: li2 } = makeRuntime({ L1: lead({}) }, {
    emailProvider: makeResend(spy2), emailConfigStore: configuredStore({ emailFromName: 'Acme\nBcc: attacker@evil.test' }),
  });
  const second = await runLead(li2, 'L1');
  await assert.rejects(() => li2.outreach.send({ pitchId: second.pitch.pitch_id, channel: 'email' }),
    (e) => e.code === 'EMAIL_SENDER_INVALID');
  assert.strictEqual(spy2.calls.length, 0, 'the transport was never invoked for a malformed display name');
});

test('E. unverified domain -> no provider invocation', async () => {
  const spy = spyTransport();
  const { li } = makeRuntime({ L1: lead({}) }, {
    emailProvider: makeResend(spy), emailConfigStore: configuredStore({ emailDomainVerification: 'pending' }),
  });
  const { pitch } = await runLead(li, 'L1');

  await assert.rejects(() => li.outreach.send({ pitchId: pitch.pitch_id, channel: 'email' }),
    (e) => e.code === 'EMAIL_DOMAIN_NOT_VERIFIED');
  assert.strictEqual(spy.calls.length, 0, 'the transport was never invoked');
  assert.strictEqual(spy.calls.length, 0, 'and no second call of any kind happened');
});

// ============================================================ F-K. the configured provider path

test('F. fully configured injected capability -> exactly ONE transport invocation', async () => {
  const spy = spyTransport();
  const cfg = configuredStore();
  const { li } = makeRuntime({ L1: lead({}) }, { emailProvider: makeResend(spy), emailConfigStore: cfg });
  const { pitch } = await runLead(li, 'L1');

  const result = await li.outreach.send({ pitchId: pitch.pitch_id, channel: 'email' });
  assert.strictEqual(spy.calls.length, 1, 'exactly one provider invocation');
  assert.strictEqual(result.outcome, 'accepted', 'the send was accepted by the provider');
  assert.strictEqual(result.providerId, 'resend', 'the ledger names the provider that accepted it');
  assert.strictEqual(result.providerAcknowledged, true, 'acknowledgement is the single truthful claim');
  assert.strictEqual(cfg.calls.set, 0, 'and the configuration source was written to ZERO times');

  // The stable idempotency key travels with the request as an extra replay defence.
  const request = spy.calls[0];
  assert.strictEqual(request.headers.Authorization, `Bearer ${TRANSPORT_KEY}`, 'the key authenticates the request');
  const payload = payloadOf(request);
  assert.strictEqual(payload.headers['X-ZTech-Send-Key'], result.idempotencyKey,
    'the stable send key rides with the request');
  assert.strictEqual(request.headers['Idempotency-Key'], result.idempotencyKey,
    'and is also presented as the provider-level idempotency key');
});

test('G. the transport receives the correct recipient', async () => {
  const spy = spyTransport();
  const { li } = makeRuntime({ L1: lead({}) }, { emailProvider: makeResend(spy), emailConfigStore: configuredStore() });
  const { pitch } = await runLead(li, 'L1');

  await li.outreach.send({ pitchId: pitch.pitch_id, channel: 'email' });
  const payload = payloadOf(spy.calls[0]);
  assert.deepStrictEqual(payload.to, ['hello@acme.example.com'], 'the stored lead email, exactly');
});

test('H. the transport receives the configured From Name and From Email', async () => {
  const spy = spyTransport();
  const { li } = makeRuntime({ L1: lead({}) }, { emailProvider: makeResend(spy), emailConfigStore: configuredStore() });
  const { pitch } = await runLead(li, 'L1');

  await li.outreach.send({ pitchId: pitch.pitch_id, channel: 'email' });
  const payload = payloadOf(spy.calls[0]);
  assert.strictEqual(payload.from, 'Acme Robotics <sender@verified-domain.test>',
    'the customer-supplied sender identity, composed by the transport and invented by nobody');
});

test('I. optional Reply-To is propagated correctly', async () => {
  const spy = spyTransport();
  const { li } = makeRuntime({ L1: lead({}) }, { emailProvider: makeResend(spy), emailConfigStore: configuredStore() });
  const { pitch } = await runLead(li, 'L1');

  await li.outreach.send({ pitchId: pitch.pitch_id, channel: 'email' });
  assert.strictEqual(payloadOf(spy.calls[0]).reply_to, 'reply@verified-domain.test');

  // And with no reply-to configured, the field is simply absent - never a default.
  const spy2 = spyTransport();
  const { li: li2 } = makeRuntime({ L1: lead({}) }, {
    emailProvider: makeResend(spy2), emailConfigStore: configuredStore({ emailReplyTo: '' }),
  });
  const second = await runLead(li2, 'L1');
  await li2.outreach.send({ pitchId: second.pitch.pitch_id, channel: 'email' });
  assert.ok(!('reply_to' in payloadOf(spy2.calls[0])), 'no reply-to configured = no reply_to key at all');
});

test('J. the exact final Prepare body equals the transport body', async () => {
  const spy = spyTransport();
  const { li } = makeRuntime({ L1: lead({}) }, { emailProvider: makeResend(spy), emailConfigStore: configuredStore() });
  const { pitch } = await runLead(li, 'L1');

  const prep = await li.outreach.prepare({ pitchId: pitch.pitch_id, channel: 'email' });
  const finalBody = prep.content.finalBody;
  assert.strictEqual(prep.content.body, renderPitchText(pitch), 'the canonical approved body is untouched');
  assert.ok(finalBody.startsWith(prep.content.body), 'the final body is the canonical body plus configuration');
  // F26.5 declared update: the opt-out footer (business name, postal address, unsubscribe line)
  // now follows the signature, so the signature is visible just before it rather than last.
  assert.ok(finalBody.includes('--\nAcme Robotics Ltd\n\n--\n'), 'the configured signature is visibly part of the final body');
  assert.ok(/\nDon't want emails from us\? Reply "unsubscribe"/.test(finalBody), 'and the opt-out footer closes it');

  await li.outreach.send({ pitchId: pitch.pitch_id, channel: 'email' });
  const transportBody = payloadOf(spy.calls[0]).text;
  assert.strictEqual(transportBody, finalBody,
    'byte-for-byte: what Prepare showed IS what the provider received');
  assert.strictEqual(prep.sender.signatureConfigured, true, 'and Prepare declares that a signature exists');
});

test('K. the approved subject contract is preserved', async () => {
  const spy = spyTransport();
  const { li } = makeRuntime({ L1: lead({}) }, { emailProvider: makeResend(spy), emailConfigStore: configuredStore() });
  const { pitch } = await runLead(li, 'L1');

  const prep = await li.outreach.prepare({ pitchId: pitch.pitch_id, channel: 'email' });
  await li.outreach.send({ pitchId: pitch.pitch_id, channel: 'email' });
  const payload = payloadOf(spy.calls[0]);
  assert.strictEqual(payload.subject, pitch.subject, 'the transport subject IS the approved pitch subject');
  assert.strictEqual(prep.content.subject, pitch.subject, 'and Prepare showed that same subject');
  assert.ok(pitch.subject && pitch.subject.length > 0, 'the pitch contract carries a subject (no invented subject anywhere)');
  assert.ok(!/generate.*subject|subject.*generat/i.test(stripComments(providerSource)), 'the transport invents no subject');
});

// ============================================================ L-N. result and error normalization

test('L. a provider acceptance is normalized, never as delivered/opened/clicked', async () => {
  const spy = spyTransport(() => ({ status: 200, body: { id: 're_msg_real_9' } }));
  const { li } = makeRuntime({ L1: lead({}) }, { emailProvider: makeResend(spy), emailConfigStore: configuredStore() });
  const { pitch } = await runLead(li, 'L1');

  const result = await li.outreach.send({ pitchId: pitch.pitch_id, channel: 'email' });
  assert.strictEqual(result.providerMessageId, 're_msg_real_9', 'the factual provider id, unmodified');
  assert.strictEqual(result.providerStatus, 'queued', 'only the provider acknowledgement status is passed through');
  assert.strictEqual(result.deliveryStatus, 'unknown');
  assert.strictEqual(result.openStatus, 'unknown');
  assert.strictEqual(result.clickStatus, 'unknown');
  const asJson = JSON.stringify(result);
  assert.ok(!/delivered|opened|clicked|"read"/i.test(asJson), 'acceptance is never dressed as delivery, open or click');
});

test('M. the factual providerMessageId persists through the existing ledger', async () => {
  const spy = spyTransport(() => ({ status: 200, body: { id: 're_msg_ledger_4' } }));
  const { li } = makeRuntime({ L1: lead({}) }, { emailProvider: makeResend(spy), emailConfigStore: configuredStore() });
  const { pitch } = await runLead(li, 'L1');

  await li.outreach.send({ pitchId: pitch.pitch_id, channel: 'email' });
  const sends = await li.outreach.sendList({ limit: 10 });
  assert.strictEqual(sends.total, 1, 'one ledger row for one accepted send');
  const row = sends.rows[0];
  assert.strictEqual(row.state, 'accepted');
  assert.strictEqual(row.providerId, 'resend');
  assert.strictEqual(row.providerMessageId, 're_msg_ledger_4', 'the factual id is what history shows');
  assert.strictEqual(row.channel, 'email');
  const activity = await activityJson(li);
  assert.ok(activity.includes('OUTREACH_SEND_ACCEPTED'), 'the acceptance is in the activity ledger');
  assert.ok(activity.includes('re_msg_ledger_4'), 'with the factual provider id');
});

test('N. provider failures are normalized to stable codes with safe messages', async () => {
  const cases = [
    { status: 500, body: { name: 'internal_server_error', message: 'raw provider detail should not leak' }, code: 'EMAIL_PROVIDER_UNAVAILABLE' },
    { status: 401, body: { name: 'authentication_error', message: 'bad key' }, code: 'EMAIL_PROVIDER_AUTH_FAILED' },
    { status: 429, body: { name: 'rate_limit_exceeded', message: 'slow down' }, code: 'EMAIL_PROVIDER_RATE_LIMITED' },
    { status: 422, body: { name: 'validation_error', message: 'the to address is invalid' }, code: 'EMAIL_PROVIDER_INVALID_RECIPIENT' },
    { status: 422, body: { name: 'validation_error', message: 'the from address is invalid' }, code: 'EMAIL_PROVIDER_INVALID_SENDER' },
    { status: 403, body: { name: 'forbidden', message: 'domain not verified' }, code: 'EMAIL_PROVIDER_DOMAIN_REJECTED' },
  ];
  for (const c of cases) {
    const spy = spyTransport(() => ({ status: c.status, body: c.body }));
    const { li } = makeRuntime({ L1: lead({}) }, { emailProvider: makeResend(spy), emailConfigStore: configuredStore() });
    const { pitch } = await runLead(li, 'L1');

    await assert.rejects(() => li.outreach.send({ pitchId: pitch.pitch_id, channel: 'email' }),
      (e) => {
        assert.strictEqual(e.code, c.code, `status ${c.status} maps to ${c.code}, got ${e.code}`);
        assert.ok(!/raw provider detail|bad key|slow down/.test(e.message), 'no raw provider text reaches the caller');
        return true;
      });
    const sends = await li.outreach.sendList({ limit: 10 });
    assert.strictEqual(sends.rows[0].state, 'failed', 'the failure is recorded as failed, not accepted');
    assert.strictEqual(sends.rows[0].failureCode, c.code, 'with the stable ZTech code');
    assert.strictEqual(sends.rows[0].providerMessageId, null, 'and no provider id was fabricated');
    assert.strictEqual(spy.calls.length, 1, 'one invocation, no automatic retry');
  }
});

// ============================================================ O. secret isolation

test('O. the API key never appears in status, Prepare, ledger, activity, renderer or IPC', async () => {
  const spy = spyTransport();
  const cfg = configuredStore();
  const { li } = makeRuntime({ L1: lead({}) }, { emailProvider: makeResend(spy), emailConfigStore: cfg });
  const { pitch } = await runLead(li, 'L1');

  const status = await li.outreach.getEmailProviderStatus();
  const prep = await li.outreach.prepare({ pitchId: pitch.pitch_id, channel: 'email' });
  const result = await li.outreach.send({ pitchId: pitch.pitch_id, channel: 'email' });
  const sends = await li.outreach.sendList({ limit: 10 });
  const activity = await li.outreach.activityList({ limit: 100 });

  for (const [name, value] of Object.entries({ status, prep, result, sends, activity })) {
    const json = JSON.stringify(value);
    assert.ok(!json.includes(TRANSPORT_KEY), `${name} carries no API key`);
    assert.ok(!/Bearer |Authorization/i.test(json), `${name} carries no authorization material`);
  }
  // The renderer/preload/IPC surface names no endpoint, no header scheme and no key.
  for (const [name, src] of [['renderer', rendererSource], ['preload', preloadSource],
    ['ipc', ipcSource], ['html', htmlSource], ['emailProviderBase', emailProviderSource]]) {
    assert.ok(!/api\.resend\.com/.test(src), `${name} names no Resend endpoint`);
    assert.ok(!/Bearer |Authorization/i.test(src), `${name} carries no authorization scheme`);
    assert.ok(!src.includes(TRANSPORT_KEY), `${name} carries no key value`);
  }
  // The provider adapter itself holds no key literal either - it is read at send time.
  assert.ok(!providerSource.includes(TRANSPORT_KEY), 'the provider source contains no baked-in key');
});

// ============================================================ P-Q. idempotency and retry

test('P. a repeated identical send does not cause a second provider invocation', async () => {
  const spy = spyTransport();
  const { li } = makeRuntime({ L1: lead({}) }, { emailProvider: makeResend(spy), emailConfigStore: configuredStore() });
  const { pitch } = await runLead(li, 'L1');

  const first = await li.outreach.send({ pitchId: pitch.pitch_id, channel: 'email' });
  assert.strictEqual(first.outcome, 'accepted');
  assert.strictEqual(spy.calls.length, 1);

  const second = await li.outreach.send({ pitchId: pitch.pitch_id, channel: 'email' });
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
      ? { status: 503, body: { name: 'service_unavailable', message: 'later' } }
      : { status: 200, body: { id: 're_msg_after_retry' } };
  });
  const { li } = makeRuntime({ L1: lead({}) }, { emailProvider: makeResend(spy), emailConfigStore: configuredStore() });
  const { pitch } = await runLead(li, 'L1');

  await assert.rejects(() => li.outreach.send({ pitchId: pitch.pitch_id, channel: 'email' }),
    (e) => e.code === 'EMAIL_PROVIDER_UNAVAILABLE');
  assert.strictEqual(spy.calls.length, 1);

  // A human retries: the SAME boundary runs again (gate, capability, approval all
  // re-checked) and the provider is invoked once more - permitted because the first
  // attempt was recorded as failed, never as accepted.
  const retry = await li.outreach.send({ pitchId: pitch.pitch_id, channel: 'email' });
  assert.strictEqual(retry.outcome, 'accepted');
  assert.strictEqual(spy.calls.length, 2, 'one invocation per human attempt, nothing automatic');

  const sends = await li.outreach.sendList({ limit: 10 });
  assert.strictEqual(sends.total, 2, 'both attempts are in the ledger');
  const states = sends.rows.map((r) => r.state).sort();
  assert.deepStrictEqual(states, ['accepted', 'failed'], 'one failed row and one accepted row');
  const blocked = await activityJson(li);
  assert.ok(blocked.includes('OUTREACH_SEND_ATTEMPTED'), 'every attempt is auditable');
});

// ============================================================ R-S. no fallback, both directions

test('R. an email failure never calls WhatsApp', async () => {
  const waCalls = [];
  const wa = new (class extends WhatsAppProvider {
    get id() { return 'test-live-wa'; }
    get live() { return true; }
    async send(m) { waCalls.push(m); return { messageId: 'wa_msg_1', status: 'queued' }; }
  })();
  const spy = spyTransport(() => ({ status: 500, body: {} }));
  const { li } = makeRuntime({ L1: lead({}) }, {
    emailProvider: makeResend(spy), emailConfigStore: configuredStore(), whatsappProvider: wa,
  });
  const { pitch } = await runLead(li, 'L1');

  await assert.rejects(() => li.outreach.send({ pitchId: pitch.pitch_id, channel: 'email' }),
    (e) => {
      assert.ok(/EMAIL/.test(e.code), 'the EMAIL failure is what a human gets: ' + e.code);
      assert.ok(!/WHATSAPP/.test(e.code), 'no WhatsApp code leaks into an email failure');
      return true;
    });
  assert.deepStrictEqual(waCalls, [], 'the WhatsApp provider was never contacted');
});

test('S. a WhatsApp selection never calls the email transport', async () => {
  const spy = spyTransport();
  const { li } = makeRuntime({ L1: lead({}) }, {
    emailProvider: makeResend(spy), emailConfigStore: configuredStore(), whatsappProvider: null,
  });
  const { pitch } = await runLead(li, 'L1');

  await assert.rejects(() => li.outreach.sendWhatsApp({ pitchId: pitch.pitch_id }),
    (e) => {
      assert.ok(/WHATSAPP/.test(e.code), 'the WhatsApp refusal is what a human gets: ' + e.code);
      assert.ok(!/EMAIL/.test(e.code), 'no email code leaks into a WhatsApp refusal');
      return true;
    });
  assert.strictEqual(spy.calls.length, 0, 'the fully configured email transport was NOT used as a fallback');
});

// ============================================================ T-X. invariants

test('T. Ready membership is unaffected by provider configuration', async () => {
  const cfg = fakeConfigStore({});
  const { li } = makeRuntime({ L1: lead({}), L2: lead({ id: 'L2', title: 'Beta Co' }) },
    { emailProvider: makeResend(spyTransport()), emailConfigStore: cfg });
  await runLead(li, 'L1');
  await runLead(li, 'L2');

  const before = await li.outreach.ready({});
  const beforeIds = before.rows.map((r) => r.pitch.pitch_id).sort();

  // Flip ONLY the configuration to fully verified, in place.
  cfg.data.settings = Object.assign({}, FULL_SETTINGS);
  cfg.data.providers = { resend: { credentials: { apiKey: TRANSPORT_KEY } } };

  const after = await li.outreach.ready({});
  assert.deepStrictEqual(after.rows.map((r) => r.pitch.pitch_id).sort(), beforeIds,
    'the same pitches are Ready, in the same membership, after configuration changes');
  const ctx = await li.contexts.getContext('L1');
  assert.strictEqual(ctx.view.qualification_status, 'qualified', 'qualification is untouched');
});

test('U. provider acceptance is never displayed as Delivered/Open/Read/Clicked', async () => {
  const spy = spyTransport(() => ({ status: 200, body: { id: 're_msg_words_1' } }));
  const { li } = makeRuntime({ L1: lead({}) }, { emailProvider: makeResend(spy), emailConfigStore: configuredStore() });
  const { pitch } = await runLead(li, 'L1');

  const result = await li.outreach.send({ pitchId: pitch.pitch_id, channel: 'email' });
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
  // The renderer's own vocabulary for a send result says "accepted", never "delivered".
  assert.ok(!/textContent = 'Delivered'|>'Delivered</.test(rendererSource), 'the renderer never labels a send Delivered');
});

test('V. Campaigns remains disabled', () => {
  const nav = [...htmlSource.matchAll(/<button[^>]*class="[^"]*nav-item[^"]*"[^>]*>[\s\S]*?<span class="nav-label">Campaigns<\/span>/g)];
  assert.ok(nav.length >= 1, 'the Campaigns nav item exists');
  for (const block of nav) {
    assert.ok(/\bdisabled\b/.test(block[0]), 'Campaigns stays disabled');
    assert.ok(/nav-item-soon/.test(block[0]), 'Campaigns keeps its later-release state');
    assert.ok(/aria-disabled="true"/.test(block[0]), 'and its aria-disabled state');
  }
  for (const banned of ['setInterval', 'node-cron', 'sendBatch', 'sendAll', 'scheduleSend']) {
    assert.ok(!providerSource.includes(banned), `the transport defines no ${banned}`);
  }
});

test('W. no scheduler, no queue, no automatic retry anywhere in the F23 path', () => {
  const providerCode = stripComments(providerSource);
  const serviceCode = stripComments(serviceSource);
  assert.ok(!/setInterval|node-cron|agenda|bull|bee-queue/.test(providerCode), 'the provider starts no scheduler or queue');
  assert.ok(!/while\s*\(|for\s*\(.*attempt|\.retry\s*\(/.test(providerCode), 'the provider has no retry loop');
  assert.strictEqual((providerCode.match(/this\._transport\(/g) || []).length, 1,
    'exactly ONE transport invocation site exists in the provider');
  assert.ok(!/setInterval|node-cron/.test(serviceCode), 'the send boundary schedules nothing');
  assert.ok(!/sendBatch|drainQueue|processQueue/.test(serviceCode), 'the send boundary drains no queue');
});

test('X. no database mutation and no schema migration for F23', async () => {
  const spy = spyTransport();
  const cfg = configuredStore();
  const { li } = makeRuntime({ L1: lead({}) }, { emailProvider: makeResend(spy), emailConfigStore: cfg });
  const { pitch } = await runLead(li, 'L1');

  await li.outreach.send({ pitchId: pitch.pitch_id, channel: 'email' });
  assert.strictEqual(cfg.calls.set, 0, 'the configuration source was never written from the send path');

  const migrationDir = path.join(root, 'src', 'main', 'lead-intelligence', 'migrations');
  const files = fs.readdirSync(migrationDir);
  // 004_email_send.sql is the pre-existing F19 send-ledger migration, tracked long before
  // F23; F23 must add NOTHING. Resend/provider concepts may not appear in any migration.
  assert.deepStrictEqual(files.filter((f) => /resend|provider/i.test(f)), [],
    'no migration file was added for the email provider or its configuration');
  for (const f of files) {
    assert.ok(!/resend/i.test(fs.readFileSync(path.join(migrationDir, f), 'utf8')),
      `${f} contains no Resend/provider concept`);
  }
  assert.ok(!/resend|email_provider/i.test(migrationsSource), 'the migration runner knows nothing about the provider');
  // The credential lives in electron-store, never in the database.
  assert.ok(!/apiKey|credential/i.test(migrationsSource) || !/resend/i.test(migrationsSource),
    'the database schema carries no provider credential concept');
});

// ============================================================ beyond the matrix

test('Y. the provider contains no ZTech business rules - only its contract and errors', () => {
  const code = stripComments(providerSource);
  const requires = [...code.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
  assert.deepStrictEqual(requires.sort(), ['../../core/errors', './EmailProvider'],
    'it imports ONLY the provider contract and the error type - no store, no lead source, no gate');
  for (const banned of [/getContext/, /outreach\./, /store\./, /gate\b/i, /\blead\b/i, /\bpitch\b/i,
    /approve/i, /renderPitch/i, /channel/i, /ready\(/]) {
    assert.ok(!banned.test(code), 'the transport makes no business decision: ' + banned);
  }
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
