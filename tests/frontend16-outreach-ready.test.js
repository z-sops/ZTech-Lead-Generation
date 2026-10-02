'use strict';

// Frontend 2.0 F16 - the derived Ready queue.
//
// THE ONE DEFINITION: a pitch is Ready only when the EXISTING OutreachGate currently
// returns `allowed`. Nothing else. F16 adds no readiness status, no flag, no table and no
// second source of truth, and it never asks "is the approval current?" or "is the evidence
// fresh?" itself - the gate already owns those rules.
//
// What is pinned:
//   1. allowed -> included; every blocking reason -> excluded; unreadable gate -> excluded
//   2. scanning is bounded and the envelope has NO invented total
//   3. deterministic ordering, truthful cursor navigation, no ready row is skipped
//   4. reading Ready writes no activity and creates no OUTREACH_READY event
//   5. no send, provider, campaign or channel-specific readiness rule
//   6. channel-neutral delivery reporting (no hard-coded email)
//   7. the workspace renders honestly: loading, empty, error, ready rows, no fake totals
//   8. preload is read-only; Campaigns stays disabled; F12-F15 are untouched
//   9. no new persisted ready status, flag or table

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const htmlSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const rendererSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'renderer.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const ipcSource = fs.readFileSync(path.join(root, 'src', 'main', 'lead-intelligence', 'outreach-ipc.js'), 'utf8');
const serviceSource = fs.readFileSync(path.join(root, 'src', 'main', 'lead-intelligence', 'outreach', 'OutreachService.js'), 'utf8');
const gateSource = fs.readFileSync(path.join(root, 'src', 'main', 'lead-intelligence', 'outreach', 'OutreachGate.js'), 'utf8');
const contract = require(path.join(root, 'src', 'main', 'lead-intelligence', 'persistence', 'contract.js'));
const { MemoryStore } = require(path.join(root, 'src', 'main', 'lead-intelligence', 'persistence', 'MemoryStore.js'));
const { OutreachService } = require(path.join(root, 'src', 'main', 'lead-intelligence', 'outreach', 'OutreachService.js'));
const pkg = require(path.join(root, 'package.json'));

const tests = [];
function test(name, fn) { tests.push([name, fn]); }
let passed = 0;
let failed = 0;
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const F16_MARKER = '// === F16 Outreach: the derived Ready queue ===';
const F17_MARKER = '// === F17 Outreach: factual contact points and channel preparation ===';
const f16From = rendererSource.indexOf(F16_MARKER);
// F17 now follows F16, so the F16 slice must stop at F17, not at F15.
const f15From = rendererSource.indexOf(F17_MARKER);
assert.ok(f16From > -1, 'the F16 block exists in renderer.js');
assert.ok(f15From > f16From, 'the F16 block is defined before the F15 block');
const F16 = rendererSource.slice(f16From, f15From);
const F16_CODE = stripComments(F16);

// ============================================================ service fixtures

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

/**
 * A real OutreachService over a real MemoryStore, with ONLY the gate stubbed - which is
 * exactly the point: F16 asks the gate, it does not re-derive the gate.
 * `verdictFor(pitchId)` returns that pitch's gate verdict, or throws to simulate an
 * unreadable gate.
 */
function makeService(pitches, verdictFor, viewName) {
  const store = new MemoryStore();
  for (const p of pitches) store.pitches.rows.set(p.pitch_id, makePitch(p));
  const service = new OutreachService({
    store,
    contexts: {
      getContext: async (leadId) => ({
        view: { name: viewName ? viewName(leadId) : 'Acme Bakery', email: 'hi@acme.test' },
        packet: null,
        icp_fit: null
      })
    },
    leadSource: {},
    freshness: { isFresh: () => true },
    config: { operatorName: 'tester' },
    clock,
    logger: { warn() {} }
  });
  let gateCalls = 0;
  service.gate = async ({ pitchId }) => {
    gateCalls++;
    return verdictFor(pitchId);
  };
  return { service, store, gateCalls: () => gateCalls };
}

const allowed = (extra) => Object.assign({
  decision: 'allowed', reasons: [], warnings: [], channel: 'email',
  pitch_id: 'pitch_1', packet_id: 'pkt_1', checkedAt: '2026-09-01T10:00:00.000Z',
  delivery: { channel: 'email', emailEnabled: false, providerConfigured: false }
}, extra);

const blockedBy = (code, message) => ({
  decision: 'blocked', reasons: [{ code, message: message || code }], warnings: [],
  channel: 'email', pitch_id: 'pitch_1', packet_id: 'pkt_1',
  checkedAt: '2026-09-01T10:00:00.000Z',
  delivery: { channel: 'email', emailEnabled: false, providerConfigured: false }
});

// ============================================================ 1. inclusion / exclusion

test('1. an allowed gate is the ONLY way into Ready, and every blocker is excluded', async () => {
  // 1. clean approved current-hash pitch -> ready
  const ok1 = makeService([{ pitch_id: 'p1' }], () => allowed({ pitch_id: 'p1' }));
  const inReady = await ok1.service.ready({});
  assert.strictEqual(inReady.rows.length, 1, 'allowed -> included');
  assert.strictEqual(inReady.rows[0].pitch.pitch_id, 'p1', 'and it is the right pitch');

  // Every reason the real gate can raise must exclude the row. F16 adds no rule of its own;
  // it simply trusts the verdict.
  const cases = [
    ['HUMAN_APPROVAL', 'approval outstanding'],
    ['HUMAN_APPROVAL', 'changed after approval'],
    ['EVIDENCE_FRESH', 'stale evidence'],
    ['EVIDENCE_COMPLETE', 'insufficient evidence'],
    ['EVIDENCE_PRESENT', 'no evidence'],
    ['PROHIBITED_CLAIMS', 'needs revision'],
    ['PITCH_INTEGRITY', 'pitch integrity'],
    ['QUALIFICATION', 'unqualified lead'],
    ['ICP_FIT', 'ICP not a fit'],
    ['CONTACT_FIELD', 'no email on file'],
    ['PITCH_MISSING', 'no pitch']
  ];
  for (const [code, why] of cases) {
    const { service } = makeService([{ pitch_id: 'p1' }], () => blockedBy(code));
    const res = await service.ready({});
    assert.strictEqual(res.rows.length, 0, code + ' must be excluded (' + why + ')');
  }

  // An UNREADABLE gate is not Ready either. Unknown must never pass.
  const boom = makeService([{ pitch_id: 'p1' }], () => { throw new Error('Lead not found'); });
  const unreadable = await boom.service.ready({});
  assert.strictEqual(unreadable.rows.length, 0, 'an unreadable gate is excluded, never allowed');

  // And the real gate still owns every one of those rules - F16 did not move them.
  for (const code of ['HUMAN_APPROVAL', 'EVIDENCE_FRESH', 'EVIDENCE_COMPLETE', 'PITCH_INTEGRITY', 'QUALIFICATION', 'CONTACT_FIELD', 'PITCH_MISSING']) {
    assert.ok(gateSource.includes("'" + code + "'"), 'the gate still owns ' + code);
  }
});

// ============================================================ 2. bounded scanning, no fake total

test('2. scanning is bounded per call and the envelope invents no total', async () => {
  // 40 pitches, only ONE ready, and it sorts LAST in the store's fixed
  // `updated_at DESC, pitch_id DESC` ordering - i.e. it needs the deepest scan.
  const pitches = Array.from({ length: 40 }, (_, i) => ({
    pitch_id: 'p' + i,
    updated_at: '2026-09-01T10:00:' + String(i).padStart(2, '0') + '.000Z'
  }));
  const deepest = pitches.reduce((a, b) => (a.updated_at < b.updated_at ? a : b));
  const { service, gateCalls } = makeService(pitches, (id) => (id === deepest.pitch_id ? allowed({ pitch_id: id }) : blockedBy('HUMAN_APPROVAL')));

  const first = await service.ready({ scanLimit: 10, limit: 10 });
  assert.strictEqual(first.rows.length, 0, 'the ready pitch sorts beyond the first window');
  assert.ok(gateCalls() <= 10, 'gate evaluations are bounded by scanLimit, got ' + gateCalls());

  // NO total anywhere: it cannot be known without an unbounded scan.
  assert.ok(!('total' in first), 'the envelope has no total key at all');
  assert.strictEqual(first.total, undefined, 'and no fake total value');
  assert.ok(typeof first.hasMore === 'boolean', 'hasMore states what IS known');
  assert.strictEqual(first.hasMore, true, 'more remains to scan');
  assert.strictEqual(first.nextCursor, 10, 'the cursor advances by the scanned amount');

  // Walking the cursor finds the ready pitch without ever scanning everything at once.
  let cursor = first.nextCursor;
  let seen = first.scanned;
  let found = null;
  while (cursor !== null && !found && seen < 1000) {
    const page = await service.ready({ cursor, scanLimit: 10, limit: 10 });
    seen += page.scanned;
    if (page.rows.length) found = page.rows[0].pitch.pitch_id;
    cursor = page.hasMore ? page.nextCursor : null;
  }
  assert.strictEqual(found, deepest.pitch_id, 'the ready pitch is reachable by paging the cursor');

  // The contract clamps a hostile request instead of honouring it.
  assert.strictEqual(contract.normalizeReadyQuery({ scanLimit: 100000 }).scanLimit, contract.READY_SCAN_MAX, 'scanLimit is clamped');
  assert.strictEqual(contract.normalizeReadyQuery({ limit: 100000 }).limit, contract.READY_PAGE_MAX_LIMIT, 'limit is clamped');
  const q = contract.normalizeReadyQuery({});
  assert.strictEqual(q.cursor, 0, 'cursor defaults to the start');
  assert.ok(q.limit <= q.scanLimit, 'a page can never exceed its own scan window');
  assert.ok(!('total' in contract.normalizeReadyQuery({})), 'the contract exposes no total either');
});

// ============================================================ 3. determinism, no skipped rows

test('3. ordering is deterministic and no ready row is ever skipped', async () => {
  const pitches = Array.from({ length: 25 }, (_, i) => ({ pitch_id: 'p' + i, updated_at: '2026-09-01T10:00:' + String(i).padStart(2, '0') + '.000Z' }));
  // Every third pitch is ready.
  const readyIds = new Set(pitches.filter((_, i) => i % 3 === 0).map((p) => p.pitch_id));
  const { service } = makeService(pitches, (id) => (readyIds.has(id) ? allowed({ pitch_id: id }) : blockedBy('QUALIFICATION')));

  const one = await service.ready({ scanLimit: 25, limit: 25 });
  const two = await service.ready({ scanLimit: 25, limit: 25 });
  assert.deepStrictEqual(one.rows.map((r) => r.pitch.pitch_id), two.rows.map((r) => r.pitch.pitch_id),
    'two identical reads return an identical order');
  assert.strictEqual(one.rows.length, readyIds.size, 'exactly the allowed pitches appear');

  // Paging with a small limit must not drop or duplicate a ready row.
  const seenIds = [];
  let cursor = 0;
  let guard = 0;
  while (cursor !== null && guard++ < 50) {
    const page = await service.ready({ cursor, scanLimit: 25, limit: 2 });
    for (const r of page.rows) seenIds.push(r.pitch.pitch_id);
    cursor = page.hasMore ? page.nextCursor : null;
  }
  // The store's own ordering is `updated_at DESC`, so the expected sequence is the ready
  // ids in THAT order - not insertion order. This is what pins determinism: the workspace
  // never re-sorts, so the backend's fixed order is the order the user sees.
  const expectedOrder = pitches
    .slice()
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : (a.pitch_id < b.pitch_id ? 1 : -1)))
    .map((p) => p.pitch_id)
    .filter((id) => readyIds.has(id));
  assert.deepStrictEqual(seenIds, expectedOrder, 'paging every window returns each ready row exactly once, in the store order');
  assert.strictEqual(new Set(seenIds).size, seenIds.length, 'no duplicates');
});

// ============================================================ 4. reads write nothing

test('4. reading Ready records no activity and creates no OUTREACH_READY event', async () => {
  const { service, store } = makeService(
    [{ pitch_id: 'p1' }],
    (id) => allowed({ pitch_id: id })
  );
  for (let i = 0; i < 5; i++) await service.ready({});
  assert.strictEqual((await store.activity.list({})).total, 0, 'five Ready reads recorded no activity');
  const rows = await store.activity.list({});
  assert.ok(!rows.rows.some((r) => r.activity_type === 'OUTREACH_READY'),
    'reading Ready is not the thing that announces readiness');
  // F15's emitter is untouched: it lives only in approve() and update().
  const emitters = [...serviceSource.matchAll(/this\._recordActivity\(([^,]+), '([A-Z_]+)'/g)].map((m) => m[2]);
  assert.deepStrictEqual([...new Set(emitters)].sort(), ['APPROVAL_INVALIDATED', 'OUTREACH_READY', 'PITCH_APPROVED'],
    'F15 still emits the same three types from the same transitions');
  const readyBody = serviceSource.slice(serviceSource.indexOf('async ready(query)'));
  assert.ok(!/_recordActivity/.test(readyBody.slice(0, readyBody.indexOf('\n  async gate('))),
    'the ready() method itself records nothing');
});

// ============================================================ 5-6. no send, channel-neutral

test('5. no send, provider, campaign or scheduling capability exists anywhere in F16', () => {
  assert.deepStrictEqual(Object.keys(pkg.dependencies).sort(),
    ['@modelcontextprotocol/client', 'ajv', 'ajv-formats', 'electron-store', 'sql.js'], 'no dependency added');
  const code = F16_CODE;
  for (const banned of [/\bsend\b/i, /smtp/i, /nodemailer/i, /schedule/i, /\bretry\b/i, /campaign/i, /\bbulk\b/i, /whatsapp/i]) {
    assert.ok(!banned.test(code), 'the F16 block must not contain: ' + banned);
  }
  // "queue" is deliberately NOT banned on its own: this workspace is a queue of ready
  // prospects, which is not a send queue. What must not exist is work being QUEUED for
  // later delivery.
  for (const banned of [/enqueue/i, /dequeue/i, /queueMicrotask/i, /workQueue/i, /pendingSend/i, /outbox/i]) {
    assert.ok(!banned.test(code), 'the F16 block must not queue any work: ' + banned);
  }
  assert.ok(!/setTimeout|setInterval/.test(code), 'and schedules nothing');
  assert.ok(!/\b(openRate|replyRate|bounceRate|sentCount|deliveredCount)\b/i.test(F16), 'no delivery metric is invented');
  // The one outbound control F16 could have added, it did not. Checked on CONTROLS, not on
  // the word: the workspace's own honest copy says "nothing has been sent", which contains
  // "send" and must not be mistaken for a button.
  const readyMarkup = htmlSource
    .slice(htmlSource.indexOf('<section class="view" id="view-ready">'), htmlSource.indexOf('</section>', htmlSource.indexOf('<section class="view" id="view-ready">')))
    .replace(/<!--[\s\S]*?-->/g, '');
  const readyButtons = [...readyMarkup.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1].replace(/<[^>]*>/g, '').trim());
  assert.deepStrictEqual(readyButtons, ['Refresh', 'Previous', 'Next'],
    'the only controls are refresh and paging: ' + JSON.stringify(readyButtons));
  for (const banned of [/\bsend\b/i, /queue/i, /schedule/i, /retry/i, /campaign/i, /test connection/i]) {
    assert.ok(!readyButtons.some((b) => banned.test(b)), 'no control labelled ' + banned);
  }
  // And no control is wired to any outbound channel name.
  assert.ok(!/onclick|data-action="(send|queue|schedule)"/i.test(readyMarkup), 'no outbound handler in the Ready markup');
  // No renderer storage/network/framework surface.
  for (const banned of [/\bfetch\s*\(/, /XMLHttpRequest/, /\bWebSocket\b/, /EventSource/, /innerHTML/, /document\.write/, /require\s*\(/, /ipcRenderer/]) {
    assert.ok(!banned.test(code), 'the F16 block must not use: ' + banned);
  }
});

test('6. readiness is channel-neutral: no email rule is duplicated in F16', async () => {
  // The service asks the gate for whatever channel it evaluates; F16 does not filter on one.
  const readyMethod = serviceSource.slice(serviceSource.indexOf('async ready(query)'), serviceSource.indexOf('\n  async gate('));
  // F17 widened this method with contact FACTS, so the words email/whatsapp may appear as
  // reported fields. What must be absent is any channel COMPARISON: nothing in the
  // derived query may branch on, filter by, or require a channel.
  const code = stripComments(readyMethod);
  for (const banned of [/channel\s*===/, /channel\s*!==/, /\.channel\s*\?/, /if\s*\([^)]*channel/, /return\s+verdict\.decision\s*===/]) {
    assert.ok(!banned.test(code), 'the derived query applies no channel condition of its own: ' + banned);
  }
  // A contact fact may never appear in the row-selection path, which is the part of
  // ready() above the push.
  // The row-DECISION path is everything from the gate call up to the verdict guard.
  // The contact derivation happens after that guard, so it cannot have influenced it.
  const gateCall = code.indexOf('verdict = await this.gate(');
  const guardLine = "if (!verdict || verdict.decision !== 'allowed') continue;";
  const guard = code.indexOf(guardLine);
  assert.ok(gateCall > -1 && guard > gateCall, 'the guard follows the gate call');
  assert.ok(code.indexOf(guardLine, guard + guardLine.length) === -1, 'the guard is evaluated exactly once');
  const decisionPath = code.slice(gateCall, guard);
  assert.ok(!/email|whatsapp|phone|website|contacts/i.test(decisionPath),
    'nothing about a contact participates in selecting or skipping a row');
  // And the derivation itself is pure reporting: it cannot return or set a verdict.
  // After the guard the only verdict mentions may be the row it is already attached to.
  const derivation = code.slice(guard + guardLine.length, code.indexOf('rows.push('));
  assert.ok(!/verdict/.test(derivation), 'the contact derivation never touches the verdict');
  // And the row itself carries the SAME verdict object it was selected with.
  assert.ok(/rows\.push\(contact \? \{ pitch: candidate, gate: verdict, lead, \.\.\.contact \} : \{ pitch: candidate, gate: verdict, lead \}\)/.test(code),
    'the row reports the gate verdict verbatim, in both the contact and no-contact shapes');
  // The renderer reports whatever capability the backend returned, naming the channel.
  assert.ok(/delivery\.channel/.test(F16), 'the workspace names the channel the backend reported');
  assert.ok(!/email/i.test(F16_CODE), 'the F16 block contains no email-specific logic at all');
  // A whatsapp-shaped capability would render honestly through the same code path.
  const ws = loadWorkspace({
    outreach: {
      ready: () => ok({
        rows: [{
          pitch: makePitch({ pitch_id: 'p1' }),
          gate: allowed({ pitch_id: 'p1', channel: 'whatsapp', delivery: { channel: 'whatsapp', whatsappEnabled: true, providerConfigured: true } }),
          lead: { id: 'L1', name: 'Acme Bakery' }
        }],
        scanned: 1, cursor: 0, nextCursor: null, hasMore: false, limit: 10
      })
    }
  });
  await ws.f16ReadyLoad();
  await settle();
  // The Delivery column moved to index 6: F17 inserted Contact at index 2.
  const deliveryText = cellsOf(ws)[6].textContent;
  assert.ok(/whatsapp/i.test(deliveryText), 'a whatsapp capability is reported, not filtered: ' + deliveryText);
  // The same row's Contact cell is honest about the absent contact facts: this fixture
  // carries none, so it says so rather than inventing one.
  assert.ok(/unavailable/i.test(cellsOf(ws)[2].textContent), 'the Contact cell admits missing facts: ' + cellsOf(ws)[2].textContent);
});

// F17 decorates an already-selected row with contact facts. That decoration must be
// incapable of creating, preserving or removing readiness, and it must not have touched
// F16's paging semantics.
test('6b. F17 contact decoration cannot influence readiness or pagination', async () => {
  const readyMethod = serviceSource.slice(serviceSource.indexOf('async ready(query)'), serviceSource.indexOf('\n  async gate('));
  const code = stripComments(readyMethod);
  // No contact property is compared, filtered on, or required for a row to be kept.
  for (const banned of [
    /(contacts|channels)\.\w+(\.\w+)*\s*(===|!==|==|!=)/,
    /if\s*\([^)]*(contacts|channels)/,
    /(contacts|channels)\s*\?\s*[^;]*continue/,
    /!\s*[^;]*(contacts|channels)[^;]*continue/,
  ]) {
    assert.ok(!banned.test(code), 'no contact-driven readiness condition: ' + banned);
  }
  // No availability/verification comparison exists at all - whatsapp has no such state,
  // so no such comparison could ever create readiness.
  for (const banned of [
    /whatsapp[\s\S]{0,80}(continue|break|return|decision)/i,
    /\.(state|verified|available)\s*(===|!==)/,
    /\bavailable\b\s*(===|!==)/,
  ]) {
    assert.ok(!banned.test(code), 'no availability comparison creates readiness: ' + banned);
  }
  // The decoration is additive: the row is pushed either way.
  assert.ok(/rows\.push\(contact \?/.test(code), 'the row is pushed decorated or not, never conditionally on contacts');
  // A blocked verdict stays excluded, and an allowed verdict stays included, for the SAME
  // resolved view - the only difference is the verdict.
  const sameView = () => 'Acme Bakery';
  const allowedRes = await makeService([{ pitch_id: 'p1' }], () => allowed({ pitch_id: 'p1' }), sameView).service.ready({});
  const blockedRes = await makeService([{ pitch_id: 'p1' }], () => blockedBy('CONTACT_FIELD'), sameView).service.ready({});
  assert.strictEqual(allowedRes.rows.length, 1, 'allowed -> included');
  assert.strictEqual(blockedRes.rows.length, 0, 'blocked -> excluded, whatever the view carries');

  // F16's paging semantics are untouched by the decoration.
  assert.ok(/const F16_READY_PAGE_SIZE = 10;/.test(F16), 'the page size is unchanged');
  assert.ok(/const F16_READY_SCAN_SIZE = 50;/.test(F16), 'the scan window is unchanged');
  assert.ok(/scanLimit: F16_READY_SCAN_SIZE/.test(F16), 'the workspace still sends the same bounded scan window');
  assert.ok(/F16_READY_SCAN_SIZE/.test(F16) && /cursor - F16_READY_SCAN_SIZE/.test(F16),
    'Previous still steps back by exactly one scan window');
  assert.ok(!/f16ReadyState\.total|\btotal\b\s*:/.test(F16), 'no total was introduced by the decoration');
});

// ============================================================ 7. the workspace

/** Evaluate the real F16 block against the workspace DOM double. */
function loadWorkspace(api) {
  const doc = makeDoc();
  const sandbox = {
    document: doc, console, Promise, Date, JSON, Math, Object, Array, Number, String,
    Boolean, Error, Set, Map, RegExp, isNaN, parseInt, parseFloat
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.ztechLeadIntel = api;
  const opened = [];
  sandbox.openLeadDetail = (id) => { opened.push(String(id)); };
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
  // F16 now calls f17ContactCell for the Contact column, so F16 must be evaluated with
  // F17 present. The F16-only slices above still stop at the F17 marker, so the
  // channel-neutrality assertions inspect F16's own code and nothing else.
  const F17 = rendererSource.slice(f15From, rendererSource.indexOf('// === F15 Outreach: activity history ==='));
  const fn = new Function(...names, F16 + '\n' + F17 + '\nreturn { f16ReadyLoad, f16ReadyState, f16ReadyInit, f16ReadyDeliveryNote };');
  const loaded = fn.apply(null, names.map((n) => sandbox[n]));
  // Wire the controls exactly as the module does at startup, so the pager buttons in this
  // harness carry the same listeners the real workspace gives them.
  loaded.f16ReadyInit();
  return Object.assign(loaded, { doc, opened });
}
const ok = (data) => ({ ok: true, data });
const err = (code, message) => ({ ok: false, error: { code, message } });
const settle = () => new Promise((r) => setTimeout(r, 0));
const body = (ws) => ws.doc.getElementById('ready-body');
const trs = (ws) => body(ws).byTag('tr');
const cellsOf = (ws) => (trs(ws).length ? trs(ws)[0].children : []);
const textOf = (ws) => body(ws).textContent;

const READY_ROW = {
  pitch: makePitch({ pitch_id: 'p1', subject: 'Three fixes for acme.com' }),
  gate: allowed({ pitch_id: 'p1' }),
  lead: { id: 'L1', name: 'Acme Bakery' }
};

test('7. the workspace renders a ready row factually, with an honest delivery line', async () => {
  const calls = [];
  const ws = loadWorkspace({
    outreach: {
      ready: (q) => { calls.push(q); return ok({ rows: [READY_ROW], scanned: 7, cursor: 0, nextCursor: 7, hasMore: true, limit: 10 }); },
      gate: () => ok(allowed({}))
    }
  });
  await ws.f16ReadyLoad();
  await settle();
  assert.deepStrictEqual(Object.keys(calls[0]).sort(), ['cursor', 'limit', 'scanLimit'],
    'the workspace sends only the three bounded integers');
  const cells = cellsOf(ws);
  assert.strictEqual(cells.length, 9, 'one cell per declared column (F17 added Contact after Readiness)');
  assert.strictEqual(cells[0].textContent, 'Acme Bakery', 'the lead name comes from the gate-resolved view');
  assert.strictEqual(cells[1].textContent, 'Ready for outreach', 'readiness states the real gate outcome');
  assert.strictEqual(cells[3].textContent, 'Three fixes for acme.com', 'the subject comes from the pitch');
  assert.ok(/provider not configured/.test(cells[6].textContent), 'delivery is honest: ' + cells[6].textContent);
  assert.ok(!/sent|queued|scheduled|delivered|contacted/i.test(textOf(ws)), 'nothing claims delivery: ' + textOf(ws));
  // The footer reports only what the backend reported - no invented total.
  const range = ws.doc.getElementById('ready-range').textContent;
  assert.ok(/1 ready/.test(range) && /scanned 7/.test(range) && /more remain/.test(range), 'the footer is truthful: ' + range);
  assert.ok(!/\bof \d+\b/.test(range), 'and states no total: ' + range);
  // The only action opens the lead.
  const openBtn = cells[8].byTag('button')[0]; // F17: Contact inserted at index 7
  assert.strictEqual(openBtn.textContent, 'Open lead', 'the only row action opens the lead');
  openBtn.fire('click');
  assert.deepStrictEqual(ws.opened, ['L1'], 'it reuses the F5 drawer with the stored lead id');
});

test('7b. loading, empty, error and paging states are all honest', async () => {
  // empty
  const empty = loadWorkspace({ outreach: { ready: () => ok({ rows: [], scanned: 12, cursor: 0, nextCursor: null, hasMore: false, limit: 10 }) } });
  await empty.f16ReadyLoad();
  await settle();
  assert.ok(/No prospects are currently ready for outreach/.test(textOf(empty)), 'honest empty copy');
  assert.strictEqual(empty.doc.getElementById('ready-prev').disabled, true, 'prev disabled at the start');
  assert.strictEqual(empty.doc.getElementById('ready-next').disabled, true, 'next disabled when the backend says nothing remains');

  // error
  const broken = loadWorkspace({ outreach: { ready: () => err('INTERNAL_ERROR', 'read failed') } });
  await broken.f16ReadyLoad();
  await settle();
  assert.ok(/READY_UNAVAILABLE/.test(textOf(broken)), 'an error is shown as an error: ' + textOf(broken));
  assert.ok(!/No prospects are currently ready/.test(textOf(broken)), 'a failure is never dressed up as an empty queue');

  // capability absent
  const absent = loadWorkspace({ outreach: {} });
  await absent.f16ReadyLoad();
  assert.ok(/not available in this session/.test(textOf(absent)), 'an absent capability is stated');

  // paging follows the backend's cursor, and never guesses one
  const seen = [];
  const paged = loadWorkspace({
    outreach: {
      ready: (q) => {
        seen.push(q.cursor);
        return q.cursor === 0
          ? ok({ rows: [READY_ROW], scanned: 5, cursor: 0, nextCursor: 5, hasMore: true, limit: 10 })
          : ok({ rows: [], scanned: 3, cursor: 5, nextCursor: null, hasMore: false, limit: 10 });
      }
    }
  });
  await paged.f16ReadyLoad();
  await settle();
  assert.strictEqual(paged.doc.getElementById('ready-next').disabled, false, 'next is enabled while the backend says more remains');
  paged.doc.getElementById('ready-next').fire('click');
  await settle();
  assert.deepStrictEqual(seen, [0, 5], 'next resumes at the backend cursor');
  assert.strictEqual(paged.doc.getElementById('ready-next').disabled, true, 'and disables at the end');
});

// ============================================================ 8. scope guards

test('8. preload is read-only, Campaigns stays disabled, and F12-F15 are untouched', () => {
  // Read-only: one method on a fixed channel, nothing beside it that could send or write.
  const start = preloadSource.indexOf('outreach: Object.freeze({');
  const end = preloadSource.indexOf('}))', start);
  const block = stripComments(preloadSource.slice(start, end));
  assert.ok(/ready:\s*\(payload\)\s*=>\s*ipcRenderer\.invoke\('lead-intel:outreach-ready'/.test(block), 'ready is a single read');
  for (const forbidden of [/send/i, /schedule/i, /retry/i, /queue/i, /provider/i, /whatsapp/i, /email\s*:/i]) {
    assert.ok(!forbidden.test(block), 'the outreach bridge exposes no ' + forbidden);
  }
  assert.ok(!/lead-intel:email-send/.test(preloadSource), 'still no email-send channel');
  // Exactly one new channel, read-only, strictly bounded.
  assert.deepStrictEqual([...new Set([...ipcSource.matchAll(/lead-intel:[a-z-]+'/g)].map((m) => m[0].replace(/'/g, '')))].filter((c) => /ready/.test(c)),
    ['lead-intel:outreach-ready'], 'exactly one ready channel');
  const schema = (ipcSource.slice(ipcSource.indexOf('[CHANNELS.OUTREACH_READY]'), ipcSource.indexOf('});', ipcSource.indexOf('[CHANNELS.OUTREACH_READY]'))));
  assert.ok(/additionalProperties:\s*false/.test(schema), 'the ready schema is additionalProperties:false');
  assert.ok(/READY_PAGE_MAX_LIMIT/.test(schema) && /READY_SCAN_MAX/.test(schema), 'its bounds come from the contract');
  assert.ok(!/total/.test(schema), 'and there is no total to ask for');
  // Trusted sender is still required and still gates every handler.
  assert.ok(/isTrustedSender\(event\)/.test(ipcSource), 'trusted sender still enforced');

  // Campaigns remains a disabled placeholder.
  const at = htmlSource.indexOf('<span class="nav-label">Campaigns</span>');
  const btn = htmlSource.slice(htmlSource.lastIndexOf('<button', at), htmlSource.indexOf('</button>', at));
  assert.ok(/nav-item-soon/.test(btn) && /\sdisabled[\s>]/.test(btn) && /aria-disabled="true"/.test(btn) && /nav-soon/.test(btn),
    'Campaigns is still disabled with its Soon badge');
  assert.ok(!/view-campaigns?/.test(htmlSource), 'and still route-free');

  // F12/F13/F14/F15 blocks are structurally untouched by F16.
  const F15 = rendererSource.slice(f15From, rendererSource.indexOf('// === F12 Outreach: the read-only Outreach workspace ==='));
  assert.ok(/F15_ACTIVITY_LABELS/.test(F15), 'the F15 activity block is intact');
  const F12 = rendererSource.slice(rendererSource.indexOf('// === F12 Outreach: the read-only Outreach workspace ==='));
  const f12api = [...stripComments(F12).matchAll(/api\.(\w+)\.(\w+)\(/g)].map((m) => m[1] + '.' + m[2]);
  assert.ok(!f12api.some((c) => /ready/i.test(c)), 'the F12 block reaches no ready method');
  assert.ok(/f14Readiness/.test(F12), 'F14 readiness derivation is still in the row builder');
  assert.ok(/f13ApprovalAvailability/.test(F12), 'F13 approval is still in the row builder');
});

test('9. no new persisted ready status, flag or table exists', () => {
  // The three pitch statuses are untouched and still the only persisted ones.
  const contractSource = fs.readFileSync(path.join(root, 'src', 'main', 'lead-intelligence', 'persistence', 'contract.js'), 'utf8');
  const statuses = (contractSource.match(/PITCH_STATUSES = Object\.freeze\(\[([^\]]*)\]/s) || [])[1] || '';
  assert.deepStrictEqual(statuses.split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean),
    ['draft', 'insufficient_evidence', 'needs_revision'], 'no ready status was added to the pitch model');
  const migrations = fs.readFileSync(path.join(root, 'src', 'main', 'lead-intelligence', 'persistence', 'migrations.js'), 'utf8');
  const version = migrations.match(/Object\.freeze\(\{ version: (\d+), name: '([^']+)'/g).map((s) => s.match(/version: (\d+)/)[1]);
  assert.deepStrictEqual(version, ['1', '2', '3'], 'F16 added no migration: ' + version.join(','));
  // Schema-scoped, not prose-scoped: F15's migration comment legitimately discusses
  // "readiness", so the claim is that no TABLE or COLUMN is named ready.
  const created = [...migrations.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
  assert.ok(!created.some((t) => /ready/i.test(t)), 'no ready table was created: ' + created.join(','));
  const cols = [...migrations.matchAll(/^\s{2}(\w+) [A-Z]/gm)].map((m) => m[1]);
  assert.ok(!cols.some((c) => /ready/i.test(c)), 'no ready column was created');
  // Readiness is computed from the gate, not read from F15's activity ledger.
  const readyMethod = serviceSource.slice(serviceSource.indexOf('async ready(query)'), serviceSource.indexOf('\n  async gate('));
  assert.ok(!/store\.activity/.test(readyMethod), 'the derived query does not read the activity ledger');
  assert.ok(/this\.gate\(/.test(readyMethod), 'it asks the gate instead');
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
  for (const id of ['ready-body', 'ready-range', 'ready-prev', 'ready-next', 'ready-refresh']) nodes.set(id, make('div'));
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
