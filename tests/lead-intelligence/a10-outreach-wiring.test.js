'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { zuniV1Packet, round1Record } = require('./fixtures/round1Record');
const { round1PacketMapper, DEFAULTS, detectDialect } = require('../../src/main/lead-intelligence/round1PacketMapper');
const { Round1ResearchBridge, normalizeRound1Record } = require('../../src/main/lead-intelligence/research/Round1ResearchBridge');
const { initializeLeadIntelligenceRuntime, createRound1Port, LI_TABLES } = require('../../src/main/lead-intelligence/lead-intelligence-runtime');
const { registerOutreachIpc, CHANNELS: OUTREACH_CHANNELS } = require('../../src/main/lead-intelligence/outreach-ipc');
const { MemoryStore } = require('../../src/main/lead-intelligence/persistence/MemoryStore');
const { createLeadIntelligence } = require('../../src/main/lead-intelligence/index');
const { validateEvidencePacket } = require('../../src/main/lead-intelligence/contracts/evidencePacket');
const { validateProviderResult } = require('../../src/main/lead-intelligence/providers/ProspectResearchProvider');
const { FreshnessPolicy } = require('../../src/main/lead-intelligence/research/FreshnessPolicy');
const { detectChangesDetailed } = require('../../src/main/lead-intelligence/research/changeDetection');
const { NotFoundError } = require('../../src/main/lead-intelligence/core/errors');
const { SECRET_KEY } = require('../../src/main/lead-intelligence/core/objects');
const { FakeEmailProvider } = require('../../src/main/lead-intelligence/outreach/email/FakeEmailProvider');

const ROOT = path.join(__dirname, '..', '..');
const CLOCK_ISO = '2026-09-01T10:00:00.000Z';
const SILENT = { warn() {}, error() {}, info() {} };

function makeClock(startIso = CLOCK_ISO) {
  let now = new Date(startIso);
  const clock = () => new Date(now.getTime());
  clock.advance = (ms) => { now = new Date(now.getTime() + ms); return clock(); };
  return clock;
}

/** A lead that satisfies every existing gate requirement. */
const LEADS = {
  5: {
    id: 5, title: 'Acme Bakery', website: 'https://acme.com', email: 'hello@acme.com',
    phone: '+92 300 1234567', address: '12 Road', qualification: 'qualified',
  },
};

function makeLeadSource(leads = LEADS) {
  return { getLead: async (id) => leads[String(id)] || null, listLeads: async () => Object.values(leads) };
}

/** Read-only Round-1 port over in-memory records. */
function fakeRound1Port(records = []) {
  const rows = [...records];
  const norm = (r) => (r ? normalizeRound1Record({
    id: r.id,
    lead_ref: r.leadRef,
    provider_job_id: r.providerJobId,
    status: r.phase,
    domain: r.website,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
    completed_at: r.finishedAt,
    error_code: r.failureReason,
    error_message: r.failureMessage,
    result: r.packet,
  }) : null);
  const byNewest = (a, b) => (a.updatedAt < b.updatedAt ? 1 : -1);
  return {
    rows,
    async getLatest(leadId) {
      return rows.filter((r) => String(r.leadRef) === String(leadId)).sort(byNewest)[0] || null;
    },
    async listByLead(leadId) {
      return rows.filter((r) => String(r.leadRef) === String(leadId)).sort(byNewest);
    },
    async listLatestPerLead() {
      const m = new Map();
      for (const r of [...rows].sort(byNewest)) if (!m.has(String(r.leadRef))) m.set(String(r.leadRef), r);
      return m;
    },
    // The port exposes reads only: it has no way to mutate the engine.
    _norm: norm,
  };
}

function makeBridge(opts = {}) {
  const { mapper, ...rest } = opts;
  return new Round1ResearchBridge({
    round1: rest.round1 || fakeRound1Port(),
    store: rest.store || new MemoryStore(),
    leadSource: makeLeadSource(),
    freshness: new FreshnessPolicy({ completeMaxAgeDays: 30, partialMaxAgeDays: 7 }),
    clock: rest.clock || makeClock(),
    logger: rest.logger || SILENT,
    ...('mapper' in opts ? { mapper } : {}),
  });
}

// ============================================================ 1. round1PacketMapper

test('A10 mapper: a genuine Round-1 v1 packet maps every field to the EvidencePacket shape', () => {
  const record = normalizeRound1Record({
    id: 'r1_0001', lead_ref: '5', provider_job_id: 'job_0123456789abcdef', status: 'complete',
    domain: 'https://acme.com', created_at: CLOCK_ISO, updated_at: CLOCK_ISO, result: zuniV1Packet(),
  });
  assert.equal(detectDialect(record.result), 'zuni-v1');

  const result = round1PacketMapper(record, { requestedDomain: 'acme.com', providerJobId: 'job_0123456789abcdef' });
  assert.equal(validateProviderResult(result).valid, true, JSON.stringify(validateProviderResult(result).errors));

  // provenance / run metadata
  assert.equal(result.contractVersion, '1.0');
  assert.equal(result.engineVersion, '1.4.2');
  assert.equal(result.capturedAt, '2026-09-01T10:00:00.000Z');
  assert.equal(result.outcome, 'complete');
  assert.equal(result.providerJobId, 'job_0123456789abcdef');
  assert.equal(result.requestedDomain, 'acme.com');

  // fact key = fact ID (the documented explicit default)
  const byKey = Object.fromEntries(result.facts.map((f) => [f.key, f]));
  assert.deepEqual(Object.keys(byKey).sort(), ['f001', 'f002', 'f003'], 'fact key is the fact ID');
  assert.equal(byKey.f002.value, 'Shopify');
  assert.equal(byKey.f002.label, 'The site is built on Shopify.');

  // finding field mapping: observation -> observed, affectedUrls -> urls, factIds -> refs
  const finding = result.findings.find((g) => g.ruleId === 'meta_description_missing');
  assert.ok(finding, 'the v1 finding_id became the rule id');
  assert.equal(finding.title, 'Pages without a meta description');
  assert.equal(finding.severity, 'medium');
  assert.equal(finding.observed, '4 of 14 pages have no meta description.');
  assert.deepEqual(finding.urls, ['https://www.acme.com/a', 'https://www.acme.com/b']);
  assert.deepEqual(finding.factKeys, ['f003'], 'factIds resolve to real fact keys');
  assert.match(finding.recommendation, /meta description/i);
});

test('A10 mapper: documented defaults apply — unknown basis, ai_access -> other, no_crawlable_content -> failed', () => {
  // A packet whose availability says "no crawlable content" is a FAILED outcome,
  // whatever the provider's job status said.
  const record = normalizeRound1Record({
    id: 'r1', lead_ref: '5', status: 'complete', domain: 'acme.com',
    created_at: CLOCK_ISO, updated_at: CLOCK_ISO,
    result: zuniV1Packet({ availability: 'no_crawlable_content', status: 'partial' }),
  });
  const result = round1PacketMapper(record, { requestedDomain: 'acme.com' });
  assert.equal(result.outcome, 'failed', 'no_crawlable_content maps to the failed outcome');
  assert.equal(result.areas[DEFAULTS.aiAccessArea], DEFAULTS.areaStatus, 'the ai_access area is explicitly unknown');

  // A GENUINE v1 basis is preserved; only a basis the contract cannot express
  // (v1 "observed") or an absent one becomes `unknown`. Neither is invented.
  const withBasis = round1PacketMapper(normalizeRound1Record({
    id: 'r1', lead_ref: '5', status: 'complete', domain: 'acme.com', created_at: CLOCK_ISO, updated_at: CLOCK_ISO,
    result: zuniV1Packet(),
  }), { requestedDomain: 'acme.com' });
  const standard = withBasis.findings.find((g) => g.ruleId === 'meta_description_missing');
  const observed = withBasis.findings.find((g) => g.ruleId === 'slow_server_response');
  assert.equal(standard.basis, 'standard', 'a genuine standard basis survives');
  assert.equal(observed.basis, DEFAULTS.observedBasis, 'an observed basis becomes unknown, never "standard"');

  // No basis at all: the explicit default, never a guess.
  const basisless = JSON.parse(JSON.stringify(zuniV1Packet()));
  delete basisless.findings[0].basis;
  delete basisless.findings[1].basis;
  const mapped = round1PacketMapper(normalizeRound1Record({
    id: 'r1', lead_ref: '5', status: 'complete', domain: 'acme.com', created_at: CLOCK_ISO, updated_at: CLOCK_ISO,
    result: basisless,
  }), { requestedDomain: 'acme.com' });
  for (const g of mapped.findings) assert.equal(g.basis, DEFAULTS.observedBasis, 'no basis is invented');

  // The flat/legacy dialect keeps the SAME defaults, so neither dialect guesses.
  const flat = normalizeRound1Record({
    id: 'r1', lead_ref: '5', status: 'complete', domain: 'acme.com', created_at: CLOCK_ISO, updated_at: CLOCK_ISO,
    result: {
      contract_version: 'zseo.evidence-envelope/1', engine: { version: '0.14.0' }, status: 'complete',
      captured_at: CLOCK_ISO, target: { requested_url: 'https://acme.com' }, coverage: { tech: 'measured' },
      facts: [{ key: 'platform', value: 'Shopify' }],
      findings: [{ id: 'no_title', title: 'No title', severity: 'nonsense', observed: 'x' }],
    },
  });
  assert.equal(detectDialect(flat.result), 'flat');
  const flatResult = round1PacketMapper(flat, { requestedDomain: 'acme.com' });
  assert.equal(flatResult.findings[0].severity, DEFAULTS.severity, 'an unrecognised severity is not guessed');
  assert.equal(flatResult.findings[0].basis, DEFAULTS.observedBasis);
  assert.deepEqual(flatResult.findings[0].urls, [], 'a missing affected-url list yields none, not an invented one');
  assert.equal(flatResult.areas[DEFAULTS.aiAccessArea], DEFAULTS.areaStatus);
});

test('A10 mapper: unestablished values stay unavailable; malformed input throws instead of guessing', () => {
  // No packet at all.
  assert.throws(() => round1PacketMapper(normalizeRound1Record({ id: 'r', lead_ref: '5', status: 'complete' })), /carries no packet envelope/);
  assert.throws(() => round1PacketMapper(null), /not an object/);
  // A packet matching no known dialect is refused, never half-mapped.
  const unknown = normalizeRound1Record({
    id: 'r', lead_ref: '5', status: 'complete', created_at: CLOCK_ISO, updated_at: CLOCK_ISO,
    result: { somethingElse: true },
  });
  assert.equal(detectDialect(unknown.result), 'unknown');
  assert.throws(() => round1PacketMapper(unknown, { requestedDomain: 'acme.com' }), /no known envelope dialect/);
  // A v1 packet with no facts/findings maps to an empty, valid result: not measured, not invented.
  const bare = normalizeRound1Record({
    id: 'r', lead_ref: '5', status: 'complete', domain: 'acme.com', created_at: CLOCK_ISO, updated_at: CLOCK_ISO,
    result: { contract_version: '1.0', run: { engine_version: '1.4.2', status: 'done', captured_at: CLOCK_ISO }, subject: { requested_url: 'https://acme.com' }, facts: [], findings: [], strengths: [], not_measured: [], limits: [] },
  });
  const bareResult = round1PacketMapper(bare, { requestedDomain: 'acme.com' });
  assert.deepEqual(bareResult.facts, []);
  assert.deepEqual(bareResult.findings, []);
  assert.equal(validateProviderResult(bareResult).valid, true);
  // A finding citing a fact id the record does not carry keeps only resolvable refs.
  const dangling = normalizeRound1Record({
    id: 'r', lead_ref: '5', status: 'complete', domain: 'acme.com', created_at: CLOCK_ISO, updated_at: CLOCK_ISO,
    result: {
      ...zuniV1Packet(), facts: [],
      findings: [{ finding_id: 'x', title: 'T', severity: 'high', observation: 'o', affected_urls: [], fact_ids: ['f003'] }],
    },
  });
  assert.deepEqual(round1PacketMapper(dangling, { requestedDomain: 'acme.com' }).findings[0].factKeys, []);
});

// ============================================================ 2. Round1ResearchBridge

test('A10 bridge: the mapper is injectable, and a completed record becomes a valid EvidencePacket', async () => {
  const store = new MemoryStore();
  const round1 = fakeRound1Port([round1Record()]);
  let seen = null;
  const bridge = makeBridge({
    round1, store,
    mapper: (rec, ctx) => { seen = { rec, ctx }; return round1PacketMapper(rec, ctx); },
  });
  const result = await bridge.syncLead('5');
  assert.equal(result.synced, true);
  assert.ok(seen, 'the injected mapper is the one the bridge calls');
  assert.equal(seen.ctx.requestedDomain, 'acme.com', 'the bridge supplies the resolved domain');

  const packet = await store.packets.latestForLead('5');
  assert.equal(validateEvidencePacket(packet).valid, true);
  assert.equal(packet.lead_id, '5');
  assert.equal(packet.provider.id, 'round1-zuni-seo');
  assert.ok(packet.facts.length >= 3, 'the v1 facts reached the packet');
  assert.ok(packet.findings.some((g) => g.title === 'Pages without a meta description'));
  assert.ok(packet.findings.every((g) => g.provenance.lead_id === '5'));
});

test('A10 bridge: a non-function mapper is refused at construction', () => {
  assert.throws(() => makeBridge({ round1: fakeRound1Port(), mapper: 'not-a-function' }), /mapper must be a function/);
  assert.throws(() => makeBridge({ round1: fakeRound1Port(), mapper: null }), /mapper must be a function/);
  // A Round-1 port missing a method is still refused, as before.
  assert.throws(() => makeBridge({ round1: { getLatest: async () => null } }), /missing listByLead/);
});

test('A10 bridge: malformed records, wrong websites and unfinished phases never create evidence', async () => {
  const cases = [
    { name: 'malformed packet', record: round1Record({ id: 'm', leadRef: '5', packet: { junk: true } }), reason: 'MALFORMED_RESULT' },
    // The record asked for acme.com but the stored packet is about another site.
    { name: 'wrong website', record: round1Record({ id: 'w', leadRef: '5', packet: zuniV1Packet({ domain: 'evil.example' }) }), reason: 'DOMAIN_MISMATCH' },
    { name: 'still polling', record: round1Record({ id: 'p', leadRef: '5', phase: 'polling' }), reason: 'STATE_POLLING', reported: false },
    { name: 'no packet', record: round1Record({ id: 'n', leadRef: '5', phase: 'failed', packet: null }), reason: 'NO_RESULT', reported: false },
  ];
  for (const c of cases) {
    const store = new MemoryStore();
    const warnings = [];
    const bridge = makeBridge({ round1: fakeRound1Port([c.record]), store, logger: { ...SILENT, warn: (m) => warnings.push(m) } });
    const r = await bridge.syncLead('5');
    assert.equal(r.synced, false, c.name);
    assert.equal(r.reason, c.reason, c.name);
    assert.equal((await store.packets.listMetaByLead('5')).length, 0, c.name + ' created no packet');
    // A record that could never be converted (malformed / wrong site) is reported.
    if (c.reported !== false) {
      assert.ok(warnings.some((w) => w.includes(`not converted: ${c.reason}`)), c.name + ' is reported');
    }
  }
  // A lead with no record at all.
  const empty = new MemoryStore();
  assert.equal((await makeBridge({ round1: fakeRound1Port([]), store: empty }).syncLead('5')).reason, 'NO_RECORD');
});

test('A10 bridge: sync is idempotent and a new Round-1 record is detected as a change', async () => {
  const store = new MemoryStore();
  const round1 = fakeRound1Port([round1Record()]);
  const bridge = makeBridge({ round1, store });

  assert.equal((await bridge.syncLead('5')).synced, true);
  const first = await store.packets.latestForLead('5');
  const again = await bridge.syncLead('5');
  assert.deepEqual([again.synced, again.reason], [false, 'ALREADY_SYNCED']);
  assert.equal(again.packet_id, first.packet_id);
  assert.equal((await store.packets.listMetaByLead('5')).length, 1, 'no duplicate packet');

  // A later Round-1 run for the same lead is a change, not a no-op.
  const second = zuniV1Packet({ capturedAt: '2026-09-08T10:00:00.000Z' });
  second.subject.audited_url = 'https://shop.acme.com/';
  round1.rows.push(round1Record({
    id: 'r1_0002', phase: 'complete', providerJobId: 'job_fedcba9876543210', packet: second,
    createdAt: '2026-09-08T10:00:00.000Z', updatedAt: '2026-09-08T10:00:00.000Z',
  }));
  const res = await bridge.syncLead('5');
  assert.equal(res.synced, true);
  const latest = await store.packets.latestForLead('5');
  assert.notEqual(latest.packet_id, first.packet_id, 'a new Round-1 record produces a new packet');
  assert.equal((await store.packets.listMetaByLead('5')).length, 2);

  // Change detection ran between the two packets and reported the real change.
  const li = createLeadIntelligence({
    store, leadSource: makeLeadSource(), round1, config: { research: { mode: 'round1' } },
    clock: makeClock(), logger: SILENT, round1ResultMapper: round1PacketMapper,
  });
  const { changes } = await li.research.changes({ leadId: '5' });
  assert.ok(changes.some((c) => c.type === 'domain_changed' && c.subject === 'audited_domain'),
    JSON.stringify(changes.map((c) => c.type + ':' + c.subject)));

  // A Round-1 v1 fact carries no canonical ZTech area, so it is honestly reported
  // as NOT comparable instead of being compared against a guessed area.
  const detailed = detectChangesDetailed(first, latest, { now: makeClock()() });
  assert.ok(detailed.insufficient.some((i) => i.subject.startsWith('fact:f00')),
    'facts without a measured area are reported as insufficient, never guessed');
});

test('A10 bridge: the read-only port delegates without mutating or controlling Round-1', async () => {
  const record = round1Record();
  const round1 = fakeRound1Port([record]);
  const bridge = makeBridge({ round1 });
  assert.equal((await bridge.getLatest('5')).id, record.id);
  assert.equal((await bridge.listByLead('5')).length, 1);
  assert.equal((await bridge.listLatestPerLead()).get('5').id, record.id);
  // The bridge itself has no way to start, poll or retry Round-1 research.
  for (const forbidden of ['requestResearch', 'start', 'step', 'resume', 'runDue', 'tick', 'advance']) {
    assert.equal(typeof bridge[forbidden], 'undefined', `the bridge must not expose ${forbidden}()`);
  }
});

// ============================================================ 3. Lead Intelligence runtime

let initSqlJs = null;
try { initSqlJs = require('sql.js'); } catch { initSqlJs = null; }

/** A minimal AccountStore stand-in over a real sql.js handle. */
function fakeAccountStore(db, { readyDelayMs = 0 } = {}) {
  let saves = 0;
  return {
    db,
    saves: () => saves,
    ready: readyDelayMs ? new Promise((r) => setTimeout(r, readyDelayMs)) : Promise.resolve(),
    saveDB() { saves += 1; },
    queryNumbers: async (q) => ({ rows: q && q.id != null && String(q.id) === '5' ? [LEADS[5]] : [], total: 0, limit: 1, offset: 0 }),
    getCollectedNumbers: async () => Object.values(LEADS),
    listTargets: async () => ({ rows: [] }),
  };
}

test('A10 runtime: initialises only after AccountStore readiness, on the shared db, without a timer', { skip: initSqlJs ? false : 'sql.js not installed' }, async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  // A pre-existing ZTech table must survive untouched.
  db.run('CREATE TABLE numbers (id INTEGER PRIMARY KEY, phone TEXT)');
  db.run("INSERT INTO numbers (id, phone) VALUES (5, '+923001234567')");

  // A10 must not create a timer of any kind. The spy is installed AFTER the
  // fixture's own `ready` delay is set up, so only A10's own calls are counted.
  let readyResolved = false;
  const accountStore = fakeAccountStore(db, { readyDelayMs: 25 });
  accountStore.ready.then(() => { readyResolved = true; });

  const realSetInterval = globalThis.setInterval;
  const realSetTimeout = globalThis.setTimeout;
  const created = { interval: 0, timeout: 0 };
  globalThis.setInterval = function (...args) { created.interval += 1; return realSetInterval.apply(this, args); };
  globalThis.setTimeout = function (...args) { created.timeout += 1; return realSetTimeout.apply(this, args); };

  let runtime;
  try {
    runtime = await initializeLeadIntelligenceRuntime({
      accountStore, config: { freshness: { completeMaxAgeDays: 30, partialMaxAgeDays: 7 } }, logger: SILENT,
    });
  } finally {
    globalThis.setInterval = realSetInterval;
    globalThis.setTimeout = realSetTimeout;
  }

  assert.equal(readyResolved, true, 'the runtime waits for accountStore.ready');
  assert.equal(runtime.li.mode, 'round1', 'round-1 is the only research engine');
  assert.equal(runtime.li.gateway, null, 'no module-mode research gateway is created');
  assert.ok(runtime.li.bridge, 'the Round1ResearchBridge is connected');
  assert.equal(created.interval, 0, 'A10 creates no interval');
  assert.equal(created.timeout, 0, 'A10 creates no timeout');
  assert.equal(runtime.available, true);

  await runtime.shutdown();
  assert.equal(runtime.available, false);
});

test('A10 runtime: runs the additive li_* migrations (001-012) on whatsapp.db and changes no ZTech table', { skip: initSqlJs ? false : 'sql.js not installed' }, async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run('CREATE TABLE numbers (id INTEGER PRIMARY KEY, phone TEXT, title TEXT)');
  db.run("INSERT INTO numbers (id, phone, title) VALUES (5, '+923001234567', 'Acme Bakery')");
  db.run('CREATE TABLE targets (id TEXT PRIMARY KEY, name TEXT)');
  db.run('CREATE TABLE saved_searches (id TEXT PRIMARY KEY, name TEXT)');
  const ztechBefore = db.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")[0].values.flat();
  const tableNames = () => db.exec("SELECT name FROM sqlite_master WHERE type='table'").flatMap((r) => r.values.flat());

  const accountStore = fakeAccountStore(db);
  const runtime = await initializeLeadIntelligenceRuntime({ accountStore, logger: SILENT });

  const tables = tableNames();
  const created = tables.filter((t) => t.startsWith('li_'));
  // F19 declared lock update: 12 -> 13 additive li_* tables, adding the send ledger.
  // I3 declared lock update: 13 -> 14, adding li_oi_associations (OI ids only, migration 006).
  // I5 declared lock update: 14 -> 15, adding li_oi_refresh_requests (migration 007).
  // F26.5 declared lock update: 15 -> 20, adding the five trust tables of migration 008.
  // F26.6 declared lock update: 20 -> 23, adding li_mailboxes, li_mailbox_sent, li_market_rules (010).
  // F26.6 follow-up declared lock update: 23 -> 24, adding li_reply_reviews (011).
  // F28 declared lock update: 24 -> 29, adding li_sequences, li_sequence_steps, li_sequence_events, li_sequence_control, li_sequence_gaps (012).
  // F29 declared lock update: 29 -> 30, adding li_reply_routes (013; ids, codes and times only).
  assert.equal(LI_TABLES.length, 30, 'thirty additive LI tables are declared');
  for (const t of LI_TABLES) assert.ok(tables.includes(t), 'missing additive table: ' + t);
  assert.equal(tables.filter((t) => String(t).startsWith('li_')).length, 30, 'exactly the thirty li_* tables were added');

  // Every pre-existing ZTech table is still present and its data is intact.
  const ztechAfter = db.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")[0].values.flat();
  for (const t of ztechBefore) assert.ok(ztechAfter.includes(t), 'ZTech table was dropped: ' + t);
  assert.equal(db.exec('SELECT phone, title FROM numbers')[0].values[0][0], '+923001234567');
  // No LI migration touched the ZTech lead row.
  assert.equal(accountStore.saves() > 0, true, 'the shared db is flushed through accountStore.saveDB()');
  await runtime.shutdown();

  // Migrations are idempotent: a second init adds nothing.
  const again = await initializeLeadIntelligenceRuntime({ accountStore, logger: SILENT });
  assert.equal(tableNames().filter((t) => String(t).startsWith('li_')).length, 30); // F29 declared lock update 29 -> 30 (li_reply_routes); F28 declared lock update 24 -> 29 (five sequence tables); F26.6 follow-up 23 -> 24; F19 12 -> 13; I3 13 -> 14; I5 14 -> 15; F26.5 15 -> 20 (five trust tables); F26.6 20 -> 23
  await again.shutdown();
});

test('A10 runtime: refuses to run without an open database, and li.start() is never called', { skip: initSqlJs ? false : 'sql.js not installed' }, async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  const closedStore = fakeAccountStore(db);
  closedStore.db = null;
  await assert.rejects(initializeLeadIntelligenceRuntime({ accountStore: closedStore, logger: SILENT }), /database is not open/);
  await assert.rejects(initializeLeadIntelligenceRuntime({ logger: SILENT }), /accountStore is required/);

  // A spy proves the runtime itself never starts background work.
  const accountStore = fakeAccountStore(db);
  const runtime = await initializeLeadIntelligenceRuntime({ accountStore, logger: SILENT });
  let started = false;
  const original = runtime.li.start;
  runtime.li.start = () => { started = true; return original(); };
  await runtime.li.outreach.generate({ leadId: '5' });
  await runtime.li.outreach.gate({ pitchId: 'p' }).catch(() => {});
  assert.equal(started, false, 'li.start() is not called by the runtime or by outreach operations');
  await runtime.shutdown();
});

test('A10 runtime: the Round-1 port reads the existing prospect_research table read-only', { skip: initSqlJs ? false : 'sql.js not installed' }, async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(`CREATE TABLE prospect_research (id TEXT PRIMARY KEY, lead_ref TEXT NOT NULL, provider_id TEXT NOT NULL,
    phase TEXT NOT NULL, next_attempt_at TEXT, updated_at TEXT NOT NULL, version INTEGER NOT NULL, record_json TEXT NOT NULL)`);
  const record = round1Record();
  db.run('INSERT INTO prospect_research VALUES (?,?,?,?,?,?,?,?)', [
    record.id, record.leadRef, record.providerId, record.phase, record.nextAttemptAt,
    record.updatedAt, record.version, JSON.stringify(record),
  ]);
  const before = db.exec('SELECT record_json FROM prospect_research')[0].values[0][0];

  const port = createRound1Port(db);
  assert.equal((await port.getLatest('5')).id, record.id);
  assert.equal((await port.listByLead('5')).length, 1);
  assert.equal((await port.listLatestPerLead()).get('5').id, record.id);
  assert.equal(await port.getLatest('does-not-exist'), null);
  assert.equal((await port.listByLead('does-not-exist')).length, 0);

  // Reads only: the port has no write method and the row is byte-identical.
  assert.equal(db.exec('SELECT record_json FROM prospect_research')[0].values[0][0], before);
  for (const forbidden of ['insert', 'update', 'step', 'request', 'start']) {
    assert.equal(typeof port[forbidden], 'undefined', 'the port must not expose ' + forbidden);
  }
  assert.throws(() => createRound1Port(null), /open database/);
});

// ============================================================ 4. IPC

function makeIpcHarness(outreach, { trusted = true } = {}) {
  const handlers = new Map();
  const reg = registerOutreachIpc({
    ipcMain: { handle: (c, f) => handlers.set(c, f), removeHandler: (c) => handlers.delete(c) },
    outreach,
    isTrustedSender: () => trusted,
    logger: SILENT,
  });
  return { handlers, reg };
}

// F21 declared lock update: the read-only send-ledger read was added alongside the send
  // boundary. It is a read, so the "no batch/queue/schedule/campaign channel" invariant
  // holds. The channel name is the singular send channel plus an "s".
  test('A10 IPC: the approved channels plus the single F19 send boundary are registered; email-send is not', () => {
    const { handlers, reg } = makeIpcHarness({
      generate: async () => ({}), get: async () => ({}), latestForLead: async () => null,
      update: async () => ({}), approve: async () => ({}), gate: async () => ({}),
      list: async () => ({ rows: [], total: 0, limit: 20, offset: 0, status: null }),
      send: async () => ({}),
      sendEmail: async () => ({ outcome: 'accepted', providerAcknowledged: true }),
      sendWhatsApp: async () => ({ outcome: 'accepted', providerAcknowledged: true }),
      // F21: the registrar now requires the read-only send-ledger read.
      sendList: async () => ({ rows: [], total: 0, limit: 0, offset: 0 }),
    });
    assert.deepEqual(reg.channels.slice().sort(), [
      'lead-intel:outreach-activity',
      'lead-intel:outreach-approve',
      'lead-intel:outreach-gate',
      'lead-intel:outreach-list',
      'lead-intel:outreach-prepare',
      'lead-intel:outreach-ready',
      'lead-intel:outreach-send',
      // F21: the read-only send-ledger read.
      'lead-intel:outreach-sends',
      'lead-intel:pitch-generate',
      'lead-intel:pitch-get',
      'lead-intel:pitch-update',
  ]);
  // F15/F16 declared lock update: + the read-only activity and ready channels. F18 declared
  // lock update: + the single read-only prepare channel. F19 declared lock update: + the
  // single send boundary.
  assert.equal(handlers.size, 11);
  assert.ok(handlers.has('lead-intel:outreach-send'), 'the one send channel is registered');
  assert.ok(handlers.has('lead-intel:outreach-sends'), 'the read-only send-ledger read is registered');
  assert.ok(!handlers.has('lead-intel:email-send'), 'the old email-send name is still not registered');
  assert.ok(!reg.channels.includes('lead-intel:email-send'));
  // Nothing beyond the outreach surface is exposed.
  for (const forbidden of ['lead-intel:research-request', 'lead-intel:export-research', 'lead-intel:enrichment-request', 'lead-intel:agent-analyze']) {
    assert.ok(!handlers.has(forbidden), 'must not register ' + forbidden);
  }
  // The channel constant itself must stay an exact allowlist, not a lower bound: a
  // seventh channel declared here would be caught even before registration.
  assert.deepEqual(Object.values(OUTREACH_CHANNELS).slice().sort(), [
    'lead-intel:outreach-activity',
    'lead-intel:outreach-approve',
    'lead-intel:outreach-gate',
    'lead-intel:outreach-list',
    'lead-intel:outreach-prepare',
    'lead-intel:outreach-ready',
    'lead-intel:outreach-send',
    // F21: the read-only send-ledger read.
    'lead-intel:outreach-sends',
    'lead-intel:pitch-generate',
    'lead-intel:pitch-get',
    'lead-intel:pitch-update',
  ]);
  // F15/F16 declared lock update: + activity and ready. F18 declared lock update: + prepare.
  // F19 declared lock update: 9 -> 10, + the single send boundary.
  // F21 declared lock update: 10 -> 11, + the single read-only send-ledger read.
  assert.equal(Object.keys(OUTREACH_CHANNELS).length, 11);
  assert.ok(!Object.values(OUTREACH_CHANNELS).includes('lead-intel:email-send'), 'email-send is not even declared here');
  reg.dispose();
  assert.equal(handlers.size, 0, 'dispose removes every handler');
});

test('A10 IPC: an untrusted sender is refused before any service call', async () => {
  let called = false;
  const { handlers } = makeIpcHarness({
    generate: async () => { called = true; return {}; }, get: async () => ({}), latestForLead: async () => null,
    update: async () => ({}), approve: async () => ({}), gate: async () => ({}),
    list: async () => { called = true; return { rows: [], total: 0, limit: 20, offset: 0, status: null }; },
    send: async () => ({}),
    sendEmail: async () => { called = true; return {}; },
    sendWhatsApp: async () => { called = true; return {}; },
    // F21: the registrar requires the read-only send-ledger read.
    sendList: async () => ({ rows: [], total: 0, limit: 0, offset: 0 }),
  }, { trusted: false });
  for (const ch of reg_channels()) {
    const res = await handlers.get(ch)({}, { leadId: '5', pitchId: 'p' });
    assert.equal(res.ok, false, ch);
    assert.equal(res.error.code, 'FORBIDDEN', ch);
  }
  assert.equal(called, false, 'no service ran for an untrusted sender');
  function reg_channels() { return Object.values(OUTREACH_CHANNELS); }
});

test('A10 IPC: invalid input is rejected and errors are structured', async () => {
  const { handlers, reg } = makeIpcHarness({
    generate: async () => { throw new Error('must not be reached'); },
    get: async () => ({}), latestForLead: async () => null,
    update: async () => ({}), approve: async () => ({}), gate: async () => ({}),
    list: async () => { throw new Error('must not be reached'); },
    send: async () => ({}),
    sendEmail: async () => { throw new Error('must not be reached'); },
    sendWhatsApp: async () => { throw new Error('must not be reached'); },
    // F21: the registrar requires the read-only send-ledger read.
    sendList: async () => ({ rows: [], total: 0, limit: 0, offset: 0 }),
  });
  const bad = [
    ['lead-intel:pitch-generate', {}],                                   // leadId required
    ['lead-intel:pitch-generate', { leadId: 5 }],                        // wrong type
    ['lead-intel:pitch-generate', { leadId: '5', extra: 'x' }],         // no extra properties
    ['lead-intel:pitch-get', { leadId: '5', pitchId: '../../etc' }],    // oversized id
    ['lead-intel:pitch-update', { pitchId: 'p', subject: 'x'.repeat(500) }],
    ['lead-intel:outreach-approve', { pitchId: '' }],
    ['lead-intel:outreach-gate', { pitchId: 'p', channel: 'sms' }],      // only email is in the vocabulary
    ['lead-intel:outreach-list', { status: 'approved' }],                 // not a persisted pitch status
    ['lead-intel:outreach-list', { status: 'blocked' }],                  // gate.decision is not a pitch status
    ['lead-intel:outreach-list', { limit: 0 }],                           // out of range
    ['lead-intel:outreach-list', { orderBy: 'lead_id' }],                 // no client-chosen ordering
  ];
  for (const [ch, payload] of bad) {
    const res = await handlers.get(ch)({}, payload);
    assert.equal(res.ok, false, ch + ' ' + JSON.stringify(payload));
    assert.equal(typeof res.error.code, 'string', ch);
    assert.equal(typeof res.error.message, 'string', ch);
  }
  // A domain error surfaces as a structured error, never as a throw.
  const { handlers: h2, reg: r2 } = makeIpcHarness({
    generate: async () => ({}), get: async () => ({}), latestForLead: async () => null,
    update: async () => ({}), approve: async () => ({}),
    gate: async () => { throw new NotFoundError('Pitch', 'p'); },
    list: async () => { throw new NotFoundError('Pitch', 'p'); },
    send: async () => ({}),
    sendEmail: async () => { throw new NotFoundError('Pitch', 'p'); },
    sendWhatsApp: async () => { throw new NotFoundError('Pitch', 'p'); },
    // F21: the registrar requires the read-only send-ledger read.
    sendList: async () => ({ rows: [], total: 0, limit: 0, offset: 0 }),
  });
  const gated = await h2.get('lead-intel:outreach-gate')({}, { pitchId: 'p' });
  assert.equal(gated.ok, false);
  assert.equal(gated.error.code, 'NOT_FOUND');
  assert.ok(!/at .*\.js:\d+/.test(gated.error.message), 'no stack trace is returned to the renderer');
  r2.dispose();
  reg.dispose();
});

test('A10 IPC: no credential, DB handle or provider secret can reach the renderer', async () => {
  const { handlers, reg } = makeIpcHarness({
    generate: async () => ({
      pitch_id: 'p', subject: 'Hi', status: 'draft',
      // Values that must never survive the boundary, whatever produced them.
      apiKey: 'sk-live-should-never-be-returned',
      password: 'hunter2',
      emailProvider: { from: 'secret@example.com' },
      fromAddress: 'sealed-vault-value',
    }),
    get: async () => ({}), latestForLead: async () => null,
    update: async () => ({}), approve: async () => ({}), gate: async () => ({}),
    // The enumeration response is scrubbed by exactly the same path.
    list: async () => ({
      rows: [{ pitch_id: 'p', status: 'draft', apiKey: 'sk-live-should-never-be-returned', password: 'hunter2' }],
      total: 1, limit: 20, offset: 0, status: null,
    }),
    send: async () => ({}),
    sendEmail: async () => ({ outcome: 'accepted', providerAcknowledged: true }),
    sendWhatsApp: async () => ({ outcome: 'accepted', providerAcknowledged: true }),
    // F21: the registrar requires the read-only send-ledger read.
    sendList: async () => ({ rows: [], total: 0, limit: 0, offset: 0 }),
  });
  const res = await handlers.get('lead-intel:pitch-generate')({}, { leadId: '5' });
  assert.equal(res.ok, true);
  const serialized = JSON.stringify(res);
  for (const secret of ['sk-live-should-never-be-returned', 'hunter2']) {
    assert.ok(!serialized.includes(secret), 'no credential is returned: ' + secret);
  }
  assert.ok(!('apiKey' in res.data) && !('password' in res.data), 'secret-like keys are dropped, whatever produced them');

  // The same scrubbing applies to the new enumeration channel.
  const listed = await handlers.get('lead-intel:outreach-list')({}, {});
  assert.equal(listed.ok, true);
  const listedSerialized = JSON.stringify(listed);
  for (const secret of ['sk-live-should-never-be-returned', 'hunter2']) {
    assert.ok(!listedSerialized.includes(secret), 'outreach:list returns no credential: ' + secret);
  }
  assert.ok(!('apiKey' in listed.data.rows[0]) && !('password' in listed.data.rows[0]),
    'outreach:list drops secret-like keys from every row');
  assert.deepEqual(listed, JSON.parse(JSON.stringify(listed)), 'the list envelope survives a JSON round-trip unchanged');
  // The response is JSON-safe plain data: no live handle, function or class instance.
  assert.equal(Object.getPrototypeOf(res.data), Object.prototype);
  assert.deepEqual(res, JSON.parse(JSON.stringify(res)), 'the envelope survives a JSON round-trip unchanged');
  reg.dispose();
});

test('A10 IPC: the registrar requires a trusted sender and a real outreach service', () => {
  const ipcMain = { handle() {}, removeHandler() {} };
  assert.throws(() => registerOutreachIpc({ ipcMain, outreach: {}, isTrustedSender: null }), /isTrustedSender is required/);
  assert.throws(() => registerOutreachIpc({ ipcMain, isTrustedSender: () => true }), /outreach service is required/);
  // F12 Batch 2: outreach:list is registered unconditionally, so a service that cannot
  // serve it is refused at registration rather than failing on its first invoke.
  assert.throws(() => registerOutreachIpc({
    ipcMain, isTrustedSender: () => true, outreach: { generate: async () => ({}) },
  }), /must implement list/);
});

// ============================================================ 5. Preload

// F21 declared lock update: the preload now exposes the single read-only send-ledger read
  // alongside the single send boundary. The exact allowlist is still exact, and email.send
  // still does not exist. The send boundary is the only method whose name implies sending.
test('A10 preload: exposes exactly the approved methods plus the single F19 send method, and no email.send', () => {
  const source = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
  const invoked = [...source.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((m) => m[1]);
const leadIntel = invoked.filter((c) => c.startsWith('lead-intel:'));
    // An EXACT allowlist, not a lower bound: a substitution or extra channel fails here.
    // Original F15-F21: 11 channels. Phase I2 adds 7 Opportunity Intelligence channels = 18 total.
    assert.deepEqual(leadIntel.slice().sort(), [
    // F15-F21 (original) + Phase I2: 18 total, alphabetically sorted.
    'lead-intel:opportunity-associations',
    'lead-intel:opportunity-engine',
    'lead-intel:opportunity-health',
    'lead-intel:opportunity-latest',
    'lead-intel:opportunity-pitch-context',
    'lead-intel:opportunity-pitch-preview', // I7 declared lock update
    'lead-intel:opportunity-report',
    'lead-intel:opportunity-request',
    'lead-intel:outreach-activity',
    'lead-intel:outreach-approve',
    'lead-intel:outreach-gate',
    'lead-intel:outreach-list',
    'lead-intel:outreach-prepare',
    'lead-intel:outreach-ready',
    'lead-intel:outreach-send',
    'lead-intel:outreach-sends',
    'lead-intel:pitch-generate',
    'lead-intel:pitch-get',
    'lead-intel:pitch-update',
    'lead-intel:timeline', // I6 declared lock update: the read-only lead timeline
    // F26.5 declared lock update: the five trust channels (none of them sends).
    'lead-intel:trust-consent', 'lead-intel:trust-handoff', 'lead-intel:trust-lead', 'lead-intel:trust-lift', 'lead-intel:trust-review', 'lead-intel:trust-suppress',
    // F26.6 declared lock update: the ten mailbox / market-rule channels (none of them sends).
    'lead-intel:mailbox-connect', 'lead-intel:mailbox-default', 'lead-intel:mailbox-disconnect', 'lead-intel:mailbox-google-client', 'lead-intel:mailbox-limits', 'lead-intel:mailbox-list', 'lead-intel:mailbox-capabilities', 'lead-intel:mailbox-check', 'lead-intel:mailbox-replies', 'lead-intel:market-rule-remove', 'lead-intel:market-rule-set', 'lead-intel:market-rules',
    // F28 declared lock update: the eight sequence channels (none of them sends).
    'lead-intel:sequence-activate', 'lead-intel:sequence-create', 'lead-intel:sequence-for-lead', 'lead-intel:sequence-list', 'lead-intel:sequence-pause', 'lead-intel:sequence-pause-all', 'lead-intel:sequence-resume', 'lead-intel:sequence-stop',
    // F29 declared lock update: the three reply-route channels (none of them sends).
    'lead-intel:reply-route-confirm', 'lead-intel:reply-route-lead', 'lead-intel:reply-routes',
    ].sort());
    assert.equal(leadIntel.length, 49, 'exactly forty-nine Lead Intelligence methods (11 F15-F21 + 7 Phase I2 OI + 1 I6 timeline + 1 I7 pitch preview + 5 F26.5 trust + 12 F26.6 mailboxes + 1 F26.6 reply review + 8 F28 sequences + 3 F29 reply routes)');
    assert.equal(leadIntel.filter((c) => /send/.test(c)).length, 2, 'the send boundary and its ledger read exist; exactly one sends');
    assert.ok(!invoked.includes('lead-intel:email-send'), 'no email.send is exposed');

  // The API lives under its own key; the existing appAPI surface is unchanged.
  assert.ok(/exposeInMainWorld\('ztechLeadIntel'/.test(source));
  const leadIntelBlock = source.slice(source.indexOf("exposeInMainWorld('ztechLeadIntel'"));
  for (const method of ['generate:', 'get:', 'update:', 'approve:', 'gate:', 'list:']) {
    assert.ok(leadIntelBlock.includes(method), 'missing method: ' + method);
  }
  assert.ok(!/email\s*:/.test(leadIntelBlock), 'no email namespace is exposed');
  // The renderer still cannot pass a channel name, a URL, a path or a credential.
  assert.ok(!/exposeInMainWorld\([^)]{0,80}ipcRenderer/.test(source), 'ipcRenderer is never exposed directly');
  assert.ok(!/require\(/.test(leadIntelBlock), 'the Lead Intelligence block pulls in nothing');
});

// ============================================================ 7. Freshness is still enforced

// The guard for the injected clock above. Without this, injecting a fixed clock would look
// like a way to wave stale evidence through the gate. It must not be: this walks the very
// same fixture PAST its 30-day window and requires the gate to refuse, with the real code.
test('A10 freshness guard: the same fixture is refused once its evidence window has passed', { skip: initSqlJs ? false : 'sql.js not installed' }, async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(`CREATE TABLE prospect_research (id TEXT PRIMARY KEY, lead_ref TEXT NOT NULL, provider_id TEXT NOT NULL,
    phase TEXT NOT NULL, next_attempt_at TEXT, updated_at TEXT NOT NULL, version INTEGER NOT NULL, record_json TEXT NOT NULL)`);
  const record = round1Record();
  db.run('INSERT INTO prospect_research VALUES (?,?,?,?,?,?,?,?)', [
    record.id, record.leadRef, record.providerId, record.phase, record.nextAttemptAt,
    record.updatedAt, record.version, JSON.stringify(record),
  ]);
  db.run('CREATE TABLE numbers (id INTEGER PRIMARY KEY, phone TEXT, title TEXT, website TEXT, email TEXT, address TEXT, qualification TEXT)');
  db.run('INSERT INTO numbers VALUES (5, ?, ?, ?, ?, ?, ?)', [
    '+923001234567', 'Acme Bakery', 'https://acme.com', 'hello@acme.com', '12 Road', 'qualified',
  ]);

  const accountStore = {
    db,
    ready: Promise.resolve(),
    saveDB() {},
    queryNumbers: async (q) => ({ rows: q && String(q.id) === '5' ? [LEADS[5]] : [], total: 1, limit: 1, offset: 0 }),
    getCollectedNumbers: async () => [LEADS[5]],
    listTargets: async () => ({ rows: [] }),
  };

  // One clock, shared, so the test can move "now" deliberately.
  const clock = makeClock();
  const runtime = await initializeLeadIntelligenceRuntime({
    accountStore,
    clock,
    config: {
      freshness: { completeMaxAgeDays: 30, partialMaxAgeDays: 7 },
      outreach: { allowedQualification: ['qualified'] },
      offer: { sender_name: 'Zee', sender_company: 'ZuniTech', value_proposition: 'We fix audit issues like these.', call_to_action: 'Short call next week?' },
    },
    logger: SILENT,
  });

  const { handlers } = makeIpcHarness(runtime.li.outreach);
  const generated = await handlers.get('lead-intel:pitch-generate')({}, { leadId: '5' });
  assert.equal(generated.ok, true, JSON.stringify(generated.error));
  await handlers.get('lead-intel:outreach-approve')({}, { pitchId: generated.data.pitch_id });

  // Still inside the 30-day window: the same content is allowed.
  let gate = await handlers.get('lead-intel:outreach-gate')({}, { pitchId: generated.data.pitch_id });
  assert.equal(gate.data.decision, 'allowed', JSON.stringify(gate.data.reasons));

  // One second past the window: the SAME pitch, SAME approval, now refused - and refused
  // for the real reason, not because the clock is fake.
  clock.advance(31 * 24 * 60 * 60 * 1000);
  gate = await handlers.get('lead-intel:outreach-gate')({}, { pitchId: generated.data.pitch_id });
  assert.equal(gate.data.decision, 'blocked', 'aged evidence can never be allowed');
  assert.ok(gate.data.reasons.some((r) => r.code === 'EVIDENCE_FRESH'), 'and it says EVIDENCE_FRESH: ' + JSON.stringify(gate.data.reasons));
  assert.ok(!gate.data.reasons.some((r) => r.code === 'HUMAN_APPROVAL'), 'the approval itself was not invalidated by age');

  await runtime.shutdown();
});

// ============================================================ 6. End-to-end

test('A10 E2E: a real Round-1 record -> mapper -> EvidencePacket -> cited pitch -> gate blocks until HUMAN_APPROVAL -> approval allows', { skip: initSqlJs ? false : 'sql.js not installed' }, async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(`CREATE TABLE prospect_research (id TEXT PRIMARY KEY, lead_ref TEXT NOT NULL, provider_id TEXT NOT NULL,
    phase TEXT NOT NULL, next_attempt_at TEXT, updated_at TEXT NOT NULL, version INTEGER NOT NULL, record_json TEXT NOT NULL)`);
  const record = round1Record();
  db.run('INSERT INTO prospect_research VALUES (?,?,?,?,?,?,?,?)', [
    record.id, record.leadRef, record.providerId, record.phase, record.nextAttemptAt,
    record.updatedAt, record.version, JSON.stringify(record),
  ]);
  db.run('CREATE TABLE numbers (id INTEGER PRIMARY KEY, phone TEXT, title TEXT, website TEXT, email TEXT, address TEXT, qualification TEXT)');
  db.run('INSERT INTO numbers VALUES (5, ?, ?, ?, ?, ?, ?)', [
    '+923001234567', 'Acme Bakery', 'https://acme.com', 'hello@acme.com', '12 Road', 'qualified',
  ]);

  const accountStore = {
    db,
    ready: Promise.resolve(),
    saveDB() {},
    queryNumbers: async (q) => ({ rows: q && String(q.id) === '5' ? [LEADS[5]] : [], total: 1, limit: 1, offset: 0 }),
    getCollectedNumbers: async () => [LEADS[5]],
    listTargets: async () => ({ rows: [] }),
  };

  const email = new FakeEmailProvider();
  const runtime = await initializeLeadIntelligenceRuntime({
    accountStore,
    // Deterministic freshness. This fixture's evidence is captured at CLOCK_ISO and its
    // 30-day window expires at 2026-10-01T10:00:00Z. Evaluating the gate against the real
    // wall clock therefore made this test pass or fail purely on the calendar date, which
    // it did: it started failing the moment that instant passed. Injecting the fixture's
    // OWN clock means "is this evidence still fresh?" is answered against the data in the
    // test, forever.
    //
    // This does not weaken the freshness rule in any way: the next test proves the very
    // same setup still blocks with EVIDENCE_FRESH once the clock passes the expiry.
    clock: makeClock(),
    config: {
      freshness: { completeMaxAgeDays: 30, partialMaxAgeDays: 7 },
      outreach: { allowedQualification: ['qualified'] },
      offer: { sender_name: 'Zee', sender_company: 'ZuniTech', value_proposition: 'We fix audit issues like these.', call_to_action: 'Short call next week?' },
    },
    logger: SILENT,
  });

  // 1. completed Round-1 research -> 2. mapper -> 3. EvidencePacket
  const synced = await runtime.li.research.sync({ leadId: '5' });
  assert.equal(synced.synced, true);
  const packet = await runtime.li.research.evidence({ leadId: '5' });
  assert.equal(validateEvidencePacket(packet).valid, true);
  assert.equal(packet.requested_domain, 'acme.com');
  assert.equal(packet.provider.provider_job_id, 'job_0123456789abcdef');

  // 4. Pitch generation -> 5. a cited draft
  const { handlers } = makeIpcHarness(runtime.li.outreach);
  const generated = await handlers.get('lead-intel:pitch-generate')({}, { leadId: '5' });
  assert.equal(generated.ok, true, JSON.stringify(generated.error));
  const pitch = generated.data;
  assert.equal(pitch.status, 'draft');
  assert.ok(pitch.observations.length > 0, 'the draft has evidence-backed observations');
  assert.ok(pitch.observations.every((o) => o.refs.length > 0), 'every observation cites its evidence');
  assert.deepEqual(pitch.unsupportedClaims, [], 'no unsupported claim survived');

  // 6. Outreach Gate blocks until HUMAN_APPROVAL
  let gate = await handlers.get('lead-intel:outreach-gate')({}, { pitchId: pitch.pitch_id });
  assert.equal(gate.ok, true);
  assert.equal(gate.data.decision, 'blocked');
  assert.ok(gate.data.reasons.some((r) => r.code === 'HUMAN_APPROVAL'), 'blocked pending human approval');
  assert.equal(email.outbox.length, 0, 'nothing was sent');

  // 7. approval -> 8. the gate allows, because every existing requirement passes
  const approved = await handlers.get('lead-intel:outreach-approve')({}, { pitchId: pitch.pitch_id });
  assert.equal(approved.ok, true, JSON.stringify(approved.error));
  assert.equal(approved.data.content_hash, pitch.content_hash, 'the approval is bound to this exact content');
  gate = await handlers.get('lead-intel:outreach-gate')({}, { pitchId: pitch.pitch_id });
  assert.equal(gate.data.decision, 'allowed', JSON.stringify(gate.data.reasons));

  // Editing after approval re-blocks the gate: the existing integrity rule holds.
  const edited = await handlers.get('lead-intel:pitch-update')({}, { pitchId: pitch.pitch_id, callToAction: 'Can we talk on Tuesday?' });
  assert.equal(edited.ok, true);
  gate = await handlers.get('lead-intel:outreach-gate')({}, { pitchId: pitch.pitch_id });
  assert.equal(gate.data.decision, 'blocked');
  assert.ok(gate.data.reasons.some((r) => r.code === 'HUMAN_APPROVAL'));

  // NO email was sent at any point, and no email channel exists.
  assert.equal(email.outbox.length, 0, 'A10 never sends an email');
  assert.ok(!handlers.has('lead-intel:email-send'));

  // No real pitch, gate or approval payload carries a credential or a live handle.
  for (const payload of [pitch, gate.data, approved.data]) {
    assert.ok(!SECRET_KEY.test(JSON.stringify(Object.keys(payload))), 'no secret-like key in a real payload');
  }
  assert.deepEqual(gate.data, JSON.parse(JSON.stringify(gate.data)), 'the gate result is JSON-safe plain data');
  await runtime.shutdown();
});

test('A10 E2E: a failed Round-1 record yields a packet the gate can never allow', { skip: initSqlJs ? false : 'sql.js not installed' }, async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  const store = new MemoryStore();
  const round1 = fakeRound1Port([round1Record({ phase: 'partial', packet: zuniV1Packet({ status: 'partial', availability: 'no_crawlable_content' }) })]);
  const li = createLeadIntelligence({
    store,
    leadSource: makeLeadSource(),
    round1,
    config: {
      research: { mode: 'round1' },
      freshness: { completeMaxAgeDays: 30, partialMaxAgeDays: 7 },
      outreach: { allowedQualification: ['qualified'] },
      offer: { sender_name: 'Zee', sender_company: 'ZuniTech', value_proposition: 'We fix audit issues.', call_to_action: 'Call?' },
    },
    clock: makeClock(),
    logger: SILENT,
    round1ResultMapper: round1PacketMapper,
  });
  await li.research.sync({ leadId: '5' });
  const packet = await store.packets.latestForLead('5');
  assert.equal(packet.research_status, 'failed', 'no_crawlable_content is a failed outcome');
  const pitch = await li.outreach.generate({ leadId: '5' });
  assert.equal(pitch.status, 'insufficient_evidence', 'a failed packet never produces a usable draft');
  const gate = await li.outreach.gate({ pitchId: pitch.pitch_id });
  assert.equal(gate.decision, 'blocked');
  assert.ok(gate.reasons.some((r) => r.code === 'EVIDENCE_COMPLETE' || r.code === 'EVIDENCE_PRESENT'));
});
