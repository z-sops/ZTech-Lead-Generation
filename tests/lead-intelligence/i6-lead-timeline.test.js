'use strict';

/**
 * I6 - the unified lead timeline: a read-only projection over ZTech's own records.
 *
 * Runs the REAL LeadTimeline over the REAL SqlJsStore / MemoryStore (rows written through
 * their own public write methods), the real OI association store, and the real IPC
 * registrar. A module-level fetch guard fails loudly if anything reaches for the network.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let initSqlJs = null;
try { initSqlJs = require('sql.js'); } catch { initSqlJs = null; }
const skip = initSqlJs ? false : 'sql.js not installed';

const fetchGuard = { calls: 0 };
globalThis.fetch = async () => { fetchGuard.calls += 1; throw new Error('I6 TEST GUARD: no network'); };

const LI = path.join(__dirname, '..', '..', 'src', 'main', 'lead-intelligence');
const { LeadTimeline, EVENT_KINDS, ACTIVITY_KIND, TIMELINE_LIMITS, SOURCES } = require(path.join(LI, 'timeline', 'LeadTimeline'));
const { registerTimelineIpc, TIMELINE_CHANNEL } = require(path.join(LI, 'timeline', 'timeline-ipc'));
const { MemoryStore } = require(path.join(LI, 'persistence', 'MemoryStore'));
const { SqlJsStore } = require(path.join(LI, 'persistence', 'SqlJsStore'));
const { ACTIVITY_TYPES } = require(path.join(LI, 'persistence', 'contract'));
const { OpportunityAssociationStore } = require(path.join(LI, 'opportunity', 'OpportunityAssociationStore'));
const fixtures = require('./opportunity-fixtures');

const LEAD = '7';
const T = (d, h = 0) => new Date(Date.UTC(2026, 8, d, h)).toISOString(); // September 2026

function leadSource(row = { id: LEAD, collectedAt: T(1), keyword: 'bakeries karachi' }) {
  return { getLead: async (id) => (String(id) === LEAD ? row : null) };
}

function opportunityWith(reports = []) {
  const associations = new OpportunityAssociationStore({ clock: () => new Date(T(20)) });
  for (const r of reports) associations.assertLeadAssociation({ leadId: LEAD, report: r });
  return { associations };
}

function oiReport(n, day) {
  return fixtures.report({
    research_id: `res_202609${String(day).padStart(2, '0')}120000_abcdef0${n}`,
    snapshot_id: `snap_202609${String(day).padStart(2, '0')}120000_abcdef0${n}`,
    generated_at: T(day, 12),
  });
}

async function seed(store, { activity = [], pitches = [], jobs = [], packets = [], changes = [], enrich = [], refresh = [] } = {}) {
  for (const j of jobs) {
    await store.jobs.insert({
      job_id: j.id, lead_id: LEAD, provider_id: 'zuni', request_key: `rk-${j.id}`, requested_domain: 'a.pk', domain_key: 'a.pk',
      state: j.state, provider_job_id: null, attempts: 0, poll_count: 0, next_attempt_at: null, last_error_code: null,
      last_error_message: null, packet_id: null, options: {}, created_at: j.created, updated_at: j.created,
      started_at: j.created, finished_at: j.finished || null, version: 1,
    });
  }
  for (const p of packets) {
    await store.packets.insert({
      packet_id: p.id, lead_id: LEAD, job_id: 'j1', research_status: 'complete', digital_footprint: { state: 'active' },
      requested_domain: 'a.pk', captured_at: p.at, freshness: { expires_at: T(28) }, created_at: p.at,
    });
  }
  if (changes.length) {
    await store.changes.insertMany(changes.map((c) => ({
      change_id: c.id, lead_id: LEAD, type: c.type, detectedAt: c.at, provenance: { previous_packet_id: 'p0', current_packet_id: 'p1' },
    })));
  }
  for (const e of enrich) {
    await store.enrichmentJobs.insert({ job_id: e.id, lead_id: LEAD, state: e.state, fields: [], steps: [], created_at: e.created, updated_at: e.created, finished_at: e.finished || null, version: 1 });
  }
  for (const p of pitches) {
    await store.pitches.upsert({ pitch_id: p.id, lead_id: LEAD, packet_id: null, status: p.status || 'draft', content_hash: 'h', created_at: p.at, updated_at: p.at });
  }
  for (const a of activity) {
    await store.activity.append({ activity_id: a.id, lead_id: LEAD, pitch_id: a.pitch || null, activity_type: a.type, metadata: a.meta || {}, created_at: a.at });
  }
  for (const r of refresh) {
    await store.oiRefreshRequests.open({ request_id: r.id, lead_id: LEAD, created_at: r.created });
    if (r.state) await store.oiRefreshRequests.close(r.id, { state: r.state, error_code: r.code || null, research_id: r.rid || null, updated_at: r.updated });
  }
}

async function sqlStore(bytes) {
  const SQL = await initSqlJs();
  const s = new SqlJsStore({ db: bytes ? new SQL.Database(bytes) : new SQL.Database(), logger: { warn() {}, error() {}, info() {} } });
  await s.migrate();
  return s;
}

const FULL = {
  jobs: [{ id: 'j1', state: 'complete', created: T(2), finished: T(2, 3) }],
  packets: [{ id: 'p1', at: T(2, 3) }],
  changes: [{ id: 'c1', type: 'pricing_page_added', at: T(9) }],
  enrich: [{ id: 'e1', state: 'complete', created: T(3), finished: T(3, 1) }],
  pitches: [{ id: 'pt1', at: T(10) }],
  activity: [
    { id: 'a1', type: 'PITCH_APPROVED', at: T(11), pitch: 'pt1' },
    { id: 'a2', type: 'OUTREACH_SEND_ATTEMPTED', at: T(12), pitch: 'pt1', meta: { channel: 'email' } },
    { id: 'a3', type: 'OUTREACH_SEND_ACCEPTED', at: T(12, 1), pitch: 'pt1', meta: { channel: 'email', providerMessageId: 're_1' } },
  ],
  refresh: [{ id: 'ztech-7-aaa', created: T(4), state: 'failed', code: 'PROVIDER_FAILED', updated: T(4, 1) }],
};

// ---------------------------------------------------------------- 1-6 projection

test('1. every source merges newest first; every event has a valid at, a known source/kind and a nullable open', async () => {
  const store = new MemoryStore();
  await seed(store, FULL);
  const tl = new LeadTimeline({ store, leadSource: leadSource(), opportunity: opportunityWith([oiReport(1, 5)]) });
  const v = await tl.forLead(LEAD);
  const kinds = v.events.map((e) => e.kind);
  for (const k of ['LEAD_COLLECTED', 'RESEARCH_REQUESTED', 'RESEARCH_FINISHED', 'EVIDENCE_CAPTURED', 'WEBSITE_CHANGE_DETECTED',
    'ENRICHMENT_FINISHED', 'OI_RESEARCH_REQUESTED', 'OI_RESEARCH_FAILED', 'OI_REPORT_RECORDED', 'PITCH_DRAFTED', 'PITCH_APPROVED',
    'OUTREACH_SEND_ATTEMPTED', 'OUTREACH_SEND_ACCEPTED']) assert.ok(kinds.includes(k), k);
  for (let i = 1; i < v.events.length; i += 1) assert.ok(v.events[i - 1].at >= v.events[i].at, 'newest first');
  for (const e of v.events) {
    assert.ok(SOURCES.includes(e.source));
    assert.ok(EVENT_KINDS.includes(e.kind));
    assert.ok(!Number.isNaN(Date.parse(e.at)));
    assert.ok(e.open === null || ['research', 'enrichment', 'opportunity', 'pitch', 'outreach'].includes(e.open));
    assert.deepEqual(Object.keys(e).sort(), ['at', 'detail', 'event_id', 'kind', 'open', 'source', 'title']);
  }
  // Clarification 2: no meaningful tab -> null, never an invented target.
  assert.equal(v.events.find((e) => e.kind === 'LEAD_COLLECTED').open, null);
  assert.equal(v.events.find((e) => e.kind === 'ENRICHMENT_FINISHED').open, null);
  assert.equal(v.events[0].kind, 'OUTREACH_SEND_ACCEPTED');
  assert.equal(v.events.at(-1).kind, 'LEAD_COLLECTED');
  assert.equal(v.affects_outreach, false);
});

test('2. ties are ordered deterministically and the cursor pages without repeats or gaps across 3 pages', async () => {
  const store = new MemoryStore();
  const same = T(15);
  const activity = Array.from({ length: 120 }, (_, i) => ({ id: `a${String(i).padStart(3, '0')}`, type: 'OUTREACH_READY', at: i % 3 ? same : T(14, i % 20) }));
  await seed(store, { activity });
  const tl = new LeadTimeline({ store, leadSource: leadSource() });
  const seen = [];
  let before = null;
  for (let page = 0; page < 3; page += 1) {
    const v = await tl.forLead(LEAD, { limit: 50, before });
    seen.push(...v.events.map((e) => e.event_id));
    before = v.next;
    if (!v.has_more) break;
  }
  assert.equal(seen.length, 121, '120 activity + lead collected');
  assert.equal(new Set(seen).size, seen.length, 'no repeats');
  const again = (await tl.forLead(LEAD, { limit: 50 })).events.map((e) => e.event_id);
  assert.deepEqual(again, seen.slice(0, 50), 'same order on every read');
});

test('3. the source filter runs in main and paging stays correct while filtered', async () => {
  const store = new MemoryStore();
  await seed(store, { ...FULL, activity: Array.from({ length: 70 }, (_, i) => ({ id: `x${i}`, type: 'OUTREACH_READY', at: T(16, i % 24) })) });
  const tl = new LeadTimeline({ store, leadSource: leadSource() });
  const p1 = await tl.forLead(LEAD, { sources: ['research'] });
  assert.ok(p1.events.length > 0 && p1.events.every((e) => e.source === 'research'));
  const o1 = await tl.forLead(LEAD, { sources: ['outreach'], limit: 50 });
  const o2 = await tl.forLead(LEAD, { sources: ['outreach'], limit: 50, before: o1.next });
  assert.equal(o1.events.length + o2.events.length, 70);
  assert.ok([...o1.events, ...o2.events].every((e) => e.source === 'outreach'));
  assert.equal(o2.has_more, false);
});

test('4. a row with a missing or invalid time is skipped and counted - never shown at "now"', async () => {
  const store = new MemoryStore();
  await seed(store, { pitches: [{ id: 'good', at: T(5) }] });
  const tl = new LeadTimeline({
    store: { ...store, pitches: { listByLead: async () => [{ pitch_id: 'good', created_at: T(5) }, { pitch_id: 'bad', created_at: 'not a date' }, { pitch_id: 'none', created_at: null }] } },
    leadSource: leadSource({ id: LEAD, collectedAt: null }),
  });
  const v = await tl.forLead(LEAD);
  assert.deepEqual(v.events.map((e) => e.event_id), ['pitch:good']);
  assert.equal(v.skipped, 2);
});

test('5. one source that fails leaves the others rendering and is named', async () => {
  const store = new MemoryStore();
  await seed(store, FULL);
  const broken = Object.create(store);
  broken.changes = { listByLead: async () => { throw new Error('corrupt'); } };
  broken.activity = { list: async () => { throw new Error('locked'); } };
  const tl = new LeadTimeline({ store: broken, leadSource: leadSource() });
  const v = await tl.forLead(LEAD);
  assert.deepEqual(v.unavailable_sources.sort(), ['outreach', 'research']);
  assert.ok(v.events.some((e) => e.source === 'pitch') && v.events.some((e) => e.source === 'lead'));
});

test('6. GLOBAL cap: per-source reads are capped at 500 and the merged timeline exposes at most 500 events; pages are at most 50', async () => {
  assert.deepEqual([TIMELINE_LIMITS.PER_SOURCE_CAP, TIMELINE_LIMITS.WINDOW, TIMELINE_LIMITS.PAGE_MAX], [500, 500, 50]);
  const store = new MemoryStore();
  await seed(store, { activity: Array.from({ length: 520 }, (_, i) => ({ id: `a${String(i).padStart(4, '0')}`, type: 'OUTREACH_READY', at: new Date(Date.UTC(2026, 8, 20) - i * 60000).toISOString() })) });
  const many = Array.from({ length: 520 }, (_, i) => ({ pitch_id: `p${i}`, created_at: new Date(Date.UTC(2026, 8, 20) - i * 61000).toISOString() }));
  const s2 = Object.create(store);
  s2.pitches = { listByLead: async (_id, limit) => many.slice(0, limit) };
  const tl = new LeadTimeline({ store: s2, leadSource: leadSource() });
  let total = 0;
  let before = null;
  let pages = 0;
  for (;;) {
    const v = await tl.forLead(LEAD, { limit: 500, before });
    assert.ok(v.events.length <= 50, 'a page never exceeds 50 even when 500 is asked');
    total += v.events.length;
    pages += 1;
    if (!v.has_more) { assert.equal(v.truncated, true); assert.equal(v.window_limit, 500); break; }
    before = v.next;
  }
  assert.equal(total, 500, 'one lead never exposes more than 500 merged events');
  assert.equal(pages, 10);
});

// ---------------------------------------------------------------- 7-12 guarantees

test('7. read-only: database bytes identical before and after 100 reads; no write method is called', { skip }, async () => {
  const s = await sqlStore();
  await seed(s, FULL);
  const before = crypto.createHash('sha256').update(Buffer.from(s.db.export())).digest('hex');
  const writes = [];
  for (const [name, sub] of Object.entries(s)) {
    if (!sub || typeof sub !== 'object') continue;
    for (const m of ['insert', 'insertMany', 'upsert', 'append', 'update', 'put', 'open', 'close', 'record', 'accept', 'fail', 'block']) {
      if (typeof sub[m] === 'function') { const orig = sub[m]; sub[m] = (...a) => { writes.push(`${name}.${m}`); return orig.apply(sub, a); }; }
    }
  }
  const tl = new LeadTimeline({ store: s, leadSource: leadSource(), opportunity: opportunityWith([oiReport(1, 5)]) });
  for (let i = 0; i < 100; i += 1) await tl.forLead(LEAD, { limit: 50 });
  const after = crypto.createHash('sha256').update(Buffer.from(s.db.export())).digest('hex');
  assert.equal(after, before);
  assert.deepEqual(writes, []);
});

test('8. no network, even with OI associations present (T1)', async () => {
  const store = new MemoryStore();
  await seed(store, FULL);
  const tl = new LeadTimeline({ store, leadSource: leadSource(), opportunity: opportunityWith([oiReport(1, 5), oiReport(2, 8)]) });
  const n = fetchGuard.calls;
  const v = await tl.forLead(LEAD);
  assert.equal(fetchGuard.calls, n);
  assert.equal(v.events.filter((e) => e.kind === 'OI_REPORT_RECORDED').length, 2);
  const src = fs.readFileSync(path.join(LI, 'timeline', 'LeadTimeline.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.equal(/fetch|gateway|getReport|getTimeline|require\(['"]http/.test(src), false);
});

test('9. each send appears once (T3): the send ledger is not read', async () => {
  const store = new MemoryStore();
  await seed(store, FULL);
  let sendReads = 0;
  const s2 = Object.create(store);
  s2.sends = { list: async () => { sendReads += 1; return { rows: [] }; } };
  const v = await new LeadTimeline({ store: s2, leadSource: leadSource() }).forLead(LEAD);
  assert.equal(sendReads, 0);
  assert.equal(v.events.filter((e) => e.kind === 'OUTREACH_SEND_ACCEPTED').length, 1);
});

test('10. every Activity type maps to one kind; an unknown type is OUTREACH_UNKNOWN with a fixed safe title', async () => {
  assert.deepEqual(Object.keys(ACTIVITY_KIND).sort(), [...ACTIVITY_TYPES].sort(), 'the mapping covers the closed Activity set exactly');
  const store = new MemoryStore();
  const tl = new LeadTimeline({ store, leadSource: leadSource() });
  const ev = tl.activityEvent({ activity_id: 'z1', activity_type: '<img src=x onerror=alert(1)> NEW_TYPE', created_at: T(3), metadata: {} });
  assert.equal(ev.kind, 'OUTREACH_UNKNOWN');
  assert.equal(ev.title, 'Outreach activity recorded');
  assert.ok(!/[<>]/.test(ev.detail), 'the raw type is sanitized');
  assert.match(ev.detail, /^Type: /);
  for (const t of ACTIVITY_TYPES) assert.ok(EVENT_KINDS.includes(tl.activityEvent({ activity_id: t, activity_type: t, created_at: T(3), metadata: {} }).kind));
});

test('11. no delivered / opened / read / replied event can be produced', () => {
  for (const k of EVENT_KINDS) assert.equal(/DELIVER|OPEN(ED)?$|_READ$|REPL/i.test(k), false, k);
  const src = fs.readFileSync(path.join(LI, 'timeline', 'LeadTimeline.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.equal(/delivered|opened|replied/i.test(src), false);
});

test('12. the timeline adds no Activity type and writes nothing to Activity', () => {
  assert.deepEqual([...ACTIVITY_TYPES].sort(), ['APPROVAL_INVALIDATED', 'OUTREACH_READY', 'OUTREACH_SEND_ACCEPTED', 'OUTREACH_SEND_ATTEMPTED', 'OUTREACH_SEND_BLOCKED', 'OUTREACH_SEND_FAILED', 'PITCH_APPROVED']);
  const dir = path.join(LI, 'timeline');
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.equal(/\.append\(|\.insert\(|\.upsert\(|\.put\(|\.close\(|\.open\(|db\.run\(/.test(src), false, f);
  }
});

// ---------------------------------------------------------------- 14 IPC

test('14. IPC: trusted sender only, closed schema, forbidden keys refused, bounded paging', async () => {
  const store = new MemoryStore();
  await seed(store, FULL);
  const handlers = {};
  const reg = registerTimelineIpc({ ipcMain: { handle: (c, f) => { handlers[c] = f; } }, timeline: new LeadTimeline({ store, leadSource: leadSource() }), isTrustedSender: (e) => !(e && e.untrusted), logger: { warn() {} } });
  assert.deepEqual(reg, [TIMELINE_CHANNEL]);
  const call = (p, ev = {}) => handlers[TIMELINE_CHANNEL](ev, p);
  assert.equal((await call({ leadId: LEAD }, { untrusted: true })).ok, false);
  for (const bad of [{}, { leadId: LEAD, url: 'http://x' }, { leadId: LEAD, token: 'x' }, { leadId: LEAD, limit: 51 }, { leadId: LEAD, sources: ['send'] },
    { leadId: LEAD, before: { at: 'yesterday', event_id: 'lead:7' } }, { leadId: LEAD, extra: 1 }]) {
    assert.equal((await call(bad)).ok, false, JSON.stringify(bad));
  }
  const ok = await call({ leadId: LEAD, limit: 5, sources: ['outreach', 'pitch'] });
  assert.equal(ok.ok, true);
  assert.ok(ok.data.events.length <= 5);
  const next = await call({ leadId: LEAD, limit: 5, before: ok.data.next || { at: T(1), event_id: 'lead:7' } });
  assert.equal(next.ok, true);
});

test('runtime wiring: initializeLeadIntelligenceRuntime exposes the timeline; pitches.listByLead exists in both stores', { skip }, async () => {
  const s = await sqlStore();
  await seed(s, { pitches: [{ id: 'b', at: T(3) }, { id: 'a', at: T(4) }] });
  assert.deepEqual((await s.pitches.listByLead(LEAD)).map((p) => p.pitch_id), ['a', 'b']);
  const m = new MemoryStore();
  await seed(m, { pitches: [{ id: 'b', at: T(3) }, { id: 'a', at: T(4) }] });
  assert.deepEqual((await m.pitches.listByLead(LEAD)).map((p) => p.pitch_id), ['a', 'b']);
  const runtimeSrc = fs.readFileSync(path.join(LI, 'lead-intelligence-runtime.js'), 'utf8');
  assert.match(runtimeSrc, /new LeadTimeline\(\{ store, leadSource, round1: port, opportunity: oi \? oi\.service : null \}\)/);
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'main.js'), 'utf8');
  assert.match(mainSrc, /registerTimelineIpc\(\{/);
});
