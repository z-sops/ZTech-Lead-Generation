'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { SqlJsStore } = require('../../src/main/lead-intelligence/persistence/SqlJsStore');
const { MIGRATIONS } = require('../../src/main/lead-intelligence/persistence/migrations');
const { writeFileAtomic, readJsonWithRecovery } = require('../../src/main/lead-intelligence/persistence/atomicFile');
const { build, researchToCompletion, makeClock } = require('./helpers');
const { FakeResearchProvider } = require('../../src/main/lead-intelligence/providers/FakeResearchProvider');

let initSqlJs = null;
try {
  initSqlJs = require('sql.js');
} catch {
  initSqlJs = null;
}
const skip = initSqlJs ? false : 'sql.js is not installed (it is already a ZTech dependency; run npm install in this package for tests)';

async function freshStore(bytes) {
  const SQL = await initSqlJs();
  const db = bytes ? new SQL.Database(bytes) : new SQL.Database();
  let saves = 0;
  const store = new SqlJsStore({ db, persist: () => { saves += 1; }, logger: { warn() {} } });
  await store.migrate();
  return { store, db, saves: () => saves, SQL };
}

test('migrations: embedded SQL is identical to migrations/*.sql', () => {
  for (const m of MIGRATIONS) {
    const onDisk = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'lead-intelligence', 'migrations', m.name), 'utf8');
    assert.equal(m.sql, onDisk, m.name);
  }
});

test('sqljs: migrate is idempotent and records the version', { skip }, async () => {
  const { store, db } = await freshStore();
  await store.migrate();
  const rows = db.exec('SELECT version FROM li_schema_migrations');
  // F19 declared lock update: [[1],[2],[3]] -> [[1],[2],[3],[4]]
  assert.deepEqual(rows[0].values, [[1], [2], [3], [4]]);
  const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'li_%' ORDER BY name")[0].values.flat();
  // F19 declared lock update: + li_outreach_sends (the outbound send ledger)
  assert.deepEqual(tables, ['li_enrichment_jobs', 'li_enrichment_observations', 'li_evidence_packets', 'li_outreach_activity', 'li_outreach_approvals', 'li_outreach_sends', 'li_pitch_drafts', 'li_research_changes', 'li_research_jobs', 'li_saved_searches', 'li_schema_migrations', 'li_segment_members', 'li_segments']);
  // A second migrate() adds nothing.
  await store.migrate();
  assert.deepEqual(db.exec('SELECT version FROM li_schema_migrations')[0].values, [[1], [2], [3], [4]]);
  assert.equal(db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'li_%'")[0].values.flat().length, 13);
});

test('sqljs: full research flow persists, and persist() is called after writes', { skip }, async () => {
  const { store, saves } = await freshStore();
  const ctx = build({ store });
  const { status } = await researchToCompletion(ctx, 'L1');
  assert.equal(status.research_state, 'complete');
  const p = await store.packets.latestForLead('L1');
  assert.equal(p.lead_id, 'L1');
  assert.ok(saves() > 3);
});

test('sqljs: unique index enforces one active job per request key', { skip }, async () => {
  const { store } = await freshStore();
  const job = { job_id: 'rjob_a', lead_id: 'L1', provider_id: 'fake', request_key: 'k', requested_domain: 'acme.com', domain_key: 'acme.com', state: 'requested', options: {}, attempts: 0, poll_count: 0, created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z', version: 1 };
  await store.jobs.insert(job);
  await assert.rejects(store.jobs.insert({ ...job, job_id: 'rjob_b' }), (e) => e.code === 'DUPLICATE_ACTIVE_JOB');
  await store.jobs.update({ ...job, state: 'preflight', version: 2 }, 1);
  await store.jobs.update({ ...job, state: 'failed', version: 3 }, 2);
  await store.jobs.insert({ ...job, job_id: 'rjob_c' }); // allowed: previous job no longer active
});

test('sqljs: compare-and-set rejects stale versions', { skip }, async () => {
  const { store } = await freshStore();
  const job = { job_id: 'rjob_a', lead_id: 'L1', provider_id: 'fake', request_key: 'k', state: 'requested', options: {}, created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z', version: 1 };
  await store.jobs.insert(job);
  await store.jobs.update({ ...job, state: 'preflight', version: 2 }, 1);
  await assert.rejects(store.jobs.update({ ...job, state: 'blocked', version: 2 }, 1), (e) => e.code === 'CONFLICT');
  await assert.rejects(store.jobs.update({ ...job, job_id: 'missing' }, 1), (e) => e.code === 'NOT_FOUND');
});

test('sqljs: restart recovery from the saved database bytes', { skip }, async () => {
  const clock = makeClock();
  const provider = new FakeResearchProvider({ clock, scenarios: { 'acme.com': { polls: ['running', 'complete'] } } });
  const first = await freshStore();
  const ctx1 = build({ store: first.store, clock, providers: new Map([['fake', provider]]) });
  await ctx1.li.gateway.requestResearch({ leadId: 'L1' });
  await ctx1.li.gateway.idle();
  const bytes = first.db.export(); // what saveDB() writes to disk

  const second = await freshStore(bytes);
  const ctx2 = build({ store: second.store, clock, providers: new Map([['fake', provider]]) });
  for (let i = 0; i < 3; i += 1) { clock.advance(1500); await ctx2.li.coordinator.tick(); }
  const [job] = await second.store.jobs.listByLead('L1');
  assert.equal(job.state, 'complete');
  assert.equal(provider.calls.filter((c) => c[0] === 'start').length, 1);
});

test('sqljs: corrupt JSON rows are skipped and reported, not fatal', { skip }, async () => {
  const { store, db } = await freshStore();
  const ctx = build({ store });
  await researchToCompletion(ctx, 'L1');
  await researchToCompletion(ctx, 'L1', { force: true });
  const [newest] = await store.packets.listMetaByLead('L1');
  db.run('UPDATE li_evidence_packets SET packet_json = ? WHERE packet_id = ?', ['{broken', newest.packet_id]);
  const p = await store.packets.latestForLead('L1');
  assert.ok(p, 'falls back to the older readable packet');
  assert.notEqual(p.packet_id, newest.packet_id);
  assert.equal(store.corruptRows.length > 0, true);
  db.run("INSERT INTO li_saved_searches VALUES ('srch_x','X','{nope','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')");
  assert.deepEqual(await store.savedSearches.list(), []);
});

test('sqljs: saved searches, segments, members, pitches, approvals round-trip', { skip }, async () => {
  const { store } = await freshStore();
  await store.savedSearches.upsert({ search_id: 'srch_1', name: 'B', filter: { website: 'present' }, created_at: 'c', updated_at: 'u' });
  await store.savedSearches.upsert({ search_id: 'srch_1', name: 'B2', filter: { website: 'absent' }, created_at: 'ignored', updated_at: 'u2' });
  const s = await store.savedSearches.get('srch_1');
  assert.equal(s.name, 'B2');
  assert.equal(s.created_at, 'c');
  assert.deepEqual(s.filter, { website: 'absent' });
  await store.segments.upsert({ segment_id: 'seg_1', name: 'S', kind: 'static', filter: null, created_at: 'c', updated_at: 'u' });
  assert.equal(await store.segments.addMembers('seg_1', ['L1', 'L2', 'L1'], 't'), 2);
  assert.equal(await store.segments.removeMembers('seg_1', ['L2']), 1);
  assert.deepEqual(await store.segments.members('seg_1'), ['L1']);
  await store.purgeLead('L1');
  assert.deepEqual(await store.segments.members('seg_1'), []);
  assert.equal(await store.segments.delete('seg_1'), true);
  await store.pitches.upsert({ pitch_id: 'pitch_1', lead_id: 'L3', packet_id: null, status: 'draft', content_hash: 'h', created_at: 'a', updated_at: 'b' });
  await store.approvals.insert({ approval_id: 'a1', pitch_id: 'pitch_1', content_hash: 'h', approved_by: 'me', approved_at: '2026-09-01T00:00:00Z' });
  assert.equal((await store.pitches.latestForLead('L3')).pitch_id, 'pitch_1');
  assert.equal((await store.approvals.latestForPitch('pitch_1')).content_hash, 'h');
});

test('atomic file write keeps a backup; JSON reader recovers from corruption', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'li-atomic-'));
  const f = path.join(dir, 'settings.json');
  writeFileAtomic(f, JSON.stringify({ v: 1 }));
  writeFileAtomic(f, JSON.stringify({ v: 2 }));
  assert.deepEqual(JSON.parse(fs.readFileSync(`${f}.bak`, 'utf8')), { v: 1 });
  fs.writeFileSync(f, '{corrupt');
  const r = readJsonWithRecovery(f, { v: 0 }, { logger: { warn() {} } });
  assert.deepEqual(r, { value: { v: 1 }, source: 'backup', corrupt: true });
  const missing = readJsonWithRecovery(path.join(dir, 'none.json'), { v: 0 });
  assert.deepEqual(missing, { value: { v: 0 }, source: 'default', corrupt: false });
  assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')).length, 0);
});

/* ---------------- F12 Batch 1: pitch enumeration ---------------- */

// A pitch record shaped exactly like PitchGenerator's output, so the list path is
// proved against the real field set rather than a reduced fixture.
function pitchRec(over = {}) {
  return {
    pitch_id: 'pitch_1',
    lead_id: 'L1',
    packet_id: 'pkt_1',
    research_status: 'complete',
    target_id: null,
    icp_fit_status: null,
    subject: 'A few notes on www.example.com',
    opening: 'Hi Example team,',
    observations: [{ text: 'No meta description', refs: ['find_1', 'fact_1'], provenance: [{ ref_id: 'find_1', provider: 'round1-zuni-seo' }] }],
    valueProposition: 'We fix the issues found in an audit.',
    callToAction: 'Would a short call be useful?',
    evidenceReferences: [{ ref_id: 'find_1', provider: 'round1-zuni-seo' }],
    unsupportedClaims: [],
    status: 'draft',
    content_hash: 'hash_1',
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    ...over,
  };
}

const ids = (page) => page.rows.map((p) => p.pitch_id);

test('pitch list: an empty store returns an empty page', { skip }, async () => {
  const { store } = await freshStore();
  const page = await store.pitches.list();
  assert.deepEqual(page.rows, []);
  assert.equal(page.total, 0);
  assert.equal(page.status, null);
});

test('pitch list: one pitch is returned with the full draft_json object', { skip }, async () => {
  const { store } = await freshStore();
  await store.pitches.upsert(pitchRec());
  const page = await store.pitches.list();
  assert.equal(page.total, 1);
  assert.deepEqual(ids(page), ['pitch_1']);
  // The full persisted object survives the round-trip: nothing is reconstructed.
  assert.deepEqual(page.rows[0], pitchRec());
});

test('pitch list: multiple pitches are returned', { skip }, async () => {
  const { store } = await freshStore();
  await store.pitches.upsert(pitchRec({ pitch_id: 'pitch_1' }));
  await store.pitches.upsert(pitchRec({ pitch_id: 'pitch_2' }));
  await store.pitches.upsert(pitchRec({ pitch_id: 'pitch_3' }));
  const page = await store.pitches.list();
  assert.equal(page.total, 3);
  assert.deepEqual(ids(page).sort(), ['pitch_1', 'pitch_2', 'pitch_3']);
});

test('pitch list: ordering is updated_at DESC with a deterministic pitch_id tie-breaker', { skip }, async () => {
  const { store } = await freshStore();
  // Two rows deliberately share a timestamp to prove the tie-breaker, not luck.
  // The tie pair is inserted in the OPPOSITE order to the one expected back, so an
  // implementation that falls back to storage order (rowid ASC) fails this test
  // instead of coincidentally agreeing with it.
  await store.pitches.upsert(pitchRec({ pitch_id: 'pitch_old', updated_at: '2026-01-01T00:00:00.000Z' }));
  await store.pitches.upsert(pitchRec({ pitch_id: 'pitch_tie_a', updated_at: '2026-06-01T00:00:00.000Z' }));
  await store.pitches.upsert(pitchRec({ pitch_id: 'pitch_tie_b', updated_at: '2026-06-01T00:00:00.000Z' }));
  await store.pitches.upsert(pitchRec({ pitch_id: 'pitch_new', updated_at: '2026-12-01T00:00:00.000Z' }));
  // updated_at DESC first, then pitch_id DESC within the tie.
  const expected = ['pitch_new', 'pitch_tie_b', 'pitch_tie_a', 'pitch_old'];
  assert.deepEqual(ids(await store.pitches.list()), expected);
  // Repeated calls return the identical order.
  assert.deepEqual(ids(await store.pitches.list()), expected);
  assert.deepEqual(ids(await store.pitches.list()), expected);
  // Paging must not change the order of the page it returns.
  assert.deepEqual(ids(await store.pitches.list({ limit: 2 })), ['pitch_new', 'pitch_tie_b']);
  assert.deepEqual(ids(await store.pitches.list({ limit: 2, offset: 1 })), ['pitch_tie_b', 'pitch_tie_a']);
});

test('pitch list: limit is honoured and total still reports the whole set', { skip }, async () => {
  const { store } = await freshStore();
  for (let i = 1; i <= 5; i++) {
    await store.pitches.upsert(pitchRec({ pitch_id: `pitch_${i}`, updated_at: `2026-01-0${i}T00:00:00.000Z` }));
  }
  const page = await store.pitches.list({ limit: 2 });
  assert.equal(page.limit, 2);
  assert.equal(page.rows.length, 2);
  assert.equal(page.total, 5, 'total counts the filtered set, not the page');
  assert.deepEqual(ids(page), ['pitch_5', 'pitch_4']);
});

test('pitch list: offset pages through without overlapping or dropping rows', { skip }, async () => {
  const { store } = await freshStore();
  for (let i = 1; i <= 5; i++) {
    await store.pitches.upsert(pitchRec({ pitch_id: `pitch_${i}`, updated_at: `2026-01-0${i}T00:00:00.000Z` }));
  }
  const first = await store.pitches.list({ limit: 2, offset: 0 });
  const second = await store.pitches.list({ limit: 2, offset: 2 });
  const last = await store.pitches.list({ limit: 2, offset: 4 });
  assert.deepEqual(ids(first), ['pitch_5', 'pitch_4']);
  assert.deepEqual(ids(second), ['pitch_3', 'pitch_2']);
  assert.deepEqual(ids(last), ['pitch_1']);
  const seen = [...ids(first), ...ids(second), ...ids(last)];
  assert.equal(new Set(seen).size, 5, 'no row is duplicated or lost across pages');
  const past = await store.pitches.list({ offset: 99 });
  assert.deepEqual(past.rows, []);
  assert.equal(past.total, 5);
});

for (const status of ['draft', 'insufficient_evidence', 'needs_revision']) {
  test(`pitch list: status="${status}" filters in the store layer`, { skip }, async () => {
    const { store } = await freshStore();
    await store.pitches.upsert(pitchRec({ pitch_id: 'pitch_draft', status: 'draft' }));
    await store.pitches.upsert(pitchRec({ pitch_id: 'pitch_insuff', status: 'insufficient_evidence' }));
    await store.pitches.upsert(pitchRec({ pitch_id: 'pitch_rev', status: 'needs_revision' }));
    const page = await store.pitches.list({ status });
    assert.deepEqual(ids(page), [`pitch_${status === 'draft' ? 'draft' : status === 'insufficient_evidence' ? 'insuff' : 'rev'}`]);
    assert.equal(page.total, 1);
    assert.equal(page.status, status);
  });
}

test('pitch list: an unknown status is rejected, and no invented state is accepted', { skip }, async () => {
  const { store } = await freshStore();
  await store.pitches.upsert(pitchRec());
  // These are NOT pitch states in this architecture and must never be filterable:
  // approved/approval_required/sent/failed would be fabricated states, and
  // blocked/allowed belong to OutreachGate.decision, which is never persisted.
  for (const bad of ['approved', 'approval_required', 'sent', 'failed', 'blocked', 'allowed', 'DRAFT', '', 42, {}]) {
    if (bad === '') {
      const empty = await store.pitches.list({ status: '' });
      assert.equal(empty.status, null, 'an empty status means "no filter"');
      continue;
    }
    await assert.rejects(() => store.pitches.list({ status: bad }), (e) => e.code === 'VALIDATION_FAILED', `status ${JSON.stringify(bad)} must be rejected`);
  }
  // A rejected query must not have written or removed anything.
  assert.equal((await store.pitches.list()).total, 1);
});

test('pitch list: paging inputs are bounded, never silently unbounded', { skip }, async () => {
  const { store } = await freshStore();
  await store.pitches.upsert(pitchRec());
  // An out-of-range page size falls back to the default rather than being honoured,
  // matching AccountStore.queryNumbers, so a malformed request can never read the
  // whole table. The cap and the default are both bounded well below the table size.
  for (const over of [101, 100000, Infinity]) {
    const page = await store.pitches.list({ limit: over });
    assert.equal(page.limit, 20, `limit ${over} falls back to the default`);
  }
  for (const bad of [0, -1, 1.5, 'ten', null, undefined]) {
    const page = await store.pitches.list({ limit: bad });
    assert.equal(page.limit, 20, `limit ${JSON.stringify(bad)} falls back to the default`);
  }
  // An explicit in-range limit is still honoured, so the fallback is not masking it.
  assert.equal((await store.pitches.list({ limit: 100 })).limit, 100);
  assert.equal((await store.pitches.list({ limit: 1 })).limit, 1);
  const badOffset = await store.pitches.list({ offset: -5 });
  assert.equal(badOffset.offset, 0);
  const hugeOffset = await store.pitches.list({ offset: 1e9 });
  assert.equal(hugeOffset.offset, 0, 'an over-large offset falls back to the start');
  const junk = await store.pitches.list('not-an-object');
  assert.equal(junk.limit, 20);
  assert.equal(junk.offset, 0);
  assert.equal(junk.status, null);
});

test('pitch list: the persisted status set matches what PitchGenerator can actually produce', () => {
  const { PITCH_STATUSES } = require('../../src/main/lead-intelligence/persistence/contract');
  // statusFor() is the only writer of pitch.status. Drive the real generator for every
  // reachable input so the store's filter set cannot drift from what is written.
  const { generatePitch } = require('../../src/main/lead-intelligence/outreach/PitchGenerator');
  const view = { id: 'L1', name: 'Example', email: 'a@b.com', qualification_status: 'qualified' };
  // A packet shaped for indexPacket(), which reads facts/findings/strengths.
  const packet = (research_status, findings, facts) => ({
    packet_id: 'pkt_1', research_status, requested_domain: 'x.com', audited_domain: 'x.com',
    captured_at: '2026-01-01T00:00:00.000Z', facts: facts || [], strengths: [], findings: findings || [],
  });
  const produced = new Set([
    // no packet at all
    generatePitch({ view, packet: null, offer: {} }).status,
    // a packet that produced no eligible observations
    generatePitch({ view, packet: packet('complete', []), offer: {} }).status,
    // failed research
    generatePitch({ view, packet: packet('failed', []), offer: {} }).status,
    // one real, cited observation -> a clean draft. The observation's refs must all
    // resolve in the packet index, otherwise the claim detector rejects it.
    generatePitch({
      view, offer: {},
      packet: packet('complete',
        [{ severity: 'high', basis: 'standard', title: 'No meta description', observed: '4 of 14 pages', finding_id: 'find_1', fact_ids: ['fact_1'] }],
        [{ fact_id: 'fact_1', key: 'pages_without_meta', value: 4 }]),
    }).status,
    // an observation whose ref does not exist in the packet -> unsupported claim
    generatePitch({
      view, offer: {},
      packet: packet('complete', [{ severity: 'high', basis: 'standard', title: 'No meta description', observed: '4 of 14 pages', finding_id: 'find_1', fact_ids: ['fact_missing'] }]),
    }).status,
    // a prohibited claim in the offer text -> needs revision
    generatePitch({ view, packet: null, offer: { value_proposition: 'We guarantee 10x your revenue.' } }).status,
  ]);
  for (const s of produced) assert.ok(PITCH_STATUSES.includes(s), `${s} must be a filterable persisted status`);
  // All three real states are reachable, and the store knows exactly those three.
  assert.deepEqual([...produced].sort(), ['draft', 'insufficient_evidence', 'needs_revision']);
  assert.deepEqual([...PITCH_STATUSES].sort(), ['draft', 'insufficient_evidence', 'needs_revision']);
});

test('memory store pitch list exposes the same contract as the SQL store', async () => {
  const { MemoryStore } = require('../../src/main/lead-intelligence/persistence/MemoryStore');
  const mem = new MemoryStore();
  // Same shape of envelope, same validation, same ordering.
  const empty = await mem.pitches.list();
  assert.deepEqual(empty, { rows: [], total: 0, limit: 20, offset: 0, status: null });

  // Inserted in the opposite order to the one expected back, so storage/insertion
  // order cannot accidentally satisfy the tie.
  await mem.pitches.upsert(pitchRec({ pitch_id: 'pitch_old', updated_at: '2026-01-01T00:00:00.000Z' }));
  await mem.pitches.upsert(pitchRec({ pitch_id: 'pitch_tie_a', updated_at: '2026-06-01T00:00:00.000Z' }));
  await mem.pitches.upsert(pitchRec({ pitch_id: 'pitch_tie_b', updated_at: '2026-06-01T00:00:00.000Z' }));
  await mem.pitches.upsert(pitchRec({ pitch_id: 'pitch_new', updated_at: '2026-12-01T00:00:00.000Z', status: 'needs_revision' }));
  assert.deepEqual((await mem.pitches.list()).rows.map((p) => p.pitch_id), ['pitch_new', 'pitch_tie_b', 'pitch_tie_a', 'pitch_old']);
  assert.deepEqual((await mem.pitches.list({ limit: 2 })).rows.map((p) => p.pitch_id), ['pitch_new', 'pitch_tie_b']);
  assert.equal((await mem.pitches.list({ limit: 2 })).total, 4);
  assert.deepEqual((await mem.pitches.list({ offset: 3 })).rows.map((p) => p.pitch_id), ['pitch_old']);
  assert.deepEqual((await mem.pitches.list({ status: 'draft' })).rows.map((p) => p.pitch_id), ['pitch_tie_b', 'pitch_tie_a', 'pitch_old']);
  assert.equal((await mem.pitches.list({ status: 'needs_revision' })).total, 1);
  await assert.rejects(() => mem.pitches.list({ status: 'approved' }), (e) => e.code === 'VALIDATION_FAILED');
  // The full record is preserved, not a projection.
  assert.deepEqual((await mem.pitches.list({ status: 'needs_revision' })).rows[0], pitchRec({ pitch_id: 'pitch_new', updated_at: '2026-12-01T00:00:00.000Z', status: 'needs_revision' }));
});

test('pitch list: memory and SQL stores agree row for row on the same data', { skip }, async () => {
  const { MemoryStore } = require('../../src/main/lead-intelligence/persistence/MemoryStore');
  const { store } = await freshStore();
  const mem = new MemoryStore();
  const seed = [
    pitchRec({ pitch_id: 'pitch_1', updated_at: '2026-01-01T00:00:00.000Z' }),
    pitchRec({ pitch_id: 'pitch_2', updated_at: '2026-03-01T00:00:00.000Z', status: 'needs_revision' }),
    pitchRec({ pitch_id: 'pitch_3', updated_at: '2026-02-01T00:00:00.000Z', status: 'insufficient_evidence' }),
  ];
  for (const r of seed) { await store.pitches.upsert(r); await mem.pitches.upsert(r); }
  for (const q of [{}, { limit: 2 }, { limit: 2, offset: 1 }, { status: 'draft' }, { status: 'needs_revision' }, { status: 'insufficient_evidence' }]) {
    const a = await store.pitches.list(q);
    const b = await mem.pitches.list(q);
    assert.deepEqual(ids(a), ids(b), `ordering must match for ${JSON.stringify(q)}`);
    assert.equal(a.total, b.total, `total must match for ${JSON.stringify(q)}`);
    assert.equal(a.limit, b.limit);
    assert.equal(a.offset, b.offset);
    assert.equal(a.status, b.status);
  }
});
