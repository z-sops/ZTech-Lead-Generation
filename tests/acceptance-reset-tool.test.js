'use strict';

// Windows acceptance (8 Oct 2026): the only test Gmail address was marked "Unsubscribed" (global),
// so nothing could be sent to it. That is correct and stays correct INSIDE ZTech. This file tests
// the out-of-app, acceptance-only reset tool (tools/acceptance/reset-email-suppression.js) AND
// locks that the production app still has no way to reverse an unsubscribe.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const LI = path.join(root, 'src', 'main', 'lead-intelligence');
const { SqlJsStore } = require(path.join(LI, 'persistence', 'SqlJsStore.js'));
const { TrustService } = require(path.join(LI, 'trust', 'TrustService.js'));
const { registerTrustIpc, TRUST_CHANNELS_IPC } = require(path.join(LI, 'trust', 'trust-ipc.js'));
const TOOL_PATH = path.join(root, 'tools', 'acceptance', 'reset-email-suppression.js');
const tool = require(TOOL_PATH);

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const ADDR = 'tester.one@example.com';
const OTHER = 'tester.one+ztest1@example.com';
const PHONE = '+923001234567';
const SILENT = { info() {}, warn() {}, error() {}, debug() {} };
let nowMs = Date.parse('2026-10-08T12:00:00.000Z');
const clock = () => new Date(nowMs);

/** A ZTech-shaped database: the real li_* migrations plus a `numbers` lead table, like whatsapp.db. */
async function world() {
  const SQL = await require('sql.js')();
  const db = new SQL.Database();
  const store = new SqlJsStore({ db, logger: SILENT });
  await store.migrate();
  db.run('CREATE TABLE numbers (id TEXT PRIMARY KEY, phone TEXT, title TEXT, email TEXT, website TEXT)');
  db.run("INSERT INTO numbers VALUES ('L1', ?, 'ZTech Test Lead', ?, 'https://example.com')", [PHONE, ' Tester.One@Example.com ']);
  db.run("INSERT INTO numbers VALUES ('L2', '+923009999999', 'Other Lead', ?, 'https://other.example')", [OTHER]);
  const leadSource = {
    getLead: async (id) => {
      const r = db.exec('SELECT id, phone, title, email, website FROM numbers WHERE id = ?', [String(id)])[0];
      if (!r) return null;
      return Object.fromEntries(r.columns.map((c, i) => [c, r.values[0][i]]));
    },
    listLeads: async () => [],
  };
  const trust = new TrustService({ store, leadSource, clock, operator: 'Zee' });
  return { SQL, db, store, trust };
}

/** The real trust IPC over the real TrustService: what the production UI can reach. */
function ipc(trust) {
  const handlers = {};
  registerTrustIpc({ ipcMain: { handle: (c, f) => { handlers[c] = f; } }, trust, outreach: { handoff: async () => ({}) }, isTrustedSender: () => true, copyText: () => {}, logger: { warn() {} } });
  return { handlers, call: (ch, p) => handlers[ch]({}, p) };
}

async function unsubscribedWithEverything(w) {
  await w.trust.recordConsent({ leadId: 'L1', channel: 'email', method: 'website_form', consentedAt: '2026-10-08', evidenceNote: 'test opt-in' });
  await w.trust.suppressLead({ leadId: 'L1', channel: 'email', reason: 'unsubscribe' });
  await w.trust.suppressLead({ leadId: 'L1', channel: 'whatsapp', reason: 'manual', scope: 'global' });
  await w.trust.suppressLead({ leadId: 'L2', channel: 'email', reason: 'unsubscribe' });
}

/* ================= production: an unsubscribe stays irreversible ================= */

test('P1. through the standard UI path (trust IPC) an unsubscribe cannot be lifted, re-consented or overwritten', async () => {
  const w = await world();
  await w.trust.suppressLead({ leadId: 'L1', channel: 'email', reason: 'unsubscribe' });
  const { call } = ipc(w.trust);
  const view = await call(TRUST_CHANNELS_IPC.LEAD, { leadId: 'L1' });
  const sup = view.data.channels.email.suppression;
  assert.strictEqual(sup.reason, 'unsubscribe');
  assert.strictEqual(sup.removable, false, 'the UI is told it is not removable');
  const lift = await call(TRUST_CHANNELS_IPC.LIFT, { leadId: 'L1', channel: 'email', suppressionId: sup.id });
  assert.strictEqual(lift.ok, false);
  assert.strictEqual(lift.error.code, 'SUPPRESSION_NOT_REMOVABLE');
  assert.strictEqual(await w.store.suppressions.removeManual(sup.id), false, 'the store refuses too');
  // Suppressing again (any reason) never replaces it with something liftable.
  await call(TRUST_CHANNELS_IPC.SUPPRESS, { leadId: 'L1', channel: 'email', reason: 'manual', scope: 'global' });
  const after = (await call(TRUST_CHANNELS_IPC.LEAD, { leadId: 'L1' })).data.channels.email.suppression;
  assert.ok(after && after.reason === 'unsubscribe', 'still unsubscribed');
  // An opt-in recorded afterwards does not unlock sending: the suppression is checked first.
  await call(TRUST_CHANNELS_IPC.CONSENT, { leadId: 'L1', channel: 'email', method: 'website_form', consentedAt: '2026-10-08', evidenceNote: 'trying to undo it' });
  // ...and with no reply on record, no review can be entered to turn into permission.
  const review = await call(TRUST_CHANNELS_IPC.REVIEW, { leadId: 'L1', outcome: 'interested', replyReceivedAt: '2026-10-08T10:00:00.000Z' });
  assert.strictEqual(review.ok, false);
  const { TrustPolicy } = require(path.join(LI, 'trust', 'TrustPolicy.js'));
  const facts = await new TrustPolicy({ store: w.store, clock }).facts({ channel: 'email', recipient: ADDR });
  assert.ok(facts.suppression && facts.suppression.reason === 'unsubscribe');
});

test('P2. the app has no reset path: no channel, no preload method, no renderer control, and the tool is not shipped', () => {
  assert.deepStrictEqual(Object.keys(TRUST_CHANNELS_IPC).sort(), ['CONSENT', 'HANDOFF', 'LEAD', 'LIFT', 'REVIEW', 'SUPPRESS'].sort(), 'trust channels unchanged');
  const shipped = ['main.js', 'preload.js', 'index.html'].map((f) => fs.readFileSync(path.join(root, f), 'utf8'));
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(path.join(root, 'src')).filter((p) => /\.(js|html|sql)$/.test(p))) shipped.push(fs.readFileSync(f, 'utf8'));
  for (const text of shipped) {
    assert.ok(!/reset-email-suppression|ztech_acceptance_resets|ACCEPTANCE_RESET|tools[\\/]+acceptance/.test(text), 'nothing in the app references the reset tool');
  }
  assert.ok(!shipped.some((t) => /DELETE FROM li_suppressions(?![^"'`]*reason = 'manual')/.test(t)), 'the only suppression delete in the app is the manual-only lift');
  const files = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).build.files;
  assert.ok(files.every((g) => !/^tools|^\*\*|^\*$/.test(g)), `the packaged build does not include tools/: ${files}`);
});

/* ========================= the acceptance-only reset tool ========================= */

test('R1. reset: email unsubscribe + opt-in cleared, audit written, WhatsApp DNC and history kept, other address untouched; then opt-in can be recorded', async () => {
  const w = await world();
  await unsubscribedWithEverything(w);
  const eventsBefore = w.db.exec('SELECT count(*) FROM li_trust_events')[0].values[0][0];
  const plan = tool.planReset(w.db, { email: ' TESTER.ONE@example.com', leadId: 'L1' });
  assert.strictEqual(plan.ok, true);
  assert.deepStrictEqual(plan.leads.map((l) => l.id), ['L1']);
  assert.strictEqual(plan.suppressions.length, 1);
  assert.strictEqual(plan.consents.length, 1);
  const rec = tool.applyReset(w.db, plan, { now: clock() });
  assert.strictEqual(rec.kind, 'ACCEPTANCE_RESET');
  const audit = w.db.exec('SELECT kind, channel, normalized_address, lead_ids_json, removed_suppressions_json, removed_consents FROM ztech_acceptance_resets')[0].values;
  assert.strictEqual(audit.length, 1);
  assert.deepStrictEqual(audit[0].slice(0, 4), ['ACCEPTANCE_RESET', 'email', ADDR, '["L1"]']);
  assert.strictEqual(JSON.parse(audit[0][4])[0].reason, 'unsubscribe');
  assert.strictEqual(audit[0][5], 1);

  const v = await w.trust.leadTrust({ leadId: 'L1' });
  assert.strictEqual(v.channels.email.suppression, null, 'email no longer suppressed');
  assert.strictEqual(v.channels.email.consent, null, 'email shows "No opt-in recorded"');
  assert.strictEqual(v.channels.whatsapp.suppression.reason, 'manual', 'WhatsApp do-not-contact untouched');
  assert.strictEqual((await w.trust.leadTrust({ leadId: 'L2' })).channels.email.suppression.reason, 'unsubscribe', 'another address (even the +alias) untouched');
  assert.strictEqual(w.db.exec('SELECT count(*) FROM li_trust_events')[0].values[0][0], eventsBefore, 'the unsubscribe event stays in the history');

  // The person records the opt-in explicitly; nothing was recorded for them.
  const after = await w.trust.recordConsent({ leadId: 'L1', channel: 'email', method: 'website_form', consentedAt: '2026-10-08', evidenceNote: 'acceptance test opt-in' });
  assert.strictEqual(after.channels.email.consent.method, 'website_form');
});

test('R2. the renderer shows "No opt-in recorded" for the reset lead (real trust UI block over the real IPC)', async () => {
  const w = await world();
  await unsubscribedWithEverything(w);
  tool.applyReset(w.db, tool.planReset(w.db, { email: ADDR }), { now: clock() });
  const { call } = ipc(w.trust);
  const api = { forLead: (p) => call(TRUST_CHANNELS_IPC.LEAD, p), suppress: () => {}, lift: () => {}, recordConsent: () => {}, handoff: () => {}, reviewReply: () => {} };
  const src = fs.readFileSync(path.join(root, 'src', 'renderer', 'renderer.js'), 'utf8');
  const block = src.slice(src.indexOf('// === F26.5 Trust: consent, do-not-contact, provenance and the mail-app handoff ==='), src.indexOf('// === END F26.5 Trust ==='));
  class El {
    constructor(t, id) { this.tagName = String(t).toUpperCase(); this.id = id || ''; this.children = []; this.attributes = {}; this.listeners = {}; this.className = ''; this.disabled = false; this.value = ''; this._text = ''; }
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
    set textContent(x) { this._text = String(x); this.children = []; }
    appendChild(c) { this.children.push(c); return c; }
    append(...cs) { cs.forEach((c) => this.appendChild(c)); }
    replaceChildren(...cs) { this.children = []; this._text = ''; cs.forEach((c) => this.appendChild(c)); }
    setAttribute(k, x) { this.attributes[k] = String(x); }
    getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; }
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
    all() { return this.children.flatMap((c) => [c, ...c.all()]); }
  }
  const reg = new Map();
  const document = { getElementById(id) { if (!reg.has(id)) reg.set(id, new El('div', id)); return reg.get(id); }, createElement: (t) => new El(t) };
  const ui = new Function('document', 'window', `let leadDrawerLeadId = "L1";\n${block}\nreturn { load: loadLeadTrust };`)(document, { ztechLeadIntel: { trust: api } });
  await ui.load('L1');
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r));
  const text = document.getElementById('lead-drawer-trust').textContent;
  assert.ok(text.includes('No opt-in recorded. A first email'), text.slice(0, 400));
  assert.ok(!/Unsubscribed/.test(text.split('WhatsApp')[0]), 'the email line no longer says Unsubscribed');
});

test('R3. refusals: bad address, not a lead contact, wrong lead, nothing to do; a dry run changes nothing', async () => {
  const w = await world();
  await unsubscribedWithEverything(w);
  assert.strictEqual(tool.planReset(w.db, { email: 'not-an-email' }).code, 'BAD_EMAIL');
  assert.strictEqual(tool.planReset(w.db, { email: 'stranger@example.com' }).code, 'NOT_A_LEAD_CONTACT');
  assert.strictEqual(tool.planReset(w.db, { email: ADDR, leadId: 'L2' }).code, 'LEAD_MISMATCH');
  const plan = tool.planReset(w.db, { email: ADDR });
  assert.strictEqual(w.db.exec("SELECT count(*) FROM li_suppressions WHERE channel = 'email'")[0].values[0][0], 2, 'planning writes nothing');
  tool.applyReset(w.db, plan, { now: clock() });
  const again = tool.planReset(w.db, { email: ADDR });
  assert.strictEqual(again.nothingToDo, true);
  assert.throws(() => tool.applyReset(w.db, again), /nothing to reset/);
  const SQL = w.SQL;
  assert.strictEqual(tool.planReset(new SQL.Database(), { email: ADDR }).code, 'NOT_A_ZTECH_DB');
});

test('R4. CLI on a database file: dry run by default, exact confirm required, refuses while ZTech runs, backup + atomic write', async () => {
  const w = await world();
  await unsubscribedWithEverything(w);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ztech-reset-'));
  const file = path.join(dir, 'whatsapp.db');
  fs.writeFileSync(file, Buffer.from(w.db.export()));
  const original = fs.readFileSync(file);
  const run = async (argv, running = false) => {
    const lines = [];
    const code = await tool.main(argv, { log: (l) => lines.push(l), env: {}, running: () => running, initSqlJs: () => require('sql.js')() });
    return { code, out: lines.join('\n') };
  };
  let r = await run(['--db', file, '--email', ADDR]);
  assert.strictEqual(r.code, 0);
  assert.ok(/DRY RUN/.test(r.out) && /Email suppressions to remove: 1/.test(r.out));
  assert.ok(/^Address: te…e@example\.com - on 1 lead\(s\): L1$/m.test(r.out), 'the summary line masks the address');
  assert.ok(fs.readFileSync(file).equals(original), 'dry run wrote nothing');
  r = await run(['--db', file, '--email', ADDR, '--apply', '--confirm', 'RESET'], false);
  assert.strictEqual(r.code, 5);
  assert.ok(fs.readFileSync(file).equals(original));
  r = await run(['--db', file, '--email', ADDR, '--apply', '--confirm', `RESET ${ADDR}`], true);
  assert.strictEqual(r.code, 3, 'refuses while ZTech runs');
  assert.ok(fs.readFileSync(file).equals(original));
  r = await run(['--db', file, '--email', ADDR, '--apply', '--confirm', `RESET ${ADDR}`]);
  assert.strictEqual(r.code, 0, r.out);
  const backups = fs.readdirSync(dir).filter((f) => f.startsWith('whatsapp.db.bak-acceptance-reset-'));
  assert.strictEqual(backups.length, 1);
  assert.ok(fs.readFileSync(path.join(dir, backups[0])).equals(original), 'the backup is the previous database');
  assert.ok(!fs.existsSync(`${file}.acceptance-reset.tmp`));
  const SQL = await require('sql.js')();
  const after = new SQL.Database(fs.readFileSync(file));
  assert.strictEqual(after.exec("SELECT count(*) FROM li_suppressions WHERE channel = 'email' AND normalized_address = ?", [ADDR])[0].values[0][0], 0);
  assert.strictEqual(after.exec("SELECT count(*) FROM li_suppressions WHERE channel = 'whatsapp'")[0].values[0][0], 1);
  assert.strictEqual(after.exec('SELECT count(*) FROM ztech_acceptance_resets')[0].values[0][0], 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('R5. the tool never opens the settings file (mailbox connection, tokens, Google client)', () => {
  const src = fs.readFileSync(TOOL_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/electron-store|config\.json|mailboxTokens|mailboxOAuth|credentialVault|safeStorage|li_mailbox|whatsapp'\s+AND|channel = 'whatsapp'/i.test(src));
  assert.ok(/channel = 'email' AND normalized_address = \?/.test(src));
});

test('R6. running-app detection on Windows: dev, packaged (even garbled), unknown = refuse', () => {
  const exec = (out) => () => out;
  assert.strictEqual(tool.ztechRunning(exec('svchost\r\nelectron\r\nexplorer\r\n'), 'win32'), true, 'npm start');
  assert.strictEqual(tool.ztechRunning(exec('explorer\r\nphone全球获客\r\n'), 'win32'), true, 'packaged');
  assert.strictEqual(tool.ztechRunning(exec('explorer\r\nphone????\r\n'), 'win32'), true, 'packaged, garbled');
  assert.strictEqual(tool.ztechRunning(exec('Code\r\nclaude\r\nchrome\r\nelectronic-thing\r\nmyphone\r\n'), 'win32'), false, 'similar names are not ZTech');
  assert.strictEqual(tool.ztechRunning(() => { throw new Error('no powershell'); }, 'win32'), true, 'cannot check = refuse');
});

test('R7. an address with reply history is refused (a reviewed reply can itself allow emailing)', async () => {
  const w = await world();
  await unsubscribedWithEverything(w);
  w.db.run("INSERT INTO li_trust_events (row_id, event_id, kind, channel, normalized_address, source, state, received_at, recorded_at) VALUES ('r1', 'e1', 'reply', 'email', ?, 'relay', 'stored', '2026-10-08T10:00:00.000Z', '2026-10-08T10:00:00.000Z')", [ADDR]);
  const plan = tool.planReset(w.db, { email: ADDR });
  assert.strictEqual(plan.code, 'REPLY_HISTORY');
  assert.ok(/Gmail \+alias/.test(plan.message));
  assert.throws(() => tool.applyReset(w.db, plan), /not valid/);
  // a rejected (forged) reply row does not count
  const w2 = await world();
  await unsubscribedWithEverything(w2);
  w2.db.run("INSERT INTO li_trust_events (row_id, event_id, kind, channel, normalized_address, source, state, reject_code, received_at, recorded_at) VALUES ('r1', 'e1', 'reply', 'email', ?, 'relay', 'rejected', 'BAD_SIGNATURE', '2026-10-08T10:00:00.000Z', '2026-10-08T10:00:00.000Z')", [ADDR]);
  assert.strictEqual(tool.planReset(w2.db, { email: ADDR }).ok, true);
});

test('R8. database choice: two ZTech databases or no APPDATA means --db is required', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ztech-appdata-'));
  for (const n of ['phone-global-leads', 'phone全球获客']) { fs.mkdirSync(path.join(dir, n, 'data'), { recursive: true }); fs.writeFileSync(path.join(dir, n, 'data', 'whatsapp.db'), ''); }
  const lines = [];
  const code = await tool.main(['--email', ADDR], { log: (l) => lines.push(l), env: { APPDATA: dir }, running: () => false, initSqlJs: () => require('sql.js')() });
  assert.strictEqual(code, 2);
  assert.ok(/More than one ZTech database/.test(lines.join('\n')));
  const l2 = [];
  assert.strictEqual(await tool.main(['--email', ADDR], { log: (l) => l2.push(l), env: {}, running: () => false, initSqlJs: () => require('sql.js')() }), 2);
  fs.rmSync(dir, { recursive: true, force: true });
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
