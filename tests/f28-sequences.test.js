'use strict';

// F28 - email follow-up sequences: drafting, approval, activation, the threaded send, stop rules,
// and the scheduler's handling of every refusal (D1-D6, Zee 7 Oct 2026). Fake Gmail only; no live
// call. Each test states the rule it pins.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const LI = path.join(root, 'src', 'main', 'lead-intelligence');
const h = require('./f28-harness');
const { registerSequenceIpc, SEQUENCE_CHANNELS_IPC, SEQUENCE_SCHEMAS } = require(path.join(LI, 'sequences', 'sequence-ipc.js'));
const { buildRawMessage } = require(path.join(LI, 'mailbox', 'gmail', 'rfc2822.js'));
const { suppress, reply } = require('./f265-harness');

const { DAY, HOUR, MBX, MBX_ADDR, LEAD_EMAIL, NOW, iso, setup, firstEmail, approvedSequence, sendCalls, lead } = h;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

async function seqOf(s, leadId = 'L1') { return s.sequences.forLead({ leadId }); }
async function active(s, opts) {
  const r = await approvedSequence(s, opts);
  await s.sequences.activate({ sequenceId: r.view.sequenceId });
  return { ...r, sequenceId: r.view.sequenceId };
}
const rejectsCode = (p, code) => assert.rejects(p, (e) => { assert.strictEqual(e.code, code); return true; });

/* ================================ 1. drafting ================================ */

test('1a. a sequence starts only from a mailbox first email that Gmail accepted and ZTech read back', async () => {
  const s = await setup();
  await rejectsCode(s.sequences.create({ leadId: 'L1' }), 'FIRST_EMAIL_REQUIRED');
  await firstEmail(s);
  const v = await s.sequences.create({ leadId: 'L1' });
  assert.strictEqual(v.status, 'draft');
  assert.deepStrictEqual(v.steps.map((x) => x.delayDays), [3, 7, 14], 'D6 defaults');
  assert.deepStrictEqual(v.steps.map((x) => x.state), ['waiting', 'waiting', 'waiting'], 'nothing is scheduled before activation');
  assert.ok(v.steps.every((x) => x.subject === 'Re: A few notes on www.acme.example.com'), 'D4: Re: <first subject>');
  assert.ok(v.steps.every((x) => x.approved === false && x.draftStatus === 'draft'));
  assert.ok(!JSON.stringify(v).includes(LEAD_EMAIL), 'no address crosses to the renderer');
  await rejectsCode(s.sequences.create({ leadId: 'L1' }), 'SEQUENCE_EXISTS');
});

test('1b. no thread, no sequence: an unreadable stored Message-ID, an edited first pitch, a used first email', async () => {
  const s = await setup();
  const { send, pitch } = await firstEmail(s);
  const row = await s.store.mailboxSent.get(send.sendId);
  await s.store.mailboxSent.record({ ...row, stored_message_id: null });
  await rejectsCode(s.sequences.create({ leadId: 'L1' }), 'THREAD_UNAVAILABLE');
  await s.store.mailboxSent.record(row);
  await s.li.outreach.update({ pitchId: pitch.pitch_id, edits: { callToAction: 'Different now?' } });
  await rejectsCode(s.sequences.create({ leadId: 'L1' }), 'FIRST_EMAIL_CHANGED');

  const t = await setup();
  await firstEmail(t);
  const v = await t.sequences.create({ leadId: 'L1' });
  await t.sequences.stop({ sequenceId: v.sequenceId });
  await rejectsCode(t.sequences.create({ leadId: 'L1' }), 'SEQUENCE_ALREADY_USED');
});

test('1c. delays: 1-3 follow-ups of 2-60 whole days; anything else is refused before anything is written', async () => {
  const s = await setup();
  await firstEmail(s);
  for (const bad of [[], [1], [61], [3, 7, 14, 20], [2.5], ['3']]) {
    await rejectsCode(s.sequences.create({ leadId: 'L1', delays: bad }), 'VALIDATION_FAILED');
  }
  assert.strictEqual(await s.store.sequences.openForLead('L1'), null);
  const v = await s.sequences.create({ leadId: 'L1', delays: [2] });
  assert.strictEqual(v.steps.length, 1);
});

test('1d. no follow-ups are drafted after a reply or for a do-not-contact address', async () => {
  const s = await setup();
  await firstEmail(s);
  s.advance(HOUR);
  await reply(s.store, { source: 'mailbox' });
  // the fixture reply is dated before the first email: only a LATER reply counts
  await assert.doesNotReject(s.sequences.create({ leadId: 'L1' }));
  const t = await setup();
  await firstEmail(t);
  await suppress(t.store, 'email', LEAD_EMAIL);
  await rejectsCode(t.sequences.create({ leadId: 'L1' }), 'SEQUENCE_NOT_ALLOWED');
  const u = await setup();
  await firstEmail(u);
  u.advance(HOUR);
  await u.store.trustEvents.append({ row_id: 'tev_later', event_id: 'evt_later', kind: 'reply', channel: 'email', recipient_ref: null, normalized_address: LEAD_EMAIL, source: 'relay', state: 'stored', reject_code: null, received_at: iso(u.clock.t), recorded_at: iso(u.clock.t) });
  await assert.rejects(u.sequences.create({ leadId: 'L1' }), (e) => e.code === 'SEQUENCE_NOT_ALLOWED' && /replied/.test(e.message));
});

/* ================================ 2. approval and activation ================================ */

test('2a. D2: activation needs EVERY step approved and the mailbox Ready', async () => {
  const s = await setup();
  await firstEmail(s);
  const v = await s.sequences.create({ leadId: 'L1' });
  await s.li.outreach.approve({ pitchId: v.steps[0].pitchId });
  await assert.rejects(s.sequences.activate({ sequenceId: v.sequenceId }), (e) => e.code === 'STEPS_NOT_APPROVED' && /2, 3/.test(e.message));
  for (const st of v.steps.slice(1)) await s.li.outreach.approve({ pitchId: st.pitchId });
  await s.store.mailboxes.setStatus(MBX, { status: 'needs_check', status_code: 'MAILBOX_CHECK_REQUIRED', updated_at: iso(NOW) });
  await rejectsCode(s.sequences.activate({ sequenceId: v.sequenceId }), 'MAILBOX_NOT_READY');
  await s.store.mailboxes.setStatus(MBX, { status: 'ready', status_code: null, updated_at: iso(NOW) });
  const a = await s.sequences.activate({ sequenceId: v.sequenceId });
  assert.strictEqual(a.status, 'active');
  assert.strictEqual(a.steps[0].state, 'scheduled');
  assert.strictEqual(a.steps[0].dueAt, iso(Date.parse(a.firstSentAt) + 3 * DAY), 'due = first accepted + delay');
  await rejectsCode(s.sequences.activate({ sequenceId: v.sequenceId }), 'SEQUENCE_NOT_DRAFT');
});

test('2b. editing an approved step of an active sequence holds it (NEEDS_APPROVAL); approving again lets it continue', async () => {
  const s = await setup();
  const { view, sequenceId } = await active(s);
  await s.li.outreach.update({ pitchId: view.steps[1].pitchId, edits: { callToAction: 'Is next week better?' } });
  let v = await seqOf(s);
  assert.strictEqual(v.status, 'paused');
  assert.strictEqual(v.holdCode, 'NEEDS_APPROVAL');
  s.advance(3 * DAY + 1000);
  await s.scheduler.tick();
  assert.strictEqual(sendCalls(s.gmail).length, 1, 'only the first email: a held sequence sends nothing');
  await s.li.outreach.approve({ pitchId: view.steps[1].pitchId });
  v = await seqOf(s);
  assert.strictEqual(v.status, 'active');
  await s.scheduler.tick();
  assert.strictEqual(sendCalls(s.gmail).length, 2, 'the due step goes out once approved again');
  assert.ok(sequenceId);
});

test('2c. a follow-up keeps the first subject; a sent step can no longer change', async () => {
  const s = await setup();
  const { view } = await active(s);
  await rejectsCode(s.li.outreach.update({ pitchId: view.steps[0].pitchId, edits: { subject: 'Re: something else' } }), 'VALIDATION_FAILED');
  s.advance(3 * DAY + 1000);
  await s.scheduler.tick();
  await rejectsCode(s.li.outreach.update({ pitchId: view.steps[0].pitchId, edits: { callToAction: 'x?' } }), 'STEP_LOCKED');
});

test('2d. a follow-up never appears in the pitch list, the Ready queue or as the lead\'s latest pitch', async () => {
  const s = await setup();
  const { view, pitch } = await approvedSequence(s);
  const ids = view.steps.map((x) => x.pitchId);
  const listed = (await s.li.outreach.list({ limit: 100 })).rows.map((r) => r.pitch_id);
  assert.ok(ids.every((id) => !listed.includes(id)));
  const ready = (await s.li.outreach.ready({ limit: 50 })).rows.map((r) => r.pitch.pitch_id);
  assert.ok(ids.every((id) => !ready.includes(id)));
  assert.strictEqual((await s.li.outreach.latestForLead('L1')).pitch_id, pitch.pitch_id);
  assert.strictEqual((await s.li.outreach.get(ids[0])).kind, 'followup', 'reachable by id for edit and approval');
});

/* ================================ 3-4. timing and the threaded send ================================ */

test('3. nothing is sent before previous accepted + delay, and a draft sequence never sends', async () => {
  const s = await setup();
  const { view } = await approvedSequence(s);
  s.advance(30 * DAY);
  await s.scheduler.tick();
  assert.strictEqual(sendCalls(s.gmail).length, 1, 'draft: nothing scheduled');
  const t = await setup();
  await active(t);
  t.advance(3 * DAY - 60 * 1000);
  await t.scheduler.tick();
  assert.strictEqual(sendCalls(t.gmail).length, 1, 'one minute early: nothing');
  t.advance(2 * 60 * 1000);
  await t.scheduler.tick();
  assert.strictEqual(sendCalls(t.gmail).length, 2);
  const v = await seqOf(t);
  assert.strictEqual(v.steps[1].dueAt, iso(Date.parse(v.steps[0].sentAt) + 7 * DAY), 'step 2 due = step 1 accepted + 7 days');
  t.advance(7 * DAY - 2 * 60 * 1000);
  await t.scheduler.tick();
  assert.strictEqual(sendCalls(t.gmail).length, 2, 'never several steps at once');
  assert.ok(view);
});

test('4. the follow-up is a reply in the SAME Gmail thread: threadId, In-Reply-To / References = STORED ids, Re: subject, footer, List-Unsubscribe, no Message-ID', async () => {
  const s = await setup();
  await active(s);
  for (const d of [3, 7, 14]) { s.advance(d * DAY + 1000); await s.scheduler.tick(); }
  const [first, f1, f2, f3] = s.gmail.sent;
  assert.strictEqual(first.requestThreadId, null);
  for (const m of [f1, f2, f3]) {
    assert.strictEqual(m.requestThreadId, first.threadId, 'sent with the first email\'s threadId');
    assert.strictEqual(m.headers.subject, 'Re: A few notes on www.acme.example.com');
    assert.strictEqual(m.headers['list-unsubscribe'], `<mailto:${MBX_ADDR}?subject=unsubscribe>`);
    assert.ok(m.body.includes('Reply "unsubscribe"'), 'every follow-up carries the opt-out footer');
    assert.ok(!/^message-id:/im.test(m.text.split('\r\n\r\n')[0]), 'no Message-ID is ever supplied');
    assert.strictEqual(m.headers.to, LEAD_EMAIL);
  }
  assert.strictEqual(f1.headers['in-reply-to'], '<CAstored-1@mail.gmail.com>');
  assert.strictEqual(f1.headers.references, '<CAstored-1@mail.gmail.com>');
  assert.strictEqual(f3.headers['in-reply-to'], '<CAstored-3@mail.gmail.com>');
  assert.strictEqual(f3.headers.references, '<CAstored-1@mail.gmail.com> <CAstored-2@mail.gmail.com> <CAstored-3@mail.gmail.com>');
  assert.strictEqual((await seqOf(s)).status, 'completed');
  assert.strictEqual(s.emailSpy.calls.length, 0, 'Resend is never used');
});

test('5a. THREAD_UNAVAILABLE: a missing stored id holds the sequence; it is never sent unthreaded', async () => {
  const s = await setup();
  await active(s);
  s.advance(3 * DAY + 1000);
  await s.scheduler.tick();
  const v = await seqOf(s);
  const step1 = await s.store.sequences.steps(v.sequenceId);
  const row = await s.store.mailboxSent.get(step1[0].send_id);
  await s.store.mailboxSent.record({ ...row, stored_message_id: null });
  s.advance(7 * DAY + 1000);
  await s.scheduler.tick();
  const after = await seqOf(s);
  assert.strictEqual(after.holdCode, 'THREAD_UNAVAILABLE');
  assert.strictEqual(sendCalls(s.gmail).length, 2);
});

test('5b. "Re:" stays refused on every ordinary send; the raw builder only threads on stored ids', async () => {
  const s = await setup();
  await h.firstEmail(s);
  const p = await s.li.outreach.generate({ leadId: 'L1' });
  await s.li.outreach.update({ pitchId: p.pitch_id, edits: { subject: 'Re: our call' } });
  await s.li.outreach.approve({ pitchId: p.pitch_id });
  await rejectsCode(s.li.outreach.send({ pitchId: p.pitch_id, channel: 'email', mailboxId: MBX }), 'SUBJECT_MISLEADING');
  const base = { from: MBX_ADDR, to: 'a@b.example', subject: 's', text: 't' };
  assert.throws(() => buildRawMessage({ ...base, headers: { 'In-Reply-To': '<a@b>' } }), /never supplied/);
  assert.throws(() => buildRawMessage({ ...base, thread: { inReplyTo: 'not-an-id', references: ['not-an-id'] } }), /stored Message-IDs/);
  assert.throws(() => buildRawMessage({ ...base, thread: { inReplyTo: '<a@b.c>', references: ['<x@y.z>'] } }), /ending with In-Reply-To/);
});

test('5c. a follow-up is sent ONLY by its sequence: Prepare, a human send on any channel and the handoff refuse it', async () => {
  const s = await setup();
  const { view } = await approvedSequence(s);
  const id = view.steps[0].pitchId;
  const g = await s.li.outreach.gate({ pitchId: id });
  assert.strictEqual(g.decision, 'blocked');
  assert.ok(g.reasons.some((r) => r.code === 'FOLLOWUP_SEQUENCE_ONLY'));
  await rejectsCode(s.li.outreach.send({ pitchId: id, channel: 'email', mailboxId: MBX }), 'NOT_READY');
  await rejectsCode(s.li.outreach.send({ pitchId: id, channel: 'email' }), 'NOT_READY');
  await rejectsCode(s.li.outreach.send({ pitchId: id, channel: 'whatsapp' }), 'NOT_READY');
  await rejectsCode(s.li.outreach.prepare({ pitchId: id, channel: 'email' }), 'NOT_READY');
  await rejectsCode(s.li.outreach.handoff({ pitchId: id, kind: 'copy' }), 'NOT_READY');
  assert.strictEqual(sendCalls(s.gmail).length, 1);
  assert.strictEqual(s.emailSpy.calls.length + s.waSpy.calls.length, 0);
  await rejectsCode(s.li.outreach.sendFromMailbox({ pitchId: view.steps[0].pitchId, mailboxId: MBX }, { followUp: { pitchId: 'pitch_other', mailboxId: MBX, firstSubject: 'x' } }), 'SEQUENCE_MISMATCH');
  // The boundary itself refuses a recipient other than the first email's (defence in depth).
  for (const st of view.steps) await s.li.outreach.approve({ pitchId: st.pitchId });
  const fu = { pitchId: id, mailboxId: MBX, firstSubject: 'A few notes on www.acme.example.com', recipient: 'someone-else@acme.example.com', threadId: 't1', inReplyTo: '<CAstored-1@mail.gmail.com>', references: ['<CAstored-1@mail.gmail.com>'] };
  await rejectsCode(s.li.outreach.sendFromMailbox({ pitchId: id, mailboxId: MBX }, { followUp: fu }), 'CONTACT_CHANGED');
  const ordinary = await s.li.outreach.generate({ leadId: 'L1' });
  await s.li.outreach.approve({ pitchId: ordinary.pitch_id });
  await rejectsCode(s.li.outreach.sendFromMailbox({ pitchId: ordinary.pitch_id, mailboxId: MBX }, { followUp: { ...fu, pitchId: ordinary.pitch_id, recipient: LEAD_EMAIL, firstSubject: ordinary.subject } }), 'SEQUENCE_MISMATCH');
  assert.strictEqual(sendCalls(s.gmail).length, 1);
});

/* ================================ 6. stop rules (D5) ================================ */

async function syncedReply(s) {
  s.gmail.deliver('in1', { From: `"Owner" <${LEAD_EMAIL}>`, Subject: 'Re: A few notes', 'In-Reply-To': '<CAstored-1@mail.gmail.com>', References: '<CAstored-1@mail.gmail.com>' });
  const sum = await s.svc.syncReplies({ mailboxId: MBX });
  assert.strictEqual(sum.replies, 1);
}

test('6a. any verified reply - not yet reviewed - stops the sequence for good; nothing more is sent', async () => {
  const s = await setup();
  const { sequenceId } = await active(s);
  s.advance(HOUR);
  await syncedReply(s);
  s.advance(3 * DAY);
  await s.scheduler.tick();
  const v = await seqOf(s);
  assert.strictEqual(v.status, 'stopped');
  assert.strictEqual(v.stopReason, 'replied');
  assert.deepStrictEqual(v.steps.map((x) => x.state), ['stopped', 'stopped', 'stopped']);
  assert.strictEqual(sendCalls(s.gmail).length, 1);
  await rejectsCode(s.sequences.resume({ sequenceId }), 'SEQUENCE_NOT_PAUSED');
  await rejectsCode(s.sequences.activate({ sequenceId }), 'SEQUENCE_NOT_DRAFT');
});

test('6a2. a reply Gmail holds but ZTech has not read yet still stops the follow-up: replies are read right before every send', async () => {
  const s = await setup();
  await active(s);
  s.gmail.deliver('in9', { From: `"Owner" <${LEAD_EMAIL}>`, Subject: 'Re: A few notes', 'In-Reply-To': '<CAstored-1@mail.gmail.com>', References: '<CAstored-1@mail.gmail.com>' });
  s.advance(3 * DAY + 1000);
  const r = await s.scheduler.tick();
  assert.deepStrictEqual(r.outcomes, ['stopped']);
  assert.strictEqual((await seqOf(s)).stopReason, 'replied');
  assert.strictEqual(sendCalls(s.gmail).length, 1, 'nothing was sent');
});

test('6a3. the pre-send reply check never lets a follow-up go unchecked: a failed read waits 15 min; a history gap holds for a human', async () => {
  const s = await setup();
  await active(s);
  const real = s.svc.syncReplies.bind(s.svc);
  s.svc.syncReplies = async () => { const e = new Error('x'); e.code = 'MAILBOX_PROVIDER_UNAVAILABLE'; throw e; };
  s.advance(3 * DAY + 1000);
  assert.deepStrictEqual((await s.scheduler.tick()).outcomes, ['rescheduled']);
  let v = await seqOf(s);
  assert.strictEqual(v.steps[0].lastCode, 'REPLY_CHECK_FAILED');
  assert.strictEqual(v.steps[0].nextAttemptAt, iso(s.clock.t + 15 * 60 * 1000));
  assert.strictEqual(sendCalls(s.gmail).length, 1);
  s.svc.syncReplies = async (a) => ({ ...(await real(a)), cursorReset: true });
  s.advance(16 * 60 * 1000);
  await s.scheduler.tick();
  v = await seqOf(s);
  assert.strictEqual(v.holdCode, 'REPLIES_UNCHECKED');
  assert.strictEqual(v.autoResume, false);
  s.svc.syncReplies = real;
  await s.sequences.resume({ sequenceId: v.sequenceId });
  await s.scheduler.tick();
  assert.strictEqual((await seqOf(s)).steps[0].state, 'sent');
});

test('6b. unsubscribe, do-not-contact and a negative reply review all stop it (suppressed)', async () => {
  for (const how of ['unsubscribe', 'manual', 'review']) {
    const s = await setup();
    await active(s);
    s.advance(HOUR);
    if (how === 'review') {
      await syncedReply(s);
      const lt = await s.li.trust.leadTrust({ leadId: 'L1' });
      await s.li.trust.reviewReply({ leadId: 'L1', outcome: 'not_interested', replyReceivedAt: lt.channels.email.mailboxReply.receivedAt });
    } else {
      await s.li.trust.suppressLead({ leadId: 'L1', channel: 'email', reason: how });
    }
    await s.scheduler.tick();
    const v = await seqOf(s);
    assert.strictEqual(v.status, 'stopped', how);
    assert.strictEqual(v.stopReason, 'suppressed', how);
  }
});

test('6c. a manual stop is final; a changed lead address stops it (contact_changed) before anything is sent', async () => {
  const s = await setup();
  const { sequenceId } = await active(s);
  const stopped = await s.sequences.stop({ sequenceId });
  assert.strictEqual(stopped.stopReason, 'manual');
  await rejectsCode(s.sequences.stop({ sequenceId }), 'SEQUENCE_CLOSED');

  const leads = { L1: lead({}) };
  const t = await setup({ leads });
  await active(t);
  leads.L1.email = 'someone-else@acme.example.com';
  t.advance(3 * DAY + 1000);
  await t.scheduler.tick();
  const v = await seqOf(t);
  assert.strictEqual(v.stopReason, 'contact_changed');
  assert.strictEqual(sendCalls(t.gmail).length, 1);
  const blockedCodes = (await t.li.outreach.activityList({ limit: 50 })).rows.filter((r) => r.activity_type === 'OUTREACH_SEND_BLOCKED').map((r) => r.metadata.blockedCode);
  assert.ok(!blockedCodes.includes('CONTACT_CHANGED'), 'stopped by the stop rules, before the send boundary was even asked');
});

/* ================================ 7. the scheduler's refusal table ================================ */

test('7a. pacing / window: the step moves to the next allowed time (not a failure, no hold)', async () => {
  // 2026-10-10 is a Saturday: a Mon-Fri window moves step 1 to Monday 00:00 Karachi.
  const s = await setup({ windowDays: '1,2,3,4,5' });
  await active(s);
  s.advance(3 * DAY + 1000);
  const r = await s.scheduler.tick();
  assert.deepStrictEqual(r.outcomes, ['rescheduled']);
  const v = await seqOf(s);
  assert.strictEqual(v.status, 'active');
  assert.strictEqual(v.steps[0].nextAttemptAt, '2026-10-11T19:00:00.000Z', 'Monday 00:00 Asia/Karachi');
  assert.strictEqual(v.steps[0].lastCode, 'MAILBOX_PACING');
  assert.strictEqual(sendCalls(s.gmail).length, 1);
  s.clock.t = Date.parse('2026-10-11T19:00:30.000Z');
  await s.scheduler.tick();
  assert.strictEqual(sendCalls(s.gmail).length, 2);
});

test('7a2. a pacing refusal inside the send boundary (a race with a click) moves the step to the exact next allowed time', async () => {
  const leads = { L1: lead({}), L2: lead({ id: 'L2', email: 'two@acme.example.com', website: 'https://two.example.com' }) };
  const s = await setup({ leads });
  await active(s);
  s.advance(3 * DAY + 1000);
  const pre = s.svc.sendGate.bind(s.svc);
  let first = true;
  s.svc.sendGate = async (id, o) => {
    if (first && !o) { first = false; await firstEmail(s, 'L2'); return { allowed: true }; } // a human click lands between the two checks
    return pre(id, o);
  };
  const r = await s.scheduler.tick();
  assert.deepStrictEqual(r.outcomes, ['rescheduled']);
  const v = await seqOf(s);
  const last = (await s.store.sends.list({ leadId: 'L2', limit: 5 })).rows.find((x) => x.state === 'accepted');
  assert.strictEqual(v.steps[0].nextAttemptAt, iso(Date.parse(last.created_at) + 180 * 1000), 'the min-gap time main computed');
});

test('7b. a window that can never open holds the sequence (PACING_NO_WINDOW) for a human', async () => {
  const s = await setup();
  await active(s);
  await s.store.mailboxes.setLimits(MBX, { window_start: '10:00', window_end: '10:00' }, iso(NOW)).catch(() => null);
  // An impossible window cannot be saved through the contract; simulate one that never opens.
  const svcGate = s.svc.sendGate.bind(s.svc);
  s.svc.sendGate = async (id, o) => ((o && o.pacing === false) ? svcGate(id, o) : { allowed: false, code: 'MAILBOX_PACING', message: 'x', nextAllowedAt: null });
  s.advance(3 * DAY + 1000);
  await s.scheduler.tick();
  assert.strictEqual((await seqOf(s)).holdCode, 'PACING_NO_WINDOW');
});

test('7c. Gmail limit: pause, retry after 1 h, then 4 h, then 24 h; a 4th limit in a row waits for a human', async () => {
  const s = await setup();
  await active(s);
  s.gmail.next = [{ status: 429 }, { status: 429 }, { status: 429 }, { status: 429 }];
  s.advance(3 * DAY + 1000);
  for (const wait of [HOUR, 4 * HOUR, 24 * HOUR]) {
    const before = sendCalls(s.gmail).length;
    await s.scheduler.tick();
    assert.strictEqual(sendCalls(s.gmail).length, before + 1, 'one Gmail call per attempt');
    let v = await seqOf(s);
    assert.strictEqual(v.status, 'paused');
    assert.strictEqual(v.holdCode, 'PROVIDER_LIMIT');
    assert.strictEqual(v.autoResume, true);
    s.advance(wait - 60 * 1000);
    await s.scheduler.tick();
    assert.strictEqual(sendCalls(s.gmail).length, before + 1, 'nothing before the wait is over');
    s.advance(2 * 60 * 1000);
    v = await seqOf(s);
  }
  await s.scheduler.tick();
  const v = await seqOf(s);
  assert.strictEqual(v.holdCode, 'PROVIDER_LIMIT_REPEATED');
  assert.strictEqual(v.autoResume, false);
  s.advance(48 * HOUR);
  const n = sendCalls(s.gmail).length;
  await s.scheduler.tick();
  assert.strictEqual(sendCalls(s.gmail).length, n, 'never retried by itself again');
  await s.sequences.resume({ sequenceId: v.sequenceId });
  await s.scheduler.tick();
  assert.strictEqual((await seqOf(s)).steps[0].state, 'sent');
});

test('7d. a Gmail limit pauses EVERY active sequence of that mailbox until the same time', async () => {
  const leads = { L1: lead({}), L2: lead({ id: 'L2', email: 'two@acme.example.com', website: 'https://two.example.com' }) };
  const s = await setup({ leads });
  await active(s);
  s.advance(5 * 60 * 1000);
  await active(s, { leadId: 'L2' });
  s.gmail.next = [{ status: 429 }];
  s.advance(3 * DAY + 10 * 60 * 1000);
  await s.scheduler.tick();
  const a = await seqOf(s, 'L1');
  const b = await seqOf(s, 'L2');
  assert.strictEqual(a.holdCode, 'PROVIDER_LIMIT');
  assert.strictEqual(b.holdCode, 'PROVIDER_LIMIT');
  assert.strictEqual(a.resumeAt, b.resumeAt);
});

test('7e. a revoked mailbox pauses the sequence; it continues by itself only when the mailbox is Ready again', async () => {
  const s = await setup();
  await active(s);
  s.gmail.next = [{ status: 401 }];
  s.advance(3 * DAY + 1000);
  await s.scheduler.tick();
  let v = await seqOf(s);
  assert.strictEqual(v.holdCode, 'MAILBOX_RECONNECT_REQUIRED');
  assert.strictEqual((await s.store.mailboxes.get(MBX)).status, 'reconnect_needed');
  s.advance(HOUR);
  await s.scheduler.tick();
  assert.strictEqual(sendCalls(s.gmail).length, 2, 'the refused call only');
  assert.ok(!(await s.store.sequences.events(v.sequenceId)).some((e) => e.event === 'resumed'), 'it does not resume while the mailbox is not Ready');
  await s.store.mailboxes.setStatus(MBX, { status: 'ready', status_code: null, updated_at: iso(s.clock.t) });
  await s.scheduler.tick();
  v = await seqOf(s);
  assert.strictEqual(v.status, 'active');
  assert.strictEqual(v.steps[0].state, 'sent');
});

test('7f. trust / market refusal: held, NEVER retried by itself; Resume re-runs every gate once', async () => {
  const s = await setup();
  await active(s);
  await s.store.marketRules.remove('US');
  s.advance(3 * DAY + 1000);
  await s.scheduler.tick();
  let v = await seqOf(s);
  assert.strictEqual(v.holdCode, 'BLOCKED');
  assert.strictEqual(v.steps[0].lastCode, 'MARKET_CONSENT_REQUIRED');
  for (let i = 0; i < 3; i += 1) { s.advance(HOUR); await s.scheduler.tick(); }
  assert.strictEqual(sendCalls(s.gmail).length, 1);
  await s.sequences.resume({ sequenceId: v.sequenceId });
  await s.scheduler.tick();
  v = await seqOf(s);
  assert.strictEqual(v.holdCode, 'BLOCKED', 'still refused: held again, after exactly one more check');
  await s.store.marketRules.set({ country_code: 'US', rule: 'opt_out_allowed', note: 'reviewed again', reviewed_by: 'Zee', reviewed_at: iso(s.clock.t) });
  await s.sequences.resume({ sequenceId: v.sequenceId });
  await s.scheduler.tick();
  assert.strictEqual((await seqOf(s)).steps[0].state, 'sent');
});

test('7g. unknown outcome (lost connection, 5xx, 2xx without an id): a HUMAN decides; never retried', async () => {
  for (const next of [{ throw: true }, { status: 503 }, { noId: true }]) {
    const s = await setup();
    await active(s);
    s.gmail.next = [next];
    s.advance(3 * DAY + 1000);
    await s.scheduler.tick();
    let v = await seqOf(s);
    assert.strictEqual(v.holdCode, 'SEND_OUTCOME_UNKNOWN', JSON.stringify(next));
    for (let i = 0; i < 3; i += 1) { s.advance(DAY); await s.scheduler.tick(); }
    assert.strictEqual(sendCalls(s.gmail).length, 2, 'the one uncertain attempt only');
    await rejectsCode(s.sequences.resume({ sequenceId: v.sequenceId }), 'CONFIRMATION_REQUIRED');
    await s.sequences.resume({ sequenceId: v.sequenceId, confirmNotSent: true });
    await s.scheduler.tick();
    v = await seqOf(s);
    assert.strictEqual(v.steps[0].state, 'sent');
    assert.strictEqual(sendCalls(s.gmail).length, 3);
  }
});

test('7h. a definite Gmail rejection (400) is held for a human, not treated as "maybe sent"', async () => {
  const s = await setup();
  await active(s);
  s.gmail.next = [{ status: 400 }];
  s.advance(3 * DAY + 1000);
  await s.scheduler.tick();
  assert.strictEqual((await seqOf(s)).holdCode, 'BLOCKED');
});

test('7i. crash recovery: a step left "sending" is never re-sent blindly', async () => {
  // (a) an attempt reached Gmail -> held for a human
  const s = await setup();
  const { sequenceId, view } = await active(s);
  s.advance(3 * DAY + 1000);
  const step = (await s.store.sequences.steps(sequenceId))[0];
  await s.store.sequences.updateStep(sequenceId, 1, { state: 'sending', updated_at: iso(s.clock.t) });
  await s.store.sends.record({ send_id: 'send_crash1', lead_id: 'L1', pitch_id: step.pitch_id, channel: 'email', content_hash: step.draft.content_hash, idempotency_key: 'k_crash', state: 'attempted', provider_id: 'gmail', mailbox_id: MBX, created_at: iso(s.clock.t), updated_at: iso(s.clock.t) });
  await s.scheduler.tick();
  assert.strictEqual((await seqOf(s)).holdCode, 'SEND_OUTCOME_UNKNOWN');
  assert.strictEqual(sendCalls(s.gmail).length, 1);
  // (b) Gmail was never contacted -> back to scheduled and sent normally
  const t = await setup();
  const r = await active(t);
  t.advance(3 * DAY + 1000);
  await t.store.sequences.updateStep(r.sequenceId, 1, { state: 'sending', updated_at: iso(t.clock.t) });
  await t.scheduler.tick();
  assert.strictEqual((await seqOf(t)).steps[0].state, 'sent');
  assert.strictEqual(sendCalls(t.gmail).length, 2);
  // (c) Gmail accepted it before the crash -> recorded as sent, never sent again
  const u = await setup();
  const q = await active(u);
  u.advance(3 * DAY + 1000);
  await u.scheduler.tick();
  await u.store.sequences.updateStep(q.sequenceId, 1, { state: 'sending', updated_at: iso(u.clock.t) });
  await u.store.sequences.updateStep(q.sequenceId, 2, { state: 'waiting', due_at: null, next_attempt_at: null, updated_at: iso(u.clock.t) });
  const fresh = new (require(path.join(LI, 'sequences', 'SequenceScheduler.js')).SequenceScheduler)({ sequences: u.sequences, store: u.store, clock: () => new Date(u.clock.t) });
  await fresh.tick();
  const w = await seqOf(u);
  assert.strictEqual(w.steps[0].state, 'sent');
  assert.strictEqual(w.steps[1].state, 'scheduled', 'the next step is scheduled from the recorded acceptance');
  assert.strictEqual(sendCalls(u.gmail).length, 2);
  assert.ok(view);
});

test('9e. runtime (static): the scheduler starts only with connected mailboxes and stops on shutdown', () => {
  const rt = fs.readFileSync(path.join(LI, 'lead-intelligence-runtime.js'), 'utf8');
  const i = rt.indexOf('    if (li.mailboxes) {\n      // A reply-history gap');
  assert.ok(i > -1, 'the scheduler is built only when mailboxes exist');
  const block = rt.slice(i, i + 900);
  assert.ok(/setRepliesGapListener\(\(mailboxId, at\) => li\.sequences\.noteRepliesGap\(mailboxId, at\)\)/.test(block), 'a reply gap seen by any sync holds the follow-ups');
  assert.ok(/new SequenceScheduler\(/.test(block) && /sequenceScheduler\.start\(/.test(block));
  assert.ok(/if \(sequenceScheduler\) await sequenceScheduler\.stop\(\);/.test(rt), 'shutdown stops it and waits for a send in flight');
  assert.ok(/li\.outreach\.setSequences\(li\.sequences\)/.test(rt));
});

/* ================================ 8-9. gates, idempotency, scope ================================ */

test('8. a step is sent at most once: forcing it back to "scheduled" replays and contacts nobody', async () => {
  const s = await setup();
  const { sequenceId } = await active(s);
  s.advance(3 * DAY + 1000);
  await s.scheduler.tick();
  await s.store.sequences.updateStep(sequenceId, 1, { state: 'scheduled', next_attempt_at: iso(s.clock.t), updated_at: iso(s.clock.t) });
  await s.store.sequences.updateStep(sequenceId, 2, { state: 'waiting', due_at: null, next_attempt_at: null, updated_at: iso(s.clock.t) });
  s.advance(5 * 60 * 1000);
  const r = await s.scheduler.tick();
  assert.deepStrictEqual(r.outcomes, ['replayed']);
  assert.strictEqual(sendCalls(s.gmail).length, 2);
});

test('9a. one send per mailbox per tick; "Pause all follow-ups" stops every tick; the scheduler never sends a first email', async () => {
  const leads = { L1: lead({}), L2: lead({ id: 'L2', email: 'two@acme.example.com', website: 'https://two.example.com' }) };
  const s = await setup({ leads });
  await active(s);
  s.advance(5 * 60 * 1000);
  await active(s, { leadId: 'L2' });
  const firstPitchL2 = await s.li.outreach.generate({ leadId: 'L2' });
  await s.li.outreach.approve({ pitchId: firstPitchL2.pitch_id }); // an approved ordinary pitch the scheduler must ignore
  await s.sequences.setPauseAll({ paused: true });
  assert.strictEqual((await s.scheduler.tick()).pausedAll, true, 'reported even when nothing is due');
  s.advance(3 * DAY + 10 * 60 * 1000);
  let r = await s.scheduler.tick();
  assert.strictEqual(r.pausedAll, true);
  assert.strictEqual(sendCalls(s.gmail).length, 2);
  await s.sequences.setPauseAll({ paused: false });
  r = await s.scheduler.tick();
  assert.deepStrictEqual(r.outcomes, ['sent'], 'one per mailbox per tick');
  s.advance(4 * 60 * 1000);
  r = await s.scheduler.tick();
  assert.deepStrictEqual(r.outcomes, ['sent'], 'the other one, after the pacing gap');
  s.advance(HOUR);
  await s.scheduler.tick();
  assert.strictEqual(sendCalls(s.gmail).length, 4, 'two first emails + two follow-ups; never the approved ordinary pitch');
});

test('9b. scope (static): the scheduler only asks for due steps; nothing in F28 names Resend, the handoff or Microsoft', () => {
  const sched = fs.readFileSync(path.join(LI, 'sequences', 'SequenceScheduler.js'), 'utf8');
  assert.ok(!/outreach|sendFromMailbox|sendEmail|handoff/.test(sched.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')), 'the scheduler calls only SequenceService');
  for (const f of ['SequenceService.js', 'SequenceScheduler.js', 'sequence-ipc.js']) {
    const src = fs.readFileSync(path.join(LI, 'sequences', f), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    assert.ok(!/Resend|Graph|microsoft|handoff\(|sendEmail\(|sendWhatsApp\(/i.test(src), f);
  }
  const svc = fs.readFileSync(path.join(LI, 'sequences', 'SequenceService.js'), 'utf8');
  assert.strictEqual((svc.match(/sendFromMailbox\(/g) || []).length, 1, 'exactly one send call site');
});

test('9c. IPC: eight channels, trusted sender only, closed schemas; none sends, none names a step, time, address or mailbox', async () => {
  const handlers = {};
  const s = await setup();
  await firstEmail(s);
  let trusted = true;
  const names = registerSequenceIpc({ ipcMain: { handle: (c, f) => { handlers[c] = f; } }, sequences: s.sequences, isTrustedSender: () => trusted, logger: { warn() {} } });
  assert.deepStrictEqual(names.sort(), Object.values(SEQUENCE_CHANNELS_IPC).sort());
  assert.strictEqual(names.length, 8);
  assert.ok(names.every((c) => !/send/.test(c)));
  const created = await handlers[SEQUENCE_CHANNELS_IPC.CREATE]({}, { leadId: 'L1' });
  assert.strictEqual(created.ok, true);
  assert.ok(!JSON.stringify(created).includes(LEAD_EMAIL));
  for (const extra of [{ stepNo: 1 }, { at: iso(NOW) }, { mailboxId: MBX }, { to: LEAD_EMAIL }, { sendNow: true }]) {
    const r = await handlers[SEQUENCE_CHANNELS_IPC.ACTIVATE]({}, { sequenceId: created.data.sequenceId, ...extra });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error.code, 'VALIDATION_FAILED');
  }
  const badDelay = await handlers[SEQUENCE_CHANNELS_IPC.CREATE]({}, { leadId: 'L2', delays: [1] });
  assert.strictEqual(badDelay.ok, false);
  trusted = false;
  const r = await handlers[SEQUENCE_CHANNELS_IPC.LIST]({}, {});
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'FORBIDDEN');
  assert.ok(SEQUENCE_SCHEMAS[SEQUENCE_CHANNELS_IPC.RESUME].properties.confirmNotSent);
});

test('9d. every refusal and every send is in the sequence audit (codes only, never content or an address)', async () => {
  const s = await setup();
  const { sequenceId } = await active(s);
  s.gmail.next = [{ status: 429 }];
  s.advance(3 * DAY + 1000);
  await s.scheduler.tick();
  s.advance(HOUR + 1000);
  await s.scheduler.tick();
  const ev = (await s.store.sequences.events(sequenceId)).map((e) => `${e.actor}:${e.event}:${e.code || ''}`).reverse();
  assert.deepStrictEqual(ev, ['operator:created:', 'operator:activated:', 'scheduler:paused:PROVIDER_LIMIT', 'scheduler:resumed:PROVIDER_LIMIT', 'scheduler:sent:']);
  const json = JSON.stringify(await s.store.sequences.events(sequenceId));
  assert.ok(!json.includes(LEAD_EMAIL) && !json.includes('Acme'));
});

/* ================================ R. independent-review findings ================================ */

test('R1a. a human Pause that lands while replies are being read wins: nothing is sent', async () => {
  const s = await setup();
  const { sequenceId } = await active(s);
  const real = s.svc.syncReplies.bind(s.svc);
  s.svc.syncReplies = async (a) => { const r = await real(a); await s.sequences.pause({ sequenceId }); return r; };
  s.advance(3 * DAY + 1000);
  const r = await s.scheduler.tick();
  assert.deepStrictEqual(r.outcomes, ['skipped']);
  const v = await seqOf(s);
  assert.strictEqual(v.holdCode, 'MANUAL');
  assert.strictEqual(v.steps[0].state, 'scheduled');
  assert.strictEqual(sendCalls(s.gmail).length, 1);
});

test('R1b. "Pause all" switched on while replies are being read wins: nothing is sent', async () => {
  const s = await setup();
  await active(s);
  const real = s.svc.syncReplies.bind(s.svc);
  s.svc.syncReplies = async (a) => { const r = await real(a); await s.sequences.setPauseAll({ paused: true }); return r; };
  s.advance(3 * DAY + 1000);
  assert.deepStrictEqual((await s.scheduler.tick()).outcomes, ['skipped']);
  assert.strictEqual(sendCalls(s.gmail).length, 1);
});

test('R1c. an automatic resume never undoes a human Pause that landed while it was checking', async () => {
  const s = await setup();
  const { sequenceId } = await active(s);
  await s.store.sequences.update(sequenceId, { status: 'paused', hold_code: 'MAILBOX_RECONNECT_REQUIRED', updated_at: iso(s.clock.t) });
  const real = s.svc.sendGate.bind(s.svc);
  s.svc.sendGate = async (id, o) => { if (o && o.pacing === false) await s.sequences.pause({ sequenceId }); return real(id, o); };
  s.advance(3 * DAY + 1000);
  await s.scheduler.tick();
  const v = await seqOf(s);
  assert.strictEqual(v.status, 'paused');
  assert.strictEqual(v.holdCode, 'MANUAL');
  assert.strictEqual(sendCalls(s.gmail).length, 1);
});

test('R2. a reply behind a long inbox backlog still stops the follow-up: nothing is sent on a partial read', async () => {
  const s = await setup();
  await active(s);
  for (let i = 0; i < 250; i += 1) s.gmail.deliver(`n${i}`, { From: `"News" <news${i}@other.example>`, Subject: `Issue ${i}` });
  s.gmail.deliver('rep', { From: `"Owner" <${LEAD_EMAIL}>`, Subject: 'Re: A few notes', 'In-Reply-To': '<CAstored-1@mail.gmail.com>', References: '<CAstored-1@mail.gmail.com>' });
  s.advance(3 * DAY + 1000);
  const first = await s.scheduler.tick();
  assert.deepStrictEqual(first.outcomes, ['rescheduled'], 'the read was partial, so the step waits');
  assert.strictEqual((await seqOf(s)).steps[0].lastCode, 'REPLY_CHECK_INCOMPLETE');
  s.advance(61 * 1000);
  await s.scheduler.tick();
  const v = await seqOf(s);
  assert.strictEqual(v.stopReason, 'replied');
  assert.strictEqual(sendCalls(s.gmail).length, 1);
});

test('R3a. a failure AFTER Gmail accepted the step records it as sent - never "nothing was sent"', async () => {
  const s = await setup();
  await active(s);
  s.svc.noteReadBack = async () => { const e = new Error('disk'); e.code = 'SQLITE_FULL'; throw e; };
  s.advance(3 * DAY + 1000);
  assert.deepStrictEqual((await s.scheduler.tick()).outcomes, ['sent']);
  const t = await setup();
  await active(t);
  const real = t.li.outreach.sendFromMailbox.bind(t.li.outreach);
  t.li.outreach.sendFromMailbox = async (...a) => { await real(...a); const e = new Error('late'); e.code = 'INTERNAL_ERROR'; throw e; };
  t.advance(3 * DAY + 1000);
  assert.deepStrictEqual((await t.scheduler.tick()).outcomes, ['sent']);
  const v = await seqOf(t);
  assert.strictEqual(v.steps[0].state, 'sent');
  assert.strictEqual(v.status, 'active');
  assert.strictEqual(sendCalls(t.gmail).length, 2);
});

test('R3b. a step that may already have gone out can never be re-worded (a new hash would send it again)', async () => {
  const s = await setup();
  const { view } = await active(s);
  s.gmail.next = [{ status: 503 }];
  s.advance(3 * DAY + 1000);
  await s.scheduler.tick();
  assert.strictEqual((await seqOf(s)).holdCode, 'SEND_OUTCOME_UNKNOWN');
  await rejectsCode(s.li.outreach.update({ pitchId: view.steps[0].pitchId, edits: { callToAction: 'Another try?' } }), 'STEP_LOCKED');
  await assert.doesNotReject(s.li.outreach.update({ pitchId: view.steps[1].pitchId, edits: { callToAction: 'Later step?' } }), 'later steps stay editable');
});

test('R4. a crash between "hold" and "release the step" never leads to a blind retry', async () => {
  const s = await setup();
  const { sequenceId } = await active(s);
  s.gmail.next = [{ status: 503 }];
  // The process dies at the worst moment: while recording the hold. The step must still be
  // 'sending' at that point (hold first, release second), so recovery holds it instead of resending.
  const realUpdate = s.store.sequences.update.bind(s.store.sequences);
  let armed = true;
  s.store.sequences.update = async (id, patch, o) => {
    if (armed && patch.hold_code === 'SEND_OUTCOME_UNKNOWN') { armed = false; throw new Error('crash'); }
    return realUpdate(id, patch, o);
  };
  s.advance(3 * DAY + 1000);
  await s.scheduler.tick();
  const { SequenceScheduler } = require(path.join(LI, 'sequences', 'SequenceScheduler.js'));
  const restarted = new SequenceScheduler({ sequences: s.sequences, store: s.store, clock: () => new Date(s.clock.t) });
  for (let i = 0; i < 3; i += 1) { s.advance(HOUR); await restarted.tick(); }
  assert.strictEqual((await s.store.sequences.get(sequenceId)).hold_code, 'SEND_OUTCOME_UNKNOWN');
  assert.strictEqual(sendCalls(s.gmail).length, 2, 'the uncertain attempt only');
});

test('R5. a reply-history gap seen by ANY sync (the 5-minute timer too) holds the follow-ups for a human', async () => {
  const s = await setup();
  const { sequenceId } = await active(s);
  s.gmail.historyGone = true;
  await s.svc.syncAll();
  s.gmail.historyGone = false;
  let v = await seqOf(s);
  assert.strictEqual(v.holdCode, 'REPLIES_UNCHECKED');
  assert.ok(v.repliesGapAt);
  s.advance(3 * DAY + 1000);
  await s.scheduler.tick();
  assert.strictEqual(sendCalls(s.gmail).length, 1);
  await s.sequences.resume({ sequenceId });
  v = await seqOf(s);
  assert.strictEqual(v.repliesGapAt, null, 'a human resume clears it');
  await s.scheduler.tick();
  assert.strictEqual(sendCalls(s.gmail).length, 2);
});

test('R6. every Gmail call is bounded: a send that never answers is "unconfirmed" (a human decides), a read is "unavailable"', async () => {
  const { GmailApi } = require(path.join(LI, 'mailbox', 'gmail', 'GmailApi.js'));
  const hang = (url, init) => new Promise((resolve, reject) => { if (init && init.signal) init.signal.addEventListener('abort', () => reject(new Error('aborted'))); });
  const api = new GmailApi({ fetch: hang, getAccessToken: async () => 't', timeoutMs: 30 });
  await rejectsCode(api.sendRaw('abc'), 'MAILBOX_SEND_UNCONFIRMED');
  await rejectsCode(api.metadata('m1', ['Message-ID']), 'MAILBOX_PROVIDER_UNAVAILABLE');
});

test('R7. stopping the scheduler waits for a send in flight and starts no new tick', async () => {
  const s = await setup();
  await active(s);
  const real = s.li.outreach.sendFromMailbox.bind(s.li.outreach);
  let release;
  s.li.outreach.sendFromMailbox = async (...a) => { await new Promise((r) => { release = r; }); return real(...a); };
  s.advance(3 * DAY + 1000);
  const ticking = s.scheduler.tick();
  for (let i = 0; i < 50 && !release; i += 1) await new Promise((r) => setImmediate(r));
  let stopped = false;
  const stopping = s.scheduler.stop().then(() => { stopped = true; });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(stopped, false, 'stop waits');
  release();
  await stopping;
  await ticking;
  assert.strictEqual((await seqOf(s)).steps[0].state, 'sent', 'the send in flight was recorded before stop resolved');
  assert.strictEqual((await s.scheduler.tick()).stopped, true);
});

test('R8. a disconnected mailbox is said plainly (MAILBOX_GONE) instead of waiting forever; a 4th Gmail limit holds the mailbox\'s other sequences too', async () => {
  const s = await setup();
  const { sequenceId } = await active(s);
  await s.store.mailboxes.remove(MBX);
  s.advance(3 * DAY + 1000);
  await s.scheduler.tick();
  assert.strictEqual((await seqOf(s)).holdCode, 'MAILBOX_GONE');
  await rejectsCode(s.sequences.resume({ sequenceId }), 'MAILBOX_NOT_FOUND');

  const leads = { L1: lead({}), L2: lead({ id: 'L2', email: 'two@acme.example.com', website: 'https://two.example.com' }) };
  const t = await setup({ leads });
  const a = await active(t);
  t.advance(5 * 60 * 1000);
  await active(t, { leadId: 'L2' });
  await t.store.sequences.updateStep(a.sequenceId, 1, { limit_strikes: 3, updated_at: iso(t.clock.t) });
  t.gmail.next = [{ status: 429 }];
  t.advance(3 * DAY + 10 * 60 * 1000);
  await t.scheduler.tick();
  assert.strictEqual((await seqOf(t, 'L1')).holdCode, 'PROVIDER_LIMIT_REPEATED');
  assert.strictEqual((await seqOf(t, 'L2')).holdCode, 'PROVIDER_LIMIT_REPEATED');
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
