'use strict';

// F26.5 shared test harness (not a test file). Real createLeadIntelligence, real OutreachService,
// real TrustService, real MemoryStore, REAL Resend / Meta adapters with spy transports.

const path = require('path');
const root = path.join(__dirname, '..');
const LI = path.join(root, 'src', 'main', 'lead-intelligence');
const { MemoryStore } = require(path.join(LI, 'persistence', 'MemoryStore.js'));
const { ResendEmailProvider } = require(path.join(LI, 'outreach', 'email', 'ResendEmailProvider.js'));
const { MetaCloudWhatsAppProvider } = require(path.join(LI, 'outreach', 'whatsapp', 'MetaCloudWhatsAppProvider.js'));
const { createLeadIntelligence } = require(path.join(LI, 'index.js'));
const { round1PacketMapper } = require(path.join(LI, 'round1PacketMapper.js'));
const { round1Record, zuniV1Packet } = require(path.join(root, 'tests', 'lead-intelligence', 'fixtures', 'round1Record.js'));
const { TRUST_OFFER } = require('./trust-fixture');

const NOW = Date.parse('2026-10-07T10:00:00.000Z');
const CAPTURED_AT = '2026-10-05T10:00:00.000Z';
const HOUR = 3600000;
const SILENT = { info() {}, warn() {}, error() {} };
const EMAIL_KEY = 're_f265_key_never_leaks';
const ACCESS_TOKEN = 'EAAG_f265_token_never_leaks';
const LEAD_EMAIL = 'hello@acme.example.com';
const LEAD_PHONE = '+923001234567';

const OFFER = Object.freeze({
  sender_name: 'Dana', sender_company: 'Ridgeline Supply',
  value_proposition: 'We fix the website issues an audit finds.', call_to_action: 'Would a short call help?',
  postal_address: TRUST_OFFER.postal_address,
});

// F26.6 declared harness update: the lead carries a country, because the F26.6 market gate
// judges every email path by it (no country = consent required).
const LEAD_COUNTRY = 'United States';
const lead = (o) => Object.assign({ id: 'L1', title: 'Acme Bakery', website: 'https://acme.example.com', email: LEAD_EMAIL, phone: LEAD_PHONE, address: '12 Road', country: LEAD_COUNTRY, qualification: 'qualified' }, o);

function configStore(settings, providers) {
  const data = { settings, providers };
  return { data, get: (k, f) => (data[k] === undefined ? f : data[k]), set: (k, v) => { data[k] = v; } };
}
const emailCfg = () => configStore({
  emailProvider: 'resend', emailEnabled: true, emailFromName: 'Ridgeline Supply', emailFromAddress: 'sender@verified-domain.test',
  emailDomain: 'verified-domain.test', emailDomainVerification: 'verified',
}, { resend: { credentials: { apiKey: EMAIL_KEY } } });
const waCfg = () => configStore({
  whatsappProvider: 'meta-cloud', whatsappEnabled: true, whatsappFromNumber: '+923001111111', whatsappPhoneNumberId: '1122334455667789',
  whatsappBusinessAccountId: '102233445566778899', whatsappNumberVerification: 'verified',
}, { 'meta-cloud': { credentials: { apiKey: ACCESS_TOKEN } } });

function spy() {
  const calls = [];
  return { calls, transport: async (req) => { calls.push(req); return { status: 200, body: { id: 're_ok', messages: [{ id: 'wamid.ok' }] } }; } };
}

/** A fresh runtime with NO trust facts: every test grants exactly what it needs. */
function runtime({ leads = { L1: lead({}) }, offer = OFFER, emailProvider, now = () => NOW, openExternal = null } = {}) {
  const store = new MemoryStore();
  const emailSpy = spy();
  const waSpy = spy();
  const records = Object.values(leads).map((l) => round1Record({
    id: 'rec_' + l.id, leadRef: l.id, domain: new URL(l.website).host, providerJobId: 'job_' + l.id,
    packet: zuniV1Packet({ domain: new URL(l.website).host, capturedAt: CAPTURED_AT }), createdAt: CAPTURED_AT, updatedAt: CAPTURED_AT,
  }));
  const li = createLeadIntelligence({
    store,
    leadSource: { getLead: async (id) => leads[String(id)] || null, listLeads: async () => Object.values(leads) },
    round1: {
      async getLatest(id) { return records.find((r) => r.leadRef === id) || null; },
      async listByLead(id) { return records.filter((r) => r.leadRef === id); },
      async listLatestPerLead() { return new Map(records.map((r) => [r.leadRef, r])); },
    },
    config: {
      research: { mode: 'round1' },
      freshness: { completeMaxAgeDays: 30, partialMaxAgeDays: 7 },
      outreach: { allowedQualification: ['qualified'], allowPartialEvidence: false, requireIcpFit: false },
      offer,
      email: { enabled: true, fromAddress: 'sender@verified-domain.test' },
      whatsapp: { enabled: true, fromNumber: '+923001111111' },
    },
    clock: () => new Date(now()),
    logger: SILENT,
    round1ResultMapper: round1PacketMapper,
    emailProvider: emailProvider || new ResendEmailProvider({ transport: emailSpy.transport, getApiKey: () => EMAIL_KEY }),
    emailConfigStore: emailCfg(),
    whatsappProvider: new MetaCloudWhatsAppProvider({ transport: waSpy.transport, getAccessToken: () => ACCESS_TOKEN, getPhoneNumberId: () => '1122334455667789' }),
    whatsappConfigStore: waCfg(),
    openExternal,
  });
  return { li, store, emailSpy, waSpy };
}

async function approved(li, leadId = 'L1') {
  await li.research.sync({ leadId });
  const pitch = await li.outreach.generate({ leadId });
  await li.outreach.approve({ pitchId: pitch.pitch_id });
  return pitch;
}

const iso = (ms) => new Date(ms).toISOString();
let n = 0;
const suppress = (store, channel, address, extra = {}) => store.suppressions.add(Object.assign({
  suppression_id: 'sup_t' + (++n), scope: 'global', workspace_id: null, channel, normalized_address: address, reason: 'unsubscribe', source: 'user', created_at: iso(NOW - HOUR),
}, extra));
const inbound = (store, { source = 'relay', at = NOW - HOUR, phone = LEAD_PHONE } = {}) => store.trustEvents.append({
  row_id: 'tev_t' + (++n), event_id: 'evt_t' + n, kind: 'whatsapp_inbound', channel: 'whatsapp', recipient_ref: null, normalized_address: phone,
  source, state: 'applied', reject_code: null, received_at: iso(at), recorded_at: iso(at),
});
const reply = (store, { source = 'relay', email = LEAD_EMAIL } = {}) => store.trustEvents.append({
  row_id: 'tev_t' + (++n), event_id: 'evt_t' + n, kind: 'reply', channel: 'email', recipient_ref: null, normalized_address: email,
  source, state: 'stored', reject_code: null, received_at: iso(NOW - HOUR), recorded_at: iso(NOW - HOUR),
});
/** F26.6: record a REVIEWED opt-out market rule for the lead's country (US by default). */
const allowMarket = (store, country_code = 'US') => store.marketRules.set({
  country_code, rule: 'opt_out_allowed', note: 'Test fixture: reviewed opt-out market', reviewed_by: 'Zee', reviewed_at: iso(NOW - HOUR),
});
const waConsent = (store) => store.consents.record({
  consent_id: 'con_t' + (++n), lead_id: 'L1', channel: 'whatsapp', normalized_address: LEAD_PHONE, method: 'in_person',
  evidence_note: 'Asked us to WhatsApp the audit at the expo.', recorded_by: 'Dana', consented_at: iso(NOW - 2 * HOUR), recorded_at: iso(NOW - 2 * HOUR), source: 'user',
});


module.exports = {
  NOW, HOUR, CAPTURED_AT, LEAD_EMAIL, LEAD_PHONE, EMAIL_KEY, ACCESS_TOKEN, OFFER, SILENT,
  lead, runtime, approved, iso, suppress, inbound, reply, waConsent, spy, allowMarket, LEAD_COUNTRY,
};
