'use strict';

// F28 - the follow-up UI: the lead drawer's Follow-ups section and the Outreach view's Follow-ups
// list. The REAL renderer block runs against a DOM double; its bridge calls the REAL sequence IPC
// handlers over the real F28 runtime (fake Gmail, no network). Checks: drafting, approval before
// activation, the two-click activation that says ZTech will send by itself, the unknown-outcome
// confirmation, Pause all, and that nothing in the block can send.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const LI = path.join(root, 'src', 'main', 'lead-intelligence');
const rendererSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'renderer.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const { registerSequenceIpc } = require(path.join(LI, 'sequences', 'sequence-ipc.js'));
const h = require('./f28-harness');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const START = '// === F28 Follow-ups: sequences of approved follow-up emails ===';
const END = '// === END F28 Follow-ups ===';
const block = rendererSource.slice(rendererSource.indexOf(START), rendererSource.indexOf(END));
const code = block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const TRUST_EL = (() => { const i = rendererSource.indexOf('function trustEl('); return rendererSource.slice(i, rendererSource.indexOf('\n}\n', i) + 3); })();

class FakeEl {
  constructor(tag, id) { this.tagName = String(tag).toUpperCase(); this.id = id || ''; this.children = []; this.attributes = {}; this.listeners = {}; this.className = ''; this.disabled = false; this.type = ''; this.value = ''; this.checked = false; this.selected = false; this._text = ''; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  set innerHTML(v) { throw new Error('innerHTML must not be used'); }
  appendChild(c) { this.children.push(c); return c; }
  append(...cs) { cs.forEach((c) => this.appendChild(c)); }
  replaceChildren(...cs) { this.children = []; this._text = ''; cs.forEach((c) => this.appendChild(c)); }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  fire(t) { for (const fn of this.listeners[t] || []) fn({}); }
  all() { return this.children.flatMap((c) => [c, ...c.all()]); }
}

const settle = async () => { for (let i = 0; i < 30; i += 1) await new Promise((r) => setImmediate(r)); };

async function env() {
  const s = await h.setup();
  const handlers = {};
  registerSequenceIpc({ ipcMain: { handle: (c, f) => { handlers[c] = f; } }, sequences: s.sequences, isTrustedSender: () => true, logger: { warn() {} } });
  const calls = [];
  const call = (channel) => async (payload) => { calls.push([channel, payload]); return handlers[channel]({}, payload || {}); };
  const wrap = (name, fn) => async (p) => { calls.push([name, p]); try { return { ok: true, data: await fn(p) }; } catch (e) { return { ok: false, error: { code: e.code, message: e.message } }; } };
  const bridge = {
    sequences: {
      create: call('lead-intel:sequence-create'), forLead: call('lead-intel:sequence-for-lead'), list: call('lead-intel:sequence-list'),
      activate: call('lead-intel:sequence-activate'), pause: call('lead-intel:sequence-pause'), resume: call('lead-intel:sequence-resume'),
      stop: call('lead-intel:sequence-stop'), setPauseAll: call('lead-intel:sequence-pause-all'),
    },
    pitch: { update: wrap('pitch.update', (p) => s.li.outreach.update({ pitchId: p.pitchId, edits: { opening: p.opening, callToAction: p.callToAction } })) },
    outreach: { approve: wrap('outreach.approve', (p) => s.li.outreach.approve({ pitchId: p.pitchId })) },
  };
  const els = {};
  const nav = new FakeEl('button');
  const document = {
    getElementById: (id) => { if (!els[id]) els[id] = new FakeEl('div', id); return els[id]; },
    createElement: (t) => new FakeEl(t),
    querySelector: (q) => (q === '.nav-item[data-view="outreach"]' ? nav : null),
  };
  const window = { ztechLeadIntel: bridge };
  const ui = new Function('document', 'window', 'leadDrawerLeadIdRef',
    `let leadDrawerLeadId = null;\n${TRUST_EL}\n${block}\nreturn { load: (id) => { leadDrawerLeadId = id; return loadLeadSequence(id); }, list: f28ListLoad, get lead() { return f28Lead; } };`)(document, window);
  const drawer = () => els['lead-drawer-sequence'];
  const panel = () => els['f28-followups'];
  const button = (host, label) => host.all().find((e) => e.tagName === 'BUTTON' && e.textContent === label) || null;
  return { s, ui, calls, drawer, panel, button, nav };
}

test('U1. drawer: "Add follow-ups" drafts a sequence; each step shows its text, and Activate waits for every approval', async () => {
  const e = await env();
  await h.firstEmail(e.s);
  await e.ui.load('L1');
  assert.ok(/No follow-ups/.test(e.drawer().textContent));
  e.button(e.drawer(), 'Add follow-ups').fire('click');
  await settle();
  const create = e.calls.find((c) => c[0] === 'lead-intel:sequence-create');
  assert.deepStrictEqual(create[1], { leadId: 'L1', delays: [3, 7, 14] }, 'the renderer names the lead and the plan only');
  const text = e.drawer().textContent;
  assert.ok(/Draft\. Approve every follow-up, then activate\. Once active, ZTech sends each one by itself/.test(text));
  assert.ok(/Follow-up 1 of 3/.test(text) && /Follow-up 3 of 3/.test(text));
  assert.ok(/Re: A few notes on www\.acme\.example\.com/.test(text));
  assert.ok(!text.includes(h.LEAD_EMAIL), 'no address is shown from the sequence view');
  assert.strictEqual(e.button(e.drawer(), 'Activate follow-ups').disabled, true);
  for (let i = 0; i < 3; i += 1) { e.button(e.drawer(), 'Approve').fire('click'); await settle(); }
  const activate = e.button(e.drawer(), 'Activate follow-ups');
  assert.strictEqual(activate.disabled, false);
  activate.fire('click');
  assert.ok(/ZTech will then send these 3 follow-up\(s\) by itself/.test(e.drawer().textContent), 'activation says plainly that ZTech sends by itself');
  e.button(e.drawer(), 'Yes, activate').fire('click');
  await settle();
  assert.ok(/Active\. Next: follow-up 1 of 3/.test(e.drawer().textContent));
  assert.strictEqual(h.sendCalls(e.s.gmail).length, 1, 'activation itself sends nothing');
});

test('U2. editing a step goes through pitch.update and needs a fresh approval', async () => {
  const e = await env();
  await h.approvedSequence(e.s);
  await e.ui.load('L1');
  e.button(e.drawer(), 'Edit').fire('click');
  const areas = e.drawer().all().filter((x) => x.tagName === 'TEXTAREA');
  assert.strictEqual(areas.length, 2);
  areas[1].value = 'Is a call next week useful?';
  e.button(e.drawer(), 'Save').fire('click');
  await settle();
  const upd = e.calls.find((c) => c[0] === 'pitch.update');
  assert.deepStrictEqual(Object.keys(upd[1]).sort(), ['callToAction', 'opening', 'pitchId']);
  assert.ok(/Saved\. Approve it again/.test(e.drawer().textContent));
  assert.ok(/Not approved/.test(e.drawer().textContent));
});

test('U3. an unknown outcome needs the "NOT sent" confirmation before Resume; Resume sends confirmNotSent', async () => {
  const e = await env();
  await h.approvedSequence(e.s);
  await e.s.sequences.activate({ sequenceId: (await e.s.sequences.forLead({ leadId: 'L1' })).sequenceId });
  e.s.gmail.next = [{ throw: true }];
  e.s.advance(3 * h.DAY + 1000);
  await e.s.scheduler.tick();
  await e.ui.load('L1');
  assert.ok(/could not tell whether Gmail sent/.test(e.drawer().textContent));
  assert.strictEqual(e.button(e.drawer(), 'Resume').disabled, true);
  const box = e.drawer().all().find((x) => x.tagName === 'INPUT');
  box.checked = true;
  box.fire('change');
  assert.strictEqual(e.button(e.drawer(), 'Resume').disabled, false);
  e.button(e.drawer(), 'Resume').fire('click');
  await settle();
  const resume = e.calls.find((c) => c[0] === 'lead-intel:sequence-resume');
  assert.strictEqual(resume[1].confirmNotSent, true);
});

test('U4. Stop needs a second click and is final; the Outreach list shows open sequences and the Pause all switch', async () => {
  const e = await env();
  await h.approvedSequence(e.s);
  await e.s.sequences.activate({ sequenceId: (await e.s.sequences.forLead({ leadId: 'L1' })).sequenceId });
  e.nav.fire('click');
  await settle();
  assert.ok(/Acme Bakery/.test(e.panel().textContent), 'the list names the lead');
  assert.ok(/Follow-up 1 of 3/.test(e.panel().textContent));
  e.button(e.panel(), 'Pause all follow-ups').fire('click');
  await settle();
  assert.deepStrictEqual(e.calls.find((c) => c[0] === 'lead-intel:sequence-pause-all')[1], { paused: true });
  assert.ok(/All follow-ups are paused/.test(e.panel().textContent));
  assert.ok(e.button(e.panel(), 'Resume all follow-ups'));
  await e.ui.load('L1');
  e.button(e.drawer(), 'Stop sequence').fire('click');
  assert.ok(/Stop these follow-ups for good\?/.test(e.drawer().textContent));
  e.button(e.drawer(), 'Yes, stop').fire('click');
  await settle();
  assert.ok(/Stopped for good: you stopped it/.test(e.drawer().textContent));
});

test('U5. static: the block cannot send, uses no innerHTML, reaches only the sequence bridge plus pitch.update / outreach.approve', () => {
  for (const banned of [/innerHTML/, /outreachSend/, /sendFromMailbox/, /ipcRenderer/, /require\s*\(/, /\bfetch\s*\(/, /setInterval|setTimeout/]) {
    assert.ok(!banned.test(code), 'the F28 block must not contain ' + banned);
  }
  const calls = [...code.matchAll(/(?:bridge|api)\.(\w+(?:\.\w+)?)\(/g)].map((m) => m[1]);
  assert.deepStrictEqual([...new Set(calls)].sort(), ['activate', 'create', 'forLead', 'list', 'outreach.approve', 'pause', 'pitch.update', 'resume', 'setPauseAll', 'stop'].sort());
  assert.ok(htmlSource.includes('id="lead-drawer-sequence"') && htmlSource.includes('id="f28-followups"'), 'both hosts exist');
  const view = htmlSource.slice(htmlSource.indexOf('<section class="view" id="view-outreach">'), htmlSource.indexOf('<section class="view" id="view-targets">'));
  assert.deepStrictEqual([...view.matchAll(/<button[^>]*>([^<]*)</g)].map((m) => m[1].trim()).sort(), ['Next', 'Previous', 'Refresh'], 'no static control was added to the Outreach view');
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
