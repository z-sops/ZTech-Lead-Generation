'use strict';

// Frontend 2.0 F11 - Outreach, Lead Drawer Pitch tab.
//
// The Pitch tab is a presentation layer over the A10 Lead Intelligence contract.
// These tests pin that claim: the tab renders the stored pitch draft, the three
// real pitch states, the backend's own gate reasons and warnings, and derives
// approval ONLY from the gate. It never recomputes the gate, never invents an
// "approved" state, never fabricates evidence, and never offers a send control.
//
// Where behaviour can be executed, it is executed: the real F11 block is lifted
// from renderer.js and run against a minimal DOM double and a fake
// window.ztechLeadIntel. No jsdom, no new dependency.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const htmlSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const rendererSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'renderer.js'), 'utf8');
const cssSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'styles.css'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const pkg = require(path.join(root, 'package.json'));

// Tests are collected, then run in order, so the pass/fail summary is the last
// line of output. tests/run-all.js only counts a file when it sees that line.
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const F11_MARKER = '// === F11 Outreach: Lead Drawer Pitch tab ===';
// F12 declared lock update: the F11 slice is now bounded at the start of the F12
// block. It used to run to the end of the file, which silently swept the F12 Outreach
// workspace into every F11 assertion. The boundary keeps each block's tests honest.
// F13 declared lock update: the F13 approval block is placed immediately after F11 and
// before F12, so the F11 slice is bounded at the F13 marker instead. Nothing else about
// the F11 boundary changes: the slice still starts at the F11 block and still stops at
// the first block that follows it.
const F13_MARKER = '// === F13 Outreach: human approval of one pitch ===';
const f11From = rendererSource.indexOf(F11_MARKER);
const f13From = rendererSource.indexOf(F13_MARKER);
assert.ok(f11From > -1, 'the F11 block exists in renderer.js');
assert.ok(f13From > f11From, 'the F13 block follows the F11 block, so the slice can be bounded there');
const F11 = rendererSource.slice(f11From, f13From);
const f11Code = F11.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const f5From = rendererSource.indexOf('// === F5 Lead Detail Drawer ===');
const F5 = rendererSource.slice(f5From, rendererSource.indexOf('function splitImportLines('));
const f5Code = F5.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const pitchPanelHtml = htmlSource.slice(
  htmlSource.indexOf('id="lead-panel-pitch"'),
  htmlSource.indexOf('<!-- P1-F Target Builder')
);
const F11_CSS = cssSource.slice(cssSource.indexOf('ZTech Frontend 2.0 - F11: Outreach, Lead Drawer Pitch tab.'));

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
    this.checked = false;
    this.disabled = false;
    this.rows = 0;
    this.maxLength = -1;
    this.hidden = false;
    this.tabIndex = 0;
    this.listeners = {};
  }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  get childElementCount() { return this.children.length; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  replaceChildren(...cs) { this.children = []; this._text = ''; cs.forEach((c) => this.appendChild(c)); }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; }
  removeAttribute(k) { delete this.attributes[k]; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  fire(type) { for (const fn of this.listeners[type] || []) fn({}); }
  descendants() { return this.children.flatMap((c) => [c, ...c.descendants()]); }
  byTag(tag) { return this.descendants().filter((n) => n.tagName === tag.toUpperCase()); }
  byClass(name) { return this.descendants().filter((n) => String(n.className).split(/\s+/).includes(name)); }
}

function makeDoc() {
  const doc = {
    registry: new Map(),
    getElementById(id) {
      if (!this.registry.has(id)) this.registry.set(id, new FakeEl(this, 'div'));
      return this.registry.get(id);
    },
    createElement(tag) { return new FakeEl(this, tag); },
    createTextNode(value) { const n = new FakeEl(this, '#text'); n._text = String(value); return n; }
  };
  for (const key of ['overview', 'research', 'evidence', 'icp', 'pitch']) {
    const tab = doc.getElementById('lead-tab-' + key);
    tab.setAttribute('role', 'tab');
    tab.dataset.tab = key;
    doc.getElementById('lead-panel-' + key).hidden = key !== 'overview';
  }
  return doc;
}

// --- fake A10 contract -------------------------------------------------------

const ok = (data) => Promise.resolve({ ok: true, data });
const fail = (code, message, errors) => Promise.resolve({ ok: false, error: { code, message, ...(errors ? { errors } : {}) } });

/** A pitch whose every field comes from the A10 PitchGenerator contract. */
function makePitch(overrides) {
  return {
    pitch_id: 'pitch_abc123',
    lead_id: 'L1',
    packet_id: 'pkt_1',
    research_status: 'complete',
    target_id: null,
    icp_fit_status: 'fit',
    subject: 'A few notes on www.acme.test',
    opening: 'Hi Acme team, I reviewed a website audit.',
    observations: [{ text: 'Missing meta description - 4 of 14 pages', refs: ['find_a', 'f003'], provenance: [{ lead_id: 'L1', packet_id: 'pkt_1' }] }],
    valueProposition: 'We fix the issues an audit finds.',
    callToAction: 'Short call next week?',
    evidenceReferences: [{ ref: 'f003' }],
    unsupportedClaims: [],
    status: 'draft',
    content_hash: 'hash1',
    created_at: '2026-09-01T10:00:00.000Z',
    updated_at: '2026-09-01T10:00:00.000Z',
    ...(overrides || {})
  };
}

function makeGate(overrides) {
  return {
    decision: 'blocked',
    reasons: [{ code: 'HUMAN_APPROVAL', message: 'A person must approve this pitch before outreach.' }],
    warnings: [],
    channel: 'email',
    pitch_id: 'pitch_abc123',
    packet_id: 'pkt_1',
    checkedAt: '2026-09-01T11:00:00.000Z',
    ...(overrides || {})
  };
}

const APPROVAL = { approval_id: 'appr_1', pitch_id: 'pitch_abc123', content_hash: 'hash1', approved_by: 'local-user', approved_at: '2026-09-01T11:00:00.000Z' };

/** Loads the real F11 block and binds it to a fake DOM and a fake API. */
function makeEnv(api) {
  const doc = makeDoc();
  const win = { ztechLeadIntel: api };
  const loaded = new Function('window', 'document',
    F11 + '\nreturn { loadLeadDrawerPitch: loadLeadDrawerPitch };'
  )(win, doc);
  return { doc, win, api: loaded, box: doc.getElementById('lead-drawer-pitch') };
}

function baseApi(overrides) {
  const o = overrides || {};
  return {
    pitch: { get: () => ok(makePitch()), generate: () => ok(makePitch()), update: () => ok(makePitch()), ...(o.pitch || {}) },
    outreach: { gate: () => ok(makeGate()), approve: () => ok(APPROVAL), ...(o.outreach || {}) }
  };
}

const buttons = (env) => env.box.byTag('button');
const buttonByLabel = (env, label) => buttons(env).find((b) => b.textContent === label);
const text = (env) => env.box.textContent;
const settle = () => new Promise((r) => setTimeout(r, 0));
const LEAD = { id: 'L1', website: 'https://acme.test' };

// --- 1. no pitch -------------------------------------------------------------

test('1. a null pitch renders "No pitch yet" and a Generate control', async () => {
  const env = makeEnv(baseApi({ pitch: { get: () => ok(null) } }));
  await env.api.loadLeadDrawerPitch(LEAD);
  assert.ok(/No pitch yet/.test(text(env)), 'the empty state says so');
  assert.ok(buttonByLabel(env, 'Generate pitch'), 'Generate is offered');
  assert.strictEqual(buttonByLabel(env, 'Approve pitch'), undefined, 'there is nothing to approve');
  assert.ok(/Nothing is sent from this drawer\./.test(text(env)), 'and nothing is sent');
});

test('1b. the empty state does not fabricate a reason when the lead has no website', async () => {
  const env = makeEnv(baseApi({ pitch: { get: () => ok(null) } }));
  await env.api.loadLeadDrawerPitch({ id: 'L1', website: '' });
  assert.ok(/has not been researched yet/.test(text(env)), 'the honest cause is shown');
});

// --- 2. the four real UI states ----------------------------------------------

test('2a. insufficient_evidence shows the state, an honest cause and no invented observation', async () => {
  const pitch = makePitch({ status: 'insufficient_evidence', observations: [], unsupportedClaims: [], packet_id: null, research_status: null });
  const env = makeEnv(baseApi({ pitch: { get: () => ok(pitch) } }));
  await env.api.loadLeadDrawerPitch(LEAD);
  assert.ok(/Insufficient evidence/.test(text(env)), 'the real state label is shown');
  assert.ok(/No stored research evidence/.test(text(env)), 'the honest cause is shown');
  assert.strictEqual(env.box.byClass('f11-observation').length, 0, 'no observation is invented');
  assert.ok(/no evidence-backed observations/.test(text(env)), 'and it says there are none');
});

test('2b. a failed research reports the failure rather than a generic state', async () => {
  const pitch = makePitch({ status: 'insufficient_evidence', observations: [], research_status: 'failed', packet_id: 'pkt_1' });
  const env = makeEnv(baseApi({ pitch: { get: () => ok(pitch) } }));
  await env.api.loadLeadDrawerPitch(LEAD);
  assert.ok(/latest stored research for this lead failed/.test(text(env)));
});

test('2c. needs_revision renders the claim alert with the real claim reasons', async () => {
  const pitch = makePitch({
    status: 'needs_revision',
    unsupportedClaims: [
      { field: 'valueProposition', text: 'Your website is slow.', reason: 'PROBLEM_CLAIM_WITHOUT_EVIDENCE' },
      { field: 'callToAction', text: 'We guarantee #1.', reason: 'PROHIBITED_CLAIM' }
    ]
  });
  const env = makeEnv(baseApi({ pitch: { get: () => ok(pitch) } }));
  await env.api.loadLeadDrawerPitch(LEAD);
  assert.ok(/Needs revision/.test(text(env)));
  const alert = env.box.descendants().find((n) => n.getAttribute('role') === 'alert');
  assert.ok(alert, 'the claims are announced as an alert');
  for (const reason of ['PROHIBITED_CLAIM', 'PROBLEM_CLAIM_WITHOUT_EVIDENCE']) {
    assert.ok(alert.textContent.includes(reason), 'the real reason is shown: ' + reason);
  }
});

test('2d. draft renders the editable draft and its evidence line', async () => {
  const env = makeEnv(baseApi());
  await env.api.loadLeadDrawerPitch(LEAD);
  assert.ok(/Draft/.test(text(env)));
  assert.ok(/Research complete/.test(text(env)), 'the evidence line reads the stored research state');
  assert.ok(/1 observation/.test(text(env)), 'the observation count is the real count');
  assert.ok(/Evidence: find_a, f003/.test(text(env)), 'the evidence refs are visible');
});

test('2e. an unknown status is labelled honestly and is not approvable', async () => {
  const env = makeEnv(baseApi({ pitch: { get: () => ok(makePitch({ status: 'approved' })) } }));
  await env.api.loadLeadDrawerPitch(LEAD);
  assert.ok(/Unknown status/.test(text(env)), 'no invented state is displayed');
  assert.strictEqual(buttonByLabel(env, 'Approve pitch').disabled, true, 'and it is not approvable');
});

// --- 3. approve availability -------------------------------------------------

test('3. Approve is enabled only for a clean draft', async () => {
  const cases = [
    ['draft', true],
    ['needs_revision', false],
    ['insufficient_evidence', false]
  ];
  for (const [status, enabled] of cases) {
    const pitch = makePitch({
      status,
      unsupportedClaims: status === 'draft' ? [] : [{ field: 'x', text: 'y', reason: 'PROHIBITED_CLAIM' }]
    });
    const env = makeEnv(baseApi({ pitch: { get: () => ok(pitch) } }));
    await env.api.loadLeadDrawerPitch(LEAD);
    const approve = buttonByLabel(env, 'Approve pitch');
    assert.ok(approve, 'the Approve control exists for ' + status);
    assert.strictEqual(approve.disabled, !enabled, 'Approve disabled for ' + status);
  }
});

// --- 4/5. observations are evidence, not copy --------------------------------

test('4. observation text comes from the pitch and nothing is invented', async () => {
  const env = makeEnv(baseApi());
  await env.api.loadLeadDrawerPitch(LEAD);
  const items = env.box.byClass('f11-observation');
  assert.strictEqual(items.length, 1);
  assert.ok(items[0].textContent.includes('Missing meta description'), 'the stored text is shown');
});

test('5. observation text is not editable', async () => {
  const env = makeEnv(baseApi());
  await env.api.loadLeadDrawerPitch(LEAD);
  const obs = env.box.byClass('f11-observation')[0];
  assert.strictEqual(obs.byTag('textarea').length, 0, 'no textarea in an observation');
  // The only control on an observation is the remove checkbox, never a text field.
  const inputs = obs.byTag('input');
  assert.ok(inputs.every((n) => n.type === 'checkbox'), 'the only observation control is a remove checkbox');
  assert.ok(/cannot be edited/.test(text(env)), 'the constraint is stated');
});

// --- 6. removeObservations ---------------------------------------------------

test('6. ticking an observation sends exactly that index', async () => {
  const sent = [];
  const pitch = makePitch({
    observations: [
      { text: 'first finding', refs: ['f1'], provenance: [] },
      { text: 'second finding', refs: ['f2'], provenance: [] },
      { text: 'third finding', refs: ['f3'], provenance: [] }
    ]
  });
  const env = makeEnv(baseApi({ pitch: { get: () => ok(pitch), update: (p) => { sent.push(p); return ok(pitch); } } }));
  await env.api.loadLeadDrawerPitch(LEAD);
  const removes = env.box.byClass('f11-remove');
  assert.strictEqual(removes.length, 3, 'one remove control per observation');
  removes[1].checked = true;
  buttonByLabel(env, 'Save edits').fire('click');
  await settle();
  assert.strictEqual(sent.length, 1, 'the save ran');
  assert.deepStrictEqual(sent[0].removeObservations, [1], 'the correct index was sent');
  assert.strictEqual(sent[0].pitchId, 'pitch_abc123');
});

test('6b. an untouched draft sends an empty removal list', async () => {
  const sent = [];
  const env = makeEnv(baseApi({ pitch: { update: (p) => { sent.push(p); return ok(makePitch()); } } }));
  await env.api.loadLeadDrawerPitch(LEAD);
  buttonByLabel(env, 'Save edits').fire('click');
  await settle();
  assert.deepStrictEqual(sent[0].removeObservations, [], 'no removals is an empty list');
});

// --- 7. maxlengths -----------------------------------------------------------

test('7. the four editable fields carry the backend maxlengths', async () => {
  const env = makeEnv(baseApi());
  await env.api.loadLeadDrawerPitch(LEAD);
  // Each field is a real labelled control: the label's `for` resolves to the input's id.
  const inputs = env.box.descendants().filter((n) => n.tagName === 'INPUT' || n.tagName === 'TEXTAREA');
  const byId = {};
  for (const input of inputs) byId[input.id] = input;
  const labels = env.box.descendants().filter((n) => n.getAttribute('for'));
  const expected = { subject: 150, opening: 600, valueProposition: 1200, callToAction: 400 };
  assert.strictEqual(labels.length, 4, 'four labelled fields, and nothing else editable');
  for (const label of labels) {
    const max = expected[label.getAttribute('for').replace('f11-', '')];
    assert.ok(max, 'the field is one of the four contract fields: ' + label.getAttribute('for'));
    const input = byId[label.getAttribute('for')];
    assert.ok(input, 'the label resolves to a control: ' + label.getAttribute('for'));
    assert.strictEqual(input.maxLength, max, 'maxlength on ' + label.getAttribute('for'));
    assert.strictEqual(input.getAttribute('maxlength'), String(max), 'maxlength attribute');
  }
});

// --- 8/9/10. the gate is the backend's, verbatim -----------------------------

const ALL_REASON_CODES = [
  'LEAD_IDENTITY', 'CONTACT_FIELD', 'CHANNEL_NOT_SUPPORTED', 'QUALIFICATION', 'ICP_FIT',
  'PITCH_MISSING', 'EVIDENCE_PRESENT', 'EVIDENCE_OUTDATED', 'EVIDENCE_FRESH',
  'EVIDENCE_COMPLETE', 'PROHIBITED_CLAIMS', 'PITCH_INTEGRITY', 'HUMAN_APPROVAL'
];

test('8. every gate reason the backend can return is rendered with its code and message', async () => {
  // The backend's own reason text is what the user reads; the code is shown too.
  const MESSAGES = {
    LEAD_IDENTITY: 'The lead has no business name.',
    CONTACT_FIELD: 'The lead has no valid email address.',
    CHANNEL_NOT_SUPPORTED: 'Outreach channel "email" is not supported yet.',
    QUALIFICATION: 'Qualification "unqualified" is not allowed for outreach.',
    ICP_FIT: 'The lead does not fit the selected ICP: outside the city.',
    PITCH_MISSING: 'No pitch draft exists.',
    EVIDENCE_PRESENT: 'The pitch is not linked to stored research evidence.',
    EVIDENCE_OUTDATED: 'Newer research exists; regenerate the pitch.',
    EVIDENCE_FRESH: 'Research evidence from 2026-08-01 is stale; run research again.',
    EVIDENCE_COMPLETE: 'Research is partial; complete research is required for outreach.',
    PROHIBITED_CLAIMS: '1 unsupported or prohibited claim(s) must be removed.',
    PITCH_INTEGRITY: 'The pitch content does not match its stored hash.',
    HUMAN_APPROVAL: 'A person must approve this pitch before outreach.'
  };
  const reasons = ALL_REASON_CODES.map((code) => ({ code, message: MESSAGES[code] }));
  const env = makeEnv(baseApi({ outreach: { gate: () => ok(makeGate({ reasons })) } }));
  await env.api.loadLeadDrawerPitch(LEAD);
  assert.strictEqual(env.box.byClass('f11-reason').length, ALL_REASON_CODES.length, 'no reason is summarised away');
  for (const code of ALL_REASON_CODES) {
    assert.ok(text(env).includes(code), 'the raw code is shown: ' + code);
    assert.ok(text(env).includes(MESSAGES[code]), 'the backend message is shown verbatim: ' + code);
    assert.ok(F11.includes(code + ':'), 'the block maps a label for ' + code);
  }
});

test('9. warnings render separately and are not treated as blockers', async () => {
  const gate = makeGate({
    reasons: [{ code: 'QUALIFICATION', message: 'blocked' }],
    warnings: [
      { code: 'ICP_FIT_UNKNOWN', message: 'ICP fit could not be fully evaluated.' },
      { code: 'EVIDENCE_PARTIAL', message: 'Research is partial.' }
    ]
  });
  const env = makeEnv(baseApi({ outreach: { gate: () => ok(gate) } }));
  await env.api.loadLeadDrawerPitch(LEAD);
  assert.strictEqual(env.box.byClass('f11-reason').length, 1, 'one blocker');
  assert.strictEqual(env.box.byClass('f11-warning').length, 2, 'two warnings, listed apart');
  assert.ok(/Warnings \(do not block outreach\)/.test(text(env)), 'labelled as non-blocking');
  for (const code of ['ICP_FIT_UNKNOWN', 'EVIDENCE_PARTIAL']) assert.ok(text(env).includes(code), 'shown: ' + code);
});

test('10. allowed renders the pass line and never claims anything was sent', async () => {
  const env = makeEnv(baseApi({ outreach: { gate: () => ok(makeGate({ decision: 'allowed', reasons: [] })) } }));
  await env.api.loadLeadDrawerPitch(LEAD);
  assert.ok(/All checks passed\. Sending is not automatic\./.test(text(env)), 'the exact pass line');
  assert.strictEqual(env.box.byClass('f11-reason').length, 0, 'no reasons');
  assert.ok(/Nothing is sent from this drawer\./.test(text(env)));
});

// --- 11. no send -------------------------------------------------------------

test('11. no send, email or test-send control exists anywhere in F11', async () => {
  const env = makeEnv(baseApi());
  await env.api.loadLeadDrawerPitch(LEAD);
  for (const label of buttons(env).map((b) => b.textContent)) {
    assert.ok(!/send|email|smtp|test send/i.test(label), 'no send control: ' + label);
  }
  assert.ok(!/send|email|smtp/i.test(pitchPanelHtml), 'no send control in the markup');
  assert.ok(!/email-send|\.email\./.test(preloadSource), 'no email API is exposed');
  assert.ok(!/lead-intel:email-send/.test(mainSource), 'no email channel is registered');
  assert.ok(!/outreach\.send|EMAIL_SEND/.test(f11Code), 'the F11 block never calls a send path');
});

// --- 12. alert role ----------------------------------------------------------

test('12. unsupported claims are exposed with role="alert"', async () => {
  const pitch = makePitch({ status: 'needs_revision', unsupportedClaims: [{ field: 'subject', text: 'We guarantee #1.', reason: 'PROHIBITED_CLAIM' }] });
  const env = makeEnv(baseApi({ pitch: { get: () => ok(pitch) } }));
  await env.api.loadLeadDrawerPitch(LEAD);
  const alerts = env.box.descendants().filter((n) => n.getAttribute('role') === 'alert');
  assert.ok(alerts.length >= 1, 'an alert exists');
  assert.ok(alerts.some((a) => a.textContent.includes('We guarantee #1.')), 'the claim text is in the alert');
  assert.ok(alerts.some((a) => a.textContent.includes('subject')), 'the field is named');
});

// --- 13/14. renderer safety --------------------------------------------------

test('13. only window.ztechLeadIntel is used, and only the five approved methods', () => {
  const used = [...f11Code.matchAll(/(?:window\.)?(ztechLeadIntel|appAPI|ipcRenderer)\b/g)].map((m) => m[1]);
  assert.ok(used.length > 0, 'the F11 block reaches the Lead Intelligence API');
  assert.deepStrictEqual([...new Set(used)], ['ztechLeadIntel'], 'only ztechLeadIntel is referenced');
  for (const banned of ['appAPI', 'ipcRenderer', 'fetch(', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'require(']) {
    assert.ok(!f11Code.includes(banned), 'F11 does not use ' + banned);
  }
  const calls = [...new Set([...f11Code.matchAll(/api\.(pitch|outreach)\.(\w+)/g)].map((m) => m[1] + '.' + m[2]))].sort();
  assert.deepStrictEqual(calls, ['outreach.approve', 'outreach.gate', 'pitch.generate', 'pitch.get', 'pitch.update']);
});

test('14. the F11 block builds no HTML strings', () => {
  for (const banned of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function']) {
    assert.ok(!f11Code.includes(banned), 'F11 does not use ' + banned);
  }
  assert.ok(/textContent/.test(f11Code), 'text is set as text');
});

test('14b. the F5 slice still performs no I/O and holds no pitch API', () => {
  assert.ok(!/appAPI|ipcRenderer|fetch\(|XMLHttpRequest|WebSocket/.test(f5Code), 'F5 still does no I/O');
  assert.ok(!/pitch\.(generate|get|update)|outreach\./.test(f5Code), 'F5 still calls no pitch API');
  assert.ok(!/ztechLeadIntel/.test(f5Code), 'F5 does not reach the Lead Intelligence API');
  assert.ok(/if \(typeof loadLeadDrawerPitch === 'function'\) loadLeadDrawerPitch\(lead\);/.test(f5Code), 'the hand-off is guarded');
});

// --- 15. async race ----------------------------------------------------------

test('15. a stale gate result for a previous lead is discarded', async () => {
  // Lead one gets as far as awaiting its gate, then the user steps to lead two.
  // The first gate must not be able to paint over the second lead.
  let releaseFirst;
  const firstGate = new Promise((r) => { releaseFirst = r; });
  let gateCalls = 0;
  const pitchA = makePitch({ lead_id: 'L1', observations: [{ text: 'MARKER-FOR-LEAD-ONE', refs: ['f1'], provenance: [] }] });
  const pitchB = makePitch({ lead_id: 'L2', observations: [{ text: 'MARKER-FOR-LEAD-TWO', refs: ['f2'], provenance: [] }] });
  const env = makeEnv({
    pitch: {
      get: (p) => ok(String(p.leadId) === 'L1' ? pitchA : pitchB),
      generate: () => ok(pitchA),
      update: () => ok(pitchA)
    },
    outreach: {
      gate: () => { gateCalls += 1; return gateCalls === 1 ? firstGate : ok(makeGate({ decision: 'allowed', reasons: [] })); },
      approve: () => ok(APPROVAL)
    }
  });
  const slow = env.api.loadLeadDrawerPitch({ id: 'L1', website: '' });
  await settle();
  await settle();
  assert.strictEqual(gateCalls, 1, 'the first lead is waiting on its gate');
  const fast = env.api.loadLeadDrawerPitch({ id: 'L2', website: '' });
  await fast;
  assert.ok(/MARKER-FOR-LEAD-TWO/.test(text(env)), 'the current lead is rendered');
  releaseFirst(ok(makeGate({ reasons: [{ code: 'HUMAN_APPROVAL', message: 'STALE-MARKER' }] })));
  await slow;
  assert.ok(/MARKER-FOR-LEAD-TWO/.test(text(env)), 'the current lead survives');
  assert.ok(!/MARKER-FOR-LEAD-ONE/.test(text(env)), 'the previous lead never overwrites it');
  assert.ok(!/STALE-MARKER/.test(text(env)), 'the stale gate result is discarded');
});

test('15b. a stale failure for a previous lead does not replace the current panel', async () => {
  let rejectFirst;
  const firstGate = new Promise((_, rej) => { rejectFirst = rej; });
  let gateCalls = 0;
  const pitchA = makePitch({ lead_id: 'L1', observations: [{ text: 'MARKER-FOR-LEAD-ONE', refs: ['f1'], provenance: [] }] });
  const pitchB = makePitch({ lead_id: 'L2', observations: [{ text: 'MARKER-FOR-LEAD-TWO', refs: ['f2'], provenance: [] }] });
  const env = makeEnv({
    pitch: {
      get: (p) => ok(String(p.leadId) === 'L1' ? pitchA : pitchB),
      generate: () => ok(pitchA),
      update: () => ok(pitchA)
    },
    outreach: {
      gate: () => { gateCalls += 1; return gateCalls === 1 ? firstGate : ok(makeGate({ decision: 'allowed', reasons: [] })); },
      approve: () => ok(APPROVAL)
    }
  });
  const slow = env.api.loadLeadDrawerPitch({ id: 'L1', website: '' }).catch(() => {});
  await settle();
  await settle();
  await env.api.loadLeadDrawerPitch({ id: 'L2', website: '' });
  assert.ok(/MARKER-FOR-LEAD-TWO/.test(text(env)), 'the current lead is rendered');
  rejectFirst(new Error('STALE-ERROR-MARKER'));
  await slow;
  assert.ok(/MARKER-FOR-LEAD-TWO/.test(text(env)), 'the current lead survives a stale failure');
  assert.ok(!/STALE-ERROR-MARKER/.test(text(env)), 'the stale error is not shown');
});

test('15c. a stale result is dropped even before the gate is requested', async () => {
  // Two loads in the same tick: the first must bail out without asking anything else.
  let gateCalls = 0;
  const env = makeEnv({
    pitch: {
      get: (p) => ok(makePitch({ lead_id: String(p.leadId), observations: [{ text: 'MARKER-' + p.leadId, refs: ['f1'], provenance: [] }] })),
      generate: () => ok(makePitch()),
      update: () => ok(makePitch())
    },
    outreach: { gate: () => { gateCalls += 1; return ok(makeGate()); }, approve: () => ok(APPROVAL) }
  });
  await Promise.all([
    env.api.loadLeadDrawerPitch({ id: 'L1', website: '' }),
    env.api.loadLeadDrawerPitch({ id: 'L2', website: '' })
  ]);
  assert.strictEqual(gateCalls, 1, 'only the newest load reaches the gate');
  assert.ok(/MARKER-L2/.test(text(env)), 'the newest lead is rendered');
  assert.ok(!/MARKER-L1/.test(text(env)), 'the superseded lead is not');
});

// --- 16/17. errors -----------------------------------------------------------

test('16. a structured validation error renders its errors[] inside role="alert"', async () => {
  const errors = [{ path: '$.subject', message: 'must have at most 150 characters' }];
  const env = makeEnv(baseApi({ pitch: { get: () => fail('VALIDATION_FAILED', 'lead-intel:pitch-get is invalid', errors) } }));
  await env.api.loadLeadDrawerPitch(LEAD);
  const alert = env.box.descendants().find((n) => n.getAttribute('role') === 'alert');
  assert.ok(alert, 'an alert is rendered');
  assert.ok(alert.textContent.includes('VALIDATION_FAILED'), 'the code is shown');
  assert.ok(alert.textContent.includes('$.subject'), 'the field path is shown');
  assert.ok(alert.textContent.includes('must have at most 150 characters'), 'the message is shown');
});

test('16b. FORBIDDEN and INTERNAL_ERROR render as an error state', async () => {
  for (const code of ['FORBIDDEN', 'INTERNAL_ERROR']) {
    const env = makeEnv(baseApi({ pitch: { get: () => fail(code, 'nope') } }));
    await env.api.loadLeadDrawerPitch(LEAD);
    assert.ok(text(env).includes(code), code + ' is reported');
    assert.ok(env.box.descendants().some((n) => n.getAttribute('role') === 'alert'), code + ' is an alert');
  }
});

test('17. NOT_FOUND shows an error state and does not crash the drawer', async () => {
  const env = makeEnv(baseApi({ pitch: { get: () => fail('NOT_FOUND', 'Pitch not found') } }));
  await env.api.loadLeadDrawerPitch(LEAD);
  assert.ok(/NOT_FOUND/.test(text(env)), 'the code is reported');
  assert.ok(/Pitch/.test(text(env)), 'the panel still renders its heading');
  const healthy = makeEnv(baseApi());
  await healthy.api.loadLeadDrawerPitch(LEAD);
  assert.ok(/Draft/.test(text(healthy)), 'a healthy lead still renders after an error');
});

// --- 18. approval derives from the gate --------------------------------------

test('18. approving re-reads the gate: approval is never shown on its own', async () => {
  const order = [];
  const env = makeEnv({
    pitch: { get: () => ok(makePitch()), generate: () => ok(makePitch()), update: () => ok(makePitch()) },
    outreach: {
      approve: () => { order.push('approve'); return ok(APPROVAL); },
      gate: () => { order.push('gate'); return ok(makeGate({ decision: 'allowed', reasons: [] })); }
    }
  });
  await env.api.loadLeadDrawerPitch(LEAD);
  order.length = 0;
  buttonByLabel(env, 'Approve pitch').fire('click');
  await settle();
  assert.deepStrictEqual(order, ['approve', 'gate'], 'the gate is read straight after approving');
  assert.ok(/All checks passed\. Sending is not automatic\./.test(text(env)), 'the gate result is the source of truth');
  assert.ok(!/local-user|signed in/i.test(text(env)), 'the operator is not presented as an account');
});

test('18b. an edit after approval re-blocks on HUMAN_APPROVAL from the backend', async () => {
  let pitch = makePitch();
  const env = makeEnv({
    pitch: {
      get: () => ok(pitch),
      generate: () => ok(pitch),
      update: (p) => { pitch = makePitch({ callToAction: p.callToAction, content_hash: 'hash2' }); return ok(pitch); }
    },
    outreach: {
      approve: () => ok(APPROVAL),
      gate: () => ok(pitch.content_hash === 'hash2'
        ? makeGate({ reasons: [{ code: 'HUMAN_APPROVAL', message: 'The pitch changed after it was approved; approve it again.' }] })
        : makeGate({ decision: 'allowed', reasons: [] }))
    }
  });
  await env.api.loadLeadDrawerPitch(LEAD);
  buttonByLabel(env, 'Approve pitch').fire('click');
  await settle();
  assert.ok(/All checks passed/.test(text(env)), 'approved and cleared');
  buttonByLabel(env, 'Save edits').fire('click');
  await settle();
  assert.ok(/changed after it was approved/.test(text(env)), 'the edit re-blocks, from the backend');
});

test('18c. there is no revoke control', async () => {
  const env = makeEnv(baseApi({ outreach: { gate: () => ok(makeGate({ decision: 'allowed', reasons: [] })) } }));
  await env.api.loadLeadDrawerPitch(LEAD);
  assert.strictEqual(buttonByLabel(env, 'Revoke'), undefined);
  assert.strictEqual(buttonByLabel(env, 'Revoke approval'), undefined);
  assert.ok(!/revoke/i.test(f11Code), 'the F11 block has no revocation path');
});

// --- 19. envelope and payload discipline -------------------------------------

test('19. the A10 envelope is unwrapped and never rendered to the user', async () => {
  const env = makeEnv(baseApi());
  await env.api.loadLeadDrawerPitch(LEAD);
  assert.ok(/Draft/.test(text(env)), 'data was unwrapped');
  assert.ok(!/"ok":true/.test(text(env)), 'the envelope is not shown');
});

test('19b. generate sends exactly the documented payload and only on request', async () => {
  const sent = [];
  const env = makeEnv(baseApi({ pitch: { get: () => ok(null), generate: (p) => { sent.push(p); return ok(makePitch()); } } }));
  await env.api.loadLeadDrawerPitch({ id: 'L9', website: '' });
  assert.deepStrictEqual(sent, [], 'nothing is generated just by opening the tab');
  buttonByLabel(env, 'Generate pitch').fire('click');
  await settle();
  assert.deepStrictEqual(sent, [{ leadId: 'L9' }], 'exactly the documented payload');
});

test('19c. the gate is requested with the documented channel and is never recomputed', async () => {
  const sent = [];
  const env = makeEnv(baseApi({ outreach: { gate: (p) => { sent.push(p); return ok(makeGate()); } } }));
  await env.api.loadLeadDrawerPitch(LEAD);
  assert.deepStrictEqual(sent, [{ pitchId: 'pitch_abc123', channel: 'email' }], 'the documented gate payload');
  assert.ok(!/evaluateOutreachGate/.test(f11Code), 'the renderer never re-implements the gate');
  assert.ok(/gate\.decision === 'allowed'/.test(f11Code), 'it only reads the decision the backend returned');
});

// --- 20/21/22. unchanged contracts and the design system --------------------

test('20. the drawer markup, CSP, channel set and dependencies are untouched by F11', () => {
  assert.strictEqual((htmlSource.match(/id="lead-panel-pitch"/g) || []).length, 1, 'one pitch panel');
  assert.strictEqual((htmlSource.match(/id="lead-drawer-pitch"/g) || []).length, 1, 'one pitch container');
  assert.ok(/aria-live="polite"/.test(pitchPanelHtml), 'the panel is a polite live region');
  assert.strictEqual((htmlSource.match(/ipcRenderer\.invoke\(/g) || []).length, 0, 'index.html still calls no IPC');
  const csp = htmlSource.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)">/);
  assert.strictEqual(csp[1], "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "connect-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'", 'CSP byte-identical');
  assert.ok(!/<script(?![^>]*src=)/i.test(pitchPanelHtml) && !/\son\w+="/.test(pitchPanelHtml), 'no inline script or handler');
  assert.strictEqual((mainSource.match(/ipcMain\.handle\('/g) || []).length, 34, 'still 34 main channels');
  assert.strictEqual(preloadSource.split('ipcRenderer.invoke').length - 1, 48, 'still 48 preload methods');
  assert.deepStrictEqual(Object.keys(pkg.dependencies).sort(),
    ['@modelcontextprotocol/client', 'ajv', 'ajv-formats', 'electron-store', 'sql.js'], 'no dependency added');
  // F12 declared lock update: the former "Ready" placeholder became the live, read-only
  // Outreach workspace, so it is no longer a placeholder. Campaigns and Activity must
  // still be untouched placeholders, and no campaign or activity view may exist.
  for (const nav of ['Campaigns', 'Activity']) {
    const re = new RegExp('nav-item nav-item-soon[^>]*>\\s*<svg[\\s\\S]*?<span class="nav-label">' + nav + '</span>', 'm');
    assert.ok(re.test(htmlSource), 'the Outreach placeholder is unchanged: ' + nav);
  }
  const outreachRe = new RegExp('<button class="nav-item" data-view="outreach"[^>]*>[\\s\\S]*?<span class="nav-label">Outreach</span>');
  assert.ok(outreachRe.test(htmlSource), 'the workspace is the live Outreach route');
  assert.ok(/aria-disabled="true"[^>]*>[\s\S]*?<span class="nav-label">Ready<\/span>/.test(htmlSource) === false,
    'Ready is no longer a disabled placeholder');
  // F15 declared update: the Activity view now exists, but it is F15's - the read-only
  // outreach history - and F11 still added none of it. What F11 must still own is that no
  // outreach/activity READ surface was smuggled into the pitch drawer block.
  assert.ok(!/view-activity/.test(F11), 'the F11 block still contains no activity view');
  assert.ok(!/id="view-campaigns?/.test(htmlSource), 'no campaign view was added');
  assert.ok(!/id="view-ready"/.test(htmlSource), 'no Outreach Ready view was added');
});

test('21. the F11 styles follow the Frontend 2.0 rules', () => {
  assert.ok(F11_CSS.length > 0, 'the F11 block is present');
  assert.ok(!/gradient/i.test(F11_CSS), 'no colour wash');
  for (const f of F11_CSS.match(/font-family:[^;]+/g) || []) {
    assert.ok(f.includes('inherit'), 'no new font: ' + f);
  }
  assert.ok(!/url\(|@import/.test(F11_CSS), 'no external asset');
  assert.ok(!/box-shadow:\s*0\s+8px|box-shadow:\s*0\s+4px\s+1[6-9]/.test(F11_CSS), 'no heavy shadow');
  assert.ok(!/border-radius:\s*(1[0-9]|[2-9][0-9])px/.test(F11_CSS), 'no pill-heavy radius');
  assert.ok(!/#[0-9a-f]{3,6}\b/i.test(F11_CSS), 'every colour comes from a token');
  assert.ok(/var\(--/.test(F11_CSS), 'tokens are used');
  assert.ok(/overflow-wrap:\s*anywhere/.test(F11_CSS), 'long untrusted text wraps');
  assert.ok(/@media \(max-width:/.test(F11_CSS), 'the narrow-width case is handled');
});

test('22. the F11 block sits outside every other test slice', () => {
  const slices = [
    ['// === P1-F Target Builder (user-owned definitions) ===', '// === B5 Lead Library Dashboard ==='],
    ['// === B5 Lead Library Dashboard ===', '// === F4: Collection workflow'],
    ['// === F4: Collection workflow', '// === ????????? ==='],
    ['// === ????????? ===', '// === F8 Intelligence workspace ==='],
    ['// === F8 Intelligence workspace ===', '// === F7 Research workspace ==='],
    ['// === F7 Research workspace ===', '// === F6 Lists: saved searches and segments ==='],
    ['// === F6 Lists: saved searches and segments ===', '// ???'],
    ['// === F5 Lead Detail Drawer ===', 'function splitImportLines(']
  ];
  for (const [start, end] of slices) {
    const from = rendererSource.indexOf(start);
    const to = rendererSource.indexOf(end, from + start.length);
    if (from === -1 || to === -1) continue;
    assert.ok(!(f11From > from && f11From < to), 'F11 is outside the slice ' + start);
  }
  assert.ok(f11From > rendererSource.lastIndexOf('// === F6 Lists: saved searches and segments ==='),
    'F11 is the last block in the file');
});

// --- run ---------------------------------------------------------------------

(async () => {
  let passed = 0;
  const failed = [];
  for (const t of tests) {
    try {
      await t.fn();
      passed += 1;
      console.log('ok - ' + t.name);
    } catch (err) {
      failed.push(t.name);
      console.log('FAIL - ' + t.name + ': ' + (err && err.message));
    }
  }
  if (failed.length) {
    console.log('');
    for (const name of failed) {
      const t = tests.find((x) => x.name === name);
      try { await t.fn(); } catch (err) { console.log(String((err && err.stack) || err)); }
    }
  }
  console.log(`${passed} passed, ${failed.length} failed`);
  process.exit(failed.length ? 1 : 0);
})();
