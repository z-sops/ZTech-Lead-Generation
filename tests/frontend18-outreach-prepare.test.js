'use strict';

// Frontend 2.0 F18 - outreach preparation / channel selection (review only, nothing sent).
//
// THE REAL PRODUCT CONTRACT these tests pin:
//
//   1. READINESS comes first and comes ONLY from the EXISTING OutreachGate, evaluated on
//      its default channel ("email"). OutreachGate is not redesigned, re-parameterised or
//      widened by F18. A pitch the gate does not currently allow can never be prepared,
//      whatever its contacts look like.
//   2. THE CHANNEL is chosen AFTER readiness: only an already-allowed pitch reaches the
//      contact-facts read model, and contact data can only NARROW what preparation offers
//      (a channel without a factual contact point is refused), never widen what the gate
//      allows. WhatsApp availability has no vote in readiness.
//   3. PREPARATION IS A DERIVED PREVIEW: it writes nothing (no pitch mutation, no
//      approval, no persistence), records no activity, sends nothing, queues nothing,
//      schedules nothing, retries nothing and reaches no provider. The only new surface
//      is ONE read-only IPC channel with a closed input schema.
//   4. ERRORS ARE HONEST: refusals are typed (NOT_READY / CHANNEL_UNAVAILABLE /
//      CONTACT_FACTS_UNAVAILABLE / VALIDATION_FAILED); a genuine internal store failure
//      propagates as itself and is never converted into a fabricated refusal.
//
// The A-section tests run the REAL runtime (real bridge, real EvidencePacket, real
// PitchGenerator, real approval, real OutreachGate) over a real MemoryStore - the gate is
// NOT stubbed. The D-section tests stub ONLY the gate (labelled DEFENSIVE/INTERNAL), the
// same way F17's defensive tests do, to reach branches the real gate never produces.
// The I-section tests drive the real IPC registrar. The S-section pins the declared
// surface locks.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const ipcSource = fs.readFileSync(path.join(root, 'src', 'main', 'lead-intelligence', 'outreach-ipc.js'), 'utf8');
const serviceSource = fs.readFileSync(path.join(root, 'src', 'main', 'lead-intelligence', 'outreach', 'OutreachService.js'), 'utf8');
const rendererSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'renderer.js'), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const tests = [];
function test(name, fn) { tests.push([name, fn]); }
let passed = 0;
let failed = 0;

// ============================================================ real runtime fixtures
// (same shape as the F17 suite: the real service graph over a real MemoryStore)

const { MemoryStore } = require(path.join(root, 'src', 'main', 'lead-intelligence', 'persistence', 'MemoryStore.js'));
const { createLeadIntelligence } = require(path.join(root, 'src', 'main', 'lead-intelligence', 'index.js'));
const { round1PacketMapper } = require(path.join(root, 'src', 'main', 'lead-intelligence', 'round1PacketMapper.js'));
const { OutreachService } = require(path.join(root, 'src', 'main', 'lead-intelligence', 'outreach', 'OutreachService.js'));
const { registerOutreachIpc, CHANNELS, INPUT_SCHEMAS } = require(path.join(root, 'src', 'main', 'lead-intelligence', 'outreach-ipc.js'));
const { renderPitchText } = require(path.join(root, 'src', 'main', 'lead-intelligence', 'outreach', 'PitchGenerator.js'));
const { S } = require(path.join(root, 'src', 'main', 'lead-intelligence', 'core', 'validate.js'));
const { NotFoundError, LiError, ValidationError } = require(path.join(root, 'src', 'main', 'lead-intelligence', 'core', 'errors.js'));
const { round1Record, zuniV1Packet } = require(path.join(root, 'tests', 'lead-intelligence', 'fixtures', 'round1Record.js'));

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

/** The REAL runtime over a real store: no gate stub, no re-implemented rule. */
function makeRuntime(leads, { emailProvider = null } = {}) {
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
      email: { enabled: false, fromAddress: null },
    },
    clock,
    logger: SILENT,
    round1ResultMapper: round1PacketMapper,
    emailProvider,
  });
  return { li, store };
}

/** sync -> generate -> (optional) approve -> gate, all through the shipped service. */
async function runLead(li, leadId, { approve = true } = {}) {
  await li.research.sync({ leadId });
  const pitch = await li.outreach.generate({ leadId });
  const approval = approve ? await li.outreach.approve({ pitchId: pitch.pitch_id }) : null;
  const gate = await li.outreach.gate({ pitchId: pitch.pitch_id });
  return { pitch, approval, gate };
}

const reasonCodes = (gate) => gate.reasons.map((r) => r.code);

/** Spy wrapper: records every write method call on the store, passes it through. */
function spyStoreWrites(store, calls) {
  const wrap = (obj, name) => {
    const orig = obj[name].bind(obj);
    obj[name] = async (...a) => { calls.push(name); return orig(...a); };
  };
  wrap(store.pitches, 'upsert');
  wrap(store.approvals, 'insert');
  wrap(store.activity, 'append');
  return store;
}

// ============================================================ A. the real backend contract

test('A1. an allowed pitch prepares a channel-neutral Email preview', async () => {
  const { li } = makeRuntime({ L1: lead({}) });
  const { pitch, gate } = await runLead(li, 'L1');
  assert.strictEqual(gate.decision, 'allowed');

  const res = await li.outreach.prepare({ pitchId: pitch.pitch_id, channel: 'email' });
  assert.strictEqual(res.leadId, 'L1');
  assert.strictEqual(res.pitchId, pitch.pitch_id);
  assert.strictEqual(res.channel, 'email');
  assert.strictEqual(res.leadName, 'Acme Bakery', 'the business name the view already carries');
  assert.deepStrictEqual(res.recipient,
    { state: 'available', contact: 'hello@acme.example.com', providerConfigured: null },
    'the factual email is the recipient; provider configuration is NOT claimed');
  assert.strictEqual(res.content.subject, pitch.subject, 'the canonical subject, unchanged');
  assert.strictEqual(res.content.body, renderPitchText(pitch), 'the canonical body is the existing renderPitchText output');
  assert.strictEqual(res.content.bodySource, 'renderPitchText');
  assert.deepStrictEqual(res.content.evidenceReferences, pitch.evidenceReferences);
  assert.strictEqual(res.content.transformationNote, null, 'email needs no transformation note');
  assert.deepStrictEqual(res.readiness, gate, 'the readiness verdict is carried verbatim');
  const row = (await li.outreach.ready({})).rows[0];
  assert.deepStrictEqual(res.contactFacts, { contacts: row.contacts, channels: row.channels },
    'the SAME F17 read model the Ready row carries');
});

test('A2. the factual email recipient is the leadView value the gate validated, byte-identical', async () => {
  const { li } = makeRuntime({ L1: lead({ email: 'HELLO@acme.example.com' }) });
  const { pitch } = await runLead(li, 'L1');
  const viewEmail = (await li.contexts.getContext('L1')).view.email;
  assert.ok(viewEmail, 'the view carries the contact value');
  const res = await li.outreach.prepare({ pitchId: pitch.pitch_id, channel: 'email' });
  assert.strictEqual(res.recipient.contact, viewEmail,
    'the recipient IS the stored view value - the same value the gate allowed - with no re-derivation');
});

test('A3. an allowed pitch prepares a WhatsApp CANDIDATE preview', async () => {
  const { li } = makeRuntime({ L1: lead({}) });
  const { pitch } = await runLead(li, 'L1');
  const res = await li.outreach.prepare({ pitchId: pitch.pitch_id, channel: 'whatsapp' });
  assert.strictEqual(res.channel, 'whatsapp');
  assert.deepStrictEqual(res.recipient,
    { state: 'candidate', contact: '+92 300 1234567', verified: false, verifiedSource: null },
    'the F17 WhatsApp shape, verbatim');
  assert.strictEqual(res.recipient.contact, '+92 300 1234567', 'the STORED number, byte-identical');
  assert.strictEqual(res.recipient.verified, false, 'never verified');
  assert.strictEqual(res.recipient.verifiedSource, null, 'no verification source is claimed');
  assert.notStrictEqual(res.recipient.state, 'available', 'WhatsApp is never available');
  assert.strictEqual(res.readiness.channel, 'email', 'readiness is the EMAIL-channel gate verdict, not a WhatsApp one');
});

test('A4. the WhatsApp transformation note is honest', async () => {
  const { li } = makeRuntime({ L1: lead({}) });
  const { pitch } = await runLead(li, 'L1');
  const email = await li.outreach.prepare({ pitchId: pitch.pitch_id, channel: 'email' });
  const whatsapp = await li.outreach.prepare({ pitchId: pitch.pitch_id, channel: 'whatsapp' });
  assert.strictEqual(typeof whatsapp.content.transformationNote, 'string');
  assert.ok(/no whatsapp/i.test(whatsapp.content.transformationNote), 'says no WhatsApp transformation exists');
  assert.ok(/unchanged/i.test(whatsapp.content.transformationNote), 'says the source is shown unchanged');
  assert.strictEqual(whatsapp.content.body, email.content.body, 'the body IS the canonical pitch text, unchanged');
  // No untruthful claim anywhere in the note.
  assert.ok(!/registered|reachable|deliverable|verified /i.test(whatsapp.content.transformationNote));
});

test('A5. Email -> WhatsApp -> Email switching is deterministic and read-only', async () => {
  const { li } = makeRuntime({ L1: lead({}) });
  const { pitch } = await runLead(li, 'L1');
  const first = await li.outreach.prepare({ pitchId: pitch.pitch_id, channel: 'email' });
  const mid = await li.outreach.prepare({ pitchId: pitch.pitch_id, channel: 'whatsapp' });
  const again = await li.outreach.prepare({ pitchId: pitch.pitch_id, channel: 'email' });
  const midAgain = await li.outreach.prepare({ pitchId: pitch.pitch_id, channel: 'whatsapp' });
  assert.deepStrictEqual(again, first, 'switching back reproduces the identical preview (fixed clock)');
  assert.deepStrictEqual(midAgain, mid);
  assert.notStrictEqual(first.channel, mid.channel);
});

test('A6. readiness is the existing email gate verdict, verbatim, and WhatsApp facts never appear in it', async () => {
  const { li } = makeRuntime({ L1: lead({}) });
  const { pitch, gate } = await runLead(li, 'L1');
  const res = await li.outreach.prepare({ pitchId: pitch.pitch_id, channel: 'whatsapp' });
  assert.deepStrictEqual(res.readiness, gate);
  assert.deepStrictEqual(res.readiness.reasons, [], 'no WhatsApp-related reason exists');
  assert.ok(!/whatsapp|phone/i.test(JSON.stringify(res.readiness)), 'readiness carries no WhatsApp/phone decision');
  const before = await li.outreach.ready({});
  await li.outreach.prepare({ pitchId: pitch.pitch_id, channel: 'whatsapp' });
  assert.deepStrictEqual(await li.outreach.ready({}), before, 'no readiness mutation');
});

test('A7. WhatsApp availability can never create readiness (blocked pitch, perfect contacts)', async () => {
  // Perfect contacts, but the pitch was never approved: the gate blocks it, so even the
  // WhatsApp channel must be refused with NOT_READY - never CHANNEL_UNAVAILABLE, which
  // would imply readiness was decided and only the contact was missing.
  const unapproved = makeRuntime({ L1: lead({}) });
  const u = await runLead(unapproved.li, 'L1', { approve: false });
  assert.strictEqual(u.gate.decision, 'blocked');
  assert.deepStrictEqual(reasonCodes(u.gate), ['HUMAN_APPROVAL'], 'blocked for approval, not for a contact');
  for (const channel of ['email', 'whatsapp']) {
    await assert.rejects(
      () => unapproved.li.outreach.prepare({ pitchId: u.pitch.pitch_id, channel }),
      (e) => e instanceof LiError && e.code === 'NOT_READY',
      channel + ': a blocked pitch is NOT_READY on every channel');
  }
  // Same for an unqualified lead with perfect contacts.
  const unqualified = makeRuntime({ L1: lead({ qualification: 'unqualified' }) });
  const q = await runLead(unqualified.li, 'L1');
  assert.deepStrictEqual(reasonCodes(q.gate), ['QUALIFICATION']);
  await assert.rejects(
    () => unqualified.li.outreach.prepare({ pitchId: q.pitch.pitch_id, channel: 'whatsapp' }),
    (e) => e instanceof LiError && e.code === 'NOT_READY');
});

test('A8. an unknown pitch is refused with the honest NOT_FOUND', async () => {
  const { li } = makeRuntime({ L1: lead({}) });
  await runLead(li, 'L1');
  await assert.rejects(
    () => li.outreach.prepare({ pitchId: 'pitch_missing', channel: 'email' }),
    (e) => e instanceof NotFoundError && e.code === 'NOT_FOUND');
});

test('A9. the channel enum is closed: only "email" and "whatsapp" exist', async () => {
  const { li } = makeRuntime({ L1: lead({}) });
  const { pitch } = await runLead(li, 'L1');
  for (const bad of ['sms', 'EMAIL', 'WhatsApp', 'voice', '', undefined, null, 5, {}, ['email']]) {
    await assert.rejects(
      () => li.outreach.prepare({ pitchId: pitch.pitch_id, channel: bad }),
      (e) => e instanceof ValidationError && e.code === 'VALIDATION_FAILED',
      'channel ' + JSON.stringify(bad) + ' must be refused as VALIDATION_FAILED');
  }
  // The enum is checked before anything else, even before pitch existence.
  await assert.rejects(
    () => li.outreach.prepare({ pitchId: 'pitch_missing', channel: 'sms' }),
    (e) => e instanceof ValidationError, 'enum is decided first');
});

test('A10. a lead with no phone refuses WhatsApp preparation honestly', async () => {
  const { li } = makeRuntime({ L1: lead({ phone: null }) });
  const { pitch } = await runLead(li, 'L1');
  // Email still prepares: readiness is the gate, the phone never was part of it.
  const email = await li.outreach.prepare({ pitchId: pitch.pitch_id, channel: 'email' });
  assert.strictEqual(email.channel, 'email');
  await assert.rejects(
    () => li.outreach.prepare({ pitchId: pitch.pitch_id, channel: 'whatsapp' }),
    (e) => e instanceof LiError && e.code === 'CHANNEL_UNAVAILABLE' && /No phone number is stored/.test(e.message));
});

test('A11. an invalid stored phone refuses WhatsApp preparation as invalid, not missing', async () => {
  const { li } = makeRuntime({ L1: lead({ phone: 'not-a-number' }) });
  const { pitch } = await runLead(li, 'L1');
  await assert.rejects(
    () => li.outreach.prepare({ pitchId: pitch.pitch_id, channel: 'whatsapp' }),
    (e) => e instanceof LiError && e.code === 'CHANNEL_UNAVAILABLE'
      && /stored phone number is not a valid number/.test(e.message));
});

test('A12. no pitch mutation and no persistence writes from preparation', async () => {
  const { li, store } = makeRuntime({ L1: lead({}) });
  const { pitch } = await runLead(li, 'L1');
  const calls = [];
  spyStoreWrites(store, calls);
  const before = JSON.parse(JSON.stringify(await li.outreach.get(pitch.pitch_id)));
  await li.outreach.prepare({ pitchId: pitch.pitch_id, channel: 'email' });
  await li.outreach.prepare({ pitchId: pitch.pitch_id, channel: 'whatsapp' });
  await li.outreach.prepare({ pitchId: pitch.pitch_id, channel: 'email' });
  const after = await li.outreach.get(pitch.pitch_id);
  assert.deepStrictEqual(after, before, 'the stored pitch is byte-identical after three preparations');
  assert.deepStrictEqual(calls, [], 'no store write method ran: ' + calls.join(','));
});

// ============================================================ B. activity / provider / errors

test('B1. opening preparation records NO activity, and neither does switching or refusing', async () => {
  const { li } = makeRuntime({ L1: lead({}) });
  const { pitch } = await runLead(li, 'L1');
  const before = await li.outreach.activityList({ limit: 100 });
  await li.outreach.prepare({ pitchId: pitch.pitch_id, channel: 'email' });
  await li.outreach.prepare({ pitchId: pitch.pitch_id, channel: 'whatsapp' });
  await li.outreach.prepare({ pitchId: pitch.pitch_id, channel: 'email' });
  await assert.rejects(() => li.outreach.prepare({ pitchId: 'pitch_missing', channel: 'email' }));
  const after = await li.outreach.activityList({ limit: 100 });
  assert.deepStrictEqual(after, before, 'preparation, switching and refusals write no activity row');
});

test('B2. preparation never reaches a provider, and send() stays refused', async () => {
  const providerCalls = [];
  const emailProvider = {
    send: async (...a) => { providerCalls.push(a); return { sent: true }; },
  };
  const { li } = makeRuntime({ L1: lead({}) }, { emailProvider });
  const { pitch } = await runLead(li, 'L1');
  for (const channel of ['email', 'whatsapp']) {
    await li.outreach.prepare({ pitchId: pitch.pitch_id, channel });
  }
  assert.deepStrictEqual(providerCalls, [], 'no provider method was ever called');
  await assert.rejects(() => li.outreach.send({ pitchId: pitch.pitch_id }),
    (e) => e instanceof LiError && e.code === 'EMAIL_DISABLED', 'the send path stays disabled');
});

test('B3. a genuine internal store failure propagates as itself, never as a fabricated refusal', async () => {
  const { li } = makeRuntime({ L1: lead({}) });
  const { pitch } = await runLead(li, 'L1');
  const boom = new Error('storage failure: disk I/O error');
  // The gate must still succeed (it owns readiness), so the context stub serves the REAL
  // context for the gate's read and fails only on prepare's own follow-up read.
  const realGet = li.outreach.contexts.getContext.bind(li.outreach.contexts);
  let contextReads = 0;
  li.outreach.contexts = { getContext: async (...a) => { contextReads++; if (contextReads >= 2) throw boom; return realGet(...a); } };
  let caught = null;
  try {
    await li.outreach.prepare({ pitchId: pitch.pitch_id, channel: 'email' });
  } catch (e) { caught = e; }
  assert.strictEqual(contextReads, 2, 'the gate read first, prepare read second');
  assert.strictEqual(caught, boom, 'the ORIGINAL internal error propagates, not a re-wrapping');
  assert.notStrictEqual(caught && caught.code, 'CONTACT_FACTS_UNAVAILABLE', 'it is not disguised as absent facts');
  assert.notStrictEqual(caught && caught.code, 'CHANNEL_UNAVAILABLE', 'and not as an unavailable channel');
});

test('B4. a lead that vanished between the gate and the context read reports NOT_FOUND', async () => {
  const { li } = makeRuntime({ L1: lead({}) });
  const { pitch } = await runLead(li, 'L1');
  const realGet = li.outreach.contexts.getContext.bind(li.outreach.contexts);
  let contextReads = 0;
  li.outreach.contexts = { getContext: async (...a) => { contextReads++; if (contextReads >= 2) throw new NotFoundError('Lead', 'L1'); return realGet(...a); } };
  await assert.rejects(
    () => li.outreach.prepare({ pitchId: pitch.pitch_id, channel: 'email' }),
    (e) => e instanceof NotFoundError && e.code === 'NOT_FOUND');
});

// ============================================================ D. defensive branches (stubbed gate ONLY here)

// The real email gate never allows a pitch without a valid email (CONTACT_FIELD), so the
// missing/invalid email refusals below are DEFENSIVE branches of the read model - reached
// exactly the way F17's defensive tests reach theirs: the gate is stubbed ALLOWED on
// purpose. This pins honest behaviour for a malformed payload; it is NOT a reachable
// product case and nothing was relaxed in the gate to reach it.
function defensiveService(view) {
  const store = new MemoryStore();
  store.pitches.upsert({
    pitch_id: 'p1', lead_id: 'L1', packet_id: null, research_status: 'complete', target_id: null,
    icp_fit_status: null, subject: 's', opening: 'o', observations: [], valueProposition: 'v',
    callToAction: 'c', evidenceReferences: [], unsupportedClaims: [], status: 'draft',
    content_hash: 'h', created_at: CLOCK_ISO, updated_at: CLOCK_ISO,
  });
  const service = new OutreachService({
    store,
    contexts: { getContext: async () => ({ view }) },
    leadSource: {}, freshness: { isFresh: () => true },
    config: {}, clock, logger: SILENT,
  });
  service.gate = async () => ({
    decision: 'allowed', reasons: [], warnings: [], channel: 'email', pitch_id: 'p1',
    delivery: { channel: 'email', emailEnabled: false, providerConfigured: false },
  });
  return service;
}
const mkView = (o) => Object.assign({
  id: 'L1', name: 'Acme Bakery', phone: null, email: null, email_raw_present: false,
  website: null, address: null, city: null, country: null,
  has_email: false, has_phone: false, has_website: false,
}, o);

test('D1. DEFENSIVE (stubbed gate): a malformed stored email cannot produce Email preparation', async () => {
  const service = defensiveService(mkView({ email: null, email_raw_present: true }));
  await assert.rejects(
    () => service.prepare({ pitchId: 'p1', channel: 'email' }),
    (e) => e instanceof LiError && e.code === 'CHANNEL_UNAVAILABLE'
      && /not a valid address/.test(e.message));
});

test('D2. DEFENSIVE (stubbed gate): a missing email refuses Email preparation as missing', async () => {
  const service = defensiveService(mkView({ email: null, email_raw_present: false }));
  await assert.rejects(
    () => service.prepare({ pitchId: 'p1', channel: 'email' }),
    (e) => e instanceof LiError && e.code === 'CHANNEL_UNAVAILABLE'
      && /No valid email address is stored/.test(e.message));
});

test('D3. a context that resolves without a usable view is CONTACT_FACTS_UNAVAILABLE', async () => {
  const service = new OutreachService({
    store: new MemoryStore(),
    contexts: { getContext: async () => ({}) },
    leadSource: {}, freshness: { isFresh: () => true },
    config: {}, clock, logger: SILENT,
  });
  service.gate = async () => ({ decision: 'allowed', reasons: [], warnings: [], channel: 'email', pitch_id: 'p1', delivery: {} });
  // A pitch must still exist for the gate stub path; get() runs first.
  await service.store.pitches.upsert({
    pitch_id: 'p1', lead_id: 'L1', packet_id: null, research_status: 'complete', target_id: null,
    icp_fit_status: null, subject: 's', opening: 'o', observations: [], valueProposition: 'v',
    callToAction: 'c', evidenceReferences: [], unsupportedClaims: [], status: 'draft',
    content_hash: 'h', created_at: CLOCK_ISO, updated_at: CLOCK_ISO,
  });
  await assert.rejects(
    () => service.prepare({ pitchId: 'p1', channel: 'email' }),
    (e) => e instanceof LiError && e.code === 'CONTACT_FACTS_UNAVAILABLE');
});

// ============================================================ I. the real IPC surface

function ipcHarness(outreach, { trusted = true } = {}) {
  const handlers = new Map();
  const reg = registerOutreachIpc({
    ipcMain: { handle: (c, f) => handlers.set(c, f), removeHandler: (c) => handlers.delete(c) },
    outreach,
    isTrustedSender: () => trusted,
    logger: SILENT,
  });
  return { handlers, reg, invoke: (c, payload, event = {}) => handlers.get(c)(event, payload) };
}

test('I1. the prepare channel is registered with the other Lead Intelligence channels - and email-send is not', async () => {
  const { li } = makeRuntime({ L1: lead({}) });
  const { reg, handlers } = ipcHarness(li.outreach);
  assert.deepStrictEqual(reg.channels.slice().sort(), [
    'lead-intel:outreach-activity',
    'lead-intel:outreach-approve',
    'lead-intel:outreach-gate',
    'lead-intel:outreach-list',
    'lead-intel:outreach-prepare',
    'lead-intel:outreach-ready',
    'lead-intel:pitch-generate',
    'lead-intel:pitch-get',
    'lead-intel:pitch-update',
  ]);
  assert.strictEqual(handlers.size, 9, 'exactly nine channels are registered');
  assert.ok(!handlers.has('lead-intel:email-send'), 'no send channel exists');
  for (const forbidden of ['lead-intel:email-send', 'lead-intel:outreach-schedule', 'lead-intel:outreach-queue',
    'lead-intel:outreach-retry', 'lead-intel:campaign-run', 'lead-intel:outreach-send']) {
    assert.ok(!handlers.has(forbidden), 'must not be registered: ' + forbidden);
  }
});

test('I2. the prepare input schema is closed: exact properties, exact enum, no extras', async () => {
  assert.deepStrictEqual(INPUT_SCHEMAS[CHANNELS.OUTREACH_PREPARE], {
    type: 'object',
    properties: {
      pitchId: S.id,
      channel: { type: 'string', enum: ['email', 'whatsapp'] },
    },
    required: ['pitchId', 'channel'],
    additionalProperties: false,
  });
});

test('I3. through IPC: a valid payload prepares; an extra property is refused; an untrusted sender is refused', async () => {
  const { li } = makeRuntime({ L1: lead({}) });
  const { pitch } = await runLead(li, 'L1');
  const good = ipcHarness(li.outreach);
  const ok = await good.invoke('lead-intel:outreach-prepare', { pitchId: pitch.pitch_id, channel: 'email' });
  assert.strictEqual(ok.ok, true, JSON.stringify(ok));
  assert.strictEqual(ok.data.recipient.contact, 'hello@acme.example.com', 'the factual value crosses the boundary');

  const extra = await good.invoke('lead-intel:outreach-prepare', { pitchId: pitch.pitch_id, channel: 'email', extra: 'x' });
  assert.strictEqual(extra.ok, false);
  assert.strictEqual(extra.error.code, 'VALIDATION_FAILED', 'additionalProperties are refused');

  const badChannel = await good.invoke('lead-intel:outreach-prepare', { pitchId: pitch.pitch_id, channel: 'sms' });
  assert.strictEqual(badChannel.ok, false);
  assert.strictEqual(badChannel.error.code, 'VALIDATION_FAILED');

  const untrusted = ipcHarness(li.outreach, { trusted: false });
  const refused = await untrusted.invoke('lead-intel:outreach-prepare', { pitchId: pitch.pitch_id, channel: 'email' });
  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.error.code, 'FORBIDDEN', 'the sender check runs before any service call');
});

// ============================================================ S. declared surface locks

const PREPARE_BODY = stripComments(serviceSource.slice(serviceSource.indexOf('async prepare('), serviceSource.indexOf('/**\n   * Human-triggered send')));

test('S1. the prepare body writes, sends, queues, schedules, retries and reaches nothing', () => {
  assert.ok(PREPARE_BODY.length > 100, 'the prepare body is located');
  for (const banned of [/\bsend\b/i, /\bschedule\b/i, /\bqueue\b/i, /\bretry\b/i, /\bcampaign\b/i,
    /nodemailer/i, /smtp/i, /\bfetch\b/i, /https?:\/\//, /\brequire\s*\(/]) {
    assert.ok(!banned.test(PREPARE_BODY), 'prepare() must not contain: ' + banned);
  }
  assert.ok(!/this\.emailProvider/.test(PREPARE_BODY), 'no provider object is touched');
  assert.ok(!/this\.email\./.test(PREPARE_BODY), 'no email config is consulted');
  assert.ok(!/\.upsert\(|\.insert\(|\.append\(|_recordActivity/.test(PREPARE_BODY), 'no store write path');
  // Readiness is re-checked through the EXISTING gate on its default channel.
  assert.ok(/await this\.gate\(\{ pitchId \}\)/.test(PREPARE_BODY), 'the gate owns readiness');
  assert.ok(!/gate\(\{[^}]*channel/.test(PREPARE_BODY), 'the gate channel is not overridden by the caller');
});

test('S2. the CHANNELS constant is an exact frozen allowlist of nine - no send, queue or campaign channel', () => {
  const block = ipcSource.slice(ipcSource.indexOf('const CHANNELS = Object.freeze({'), ipcSource.indexOf('}));'));
  assert.ok(/Object\.freeze\(\{/.test(block), 'the channel set is frozen');
  const values = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]).filter((v) => v.startsWith('lead-intel:'));
  assert.strictEqual(values.length, 9, 'exactly nine channels are declared');
  assert.ok(values.includes('lead-intel:outreach-prepare'), 'the prepare channel is declared');
  for (const v of values) {
    assert.ok(!/send|schedule|queue|retry|campaign/i.test(v), 'no dangerous channel name: ' + v);
  }
  assert.ok(!values.includes('lead-intel:email-send'), 'email-send is still not declared');
});

test('S3. the preload bridge adds exactly one read-only prepare method and nothing else', () => {
  const start = preloadSource.indexOf("exposeInMainWorld('ztechLeadIntel'");
  const bridge = stripComments(preloadSource.slice(start));
  const methods = [...bridge.matchAll(/(\w+):\s*\((?:payload|payload \|\| \{\})\)\s*=>\s*ipcRenderer\.invoke/g)].map((m) => m[1]);
  assert.ok(methods.includes('prepare'), 'the bridge exposes prepare');
  assert.strictEqual(methods.length, 9, 'exactly nine Lead Intelligence methods: ' + methods.join(','));
  assert.strictEqual([...bridge.matchAll(/\bprepare\s*:/g)].length, 1, 'prepare is declared exactly once');
  assert.ok(/lead-intel:outreach-prepare/.test(bridge), 'it invokes only the fixed channel');
  for (const banned of [/\bsend\b/i, /\bschedule\b/i, /\bqueue\b/i, /\bretry\b/i, /\bcampaign\b/i, /\bverify\b/i]) {
    assert.ok(!banned.test(bridge), 'no bridge method for: ' + banned);
  }
  assert.ok(!/exposeInMainWorld\([^)]{0,80}ipcRenderer/.test(preloadSource), 'ipcRenderer is never exposed directly');
});

// ============================================================ R. the real renderer UI
//
// The F18 review panel is a READ-ONLY preview written entirely by the renderer block at
// the F18 marker. These tests drive the REAL f18* functions inside a DOM double, in
// exactly the way the F16/F17 suites drive theirs, and assert the panel can never send,
// queue or fabricate a channel or a WhatsApp claim.

const R18_MARKER = '// === F18 Outreach: preparation review';
const R15_MARKER = '// === F15 Outreach: activity history ===';
const F18_RENDERER = rendererSource.slice(rendererSource.indexOf(R18_MARKER), rendererSource.indexOf(R15_MARKER));
assert.ok(F18_RENDERER.length > 500, 'the F18 renderer block is located');

function makeDoc18() {
  const listeners = new WeakMap();
  const docListeners = [];
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
      classList: {
        add() {}, remove() {}, contains() { return false; },
      },
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
    addEventListener: (type, fn) => { docListeners.push({ type, fn }); },
    _docListeners: docListeners,
  };
}

/** Evaluate the REAL F18 renderer block against a DOM double, with the F11 helpers stubbed. */
function loadPrepare(api) {
  const doc = makeDoc18();
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
  const fn = new Function(...names, F18_RENDERER + '\nreturn { f18OpenPrepare, f18ClosePrepare, f18SetChannel, f18PrepareLoad, f18PrepareState, f18PrepareInit, f18ChannelAvailability };');
  const loaded = fn.apply(null, names.map((n) => sandbox[n]));
  loaded.doc = doc;
  return loaded;
}

const settle = () => new Promise((r) => setTimeout(r, 0));

const PREVIEW_EMAIL = {
  leadId: 'L1', pitchId: 'p1', channel: 'email', leadName: 'Acme Bakery',
  recipient: { state: 'available', contact: 'hello@acme.example.com', providerConfigured: null },
  content: {
    subject: 'Three fixes for acme.com', body: 'The pitch body text.',
    bodySource: 'renderPitchText', evidenceReferences: ['audit-1'], transformationNote: null,
  },
  readiness: { decision: 'allowed', reasons: [], warnings: [], channel: 'email' },
  contactFacts: {
    contacts: { email: { present: true, valid: true, value: 'hello@acme.example.com', state: 'available' },
      phone: { present: true, valid: true, value: '+92 300 1234567' }, website: { present: true, valid: true, value: 'https://acme.example.com' } },
    channels: {
      email: { state: 'available', contact: 'hello@acme.example.com', providerConfigured: null },
      whatsapp: { state: 'candidate', contact: '+92 300 1234567', verified: false, verifiedSource: null },
    },
  },
};
const ok = (data) => ({ ok: true, data });
const bad = (code, message) => ({ ok: false, error: { code, message } });

test('R1. opening preparation calls prepare() once, defaults to Email, and renders a read-only review with no send control', async () => {
  const calls = [];
  const p = loadPrepare({ outreach: { prepare: (payload) => { calls.push(payload); return ok(PREVIEW_EMAIL); } } });
  p.f18OpenPrepare('p1');
  await settle();
  assert.strictEqual(calls.length, 1, 'exactly one prepare call on open');
  assert.deepStrictEqual(calls[0], { pitchId: 'p1', channel: 'email' }, 'defaults to Email for the single pitch');
  assert.strictEqual(p.f18PrepareState.open, true);
  assert.strictEqual(p.f18PrepareState.channel, 'email');
  const body = p.doc.getElementById('f18-prepare-body');
  assert.ok(/Hello|hello@acme\.example\.com/i.test(body.textContent), 'the stored email recipient is shown verbatim');
  assert.ok(/Three fixes for acme\.com/.test(body.textContent), 'the canonical subject is shown');
  assert.ok(/candidate|Not verified for WhatsApp/i.test(body.textContent) === false, 'no WhatsApp caveat leaks into the Email tab');
  assert.ok(/Review only/.test(body.textContent), 'the standing boundary line is shown');
  const buttons = body.byTag('button');
  assert.ok(buttons.length >= 2, 'channel tabs render');
  for (const b of body.byTag('button')) {
    assert.ok(!/\bSend\b|\bSchedule\b|\bQueue\b|\bLaunch\b|\bCampaign\b|\bRetry\b/i.test(b.textContent),
      'no outbound control is rendered: ' + b.textContent);
  }
  assert.ok(!/\bSend\b|\bSchedule\b|\bQueue\b|\bLaunch\b|\bCampaign\b|\bRetry\b/i.test(body.textContent.replace('Review only · nothing is sent, queued or recorded · this build has no sending provider', '')));
});

test('R2. switching to WhatsApp re-prepares the SAME pitch, shows the candidate caveat, and switching back is read-only', async () => {
  const calls = [];
  const p = loadPrepare({ outreach: { prepare: (payload) => {
    calls.push(payload.channel);
    return ok(Object.assign({}, PREVIEW_EMAIL, {
      channel: payload.channel,
      recipient: payload.channel === 'whatsapp'
        ? { state: 'candidate', contact: '+92 300 1234567', verified: false, verifiedSource: null }
        : PREVIEW_EMAIL.recipient,
      content: { ...PREVIEW_EMAIL.content, transformationNote: payload.channel === 'whatsapp' ? 'No WhatsApp-specific message transformation exists in this build.' : null },
    }));
  } } });
  p.f18OpenPrepare('p1');
  await settle();
  p.f18SetChannel('whatsapp');
  await settle();
  const waBody = p.doc.getElementById('f18-prepare-body');
  assert.ok(/WhatsApp candidate/.test(waBody.textContent), 'the candidate label is shown');
  assert.ok(/Not verified for WhatsApp/.test(waBody.textContent), 'the standing WhatsApp caveat is shown');
  assert.ok(/1234567|\+92/.test(waBody.textContent), 'the stored number is shown verbatim');
  assert.ok(/No WhatsApp-specific message transformation/.test(waBody.textContent), 'the note says no transformation exists');

  p.f18SetChannel('email');
  await settle();
  const emBody = p.doc.getElementById('f18-prepare-body');
  assert.ok(/hello@acme\.example\.com/.test(emBody.textContent), 'switching back returns the email recipient');
  assert.ok(!/Not verified for WhatsApp/.test(emBody.textContent), 'no WhatsApp caveat on the Email tab');
  assert.deepStrictEqual(calls, ['email', 'whatsapp', 'email'], 'each switch is one fresh prepare call; nothing accumulates');
});

test('R3. a channel with no usable contact renders its tab disabled and never calls prepare() for it', async () => {
  const calls = [];
  const data = Object.assign({}, PREVIEW_EMAIL, {
    contactFacts: {
      contacts: { email: { present: true, valid: true, value: 'hello@acme.example.com', state: 'available' },
        phone: { present: false, valid: null, value: null }, website: { present: false, valid: null, value: null } },
      channels: {
        email: { state: 'available', contact: 'hello@acme.example.com', providerConfigured: null },
        whatsapp: { state: 'missing', contact: null, verified: false, verifiedSource: null },
      },
    },
  });
  const p = loadPrepare({ outreach: { prepare: (payload) => { calls.push(payload); return ok(data); } } });
  p.f18OpenPrepare('p1');
  await settle();
  const waTab = p.doc.getElementById('f18-prepare-channel-whatsapp');
  assert.ok(waTab, 'the WhatsApp tab exists');
  assert.strictEqual(waTab.disabled, true, 'the WhatsApp tab is disabled when no phone is stored');
  assert.strictEqual(p.f18ChannelAvailability(data).whatsapp, false);
  assert.strictEqual(p.f18ChannelAvailability(data).email, true);
  waTab.fire('click'); // a disabled tab must not get a channel change
  await settle();
  assert.strictEqual(calls.length, 1, 'only the initial Email prepare ran; the disabled WhatsApp tab cannot trigger a prepare');
  assert.deepStrictEqual(calls.map((c) => c.channel), ['email']);
});

test('R4. an honest backend refusal is shown as an alert and never as a simulated preview', async () => {
  const p = loadPrepare({ outreach: { prepare: () => bad('NOT_READY', 'Only a pitch the Outreach Gate currently allows can be prepared.') } });
  p.f18OpenPrepare('p1');
  await settle();
  assert.strictEqual(p.f18PrepareState.data, null, 'no preview data is shown');
  assert.strictEqual(p.f18PrepareState.error.code, 'NOT_READY');
  const body = p.doc.getElementById('f18-prepare-body');
  const bodyText = body.textContent;
  assert.ok(/NOT_READY/.test(bodyText) && /Outreach Gate/.test(bodyText), 'the typed refusal is shown, not a fabricated preview');
  for (const b of body.byTag('button')) {
    assert.ok(!/\bSend\b|\bSchedule\b|\bQueue\b|\bLaunch\b|\bCampaign\b|\bRetry\b/i.test(b.textContent), 'no outbound control in the refusal view');
  }
});

test('R5. closing resets state, and a late prepare response for a closed panel does not render', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const p = loadPrepare({ outreach: {
    prepare: () => new Promise((r) => gate.then(() => r(ok(PREVIEW_EMAIL)))),
  } });
  p.f18OpenPrepare('p1'); // fires prepare() but it has not resolved
  assert.strictEqual(p.f18PrepareState.loading, true);
  p.f18ClosePrepare();
  assert.strictEqual(p.f18PrepareState.open, false);
  assert.strictEqual(p.f18PrepareState.data, null);
  assert.strictEqual(p.f18PrepareState.pitchId, null);
  release(); // resolve the stale, in-flight prepare
  await settle();
  assert.strictEqual(p.f18PrepareState.data, null, 'the stale response is discarded and renders nothing');
  assert.ok(!p.doc.getElementById('f18-prepare-overlay'), 'the overlay is removed after close');
});

test('R6. the renderer block keeps the same outbound/send and persistence hygiene as the service', () => {
  const code = stripComments(F18_RENDERER);
  // Only CALLS are banned. The string "Review only · nothing is sent, queued or recorded"
  // is honest copy, not a control, so a bare word is not what is checked - a method call is.
  for (const banned of [/\b(send|schedule|queue|retry|campaign|launch)\s*\(/, /\bfetch\s*\(/, /XMLHttpRequest/, /\bWebSocket\b/, /EventSource/, /innerHTML/, /document\.write/, /ipcRenderer/, /require\s*\(/]) {
    assert.ok(!banned.test(code), 'the F18 renderer block must not call: ' + banned);
  }
  assert.ok(!/ztechLeadIntel\.[a-z]+\.(send|schedule|queue|retry|campaign|verify)/i.test(code), 'no outbound method is reachable');
  assert.ok(!/verify|verifier/i.test(code), 'no verification is claimed or requested in the code');
  // WhatsApp is only ever shown as a candidate here - never as available or verified.
  assert.ok(!/whatsapp[^;]{0,60}\.state\s*===?\s*['"]available['"]/i.test(code), 'WhatsApp never uses an available state');
  assert.ok(!/verified\s*:\s*true/.test(code), 'nothing renders WhatsApp as verified');
  // No storage/network/framework surface in the block.
  assert.ok(!/\b(fetch|XMLHttpRequest|WebSocket|EventSource|ipcRenderer|innerHTML|document\.write|require)\b/i.test(code),
    'no renderer network, IPC or storage surface');
});

// ============================================================ runner

(async () => {
  for (const [name, fn] of tests) {
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
})();
