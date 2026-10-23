'use strict';

// I7 - the review-only "Opportunity context" section in the Pitch tab.
//
// The real I7 renderer block runs against a DOM double. Its bridge is wired to the REAL
// opportunity IPC handlers over the REAL OpportunityIntelligenceService, bridge and
// PitchGenerator, with a fake OI report service. Nothing touches the network.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const OP = path.join(root, 'src', 'main', 'lead-intelligence', 'opportunity');
const rendererSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'renderer.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const { OpportunityIntelligenceService } = require(path.join(OP, 'OpportunityIntelligenceService'));
const { CHANNELS, registerOpportunityIpc } = require(path.join(OP, 'opportunity-ipc'));
const fixtures = require(path.join(__dirname, 'lead-intelligence', 'opportunity-fixtures'));

let passed = 0;
const failures = [];
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from !== -1 && to !== -1, 'markers found: ' + start);
  return source.slice(from, to);
}
function functionSource(source, marker) {
  const from = source.indexOf(marker);
  assert.ok(from !== -1, 'function found: ' + marker);
  return source.slice(from, source.indexOf('\n}', from) + 2);
}
const block = between(rendererSource, '// === I7 OI pitch context ===', '// === I6 Lead timeline ===');
const code = block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const helpers = [
  between(rendererSource, 'const LEAD_DRAWER_NA', '\n') + '\n',
  functionSource(rendererSource, 'function leadDrawerText('),
  functionSource(rendererSource, 'function leadDrawerFormatTime('),
].join('\n');

class FakeEl {
  constructor(tag, id) { this.tagName = String(tag).toUpperCase(); this.id = id || ''; this.children = []; this.attributes = {}; this.listeners = {}; this.className = ''; this.disabled = false; this.type = ''; this._text = ''; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  set innerHTML(v) { throw new Error('innerHTML must not be used'); }
  appendChild(c) { this.children.push(c); return c; }
  replaceChildren(...cs) { this.children = []; this._text = ''; cs.forEach((c) => this.appendChild(c)); }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  click() { for (const fn of this.listeners.click || []) fn({}); }
  all() { return this.children.flatMap((c) => [c, ...c.all()]); }
}

const BASE = 'http://127.0.0.1:8099';
const LEAD = 'L1';
const T0 = Date.parse('2026-10-05T12:00:00.000Z');
const DAY = 86400000;
const resp = (status, body) => ({ ok: status < 400, status, headers: { get: () => null }, text: async () => JSON.stringify(body) });

function mainSide({ nowDays = 2, reports = [fixtures.report()], missing = [] } = {}) {
  const served = new Map(reports.map((r) => [r.research_id, r]));
  for (const id of missing) served.delete(id);
  const svc = new OpportunityIntelligenceService({
    config: { enabled: true, baseUrl: BASE },
    clock: () => new Date(T0 + nowDays * DAY),
    logger: { warn() {}, error() {}, info() {} },
    fetchImpl: async (url) => {
      const m = url.match(/\/v1\/reports\/([^/?]+)/);
      if (m) return served.has(m[1]) ? resp(200, served.get(m[1])) : resp(404, { error: 'NOT_FOUND', message: 'gone', retryable: false });
      return resp(200, { status: 'ok', schema_version: '1.0', instance_id: null });
    },
  });
  for (const r of reports) svc.associations.assertLeadAssociation({ leadId: LEAD, report: r });
  const handlers = {};
  registerOpportunityIpc({
    ipcMain: { handle: (c, f) => { handlers[c] = f; } }, opportunity: svc, isTrustedSender: () => true,
    leadSource: { get: async (id) => ({ id, company_name: 'Acme Bakery', domain: 'acme.example' }) },
    offer: () => ({ sender_name: 'Dana', sender_company: 'Ridgeline' }), logger: { warn() {} },
  });
  const sent = [];
  const inv = (ch) => (p) => { sent.push({ ch, p }); return handlers[ch]({}, p || {}); };
  return { api: { pitchContext: inv(CHANNELS.PITCH_CONTEXT), pitchPreview: inv(CHANNELS.PITCH_PREVIEW) }, sent };
}

function makeUi(api) {
  const reg = new Map();
  const document = { getElementById(id) { if (!reg.has(id)) reg.set(id, new FakeEl('div', id)); return reg.get(id); }, createElement(tag) { return new FakeEl(tag); } };
  const ui = new Function('document', 'window',
    `let leadDrawerLeadId = ${JSON.stringify(LEAD)};\n${helpers}\n${block}\n`
    + 'return { reset: resetPitchOiContext, toggle: togglePitchOiContext, preview: previewPitchOiContext, load: loadPitchOiContext, get state() { return pitchOiContext; } };')(
    document, { ztechLeadIntel: api ? { opportunity: api } : {} });
  const box = document.getElementById('lead-drawer-oi-context');
  return { ui, box, text: () => box.textContent, btn: (a) => box.all().find((n) => n.getAttribute('data-action') === a) || null, all: () => box.all() };
}
const flush = async () => { for (let i = 0; i < 6; i += 1) await new Promise((r) => setImmediate(r)); };

test('11a. markup + code rules: own section, textContent only, no score words, no timers, only the two OI calls', () => {
  assert.ok(htmlSource.includes('id="lead-drawer-oi-context"'));
  const pitchPanel = htmlSource.slice(htmlSource.indexOf('id="lead-panel-pitch"'), htmlSource.indexOf('<!-- P1-F Target Builder'));
  assert.ok(!/send|email|smtp/i.test(pitchPanel), 'the Pitch panel markup still names no delivery control');
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(code));
  assert.ok(!/\d+\s*%|\bscore\b|\bgrade\b|\brank/i.test(code));
  assert.ok(!/setInterval|setTimeout/.test(code));
  const calls = [...code.matchAll(/api\.(\w+)\(/g)].map((m) => m[1]).sort();
  assert.deepStrictEqual([...new Set(calls)], ['pitchContext', 'pitchPreview']);
  assert.ok(!/outreach\.|outreachSend|\.approve\(|pitch\.(generate|update|get)\(/.test(code), 'no pitch/outreach write from this block');
});

test('11b. collapsed by default; nothing is read until the person expands it', async () => {
  const m = mainSide();
  const u = makeUi(m.api);
  u.ui.reset();
  assert.equal(u.btn('oi-ctx-toggle').getAttribute('aria-expanded'), 'false');
  assert.equal(m.sent.length, 0);
  u.btn('oi-ctx-toggle').click();
  await flush();
  assert.equal(m.sent.length, 1);
  assert.deepStrictEqual(m.sent[0].p, { leadId: LEAD });
});

test('11c. expanded: Fact/Estimate items with source and evidence ids, freshness chip, counts', async () => {
  const m = mainSide();
  const u = makeUi(m.api);
  u.ui.reset();
  u.btn('oi-ctx-toggle').click();
  await flush();
  const t = u.text();
  assert.ok(t.includes('review only'));
  assert.ok(t.includes('Fresh'));
  assert.ok(/Source: res_\d+_[a-f0-9]+/.test(t));
  assert.ok(t.includes('Evidence: '));
  const kinds = u.all().filter((n) => n.className === 'pitch-oi-chip' && n.getAttribute('data-kind')).map((n) => n.textContent);
  assert.ok(kinds.length > 0 && kinds.every((k) => k === 'Fact' || k === 'Estimate'), kinds.join('|'));
  assert.ok(/usable item\(s\)/.test(t) && /inference\(s\) left out/.test(t));
  assert.equal(u.btn('oi-ctx-preview').disabled, false);
});

test('11d. preview: read-only box that says it is not saved, not approved and cannot be sent; Close only', async () => {
  const m = mainSide();
  const u = makeUi(m.api);
  u.ui.reset();
  u.btn('oi-ctx-toggle').click();
  await flush();
  u.btn('oi-ctx-preview').click();
  await flush();
  assert.ok(u.text().includes('Preview - not saved, not approved, cannot be sent.'));
  assert.ok(u.text().includes('Dana'), 'the sender comes from main');
  const actions = u.all().filter((n) => n.tagName === 'BUTTON').map((n) => n.getAttribute('data-action'));
  assert.deepStrictEqual(actions.sort(), ['oi-ctx-preview', 'oi-ctx-preview-close', 'oi-ctx-toggle']);
  assert.ok(!u.all().some((n) => n.tagName === 'BUTTON' && /save|approve|send/i.test(n.textContent)));
  u.btn('oi-ctx-preview-close').click();
  assert.ok(!u.text().includes('Preview - not saved'));
});

test('11e. expired report: labelled, "Refresh research first", preview disabled, items dimmed', async () => {
  const m = mainSide({ nowDays: 40 });
  const u = makeUi(m.api);
  u.ui.reset();
  u.btn('oi-ctx-toggle').click();
  await flush();
  assert.ok(u.text().includes('Expired'));
  assert.ok(u.text().includes('Refresh research first'));
  assert.equal(u.btn('oi-ctx-preview').disabled, true);
  assert.ok(u.all().filter((n) => n.className === 'pitch-oi-item').every((n) => n.getAttribute('data-eligible') === 'false'));
});

test('11f. older report and no report states', async () => {
  const r1 = fixtures.report({ research_id: 'res_20261001120000_abcdef01', snapshot_id: 'snap_20261001120000_abcdef01', generated_at: new Date(T0).toISOString() });
  const r2 = fixtures.report({ research_id: 'res_20261002120000_abcdef02', snapshot_id: 'snap_20261002120000_abcdef02', generated_at: new Date(T0 + DAY).toISOString() });
  const m = mainSide({ reports: [r1, r2], missing: [r2.research_id] });
  const u = makeUi(m.api);
  u.ui.reset();
  u.btn('oi-ctx-toggle').click();
  await flush();
  assert.ok(u.text().includes('Showing an older report because the latest report is no longer available.'));
  const none = makeUi(mainSide({ reports: [] }).api);
  none.ui.reset();
  none.btn('oi-ctx-toggle').click();
  await flush();
  assert.ok(none.text().includes('No Opportunity Intelligence report for this lead yet.'));
  const off = makeUi(null);
  off.ui.reset();
  off.btn('oi-ctx-toggle').click();
  await flush();
  assert.ok(off.text().includes('Opportunity Intelligence is unavailable.'));
});

test('11g. a late answer after a lead change is dropped', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const u = makeUi({ pitchContext: async () => { await gate; return { ok: true, data: { available: true, eligible: true, items: [{ title: 'LATE', eligible: true, claim_kind: 'fact', evidence_ids: ['e1'] }] } }; } });
  u.ui.reset();
  u.btn('oi-ctx-toggle').click();
  u.ui.reset();
  release();
  await flush();
  assert.ok(!u.text().includes('LATE'));
});

(async () => {
  for (const { name, fn } of queue) {
    try { await fn(); passed += 1; console.log('ok - ' + name); } catch (err) { failures.push({ name, err }); console.log('FAIL - ' + name + ': ' + err.message); }
  }
  for (const f of failures) console.error(f.err && f.err.stack);
  console.log(`${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
