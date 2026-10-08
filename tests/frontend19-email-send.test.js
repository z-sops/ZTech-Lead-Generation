'use strict';

// Frontend 2.0 F19 - the single-message email send boundary (human-triggered, one pitch).
//
// THE REAL PRODUCT CONTRACT these tests pin:
//
//   1. A SEND IS A HUMAN DECISION, MADE TWICE. Opening the panel and reading the preview
//      contacts nothing. The first click only ARMS a confirmation that restates the stored
//      recipient and the subject; the second click is the only call to the bridge. There is
//      no path where a single stray click can mail a prospect.
//   2. THE RENDERER DECIDES NOTHING BUT THE CLICK AND THE REVIEWED CHANNEL. It cannot pass
//      a recipient, a from address, a subject, a body, a provider or a template: the payload
//      is exactly { pitchId, channel } with channel a required closed enum ('email' |
//      'whatsapp') - F25's explicit channel, the Prepare tab a human just reviewed. There is
//      no default channel in the schema or the dispatcher, and no fallback to the other
//      channel in either direction. Readiness is never computed here - the service re-runs
//      the real OutreachGate immediately before a provider is contacted, so a stale or edited
//      panel is refused in the main process no matter what this block renders.
//   3. THE CONTROL APPEARS ONLY WHEN THE BACKEND SAYS IT CAN. The `delivery.canSend` block
//      comes from the same evaluateSendCapability() the send boundary itself uses, so the
//      renderer can never offer a send the main process would refuse. With no live provider
//      configured there is literally nothing to click, and the backend's own refusal text is
//      shown instead.
//   4. THE RESULT IS AN ACKNOWLEDGEMENT, NOT A DELIVERY. `providerAcknowledged` is the only
//      claim about the outside world. Delivery, open and click are always rendered 'unknown'
//      and this file greps the block to prove no code path can print "delivered", "opened"
//      or "clicked" as a fact.
//   5. NOTHING IS BATCHED, QUEUED, SCHEDULED OR RETRIED. One click sends one message for one
//      pitch id. There is no loop, no timer, no queue and no retry counter in the block.
//
// The A-section tests run the REAL runtime (real bridge, real gate, real provider contract)
// over a real MemoryStore. The D-section tests use DOM doubles to drive the REAL f18*/f19*
// renderer functions, and the S-section pins the declared surface locks.

const fs = require('fs');
const { withTrustOffer, grantTrustForLeadsSync } = require('./trust-fixture'); // F26.5
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const ipcSource = fs.readFileSync(path.join(root, 'src', 'main', 'lead-intelligence', 'outreach-ipc.js'), 'utf8');
const serviceSource = fs.readFileSync(path.join(root, 'src', 'main', 'lead-intelligence', 'outreach', 'OutreachService.js'), 'utf8');
const rendererSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'renderer.js'), 'utf8');
const { registerOutreachIpc, CHANNELS, INPUT_SCHEMAS } = require(path.join(root, 'src', 'main', 'lead-intelligence', 'outreach-ipc.js'));
const { MemoryStore } = require(path.join(root, 'src', 'main', 'lead-intelligence', 'persistence', 'MemoryStore.js'));
const { EmailProvider } = require(path.join(root, 'src', 'main', 'lead-intelligence', 'outreach', 'email', 'EmailProvider.js'));
const { FakeEmailProvider } = require(path.join(root, 'src', 'main', 'lead-intelligence', 'outreach', 'email', 'FakeEmailProvider.js'));
const { evaluateSendCapability } = require(path.join(root, 'src', 'main', 'lead-intelligence', 'outreach', 'email', 'sendConfig.js'));
const { createLeadIntelligence } = require(path.join(root, 'src', 'main', 'lead-intelligence', 'index.js'));
const { LiError } = require(path.join(root, 'src', 'main', 'lead-intelligence', 'core', 'errors.js'));
const { round1PacketMapper } = require(path.join(root, 'src', 'main', 'lead-intelligence', 'round1PacketMapper.js'));
const { round1Record, zuniV1Packet } = require(path.join(root, 'tests', 'lead-intelligence', 'fixtures', 'round1Record.js'));

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const CLOCK_ISO = '2026-10-02T10:00:00.000Z';
const CAPTURED_AT = '2026-10-01T10:00:00.000Z';
const clock = () => new Date(CLOCK_ISO);
const SILENT = { info() {}, warn() {}, error() {} };

const OFFER = {
  sender_name: 'Zee',
  sender_company: 'ZuniTech',
  value_proposition: 'We help local businesses fix the website issues found in an audit like this one.',
  call_to_action: 'Would a short call next week be useful to go through these points?',
};

const lead = (o) => Object.assign({
  id: 'L1', title: 'Acme Bakery', website: 'https://acme.example.com', email: 'hello@acme.example.com',
  phone: '+92 300 1234567', address: '12 Road', qualification: 'qualified',
}, o);

function fakeRound1Port(records) {
  const rows = [...records];
  const byNewest = (a, b) => (a.updatedAt < b.updatedAt ? 1 : -1);
  return {
    async getLatest(leadId) { return rows.filter((r) => String(r.leadRef) === String(leadId)).sort(byNewest)[0] || null; },
    async listByLead(leadId) { return rows.filter((r) => String(r.leadRef) === String(leadId)).sort(byNewest); },
    async listLatestPerLead() {
      const m = new Map();
      for (const r of [...rows].sort(byNewest)) if (!m.has(String(r.leadRef))) m.set(String(r.leadRef), r);
      return m;
    },
  };
}

/**
 * A provider that is EXPLICITLY live, built on the real base class rather than on
 * FakeEmailProvider. F19's rule is that `live === true` is a deliberate opt-in no
 * simulation can inherit by accident, so the honest test double has to say so out loud.
 */
function liveProvider(overrides = {}) {
  // `id` and `live` are GETTERS on the base class, so they cannot be assigned onto an
  // instance. This subclass overrides them the way a real adapter must, which is exactly the
  // deliberate opt-in F19 requires.
  class TestLiveProvider extends EmailProvider {
    constructor() { super(); this.calls = []; }
    get id() { return 'test-live'; }
    get live() { return true; }
    async send(message) {
      this.calls.push(message);
      // The documented EmailProvider receipt shape: { messageId, status }. A provider
      // acknowledgement is deliberately NOT a delivery receipt.
      return { messageId: 'pm_test_1', status: 'queued' };
    }
  }
  const p = new TestLiveProvider();
  if (overrides && overrides.send) p.send = overrides.send;
  return p;
}

function makeRuntime(leads, { emailProvider = null, email = {} } = {}) {
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
    round1: fakeRound1Port(records),
    config: {
      research: { mode: 'round1' },
      freshness: { completeMaxAgeDays: 30, partialMaxAgeDays: 7 },
      outreach: { allowedQualification: ['qualified'], allowPartialEvidence: false, requireIcpFit: false },
      offer: withTrustOffer(OFFER), // F26.5 declared update: + postal_address (sender identity)
      email: Object.assign({ enabled: true, fromAddress: 'zee@zunitech.example.com' }, email),
    },
    clock,
    logger: SILENT,
    round1ResultMapper: round1PacketMapper,
    emailProvider,
  });
  return { li, store };
}

async function runLead(li, leadId, { approve = true } = {}) {
  await li.research.sync({ leadId });
  const pitch = await li.outreach.generate({ leadId });
  const approval = approve ? await li.outreach.approve({ pitchId: pitch.pitch_id }) : null;
  const gate = await li.outreach.gate({ pitchId: pitch.pitch_id });
  return { pitch, approval, gate };
}

const ok = (data) => ({ ok: true, data });
const bad = (code, message) => ({ ok: false, error: { code, message } });

// ============================================================ A. the real boundary

test('A1. a live provider with a gate-allowed pitch sends once and reports acknowledgement only', async () => {
  const provider = liveProvider();
  const { li, store } = makeRuntime({ L1: lead({}) }, { emailProvider: provider });
  const { pitch, gate } = await runLead(li, 'L1');
  assert.strictEqual(gate.decision, 'allowed', 'the fixture pitch is allowed, so this tests the send path');

  const result = await li.outreach.sendEmail({ pitchId: pitch.pitch_id });
  assert.strictEqual(result.outcome, 'accepted');
  assert.strictEqual(result.providerAcknowledged, true);
  assert.strictEqual(result.providerMessageId, 'pm_test_1');
  // The three unobservable facts. Not true, not false: unknown.
  assert.strictEqual(result.deliveryStatus, 'unknown');
  assert.strictEqual(result.openStatus, 'unknown');
  assert.strictEqual(result.clickStatus, 'unknown');
  // ONE call, ONE message, addressed from the configured sender to the stored contact.
  assert.strictEqual(provider.calls.length, 1);
  assert.strictEqual(provider.calls[0].to, 'hello@acme.example.com');
  assert.strictEqual(provider.calls[0].from, 'zee@zunitech.example.com');
  assert.strictEqual(provider.calls[0].subject, pitch.subject);

  // The durable ledger is the audit trail, so the acceptance is asserted in storage too,
  // not only in the returned value the renderer happened to receive.
  const listed = await store.sends.list({ pitchId: pitch.pitch_id });
  assert.strictEqual(listed.total, 1, 'exactly one ledger row exists for this pitch');
  assert.strictEqual(listed.rows[0].state, 'accepted');
  assert.strictEqual(listed.rows[0].provider_message_id, 'pm_test_1');
  assert.strictEqual(listed.rows[0].channel, 'email');
});

test('A2. the same approved content is never sent twice: the second call is a replay', async () => {
  const provider = liveProvider();
  const { li } = makeRuntime({ L1: lead({}) }, { emailProvider: provider });
  const { pitch } = await runLead(li, 'L1');

  const first = await li.outreach.sendEmail({ pitchId: pitch.pitch_id });
  const second = await li.outreach.sendEmail({ pitchId: pitch.pitch_id });
  assert.strictEqual(first.outcome, 'accepted');
  assert.strictEqual(second.outcome, 'replayed', 'the second attempt is refused the provider');
  assert.strictEqual(second.providerAcknowledged, true);
  assert.strictEqual(provider.calls.length, 1, 'the provider was contacted exactly once in total');
  assert.strictEqual(second.deliveryStatus, 'unknown', 'a replay is not a delivery claim');
});

test('A3. a simulated provider is refused before any provider call, because live is opt-in', async () => {
  const provider = new FakeEmailProvider();
  assert.strictEqual(provider.live, false, 'FakeEmailProvider is not live by construction');
  const { li } = makeRuntime({ L1: lead({}) }, { emailProvider: provider });
  const { pitch } = await runLead(li, 'L1');
  await assert.rejects(() => li.outreach.sendEmail({ pitchId: pitch.pitch_id }), (e) => {
    // The NOT_LIVE code is the interlock: it names the real problem rather than a generic
    // failure, which is exactly what lets the renderer explain the refusal.
    assert.ok(e.code.includes('NOT_LIVE'), 'the refusal names the live interlock, got ' + e.code);
    return true;
  });
  assert.strictEqual((provider.sent || provider.messages || []).length, 0, 'the fake provider was never called');
});

test('A4. a pitch the real gate does not allow is refused before any provider call', async () => {
  const provider = liveProvider();
  // 'unqualified' is refused by the shipped OutreachGate - no stub, no re-implemented rule.
  const { li } = makeRuntime({ L1: lead({ qualification: 'unqualified' }) }, { emailProvider: provider });
  await li.research.sync({ leadId: 'L1' });
  const pitch = await li.outreach.generate({ leadId: 'L1' });
  const approval = await li.outreach.approve({ pitchId: pitch.pitch_id });
  assert.strictEqual(approval.approval_id !== undefined, true);
  const gate = await li.outreach.gate({ pitchId: pitch.pitch_id });
  assert.strictEqual(gate.decision, 'blocked', 'the real gate blocks this pitch');

  await assert.rejects(() => li.outreach.sendEmail({ pitchId: pitch.pitch_id }), (e) => {
    assert.strictEqual(e.code, 'NOT_READY');
    return true;
  });
  assert.strictEqual(provider.calls.length, 0, 'the provider was never contacted for a blocked pitch');
});

test('A5. disabled email is refused even with a live provider, and the reason says so', async () => {
  const provider = liveProvider();
  const { li } = makeRuntime({ L1: lead({}) }, { emailProvider: provider, email: { enabled: false } });
  const { pitch } = await runLead(li, 'L1');
  await assert.rejects(() => li.outreach.sendEmail({ pitchId: pitch.pitch_id }), (e) => {
    assert.ok(e.code.includes('DISABLED'), 'the refusal names the disabled configuration, got ' + e.code);
    return true;
  });
  assert.strictEqual(provider.calls.length, 0);
});

test('A6. a lead with no stored email has nobody to contact, and is refused', async () => {
  const provider = liveProvider();
  const { li } = makeRuntime({ L1: lead({ email: '' }) }, { emailProvider: provider });
  await li.research.sync({ leadId: 'L1' });
  const pitch = await li.outreach.generate({ leadId: 'L1' });
  await li.outreach.approve({ pitchId: pitch.pitch_id });
  // No stored address means the pitch has no factual email contact, so it never even reaches a
  // send attempt. Whether the refusal is the gate's NOT_READY or the contact-facts refusal
  // depends on which check runs first; both are honest and both happen before any provider.
  await assert.rejects(() => li.outreach.sendEmail({ pitchId: pitch.pitch_id }), (e) => {
    assert.ok(['NOT_READY', 'CHANNEL_UNAVAILABLE', 'CONTACT_FACTS_UNAVAILABLE'].includes(e.code),
      'a typed refusal, got ' + e.code);
    return true;
  });
  assert.strictEqual(provider.calls.length, 0);
});

test('A7. evaluateSendCapability and the gate report agree, so the renderer cannot be misled', async () => {
  const { li } = makeRuntime({ L1: lead({}) }, { emailProvider: liveProvider() });
  const { pitch } = await runLead(li, 'L1');
  const gate = await li.outreach.gate({ pitchId: pitch.pitch_id });
  assert.strictEqual(gate.delivery.canSend, true, 'a fully configured runtime reports it can send');
  assert.strictEqual(gate.delivery.deliveryStatus, 'unknown', 'and never claims delivery');
  assert.strictEqual(gate.delivery.openStatus, 'unknown');
  assert.strictEqual(gate.delivery.clickStatus, 'unknown');

  // The same function, directly, for the refusal shapes the renderer must respect.
  assert.strictEqual(evaluateSendCapability({ enabled: false, provider: liveProvider(), fromAddress: 'a@b.example.com' }).canSend, false);
  assert.strictEqual(evaluateSendCapability({ enabled: true, provider: null, fromAddress: 'a@b.example.com' }).canSend, false);
  assert.strictEqual(evaluateSendCapability({ enabled: true, provider: liveProvider(), fromAddress: null }).canSend, false);
  assert.strictEqual(evaluateSendCapability({ enabled: true, provider: new FakeEmailProvider(), fromAddress: 'a@b.example.com' }).canSend, false,
    'a simulated provider is never a send capability');
});

test('A8. a provider failure is recorded as FAILED and can be retried into an acceptance', async () => {
  let attempt = 0;
  const provider = liveProvider({
    async send() {
      attempt += 1;
      if (attempt === 1) throw new Error('SMTP connection refused');
      return { messageId: 'pm_second_try', status: 'queued' };
    },
  });
  const { li, store } = makeRuntime({ L1: lead({}) }, { emailProvider: provider });
  const { pitch } = await runLead(li, 'L1');

  await assert.rejects(() => li.outreach.sendEmail({ pitchId: pitch.pitch_id }), /could not accept|EMAIL_SEND_FAILED/);
  const afterFailure = await store.sends.list({ pitchId: pitch.pitch_id });
  assert.strictEqual(afterFailure.total, 1, 'the failed attempt is durable');
  assert.strictEqual(afterFailure.rows[0].state, 'failed');

  // A FAILED row is not an acceptance, so an explicit human retry is allowed and succeeds.
  const retry = await li.outreach.sendEmail({ pitchId: pitch.pitch_id });
  assert.strictEqual(retry.outcome, 'accepted');
  assert.strictEqual(retry.providerMessageId, 'pm_second_try');
  const afterRetry = await store.sends.list({ pitchId: pitch.pitch_id });
  assert.strictEqual(afterRetry.rows.filter((r) => r.state === 'accepted').length, 1,
    'still exactly one ACCEPTED row for the key, whatever the failure history');
});

// ============================================================ B. the IPC surface

function harness(outreach, { trusted = true } = {}) {
  const handlers = new Map();
  const reg = { channels: [] };
  // F20: the registrar now requires sendWhatsApp too, so provide a no-op stub.
  // F25: the generic send() the OUTREACH_SEND handler calls is now an EXPLICIT-CHANNEL
  // dispatcher, so this stub mirrors it exactly: channel 'whatsapp' goes to sendWhatsApp,
  // anything else to sendEmail - and the payloads in this suite always name 'email'. The
  // real dispatcher (and its refusal of an unknown channel) is pinned by
  // tests/f25-unified-send.test.js; the dispatch BEHAVIOUR of this harness exists only so
  // this file's IPC tests observe the payload that actually crosses the boundary.
  // F21: the registrar additionally requires sendList, the read-only send-history read.
  const withSendWhatsApp = Object.assign({
    sendWhatsApp: async () => ({ outcome: 'accepted', providerAcknowledged: true }),
    send: async (a) => {
      if (a && a.channel === 'whatsapp') {
        return outreach.sendWhatsApp ? outreach.sendWhatsApp(a) : { outcome: 'accepted', providerAcknowledged: true };
      }
      return outreach.sendEmail ? outreach.sendEmail(a) : { outcome: 'accepted', providerAcknowledged: true };
    },
    // F21: read-only. It returns an empty page; no F19 test reads a real ledger.
    sendList: async () => ({ rows: [], total: 0, limit: 0, offset: 0 }),
  }, outreach);
  registerOutreachIpc({
    ipcMain: { handle: (c, fn) => { reg.channels.push(c); handlers.set(c, fn); } },
    outreach: withSendWhatsApp,
    isTrustedSender: () => trusted,
    logger: SILENT,
  });
  return { reg, handlers, invoke: (c, payload) => handlers.get(c)({}, payload) };
}

test('B1. the send channel is registered, and its schema admits exactly { pitchId, channel }', async () => {
  const seen = [];
  const { reg, invoke } = harness({
    generate: async () => ({}), get: async () => ({}), latestForLead: async () => null,
    update: async () => ({}), approve: async () => ({}), gate: async () => ({}), list: async () => ({ rows: [], total: 0 }),
    sendEmail: async (a) => { seen.push(a); return { outcome: 'accepted', providerAcknowledged: true }; },
  });
  assert.ok(reg.channels.includes(CHANNELS.OUTREACH_SEND), 'the send channel exists');
  const schema = INPUT_SCHEMAS[CHANNELS.OUTREACH_SEND];
  // F25 lock amendment (was: required === ['pitchId'], properties === ['pitchId']). The
  // renderer must now name the EXPLICIT channel it reviewed, so `channel` is a required
  // closed enum - still exactly two properties, still additionalProperties:false, and a
  // payload without a channel is refused rather than defaulted to email.
  assert.deepStrictEqual(schema.required, ['pitchId', 'channel'], 'both properties are required - no implicit channel');
  // F26.6 declared lock update: + an OPTIONAL mailboxId (an id, never an address or token).
  assert.deepStrictEqual(Object.keys(schema.properties), ['pitchId', 'channel', 'mailboxId'], 'pitchId, channel and an optional mailboxId are the ONLY properties defined');
  assert.deepStrictEqual(schema.properties.channel.enum, ['email', 'whatsapp'], 'the channel enum is the two factual channels');
  assert.strictEqual(schema.additionalProperties, false, 'nothing else can be expressed');

  const res = await invoke(CHANNELS.OUTREACH_SEND, { pitchId: 'p1', channel: 'email' });
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(seen, [{ pitchId: 'p1', channel: 'email' }], 'the service received the id and the explicit channel');
});

test('B2. the renderer cannot smuggle a recipient, body, provider or bad channel through the boundary', async () => {
  let called = false;
  const { invoke } = harness({
    generate: async () => ({}), get: async () => ({}), latestForLead: async () => null,
    update: async () => ({}), approve: async () => ({}), gate: async () => ({}), list: async () => ({ rows: [], total: 0 }),
    sendEmail: async () => { called = true; return {}; },
    sendWhatsApp: async () => { called = true; return {}; },
  });
  const attempts = [
    { pitchId: 'p1', channel: 'email', to: 'victim@example.com' },
    { pitchId: 'p1', channel: 'email', body: 'anything you like' },
    { pitchId: 'p1', channel: 'email', from: 'ceo@zunitech.example.com' },
    { pitchId: 'p1', channel: 'email', provider: 'smtp' },
    // F25 lock amendment (removed: { pitchId: 'p1', channel: 'whatsapp' } was REFUSED).
    // That payload is now the LEGITIMATE explicit WhatsApp send, so refusing it here would
    // pin the obsolete email-only contract. What must still be refused is a channel outside
    // the enum - 'sms' below proves the enum is closed, not loosened.
    { pitchId: 'p1', channel: 'sms' },
    { pitchId: 'p1', channel: 'email', subject: 'rewritten' },
    { pitchId: 'p1' },
    {},
    { leadId: 'L1', pitchId: 'p1', channel: 'email' },
  ];
  for (const payload of attempts) {
    const res = await invoke(CHANNELS.OUTREACH_SEND, payload);
    assert.strictEqual(res.ok, false, JSON.stringify(payload) + ' is refused');
    assert.strictEqual(res.error.code, 'VALIDATION_FAILED', JSON.stringify(payload) + ' is refused by the schema');
  }
  assert.strictEqual(called, false, 'the service never ran for a smuggled payload');
});

test('B3. an untrusted sender is refused before the service is reached', async () => {
  let called = false;
  const { invoke } = harness({
    generate: async () => ({}), get: async () => ({}), latestForLead: async () => null,
    update: async () => ({}), approve: async () => ({}), gate: async () => ({}), list: async () => ({ rows: [], total: 0 }),
    sendEmail: async () => { called = true; return {}; },
  }, { trusted: false });
  const res = await invoke(CHANNELS.OUTREACH_SEND, { pitchId: 'p1', channel: 'email' });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error.code, 'FORBIDDEN');
  assert.strictEqual(called, false);
});

test('B4. the registrar refuses to start a service that cannot send', () => {
  // A build whose service predates F19 would otherwise start cleanly and throw an opaque
  // TypeError the first time a human clicked send.
  const incomplete = {
    generate: async () => ({}), get: async () => ({}), latestForLead: async () => null,
    update: async () => ({}), approve: async () => ({}), gate: async () => ({}), list: async () => ({ rows: [], total: 0 }),
  };
  assert.throws(() => harness(incomplete), /sendEmail/);
});

test('B5. a service refusal crosses the boundary as a typed error, never as a fake success', async () => {
  const { invoke } = harness({
    generate: async () => ({}), get: async () => ({}), latestForLead: async () => null,
    update: async () => ({}), approve: async () => ({}), gate: async () => ({}), list: async () => ({ rows: [], total: 0 }),
    sendEmail: async () => { throw new LiError('EMAIL_DISABLED', 'Email sending is switched off in this build.'); },
  });
  const res = await invoke(CHANNELS.OUTREACH_SEND, { pitchId: 'p1', channel: 'email' });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error.code, 'EMAIL_DISABLED', 'a typed domain refusal crosses the boundary intact');
  assert.ok(!/at .*\.js:\d+/.test(res.error.message), 'no stack trace reaches the renderer');
});

// ============================================================ C/D. the real renderer block

const F18_MARKER = '// === F18 Outreach: preparation review';
const F15_MARKER = '// === F15 Outreach: activity history ===';
const F19_MARKER = '// === F19 Outreach: the send control';
const F12_MARKER = '// === F12 Outreach:';
const F18_RENDERER = rendererSource.slice(rendererSource.indexOf(F18_MARKER), rendererSource.indexOf(F15_MARKER));
const F19_RENDERER = rendererSource.slice(rendererSource.indexOf(F19_MARKER), rendererSource.indexOf(F12_MARKER));
assert.ok(F19_RENDERER.length > 500, 'the F19 renderer block is located');
assert.ok(rendererSource.indexOf(F19_MARKER) > rendererSource.indexOf(F15_MARKER),
  'F19 sits after the F15 block, so it does not interleave into the F18 slice');

function makeDoc19() {
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
      addEventListener(type, fn) { listeners.set(this, (listeners.get(this) || []).concat([{ type, fn }])); },
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
      byText(re) { return this.byTag('*').filter((e) => re.test(e.textContent)); },
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

/** Load the REAL F18 review + F19 send blocks against a DOM double. */
function loadPanel(api) {
  const doc = makeDoc19();
  const sent = [];
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
  sandbox.f11AlertBox = (err) => { const el = doc.createElement('div'); el.textContent = (err && err.code ? err.code + ': ' : '') + (err && err.message ? err.message : ''); return el; };
  sandbox.f11El = (tag, cls, text) => { const el = doc.createElement(tag); el.className = cls || ''; el.textContent = text === undefined ? '' : String(text); return el; };
  const names = Object.keys(sandbox);
  const fn = new Function(...names, F18_RENDERER + '\n' + F19_RENDERER +
    '\nreturn { f18OpenPrepare, f18ClosePrepare, f18SetChannel, f18PrepareLoad, f18PrepareRenderFooter, f18PrepareState, f19SendState, f19ResetSend, f19OpenSendConfirm, f19ConfirmSend };');
  const loaded = fn.apply(null, names.map((n) => sandbox[n]));
  loaded.doc = doc;
  loaded.sent = sent;
  return loaded;
}

const settle = () => new Promise((r) => setTimeout(r, 0));

const previewEmail = (delivery, pitchId = 'p1') => ({
  leadId: 'L1', pitchId, channel: 'email', leadName: 'Acme Bakery',
  recipient: { state: 'available', contact: 'hello@acme.example.com', providerConfigured: null },
  content: {
    subject: 'Three fixes for acme.com', body: 'The pitch body text.',
    bodySource: 'renderPitchText', evidenceReferences: ['audit-1'], transformationNote: null,
  },
  readiness: {
    decision: 'allowed', reasons: [], warnings: [], channel: 'email',
    delivery: Object.assign({ channel: 'email', deliveryStatus: 'unknown', openStatus: 'unknown', clickStatus: 'unknown' }, delivery),
  },
  contactFacts: {
    contacts: { email: { present: true, valid: true, value: 'hello@acme.example.com', state: 'available' },
      phone: { present: true, valid: true, value: '+92 300 1234567' }, website: { present: true, valid: true, value: 'https://acme.example.com' } },
    channels: {
      email: { state: 'available', contact: 'hello@acme.example.com', providerConfigured: null },
      whatsapp: { state: 'candidate', contact: '+92 300 1234567', verified: false, verifiedSource: null },
    },
  },
});

const CAN_SEND = { canSend: true, emailEnabled: true, providerConfigured: true, providerLive: true, blockedCode: null, blockedMessage: null };

const sendResult = (o = {}) => Object.assign({
  channel: 'email', pitchId: 'p1', leadId: 'L1',
  outcome: 'accepted', providerAcknowledged: true, providerId: 'test-live', providerMessageId: 'pm_test_1',
  providerStatus: 'queued', idempotencyKey: 'k',
  deliveryStatus: 'unknown', openStatus: 'unknown', clickStatus: 'unknown',
  sentAt: CLOCK_ISO,
}, o);

const footerOf = (p) => p.doc.getElementById('f18-prepare-footer');
const clickByText = (root, re) => {
  const b = root.byTag('button').find((x) => re.test(x.textContent));
  assert.ok(b, 'a button matching ' + re + ' is rendered; saw: ' + root.byTag('button').map((x) => x.textContent).join(' | '));
  return b;
};

test('D1. with a live provider the footer offers a send control, and the body still offers none', async () => {
  const p = loadPanel({ outreach: { prepare: () => ok(previewEmail(CAN_SEND)), outreachSend: () => ok(sendResult()) } });
  p.f18OpenPrepare('p1');
  await settle();
  const body = p.doc.getElementById('f18-prepare-body');
  assert.ok(/Review only/.test(body.textContent), 'the F18 boundary line is untouched');
  for (const b of body.byTag('button')) {
    assert.ok(!/send/i.test(b.textContent), 'no send control in the read-only body: ' + b.textContent);
  }
  assert.ok(footerOf(p).byTag('button').some((b) => /Send this email/.test(b.textContent)), 'the footer offers the send control');
});

test('D2. when the backend says it cannot send, no control exists and its reason is shown', async () => {
  const p = loadPanel({
    outreach: {
      prepare: () => ok(previewEmail({ canSend: false, blockedCode: 'SEND_NOT_CONFIGURED', blockedMessage: 'Email sending is switched off.' })),
      outreachSend: () => ok(sendResult()),
    },
  });
  p.f18OpenPrepare('p1');
  await settle();
  const footer = footerOf(p);
  assert.strictEqual(footer.byTag('button').filter((b) => /Send this email/.test(b.textContent)).length, 0,
    'there is nothing to click');
  assert.ok(/Email sending is switched off\./.test(footer.textContent), 'the backend refusal is shown verbatim');
});

test('D3. F20: the WhatsApp tab offers a send control when the backend says it can send', async () => {
  const p = loadPanel({
    outreach: {
      prepare: (pl) => ok(pl.channel === 'whatsapp'
        ? Object.assign(previewEmail(CAN_SEND), {
          channel: 'whatsapp',
          recipient: { state: 'available', contact: '+92 300 1234567', verified: true, verifiedSource: 'user' },
          content: Object.assign(previewEmail(CAN_SEND).content, { transformationNote: 'No WhatsApp-specific message transformation exists in this build.' }),
          readiness: Object.assign(previewEmail(CAN_SEND).readiness, { channel: 'whatsapp' }),
        })
        : previewEmail(CAN_SEND)),
      outreachSend: () => ok(sendResult({ channel: 'whatsapp' })),
    },
  });
  p.f18OpenPrepare('p1');
  await settle();
  p.f18SetChannel('whatsapp');
  await settle();
  const footer = footerOf(p);
  // F20: with a live WhatsApp provider configured, the send control appears.
  assert.ok(footer.byTag('button').some((b) => /Send this WhatsApp/.test(b.textContent)),
    'the footer offers the WhatsApp send control when canSend is true');
  assert.ok(/candidate|Not verified/i.test(p.doc.getElementById('f18-prepare-body').textContent) === false,
    'the candidate caveat is NOT shown when WhatsApp is verified and available');
});

test('D4. opening the panel sends nothing: two clicks are required and the first contacts no provider', async () => {
  const calls = [];
  const p = loadPanel({
    outreach: {
      prepare: () => ok(previewEmail(CAN_SEND)),
      outreachSend: (payload) => { calls.push(payload); return ok(sendResult()); },
    },
  });
  p.f18OpenPrepare('p1');
  await settle();
  assert.strictEqual(calls.length, 0, 'reading the preview contacts nothing');

  clickByText(footerOf(p), /Send this email/).fire('click');
  assert.strictEqual(calls.length, 0, 'arming the confirmation still contacts nothing');
  const footer = footerOf(p);
  assert.ok(/hello@acme\.example\.com/.test(footer.textContent), 'the stored recipient is restated before sending');
  assert.ok(/Three fixes for acme\.com/.test(footer.textContent), 'the subject is restated too');
  assert.ok(/Send "Three fixes for acme\.com" to hello@acme\.example\.com\?/.test(footer.textContent),
    'the confirmation states exactly who and what');

  clickByText(footerOf(p), /Yes, send it/).fire('click');
  await settle();
  assert.strictEqual(calls.length, 1, 'the second click is the only send');
  // F25: the payload now carries the EXPLICIT reviewed channel beside the id - still
  // exactly two properties, and nothing else.
  assert.deepStrictEqual(calls[0], { pitchId: 'p1', channel: 'email' }, 'the payload is exactly { pitchId, channel: email }');
});

test('D5. cancelling the confirmation sends nothing and returns to the plain control', async () => {
  const calls = [];
  const p = loadPanel({
    outreach: {
      prepare: () => ok(previewEmail(CAN_SEND)),
      outreachSend: (payload) => { calls.push(payload); return ok(sendResult()); },
    },
  });
  p.f18OpenPrepare('p1');
  await settle();
  clickByText(footerOf(p), /Send this email/).fire('click');
  clickByText(footerOf(p), /Cancel/).fire('click');
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(p.f19SendState.armed, false);
  assert.ok(footerOf(p).byTag('button').some((b) => /Send this email/.test(b.textContent)), 'the plain control is back');
});

test('D6. an acceptance is reported as an acknowledgement with three unknown statuses', async () => {
  const p = loadPanel({ outreach: { prepare: () => ok(previewEmail(CAN_SEND)), outreachSend: () => ok(sendResult()) } });
  p.f18OpenPrepare('p1');
  await settle();
  clickByText(footerOf(p), /Send this email/).fire('click');
  clickByText(footerOf(p), /Yes, send it/).fire('click');
  await settle();
  const text = footerOf(p).textContent;
  assert.ok(/accepted/i.test(text), 'the provider acceptance is stated: ' + text);
  assert.ok(/Delivery unknown/.test(text) && /opened unknown/.test(text) && /clicked unknown/.test(text),
    'the three unobservable facts are shown as unknown: ' + text);
  assert.ok(!/delivered|opened by|clicked by|bounced/i.test(text.replace(/opened unknown/g, '')), 'nothing claims an outcome');
  assert.strictEqual(footerOf(p).byTag('button').filter((b) => /Send this email|Yes, send it/.test(b.textContent)).length, 0,
    'no further send control is offered from the same panel');
});

test('D7. a replay is reported honestly: nothing was sent a second time', async () => {
  const p = loadPanel({
    outreach: {
      prepare: () => ok(previewEmail(CAN_SEND)),
      outreachSend: () => ok(sendResult({ outcome: 'replayed', providerMessageId: 'pm_first' })),
    },
  });
  p.f18OpenPrepare('p1');
  await settle();
  clickByText(footerOf(p), /Send this email/).fire('click');
  clickByText(footerOf(p), /Yes, send it/).fire('click');
  await settle();
  assert.ok(/already accepted|nobody was contacted again/i.test(footerOf(p).textContent), 'a replay is explained, not reported as a new send');
});

test('D8. a typed refusal is shown as a refusal, never softened into a probable send', async () => {
  const p = loadPanel({
    outreach: {
      prepare: () => ok(previewEmail(CAN_SEND)),
      outreachSend: () => bad('SEND_NOT_CONFIGURED', 'Email sending is switched off.'),
    },
  });
  p.f18OpenPrepare('p1');
  await settle();
  clickByText(footerOf(p), /Send this email/).fire('click');
  clickByText(footerOf(p), /Yes, send it/).fire('click');
  await settle();
  const text = footerOf(p).textContent;
  assert.ok(/SEND_NOT_CONFIGURED/.test(text) && /Email sending is switched off\./.test(text), 'the error is shown as-is: ' + text);
  assert.ok(!/accepted|probably|likely/i.test(text), 'no send is implied');
  assert.ok(footerOf(p).byTag('button').some((b) => /Send this email/.test(b.textContent)),
    'the control returns so the human can try again after fixing the configuration');
});

test('D9. closing the panel discards the armed confirmation and any result', async () => {
  const p = loadPanel({ outreach: { prepare: () => ok(previewEmail(CAN_SEND)), outreachSend: () => ok(sendResult()) } });
  p.f18OpenPrepare('p1');
  await settle();
  clickByText(footerOf(p), /Send this email/).fire('click');
  assert.strictEqual(p.f19SendState.armed, true);
  p.f18ClosePrepare();
  assert.strictEqual(p.f19SendState.armed, false, 'nothing survives the close');
  assert.strictEqual(p.f19SendState.result, null);
  assert.strictEqual(p.doc.getElementById('f18-prepare-overlay'), null, 'the panel is gone');
});

test('D10. a result belonging to another pitch can never be shown against this one', async () => {
  let resolveSend;
  const p = loadPanel({
    outreach: {
      prepare: (pl) => ok(previewEmail(CAN_SEND, pl.pitchId)),
      outreachSend: () => new Promise((r) => { resolveSend = () => r(ok(sendResult())); }),
    },
  });
  p.f18OpenPrepare('p1');
  await settle();
  clickByText(footerOf(p), /Send this email/).fire('click');
  clickByText(footerOf(p), /Yes, send it/).fire('click');
  await settle();
  // The panel is closed and reopened for a DIFFERENT pitch while the first send is in flight.
  p.f18ClosePrepare();
  p.f18OpenPrepare('p2');
  await settle();
  resolveSend();
  await settle();
  assert.strictEqual(p.f18PrepareState.data.pitchId, 'p2');
  assert.strictEqual(p.f19SendState.result, null, 'the late response painted nothing');
  assert.ok(!/accepted/i.test(footerOf(p).textContent), 'the new pitch shows no result: ' + footerOf(p).textContent);
});

test('D11. the send block has no batch, queue, schedule, retry, timer or network surface', () => {
  const code = stripComments(F19_RENDERER);
  // No second send surface, and no domain write the renderer is not allowed to perform.
  for (const banned of [
    /sendAll|sendBatch|sendNow|sendLater/, /schedule\w*\s*\(/, /queue\w*\s*\(/, /retry\w*\s*\(/,
    /campaign/i, /setTimeout|setInterval/, /\bwhile\s*\(/, /for\s*\(/,
    /\bfetch\s*\(/, /XMLHttpRequest/, /\bWebSocket\b/, /EventSource/, /innerHTML/, /document\.write/,
    /ipcRenderer/, /require\s*\(/, /\bset\s*\(/,
  ]) {
    assert.ok(!banned.test(code), 'the F19 block must not contain: ' + banned);
  }
  // Exactly one bridge call, and it is the closed send payload.
  const bridgeCalls = [...code.matchAll(/api\.outreach\.(\w+)\s*\(/g)].map((m) => m[1]);
  assert.deepStrictEqual([...new Set(bridgeCalls)], ['outreachSend'], 'the block calls exactly one bridge method');
  // F25 lock amendment (was: /outreachSend\(\{\s*pitchId\s*\}\)/ - "the payload is exactly
  // { pitchId }"). The reviewed channel is now the one intent that crosses the boundary, so
  // the payload is exactly { pitchId, channel } and NOTHING more - the channel enum itself
  // is pinned by B1 and by tests/f25-unified-send.test.js.
  assert.ok(/outreachSend\(\{\s*pitchId\s*,\s*channel\s*\}\)/.test(code), 'the payload is exactly { pitchId, channel }');
  // It cannot express a recipient, content or provider at all. F25: `channel:` is no longer
  // in this list because the channel IS now a renderer-supplied property - but it appears
  // only as the shorthand `{ pitchId, channel }` above, bound to f18PrepareState.channel,
  // so no literal channel value (no provider name, no third channel) is expressible here.
  for (const banned of [/\bto\s*:/, /\bfrom\s*:/, /\bsubject\s*:/, /\bbody\s*:/, /\bprovider\s*:/, /\brecipient\s*:/]) {
    assert.ok(!banned.test(code), 'the F19 payload cannot carry ' + banned);
  }
  // No delivery claim is expressible: the words cannot appear as a rendered state.
  assert.ok(!/['"]delivered['"]|['"]opened['"]|['"]clicked['"]|['"]bounced['"]/.test(code),
    'no delivery outcome literal exists in the block');
});

// ============================================================ S. declared surface locks

test('S1. the bridge exposes exactly one send method and no scheduling surface', () => {
  assert.ok(/outreachSend:\s*\(payload\)\s*=>\s*ipcRenderer\.invoke\('lead-intel:outreach-send'/.test(preloadSource),
    'outreachSend is the single send bridge method');
  // The bridge CODE, not its prose: the F19 comment block names these forbidden methods in
  // order to state their absence, and a comment must not be able to fail a surface check.
  const bridgeCode = stripComments(preloadSource);
  for (const forbidden of [
    /sendAll/, /sendBatch/, /outreachBatch/, /outreachSchedule/, /outreachQueue/, /outreachCampaign/,
    /lead-intel:email-send/, /lead-intel:outreach-batch/, /lead-intel:outreach-schedule/,
  ]) {
    assert.ok(!forbidden.test(bridgeCode), 'the bridge has no such method: ' + forbidden);
  }
  const block = preloadSource.slice(preloadSource.indexOf("exposeInMainWorld('ztechLeadIntel'"));
  const methods = [...block.matchAll(/(\w+):\s*\(payload\)\s*=>\s*ipcRenderer\.invoke\('lead-intel:/g)].map((m) => m[1]);
  // Phase I2: +5 Opportunity Intelligence methods with payload pattern = 16 total.
  const expectedOutreach = ['generate', 'get', 'update', 'regenerate', 'approve', 'gate', 'list', 'activity', 'ready', 'prepare', 'outreachSend', 'sends'];
  const expectedOI = ['request', 'report', 'latest', 'associations', 'pitchContext', 'pitchPreview']; // I7 declared lock update: + pitchPreview
  const expectedI6 = ['forLead']; // I6 declared lock update: the read-only lead timeline
  const expectedF265 = ['forLead', 'suppress', 'lift', 'recordConsent', 'handoff', 'reviewReply']; // F26.5 declared lock update: trust (handoff is not a send) // F26.6 follow-up: + reviewReply (a review, not a send)
  // F26.6 declared lock update: the mailbox methods that take a payload (none sends; there is no
  // mailbox send method on the bridge).
  const expectedF266 = ['connect', 'disconnect', 'setDefault', 'setLimits', 'setGoogleClient', 'setMarketRule', 'removeMarketRule', 'check', 'checkReplies'];
  const expectedF28 = ['create', 'forLead', 'activate', 'pause', 'resume', 'stop', 'setPauseAll']; // F28 declared lock update: follow-up sequences (none sends)
  const expectedF29 = ['list', 'confirm', 'forLead']; // F29 declared lock update: reply categories (none sends)
  assert.deepStrictEqual(methods, [...expectedOutreach, ...expectedOI, ...expectedI6, ...expectedF265, ...expectedF266, ...expectedF28, ...expectedF29],
    'the bridge method list is exactly the eleven declared channels plus Phase I2 Opportunity Intelligence');
  assert.deepStrictEqual(methods.filter((m) => /send/i.test(m) && !/^sends$/.test(m)), ['outreachSend'],
    'outreachSend is still the only sending method; `sends` is the ledger read');
  for (const forbidden of [/sendRetry/, /sendAgain/, /resend/i, /redeliver/i, /scheduleSend/, /queueSend/]) {
    // Comment-stripped: the bridge's own comment NAMES these methods in order to state their
    // absence, and a comment must not be able to fail a surface check.
    assert.ok(!forbidden.test(stripComments(preloadSource)), 'no retry or rescheduling surface on the bridge: ' + forbidden);
  }
});

test('S2. the service surface adds one method and removes none', () => {
  for (const m of ['async sendEmail(', 'async prepare(', 'async gate(', 'async approve(', 'async list(', 'async generate(']) {
    assert.ok(serviceSource.includes(m), 'the service keeps ' + m);
  }
  assert.ok(!/async sendBatch|async scheduleSend|async queueSend|async campaign/.test(serviceSource), 'no batch surface in the service');
  // The acknowledgement-only contract is stated in the code, not just in the tests.
  for (const literal of ["deliveryStatus: 'unknown'", "openStatus: 'unknown'", "clickStatus: 'unknown'"]) {
    assert.ok(serviceSource.includes(literal), 'the service reports ' + literal);
  }
});

test('S3. the renderer keeps the whole F18 review body read-only', () => {
  // The body function only, not the whole F18 slice: the F18 FOOTER is the F19 extension point
  // and legitimately calls the bridge.
  const from = F18_RENDERER.indexOf('function f18PrepareRenderBody');
  const to = F18_RENDERER.indexOf('function f18PrepareRenderFooter', from);
  const bodyBlock = F18_RENDERER.slice(from, to === -1 ? undefined : to);
  const code = stripComments(bodyBlock);
  assert.ok(code.length > 300, 'the body function was located');
  assert.ok(!/outreachSend|api\.outreach\./.test(code), 'the review body calls nothing at all');
  assert.ok(!/Send this email|Yes, send it/.test(code), 'the send control is not in the body');
});

// The same runner shape as the F18 suite: sequential, one line per test, and a final
// "N passed, N failed" line that tests/run-all.js parses.
(async () => {
  let passed = 0;
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++;
      console.log('ok - ' + name);
    } catch (e) {
      failed++;
      console.log('FAIL - ' + name);
      console.log(String((e && e.stack) || e));
    }
  }
  console.log(passed + ' passed, ' + failed + ' failed');
  if (failed > 0) process.exitCode = 1;
})();