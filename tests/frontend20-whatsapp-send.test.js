'use strict';

// Frontend 2.0 F20 - WhatsApp behind the SAME single-pitch send boundary.
//
// F19 shipped one outbound channel: email, payload exactly { pitchId }. F20 added a second
// channel WITHOUT adding a second door - the service derived the channel. F25 completes the
// handover: the payload is now exactly { pitchId, channel } with channel a required closed
// enum, so the renderer names the ONE reviewed channel and the service dispatches to that
// channel's existing boundary only. The renderer still cannot name a recipient, a body or a
// provider, and there is still no second door: no fallback exists in either direction.
//
// THE CONTRACT THESE TESTS PIN:
//
//   1. THE CHANNEL IS NEVER DERIVED FROM CAPABILITY, AND THERE IS NO FALLBACK EITHER
//      WAY. `send({ pitchId, channel: 'email' })` reaches the EMAIL boundary only;
//      `send({ pitchId, channel: 'whatsapp' })` reaches the WHATSAPP boundary only; an
//      unknown or missing channel throws before any boundary runs. Each boundary refuses
//      closed with its OWN capability reason when its channel cannot send, and neither ever
//      routes the human's intent to the other channel. A WhatsApp provider that happens to
//      be configured cannot turn an email send into a WhatsApp message, and vice versa -
//      contacting a lead on a channel the operator did not select is exactly the failure
//      this rule exists to prevent. A13/A14/A15/A16 are the four tests that pin it.
//   2. `live` IS STILL AN EXPLICIT OPT-IN. The WhatsAppProvider base class is not live, so
//      every simulated provider is refused with WHATSAPP_PROVIDER_NOT_LIVE before any
//      provider call. This is the interlock, and it is asserted per refusal code.
//   3. READINESS IS READINESS. sendWhatsApp re-runs the EXISTING gate on its own default
//      channel. It does not ask the gate for channel 'whatsapp' - the gate answers
//      CHANNEL_NOT_SUPPORTED for every non-email channel, which would make this boundary
//      refuse every message it exists to send. The WhatsApp-specific narrowing happens after,
//      where a missing number can only REMOVE a send.
//   4. AN UNVERIFIED NUMBER IS SENT ONLY BEHIND AN EXPLICIT HUMAN ACKNOWLEDGEMENT. F18
//      declared a stored phone is at most a `candidate`; no verifier exists. So a candidate is
//      sendable, but the renderer must show the number as unverified on BOTH the review and the
//      confirmation, and the service must refuse a lead with no valid number at all.
//   5. THE RESULT IS AN ACKNOWLEDGEMENT. providerAcknowledged is the only claim about the
//      outside world; delivery/open/click are always 'unknown'.
//   6. NOTHING IS BATCHED, QUEUED, SCHEDULED, RETRIED, OR CALLED. There is no voice-calling
//      surface, and this file greps the WhatsApp blocks to prove it.
//
// A-section: the real runtime, real gate, real MemoryStore, real provider contract.
// B-section: the IPC boundary. D-section: the real renderer against a DOM double.
// S-section: declared surface locks.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const serviceSource = fs.readFileSync(path.join(root, 'src', 'main', 'lead-intelligence', 'outreach', 'OutreachService.js'), 'utf8');
const rendererSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'renderer.js'), 'utf8');
const contractSource = fs.readFileSync(path.join(root, 'src', 'main', 'lead-intelligence', 'persistence', 'contract.js'), 'utf8');
const migration005 = fs.readFileSync(path.join(root, 'src', 'main', 'lead-intelligence', 'migrations', '005_whatsapp_send.sql'), 'utf8');
const whatsappProviderSource = fs.readFileSync(path.join(root, 'src', 'main', 'lead-intelligence', 'outreach', 'whatsapp', 'WhatsAppProvider.js'), 'utf8');
const whatsappConfigSource = fs.readFileSync(path.join(root, 'src', 'main', 'lead-intelligence', 'outreach', 'whatsapp', 'sendConfig.js'), 'utf8');
const { MemoryStore } = require(path.join(root, 'src', 'main', 'lead-intelligence', 'persistence', 'MemoryStore.js'));
const { WhatsAppProvider, validateWhatsAppMessage } = require(path.join(root, 'src', 'main', 'lead-intelligence', 'outreach', 'whatsapp', 'WhatsAppProvider.js'));
const { evaluateSendCapability, checkFromNumber } = require(path.join(root, 'src', 'main', 'lead-intelligence', 'outreach', 'whatsapp', 'sendConfig.js'));
const { EmailProvider } = require(path.join(root, 'src', 'main', 'lead-intelligence', 'outreach', 'email', 'EmailProvider.js'));
const { createLeadIntelligence } = require(path.join(root, 'src', 'main', 'lead-intelligence', 'index.js'));
const { round1PacketMapper } = require(path.join(root, 'src', 'main', 'lead-intelligence', 'round1PacketMapper.js'));
const { round1Record, zuniV1Packet } = require(path.join(root, 'tests', 'lead-intelligence', 'fixtures', 'round1Record.js'));

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const CLOCK_ISO = '2026-10-02T10:00:00.000Z';
const CAPTURED_AT = '2026-10-01T10:00:00.000Z';
const clock = () => new Date(CLOCK_ISO);
const SILENT = { info() {}, warn() {}, error() {} };

const FROM_NUMBER = '+923001111111';
const LEAD_PHONE = '+923001234567';

const OFFER = {
  sender_name: 'Zee',
  sender_company: 'ZuniTech',
  value_proposition: 'We help local businesses fix the website issues found in an audit like this one.',
  call_to_action: 'Would a short call next week be useful to go through these points?',
};

const lead = (o) => Object.assign({
  id: 'L1', title: 'Acme Bakery', website: 'https://acme.example.com', email: 'hello@acme.example.com',
  phone: LEAD_PHONE, address: '12 Road', qualification: 'qualified',
}, o);

function fakeRound1Port(records) {
  const rows = [...records];
  const byNewest = (a, b) => (a.updatedAt < b.updatedAt ? 1 : -1);
  return {
    async getLatest(leadId) { return rows.filter((r) => String(r.leadRef) === String(leadId)).sort(byNewest)[0] || null; },
    async listByLead(leadId) { return rows.filter((r) => String(r.leadRef) === String(leadId)).sort(byNewest); },
    async listLatestPerLead() {
      const m = new Map();
      for (const r of [...rows].sort(byNewest)) if (!m.has(String(r.leadRef))) m.set(r.leadRef, r);
      return m;
    },
  };
}

/**
 * A WhatsApp provider that is EXPLICITLY live, built on the real base class. `live` is a
 * getter there, so the opt-in has to be written out loud in a subclass - which is the point:
 * nothing becomes sendable by accident.
 */
function liveWhatsApp(overrides = {}) {
  class TestLiveWhatsApp extends WhatsAppProvider {
    constructor() { super(); this.calls = []; }
    get id() { return 'test-live-wa'; }
    get live() { return true; }
    async send(message) {
      this.calls.push(message);
      return { messageId: 'wa_msg_1', status: 'queued' };
    }
  }
  const p = new TestLiveWhatsApp();
  if (overrides && overrides.send) p.send = overrides.send;
  return p;
}

function makeRuntime(leads, { whatsappProvider = null, whatsapp = {}, emailProvider = null, email = {} } = {}) {
  const store = new MemoryStore();
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
      offer: OFFER,
      // F20 default: WhatsApp is OFF unless a test/config opts in. This is the F19 posture.
      whatsapp: Object.assign({ enabled: true, fromNumber: FROM_NUMBER }, whatsapp),
      email: Object.assign({ enabled: false, fromAddress: 'zee@zunitech.example.com' }, email),
    },
    clock,
    logger: SILENT,
    round1ResultMapper: round1PacketMapper,
    emailProvider,
    whatsappProvider,
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

test('A1. a live WhatsApp provider sends once to the STORED number and reports acknowledgement only', async () => {
  const provider = liveWhatsApp();
  const { li, store } = makeRuntime({ L1: lead({}) }, { whatsappProvider: provider });
  const { pitch, gate } = await runLead(li, 'L1');
  assert.strictEqual(gate.decision, 'allowed', 'the fixture pitch is allowed, so this tests the send path');

  const result = await li.outreach.sendWhatsApp({ pitchId: pitch.pitch_id });
  assert.strictEqual(result.outcome, 'accepted');
  assert.strictEqual(result.channel, 'whatsapp');
  assert.strictEqual(result.providerAcknowledged, true);
  assert.strictEqual(result.providerMessageId, 'wa_msg_1');
  // The three unobservable facts. Not true, not false: unknown.
  assert.strictEqual(result.deliveryStatus, 'unknown');
  assert.strictEqual(result.openStatus, 'unknown');
  assert.strictEqual(result.clickStatus, 'unknown');

  // ONE call, addressed from the configured number to the number stored on the lead.
  assert.strictEqual(provider.calls.length, 1);
  assert.strictEqual(provider.calls[0].to, LEAD_PHONE);
  assert.strictEqual(provider.calls[0].from, FROM_NUMBER);
  assert.ok(provider.calls[0].body.length > 0, 'the canonical pitch text is the message body');
  // The caller supplied nothing but a pitch id, so the number can only have come from storage.
  assert.ok(!JSON.stringify(pitch).includes(LEAD_PHONE), 'the pitch record carries no recipient');
  assert.ok(!JSON.stringify(pitch).includes('"to"'), 'the pitch record carries no recipient field either');
  assert.strictEqual(pitch.phone, undefined, 'and the pitch itself carries no phone at all');

  const listed = await store.sends.list({ pitchId: pitch.pitch_id });
  assert.strictEqual(listed.total, 1, 'exactly one ledger row exists for this pitch');
  assert.strictEqual(listed.rows[0].state, 'accepted');
  assert.strictEqual(listed.rows[0].channel, 'whatsapp');
  assert.strictEqual(listed.rows[0].provider_message_id, 'wa_msg_1');
});

test('A2. the same approved content is never sent twice: the second call is a replay', async () => {
  const provider = liveWhatsApp();
  const { li } = makeRuntime({ L1: lead({}) }, { whatsappProvider: provider });
  const { pitch } = await runLead(li, 'L1');

  const first = await li.outreach.sendWhatsApp({ pitchId: pitch.pitch_id });
  const second = await li.outreach.sendWhatsApp({ pitchId: pitch.pitch_id });
  assert.strictEqual(first.outcome, 'accepted');
  assert.strictEqual(second.outcome, 'replayed', 'the second attempt is refused the provider');
  assert.strictEqual(second.providerAcknowledged, true);
  assert.strictEqual(provider.calls.length, 1, 'the provider was contacted exactly once in total');
  assert.strictEqual(second.deliveryStatus, 'unknown', 'a replay is not a delivery claim');
});

test('A3. the two channels have SEPARATE idempotency keys for the same content', async () => {
  const wa = liveWhatsApp();
  const email = new (class extends EmailProvider {
    constructor() { super(); this.calls = []; }
    get id() { return 'test-live'; }
    get live() { return true; }
    async send(m) { this.calls.push(m); return { messageId: 'pm_1', status: 'queued' }; }
  })();
  const { li } = makeRuntime({ L1: lead({}) }, { whatsappProvider: wa, emailProvider: email, email: { enabled: true } });
  const { pitch } = await runLead(li, 'L1');

  const viaEmail = await li.outreach.sendEmail({ pitchId: pitch.pitch_id });
  const viaWhatsApp = await li.outreach.sendWhatsApp({ pitchId: pitch.pitch_id });
  assert.strictEqual(viaEmail.outcome, 'accepted');
  assert.strictEqual(viaWhatsApp.outcome, 'accepted', 'a WhatsApp send is not a replay of the email send');
  assert.notStrictEqual(viaEmail.idempotencyKey, viaWhatsApp.idempotencyKey,
    'the key is channel-scoped, so one channel cannot suppress the other');
  assert.strictEqual(email.calls.length, 1);
  assert.strictEqual(wa.calls.length, 1);
});

test('A4. a non-live provider is refused before any provider call, because live is opt-in', async () => {
  const provider = new WhatsAppProvider();
  assert.strictEqual(provider.live, false, 'the base provider is not live by construction');
  const { li } = makeRuntime({ L1: lead({}) }, { whatsappProvider: provider });
  const { pitch } = await runLead(li, 'L1');
  await assert.rejects(() => li.outreach.sendWhatsApp({ pitchId: pitch.pitch_id }), (e) => {
    assert.strictEqual(e.code, 'WHATSAPP_PROVIDER_NOT_LIVE');
    return true;
  });
  assert.strictEqual(provider.calls, undefined, 'the abstract provider was never called');
});

test('A5. disabled WhatsApp is refused even with a live provider, and the reason says so', async () => {
  const provider = liveWhatsApp();
  const { li } = makeRuntime({ L1: lead({}) }, { whatsappProvider: provider, whatsapp: { enabled: false } });
  const { pitch } = await runLead(li, 'L1');
  await assert.rejects(() => li.outreach.sendWhatsApp({ pitchId: pitch.pitch_id }), (e) => {
    assert.strictEqual(e.code, 'WHATSAPP_DISABLED');
    return true;
  });
  assert.strictEqual(provider.calls.length, 0);
});

test('A6. no provider at all is refused with its own code, not a generic failure', async () => {
  const { li } = makeRuntime({ L1: lead({}) }, { whatsappProvider: null });
  const { pitch } = await runLead(li, 'L1');
  await assert.rejects(() => li.outreach.sendWhatsApp({ pitchId: pitch.pitch_id }), (e) => {
    assert.strictEqual(e.code, 'WHATSAPP_PROVIDER_NOT_SET');
    return true;
  });
});

test('A7. a missing or invalid from-number is refused before any provider call', async () => {
  const missing = liveWhatsApp();
  const a = makeRuntime({ L1: lead({}) }, { whatsappProvider: missing, whatsapp: { fromNumber: '' } });
  const ra = await runLead(a.li, 'L1');
  await assert.rejects(() => a.li.outreach.sendWhatsApp({ pitchId: ra.pitch.pitch_id }), (e) => {
    assert.strictEqual(e.code, 'WHATSAPP_FROM_MISSING');
    return true;
  });
  assert.strictEqual(missing.calls.length, 0);

  const invalid = liveWhatsApp();
  const b = makeRuntime({ L1: lead({}) }, { whatsappProvider: invalid, whatsapp: { fromNumber: 'not-a-number' } });
  const rb = await runLead(b.li, 'L1');
  await assert.rejects(() => b.li.outreach.sendWhatsApp({ pitchId: rb.pitch.pitch_id }), (e) => {
    assert.strictEqual(e.code, 'WHATSAPP_FROM_INVALID');
    return true;
  });
  assert.strictEqual(invalid.calls.length, 0);
});

test('A8. a lead with no usable phone number is refused, and no provider is contacted', async () => {
  const provider = liveWhatsApp();
  const { li } = makeRuntime({ L1: lead({ phone: '' }) }, { whatsappProvider: provider });
  await li.research.sync({ leadId: 'L1' });
  const pitch = await li.outreach.generate({ leadId: 'L1' });
  await li.outreach.approve({ pitchId: pitch.pitch_id });
  await assert.rejects(() => li.outreach.sendWhatsApp({ pitchId: pitch.pitch_id }), (e) => {
    // Either the gate's NOT_READY or the contact-facts refusal is honest; both precede the
    // provider. What must never happen is a send to a number that does not exist.
    assert.ok(['NOT_READY', 'CHANNEL_UNAVAILABLE'].includes(e.code), 'unexpected code ' + e.code);
    return true;
  });
  assert.strictEqual(provider.calls.length, 0, 'nobody without a number was contacted');
});

test('A9. a pitch the real gate does not allow is refused before any provider call', async () => {
  const provider = liveWhatsApp();
  const { li } = makeRuntime({ L1: lead({ qualification: 'unqualified' }) }, { whatsappProvider: provider });
  await li.research.sync({ leadId: 'L1' });
  const pitch = await li.outreach.generate({ leadId: 'L1' });
  await li.outreach.approve({ pitchId: pitch.pitch_id });
  assert.strictEqual((await li.outreach.gate({ pitchId: pitch.pitch_id })).decision, 'blocked', 'the real gate blocks this pitch');

  await assert.rejects(() => li.outreach.sendWhatsApp({ pitchId: pitch.pitch_id }), (e) => {
    assert.strictEqual(e.code, 'NOT_READY');
    return true;
  });
  assert.strictEqual(provider.calls.length, 0, 'the provider was never contacted for a blocked pitch');
});

test('A10. an unapproved pitch is refused: WhatsApp contact data cannot create readiness', async () => {
  const provider = liveWhatsApp();
  const { li } = makeRuntime({ L1: lead({}) }, { whatsappProvider: provider });
  const { pitch, gate } = await runLead(li, 'L1', { approve: false });
  assert.strictEqual(gate.decision, 'blocked');
  assert.ok(gate.reasons.some((r) => r.code === 'HUMAN_APPROVAL'), 'blocked for approval, not for a contact');
  await assert.rejects(() => li.outreach.sendWhatsApp({ pitchId: pitch.pitch_id }), (e) => {
    assert.strictEqual(e.code, 'NOT_READY');
    return true;
  });
  assert.strictEqual(provider.calls.length, 0);
});

test('A11. a provider failure is recorded as FAILED and does not become a fake acceptance', async () => {
  const { LiError } = require(path.join(root, 'src', 'main', 'lead-intelligence', 'core', 'errors.js'));
  const provider = liveWhatsApp({
    send: async () => { throw new LiError('WHATSAPP_REJECTED', 'The provider refused the message.'); },
  });
  const { li, store } = makeRuntime({ L1: lead({}) }, { whatsappProvider: provider });
  const { pitch } = await runLead(li, 'L1');
  await assert.rejects(() => li.outreach.sendWhatsApp({ pitchId: pitch.pitch_id }), (e) => {
    assert.strictEqual(e.code, 'WHATSAPP_REJECTED');
    return true;
  });
  const listed = await store.sends.list({ pitchId: pitch.pitch_id });
  assert.strictEqual(listed.total, 1);
  assert.strictEqual(listed.rows[0].state, 'failed', 'a refusal is never recorded as accepted');
  assert.strictEqual(listed.rows[0].failure_code, 'WHATSAPP_REJECTED');
});

test('A12. the activity ledger records the channel, and no recipient or body leaks into metadata', async () => {
  const provider = liveWhatsApp();
  const { li } = makeRuntime({ L1: lead({}) }, { whatsappProvider: provider });
  const { pitch } = await runLead(li, 'L1');
  await li.outreach.sendWhatsApp({ pitchId: pitch.pitch_id });

  const events = await li.outreach.activityList({ pitchId: pitch.pitch_id });
  const attempted = events.rows.find((r) => r.activity_type === 'OUTREACH_SEND_ATTEMPTED');
  const accepted = events.rows.find((r) => r.activity_type === 'OUTREACH_SEND_ACCEPTED');
  assert.ok(attempted && accepted, 'both send events exist');
  assert.strictEqual(attempted.metadata.channel, 'whatsapp', 'the channel is recorded in metadata');
  assert.strictEqual(accepted.metadata.channel, 'whatsapp');
  const serialised = JSON.stringify(events);
  assert.ok(!serialised.includes(LEAD_PHONE), 'the phone number never enters the activity ledger');
  assert.ok(!serialised.includes(FROM_NUMBER), 'the from-number never enters the activity ledger');
});

test('A13. CHANNEL SELECTION: the EXPLICIT email channel runs the email boundary only, even when WhatsApp can send', async () => {
  const wa = liveWhatsApp();
  const emailCalls = [];
  const email = new (class extends EmailProvider {
    constructor() { super(); }
    get id() { return 'test-live'; }
    get live() { return true; }
    async send(m) { emailCalls.push(m); return { messageId: 'pm_1', status: 'queued' }; }
  })();
  const { li } = makeRuntime({ L1: lead({}) }, { whatsappProvider: wa, emailProvider: email, email: { enabled: true } });
  const { pitch } = await runLead(li, 'L1');

  // F25: the channel is now named, not defaulted - and naming 'email' reaches the email
  // boundary and nothing else.
  const result = await li.outreach.send({ pitchId: pitch.pitch_id, channel: 'email' });
  assert.strictEqual(result.channel, 'email', 'the explicit email selection ran the email boundary');
  assert.strictEqual(emailCalls.length, 1);
  assert.strictEqual(wa.calls.length, 0, 'WhatsApp was NOT used even though a number exists');
});

test('A14. CHANNEL SELECTION: email capability unavailable FAILS CLOSED - never a silent WhatsApp send', async () => {
  const wa = liveWhatsApp();
  // Email configured but DISABLED - exactly the state F19 refused by contacting nobody.
  const { li } = makeRuntime({ L1: lead({}) }, { whatsappProvider: wa, email: { enabled: false } });
  const { pitch } = await runLead(li, 'L1');

  // The channel is NOT derived from capability. A human whose send boundary is email and
  // whose email capability is unavailable gets that channel's own factual refusal, and the
  // fact that WhatsApp happens to be able to send is irrelevant: contacting the lead on a
  // channel they did not select is the thing this test exists to make impossible.
  await assert.rejects(() => li.outreach.send({ pitchId: pitch.pitch_id, channel: 'email' }), (e) => {
    assert.ok(/EMAIL/.test(e.code), 'the email capability refusal is reported, got ' + e.code);
    assert.ok(!/WHATSAPP/.test(e.code), 'no WhatsApp code leaks into an email refusal: ' + e.code);
    return true;
  });
  assert.strictEqual(wa.calls.length, 0, 'NO automatic email -> WhatsApp fallback: the live WhatsApp provider was never contacted');
});

test('A15. CHANNEL SELECTION: when neither channel can send, the refusal is EMAIL\'s (F19 parity)', async () => {
  const { li } = makeRuntime({ L1: lead({}) }, { whatsappProvider: null, email: { enabled: false } });
  const { pitch } = await runLead(li, 'L1');
  await assert.rejects(() => li.outreach.send({ pitchId: pitch.pitch_id, channel: 'email' }), (e) => {
    // A human who only ever configured email must never be shown a WhatsApp-shaped error.
    assert.ok(!/WHATSAPP/.test(e.code), 'no WhatsApp code leaks into an email-only refusal: ' + e.code);
    assert.ok(/EMAIL/.test(e.code), 'the email refusal is reported, got ' + e.code);
    return true;
  });
});

test('A16. only the pitch id and the explicit channel cross the boundary: recipient and provider cannot be smuggled', async () => {
  const wa = liveWhatsApp();
  const emailCalls = [];
  const email = new (class extends EmailProvider {
    get id() { return 'test-live'; }
    get live() { return true; }
    async send(m) { emailCalls.push(m); return { messageId: 'pm_1', status: 'queued' }; }
  })();
  const { li } = makeRuntime({ L1: lead({}) }, { whatsappProvider: wa, emailProvider: email, email: { enabled: true } });
  const { pitch } = await runLead(li, 'L1');
  // F25 lock amendment (was: channel:'whatsapp' was IGNORED and the email boundary ran).
  // The channel is now the ONE renderer intent the dispatcher honours, so this payload
  // legitimately reaches the WhatsApp boundary - what must still be ignored is everything
  // else: the smuggled recipient (+1 555...) and the smuggled provider name 'evil' never
  // reach the provider, because both are re-derived from stored facts in the main process.
  await li.outreach.send({ pitchId: pitch.pitch_id, channel: 'whatsapp', to: '+1 555 000 0000', provider: 'evil' });
  assert.strictEqual(wa.calls.length, 1, 'the explicit whatsapp channel ran the WhatsApp boundary exactly once');
  assert.strictEqual(emailCalls.length, 0, 'and the email boundary was never reached');
  assert.strictEqual(wa.calls[0].to, LEAD_PHONE,
    'the smuggled recipient was ignored; the stored contact fact was used');
  assert.ok(!JSON.stringify(wa.calls).includes('evil'), 'the smuggled provider was ignored');
  assert.ok(!JSON.stringify(wa.calls).includes('+1 555'), 'the smuggled recipient appears nowhere in the payload');
});

// ============================================================ B. capability + message contracts

test('B1. the capability evaluator refuses in a fixed order, one reason at a time', () => {
  const live = liveWhatsApp();
  assert.deepStrictEqual(
    evaluateSendCapability({ enabled: false, provider: live, fromNumber: FROM_NUMBER }).code, 'WHATSAPP_DISABLED');
  assert.deepStrictEqual(
    evaluateSendCapability({ enabled: true, provider: null, fromNumber: FROM_NUMBER }).code, 'WHATSAPP_PROVIDER_NOT_SET');
  assert.deepStrictEqual(
    evaluateSendCapability({ enabled: true, provider: new WhatsAppProvider(), fromNumber: FROM_NUMBER }).code, 'WHATSAPP_PROVIDER_NOT_LIVE');
  assert.deepStrictEqual(
    evaluateSendCapability({ enabled: true, provider: live, fromNumber: '' }).code, 'WHATSAPP_FROM_MISSING');
  assert.deepStrictEqual(
    evaluateSendCapability({ enabled: true, provider: live, fromNumber: 'nope' }).code, 'WHATSAPP_FROM_INVALID');

  const good = evaluateSendCapability({ enabled: true, provider: live, fromNumber: '  ' + FROM_NUMBER + ' ' });
  assert.strictEqual(good.canSend, true);
  assert.strictEqual(good.providerId, 'test-live-wa');
  assert.strictEqual(good.providerLive, true);
  // The NORMALISED number travels with the verdict, so the boundary cannot re-parse it.
  assert.strictEqual(good.fromNumber, FROM_NUMBER);
});

test('B2. the capability and the gate agree, so the renderer cannot be misled', async () => {
  const provider = liveWhatsApp();
  const { li } = makeRuntime({ L1: lead({}) }, { whatsappProvider: provider });
  const { pitch } = await runLead(li, 'L1');
  const direct = li.outreach.sendCapability('whatsapp');
  assert.strictEqual(direct.canSend, true);
  // The gate is asked on its own channel, and the PREPARE response carries the WhatsApp
  // capability beside readiness - never inside it.
  const prep = await li.outreach.prepare({ pitchId: pitch.pitch_id, channel: 'whatsapp' });
  assert.strictEqual(prep.delivery.channel, 'whatsapp');
  assert.strictEqual(prep.delivery.canSend, direct.canSend);
  assert.strictEqual(prep.delivery.providerId, direct.providerId);
  assert.ok(!/whatsapp/i.test(JSON.stringify(prep.readiness)), 'readiness stays the email verdict, verbatim');
  assert.strictEqual(prep.recipient.state, 'candidate', 'the recipient is reported honestly');
  assert.strictEqual(prep.recipient.verified, false, 'preparation never invents verification');
});

test('B3. message validation is the provider\'s own, and refuses before any send', () => {
  const okMsg = { to: LEAD_PHONE, from: FROM_NUMBER, body: 'hello' };
  assert.strictEqual(validateWhatsAppMessage(okMsg).valid, true);
  assert.strictEqual(validateWhatsAppMessage({ to: 'nope', from: FROM_NUMBER, body: 'x' }).valid, false);
  assert.strictEqual(validateWhatsAppMessage({ to: LEAD_PHONE, from: FROM_NUMBER, body: '' }).valid, false);
  assert.strictEqual(validateWhatsAppMessage({ to: LEAD_PHONE + '\nBcc: x@y.z', from: FROM_NUMBER, body: 'x' }).valid, false);
  assert.strictEqual(validateWhatsAppMessage({ to: LEAD_PHONE, from: FROM_NUMBER, body: 'x'.repeat(4097) }).valid, false);
  // The from-number rule is the same rule, so a number that passes the capability cannot
  // fail later for a different reason.
  assert.strictEqual(checkFromNumber(FROM_NUMBER).ok, true);
  // F20: a catalogue-shaped value is NORMALISED rather than refused for formatting, and the
  // normalised form is what travels with the verdict - so the wire value is the checked value.
  assert.deepStrictEqual(checkFromNumber('+92 300 111 1111'), { ok: true, value: FROM_NUMBER });
  assert.strictEqual(checkFromNumber('+92 300 1234567').ok, true, 'spacing alone is not a reason to refuse');
  assert.strictEqual(checkFromNumber('+92-300-1234567').ok, true, 'nor is punctuation');
  // A trunk prefix is refused rather than guessed: stripping it would produce a DIFFERENT,
  // wrong number, and a wrong number looks exactly like a delivered message.
  assert.strictEqual(checkFromNumber('+44 (0)20 7123 4567').ok, false, 'a trunk prefix is never silently stripped');
  assert.strictEqual(checkFromNumber('+0923001234567').ok, false, 'but a zero country code is not E.164');
  // No leading '+' means no country code, and ZTech does not invent one.
  assert.strictEqual(checkFromNumber('23001234567').ok, false);
});

// ============================================================ C. IPC

const ipcSource = fs.readFileSync(path.join(root, 'src', 'main', 'lead-intelligence', 'outreach-ipc.js'), 'utf8');
const { registerOutreachIpc, CHANNELS, INPUT_SCHEMAS } = require(path.join(root, 'src', 'main', 'lead-intelligence', 'outreach-ipc.js'));

function ipcHarness(outreach, { trusted = true } = {}) {
  const handlers = new Map();
  const reg = { channels: [] };
  // F21: the registrar now also requires sendList, the read-only send-ledger read. It is
  // stubbed by default and an explicit `sendList: undefined` still reaches the guard, because
  // Object.assign copies an own property whose value is undefined.
  const withSendList = Object.assign({
    sendList: async () => ({ rows: [], total: 0, limit: 0, offset: 0 }),
    getEmailProviderStatus: async () => ({ 
      providerId: 'resend', providerDisplay: 'Resend', providerSelected: true,
      credentialConfigured: true, credentialPresent: true, senderConfigured: true,
      fromName: 'Test', fromAddress: 'test@example.com', domainConfigured: true,
      domain: 'example.com', domainVerification: 'verified',
      capability: { canSend: true, code: null, message: null, providerId: 'resend', providerDisplay: 'Resend', providerLive: true }
    })
  }, outreach);
  registerOutreachIpc({
    ipcMain: { handle: (c, f) => { reg.channels.push(c); handlers.set(c, f); } },
    outreach: withSendList,
    isTrustedSender: () => trusted,
    logger: SILENT,
  });
  return { reg, handlers, invoke: (c, payload) => handlers.get(c)({}, payload) };
}

test('C1. the send payload is exactly { pitchId, channel }, and nothing else is admitted', async () => {
  const seen = [];
  const stub = {
    generate: async () => ({}), get: async () => ({}), latestForLead: async () => null,
    update: async () => ({}), approve: async () => ({}), gate: async () => ({}),
    list: async () => ({ rows: [], total: 0 }),
    send: async (a) => { seen.push(a); return { outcome: 'accepted', providerAcknowledged: true }; },
    sendEmail: async () => ({}), sendWhatsApp: async () => ({}),
    // F21: the registrar requires the read-only ledger read as well.
    sendList: async () => ({ rows: [], total: 0, limit: 0, offset: 0 }),
  };
  const { invoke } = ipcHarness(stub);
  // F25 lock amendment (was: { pitchId: 'p1 } alone, with channel 'whatsapp' REFUSED).
  // The explicit channel is now required and 'whatsapp' is its legitimate value - this is
  // the payload the reviewed WhatsApp tab actually sends. Everything else stays refused.
  const res = await invoke(CHANNELS.OUTREACH_SEND, { pitchId: 'p1', channel: 'whatsapp' });
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(seen, [{ pitchId: 'p1', channel: 'whatsapp' }],
    'the service receives the pitch id and the explicit channel, and nothing else');

  for (const bad of [
    { pitchId: 'p1' },
    { pitchId: 'p1', channel: 'sms' },
    { pitchId: 'p1', channel: 'whatsapp', to: '+1' },
    { pitchId: 'p1', channel: 'whatsapp', body: 'x' },
  ]) {
    const refused = await invoke(CHANNELS.OUTREACH_SEND, bad);
    assert.strictEqual(refused.ok, false, 'refused: ' + JSON.stringify(bad));
    assert.strictEqual(refused.error.code, 'VALIDATION_FAILED');
  }
  assert.strictEqual(seen.length, 1, 'no refused payload ever reached the service');
  assert.strictEqual(INPUT_SCHEMAS[CHANNELS.OUTREACH_SEND].additionalProperties, false);
});

test('C2. the registrar refuses to start a service that cannot send', () => {
  const base = {
    generate: async () => ({}), get: async () => ({}), latestForLead: async () => null,
    update: async () => ({}), approve: async () => ({}), gate: async () => ({}),
    list: async () => ({ rows: [], total: 0 }), sendEmail: async () => ({}), sendWhatsApp: async () => ({}),
    // F21: the registrar also requires the read-only ledger read.
    sendList: async () => ({ rows: [], total: 0, limit: 0, offset: 0 }),
  };
  assert.throws(() => ipcHarness(base), /must implement send$/);
  assert.throws(() => ipcHarness(Object.assign({ send: async () => ({}) }, base, { sendWhatsApp: undefined })),
    /must implement sendWhatsApp/);
  assert.throws(() => ipcHarness(Object.assign({ send: async () => ({}) }, base, { sendList: undefined })),
    /must implement sendList/);
});

test('C3. an untrusted sender is refused before the service is reached', async () => {
  let called = false;
  const stub = {
    generate: async () => ({}), get: async () => ({}), latestForLead: async () => null,
    update: async () => ({}), approve: async () => ({}), gate: async () => ({}), list: async () => ({ rows: [], total: 0 }),
    send: async () => { called = true; return {}; }, sendEmail: async () => ({}), sendWhatsApp: async () => ({}),
  };
  const { invoke } = ipcHarness(stub, { trusted: false });
  const res = await invoke(CHANNELS.OUTREACH_SEND, { pitchId: 'p1' });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error.code, 'FORBIDDEN');
  assert.strictEqual(called, false);
});

// ============================================================ D. the renderer

const F18_MARKER = '// === F18 Outreach:';
const F19_MARKER = '// === F19 Outreach:';
const F12_MARKER = '// === F12 Outreach:';
const F15_MARKER = '// === F15 Outreach:';
const F18_RENDERER = rendererSource.slice(rendererSource.indexOf(F18_MARKER), rendererSource.indexOf(F15_MARKER));
const F19_RENDERER = rendererSource.slice(rendererSource.indexOf(F19_MARKER), rendererSource.indexOf(F12_MARKER));
assert.ok(F18_RENDERER.length > 500 && F19_RENDERER.length > 500, 'the renderer blocks are located');

function makeDoc20() {
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

function loadPanel(api) {
  const doc = makeDoc20();
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
  return loaded;
}

const settle = () => new Promise((r) => setTimeout(r, 0));

const CAN_SEND_WA = {
  channel: 'whatsapp', canSend: true, emailEnabled: false, providerConfigured: true,
  providerLive: true, blockedCode: null, blockedMessage: null,
  deliveryStatus: 'unknown', openStatus: 'unknown', clickStatus: 'unknown',
};

/** A WhatsApp preparation response, exactly as the real service returns one. */
const previewWhatsApp = (delivery = CAN_SEND_WA, over = {}) => Object.assign({
  leadId: 'L1', pitchId: 'p1', channel: 'whatsapp', leadName: 'Acme Bakery',
  recipient: { state: 'candidate', contact: LEAD_PHONE, verified: false, verifiedSource: null },
  content: {
    subject: 'Three fixes for acme.com', body: 'The pitch body text.',
    bodySource: 'renderPitchText', evidenceReferences: ['audit-1'],
    transformationNote: 'No WhatsApp-specific message transformation exists in this build.',
  },
  readiness: {
    decision: 'allowed', reasons: [], warnings: [], channel: 'email',
    delivery: { channel: 'email', canSend: false, blockedCode: 'EMAIL_DISABLED', blockedMessage: 'Email sending is switched off in this build.' },
  },
  delivery,
  contactFacts: { channels: { whatsapp: { state: 'candidate', contact: LEAD_PHONE, verified: false, verifiedSource: null } } },
}, over);

const waResult = (o = {}) => Object.assign({
  channel: 'whatsapp', pitchId: 'p1', leadId: 'L1', outcome: 'accepted',
  providerAcknowledged: true, providerId: 'test-live-wa', providerMessageId: 'wa_msg_1',
  providerStatus: 'queued', idempotencyKey: 'k',
  deliveryStatus: 'unknown', openStatus: 'unknown', clickStatus: 'unknown', sentAt: CLOCK_ISO,
}, o);

const footerOf = (p) => p.doc.getElementById('f18-prepare-footer');
const clickByText = (root, re) => {
  const b = root.byTag('button').find((x) => re.test(x.textContent));
  assert.ok(b, 'a button matching ' + re + ' is rendered; saw: ' + root.byTag('button').map((x) => x.textContent).join(' | '));
  return b;
};

const openWhatsApp = async (api) => {
  const p = loadPanel(api);
  p.f18OpenPrepare('p1');
  await settle();
  p.f18SetChannel('whatsapp');
  await settle();
  return p;
};

test('D1. the WhatsApp tab offers a send control when the backend says it can send', async () => {
  const p = await openWhatsApp({ outreach: { prepare: () => ok(previewWhatsApp()), outreachSend: () => ok(waResult()) } });
  assert.ok(footerOf(p).byTag('button').some((b) => /Send this WhatsApp/.test(b.textContent)),
    'the control is offered for WhatsApp, not just for email');
  // The body stays a review: no control up there.
  for (const b of p.doc.getElementById('f18-prepare-body').byTag('button')) {
    assert.ok(!/send/i.test(b.textContent), 'no send control in the read-only body');
  }
});

test('D2. the WhatsApp tab is gated on WHATSApp capability, not the email one', async () => {
  // Email disabled, WhatsApp live: the WhatsApp tab must still offer its control, because the
  // capability read is the one for the channel on screen.
  const p = await openWhatsApp({ outreach: { prepare: () => ok(previewWhatsApp()), outreachSend: () => ok(waResult()) } });
  assert.ok(/Send this WhatsApp/.test(footerOf(p).textContent));

  // And the reverse: WhatsApp not configured means no WhatsApp control, whatever email says.
  const blocked = Object.assign({}, CAN_SEND_WA, {
    canSend: false, blockedCode: 'WHATSAPP_PROVIDER_NOT_LIVE',
    blockedMessage: 'The configured WhatsApp provider cannot deliver real messages.',
  });
  const q = await openWhatsApp({ outreach: { prepare: () => ok(previewWhatsApp(blocked)), outreachSend: () => ok(waResult()) } });
  assert.strictEqual(footerOf(q).byTag('button').filter((b) => /Send this WhatsApp/.test(b.textContent)).length, 0,
    'there is nothing to click when WhatsApp cannot send');
  assert.ok(/cannot deliver real messages/.test(footerOf(q).textContent), 'the backend refusal is shown verbatim');
});

test('D3. two clicks are required, and the confirmation discloses the UNVERIFIED number', async () => {
  const calls = [];
  const p = await openWhatsApp({
    outreach: {
      prepare: () => ok(previewWhatsApp()),
      outreachSend: (payload) => { calls.push(payload); return ok(waResult()); },
    },
  });
  assert.strictEqual(calls.length, 0, 'reading the preview contacts nothing');
  clickByText(footerOf(p), /Send this WhatsApp/).fire('click');
  assert.strictEqual(calls.length, 0, 'arming the confirmation still contacts nothing');

  const footer = footerOf(p);
  assert.ok(footer.textContent.includes(LEAD_PHONE), 'the stored number is restated before sending');
  assert.ok(/unverified number/i.test(footer.textContent),
    'the confirmation says the number is unverified - that is what the click acknowledges');
  clickByText(footer, /Yes, send it/).fire('click');
  await settle();
  // F25: the reviewed WhatsApp tab is what names the channel - exactly one call, carrying
  // the pitch id and the explicit channel and nothing else.
  assert.deepStrictEqual(calls, [{ pitchId: 'p1', channel: 'whatsapp' }],
    'exactly one call, carrying exactly the pitch id and the explicit channel');
});

test('D4. an acceptance is reported as an acknowledgement with three unknown statuses', async () => {
  const p = await openWhatsApp({ outreach: { prepare: () => ok(previewWhatsApp()), outreachSend: () => ok(waResult()) } });
  clickByText(footerOf(p), /Send this WhatsApp/).fire('click');
  clickByText(footerOf(p), /Yes, send it/).fire('click');
  await settle();
  const text = footerOf(p).textContent;
  assert.ok(/wa_msg_1/.test(text), 'the provider message id is shown');
  assert.ok(/Delivery unknown/.test(text) && /opened unknown/.test(text) && /clicked unknown/.test(text),
    'the three unobservable facts are rendered as unknown: ' + text);
  assert.ok(!/delivered|opened by|clicked by/i.test(text), 'nothing is rendered as a delivery fact');
});

test('D5. a result belongs to its OWN channel: switching tabs never shows another channel\'s outcome', async () => {
  const p = loadPanel({
    outreach: {
      prepare: (pl) => ok(pl.channel === 'whatsapp'
        ? previewWhatsApp()
        : previewWhatsApp(CAN_SEND_WA, {
          channel: 'email',
          recipient: { state: 'available', contact: 'hello@acme.example.com', providerConfigured: null },
          delivery: { channel: 'email', canSend: true, providerLive: true, blockedCode: null, blockedMessage: null },
        })),
      outreachSend: () => ok(waResult()),
    },
  });
  p.f18OpenPrepare('p1');
  await settle();
  p.f18SetChannel('whatsapp');
  await settle();
  clickByText(footerOf(p), /Send this WhatsApp/).fire('click');
  clickByText(footerOf(p), /Yes, send it/).fire('click');
  await settle();
  assert.ok(/wa_msg_1/.test(footerOf(p).textContent), 'the WhatsApp result is shown on the WhatsApp tab');

  // Switching to Email must not present the WhatsApp send as this channel's outcome.
  p.f18SetChannel('email');
  await settle();
  assert.ok(!/wa_msg_1/.test(footerOf(p).textContent),
    'the WhatsApp result is NOT shown against the email tab');
  // Coming back does not resurrect it either: F19's declared rule is that re-preparing
  // re-reads backend truth and drops any prior result, so nothing rendered from an older read
  // ever survives a newer one. The test asserts that rule still holds for a channel switch.
  p.f18SetChannel('whatsapp');
  await settle();
  assert.ok(!/wa_msg_1/.test(footerOf(p).textContent),
    'a re-prepared panel shows no stale result at all');
  // And the control is offered again, because a replay would be refused by the service anyway.
  assert.ok(/Send this WhatsApp/.test(footerOf(p).textContent), 'the control returns on a fresh read');
});

test('D6. a typed refusal is shown as a refusal, never softened into a probable send', async () => {
  const p = await openWhatsApp({
    outreach: { prepare: () => ok(previewWhatsApp()), outreachSend: () => bad('WHATSAPP_PROVIDER_NOT_LIVE', 'The provider cannot deliver.') },
  });
  clickByText(footerOf(p), /Send this WhatsApp/).fire('click');
  clickByText(footerOf(p), /Yes, send it/).fire('click');
  await settle();
  const text = footerOf(p).textContent;
  assert.ok(/WHATSAPP_PROVIDER_NOT_LIVE/.test(text), 'the code is shown verbatim');
  assert.ok(!/sent|delivered/i.test(text), 'no word suggesting a send happened');
  assert.ok(/Send this WhatsApp/.test(text), 'the control returns so a fixed configuration can be retried');
});

// ============================================================ S. declared surface locks

const WA_SERVICE = stripComments(
  serviceSource.slice(serviceSource.indexOf('async sendWhatsApp('), serviceSource.lastIndexOf('  _sendResult(')));
const WA_RENDERER = stripComments(F18_RENDERER + '\n' + F19_RENDERER);

test('S1. the WhatsApp boundary has no batch, queue, schedule, retry, timer or network surface', () => {
  assert.ok(WA_SERVICE.length > 500, 'the WhatsApp boundary is located');
  for (const banned of [/\bbatch\b/i, /\bqueue\b/i, /\bschedul/i, /\bretry\b/i, /setTimeout/, /setInterval/,
    /\bfetch\s*\(/, /https?:\/\//, /\bfor\s*\(\s*const\s+\w+\s+of\b.*send/i]) {
    assert.ok(!banned.test(WA_SERVICE), 'the WhatsApp boundary must not contain: ' + banned);
  }
  // Exactly one provider call, and it is the send.
  assert.strictEqual((WA_SERVICE.match(/this\.whatsappProvider\.send\(/g) || []).length, 1,
    'the provider is contacted exactly once, in one place');
});

test('S2. the WhatsApp provider contract is plain text: no template, no attachment, no voice call', async () => {
  // Word-bounded so `String(...)` cannot masquerade as a "ring"/"call" surface.
  const provider = stripComments(whatsappProviderSource);
  for (const banned of [/\bvoice/i, /\bcall\b/i, /\baudio/i, /\bring(ing)?\b/i, /template/i, /\bmcp\b/i]) {
    assert.ok(!banned.test(provider), 'no voice-calling or template surface: ' + banned);
  }
  assert.ok(/validate\(message\)/.test(provider) && /async send\(\)/.test(provider));
  // `live` is false on the base class, which is what makes A4's interlock real.
  assert.ok(/get live\(\)\s*\{\s*return false;/.test(whatsappProviderSource),
    'live defaults to false on the base provider');
  assert.strictEqual(new WhatsAppProvider().live, false);
  // An unknown message id reports 'unknown' - it never invents a delivery or a read receipt.
  assert.deepStrictEqual(await new WhatsAppProvider().getStatus('wa_unknown'),
    { messageId: 'wa_unknown', status: 'unknown' });
  // And the abstract send refuses rather than pretending to deliver.
  await assert.rejects(() => new WhatsAppProvider().send({}), (e) => {
    assert.strictEqual(e.code, 'WHATSAPP_PROVIDER_NOT_CONFIGURED');
    return true;
  });
});

test('S3. the send vocabulary is closed: exactly email and whatsapp', () => {
  assert.ok(/SEND_CHANNELS\s*=\s*Object\.freeze\(\[\s*'email',\s*'whatsapp'\s*\]\)/.test(contractSource),
    'SEND_CHANNELS admits exactly the two real channels');
  assert.ok(/channel IN \('email','whatsapp'\)/.test(migration005), 'the ledger admits exactly those two');
  // No sms, no voice, no third channel anywhere in the migration.
  assert.ok(!/sms|voice|call/i.test(migration005), 'the migration admits no other channel');
});

test('S4. migration 005 preserves existing rows and rebuilds rather than dropping the table', () => {
  assert.ok(/CREATE TABLE li_outreach_sends_f20/.test(migration005));
  assert.ok(/INSERT INTO li_outreach_sends_f20/.test(migration005), 'existing rows are copied, not discarded');
  assert.ok(/DROP TABLE li_outreach_sends/.test(migration005));
  assert.ok(/RENAME TO li_outreach_sends/.test(migration005));
  // The at-most-one-accepted rule becomes channel-scoped, and stays UNIQUE.
  assert.ok(/CREATE UNIQUE INDEX IF NOT EXISTS li_sends_one_accepted[\s\S]*?ON li_outreach_sends \(channel, idempotency_key\)/.test(migration005));
  assert.ok(/WHERE state = 'accepted'/.test(migration005));
});

test('S5. the renderer has no WhatsApp-specific send surface beyond the reviewed control', () => {
  for (const banned of [/\bvoice\b/i, /\bring\b/i, /outreachWhatsApp/i, /whatsappSend/i, /api\.outreach\.\w*[Ww]hats/i]) {
    assert.ok(!banned.test(WA_RENDERER), 'the renderer must not contain: ' + banned);
  }
  // Two bridge calls exist in these blocks - the read-only prepare and the single send - and
  // exactly ONE of them is a send, carrying exactly the pitch id and the reviewed channel.
  assert.strictEqual((WA_RENDERER.match(/api\.outreach\.\w+\(/g) || []).length, 2,
    'the renderer makes exactly two bridge calls: prepare (read-only) and send');
  assert.strictEqual((WA_RENDERER.match(/outreachSend\(/g) || []).length, 1, 'and exactly one of them sends');
  // F25 lock amendment (was: /outreachSend\(\{ pitchId \}\)/ - "carries exactly the pitch
  // id"). The explicit channel now travels with it; the payload shape is pinned, not
  // loosened: two identifiers, no recipient, no body, no provider.
  assert.ok(/outreachSend\(\{ pitchId, channel \}\)/.test(WA_RENDERER),
    'the send call carries exactly the pitch id and the reviewed channel');
});

test('S6. the WhatsApp capability evaluator is pure: it reads configuration and contacts nothing', () => {
  // Scoped to the function bodies: the module's own `require` of the shared E.164 validator is
  // not impurity.
  const cfg = stripComments(
    whatsappConfigSource.slice(whatsappConfigSource.indexOf('function checkFromNumber')));
  for (const banned of [/\brequire\s*\(/, /\bawait\b/, /this\.store/, /\bfetch/, /\.send\(/, /\bnew\s+\w*Store/]) {
    assert.ok(!banned.test(cfg), 'the capability evaluator must be pure, found: ' + banned);
  }
});

// ============================================================ runner

(async () => {
  let passed = 0;
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++;
      console.log('ok - ' + name);
    } catch (err) {
      failed++;
      console.log('FAIL - ' + name);
      console.log(String(err && err.stack ? err.stack : err));
    }
  }
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();