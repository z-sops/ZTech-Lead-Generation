'use strict';

/**
 * F28 - the email follow-up sequence contract: closed sets, limits and record normalizers.
 * Pure; no I/O.
 */

const { ValidationError } = require('../core/errors');

const SEQUENCE_STATUSES = Object.freeze(['draft', 'active', 'paused', 'stopped', 'completed']);
const OPEN_STATUSES = Object.freeze(['draft', 'active', 'paused']);
const STEP_STATES = Object.freeze(['waiting', 'scheduled', 'sending', 'sent', 'stopped']);
const STOP_REASONS = Object.freeze(['replied', 'suppressed', 'manual', 'contact_changed']);
const EVENT_ACTORS = Object.freeze(['operator', 'scheduler']);
const SEQUENCE_EVENTS = Object.freeze(['created', 'activated', 'sent', 'rescheduled', 'paused', 'resumed', 'stopped', 'completed']);

/**
 * Hold codes. AUTO holds clear by themselves (a time passes, or the mailbox is Ready again);
 * every other hold waits for a human Resume or Stop.
 */
const HOLD = Object.freeze({
  PROVIDER_LIMIT: 'PROVIDER_LIMIT',                     // auto: resume_at
  MAILBOX_RECONNECT_REQUIRED: 'MAILBOX_RECONNECT_REQUIRED', // auto: mailbox Ready again
  PROVIDER_LIMIT_REPEATED: 'PROVIDER_LIMIT_REPEATED',
  SEND_OUTCOME_UNKNOWN: 'SEND_OUTCOME_UNKNOWN',
  PACING_NO_WINDOW: 'PACING_NO_WINDOW',
  NEEDS_APPROVAL: 'NEEDS_APPROVAL',
  THREAD_UNAVAILABLE: 'THREAD_UNAVAILABLE',
  REPLIES_UNCHECKED: 'REPLIES_UNCHECKED',
  BLOCKED: 'BLOCKED',
  MANUAL: 'MANUAL',
});
const AUTO_HOLDS = Object.freeze([HOLD.PROVIDER_LIMIT, HOLD.MAILBOX_RECONNECT_REQUIRED]);
const HOLD_CODES = Object.freeze(Object.values(HOLD));

const LIMITS = Object.freeze({
  MAX_STEPS: 3,
  MIN_DELAY_DAYS: 2,
  MAX_DELAY_DAYS: 60,
  DEFAULT_DELAYS: Object.freeze([3, 7, 14]),
  // Gmail limit refusals: wait 1 h, then 4 h, then 24 h; a 4th limit in a row holds for a human.
  LIMIT_BACKOFF_MS: Object.freeze([60 * 60 * 1000, 4 * 60 * 60 * 1000, 24 * 60 * 60 * 1000]),
});

const DAY_MS = 24 * 60 * 60 * 1000;
const SEQUENCE_ID_RE = /^seq_[A-Za-z0-9-]{8,64}$/;
const ISO_OK = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v));
const CODE_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

function bad(message) { throw new ValidationError('Invalid sequence record', [{ path: '$', message }]); }

/** The delays a human chose (1-3 integers, 2-60 days each). */
function normalizeDelays(delays) {
  const list = delays === undefined ? [...LIMITS.DEFAULT_DELAYS] : delays;
  if (!Array.isArray(list) || list.length < 1 || list.length > LIMITS.MAX_STEPS) {
    throw new ValidationError('Invalid follow-up delays', [{ path: '$.delays', message: `choose 1 to ${LIMITS.MAX_STEPS} follow-ups` }]);
  }
  list.forEach((d, i) => {
    if (!Number.isInteger(d) || d < LIMITS.MIN_DELAY_DAYS || d > LIMITS.MAX_DELAY_DAYS) {
      throw new ValidationError('Invalid follow-up delays', [{ path: `$.delays[${i}]`, message: `each delay is ${LIMITS.MIN_DELAY_DAYS}-${LIMITS.MAX_DELAY_DAYS} whole days` }]);
    }
  });
  return list.slice();
}

function normalizeSequence(rec) {
  if (!rec || typeof rec.sequence_id !== 'string' || !SEQUENCE_ID_RE.test(rec.sequence_id)) bad('sequence_id');
  for (const k of ['lead_id', 'mailbox_id', 'first_send_id', 'first_pitch_id', 'thread_id', 'recipient_address']) {
    if (typeof rec[k] !== 'string' || !rec[k] || rec[k].length > 320) bad(k);
  }
  if (typeof rec.first_subject !== 'string' || !rec.first_subject || rec.first_subject.length > 200 || /[\r\n]/.test(rec.first_subject)) bad('first_subject');
  if (!SEQUENCE_STATUSES.includes(rec.status)) bad('status');
  const stopReason = rec.stop_reason == null ? null : rec.stop_reason;
  if (stopReason !== null && !STOP_REASONS.includes(stopReason)) bad('stop_reason');
  if ((rec.status === 'stopped') !== (stopReason !== null)) bad('stop_reason/status');
  const hold = rec.hold_code == null ? null : rec.hold_code;
  if (hold !== null && !HOLD_CODES.includes(hold)) bad('hold_code');
  if ((rec.status === 'paused') !== (hold !== null)) bad('hold_code/status');
  for (const k of ['first_accepted_at', 'created_at', 'updated_at']) if (!ISO_OK(rec[k])) bad(k);
  for (const k of ['resume_at', 'activated_at']) if (rec[k] != null && !ISO_OK(rec[k])) bad(k);
  return {
    sequence_id: rec.sequence_id, lead_id: String(rec.lead_id), mailbox_id: rec.mailbox_id, first_send_id: rec.first_send_id,
    first_pitch_id: rec.first_pitch_id, thread_id: rec.thread_id, first_subject: rec.first_subject,
    recipient_address: rec.recipient_address.trim().toLowerCase(), first_accepted_at: rec.first_accepted_at,
    status: rec.status, hold_code: hold, resume_at: rec.resume_at == null ? null : rec.resume_at, stop_reason: stopReason,
    activated_at: rec.activated_at == null ? null : rec.activated_at, created_at: rec.created_at, updated_at: rec.updated_at,
  };
}

function normalizeStep(rec) {
  if (!rec || typeof rec.sequence_id !== 'string' || !SEQUENCE_ID_RE.test(rec.sequence_id)) bad('step sequence_id');
  if (!Number.isInteger(rec.step_no) || rec.step_no < 1 || rec.step_no > LIMITS.MAX_STEPS) bad('step_no');
  if (typeof rec.pitch_id !== 'string' || !rec.pitch_id) bad('pitch_id');
  if (!Number.isInteger(rec.delay_days) || rec.delay_days < LIMITS.MIN_DELAY_DAYS || rec.delay_days > LIMITS.MAX_DELAY_DAYS) bad('delay_days');
  if (!STEP_STATES.includes(rec.state)) bad('state');
  for (const k of ['due_at', 'next_attempt_at', 'sent_at']) if (rec[k] != null && !ISO_OK(rec[k])) bad(k);
  if (rec.last_code != null && (typeof rec.last_code !== 'string' || !CODE_RE.test(rec.last_code))) bad('last_code');
  const strikes = rec.limit_strikes == null ? 0 : rec.limit_strikes;
  if (!Number.isInteger(strikes) || strikes < 0 || strikes > 10) bad('limit_strikes');
  if (!rec.draft || typeof rec.draft !== 'object' || rec.draft.pitch_id !== rec.pitch_id || rec.draft.kind !== 'followup') bad('draft');
  if (!ISO_OK(rec.updated_at)) bad('updated_at');
  return {
    sequence_id: rec.sequence_id, step_no: rec.step_no, pitch_id: rec.pitch_id, delay_days: rec.delay_days, state: rec.state,
    due_at: rec.due_at == null ? null : rec.due_at, next_attempt_at: rec.next_attempt_at == null ? null : rec.next_attempt_at,
    send_id: rec.send_id == null ? null : String(rec.send_id), sent_at: rec.sent_at == null ? null : rec.sent_at,
    last_code: rec.last_code == null ? null : rec.last_code, limit_strikes: strikes, draft: rec.draft, updated_at: rec.updated_at,
  };
}

function normalizeEvent(rec) {
  if (!rec || typeof rec.event_id !== 'string' || !/^sev_[A-Za-z0-9-]{8,64}$/.test(rec.event_id)) bad('event_id');
  if (typeof rec.sequence_id !== 'string' || !SEQUENCE_ID_RE.test(rec.sequence_id)) bad('event sequence_id');
  if (rec.step_no != null && (!Number.isInteger(rec.step_no) || rec.step_no < 1 || rec.step_no > LIMITS.MAX_STEPS)) bad('event step_no');
  if (!EVENT_ACTORS.includes(rec.actor)) bad('actor');
  if (!SEQUENCE_EVENTS.includes(rec.event)) bad('event');
  if (rec.code != null && (typeof rec.code !== 'string' || !CODE_RE.test(rec.code))) bad('code');
  if (!ISO_OK(rec.at)) bad('at');
  return { event_id: rec.event_id, sequence_id: rec.sequence_id, step_no: rec.step_no == null ? null : rec.step_no, actor: rec.actor, event: rec.event, code: rec.code == null ? null : rec.code, at: rec.at };
}

module.exports = {
  SEQUENCE_STATUSES, OPEN_STATUSES, STEP_STATES, STOP_REASONS, EVENT_ACTORS, SEQUENCE_EVENTS,
  HOLD, AUTO_HOLDS, HOLD_CODES, LIMITS, DAY_MS, SEQUENCE_ID_RE,
  normalizeDelays, normalizeSequence, normalizeStep, normalizeEvent,
};
