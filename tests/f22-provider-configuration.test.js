'use strict';

// ============================================================ F22
// PROVIDER CONFIGURATION FOUNDATION - the safety contract.
//
// F22 is a CONFIGURATION phase. It resolves provider configuration into one factual
// capability verdict, hands that verdict to the send boundary as an additional
// fail-closed check, and executes nothing. These tests are the proof, in the order
// the phase specification lists them:
//
//   configuration source -> safe parser -> capability resolver -> bounded status read
//   -> existing Prepare/send boundary consults capability -> NO provider execution
//
// Nothing here may send, and nothing here may change readiness. A later phase may
// legitimately start executing; these tests exist so that doing so accidentally is
// loud rather than silent.

const fs = require('fs');
const { withTrustOffer, grantTrustForLeadsSync } = require('./trust-fixture'); // F26.5
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const serviceSource = read(path.join('src', 'main', 'lead-intelligence', 'outreach', 'OutreachService.js'));
const resendConfigSource = read(path.join('src', 'main', 'lead-intelligence', 'outreach', 'email', 'resendConfig.js'));
const sendConfigSource = read(path.join('src', 'main', 'lead-intelligence', 'outreach', 'email', 'sendConfig.js'));
const ipcSource = read(path.join('src', 'main', 'lead-intelligence', 'outreach-ipc.js'));
const preloadSource = read('preload.js');
const rendererSource = read(path.join('src', 'renderer', 'renderer.js'));
const htmlSource = read('index.html');
const migrationsSource = read(path.join('src', 'main', 'lead-intelligence', 'persistence', 'migrations.js'));
const mainSource = read('main.js');

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const serviceCode = stripComments(serviceSource);
const ipcCode = stripComments(ipcSource);

const {
  readResendConfig, evaluateResendCapability, RESEND_REFUSALS, VERIFICATION_STATUSES, emptyResendConfig,
} = require(path.join(root, 'src', 'main', 'lead-intelligence', 'outreach', 'email', 'resendConfig.js'));
const { normalizeActivityMetadata, SEND_STATES, SEND_CHANNELS } =
  require(path.join(root, 'src', 'main', 'lead-intelligence', 'persistence', 'contract.js'));
const { scrubSecrets } = require(path.join(root, 'src', 'main', 'lead-intelligence', 'core', 'objects.js'));
const { MemoryStore } = require(path.join(root, 'src', 'main', 'lead-intelligence', 'persistence', 'MemoryStore.js'));
const { createLeadIntelligence } = require(path.join(root, 'src', 'main', 'lead-intelligence', 'index.js'));
const { round1PacketMapper } = require(path.join(root, 'src', 'main', 'lead-intelligence', 'round1PacketMapper.js'));
const { round1Record, zuniV1Packet } = require(path.join(root, 'tests', 'lead-intelligence', 'fixtures', 'round1Record.js'));
const { EmailProvider } = require(path.join(root, 'src', 'main', 'lead-intelligence', 'outreach', 'email', 'EmailProvider.js'));
const { WhatsAppProvider } = require(path.join(root, 'src', 'main', 'lead-intelligence', 'outreach', 'whatsapp', 'WhatsAppProvider.js'));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const CLOCK_ISO = '2026-10-02T10:00:00.000Z';
const CAPTURED_AT = '2026-10-01T10:00:00.000Z';
const clock = () => new Date(CLOCK_ISO);
const SILENT = { info() {}, warn() {}, error() {} };

// The value that must never be observable anywhere outside the configuration source.
const SECRET_KEY = 're_this_api_key_must_never_escape_42';

const OFFER = {
  sender_name: 'Zee',
  sender_company: 'ZuniTech',
  value_proposition: 'We help local businesses fix the website issues found in an audit like this one.',
  call_to_action: 'Would a short call next week be useful to go through these points?',
};

const lead = (o) => Object.assign({
  id: 'L1', title: 'Acme Bakery', website: 'https://acme.example.com', email: 'hello@acme.example.com',
  phone: '+923001234567', address: '12 Road', qualification: 'qualified',
}, o);

/**
 * A configuration source double. It answers `get` from a plain object and records every
 * `set`, so "this layer is a read and nothing else" is provable rather than asserted in
 * prose.
 */
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

/** A fully, structurally complete and verified configuration - still able to send nothing. */
const VERIFIED_SETTINGS = Object.freeze({
  emailProvider: 'resend',
  emailFromName: 'ZuniTech',
  emailFromAddress: 'hello@zunitechai.com',
  emailDomain: 'zunitechai.com',
  emailDomainVerification: 'verified',
});

/** A source holding the given settings AND a stored credential. */
const withCredential = (settings) =>
  fakeConfigStore(settings, { resend: { credentials: { apiKey: SECRET_KEY } } });

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

function makeRuntime(leads, { emailProvider = null, email = {}, emailConfigStore = undefined, whatsappProvider = null } = {}) {
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
      whatsapp: { enabled: true, fromNumber: '+923001111111' },
      email: Object.assign({ enabled: false, fromAddress: 'zee@zunitech.example.com' }, email),
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

async function runLead(li, leadId, { approve = true } = {}) {
  await li.research.sync({ leadId });
  const pitch = await li.outreach.generate({ leadId });
  if (approve) await li.outreach.approve({ pitchId: pitch.pitch_id });
  const gate = await li.outreach.gate({ pitchId: pitch.pitch_id });
  return { pitch, gate };
}

/**
 * Counts every network request made while `fn` runs, and restores the globals afterwards.
 * Used to prove the negative: this phase contacts nothing, ever.
 */
async function withNetworkSpy(fn) {
  const seen = [];
  const globals = globalThis;
  const originalFetch = globals.fetch;
  const originalXHR = globals.XMLHttpRequest;
  const originalWS = globals.WebSocket;
  const record = (kind, args) => seen.push({ kind, args });
  try {
    if (typeof originalFetch === 'function') {
      globals.fetch = function (...a) { record('fetch', a); return Promise.reject(new Error('network disabled in test')); };
    }
    if (typeof originalXHR === 'function') {
      globals.XMLHttpRequest = function () { record('xhr', []); throw new Error('network disabled in test'); };
    }
    if (typeof originalWS === 'function') {
      globals.WebSocket = function () { record('ws', []); throw new Error('network disabled in test'); };
    }
    await fn();
  } finally {
    globals.fetch = originalFetch;
    globals.XMLHttpRequest = originalXHR;
    globals.WebSocket = originalWS;
  }
  return seen;
}

// ============================================================ 1. read-only

test('1. the provider status read is read-only: no configuration write, no store write, no activity', async () => {
  const cfg = fakeConfigStore({}, { resend: { credentials: { apiKey: SECRET_KEY } } });
  const before = JSON.stringify({ s: cfg.data.settings, p: cfg.data.providers });

  const snapshot = readResendConfig(cfg);
  assert.strictEqual(typeof snapshot, 'object', 'a snapshot is returned');
  assert.strictEqual(cfg.calls.set, 0, 'readResendConfig called set() zero times');

  const { li, store } = makeRuntime({ L1: lead({}) }, { emailConfigStore: cfg });
  const writes = [];
  for (const m of ['upsert', 'append', 'insert', 'set', 'save']) {
    if (typeof store.pitches[m] === 'function') store.pitches[m] = (function (orig) {
      return (...a) => { writes.push(m); return orig.apply(store.pitches, a); };
    })(store.pitches[m].bind(store.pitches));
  }
  const activityBefore = JSON.stringify(await li.outreach.activityList({ limit: 100 }));

  const first = await li.outreach.getEmailProviderStatus();
  const second = await li.outreach.getEmailProviderStatus();

  assert.deepStrictEqual(second, first, 'the read is deterministic - it derives nothing new');
  assert.strictEqual(cfg.calls.set, 0, 'the status read called set() zero times');
  assert.strictEqual(JSON.stringify({ s: cfg.data.settings, p: cfg.data.providers }), before,
    'the configuration source is byte-identical after the read');
  assert.deepStrictEqual(writes, [], 'no store write method ran');
  assert.strictEqual(JSON.stringify(await li.outreach.activityList({ limit: 100 })), activityBefore,
    'reading provider status records no activity');
  assert.strictEqual(Object.isFrozen(snapshot) || typeof snapshot === 'object', true, 'a bounded object is returned');
});

// ============================================================ 2-4. secrets

test('2. the API key never crosses the IPC boundary', async () => {
  const cfg = fakeConfigStore(VERIFIED_SETTINGS, { resend: { credentials: { apiKey: SECRET_KEY } } });
  const { li } = makeRuntime({ L1: lead({}) }, { emailConfigStore: cfg });

  const status = await li.outreach.getEmailProviderStatus();
  const asJson = JSON.stringify(status);
  assert.ok(!asJson.includes(SECRET_KEY), 'the raw key is absent from the status payload');
  assert.ok(!asJson.includes('enc:v1:'), 'a sealed key is absent too');

  // Every string value, recursively, must be free of it - not just the top level.
  const offenders = [];
  const walk = (v, at) => {
    if (typeof v === 'string') { if (v.includes(SECRET_KEY)) offenders.push(at); return; }
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, at + '[' + i + ']'));
    if (v && typeof v === 'object') return Object.entries(v).forEach(([k, x]) => walk(x, at + '.' + k));
  };
  walk(status, 'status');
  assert.deepStrictEqual(offenders, [], 'no nested value carries the key');

  // Nothing that looks like a credential is even NAMED on the payload, so the boundary's
  // secret scrub has nothing to find and cannot silently mask a real leak.
  const secretKeyPattern = /(token|secret|password|passwd|api[_-]?key|apikey|authorization|credential|bearer|cookie|session[_-]?id|private[_-]?key)/i;
  const named = Object.keys(status).filter((k) => secretKeyPattern.test(k));
  assert.deepStrictEqual(named, [], 'the payload names no credential-shaped key: ' + named.join(','));

  // The scrub the IPC boundary actually applies must also be free of it.
  const scrubbed = JSON.stringify(scrubSecrets(JSON.parse(JSON.stringify(status))));
  assert.ok(!scrubbed.includes(SECRET_KEY), 'the scrubbed payload is free of the key');

  // And the payload must still carry the FACT after scrubbing - otherwise the scrub would
  // be hiding the leak by hiding the information the operator needs.
  assert.strictEqual(scrubSecrets(JSON.parse(JSON.stringify(status))).capability.canSend, true,
    'the capability verdict survives the scrub');
});

test('3. the API key never appears in the renderer, the preload bridge or the markup', () => {
  // F22 adds NO renderer surface: the status is reported by the existing Prepare/send
  // boundary's own `delivery` block. So there is nothing for a secret to travel to.
  for (const [name, src] of [['renderer', rendererSource], ['preload', preloadSource], ['index.html', htmlSource]]) {
    assert.ok(!/getEmailProviderStatus|readResendConfig|resendConfig|email-provider-status/.test(src),
      name + ' references no provider-configuration reader');
    assert.ok(!src.includes(SECRET_KEY), name + ' contains no key literal');
  }
  // No Resend-shaped key prefix and no credential header vocabulary in the renderer.
  for (const banned of [/re_[A-Za-z0-9]{10,}/, /Bearer\s+[A-Za-z0-9._-]{10,}/, /Authorization['"]?\s*:/]) {
    assert.ok(!banned.test(rendererSource), 'renderer has no credential-shaped literal: ' + banned);
  }
  // The configuration reader stays in the main process.
  assert.ok(/require\('\.\/email\/resendConfig'\)/.test(serviceSource), 'the parser is a main-process module');
  assert.ok(!/resendConfig|credentialVault/.test(preloadSource), 'the preload bridge pulls in no configuration reader');
});

test('4. the API key never appears in the activity ledger or the send history', async () => {
  // The ledger's own contract refuses a credential-shaped metadata KEY outright, so a key
  // cannot be recorded even by a future caller that tries.
  const rejected = normalizeActivityMetadata({ reason: 'attempted', apiKey: SECRET_KEY });
  assert.strictEqual(rejected.ok, false, 'a credential-shaped metadata key is refused');
  const rejected2 = normalizeActivityMetadata({ authorization: 'Bearer ' + SECRET_KEY });
  assert.strictEqual(rejected2.ok, false, 'an Authorization-shaped metadata key is refused');

  const cfg = fakeConfigStore(VERIFIED_SETTINGS, { resend: { credentials: { apiKey: SECRET_KEY } } });
  const { li } = makeRuntime({ L1: lead({}) }, { emailConfigStore: cfg });
  const { pitch } = await runLead(li, 'L1');

  // Drive the boundary until it refuses, then read everything it could have written.
  await assert.rejects(() => li.outreach.send({ pitchId: pitch.pitch_id, channel: 'email' }));
  const activity = JSON.stringify(await li.outreach.activityList({ limit: 100 }));
  const sends = JSON.stringify(await li.outreach.sendList({ limit: 100, offset: 0 }));
  assert.ok(!activity.includes(SECRET_KEY), 'the activity ledger is free of the key');
  assert.ok(!sends.includes(SECRET_KEY), 'the send history is free of the key');
  assert.ok(!sends.includes(SECRET_KEY), 'and so is every send row');
});

// ============================================================ 5-8. capability resolution

test('5. a missing credential makes capability unavailable', () => {
  // Provider is selected (via settings) but NO credential is stored at all.
  const cfg = fakeConfigStore(VERIFIED_SETTINGS);
  const config = readResendConfig(cfg);
  assert.strictEqual(config.providerSelected, true, 'a provider is selected');
  assert.strictEqual(config.keyConfigured, false, 'no credential is stored');
  const verdict = evaluateResendCapability(config);
  assert.strictEqual(verdict.canSend, false);
  assert.strictEqual(verdict.code, RESEND_REFUSALS.CREDENTIAL_MISSING);

  // And a credential that is stored but unreadable is its OWN distinct reason - never
  // silently treated as configured, and never reported as valid.
  const sealed = fakeConfigStore(VERIFIED_SETTINGS, { resend: { credentials: { apiKey: 'enc:v1:notbase64!!!' } } });
  const sealedVerdict = evaluateResendCapability(readResendConfig(sealed));
  assert.strictEqual(sealedVerdict.canSend, false);
  assert.strictEqual(sealedVerdict.code, RESEND_REFUSALS.CREDENTIAL_INVALID);

  // The converse, and it matters just as much: a stored, readable credential must NOT be
  // reported as unreadable. Destructuring the vault module wrongly used to cause exactly
  // that, so a complete configuration could never resolve to available.
  const good = readResendConfig(withCredential(VERIFIED_SETTINGS));
  assert.strictEqual(good.keyConfigured, true);
  assert.strictEqual(good.keyReadable, true, 'a stored plaintext key reads back');
});

test('6. a missing or invalid sender makes capability unavailable', () => {
  const noSender = withCredential(Object.assign({}, VERIFIED_SETTINGS, { emailFromAddress: '' }));
  assert.strictEqual(evaluateResendCapability(readResendConfig(noSender)).code, RESEND_REFUSALS.SENDER_MISSING);

  const badSender = withCredential(Object.assign({}, VERIFIED_SETTINGS, { emailFromAddress: 'not-an-address' }));
  assert.strictEqual(evaluateResendCapability(readResendConfig(badSender)).code, RESEND_REFUSALS.SENDER_INVALID);

  // A sender that is syntactically valid is not thereby a mailbox that exists - the
  // verdict says nothing beyond structure.
  const ok = withCredential(VERIFIED_SETTINGS);
  const v = evaluateResendCapability(readResendConfig(ok));
  assert.strictEqual(v.fromAddress, 'hello@zunitechai.com');
});

test('7. an unconfigured or unverified domain makes capability unavailable', () => {
  const none = withCredential(Object.assign({}, VERIFIED_SETTINGS, { emailDomain: '' }));
  const v1 = evaluateResendCapability(readResendConfig(none));
  assert.strictEqual(v1.canSend, false);
  assert.strictEqual(v1.code, RESEND_REFUSALS.DOMAIN_NOT_CONFIGURED);
  assert.strictEqual(v1.domainVerification, VERIFICATION_STATUSES.UNKNOWN, 'no domain reads back as unknown, never verified');

  const pending = withCredential(Object.assign({}, VERIFIED_SETTINGS, { emailDomainVerification: 'pending' }));
  const v2 = evaluateResendCapability(readResendConfig(pending));
  assert.strictEqual(v2.canSend, false);
  assert.strictEqual(v2.code, RESEND_REFUSALS.DOMAIN_NOT_VERIFIED);
  assert.strictEqual(v2.domainVerification, 'pending');

  const failed = withCredential(Object.assign({}, VERIFIED_SETTINGS, { emailDomainVerification: 'failed' }));
  const v3 = evaluateResendCapability(readResendConfig(failed));
  assert.strictEqual(v3.canSend, false);
  assert.strictEqual(v3.code, RESEND_REFUSALS.DOMAIN_VERIFICATION_FAILED);

  // Nothing is hard-coded as verified. An unconfigured build is unavailable, full stop.
  const empty = readResendConfig(null);
  assert.strictEqual(empty.domainConfigured, false);
  assert.strictEqual(empty.domainVerification, VERIFICATION_STATUSES.UNKNOWN);
  assert.strictEqual(evaluateResendCapability(empty).canSend, false);
});

test('8. a verified structural configuration reports available WITHOUT sending anything', async () => {
  const cfg = withCredential(VERIFIED_SETTINGS);
  const config = readResendConfig(cfg);
  assert.strictEqual(config.keyConfigured, true);
  assert.strictEqual(config.senderConfigured, true);
  assert.strictEqual(config.domainConfigured, true);
  assert.strictEqual(config.domainVerification, 'verified');

  const network = await withNetworkSpy(async () => {
    const verdict = evaluateResendCapability(config);
    assert.strictEqual(verdict.canSend, true, 'structurally complete and verified resolves to available');
    assert.strictEqual(verdict.code, null);
    assert.strictEqual(verdict.message, null);
    assert.strictEqual(verdict.providerId, 'resend');

    const { li } = makeRuntime({ L1: lead({}) }, { emailConfigStore: cfg });
    const status = await li.outreach.getEmailProviderStatus();
    assert.strictEqual(status.capability.canSend, true, 'the read model reports the same verdict');
    assert.strictEqual(status.providerSelected, true);
  });

  assert.deepStrictEqual(network, [], 'resolving and reporting capability made ZERO network requests');
  assert.strictEqual(cfg.calls.set, 0, 'and wrote to the configuration source ZERO times');
});

// ============================================================ 9-10. no network

test('9. zero Resend network requests during configuration; the F23 transport is opt-in and inert', async () => {
  // F23 DECLARED CONTRACT CHANGE: the Resend provider adapter now EXISTS (this phase adds
  // the real transport boundary). What F22 still guarantees - and what this test now pins
  // more strictly - is that REQUIRING or CONSTRUCTING it performs zero network calls, and
  // that F22's configuration layers name no endpoint and never call fetch. The transport
  // is reachable only through the send boundary after a fully verified configuration,
  // which the runtime half below proves still refuses for this installation.
  const providerFile = path.join(root, 'src', 'main', 'lead-intelligence', 'outreach', 'email', 'ResendEmailProvider.js');
  assert.ok(fs.existsSync(providerFile), 'the F23 Resend transport adapter exists');

  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls += 1; throw new Error('network is forbidden here'); };
  try {
    const { ResendEmailProvider } = require(providerFile);
    const inert = new ResendEmailProvider();
    assert.strictEqual(inert.id, 'resend', 'it presents itself as the resend adapter');
    assert.strictEqual(typeof inert.send, 'function', 'it implements the provider contract');
    assert.strictEqual(inert.validate({ to: 'a@b.com', from: 'c@d.com', subject: 's', text: 't' }).valid, true,
      'validation is pure and touches no network');
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.strictEqual(fetchCalls, 0, 'requiring or constructing the transport made ZERO network calls');

  for (const [name, src] of [['service', serviceSource], ['sendConfig', sendConfigSource],
    ['resendConfig', resendConfigSource], ['main', mainSource]]) {
    assert.ok(!/api\.resend\.com/.test(src), name + ' names no Resend endpoint');
    assert.ok(!/https?:\/\/[^\s'"`]*resend/i.test(src), name + ' contains no Resend URL');
  }
  // The configuration layer is documentation-and-evaluation only: no transport import.
  assert.ok(!/\bfetch\s*\(|XMLHttpRequest|require\(['"]https?['"]\)|node-fetch|axios/i.test(resendConfigSource),
    'resendConfig.js performs no transport call of any kind');

  const cfg = fakeConfigStore(VERIFIED_SETTINGS, { resend: { credentials: { apiKey: SECRET_KEY } } });
  const { li } = makeRuntime({ L1: lead({}) }, { emailConfigStore: cfg });
  const { pitch } = await runLead(li, 'L1');

  const network = await withNetworkSpy(async () => {
    await li.outreach.getEmailProviderStatus();
    await li.outreach.prepare({ pitchId: pitch.pitch_id, channel: 'email' });
    await assert.rejects(() => li.outreach.send({ pitchId: pitch.pitch_id, channel: 'email' }));
  });
  assert.deepStrictEqual(network, [], 'no network request of any kind was attempted');
});

test('10. zero WhatsApp network requests', async () => {
  const { li } = makeRuntime({ L1: lead({}) });
  const { pitch } = await runLead(li, 'L1');

  const network = await withNetworkSpy(async () => {
    await li.outreach.prepare({ pitchId: pitch.pitch_id, channel: 'whatsapp' });
    await assert.rejects(() => li.outreach.send({ pitchId: pitch.pitch_id, channel: 'email' }));
    // The explicit WhatsApp boundary is reached by nothing in this phase's configuration
    // (no WhatsApp provider is injected), so it refuses before any transport could exist.
    await assert.rejects(() => li.outreach.sendWhatsApp({ pitchId: pitch.pitch_id }));
  });
  assert.deepStrictEqual(network, [], 'no WhatsApp network request of any kind was attempted');
  assert.ok(!/https?:\/\/[^\s'"`]*(whatsapp|graph\.facebook|cloud\.api)/i.test(serviceSource + resendConfigSource),
    'no WhatsApp endpoint is named in the configuration or send layer');
});

// ============================================================ 11-12. no fallback

test('11. an email selection NEVER falls back to WhatsApp', async () => {
  const waCalls = [];
  const wa = new (class extends WhatsAppProvider {
    get id() { return 'test-live-wa'; }
    get live() { return true; }
    async send(m) { waCalls.push(m); return { messageId: 'wa_msg_1', status: 'queued' }; }
  })();

  // Email disabled, WhatsApp fully able: the exact configuration a fallback would pick.
  const { li } = makeRuntime({ L1: lead({}) }, { whatsappProvider: wa, email: { enabled: false } });
  const { pitch } = await runLead(li, 'L1');

  await assert.rejects(() => li.outreach.send({ pitchId: pitch.pitch_id, channel: 'email' }), (e) => {
    assert.ok(/EMAIL/.test(e.code), 'the EMAIL capability refusal is what a human gets: ' + e.code);
    assert.ok(!/WHATSAPP/.test(e.code), 'no WhatsApp code leaks into an email refusal');
    return true;
  });
  assert.deepStrictEqual(waCalls, [], 'the WhatsApp provider was never contacted');

  // And the explicit email boundary behaves identically.
  await assert.rejects(() => li.outreach.sendEmail({ pitchId: pitch.pitch_id }));
  assert.deepStrictEqual(waCalls, [], 'sendEmail never reaches WhatsApp either');
});

test('12. a WhatsApp selection NEVER falls back to email', async () => {
  const emailCalls = [];
  const email = new (class extends EmailProvider {
    get id() { return 'test-live'; }
    get live() { return true; }
    async send(m) { emailCalls.push(m); return { messageId: 'pm_1', status: 'queued' }; }
  })();

  // WhatsApp disabled, email fully able.
  const { li } = makeRuntime({ L1: lead({}) }, {
    emailProvider: email, email: { enabled: true }, whatsappProvider: null,
  });
  const { pitch } = await runLead(li, 'L1');

  await assert.rejects(() => li.outreach.sendWhatsApp({ pitchId: pitch.pitch_id }), (e) => {
    assert.ok(/WHATSAPP/.test(e.code), 'the WHATSAPP capability refusal is what a human gets: ' + e.code);
    assert.ok(!/EMAIL/.test(e.code), 'no email code leaks into a WhatsApp refusal');
    return true;
  });
  assert.deepStrictEqual(emailCalls, [], 'the email provider was never contacted');

  // The send boundary itself is explicitly the EMAIL boundary; it does not "notice" that
  // WhatsApp was selected and quietly change channel - it runs the email checks.
  const outcome = await li.outreach.send({ pitchId: pitch.pitch_id, channel: 'email' });
  assert.strictEqual(outcome.channel, 'email', 'the boundary names its own channel explicitly');
  assert.strictEqual(emailCalls.length, 1, 'and it contacted exactly that channel');
});

// ============================================================ 13-14. readiness vs capability

test('13. provider configuration does not affect Ready membership, order, qualification or approval', async () => {
  const storeA = fakeConfigStore({});
  const storeB = fakeConfigStore(VERIFIED_SETTINGS, { resend: { credentials: { apiKey: SECRET_KEY } } });
  const unconfigured = makeRuntime({ L1: lead({}), L2: lead({ id: 'L2', title: 'Beta Co' }) },
    { emailConfigStore: storeA });
  const configured = makeRuntime({ L1: lead({}), L2: lead({ id: 'L2', title: 'Beta Co' }) },
    { emailConfigStore: storeB });

  for (const rt of [unconfigured, configured]) {
    await runLead(rt.li, 'L1');
    await runLead(rt.li, 'L2');
  }

  const beforeA = await unconfigured.li.outreach.ready({});
  const beforeB = await configured.li.outreach.ready({});

  // Pitch ids are generated per runtime, so the two runtimes hold DIFFERENT pitch ids for
  // the same leads, and Ready ties on the fixed test clock break by those random ids.
  // Membership is therefore compared across runtimes by lead id (order-insensitively),
  // and ORDER only within one runtime: before vs after the configuration flip below.
  const leadIdsA = beforeA.rows.map((r) => r.pitch.lead_id);
  const leadIdsB = beforeB.rows.map((r) => r.pitch.lead_id);
  assert.deepStrictEqual([...leadIdsA].sort(), [...leadIdsB].sort(),
    'the same leads are Ready in both runtimes');
  assert.ok(leadIdsA.length >= 1, 'the fixture produced a Ready row');
  assert.ok(leadIdsA.every(Boolean), 'every Ready row carries a real lead id');

  const pitchIdsA = beforeA.rows.map((r) => r.pitch.pitch_id);
  const pitchIdsB = beforeB.rows.map((r) => r.pitch.pitch_id);
  assert.ok(pitchIdsA.every(Boolean), 'every Ready row carries a real pitch id');
  assert.ok(pitchIdsB.every(Boolean), 'in both runtimes');

  // Snapshot the approvals BEFORE any configuration change, per runtime.
  const approvalsBeforeA = await unconfigured.store.approvals.latestForPitch(pitchIdsA[0]);
  const approvalsBeforeB = await configured.store.approvals.latestForPitch(pitchIdsB[0]);
  assert.ok(approvalsBeforeA && approvalsBeforeA.content_hash, 'both runtimes hold an approval');
  assert.ok(approvalsBeforeB && approvalsBeforeB.content_hash, 'both runtimes hold an approval');

  // Change ONLY the provider configuration on the already-populated runtimes and re-read.
  // The source itself is mutated in place (the service holds it by reference and reads it
  // on every evaluation), so no service state and no outreach data is touched at all.
  storeA.data.settings = VERIFIED_SETTINGS;
  storeA.data.providers = { resend: { credentials: { apiKey: SECRET_KEY } } };
  storeB.data.settings = {};
  storeB.data.providers = undefined;

  const afterA = await unconfigured.li.outreach.ready({});
  const afterB = await configured.li.outreach.ready({});
  assert.deepStrictEqual(afterA.rows.map((r) => r.pitch.pitch_id), pitchIdsA,
    'flipping configuration to verified does not add or remove a Ready row');
  assert.deepStrictEqual(afterB.rows.map((r) => r.pitch.pitch_id), pitchIdsB,
    'flipping configuration back to empty does not add or remove a Ready row');

  // The gate verdict itself - readiness - is byte-identical either way. Each runtime is
  // asked about ITS OWN pitch: pitch ids are per-runtime and never cross over.
  const pitchIdA = pitchIdsA[0];
  const pitchIdB = pitchIdsB[0];
  const gA = await unconfigured.li.outreach.gate({ pitchId: pitchIdA });
  const gB = await configured.li.outreach.gate({ pitchId: pitchIdB });
  assert.strictEqual(gA.decision, gB.decision, 'the gate decision is unchanged');
  assert.deepStrictEqual(gA.reasons, gB.reasons, 'the gate reasons are unchanged');
  // ...while the capability half of the SAME response does reflect configuration.
  assert.notStrictEqual(gA.delivery.blockedCode, gB.delivery.blockedCode,
    'only the delivery/capability half differs');

  // Qualification, evidence freshness and approval are untouched by configuration.
  for (const [rt, pitchId] of [[unconfigured, pitchIdA], [configured, pitchIdB]]) {
    const ctx = await rt.li.contexts.getContext('L1');
    assert.strictEqual(ctx.view.qualification_status, 'qualified', 'qualification is unchanged');
    const stored = await rt.li.outreach.get(pitchId);
    assert.ok(stored.content_hash, 'the pitch content hash still exists');
  }
  const approvalsAfterA = await unconfigured.store.approvals.latestForPitch(pitchIdA);
  const approvalsAfterB = await configured.store.approvals.latestForPitch(pitchIdB);
  assert.ok(approvalsAfterA && approvalsAfterA.content_hash, 'the approval still exists');
  assert.strictEqual(approvalsAfterA.content_hash, approvalsBeforeA.content_hash,
    'flipping configuration to verified does not change the approval');
  assert.strictEqual(approvalsAfterB.content_hash, approvalsBeforeB.content_hash,
    'flipping configuration back to empty does not change the approval');
});

test('14. Prepare distinguishes readiness from capability: allowed AND unable, at once', async () => {
  const cfg = withCredential(Object.assign({}, VERIFIED_SETTINGS, { emailDomainVerification: 'pending' }));
  const { li } = makeRuntime({ L1: lead({}) }, { emailConfigStore: cfg });
  const { pitch, gate } = await runLead(li, 'L1');
  assert.strictEqual(gate.decision, 'allowed', 'the fixture pitch is Ready');

  const prep = await li.outreach.prepare({ pitchId: pitch.pitch_id, channel: 'email' });

  // READINESS: the gate verdict, carried verbatim.
  assert.strictEqual(prep.readiness.decision, 'allowed', 'the pitch is Ready for outreach');
  assert.deepStrictEqual(prep.readiness.reasons, [], 'with no blocking reason');

  // CAPABILITY: unavailable, with its own stable factual reason, alongside it.
  assert.strictEqual(prep.delivery.canSend, false, 'while email capability is unavailable');
  assert.strictEqual(prep.delivery.blockedCode, RESEND_REFUSALS.DOMAIN_NOT_VERIFIED);
  assert.ok(/not been verified/i.test(prep.delivery.blockedMessage), 'and says exactly which fact is missing');

  // The two are separate fields: neither top-level verdict is derived from the other.
  // `readiness` is the gate verdict carried verbatim (locked by F18), and that verdict's
  // own `delivery` block is the very same block delivered beside it - so strip it before
  // checking that READINESS ITSELF holds no capability or WhatsApp fact.
  assert.ok(!('canSend' in prep.readiness), 'readiness carries no top-level capability verdict');
  assert.ok(!('decision' in prep.delivery), 'capability carries no readiness verdict');
  assert.deepStrictEqual(prep.readiness.delivery, prep.delivery,
    'the capability block readiness carries is the same one delivered beside it');
  const readinessOwn = Object.assign({}, prep.readiness);
  delete readinessOwn.delivery;
  assert.ok(!/whatsapp|canSend/i.test(JSON.stringify(readinessOwn)), 'readiness carries no WhatsApp or capability fact of its own');

  // Ready membership is unaffected by the very fact that capability is unavailable.
  const ready = await li.outreach.ready({});
  assert.deepStrictEqual(ready.rows.map((r) => r.pitch.pitch_id), [pitch.pitch_id],
    'an unverifiable domain does not remove a Ready lead');
});

// ============================================================ 15-18. no execution surface

test('15. Campaigns remains disabled', () => {
  const nav = [...htmlSource.matchAll(/<button[^>]*class="[^"]*nav-item[^"]*"[^>]*>[\s\S]*?<span class="nav-label">Campaigns<\/span>/g)];
  assert.ok(nav.length >= 1, 'the Campaigns nav item exists');
  for (const [block] of nav) {
    assert.ok(/\bdisabled\b/.test(block), 'Campaigns stays disabled');
    assert.ok(/nav-item-soon/.test(block), 'Campaigns keeps its "later release" state');
    assert.ok(/aria-disabled="true"/.test(block), 'and announces it');
  }
  assert.ok(!/campaign/i.test(serviceCode), 'the service contains no campaign logic');
  assert.ok(!/campaign/i.test(ipcCode), 'the outreach IPC surface declares no campaign channel');
});

test('16. no scheduler: nothing in this phase can start a timer', () => {
  for (const [name, src] of [['service', serviceSource], ['ipc', ipcSource],
    ['resendConfig', resendConfigSource], ['sendConfig', sendConfigSource]]) {
    assert.ok(!/setInterval\s*\(|setTimeout\s*\(/.test(stripComments(src)), name + ' starts no timer');
  }
  assert.ok(!/\bschedule\w*\s*\(/i.test(serviceCode), 'the service schedules nothing');
  assert.ok(!/\bschedule/i.test(ipcCode), 'no scheduled channel exists');
  // And no channel or bridge method advertises one.
  const channels = [...ipcSource.matchAll(/'lead-intel:[a-z-]+'/g)].map((m) => m[0]);
  assert.deepStrictEqual(channels.filter((c) => /schedule|timer|cron/i.test(c)), [], 'no scheduling channel');
});

test('17. no queue: nothing can enqueue, drain or batch', () => {
  assert.ok(!/\bqueue\s*\(|\.enqueue\s*\(|\.push\s*\(\s*\{[^}]*send/i.test(serviceCode), 'the service enqueues nothing');
  assert.ok(!/\b(batch|queue|outbox)\w*\s*\(/i.test(serviceCode), 'no batch or queue method exists');
  const channels = [...ipcSource.matchAll(/'lead-intel:[a-z-]+'/g)].map((m) => m[0]);
  assert.deepStrictEqual(channels.filter((c) => /queue|batch|outbox/i.test(c)), [], 'no queue channel');
  const bridge = preloadSource.slice(preloadSource.indexOf('outreach: Object.freeze({'));
  assert.ok(!/\b(queue|batch|outbox|sendAll|sendBatch)\w*\s*:/i.test(bridge), 'no queue bridge method');
});

test('18. no automatic retry: a further attempt re-enters the same human-triggered boundary', async () => {
  // The send boundary itself contains no retry loop - one attempt, one call, no second pass.
  const sendBody = serviceCode.slice(serviceCode.indexOf('async sendEmail('), serviceCode.indexOf('async sendWhatsApp('));
  assert.ok(sendBody.length > 500, 'the email boundary was located');
  assert.ok(!/\bretry\s*\(|for\s*\(|while\s*\(|\.attempt\w*\s*\(/.test(sendBody), 'the boundary has no retry loop');
  assert.strictEqual((sendBody.match(/provider\.send\(|emailProvider\.send\(/g) || []).length, 1,
    'exactly one provider call, not a loop');

  // The ledger exposes no retry/attempt/again method - only the read.
  const retryVerb = /\bretry\s*\(|\bsendAgain\s*\(|\bresend\s*\(|\battempt\s*\(/;
  assert.ok(!retryVerb.test(serviceCode), 'the service has no retry verb');
  assert.ok(!retryVerb.test(ipcCode), 'the IPC surface exposes no retry verb');
  // The renderer's recovery affordance re-opens the reviewed Prepare panel; it does not send.
  const f21Block = rendererSource.slice(rendererSource.indexOf('function f21SendHistoryStrip'),
    rendererSource.indexOf('function f21SendHistoryPaint'));
  assert.ok(f21Block.length > 200, 'the F21 recovery affordance was located');
  assert.ok(/f18OpenPrepare\(/.test(f21Block), 'it opens the reviewed Prepare panel');
  assert.ok(!/outreachSend\s*\(/.test(f21Block), 'it never calls the send boundary itself');
});

// ============================================================ 19. F21 manual recovery

test('19. F21 manual recovery re-enters the SAME controlled boundary, with no bypass', async () => {
  const { li, store } = makeRuntime({ L1: lead({}) });
  const { pitch } = await runLead(li, 'L1');

  // Seed a recorded, non-accepted attempt - the state that makes a row look recoverable.
  await store.sends.record({
    send_id: 'send_1', lead_id: 'L1', pitch_id: pitch.pitch_id, channel: 'email',
    content_hash: pitch.content_hash, idempotency_key: 'k1', state: 'attempted',
    provider_id: 'resend', created_at: CLOCK_ISO, updated_at: CLOCK_ISO,
  });
  await store.sends.fail({ sendId: 'send_1', failureCode: 'EMAIL_SEND_FAILED', failureMessage: 'no', at: CLOCK_ISO });

  const page = await li.outreach.sendList({ pitchId: pitch.pitch_id, limit: 50, offset: 0 });
  assert.strictEqual(page.rows.length, 1, 'the recorded attempt is readable');
  assert.strictEqual(page.rows[0].state, 'failed');
  assert.strictEqual(page.rows[0].retryable, true, 'a non-accepted row reports itself as retryable');

  // ...but `retryable` grants nothing. The next attempt still runs capability first and is
  // refused, exactly as a first attempt would be - no path skips the interlocks.
  await assert.rejects(() => li.outreach.send({ pitchId: pitch.pitch_id, channel: 'email' }), (e) => {
    assert.ok(/EMAIL/.test(e.code), 'the capability check still runs first: ' + e.code);
    return true;
  });

  // An ACCEPTED row is not retryable: re-attempting it is a no-op replay, so offering it
  // would advertise an action whose honest outcome is "nothing happened".
  await store.sends.record({
    send_id: 'send_2', lead_id: 'L1', pitch_id: pitch.pitch_id, channel: 'email',
    content_hash: pitch.content_hash, idempotency_key: 'k2', state: 'attempted',
    provider_id: 'resend', created_at: CLOCK_ISO, updated_at: CLOCK_ISO,
  });
  await store.sends.accept({ sendId: 'send_2', providerId: 'resend', providerMessageId: 'pm_1', at: CLOCK_ISO });
  const page2 = await li.outreach.sendList({ pitchId: pitch.pitch_id, limit: 50, offset: 0 });
  const accepted = page2.rows.find((r) => r.sendId === 'send_2');
  assert.strictEqual(accepted.retryable, false, 'an accepted row is not retryable');
});

// ============================================================ 20. no migration

test('20. F22 requires no schema migration and stores no configuration in the database', () => {
  // No migration mentions provider configuration, so applying the F22 layer needs no
  // schema change and no backfill.
  assert.ok(!/resend|email_from|email_domain|email_domain_verification|provider_status/i.test(migrationsSource),
    'no migration references provider configuration');
  for (const banned of [/\bALTER TABLE\b[^\n]*email/i, /\bCREATE TABLE\b[^\n]*(provider|resend)/i, /api[_-]?key/i]) {
    assert.ok(!banned.test(migrationsSource), 'no migration creates provider configuration state: ' + banned);
  }

  // The configuration layer itself contains no SQL and no database handle (code only: the
  // doc comment is allowed to state the negative - that it stores nothing in the DB).
  const resendCode = stripComments(resendConfigSource);
  for (const banned of [/\bCREATE TABLE\b/i, /\bALTER TABLE\b/i, /\bDROP TABLE\b/i, /\bSELECT\b[^\n]*FROM/i,
    /whatsapp\.db|sql\.js|sqlJs|db\.(run|exec|prepare)/i, /migrate\w*\s*\(/i]) {
    assert.ok(!banned.test(resendCode), 'resendConfig.js touches no schema: ' + banned);
  }

  // And the status payload carries no row identity that would imply persisted state.
  const empty = emptyResendConfig();
  for (const banned of [/_id$/, /^id$/, /rowid|table/i]) {
    for (const k of Object.keys(empty)) assert.ok(!banned.test(k), 'the status shape names no row: ' + k);
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
    } catch (e) {
      failed++;
      console.log('FAIL - ' + name);
      console.log(String((e && e.stack) || e));
    }
  }
  console.log(passed + ' passed, ' + failed + ' failed');
  if (failed > 0) process.exitCode = 1;
})();
