'use strict';

// F29 - the Reply Router UI: the lead drawer's "Reply category" section and the Outreach view's
// Replies list. The REAL renderer block runs against a DOM double; its bridge calls the REAL
// reply-router IPC handlers over the real F26.6/F28 runtime (fake Gmail, no network).

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const LI = path.join(root, 'src', 'main', 'lead-intelligence');
const rendererSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'renderer.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const { registerReplyRouterIpc } = require(path.join(LI, 'replies', 'reply-router-ipc.js'));
const { ReplyRouterService } = require(path.join(LI, 'replies', 'ReplyRouterService.js'));
const { mailboxEventId } = require(path.join(LI, 'mailbox', 'gmail', 'rfc2822.js'));
const h = require('./f28-harness');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const START = '// === F29 Reply Router: suggested categories for verified replies ===';
const END = '// === END F29 Reply Router ===';
const block = rendererSource.slice(rendererSource.indexOf(START), rendererSource.indexOf(END));
const code = block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const TRUST_EL = (() => { const i = rendererSource.indexOf('function trustEl('); return rendererSource.slice(i, rendererSource.indexOf('\n}\n', i) + 3); })();
const STORED = '<CAstored-1@mail.gmail.com>';
const FROM = `"Owner" <${h.LEAD_EMAIL}>`;

class FakeEl {
  constructor(tag, id) { this.tagName = String(tag).toUpperCase(); this.id = id || ''; this.children = []; this.attributes = {}; this.listeners = {}; this.className = ''; this.disabled = false; this.type = ''; this.value = ''; this.checked = false; this.selected = false; this._text = ''; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  set innerHTML(v) { throw new Error('innerHTML must not be used'); }
  appendChild(c) { this.children.push(c); if (c.tagName === 'OPTION' && c.selected) this.value = c.value; return c; }
  append(...cs) { cs.forEach((c) => this.appendChild(typeof c === 'string' ? Object.assign(new FakeEl('#text'), { _text: c }) : c)); }
  replaceChildren(...cs) { this.children = []; this._text = ''; cs.forEach((c) => this.appendChild(c)); }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  fire(t) { for (const fn of this.listeners[t] || []) fn({}); }
  all() { return this.children.flatMap((c) => [c, ...c.all()]); }
}

const settle = async () => { for (let i = 0; i < 40; i += 1) await new Promise((r) => setImmediate(r)); };

async function env({ leads } = {}) {
  const s = await h.setup(leads ? { leads } : {});
  const router = new ReplyRouterService({ store: s.store, clock: () => new Date(s.clock.t), operator: 'Zee', leadName: async (id) => { const c = await s.li.outreach.contexts.getContext(id); return c && c.view ? c.view.name : null; } });
  s.svc.setReplyRouter((m) => router.onMailboxMessage(m));
  const handlers = {};
  registerReplyRouterIpc({ ipcMain: { handle: (c, f) => { handlers[c] = f; } }, replyRouter: router, isTrustedSender: () => true, logger: { warn() {} } });
  const calls = [];
  const call = (channel) => async (payload) => { calls.push([channel, payload]); return handlers[channel]({}, payload || {}); };
  const bridge = { replyRoutes: { list: call('lead-intel:reply-routes'), confirm: call('lead-intel:reply-route-confirm'), forLead: call('lead-intel:reply-route-lead') } };
  const els = {};
  const nav = new FakeEl('button');
  const document = {
    getElementById: (id) => { if (!els[id]) els[id] = new FakeEl('div', id); return els[id]; },
    createElement: (t) => new FakeEl(t),
    createTextNode: (t) => Object.assign(new FakeEl('#text'), { _text: String(t) }),
    querySelector: (q) => (q === '.nav-item[data-view="outreach"]' ? nav : null),
  };
  const opened = [];
  const window = { ztechLeadIntel: bridge };
  const ui = new Function('document', 'window', 'openLeadDetail',
    `let leadDrawerLeadId = null;\n${TRUST_EL}\n${block}\nreturn { load: (id) => { leadDrawerLeadId = id; return loadLeadReplyRoute(id); }, close: () => { leadDrawerLeadId = null; }, list: f29ListLoad, get lead() { return f29Lead; } };`)(document, window, (id) => opened.push(id));
  const drawer = () => els['lead-drawer-reply-route'];
  const panel = () => els['f29-replies'];
  const button = (host, label) => host.all().find((e) => e.tagName === 'BUTTON' && e.textContent === label) || null;
  const deliver = async (id, subject, extra = {}) => { s.gmail.deliver(id, { From: FROM, Subject: subject, 'In-Reply-To': STORED, References: STORED, ...extra }); await s.svc.syncReplies({ mailboxId: h.MBX }); };
  return { s, ui, calls, drawer, panel, button, nav, deliver, opened, bridge, ev: (id) => mailboxEventId(h.MBX, id) };
}

test('U1. drawer: a "Re: <our subject>" reply says "No clear signal from subject/headers"; Confirm and Change record the category only', async () => {
  const e = await env();
  await h.firstEmail(e.s);
  await e.deliver('in1', 'Re: A few notes on www.acme.example.com');
  await e.ui.load('L1');
  const t = e.drawer().textContent;
  assert.ok(/Unknown \(suggested\)/.test(t), t);
  assert.ok(/No clear signal from subject\/headers\./.test(t));
  assert.ok(/No matching review: choose the review yourself\./.test(t));
  assert.ok(/never its body\. A stop request written only in the body is not detected/.test(t), 'the body limit is stated');
  assert.ok(!/first lines|snippet|\bAI\b/i.test(t), 'no claim about reading the reply text');
  e.button(e.drawer(), 'Confirm').fire('click');
  await settle();
  assert.deepStrictEqual(e.calls.filter((c) => c[0] === 'lead-intel:reply-route-confirm').map((c) => c[1]), [{ eventId: e.ev('in1'), category: 'unknown' }]);
  assert.ok(/Category saved\. It changes nothing else/.test(e.drawer().textContent));
  assert.ok(/Confirmed by you/.test(e.drawer().textContent));
  e.button(e.drawer(), 'Change').fire('click');
  const select = e.drawer().all().find((x) => x.tagName === 'SELECT');
  select.value = 'later';
  e.button(e.drawer(), 'Save category').fire('click');
  await settle();
  assert.deepStrictEqual(e.calls.filter((c) => c[0] === 'lead-intel:reply-route-confirm').at(-1)[1], { eventId: e.ev('in1'), category: 'later' });
  assert.ok(/Later · reply received/.test(e.drawer().textContent));
  assert.strictEqual(e.s.store.replyReviews.rows.size, 0, 'no review is recorded from the drawer section');
  // A late answer for a drawer that was closed (or moved to another lead) is never shown.
  e.ui.load('L1');
  e.ui.close();
  await settle();
  assert.strictEqual(e.ui.lead.view, null);
  assert.ok(/Loading/.test(e.drawer().textContent));
});

test('U2. drawer: a changed subject says "Suggested from the subject/headers" and names the matching review; Away and opt-out notes', async () => {
  const e = await env();
  await h.firstEmail(e.s);
  await e.deliver('in1', 'Pricing?');
  await e.ui.load('L1');
  let t = e.drawer().textContent;
  assert.ok(/Pricing request \(suggested\)/.test(t));
  assert.ok(/Suggested from the subject\/headers\./.test(t));
  assert.ok(/Matching review: Interested\. Nothing is recorded until you click a review button\./.test(t));
  await e.deliver('o1', 'Automatic reply', { 'Auto-Submitted': 'auto-replied' });
  e.s.advance(1000);
  await e.deliver('in2', 'Stop emailing me');
  await e.ui.load('L1');
  t = e.drawer().textContent;
  assert.ok(/Possible opt-out - review now\. A category never adds anyone to do-not-contact: your review \("Unsubscribe" or "Not interested"\) or the do-not-contact buttons do\./.test(t));
  assert.ok(/Away \(out of office\): an automatic reply \(marked automatic in its headers\) arrived .*A note only: it is not counted as a reply and stops or changes nothing\./.test(t));
  assert.ok(!t.includes(h.LEAD_EMAIL), 'no address is shown');
});

test('U3. Outreach > Replies: opt-outs first, filter and "show reviewed" go to main as codes, Open lead uses the existing drawer', async () => {
  const leads = { L1: h.lead({}), L2: h.lead({ id: 'L2', title: 'Beta Cafe', website: 'https://beta.example.com', email: 'owner@beta.example.com' }) };
  const e = await env({ leads });
  await h.firstEmail(e.s, 'L1');
  e.s.advance(10 * 60 * 1000);
  await h.firstEmail(e.s, 'L2');
  await e.deliver('p1', 'Call next week?');
  e.s.advance(1000);
  e.s.gmail.deliver('s1', { From: '"B" <owner@beta.example.com>', Subject: 'Please take me off', 'In-Reply-To': '<CAstored-2@mail.gmail.com>', References: '<CAstored-2@mail.gmail.com>' });
  await e.s.svc.syncReplies({ mailboxId: h.MBX });
  e.nav.fire('click');
  await settle();
  const t = e.panel().textContent;
  assert.ok(t.indexOf('Possible opt-out - review now') < t.indexOf('Beta Cafe') && t.indexOf('Beta Cafe') < t.indexOf('Acme Bakery'), 'the opt-out is listed first');
  assert.ok(/Meeting request \(suggested\)/.test(t));
  assert.ok(/never its body/.test(t));
  assert.ok(!/first lines|snippet/i.test(t));
  assert.deepStrictEqual(e.calls.find((c) => c[0] === 'lead-intel:reply-routes')[1], { show: 'pending' });
  const filter = e.panel().all().find((x) => x.tagName === 'SELECT' && x.attributes['aria-label'] === 'Filter by category');
  filter.value = 'meeting_request';
  filter.fire('change');
  await settle();
  assert.deepStrictEqual(e.calls.filter((c) => c[0] === 'lead-intel:reply-routes').at(-1)[1], { show: 'pending', category: 'meeting_request' });
  assert.ok(!/Beta Cafe/.test(e.panel().textContent));
  const box = e.panel().all().find((x) => x.tagName === 'INPUT');
  box.checked = true;
  box.fire('change');
  await settle();
  assert.deepStrictEqual(e.calls.filter((c) => c[0] === 'lead-intel:reply-routes').at(-1)[1], { show: 'all', category: 'meeting_request' });
  e.button(e.panel(), 'Open lead').fire('click');
  assert.deepStrictEqual(e.opened, ['L1']);
  e.button(e.panel(), 'Confirm').fire('click');
  await settle();
  assert.deepStrictEqual(e.calls.filter((c) => c[0] === 'lead-intel:reply-route-confirm').at(-1)[1], { eventId: e.ev('p1'), category: 'meeting_request' });
  assert.strictEqual(h.sendCalls(e.s.gmail).length, 2, 'nothing was sent from the list');
  // Review fix: a slow answer for an older filter never overwrites the newer one.
  const real = e.s;
  let release;
  const gate = new Promise((r) => { release = r; });
  const orig = e.bridge.replyRoutes.list;
  let n = 0;
  e.bridge.replyRoutes.list = async (p) => { n += 1; if (n === 1) await gate; return orig(p); };
  box.checked = false;
  box.fire('change'); // slow: show pending, meeting_request
  filter.value = 'unsubscribe';
  filter.fire('change'); // fast: show pending, unsubscribe
  await settle();
  release();
  await settle();
  const shown = e.panel().all().filter((x) => x.className === 'f29-row-category').map((x) => x.textContent);
  assert.deepStrictEqual(shown, ['Unsubscribe (suggested)'], 'the newest filter wins');
  assert.ok(real);
});

test('U4. static: the block reaches only the reply-route bridge, uses no innerHTML, cannot send; hosts exist; no static Outreach control', () => {
  for (const banned of [/innerHTML/, /outreachSend/, /sendFromMailbox/, /reviewReply/, /ipcRenderer/, /require\s*\(/, /\bfetch\s*\(/, /setInterval|setTimeout/, /first lines/i, /snippet/i, /\bAI\b/]) {
    assert.ok(!banned.test(code), 'the F29 block must not contain ' + banned);
  }
  const calls = [...code.matchAll(/(?:bridge|api)\.(\w+(?:\.\w+)?)\(/g)].map((m) => m[1]);
  assert.deepStrictEqual([...new Set(calls)].sort(), ['confirm', 'forLead', 'list']);
  assert.ok(htmlSource.includes('id="lead-drawer-reply-route"') && htmlSource.includes('id="f29-replies"'), 'both hosts exist');
  const view = htmlSource.slice(htmlSource.indexOf('<section class="view" id="view-outreach">'), htmlSource.indexOf('<section class="view" id="view-targets">'));
  assert.deepStrictEqual([...view.matchAll(/<button[^>]*>([^<]*)</g)].map((m) => m[1].trim()).sort(), ['Next', 'Previous', 'Refresh'], 'no static control was added to the Outreach view');
  // Review fix: a review or do-not-contact click in the trust block refreshes the category section.
  const trustAct = rendererSource.slice(rendererSource.indexOf('async function trustAct('), rendererSource.indexOf('function trustStatusLine('));
  assert.ok(trustAct.includes("if (!next.error && typeof loadLeadReplyRoute === 'function') loadLeadReplyRoute(leadId);"));
  assert.ok(!/only the review button/i.test(code), 'no false claim about what adds someone to do-not-contact');
  // Placed between the F28 block and the F11 marker, outside the F11 / F12 / F19 slices.
  const at = rendererSource.indexOf(START);
  assert.ok(at > rendererSource.indexOf('// === END F28 Follow-ups ===') && at < rendererSource.indexOf('// === F11 Outreach: Lead Drawer Pitch tab ==='));
});

(async () => {
  let passed = 0;
  let failed = 0;
  for (const { name, fn } of tests) {
    try { await fn(); passed += 1; console.log('ok - ' + name); } catch (err) { failed += 1; console.log('FAIL - ' + name); console.log(String(err && err.stack ? err.stack : err)); }
  }
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
