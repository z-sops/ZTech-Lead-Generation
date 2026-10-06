'use strict';

// Phase I2 — Opportunity Intelligence panel in the Lead Detail drawer.
//
// The panel code is lifted from renderer.js and EXECUTED against a minimal DOM
// double. Its data comes from the real main-process path: the real
// OpportunityIntelligenceService and the real registerOpportunityIpc handlers,
// over a fake fetch that stands in for the local OI FastAPI service. No network,
// no provider, no jsdom.
//
// What these tests pin:
//   - OI down renders "Opportunity Intelligence unavailable" and never throws.
//   - Opening the drawer only READS; research runs only on the button.
//   - The renderer sends { leadId, force } and nothing else.
//   - FACT / ESTIMATE / INFERENCE are shown as OI stated them; a missing kind is
//     "Not stated", never FACT.
//   - Provider statuses are shown verbatim; degraded is not failed.
//   - A late answer for another lead is never applied.
//   - OI text is set as text, never parsed as HTML.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const rendererSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'renderer.js'), 'utf8');
const cssSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'styles.css'), 'utf8');
const OP = path.join(root, 'src', 'main', 'lead-intelligence', 'opportunity');
const { OpportunityIntelligenceService } = require(path.join(OP, 'OpportunityIntelligenceService'));
const { CHANNELS, registerOpportunityIpc, registerUnavailableOpportunityIpc } = require(path.join(OP, 'opportunity-ipc'));
const fixtures = require(path.join(__dirname, 'lead-intelligence', 'opportunity-fixtures'));

let passed = 0;
const failures = [];
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from !== -1 && to !== -1, 'slice markers found: ' + start);
  return source.slice(from, to);
}
function functionSource(source, marker) {
  const from = source.indexOf(marker);
  assert.ok(from !== -1, 'function found: ' + marker);
  const close = source.indexOf('\n}', from);
  return source.slice(from, close + 2);
}

const OI_START = '// === I2 Opportunity Intelligence: Lead Drawer panel ===';
const OI_END = '// === P1-G Collection Quality Report (read-only) ===';
const oiBlock = between(rendererSource, OI_START, OI_END);
const oiCode = oiBlock.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const helpers = [
  between(rendererSource, 'const LEAD_DRAWER_NA', '\n') + '\n',
  functionSource(rendererSource, 'function leadDrawerText('),
  functionSource(rendererSource, 'function leadDrawerEl('),
  functionSource(rendererSource, 'function leadDrawerFormatTime('),
  functionSource(rendererSource, 'function leadDrawerValueText('),
  functionSource(rendererSource, 'function leadDrawerField(')
].join('\n');

// --- minimal DOM double ------------------------------------------------------

class FakeEl {
  constructor(doc, tag, id) {
    this.ownerDocument = doc;
    this.tagName = String(tag).toUpperCase();
    this.id = id || '';
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.listeners = {};
    this.className = '';
    this.disabled = false;
    this.type = '';
    this._text = '';
  }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  set innerHTML(v) { throw new Error('innerHTML must not be used by the OI panel'); }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  replaceChildren(...cs) { this.children = []; this._text = ''; cs.forEach((c) => this.appendChild(c)); }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  click() { for (const fn of this.listeners.click || []) fn({}); }
  descendants() { return this.children.flatMap((c) => [c, ...c.descendants()]); }
}

// --- the main-process side, real code over a fake OI service -----------------

const BASE = 'http://127.0.0.1:8099';
function resp(status, body) {
  return { ok: status < 400, status, headers: { get: () => null }, text: async () => JSON.stringify(body) };
}
function fakeFetch(routes, log) {
  return async (url, init = {}) => {
    const key = `${init.method || 'GET'} ${url}`;
    log.push({ key, body: init.body ? JSON.parse(init.body) : null });
    const r = typeof routes === 'function' ? routes(key) : routes[key];
    if (r === 'refused' || r === undefined && routes.__down) {
      const e = new Error('connect ECONNREFUSED 127.0.0.1:8099'); e.code = 'ECONNREFUSED'; throw e;
    }
    if (!r) return resp(404, { error: 'NOT_FOUND', message: 'no route' });
    return resp(r.status || 200, r.body);
  };
}

const { toLeadView } = require(path.join(root, 'src', 'main', 'lead-intelligence', 'contracts', 'leadView'));

function mainProcess(routes, leadRows) {
  const log = [];
  const svc = new OpportunityIntelligenceService({
    config: { baseUrl: BASE },
    fetchImpl: fakeFetch(routes, log),
    clock: () => new Date('2026-10-05T12:00:00Z'),
    logger: { warn() {}, error() {}, info() {} }
  });
  const handlers = {};
  registerOpportunityIpc({
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } },
    opportunity: svc,
    isTrustedSender: () => true,
    leadSource: { get: async (id) => (leadRows ? toLeadView(leadRows[id]) : { id, company_name: 'Acme Bakery', domain: 'acme.example' }) },
    logger: { warn() {} }
  });
  const sent = [];
  // Exactly what preload.js exposes: ipcRenderer.invoke(channel, payload || {}).
  const invoke = (ch) => (payload) => { sent.push({ ch, payload }); return handlers[ch]({ sender: {} }, payload || {}); };
  const api = {
    health: () => invoke(CHANNELS.HEALTH)(),
    engine: () => invoke(CHANNELS.ENGINE)(),
    request: invoke(CHANNELS.REQUEST),
    report: invoke(CHANNELS.REPORT),
    latest: invoke(CHANNELS.LATEST),
    associations: invoke(CHANNELS.ASSOCIATIONS),
    pitchContext: invoke(CHANNELS.PITCH_CONTEXT)
  };
  return { svc, api, log, sent };
}

const RESEARCH = `POST ${BASE}/v1/research`;
const REPORT = `GET ${BASE}/v1/reports/res_20261005120000_abcdef01`;

// --- the renderer side --------------------------------------------------------

function makePanel(api) {
  const doc = {
    registry: new Map(),
    getElementById(id) {
      if (!this.registry.has(id)) this.registry.set(id, new FakeEl(this, 'div', id));
      return this.registry.get(id);
    },
    createElement(tag) { return new FakeEl(this, tag); }
  };
  const window = { ztechLeadIntel: api ? { opportunity: api } : {} };
  const ctl = new Function('document', 'window',
    'let leadDrawerLeadId = null;\n' +
    "let leadDrawerOpportunity = { kind: 'idle', view: null, error: null, leadId: null, running: false, notice: null };\n" +
    helpers + '\n' + oiBlock +
    '\nreturn {' +
    ' open(id) { leadDrawerLeadId = id; return loadLeadDrawerOpportunity(id); },' +
    ' switchTo(id) { leadDrawerLeadId = id; leadDrawerOpportunitySeq += 1;' +
    "   leadDrawerOpportunity = { kind: 'idle', view: null, error: null, leadId: null, running: false, notice: null }; }," +
    ' run: () => runLeadDrawerOpportunity(),' +
    ' get state() { return leadDrawerOpportunity; } };'
  )(doc, window);
  const box = doc.getElementById('lead-drawer-opportunity');
  return {
    ctl,
    box,
    text: () => box.textContent,
    find: (pred) => box.descendants().filter(pred),
    button: (action) => box.descendants().find((n) => n.getAttribute('data-action') === action) || null,
    badges: (kind) => box.descendants().filter((n) => n.className === 'oi-badge' && (!kind || n.getAttribute('data-kind') === kind)).map((n) => n.textContent)
  };
}

const flush = () => new Promise((r) => setImmediate(r));

// --- tests -------------------------------------------------------------------

test('1. OI down: the panel says "Opportunity Intelligence unavailable", offers Retry, and does not throw', async () => {
  const main = mainProcess({ __down: true });
  const p = makePanel(main.api);
  await p.ctl.open('L1');
  // Nothing was researched yet in this session, so latest answers not_researched without
  // touching the network; a down service shows up when research is asked for. Both paths
  // must stay honest - check the explicitly unconfigured build too.
  assert.ok(/No Opportunity Intelligence research has been run/.test(p.text()));

  const handlers = {};
  registerUnavailableOpportunityIpc({
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } },
    isTrustedSender: () => true,
    reason: 'Opportunity Intelligence is not configured.',
    logger: { warn() {} }
  });
  const q = makePanel({ latest: (pl) => handlers[CHANNELS.LATEST]({}, pl), request: (pl) => handlers[CHANNELS.REQUEST]({}, pl) });
  await q.ctl.open('L1');
  assert.ok(q.text().includes('Opportunity Intelligence unavailable'), q.text());
  assert.ok(q.text().includes('Opportunity Intelligence is not configured.'));
  assert.ok(q.text().includes('Research, Evidence, Pitch and Outreach keep working without it.'));
  assert.ok(q.button('oi-retry'), 'a retry button is offered');
  assert.strictEqual(q.button('oi-run'), null, 'no run button while the service is unavailable');
});

test('2. a missing bridge renders unavailable, not a crash', async () => {
  const p = makePanel(null);
  await p.ctl.open('L1');
  assert.ok(p.text().includes('Opportunity Intelligence unavailable'));
});

test('3. an {ok:false} envelope renders unavailable with the safe message', async () => {
  const p = makePanel({ latest: async () => ({ ok: false, error: { code: 'VALIDATION', message: 'leadId is invalid' } }) });
  await p.ctl.open('L1');
  assert.ok(p.text().includes('Opportunity Intelligence unavailable'));
  assert.ok(p.text().includes('leadId is invalid'));
});

test('4. opening the drawer only reads: no research request reaches OI', async () => {
  const main = mainProcess({ [RESEARCH]: { body: fixtures.report() }, [REPORT]: { body: fixtures.report() } });
  const p = makePanel(main.api);
  await p.ctl.open('L1');
  assert.deepStrictEqual(main.sent.map((s) => s.ch), [CHANNELS.LATEST]);
  assert.ok(!main.log.some((c) => c.key === RESEARCH), 'no research POST on open');
  assert.ok(p.text().includes('No Opportunity Intelligence research has been run for this lead yet.'));
  const run = p.button('oi-run');
  assert.ok(run && !run.disabled, 'Run Opportunity Research is offered');
  assert.strictEqual(run.textContent, 'Run Opportunity Research');
});

test('5. Run calls opportunity.request with exactly { leadId, force:true } and renders the report', async () => {
  const main = mainProcess({ [RESEARCH]: { body: fixtures.report() }, [REPORT]: { body: fixtures.report() } });
  const p = makePanel(main.api);
  await p.ctl.open('L1');
  p.button('oi-run').click();
  assert.strictEqual(p.button('oi-run').disabled, true, 'the button is disabled while research runs');
  assert.ok(p.text().includes('Running research...'));
  await flush(); await flush();
  const req = main.sent.find((s) => s.ch === CHANNELS.REQUEST);
  assert.deepStrictEqual(req.payload, { leadId: 'L1', force: true }, 'the renderer sends a lead id and nothing else');
  const post = main.log.find((c) => c.key === RESEARCH);
  assert.ok(post, 'research reached the OI service');
  assert.strictEqual(post.body.prospect.company_name, 'Acme Bakery', 'identity came from the main store');
  const t = p.text();
  for (const s of ['Overview', 'Provider status', 'Opportunities', 'Sales angles', 'Competitors', 'Ads',
    'Content & Social', 'Research timeline', 'Evidence']) {
    assert.ok(t.includes(s), 'section rendered: ' + s);
  }
  assert.ok(t.includes('res_20261005120000_abcdef01'), 'research id shown');
  assert.ok(t.includes('Run research again'));
});

test('6. FACT, ESTIMATE and INFERENCE are all shown, as OI stated them', async () => {
  const main = mainProcess({ [RESEARCH]: { body: fixtures.report() }, [REPORT]: { body: fixtures.report() } });
  const p = makePanel(main.api);
  await p.ctl.open('L1');
  await p.ctl.run();
  const kinds = new Set(p.badges('claim-kind'));
  for (const k of ['FACT', 'ESTIMATE', 'INFERENCE']) assert.ok(kinds.has(k), 'claim kind shown: ' + k);
  // the estimate keeps its range, so it reads as an estimate and not a measured value
  assert.ok(p.text().includes('Estimated range 3–5'), 'the estimate range is shown');
  // every opportunity is badged INFERENCE, never FACT
  const report = fixtures.report();
  for (const o of report.opportunities) {
    const li = p.find((n) => n.tagName === 'LI' && n.textContent.startsWith(o.title))[0];
    assert.ok(li, 'opportunity rendered: ' + o.title);
    const badge = li.descendants().find((n) => n.getAttribute('data-kind') === 'claim-kind');
    assert.strictEqual(badge.textContent, 'INFERENCE');
  }
});

test('7. a claim with no claim_kind shows "Not stated", never FACT', async () => {
  const main = mainProcess({});
  const r = fixtures.report();
  const claim = r.evidence[0].claim;
  delete r.evidence[0].claim_kind;
  const view = main.svc.toView('L1', r, null);
  const p = makePanel({ latest: async () => ({ ok: true, data: view }) });
  await p.ctl.open('L1');
  const li = p.find((n) => n.tagName === 'LI' && n.textContent.startsWith(claim))[0];
  assert.ok(li, 'the untyped evidence item is rendered');
  const badge = li.descendants().find((n) => n.getAttribute('data-kind') === 'claim-kind');
  assert.strictEqual(badge.textContent, 'Not stated');
});

test('8. provider statuses are verbatim, and a degraded report reads as partial, not failed', async () => {
  const main = mainProcess({ [RESEARCH]: { body: fixtures.report() }, [REPORT]: { body: fixtures.report() } });
  const p = makePanel(main.api);
  await p.ctl.open('L1');
  await p.ctl.run();
  const statuses = new Set(p.badges('provider-status'));
  const expected = new Set();
  const label = { success: 'Success', partial: 'Partial', unavailable: 'Unavailable', unsupported: 'Unsupported', failed: 'Failed', rate_limited: 'Rate limited' };
  for (const byProvider of Object.values(fixtures.report().provider_status)) {
    for (const st of Object.values(byProvider)) expected.add(label[st]);
  }
  for (const s of expected) assert.ok(statuses.has(s), 'provider status shown: ' + s);
  assert.ok(expected.has('Unavailable'), 'the fixture really is degraded');
  const t = p.text();
  assert.ok(t.includes('Partial — some providers unavailable'));
  assert.ok(!t.includes('Research failed'));
  assert.ok(t.includes('It is not evidence that the channel is empty.'));
});

test('9. an OI-reported failure is shown as a failure, without crashing', async () => {
  const main = mainProcess({});
  const view = main.svc.toView('L1', fixtures.failedReport(), null);
  const p = makePanel({ latest: async () => ({ ok: true, data: view }) });
  await p.ctl.open('L1');
  assert.ok(p.text().includes('Research failed'));
});

test('10. sales angles carry the not-verified warning and every do_not_claim line', async () => {
  const main = mainProcess({ [RESEARCH]: { body: fixtures.report() }, [REPORT]: { body: fixtures.report() } });
  const p = makePanel(main.api);
  await p.ctl.open('L1');
  await p.ctl.run();
  const t = p.text();
  assert.ok(t.includes('Sales angles are intelligence-derived suggestions, not verified facts.'));
  for (const a of fixtures.report().sales_angles) {
    assert.ok(t.includes(a.angle), 'angle shown: ' + a.angle);
    for (const line of a.do_not_claim) assert.ok(t.includes(line), 'do_not_claim shown: ' + line);
  }
});

test('11. the timeline says it is separate from ZTech Activity', async () => {
  const main = mainProcess({ [RESEARCH]: { body: fixtures.report() }, [REPORT]: { body: fixtures.report() } });
  const p = makePanel(main.api);
  await p.ctl.open('L1');
  await p.ctl.run();
  assert.ok(p.text().includes('ZTech operational Activity (approvals, sends) is a separate ledger'));
  for (const ev of fixtures.report().timeline) assert.ok(p.text().includes(ev.title), 'event shown: ' + ev.title);
});

test('12. once researched, reopening the lead reads the latest report back', async () => {
  const main = mainProcess({ [RESEARCH]: { body: fixtures.report() }, [REPORT]: { body: fixtures.report() } });
  const p = makePanel(main.api);
  await p.ctl.open('L1');
  await p.ctl.run();
  const q = makePanel(main.api);
  await q.ctl.open('L1');
  assert.ok(q.text().includes('res_20261005120000_abcdef01'));
  assert.ok(q.text().includes('Run research again'));
});

test('13. a failed re-run keeps the last good report and says why', async () => {
  let down = false;
  const routes = (key) => {
    if (down) return 'refused';
    return key === RESEARCH || key === REPORT ? { body: fixtures.report() } : null;
  };
  const main = mainProcess(routes);
  const p = makePanel(main.api);
  await p.ctl.open('L1');
  await p.ctl.run();
  down = true;
  await p.ctl.run();
  const t = p.text();
  assert.ok(t.includes('Research did not complete:'), t.slice(0, 300));
  assert.ok(t.includes('res_20261005120000_abcdef01'), 'the previous report stays on screen');
});

test('14. a late answer for a different lead is never applied', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const main = mainProcess({});
  const view = main.svc.toView('L1', fixtures.report(), null);
  const p = makePanel({
    latest: async ({ leadId }) => ({ ok: true, data: { available: false, state: 'not_researched', lead_id: leadId, model: null } }),
    request: async () => { await gate; return { ok: true, data: view }; }
  });
  await p.ctl.open('L1');
  const pending = p.ctl.run();
  p.ctl.switchTo('L2');
  await p.ctl.open('L2');
  release();
  await pending;
  assert.ok(!p.text().includes('res_20261005120000_abcdef01'), 'L1 report did not land on L2');
  assert.ok(p.text().includes('No Opportunity Intelligence research has been run'));
});

test('15. OI text is set as text, never as HTML', async () => {
  const main = mainProcess({});
  const r = fixtures.report();
  r.evidence[0].claim = '<img src=x onerror=alert(1)> evil';
  const view = main.svc.toView('L1', r, null);
  const p = makePanel({ latest: async () => ({ ok: true, data: view }) });
  await p.ctl.open('L1'); // the FakeEl throws if innerHTML is assigned
  assert.ok(p.text().includes('<img src=x onerror=alert(1)> evil'), 'shown literally');
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(oiCode), 'no HTML sinks in the OI panel');
  assert.ok(!p.find((n) => n.tagName === 'A').length, 'no OI-supplied link is rendered');
});

test('16. the panel only uses the OI bridge, and only reads plus the one request', () => {
  const calls = [...oiCode.matchAll(/bridge\.(\w+)\(/g)].map((m) => m[1]);
  assert.deepStrictEqual([...new Set(calls)].sort(), ['latest', 'request']);
  for (const forbidden of [/ztechLeadIntel\.research/, /\bsend\w*\(/i, /approve/i, /outreach\./i, /baseUrl|base_url|apiKey|token/]) {
    assert.ok(!forbidden.test(oiCode), 'OI panel stays out of: ' + forbidden);
  }
  assert.ok(!/mountOpportunitySection/.test(rendererSource), 'no dead module mount remains');
  // OI lives in its own block, so the F5 "no invented score" guard still covers F5 itself.
  const f5 = between(rendererSource, '// === F5 Lead Detail Drawer ===', 'function splitImportLines(');
  assert.ok(!/function renderLeadDrawerOpportunity|function oi[A-Z]/.test(f5), 'OI rendering is not inside the F5 block');
});

test('17. the OI badge styles use existing status tokens only', () => {
  const css = between(cssSource, 'ZTech Phase I2 - Opportunity Intelligence', '.oi-do-not-claim-label');
  assert.ok(!/#[0-9a-fA-F]{3,6}\b/.test(css), 'no new colours');
  for (const tone of ['ok', 'warn', 'bad', 'info']) assert.ok(css.includes(`.oi-badge[data-tone="${tone}"]`));
});

test('18. the health view crossing IPC does not carry the OI destination', async () => {
  const main = mainProcess({});
  const res = await main.api.health();
  assert.strictEqual(res.ok, true);
  assert.ok(!('base_url' in res.data) && !('baseUrl' in res.data));
  assert.ok(!JSON.stringify(res.data).includes('127.0.0.1'));
});

test('19. a real ZTech lead row (title + full website URL) reaches OI as company + hostname', async () => {
  const rows = { L9: { id: 'L9', title: 'Thai Cafe & Co', website: 'https://www.thaicafe-bkk.com/menu', phone: '+66 81 234 5678' } };
  const main = mainProcess({ [RESEARCH]: { body: fixtures.report() }, [REPORT]: { body: fixtures.report() } }, rows);
  const p = makePanel(main.api);
  await p.ctl.open('L9');
  await p.ctl.run();
  const post = main.log.find((c) => c.key === RESEARCH);
  assert.ok(post, 'research was requested');
  assert.strictEqual(post.body.prospect.company_name, 'Thai Cafe & Co');
  assert.ok(/^(www\.)?thaicafe-bkk\.com$/.test(post.body.prospect.domain), 'hostname, not a URL: ' + post.body.prospect.domain);
  assert.ok(p.text().includes('res_20261005120000_abcdef01'));
});

(async () => {
  for (const { name, fn } of queue) {
    try {
      await fn();
      passed += 1;
      console.log('ok - ' + name);
    } catch (err) {
      failures.push({ name, err });
      console.log('FAIL - ' + name + ': ' + err.message);
    }
  }
  for (const f of failures) console.error(f.err && f.err.stack);
  console.log(`${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
