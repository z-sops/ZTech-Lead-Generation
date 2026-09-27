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
  assert.deepEqual(rows[0].values, [[1], [2]]);
  const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'li_%' ORDER BY name")[0].values.flat();
  assert.deepEqual(tables, ['li_enrichment_jobs', 'li_enrichment_observations', 'li_evidence_packets', 'li_outreach_approvals', 'li_pitch_drafts', 'li_research_changes', 'li_research_jobs', 'li_saved_searches', 'li_schema_migrations', 'li_segment_members', 'li_segments']);
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
