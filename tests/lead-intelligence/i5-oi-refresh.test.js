'use strict';

/**
 * I5 - Opportunity Intelligence freshness, persistent refresh idempotency, missing-report
 * recovery and restart behaviour.
 *
 * Runs the REAL OpportunityIntelligenceService, gateway, association store, refresh ledger
 * and SqlJsStore (migration 007) against a fake OI REST service that implements OI's own
 * idempotency rules (a known key never runs the pipeline again). `pipelineRuns` counts what
 * would have been paid provider work. No real network.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

let initSqlJs = null;
try { initSqlJs = require('sql.js'); } catch { initSqlJs = null; }
const skip = initSqlJs ? false : 'sql.js not installed';

const LI = path.join(__dirname, '..', '..', 'src', 'main', 'lead-intelligence');
const OP = path.join(LI, 'opportunity');
const { OpportunityIntelligenceService, MAX_REPORT_LOOKUPS, I5_COPY, classifyResearchFailure } = require(path.join(OP, 'OpportunityIntelligenceService'));
const { classifyOiFreshness, OI_FRESHNESS_POLICY } = require(path.join(OP, 'oiFreshness'));
const { mintRequestId } = require(path.join(OP, 'OpportunityRefreshLedger'));
const { MemoryStore } = require(path.join(LI, 'persistence', 'MemoryStore'));
const { SqlJsStore } = require(path.join(LI, 'persistence', 'SqlJsStore'));
const fixtures = require('./opportunity-fixtures');

const SILENT = { info() {}, warn() {}, error() {}, debug() {} };
const BASE = 'http://127.0.0.1:8099';
const DAY = 24 * 60 * 60 * 1000;
const LEAD = '5';
const VIEW = { company_name: 'Acme Bakery', domain: 'acmebakery.pk' };
const T0 = Date.parse('2026-10-07T12:00:00.000Z');

const resp = (status, body) => ({ ok: status < 400, status, headers: { get: () => null }, text: async () => JSON.stringify(body) });

/** A fake OI that keeps reports and enforces OI's idempotency contract. */
function fakeOi(clock) {
  const st = {
    reports: new Map(), jobs: new Map(), posts: [], gets: [], pipelineRuns: 0, seq: 0,
    down: false,          // every call throws (OI not reachable)
    mode: 'ok',           // ok | networkAfterRun | inProgress | fail500 | reject400
    gate: null,           // a promise the next POST waits on (to hold a run in flight)
  };
  const run = (key) => {
    st.pipelineRuns += 1;
    st.seq += 1;
    const tag = String(st.seq).padStart(8, '0');
    const iso = new Date(clock()).toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
    const rep = fixtures.report({
      research_id: `res_${iso}_${tag}`, snapshot_id: `snap_${iso}_${tag}`, generated_at: new Date(clock()).toISOString(),
    });
    st.reports.set(rep.research_id, rep);
    if (key) st.jobs.set(key, { rid: rep.research_id, status: 'done' });
    return rep;
  };
  const fetchImpl = async (url, init = {}) => {
    const method = init.method || 'GET';
    if (url === `${BASE}/v1/health`) return resp(200, { status: 'ok', schema_version: '1.0', instance_id: null });
    if (st.down) throw new Error('connect ECONNREFUSED 127.0.0.1:8099');
    if (method === 'POST' && url === `${BASE}/v1/research`) {
      const body = JSON.parse(init.body);
      const key = body.options && body.options.idempotency_key;
      st.posts.push(key);
      if (st.gate) { const g = st.gate; st.gate = null; await g; }
      const job = key ? st.jobs.get(key) : null;
      if (job) {
        if (job.status === 'running') return resp(409, { error: 'IN_PROGRESS', message: 'still running', retryable: true, details: { research_id: 'x', idempotent_replay: true } });
        if (job.status === 'failed') return resp(500, { error: 'PROVIDER_FAILED', message: 'search failed', retryable: false, details: { research_id: 'x', idempotent_replay: true } });
        return resp(200, st.reports.get(job.rid) || {});
      }
      if (st.mode === 'inProgress') { st.jobs.set(key, { status: 'running' }); return resp(409, { error: 'IN_PROGRESS', message: 'still running', retryable: true, details: { idempotent_replay: true } }); }
      if (st.mode === 'fail500') { st.jobs.set(key, { status: 'failed' }); return resp(500, { error: 'INTERNAL_ERROR', message: 'RuntimeError', retryable: false }); }
      if (st.mode === 'reject400') return resp(400, { error: 'VALIDATION_ERROR', message: 'invalid research request', retryable: false });
      const rep = run(key);
      if (st.mode === 'networkAfterRun') throw new Error('The operation was aborted due to timeout');
      return resp(200, rep);
    }
    const m = url.match(/\/v1\/reports\/([^/?]+)/);
    if (method === 'GET' && m) {
      st.gets.push(m[1]);
      return st.reports.has(m[1]) ? resp(200, st.reports.get(m[1])) : resp(404, { error: 'NOT_FOUND', message: 'no report', retryable: false });
    }
    return resp(404, { error: 'NOT_FOUND' });
  };
  return { st, fetchImpl };
}

async function build({ store = new MemoryStore(), now = { t: T0 }, oi = null } = {}) {
  const clock = () => new Date(now.t);
  const fake = oi || fakeOi(clock);
  const svc = new OpportunityIntelligenceService({
    config: { enabled: true, baseUrl: BASE }, fetchImpl: fake.fetchImpl, clock, logger: SILENT,
    associationBacking: store.oiAssociations, refreshBacking: store.oiRefreshRequests,
  });
  await svc.associations.load();
  await svc.start();
  return { svc, store, now, oi: fake, st: fake.st, run: (o = {}) => svc.researchForLead({ leadId: LEAD, leadView: VIEW, ...o }) };
}

async function sqlStore(bytes) {
  const SQL = await initSqlJs();
  const s = new SqlJsStore({ db: bytes ? new SQL.Database(bytes) : new SQL.Database(), logger: SILENT });
  await s.migrate();
  return s;
}

// ============================================================ freshness (1-5)

test('1. freshness boundaries come from the one policy module: 0, 6.9, 7, 30, 31 days', () => {
  assert.deepEqual(OI_FRESHNESS_POLICY, { FRESH_MAX_DAYS: 7, EXPIRED_AFTER_DAYS: 30, FUTURE_SKEW_MS: 300000 });
  const at = (days) => new Date(T0 - days * DAY).toISOString();
  const states = [0, 6.9, 7, 30, 31].map((d) => classifyOiFreshness(at(d), new Date(T0)).state);
  assert.deepEqual(states, ['fresh', 'fresh', 'stale', 'stale', 'expired']);
  const f = classifyOiFreshness(at(10.5), new Date(T0));
  assert.deepEqual({ ...f }, { state: 'stale', ageDays: 10, generatedAt: at(10.5), refreshRecommended: true });
  assert.equal(classifyOiFreshness(at(1), new Date(T0)).refreshRecommended, false);
  // No magic numbers elsewhere: the service and renderer never restate the thresholds.
  const svcSrc = fs.readFileSync(path.join(OP, 'OpportunityIntelligenceService.js'), 'utf8');
  assert.equal(/\b(7|30)\s*\*\s*(24|DAY)/.test(svcSrc), false);
});

test('2. missing, unparseable or future times are unknown, never fresh', () => {
  const now = new Date(T0);
  for (const v of [null, undefined, '', 'yesterday', '2026-13-45T99:00:00Z', new Date(T0 + 10 * 60 * 1000).toISOString()]) {
    assert.equal(classifyOiFreshness(v, now).state, 'unknown', String(v));
    assert.equal(classifyOiFreshness(v, now).refreshRecommended, true);
  }
  assert.equal(classifyOiFreshness(new Date(T0 + 2 * 60 * 1000).toISOString(), now).state, 'fresh', 'small clock skew tolerated');
});

test('3. freshness is shown from the stored association when OI is down', async () => {
  const b = await build();
  await b.run();
  b.now.t += 9 * DAY;
  b.st.down = true;
  const v = await b.svc.latestForLead({ leadId: LEAD });
  assert.equal(v.available, false);
  assert.notEqual(v.state, 'report_missing', 'could not ask is never "missing"');
  assert.equal(v.freshness.state, 'stale');
  assert.equal(v.freshness.ageDays, 9);
});

test('4. freshness never reaches outreach: no outreach or gate module imports it, every view says affects_outreach:false', async () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const users = walk(LI).filter((f) => f.endsWith('.js') && fs.readFileSync(f, 'utf8').includes('oiFreshness'));
  assert.deepEqual(users.map((f) => path.relative(OP, f)).sort(), ['OpportunityIntelligenceService.js']);
  const b = await build();
  const views = [await b.run(), await b.svc.latestForLead({ leadId: LEAD })];
  b.now.t += 40 * DAY;
  views.push(await b.svc.latestForLead({ leadId: LEAD }));
  for (const v of views) assert.equal(v.affects_outreach, false);
  assert.equal(views[2].freshness.state, 'expired');
  assert.ok(views[2].model, 'an expired report is still shown, never hidden');
});

test('5. nothing runs by itself: no timers in the I5 modules, and opening the drawer never posts', async () => {
  for (const f of ['oiFreshness.js', 'OpportunityRefreshLedger.js', 'OpportunityIntelligenceService.js']) {
    const src = fs.readFileSync(path.join(OP, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.equal(/setInterval|setTimeout|setImmediate|schedule/i.test(src), false, f);
  }
  const b = await build();
  await b.run();
  b.now.t += 60 * DAY;
  for (let i = 0; i < 3; i += 1) await b.svc.latestForLead({ leadId: LEAD });
  assert.equal(b.st.posts.length, 1, 'only the one deliberate run');
});

// ============================================================ refresh (6-11)

test('6. a refresh is a NEW snapshot; older history stays intact and readable', async () => {
  const b = await build();
  const first = await b.run();
  b.now.t += 10 * DAY;
  const second = await b.run();
  assert.notEqual(first.model.research_id, second.model.research_id);
  assert.notEqual(first.model.snapshot_id, second.model.snapshot_id);
  const list = b.svc.associations.listForLead(LEAD);
  assert.deepEqual(list.map((a) => a.research_id), [second.model.research_id, first.model.research_id]);
  const old = await b.svc.reportForResearchId({ leadId: LEAD, researchId: first.model.research_id });
  assert.equal(old.model.research_id, first.model.research_id, 'the old snapshot is still readable');
  assert.equal(b.st.pipelineRuns, 2);
});

test('7. two concurrent runs for one lead = exactly one OI POST; other leads are independent', async () => {
  const b = await build();
  let release;
  b.st.gate = new Promise((r) => { release = r; });
  const a = b.run();
  await new Promise((r) => setImmediate(r));
  const second = await b.run({ confirmFresh: true });
  assert.equal(second.state, 'in_progress');
  assert.equal(second.code, 'OI_RUN_IN_PROGRESS');
  const during = await b.svc.latestForLead({ leadId: LEAD });
  assert.equal(during.running, true, 'reopening the drawer during a run shows Running');
  const other = await b.svc.researchForLead({ leadId: '6', leadView: { company_name: 'Other Co', domain: 'other.pk' } });
  assert.equal(other.state, 'ok', 'another lead is not blocked');
  release();
  assert.equal((await a).state, 'ok');
  assert.equal(b.st.posts.filter((k) => k.startsWith('ztech-5-')).length, 1);
  assert.equal((await b.svc.latestForLead({ leadId: LEAD })).running, false);
});

test('8. the lock is released after success, a terminal failure and an unreachable OI', async () => {
  const b = await build();
  await b.run();
  b.now.t += 10 * DAY;
  b.st.mode = 'reject400';
  assert.equal((await b.run()).terminal, true);
  b.st.mode = 'ok';
  b.st.down = true;
  assert.equal((await b.run()).refresh_pending, true);
  b.st.down = false;
  assert.equal((await b.run()).state, 'ok', 'nothing is left locked');
  assert.equal(b.svc.inflight.size, 0);
});

test('9. timeout after OI finished: Retry reuses the SAME key and OI replays - one paid run, one association', async () => {
  const b = await build();
  b.st.mode = 'networkAfterRun';
  const t1 = await b.run();
  assert.equal(t1.available, false);
  assert.equal(t1.refresh_pending, true);
  assert.match(t1.message, /will not start a second paid run/);
  assert.equal(b.st.pipelineRuns, 1, 'OI did the work before ZTech gave up');
  b.st.mode = 'ok';
  const pending = await b.store.oiRefreshRequests.pendingForLead(LEAD);
  const retry = await b.run();
  assert.equal(retry.state, 'ok');
  assert.equal(retry.refresh.retried, true);
  assert.deepEqual(b.st.posts, [pending.request_id, pending.request_id], 'the retry sent the same key');
  assert.equal(b.st.pipelineRuns, 1, 'no second paid run');
  assert.equal(b.svc.associations.listForLead(LEAD).length, 1);
  const closed = (await b.store.oiRefreshRequests.listByLead(LEAD))[0];
  assert.deepEqual([closed.state, closed.research_id], ['succeeded', retry.model.research_id]);
  // The next DELIBERATE refresh is a new intent with a new key.
  b.now.t += 10 * DAY;
  await b.run();
  assert.notEqual(b.st.posts[2], pending.request_id);
  assert.equal(b.st.pipelineRuns, 2);
});

test('10. E3: refreshing a FRESH report needs confirmation (enforced in main); stale/expired do not ask', async () => {
  const b = await build();
  await b.run();
  b.now.t += 2 * DAY;
  const ask = await b.run();
  assert.equal(ask.state, 'confirm_required');
  assert.equal(ask.message, 'This report is still fresh. Refreshing may call configured paid providers again. Continue?');
  assert.equal(ask.freshness.state, 'fresh');
  assert.equal(b.st.posts.length, 1, 'cancel / no answer sends nothing');
  assert.equal(await b.store.oiRefreshRequests.pendingForLead(LEAD), null, 'and opens no intent');
  assert.equal((await b.run({ confirmFresh: true })).state, 'ok');
  b.now.t += 8 * DAY;
  assert.equal((await b.run()).state, 'ok', 'stale: no question');
  b.now.t += 40 * DAY;
  assert.equal((await b.run()).state, 'ok', 'expired: no question');
  assert.equal(b.st.posts.length, 4);
});

test('11. a failed refresh keeps the previous report and writes no association', async () => {
  const b = await build();
  const first = await b.run();
  b.now.t += 10 * DAY;
  b.st.mode = 'reject400';
  const f = await b.run();
  assert.equal(f.terminal, true);
  assert.equal(b.svc.associations.listForLead(LEAD).length, 1);
  const v = await b.svc.latestForLead({ leadId: LEAD });
  assert.equal(v.model.research_id, first.model.research_id);
  assert.equal(v.refresh_pending, false, 'a terminal answer closes the intent');
});

// ============================================================ E4 end to end

test('E4. OI still running this key (409 IN_PROGRESS) keeps the intent open; nothing re-runs', async () => {
  const b = await build();
  b.st.mode = 'inProgress';
  const a = await b.run();
  assert.equal(a.state, 'in_progress');
  assert.match(a.message, /no new paid run/);
  const again = await b.run();
  assert.equal(again.state, 'in_progress');
  assert.equal(b.st.posts[0], b.st.posts[1], 'same key both times');
  assert.equal(b.st.pipelineRuns, 0);
  assert.ok(await b.store.oiRefreshRequests.pendingForLead(LEAD));
});

test('E4. a failure stored in OI is replayed and closes the intent; only then does a new key appear', async () => {
  const b = await build();
  b.st.mode = 'fail500';
  const first = await b.run();
  assert.equal(first.refresh_pending, true, 'a first 5xx is ambiguous: keep the key');
  const second = await b.run();
  assert.equal(second.terminal, true, 'the replayed failure is terminal');
  assert.equal(b.st.posts[0], b.st.posts[1]);
  const row = (await b.store.oiRefreshRequests.listByLead(LEAD))[0];
  assert.deepEqual([row.state, row.error_code], ['failed', 'PROVIDER_FAILED']);
  b.st.mode = 'ok';
  await b.run();
  assert.notEqual(b.st.posts[2], b.st.posts[0], 'a new deliberate run gets a new key');
});

test('E4. if the intent cannot be recorded, nothing is sent to OI', async () => {
  const store = new MemoryStore();
  store.oiRefreshRequests.open = async () => { throw new Error('disk full'); };
  const b = await build({ store });
  const v = await b.run();
  assert.equal(v.state, 'refresh_store_unavailable');
  assert.equal(v.message, I5_COPY.notRecorded);
  assert.equal(b.st.posts.length, 0);
});

test('E4. keys: OI charset, <=128, unique per intent, never the bare lead id', () => {
  const a = mintRequestId('5');
  const b = mintRequestId('5');
  assert.notEqual(a, b);
  for (const k of [a, mintRequestId('lead with spaces/and;stuff'), mintRequestId('x'.repeat(500))]) {
    assert.match(k, /^[A-Za-z0-9._:-]{1,128}$/);
    assert.ok(k.length <= 128);
  }
  assert.notEqual(a, '5');
});

test('E4. failure classification', () => {
  const c = (r) => classifyResearchFailure(r);
  assert.equal(c({ status: 409, oiError: { code: 'IN_PROGRESS', replay: true } }), 'in_progress');
  assert.equal(c({ status: 500, oiError: { code: 'PROVIDER_FAILED', replay: true } }), 'terminal');
  assert.equal(c({ status: 409, oiError: { code: 'IDEMPOTENCY_CONFLICT', replay: false } }), 'terminal');
  assert.equal(c({ status: 400, oiError: { code: 'VALIDATION_ERROR' } }), 'terminal');
  assert.equal(c({ state: 'invalid_response' }), 'terminal');
  for (const r of [{ status: 500 }, { status: 429 }, { state: 'unavailable' }, { state: 'invalid_response', status: 502 }, { state: 'misconfigured' }]) {
    assert.equal(c(r), 'retryable', JSON.stringify(r));
  }
});

test('E4. restart mid-request: the persisted key survives and the retry after restart does not pay twice', { skip }, async () => {
  const now = { t: T0 };
  const s1 = await sqlStore();
  const b1 = await build({ store: s1, now });
  b1.st.mode = 'networkAfterRun';
  await b1.run();
  const key = (await s1.oiRefreshRequests.pendingForLead(LEAD)).request_id;
  // "Restart": a new store from the saved bytes, a new service, the SAME OI.
  const s2 = await sqlStore(s1.db.export());
  b1.st.mode = 'ok';
  const b2 = await build({ store: s2, now, oi: b1.oi });
  const reopened = await b2.svc.latestForLead({ leadId: LEAD });
  assert.equal(reopened.state, 'not_researched');
  assert.equal(reopened.running, false, 'no ghost Running after a restart');
  assert.equal(reopened.refresh_pending, true, 'the unfinished intent is visible');
  assert.equal(b1.st.posts.length, 1, 'reopening sent nothing');
  const retry = await b2.run();
  assert.equal(retry.state, 'ok');
  assert.deepEqual(b1.st.posts, [key, key]);
  assert.equal(b1.st.pipelineRuns, 1);
  assert.equal(await s2.oiRefreshRequests.pendingForLead(LEAD), null);
});

// ============================================================ recovery (12-16)

test('12. newest report missing -> the newest older report, labelled, with its own age; nothing deleted', async () => {
  const b = await build();
  const r1 = await b.run();
  b.now.t += 10 * DAY;
  await b.run();
  b.now.t += 10 * DAY;
  const r3 = await b.run();
  b.st.reports.delete(r3.model.research_id);
  b.now.t += 1 * DAY;
  const v = await b.svc.latestForLead({ leadId: LEAD });
  assert.equal(v.state, 'older_report');
  assert.equal(v.message, 'Showing an older report because the latest report is no longer available.');
  assert.equal(v.missing_newer, 1);
  assert.equal(v.freshness.ageDays, 11, 'the age of the report SHOWN, not of the newest row');
  assert.equal(v.freshness.state, 'stale');
  assert.equal(v.latest_generated_at, r3.model.generated_at);
  assert.notEqual(v.model.research_id, r3.model.research_id);
  assert.notEqual(v.model.research_id, r1.model.research_id);
  assert.equal(b.svc.associations.listForLead(LEAD).length, 3, 'no association is deleted');
});

test('13. none of the first five available -> report_missing with the approved copy, at most 5 lookups', async () => {
  assert.equal(MAX_REPORT_LOOKUPS, 5);
  const b = await build();
  for (let i = 0; i < 7; i += 1) { await b.run({ confirmFresh: true }); b.now.t += DAY; }
  b.st.reports.clear();
  b.st.gets.length = 0;
  const v = await b.svc.latestForLead({ leadId: LEAD });
  assert.equal(v.state, 'report_missing');
  assert.equal(v.message, "This lead's reports are no longer available. Run research again.");
  assert.equal(v.model, null);
  assert.equal(b.st.gets.length, 5);
});

test('14. a network failure during the walk is unavailable, never report_missing', async () => {
  const b = await build();
  await b.run();
  b.now.t += 10 * DAY;
  const r2 = await b.run();
  b.st.reports.delete(r2.model.research_id);
  const realFetch = b.oi.fetchImpl;
  let n = 0;
  b.svc.gateway.fetchImpl = async (url, init) => {
    if (/\/v1\/reports\//.test(url) && ++n === 2) throw new Error('connect ECONNREFUSED');
    return realFetch(url, init);
  };
  const v = await b.svc.latestForLead({ leadId: LEAD });
  assert.equal(v.state, 'unavailable');
  assert.notEqual(v.state, 'report_missing');
  assert.ok(v.freshness, 'the stored age is still shown');
});

test('15. a run started before the drawer closed still lands; reopening shows it', async () => {
  const b = await build();
  let release;
  b.st.gate = new Promise((r) => { release = r; });
  const p = b.run();
  await new Promise((r) => setImmediate(r));
  assert.equal((await b.svc.latestForLead({ leadId: LEAD })).running, true);
  release();
  await p;
  const after = await b.svc.latestForLead({ leadId: LEAD });
  assert.equal(after.state, 'ok');
  assert.equal(after.running, false);
  assert.equal(after.freshness.state, 'fresh');
});

test('16. restart from database bytes keeps associations and freshness; no running state, no run', { skip }, async () => {
  const now = { t: T0 };
  const s1 = await sqlStore();
  const b1 = await build({ store: s1, now });
  await b1.run();
  await b1.svc.associations.flush();
  now.t += 12 * DAY;
  const s2 = await sqlStore(s1.db.export());
  const b2 = await build({ store: s2, now, oi: b1.oi });
  const v = await b2.svc.latestForLead({ leadId: LEAD });
  assert.equal(v.state, 'ok');
  assert.equal(v.freshness.state, 'stale');
  assert.equal(v.freshness.ageDays, 12);
  assert.equal(v.running, false);
  assert.equal(v.refresh_pending, false);
  assert.equal(b1.st.posts.length, 1, 'restart and reopen never re-run research');
});

test('migration 007: one pending intent per lead (partial unique index); purgeLead removes the rows', { skip }, async () => {
  const s = await sqlStore();
  await s.oiRefreshRequests.open({ request_id: 'ztech-5-a', lead_id: '5', created_at: '2026-10-07T00:00:00.000Z' });
  await assert.rejects(() => s.oiRefreshRequests.open({ request_id: 'ztech-5-b', lead_id: '5', created_at: '2026-10-07T00:00:01.000Z' }));
  await s.oiRefreshRequests.close('ztech-5-a', { state: 'succeeded', research_id: 'res_1', updated_at: '2026-10-07T00:01:00.000Z' });
  await s.oiRefreshRequests.open({ request_id: 'ztech-5-b', lead_id: '5', created_at: '2026-10-07T00:02:00.000Z' });
  const cols = s.db.exec('PRAGMA table_info(li_oi_refresh_requests)')[0].values.map((r) => r[1]).sort();
  assert.deepEqual(cols, ['created_at', 'error_code', 'lead_id', 'request_id', 'research_id', 'state', 'updated_at']);
  await s.purgeLead('5');
  assert.deepEqual(await s.oiRefreshRequests.listByLead('5'), []);
});
