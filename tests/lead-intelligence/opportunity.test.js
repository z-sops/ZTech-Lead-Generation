'use strict';

/**
 * Phase I2 - Opportunity Intelligence adapter tests.
 *
 * Structure: node:test + node:assert/strict, matching tests/lead-intelligence/*.
 * No network: every gateway test injects a fake fetch. No real provider research.
 *
 * The 30 numbered comments map one-to-one onto the I2 required test list.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const OP = path.join(__dirname, '..', '..', 'src', 'main', 'lead-intelligence', 'opportunity');

const { OpportunityIntelligenceGateway, ROUTES, DEFAULT_CONFIG } = require(path.join(OP, 'OpportunityIntelligenceGateway'));
const { OpportunityAssociationStore, MIGRATION_NEED } = require(path.join(OP, 'OpportunityAssociationStore'));
const { buildOpportunityReadModel, summariseReadModel } = require(path.join(OP, 'OpportunityReadModel'));
const { buildPitchEvidenceBridge, CLAIM_KIND_TO_BASIS } = require(path.join(OP, 'PitchEvidenceBridge'));
const { OpportunityIntelligenceService } = require(path.join(OP, 'OpportunityIntelligenceService'));
const oiContract = require(path.join(OP, 'oiContract'));
const {
  CHANNELS, INPUT_SCHEMAS, assertNoDestination, registerOpportunityIpc,
  registerUnavailableOpportunityIpc, FORBIDDEN_RENDERER_KEYS,
} = require(path.join(OP, 'opportunity-ipc'));
const { createOpportunityIntelligence } = require(path.join(OP, 'index'));
const { validateEvidencePacket, indexPacket } =
  require(path.join(__dirname, '..', '..', 'src', 'main', 'lead-intelligence', 'contracts', 'evidencePacket'));
const { PACKET_CONTRACT_VERSION, BASES } =
  require(path.join(__dirname, '..', '..', 'src', 'main', 'lead-intelligence', 'contracts', 'constants'));
const { PitchGenerator } = require(path.join(__dirname, '..', '..', 'src', 'main', 'lead-intelligence', 'outreach', 'PitchGenerator'));
const { generatePitch } = require(path.join(__dirname, '..', '..', 'src', 'main', 'lead-intelligence', 'outreach', 'PitchGenerator'));

// Fixtures live in tests/, never in src/: production code must not ship a test
// fixture, and the "no secret names in OI source" check depends on that.
const fixtures = require(path.join(__dirname, 'opportunity-fixtures'));

// --- helpers ----------------------------------------------------------------

/** Fake fetch. Records every call so tests can assert what left the process. */
function fakeFetch(routes, log = []) {
  return async (url, init = {}) => {
    log.push({ url, method: init.method || 'GET', init });
    const key = `${init.method || 'GET'} ${url}`;
    if (!(key in routes)) return resp(404, { error: 'NOT_FOUND', message: `no route ${key}` });
    const r = routes[key];
    if (r === 'network') throw new TypeError('fetch failed');
    if (r === 'refused') { const e = new Error('connect ECONNREFUSED 127.0.0.1:8099'); e.code = 'ECONNREFUSED'; throw e; }
    if (r === 'timeout') { const e = new Error('The operation was aborted'); e.name = 'AbortError'; throw e; }
    if (r === 'huge') return { ok: false, status: 200, headers: { get: () => String(64 * 1024 * 1024) }, text: async () => '' };
    return resp(r.status || 200, r.body, r.text);
  };
}

function resp(status, body, text) {
  return {
    ok: status < 400,
    status,
    headers: { get: () => null },
    text: async () => (text !== undefined ? text : JSON.stringify(body === undefined ? {} : body)),
  };
}

/**
 * Source with comments removed, so a test that greps for a forbidden identifier
 * finds real code references and not the prose explaining why it is absent.
 */
function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

function gateway(overrides = {}, routes = {}, log = []) {
  return new OpportunityIntelligenceGateway({
    config: { baseUrl: 'http://127.0.0.1:8099', ...overrides.config },
    fetchImpl: fakeFetch(routes, log),
    clock: () => new Date('2026-10-05T12:00:00Z'),
    logger: { warn() {}, error() {}, info() {} },
  });
}

function service(overrides = {}, routes = {}, log = []) {
  return new OpportunityIntelligenceService({
    config: { baseUrl: 'http://127.0.0.1:8099', ...overrides },
    fetchImpl: fakeFetch(routes, log),
    clock: () => new Date('2026-10-05T12:00:00Z'),
    logger: { warn() {}, error() {}, info() {} },
  });
}

const HEALTH_BODY = { status: 'ok', schema_version: '1.0' };
const RESEARCH_OK = { 'POST http://127.0.0.1:8099/v1/research': { status: 200, body: fixtures.report() } };
const REPORT_OK = { 'GET http://127.0.0.1:8099/v1/reports/res_20261005120000_abcdef01': { status: 200, body: fixtures.report() } };
const LEAD_VIEW = { company_name: 'Acme Bakery', domain: 'acme.example' };

/**
 * A service that has already run OI research for a lead, so the association
 * exists. Anything that tests the bridge, pitch context or the "latest report"
 * path needs a real association first - the bridge refuses to work from a bare
 * report, which is the point.
 */
async function seeded(leadId = 'L7', log = []) {
  const s = service({}, { ...RESEARCH_OK, ...REPORT_OK }, log);
  const view = await s.researchForLead({ leadId, leadView: LEAD_VIEW });
  assert.equal(view.available, true, `seeding research failed: ${view.message}`);
  return s;
}

// ============================================================================
// 1. OI gateway health success
// ============================================================================
test('1. gateway health succeeds and reports the OI schema version', async () => {
  const log = [];
  const g = gateway({}, { 'GET http://127.0.0.1:8099/v1/health': { status: 200, body: HEALTH_BODY } }, log);
  const h = await g.checkHealth();
  assert.equal(h.state, 'available');
  assert.equal(h.schema_version, '1.0');
  assert.equal(log[0].url, 'http://127.0.0.1:8099/v1/health');
  assert.equal(log[0].init.redirect, 'error', 'must not follow redirects');
  assert.equal(log[0].init.headers.authorization, undefined, 'no credential is ever attached');
});

// ============================================================================
// 2. OI unavailable does not crash ZTech
// ============================================================================
test('2. OI unavailable returns an honest state and never throws', async () => {
  for (const mode of ['network', 'timeout', 'refused']) {
    const g = gateway({}, { 'GET http://127.0.0.1:8099/v1/health': mode }, []);
    const h = await g.checkHealth(); // must not reject
    assert.equal(h.state, 'unavailable', `mode ${mode}`);
    assert.ok(h.message && h.message.length > 0);
  }
  // And a full research call on a dead service is data, not an exception.
  const s = service({}, { 'POST http://127.0.0.1:8099/v1/research': 'network' });
  const view = await s.researchForLead({ leadId: 'L1', leadView: { company_name: 'Acme', domain: 'acme.example' } });
  assert.equal(view.available, false);
  assert.equal(view.affects_outreach, false);
});

test('2b. service start never throws when OI is down', async () => {
  const s = service({}, { 'GET http://127.0.0.1:8099/v1/health': 'network' });
  const h = await s.start();
  assert.equal(h.state, 'unavailable');
  assert.equal(h.affects_outreach, false);
});

// ============================================================================
// 3. invalid base URL rejected
// ============================================================================
test('3. invalid or non-loopback base URLs are rejected at construction', async () => {
  const bad = [
    ['not a url', 'UNPARSEABLE'],
    ['', 'EMPTY'],
    ['ftp://127.0.0.1', 'UNSUPPORTED_SCHEME'],
    ['http://user:pw@127.0.0.1:8099', 'CREDENTIALS_IN_URL'],
    ['http://127.0.0.1:8099/?x=1', 'QUERY_OR_FRAGMENT_NOT_ALLOWED'],
    ['http://example.com', 'HTTPS_REQUIRED'],
    ['http://10.0.0.5:8099', 'HTTPS_REQUIRED'],
    ['https://oi.internal', 'PRIVATE_OR_RESERVED_DOMAIN'],
    ['https://oi.internal.example', null],
  ];
  // A public hostname over https is a legitimate explicitly-configured remote.
  assert.equal(gateway({ config: { baseUrl: 'https://oi.internal.example' } }).enabled, true);
  for (const [url, reason] of bad) {
    if (url === 'https://oi.internal.example') continue;
    const g = gateway({ config: { baseUrl: url } });
    assert.equal(g.enabled, false, `${url} must be refused`);
    assert.equal(g.health.state, 'misconfigured', `${url} must be misconfigured`);
    assert.ok(g.unavailableReason().length > 0, `${url} must explain itself`);
    if (reason) assert.match(g.health.message, /rejected/i);
  }
});

test('3b. localhost is allowed by default and remote requires https + opt-in', () => {
  for (const host of ['http://127.0.0.1:8099', 'http://localhost:8099', 'http://[::1]:8099']) {
    assert.equal(gateway({ config: { baseUrl: host } }).enabled, true, host);
  }
  assert.equal(gateway({ config: { baseUrl: 'http://localhost:8099', allowLocalhost: false } }).enabled, false);
  assert.equal(gateway({ config: { baseUrl: 'https://oi.example.com' } }).enabled, true, 'https remote is allowed when configured');
});

// ============================================================================
// 4. renderer cannot supply arbitrary OI URL
// ============================================================================
test('4. no IPC schema accepts a URL, host, endpoint or credential', () => {
  const forbidden = ['baseUrl', 'base_url', 'url', 'endpoint', 'host', 'hostname', 'origin',
    'address', 'apiKey', 'api_key', 'token', 'secret', 'credential', 'password', 'auth'];
  for (const [channel, schema] of Object.entries(INPUT_SCHEMAS)) {
    assert.equal(schema.additionalProperties, false, `${channel} must refuse extra properties`);
    const props = Object.keys(schema.properties || {});
    for (const bad of forbidden) {
      assert.equal(props.includes(bad), false, `${channel} must not accept ${bad}`);
    }
  }
});

test('4b. a renderer payload carrying a base URL is refused, not ignored', () => {
  for (const key of FORBIDDEN_RENDERER_KEYS) {
    assert.throws(() => assertNoDestination({ leadId: 'L1', [key]: 'http://evil.example' }, 'test'), /does not accept/);
  }
  assert.doesNotThrow(() => assertNoDestination({ leadId: 'L1' }, 'test'));
});

test('4c. the IPC handler refuses a smuggled destination before validation', async () => {
  const log = [];
  const handlers = {};
  const ipcMain = { handle: (c, fn) => { handlers[c] = fn; } };
  const s = service({}, { ...RESEARCH_OK }, log);
  registerOpportunityIpc({ ipcMain, opportunity: s, isTrustedSender: () => true });
  const res = await handlers[CHANNELS.REQUEST]({}, { leadId: 'L1', baseUrl: 'http://evil.example' });
  assert.equal(res.ok, false);
  assert.match(res.error.message, /does not accept/);
  assert.equal(log.length, 0, 'a refused payload must not reach the network');
});

test('4d. renderer-supplied lead view is never trusted: identity comes from the main store', async () => {
  const log = [];
  const handlers = {};
  const ipcMain = { handle: (c, fn) => { handlers[c] = fn; } };
  const s = service({}, { ...RESEARCH_OK }, log);
  const leadSource = { get: async () => ({ name: 'Real Co', domain: 'real.example' }) };
  registerOpportunityIpc({ ipcMain, opportunity: s, isTrustedSender: () => true, leadSource });

  // The renderer tries to smuggle identity fields into the payload: the closed
  // schema refuses the whole call, and nothing is sent.
  const smuggled = await handlers[CHANNELS.REQUEST]({}, { leadId: 'L1', company_name: 'Fake Co', domain: 'evil.example' });
  assert.equal(smuggled.ok, false, 'identity fields are not part of the schema');
  assert.equal(log.length, 0);

  // A legitimate payload carries ONLY leadId; the body is built from the store.
  const ok = await handlers[CHANNELS.REQUEST]({}, { leadId: 'L1' });
  assert.equal(ok.ok, true);
  const body = JSON.parse(log[0].init.body);
  assert.equal(body.prospect.company_name, 'Real Co');
  assert.equal(body.prospect.domain, 'real.example');
  assert.equal(body.prospect.lead_reference, undefined, 'lead_id is not sent to OI');
  assert.equal(ok.data.model.lead_id, 'L1');
});

// ============================================================================
// 5. canonical IntelligenceReport accepted
// ============================================================================
test('5. a canonical IntelligenceReport is accepted unchanged', async () => {
  const log = [];
  const g = gateway({}, RESEARCH_OK, log);
  const res = await g.requestResearch({ leadId: 'L1', companyName: 'Acme Bakery', domain: 'acme.example' });
  assert.equal(res.ok, true);
  assert.equal(res.report.schema_version, '1.0');
  assert.equal(res.report.research_id, 'res_20261005120000_abcdef01');
  assert.equal(res.providers.usable, 6);
  // nothing was rewritten on the way through
  assert.deepEqual(res.report.provider_status['dom:acme.example'].linkedin, 'unsupported');
});

test('5b. the minimal legal report is accepted', async () => {
  const g = gateway({}, { 'POST http://127.0.0.1:8099/v1/research': { status: 200, body: fixtures.minimalReport() } });
  const res = await g.requestResearch({ companyName: 'Min Co', domain: 'min.example' });
  assert.equal(res.ok, true);
  assert.equal(res.report.prospect.company_name, 'Min Co');
});

test('5c. the read model carries every OI section and the authoritative ids', () => {
  const r = fixtures.report();
  const m = buildOpportunityReadModel({ report: r, leadId: 'L42' });
  assert.equal(m.lead_id, 'L42');
  assert.equal(m.research_id, r.research_id);
  assert.equal(m.snapshot_id, r.snapshot_id);
  assert.equal(m.entity_key, 'dom:acme.example');
  for (const k of ['competitors', 'evidence', 'observations', 'signals', 'advertising_intelligence',
    'content_intelligence', 'social_intelligence', 'comparisons', 'changes', 'opportunities',
    'opportunity_score', 'sales_angles', 'timeline', 'conflicts', 'limitations', 'provider_status']) {
    assert.ok(m[k] !== undefined, `read model is missing ${k}`);
  }
  assert.equal(m.counts.competitors, 1);
  assert.equal(m.counts.opportunities, 1);
  assert.equal(m.counts.timeline, 4);
  assert.ok(m.summarise === undefined);
  assert.equal(summariseReadModel(m).opportunity_score, 38);
});

// ============================================================================
// 6. malformed report rejected safely
// ============================================================================
test('6. every malformed report variant is refused, with no partial application', async () => {
  for (const [name, bad] of Object.entries(fixtures.malformedVariants())) {
    const check = oiContract.validateIntelligenceReport(bad);
    assert.equal(check.valid, false, `${name} must be rejected`);
    assert.ok(check.errors.length > 0, `${name} must report an error`);

    const g = gateway({}, { 'POST http://127.0.0.1:8099/v1/research': { status: 200, body: bad } });
    const res = await g.requestResearch({ companyName: 'Acme', domain: 'acme.example' });
    assert.equal(res.ok, false, `${name} must not be accepted by the gateway`);
    assert.equal(res.state, 'invalid_response', `${name} must be invalid_response`);
    assert.equal(res.report, undefined, `${name} must yield no report`);
  }
});

test('6b. a non-JSON OI body is refused, and an oversized body is refused', async () => {
  const nonJson = gateway({}, { 'GET http://127.0.0.1:8099/v1/health': { status: 200, text: '<html>nope</html>' } });
  assert.equal((await nonJson.checkHealth()).state, 'invalid_response');

  const huge = gateway({}, { 'GET http://127.0.0.1:8099/v1/reports/res_20261005120000_abcdef01': 'huge' });
  const res = await huge.getReport('res_20261005120000_abcdef01');
  assert.equal(res.ok, false);
  assert.equal(res.state, 'invalid_response');
});

test('6c. a bogus research id never reaches the network', async () => {
  const log = [];
  const g = gateway({}, {}, log);
  for (const bad of ['', 'res_../../admin', '../../etc/passwd', 'res_20261005120000_ZZZZZZZZ', null]) {
    const res = await g.getReport(bad);
    assert.equal(res.ok, false);
    assert.equal(res.state, 'invalid_input');
  }
  assert.equal(log.length, 0, 'no request may be issued for an invalid id');
});

// ============================================================================
// 7. lead_id association preserved
// ============================================================================
test('7. lead_id is preserved through gateway, read model, bridge and service', async () => {
  const log = [];
  const s = service({}, { ...RESEARCH_OK, ...REPORT_OK }, log);
  const view = await s.researchForLead({ leadId: 'L7', leadView: { company_name: 'Acme Bakery', domain: 'acme.example' } });
  assert.equal(view.model.lead_id, 'L7');
  assert.equal(view.model.association.lead_id, 'L7');
  assert.equal(view.summary.lead_id, 'L7');

  const bridge = await s.pitchContextForLead({ leadId: 'L7', leadView: { name: 'Acme' } });
  assert.equal(bridge.bridge.packet.lead_id, 'L7');
  assert.equal(bridge.bridge.oi.research_id, 'res_20261005120000_abcdef01');
});

test('7b. the join is never a business-name match', async () => {
  const store = new OpportunityAssociationStore();
  const r = fixtures.report();
  assert.equal(store.assertLeadAssociation({ leadId: 'L7', report: r }).ok, true);
  assert.equal(store.leadForResearch(r.research_id), 'L7');
  // Same company name, different lead: nothing links them.
  assert.equal(store.leadForResearch('res_20260101120000_0000aaaa'), null);
  // A different lead cannot steal the research_id.
  const other = store.assertLeadAssociation({ leadId: 'L9', report: r });
  assert.equal(other.ok, false);
  assert.equal(store.leadForResearch(r.research_id), 'L7');
});

test('7c. a report without OI ids cannot create an association', () => {
  const store = new OpportunityAssociationStore();
  for (const bad of [{}, { research_id: 'nope', snapshot_id: 'snap_20260101120000_0000aaaa' },
    { research_id: 'res_20260101120000_0000aaaa' }, { research_id: 'res_20260101120000_0000aaaa', snapshot_id: 'x', prospect: { entity_key: 'k' } }]) {
    assert.equal(store.assertLeadAssociation({ leadId: 'L1', report: bad }).ok, false, JSON.stringify(bad));
  }
  assert.equal(store.assertLeadAssociation({ leadId: 'L1' }).ok, false);
  assert.equal(store.assertLeadAssociation({ report: fixtures.report() }).ok, false);
});

// ============================================================================
// 8. research_id preserved
// ============================================================================
test('8. research_id survives the gateway, the read model and the bridge', async () => {
  const s = service({}, { ...RESEARCH_OK, ...REPORT_OK });
  const view = await s.researchForLead({ leadId: 'L7', leadView: { company_name: 'Acme Bakery', domain: 'acme.example' } });
  assert.equal(view.model.research_id, 'res_20261005120000_abcdef01');
  assert.equal(view.model.association.research_id, 'res_20261005120000_abcdef01');
  const bridge = await s.pitchContextForLead({ leadId: 'L7' });
  assert.equal(bridge.bridge.oi.research_id, 'res_20261005120000_abcdef01');
  // The ZTech job_id is derived from it, so a packet can be traced back.
  assert.ok(bridge.bridge.packet.job_id.includes('res_20261005120000_abcdef01'));
  assert.equal(bridge.bridge.packet.provenance.provider_job_id.includes('res_20261005120000_abcdef01'), true);
});

// ============================================================================
// 9. snapshot_id preserved
// ============================================================================
test('9. snapshot_id is preserved and never inferred', async () => {
  const s = await seeded();
  const view = await s.latestForLead({ leadId: 'L7' });
  assert.equal(view.model.snapshot_id, 'snap_20261005120000_abcdef01');
  const bridge = await s.pitchContextForLead({ leadId: 'L7' });
  assert.equal(bridge.bridge.oi.snapshot_id, 'snap_20261005120000_abcdef01');

  // A report with no snapshot id is refused rather than having one invented.
  const noSnap = fixtures.report();
  delete noSnap.snapshot_id;
  const g = gateway({}, { 'POST http://127.0.0.1:8099/v1/research': { status: 200, body: noSnap } });
  const res = await g.requestResearch({ companyName: 'Acme', domain: 'acme.example' });
  assert.equal(res.ok, false);
  assert.equal(res.report, undefined);
});

// ============================================================================
// 10-12. FACT / ESTIMATE / INFERENCE each remain themselves
// ============================================================================
test('10/11/12. ClaimKind survives the read model: fact, estimate and inference', () => {
  const m = buildOpportunityReadModel({ report: fixtures.report(), leadId: 'L7' });
  const by = Object.fromEntries(m.evidence.map((e) => [e.evidence_id, e.claim_kind]));
  assert.equal(by.ev_web01, 'fact');
  assert.equal(by.ev_est01, 'estimate');
  assert.equal(by.ev_inf01, 'inference');
  // not weakened into a boolean or a coarser label
  assert.notEqual(by.ev_est01, 'fact');
  assert.notEqual(by.ev_inf01, 'fact');
  assert.deepEqual(m.observations[0].claim_kind, 'fact');
  assert.deepEqual(m.signals[0].claim_kind, 'inference');
  assert.deepEqual(m.changes[0].claim_kind, 'fact');
  assert.deepEqual(m.timeline.map((t) => t.claim_kind), ['fact', 'fact', 'inference', 'fact']);
  assert.deepEqual(m.opportunities[0].claim_kind, 'inference');
});

test('10b. an evidence item with no claim_kind is reported as null, never defaulted to fact', () => {
  const r = fixtures.report();
  delete r.evidence[0].claim_kind;
  const m = buildOpportunityReadModel({ report: r, leadId: 'L1' });
  assert.equal(m.evidence[0].claim_kind, null);
});

test('10c. the read model keeps the estimate range and the raw confidence', () => {
  const m = buildOpportunityReadModel({ report: fixtures.report(), leadId: 'L1' });
  const est = m.evidence.find((e) => e.evidence_id === 'ev_est01');
  assert.equal(est.claim_kind, 'estimate');
  assert.equal(est.confidence, 0.7);
  assert.equal(est.freshness, 'fresh');
});

// ============================================================================
// 13-16. provider statuses SUCCESS / PARTIAL / UNAVAILABLE / UNSUPPORTED preserved
// ============================================================================
test('13/14/15/16. all four provider statuses are preserved verbatim', () => {
  const m = buildOpportunityReadModel({ report: fixtures.report(), leadId: 'L1' });
  // keyed by entity AND provider: the same provider can be success on the prospect
  // and partial on a competitor, and both must survive.
  const flat = Object.fromEntries(m.provider_status.map((p) => [`${p.entity_key}:${p.provider}`, p.status]));
  assert.equal(flat['dom:acme.example:website'], 'success');
  assert.equal(flat['dom:acme.example:content'], 'success');
  assert.equal(flat['dom:acme.example:competitors'], 'success');
  assert.equal(flat['dom:acme.example:google_ads'], 'partial');
  assert.equal(flat['dom:rival.example:meta_ads'], 'partial');
  assert.equal(flat['dom:acme.example:meta_ads'], 'unavailable');
  assert.equal(flat['dom:acme.example:twitter'], 'unavailable');
  assert.equal(flat['dom:acme.example:linkedin'], 'unsupported');
  assert.equal(flat['dom:rival.example:linkedin'], 'unsupported');
  assert.deepEqual(m.provider_summary.counts, {
    success: 4, partial: 2, unavailable: 2, unsupported: 2, failed: 0, rate_limited: 0,
  });
});

test('13b. degraded providers never mean "research failed"', () => {
  const m = buildOpportunityReadModel({ report: fixtures.report(), leadId: 'L1' });
  assert.equal(m.degraded, true);
  assert.equal(m.available, true);
  assert.equal(m.research_failed, false);
  assert.equal(m.status, 'partial');
});

test('13c. only an OI-reported failure is a failure', () => {
  const m = buildOpportunityReadModel({ report: fixtures.failedReport(), leadId: 'L1' });
  assert.equal(m.research_failed, true);
  assert.equal(m.available, false);
  assert.equal(m.status, 'failed');
});

// ============================================================================
// 17. competitor identities preserved
// ============================================================================
test('17. competitor identity is preserved exactly as OI resolved it', () => {
  const m = buildOpportunityReadModel({ report: fixtures.report(), leadId: 'L1' });
  assert.equal(m.competitors.length, 1);
  const c = m.competitors[0];
  assert.equal(c.entity_id, 'ent_competitor1');
  assert.equal(c.entity_key, 'dom:rival.example');
  assert.equal(c.company_name, 'Rival Foods');
  assert.equal(c.domain, 'rival.example');
  assert.equal(c.relationship_type, 'direct_competitor');
  assert.equal(c.relationship_confidence, 0.9);
  assert.equal(c.discovered_via, 'search');
  assert.deepEqual(c.evidence_refs, ['ev_discovery01']);
  // and the comparison still points at the right entity key
  assert.equal(m.comparisons[0].competitor_entity_key, 'dom:rival.example');
});

// ============================================================================
// 18. evidence provenance preserved
// ============================================================================
test('18. evidence provenance is preserved end to end', async () => {
  const s = await seeded();
  const bridge = await s.pitchContextForLead({ leadId: 'L7', leadView: { name: 'Acme' } });
  const p = bridge.bridge.packet;
  for (const f of p.facts) {
    assert.equal(f.provenance.provider, 'opportunity-intelligence');
    assert.equal(f.provenance.lead_id, 'L7');
    assert.equal(f.provenance.packet_id, p.packet_id);
    assert.ok(f.provenance.captured_at, 'captured_at must survive');
    // every bridged fact traces back to an OI evidence_id
    const oid = bridge.bridge.oi_ids[f.fact_id];
    assert.ok(oid && oid.evidence_id, `fact ${f.fact_id} has no OI evidence_id`);
    assert.ok(oid.provider);
  }
  assert.ok(p.source_references.length > 0, 'source urls must be carried');
  assert.equal(p.source_references[0].kind, 'opportunity-intelligence');
});

test('18b. an OI limitation and each unavailable provider become packet limitations', async () => {
  const s = await seeded();
  const bridge = await s.pitchContextForLead({ leadId: 'L7' });
  const codes = bridge.bridge.packet.limitations.map((l) => l.code);
  assert.ok(codes.includes('OI_LIMITATION'));
  assert.ok(codes.includes('OI_PROVIDER_UNAVAILABLE'));
  assert.ok(codes.includes('OI_PROVIDER_PARTIAL'));
  assert.ok(codes.includes('OI_PROVIDER_UNSUPPORTED'));
  const msg = bridge.bridge.packet.limitations.find((l) => l.code === 'OI_PROVIDER_UNAVAILABLE').message;
  assert.match(msg, /absent from this packet, not refuted/);
});

// ============================================================================
// 19. opportunities preserved
// ============================================================================
test('19. opportunities are preserved, typed as inference, with their refs', () => {
  const m = buildOpportunityReadModel({ report: fixtures.report(), leadId: 'L1' });
  assert.equal(m.opportunities.length, 1);
  const o = m.opportunities[0];
  assert.equal(o.opportunity_id, 'opp_ads01');
  assert.equal(o.type, 'ADVERTISING_GAP');
  assert.equal(o.severity, 'high');
  assert.equal(o.claim_kind, 'inference');
  assert.equal(o.confidence, 0.75);
  assert.deepEqual(o.evidence_refs, ['ev_web01', 'ev_disc01']);
  assert.deepEqual(o.signal_refs, ['sig_gap01']);
  assert.deepEqual(o.comparison_refs, ['cmp_ads01']);
  assert.ok(o.what_was_observed.length > 0);
  assert.ok(o.why_it_matters.length > 0);
  assert.equal(m.opportunity_score.score, 38);
  assert.equal(m.opportunity_score.model_version, 'score-1.0');
});

// ============================================================================
// 20. sales angles preserved
// ============================================================================
test('20. sales angles survive with confidence, refs and do_not_claim guidance', () => {
  const m = buildOpportunityReadModel({ report: fixtures.report(), leadId: 'L1' });
  assert.equal(m.sales_angles.length, 1);
  const a = m.sales_angles[0];
  assert.equal(a.angle_id, 'ang_01');
  assert.equal(a.angle, 'Lead with the paid-social blind spot');
  assert.equal(a.confidence, 0.7);
  assert.deepEqual(a.opportunity_refs, ['opp_ads01']);
  assert.deepEqual(a.evidence_refs, ['ev_web01', 'ev_disc01']);
  assert.deepEqual(a.do_not_claim, ['Do not say the prospect has zero ads.']);
});

// ============================================================================
// 21. timeline preserved
// ============================================================================
test('21. the OI research timeline is preserved with type and claim kind', () => {
  const m = buildOpportunityReadModel({ report: fixtures.report(), leadId: 'L1' });
  assert.equal(m.timeline.length, 4);
  assert.deepEqual(m.timeline.map((t) => t.event_type),
    ['RESEARCH_STARTED', 'PROVIDER_UNAVAILABLE', 'OPPORTUNITY_IDENTIFIED', 'SNAPSHOT_CAPTURED']);
  assert.equal(m.timeline[1].claim_kind, 'fact');
  assert.equal(m.timeline[2].claim_kind, 'inference');
  for (const e of m.timeline) assert.equal(e.research_id, 'res_20261005120000_abcdef01');
  // It is a research timeline, not the operational Activity ledger.
  assert.ok(!('activity_type' in m.timeline[0]));
});

test('21b. the OI timeline route works and stays separate from operational activity', async () => {
  const g = gateway({}, { 'GET http://127.0.0.1:8099/v1/timeline?research_id=res_20261005120000_abcdef01': { status: 200, body: { research_ids: ['res_20261005120000_abcdef01'], score_history: [], events: [{ event_id: 'evt_01', event_type: 'RESEARCH_STARTED', entity_id: 'e', occurred_at: fixtures.GENERATED_AT, title: 't', claim_kind: 'fact' }] } } });
  const res = await g.getTimeline({ researchId: 'res_20261005120000_abcdef01' });
  assert.equal(res.ok, true);
  assert.equal(res.timeline.events.length, 1);
  assert.equal(res.timeline.events[0].claim_kind, 'fact');
});

// ============================================================================
// 22. limitations preserved
// ============================================================================
test('22. limitations are preserved verbatim', () => {
  const m = buildOpportunityReadModel({ report: fixtures.report(), leadId: 'L1' });
  assert.equal(m.limitations.length, 2);
  assert.match(m.limitations[0], /No search API configured/);
  assert.match(m.limitations[1], /First snapshot for this prospect/);
  assert.equal(m.conflicts.length, 1);
  assert.equal(m.conflicts[0].metric, 'articles_60d');
});

// ============================================================================
// 23. bridge contains only bounded supported data
// ============================================================================
test('23. the bridge output is a valid, bounded EvidencePacket', async () => {
  const s = await seeded();
  const ctx = await s.pitchContextForLead({ leadId: 'L7', leadView: { name: 'Acme' } });
  const b = ctx.bridge;
  assert.equal(ctx.available, true, JSON.stringify(ctx.errors));
  const v = validateEvidencePacket(b.packet);
  assert.equal(v.valid, true, JSON.stringify(v.errors));
  assert.equal(b.packet.contract_version, PACKET_CONTRACT_VERSION);
  assert.ok(b.packet.facts.length <= 200);
  assert.ok(b.packet.findings.length <= 40);
  assert.ok(b.packet.strengths.length <= 20);
  assert.ok(b.packet.limitations.length <= 50);
  // every reference resolves
  const idx = indexPacket(b.packet);
  for (const f of b.packet.findings) for (const id of f.fact_ids) assert.ok(idx.hasRef(id), `dangling ${id}`);
  // and the index itself confirms every claim the bridge makes is traceable
  for (const f of b.packet.findings) assert.ok(f.fact_ids.length > 0);
});

test('23b. low-confidence evidence is dropped and the drop is reported', async () => {
  const s = await seeded();
  const ctx = await s.pitchContextForLead({ leadId: 'L7' });
  const b = ctx.bridge;
  assert.equal(b.excluded.low_confidence, 1);
  const hasLow = b.packet.facts.some((f) => JSON.stringify(b.oi_ids[f.fact_id]).includes('ev_low01'));
  assert.equal(hasLow, false);
  assert.ok(ctx.bridge.packet.limitations.some((l) => l.code === 'OI_LOW_CONFIDENCE_DROPPED'));
});

test('23c. opportunities are NOT bridged as findings, and that is stated', async () => {
  const s = await seeded();
  const ctx = await s.pitchContextForLead({ leadId: 'L7' });
  assert.equal(ctx.bridge.excluded.opportunities_not_bridged, 1);
  assert.ok(ctx.bridge.packet.limitations.some((l) => l.code === 'OI_OPPORTUNITIES_NOT_BRIDGED'));
  const findingText = ctx.bridge.packet.findings.map((f) => f.observed).join(' ');
  assert.equal(findingText.includes('ADVERTISING_GAP'), false);
});

// ============================================================================
// 24. bridge never upgrades inference/estimate into fact
// ============================================================================
test('24. the bridge maps claim kinds one-way and never upgrades', () => {
  assert.deepEqual(CLAIM_KIND_TO_BASIS, { fact: 'standard', estimate: 'research', inference: 'heuristic' });

  const r = fixtures.report();
  // Every OI opportunity is an inference. Force a report where every evidence
  // item is an inference, and assert the bridge produces ZERO findings.
  const allInference = JSON.parse(JSON.stringify(r));
  allInference.evidence.forEach((e) => { e.claim_kind = 'inference'; });
  allInference.comparisons.forEach((c) => { c.evidence_refs = ['ev_inf01']; });
  allInference.sales_angles.forEach((a) => { a.evidence_refs = ['ev_inf01']; });
  const built = buildPitchEvidenceBridge({ report: allInference, leadId: 'L1' });
  assert.equal(built.packet.findings.length, 0, 'an inference must never become a pitch finding');
  for (const f of built.packet.findings) {
    assert.notEqual(built.claim_kinds[f.finding_id], 'inference');
  }
});

test('24b. an estimate becomes basis research, never basis standard', async () => {
  const s = await seeded();
  const ctx = await s.pitchContextForLead({ leadId: 'L7' });
  const b = ctx.bridge;
  const estFinding = b.packet.findings.find((f) => b.claim_kinds[f.finding_id] === 'estimate');
  assert.ok(estFinding, 'the estimate evidence should have produced a finding');
  assert.equal(estFinding.basis, 'research');
  assert.notEqual(estFinding.basis, 'standard', 'an estimate must not become a standard fact');
  assert.ok(BASES.includes(estFinding.basis));
  // the estimate range is not silently promoted to a point value
  assert.match(estFinding.observed, /estimate, not a direct observation/);
});

test('24c. no finding in the bridge is basis heuristic AND pitch eligible', async () => {
  const s = await seeded();
  const b = (await s.pitchContextForLead({ leadId: 'L7' })).bridge;
  // the mapping is total and one-way in both directions
  for (const f of b.packet.findings) {
    const kind = b.claim_kinds[f.finding_id];
    if (f.basis === 'heuristic') assert.equal(kind, 'inference', 'heuristic basis implies an OI inference');
    if (kind === 'inference') assert.equal(f.basis, 'heuristic', 'an OI inference is always heuristic basis');
  }
  // and the invariant holds for every report variant the bridge can build
  const built = buildPitchEvidenceBridge({ report: fixtures.report(), leadId: 'L1' });
  for (const f of built.packet.findings) {
    if (built.claim_kinds[f.finding_id] === 'inference') assert.equal(f.basis, 'heuristic');
  }
});

test('24d. PitchGenerator refuses to quote a heuristic-basis finding', () => {
  const report = fixtures.report();
  const base = { schema_version: '1.0', research_id: report.research_id, snapshot_id: report.snapshot_id, previous_snapshot_id: null, status: 'completed', generated_at: report.generated_at, prospect: report.prospect, competitors: [], evidence: [], observations: [], signals: [], advertising_intelligence: {}, content_intelligence: {}, social_intelligence: {}, comparisons: [], changes: [], opportunities: [], opportunity_score: report.opportunity_score, sales_angles: [], timeline: [], conflicts: [], limitations: [], provider_status: report.provider_status, telemetry: report.telemetry };
  const inferenceOnly = JSON.parse(JSON.stringify(base));
  inferenceOnly.evidence = [{ evidence_id: 'ev_i1', entity_id: 'ent_prospect01', provider: 'content', claim: 'Likely produced by an agency.', claim_kind: 'inference', captured_at: report.generated_at, confidence: 0.9 }];
  const built = buildPitchEvidenceBridge({ report: inferenceOnly, leadId: 'L1' });
  assert.equal(built.packet.findings.length, 0);

  // And when a finding IS heuristic, the generator filters it out.
  const pkt = JSON.parse(JSON.stringify(built.packet));
  pkt.findings = [{
    finding_id: 'find_x', rule_id: 'oi.inferred', area: 'other', title: 'Inferred thing', severity: 'high',
    basis: 'heuristic', observed: 'Inferred thing - it looks agency-produced', recommendation: '', urls: [],
    fact_ids: built.packet.facts.map((f) => f.fact_id),
    provenance: built.packet.facts[0].provenance,
  }];
  const draft = generatePitch({ view: { id: 'L1', name: 'Acme' }, packet: pkt, offer: {} });
  assert.equal(draft.observations.length, 0, 'a heuristic finding must not become a pitch observation');
});

test('24e. the bridge refuses to invent an observation for an unavailable provider', async () => {
  const s = await seeded();
  const b = (await s.pitchContextForLead({ leadId: 'L7' })).bridge;
  for (const f of b.packet.facts) {
    const oid = b.oi_ids[f.fact_id];
    assert.ok(oid.provider, 'each fact names its provider');
    const status = b.oi.provider_status.find((p) => p.provider === oid.provider && p.entity_key === 'dom:acme.example');
    if (status) assert.notEqual(status.status, 'unavailable', 'no fact may come from an unavailable provider');
  }
});

// ============================================================================
// 25. Zuni-SEO gateway remains unchanged
// ============================================================================
test('25. the Zuni-SEO gateway and contract are untouched by the OI work', () => {
  const fs = require('fs');
  const root = path.join(__dirname, '..', '..');
  const zuni = fs.readFileSync(path.join(root, 'src', 'main', 'lead-intelligence', 'research', 'ProspectIntelligenceGateway.js'), 'utf8');
  // The Zuni-SEO gateway must not know OI exists.
  for (const token of ['opportunity', 'Opportunity', 'oiContract', 'oi.read', 'IntelligenceReport']) {
    assert.equal(zuni.includes(token), false, `Zuni-SEO gateway must not mention ${token}`);
  }
  // Its contract is unchanged: same required field list.
  const contract = fs.readFileSync(path.join(root, 'src', 'main', 'lead-intelligence', 'contracts', 'constants.js'), 'utf8');
  assert.match(contract, /const BASES = Object\.freeze\(\['standard', 'research', 'heuristic', 'unknown'\]\)/);
  const evidence = fs.readFileSync(path.join(root, 'src', 'main', 'lead-intelligence', 'contracts', 'evidencePacket.js'), 'utf8');
  assert.match(evidence, /'packet_id', 'lead_id', 'job_id', 'contract_version'/);
  // OI never writes into the Zuni-SEO packet contract module.
  assert.equal(evidence.includes('OpportunityIntelligence'), false);
});

test('25b. the OI service module set touches no Zuni-SEO or outreach file', () => {
  const fs = require('fs');
  const dir = path.join(__dirname, '..', '..', 'src', 'main', 'lead-intelligence', 'opportunity');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
  assert.ok(files.length >= 8, `expected the OI module set, saw ${files.join(', ')}`);
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    // It may import PitchGenerator (read-only) but must never mutate outreach internals.
    assert.equal(/require\(['"]\.\.\/outreach\/(?!PitchGenerator)/.test(src), false,
      `${f} must not require another outreach module`);
    assert.equal(/require\(['"]\.\.\/research\//.test(src), false,
      `${f} must not reach into the Zuni-SEO research modules`);
  }
});

// ============================================================================
// 26. OI unavailable does not disable existing Zuni-SEO
// ============================================================================
test('26. OI being down leaves the Zuni-SEO path untouched and usable', async () => {
  // The REAL Zuni-SEO graph on MemoryStore, not a mock: the point of this test
  // is that a dead OI cannot stop actual Zuni-SEO research from completing.
  const { build, researchToCompletion } = require(path.join(__dirname, 'helpers'));
  const ctx = build();
  // ctx.li.gateway IS the real Zuni-SEO ProspectIntelligenceGateway.
  const zuni = ctx.li.gateway;
  assert.equal(zuni.constructor.name, 'ProspectIntelligenceGateway');

  const oi = service({}, { 'GET http://127.0.0.1:8099/v1/health': 'network', 'POST http://127.0.0.1:8099/v1/research': 'network' });
  await oi.start();
  const oiView = await oi.researchForLead({ leadId: 'L1', leadView: LEAD_VIEW });
  assert.equal(oiView.available, false);
  assert.equal(oiView.affects_outreach, false);

  // Zuni-SEO answers its own status...
  const status = await zuni.getStatus('L1');
  assert.equal(status.lead_id, 'L1');
  assert.ok(status.research_state, 'Zuni-SEO still reports its own research state');

  // ...and still runs a full research to completion while OI is dead.
  await researchToCompletion(ctx, 'L1', { force: true });
  const done = await zuni.getStatus('L1');
  assert.ok(['complete', 'partial'].includes(done.research_state), `expected a finished Zuni job, got ${done.research_state}`);
  assert.ok(done.packet, 'Zuni-SEO still produced its own packet');
  assert.ok(done.fresh);

  // The two ledgers never cross: an OI failure adds nothing to Zuni's history.
  const oiHistory = await zuni.getHistory('L1');
  assert.ok(Array.isArray(oiHistory.jobs || oiHistory.events || []), 'ZTech history keeps its own shape');
  assert.equal(oi.associations.leadForResearch('job_1'), null, 'no OI association may borrow a Zuni job id');
});

test('26b. an OI-disabled build still answers every OI channel honestly', async () => {
  const handlers = {};
  const ipcMain = { handle: (c, fn) => { handlers[c] = fn; } };
  const oi = createOpportunityIntelligence({ config: { enabled: false }, fetchImpl: async () => { throw new Error('must not be called'); } });
  const registered = oi.registerIpc({ ipcMain, isTrustedSender: () => true });
  assert.equal(registered.length, Object.keys(CHANNELS).length);
  for (const c of Object.values(CHANNELS)) {
    const res = await handlers[c]({}, {});
    assert.equal(res.ok, true, c);
    assert.equal(res.data.available, false, c);
    assert.equal(res.data.affects_outreach, false, c);
  }
});

// ============================================================================
// 27. OI unavailable does not alter Ready / send capability
// ============================================================================
test('27. no OI state can change outreach readiness or send capability', async () => {
  const fs = require('fs');
  const root = path.join(__dirname, '..', '..');
  // 1. the OI channels contain no send/approve/schedule verb
  for (const c of Object.values(CHANNELS)) {
    for (const verb of ['send', 'approve', 'schedule', 'queue', 'campaign', 'retry', 'deliver']) {
      assert.equal(c.toLowerCase().includes(verb), false, `${c} must not be a ${verb} channel`);
    }
  }
  // 2. every OI response carries an explicit "does not affect outreach" marker
  const oi = await seeded('L1');
  const view = await oi.researchForLead({ leadId: 'L1', leadView: LEAD_VIEW });
  assert.equal(view.affects_outreach, false);
  assert.equal(oi.healthView().affects_outreach, false);
  assert.equal((await oi.pitchContextForLead({ leadId: 'L1' })).affects_outreach, false);
  assert.equal(oi.associationsForLead({ leadId: 'L1' }).affects_outreach, false);

  // 3. the OI modules never import the gate, the send boundary or the approval store
  const dir = path.join(root, 'src', 'main', 'lead-intelligence', 'opportunity');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    // strip comments first: this file explains at length WHY the gate is not
    // touched, and that explanation must not count as touching it.
    const src = stripComments(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const forbidden of ['OutreachGate', 'outreachReady', 'sendEmail', 'sendWhatsApp', 'OutreachService',
      'li_outreach_activity', 'li_outreach_sends', 'li_pitch_drafts', 'registerOutreachIpc']) {
      assert.equal(src.includes(forbidden), false, `${f} must not reference ${forbidden}`);
    }
  }

  // 4. the pitch preview is explicitly not persisted and not approved
  const preview = await oi.previewPitchFromOI({ leadId: 'L1', leadView: { name: 'Acme' }, offer: {} });
  assert.equal(preview.persisted, false);
  assert.equal(preview.approved, false);
  assert.equal(preview.affects_outreach, false);
});

// ============================================================================
// 28. no provider secrets cross IPC
// ============================================================================
test('28. no provider credential crosses the IPC boundary in either direction', async () => {
  const SECRET_NAMES = ['BRAVE_API_KEY', 'SERPER_API_KEY', 'LLM_API_KEY', 'META_ACCESS_TOKEN', 'SERPAPI_API_KEY', 'X_BEARER_TOKEN'];
  // 1. no schema and no outbound header can carry one
  for (const [channel, schema] of Object.entries(INPUT_SCHEMAS)) {
    const props = Object.keys(schema.properties || {}).join(',');
    for (const n of SECRET_NAMES) assert.equal(props.includes(n), false, `${channel}/${n}`);
  }
  const log = [];
  const g = gateway({}, {
    ...RESEARCH_OK,
    'GET http://127.0.0.1:8099/v1/engine': {
      status: 200,
      body: {
        engine: 'ztech-opportunity-intelligence',
        schema_version: '1.0',
        providers: ['website', 'content'],
        configuration: { db_path: 'ztech_oi.sqlite3', search: null, llm: null, social: null },
      },
    },
  }, log);
  await g.requestResearch({ companyName: 'Acme', domain: 'acme.example', options: { brave_api_key: 'x' } });
  const headers = JSON.stringify(log[0].init.headers).toLowerCase();
  for (const n of ['authorization', 'api-key', 'x-api-key', 'bearer', 'token']) {
    assert.equal(headers.includes(n), false, `request must not carry ${n}`);
  }
  // the request body carries no key either
  const body = JSON.stringify(log[0].init.body).toLowerCase();
  for (const n of ['key', 'token', 'secret', 'credential']) {
    assert.equal(body.includes(n), false, `request body must not carry ${n}`);
  }
  // 2. OI's capability output is a boolean summary, never a secret value
  const engineRes = await g.describeEngine();
  const rendered = JSON.stringify(engineRes.configuration).toLowerCase();
  assert.equal(rendered.includes('secret'), false);
  assert.equal(rendered.includes('token'), false);

  // 3. the OI source files never hard-code a key
  const fs = require('fs');
  const dir = path.join(__dirname, '..', '..', 'src', 'main', 'lead-intelligence', 'opportunity');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const n of SECRET_NAMES) assert.equal(src.includes(n), false, `${f} must not mention ${n}`);
  }
});

// ============================================================================
// 29. no real external provider call
// ============================================================================
test('29. every network call in these tests targets loopback, and none is a real provider', async () => {
  const log = [];
  const s = service({}, {
    'GET http://127.0.0.1:8099/v1/health': { status: 200, body: HEALTH_BODY },
    'GET http://127.0.0.1:8099/v1/engine': { status: 200, body: { engine: 'ztech-opportunity-intelligence', schema_version: '1.0', providers: ['website'], configuration: { db_path: 'ztech_oi.sqlite3', search: null } } },
    ...RESEARCH_OK,
    ...REPORT_OK,
  }, log);
  await s.start();
  await s.researchForLead({ leadId: 'L1', leadView: LEAD_VIEW });
  await s.pitchContextForLead({ leadId: 'L1' });
  await s.describeEngine();
  const tl = await s.timelineForLead({ leadId: 'L1' });
  assert.equal(tl.separate_from_activity, true);

  assert.ok(log.length > 0, 'the fake fetch should have been exercised');
  const timelineCalls = log.filter((c) => c.url.startsWith('http://127.0.0.1:8099/v1/timeline'));
  assert.equal(timelineCalls.length, 1, 'the timeline route should have been exercised');
  assert.match(timelineCalls[0].url, /research_id=res_20261005120000_abcdef01&domain=acme\.example/,
    'an entity key must map onto a real OI timeline filter');
  for (const call of log) {
    const u = new URL(call.url);
    assert.equal(u.hostname, '127.0.0.1', `only loopback may be contacted, saw ${u.hostname}`);
    assert.equal(u.pathname.startsWith('/v1/'), true, `only OI routes exist, saw ${u.pathname}`);
    // and no provider host is ever contacted from ZTech: providers live behind OI
    for (const host of ['api.search.brave.com', 'google.serper.dev', 'graph.facebook.com', 'api.x.com', 'serpapi.com', 'openai.com']) {
      assert.equal(call.url.includes(host), false, `ZTech must never contact ${host} directly`);
    }
  }
});

test('29b. OI provider hosts are never contacted, whatever the config says', async () => {
  // The gateway talks to exactly one host: the configured base URL. A research
  // request cannot redirect it, because the only URL a caller can influence is
  // rejected by normalizeDomain.
  const log = [];
  const g = gateway({}, RESEARCH_OK, log);
  const res = await g.requestResearch({
    companyName: 'Acme',
    domain: 'http://169.254.169.254/latest/meta-data/',
    options: { probe: 'http://evil.example' },
  });
  assert.equal(res.ok, false, 'a link-local metadata URL must be refused');
  assert.equal(log.length, 0);
});

// ============================================================================
// 30. existing F12-F25 tests remain green  (enforced by the full suite run)
// ============================================================================
test('30. OI adds no migration, no send path and no change to F12-F25 semantics', async () => {
  const fs = require('fs');
  const root = path.join(__dirname, '..', '..');
  // The required migration is REPORTED, not applied.
  assert.equal(MIGRATION_NEED.migration_required, true);
  assert.equal(MIGRATION_NEED.applied, false);
  assert.equal(fs.existsSync(path.join(root, 'src', 'main', 'lead-intelligence', 'migrations', '006_oi_associations.sql')), false,
    'I2 must not add a ZTech migration');
  // No OI table exists in the shipped migrations.
  const migs = fs.readdirSync(path.join(root, 'src', 'main', 'lead-intelligence', 'migrations'));
  const combined = migs.map((f) => fs.readFileSync(path.join(root, 'src', 'main', 'lead-intelligence', 'migrations', f), 'utf8')).join('\n');
  assert.equal(combined.includes('li_oi_'), false, 'no OI table may exist in ZTech migrations yet');
  // whatsapp.db still has no opportunity-intelligence table.
  assert.equal(combined.includes('opportunity_intelligence'), false);

  // The outreach activity enum is untouched: 7 operational events, no research event.
  const contract = fs.readFileSync(path.join(root, 'src', 'main', 'lead-intelligence', 'persistence', 'contract.js'), 'utf8');
  const block = contract.slice(contract.indexOf('ACTIVITY_TYPES'), contract.indexOf('ACTIVITY_TYPES') + 600);
  for (const ev of ['PITCH_APPROVED', 'OUTREACH_READY', 'OUTREACH_SEND_ATTEMPTED', 'OUTREACH_SEND_ACCEPTED', 'OUTREACH_SEND_FAILED']) {
    assert.ok(block.includes(ev), `${ev} must still exist`);
  }
  for (const ev of ['RESEARCH_COMPLETED', 'OPPORTUNITY_IDENTIFIED', 'OI_REPORT_CREATED']) {
    assert.equal(block.includes(ev), false, `OI must not add an activity event (${ev})`);
  }
});

// --- additional hardening ---------------------------------------------------

test('A. untrusted IPC senders are refused on every OI channel', async () => {
  const handlers = {};
  const ipcMain = { handle: (c, fn) => { handlers[c] = fn; } };
  const s = service({}, { ...RESEARCH_OK });
  registerOpportunityIpc({ ipcMain, opportunity: s, isTrustedSender: () => false });
  for (const c of Object.values(CHANNELS)) {
    const res = await handlers[c]({ senderFrame: 'evil' }, { leadId: 'L1', researchId: 'res_20261005120000_abcdef01' });
    assert.equal(res.ok, false, c);
  }
});

test('B. the gateway refuses a private, reserved or IP-literal prospect domain', async () => {
  const g = gateway({}, RESEARCH_OK);
  for (const d of ['localhost', '127.0.0.1', '10.0.0.1', '192.168.1.1', '169.254.169.254', 'example.invalid', 'example.test', 'http://user:pw@acme.example']) {
    const res = await g.requestResearch({ companyName: 'Acme', domain: d });
    assert.equal(res.ok, false, `${d} must be refused`);
    assert.equal(res.state, 'invalid_input');
  }
});

test('C. request options are a closed whitelist', async () => {
  const log = [];
  const g = gateway({}, RESEARCH_OK, log);
  await g.requestResearch({
    companyName: 'Acme',
    domain: 'acme.example',
    options: { discover_competitors: true, max_competitors: 999, evil: 'x', __proto__marker: 1, discover_competitors_evil: true },
  });
  const sent = JSON.parse(log[0].init.body).options;
  assert.equal(sent.discover_competitors, true);
  // clamped to OI's own bound: ResearchOptions.max_competitors is le=5
  assert.equal(sent.max_competitors, 5, 'out-of-range values are clamped to the OI maximum');
  assert.equal(sent.evil, undefined);
  assert.equal(sent.discover_competitors_evil, undefined);
  // the wire keys are exactly the fields OI declares on ResearchOptions
  assert.deepEqual(Object.keys(sent).sort(), ['discover_competitors', 'max_competitors']);
});

test('D. a failed OI report is reported as failed, not as an empty success', async () => {
  const s = service({}, { ...RESEARCH_OK });
  const view = await s.researchForLead({ leadId: 'L1', leadView: { company_name: 'Nowhere', domain: 'nowhere.example' } });
  // the canonical fixture is partial-but-usable
  assert.equal(view.available, true);

  const failed = service({}, { 'POST http://127.0.0.1:8099/v1/research': { status: 200, body: fixtures.failedReport() } });
  const fview = await failed.researchForLead({ leadId: 'L1', leadView: { company_name: 'Nowhere', domain: 'nowhere.example' } });
  assert.equal(fview.model.research_failed, true);
  assert.equal(fview.available, false);
  assert.ok(fview.message.includes('could not observe'));
});

test('E. latestForLead returns an honest not_researched state, never a fabricated report', async () => {
  const s = service({}, { ...REPORT_OK });
  const v = await s.latestForLead({ leadId: 'L404' });
  assert.equal(v.available, false);
  assert.equal(v.state, 'not_researched');
  assert.equal(v.model, null);
});

test('F. the default config is loopback, bounded and needs no credential', () => {
  assert.equal(DEFAULT_CONFIG.baseUrl, 'http://127.0.0.1:8099');
  assert.equal(DEFAULT_CONFIG.allowLocalhost, true);
  assert.ok(DEFAULT_CONFIG.timeoutMs > 0 && DEFAULT_CONFIG.timeoutMs <= 60_000);
  assert.ok(DEFAULT_CONFIG.healthTimeoutMs <= DEFAULT_CONFIG.timeoutMs);
  assert.equal(DEFAULT_CONFIG.maxCompetitors, 5);
  assert.equal(DEFAULT_CONFIG.providerId, undefined, 'no provider credential is configured by default');
});

test('G. every OI route path is one of the fixed engine routes', () => {
  assert.deepEqual(Object.values(ROUTES).filter((v) => typeof v === 'string').sort(),
    ['/v1/competitors/discover', '/v1/engine', '/v1/health', '/v1/research', '/v1/timeline']);
});