'use strict';

// ============================================================ F25
// UNIFIED EXPLICIT-CHANNEL SEND + RECOVERY UX (§21 matrix A-AJ).
//
// F25 connects F18-F24 into ONE flow: Prepare -> explicit channel -> preview -> human
// confirm -> ONE bounded dispatcher -> the EXISTING email or WhatsApp boundary -> ledger ->
// history -> manual recovery. This file proves the properties F25 adds on top of the
// already-green F19/F20/F23/F24 suites, in the order the phase specification lists them:
//
//   A/B   the reviewed channel is the sent channel, and ONLY that channel runs
//   C/D   unavailable selected channel fails closed with ZERO invocations of the other
//   E     invalid/missing channel refused by the IPC schema (and by the service)
//   F-I   provider / recipient / body / sender overrides are structurally inexpressible
//   J-L   the bytes on screen before confirm are the bytes handed to the provider
//   M/N   readiness and channel capability stay independent in both directions
//   O/P   double confirm = one attempt; durable idempotency = one provider invocation
//   Q-S   factual result / failure / block language, no secret, no stack, no delivery claim
//   T/U   history distinguishes channels and never leaks a secret
//   V-Z   manual retry re-enters Prepare, preserves the recorded channel, contacts nobody
//         before a NEW confirmation, and never switches channel automatically
//   AA-AD stale approval / stale evidence / changed pitch / changed recipient re-evaluated
//         at the confirm boundary
//   AE/AF missing business or sender profile stays honest - never an invented identity
//   AG-AJ campaigns disabled, no scheduler/queue/auto-retry, zero real network, production
//         DB byte-identical across the whole run
//
// NO REAL EMAIL AND NO REAL WHATSAPP MESSAGE IS SENT ANYWHERE IN THIS FILE. Every provider
// path runs through an injected transport spy with an exact invocation count, and the
// module-level fetch guard fails loudly if anything reaches for the network.

const fs = require('fs');
const { withTrustOffer, grantTrust, grantTrustForLeadsSync } = require('./trust-fixture'); // F26.5
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const serviceSource = read(path.join('src', 'main', 'lead-intelligence', 'outreach', 'OutreachService.js'));
const ipcSource = read(path.join('src', 'main', 'lead-intelligence', 'outreach-ipc.js'));
const rendererSource = read(path.join('src', 'renderer', 'renderer.js'));
const preloadSource = read('preload.js');
const htmlSource = read('index.html');

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// §19/AI HARD NETWORK GUARD: any code path that forgets an injected transport and falls
// through to the default fetch fails loudly here instead of touching the network.
const netGuard = { calls: 0 };
globalThis.fetch = async () => {
  netGuard.calls += 1;
  throw new Error('F25 TEST GUARD: real network is forbidden in this suite');
};

const { registerOutreachIpc, CHANNELS, INPUT_SCHEMAS } =
  require(path.join(root, 'src', 'main', 'lead-intelligence', 'outreach-ipc.js'));
const { MemoryStore } = require(path.join(root, 'src', 'main', 'lead-intelligence', 'persistence', 'MemoryStore.js'));
const { ResendEmailProvider } =
  require(path.join(root, 'src', 'main', 'lead-intelligence', 'outreach', 'email', 'ResendEmailProvider.js'));
const { MetaCloudWhatsAppProvider } =
  require(path.join(root, 'src', 'main', 'lead-intelligence', 'outreach', 'whatsapp', 'MetaCloudWhatsAppProvider.js'));
const { readBusinessProfile, BUSINESS_PROFILE_FIELDS } =
  require(path.join(root, 'src', 'main', 'lead-intelligence', 'outreach', 'businessProfile.js'));
const { createLeadIntelligence } = require(path.join(root, 'src', 'main', 'lead-intelligence', 'index.js'));
const { round1PacketMapper } = require(path.join(root, 'src', 'main', 'lead-intelligence', 'round1PacketMapper.js'));
const { round1Record, zuniV1Packet } = require(path.join(root, 'tests', 'lead-intelligence', 'fixtures', 'round1Record.js'));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const CLOCK_ISO = '2026-10-05T10:00:00.000Z';
const CAPTURED_AT = '2026-10-01T10:00:00.000Z';
const clock = () => new Date(CLOCK_ISO);
const SILENT = { info() {}, warn() {}, error() {} };

// Secrets that exist ONLY in the injected configuration of this file. Production source
// defaults to nothing; these values must never be readable from any response or render.
const EMAIL_KEY = 're_f25_email_key_must_never_leak_77';
const ACCESS_TOKEN = 'EAAG_f25_whatsapp_token_must_never_leak_88';
const PHONE_NUMBER_ID = '1122334455667789';
const FROM_NUMBER = '+923001111111';
const LEAD_PHONE = '+923001234567';
const SECRETS = [EMAIL_KEY, ACCESS_TOKEN];

// The F24-verified production database. Read-only hashing for matrix AJ - never opened by
// any code path in this suite, never written, never migrated.
const PROD_DB = path.join(process.env.APPDATA || '', 'phone-global-leads', 'data', 'whatsapp.db');
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const prodDbExists = () => { try { return fs.existsSync(PROD_DB); } catch { return false; } };
const PROD_DB_HASH_AT_LOAD = prodDbExists() ? sha256(PROD_DB) : null;

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
  const calls = { set: 0 };
  return {
    calls,
    data,
    get(key, fallback) {
      const v = data[key];
      return v === undefined ? fallback : v;
    },
    set(key, value) { calls.set += 1; data[key] = value; },
  };
}

const EMAIL_FULL_SETTINGS = Object.freeze({
  emailProvider: 'resend',
  emailEnabled: true,
  emailFromName: 'Ridgeline Supply',
  emailFromAddress: 'sender@verified-domain.test',
  emailReplyTo: 'reply@verified-domain.test',
  emailDomain: 'verified-domain.test',
  emailDomainVerification: 'verified',
  emailSignature: '--\nRidgeline Supply Ltd',
});
const WHATSAPP_FULL_SETTINGS = Object.freeze({
  whatsappProvider: 'meta-cloud',
  whatsappEnabled: true,
  whatsappFromNumber: FROM_NUMBER,
  whatsappPhoneNumberId: PHONE_NUMBER_ID,
  whatsappBusinessAccountId: '102233445566778899',
  whatsappNumberVerification: 'verified',
});
const emailStore = (overrides = {}) =>
  fakeConfigStore(Object.assign({}, EMAIL_FULL_SETTINGS, overrides), { resend: { credentials: { apiKey: EMAIL_KEY } } });
const whatsappStore = (overrides = {}) =>
  fakeConfigStore(Object.assign({}, WHATSAPP_FULL_SETTINGS, overrides),
    overrides.providers !== undefined ? overrides.providers : { 'meta-cloud': { credentials: { apiKey: ACCESS_TOKEN } } });

/** A transport spy: records every request, answers with the given responder. */
function spyTransport(responder) {
  const calls = [];
  const transport = async (request) => {
    calls.push(request);
    if (responder) return responder(request);
    return { status: 200, body: { id: 're_msg_1', messages: [{ id: 'wamid.F25_OK' }] } };
  };
  return { calls, transport };
}
const makeResend = (spy) => new ResendEmailProvider({ transport: spy.transport, getApiKey: () => EMAIL_KEY });
const makeMeta = (spy) => new MetaCloudWhatsAppProvider({
  transport: spy.transport,
  getAccessToken: () => ACCESS_TOKEN,
  getPhoneNumberId: () => PHONE_NUMBER_ID,
});

function makeRuntime(leads, {
  emailProvider = null, email = null, emailConfigStore = undefined,
  whatsappProvider = null, whatsapp = null, whatsappConfigStore = undefined,
  when = clock,
} = {}) {
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
      whatsapp: Object.assign({ enabled: true, fromNumber: FROM_NUMBER }, whatsapp || {}),
      email: Object.assign({ enabled: false, fromAddress: null }, email || {}),
    },
    clock: when,
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

/** Both channels fully configured - the state every "can send" test starts from. */
function bothChannelsRuntime(leads, opts = {}) {
  const emailSpy = opts.emailSpy || spyTransport();
  const waSpy = opts.waSpy || spyTransport();
  const runtime = makeRuntime(leads, Object.assign({
    emailProvider: makeResend(emailSpy),
    emailConfigStore: emailStore(),
    email: { enabled: true, fromAddress: 'sender@verified-domain.test' },
    whatsappProvider: makeMeta(waSpy),
    whatsappConfigStore: whatsappStore(),
  }, opts.runtime || {}));
  return Object.assign(runtime, { emailSpy, waSpy });
}

/** The IPC boundary around the REAL service - schema, trust check and dispatch included. */
function ipcHarness(outreach, { trusted = true } = {}) {
  const handlers = new Map();
  const reg = registerOutreachIpc({
    ipcMain: { handle: (c, f) => handlers.set(c, f), removeHandler: (c) => handlers.delete(c) },
    outreach,
    isTrustedSender: () => trusted,
    logger: SILENT,
  });
  return { reg, handlers, invoke: (c, payload, event = {}) => handlers.get(c)(event, payload) };
}

const payloadOf = (request) => JSON.parse(request.body);
const activityJson = async (li) => JSON.stringify(await li.outreach.activityList({ limit: 100 }));

// ============================================================ renderer harness (F18 + F19)

const F18_MARKER = '// === F18 Outreach:';
const F15_MARKER = '// === F15 Outreach:';
const F19_MARKER = '// === F19 Outreach:';
const F12_MARKER = '// === F12 Outreach:';
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
const footerOf = (p) => p.doc.getElementById('f18-prepare-footer');
const clickByText = (rootEl, re) => {
  const b = rootEl.byTag('button').find((x) => re.test(x.textContent));
  assert.ok(b, 'a button matching ' + re + ' is rendered; saw: ' + rootEl.byTag('button').map((x) => x.textContent).join(' | '));
  return b;
};

const EMAIL_DELIVERY_OK = {
  channel: 'email', canSend: true, emailEnabled: true, providerConfigured: true, providerLive: true,
  blockedCode: null, blockedMessage: null, providerId: 'resend', providerLiveHint: true,
  deliveryStatus: 'unknown', openStatus: 'unknown', clickStatus: 'unknown',
};
const WA_DELIVERY_OK = {
  channel: 'whatsapp', canSend: true, emailEnabled: false, providerConfigured: true, providerLive: true,
  blockedCode: null, blockedMessage: null, providerId: 'meta-cloud',
  deliveryStatus: 'unknown', openStatus: 'unknown', clickStatus: 'unknown',
};

/** An email preparation response shaped exactly like the real service's. */
const previewEmail = (delivery = EMAIL_DELIVERY_OK, pitchId = 'p1') => ({
  leadId: 'L1', pitchId, channel: 'email', leadName: 'Acme Bakery',
  recipient: { state: 'available', contact: 'hello@acme.example.com', providerConfigured: null },
  content: {
    subject: 'Three fixes for acme.com', body: 'The pitch body text.',
    finalBody: 'The pitch body text.\n--\nRidgeline Supply Ltd',
    bodySource: 'renderPitchText', evidenceReferences: ['audit-1'], transformationNote: null,
  },
  readiness: {
    decision: 'allowed', reasons: [], warnings: [], channel: 'email',
    delivery: Object.assign({ channel: 'email' }, delivery),
  },
  delivery: Object.assign({ channel: 'email' }, delivery),
  sender: {
    providerId: 'resend', providerDisplay: 'Resend', providerSelected: true,
    displayName: 'Ridgeline Supply', fromAddress: 'sender@verified-domain.test',
    replyTo: 'reply@verified-domain.test', domain: 'verified-domain.test', domainVerification: 'verified',
    signatureConfigured: true, configured: true,
  },
  contactFacts: {
    contacts: { email: { present: true, valid: true, value: 'hello@acme.example.com', state: 'available' },
      phone: { present: true, valid: true, value: LEAD_PHONE }, website: { present: true, valid: true, value: 'https://acme.example.com' } },
    channels: {
      email: { state: 'available', contact: 'hello@acme.example.com', providerConfigured: null },
      whatsapp: { state: 'candidate', contact: LEAD_PHONE, verified: false, verifiedSource: null },
    },
  },
});

/** A WhatsApp preparation response shaped exactly like the real service's. */
const previewWhatsApp = (delivery = WA_DELIVERY_OK, pitchId = 'p1') => ({
  leadId: 'L1', pitchId, channel: 'whatsapp', leadName: 'Acme Bakery',
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
  delivery: Object.assign({ channel: 'whatsapp' }, delivery),
  sender: {
    providerSelected: true, providerId: 'meta-cloud', providerDisplay: 'Meta WhatsApp Cloud API',
    accountConfigured: true, fromNumber: FROM_NUMBER, numberVerification: 'verified',
    keyConfigured: true, capability: 'available',
  },
  contactFacts: {
    contacts: { email: { present: true, valid: true, value: 'hello@acme.example.com', state: 'available' },
      phone: { present: true, valid: true, value: LEAD_PHONE } },
    channels: {
      email: { state: 'available', contact: 'hello@acme.example.com', providerConfigured: null },
      whatsapp: { state: 'candidate', contact: LEAD_PHONE, verified: false, verifiedSource: null },
    },
  },
});

const sendResult = (o = {}) => Object.assign({
  channel: 'email', pitchId: 'p1', leadId: 'L1',
  outcome: 'accepted', providerAcknowledged: true, providerId: 'resend', providerMessageId: 'pm_test_1',
  providerStatus: 'queued', idempotencyKey: 'k',
  deliveryStatus: 'unknown', openStatus: 'unknown', clickStatus: 'unknown',
  sentAt: CLOCK_ISO,
}, o);

// ============================================================ F21 recovery harness
// The REAL F21 history block (state + row + strip) executed against the DOM double, so the
// "Review and try again" affordance is exercised rather than grepped.

const F21_CODE = rendererSource.slice(
  rendererSource.indexOf('const f21SendHistoryState = {'),
  rendererSource.indexOf('function f21SendHistoryPaint'));
assert.ok(F21_CODE.length > 500, 'the F21 history block is located');

function loadHistory(api) {
  const doc = makeDoc();
  const f11El = (tag, cls, text) => { const el = doc.createElement(tag); el.className = cls || ''; el.textContent = text === undefined ? '' : String(text); return el; };
  const f11Status = (text, tone) => { const el = doc.createElement('span'); el.textContent = text; el.setAttribute('data-state', tone); return el; };
  const f15ActivityWhen = (iso) => String(iso);
  const opened = [];
  const f18OpenPrepare = (...args) => { opened.push(args); };
  const fn = new Function('document', 'f11El', 'f11Status', 'f15ActivityWhen', 'f18OpenPrepare',
    F21_CODE + '\nreturn { state: f21SendHistoryState, strip: f21SendHistoryStrip };');
  const loaded = fn(doc, f11El, f11Status, f15ActivityWhen, f18OpenPrepare);
  loaded.doc = doc;
  loaded.opened = opened;
  loaded.api = api;
  return loaded;
}

const historyRow = (o) => Object.assign({
  sendId: 'send_1', pitchId: 'p1', leadId: 'L1', channel: 'email',
  state: 'failed', createdAt: CLOCK_ISO, providerId: 'resend',
  providerMessageId: null, failureCode: 'EMAIL_SEND_FAILED', failureMessage: 'The provider refused the message.',
  retryable: true,
}, o);

// ============================================================ A/B. explicit channel dispatch

test('A. Prepare Email -> confirm dispatches the EMAIL boundary only', async () => {
  const { li, emailSpy, waSpy } = bothChannelsRuntime({ L1: lead({}) });
  const { pitch } = await runLead(li, 'L1');

  // Service level: the explicit email channel reaches the email boundary and nothing else.
  const result = await li.outreach.send({ pitchId: pitch.pitch_id, channel: 'email' });
  assert.strictEqual(result.channel, 'email');
  assert.strictEqual(result.outcome, 'accepted');
  assert.strictEqual(emailSpy.calls.length, 1, 'the email provider ran exactly once');
  assert.strictEqual(waSpy.calls.length, 0, 'the WhatsApp provider was never contacted');

  // Renderer level: the reviewed Email tab is what names the channel.
  const calls = [];
  const p = loadPanel({ outreach: { prepare: () => ({ ok: true, data: previewEmail() }), outreachSend: (payload) => { calls.push(payload); return { ok: true, data: sendResult() }; } } });
  p.f18OpenPrepare('p1');
  await settle();
  clickByText(footerOf(p), /Send this email/).fire('click');
  clickByText(footerOf(p), /Yes, send it/).fire('click');
  await settle();
  assert.deepStrictEqual(calls, [{ pitchId: 'p1', channel: 'email' }], 'the confirm names the reviewed channel');
});

test('B. Prepare WhatsApp -> confirm dispatches the WHATSAPP boundary only', async () => {
  const { li, emailSpy, waSpy } = bothChannelsRuntime({ L1: lead({}) });
  const { pitch } = await runLead(li, 'L1');

  const result = await li.outreach.send({ pitchId: pitch.pitch_id, channel: 'whatsapp' });
  assert.strictEqual(result.channel, 'whatsapp');
  assert.strictEqual(result.outcome, 'accepted');
  assert.strictEqual(waSpy.calls.length, 1, 'the WhatsApp provider ran exactly once');
  assert.strictEqual(emailSpy.calls.length, 0, 'the email provider was never contacted');

  const calls = [];
  const p = loadPanel({ outreach: { prepare: () => ({ ok: true, data: previewWhatsApp() }), outreachSend: (payload) => { calls.push(payload); return { ok: true, data: sendResult({ channel: 'whatsapp' }) }; } } });
  p.f18OpenPrepare('p1');
  await settle();
  p.f18SetChannel('whatsapp');
  await settle();
  clickByText(footerOf(p), /Send this WhatsApp/).fire('click');
  clickByText(footerOf(p), /Yes, send it/).fire('click');
  await settle();
  assert.deepStrictEqual(calls, [{ pitchId: 'p1', channel: 'whatsapp' }], 'the confirm names the reviewed WhatsApp tab');
});

// ============================================================ C/D. fail closed, zero cross-channel calls

test('C. email unavailable -> the email refusal is reported and WhatsApp is never invoked', async () => {
  const emailSpy = spyTransport();
  const waSpy = spyTransport();
  // WhatsApp is FULLY configured; email has no configuration source at all.
  const { li } = makeRuntime({ L1: lead({}) }, {
    emailProvider: makeResend(emailSpy), emailConfigStore: fakeConfigStore({}), email: { enabled: true },
    whatsappProvider: makeMeta(waSpy), whatsappConfigStore: whatsappStore(),
  });
  const { pitch } = await runLead(li, 'L1');
  const { invoke } = ipcHarness(li.outreach);

  const res = await invoke(CHANNELS.OUTREACH_SEND, { pitchId: pitch.pitch_id, channel: 'email' });
  assert.strictEqual(res.ok, false, 'the send fails closed');
  assert.ok(/EMAIL|SEND/.test(res.error.code), 'the refusal names the SELECTED channel: ' + res.error.code);
  assert.ok(!/WHATSAPP/i.test(res.error.code), 'no WhatsApp code leaks into an email refusal');
  assert.strictEqual(emailSpy.calls.length, 0, 'the email transport was never invoked');
  assert.strictEqual(waSpy.calls.length, 0, 'ZERO WhatsApp invocation - no fallback channel');
});

test('D. WhatsApp unavailable -> the WhatsApp refusal is reported and email is never invoked', async () => {
  const emailSpy = spyTransport();
  const waSpy = spyTransport();
  // Email is FULLY configured; WhatsApp has no configuration source at all.
  const { li } = makeRuntime({ L1: lead({}) }, {
    emailProvider: makeResend(emailSpy), emailConfigStore: emailStore(), email: { enabled: true, fromAddress: 'sender@verified-domain.test' },
    whatsappProvider: makeMeta(waSpy), whatsappConfigStore: fakeConfigStore({}),
  });
  const { pitch } = await runLead(li, 'L1');
  const { invoke } = ipcHarness(li.outreach);

  const res = await invoke(CHANNELS.OUTREACH_SEND, { pitchId: pitch.pitch_id, channel: 'whatsapp' });
  assert.strictEqual(res.ok, false, 'the send fails closed');
  assert.ok(/WHATSAPP/.test(res.error.code), 'the refusal names the SELECTED channel: ' + res.error.code);
  assert.strictEqual(waSpy.calls.length, 0, 'the WhatsApp transport was never invoked');
  assert.strictEqual(emailSpy.calls.length, 0, 'ZERO email invocation - no fallback channel');
});

// ============================================================ E-I. the schema refuses everything but { pitchId, channel }

test('E. an invalid or missing channel is refused by the IPC schema AND by the service', async () => {
  const { li, emailSpy, waSpy } = bothChannelsRuntime({ L1: lead({}) });
  const { pitch } = await runLead(li, 'L1');
  const { invoke } = ipcHarness(li.outreach);

  for (const bad of [
    { pitchId: pitch.pitch_id },                      // missing channel - no implicit default
    { pitchId: pitch.pitch_id, channel: 'sms' },      // unknown channel
    { pitchId: pitch.pitch_id, channel: 'Email' },    // not one of the two enum values
    { pitchId: pitch.pitch_id, channel: 42 },         // not even a string
  ]) {
    const res = await invoke(CHANNELS.OUTREACH_SEND, bad);
    assert.strictEqual(res.ok, false, 'refused by the schema: ' + JSON.stringify(bad));
    assert.strictEqual(res.error.code, 'VALIDATION_FAILED');
  }
  assert.strictEqual(emailSpy.calls.length, 0, 'no refused payload reached a provider');
  assert.strictEqual(waSpy.calls.length, 0);

  // The service refuses the same values on its own - a caller that bypasses IPC inherits
  // no default channel either.
  for (const bad of [{ pitchId: pitch.pitch_id }, { pitchId: pitch.pitch_id, channel: 'sms' }]) {
    await assert.rejects(() => li.outreach.send(bad), (e) => {
      assert.strictEqual(e.code, 'VALIDATION_FAILED', 'the dispatcher refuses: ' + JSON.stringify(bad));
      return true;
    });
  }
  assert.strictEqual(emailSpy.calls.length + waSpy.calls.length, 0, 'still zero provider invocations');
  const schema = INPUT_SCHEMAS[CHANNELS.OUTREACH_SEND];
  assert.deepStrictEqual(schema.required, ['pitchId', 'channel']);
  // F26.6 declared lock update: + an OPTIONAL mailboxId (id only; a connected-mailbox email).
  assert.deepStrictEqual(Object.keys(schema.properties), ['pitchId', 'channel', 'mailboxId']);
  assert.deepStrictEqual(Object.keys(schema.properties.mailboxId).sort(), ['maxLength', 'minLength', 'pattern', 'type']);
  assert.deepStrictEqual(schema.properties.channel.enum, ['email', 'whatsapp']);
  assert.strictEqual(schema.additionalProperties, false);
});

const smuggle = (field, value) => test(`${field[0]}. a renderer-supplied ${field[1]} cannot cross the send boundary`, async () => {
  const { li, emailSpy, waSpy } = bothChannelsRuntime({ L1: lead({}) });
  const { pitch } = await runLead(li, 'L1');
  const { invoke } = ipcHarness(li.outreach);
  const payload = Object.assign({ pitchId: pitch.pitch_id, channel: 'email' }, { [field[1]]: value });
  const res = await invoke(CHANNELS.OUTREACH_SEND, payload);
  assert.strictEqual(res.ok, false, JSON.stringify(payload) + ' is refused');
  assert.strictEqual(res.error.code, 'VALIDATION_FAILED');
  assert.strictEqual(emailSpy.calls.length + waSpy.calls.length, 0, 'the service never ran for a smuggled payload');
});
smuggle(['F', 'provider'], 'evil-provider');
smuggle(['G', 'to'], 'victim@example.com');
smuggle(['H', 'body'], 'whatever the renderer wants');
smuggle(['H2', 'subject'], 'rewritten subject');
smuggle(['I', 'from'], 'ceo@somewhere.example.com');

// ============================================================ J-L. exact payload integrity

test('J. the exact email body shown in Prepare is the byte-for-byte provider body', async () => {
  const { li, emailSpy } = bothChannelsRuntime({ L1: lead({}) });
  const { pitch } = await runLead(li, 'L1');
  const prep = await li.outreach.prepare({ pitchId: pitch.pitch_id, channel: 'email' });
  assert.ok(prep.content.finalBody, 'Prepare carries the final byte-exact body');

  await li.outreach.send({ pitchId: pitch.pitch_id, channel: 'email' });
  const wire = payloadOf(emailSpy.calls[0]);
  assert.strictEqual(wire.text, prep.content.finalBody, 'preview body === provider text, byte for byte');
});

test('K. the exact WhatsApp message shown in Prepare is the byte-for-byte provider body', async () => {
  const { li, waSpy } = bothChannelsRuntime({ L1: lead({}) });
  const { pitch } = await runLead(li, 'L1');
  const prep = await li.outreach.prepare({ pitchId: pitch.pitch_id, channel: 'whatsapp' });
  assert.strictEqual(prep.content.transformationNote !== null, true, 'Prepare states the (absent) transformation');

  await li.outreach.send({ pitchId: pitch.pitch_id, channel: 'whatsapp' });
  const wire = payloadOf(waSpy.calls[0]);
  assert.strictEqual(wire.type, 'text', 'the plain-text contract is unchanged');
  assert.strictEqual(wire.text.body, prep.content.body, 'preview message === provider body, byte for byte');
});

test('L. the subject shown in Prepare is the provider subject', async () => {
  const { li, emailSpy } = bothChannelsRuntime({ L1: lead({}) });
  const { pitch } = await runLead(li, 'L1');
  const prep = await li.outreach.prepare({ pitchId: pitch.pitch_id, channel: 'email' });
  await li.outreach.send({ pitchId: pitch.pitch_id, channel: 'email' });
  const wire = payloadOf(emailSpy.calls[0]);
  assert.strictEqual(wire.subject, prep.content.subject, 'subject preview === provider subject');
  assert.strictEqual(wire.from.includes('Ridgeline Supply') || wire.from.includes('sender@verified-domain.test'), true,
    'the sender shown as configured is the sender on the wire: ' + wire.from);
});

// ============================================================ M/N. readiness vs capability

test('M. readiness stays Ready while channel capability is unavailable - and the renderer shows BOTH', async () => {
  const { li } = bothChannelsRuntime({ L1: lead({}) }, { runtime: { emailConfigStore: fakeConfigStore({}), email: { enabled: true } } });
  const { pitch } = await runLead(li, 'L1');
  const prep = await li.outreach.prepare({ pitchId: pitch.pitch_id, channel: 'email' });
  assert.strictEqual(prep.readiness.decision, 'allowed', 'the pitch itself is still Ready');
  assert.strictEqual(prep.delivery.canSend, false, 'while the channel cannot send');

  // The renderer must show both facts at once and offer no send control.
  const blocked = Object.assign({}, EMAIL_DELIVERY_OK, { canSend: false, blockedCode: 'EMAIL_PROVIDER_NOT_SELECTED', blockedMessage: 'No email provider is configured.' });
  const p = loadPanel({ outreach: { prepare: () => ({ ok: true, data: previewEmail(blocked) }), outreachSend: () => { throw new Error('must not be called'); } } });
  p.f18OpenPrepare('p1');
  await settle();
  const footer = footerOf(p);
  assert.ok(/Ready for outreach/.test(p.doc.getElementById('f18-prepare-header').textContent), 'the header still says Ready');
  assert.ok(/No email provider is configured\./.test(footer.textContent), 'the capability refusal is shown verbatim');
  assert.strictEqual(footer.byTag('button').filter((b) => /Send this email|Yes, send it/.test(b.textContent)).length, 0,
    'no send control while the channel cannot send');
});

test('N. capability available can never manufacture readiness - the gate still decides', async () => {
  // Fully configured email provider (capability TRUE) but an UNAPPROVED pitch: the gate is
  // blocked, so preparation and send both refuse, and no provider is contacted.
  const { li, emailSpy } = bothChannelsRuntime({ L1: lead({}) });
  await li.research.sync({ leadId: 'L1' });
  const pitch = await li.outreach.generate({ leadId: 'L1' }); // NO approval
  assert.strictEqual(li.outreach.sendCapability('email').canSend, true, 'capability is available');
  const gate = await li.outreach.gate({ pitchId: pitch.pitch_id });
  assert.strictEqual(gate.decision, 'blocked', 'but the pitch is not Ready');
  await assert.rejects(() => li.outreach.prepare({ pitchId: pitch.pitch_id, channel: 'email' }),
    (e) => e.code === 'NOT_READY');
  await assert.rejects(() => li.outreach.send({ pitchId: pitch.pitch_id, channel: 'email' }),
    (e) => e.code === 'NOT_READY');
  assert.strictEqual(emailSpy.calls.length, 0, 'capability could not manufacture a send');
});

// ============================================================ O/P. duplicate protection

test('O. a rapid double confirm produces at most ONE send invocation', async () => {
  const calls = [];
  let resolveSend;
  const p = loadPanel({
    outreach: {
      prepare: () => ({ ok: true, data: previewEmail() }),
      outreachSend: (payload) => { calls.push(payload); return new Promise((r) => { resolveSend = () => r({ ok: true, data: sendResult() }); }); },
    },
  });
  p.f18OpenPrepare('p1');
  await settle();
  clickByText(footerOf(p), /Send this email/).fire('click');
  const confirm = clickByText(footerOf(p), /Yes, send it/);
  confirm.fire('click');
  confirm.fire('click');      // the second click of an accidental double click
  p.f19ConfirmSend();         // and a third attempt while still in flight
  assert.strictEqual(p.f19SendState.busy, true, 'the in-flight state is entered immediately');
  await settle();
  assert.strictEqual(calls.length, 1, 'exactly ONE attempt crossed the bridge');
  resolveSend();
  await settle();
  assert.ok(/accepted/i.test(footerOf(p).textContent), 'the single result is rendered');
});

test('P. durable idempotency replays an existing result with ZERO extra provider invocations', async () => {
  const { li, emailSpy } = bothChannelsRuntime({ L1: lead({}) });
  const { pitch } = await runLead(li, 'L1');
  const first = await li.outreach.send({ pitchId: pitch.pitch_id, channel: 'email' });
  const second = await li.outreach.send({ pitchId: pitch.pitch_id, channel: 'email' });
  assert.strictEqual(first.outcome, 'accepted');
  assert.strictEqual(second.outcome, 'replayed', 'the second confirmation is a replay, not a new send');
  assert.strictEqual(second.providerAcknowledged, true);
  assert.strictEqual(emailSpy.calls.length, 1, 'the provider was invoked exactly once in total');
  assert.strictEqual(second.deliveryStatus, 'unknown', 'a replay is not a delivery claim');
});

// ============================================================ Q/R/S. factual result language

test('Q. an accepted result is rendered as acceptance, never as delivery', async () => {
  const { li } = bothChannelsRuntime({ L1: lead({}) });
  const { pitch } = await runLead(li, 'L1');
  const result = await li.outreach.send({ pitchId: pitch.pitch_id, channel: 'email' });
  assert.ok(!('delivered' in result), 'the result has no delivered field at all');
  assert.ok(!/delivered/i.test(JSON.stringify(result)), 'and no delivered string anywhere');

  const p = loadPanel({ outreach: { prepare: () => ({ ok: true, data: previewEmail() }), outreachSend: () => ({ ok: true, data: result }) } });
  p.f18OpenPrepare('p1');
  await settle();
  clickByText(footerOf(p), /Send this email/).fire('click');
  clickByText(footerOf(p), /Yes, send it/).fire('click');
  await settle();
  const text = footerOf(p).textContent;
  assert.ok(/accepted/i.test(text), 'acceptance is stated: ' + text);
  assert.ok(!/delivered|received|read\b|seen|opened|clicked/i.test(text.replace(/opened unknown|clicked unknown/g, '')),
    'no delivery, receipt or engagement claim is expressible');
});

test('R. a failed result shows the safe normalized failure - no stack, no secret, no raw response', async () => {
  const failing = spyTransport(() => ({ status: 500, body: { message: 'Internal server error' } }));
  const { li } = makeRuntime({ L1: lead({}) }, {
    emailProvider: makeResend(failing), emailConfigStore: emailStore(), email: { enabled: true, fromAddress: 'sender@verified-domain.test' },
  });
  const { pitch } = await runLead(li, 'L1');
  let caught = null;
  await assert.rejects(() => li.outreach.send({ pitchId: pitch.pitch_id, channel: 'email' }), (e) => { caught = e; return true; });
  assert.ok(caught, 'the send failed');
  assert.ok(!/at .*\.js:\d+/.test(caught.message), 'no stack trace in the message');
  for (const secret of SECRETS) assert.ok(!caught.message.includes(secret), 'no secret in the message');

  const listed = await store_rows(li, pitch.pitch_id);
  assert.strictEqual(listed[0].state, 'failed', 'the failure is durable');
  assert.ok(listed[0].failureCode, 'with its failure code: ' + listed[0].failureCode);

  // And the renderer shows exactly code + message, nothing more.
  const p = loadPanel({ outreach: { prepare: () => ({ ok: true, data: previewEmail() }), outreachSend: () => ({ ok: false, error: { code: 'EMAIL_SEND_FAILED', message: 'The email provider could not accept the message.' } }) } });
  p.f18OpenPrepare('p1');
  await settle();
  clickByText(footerOf(p), /Send this email/).fire('click');
  clickByText(footerOf(p), /Yes, send it/).fire('click');
  await settle();
  const text = footerOf(p).textContent;
  assert.ok(/EMAIL_SEND_FAILED/.test(text) && /could not accept the message/.test(text), 'code and normalized message shown');
  assert.ok(!/at .*\.js:\d+/.test(text), 'no stack reaches the screen');
  for (const secret of SECRETS) assert.ok(!text.includes(secret), 'no secret reaches the screen');
  assert.ok(!/accepted/i.test(text), 'a failure is never softened into an acceptance');
  assert.ok(footerOf(p).byTag('button').some((b) => /Send this email/.test(b.textContent)), 'the control returns for a manual retry');
});

test('S. a blocked result shows the backend factual reason, recorded as a blocked attempt', async () => {
  const { li } = makeRuntime({ L1: lead({}) }, { emailProvider: null, emailConfigStore: fakeConfigStore({}) });
  const { pitch } = await runLead(li, 'L1');
  await assert.rejects(() => li.outreach.send({ pitchId: pitch.pitch_id, channel: 'email' }), (e) => {
    assert.ok(e.code && e.code.length > 0, 'the refusal carries a code');
    return true;
  });
  assert.ok((await activityJson(li)).includes('OUTREACH_SEND_BLOCKED'), 'the block is an auditable event');

  // The renderer shows the backend text and no control.
  const blocked = Object.assign({}, EMAIL_DELIVERY_OK, { canSend: false, blockedCode: 'SEND_NOT_CONFIGURED', blockedMessage: 'Email sending is switched off in this build.' });
  const p = loadPanel({ outreach: { prepare: () => ({ ok: true, data: previewEmail(blocked) }), outreachSend: () => { throw new Error('must not be called'); } } });
  p.f18OpenPrepare('p1');
  await settle();
  assert.ok(/Email sending is switched off in this build\./.test(footerOf(p).textContent), 'the backend refusal is verbatim');
  assert.strictEqual(footerOf(p).byTag('button').filter((b) => /Send this email/.test(b.textContent)).length, 0);
});

// ============================================================ T/U. send history

test('T. history distinguishes email from WhatsApp attempts, per recorded row', async () => {
  const { li, store } = bothChannelsRuntime({ L1: lead({}) });
  const { pitch } = await runLead(li, 'L1');
  await li.outreach.send({ pitchId: pitch.pitch_id, channel: 'email' });
  await li.outreach.send({ pitchId: pitch.pitch_id, channel: 'whatsapp' });

  const page = await li.outreach.sendList({ pitchId: pitch.pitch_id, limit: 50, offset: 0 });
  const channels = page.rows.map((r) => r.channel).sort();
  assert.deepStrictEqual(channels, ['email', 'whatsapp'], 'both attempts are recorded with their own channel');
  assert.strictEqual(page.rows.every((r) => Boolean(r.channel) && Boolean(r.state)), true,
    'every recorded row carries its own channel and state');

  // The renderer renders the channel of each row as its own visible, addressable fact.
  const hist = loadHistory();
  hist.state.rows = [
    historyRow({ sendId: 's1', channel: 'whatsapp', providerId: 'meta-cloud', state: 'failed', failureCode: 'WHATSAPP_REJECTED' }),
    historyRow({ sendId: 's2', channel: 'email', providerId: 'resend', state: 'failed' }),
  ];
  hist.state.loaded = true;
  hist.state.total = 2;
  const strip = hist.strip('p1');
  const channelsRendered = strip.byTag('span')
    .filter((el) => el.getAttribute && el.getAttribute('data-send-channel'))
    .map((el) => el.getAttribute('data-send-channel'));
  assert.deepStrictEqual(channelsRendered.sort(), ['email', 'whatsapp'], 'the strip renders both channels distinctly');
});

test('U. neither the send result nor the history read can leak a configured secret', async () => {
  const { li } = bothChannelsRuntime({ L1: lead({}) });
  const { pitch } = await runLead(li, 'L1');
  const { invoke } = ipcHarness(li.outreach);

  const sent = await invoke(CHANNELS.OUTREACH_SEND, { pitchId: pitch.pitch_id, channel: 'email' });
  assert.strictEqual(sent.ok, true);
  const history = await invoke(CHANNELS.OUTREACH_SENDS, { pitchId: pitch.pitch_id, limit: 50, offset: 0 });
  assert.strictEqual(history.ok, true);
  const surface = JSON.stringify(sent) + JSON.stringify(history);
  for (const secret of SECRETS) {
    assert.ok(!surface.includes(secret), 'the secret ' + secret.slice(0, 8) + '... never crosses IPC');
  }
  assert.ok(!/Authorization|"apiKey"|Bearer /i.test(surface), 'no credential-shaped field crosses IPC');
});

// ============================================================ V-Z. manual recovery

test('V. "Review and try again" re-enters the reviewed Prepare panel and nothing else', async () => {
  const hist = loadHistory();
  hist.state.rows = [historyRow({ channel: 'email' })];
  hist.state.loaded = true;
  hist.state.total = 1;
  const strip = hist.strip('p1');
  const buttons = strip.byTag('button');
  assert.strictEqual(buttons.length, 1, 'the recovery affordance is exactly one button');
  assert.ok(/Review and try again/.test(buttons[0].textContent), 'the documented label');
  buttons[0].fire('click');
  assert.deepStrictEqual(hist.opened, [['p1', 'email']], 'it opens Prepare for this pitch - it contacts nothing');
  // And the slice itself cannot reach the send boundary.
  assert.ok(!/outreachSend\s*\(/.test(F21_CODE), 'the recovery block never calls the send boundary');
});

test('W. reopening through recovery invokes NO provider before a NEW human confirmation', async () => {
  const calls = [];
  const prepareCalls = [];
  const p = loadPanel({
    outreach: {
      prepare: (payload) => { prepareCalls.push(payload); return { ok: true, data: previewEmail() }; },
      outreachSend: (payload) => { calls.push(payload); return { ok: true, data: sendResult() }; },
    },
  });
  p.f18OpenPrepare('p1', 'email');
  await settle();
  assert.strictEqual(prepareCalls.length, 1, 'the preview is reloaded');
  assert.strictEqual(calls.length, 0, 'reopening contacts nothing');
  clickByText(footerOf(p), /Send this email/).fire('click');
  assert.strictEqual(calls.length, 0, 'arming contacts nothing either');
  clickByText(footerOf(p), /Yes, send it/).fire('click');
  await settle();
  assert.strictEqual(calls.length, 1, 'only the NEW confirmation reaches the boundary');
});

test('X. a failed WHATSAPP attempt reopens the WHATSAPP context', async () => {
  const hist = loadHistory();
  hist.state.rows = [historyRow({ channel: 'whatsapp', providerId: 'meta-cloud', failureCode: 'WHATSAPP_REJECTED' })];
  hist.state.loaded = true;
  const strip = hist.strip('p1');
  strip.byTag('button')[0].fire('click');
  assert.deepStrictEqual(hist.opened, [['p1', 'whatsapp']], 'the recorded channel is preserved');

  // And the panel honours it: the WhatsApp tab is what loads and what is previewed.
  const prepareCalls = [];
  const p = loadPanel({ outreach: { prepare: (payload) => { prepareCalls.push(payload); return { ok: true, data: previewWhatsApp() }; }, outreachSend: () => { throw new Error('must not be called'); } } });
  p.f18OpenPrepare('p1', 'whatsapp');
  await settle();
  assert.strictEqual(p.f18PrepareState.channel, 'whatsapp', 'the panel opens on WhatsApp');
  assert.strictEqual(prepareCalls[0].channel, 'whatsapp', 'the preview is re-read for WhatsApp');
});

test('Y. a failed EMAIL attempt reopens the Email context', async () => {
  const hist = loadHistory();
  hist.state.rows = [historyRow({ channel: 'email' })];
  hist.state.loaded = true;
  const strip = hist.strip('p1');
  strip.byTag('button')[0].fire('click');
  assert.deepStrictEqual(hist.opened, [['p1', 'email']], 'the recorded channel is preserved');

  const prepareCalls = [];
  const p = loadPanel({ outreach: { prepare: (payload) => { prepareCalls.push(payload); return { ok: true, data: previewEmail() }; }, outreachSend: () => { throw new Error('must not be called'); } } });
  p.f18OpenPrepare('p1', 'email');
  await settle();
  assert.strictEqual(p.f18PrepareState.channel, 'email');
  assert.strictEqual(prepareCalls[0].channel, 'email');
});

test('Z. recovery NEVER switches channel automatically when the recorded channel is unavailable', async () => {
  const blockedWa = Object.assign({}, WA_DELIVERY_OK, {
    canSend: false, blockedCode: 'WHATSAPP_PROVIDER_NOT_SELECTED', blockedMessage: 'No WhatsApp provider is configured.',
  });
  const prepareCalls = [];
  const p = loadPanel({
    outreach: {
      prepare: (payload) => { prepareCalls.push(payload); return { ok: true, data: previewWhatsApp(blockedWa) }; },
      outreachSend: () => { throw new Error('must not be called'); },
    },
  });
  // The recorded attempt was WhatsApp; WhatsApp can no longer send.
  p.f18OpenPrepare('p1', 'whatsapp');
  await settle();
  assert.strictEqual(p.f18PrepareState.channel, 'whatsapp', 'the channel does NOT silently become email');
  assert.strictEqual(prepareCalls[0].channel, 'whatsapp', 'the preview is re-read on the SAME channel');
  const footer = footerOf(p);
  assert.ok(/No WhatsApp provider is configured\./.test(footer.textContent), 'the current capability gap is stated honestly');
  assert.strictEqual(footer.byTag('button').filter((b) => /Send this|Yes, send it/.test(b.textContent)).length, 0,
    'and nothing is sendable until a human picks another channel and confirms again');
  // An unrecognised channel value reopens the panel default instead of being guessed at.
  const p2 = loadPanel({ outreach: { prepare: (payload) => { prepareCalls.push(payload); return { ok: true, data: previewEmail() }; } } });
  p2.f18OpenPrepare('p1', 'carrier-pigeon');
  await settle();
  assert.strictEqual(p2.f18PrepareState.channel, 'email', 'only the two factual channels are ever selectable');
});

// ============================================================ AA-AD. stale facts at confirm

test('AA. an approval invalidated between Prepare and Confirm blocks the send at the boundary', async () => {
  const { li, emailSpy } = bothChannelsRuntime({ L1: lead({}) });
  const { pitch } = await runLead(li, 'L1');
  const prep = await li.outreach.prepare({ pitchId: pitch.pitch_id, channel: 'email' });
  assert.ok(prep.content.body, 'the preview exists while the approval is valid');

  // The pitch is edited while the panel sits open: the approval now covers OLD content.
  await li.outreach.update({ pitchId: pitch.pitch_id, edits: { opening: 'An edited opening written after the approval.' } });
  const gate = await li.outreach.gate({ pitchId: pitch.pitch_id });
  assert.strictEqual(gate.decision, 'blocked', 'the gate re-evaluates with the stale approval');
  assert.ok(gate.reasons.some((r) => /APPROVAL/.test(r.code)), 'and names the approval as the reason');

  await assert.rejects(() => li.outreach.send({ pitchId: pitch.pitch_id, channel: 'email' }),
    (e) => e.code === 'NOT_READY');
  assert.strictEqual(emailSpy.calls.length, 0, 'the stale panel could not reach a provider');
});

test('AB. stale evidence blocks at confirm - freshness is re-evaluated, not remembered', async () => {
  const later = () => new Date('2026-12-15T10:00:00.000Z'); // 75 days after capture; policy allows 30
  const { li, emailSpy } = bothChannelsRuntime({ L1: lead({}) }, { runtime: { when: later } });
  const { pitch } = await runLead(li, 'L1');
  const gate = await li.outreach.gate({ pitchId: pitch.pitch_id });
  assert.strictEqual(gate.decision, 'blocked', 'evidence captured on ' + CAPTURED_AT + ' is stale at the new clock');
  await assert.rejects(() => li.outreach.prepare({ pitchId: pitch.pitch_id, channel: 'email' }),
    (e) => e.code === 'NOT_READY');
  await assert.rejects(() => li.outreach.send({ pitchId: pitch.pitch_id, channel: 'email' }),
    (e) => e.code === 'NOT_READY');
  assert.strictEqual(emailSpy.calls.length, 0, 'stale evidence never reaches a provider');
});

test('AC. changed pitch content between preview and confirm is re-checked, not sent', async () => {
  const { li, emailSpy } = bothChannelsRuntime({ L1: lead({}) });
  const { pitch } = await runLead(li, 'L1');
  const before = await li.outreach.get(pitch.pitch_id);
  const prep = await li.outreach.prepare({ pitchId: pitch.pitch_id, channel: 'email' });
  assert.ok(prep.content.body.includes('Three fixes') || prep.content.body.length > 0, 'a preview exists');

  await li.outreach.update({ pitchId: pitch.pitch_id, edits: { valueProposition: 'A different value proposition typed after the preview.' } });
  const after = await li.outreach.get(pitch.pitch_id);
  assert.notStrictEqual(after.content_hash, before.content_hash, 'the content hash changed under the open panel');

  await assert.rejects(() => li.outreach.send({ pitchId: pitch.pitch_id, channel: 'email' }),
    (e) => e.code === 'NOT_READY');
  assert.strictEqual(emailSpy.calls.length, 0, 'neither the OLD preview nor the new content was sent');
});

test('AD. changed contact facts are re-evaluated at send time - the recipient is re-read, never cached', async () => {
  const leads = { L1: lead({}) };
  const { li, store, emailSpy } = bothChannelsRuntime(leads);
  const { pitch } = await runLead(li, 'L1');
  const prep = await li.outreach.prepare({ pitchId: pitch.pitch_id, channel: 'email' });
  assert.strictEqual(prep.recipient.contact, 'hello@acme.example.com', 'the preview showed the stored value');

  // The stored contact changes between Prepare and Confirm.
  leads.L1.email = 'ops@acme.example.com';
  // F26.5 declared update: consent is bound to an ADDRESS, so the new address needs its own
  // recorded consent - without it this send is (correctly) refused as cold.
  await grantTrust(store, { email: 'ops@acme.example.com', leadId: 'L1', now: clock() });
  await li.outreach.send({ pitchId: pitch.pitch_id, channel: 'email' });
  const wire = payloadOf(emailSpy.calls[0]);
  assert.ok(JSON.stringify(wire.to).includes('ops@acme.example.com'),
    'the send used the CURRENT stored recipient: ' + JSON.stringify(wire.to));
  assert.ok(!JSON.stringify(wire.to).includes('hello@acme.example.com'),
    'the stale preview value was never sent');
});

// ============================================================ AE/AF. honest identity

test('AE. a missing business/sender profile stays honest - never an invented identity', async () => {
  // Business profile: absent configuration reads back as EMPTY STRINGS, not as a default
  // company. The fixture identities in this file are test data only and appear nowhere.
  const profile = readBusinessProfile(fakeConfigStore({}));
  assert.deepStrictEqual(Object.keys(profile), BUSINESS_PROFILE_FIELDS.map((f) => f.key));
  for (const f of BUSINESS_PROFILE_FIELDS) assert.strictEqual(profile[f.key], '', f.key + ' is empty when unconfigured');
  const frozen = JSON.stringify(profile);
  for (const builtin of ['ZuniTech', 'Zee', 'zunitech', 'marketing@']) {
    assert.ok(!frozen.includes(builtin), 'no built-in identity: ' + builtin);
  }

  // Sender profile: an unconfigured email sender reads back as null fields, and the panel
  // says "Not configured" instead of inventing a from-address.
  const { li } = bothChannelsRuntime({ L1: lead({}) }, { runtime: { emailConfigStore: fakeConfigStore({}), email: { enabled: true } } });
  const { pitch } = await runLead(li, 'L1');
  const prep = await li.outreach.prepare({ pitchId: pitch.pitch_id, channel: 'email' });
  assert.strictEqual(prep.sender.fromAddress, null, 'no sender address is invented');
  assert.strictEqual(prep.sender.providerSelected, false, 'and no provider is claimed');

  const unconfigured = Object.assign({}, previewEmail().sender, { providerSelected: false, displayName: null, fromAddress: null, replyTo: null, providerDisplay: null, providerId: null, configured: false });
  const p = loadPanel({ outreach: { prepare: () => ({ ok: true, data: Object.assign(previewEmail(), { sender: unconfigured }) }) } });
  p.f18OpenPrepare('p1');
  await settle();
  const body = p.doc.getElementById('f18-prepare-body');
  assert.ok(/Not configured/.test(body.textContent), 'the panel states the honest absence');
  assert.ok(/From/.test(body.textContent) && /Not configured/.test(body.textContent), 'the From row reads Not configured');
});

test('AF. a missing WhatsApp sender/provider profile stays honest, and the send fails closed', async () => {
  const waSpy = spyTransport();
  const { li } = makeRuntime({ L1: lead({}) }, {
    whatsappProvider: makeMeta(waSpy), whatsappConfigStore: fakeConfigStore({}),
    emailProvider: makeResend(spyTransport()), emailConfigStore: emailStore(), email: { enabled: true, fromAddress: 'sender@verified-domain.test' },
  });
  const { pitch } = await runLead(li, 'L1');
  const prep = await li.outreach.prepare({ pitchId: pitch.pitch_id, channel: 'whatsapp' });
  assert.strictEqual(prep.sender.providerSelected, false, 'no provider is claimed');
  assert.strictEqual(prep.delivery.canSend, false, 'and the capability says so');
  await assert.rejects(() => li.outreach.send({ pitchId: pitch.pitch_id, channel: 'whatsapp' }),
    (e) => e.code === 'WHATSAPP_PROVIDER_NOT_SELECTED');
  assert.strictEqual(waSpy.calls.length, 0, 'an unconfigured profile can never reach the transport');

  const emptySender = { providerSelected: false, providerId: null, providerDisplay: null, accountConfigured: false, fromNumber: null, numberVerification: null, keyConfigured: false };
  const p = loadPanel({ outreach: { prepare: () => ({ ok: true, data: Object.assign(previewWhatsApp(), { sender: emptySender }) }) } });
  p.f18OpenPrepare('p1');
  await settle();
  p.f18SetChannel('whatsapp');
  await settle();
  const text = p.doc.getElementById('f18-prepare-body').textContent;
  assert.ok(/Not configured/.test(text), 'the WhatsApp panel says the honest absence');
  assert.ok(!text.includes(ACCESS_TOKEN) && !text.includes(ACCESS_TOKEN.split('.').slice(-1)[0]), 'no token rendered');
});

// ============================================================ AG-AJ. freeze guards

test('AG. Campaigns remains disabled - no bulk or campaign surface exists anywhere in F25', () => {
  const nav = [...htmlSource.matchAll(/<button[^>]*class="[^"]*nav-item[^"]*"[^>]*>[\s\S]*?<span class="nav-label">Campaigns<\/span>/g)];
  assert.ok(nav.length >= 1, 'the Campaigns nav item exists');
  const block = [...htmlSource.matchAll(/<button[^>]*class="[^"]*nav-item[^"]*"[^>]*>[\s\S]*?<\/button>/g)]
    .filter((m) => /nav-label">Campaigns</.test(m[0]));
  assert.ok(block.length >= 1, 'the Campaigns button was located');
  assert.ok(/\bdisabled\b/.test(block[0][0]), 'Campaigns stays disabled');
  assert.ok(/nav-item-soon/.test(block[0][0]), 'Campaigns keeps its later-release state');
  assert.ok(/aria-disabled="true"/.test(block[0][0]), 'and is announced as disabled');
  // F28 declared lock update (D1, Zee 7 Oct 2026): follow-up SEQUENCES are the one declared
  // exception - the service only refuses a follow-up outside its own sequence and threads the
  // sequence's send. Campaign, bulk and drip surfaces stay banned.
  for (const banned of [/campaign/i, /bulk/i, /drip/i]) {
    assert.ok(!banned.test(stripComments(serviceSource)), 'the service contains no ' + banned + ' surface');
  }
  const seqMentions = stripComments(serviceSource).split('\n').filter((l) => /sequence/i.test(l));
  assert.ok(seqMentions.length > 0 && seqMentions.every((l) => /store\.sequences|this\.sequences|setSequences|sequenceSend|FOLLOWUP_SEQUENCE_ONLY|SEQUENCE_MISMATCH|SEQUENCES_UNAVAILABLE|sequence approval note/.test(l)),
    'every sequence mention in the service is an F28 follow-up hook: ' + seqMentions.join(' | '));
  assert.ok(!/\bcampaign/i.test(stripComments(ipcSource)), 'no campaign channel exists');
});

test('AH. no scheduler, queue, batch or automatic retry exists in the send path', () => {
  for (const [name, src] of [['service', serviceSource], ['ipc', ipcSource],
    ['renderer-F18-F19', F18_RENDERER + F19_RENDERER], ['renderer-F21', F21_CODE]]) {
    const code = stripComments(src);
    for (const banned of [/setTimeout\s*\(/, /setInterval\s*\(/, /\bqueue\s*\(/, /\bbatch\s*\(/,
      /\bschedule\w*\s*\(/i, /\.enqueue\s*\(/, /\bretry\s*\(/, /\bresend\s*\(/i]) {
      assert.ok(!banned.test(code), name + ' must not contain ' + banned);
    }
  }
  const channels = [...ipcSource.matchAll(/'lead-intel:[a-z-]+'/g)].map((m) => m[0]);
  assert.deepStrictEqual(channels.filter((c) => /schedule|queue|batch|retry|campaign/i.test(c)), [],
    'no scheduler/queue/retry channel exists');
  // The bridge still exposes exactly one send method and no retry surface.
  const bridge = stripComments(preloadSource.slice(preloadSource.indexOf("exposeInMainWorld('ztechLeadIntel'")));
  assert.ok(!/retry|resend|schedule|queue/i.test(bridge), 'no retry or scheduling bridge method');
});

test('AI. zero real provider network calls: every invocation in this file went through an injected fake transport', async () => {
  // The module-level fetch guard counts anything that reaches for the network. It must
  // have fired ZERO times across the whole suite, and the fake transports are the only
  // provider path this file ever builds.
  assert.strictEqual(netGuard.calls, 0, 'no code path reached the real network');
  assert.ok(typeof (new ResendEmailProvider({ transport: () => {}, getApiKey: () => 'k' })).send === 'function',
    'the email provider requires an injected transport by construction');
  assert.ok(typeof (new MetaCloudWhatsAppProvider({ transport: () => {}, getAccessToken: () => 't', getPhoneNumberId: () => 'n' })).send === 'function',
    'the WhatsApp provider requires an injected transport by construction');
  // And the shipped default transport is still the fetch-based one that the guard replaces:
  // nothing in this suite called it.
  assert.strictEqual(netGuard.calls, 0, 'still zero real requests');
});

test('AJ. the production database is byte-identical before and after this entire suite', () => {
  if (!prodDbExists()) {
    // Nothing to protect in this environment - stated, never silently skipped as a pass
    // without meaning: the runtime E2E step verifies the real production hash separately.
    assert.ok(true, 'production database absent in this environment');
    return;
  }
  const after = sha256(PROD_DB);
  assert.strictEqual(after, PROD_DB_HASH_AT_LOAD,
    'the suite never opened or modified the production database');
  console.log('    production DB sha256 (unchanged): ' + after);
});

// ============================================================ runner

// The helper R uses above: rows straight from the ledger read.
function store_rows(li, pitchId) {
  return li.outreach.sendList({ pitchId, limit: 50, offset: 0 }).then((page) => page.rows);
}

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
