'use strict';

// Frontend 2.0 F17 - factual contact points and channel preparation.
//
// THE REAL PRODUCT CONTRACT these tests pin (unchanged by F17):
//
//   Ready queue -> the EXISTING OutreachGate -> channel "email" -> a valid email address
//   is required (CONTACT_FIELD) -> decision "allowed" -> F17 decorates the already-ready
//   row with contact facts.
//
// Consequences enforced below:
//   - a real Ready row ALWAYS carries a valid email today;
//   - a lead with no email, or a malformed email, is EXCLUDED from Ready by the gate,
//     upstream of F17. F17 cannot make such a lead Ready and must never try;
//   - phone availability or classification can never create an allowed verdict;
//   - contacts are derived only AFTER the gate returned allowed.
//
// The A-F tests run the REAL runtime (real bridge, real EvidencePacket, real PitchGenerator,
// real approval, real OutreachGate, real derived query) over a real store - the gate is NOT
// stubbed. Tests that exercise the missing/invalid email branches are labelled DEFENSIVE:
// they pin honest rendering of a malformed or unexpected payload, NOT a reachable
// Ready-service case. No backend behaviour was added or relaxed to reach them.
//
// What is pinned:
//   A. allowed + valid email + valid phone -> included; email AND stored number reported
//   B. allowed + valid email + no phone    -> included; honest missing phone
//   C. missing email    -> gate blocked CONTACT_FIELD -> absent from Ready
//   D. malformed email  -> gate blocked CONTACT_FIELD -> absent from Ready
//   E. perfect contacts blocked for another reason -> absent from Ready
//   F. phone presence/shape alone never creates an allowed verdict
//   G. contacts are derived only after the gate returned allowed
//   H. no WhatsApp verification/availability claim anywhere
//   9. zero new persistence, IPC channel, preload method or schema
//  10. no send/provider/credential surface; the stored number IS rendered

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const htmlSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const rendererSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'renderer.js'), 'utf8');
const stylesSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'styles.css'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const ipcSource = fs.readFileSync(path.join(root, 'src', 'main', 'lead-intelligence', 'outreach-ipc.js'), 'utf8');
const serviceSource = fs.readFileSync(path.join(root, 'src', 'main', 'lead-intelligence', 'outreach', 'OutreachService.js'), 'utf8');
const accountStoreSource = fs.readFileSync(path.join(root, 'src', 'main', 'accountStore.js'), 'utf8');
const migrationsSource = fs.readFileSync(path.join(root, 'src', 'main', 'lead-intelligence', 'persistence', 'migrations.js'), 'utf8');
const catalogSource = fs.readFileSync(path.join(root, 'src', 'main', 'lead-intelligence', 'enrichment', 'catalog.js'), 'utf8');
const pkg = require(path.join(root, 'package.json'));

const tests = [];
function test(name, fn) { tests.push([name, fn]); }
let passed = 0;
let failed = 0;
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const F17_MARKER = '// === F17 Outreach: factual contact points and channel preparation ===';
const F15_MARKER = '// === F15 Outreach: activity history ===';
// F18 declared lock update: F18's own preparation block now sits between F17 and F15, so
// the F17 region is bounded by the F18 marker instead of the F15 marker. F17's own
// assertions are unchanged; the F18 block is pinned by the F18 suite.
const F18_MARKER = '// === F18 Outreach: preparation review';
const f17From = rendererSource.indexOf(F17_MARKER);
const f18From = rendererSource.indexOf(F18_MARKER);
const f15From = rendererSource.indexOf(F15_MARKER);
assert.ok(f17From > -1, 'the F17 block exists in renderer.js');
assert.ok(f18From > f17From, 'the F18 block is defined after the F17 block');
assert.ok(f15From > f18From, 'the F15 block is defined after the F18 block');
const F17 = rendererSource.slice(f17From, f18From);
const F17_CODE = stripComments(F17);

// ============================================================ real runtime fixtures

const { MemoryStore } = require(path.join(root, 'src', 'main', 'lead-intelligence', 'persistence', 'MemoryStore.js'));
const { createLeadIntelligence } = require(path.join(root, 'src', 'main', 'lead-intelligence', 'index.js'));
const { round1PacketMapper } = require(path.join(root, 'src', 'main', 'lead-intelligence', 'round1PacketMapper.js'));
const { OutreachService } = require(path.join(root, 'src', 'main', 'lead-intelligence', 'outreach', 'OutreachService.js'));
const { toLeadView, EMAIL } = require(path.join(root, 'src', 'main', 'lead-intelligence', 'contracts', 'leadView.js'));
const { round1Record, zuniV1Packet } = require(path.join(root, 'tests', 'lead-intelligence', 'fixtures', 'round1Record.js'));

// Fixed clock + fixed capture time, so "is the evidence fresh?" is answered against the
// fixture's own data and never against the calendar date.
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

/** A ZTech lead row as AccountStore stores it. The domain must be a public hostname:
 *  the research bridge refuses reserved TLDs (`.test`, `.local`, ...) on purpose. */
const lead = (o) => Object.assign({
  id: 'L1', title: 'Acme Bakery', website: 'https://acme.example.com', email: 'hello@acme.example.com',
  phone: '+92 300 1234567', address: '12 Road', qualification: 'qualified',
}, o);

/** Read-only Round-1 port over in-memory records (the real `prospect_research` shape). */
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
function makeRuntime(leads) {
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

// ============================================================ A-B. the ready cases

test('A. allowed + valid email + valid phone: included, with the stored number reported', async () => {
  const { li } = makeRuntime({ L1: lead({}) });
  const { gate } = await runLead(li, 'L1');
  assert.strictEqual(gate.decision, 'allowed', 'the real gate allows this lead: ' + JSON.stringify(gate.reasons));
  assert.deepStrictEqual(reasonCodes(gate), [], 'with no blocking reason');

  const res = await li.outreach.ready({});
  assert.strictEqual(res.rows.length, 1, 'the row is in Ready');
  const row = res.rows[0];
  assert.strictEqual(row.gate.decision, 'allowed', 'the row reports the real verdict');
  assert.strictEqual(row.contacts.email.state, 'available');
  assert.strictEqual(row.contacts.email.value, 'hello@acme.example.com', 'the stored email, not a re-derived one');
  assert.deepStrictEqual(row.contacts.phone, { present: true, valid: true, value: '+92 300 1234567' });
  assert.strictEqual(row.channels.whatsapp.state, 'candidate');
  assert.strictEqual(row.channels.whatsapp.contact, '+92 300 1234567', 'the STORED number is what the row carries');
  assert.strictEqual(row.channels.whatsapp.verified, false);
  assert.strictEqual(row.channels.whatsapp.verifiedSource, null);
  // "available" for email means only that a valid address exists: never deliverability.
  assert.strictEqual(row.channels.email.providerConfigured, null, 'provider configuration is not claimed');
  for (const banned of [/deliverab/i, /sent/i, /reachable/i, /verified/i]) {
    assert.ok(!banned.test(JSON.stringify(row.channels.email)), 'no delivery claim: ' + banned);
  }
});

test('B. allowed + valid email + no phone: included, with honest missing-phone facts', async () => {
  const { li } = makeRuntime({ L1: lead({ phone: null }) });
  const { gate } = await runLead(li, 'L1');
  assert.strictEqual(gate.decision, 'allowed', 'a missing phone does not block: ' + JSON.stringify(gate.reasons));

  const res = await li.outreach.ready({});
  assert.strictEqual(res.rows.length, 1, 'the row is still Ready: the gate decides, not the phone');
  const row = res.rows[0];
  assert.strictEqual(row.contacts.email.state, 'available');
  assert.deepStrictEqual(row.contacts.phone, { present: false, valid: null, value: null });
  assert.strictEqual(row.channels.whatsapp.state, 'missing', 'no phone is never a candidate');
  assert.strictEqual(row.channels.whatsapp.contact, null);
  assert.strictEqual(row.channels.whatsapp.verified, false);
});

// ============================================================ C-D. the email gate

test('C. a missing email is blocked by the real gate (CONTACT_FIELD) and absent from Ready', async () => {
  const { li } = makeRuntime({ L1: lead({ email: '' }) });
  const { gate } = await runLead(li, 'L1');
  assert.strictEqual(gate.decision, 'blocked', 'a lead without an email can never be allowed');
  assert.deepStrictEqual(reasonCodes(gate), ['CONTACT_FIELD'], 'and CONTACT_FIELD is the only reason');
  assert.strictEqual(gate.channel, 'email', 'the gate is the email channel');
  const res = await li.outreach.ready({});
  assert.strictEqual(res.rows.length, 0, 'so it is absent from Ready');
});

test('D. a malformed email is blocked by the real gate (CONTACT_FIELD) and absent from Ready', async () => {
  const leads = { L1: lead({ email: 'hello@@acme.example.com' }) };
  const { li } = makeRuntime(leads);
  const { gate } = await runLead(li, 'L1');
  assert.strictEqual(gate.decision, 'blocked', 'a malformed address can never be allowed');
  assert.deepStrictEqual(reasonCodes(gate), ['CONTACT_FIELD'], 'and CONTACT_FIELD is the only reason');
  const res = await li.outreach.ready({});
  assert.strictEqual(res.rows.length, 0, 'so it is absent from Ready');

  // The contract still knows a value was stored - which is why the renderer keeps a
  // defensive "invalid" branch. It is NOT a reachable Ready row (asserted just above).
  const view = (await li.contexts.getContext('L1')).view;
  assert.strictEqual(view.email, null, 'the malformed address is refused as a contact value');
  assert.strictEqual(view.email_raw_present, true, 'but the stored-value presence is still known');
});

// ============================================================ E. blocked, perfect contacts

test('E. perfect email/phone/website blocked for another gate reason is absent from Ready', async () => {
  // The contacts really are perfect on both of these leads.
  const perfect = toLeadView(lead({}));
  assert.ok(perfect.email && EMAIL.test(perfect.email), 'valid email');
  assert.strictEqual(perfect.phone, '+92 300 1234567', 'valid phone');
  assert.strictEqual(perfect.website, 'https://acme.example.com', 'website present');

  // E1 - the approval is missing (HUMAN_APPROVAL).
  const noApproval = makeRuntime({ L1: lead({}) });
  const e1 = await runLead(noApproval.li, 'L1', { approve: false });
  assert.strictEqual(e1.gate.decision, 'blocked');
  assert.deepStrictEqual(reasonCodes(e1.gate), ['HUMAN_APPROVAL'], 'blocked for approval, not for a contact');
  assert.strictEqual((await noApproval.li.outreach.ready({})).rows.length, 0, 'absent from Ready');

  // E2 - the lead is not qualified (QUALIFICATION).
  const unqualified = makeRuntime({ L1: lead({ qualification: 'unqualified' }) });
  const e2 = await runLead(unqualified.li, 'L1');
  assert.strictEqual(e2.gate.decision, 'blocked');
  assert.deepStrictEqual(reasonCodes(e2.gate), ['QUALIFICATION'], 'blocked for qualification, not for a contact');
  assert.strictEqual((await unqualified.li.outreach.ready({})).rows.length, 0, 'absent from Ready');
});

// ============================================================ F. phone never decides

test('F. changing phone availability or classification alone never creates an allowed verdict', async () => {
  // F1 - no email at all, but a perfect phone AND website: still blocked, and the ONLY
  // reason is the gate's own email requirement.
  const noEmail = makeRuntime({ L1: lead({ email: '', phone: '+92 300 1234567', website: 'https://acme.example.com' }) });
  const f1 = await runLead(noEmail.li, 'L1');
  assert.strictEqual(f1.gate.decision, 'blocked', 'a phone cannot stand in for the email the gate requires');
  assert.deepStrictEqual(reasonCodes(f1.gate), ['CONTACT_FIELD'], 'and it says exactly that');
  assert.strictEqual((await noEmail.li.outreach.ready({})).rows.length, 0, 'absent from Ready');

  // F2-F5 - with a valid email the decision is the same whatever the phone looks like.
  const shapes = [
    { what: 'no phone', phone: null, state: 'missing' },
    { what: 'invalid phone', phone: 'not-a-number', state: 'missing' },
    { what: 'mobile-looking phone', phone: '+92 300 1234567', state: 'candidate' },
    { what: 'landline-looking phone', phone: '+44 20 7123 4567', state: null },
  ];
  for (const shape of shapes) {
    const rt = makeRuntime({ L1: lead({ phone: shape.phone }) });
    const r = await runLead(rt.li, 'L1');
    assert.strictEqual(r.gate.decision, 'allowed', shape.what + ': the gate decision does not depend on the phone');
    assert.deepStrictEqual(reasonCodes(r.gate), [], shape.what + ': no reason is raised');
    const res = await rt.li.outreach.ready({});
    assert.strictEqual(res.rows.length, 1, shape.what + ': the row is Ready');
    const wa = res.rows[0].channels.whatsapp;
    assert.notStrictEqual(wa.state, 'available', shape.what + ': WhatsApp is never available');
    if (shape.state) assert.strictEqual(wa.state, shape.state, shape.what + ': state follows validity only');
    else assert.ok(['candidate', 'missing'].includes(wa.state), shape.what + ': only candidate/missing');
    assert.strictEqual(wa.verified, false, shape.what + ': never verified');
  }
});

// ============================================================ G. decoration order

test('G. contacts are derived only AFTER the gate returned allowed', async () => {
  // Source order in the real ready() body: the gate is consulted before any contact fact.
  const body = serviceSource.slice(serviceSource.indexOf('async ready('), serviceSource.indexOf('const nextCursor'));
  const gateIndex = body.indexOf('await this.gate(');
  const contactIndex = body.indexOf('contactFactsFromView(');
  assert.ok(gateIndex > -1, 'ready() calls the gate');
  assert.ok(contactIndex > -1, 'ready() derives contact facts');
  assert.ok(gateIndex < contactIndex, 'the gate is consulted BEFORE any contact fact is read');
  assert.ok(body.includes("if (!verdict || verdict.decision !== 'allowed') continue;"),
    'a non-allowed verdict continues immediately, contacts are never consulted for it');
  assert.strictEqual([...body.matchAll(/verdict\s*=\s*/g)].length, 1, 'the verdict is assigned exactly once, from the gate');
  assert.ok(!/email|whatsapp|phone|website|contacts/i.test(body.slice(gateIndex, body.indexOf("verdict.decision !== 'allowed'"))),
    'no contact participates in the row-selection path');

  // Behaviourally: the row carries the gate verdict verbatim...
  const rt = makeRuntime({ L1: lead({}) });
  const { gate } = await runLead(rt.li, 'L1');
  const res = await rt.li.outreach.ready({});
  assert.strictEqual(res.rows.length, 1);
  assert.deepStrictEqual(res.rows[0].gate, gate, 'the row reports the gate verdict verbatim');

  // ...and a blocked row produces no contact payload at all, because it produces no row.
  const blocked = makeRuntime({ L1: lead({ email: '' }) });
  await runLead(blocked.li, 'L1');
  const blockedRes = await blocked.li.outreach.ready({});
  assert.strictEqual(blockedRes.rows.length, 0, 'a blocked row has no contact payload: it has no row');
});

// ============================================================ H. never a WhatsApp claim

test('H. a phone never produces a verified or available WhatsApp claim', async () => {
  const rt = makeRuntime({ L1: lead({}) });
  await runLead(rt.li, 'L1');
  const res = await rt.li.outreach.ready({});
  const wa = res.rows[0].channels.whatsapp;
  assert.strictEqual(wa.verified, false, 'verified is always false');
  assert.strictEqual(wa.verifiedSource, null, 'no verification source is ever claimed');
  assert.notStrictEqual(wa.state, 'available', 'WhatsApp is never available');
  assert.ok(['candidate', 'missing'].includes(wa.state), 'only candidate/missing, got ' + wa.state);
  // The KEY names necessarily contain "verified" (that is the point of the field), so the
  // claim check runs over string VALUES only - where an untruthful claim would live.
  const claims = [];
  (function values(v) {
    if (typeof v === 'string') claims.push(v);
    else if (v && typeof v === 'object') Object.keys(v).forEach((k) => values(v[k]));
  })(wa);
  for (const claim of claims) {
    assert.ok(!/registered|available|verified|confirmed|reachable|deliverable/i.test(claim),
      'no such claim as a value, found "' + claim + '"');
  }
  assert.ok(claims.includes('+92 300 1234567'), 'the only string value is the stored number itself');

  // The backend asserts no line type: AccountStore has exactly one phone column.
  for (const key of ['lineType', 'line_type', 'isMobile', 'isLandline', 'country', 'countryCode']) {
    assert.ok(!Object.prototype.hasOwnProperty.call(res.rows[0].contacts.phone, key), 'the backend asserts no ' + key);
    assert.ok(!Object.prototype.hasOwnProperty.call(res.rows[0].contacts, key), 'contacts carries no ' + key);
  }
  assert.ok(/CREATE TABLE IF NOT EXISTS numbers \([\s\S]*?phone TEXT/.test(accountStoreSource),
    'AccountStore still has exactly one phone column');
  assert.ok(!/landline|mobile/i.test(accountStoreSource), 'no mobile/landline column was added');
  // Validation is reused, not reimplemented.
  assert.ok(/'company\.phone': \{ normalize: phone/.test(catalogSource), 'the phone normaliser still lives in the catalog');
  assert.ok(/normalizeFieldValue/.test(serviceSource), 'the service reuses the catalog normaliser');
  assert.ok(!/INVALID_PHONE'/.test(serviceSource), 'and does not restate the rule');
});

// ============================================================ DEFENSIVE read model

// DEFENSIVE ONLY - NOT A REACHABLE READY CASE.
// Tests C and D prove the live email gate excludes both of these leads, so no real Ready
// response can carry `missing` or `invalid`. This test exists so that IF a malformed or
// unexpected payload ever arrived, the read model would still tell invalid apart from
// missing instead of flattening them. It must never be read as "allowed + no email" being
// a product state, and nothing was relaxed in the gate to reach it.
test('DEFENSIVE (not reachable): the read model still distinguishes invalid from missing email', async () => {
  const mkView = (o) => Object.assign({
    id: 'L1', name: 'Acme Bakery', phone: null, email: null, email_raw_present: false,
    website: null, address: null, city: null, country: null,
    has_email: false, has_phone: false, has_website: false,
  }, o);
  const store = new MemoryStore();
  store.pitches.rows.set('p1', {
    pitch_id: 'p1', lead_id: 'L1', packet_id: null, research_status: 'complete', target_id: null,
    icp_fit_status: null, subject: 's', opening: 'o', observations: [], valueProposition: 'v',
    callToAction: 'c', evidenceReferences: [], unsupportedClaims: [], status: 'draft',
    content_hash: 'h', created_at: CLOCK_ISO, updated_at: CLOCK_ISO,
  });
  const service = new OutreachService({
    store,
    contexts: { getContext: async () => ({ view: current }) },
    leadSource: {}, freshness: { isFresh: () => true },
    config: {}, clock, logger: SILENT,
  });
  // The gate is stubbed ALLOWED here on purpose: this is the only way to observe the read
  // model's defensive branches, and it is exactly the response the real gate never returns.
  service.gate = async () => ({
    decision: 'allowed', reasons: [], warnings: [], channel: 'email', pitch_id: 'p1',
    delivery: { channel: 'email', emailEnabled: false, providerConfigured: false },
  });
  let current = mkView({ email: null, email_raw_present: false });
  const absent = (await service.ready({})).rows[0];
  assert.strictEqual(absent.contacts.email.state, 'missing');
  assert.strictEqual(absent.contacts.email.present, false);
  assert.strictEqual(absent.channels.email.state, 'missing');

  current = mkView({ email: null, email_raw_present: true });
  const malformed = (await service.ready({})).rows[0];
  assert.strictEqual(malformed.contacts.email.state, 'invalid', 'a stored malformed email is invalid, not missing');
  assert.strictEqual(malformed.channels.email.state, 'invalid');
  assert.strictEqual(malformed.contacts.email.value, null, 'the rejected value is never re-surfaced');
  assert.notStrictEqual(malformed.contacts.email.state, absent.contacts.email.state, 'invalid and missing stay distinguishable');
});

// ============================================================ renderer: real rows -> DOM

const ok = (data) => ({ ok: true, data });
const err = (code, message) => ({ ok: false, error: { code, message } });
const settle = () => new Promise((r) => setTimeout(r, 0));

/** Evaluate the real F16 + F17 blocks against the workspace DOM double. */
function loadWorkspace(api, opts) {
  const options = opts || {};
  const doc = makeDoc();
  const sandbox = {
    document: doc, console, Promise, Date, JSON, Math, Object, Array, Number, String,
    Boolean, Error, Set, Map, RegExp, isNaN, parseInt, parseFloat,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.ztechLeadIntel = api;
  const opened = [];
  sandbox.openLeadDetail = (id) => { opened.push(String(id)); };
  sandbox.f11LeadIntel = () => sandbox.ztechLeadIntel;
  sandbox.f11Unwrap = (res) => {
    if (res && res.ok === true) return res.data;
    const e = new Error((res && res.error && res.error.message) || 'The request failed.');
    e.code = (res && res.error && res.error.code) || 'ERROR';
    throw e;
  };
  sandbox.f11Status = (text, tone) => { const el = doc.createElement('span'); el.textContent = text; el.setAttribute('data-state', tone); return el; };
  sandbox.f11AlertBox = (e) => { const el = doc.createElement('div'); el.textContent = (e && e.code ? e.code + ': ' : '') + (e && e.message ? e.message : ''); return el; };
  sandbox.f11El = (tag, cls, text) => { const el = doc.createElement(tag); el.className = cls || ''; el.textContent = text === undefined ? '' : String(text); return el; };
  // The renderer heuristic, injectable so the labelling can be asserted either way.
  sandbox.isMobileNumber = options.isMobileNumber || (() => true);
  const F16 = rendererSource.slice(rendererSource.indexOf('// === F16 Outreach: the derived Ready queue ==='), f17From);
  const names = Object.keys(sandbox);
  const fn = new Function(...names, F16 + '\n' + F17 + '\nreturn { f16ReadyLoad, f16ReadyState, f17EmailLine, f17WhatsappLine };');
  const loaded = fn.apply(null, names.map((n) => sandbox[n]));
  return Object.assign(loaded, { doc, opened });
}

const cellsOf = (ws) => {
  const trs = ws.doc.getElementById('ready-body').byTag('tr');
  return trs.length ? trs[0].children : [];
};
const contactOf = (ws) => cellsOf(ws)[2].textContent;

/** Load one REAL ready page through the real renderer path. */
async function renderPage(page, opts) {
  const ws = loadWorkspace({ outreach: { ready: () => ok(page) } }, opts);
  await ws.f16ReadyLoad();
  await settle();
  return ws;
}

const pageOf = (rows, extra) => Object.assign({ rows, scanned: rows.length, cursor: 0, nextCursor: null, hasMore: false, limit: 10 }, extra || {});

test('R-A. the real Ready row renders the factual email AND the factual stored phone', async () => {
  const rt = makeRuntime({ L1: lead({}) });
  await runLead(rt.li, 'L1');
  const page = await rt.li.outreach.ready({});
  const ws = await renderPage(page, { isMobileNumber: () => true });
  const contact = contactOf(ws);

  assert.ok(contact.includes('hello@acme.example.com'), 'the factual email is shown: ' + contact);
  assert.ok(contact.includes('+92 300 1234567'), 'the factual STORED PHONE is shown: ' + contact);
  assert.ok(contact.indexOf('+92 300 1234567') < contact.indexOf('Mobile candidate'),
    'the stored value comes BEFORE the labelled reading of it: ' + contact);
  assert.ok(/Mobile candidate \(heuristic\)/.test(contact), 'the heuristic is labelled a candidate: ' + contact);
  assert.ok(/Not verified for WhatsApp/.test(contact), 'and the not-verified caveat is always present: ' + contact);
  // Byte-identical to the backend value: nothing was reformatted on the way to the DOM.
  assert.ok(contact.includes(page.rows[0].channels.whatsapp.contact), 'the rendered number is the backend value verbatim');
  for (const banned of [/WhatsApp available/i, /WhatsApp verified/i, /WhatsApp registered/i, /WhatsApp reachable/i, /WhatsApp deliverable/i, /\bconfirmed\b/i]) {
    assert.ok(!banned.test(contact), 'never claims: ' + banned);
  }
  // The Contact cell is display-only.
  assert.strictEqual(cellsOf(ws)[2].byTag('button').length, 0, 'no control in the Contact cell');
  assert.strictEqual(cellsOf(ws).length, 9, 'the row still has one cell per declared column');
});

test('R-A2. a non-mobile number is still shown, and is only ever a "Phone candidate"', async () => {
  const rt = makeRuntime({ L1: lead({ phone: '+44 20 7123 4567' }) });
  await runLead(rt.li, 'L1');
  const page = await rt.li.outreach.ready({});
  const ws = await renderPage(page, { isMobileNumber: () => false });
  const contact = contactOf(ws);
  assert.ok(contact.includes('+44 20 7123 4567'), 'the stored number is shown: ' + contact);
  assert.ok(/Phone candidate/.test(contact), 'the neutral candidate wording is used: ' + contact);
  assert.ok(/Not verified for WhatsApp/.test(contact), 'and the caveat is present: ' + contact);
  assert.ok(!/landline/i.test(contact), 'it is never asserted to be a landline: ' + contact);
});

test('R-B. a real row with no phone renders the honest missing-phone state', async () => {
  const rt = makeRuntime({ L1: lead({ phone: null }) });
  await runLead(rt.li, 'L1');
  const page = await rt.li.outreach.ready({});
  const ws = await renderPage(page);
  const contact = contactOf(ws);
  assert.ok(contact.includes('hello@acme.example.com'), 'the email is still shown: ' + contact);
  assert.ok(/No phone number/.test(contact), 'and the missing phone is stated: ' + contact);
  assert.ok(!/\d{4,}/.test(contact.replace(/02\/10\/2026/g, '')), 'no phone-like digits are invented: ' + contact);
  assert.ok(!/candidate/i.test(contact), 'a missing phone is never a candidate: ' + contact);
});

// DEFENSIVE RENDERING ONLY - NOT A REACHABLE READY-SERVICE CASE.
// Tests C/D prove the live gate excludes a lead without a valid email, so the backend
// never returns such a row. This test injects malformed row data directly to pin the
// renderer's defensive behaviour, and it is labelled as such on purpose.
test('R-DEFENSIVE (injected malformed row, not a reachable case): missing/invalid render honestly', async () => {
  const rt = makeRuntime({ L1: lead({}) });
  await runLead(rt.li, 'L1');
  const real = (await rt.li.outreach.ready({})).rows[0];

  const invalidRow = {
    ...real,
    contacts: { ...real.contacts, email: { present: false, valid: null, value: null, state: 'invalid' }, phone: { present: true, valid: false, value: null } },
    channels: { email: { state: 'invalid', contact: null, providerConfigured: null }, whatsapp: { state: 'missing', contact: null, verified: false, verifiedSource: null } },
  };
  const invalid = await renderPage(pageOf([invalidRow]));
  const invalidText = contactOf(invalid);
  assert.ok(/Invalid email on lead/.test(invalidText), 'a malformed email reads as invalid: ' + invalidText);
  assert.ok(!/No email/.test(invalidText), 'and is NOT flattened into "no email": ' + invalidText);
  assert.ok(/No phone number/.test(invalidText), 'an invalid phone is not a WhatsApp candidate: ' + invalidText);
  assert.ok(/Stored phone is not a valid number/.test(invalidText), 'and the stored-but-invalid phone is stated: ' + invalidText);

  const missingRow = {
    ...real,
    contacts: { ...real.contacts, email: { present: false, valid: null, value: null, state: 'missing' } },
    channels: { email: { state: 'missing', contact: null, providerConfigured: null }, whatsapp: { state: 'missing', contact: null, verified: false, verifiedSource: null } },
  };
  const missing = await renderPage(pageOf([missingRow]));
  const missingText = contactOf(missing);
  assert.ok(/No email/.test(missingText), 'a missing email says so: ' + missingText);
  assert.ok(!/Invalid email on lead/.test(missingText), 'and is not described as invalid: ' + missingText);
});

test('R-H. no rendered Ready text claims a WhatsApp state beyond candidate/unverified', async () => {
  const rt = makeRuntime({ L1: lead({}) });
  await runLead(rt.li, 'L1');
  const page = await rt.li.outreach.ready({});
  for (const isMobile of [() => true, () => false]) {
    const ws = await renderPage(page, { isMobileNumber: isMobile });
    const text = ws.doc.getElementById('ready-body').textContent;
    assert.ok(!/\bwhatsapp\b[^.]{0,60}\b(available|verified|registered|reachable|deliverable|confirmed)\b/i.test(text),
      'no WhatsApp claim: ' + text);
    assert.ok(!/\b(available|registered|reachable|deliverable)\b/i.test(text), 'no such state anywhere: ' + text);
    // "verified" appears only inside the standing "Not verified for WhatsApp" caveat.
    for (const match of text.matchAll(/.{0,24}\bverified\b.{0,24}/gi)) {
      assert.ok(/Not verified for WhatsApp/.test(match[0]), 'the only "verified" wording is the caveat: ' + match[0]);
    }
  }
});

// ============================================================ 9. scope guards

test('9. zero new persistence, IPC channel, preload method or schema', () => {
  const versions = migrationsSource.match(/Object\.freeze\(\{ version: (\d+), name: '([^']+)'/g).map((s) => s.match(/version: (\d+)/)[1]);
  // F19 declared lock update: migration 004 exists legitimately, so versions are 1-4. The
  // banned-token check below is what actually protects F17's no-schema-change property.
  // F26.5 declared lock update: + 8 (five trust tables) and 9 (activity CHECK + handoff).
  // F26.6 declared lock update: + 10 (mailboxes, mailbox_sent, market rules, sends.mailbox_id).
  assert.deepStrictEqual(versions, ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'], 'migrations include F20 WhatsApp send, I3 OI associations and I5 OI refresh requests and F26.5 trust tables + handoff activity and F26.6 mailbox transport and F28 sequences (declared): ' + versions.join(','));
  for (const banned of [/contact/i, /channel/i, /whatsapp/i, /outbox/i, /queue/i]) {
    assert.ok(!new RegExp('CREATE TABLE IF NOT EXISTS (li_)?\\w*' + banned.source, 'i').test(migrationsSource),
      'no ' + banned + ' table was migrated');
  }
  // F17 is a widening of the existing F16 response: the gate itself is untouched.
  assert.ok(!/contacts|channels\.whatsapp/.test(fs.readFileSync(path.join(root, 'src', 'main', 'lead-intelligence', 'outreach', 'OutreachGate.js'), 'utf8')),
    'the gate was not widened');
  // F18 declared lock update: the prepare schema now follows the ready schema, so the
  // slice is bounded by the F18 block instead of the next '});' (which used to be the
  // schema-map terminator). The assertions below are unchanged.
  const readyStart = ipcSource.indexOf('[CHANNELS.OUTREACH_READY]');
  const readySchema = ipcSource.slice(readyStart, ipcSource.indexOf('// F18:', readyStart));
  assert.ok(!/contact/i.test(readySchema), 'no contact property was added to the ready schema');
  assert.ok(/additionalProperties:\s*false/.test(readySchema), 'the ready schema is still additionalProperties:false');
  assert.ok(/READY_SCAN_MAX/.test(readySchema) && /READY_PAGE_MAX_LIMIT/.test(readySchema), 'its bounds are unchanged');
  const start = preloadSource.indexOf('outreach: Object.freeze({');
  const bridge = stripComments(preloadSource.slice(start, preloadSource.indexOf('}))', start)));
  const methods = [...bridge.matchAll(/(\w+):\s*\(/g)].map((m) => m[1]);
  // F18 declared lock update: + the single read-only prepare method.
  // F19 declared lock update: + the single send boundary (outreachSend).
  // F21 declared lock update: + the single read-only send-ledger read (`sends`). It reads the
  // ledger F19/F20 write; it cannot cause a send, so F17's "no send method" property holds.
  // Phase I2: +7 Opportunity Intelligence channels.
  const expectedOutreach = ['activity', 'approve', 'gate', 'list', 'outreachSend', 'prepare', 'ready', 'sends'];
  const expectedOI = ['health', 'engine', 'request', 'report', 'latest', 'associations', 'pitchContext', 'pitchPreview']; // I7 declared lock update: + pitchPreview
  const expectedI3 = ['status', 'setKey', 'clearKey', 'setSetting', 'chooseFolder', 'setMode', 'start', 'stop', 'restart', 'copyLog']; // I3/I4 declared lock update
  const expectedI6 = ['forLead']; // I6 declared lock update: the read-only lead timeline
  const expectedF265 = ['forLead', 'suppress', 'lift', 'recordConsent', 'handoff', 'reviewReply']; // F26.5 declared lock update: trust (no send) // F26.6 follow-up: + reviewReply (a review, not a send)
  const expectedF266 = ['capabilities', 'list', 'connect', 'disconnect', 'setDefault', 'setLimits', 'setGoogleClient', 'marketRules', 'setMarketRule', 'removeMarketRule', 'check', 'checkReplies']; // F26.6 declared lock update: mailboxes (no send to a lead)
  const expectedF28 = ['create', 'forLead', 'list', 'activate', 'pause', 'resume', 'stop', 'setPauseAll']; // F28 declared lock update: follow-up sequences (none sends)
  assert.deepStrictEqual(methods.sort(), [...expectedOutreach, ...expectedOI, ...expectedI6, ...expectedF265, ...expectedF266, ...expectedF28, ...expectedI3].sort(),
    'F17 added no preload method of its own; F18 adds exactly prepare, F19 exactly outreachSend, F21 exactly the reads; Phase I2 adds Opportunity Intelligence');
  for (const forbidden of [/contact/i, /schedule/i, /whatsapp/i, /verify/i]) {
    assert.ok(!forbidden.test(bridge), 'no preload method for ' + forbidden);
  }
  // F17's own "no send method" property is preserved: outreachSend is the single F19 send
  // method, it is declared once, and there is no send verb that F17 could have introduced.
  assert.strictEqual([...bridge.matchAll(/outreachSend\s*:/g)].length, 1, 'the send method is declared exactly once');
  for (const forbidden of [/^send\b/i, /sendAll/i, /sendBatch/i, /sendContact/i]) {
    assert.ok(!forbidden.test(bridge), 'no F17-style send method for ' + forbidden);
  }
  assert.deepStrictEqual(Object.keys(pkg.dependencies).sort(),
    ['@modelcontextprotocol/client', 'ajv', 'ajv-formats', 'electron-store', 'sql.js'], 'no dependency added');
});

test('10. no send/provider/credential surface, and the stored number IS rendered', () => {
  for (const banned of [/\bsend\b/i, /smtp/i, /nodemailer/i, /schedule/i, /enqueue/i, /outbox/i, /retry\s*\(/i, /campaign/i, /\bbulk\b/i, /twilio/i, /meta.?cloud/i, /qr.?login/i]) {
    assert.ok(!banned.test(F17_CODE), 'the F17 block must not contain: ' + banned);
  }
  assert.ok(!/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|require\s*\(|ipcRenderer|innerHTML/.test(F17_CODE),
    'no network, framework or raw IPC surface');
  assert.ok(!/net\.|https?\.|apiKey|password|token|secret/i.test(F17_CODE), 'no credentials or endpoints');
  // The Contact cell is display-only: it can build no action.
  assert.ok(!/<button|addEventListener|onclick/i.test(F17), 'the F17 block wires no control at all');
  // Only the existing heuristic is used, and only as a labelled candidate.
  assert.ok(/isMobileNumber/.test(F17), 'the only heuristic referenced is the existing isMobileNumber');
  assert.ok(/Mobile candidate \(heuristic\)/.test(F17), 'and its output is labelled as a heuristic');
  // THE D1 FIX: the stored value is the rendered value, the candidate reading is separate.
  assert.ok(/return \{ label: 'WhatsApp', value: stored, note: candidate, hint: 'Not verified for WhatsApp' \};/.test(F17),
    'the stored number is the value; the labelled reading is the note; the caveat is the hint');
  assert.ok(/value: 'No phone number'/.test(F17), 'and a missing phone stays honest');
  assert.ok(/f17-channel-note/.test(F17) && /\.f17-channel-note\s*\{/.test(stylesSource),
    'the labelled reading has its own muted line, defined in the stylesheet');
});

// ============================================================ minimal DOM double

function makeDoc() {
  const listeners = new WeakMap();
  const make = (tag) => {
    const el = {
      tagName: String(tag).toUpperCase(), className: '', children: [], hidden: false, disabled: false,
      attrs: {}, _text: '',
      get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); },
      set textContent(v) { this._text = String(v); this.children = []; },
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
      appendChild(c) { this.children.push(c); return c; },
      replaceChildren(...c) { this.children = c; this._text = ''; },
      addEventListener(type, fn) { listeners.set(this, (listeners.get(this) || []).concat([{ type, fn }])); },
      fire(type) { for (const l of (listeners.get(this) || [])) if (l.type === type) l.fn({ type }); },
      byTag(tag) {
        const want = String(tag).toUpperCase();
        const out = [];
        const walk = (n) => { for (const c of n.children) { if (c.tagName === want) out.push(c); walk(c); } };
        walk(this);
        return out;
      },
      classList: { add() {}, remove() {}, contains() { return false; } },
    };
    return el;
  };
  const nodes = new Map();
  for (const id of ['ready-body', 'ready-range', 'ready-prev', 'ready-next', 'ready-refresh']) nodes.set(id, make('div'));
  return { createElement: make, getElementById: (id) => nodes.get(id) || null, querySelector: () => null, querySelectorAll: () => [] };
}

// Async tests, run in order, so the pass/fail summary is the last line of output.
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
