'use strict';

// I6 - the Lead drawer Timeline tab.
//
// The real I6 renderer block is lifted from renderer.js and run against a DOM double. Its
// bridge is wired to the REAL timeline IPC handler over the REAL LeadTimeline and a real
// MemoryStore, exactly as preload exposes it. Nothing here touches the network.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const LI = path.join(root, 'src', 'main', 'lead-intelligence');
const rendererSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'renderer.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const { LeadTimeline } = require(path.join(LI, 'timeline', 'LeadTimeline'));
const { registerTimelineIpc, TIMELINE_CHANNEL } = require(path.join(LI, 'timeline', 'timeline-ipc'));
const { MemoryStore } = require(path.join(LI, 'persistence', 'MemoryStore'));

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

const block = between(rendererSource, '// === I6 Lead timeline ===', '// === P1-G Collection Quality Report (read-only) ===');
const code = block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const helpers = [
  between(rendererSource, 'const LEAD_DRAWER_TABS', '\n') + '\n',
  between(rendererSource, 'const LEAD_DRAWER_NA', '\n') + '\n',
  functionSource(rendererSource, 'function leadDrawerText('),
  functionSource(rendererSource, 'function leadDrawerEl('),
  functionSource(rendererSource, 'function leadDrawerFormatTime('),
].join('\n');

class FakeEl {
  constructor(tag, id) {
    this.tagName = String(tag).toUpperCase();
    this.id = id || '';
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.className = '';
    this.disabled = false;
    this.type = '';
    this._text = '';
  }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  set innerHTML(v) { throw new Error('innerHTML must not be used by the timeline'); }
  appendChild(c) { this.children.push(c); return c; }
  replaceChildren(...cs) { this.children = []; this._text = ''; cs.forEach((c) => this.appendChild(c)); }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  click() { for (const fn of this.listeners.click || []) fn({}); }
  all() { return this.children.flatMap((c) => [c, ...c.all()]); }
}

const LEAD = '7';
const T = (d, h = 0) => new Date(Date.UTC(2026, 8, d, h)).toISOString();

async function mainSide({ activity = 0, broken = false } = {}) {
  const store = new MemoryStore();
  await store.pitches.upsert({ pitch_id: 'pt1', lead_id: LEAD, packet_id: null, status: 'draft', content_hash: 'h', created_at: T(10), updated_at: T(10) });
  await store.activity.append({ activity_id: 'a1', lead_id: LEAD, pitch_id: 'pt1', activity_type: 'OUTREACH_SEND_ACCEPTED', metadata: { channel: 'email' }, created_at: T(12) });
  for (let i = 0; i < activity; i += 1) {
    await store.activity.append({ activity_id: `r${String(i).padStart(3, '0')}`, lead_id: LEAD, pitch_id: 'pt1', activity_type: 'OUTREACH_READY', metadata: {}, created_at: new Date(Date.UTC(2026, 8, 11) - i * 60000).toISOString() });
  }
  const s = broken ? Object.assign(Object.create(store), { changes: { listByLead: async () => { throw new Error('x'); } } }) : store;
  const timeline = new LeadTimeline({ store: s, leadSource: { getLead: async () => ({ id: LEAD, collectedAt: T(1) }) } });
  const handlers = {};
  registerTimelineIpc({ ipcMain: { handle: (c, f) => { handlers[c] = f; } }, timeline, isTrustedSender: () => true, logger: { warn() {} } });
  const sent = [];
  // Exactly the preload surface: ztechLeadIntel.timeline.forLead(payload).
  const api = { forLead: (p) => { sent.push(p); return handlers[TIMELINE_CHANNEL]({}, p || {}); } };
  return { api, sent };
}

function makeUi(api, leadId = LEAD) {
  const reg = new Map();
  const document = {
    getElementById(id) { if (!reg.has(id)) reg.set(id, new FakeEl('div', id)); return reg.get(id); },
    createElement(tag) { return new FakeEl(tag); },
  };
  const opened = [];
  const ui = new Function('document', 'window', 'selectLeadDrawerTab',
    `let leadDrawerLeadId = ${JSON.stringify(leadId)};\n${helpers}\n${block}\n`
    + 'return { load: (older) => loadLeadDrawerTimeline(leadDrawerLeadId, older), reset: resetLeadDrawerTimeline, get state() { return leadDrawerTimeline; } };')(
    document, { ztechLeadIntel: api ? { timeline: api } : {} }, (tab) => opened.push(tab));
  const box = document.getElementById('lead-drawer-timeline');
  return {
    ui, box, opened,
    text: () => box.textContent,
    rows: () => box.all().filter((n) => n.className === 'lead-timeline-row'),
    btn: (action, extra) => box.all().find((n) => n.getAttribute('data-action') === action && (!extra || n.getAttribute('data-source') === extra || n.getAttribute('data-target') === extra)) || null,
  };
}
const flush = () => new Promise((r) => setImmediate(r));

test('13a. markup: a 7th tab and panel, textContent only, no score vocabulary, preload is read-only', () => {
  assert.ok(/id="lead-tab-timeline" data-tab="timeline"[^>]*>Timeline<\/button>/.test(htmlSource));
  assert.ok(htmlSource.includes('id="lead-panel-timeline"') && htmlSource.includes('id="lead-drawer-timeline"'));
  assert.ok(rendererSource.includes("const LEAD_DRAWER_TABS = ['overview', 'research', 'opportunity', 'evidence', 'icp', 'pitch', 'timeline'];"));
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(code));
  assert.ok(!/\d+\s*%|\bscore\b|\bgrade\b|\brank/i.test(code));
  assert.ok(!/setInterval|setTimeout|requestAnimationFrame/.test(code), 'no polling');
  assert.ok(!/outreach\.|outreachSend|approve\(|\.request\(/.test(code), 'the timeline calls only timeline.forLead');
  const tl = preloadSource.slice(preloadSource.indexOf('timeline: Object.freeze({'));
  assert.ok(/forLead: \(payload\) => ipcRenderer\.invoke\('lead-intel:timeline', payload \|\| \{\}\)/.test(tl.slice(0, 300)));
});

test('13b. renders newest first with source badges; Open only where a drawer tab exists', async () => {
  const m = await mainSide();
  const u = makeUi(m.api);
  await u.ui.load(false);
  const rows = u.rows();
  assert.equal(rows.length, 3);
  assert.ok(rows[0].textContent.includes('Send accepted by the provider') && rows[0].textContent.includes('Outreach'));
  assert.ok(rows[2].textContent.includes('Lead collected'));
  const leadRow = rows[2];
  assert.equal(leadRow.all().find((n) => n.getAttribute('data-action') === 'timeline-open'), undefined, 'null open -> no link');
  u.btn('timeline-open', 'pitch').click();
  assert.deepEqual(u.opened, ['pitch']);
  assert.ok(u.text().includes("Built from ZTech's records."));
  assert.deepEqual(m.sent[0], { leadId: LEAD, limit: 50 });
});

test('13c. filters are applied in main (sources sent), and at least one stays on', async () => {
  const m = await mainSide();
  const u = makeUi(m.api);
  await u.ui.load(false);
  u.btn('timeline-filter', 'outreach').click();
  await flush(); await flush();
  assert.deepEqual(m.sent.at(-1).sources, ['lead', 'research', 'enrichment', 'opportunity', 'pitch']);
  assert.ok(!u.text().includes('Send accepted'));
  for (const s of ['lead', 'research', 'enrichment', 'opportunity', 'pitch']) { u.btn('timeline-filter', s).click(); await flush(); await flush(); }
  assert.equal(u.ui.state.sources.length, 1, 'the last source cannot be switched off');
});

test('13d. Load older pages with the cursor and never repeats a row', async () => {
  const m = await mainSide({ activity: 70 });
  const u = makeUi(m.api);
  await u.ui.load(false);
  assert.equal(u.rows().length, 50);
  u.btn('timeline-older').click();
  await flush(); await flush(); await flush();
  assert.equal(u.rows().length, 73, '70 ready + accepted + pitch + lead');
  assert.ok(m.sent.at(-1).before && m.sent.at(-1).before.event_id);
  const ids = u.rows().map((r) => r.attributes['data-kind'] + r.textContent);
  assert.equal(new Set(ids).size >= 3, true);
  assert.equal(u.btn('timeline-older'), null, 'no more pages');
});

test('13e. empty, partial and error states are honest', async () => {
  const empty = makeUi({ forLead: async () => ({ ok: true, data: { events: [], has_more: false, unavailable_sources: [] } }) });
  await empty.ui.load(false);
  assert.ok(empty.text().includes('Nothing has happened for this lead yet.'));
  const m = await mainSide({ broken: true });
  const part = makeUi(m.api);
  await part.ui.load(false);
  assert.ok(part.text().includes('Research history could not be read.'));
  assert.ok(part.rows().length > 0, 'the other sources still render');
  const err = makeUi({ forLead: async () => ({ ok: false, error: { message: 'Untrusted IPC sender' } }) });
  await err.ui.load(false);
  assert.ok(err.text().includes('Untrusted IPC sender'));
  const none = makeUi(null);
  await none.ui.load(false);
  assert.ok(none.text().includes('not available in this build'));
});

test('13f. a late answer for a different lead is dropped', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const u = makeUi({ forLead: async () => { await gate; return { ok: true, data: { events: [{ event_id: 'lead:9', at: T(1), source: 'lead', kind: 'LEAD_COLLECTED', title: 'Lead collected', detail: null, open: null }] } }; } });
  const p = u.ui.load(false);
  u.ui.reset();
  release();
  await p;
  assert.equal(u.rows().length, 0);
});

(async () => {
  for (const { name, fn } of queue) {
    try { await fn(); passed += 1; console.log('ok - ' + name); } catch (err) { failures.push({ name, err }); console.log('FAIL - ' + name + ': ' + err.message); }
  }
  for (const f of failures) console.error(f.err && f.err.stack);
  console.log(`${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
