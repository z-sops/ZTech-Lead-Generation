'use strict';

// Frontend 2.0 F13 - human approval of ONE pitch, from the Outreach workspace.
//
// F13 adds no backend capability. `outreach.approve`, the `lead-intel:outreach-approve`
// channel, the `li_outreach_approvals` table and OutreachService.approve all already
// shipped, so these tests pin the RENDERER's use of that existing contract and nothing
// else. No jsdom, no new dependency, no network: the F11/F13/F12 blocks are lifted out of
// renderer.js and run against the workspace's own minimal DOM double.
//
// What is pinned:
//   1. no new capability: the preload surface, the channel set and the schema are untouched
//   2. Approve is offered ONLY when the backend's gate is blocked for HUMAN_APPROVAL
//   3. and only for a clean draft, because the service refuses any other status
//   4. an already-allowed pitch, a gate with other reasons, and an unreadable gate are
//      each refused with a specific honest reason instead of a doomed button
//   5. approving calls the shipped channel with exactly { pitchId } and nothing else
//   6. after approving, the page is RE-READ so the gate column shows the backend's new
//      verdict; the renderer never edits the verdict locally
//   7. a refusal surfaces the real error code and message, never a false success
//   8. there is no send, no bulk approve, no select-all, no queue, no campaign
//   9. F12's read-only pins and the empty/error states are unchanged

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
const pkg = require(path.join(root, 'package.json'));

const tests = [];
function test(name, fn) { tests.push([name, fn]); }
let passed = 0;
let failed = 0;
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// The three lifted blocks, in file order: F11 (helpers), F13 (this increment), F12 (the
// workspace the action lives in).
const F11_MARKER = '// === F11 Outreach: Lead Drawer Pitch tab ===';
const F13_MARKER = '// === F13 Outreach: human approval of one pitch ===';
const F12_MARKER = '// === F12 Outreach: the read-only Outreach workspace ===';
const f11From = rendererSource.indexOf(F11_MARKER);
const f13From = rendererSource.indexOf(F13_MARKER);
const f12From = rendererSource.indexOf(F12_MARKER);
assert.ok(f11From > -1 && f13From > f11From && f12From > f13From, 'F11, F13, F12 all exist in order');
const F11 = rendererSource.slice(f11From, f13From);
const F13 = rendererSource.slice(f13From, f12From);
const F12 = rendererSource.slice(f12From);
const F13_CODE = stripComments(F13);

// F13 adds no bootstrap of its own: the action is built per row by the F12 row builder,
// which already runs from the module's single `f12OutreachInit();`.
assert.ok(!/^f13\w+\(\);$/m.test(F13), 'the F13 block adds no module-scope bootstrap call');

// ============================================================ 1. no new capability

test('1. F13 adds no backend capability, channel, preload method or dependency', () => {
  assert.deepStrictEqual(Object.keys(pkg.dependencies).sort(),
    ['@modelcontextprotocol/client', 'ajv', 'ajv-formats', 'electron-store', 'sql.js'], 'no dependency added');
  // The approve method the renderer calls is the one that already shipped.
  assert.ok(/approve:\s*\(payload\)\s*=>\s*ipcRenderer\.invoke\('lead-intel:outreach-approve'/.test(preloadSource),
    'outreach.approve is the pre-existing preload method');
  assert.ok(!/f13/i.test(preloadSource), 'preload.js gained no F13 method');
  assert.ok(!/f13/i.test(ipcSource), 'no new IPC channel was registered');
  // The shipped schema still refuses anything but pitchId.
  assert.ok(/\[CHANNELS\.OUTREACH_APPROVE\]: obj\(\{ pitchId \}, \['pitchId'\]\)/.test(ipcSource),
    'the approve schema is still exactly { pitchId }');
  // The service still refuses a non-draft, and still writes the real approval row.
  assert.ok(/if \(p\.status !== 'draft'\)/.test(serviceSource), 'the service still refuses a non-draft pitch');
  assert.ok(/this\.store\.approvals\.insert\(rec\)/.test(serviceSource), 'the approval is still persisted by the store');
  // The gate still clears HUMAN_APPROVAL only for a matching content hash.
  assert.ok(/if \(!approval\) block\('HUMAN_APPROVAL'/.test(gateSource), 'the gate rule is unchanged');
  assert.ok(/approval\.content_hash !== hash/.test(gateSource), 'an approval of changed content still blocks');
});

// ============================================================ 2-4. when approval is offered

const ok = (data) => ({ ok: true, data });
const err = (code, message) => ({ ok: false, error: { code, message } });

function makePitch(o) {
  return Object.assign({
    pitch_id: 'pitch_1', lead_id: '5', packet_id: null, research_status: 'complete',
    target_id: null, icp_fit_status: null, subject: 'A few notes', opening: 'Hi,',
    observations: [], valueProposition: 'We fix it.', callToAction: 'Call?',
    evidenceReferences: [], unsupportedClaims: [], status: 'draft', content_hash: 'hash_1',
    created_at: '2026-09-01T10:00:00.000Z', updated_at: '2026-09-01T10:00:00.000Z'
  }, o);
}
function makeGate(o) {
  return Object.assign({
    decision: 'blocked', reasons: [], warnings: [], channel: 'email',
    pitch_id: 'pitch_1', packet_id: 'pkt_1', checkedAt: '2026-09-01T10:00:00.000Z'
  }, o);
}
const humanApproval = { code: 'HUMAN_APPROVAL', message: 'A person must approve this pitch before outreach.' };

/** Evaluate the real F11 + F13 + F12 blocks against a fake bridge. */
function loadWorkspace(api) {
  const doc = makeDoc();
  const opened = [];
  const sandbox = {
    document: doc, console, Promise, Date, JSON, Math, Object, Array, Number, String,
    Boolean, Error, Set, Map, RegExp, isNaN, parseInt, parseFloat
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.ztechLeadIntel = api;
  sandbox.openLeadDetail = (id) => { opened.push(String(id)); };
  const names = Object.keys(sandbox);
  const fn = new Function(...names, F11 + '\n' + F13 + '\n' + F12 + '\nreturn {'
    + 'f12OutreachLoad, f12OutreachState, f13ApprovalAvailability, F13_APPROVAL_REASON };');
  const loaded = fn.apply(null, names.map((n) => sandbox[n]));
  return Object.assign(loaded, { doc, opened });
}

function baseApi(overrides) {
  const outreach = {
    list: () => ok({ rows: [], total: 0, limit: 20, offset: 0, status: null }),
    gate: () => ok(makeGate({ decision: 'allowed' })),
    approve: () => ok({ approval_id: 'appr_1' })
  };
  return { outreach: Object.assign(outreach, overrides) };
}
const settle = () => new Promise((r) => setTimeout(r, 0));
const buttons = (ws) => ws.doc.getElementById('outreach-body').byTag('button');
const rowText = (ws) => ws.doc.getElementById('outreach-body').textContent;

test('2. Approve is offered only when the gate is blocked for HUMAN_APPROVAL', () => {
  const ws = loadWorkspace(baseApi());
  // Blocked for the approval reason -> offered.
  const yes = ws.f13ApprovalAvailability(makePitch({ status: 'draft' }), { ok: true, gate: makeGate({ reasons: [humanApproval] }) });
  assert.strictEqual(yes.canApprove, true, 'a draft waiting for a human approval may be approved');
  // Blocked for a different reason -> not offered: approving would not help.
  const other = ws.f13ApprovalAvailability(makePitch({ status: 'draft' }),
    { ok: true, gate: makeGate({ reasons: [{ code: 'QUALIFICATION', message: 'x' }] }) });
  assert.strictEqual(other.canApprove, false, 'another blocking reason is not an approval decision');
  assert.ok(/not waiting for an approval/.test(other.reason), 'and it says so honestly');
  // Blocked for both -> the approval reason is genuinely among them, so offer it.
  const both = ws.f13ApprovalAvailability(makePitch({ status: 'draft' }),
    { ok: true, gate: makeGate({ reasons: [{ code: 'QUALIFICATION', message: 'x' }, humanApproval] }) });
  assert.strictEqual(both.canApprove, true, 'HUMAN_APPROVAL among the reasons is enough to offer it');
});

test('3. only a clean draft is offered, because the service refuses anything else', () => {
  const ws = loadWorkspace(baseApi());
  for (const status of ['insufficient_evidence', 'needs_revision']) {
    const res = ws.f13ApprovalAvailability(makePitch({ status }), { ok: true, gate: makeGate({ reasons: [humanApproval] }) });
    assert.strictEqual(res.canApprove, false, status + ' must not be approvable');
    assert.ok(/clean draft/.test(res.reason), 'and the row says why: ' + res.reason);
  }
  // The offer comes from the row's own stored status, not from a guess.
  assert.strictEqual(ws.f13ApprovalAvailability(makePitch({ status: 'draft' }), { ok: true, gate: makeGate({ reasons: [humanApproval] }) }).canApprove, true,
    'a draft is offered');
});

test('4. an allowed pitch and an unreadable gate are both refused, with reasons', () => {
  const ws = loadWorkspace(baseApi());
  const allowed = ws.f13ApprovalAvailability(makePitch({ status: 'draft' }), { ok: true, gate: makeGate({ decision: 'allowed' }) });
  assert.strictEqual(allowed.canApprove, false, 'an allowed pitch has nothing to decide');
  assert.ok(/already cleared/.test(allowed.reason), 'and says so');
  const unreadable = ws.f13ApprovalAvailability(makePitch({ status: 'draft' }), { ok: false, error: { code: 'NOT_FOUND' } });
  assert.strictEqual(unreadable.canApprove, false, 'an unreadable gate decides nothing');
  assert.ok(/could not be read/.test(unreadable.reason), 'and is not silently treated as blocked');
  const missing = ws.f13ApprovalAvailability(makePitch({ status: 'draft' }), null);
  assert.strictEqual(missing.canApprove, false, 'no gate result decides nothing');
});

// ============================================================ 5-7. the click path

test('5. a populated row offers Approve, and clicking calls the shipped channel with only pitchId', async () => {
  const calls = [];
  const api = baseApi({
    list: () => ok({ rows: [makePitch({ pitch_id: 'p9' })], total: 1, limit: 20, offset: 0, status: null }),
    gate: () => ok(makeGate({ reasons: [humanApproval] })),
    approve: (payload) => { calls.push(payload); return ok({ approval_id: 'appr_1' }); }
  });
  const ws = loadWorkspace(api);
  await ws.f12OutreachLoad();
  await settle();
  const labels = buttons(ws).map((b) => b.textContent);
  assert.ok(labels.includes('Open lead'), 'the lead action is unchanged: ' + labels.join(','));
  assert.ok(labels.includes('Approve'), 'the approval action is offered: ' + labels.join(','));
  const approve = buttons(ws).find((b) => b.textContent === 'Approve');
  assert.strictEqual(approve.getAttribute('data-pitch-id'), 'p9', 'it names the pitch it acts on');
  assert.ok(/Nothing is sent/i.test(approve.title), 'the button says plainly that nothing is sent');
  approve.fire('click');
  await settle();
  assert.strictEqual(calls.length, 1, 'approve is called once');
  assert.deepStrictEqual(Object.keys(calls[0]), ['pitchId'], 'with exactly { pitchId } and nothing else');
  assert.strictEqual(calls[0].pitchId, 'p9', 'for the row it belongs to');
});

test('6. after approving, the page is re-read so the gate column shows the backend verdict', async () => {
  let lists = 0;
  let decision = 'blocked';
  const ws = loadWorkspace(baseApi({
    list: () => { lists++; return ok({ rows: [makePitch({})], total: 1, limit: 20, offset: 0, status: null }); },
    gate: () => ok(makeGate({
      decision,
      // Before the approval the gate waits for a human; afterwards it does not.
      reasons: decision === 'blocked' ? [humanApproval] : []
    })),
    approve: () => { decision = 'allowed'; return ok({ approval_id: 'appr_1' }); }
  }));
  await ws.f12OutreachLoad();
  await settle();
  assert.ok(/Blocked/.test(rowText(ws)), 'the gate starts blocked: ' + rowText(ws));
  const before = lists;
  buttons(ws).find((b) => b.textContent === 'Approve').fire('click');
  await settle();
  await settle();
  assert.ok(lists > before, 'the page is re-read from the store after an approval');
  assert.ok(/Cleared for outreach/.test(rowText(ws)), 'the NEW backend verdict is rendered: ' + rowText(ws));
  assert.ok(!/HUMAN_APPROVAL/.test(rowText(ws)), 'the cleared reason is gone because the backend cleared it');
  // And with the gate allowed, the action is no longer offered.
  assert.ok(!buttons(ws).some((b) => b.textContent === 'Approve'), 'nothing left to decide, so no Approve');
});

test('7. a refusal shows the real code and message, and never a false success', async () => {
  const ws = loadWorkspace(baseApi({
    list: () => ok({ rows: [makePitch({})], total: 1, limit: 20, offset: 0, status: null }),
    gate: () => ok(makeGate({ reasons: [humanApproval] })),
    approve: () => err('VALIDATION_FAILED', 'only a clean draft can be approved')
  }));
  await ws.f12OutreachLoad();
  await settle();
  buttons(ws).find((b) => b.textContent === 'Approve').fire('click');
  await settle();
  const notice = ws.doc.getElementById('outreach-notice');
  const text = notice.textContent;
  assert.ok(/VALIDATION_FAILED/.test(text), 'the real code is shown: ' + text);
  assert.ok(/only a clean draft can be approved/.test(text), 'the real message is shown');
  assert.strictEqual(notice.getAttribute('role'), 'alert', 'a refusal is an alert, not a success');
  assert.strictEqual(notice.getAttribute('data-state'), 'error', 'and it is not dressed up as a success');
  // The success wording is specific, so assert on that rather than on the word
  // "approved" - which the real refusal message ("only a clean draft can be approved")
  // legitimately contains.
  for (const phrase of ['Approval recorded', 'Saved', 'nothing is sent', 'The gate has been re-read']) {
    assert.ok(!new RegExp(phrase, 'i').test(text), 'no success wording after a refusal: ' + phrase);
  }
  // The button is usable again: the user can retry after fixing the row.
  const approve = buttons(ws).find((b) => b.textContent === 'Approve');
  assert.ok(approve && approve.disabled === false, 'the action stays available after a refusal');
});

// ============================================================ 8. what is NOT there

test('8. there is no send, no bulk approve, no queue, no campaign and no metrics', () => {
  const code = F13_CODE;
  for (const banned of [
    /email\s*\.\s*send\s*\(/, /outreach\.send\s*\(/, /lead-intel:email-send/,
    /smtp/i, /provider/i, /schedule/i, /queue/i, /batch/i,
    /selectAll|select-all/, /approveAll|approve all/i, /campaign/i
  ]) {
    assert.ok(!banned.test(code), 'the F13 block must not contain: ' + banned);
  }
  // No invented number is rendered: the only counts on screen are the store's own.
  for (const banned of [/\bmetric\b/i, /\bscore\b/i, /\bopenRate\b/i, /\breplyRate\b/i, /\bsentCount\b/i]) {
    assert.ok(!banned.test(code), 'the F13 block invents no: ' + banned);
  }
  // The approval record the backend returns is never drawn.
  assert.ok(!/approval_id|approved_by|approved_at/.test(F13), 'the approval record is not rendered');
  // The reason code it keys on is the gate's own, not a second invented vocabulary.
  assert.strictEqual(ws_reasonCode(), 'HUMAN_APPROVAL', 'the gate reason code is reused verbatim');
});
function ws_reasonCode() {
  const m = F13.match(/F13_APPROVAL_REASON = '([A-Z_]+)'/);
  return m ? m[1] : null;
}

// ============================================================ 9. F12 preserved

test('9. F12 behaviour, the notice markup and the read-only pins are intact', () => {
  // The notice element exists in the workspace, hidden until there is something to say.
  assert.ok(/<div class="outreach-notice" id="outreach-notice" hidden><\/div>/.test(htmlSource), 'the notice exists and starts hidden');
  // F12's own block still reaches only list and gate: the approve call lives in F13.
  const used = [...stripComments(F12).matchAll(/api\.(\w+)\.(\w+)\(/g)].map((m) => m[1] + '.' + m[2]);
  assert.deepStrictEqual([...new Set(used)].sort(), ['outreach.gate', 'outreach.list'],
    'the F12 block still reaches only outreach.list and outreach.gate');
  assert.ok(!/outreach\.approve\s*\(/.test(F12), 'F12 still contains no approval call');
  // F13 offers the action; it does not add a second data source.
  const f13used = [...F13_CODE.matchAll(/api\.(\w+)\.(\w+)\(/g)].map((m) => m[1] + '.' + m[2]);
  assert.deepStrictEqual([...new Set(f13used)].sort(), ['outreach.approve'], 'F13 reaches only the one shipped method');
  // No new network, storage or framework surface in the renderer.
  for (const banned of [/\bfetch\s*\(/, /XMLHttpRequest/, /\bWebSocket\b/, /EventSource/, /innerHTML/, /document\.write/, /require\s*\(/, /ipcRenderer/]) {
    assert.ok(!banned.test(F13_CODE), 'the F13 block must not use: ' + banned);
  }
  // The row keeps the F12 empty and error states intact.
  assert.ok(/f12OutreachEmptyRow/.test(F12), 'the honest empty row still exists');
  assert.ok(/f12OutreachErrorBox/.test(F12), 'the honest error box still exists');
});

// Minimal DOM double, the same shape the F12 suite uses, extended with the notice node.
function makeDoc() {
  const listeners = new WeakMap();
  const make = (tag) => {
    const el = {      tagName: String(tag).toUpperCase(), className: '', children: [], hidden: false, disabled: false,
      attrs: {}, _text: '',
      get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); },
      set textContent(v) { this._text = String(v); this.children = []; },
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
      appendChild(c) { this.children.push(c); return c; },
      replaceChildren(...c) { this.children = c; this._text = ''; },
      addEventListener(type, fn) { listeners.set(this, (listeners.get(this) || []).concat([{ type, fn }])); },
      fire(type) { for (const l of (listeners.get(this) || [])) if (l.type === type) l.fn({ type }); },
      // Descendant search, like querySelectorAll: a button lives inside a td inside a tr.
      byTag(tag) {
        const want = String(tag).toUpperCase();
        const out = [];
        const walk = (n) => { for (const c of n.children) { if (c.tagName === want) out.push(c); walk(c); } };
        walk(this);
        return out;
      },
      byClass(cls) {
        const out = [];
        const walk = (n) => { for (const c of n.children) { if (String(c.className).split(/\s+/).includes(cls)) out.push(c); walk(c); } };
        walk(this);
        return out;
      },
      // classList, because the real row builder marks a value-less cell as muted.
      classList: {
        add(...names) {
          const set = new Set(String(this.owner.className).split(/\s+/).filter(Boolean));
          for (const n of names) set.add(n);
          this.owner.className = [...set].join(' ');
        },
        remove(...names) {
          const set = new Set(String(this.owner.className).split(/\s+/).filter(Boolean));
          for (const n of names) set.delete(n);
          this.owner.className = [...set].join(' ');
        },
        contains(name) { return String(this.owner.className).split(/\s+/).includes(name); }
      },
      get value() { return this._value === undefined ? '' : this._value; },
      set value(v) { this._value = String(v); },
      get options() { return this._options || []; }
    };
    el.classList.owner = el;
    return el;
  };
  const nodes = new Map();
  const ids = ['outreach-body', 'outreach-range', 'outreach-prev', 'outreach-next', 'outreach-refresh',
    'outreach-status-filter', 'outreach-gate-filter', 'outreach-notice'];
  for (const id of ids) nodes.set(id, make('div'));
  nodes.get('outreach-next').disabled = false;
  nodes.get('outreach-prev').disabled = false;
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
