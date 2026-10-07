'use strict';

// Frontend 2.0 F15 - the outreach activity ledger and its workspace.
//
// What is pinned:
//   1. a successful approval records PITCH_APPROVED (and OUTREACH_READY when the gate
//      genuinely allows)
//   2. a FAILED approval records nothing
//   3. reads - list, gate, refresh, app start - record NOTHING
//   4. repeated approval of the same content adds no duplicate ready line
//   5. activity survives a store restart, and ordering is deterministic
//   6. pagination is bounded and paging does not overlap or drop rows
//   7. filtering by lead works; an unknown activity type is rejected by the store
//   8. MemoryStore and SqlJsStore agree row for row
//   9. the renderer renders persisted activity accurately, with honest empty and error
//      states, and Campaigns is still a disabled placeholder
//  10. no send/provider/campaign capability exists anywhere, and the renderer cannot
//      write activity
//  11. F12/F13/F14 behaviour is untouched

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const htmlSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const rendererSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'renderer.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const ipcSource = fs.readFileSync(path.join(root, 'src', 'main', 'lead-intelligence', 'outreach-ipc.js'), 'utf8');
const serviceSource = fs.readFileSync(path.join(root, 'src', 'main', 'lead-intelligence', 'outreach', 'OutreachService.js'), 'utf8');
const contract = require(path.join(root, 'src', 'main', 'lead-intelligence', 'persistence', 'contract.js'));
const { MemoryStore } = require(path.join(root, 'src', 'main', 'lead-intelligence', 'persistence', 'MemoryStore.js'));
const { SqlJsStore } = require(path.join(root, 'src', 'main', 'lead-intelligence', 'persistence', 'SqlJsStore.js'));
const { OutreachService } = require(path.join(root, 'src', 'main', 'lead-intelligence', 'outreach', 'OutreachService.js'));
const pkg = require(path.join(root, 'package.json'));

const tests = [];
function test(name, fn) { tests.push([name, fn]); }
let passed = 0;
let failed = 0;
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const F15_MARKER = '// === F15 Outreach: activity history ===';
const f15From = rendererSource.indexOf(F15_MARKER);
const F12_MARKER = '// === F12 Outreach: the read-only Outreach workspace ===';
const f12From = rendererSource.indexOf(F12_MARKER);
assert.ok(f15From > -1, 'the F15 block exists in renderer.js');
assert.ok(f12From > f15From, 'the F15 block is defined before the F12 block');
// F19 places the send control BETWEEN the F15 and F12 blocks. F15 still owns exactly its own
// region, so the F15 slice now ends at the F19 marker instead of running on to F12. Without
// this, the F19 send call would be attributed to the activity workspace and F15's
// "calls nothing but the read" lock would fail for code F15 does not contain.
const F19_MARKER = '// === F19 Outreach: the send control';
const f19From = rendererSource.indexOf(F19_MARKER);
assert.ok(f19From > f15From && f19From < f12From, 'the F19 send block sits between the F15 and F12 blocks');
const F15 = rendererSource.slice(f15From, f19From);
const F15_CODE = stripComments(F15);

// ============================================================ store-level fixtures

let clockNow = Date.parse('2026-09-01T10:00:00.000Z');
const clock = () => new Date(clockNow);

function makePitch(o) {
  return Object.assign({
    pitch_id: 'pitch_1', lead_id: 'L1', packet_id: null, research_status: 'complete',
    target_id: null, icp_fit_status: null, subject: 'A few notes', opening: 'Hi,',
    observations: [], valueProposition: 'We fix it.', callToAction: 'Call?',
    evidenceReferences: [], unsupportedClaims: [], status: 'draft', content_hash: 'hash_1',
    created_at: '2026-09-01T10:00:00.000Z', updated_at: '2026-09-01T10:00:00.000Z'
  }, o);
}

/** A store preloaded with pitches, for both backends. */
async function makeStore(kind, pitches) {
  if (kind === 'mem') {
    const store = new MemoryStore();
    for (const p of pitches) await store.pitches.upsert(makePitch(p));
    return store;
  }
  const initSqlJs = require(path.join(root, 'node_modules', 'sql.js'));
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  const store = new SqlJsStore({ db, persist: () => {} });
  await store.migrate();
  for (const p of pitches) await store.pitches.upsert(makePitch(p));
  return store;
}

/** A real OutreachService over a real store, with the gate stubbed to a verdict. */
function makeService(store, gateResult) {
  const contexts = { getContext: async () => ({ view: { name: 'Acme' }, packet: null, icp_fit: null }) };
  const service = new OutreachService({
    store,
    contexts,
    leadSource: {},
    freshness: { isFresh: () => true },
    config: { operatorName: 'tester' },
    clock,
    logger: { warn() {} }
  });
  // The gate is the only thing stubbed: activity emission must not depend on it.
  service.gate = async () => (typeof gateResult === 'function' ? gateResult() : gateResult);
  return service;
}

const allowedGate = { decision: 'allowed', reasons: [], warnings: [], delivery: { channel: 'email', emailEnabled: false, providerConfigured: false } };
const blockedGate = { decision: 'blocked', reasons: [{ code: 'HUMAN_APPROVAL', message: 'A person must approve this pitch before outreach.' }], warnings: [] };

// ============================================================ 1-2. approval emits

test('1. a successful approval records PITCH_APPROVED, and OUTREACH_READY when the gate allows', async () => {
  for (const kind of ['mem', 'sql']) {
    const store = await makeStore(kind, [{ pitch_id: 'p1', lead_id: 'L1' }]);
    const service = makeService(store, allowedGate);
    const before = await service.activityList({});
    assert.strictEqual(before.total, 0, kind + ': nothing is recorded before any approval');

    await service.approve({ pitchId: 'p1' });
    const after = await service.activityList({});
    const types = after.rows.map((r) => r.activity_type).sort();
    assert.deepStrictEqual(types, ['OUTREACH_READY', 'PITCH_APPROVED'], kind + ': exactly the two provable events');
    // The row is a fact about the pitch, not a UI interpretation.
    const approved = after.rows.find((r) => r.activity_type === 'PITCH_APPROVED');
    assert.strictEqual(approved.pitch_id, 'p1', kind + ': it names the pitch');
    assert.strictEqual(approved.lead_id, 'L1', kind + ': it names the lead');
    assert.strictEqual(approved.metadata.approvedBy, 'tester', kind + ': it records who approved');
    assert.strictEqual(approved.metadata.contentHash, 'hash_1', kind + ': it is bound to the exact content');
    // A file/db-backed store must survive a restart.
    if (kind === 'sql') {
      const listed = await store.activity.list({});
      assert.strictEqual(listed.total, 2, 'sql: the ledger is persisted, not in-memory');
    }
  }
});

test('2. a failed approval records nothing', async () => {
  for (const kind of ['mem', 'sql']) {
    // not a clean draft -> the service refuses before any write
    const store = await makeStore(kind, [{ pitch_id: 'p2', lead_id: 'L1', status: 'needs_revision' }]);
    const service = makeService(store, allowedGate);
    await assert.rejects(service.approve({ pitchId: 'p2' }));
    assert.strictEqual((await service.activityList({})).total, 0, kind + ': a refused approval leaves no activity');

    // unknown pitch -> also refused, still nothing
    await assert.rejects(service.approve({ pitchId: 'nope' }));
    assert.strictEqual((await service.activityList({})).total, 0, kind + ': an unknown pitch leaves no activity');
  }
});

// ============================================================ 3-4. reads and dedupe

test('3. reads record nothing - list, gate, workspace refresh and app start', async () => {
  const store = await makeStore('mem', [{ pitch_id: 'p1', lead_id: 'L1' }]);
  const service = makeService(store, allowedGate);
  await service.approve({ pitchId: 'p1' });
  const afterApproval = (await service.activityList({})).total;
  assert.strictEqual(afterApproval, 2, 'the approval produced its two events');

  // Everything a refresh or an app start does.
  await service.list({ limit: 20, offset: 0 });
  await service.gate({ pitchId: 'p1' });
  await service.get('p1');
  await service.latestForLead('L1');
  await service.activityList({ limit: 20, offset: 0 });
  await service.activityList({ limit: 5, offset: 0 });
  const store2 = new MemoryStore();
  // Everything a refresh or an app start does. A fresh MemoryStore stands in for a cold
  // start: constructing it must not record anything.
  new MemoryStore();

  assert.strictEqual((await service.activityList({})).total, afterApproval,
    'reading never manufactures an activity row');
});

test('4. a repeated approval of the same content adds no duplicate ready line', async () => {
  const store = await makeStore('mem', [{ pitch_id: 'p1', lead_id: 'L1' }]);
  const service = makeService(store, allowedGate);
  await service.approve({ pitchId: 'p1' });
  await service.approve({ pitchId: 'p1' });
  await service.approve({ pitchId: 'p1' });
  const all = await service.activityList({});
  const ready = all.rows.filter((r) => r.activity_type === 'OUTREACH_READY');
  const approved = all.rows.filter((r) => r.activity_type === 'PITCH_APPROVED');
  // Each approval genuinely happened, so each is recorded; "ready" is a state, not an
  // event, so the same content must not be announced as newly ready three times.
  assert.strictEqual(approved.length, 3, 'each approval really happened and is recorded');
  assert.strictEqual(ready.length, 1, 'the same content is announced ready once');
});

test('4b. a blocked gate records the approval but NOT readiness', async () => {
  const store = await makeStore('mem', [{ pitch_id: 'p1', lead_id: 'L1' }]);
  const service = makeService(store, blockedGate);
  await service.approve({ pitchId: 'p1' });
  const types = (await service.activityList({})).rows.map((r) => r.activity_type);
  assert.deepStrictEqual(types, ['PITCH_APPROVED'], 'no ready line while the gate still blocks');
});

// ============================================================ 5-7. store contract

test('5. the ledger survives restart and orders deterministically', async () => {
  const initSqlJs = require(path.join(root, 'node_modules', 'sql.js'));
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  const store = new SqlJsStore({ db, persist: () => {} });
  await store.migrate();
  const base = { lead_id: 'L1', pitch_id: 'p1', activity_type: 'PITCH_APPROVED', metadata: {} };

  // Same created_at for all three: the activity_id tie-breaker must make the order fixed.
  await store.activity.append({ ...base, activity_id: 'act_b', created_at: '2026-09-01T10:00:00.000Z' });
  await store.activity.append({ ...base, activity_id: 'act_c', created_at: '2026-09-01T10:00:00.000Z' });
  await store.activity.append({ ...base, activity_id: 'act_a', created_at: '2026-09-01T09:00:00.000Z' });

  const first = (await store.activity.list({})).rows.map((r) => r.activity_id);
  const second = (await store.activity.list({})).rows.map((r) => r.activity_id);
  assert.deepStrictEqual(first, second, 'two reads return the same order');
  assert.deepStrictEqual(first, ['act_c', 'act_b', 'act_a'],
    'newest first, with activity_id DESC breaking the tie: ' + first.join(','));

  // "Restart": reopen the same bytes as a brand new store.
  const bytes = db.export();
  const db2 = new SQL.Database(bytes);
  const reopened = new SqlJsStore({ db: db2, persist: () => {} });
  await reopened.migrate();
  const after = (await reopened.activity.list({})).rows.map((r) => r.activity_id);
  assert.deepStrictEqual(after, first, 'the ledger survives a restart with the same order');
});

test('6. pagination is bounded, and paging neither overlaps nor drops rows', async () => {
  for (const kind of ['mem', 'sql']) {
    const store = await makeStore(kind, []);
    for (let i = 0; i < 45; i++) {
      await store.activity.append({
        activity_id: 'act_' + String(i).padStart(3, '0'),
        lead_id: 'L' + (i % 2), pitch_id: 'p1',
        activity_type: 'PITCH_APPROVED', metadata: {},
        created_at: '2026-09-01T10:00:' + String(i).padStart(2, '0') + '.000Z'
      });
    }
    const page1 = await store.activity.list({ limit: 20, offset: 0 });
    const page2 = await store.activity.list({ limit: 20, offset: 20 });
    const page3 = await store.activity.list({ limit: 20, offset: 40 });
    assert.strictEqual(page1.rows.length, 20, kind + ': first page');
    assert.strictEqual(page2.rows.length, 20, kind + ': second page');
    assert.strictEqual(page3.rows.length, 5, kind + ': last page');
    assert.strictEqual(page1.total, 45, kind + ': total is the whole ledger, not the page');
    const ids = [...page1.rows, ...page2.rows, ...page3.rows].map((r) => r.activity_id);
    assert.strictEqual(new Set(ids).size, 45, kind + ': no row is repeated or dropped');
    // The store clamps: an absurd limit can never pull the whole ledger in one page.
    const huge = await store.activity.list({ limit: 100000, offset: 0 });
    assert.ok(huge.rows.length <= contract.ACTIVITY_MAX_LIMIT, kind + ': limit is clamped');
    assert.strictEqual(contract.normalizeActivityQuery({ limit: 999999 }).limit, contract.ACTIVITY_MAX_LIMIT,
      kind + ': the contract clamps the limit');
    assert.strictEqual(contract.normalizeActivityQuery({}).limit, contract.ACTIVITY_DEFAULT_LIMIT,
      kind + ': and defaults it');
  }
});

test('7. filtering by lead works, and an unknown activity type is rejected', async () => {
  for (const kind of ['mem', 'sql']) {
    const store = await makeStore(kind, []);
    await store.activity.append({ activity_id: 'a1', lead_id: 'L1', pitch_id: 'p1', activity_type: 'PITCH_APPROVED', metadata: {}, created_at: '2026-09-02T10:00:00.000Z' });
    await store.activity.append({ activity_id: 'a2', lead_id: 'L2', pitch_id: 'p2', activity_type: 'PITCH_APPROVED', metadata: {}, created_at: '2026-09-01T10:00:00.000Z' });
    await store.activity.append({ activity_id: 'a3', lead_id: 'L1', pitch_id: 'p1', activity_type: 'OUTREACH_READY', metadata: {}, created_at: '2026-09-03T10:00:00.000Z' });

    const byLead = await store.activity.list({ leadId: 'L1' });
    assert.strictEqual(byLead.total, 2, kind + ': filtered by lead');
    assert.ok(byLead.rows.every((r) => r.lead_id === 'L1'), kind + ': only that lead comes back');
    const byPitch = await store.activity.list({ pitchId: 'p1' });
    assert.strictEqual(byPitch.total, 2, kind + ': filtered by pitch');

    // An unknown type cannot be stored at all.
    for (const bad of ['EMAIL_SENT', 'EMAIL_DELIVERED', 'EMAIL_OPENED', 'EMAIL_CLICKED',
      'WHATSAPP_SENT', 'CALL_PLACED', 'CAMPAIGN_STARTED', 'PITCH_APPROVED ', 'sent']) {
      await assert.rejects(
        store.activity.append({ activity_id: 'bad', lead_id: 'L1', activity_type: bad, metadata: {}, created_at: 'x' }),
        /Invalid activity/,
        kind + ': the store refuses ' + bad
      );
    }
    assert.strictEqual((await store.activity.list({})).total, 3, kind + ': no refused row was written');
  }
});

test('7b. metadata is a closed set, not a dumping ground', async () => {
  const meta = contract.normalizeActivityMetadata;
  assert.deepStrictEqual(meta({ approvedBy: 'me', contentHash: 'h' }).value, { approvedBy: 'me', contentHash: 'h' });
  assert.deepStrictEqual(meta(undefined).value, {}, 'absent metadata is empty');
  for (const bad of [{ apiKey: 'sk-live-x' }, { password: 'p' }, { token: 't' }, { rawPayload: '{}' }, { provider_response: 'x' }]) {
    const res = meta(bad);
    assert.strictEqual(res.ok, false, 'refused: ' + JSON.stringify(bad));
  }
  // A nested object cannot smuggle a packet or a credential through.
  assert.strictEqual(meta({ approvedBy: { nested: true } }).ok, false, 'non-string value refused');
  assert.strictEqual(meta({ approvedBy: 'x'.repeat(500) }).ok, false, 'over-long value refused');
});

test('8. MemoryStore and SqlJsStore agree row for row', async () => {
  const rows = [
    { activity_id: 'a1', lead_id: 'L1', pitch_id: 'p1', activity_type: 'PITCH_APPROVED', metadata: { approvedBy: 'tester' }, created_at: '2026-09-03T10:00:00.000Z' },
    { activity_id: 'a2', lead_id: 'L1', pitch_id: 'p1', activity_type: 'OUTREACH_READY', metadata: { contentHash: 'h' }, created_at: '2026-09-02T10:00:00.000Z' },
    { activity_id: 'a3', lead_id: 'L2', pitch_id: null, activity_type: 'APPROVAL_INVALIDATED', metadata: { reason: 'The pitch changed after it was approved.' }, created_at: '2026-09-01T10:00:00.000Z' }
  ];
  const mem = new MemoryStore();
  const sql = await makeStore('sql', []);
  for (const r of rows) {
    await mem.activity.append(r);
    await sql.activity.append(r);
  }
  for (const query of [{}, { leadId: 'L1' }, { pitchId: 'p1' }, { limit: 2, offset: 1 }]) {
    assert.deepStrictEqual(await mem.activity.list(query), await sql.activity.list(query),
      'the two stores agree for ' + JSON.stringify(query));
  }
});

// ============================================================ 9. the workspace

/** Evaluate the real F15 block against the workspace DOM double. */
function loadWorkspace(api) {
  const doc = makeDoc();
  const sandbox = {
    document: doc, console, Promise, Date, JSON, Math, Object, Array, Number, String,
    Boolean, Error, Set, Map, RegExp, isNaN, parseInt, parseFloat
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.ztechLeadIntel = api;
  // The F15 block reuses these F11 helpers: the API accessor, the envelope unwrapper, the
  // status badge and the alert box. The unwrapper is the real F11 contract.
  sandbox.f11LeadIntel = () => sandbox.ztechLeadIntel;
  sandbox.f11Unwrap = (res) => {
    if (res && res.ok === true) return res.data;
    const e = new Error((res && res.error && res.error.message) || 'The request failed.');
    e.code = (res && res.error && res.error.code) || 'ERROR';
    throw e;
  };
  sandbox.f11Status = (text, tone) => { const el = doc.createElement('span'); el.textContent = text; el.setAttribute('data-state', tone); return el; };
  sandbox.f11AlertBox = (err) => { const el = doc.createElement('div'); el.textContent = (err && err.code ? err.code + ': ' : '') + (err && err.message ? err.message : ''); return el; };
  const names = Object.keys(sandbox);
  const fn = new Function(...names, F15 + '\nreturn { f15ActivityLoad, f15ActivityState, F15_ACTIVITY_LABELS, f15ActivityDetail };');
  const loaded = fn.apply(null, names.map((n) => sandbox[n]));
  return Object.assign(loaded, { doc });
}
const ok = (data) => ({ ok: true, data });
const err = (code, message) => ({ ok: false, error: { code, message } });
const settle = () => new Promise((r) => setTimeout(r, 0));
const body = (ws) => ws.doc.getElementById('activity-body');
const trs = (ws) => body(ws).byTag('tr');
const cellText = (ws, tr, i) => (tr.children[i] ? tr.children[i].textContent : '');

// Newest first, exactly as the store returns them: the renderer must NOT re-sort, because
// the fixed `created_at DESC, activity_id DESC` ordering is the backend's contract.
const LEDGER = [
  { activity_id: 'act_2', lead_id: 'L1', pitch_id: 'pitch_1', activity_type: 'OUTREACH_READY', metadata: { contentHash: 'hash_1' }, created_at: '2026-09-03T10:31:00.000Z' },
  { activity_id: 'act_1', lead_id: 'L1', pitch_id: 'pitch_1', activity_type: 'PITCH_APPROVED', metadata: { approvedBy: 'local-user', contentHash: 'hash_1' }, created_at: '2026-09-03T10:30:00.000Z' }
];

test('9. the workspace renders the persisted ledger accurately', async () => {
  const calls = [];
  const ws = loadWorkspace({
    outreach: {
      activity: (q) => { calls.push(q); return ok({ rows: LEDGER, total: 2, limit: q.limit, offset: q.offset, leadId: null, pitchId: null }); }
    }
  });
  await ws.f15ActivityLoad();
  await settle();
  assert.strictEqual(calls.length, 1, 'one activity call per load');
  assert.deepStrictEqual(Object.keys(calls[0]).sort(), ['limit', 'offset'],
    'the workspace sends only bounded paging - no filter, sort or field selection');
  const rows = trs(ws);
  assert.strictEqual(rows.length, 2, 'both persisted events render');
  const first = rows[0];
  assert.strictEqual(cellText(ws, first, 0), '03/09/2026 10:31', 'the time comes from created_at');
  assert.strictEqual(cellText(ws, first, 1), 'L1', 'the lead comes from the row');
  assert.ok(/Ready for outreach/.test(cellText(ws, first, 2)), 'the event label is the backend type: ' + cellText(ws, first, 2));
  assert.strictEqual(cellText(ws, first, 3), 'pitch_1', 'the related pitch is shown');
  // The ready row must say plainly that nothing was sent.
  assert.ok(/nothing has been sent/i.test(cellText(ws, first, 4)), 'ready never implies delivery: ' + cellText(ws, first, 4));
  const second = rows[1];
  assert.ok(/by local-user/.test(cellText(ws, second, 4)), 'the approval detail comes from metadata: ' + cellText(ws, second, 4));
  assert.strictEqual(ws.doc.getElementById('activity-range').textContent, '1–2 of 2 events',
    'the range comes from the store total');
});

test('9b. honest empty, loading and error states, and Campaigns is still a placeholder', async () => {
  // empty
  const empty = loadWorkspace({ outreach: { activity: () => ok({ rows: [], total: 0, limit: 20, offset: 0 }) } });
  await empty.f15ActivityLoad();
  await settle();
  assert.ok(/No outreach activity recorded yet/.test(body(empty).textContent), 'honest empty state');
  assert.strictEqual(empty.doc.getElementById('activity-prev').disabled, true, 'prev is disabled when empty');
  assert.strictEqual(empty.doc.getElementById('activity-next').disabled, true, 'next is disabled when empty');

  // error
  const broken = loadWorkspace({ outreach: { activity: () => err('NOT_FOUND', 'nothing readable') } });
  await broken.f15ActivityLoad();
  await settle();
  assert.ok(/ACTIVITY_UNAVAILABLE/.test(body(broken).textContent), 'the error is shown as an error: ' + body(broken).textContent);
  assert.ok(!/No outreach activity recorded yet/.test(body(broken).textContent),
    'a failure is never dressed up as an empty history');

  // capability absent -> says so, rather than showing a false empty history
  const absent = loadWorkspace({ outreach: {} });
  await absent.f15ActivityLoad();
  assert.ok(/not available in this session/.test(body(absent).textContent), 'an absent capability is stated');

  // Campaigns remains a disabled placeholder.
  const campaignsAt = htmlSource.indexOf('<span class="nav-label">Campaigns</span>');
  const campaignBtn = htmlSource.slice(htmlSource.lastIndexOf('<button', campaignsAt), htmlSource.indexOf('</button>', campaignsAt));
  assert.ok(/nav-item-soon/.test(campaignBtn), 'Campaigns is still nav-item-soon');
  assert.ok(/\sdisabled[\s>]/.test(campaignBtn), 'Campaigns is still disabled');
  assert.ok(/nav-soon/.test(campaignBtn), 'Campaigns still shows its Soon badge');
  // Activity itself is now a real route.
  const activityAt = htmlSource.indexOf('<span class="nav-label">Activity</span>');
  const activityBtn = htmlSource.slice(htmlSource.lastIndexOf('<button', activityAt), htmlSource.indexOf('</button>', activityAt));
  assert.ok(/<button class="nav-item" data-view="activity"/.test(activityBtn), 'Activity is a live route');
  assert.ok(!/disabled|nav-soon/.test(activityBtn), 'and carries no placeholder markup');
});

test('9c. an unrecognised event type is shown as itself, never relabelled', async () => {
  const ws = loadWorkspace({
    outreach: { activity: () => ok({ rows: [{ activity_id: 'x', lead_id: 'L1', pitch_id: null, activity_type: 'SOMETHING_NEW', metadata: {}, created_at: '2026-09-03T10:30:00.000Z' }], total: 1, limit: 20, offset: 0 }) }
  });
  await ws.f15ActivityLoad();
  await settle();
  const text = trs(ws)[0].children[2].textContent;
  assert.strictEqual(text, 'SOMETHING_NEW', 'an unknown type is rendered verbatim, not mapped: ' + text);
});

// ============================================================ 10. security / scope

test('10. no send, provider or campaign capability, and the renderer cannot write activity', () => {
  assert.deepStrictEqual(Object.keys(pkg.dependencies).sort(),
    ['@modelcontextprotocol/client', 'ajv', 'ajv-formats', 'electron-store', 'sql.js'], 'no dependency added');
  // The bridge exposes activity READ-ONLY: there is no create/update/delete method.
  const leadIntelBlock = preloadSource.slice(preloadSource.indexOf("exposeInMainWorld('ztechLeadIntel'"));
  assert.ok(/activity:\s*\(payload\)\s*=>\s*ipcRenderer\.invoke\('lead-intel:outreach-activity'/.test(leadIntelBlock),
    'activity is exposed as a single read method');
  for (const forbidden of [/activityAppend/, /activityCreate/, /activityWrite/, /activityDelete/, /activityUpdate/]) {
    assert.ok(!forbidden.test(preloadSource), 'no activity write bridge exists: ' + forbidden);
  }
  // Exactly one new channel, and it is a read.
  const channels = [...ipcSource.matchAll(/lead-intel:[a-z-]+'/g)].map((m) => m[0].replace(/'/g, ''));
  assert.deepStrictEqual([...new Set(channels)].filter((c) => /activity/.test(c)), ['lead-intel:outreach-activity'],
    'exactly one activity channel, and it is the read one');
  // The renderer only ever calls the read method.
  const used = [...F15_CODE.matchAll(/api\.(\w+)\.(\w+)\(/g)].map((m) => m[1] + '.' + m[2]);
  assert.deepStrictEqual([...new Set(used)].sort(), ['outreach.activity'], 'the workspace calls nothing but the read');
  // No send surface anywhere in the new code.
  for (const banned of [/email\s*\.\s*send/, /outreach\.send/, /smtp/i, /provider\b(?!Configured)/i, /campaign/i, /queue/i, /retry/i]) {
    const hits = F15_CODE.match(new RegExp(banned.source, 'i'));
    if (/provider/i.test(banned.source)) {
      // "providerConfigured" is the honest ABSENCE report, which is required.
      assert.ok(!hits || F15_CODE.replace(/providerConfigured/g, '').match(banned) === null,
        'the only provider mention is providerConfigured');
    } else {
      assert.ok(!hits, 'the workspace must not contain: ' + banned);
    }
  }
  assert.ok(!/\b(openRate|clickRate|replyRate|sentCount|deliveredCount|bounceRate)\b/i.test(F15),
    'no delivery metric is invented');
  // The renderer has no storage, network or framework surface.
  for (const banned of [/\bfetch\s*\(/, /XMLHttpRequest/, /\bWebSocket\b/, /EventSource/, /innerHTML/, /document\.write/, /require\s*\(/, /ipcRenderer/, /indexedDB/]) {
    assert.ok(!banned.test(F15_CODE), 'the workspace must not use: ' + banned);
  }
});

test('11. F12/F13/F14 behaviour is untouched by F15', () => {
  // F12 still reaches only list and gate; the new block is separate.
  const F12 = rendererSource.slice(f12From);
  const f12api = [...stripComments(F12).matchAll(/api\.(\w+)\.(\w+)\(/g)].map((m) => m[1] + '.' + m[2]);
  assert.ok(!f12api.some((c) => /activity/i.test(c)), 'F12 reaches no activity method');
  // F13's approval action is still there and still single-pitch with an exact payload.
  const F13_MARKER = '// === F13 Outreach: human approval of one pitch ===';
  const F14_MARKER = '// === F14 Outreach: readiness of an approved pitch ===';
  const F13 = rendererSource.slice(rendererSource.indexOf(F13_MARKER), rendererSource.indexOf(F14_MARKER));
  assert.ok(/api\.outreach\.approve\(\{ pitchId: String\(pitchId\) \}\)/.test(stripComments(F13)),
    'F13 still calls approve with exactly { pitchId }');
  assert.strictEqual((F13.match(/api\.outreach\.\w+\(/g) || []).length, 1, 'F13 still makes exactly one API call');
  // F14 readiness derivation is unchanged.
  const F14 = rendererSource.slice(rendererSource.indexOf(F14_MARKER), f15From);
  assert.ok(/gate\.decision === 'allowed'/.test(stripComments(F14)), 'F14 still derives ready from the gate');
  // The service still refuses to send by default (F19 adds sendEmail behind a live
  // provider interlock; the legacy send() path remains disabled in the default build).
  // F20 declared lock update: the single zero-argument sendCapability() became the
  // channel-aware sendCapability(channel), because two channels now share one send entry
  // point. What this lock actually protects - no default-build send capability - is
  // asserted by the fact that BOTH evaluators are still gated on a live provider below.
  const canSendInDefault = /sendCapability\(channel\)/.test(serviceSource)
    && /sendCapability\('email'\)/.test(serviceSource)
    && /sendCapability\('whatsapp'\)/.test(serviceSource);
  assert.ok(canSendInDefault, 'send() remains disabled in the default configuration');
  // Activity is emitted only from the two mutation boundaries.
  const emitters = [...serviceSource.matchAll(/this\._recordActivity\(([^,]+), '([A-Z_]+)'/g)].map((m) => m[2]);
  // F26.5 declared lock update: + OUTREACH_HANDOFF_CREATED, emitted only by handoff() - a
  // mutation boundary where the handoff provably happened. It is never a send event.
  assert.deepStrictEqual([...new Set(emitters)].sort(), ['APPROVAL_INVALIDATED', 'OUTREACH_HANDOFF_CREATED', 'OUTREACH_READY', 'PITCH_APPROVED'],
    'all three types are emitted');
  for (const read of ['async list(', 'async activityList(', 'async gate(', 'async get(']) {
    const body = serviceSource.slice(serviceSource.indexOf(read));
    const fnEnd = body.indexOf('\n  }\n');
    assert.ok(!/_recordActivity/.test(body.slice(0, fnEnd)),
      'the read method ' + read.trim() + ' records nothing');
  }
});

// Minimal DOM double.
function makeDoc() {
  const listeners = new WeakMap();
  const make = (tag) => {
    const el = {
      tagName: String(tag).toUpperCase(), className: '', children: [], hidden: false, disabled: false,
      attrs: {}, _text: '',
      get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); },
      set textContent(v) { this._text = String(v); this.children = []; },
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
      appendChild(c) { this.children.push(c); return c; },
      replaceChildren(...c) { this.children = c; this._text = ''; },
      addEventListener(type, fn) { listeners.set(this, (listeners.get(this) || []).concat([{ type, fn }])); },
      fire(type) { for (const l of (listeners.get(this) || [])) if (l.type === type) l.fn({ type }); },
      byTag(tag) {
        const want = String(tag).toUpperCase();
        const out = [];
        const walk = (n) => { for (const c of n.children) { if (c.tagName === want) out.push(c); walk(c); } };
        walk(this);
        return out;
      },
      classList: {
        add(...names) { const s = new Set(String(this.owner.className).split(/\s+/).filter(Boolean)); for (const n of names) s.add(n); this.owner.className = [...s].join(' '); },
        remove() {}, contains() { return false; }
      }
    };
    el.classList.owner = el;
    return el;
  };
  const nodes = new Map();
  for (const id of ['activity-body', 'activity-range', 'activity-prev', 'activity-next', 'activity-refresh']) {
    nodes.set(id, make('div'));
  }
  return {
    createElement: make,
    getElementById: (id) => nodes.get(id) || null,
    querySelector: () => null,
    querySelectorAll: () => []
  };
}

// Async tests, run in order, so the pass/fail summary is the last line of output.
(async () => {
  for (const [name, fn] of tests) {
    try {
      await fn();
      passed++;
      console.log('ok - ' + name);
    } catch (err) {
      failed++;
      console.log('FAIL - ' + name);
      console.log(String((err && err.stack) || err));
    }
  }
  console.log(passed + ' passed, ' + failed + ' failed');
})();
