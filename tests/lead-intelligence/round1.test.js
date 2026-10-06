'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { makeClock, sampleLeads, makeLeadSource, makeTargetSource, DAY } = require('./helpers');
const { sampleEnvelope } = require('./fixtures/envelope');
const { MemoryStore } = require('../../src/main/lead-intelligence/persistence/MemoryStore');
const { createLeadIntelligence } = require('../../src/main/lead-intelligence/index');
const { normalizeRound1Record, ROUND1_STATE_MAP } = require('../../src/main/lead-intelligence/research/Round1ResearchBridge');
const { validateEvidencePacket } = require('../../src/main/lead-intelligence/contracts/evidencePacket');
const { registerLeadIntelligenceIpc, registerUnavailableLeadIntelligenceIpc } = require('../../src/main/lead-intelligence/ipc/registerLeadIntelligenceIpc');
const { CHANNELS: C, MODULE_ONLY_CHANNELS } = require('../../src/main/lead-intelligence/ipc/channels');
const { setupLeadIntelligence, accountStoreLeadSource } = require('../../src/main/lead-intelligence/integration/mainProcess');

/** Fake round-1 port over raw records shaped like an (assumed) prospect_research row. */
function fakeRound1() {
  const rows = [];
  const port = {
    rows,
    add(r) { rows.push(r); return r; },
    async getLatest(leadId) { return rows.filter((r) => String(r.lead_id) === String(leadId)).sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0] || null; },
    async listByLead(leadId) { return rows.filter((r) => String(r.lead_id) === String(leadId)).sort((a, b) => (a.created_at < b.created_at ? 1 : -1)); },
    async listLatestPerLead() {
      const m = new Map();
      for (const r of [...rows].sort((a, b) => (a.created_at < b.created_at ? 1 : -1))) if (!m.has(String(r.lead_id))) m.set(String(r.lead_id), r);
      return m;
    },
  };
  return port;
}

function record(id, leadId, status, extra = {}) {
  return { id, lead_id: leadId, job_id: `zj_${id}`, status, domain: 'acme.com', created_at: '2026-09-01T09:00:00.000Z', updated_at: '2026-09-01T09:05:00.000Z', completed_at: status === 'completed' ? '2026-09-01T09:05:00.000Z' : null, ...extra };
}

function setupA({ store = new MemoryStore(), clock = makeClock(), leads = sampleLeads(), round1 = fakeRound1(), config = {} } = {}) {
  const warnings = [];
  const li = createLeadIntelligence({
    store,
    leadSource: makeLeadSource(leads),
    targetSource: makeTargetSource(),
    round1,
    clock,
    logger: { warn: (m) => warnings.push(m), error() {}, info() {} },
    config: { research: { mode: 'round1' }, enrichment: { enableEvidenceProvider: true }, outreach: { allowedQualification: ['qualified'] }, offer: { sender_name: 'Zee', sender_company: 'ZuniTech', value_proposition: 'We fix audit issues.', call_to_action: 'Short call next week?' }, ...config },
  });
  return { li, store, clock, leads, round1, warnings };
}

test('round1: record normaliser — verified-style fields, JSON result string, unknown states stay unknown', () => {
  const n = normalizeRound1Record({ id: 7, lead_id: 3, job_id: 'zj_7', status: 'COMPLETED', domain: 'acme.com', created_at: 1693562400000, result_json: JSON.stringify({ a: 1 }) });
  assert.equal(n.recordId, '7');
  assert.equal(n.leadId, '3');
  assert.equal(n.state, 'complete');
  assert.deepEqual(n.result, { a: 1 });
  assert.equal(n.createdAt, '2023-09-01T10:00:00.000Z');
  assert.equal(normalizeRound1Record({ id: 1, lead_id: 1, status: 'teleporting' }).state, 'unknown');
  assert.equal(normalizeRound1Record({ status: 'completed' }), null);
  assert.equal(normalizeRound1Record({ id: 1, lead_id: 1, result: '{broken' }).result, undefined);
  assert.ok(ROUND1_STATE_MAP.quarantined === 'failed');
});

test('round1: a completed round-1 result becomes a valid EvidencePacket with round-1 provenance (idempotent)', async () => {
  const ctx = setupA();
  ctx.round1.add(record('r1', 'L1', 'completed', { result_json: JSON.stringify(sampleEnvelope()) }));
  const r = await ctx.li.research.sync({ leadId: 'L1' });
  assert.equal(r.synced, true);
  const p = await ctx.store.packets.latestForLead('L1');
  assert.equal(validateEvidencePacket(p).valid, true);
  assert.equal(p.provider.id, 'round1-zuni-seo');
  assert.equal(p.provider.provider_job_id, 'zj_r1');
  assert.equal(p.provenance.provider, 'round1-zuni-seo');
  assert.equal(p.digital_footprint.state, 'DIGITAL_FOOTPRINT_FOUND');
  assert.ok(p.facts.every((f) => f.provenance.provider === 'round1-zuni-seo' && f.provenance.lead_id === 'L1'));
  const again = await ctx.li.research.sync({ leadId: 'L1' });
  assert.deepEqual([again.synced, again.reason], [false, 'ALREADY_SYNCED']);
  assert.equal((await ctx.store.packets.listMetaByLead('L1')).length, 1);
});

test('round1: running / failed-without-result / malformed / wrong-site records never create evidence', async () => {
  const ctx = setupA();
  ctx.round1.add(record('a', 'L1', 'running'));
  assert.equal((await ctx.li.research.sync({ leadId: 'L1' })).reason, 'STATE_POLLING');
  ctx.round1.add(record('b', 'L3', 'failed', { created_at: '2026-09-01T10:00:00.000Z', domain: 'gamma-clinic.pk' }));
  assert.equal((await ctx.li.research.sync({ leadId: 'L3' })).reason, 'NO_RESULT');
  ctx.round1.add(record('c', 'L1', 'completed', { created_at: '2026-09-02T00:00:00.000Z', result_json: '{"junk":true}' }));
  assert.equal((await ctx.li.research.sync({ leadId: 'L1' })).reason, 'MALFORMED_RESULT');
  ctx.round1.add(record('d', 'L1', 'completed', { created_at: '2026-09-03T00:00:00.000Z', result_json: JSON.stringify(sampleEnvelope({ domain: 'evil.example' })) }));
  assert.equal((await ctx.li.research.sync({ leadId: 'L1' })).reason, 'DOMAIN_MISMATCH');
  assert.equal((await ctx.store.packets.listMetaByLead('L1')).length, 0);
  assert.ok(ctx.warnings.some((w) => /not converted: MALFORMED_RESULT/.test(w)));
  assert.equal((await ctx.li.research.sync({ leadId: 'L2' })).reason, 'NO_RECORD');
});

test('round1: syncAll converts only new finished results; change detection runs between runs', async () => {
  const ctx = setupA();
  ctx.round1.add(record('r1', 'L1', 'completed', { result_json: JSON.stringify(sampleEnvelope({ platform: 'WordPress' })) }));
  ctx.round1.add(record('r2', 'L3', 'running', { domain: 'gamma-clinic.pk' }));
  let s = await ctx.li.research.sync({});
  assert.deepEqual(s, { synced: 1, skipped: 1 });
  s = await ctx.li.research.sync({});
  assert.deepEqual(s, { synced: 0, skipped: 2 });
  ctx.round1.add(record('r3', 'L1', 'completed', { created_at: '2026-09-10T00:00:00.000Z', result_json: JSON.stringify(sampleEnvelope({ platform: 'Shopify', capturedAt: '2026-09-10T00:00:00Z' })) }));
  s = await ctx.li.research.sync({});
  assert.equal(s.synced, 1);
  const { changes, signals } = await ctx.li.research.changes({ leadId: 'L1' });
  assert.ok(changes.some((c) => c.type === 'fact_changed' && c.subject === 'tech.platform'));
  assert.ok(signals.some((x) => x.type === 'technology_change'));
});

test('round1: research state for profile, filters and ICP comes from round-1 records', async () => {
  const ctx = setupA();
  ctx.round1.add(record('r1', 'L1', 'completed', { result_json: JSON.stringify(sampleEnvelope()) }));
  ctx.round1.add(record('r2', 'L3', 'running', { domain: 'gamma-clinic.pk' }));
  ctx.round1.add(record('r3', 'L5', 'teleporting', { domain: 'x.example' }));
  const profile = await ctx.li.profile.build({ leadId: 'L1', targetId: 'T1' }); // lazy sync on read
  assert.equal(profile.research_status.state, 'complete');
  assert.equal(profile.research_status.job.provider_id, 'round1-zuni-seo');
  assert.equal(profile.evidence.packet.provider, 'round1-zuni-seo');
  assert.ok(profile.findings.length > 0);
  const running = await ctx.li.savedSearches.run({ filter: { research_status: ['polling'] } });
  assert.deepEqual(running.rows.map((r) => r.lead_id), ['L3']);
  const unknown = await ctx.li.savedSearches.run({ filter: { research_status: ['unknown'] } });
  assert.deepEqual(unknown.rows.map((r) => r.lead_id), ['L5']);
  const none = await ctx.li.savedSearches.run({ filter: { research_status: ['not_researched'] } });
  assert.deepEqual(none.rows.map((r) => r.lead_id).sort(), ['L2', 'L4']);
  ctx.clock.advance(31 * DAY);
  const stale = await ctx.li.profile.build({ leadId: 'L1' });
  assert.equal(stale.research_status.state, 'stale');
});

test('round1: agent, pitch, gate and enrichment work on bridged evidence', async () => {
  const ctx = setupA();
  ctx.round1.add(record('r1', 'L1', 'completed', { result_json: JSON.stringify(sampleEnvelope()) }));
  await ctx.li.research.sync({ leadId: 'L1' });
  const pitch = await ctx.li.outreach.generate({ leadId: 'L1', targetId: 'T1' });
  assert.equal(pitch.status, 'draft');
  assert.ok(pitch.observations.every((o) => o.refs.length > 0));
  await ctx.li.outreach.approve({ pitchId: pitch.pitch_id });
  assert.equal((await ctx.li.outreach.gate({ pitchId: pitch.pitch_id })).decision, 'allowed');
  const e = await ctx.li.enrichment.request({ leadId: 'L1', fields: ['website.platform'] });
  assert.equal(e.outcome, 'started');
  await ctx.li.enrichment.idle();
  const ep = await ctx.li.enrichment.profile({ leadId: 'L1' });
  assert.equal(ep.fields['website.platform'].selected.value, 'Shopify');
  const agent = await ctx.li.agent.analyze({ leadId: 'L1' });
  assert.ok(agent.observations.length > 0);
});

test('round1 IPC: research-control channels are not registered; export defaults to renderer download', async () => {
  const ctx = setupA();
  ctx.round1.add(record('r1', 'L1', 'completed', { result_json: JSON.stringify(sampleEnvelope()) }));
  const handlers = new Map();
  const reg = registerLeadIntelligenceIpc({ ipcMain: { handle: (c, f) => handlers.set(c, f), removeHandler: (c) => handlers.delete(c) }, li: ctx.li, isTrustedSender: () => true, logger: { warn() {} } });
  for (const ch of MODULE_ONLY_CHANNELS) assert.ok(!reg.channels.includes(ch), ch);
  assert.equal(reg.channels.length, Object.keys(C).length - MODULE_ONLY_CHANNELS.length - 1); // minus email-send
  assert.ok(reg.channels.every((c) => /^lead-intel:[a-z]+(?:-[a-z]+)*$/.test(c)), 'domain:verb-kebab-case');
  const ev = await handlers.get(C.EVIDENCE_GET)({}, { leadId: 'L1' });
  assert.equal(ev.data.provider.id, 'round1-zuni-seo');
  const ex = await handlers.get(C.EXPORT_RESEARCH)({}, { scope: { leadIds: ['L1'] }, format: 'csv' });
  assert.equal(ex.data.mode, 'renderer-download');
  assert.equal(ex.data.mimeType, 'text/csv');
  assert.match(ex.data.content, /round1-zuni-seo/);
  assert.ok(!/token|password|apikey/i.test(ex.data.content));
  reg.dispose();
  assert.equal(handlers.size, 0);
});

test('JSON fallback: every channel answers NOT_AVAILABLE and nothing is persisted', async () => {
  const handlers = new Map();
  const r = await setupLeadIntelligence({ ipcMain: { handle: (c, f) => handlers.set(c, f), removeHandler() {} }, db: null, isTrustedSender: (e) => Boolean(e && e.ok), config: {} });
  assert.equal(r.available, false);
  assert.equal(handlers.size, Object.keys(C).length);
  const res = await handlers.get(C.PROFILE_GET)({ ok: true }, { leadId: 'L1' });
  assert.equal(res.error.code, 'NOT_AVAILABLE');
  assert.equal((await handlers.get(C.PROFILE_GET)({ ok: false }, {})).error.code, 'FORBIDDEN');
  const direct = registerUnavailableLeadIntelligenceIpc({ ipcMain: { handle() {}, removeHandler() {} }, isTrustedSender: () => true });
  assert.equal(direct.channels.length, Object.keys(C).length);
});

let initSqlJs = null;
try { initSqlJs = require('sql.js'); } catch { initSqlJs = null; }

test('setupLeadIntelligence: round1 wiring on a real sql.js db (migrates, registers, syncs)', { skip: initSqlJs ? false : 'sql.js not installed' }, async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  let saves = 0;
  const round1 = fakeRound1();
  round1.add(record('r1', 'L1', 'completed', { result_json: JSON.stringify(sampleEnvelope()) }));
  const handlers = new Map();
  const r = await setupLeadIntelligence({
    ipcMain: { handle: (c, f) => handlers.set(c, f), removeHandler() {} },
    db,
    persist: () => { saves += 1; },
    leadSource: makeLeadSource(sampleLeads()),
    targetSource: makeTargetSource(),
    round1,
    isTrustedSender: () => true,
    config: { research: { mode: 'module' } }, // forced to round1 by setup
    logger: { warn() {}, error() {}, info() {} },
  });
  r.li.stop();
  assert.equal(r.li.mode, 'round1');
  assert.ok(!handlers.has(C.RESEARCH_REQUEST));
  const prof = await handlers.get(C.PROFILE_GET)({}, { leadId: 'L1' });
  assert.equal(prof.ok, true);
  assert.equal(prof.data.evidence.packet.provider, 'round1-zuni-seo');
  assert.ok(saves > 0);
});

// F11: the id contract is that queryNumbers receives a STRING. AccountStore
// validates `id` with `typeof q.id === 'string'` and returns an EMPTY envelope
// for anything else, so a numeric id is a silent miss, not a lookup. The mock
// below reproduces that guard rather than accepting any type, so this test can
// no longer confirm a caller that coerces the id to a number.
test('accountStoreLeadSource: digit-only ids are passed through as strings', async () => {
  const calls = [];
  const src = accountStoreLeadSource({
    queryNumbers: async (q) => {
      calls.push(q);
      // Mirrors accountStore.js "B3 single-lead lookup": a non-string id
      // short-circuits to an empty envelope.
      if (q.id !== undefined && typeof q.id !== 'string') {
        return { rows: [], total: 0, limit: q.limit, offset: q.offset };
      }
      return { rows: q.id === '5' ? [{ id: '5', title: 'X' }] : [], total: 1, limit: 1, offset: 0 };
    },
    getCollectedNumbers: async () => [{ id: '5' }],
  });
  assert.deepEqual(await src.getLead('5'), { id: '5', title: 'X' });
  assert.deepEqual(await src.getLead(5), { id: '5', title: 'X' }, 'a numeric id resolves too');
  assert.equal(await src.getLead('abc'), null);
  assert.deepEqual(calls.map((c) => c.id), ['5', '5', 'abc'], 'every id reaches queryNumbers as a string');
  assert.equal((await src.listLeads()).length, 1);
});

test('renderer: UMD files attach to the browser global in import order (what index.mjs relies on)', () => {
  const dir = path.join(__dirname, '..', '..', 'src', 'renderer', 'lead-intelligence');
  const sandbox = {};
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
const order = [...fs.readFileSync(path.join(dir, 'index.mjs'), 'utf8').matchAll(/^import '\.\/([\w]+\.js)';$/gm)].map((m) => m[1]);
    // Opportunity Intelligence renders natively in the F5 drawer (renderer.js), so it
    // is deliberately NOT one of these UMD modules: one OI implementation, not two.
    assert.deepEqual(order, ['dom.js', 'researchSection.js', 'listsPanels.js', 'pitchPanel.js', 'enrichmentSection.js']);
    for (const f of order) vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), sandbox, { filename: f });
    const LI = sandbox.ZTechLI;
    assert.equal(typeof LI.dom.h, 'function');
    assert.equal(typeof LI.researchSection.mountResearchSection, 'function');
    assert.equal(typeof LI.listsPanels.mountSegmentsPanel, 'function');
    assert.equal(typeof LI.pitchPanel.mountPitchPanel, 'function');
    assert.equal(typeof LI.enrichmentSection.mountEnrichmentSection, 'function');
    assert.equal(LI.opportunitySection, undefined);
});
