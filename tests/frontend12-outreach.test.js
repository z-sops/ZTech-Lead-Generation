'use strict';

// Frontend 2.0 F12 - the read-only Outreach workspace.
//
// The workspace is a READ of existing state. These tests pin that claim against the
// real renderer source, and where behaviour can be executed it is: the F11 helpers the
// workspace reuses and the F12 block itself are lifted out of renderer.js and run
// against a minimal DOM double and a fake window.ztechLeadIntel. No jsdom, no new
// dependency, no network.
//
// What is pinned:
//   1. the view and the single enabled navigation item exist
//   2. Campaigns and Activity stay disabled placeholders
//   3. only outreach.list and outreach.gate are ever called
//   4. the honest loading / empty / filtered-empty / error states
//   5. pitch status and gate decision are rendered from stored + returned values
//   6. blocked reasons come from the backend, never recomputed
//   7. status filtering is server-side, gate filtering is bounded page-side
//   8. pagination and refresh re-query the store
//   9. there is NO send, approve, generate or save action anywhere
//  10. no fetch / XHR / WebSocket / require / ipcRenderer / database access

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const htmlSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const rendererSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'renderer.js'), 'utf8');
const cssSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'styles.css'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const pkg = require(path.join(root, 'package.json'));

const tests = [];
function test(name, fn) { tests.push([name, fn]); }
let passed = 0;
let failed = 0;

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from !== -1 && to !== -1, 'slice markers found: ' + start);
  return source.slice(from, to);
}
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// F11 first: the F12 block reuses its status/gate label maps and element helpers, so
// both blocks are lifted together and the real F11 definitions are what render.
// F13 declared lock update: the F13 approval block sits between F11 and F12 and the F12
// row builder calls into it, so the evaluated slice now starts at the F13 block. The F12
// block itself is unchanged, and F12's own read-only rules are asserted on F12 alone below.
const F11_MARKER = '// === F11 Outreach: Lead Drawer Pitch tab ===';
const F13_MARKER = '// === F13 Outreach: human approval of one pitch ===';
const F12_MARKER = '// === F12 Outreach: the read-only Outreach workspace ===';
const f11From = rendererSource.indexOf(F11_MARKER);
const f13From = rendererSource.indexOf(F13_MARKER);
const f12From = rendererSource.indexOf(F12_MARKER);
assert.ok(f11From > -1, 'the F11 block exists in renderer.js');
assert.ok(f12From > -1, 'the F12 block exists in renderer.js');
assert.ok(f13From > f11From && f12From > f13From, 'F11, then F13, then F12');
assert.ok(f12From > f11From, 'F12 comes after F11, so it can reuse the F11 helpers');

const F11 = rendererSource.slice(f11From, f12From);
const F12 = rendererSource.slice(f12From);
const F12_CODE = stripComments(F12);

// F12 owns exactly one init point, and it MUST run after every module-scope binding it
// reads.
//
// This assertion is the regression guard for a real runtime defect: the call used to sit
// in the middle of the file, beside `initSegmentRuleSelects()`, which is BEFORE
// `const F11_PITCH_STATUS` and `const F12_OUTREACH_STATUSES`. renderer.js is an ES
// module, so that call ran inside those consts' temporal dead zone and threw a
// ReferenceError that killed the entire renderer at evaluation time - a blank app - and
// no lifted-slice test could ever have seen it, because the slice evaluates in a
// different order than the module does.
//
// So the invariant pinned here is ORDER, not adjacency to a particular statement: the
// single call site comes after the declarations it reads.
const f12InitCalls = rendererSource.match(/^f12OutreachInit\(\);$/gm) || [];
assert.strictEqual(f12InitCalls.length, 1, 'the workspace is initialised exactly once');
assert.ok(!/f12OutreachInit\(\)/.test(F11), 'the F11 block does not initialise F12');

const f12CallAt = rendererSource.indexOf('\nf12OutreachInit();\n');
assert.ok(f12CallAt > -1, 'the F12 init call is a top-level statement of its own');
for (const decl of [
  'const F11_PITCH_STATUS =',
  'const F11_GATE_REASON_LABELS =',
  'const F11_GATE_WARNING_LABELS =',
  'const F12_OUTREACH_STATUSES =',
  'const F12_OUTREACH_PAGE_SIZE =',
  'const F12_OUTREACH_MAX_GATES =',
  'const F12_OUTREACH_UNAVAILABLE =',
  'const f12OutreachState ='
]) {
  const at = rendererSource.indexOf(decl);
  assert.ok(at > -1, decl + ' exists in renderer.js');
  assert.ok(at < f12CallAt, decl + ' is initialised before the workspace init call');
}
// The call reads those bindings at evaluation time, so it must be the last statement of
// the module - nothing below it may be allowed to depend on it.
assert.strictEqual(
  rendererSource.slice(f12CallAt + '\nf12OutreachInit();\n'.length).replace(/\s+$/, ''),
  '',
  'the F12 init call is the last statement of renderer.js'
);
assert.ok(!/DOMContentLoaded/.test(F12), 'the F12 block adds no second bootstrap listener');

// F12 is the last block in styles.css, so it runs to the end of the file.
const F12_CSS = cssSource.slice(cssSource.indexOf('ZTech Frontend 2.0 - F12: Outreach workspace.'));
const f12CssCode = stripComments(F12_CSS);
assert.ok(F12_CSS.length > 100, 'the F12 CSS block exists');

const OUTREACH_VIEW = between(htmlSource, '<!-- F12 outreach-workspace-view:', '<section class="view" id="view-targets">');
const navButtonFor = (label) => {
  const idx = htmlSource.indexOf('<span class="nav-label">' + label + '</span>');
  assert.ok(idx > -1, label + ' is in the nav');
  const start = htmlSource.lastIndexOf('<button', idx);
  return htmlSource.slice(start, htmlSource.indexOf('</button>', idx));
};
const OUTREACH_NAV = navButtonFor('Outreach');

// --- minimal DOM double ------------------------------------------------------

class FakeEl {
  constructor(doc, tag) {
    this.ownerDocument = doc;
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.dataset = {};
    this.className = '';
    this._text = '';
    this.id = '';
    this.type = '';
    this.value = '';
    this.disabled = false;
    this.colSpan = 1;
    this.listeners = {};
    this.classList = {
      add: (name) => {
        const parts = String(this.className).split(/\s+/).filter(Boolean);
        if (parts.indexOf(name) === -1) parts.push(name);
        this.className = parts.join(' ');
      }
    };
  }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  replaceChildren(...cs) { this.children = []; this._text = ''; cs.forEach((c) => this.appendChild(c)); }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  fire(type) { for (const fn of this.listeners[type] || []) fn({}); }
  descendants() { return this.children.flatMap((c) => [c, ...c.descendants()]); }
  byTag(tag) { return this.descendants().filter((n) => n.tagName === String(tag).toUpperCase()); }
  byClass(name) { return this.descendants().filter((n) => String(n.className).split(/\s+/).includes(name)); }
}

function makeDoc() {
  const doc = {
    registry: new Map(),
    listeners: {},
    getElementById(id) {
      if (!this.registry.has(id)) this.registry.set(id, new FakeEl(this, 'div'));
      return this.registry.get(id);
    },
    createElement(tag) { return new FakeEl(this, tag); },
    createTextNode(v) { const n = new FakeEl(this, '#text'); n._text = String(v); return n; },
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  };
  doc.readyState = 'complete';
  const nav = new FakeEl(doc, 'button');
  nav.dataset.view = 'outreach';
  nav.className = 'nav-item';
  doc.navItem = nav;
  doc.querySelector = (sel) => (sel === '.nav-item[data-view="outreach"]' ? nav : null);
  return doc;
}

// --- fake A10 contract -------------------------------------------------------

const ok = (data) => Promise.resolve({ ok: true, data });
const fail = (code, message) => Promise.resolve({ ok: false, error: { code, message } });

function makePitch(o) {
  return Object.assign({
    pitch_id: 'pitch_1',
    lead_id: '5',
    packet_id: 'pkt_1',
    research_status: 'complete',
    target_id: null,
    icp_fit_status: 'fit',
    subject: 'A few notes on www.acme.test',
    opening: 'Hi Acme team,',
    observations: [],
    valueProposition: 'We fix what the audit found.',
    callToAction: 'Short call next week?',
    evidenceReferences: [],
    unsupportedClaims: [],
    status: 'draft',
    content_hash: 'hash_1',
    created_at: '2026-09-01T10:00:00.000Z',
    updated_at: '2026-09-01T10:00:00.000Z'
  }, o);
}

function makeGate(o) {
  return Object.assign({
    decision: 'blocked', reasons: [], warnings: [], channel: 'email',
    pitch_id: 'pitch_1', packet_id: 'pkt_1', checkedAt: '2026-09-01T10:00:00.000Z'
  }, o);
}

/** Evaluate the real F11 + F12 blocks in one sandbox against a fake API. */
function loadWorkspace(api, options) {
  const opts = options || {};
  const doc = makeDoc();
  const opened = [];
  const sandbox = {
    document: doc,
    console,
    Promise, Date, JSON, Math, Object, Array, Number, String, Boolean, Error, Set, Map, RegExp,
    isNaN, parseInt, parseFloat
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.ztechLeadIntel = api;
  if (opts.withDrawer) sandbox.openLeadDetail = (id) => { opened.push(String(id)); };
  const names = Object.keys(sandbox);
  const fn = new Function(...names, F11 + '\n' + F12 + '\nreturn {'
    + 'f12OutreachInit, f12OutreachLoad, f12OutreachRender, f12OutreachState,'
    + 'F12_OUTREACH_STATUSES, F12_OUTREACH_MAX_GATES, F12_OUTREACH_PAGE_SIZE };');
  const loaded = fn.apply(null, names.map((n) => sandbox[n]));
  // F12 ends with the module's own single `f12OutreachInit();`, so evaluating this slice
  // already wires the controls exactly as the real module does. Calling it again here
  // would attach every listener twice, which is a harness artefact of the test, not a
  // product defect - a doubled refresh would look like two loads and a doubled page step
  // would look like a broken pager.
  assert.ok(loaded.f12OutreachState, 'the workspace state object exists after evaluation');
  return Object.assign(loaded, { doc: doc, opened: opened });
}

/** The real preload shape: only window.ztechLeadIntel.outreach.{list,gate} is reachable. */
function baseApi(overrides) {
  const outreach = {
    list: () => ok({ rows: [], total: 0, limit: 20, offset: 0, status: null }),
    gate: () => ok(makeGate({ decision: 'allowed', reasons: [] }))
  };
  return { outreach: Object.assign(outreach, overrides) };
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const bodyText = (ws) => ws.doc.getElementById('outreach-body').textContent;
const rangeText = (ws) => ws.doc.getElementById('outreach-range').textContent;
const rows = (ws) => ws.doc.getElementById('outreach-body').byTag('tr');
const buttons = (ws) => ws.doc.getElementById('outreach-body').byTag('button');
const cellText = (tr, i) => (tr.children[i] ? tr.children[i].textContent : '');

// ============================================================ 1-4. structure

test('1. the Outreach view exists and is a real view, not a placeholder', () => {
  assert.ok(/<section class="view" id="view-outreach">/.test(htmlSource), 'view-outreach section exists');
  // The nav target must be a registered view, or activateView refuses it.
  const titles = between(rendererSource, 'const viewTitles = {', '};');
  assert.ok(/outreach:\s*'Outreach'/.test(titles), 'outreach is a registered view title');
  const contexts = between(rendererSource, 'const viewContexts = {', '};');
  assert.ok(/outreach:/.test(contexts), 'outreach has a breadcrumb context');
  for (const id of ['outreach-body', 'outreach-range', 'outreach-prev', 'outreach-next',
    'outreach-refresh', 'outreach-status-filter', 'outreach-gate-filter']) {
    assert.ok(htmlSource.includes('id="' + id + '"'), 'markup provides #' + id);
  }
  assert.ok(/<table class="data-table outreach-table">/.test(htmlSource), 'it reuses the existing data-table');
  for (const col of ['col-lead', 'col-status', 'col-gate', 'col-subject', 'col-research', 'col-icp', 'col-updated', 'col-actions']) {
    assert.ok(htmlSource.includes('class="' + col + '"'), 'column present: ' + col);
  }
});

test('2. Outreach navigation is enabled and activates the view', () => {
  assert.ok(/<button class="nav-item" data-view="outreach" type="button">/.test(OUTREACH_NAV), 'a real nav-item with data-view="outreach"');
  assert.ok(/<span class="nav-label">Outreach<\/span>/.test(OUTREACH_NAV), 'labelled Outreach');
  for (const gone of ['nav-item-soon', 'aria-disabled', 'class="nav-soon"', 'Available in a later release', '>Soon<']) {
    assert.ok(!OUTREACH_NAV.includes(gone), 'the Outreach item must not carry: ' + gone);
  }
  assert.ok(!/\sdisabled[\s>]/.test(OUTREACH_NAV), 'the Outreach item is not disabled');
  // The nav item is wired to the loader, so entering the view reads the store.
  assert.ok(/querySelector\('\.nav-item\[data-view="outreach"\]'\)/.test(F12), 'the nav item is found by its view target');
  assert.ok(/nav\.addEventListener\('click', \(\) => f12OutreachLoad\(\)\)/.test(F12), 'clicking it loads the workspace');
  // No router: it goes through the existing activateView path like every other item.
  assert.ok(!/location\.hash|pushState|replaceState/.test(F12), 'no router is introduced');
  // Exactly one nav item was enabled.
  const enabled = [...htmlSource.matchAll(/<button class="nav-item" data-view="outreach"/g)].length;
  assert.strictEqual(enabled, 1, 'exactly one outreach nav item');
});

test('3. Campaigns remains a disabled placeholder', () => {
  const button = navButtonFor('Campaigns');
  assert.ok(/nav-item-soon/.test(button), 'Campaigns keeps nav-item-soon');
  assert.ok(/\sdisabled[\s>]/.test(button), 'Campaigns stays disabled');
  assert.ok(/aria-disabled="true"/.test(button), 'Campaigns stays aria-disabled');
  assert.ok(/Available in a later release/.test(button), 'Campaigns keeps its placeholder title');
  assert.ok(/class="nav-soon"/.test(button), 'Campaigns keeps its Soon badge');
  assert.ok(/Campaigns/.test(button), 'still labelled Campaigns');
});

test('4. Activity remains a disabled placeholder, and no campaign exists', () => {
  const button = navButtonFor('Activity');
  assert.ok(/nav-item-soon/.test(button), 'Activity keeps nav-item-soon');
  assert.ok(/\sdisabled[\s>]/.test(button), 'Activity stays disabled');
  assert.ok(/aria-disabled="true"/.test(button), 'Activity stays aria-disabled');
  assert.ok(/class="nav-soon"/.test(button), 'Activity keeps its Soon badge');
  // Neither placeholder gained a capability behind its disabled state.
  assert.ok(!/campaign/i.test(F12_CODE), 'the F12 block contains no campaign logic at all');
  // The workspace builds DOM nodes; it creates no domain record of any kind.
  for (const banned of [/\bcreate\w*(Campaign|Segment|Search|Job|Pitch|Approval|Activity)\w*\s*\(/i,
    /\bsave\w*(Campaign|Segment|Pitch|Approval)\w*\s*\(/i,
    /\bschedule\w*\s*\(/i, /\bapprove\w*\s*\(/i, /\bsend\w*\s*\(/i]) {
    assert.ok(!banned.test(F12_CODE), 'the workspace performs no domain write: ' + banned);
  }
  // Still no campaign/activity view or data source.
  assert.ok(!/view-campaign/i.test(htmlSource), 'no campaign view exists');
});

// ============================================================ 5-8. states

test('5. outreach.list is the only data source, and refresh re-queries it', async () => {
  const calls = [];
  const api = baseApi({
    list: (q) => { calls.push(q); return ok({ rows: [makePitch({})], total: 1, limit: 20, offset: 0, status: q.status || null }); },
    gate: () => ok(makeGate({ decision: 'allowed' }))
  });
  const ws = loadWorkspace(api);
  await ws.f12OutreachLoad();
  assert.strictEqual(calls.length, 1, 'one list call per load');
  assert.deepStrictEqual(calls[0], { limit: 20, offset: 0 }, 'a bounded page is requested');
  ws.doc.getElementById('outreach-refresh').fire('click');
  await settle();
  assert.strictEqual(calls.length, 2, 'refresh re-queries outreach.list');
  // Only the two approved methods exist on the API the workspace sees.
  assert.deepStrictEqual(Object.keys(api.outreach).sort(), ['gate', 'list']);
  assert.deepStrictEqual(Object.keys(api).sort(), ['outreach'], 'nothing else is on the bridge');
});

test('6. the loading state is shown and resolves', async () => {
  let release;
  const gatePromise = new Promise((r) => { release = r; });
  const api = baseApi({ list: () => gatePromise.then(() => ok({ rows: [makePitch({})], total: 1, limit: 20, offset: 0, status: null })) });
  const ws = loadWorkspace(api);
  const loading = ws.f12OutreachLoad();
  assert.ok(bodyText(ws).includes('Loading outreach...'), 'the loading state is honest');
  assert.strictEqual(ws.doc.getElementById('outreach-body').children[0].children[0].colSpan, 8, 'the loading row spans the table');
  release();
  await loading;
  assert.ok(!bodyText(ws).includes('Loading outreach...'), 'the loading state clears');
  assert.strictEqual(rows(ws).length, 1, 'the row rendered');
});

test('7. an empty store shows the honest empty state', async () => {
  const ws = loadWorkspace(baseApi());
  await ws.f12OutreachLoad();
  assert.ok(bodyText(ws).includes('No outreach pitches yet.'), 'empty state text');
  assert.strictEqual(rows(ws).length, 1, 'one placeholder row, not a fake metric row');
  assert.ok(rangeText(ws).includes('No outreach pitches yet.'), 'the range line states it too');
  assert.ok(!/\d/.test(rangeText(ws)), 'no invented count in the empty state');
});

test('8. an error shows the real code and message, never a fake success', async () => {
  const ws = loadWorkspace(baseApi({ list: () => fail('VALIDATION_FAILED', 'pitch status filter is invalid') }));
  await ws.f12OutreachLoad();
  const text = bodyText(ws);
  assert.ok(text.includes('VALIDATION_FAILED'), 'the real error code is shown');
  assert.ok(text.includes('pitch status filter is invalid'), 'the real message is shown');
  assert.ok(!/No outreach pitches yet/.test(text), 'an error is not reported as an empty store');
  assert.ok(!/\d/.test(rangeText(ws)), 'an error invents no count');
});

// ============================================================ 9-12. rows

test('9. a populated table renders every column from the stored pitch', async () => {
  const pitch = makePitch({ lead_id: '5', subject: 'A few notes on www.acme.test', research_status: 'complete', icp_fit_status: 'fit', updated_at: '2026-09-01T10:00:00.000Z' });
  const ws = loadWorkspace(baseApi({ list: () => ok({ rows: [pitch], total: 1, limit: 20, offset: 0, status: null }) }));
  await ws.f12OutreachLoad();
  const tr = rows(ws)[0];
  assert.strictEqual(tr.getAttribute('data-pitch-id'), 'pitch_1');
  assert.strictEqual(tr.getAttribute('data-lead-id'), '5');
  assert.strictEqual(tr.children.length, 8, 'one cell per declared column');
  assert.strictEqual(cellText(tr, 0), '5', 'lead identity is the stored lead_id');
  assert.strictEqual(cellText(tr, 3), 'A few notes on www.acme.test', 'subject comes from the pitch');
  assert.strictEqual(cellText(tr, 4), 'complete', 'research status comes from the pitch');
  assert.strictEqual(cellText(tr, 5), 'fit', 'icp fit comes from the pitch');
  assert.ok(/01\/09\/2026/.test(cellText(tr, 6)), 'updated is formatted from the pitch timestamp');
  // A pitch carries no company name, so none may appear.
  assert.ok(!/Acme Bakery/i.test(bodyText(ws)), 'no lead name is invented from the domain');
  assert.ok(rangeText(ws).includes('1 of 1 pitch'), 'the range comes from the store total: ' + rangeText(ws));
});

test('10. pitch status uses the real F11 badge for each stored status', async () => {
  const seen = [];
  const expected = [
    ['draft', 'Draft', 'ok'],
    ['insufficient_evidence', 'Insufficient evidence', 'warn'],
    ['needs_revision', 'Needs revision', 'warn']
  ];
  for (const [status, label, tone] of expected) {
    const ws = loadWorkspace(baseApi({ list: () => ok({ rows: [makePitch({ status: status })], total: 1, limit: 20, offset: 0, status: null }) }));
    await ws.f12OutreachLoad();
    const badge = ws.doc.getElementById('outreach-body').byClass('lead-drawer-state')[0];
    assert.ok(badge, status + ': a status badge rendered');
    assert.strictEqual(badge.textContent, label, status + ': the F11 label');
    assert.strictEqual(badge.getAttribute('data-state'), tone, status + ': the F11 tone');
    seen.push(badge.textContent);
  }
  assert.deepStrictEqual(seen, expected.map((e) => e[1]));
  // The status set is F11_PITCH_STATUS's own keys, not a second definition.
  assert.ok(/Object\.keys\(F11_PITCH_STATUS\)/.test(F12), 'the filter reuses F11_PITCH_STATUS');
  assert.ok(!/insufficient_evidence'\s*:/.test(F12), 'no second status map is declared in F12');
  // An unknown stored status degrades honestly rather than becoming a new state.
  const ws = loadWorkspace(baseApi({ list: () => ok({ rows: [makePitch({ status: 'approved' })], total: 1, limit: 20, offset: 0, status: null }) }));
  await ws.f12OutreachLoad();
  assert.ok(bodyText(ws).includes('Unknown status'), 'an unrecognised stored status shows as unknown, never as approved');
});

test('11. gate allowed is rendered from the backend decision and never implies a send', async () => {
  const ws = loadWorkspace(baseApi({
    list: () => ok({ rows: [makePitch({})], total: 1, limit: 20, offset: 0, status: null }),
    gate: () => ok(makeGate({ decision: 'allowed', reasons: [] }))
  }));
  await ws.f12OutreachLoad();
  const cell = rows(ws)[0].children[2];
  const text = cell.textContent;
  assert.ok(text.includes('Allowed'), 'the decision is Allowed');
  assert.ok(!text.includes('Blocked'), 'and not Blocked');
  assert.ok(/Nothing is sent|Cleared for outreach/.test(text), 'allowed is explicitly not sent');
  for (const banned of ['Sent', 'sent successfully', 'delivered', 'Delivered']) {
    assert.ok(!text.includes(banned), 'allowed never implies a send: ' + banned);
  }
});

test('12. gate blocked renders the real backend reason codes and messages', async () => {
  const gate = makeGate({
    decision: 'blocked',
    reasons: [
      { code: 'HUMAN_APPROVAL', message: 'A person must approve this pitch before outreach.' },
      { code: 'EVIDENCE_FRESH', message: 'Research evidence from 2026-01-01 is stale; run research again.' }
    ],
    warnings: [{ code: 'ICP_FIT_UNKNOWN', message: 'ICP fit could not be fully evaluated.' }]
  });
  const ws = loadWorkspace(baseApi({
    list: () => ok({ rows: [makePitch({})], total: 1, limit: 20, offset: 0, status: null }),
    gate: () => ok(gate)
  }));
  await ws.f12OutreachLoad();
  const text = rows(ws)[0].children[2].textContent;
  assert.ok(text.includes('Blocked'), 'the decision is Blocked');
  assert.ok(text.includes('HUMAN_APPROVAL'), 'reason code 1');
  assert.ok(text.includes('A person must approve this pitch before outreach.'), 'reason message 1');
  assert.ok(text.includes('EVIDENCE_FRESH'), 'reason code 2');
  assert.ok(text.includes('run research again'), 'reason message 2');
  // Human approval is a record surfaced through the gate, not a fourth pitch status.
  assert.ok(text.includes('Human approval'), 'the F11 label map is reused for the reason');
  assert.ok(text.includes('ICP_FIT_UNKNOWN'), 'warning code');
  assert.ok(text.includes('ICP fit could not be fully evaluated.'), 'warning message');
  // The renderer reads the decision, it never infers it. The patterns are precise:
  // no gate evaluation, no hardcoded reason code, no reason list defined in the
  // renderer. (A bare `reasons : []` fallback is a read of the backend's own array,
  // not a definition of one, so it is not what is banned here.)
  assert.ok(/gate\.decision === 'allowed'/.test(F12), 'the only decision read is the backend value');
  assert.ok(!/evaluateOutreachGate/.test(F12), 'the renderer never evaluates a gate');
  assert.ok(!/code:\s*'[A-Z_]{4,}'/.test(F12_CODE), 'the renderer defines no reason code of its own');
  assert.ok(!/REASONS\s*=\s*\[|REASON_CODES/.test(F12), 'the renderer defines no reason vocabulary');
  // Every reason shown comes from the object the backend returned.
  assert.ok(/for \(const reason of reasons\)/.test(F12) && /reason\.code/.test(F12), 'reasons are iterated from the response');
});

test('12b. a gate that cannot be read is unavailable, not silently blocked', async () => {
  const ws = loadWorkspace(baseApi({
    list: () => ok({ rows: [makePitch({})], total: 1, limit: 20, offset: 0, status: null }),
    gate: () => fail('NOT_FOUND', 'Pitch not found')
  }));
  await ws.f12OutreachLoad();
  const text = rows(ws)[0].children[2].textContent;
  assert.ok(text.includes('Unavailable'), 'an unreadable gate says so');
  assert.ok(text.includes('NOT_FOUND'), 'with the real code');
  assert.ok(!text.includes('Blocked'), 'and is not silently treated as blocked');
  assert.ok(!text.includes('Allowed'), 'nor as allowed');
});

// ============================================================ 13-15. filters / paging

test('13. pitch status filtering is server-side and resets the page', async () => {
  const calls = [];
  const api = baseApi({
    list: (q) => { calls.push(q); return ok({ rows: [makePitch({ status: q.status || 'draft' })], total: 1, limit: 20, offset: q.offset, status: q.status || null }); },
    gate: () => ok(makeGate({ decision: 'allowed' }))
  });
  const ws = loadWorkspace(api);
  await ws.f12OutreachLoad();
  const select = ws.doc.getElementById('outreach-status-filter');
  // The options ARE F11_PITCH_STATUS's own key set, in its own declaration order,
  // behind an "all" option. Nothing is hand-written and nothing is reordered.
  assert.deepStrictEqual(select.children.map((o) => o.value), [''].concat(ws.F12_OUTREACH_STATUSES),
    'the filter offers exactly the real statuses');
  assert.deepStrictEqual(ws.F12_OUTREACH_STATUSES.slice().sort(),
    ['draft', 'insufficient_evidence', 'needs_revision'],
    'and those are exactly the three real persisted statuses');
  assert.ok(!ws.F12_OUTREACH_STATUSES.includes('approved'), 'approved is not a pitch status');
  assert.ok(!ws.F12_OUTREACH_STATUSES.includes('sent'), 'sent is not a pitch status');
  assert.ok(!ws.F12_OUTREACH_STATUSES.includes('blocked'), 'a gate decision is not a pitch status');
  select.value = 'needs_revision';
  select.fire('change');
  await settle();
  assert.strictEqual(calls[calls.length - 1].status, 'needs_revision', 'the filter reaches outreach.list');
  assert.strictEqual(calls[calls.length - 1].offset, 0, 'changing the filter returns to the first page');
  // Gate filtering stays client-side and bounded: no extra list call.
  const before = calls.length;
  ws.doc.getElementById('outreach-gate-filter').value = 'blocked';
  ws.doc.getElementById('outreach-gate-filter').fire('change');
  await settle();
  assert.strictEqual(calls.length, before, 'a gate filter never triggers another list call');
});

test('13b. a gate filter narrows the loaded page and says so honestly', async () => {
  const pitches = [makePitch({ pitch_id: 'p1', lead_id: '1' }), makePitch({ pitch_id: 'p2', lead_id: '2' })];
  const ws = loadWorkspace(baseApi({
    list: () => ok({ rows: pitches, total: 2, limit: 20, offset: 0, status: null }),
    gate: (a) => ok(makeGate({ decision: a.pitchId === 'p1' ? 'allowed' : 'blocked' }))
  }));
  await ws.f12OutreachLoad();
  assert.strictEqual(rows(ws).length, 2);
  const filter = ws.doc.getElementById('outreach-gate-filter');
  filter.value = 'blocked';
  filter.fire('change');
  assert.strictEqual(rows(ws).length, 1, 'only the blocked pitch remains');
  assert.strictEqual(rows(ws)[0].getAttribute('data-pitch-id'), 'p2');
  const text = rangeText(ws);
  assert.ok(/1 of 2 on this page are blocked/.test(text), 'the filter scope is stated: ' + text);
  assert.ok(/1–2 of 2 pitches/.test(text), 'the range still comes from the store: ' + text);
  // A page where nothing matches says so rather than looking empty overall.
  filter.value = 'allowed';
  filter.fire('change');
  assert.strictEqual(rows(ws).length, 1, 'the allowed pitch is the one that remains');
  assert.strictEqual(rows(ws)[0].getAttribute('data-pitch-id'), 'p1');
  // An unreadable gate is not counted as either decision, so it drops out of both.
  const ws2 = loadWorkspace(baseApi({
    list: () => ok({ rows: [makePitch({ pitch_id: 'p1' })], total: 1, limit: 20, offset: 0, status: null }),
    gate: () => fail('NOT_FOUND', 'Pitch not found')
  }));
  await ws2.f12OutreachLoad();
  const f2 = ws2.doc.getElementById('outreach-gate-filter');
  f2.value = 'blocked';
  f2.fire('change');
  assert.ok(bodyText(ws2).includes('No pitches match these filters.'), 'an unreadable gate matches neither filter');
});

test('14. pagination uses the store envelope and never fetches the whole table', async () => {
  const calls = [];
  const ws = loadWorkspace(baseApi({
    list: (q) => { calls.push(q); return ok({ rows: [makePitch({ pitch_id: 'pitch_' + q.offset })], total: 95, limit: 20, offset: q.offset, status: null }); },
    gate: () => ok(makeGate({ decision: 'allowed' }))
  }));
  await ws.f12OutreachLoad();
  assert.ok(rangeText(ws).includes('of 95 pitches'), 'the total comes from the store envelope: ' + rangeText(ws));
  assert.ok(ws.doc.getElementById('outreach-prev').disabled, 'Previous is disabled on the first page');
  assert.ok(!ws.doc.getElementById('outreach-next').disabled, 'Next is available');
  ws.doc.getElementById('outreach-next').fire('click');
  await settle();
  assert.deepStrictEqual(calls[calls.length - 1], { limit: 20, offset: 20 }, 'Next advances by one page');
  assert.strictEqual(ws.doc.getElementById('outreach-prev').disabled, false, 'Previous becomes available');
  for (let i = 0; i < 8; i++) { ws.doc.getElementById('outreach-prev').fire('click'); await settle(); }
  assert.deepStrictEqual(calls[calls.length - 1], { limit: 20, offset: 0 }, 'Previous clamps at the first page');
  assert.ok(calls.every((c) => c.limit === 20), 'every request is page-bounded');
});

test('15. gate evaluation is bounded to the visible page', async () => {
  const many = Array.from({ length: 20 }, (_, i) => makePitch({ pitch_id: 'pitch_' + i, lead_id: String(i) }));
  let gateCalls = 0;
  const ws = loadWorkspace(baseApi({
    list: () => ok({ rows: many, total: 400, limit: 20, offset: 0, status: null }),
    gate: () => { gateCalls++; return ok(makeGate({ decision: 'allowed' })); }
  }));
  await ws.f12OutreachLoad();
  assert.strictEqual(rows(ws).length, 20, 'one row per pitch on the page');
  assert.strictEqual(gateCalls, 20, 'exactly one gate read per visible row, and no more');
  assert.ok(gateCalls <= ws.F12_OUTREACH_MAX_GATES, 'the gate budget is respected');
  assert.ok(ws.F12_OUTREACH_MAX_GATES <= ws.F12_OUTREACH_PAGE_SIZE, 'the budget can never exceed a page');
  assert.ok(gateCalls < 400, 'the full table is not gate-evaluated');
});

// ============================================================ 16-20. read-only + guards

test('16. opening the lead is the only action the F12 block itself offers', async () => {
  // Scope note, stated honestly: this row's gate is `allowed`, so no approval is
  // waiting and the F13 block offers no Approve action either - the only button is
  // "Open lead". F13 deliberately adds a second action for a gate blocked by
  // HUMAN_APPROVAL; that is covered by tests/frontend13-outreach-approval.test.js and is
  // NOT a read the F12 block performs. What this test pins is that the F12 block on its
  // own still reaches only list and gate, and still has no send/generate/save control.
  const ws = loadWorkspace(
    baseApi({ list: () => ok({ rows: [makePitch({})], total: 1, limit: 20, offset: 0, status: null }) }),
    { withDrawer: true }
  );
  await ws.f12OutreachLoad();
  const labels = buttons(ws).map((b) => b.textContent);
  for (const banned of ['Generate', 'Approve', 'Save', 'Send', 'Test Send', 'Revoke', 'campaign', 'Campaign']) {
    assert.ok(!labels.some((l) => new RegExp(banned, 'i').test(l)), 'no such button: ' + banned);
  }
  assert.deepStrictEqual(labels, ['Open lead'], 'the only row action opens the lead');
  ws.doc.getElementById('outreach-body').byTag('button')[0].fire('click');
  assert.deepStrictEqual(ws.opened, ['5'], 'it reuses the F5 lead drawer with the stored lead id');
  // No pitch mutation is even reachable from this block. The patterns require a call
  // paren so a field like `pitch.updated_at` is not mistaken for `pitch.update`.
  for (const banned of [/pitch\.generate\s*\(/, /pitch\.update\s*\(/, /outreach\.approve\s*\(/, /outreach\.send\s*\(/]) {
    assert.ok(!banned.test(F12), 'no pitch mutation is callable here: ' + banned);
  }
  // The only bridge methods the whole block reaches are list and gate.
  const used = [...F12_CODE.matchAll(/api\.(\w+)\.(\w+)\(/g)].map((m) => m[1] + '.' + m[2]);
  assert.deepStrictEqual([...new Set(used)].sort(), ['outreach.gate', 'outreach.list'],
    'the workspace reaches exactly outreach.list and outreach.gate');
  assert.strictEqual(ws.doc.getElementById('outreach-body').byClass('f11-claims').length, 0, 'no unsupported-claim editor');
});

test('16b. the workspace markup contains no outbound control', () => {
  for (const banned of [/\bSend\b/, /Test Send/, /\bRevoke\b/, /Batch/, /New campaign/]) {
    assert.ok(!banned.test(OUTREACH_VIEW), 'markup must not contain: ' + banned);
  }
  assert.ok(!/id="outreach-(send|approve|generate|save)/.test(OUTREACH_VIEW), 'no mutation control ids');
  const buttonLabels = [...OUTREACH_VIEW.matchAll(/<button[^>]*>([^<]*)</g)].map((m) => m[1].trim());
  assert.deepStrictEqual(buttonLabels.slice().sort(), ['Next', 'Previous', 'Refresh']);
});

test('17. no fetch, XHR, WebSocket, EventSource or innerHTML in the workspace', () => {
  // Banned tokens are checked against comment-stripped code: the block's own header
  // legitimately NAMES these things to document that it does not use them. A name in a
  // comment is fine; a call in code is not.
  for (const banned of [/\bfetch\s*\(/, /XMLHttpRequest/, /\bWebSocket\b/, /EventSource/, /innerHTML/, /document\.write/]) {
    assert.ok(!banned.test(F12_CODE), 'the F12 block must not use: ' + banned);
    assert.ok(!banned.test(f12CssCode), 'the F12 CSS block must not use: ' + banned);
  }
  // And the names appear only inside comments in the raw source.
  const rawCodeLines = F12.split('\n').filter((l) => /innerHTML|require\s*\(/.test(l));
  for (const line of rawCodeLines) {
    assert.ok(/^\s*\/\//.test(line), 'a banned token appears outside a comment: ' + line.trim());
  }
  assert.ok(!/\bfetch\s*\(|XMLHttpRequest|\bWebSocket\b|innerHTML/.test(stripComments(F11)), 'the reused F11 helpers stay clean');
});

test('18. no renderer database access, no require, no ipcRenderer, no email', () => {
  for (const banned of [/require\s*\(/, /ipcRenderer/, /contextBridge/, /sqlite/i, /sql\.js/, /AccountStore/, /SqlJsStore/, /li_pitch_drafts/, /EMAIL_SEND/, /email\.send/, /outreach\.send/]) {
    assert.ok(!banned.test(F12_CODE), 'the F12 block must not reference: ' + banned);
  }
  assert.ok(/api\.outreach\.list\(/.test(F12), 'outreach.list is the data source');
  assert.ok(/api\.outreach\.gate\(/.test(F12), 'outreach.gate is the gate source');
  const called = [...F12_CODE.matchAll(/api\.outreach\.(\w+)\(/g)].map((m) => m[1]);
  assert.deepStrictEqual([...new Set(called)].sort(), ['gate', 'list'], 'only outreach.list and outreach.gate are called');
  assert.ok(!/window\.appAPI/.test(F12), 'the workspace does not reach appAPI');
  // email.send is still not exposed by the preload surface.
  assert.ok(!/lead-intel:email-send/.test(preloadSource), 'preload still exposes no email.send');
  assert.ok(/outreach:\s*Object\.freeze/.test(preloadSource), 'the outreach namespace is still there');
});

test('19. no fake metrics, no invented counts, no invented names', async () => {
  assert.ok(!/<div class="[^"]*(metric|stat|kpi|tile|hero|card)/i.test(OUTREACH_VIEW), 'no metric or hero block');
  assert.ok(!/\d+\s*%|10x/.test(OUTREACH_VIEW), 'no invented score in the markup');
  assert.ok(!/faked|canned|demo|sample/i.test(F12), 'no canned or demo data');
  // The unavailable treatment is the honest dash, used when a pitch has no value.
  const ws = loadWorkspace(baseApi({
    list: () => ok({ rows: [makePitch({ subject: '', research_status: null, icp_fit_status: null, updated_at: null })], total: 1, limit: 20, offset: 0, status: null })
  }));
  await ws.f12OutreachLoad();
  const tr = rows(ws)[0];
  for (const i of [3, 4, 5, 6]) {
    assert.strictEqual(cellText(tr, i), '—', 'a missing pitch field renders the honest dash, column ' + i);
  }
});

test('20. the workspace reuses the existing design system', () => {
  assert.ok(/class="data-table outreach-table"/.test(OUTREACH_VIEW), 'the existing data-table class');
  assert.ok(/class="lists-workspace outreach-workspace"/.test(OUTREACH_VIEW), 'the existing lists workspace chrome');
  assert.ok(/class="lists-header"/.test(OUTREACH_VIEW) && /class="lists-actions"/.test(OUTREACH_VIEW), 'the existing lists header/actions');
  for (const banned of [/linear-gradient/, /radial-gradient/, /box-shadow/, /border-radius:\s*\d+px/]) {
    assert.ok(!banned.test(f12CssCode), 'the F12 CSS introduces: ' + banned);
  }
  assert.ok(!/#[0-9a-f]{3,6}/i.test(f12CssCode), 'the F12 CSS introduces no literal colour');
  const used = [...new Set([...f12CssCode.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]))];
  assert.ok(used.length > 0, 'the F12 CSS uses existing tokens');
  for (const token of used) {
    assert.ok(new RegExp('\\s' + token + ':').test(cssSource), 'token is already defined by an earlier block: ' + token);
    assert.ok(!new RegExp('\\n\\s*' + token + ':').test(F12_CSS), 'the F12 block defines no token of its own: ' + token);
  }
  // The F11 visual language for status and gate is reused, not reinvented.
  assert.ok(/f11PitchStatusBadge\(/.test(F12), 'the F11 status badge is reused');
  assert.ok(/f11Status\(/.test(F12), 'the F11 gate badge is reused');
  assert.ok(/F11_GATE_REASON_LABELS/.test(F12) && /F11_GATE_WARNING_LABELS/.test(F12), 'the F11 label maps are reused');
  assert.ok(/f11-reasons|f11-reason-code-raw/.test(F12), 'the F11 reason markup is reused');
  // Responsive: the table scrolls inside its wrap, and there is a narrow-width rule.
  assert.ok(/\.outreach-table-wrap\s*\{[^}]*overflow:\s*auto/.test(f12CssCode), 'the table scrolls inside its own wrapper');
  assert.ok(/@media \(max-width: 900px\)/.test(f12CssCode), 'a 900px rule exists');
  assert.ok(!/100vw/.test(f12CssCode), 'nothing is sized to the viewport width');
});

test('20b. dependencies and the F11 boundary are untouched', () => {
  assert.deepStrictEqual(Object.keys(pkg.dependencies).sort(),
    ['@modelcontextprotocol/client', 'ajv', 'ajv-formats', 'electron-store', 'sql.js'], 'no dependency added');
  assert.ok(/function loadLeadDrawerPitch\(lead\)/.test(F11), 'the F11 entry point is intact');
  // The F11 slice above runs to the F12 block so the harness can evaluate the row
  // builder, and it therefore contains the F13 block too. This boundary assertion is
  // about the F11 block ITSELF: no F12 and no F13 code may live inside it.
  const f11Only = rendererSource.slice(f11From, f13From);
  assert.ok(!/F12/.test(f11Only), 'no F12 code was injected into the F11 block');
  assert.ok(!/F13/.test(f11Only), 'no F13 code was injected into the F11 block');
  assert.ok(rendererSource.indexOf('// === F5 Lead Detail Drawer ===') < f12From, 'F5 is available to the workspace');
  // No polling or timers were introduced.
  assert.ok(!/setInterval|setTimeout/.test(F12), 'the workspace has no timer or polling');
});

// Async tests, run in order, so the pass/fail summary is the last line of output.
// tests/run-all.js only counts a file when it sees that line. The IIFE keeps this file
// CommonJS: top-level await would make Node guess the module format and fail.
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

  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.log(String((err && err.stack) || err));
  process.exit(1);
});
