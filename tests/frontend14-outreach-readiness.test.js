'use strict';

// Frontend 2.0 F14 - outreach readiness of an approved pitch.
//
// READINESS IS DERIVED, NOT STORED. There is no readiness table, column, status value or
// persisted flag. Every state below is computed from what the backend already returns:
// the OutreachGate verdict and the delivery capability OutreachService reports next to
// it. These tests pin that claim against the real source, and execute the F11 + F13 +
// F14 + F12 blocks against the workspace's own DOM double.
//
// What is pinned:
//   1. approved + matching content hash -> READY_FOR_OUTREACH
//   2. approved but the content changed -> NOT ready (the gate says so, not us)
//   3. HUMAN_APPROVAL outstanding -> NOT ready
//   4. insufficient_evidence -> NOT ready
//   5. needs_revision -> NOT ready
//   6. an unreadable gate -> unknown, never blocked and never allowed
//   7. F13 approval behaviour is untouched
//   8. no sent/delivered state, no provider, no send path, no new persistence
//   9. F12's read-only protections are intact
//  10. delivery capability comes from the backend, never guessed in the renderer

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const htmlSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const rendererSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'renderer.js'), 'utf8');
const cssSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'styles.css'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const serviceSource = fs.readFileSync(path.join(root, 'src', 'main', 'lead-intelligence', 'outreach', 'OutreachService.js'), 'utf8');
const gateSource = fs.readFileSync(path.join(root, 'src', 'main', 'lead-intelligence', 'outreach', 'OutreachGate.js'), 'utf8');
const contractSource = fs.readFileSync(path.join(root, 'src', 'main', 'lead-intelligence', 'persistence', 'contract.js'), 'utf8');
const migrationsSource = fs.readFileSync(path.join(root, 'src', 'main', 'lead-intelligence', 'persistence', 'migrations.js'), 'utf8');
const pkg = require(path.join(root, 'package.json'));

const tests = [];
function test(name, fn) { tests.push([name, fn]); }
let passed = 0;
let failed = 0;
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const F11_MARKER = '// === F11 Outreach: Lead Drawer Pitch tab ===';
const F13_MARKER = '// === F13 Outreach: human approval of one pitch ===';
const F14_MARKER = '// === F14 Outreach: readiness of an approved pitch ===';
const F12_MARKER = '// === F12 Outreach: the read-only Outreach workspace ===';
const f11From = rendererSource.indexOf(F11_MARKER);
const f13From = rendererSource.indexOf(F13_MARKER);
const f14From = rendererSource.indexOf(F14_MARKER);
const f12From = rendererSource.indexOf(F12_MARKER);
assert.ok(f11From > -1 && f13From > f11From && f14From > f13From && f12From > f14From,
  'F11, F13, F14, F12 all exist in order');
const F11 = rendererSource.slice(f11From, f13From);
const F13 = rendererSource.slice(f13From, f14From);
const F14 = rendererSource.slice(f14From, f12From);
const F12 = rendererSource.slice(f12From);
const F14_CODE = stripComments(F14);

// Readiness is a view, so it must not have added a bootstrap of its own or a timer.
assert.ok(!/^f14\w+\(\);$/m.test(F14), 'the F14 block adds no module-scope bootstrap call');
assert.ok(!/setInterval|setTimeout/.test(F14), 'the F14 block has no timer or polling');

const ok = (data) => ({ ok: true, data });
const fail = (code, message) => ({ ok: false, error: { code, message } });

function makePitch(o) {
  return Object.assign({
    pitch_id: 'pitch_1', lead_id: '5', packet_id: 'pkt_1', research_status: 'complete',
    target_id: null, icp_fit_status: null, subject: 'A few notes', opening: 'Hi,',
    observations: [], valueProposition: 'We fix it.', callToAction: 'Call?',
    evidenceReferences: [], unsupportedClaims: [], status: 'draft', content_hash: 'hash_1',
    created_at: '2026-09-01T10:00:00.000Z', updated_at: '2026-09-01T10:00:00.000Z'
  }, o);
}
function makeGate(o) {
  return Object.assign({
    decision: 'blocked', reasons: [], warnings: [], channel: 'email',
    pitch_id: 'pitch_1', packet_id: 'pkt_1', checkedAt: '2026-09-01T10:00:00.000Z',
    // What the backend really reports: email is abstract, no provider exists.
    delivery: { channel: 'email', emailEnabled: false, providerConfigured: false }
  }, o);
}
const HUMAN_APPROVAL = { code: 'HUMAN_APPROVAL', message: 'A person must approve this pitch before outreach.' };
const STALE_APPROVAL = { code: 'HUMAN_APPROVAL', message: 'The pitch changed after it was approved; approve it again.' };

/** Evaluate the real F11 + F13 + F14 + F12 blocks against a fake bridge. */
function loadWorkspace(api) {
  const doc = makeDoc();
  const sandbox = {
    document: doc, console, Promise, Date, JSON, Math, Object, Array, Number, String,
    Boolean, Error, Set, Map, RegExp, isNaN, parseInt, parseFloat
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.ztechLeadIntel = api;
  sandbox.openLeadDetail = () => {};
  const names = Object.keys(sandbox);
  const fn = new Function(...names, F11 + '\n' + F13 + '\n' + F14 + '\n' + F12 + '\nreturn {'
    + 'f12OutreachLoad, f12OutreachState, f14Readiness, f14DeliveryNote, F14_READINESS };');
  const loaded = fn.apply(null, names.map((n) => sandbox[n]));
  return Object.assign(loaded, { doc });
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
const cellsOf = (ws) => {
  const tbody = ws.doc.getElementById('outreach-body');
  const trs = tbody.byTag('tr');
  return trs.length ? trs[0].children : [];
};

// ============================================================ 1-2. approved + hash

test('1. an approved pitch whose hash matches the gate is READY', async () => {
  const ws = loadWorkspace(baseApi({
    list: () => ok({ rows: [makePitch({})], total: 1, limit: 20, offset: 0, status: null }),
    // The gate allowed it, which is only possible when an approval exists for the
    // CURRENT content hash. That is the backend's statement, not ours.
    gate: () => ok(makeGate({ decision: 'allowed', reasons: [] }))
  }));
  await ws.f12OutreachLoad();
  await settle();
  const cell = cellsOf(ws)[3];
  const text = cell.textContent;
  assert.ok(/Ready for outreach/.test(text), 'the row states it is ready: ' + text);
  const badge = cell.byTag('span')[0];
  assert.strictEqual(badge.getAttribute('data-readiness'), 'ready', 'and the badge says ready');
  assert.ok(/delivery provider not configured/.test(text),
    'and it says plainly that no delivery provider exists: ' + text);
  // It must never read as delivered.
  for (const banned of [/sent/i, /delivered/i, /contacted/i, /replied/i, /email sent/i]) {
    assert.ok(!banned.test(text), 'readiness must never imply delivery: ' + banned);
  }
  assert.strictEqual(ws.f14Readiness({ ok: true, gate: makeGate({ decision: 'allowed' }) }).state, 'ready',
    'the derived state is ready');
});

test('2. an approval whose content hash no longer matches is NOT ready', async () => {
  // This is exactly what OutreachGate returns after the pitch changes: it keeps blocking
  // HUMAN_APPROVAL with a different message. F14 must not re-check any hash itself.
  const ws = loadWorkspace(baseApi({
    list: () => ok({ rows: [makePitch({})], total: 1, limit: 20, offset: 0, status: null }),
    gate: () => ok(makeGate({ reasons: [STALE_APPROVAL] }))
  }));
  await ws.f12OutreachLoad();
  await settle();
  const cell = cellsOf(ws)[3];
  const text = cell.textContent;
  assert.ok(/Not ready/.test(text), 'a stale approval is not ready: ' + text);
  assert.ok(/HUMAN_APPROVAL/.test(text), 'and the reason is the backend\'s own code: ' + text);
  assert.ok(!/Ready for outreach/.test(text), 'it never claims readiness');
  assert.strictEqual(ws.f14Readiness({ ok: true, gate: makeGate({ reasons: [STALE_APPROVAL] }) }).state, 'blocked',
    'the derived state is blocked');
});

// ============================================================ 3-6. not ready cases

test('3. HUMAN_APPROVAL outstanding is not ready', async () => {
  const ws = loadWorkspace(baseApi({
    list: () => ok({ rows: [makePitch({})], total: 1, limit: 20, offset: 0, status: null }),
    gate: () => ok(makeGate({ reasons: [HUMAN_APPROVAL] }))
  }));
  await ws.f12OutreachLoad();
  await settle();
  const text = cellsOf(ws)[3].textContent;
  assert.ok(/Not ready/.test(text) && /HUMAN_APPROVAL/.test(text), 'blocked on approval: ' + text);
  assert.ok(!/Ready for outreach/.test(text), 'never claims readiness');
});

test('4. insufficient_evidence is not ready', async () => {
  const ws = loadWorkspace(baseApi({
    list: () => ok({ rows: [makePitch({ status: 'insufficient_evidence' })], total: 1, limit: 20, offset: 0, status: null }),
    gate: () => ok(makeGate({ reasons: [{ code: 'EVIDENCE_COMPLETE', message: 'Research is partial.' }] }))
  }));
  await ws.f12OutreachLoad();
  await settle();
  const text = cellsOf(ws)[3].textContent;
  assert.ok(/Not ready/.test(text), 'insufficient_evidence is not ready: ' + text);
  assert.ok(/EVIDENCE_COMPLETE/.test(text), 'with the backend reason: ' + text);
  // The stored status is still shown as itself, not as a new readiness value.
  assert.strictEqual(cellsOf(ws)[1].textContent.trim(), 'Insufficient evidence',
    'the pitch status is unchanged and still one of the three real statuses');
});

test('5. needs_revision is not ready', async () => {
  const ws = loadWorkspace(baseApi({
    list: () => ok({ rows: [makePitch({ status: 'needs_revision' })], total: 1, limit: 20, offset: 0, status: null }),
    gate: () => ok(makeGate({ reasons: [{ code: 'PROHIBITED_CLAIMS', message: 'Unsupported claims.' }] }))
  }));
  await ws.f12OutreachLoad();
  await settle();
  assert.ok(/Not ready/.test(cellsOf(ws)[3].textContent), 'needs_revision is not ready');
  assert.strictEqual(cellsOf(ws)[1].textContent.trim(), 'Needs revision', 'the stored status is unchanged');
});

test('6. an unreadable gate is unknown - never blocked, never allowed', async () => {
  const ws = loadWorkspace(baseApi({
    list: () => ok({ rows: [makePitch({})], total: 1, limit: 20, offset: 0, status: null }),
    gate: () => fail('NOT_FOUND', 'Lead not found')
  }));
  await ws.f12OutreachLoad();
  await settle();
  const text = cellsOf(ws)[3].textContent;
  assert.ok(/Readiness unknown/.test(text), 'an unreadable gate is unknown: ' + text);
  assert.ok(!/Not ready/.test(text), 'it is not reported as blocked');
  assert.ok(!/Ready for outreach/.test(text), 'and not as ready');
  const state = ws.f14Readiness({ ok: false, error: { code: 'NOT_FOUND' } }).state;
  assert.strictEqual(state, 'unknown', 'the derived state is unknown');
  assert.strictEqual(ws.f14Readiness(null).state, 'unknown', 'a missing gate result is unknown too');
});

// ============================================================ 7-8. no new surface

test('7. no sent or delivered status exists, and none is invented', () => {
  // The store's status vocabulary is untouched: still exactly three values.
  const statuses = (contractSource.match(/PITCH_STATUSES = Object\.freeze\(\[([^\]]*)\]/s) || [])[1] || '';
  const values = statuses.split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  assert.deepStrictEqual(values, ['draft', 'insufficient_evidence', 'needs_revision'],
    'the persisted pitch statuses are unchanged - no ready, sent or delivered value');
  // No readiness table, column or migration.
  for (const banned of [/readiness/i, /\bready\b/i, /outreach_ready/i]) {
    assert.ok(!banned.test(migrationsSource), 'no readiness state was migrated: ' + banned);
  }
  assert.ok(!/readiness/i.test(contractSource), 'the persistence contract gained no readiness concept');
  // Readiness is a renderer view over the gate, so it must not hash anything itself.
  assert.ok(!/contentHash|content_hash|stableHash/.test(F14_CODE), 'F14 re-checks no hash; the gate did it');
  assert.ok(!/\bfetch\s*\(|XMLHttpRequest|\bWebSocket\b|EventSource|innerHTML|document\.write|require\s*\(|ipcRenderer/.test(F14_CODE),
    'no network, storage or framework surface in the readiness block');
});

test('8. no provider is introduced and no send path is reachable', () => {
  assert.deepStrictEqual(Object.keys(pkg.dependencies).sort(),
    ['@modelcontextprotocol/client', 'ajv', 'ajv-formats', 'electron-store', 'sql.js'], 'no dependency added');
  // The renderer reaches no method beyond the three that already existed.
  const f14used = [...F14_CODE.matchAll(/api\.(\w+)\.(\w+)\(/g)].map((m) => m[1] + '.' + m[2]);
  assert.deepStrictEqual(f14used, [], 'the readiness block calls no API at all - it reads what F12 loaded');
  // The service still refuses to send, and F14 only REPORTS its configuration.
  assert.ok(/if \(!this\.email\.enabled \|\| !this\.emailProvider\) throw new LiError\('EMAIL_DISABLED'/.test(serviceSource),
    'send() is still refused when email is disabled or no provider exists');
  assert.ok(!/new .*Provider|smtp|nodemailer|sendgrid/i.test(F14_CODE + serviceSource.replace(/^\s*\/\/.*$/gm, '')),
    'no provider is constructed anywhere');
  // No channel was added for readiness: it rides the existing gate result.
  assert.ok(!/readiness/i.test(preloadSource), 'preload exposes no readiness method');
  assert.ok(/delivery: \{[\s\S]*?providerConfigured: this\.emailProvider !== null/.test(serviceSource),
    'the backend reports its existing delivery configuration rather than inventing one');
  assert.ok(/emailEnabled: this\.email\.enabled === true/.test(serviceSource),
    'and reports whether email is enabled, from the config it was constructed with');
  // The gate verdict itself is returned unchanged; only `delivery` was added.
  assert.ok(/const gate = evaluateOutreachGate\(\{[\s\S]*?\n    \}\);\n    \/\/ F14/.test(serviceSource),
    'the F14 change wraps the existing gate result rather than altering the evaluation');
});

// ============================================================ 9-10. F12/F13 preserved

test('9. F12 read-only protections and the F13 approval action are untouched', async () => {
  // F12 still reaches only list and gate.
  const f12used = [...stripComments(F12).matchAll(/api\.(\w+)\.(\w+)\(/g)].map((m) => m[1] + '.' + m[2]);
  assert.deepStrictEqual([...new Set(f12used)].sort(), ['outreach.gate', 'outreach.list'],
    'the F12 block still reaches only outreach.list and outreach.gate');
  assert.ok(!/outreach\.approve\s*\(|outreach\.send\s*\(|email\.send\s*\(/.test(F12),
    'F12 still contains no approval and no send call');
  // F13 still offers Approve only for a clean draft blocked by HUMAN_APPROVAL, with the
  // exact payload, and readiness did not change that.
  const calls = [];
  const ws = loadWorkspace(baseApi({
    list: () => ok({ rows: [makePitch({ pitch_id: 'p7' })], total: 1, limit: 20, offset: 0, status: null }),
    gate: () => ok(makeGate({ reasons: [HUMAN_APPROVAL] })),
    approve: (payload) => { calls.push(payload); return ok({ approval_id: 'appr_1' }); }
  }));
  await ws.f12OutreachLoad();
  await settle();
  const all = ws.doc.getElementById('outreach-body').byTag('button');
  const approve = all.find((b) => b.textContent === 'Approve');
  assert.ok(approve, 'the F13 approval action is still offered for a blocked clean draft');
  approve.fire('click');
  await settle();
  assert.deepStrictEqual(Object.keys(calls[0]), ['pitchId'], 'F13 still sends exactly { pitchId }');
  // A non-draft is still not approvable.
  const ws2 = loadWorkspace(baseApi({
    list: () => ok({ rows: [makePitch({ status: 'needs_revision' })], total: 1, limit: 20, offset: 0, status: null }),
    gate: () => ok(makeGate({ reasons: [HUMAN_APPROVAL] }))
  }));
  await ws2.f12OutreachLoad();
  await settle();
  assert.ok(!ws2.doc.getElementById('outreach-body').byTag('button').some((b) => b.textContent === 'Approve'),
    'a non-draft still has no Approve action');
});

test('10. the readiness column, its markup and its design language', () => {
  assert.ok(/<th class="col-readiness">Readiness<\/th>/.test(htmlSource), 'the header declares the column');
  assert.ok(/class="outreach-notice" id="outreach-notice"/.test(htmlSource), 'the F13 notice is still there');
  // The column is part of the one real table, not a second data source.
  assert.ok(/<table class="data-table outreach-table">/.test(htmlSource), 'the existing data-table is reused');
  // CSS: only existing tokens, and no literal colour or new shadow language.
  const f14Css = cssSource.slice(cssSource.indexOf('F14: one more column') >= 0
    ? cssSource.indexOf('ZTech Frontend 2.0 - F13') : 0);
  assert.ok(/\.outreach-table \.col-readiness\s*\{[^}]*width:/.test(f14Css), 'the column has a width');
  assert.ok(!/#[0-9a-f]{3,6}/i.test(f14Css), 'no literal colour introduced');
  assert.ok(!/box-shadow|linear-gradient/.test(f14Css), 'no new shadow or gradient language');
  // The badge reuses the F11 status badge rather than inventing one.
  assert.ok(/f11Status\(readiness\.label/.test(F12), 'the F11 status badge is reused for readiness');
  // The gate decision itself is still rendered by F12 unchanged.
  assert.ok(/gate\.decision === 'allowed'/.test(F12), 'F12 still renders the backend gate decision');
});

// Minimal DOM double, extended with the readiness column.
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
      byClass(cls) {
        const out = [];
        const walk = (n) => { for (const c of n.children) { if (String(c.className).split(/\s+/).includes(cls)) out.push(c); walk(c); } };
        walk(this);
        return out;
      },
      classList: {
        add(...names) { const s = new Set(String(this.owner.className).split(/\s+/).filter(Boolean)); for (const n of names) s.add(n); this.owner.className = [...s].join(' '); },
        remove(...names) { const s = new Set(String(this.owner.className).split(/\s+/).filter(Boolean)); for (const n of names) s.delete(n); this.owner.className = [...s].join(' '); },
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
  for (const id of ['outreach-body', 'outreach-range', 'outreach-prev', 'outreach-next', 'outreach-refresh',
    'outreach-status-filter', 'outreach-gate-filter', 'outreach-notice']) nodes.set(id, make('div'));
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
