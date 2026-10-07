'use strict';

// F26.5 - renderer controls (lock item 12): consent, do-not-contact, provenance and the
// mail-app handoff. The REAL renderer block runs against a DOM double; its bridge is wired to
// the REAL trust IPC handlers over the REAL TrustService / OutreachService (f265 harness).

const fs = require('fs');
const path = require('path');
const assert = require('assert');

globalThis.fetch = async () => { throw new Error('F26.5 TEST GUARD: real network is forbidden'); };

const root = path.join(__dirname, '..');
const rendererSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'renderer.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const { registerTrustIpc, TRUST_CHANNELS_IPC } = require(path.join(root, 'src', 'main', 'lead-intelligence', 'trust', 'trust-ipc.js'));
const { grantTrust } = require('./trust-fixture');
const { NOW, LEAD_EMAIL, LEAD_PHONE, runtime, approved, iso } = require('./f265-harness');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const START = '// === F26.5 Trust: consent, do-not-contact, provenance and the mail-app handoff ===';
const END = '// === END F26.5 Trust ===';
const block = rendererSource.slice(rendererSource.indexOf(START), rendererSource.indexOf(END));
const code = block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

class FakeEl {
  constructor(tag, id) { this.tagName = String(tag).toUpperCase(); this.id = id || ''; this.children = []; this.attributes = {}; this.listeners = {}; this.className = ''; this.disabled = false; this.type = ''; this.value = ''; this._text = ''; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  set innerHTML(v) { throw new Error('innerHTML must not be used'); }
  appendChild(c) { this.children.push(c); return c; }
  append(...cs) { cs.forEach((c) => this.appendChild(c)); }
  replaceChildren(...cs) { this.children = []; this._text = ''; cs.forEach((c) => this.appendChild(c)); }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  click() { for (const fn of this.listeners.click || []) fn({}); }
  all() { return this.children.flatMap((c) => [c, ...c.all()]); }
}

/** The real IPC handlers over a real runtime; the bridge records every payload it sends. */
function mainSide(opts = {}) {
  const rt = runtime(opts);
  const handlers = {};
  const copied = [];
  registerTrustIpc({ ipcMain: { handle: (c, f) => { handlers[c] = f; } }, trust: rt.li.trust, outreach: rt.li.outreach, isTrustedSender: () => true, copyText: (t) => copied.push(t), logger: { warn() {} } });
  const sent = [];
  const inv = (ch) => (p) => { sent.push({ ch, p }); return handlers[ch]({}, p); };
  const api = { forLead: inv(TRUST_CHANNELS_IPC.LEAD), suppress: inv(TRUST_CHANNELS_IPC.SUPPRESS), lift: inv(TRUST_CHANNELS_IPC.LIFT), recordConsent: inv(TRUST_CHANNELS_IPC.CONSENT), handoff: inv(TRUST_CHANNELS_IPC.HANDOFF) };
  return { ...rt, api, sent, copied };
}

function makeUi(api, leadId = 'L1') {
  const reg = new Map();
  const document = {
    getElementById(id) {
      for (const root of reg.values()) { const hit = [root, ...root.all()].find((n) => n.id === id); if (hit) return hit; }
      reg.set(id, new FakeEl('div', id));
      return reg.get(id);
    },
    createElement(tag) { return new FakeEl(tag); },
  };
  const ui = new Function('document', 'window', `let leadDrawerLeadId = ${JSON.stringify(leadId)};\n${block}\n`
    + 'return { load: loadLeadTrust, reset: resetLeadTrust, handoffControls: f265HandoffControls, get state() { return leadTrust; } };')(
    document, { ztechLeadIntel: api ? { trust: api } : {} });
  const host = document.getElementById('lead-drawer-trust');
  const nodes = () => host.all();
  const btn = (label, channel) => {
    const scope = channel ? nodes().find((n) => n.getAttribute('data-channel') === channel) : host;
    return scope.all().find((n) => n.tagName === 'BUTTON' && n.textContent === label) || null;
  };
  return { ui, host, text: () => host.textContent, btn, nodes, document };
}
const flush = async () => { for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r)); };

test('12a. markup + code rules: own section in Overview, textContent only, no timers, only the trust bridge', () => {
  const overview = htmlSource.slice(htmlSource.indexOf('id="lead-panel-overview"'), htmlSource.indexOf('id="lead-panel-research"'));
  assert.ok(overview.includes('id="lead-drawer-trust"'));
  assert.ok(block.length > 1000 && rendererSource.indexOf(END) > rendererSource.indexOf(START));
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML|document\.write/.test(code));
  assert.ok(!/setInterval|setTimeout/.test(code));
  const calls = [...new Set([...code.matchAll(/bridge(?:\[method\]|\.(\w+))\(/g)].map((m) => m[1] || '[method]'))].sort();
  assert.deepStrictEqual(calls, ['[method]', 'forLead', 'handoff']);
  assert.ok(/trustAct\('(suppress|lift|recordConsent)'/.test(code));
  assert.ok(!/\.(send|outreachSend|approve)\(/.test(code), 'the block never sends or approves');
  assert.ok(!/replied/i.test(code.replace(/Replied \(verified\)/g, '')), 'no "they replied" control exists');
});

test('12b. an empty lead shows honest states; nothing is written by reading', async () => {
  const m = mainSide();
  const u = makeUi(m.api);
  await u.ui.load('L1');
  await flush();
  const t = u.text();
  assert.ok(t.includes('Consent & do-not-contact'));
  assert.ok(t.includes('No opt-in recorded. A first email goes out from your own mail app.'));
  assert.ok(t.includes('No opt-in recorded. WhatsApp stays locked until the contact opts in.'));
  assert.deepStrictEqual(m.sent.map((s) => s.ch), [TRUST_CHANNELS_IPC.LEAD]);
  assert.strictEqual((await m.store.suppressions.list()).total, 0);
});

test('12c. "Mark unsubscribed" asks once more, then suppresses; it offers no undo', async () => {
  const m = mainSide();
  const u = makeUi(m.api);
  await u.ui.load('L1');
  await flush();
  u.btn('Mark unsubscribed', 'email').click();
  assert.ok(u.text().includes('This cannot be undone here.'));
  assert.strictEqual(m.sent.length, 1, 'the first click writes nothing');
  u.btn('Yes, unsubscribe', 'email').click();
  await flush();
  assert.deepStrictEqual(m.sent[1], { ch: TRUST_CHANNELS_IPC.SUPPRESS, p: { leadId: 'L1', channel: 'email', reason: 'unsubscribe' } });
  assert.ok(u.text().includes('Unsubscribed · all workspaces'));
  assert.ok(u.text().includes('Marked as unsubscribed.'));
  assert.strictEqual(u.btn('Remove do-not-contact', 'email'), null);
  assert.ok((await m.store.suppressions.find({ channel: 'email', address: LEAD_EMAIL })));
});

test('12d. "Do not contact" can be removed again by the person', async () => {
  const m = mainSide();
  const u = makeUi(m.api);
  await u.ui.load('L1');
  await flush();
  u.btn('Do not contact', 'whatsapp').click();
  await flush();
  assert.ok(u.text().includes('Do not contact · all workspaces'));
  u.btn('Remove do-not-contact', 'whatsapp').click();
  await flush();
  assert.strictEqual(await m.store.suppressions.find({ channel: 'whatsapp', address: LEAD_PHONE }), null);
  const lift = m.sent.find((s) => s.ch === TRUST_CHANNELS_IPC.LIFT);
  assert.deepStrictEqual(Object.keys(lift.p).sort(), ['channel', 'leadId', 'suppressionId']);
});

test('12e. Record opt-in: email offers no "they messaged us first"; the saved consent shows method, date, recorder and evidence', async () => {
  const m = mainSide();
  const u = makeUi(m.api);
  await u.ui.load('L1');
  await flush();
  u.document.getElementById('lead-drawer-trust');
  u.btn('Record opt-in', 'email').click();
  const emailSelect = u.document.getElementById('lead-trust-method-email');
  assert.deepStrictEqual(emailSelect.children.map((o) => o.value), ['website_form', 'in_person', 'other']);
  u.btn('Record opt-in', 'whatsapp').click();
  const waSelect = u.document.getElementById('lead-trust-method-whatsapp');
  assert.ok(waSelect.children.some((o) => o.value === 'inbound_message'), 'WhatsApp may record an inbound opt-in (Meta allows it)');
  waSelect.value = 'in_person';
  u.document.getElementById('lead-trust-date-whatsapp').value = '2026-10-06';
  u.document.getElementById('lead-trust-note-whatsapp').value = 'Asked us to WhatsApp the audit at the expo';
  u.btn('Save opt-in', 'whatsapp').click();
  await flush();
  const call = m.sent.find((s) => s.ch === TRUST_CHANNELS_IPC.CONSENT);
  assert.deepStrictEqual(call.p, { leadId: 'L1', channel: 'whatsapp', method: 'in_person', consentedAt: '2026-10-06', evidenceNote: 'Asked us to WhatsApp the audit at the expo' });
  const t = u.text();
  assert.ok(t.includes('Opted in: In person'));
  assert.ok(t.includes('recorded by local-user'));
  assert.ok(t.includes('Evidence: Asked us to WhatsApp the audit at the expo'));
});

test('12f. a refused save shows the main process\'s message and keeps the form', async () => {
  const m = mainSide();
  const u = makeUi(m.api);
  await u.ui.load('L1');
  await flush();
  u.btn('Record opt-in', 'email').click();
  u.document.getElementById('lead-trust-note-email').value = 'x';
  u.btn('Save opt-in', 'email').click();
  await flush();
  assert.ok(/Invalid|evidence|at least/i.test(u.text()), u.text());
  assert.ok(u.document.getElementById('lead-trust-method-email'), 'the form is still there');
});

test('12g. nothing the renderer shows or sends carries an address, a ref, a hash or a token', async () => {
  const m = mainSide();
  await grantTrust(m.store, { email: LEAD_EMAIL, phone: LEAD_PHONE, now: iso(NOW) });
  await m.li.trust.captureSave({ rows: [{ phone: LEAD_PHONE, email: LEAD_EMAIL }], providerId: 'coreclaw', runSlug: 'run-7' });
  const u = makeUi(m.api);
  await u.ui.load('L1');
  await flush();
  const t = u.text();
  assert.ok(t.includes('Where these details came from'));
  assert.ok(t.includes('Email: Collection run · coreclaw/run-7'));
  assert.ok(!t.includes(LEAD_EMAIL) && !t.includes(LEAD_PHONE) && !/rref_|sup_[0-9a-f-]{8}|[a-f0-9]{40}/.test(t), t);
  const allowed = new Set(['leadId', 'channel', 'reason', 'scope', 'suppressionId', 'method', 'consentedAt', 'evidenceNote', 'pitchId', 'kind']);
  for (const s of m.sent) for (const k of Object.keys(s.p)) assert.ok(allowed.has(k), 'payload key ' + k);
});

test('12h. a late answer for another lead is dropped; without the bridge the block says so', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const u = makeUi({ forLead: async () => { await gate; return { ok: true, data: { channels: { email: { available: true, consent: { method: 'other', consentedAt: iso(NOW), recordedBy: 'LATE', evidenceNote: 'LATE' } } }, provenance: [] } }; } });
  const p = u.ui.load('L1');
  u.ui.reset();
  release();
  await p;
  await flush();
  assert.ok(!u.text().includes('LATE'));
  const off = makeUi(null);
  await off.ui.load('L1');
  assert.ok(off.text().includes('not available in this build'));
});

test('12i. Prepare handoff: Copy goes to main (clipboard there), the result says it was not sent, and the header limit is stated', async () => {
  const m = mainSide();
  const pitch = await approved(m.li);
  const u = makeUi(m.api);
  const footer = new FakeEl('div', 'f18-prepare-footer');
  u.ui.handoffControls(footer, pitch.pitch_id);
  const labels = footer.all().filter((n) => n.tagName === 'BUTTON').map((n) => n.textContent);
  assert.deepStrictEqual(labels, ['Open in my mail app', 'Copy text']);
  assert.ok(footer.textContent.includes('ZTech cannot add the unsubscribe headers'));
  assert.ok(footer.textContent.includes('Temporary option'), 'C1 revision: the handoff is labelled a temporary fallback');
  footer.all().find((n) => n.textContent === 'Copy text').click();
  await flush();
  assert.deepStrictEqual(m.sent.at(-1), { ch: TRUST_CHANNELS_IPC.HANDOFF, p: { pitchId: pitch.pitch_id, kind: 'copy' } });
  assert.strictEqual(m.copied.length, 1, 'the main process wrote the clipboard');
  assert.ok(m.copied[0].includes('Reply "unsubscribe"'));
  const again = new FakeEl('div', 'f18-prepare-footer');
  u.ui.handoffControls(again, pitch.pitch_id);
  assert.ok(again.textContent.includes(`Copied. Paste it into a new email to ${LEAD_EMAIL}`));
  assert.ok(!/\bsent\b(?! it)/i.test(again.textContent.replace('cannot see whether you send it', '')), 'nothing claims it was sent');
  assert.strictEqual(m.emailSpy.calls.length, 0);
});

test('12j. the Prepare footer hides the send control when trust refuses, and offers the handoff for email only', () => {
  const footerFn = rendererSource.slice(rendererSource.indexOf('function f18PrepareRenderFooter()'), rendererSource.indexOf('async function f18PrepareLoad()'));
  assert.ok(/const canSend = Boolean\(delivery && delivery\.canSend\) && !trustBlocks;/.test(footerFn));
  assert.ok(/if \(trust && trust\.handoffAvailable === true && !isWhatsApp && data && data\.pitchId\) f265HandoffControls\(footer, data\.pitchId\);/.test(footerFn));
  assert.ok(footerFn.indexOf('trustBlocks && !result') > footerFn.indexOf("'Send this WhatsApp' : 'Send this email'"), 'the refusal replaces the control, it does not sit beside it');
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
