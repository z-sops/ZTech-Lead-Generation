'use strict';

// Outreach read model (Windows acceptance, 15 Oct 2026).
//
// Observed: ZTech Test Lead - Gmail mailbox Ready, first email and follow-up 1 accepted by Gmail,
// follow-up 2 scheduled, sequence Active - yet the Outreach table said
//   Pitch status "Draft" | Gate "Allowed" | "Ready for outreach - delivery provider not configured".
// Root cause: the table explained an allowed pitch only through gate.delivery, which describes the
// transactional-provider (Resend) configuration. Since F26.6 cold email leaves from the user's own
// mailbox, which the table never read; and the stored pitch status is the CONTENT lifecycle
// (draft / insufficient_evidence / needs_revision), with approval and sends stored elsewhere.
//
// The fix is read-only: gateView() = gate() unchanged + `transport` (default mailbox state) +
// `sent` (accepted sends of the pitch). These tests pin that the facts are right AND that nothing
// that decides or sends changed.

const assert = require('assert');
const { implSource } = require('./lead-intelligence/impl');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const h = require('./f28-harness');
const { DAY, MBX, NOW, iso, setup, firstEmail, approvedSequence, sendCalls } = h;

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

/* ------------------------- the renderer's pure helpers, evaluated as shipped ------------------------- */

const src = fs.readFileSync(path.join(root, 'src', 'renderer', 'renderer.js'), 'utf8');
function slice(startMarker, endMarker) {
  const a = src.indexOf(startMarker);
  assert.ok(a > -1, 'renderer has ' + startMarker);
  const b = src.indexOf(endMarker, a);
  assert.ok(b > a, 'renderer has the end of ' + startMarker);
  return src.slice(a, b);
}
const helperSrc = [
  slice('function f12OutreachDate(', '\n}\n') + '\n}\n',
  slice('function f14DeliveryNote(', '\n}\n') + '\n}\n',
  slice('function f16ReadyDeliveryNote(', '\n}\n') + '\n}\n',
  slice('const OUTREACH_MAILBOX_STATUS_TEXT', 'function outreachPitchFactsNote('),
  slice('function outreachPitchFactsNote(', '\n}\n') + '\n}\n',
  'this.api = { f14DeliveryNote, f16ReadyDeliveryNote, outreachTransportNote, outreachPitchFactsNote };',
].join('\n');
const ctx = {};
vm.runInNewContext(helperSrc, ctx);
const R = ctx.api;

// The rows as the renderer composes them (same expressions as f12OutreachRow / f16ReadyRow).
const outreachReadyNote = (gate) => 'Ready for outreach — ' + (R.outreachTransportNote(gate.transport, gate.delivery) || R.f14DeliveryNote(gate.delivery));
const readyPageNote = (item) => R.outreachTransportNote(item && item.transport, item.gate.delivery) || R.f16ReadyDeliveryNote(item.gate.delivery);

const viewOf = async (s, pitchId) => s.li.outreach.gateView({ pitchId, channel: 'email' });
const strip = (v) => { const { transport, sent, ...rest } = v; return rest; };

/* ============================================ tests ============================================ */

test('1. Gmail Ready + approved pitch + accepted send: no "delivery provider not configured"; the row says Ready mailbox and sent', async () => {
  const s = await setup();
  const { pitch } = await firstEmail(s);
  const v = await viewOf(s, pitch.pitch_id);
  assert.strictEqual(v.decision, 'allowed');
  // As on the acceptance machine: no transactional (Resend) provider configured. The harness has a
  // fake one, so the block is set to the "not configured" shape the real app reported.
  v.delivery = { ...v.delivery, canSend: false, providerConfigured: false, emailEnabled: false };
  assert.ok(/not configured/.test(R.f14DeliveryNote(v.delivery)), 'the legacy block alone would say not configured');
  assert.deepStrictEqual(
    { connected: v.transport.connected, provider: v.transport.provider, status: v.transport.status, ready: v.transport.ready },
    { connected: true, provider: 'gmail', status: 'ready', ready: true });
  assert.strictEqual(v.sent.accepted, 1);
  assert.strictEqual(v.sent.providerId, 'gmail');
  const note = outreachReadyNote(v);
  assert.ok(!/not configured/i.test(note), note);
  assert.ok(/Gmail mailbox \(Ready\)/.test(note), note);
  const facts = R.outreachPitchFactsNote({ ok: true, gate: v });
  assert.ok(/^Approved content sent - accepted by Gmail on \d\d\/\d\d\/\d{4}\.$/.test(facts), facts);
  // the Ready page uses the same fact
  const page = await s.li.outreach.ready({});
  const found = page.rows.find((r) => r.pitch.pitch_id === pitch.pitch_id);
  assert.ok(found && found.transport && found.transport.ready === true);
  const row = { ...found, gate: { ...found.gate, delivery: v.delivery } };
  assert.ok(!/not configured/i.test(readyPageNote(row)), readyPageNote(row));
});

test('2. no Gmail mailbox and no provider: the correct not-configured message (not a Ready claim)', async () => {
  const s = await setup();
  const { pitch } = await firstEmail(s);
  await s.store.mailboxes.remove(MBX);
  const v = await viewOf(s, pitch.pitch_id);
  v.delivery = { ...v.delivery, canSend: false, providerConfigured: false, emailEnabled: false }; // no Resend either
  assert.strictEqual(v.transport.connected, false);
  const note = outreachReadyNote(v);
  assert.ok(/No sending mailbox connected/.test(note) && !/Ready\)/.test(note), note);
  // a process without any mailbox service keeps the earlier provider sentence exactly
  assert.strictEqual(R.outreachTransportNote(null, v.delivery), null);
  // no mailbox but a configured transactional provider: that provider's own sentence is kept
  assert.strictEqual(R.outreachTransportNote(v.transport, { canSend: true }), null);
  assert.strictEqual(outreachReadyNote({ ...v, transport: null }), 'Ready for outreach — delivery provider not configured');
});

test('3. Gmail needs_check / reconnect_needed / paused: the mailbox warning, never "Ready" and never "provider not configured"', async () => {
  const s = await setup();
  const { pitch } = await firstEmail(s);
  const cases = [
    ['needs_check', 'MAILBOX_CHECK_REQUIRED', /needs a check - run "Check mailbox"/],
    ['reconnect_needed', 'MAILBOX_RECONNECT_NEEDED', /needs to be reconnected/],
    ['paused', 'MAILBOX_PAUSED', /is paused/],
  ];
  for (const [status, code, re] of cases) {
    await s.store.mailboxes.setStatus(MBX, { status, status_code: code, updated_at: iso(NOW) });
    const v = await viewOf(s, pitch.pitch_id);
    assert.strictEqual(v.transport.status, status);
    assert.strictEqual(v.transport.ready, false);
    const note = outreachReadyNote(v);
    assert.ok(re.test(note) && !/\(Ready\)/.test(note) && !/provider not configured/.test(note), status + ': ' + note);
  }
  // an unreadable mailbox state is "unknown", never Ready
  assert.ok(/could not be read/.test(R.outreachTransportNote({ kind: 'mailbox', unknown: true }, null)));
});

test('4. the gate verdict is byte-identical with and without the read model; gate() itself carries no new fields', async () => {
  const s = await setup();
  const { pitch } = await firstEmail(s);
  const bare = await s.li.outreach.gate({ pitchId: pitch.pitch_id, channel: 'email' });
  assert.strictEqual(bare.transport, undefined, 'send paths read gate(), which is unchanged');
  assert.strictEqual(bare.sent, undefined);
  const v = await viewOf(s, pitch.pitch_id);
  assert.deepStrictEqual(strip(v), bare);
});

test('5. existing send records and the active F28 sequence are untouched by reading the view', async () => {
  const s = await setup();
  const { pitch, view } = await approvedSequence(s);
  await s.sequences.activate({ sequenceId: view.sequenceId });
  s.advance(3 * DAY + 1000);
  await s.scheduler.tick(); // follow-up 1 goes out
  assert.strictEqual(sendCalls(s.gmail).length, 2);

  const sendsBefore = JSON.stringify(await s.store.sends.list({ limit: 50 }));
  const sentBefore = JSON.stringify(s.store.mailboxSent);
  const seqBefore = JSON.stringify(await s.sequences.forLead({ leadId: 'L1' }));
  const callsBefore = s.gmail.calls.length;

  for (let i = 0; i < 3; i += 1) {
    await viewOf(s, pitch.pitch_id);
    await s.li.outreach.ready({});
  }

  assert.strictEqual(JSON.stringify(await s.store.sends.list({ limit: 50 })), sendsBefore, 'send ledger unchanged');
  assert.strictEqual(JSON.stringify(s.store.mailboxSent), sentBefore, 'stored Message-IDs unchanged');
  const seqAfter = await s.sequences.forLead({ leadId: 'L1' });
  assert.strictEqual(JSON.stringify(seqAfter), seqBefore, 'sequence state unchanged');
  assert.strictEqual(seqAfter.status, 'active');
  assert.strictEqual(s.gmail.calls.length, callsBefore, 'reading the Outreach view never calls Gmail');

  // the first pitch still reports exactly one accepted send (follow-ups are their own pitches)
  const v = await viewOf(s, pitch.pitch_id);
  assert.strictEqual(v.sent.accepted, 1);
});

test('6. an approved pitch that was not sent says so; a blocked pitch gets no approval claim', async () => {
  const s = await setup();
  const { pitch } = await firstEmail(s);
  const v = await viewOf(s, pitch.pitch_id);
  assert.strictEqual(R.outreachPitchFactsNote({ ok: true, gate: { ...v, sent: { accepted: 0 } } }), 'Approved - not sent yet.');
  assert.strictEqual(R.outreachPitchFactsNote({ ok: true, gate: { ...v, decision: 'blocked', sent: { accepted: 0 } } }), null);
  assert.strictEqual(R.outreachPitchFactsNote({ ok: false }), null, 'an unreadable gate claims nothing');
  // the stored status is left as the content lifecycle: "Draft" is not renamed
  assert.ok(/draft: \{ label: 'Draft', tone: 'ok' \}/.test(src));
});

test('7. a ledger or mailbox read failure degrades to unknown/null and never fails the gate read', async () => {
  const s = await setup();
  const { pitch } = await firstEmail(s);
  const origList = s.store.sends.list.bind(s.store.sends);
  s.store.sends.list = async () => { throw new Error('ledger offline'); };
  const origDefault = s.store.mailboxes.getDefault.bind(s.store.mailboxes);
  s.store.mailboxes.getDefault = async () => { throw new Error('mailboxes offline'); };
  const v = await viewOf(s, pitch.pitch_id);
  assert.strictEqual(v.decision, 'allowed');
  assert.strictEqual(v.sent, null);
  assert.strictEqual(v.transport.unknown, true);
  s.store.sends.list = origList;
  s.store.mailboxes.getDefault = origDefault;
});

test('8. wiring: the gate IPC serves gateView; both tables use the mailbox note; no address or token crosses', async () => {
  const ipcSrc = implSource('outreach-ipc.js');
  assert.ok(/CHANNELS\.OUTREACH_GATE[\s\S]{0,200}outreach\.gateView\(/.test(ipcSrc));
  assert.ok(/outreachTransportNote\(g\.transport, g\.delivery\) \|\| f14DeliveryNote\(g\.delivery\)/.test(src));
  assert.ok(/outreachTransportNote\(item && item\.transport, gate\.delivery\) \|\| f16ReadyDeliveryNote\(gate\.delivery\)/.test(src));
  assert.ok(/outreachPitchFactsNote\(gateEntry\)/.test(src));
  const s = await setup();
  const { pitch } = await firstEmail(s);
  const json = JSON.stringify({ transport: (await viewOf(s, pitch.pitch_id)).transport });
  assert.ok(!json.includes(h.MBX_ADDR) && !json.includes(h.REFRESH) && !json.includes(h.ACCESS), json);
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
