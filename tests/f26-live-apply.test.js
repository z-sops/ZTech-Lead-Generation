'use strict';

// F26 (D2) - LIVE APPLY. A Settings save reaches the running OutreachService without a
// restart. This file drives the REAL chain end to end:
//
//   outreachSettings.save*/setKey/verify  ->  onChange
//     -> applyOutreachSettings + emailConfigFromSettings / whatsappConfigFromSettings /
//        businessProfileFromSettings (the exact functions, sliced out of main.js)
//     -> OutreachService.reconfigure
//     -> the next gate / sendEmail / generate sees the new values.
//
// Send semantics are NOT changed: the same capability evaluators and the same refusal
// codes decide. Nothing reaches the network - the Resend transport is a spy and the
// domain check uses a fake fetch.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const LI = path.join(root, 'src', 'main', 'lead-intelligence');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');

globalThis.fetch = async () => { throw new Error('F26 D2 TEST GUARD: real network is forbidden'); };

const vault = require(path.join(root, 'src', 'main', 'credentialVault.js'));
const { createOutreachSettings } = require(path.join(LI, 'outreach', 'outreachSettings'));
const { MemoryStore } = require(path.join(LI, 'persistence', 'MemoryStore.js'));
const { ResendEmailProvider } = require(path.join(LI, 'outreach', 'email', 'ResendEmailProvider.js'));
const { readBusinessProfile } = require(path.join(LI, 'outreach', 'businessProfile.js'));
const { createLeadIntelligence } = require(path.join(LI, 'index.js'));
const { round1PacketMapper } = require(path.join(LI, 'round1PacketMapper.js'));
const { round1Record, zuniV1Packet } = require(path.join(root, 'tests', 'lead-intelligence', 'fixtures', 'round1Record.js'));

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const SILENT = { info() {}, warn() {}, error() {} };
const CAPTURED_AT = '2026-10-01T10:00:00.000Z';
const clock = () => new Date('2026-10-06T10:00:00.000Z');
const KEY = 're_f26_live_apply_key_never_leaks_42';

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
    get(p, d) { const [o, k] = walk(p, false); return o && o[k] !== undefined ? o[k] : d; },
    set(p, v) { const [o, k] = walk(p, true); o[k] = JSON.parse(JSON.stringify(v)); },
    delete(p) { const [o, k] = walk(p, false); if (o) delete o[k]; },
  };
}
const safeStorage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'dpapi',
  encryptString: (p) => Buffer.from('enc:' + p, 'utf8'),
  decryptString: (b) => { const t = b.toString('utf8'); if (!t.startsWith('enc:')) throw new Error('x'); return t.slice(4); },
};
const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });

/** Slice a top-level `function name(` declaration out of main.js, verbatim. */
function sliceFn(name) {
  const start = mainSource.indexOf(`\nfunction ${name}(`);
  assert.ok(start !== -1, `main.js declares ${name}`);
  const end = mainSource.indexOf('\n}\n', start);
  return mainSource.slice(start, end + 3);
}

/** The production apply chain from main.js, bound to a given store and runtime. */
function loadMainApply(electronStore, leadIntelRuntime) {
  const src = ['emailConfigFromSettings', 'whatsappConfigFromSettings', 'businessProfileFromSettings', 'applyOutreachSettings']
    .map(sliceFn).join('\n');
  const localRequire = (p) => require(p.startsWith('./') ? path.join(root, p) : p);
  // eslint-disable-next-line no-new-func
  return new Function('electronStore', 'leadIntelRuntime', 'require', src + '\nreturn applyOutreachSettings;')(
    electronStore, leadIntelRuntime, localRequire);
}

function build() {
  vault.setSafeStorageForTests(safeStorage);
  const store = makeStore();
  const sends = [];
  const provider = new ResendEmailProvider({
    transport: async (req) => { sends.push(req); return { status: 200, body: { id: 're_msg_live_1' } }; },
    getApiKey: () => KEY,
  });
  const lead = { id: 'L1', title: 'Acme Bakery', website: 'https://acme.example.com', email: 'hello@acme.example.com', phone: '+923001234567', address: '12 Road', qualification: 'qualified' };
  const record = round1Record({
    id: 'rec_L1', leadRef: 'L1', domain: 'acme.example.com', providerJobId: 'job_L1',
    packet: zuniV1Packet({ domain: 'acme.example.com', capturedAt: CAPTURED_AT }), createdAt: CAPTURED_AT, updatedAt: CAPTURED_AT,
  });
  // Startup: exactly what initLeadIntelligence does - read the (empty) settings once.
  const li = createLeadIntelligence({
    store: new MemoryStore(),
    leadSource: { getLead: async (id) => (String(id) === 'L1' ? lead : null), listLeads: async () => [lead] },
    round1: {
      async getLatest(id) { return id === 'L1' ? record : null; },
      async listByLead(id) { return id === 'L1' ? [record] : []; },
      async listLatestPerLead() { return new Map([['L1', record]]); },
    },
    config: {
      research: { mode: 'round1' },
      freshness: { completeMaxAgeDays: 30, partialMaxAgeDays: 7 },
      outreach: { allowedQualification: ['qualified'], allowPartialEvidence: false, requireIcpFit: false },
      offer: readBusinessProfile(store),
      email: { enabled: false, fromAddress: null },
      whatsapp: { enabled: false, fromNumber: null },
    },
    clock, logger: SILENT, round1ResultMapper: round1PacketMapper,
    emailProvider: provider, emailConfigStore: store,
  });
  const runtime = { li };
  const apply = loadMainApply(store, runtime);
  let applies = 0;
  const fetchImpl = async () => resp(200, { data: [{ name: 'live-apply.test', status: 'verified' }] });
  const settings = createOutreachSettings({ store, safeStorage, fetchImpl, clock, onChange: () => { applies += 1; apply(); }, logger: SILENT });
  return { li, store, settings, sends, applies: () => applies };
}

async function approvedPitch(li) {
  await li.research.sync({ leadId: 'L1' });
  const pitch = await li.outreach.generate({ leadId: 'L1' });
  await li.outreach.approve({ pitchId: pitch.pitch_id });
  return pitch;
}

async function configureEmail(settings) {
  await settings.saveEmail({ enabled: true, fromName: 'Ridgeline', fromAddress: 'sender@live-apply.test', domain: 'live-apply.test' });
  await settings.setKey('resend', KEY);
  const v = await settings.verify('resend');
  assert.strictEqual(v.status, 'verified');
}

test('main.js wires outreachSettings.onChange to applyOutreachSettings -> outreach.reconfigure', () => {
  assert.match(mainSource, /onChange:\s*\(\)\s*=>\s*applyOutreachSettings\(\)/);
  const body = sliceFn('applyOutreachSettings');
  assert.match(body, /outreach\.reconfigure\(\{/);
  for (const fn of ['emailConfigFromSettings()', 'whatsappConfigFromSettings()', 'businessProfileFromSettings()']) assert.ok(body.includes(fn), fn);
});

test('startup with email off refuses EMAIL_DISABLED; enabling in Settings sends on the NEXT attempt, no restart', async () => {
  const { li, settings, sends, applies } = build();
  const pitch = await approvedPitch(li);
  await assert.rejects(() => li.outreach.sendEmail({ pitchId: pitch.pitch_id }), (e) => e.code === 'EMAIL_DISABLED');
  assert.strictEqual(sends.length, 0);

  await configureEmail(settings);
  assert.ok(applies() >= 3, 'every successful write applied live');
  const gate = await li.outreach.gate({ pitchId: pitch.pitch_id });
  assert.strictEqual(gate.delivery ? gate.delivery.canSend : li.outreach.sendCapability('email').canSend, true);

  const result = await li.outreach.sendEmail({ pitchId: pitch.pitch_id });
  assert.strictEqual(result.providerAcknowledged, true);
  assert.strictEqual(sends.length, 1, 'exactly one provider invocation');
  assert.strictEqual(JSON.parse(sends[0].body).from.includes('sender@live-apply.test'), true, 'the live From address is the one sent');
  assert.ok(!JSON.stringify(result).includes(KEY), 'no secret in the result');
});

test('disabling in Settings closes the boundary immediately - same EMAIL_DISABLED refusal, zero provider calls', async () => {
  const { li, settings, sends } = build();
  await configureEmail(settings);
  const pitch = await approvedPitch(li);
  await settings.saveEmail({ enabled: false });
  await assert.rejects(() => li.outreach.sendEmail({ pitchId: pitch.pitch_id }), (e) => e.code === 'EMAIL_DISABLED');
  assert.strictEqual(sends.length, 0);
});

test('Business profile save reaches the next generated pitch without a restart', async () => {
  const { li, settings } = build();
  await li.research.sync({ leadId: 'L1' });
  const before = await li.outreach.generate({ leadId: 'L1' });
  assert.ok(!JSON.stringify(before).includes('Ridgeline Supply'));
  await settings.saveBusiness({ representativeName: 'Dana', companyName: 'Ridgeline Supply', valueProposition: 'We fix the website issues an audit finds.', callToAction: 'Would a short call help?' });
  const after = await li.outreach.generate({ leadId: 'L1' });
  assert.ok(JSON.stringify(after).includes('Ridgeline Supply'), 'the new company identity is used');
});

test('reconfigure: omitted fields untouched; null/garbage fails closed to disabled', () => {
  const { li } = build();
  const o = li.outreach;
  o.reconfigure({ email: { enabled: true, fromAddress: 'a@b.test' } });
  o.reconfigure({ offer: { sender_company: 'X' } });
  assert.deepStrictEqual([o.email.enabled, o.email.fromAddress], [true, 'a@b.test']);
  o.reconfigure({ email: null, whatsapp: 'nope' });
  assert.deepStrictEqual([o.email.enabled, o.whatsapp.enabled], [false, false]);
  o.reconfigure({ offer: null });
  assert.deepStrictEqual(o.offer, {});
});

test('a failed write does not apply; the apply never needs the key value', async () => {
  const { settings, applies, store } = build();
  const n = applies();
  assert.throws(() => settings.saveEmail({ fromAddress: 'x@other.test', domain: 'live-apply.test' }));
  assert.strictEqual(applies(), n);
  await settings.setKey('resend', KEY);
  assert.ok(!JSON.stringify(store.data.settings || {}).includes(KEY), 'key never lands in settings.*');
  assert.ok(!sliceFn('applyOutreachSettings').includes('apiKey'));
});

test('F26 follow-up: a replaced key closes the send boundary until Check runs again (zero provider calls meanwhile)', async () => {
  const { li, settings, sends } = build();
  await configureEmail(settings);
  const pitch = await approvedPitch(li);
  await settings.setKey('resend', KEY + '_rotated');
  await assert.rejects(() => li.outreach.sendEmail({ pitchId: pitch.pitch_id }), (e) => e.code === 'EMAIL_DOMAIN_NOT_VERIFIED');
  assert.strictEqual(sends.length, 0, 'stale verification never reaches the provider');
  assert.strictEqual((await settings.verify('resend')).status, 'verified');
  const result = await li.outreach.sendEmail({ pitchId: pitch.pitch_id });
  assert.strictEqual(result.providerAcknowledged, true);
  assert.strictEqual(sends.length, 1);
});

(async () => {
  let passed = 0; let failed = 0;
  for (const { name, fn } of tests) {
    try { await fn(); passed++; console.log('ok - ' + name); } catch (err) { failed++; console.log('FAIL - ' + name); console.log(String(err && err.stack ? err.stack : err)); }
  }
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
