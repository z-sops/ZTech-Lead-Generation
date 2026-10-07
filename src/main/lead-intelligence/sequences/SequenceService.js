'use strict';

/**
 * F28 - email follow-up sequences. MAIN PROCESS ONLY.
 *
 * Decisions (Zee, 7 Oct 2026):
 *   D1  Once a human has approved every step and ACTIVATED the sequence, ZTech sends each due step
 *       by itself (SequenceScheduler -> sendDueStep). This lifts F26.6's "one human click = one
 *       message" for F28 steps ONLY. Every send re-runs every gate (OutreachService.sendFromMailbox).
 *   D2  Each step is its own follow-up pitch with its own approval (content hash). All steps can be
 *       written and approved up front; activation needs every step approved.
 *   D3  Gmail, and only the connected mailbox that sent the first email.
 *   D4  "Re: <first subject>" only on a genuinely threaded follow-up.
 *   D5  Any verified reply (relay or mailbox, reviewed or not), unsubscribe / do-not-contact, a
 *       manual stop or a contact change stops the sequence for good.
 *   D6  Up to 3 follow-ups; defaults +3 / +7 / +14 calendar days after the previous accepted send.
 *
 * Refusal handling (never a blind retry):
 *   pacing / window      -> the step moves to the next allowed time
 *   Gmail limit          -> the mailbox's sequences pause; retry after 1 h, 4 h, 24 h; then a human
 *   mailbox not usable   -> pause until the mailbox is Ready again (reconnect + Check mailbox)
 *   outcome unknown      -> hold for a HUMAN decision (the message may have gone)
 *   reply / unsubscribe / do-not-contact / contact change -> stop
 *   anything else (trust, market, gate, approval, thread) -> hold for a human; no retry
 *
 * Nothing here reads a message body, holds a token or exposes an address to the renderer.
 */

const { newId } = require('../core/ids');
const { LiError, ValidationError, NotFoundError } = require('../core/errors');
const { generateFollowUp, renderPitchText } = require('../outreach/PitchGenerator');
const { sendIdempotencyKey } = require('../persistence/contract');
const { normalizeEmail } = require('../trust/trustContract');
const { STORED_ID_RE } = require('../mailbox/gmail/GmailMailboxTransport');
const { HOLD, AUTO_HOLDS, LIMITS, DAY_MS, OPEN_STATUSES, normalizeDelays } = require('./sequenceContract');

const RECONNECT_CODES = new Set([
  'MAILBOX_RECONNECT_NEEDED', 'MAILBOX_NOT_READY', 'MAILBOX_NOT_FOUND', 'MAILBOX_UNAVAILABLE', 'MAILBOX_PROVIDER_UNVERIFIED',
  'MAILBOX_CLIENT_NOT_CONFIGURED', 'MAILBOX_VAULT_UNAVAILABLE',
]);
// Gmail did NOT accept the message, for certain: safe to treat as "not sent".
const DEFINITELY_NOT_SENT = new Set([...RECONNECT_CODES, 'MAILBOX_PROVIDER_LIMIT', 'MAILBOX_PROVIDER_REJECTED', 'MAILBOX_REMOTE_NOT_FOUND', 'VALIDATION_FAILED']);
// Gmail may or may not have accepted it.
const OUTCOME_UNKNOWN = new Set(['MAILBOX_PROVIDER_UNAVAILABLE', 'MAILBOX_SEND_UNCONFIRMED', 'EMAIL_SEND_FAILED']);
const RETRY_NEXT_TICK = new Set(['MAILBOX_BUSY', 'SEND_IN_PROGRESS']);
// A failed reply check is a READ that failed: the follow-up waits; it is never sent unchecked.
const REPLY_CHECK_RETRY_MS = 15 * 60 * 1000;
const STOP_CODES = Object.freeze({ CONTACT_CHANGED: 'contact_changed', REPLY_REVIEW_REQUIRED: 'replied' });

const HOLD_MESSAGES = Object.freeze({
  [HOLD.PROVIDER_LIMIT]: 'Gmail refused because a sending limit was reached. ZTech tries again later by itself.',
  [HOLD.MAILBOX_RECONNECT_REQUIRED]: 'The mailbox needs to be reconnected and checked. The follow-ups continue once it is Ready again.',
  [HOLD.PROVIDER_LIMIT_REPEATED]: 'Gmail refused because of a sending limit four times in a row. Resume when you are ready, or stop.',
  [HOLD.SEND_OUTCOME_UNKNOWN]: 'ZTech could not tell whether Gmail sent the last follow-up. Check Gmail\'s Sent folder, then stop, or confirm it was not sent and resume.',
  [HOLD.PACING_NO_WINDOW]: 'The mailbox\'s sending window never opens. Fix the sending days or hours, then resume.',
  [HOLD.NEEDS_APPROVAL]: 'A follow-up changed after it was approved. Approve it again to continue.',
  [HOLD.THREAD_UNAVAILABLE]: 'An earlier message\'s Gmail id could not be read back, so this follow-up cannot be sent in the same thread.',
  [HOLD.REPLIES_UNCHECKED]: 'Gmail no longer had the history ZTech needed to check for a reply. Look in your inbox for a reply from this lead, then resume or stop.',
  [HOLD.BLOCKED]: 'A check refused this follow-up. Nothing was sent. Resume to re-run every check once, or stop.',
  [HOLD.MANUAL]: 'Paused by you.',
});

const iso = (ms) => new Date(ms).toISOString();
const maxIso = (a, b) => (Date.parse(a) >= Date.parse(b) ? a : b);

class SequenceService {
  /**
   * @param {{store: object, outreach: object, mailboxes?: object|null, clock?: () => Date, logger?: object|null}} deps
   */
  constructor({ store, outreach, mailboxes = null, clock = () => new Date(), logger = null } = {}) {
    if (!store || !store.sequences) throw new TypeError('SequenceService needs a store with sequences');
    if (!outreach) throw new TypeError('SequenceService needs the outreach service');
    this.store = store;
    this.outreach = outreach;
    this.mailboxes = mailboxes;
    this.clock = clock;
    this.logger = logger;
  }

  _now() { return this.clock(); }
  _nowIso() { return this.clock().toISOString(); }

  async _event(sequenceId, event, { stepNo = null, actor = 'operator', code = null } = {}) {
    try {
      await this.store.sequences.appendEvent({ event_id: newId('sev'), sequence_id: sequenceId, step_no: stepNo, actor, event, code, at: this._nowIso() });
    } catch (err) {
      if (this.logger && this.logger.warn) this.logger.warn(`[lead-intelligence] sequence event not recorded: ${(err && err.code) || 'ERROR'}`);
    }
  }

  async _require(sequenceId) {
    const seq = await this.store.sequences.get(sequenceId);
    if (!seq) throw new NotFoundError('Sequence', sequenceId);
    return seq;
  }

  async _approved(draft) {
    if (!draft || draft.status !== 'draft') return false;
    const approval = await this.store.approvals.latestForPitch(draft.pitch_id);
    return Boolean(approval && approval.content_hash === draft.content_hash);
  }

  /* ------------------------------ views ------------------------------ */

  async _view(seq) {
    if (!seq) return null;
    const steps = await this.store.sequences.steps(seq.sequence_id);
    const out = [];
    for (const st of steps) {
      const d = st.draft || {};
      out.push({
        stepNo: st.step_no, pitchId: st.pitch_id, delayDays: st.delay_days, state: st.state,
        approved: await this._approved(d), draftStatus: d.status || null,
        subject: `Re: ${seq.first_subject}`, text: d.opening ? renderPitchText(d) : '',
        opening: typeof d.opening === 'string' ? d.opening : '', callToAction: typeof d.callToAction === 'string' ? d.callToAction : '',
        dueAt: st.due_at, nextAttemptAt: st.next_attempt_at, sentAt: st.sent_at, lastCode: st.last_code,
      });
    }
    return {
      sequenceId: seq.sequence_id, leadId: seq.lead_id, mailboxId: seq.mailbox_id, status: seq.status,
      holdCode: seq.hold_code, holdMessage: seq.hold_code ? HOLD_MESSAGES[seq.hold_code] || null : null,
      autoResume: AUTO_HOLDS.includes(seq.hold_code), resumeAt: seq.resume_at, stopReason: seq.stop_reason,
      firstSubject: seq.first_subject, firstSentAt: seq.first_accepted_at, activatedAt: seq.activated_at,
      createdAt: seq.created_at, updatedAt: seq.updated_at, steps: out,
    };
  }

  /** The lead's newest sequence (open or finished), or null. */
  async forLead({ leadId }) {
    return this._view(await this.store.sequences.latestForLead(String(leadId)));
  }

  /** Every open sequence plus the Pause all switch. */
  async list() {
    const rows = await this.store.sequences.listOpen();
    const sequences = [];
    for (const r of rows) {
      let leadName = null;
      try {
        const ctx = await this.outreach.contexts.getContext(r.lead_id);
        leadName = ctx && ctx.view && typeof ctx.view.name === 'string' ? ctx.view.name : null;
      } catch { leadName = null; }
      sequences.push({ ...(await this._view(r)), leadName });
    }
    return { pausedAll: (await this.store.sequences.control()).paused, sequences };
  }

  /* ------------------------------ stop rules ------------------------------ */

  /** The D5 stop reason that applies to this sequence now, or null. */
  async _stopReason(seq) {
    const address = seq.recipient_address;
    if (this.store.suppressions && await this.store.suppressions.find({ channel: 'email', address })) return 'suppressed';
    if (this.store.trustEvents) {
      const reply = await this.store.trustEvents.latestFor({ channel: 'email', address, kinds: ['reply'] });
      if (reply && Date.parse(reply.received_at) >= Date.parse(seq.first_accepted_at)) return 'replied';
    }
    let current = null;
    try {
      const ctx = await this.outreach.contexts.getContext(seq.lead_id);
      current = ctx && ctx.view && ctx.view.email ? normalizeEmail(ctx.view.email) : null;
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err;
    }
    if (current !== seq.recipient_address) return 'contact_changed';
    return null;
  }

  async _stop(seq, reason, actor) {
    const at = this._nowIso();
    const done = await this.store.sequences.update(seq.sequence_id, { status: 'stopped', stop_reason: reason, hold_code: null, resume_at: null, updated_at: at }, { expect: OPEN_STATUSES });
    if (!done) return null;
    // A step in flight is left alone: if Gmail accepts it, that is recorded as the truth.
    for (const st of await this.store.sequences.steps(seq.sequence_id)) {
      if (st.state === 'waiting' || st.state === 'scheduled') await this.store.sequences.updateStep(seq.sequence_id, st.step_no, { state: 'stopped', next_attempt_at: null, updated_at: at }, { expect: ['waiting', 'scheduled'] });
    }
    await this._event(seq.sequence_id, 'stopped', { actor, code: reason.toUpperCase() });
    return done;
  }

  async _pause(seq, hold, { actor = 'scheduler', resumeAt = null, expect = ['active', 'paused'] } = {}) {
    const done = await this.store.sequences.update(seq.sequence_id, { status: 'paused', hold_code: hold, resume_at: resumeAt, updated_at: this._nowIso() }, { expect });
    if (done) await this._event(seq.sequence_id, 'paused', { actor, code: hold });
    return done;
  }

  /** The step currently in turn (the first one not yet sent), or null. */
  async _currentStep(sequenceId) {
    return (await this.store.sequences.steps(sequenceId)).find((s) => s.state !== 'sent' && s.state !== 'stopped') || null;
  }

  async _rearm(seq, actor, code) {
    const st = await this._currentStep(seq.sequence_id);
    const at = this._nowIso();
    if (st && st.state === 'scheduled') {
      await this.store.sequences.updateStep(seq.sequence_id, st.step_no, { next_attempt_at: maxIso(st.due_at || at, at), updated_at: at }, { expect: ['scheduled'] });
    }
    const done = await this.store.sequences.update(seq.sequence_id, { status: 'active', hold_code: null, resume_at: null, updated_at: at }, { expect: ['paused'] });
    if (done) await this._event(seq.sequence_id, 'resumed', { actor, code });
    return done;
  }

  /* ------------------------------ human actions ------------------------------ */

  /**
   * "Add follow-ups": a DRAFT sequence from the lead's newest first email that a connected
   * mailbox sent, Gmail accepted and ZTech read back. Nothing is scheduled until activation.
   */
  async create({ leadId, delays } = {}) {
    const lead = String(leadId || '');
    if (!lead) throw new ValidationError('Invalid lead', [{ path: '$.leadId', message: 'is required' }]);
    const plan = normalizeDelays(delays);
    if (await this.store.sequences.openForLead(lead)) throw new LiError('SEQUENCE_EXISTS', 'This lead already has follow-ups. Stop them first to start new ones.');

    const page = await this.store.sends.list({ leadId: lead, limit: 50 });
    let first = null;
    for (const r of page.rows || []) {
      if (r.state !== 'accepted' || !r.mailbox_id) continue;
      if (await this.store.sequences.stepByPitch(r.pitch_id)) continue; // a follow-up, not a first email
      first = r;
      break;
    }
    if (!first) throw new LiError('FIRST_EMAIL_REQUIRED', 'Follow-ups start from a first email sent from your connected mailbox. Send that first.');
    if (await this.store.sequences.forFirstSend(first.send_id)) throw new LiError('SEQUENCE_ALREADY_USED', 'That first email already had follow-ups. A new sequence needs a new first email.');
    const sent = this.store.mailboxSent ? await this.store.mailboxSent.get(first.send_id) : null;
    if (!sent || !sent.stored_message_id || !STORED_ID_RE.test(sent.stored_message_id) || !sent.thread_id || !sent.recipient_address) {
      throw new LiError('THREAD_UNAVAILABLE', 'Gmail\'s id for the first email could not be read back, so follow-ups cannot be sent in its thread.');
    }
    const firstPitch = await this.store.pitches.get(first.pitch_id);
    if (!firstPitch || firstPitch.content_hash !== first.content_hash) {
      throw new LiError('FIRST_EMAIL_CHANGED', 'The first email\'s pitch was edited after it was sent, so follow-ups cannot be written from it.');
    }
    if (!this.store.mailboxes || !(await this.store.mailboxes.get(first.mailbox_id))) throw new LiError('MAILBOX_NOT_FOUND', 'The mailbox that sent the first email is no longer connected.');

    const nowIso = this._nowIso();
    const seq = {
      sequence_id: newId('seq'), lead_id: lead, mailbox_id: first.mailbox_id, first_send_id: first.send_id, first_pitch_id: firstPitch.pitch_id,
      thread_id: sent.thread_id, first_subject: firstPitch.subject, recipient_address: normalizeEmail(sent.recipient_address),
      first_accepted_at: first.updated_at, status: 'draft', hold_code: null, resume_at: null, stop_reason: null, activated_at: null,
      created_at: nowIso, updated_at: nowIso,
    };
    const stop = await this._stopReason(seq);
    if (stop) throw new LiError('SEQUENCE_NOT_ALLOWED', stop === 'replied' ? 'They already replied, so no follow-ups are added.' : (stop === 'suppressed' ? 'This contact is on the do-not-contact list.' : 'The lead\'s email address changed since the first email.'));

    const packet = firstPitch.packet_id ? await this.store.packets.get(firstPitch.packet_id) : null;
    const ctx = await this.outreach.contexts.getContext(lead, { targetId: firstPitch.target_id ?? undefined });
    const steps = plan.map((delay, i) => {
      const draft = generateFollowUp({ first: firstPitch, packet, view: ctx && ctx.view ? ctx.view : {}, stepNo: i + 1, sequenceId: seq.sequence_id, firstSentAt: seq.first_accepted_at, now: this._now() });
      return { sequence_id: seq.sequence_id, step_no: i + 1, pitch_id: draft.pitch_id, delay_days: delay, state: 'waiting', due_at: null, next_attempt_at: null, send_id: null, sent_at: null, last_code: null, limit_strikes: 0, draft, updated_at: nowIso };
    });
    try {
      await this.store.sequences.create(seq, steps);
    } catch (err) {
      if (/UNIQUE/.test(String(err && err.message))) throw new LiError('SEQUENCE_EXISTS', 'This lead already has follow-ups.');
      throw err;
    }
    await this._event(seq.sequence_id, 'created');
    return this.forLead({ leadId: lead });
  }

  /** Save an edited step draft (from OutreachService.update). Sent or finished steps never change. */
  async saveStepDraft(draft) {
    const step = await this.store.sequences.stepByPitch(draft.pitch_id);
    if (!step) throw new NotFoundError('Pitch', draft.pitch_id);
    const seq = await this._require(step.sequence_id);
    if (!OPEN_STATUSES.includes(seq.status)) throw new LiError('SEQUENCE_CLOSED', 'These follow-ups have ended and can no longer change.');
    const saved = await this.store.sequences.updateStep(step.sequence_id, step.step_no, { draft, updated_at: this._nowIso() }, { expect: ['waiting', 'scheduled'] });
    if (!saved) throw new LiError('STEP_LOCKED', 'This follow-up is being sent or was sent, so it can no longer change.');
    // D2: an active sequence never sends a step whose approval no longer matches its content.
    if (seq.status === 'active' && !(await this._approved(draft))) await this._pause(seq, HOLD.NEEDS_APPROVAL, { actor: 'operator', expect: ['active'] });
    return saved;
  }

  /** After a step is approved: a sequence held only for approval continues once all are approved. */
  async onStepApproved(pitch) {
    const step = await this.store.sequences.stepByPitch(pitch.pitch_id);
    if (!step) return;
    const seq = await this.store.sequences.get(step.sequence_id);
    if (!seq || seq.status !== 'paused' || seq.hold_code !== HOLD.NEEDS_APPROVAL) return;
    if (await this._unapprovedSteps(seq)) return;
    if (await this._stopReason(seq)) return;
    await this._rearm(seq, 'operator', HOLD.NEEDS_APPROVAL);
  }

  async _unapprovedSteps(seq) {
    const out = [];
    for (const st of await this.store.sequences.steps(seq.sequence_id)) {
      if (st.state === 'sent' || st.state === 'stopped') continue;
      if (!(await this._approved(st.draft))) out.push(st.step_no);
    }
    return out.length ? out : null;
  }

  /** Activate: every step approved, the mailbox Ready. Step 1 becomes due at first send + delay. */
  async activate({ sequenceId }) {
    const seq = await this._require(sequenceId);
    if (seq.status !== 'draft') throw new LiError('SEQUENCE_NOT_DRAFT', 'Only follow-ups that were not started yet can be activated.');
    const missing = await this._unapprovedSteps(seq);
    if (missing) {
      const err = new LiError('STEPS_NOT_APPROVED', `Approve every follow-up first (not approved: ${missing.join(', ')}).`);
      err.details = { steps: missing };
      throw err;
    }
    if (!this.mailboxes) throw new LiError('MAILBOX_UNAVAILABLE', 'Mailboxes are not available here.');
    let gate;
    try { gate = await this.mailboxes.sendGate(seq.mailbox_id, { pacing: false }); } catch (err) { gate = { allowed: false, code: (err && err.code) || 'MAILBOX_NOT_FOUND', message: 'The mailbox that sent the first email is no longer connected.' }; }
    if (!gate.allowed) throw new LiError(gate.code, gate.message);
    const stop = await this._stopReason(seq);
    if (stop) {
      await this._stop(seq, stop, 'operator');
      throw new LiError('SEQUENCE_STOPPED', 'These follow-ups were stopped before they started.');
    }
    const steps = await this.store.sequences.steps(seq.sequence_id);
    const nowIso = this._nowIso();
    const due = maxIso(iso(Date.parse(seq.first_accepted_at) + steps[0].delay_days * DAY_MS), nowIso);
    const armed = await this.store.sequences.updateStep(seq.sequence_id, 1, { state: 'scheduled', due_at: due, next_attempt_at: due, updated_at: nowIso }, { expect: ['waiting'] });
    if (!armed) throw new LiError('SEQUENCE_CHANGED', 'These follow-ups changed. Look again, then activate.');
    const done = await this.store.sequences.update(seq.sequence_id, { status: 'active', activated_at: nowIso, updated_at: nowIso }, { expect: ['draft'] });
    if (!done) throw new LiError('SEQUENCE_CHANGED', 'These follow-ups changed. Look again, then activate.');
    await this._event(seq.sequence_id, 'activated');
    return this._view(done);
  }

  async pause({ sequenceId }) {
    const seq = await this._require(sequenceId);
    if (seq.status !== 'active' && !(seq.status === 'paused' && seq.hold_code !== HOLD.MANUAL)) throw new LiError('SEQUENCE_NOT_ACTIVE', 'Only running follow-ups can be paused.');
    const done = await this._pause(seq, HOLD.MANUAL, { actor: 'operator' });
    if (!done) throw new LiError('SEQUENCE_CHANGED', 'These follow-ups changed. Look again.');
    return this._view(done);
  }

  /**
   * Resume a paused sequence. Re-runs nothing itself: the scheduler re-checks EVERY gate at the next
   * send. After an unknown outcome the human must confirm, having looked in Gmail, that it was NOT
   * sent - otherwise the step could go out twice.
   */
  async resume({ sequenceId, confirmNotSent = false }) {
    const seq = await this._require(sequenceId);
    if (seq.status !== 'paused') throw new LiError('SEQUENCE_NOT_PAUSED', 'Only paused follow-ups can be resumed.');
    if (seq.hold_code === HOLD.SEND_OUTCOME_UNKNOWN && confirmNotSent !== true) {
      throw new LiError('CONFIRMATION_REQUIRED', 'Check Gmail\'s Sent folder first. Resume only if the follow-up was NOT sent; if it was, stop the sequence.');
    }
    const stop = await this._stopReason(seq);
    if (stop) {
      await this._stop(seq, stop, 'operator');
      throw new LiError('SEQUENCE_STOPPED', 'These follow-ups were stopped: a stop rule applies.');
    }
    const missing = await this._unapprovedSteps(seq);
    if (missing) throw new LiError('STEPS_NOT_APPROVED', `Approve every remaining follow-up first (not approved: ${missing.join(', ')}).`);
    const done = await this._rearm(seq, 'operator', seq.hold_code);
    if (!done) throw new LiError('SEQUENCE_CHANGED', 'These follow-ups changed. Look again.');
    return this._view(done);
  }

  async stop({ sequenceId }) {
    const seq = await this._require(sequenceId);
    if (!OPEN_STATUSES.includes(seq.status)) throw new LiError('SEQUENCE_CLOSED', 'These follow-ups have already ended.');
    const done = await this._stop(seq, 'manual', 'operator');
    if (!done) throw new LiError('SEQUENCE_CHANGED', 'These follow-ups changed. Look again.');
    return this._view(done);
  }

  async setPauseAll({ paused }) {
    if (typeof paused !== 'boolean') throw new ValidationError('Invalid switch', [{ path: '$.paused', message: 'must be true or false' }]);
    const r = await this.store.sequences.setControl({ paused, updatedAt: this._nowIso() });
    return { pausedAll: r.paused };
  }

  /* ------------------------------ scheduler side ------------------------------ */

  /**
   * Housekeeping before each tick: apply stop rules to every open sequence and clear AUTO holds
   * whose condition has passed. Sends nothing.
   */
  async sweep() {
    const now = this._now().getTime();
    for (const seq of await this.store.sequences.listOpen()) {
      const stop = await this._stopReason(seq);
      if (stop) { await this._stop(seq, stop, 'scheduler'); continue; }
      if (seq.status !== 'paused') continue;
      if (seq.hold_code === HOLD.PROVIDER_LIMIT && seq.resume_at && Date.parse(seq.resume_at) <= now) {
        await this._rearm(seq, 'scheduler', HOLD.PROVIDER_LIMIT);
      } else if (seq.hold_code === HOLD.MAILBOX_RECONNECT_REQUIRED && this.mailboxes) {
        let ready = false;
        try { ready = (await this.mailboxes.sendGate(seq.mailbox_id, { pacing: false })).allowed === true; } catch { ready = false; }
        if (ready) await this._rearm(seq, 'scheduler', HOLD.MAILBOX_RECONNECT_REQUIRED);
      }
    }
  }

  /**
   * Crash recovery (once, before the first tick): a step left 'sending' is NEVER re-sent blindly.
   *   accepted in the ledger      -> recorded as sent
   *   an attempt reached Gmail    -> held for a human (SEND_OUTCOME_UNKNOWN)
   *   no attempt was recorded     -> back to scheduled (Gmail was never contacted)
   */
  async recover() {
    for (const st of await this.store.sequences.stepsInState('sending')) {
      const seq = await this.store.sequences.get(st.sequence_id);
      if (!seq) continue;
      const key = sendIdempotencyKey({ channel: 'email', pitchId: st.pitch_id, contentHash: st.draft.content_hash });
      const accepted = await this.store.sends.findAccepted(key);
      if (accepted) { await this._accepted(seq, st, accepted.send_id, 'scheduler'); continue; }
      const attempt = await this._attemptSince(st.pitch_id, st.updated_at);
      await this.store.sequences.updateStep(seq.sequence_id, st.step_no, { state: 'scheduled', last_code: attempt ? HOLD.SEND_OUTCOME_UNKNOWN : st.last_code, updated_at: this._nowIso() }, { expect: ['sending'] });
      if (attempt && OPEN_STATUSES.includes(seq.status)) await this._pause(seq, HOLD.SEND_OUTCOME_UNKNOWN, { expect: ['active', 'paused'] });
    }
  }

  async _attemptSince(pitchId, sinceIso) {
    const page = await this.store.sends.list({ pitchId, limit: 20 });
    return (page.rows || []).find((r) => r.state !== 'accepted' && r.state !== 'blocked' && r.created_at >= sinceIso) || null;
  }

  async _threadFor(seq, step) {
    const steps = await this.store.sequences.steps(seq.sequence_id);
    const sendIds = [seq.first_send_id];
    for (const s of steps) {
      if (s.step_no >= step.step_no) break;
      if (s.state !== 'sent' || !s.send_id) return null;
      sendIds.push(s.send_id);
    }
    const references = [];
    let threadId = seq.thread_id;
    for (const id of sendIds) {
      const row = await this.store.mailboxSent.get(id);
      if (!row || !row.stored_message_id || !STORED_ID_RE.test(row.stored_message_id)) return null;
      if (row.thread_id && row.thread_id !== threadId) return null; // a different Gmail thread: never mix
      references.push(row.stored_message_id);
    }
    return { threadId, inReplyTo: references[references.length - 1], references };
  }

  async _reschedule(seq, step, atIso, code) {
    await this.store.sequences.updateStep(seq.sequence_id, step.step_no, { state: 'scheduled', next_attempt_at: atIso, last_code: code, updated_at: this._nowIso() }, { expect: ['scheduled', 'sending'] });
    await this._event(seq.sequence_id, 'rescheduled', { stepNo: step.step_no, actor: 'scheduler', code });
  }

  async _accepted(seq, step, sendId, actor) {
    const at = this._nowIso();
    const sendRow = await this.store.sends.get(sendId);
    const sentAt = sendRow && sendRow.updated_at ? sendRow.updated_at : at;
    await this.store.sequences.updateStep(seq.sequence_id, step.step_no, { state: 'sent', send_id: sendId, sent_at: sentAt, next_attempt_at: null, last_code: null, limit_strikes: 0, updated_at: at }, { expect: ['sending', 'scheduled', 'stopped'] });
    await this._event(seq.sequence_id, 'sent', { stepNo: step.step_no, actor });
    const fresh = await this.store.sequences.get(seq.sequence_id);
    const next = (await this.store.sequences.steps(seq.sequence_id)).find((s) => s.step_no === step.step_no + 1);
    if (!fresh || !OPEN_STATUSES.includes(fresh.status)) return;
    if (!next) {
      const done = await this.store.sequences.update(seq.sequence_id, { status: 'completed', hold_code: null, resume_at: null, updated_at: at }, { expect: OPEN_STATUSES });
      if (done) await this._event(seq.sequence_id, 'completed', { actor });
      return;
    }
    const due = iso(Date.parse(sentAt) + next.delay_days * DAY_MS);
    await this.store.sequences.updateStep(seq.sequence_id, next.step_no, { state: 'scheduled', due_at: due, next_attempt_at: due, updated_at: at }, { expect: ['waiting'] });
  }

  /** Gmail refused because of a limit: every active sequence of that mailbox waits; strikes grow. */
  async _providerLimit(seq, step) {
    const strikes = (step.limit_strikes || 0) + 1;
    const at = this._nowIso();
    if (strikes > LIMITS.LIMIT_BACKOFF_MS.length) {
      await this.store.sequences.updateStep(seq.sequence_id, step.step_no, { state: 'scheduled', limit_strikes: Math.min(strikes, 10), last_code: 'MAILBOX_PROVIDER_LIMIT', updated_at: at }, { expect: ['sending', 'scheduled'] });
      await this._pause(seq, HOLD.PROVIDER_LIMIT_REPEATED);
      return;
    }
    const until = iso(this._now().getTime() + LIMITS.LIMIT_BACKOFF_MS[strikes - 1]);
    await this.store.sequences.updateStep(seq.sequence_id, step.step_no, { state: 'scheduled', limit_strikes: strikes, last_code: 'MAILBOX_PROVIDER_LIMIT', next_attempt_at: until, updated_at: at }, { expect: ['sending', 'scheduled'] });
    for (const other of await this.store.sequences.listOpen()) {
      if (other.mailbox_id !== seq.mailbox_id || other.status !== 'active') continue;
      await this._pause(other, HOLD.PROVIDER_LIMIT, { resumeAt: until, expect: ['active'] });
    }
  }

  /**
   * Send ONE due step (scheduler only). Returns a short outcome word for the scheduler's log.
   * Order: still active -> approval -> thread -> read replies + stop rules -> mailbox gate incl. pacing ->
   * mark 'sending' -> the send boundary (which re-runs EVERY gate) -> record what happened.
   */
  async sendDueStep(step) {
    const seq = await this.store.sequences.get(step.sequence_id);
    if (!seq || seq.status !== 'active') return 'skipped';
    // (The stop rules ran in this tick's sweep, and run again below once replies are read.)
    const cur = await this._currentStep(seq.sequence_id);
    if (!cur || cur.step_no !== step.step_no || cur.state !== 'scheduled') return 'skipped';
    if (!(await this._approved(cur.draft))) { await this._pause(seq, HOLD.NEEDS_APPROVAL); return 'held'; }
    const thread = await this._threadFor(seq, cur);
    if (!thread) { await this._pause(seq, HOLD.THREAD_UNAVAILABLE); return 'held'; }
    if (!this.mailboxes) { await this._pause(seq, HOLD.MAILBOX_RECONNECT_REQUIRED); return 'paused'; }

    // D5: a reply Gmail already holds but ZTech has not read yet must still stop this follow-up, so
    // the mailbox's replies are read (headers only) right before every follow-up is sent.
    let check;
    try {
      check = await this.mailboxes.syncReplies({ mailboxId: seq.mailbox_id });
    } catch (err) {
      const code = err && typeof err.code === 'string' ? err.code : 'REPLY_CHECK_FAILED';
      if (RECONNECT_CODES.has(code)) { await this._pause(seq, HOLD.MAILBOX_RECONNECT_REQUIRED); return 'paused'; }
      await this._reschedule(seq, cur, iso(this._now().getTime() + REPLY_CHECK_RETRY_MS), 'REPLY_CHECK_FAILED');
      return 'rescheduled';
    }
    const late = await this._stopReason(seq);
    if (late) { await this._stop(seq, late, 'scheduler'); return 'stopped'; }
    if (check && check.cursorReset) { await this._pause(seq, HOLD.REPLIES_UNCHECKED); return 'held'; }

    let gate;
    try { gate = await this.mailboxes.sendGate(seq.mailbox_id); } catch (err) { gate = { allowed: false, code: (err && err.code) || 'MAILBOX_NOT_FOUND' }; }
    if (!gate.allowed) return this._onRefusal(seq, cur, gate.code, { nextAllowedAt: gate.nextAllowedAt, attempted: false });

    const sending = await this.store.sequences.updateStep(seq.sequence_id, cur.step_no, { state: 'sending', updated_at: this._nowIso() }, { expect: ['scheduled'] });
    if (!sending) return 'skipped';
    const followUp = {
      pitchId: cur.pitch_id, mailboxId: seq.mailbox_id, recipient: seq.recipient_address, firstSubject: seq.first_subject,
      threadId: thread.threadId, inReplyTo: thread.inReplyTo, references: thread.references,
    };
    let result;
    try {
      result = await this.outreach.sendFromMailbox({ pitchId: cur.pitch_id, mailboxId: seq.mailbox_id }, { followUp });
    } catch (err) {
      const code = err && typeof err.code === 'string' ? err.code : 'UNEXPECTED_ERROR';
      const details = err && err.details ? err.details : {};
      return this._onRefusal(seq, sending, code, { nextAllowedAt: details.nextAllowedAt, attempted: true });
    }
    await this._accepted(seq, sending, result.sendId, 'scheduler');
    return result.outcome === 'replayed' ? 'replayed' : 'sent';
  }

  async _onRefusal(seq, step, code, { nextAllowedAt = undefined, attempted = false } = {}) {
    // A stop rule always wins over any other reading of the refusal.
    const stop = (await this._stopReason(seq)) || STOP_CODES[code] || null;
    if (stop) {
      await this.store.sequences.updateStep(seq.sequence_id, step.step_no, { state: 'scheduled', last_code: code, updated_at: this._nowIso() }, { expect: ['sending'] });
      await this._stop(seq, stop, 'scheduler');
      return 'stopped';
    }
    if (code === 'MAILBOX_PACING') {
      if (nextAllowedAt) { await this._reschedule(seq, step, nextAllowedAt, code); return 'rescheduled'; }
      await this.store.sequences.updateStep(seq.sequence_id, step.step_no, { state: 'scheduled', last_code: code, updated_at: this._nowIso() }, { expect: ['sending', 'scheduled'] });
      await this._pause(seq, HOLD.PACING_NO_WINDOW);
      return 'held';
    }
    if (RETRY_NEXT_TICK.has(code)) { await this._reschedule(seq, step, iso(this._now().getTime() + 60 * 1000), code); return 'rescheduled'; }
    if (code === 'MAILBOX_PROVIDER_LIMIT') { await this._providerLimit(seq, step); return 'paused'; }
    const back = async () => this.store.sequences.updateStep(seq.sequence_id, step.step_no, { state: 'scheduled', last_code: code, updated_at: this._nowIso() }, { expect: ['sending', 'scheduled'] });
    if (RECONNECT_CODES.has(code)) { await back(); await this._pause(seq, HOLD.MAILBOX_RECONNECT_REQUIRED); return 'paused'; }
    if (code === 'THREAD_UNAVAILABLE') { await back(); await this._pause(seq, HOLD.THREAD_UNAVAILABLE); return 'held'; }
    // Did a request reach Gmail without a clear answer? Then only a human may decide.
    const unknown = attempted && !DEFINITELY_NOT_SENT.has(code) && (OUTCOME_UNKNOWN.has(code) || Boolean(await this._attemptSince(step.pitch_id, step.updated_at)));
    await back();
    await this._pause(seq, unknown ? HOLD.SEND_OUTCOME_UNKNOWN : HOLD.BLOCKED);
    return 'held';
  }
}

module.exports = { SequenceService, HOLD_MESSAGES };
