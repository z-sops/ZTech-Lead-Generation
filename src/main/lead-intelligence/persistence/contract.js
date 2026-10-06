'use strict';

const { ValidationError } = require('../core/errors');

/**
 * Repository contract shared by MemoryStore (tests) and SqlJsStore (ZTech sql.js DB).
 * Every method is async so a different backing store can be swapped in.
 *
 * jobs:
 *   insert(job)                         throws DuplicateActiveJobError if an active job has the same request_key
 *   update(job, expectedVersion)        compare-and-set on `version`; throws ConflictError / NotFoundError
 *   get(jobId)
 *   findActive(requestKey)
 *   listByLead(leadId)                  newest first
 *   listDue(nowIso)                     requested/preflight/started, or polling/pending with next_attempt_at <= now
 *   listByStates(states)
 *   latestPerLead()                     Map<leadId, job>
 * packets:
 *   insert(packet)
 *   get(packetId)
 *   latestForLead(leadId)               full packet, newest captured_at
 *   previousForLead(leadId, packetId)   the newest packet older than packetId (for change detection)
 *   listMetaByLead(leadId)              newest meta first, meta only
 *   getMeta(packetId)
 *   latestMetaPerLead()                 Map<leadId, meta>
 * changes:      insertMany(changes), listByLead(leadId)
 * savedSearches: upsert(rec), get(id), list(), delete(id)
 * segments:     upsert(rec), get(id), list(), delete(id), addMembers(id, leadIds, atIso),
 *               removeMembers(id, leadIds), members(id)
 * pitches:      upsert(rec), get(id), latestForLead(leadId), list({limit, offset, status})
 * approvals:    insert(rec), latestForPitch(pitchId)
 * enrichmentJobs: insert(job) (DuplicateActiveJobError if the lead already has an active job),
 *               update(job, expectedVersion), get(id), findActiveForLead(leadId), listByLead(leadId),
 *               listDue(nowIso), listByStates(states)
 * enrichmentObservations: upsertMany(obs[]) (same observation_id -> refresh collected_at/job_id),
 *               listByLead(leadId), listAllGrouped() -> Map<leadId, obs[]>
 * purgeLead(leadId)                     remove all lead-intelligence rows for a deleted lead
 */

/**
 * The persisted pitch.status values, mirroring PitchGenerator.statusFor(). This is the
 * COMPLETE set: `approved`, `approval_required`, `sent` and `failed` are NOT pitch states
 * in this architecture. `blocked`/`allowed` belong to OutreachGate.decision, which is
 * computed on read and never persisted, so it can never be filtered on here.
 *
 * Kept in this shared module so the SQL store and the memory store validate against ONE
 * definition instead of two lists that can drift apart. tests/lead-intelligence/
 * persistence.test.js pins this set against PitchGenerator.statusFor()'s own output.
 */
const PITCH_STATUSES = Object.freeze(['draft', 'insufficient_evidence', 'needs_revision']);

// Paging bounds follow ZTech's existing paginated query convention
// (AccountStore.queryNumbers): a non-integer or out-of-range value falls back to the
// default rather than being rejected, so a malformed page request can never error or
// silently read the whole table.
const PITCH_LIST_DEFAULT_LIMIT = 20;
const PITCH_LIST_MAX_LIMIT = 100;
const PITCH_LIST_MAX_OFFSET = 100000;

/**
 * Validate and clamp a pitch list query. Unknown `status` IS rejected, because silently
 * returning an empty page for a typo'd status would look like "no pitches" in a
 * workspace rather than a caller bug.
 *
 * @param {{limit?: number, offset?: number, status?: string|null}} [query]
 * @returns {{limit: number, offset: number, status: string|null}}
 */
function normalizePitchListQuery(query) {
  const q = query && typeof query === 'object' && !Array.isArray(query) ? query : {};
  let status = null;
  if (q.status !== undefined && q.status !== null && q.status !== '') {
    if (typeof q.status !== 'string' || !PITCH_STATUSES.includes(q.status)) {
      throw new ValidationError('pitch status filter is invalid', [{
        path: '$.status',
        message: `must be one of ${PITCH_STATUSES.join(', ')}`,
      }]);
    }
    status = q.status;
  }
  return {
    status,
    limit: Number.isInteger(q.limit) && q.limit >= 1 && q.limit <= PITCH_LIST_MAX_LIMIT ? q.limit : PITCH_LIST_DEFAULT_LIMIT,
    offset: Number.isInteger(q.offset) && q.offset >= 0 && q.offset <= PITCH_LIST_MAX_OFFSET ? q.offset : 0,
  };
}

const PACKET_META_FIELDS = ['packet_id', 'lead_id', 'job_id', 'research_status', 'footprint_state', 'requested_domain', 'captured_at', 'expires_at', 'created_at'];

function packetMeta(packet) {
  return {
    packet_id: packet.packet_id,
    lead_id: packet.lead_id,
    job_id: packet.job_id,
    research_status: packet.research_status,
    footprint_state: packet.digital_footprint.state,
    requested_domain: packet.requested_domain,
    captured_at: packet.captured_at,
    expires_at: packet.freshness.expires_at,
    created_at: packet.created_at,
  };
}

// === F15: outreach activity ===
//
// The canonical allowlist of outreach events. It is CLOSED, and deliberately tiny: an
// event type may only be listed here if this codebase can prove it happened at a real
// mutation boundary.
//
// F19 adds the four SEND-BOUNDARY events. They are named CHANNEL-NEUTRALLY on purpose -
// exactly like the F18 preparation shape - because the channel is a fact recorded in
// metadata, not part of the event's identity. A later WhatsApp send therefore records the
// SAME four types with channel "whatsapp" and needs no further schema change.
//
//   OUTREACH_SEND_BLOCKED    a human asked to send and ZTech refused BEFORE contacting a
//                            provider (gate not allowed, nothing configured, or the
//                            message failed validation).
//   OUTREACH_SEND_ATTEMPTED  a provider WAS called. Written BEFORE the call so a crash
//                            mid-send leaves proof of contact rather than silence.
//   OUTREACH_SEND_ACCEPTED   the provider returned its own message id.
//   OUTREACH_SEND_FAILED     the provider refused, or the call failed.
//
// There is STILL intentionally no DELIVERED, OPENED, CLICKED, BOUNCED or QUEUED type.
// A provider accepting a message does not prove it arrived, and nothing in this build
// observes an inbox, so such a row could only ever be fabrication. Those facts stay
// 'unknown' forever unless a real observer exists to report them. CALL_PLACED and
// CAMPAIGN_STARTED remain absent for the same reason.
const ACTIVITY_TYPES = Object.freeze([
  'PITCH_APPROVED',
  'OUTREACH_READY',
  'APPROVAL_INVALIDATED',
  'OUTREACH_SEND_BLOCKED',
  'OUTREACH_SEND_ATTEMPTED',
  'OUTREACH_SEND_ACCEPTED',
  'OUTREACH_SEND_FAILED'
]);
const ACTIVITY_DEFAULT_LIMIT = 20;
const ACTIVITY_MAX_LIMIT = 100;
const ACTIVITY_MAX_OFFSET = 100000;
// Metadata is a CLOSED set of scalar facts about the event, not a place to put anything.
// Keys are matched exactly and every value must be a string, so no nested object, array,
// credential, provider payload or evidence packet can ever be smuggled into the row.
//
// F19 adds five send keys. Note what is deliberately ABSENT: there is no `to`, `recipient`,
// `email`, `phone`, `body`, `text` or `subject` key. The recipient address is personal
// data and the pitch body is already recoverable from the pitch itself, so neither is
// duplicated into the ledger - the row links to the lead and pitch instead.
const ACTIVITY_METADATA_KEYS = Object.freeze([
  'approvedBy',
  'contentHash',
  'reason',
  'channel',
  'providerId',
  'providerMessageId',
  'idempotencyKey',
  'failureCode'
]);
const ACTIVITY_METADATA_MAX_LENGTH = 200;

/**
 * Validate and normalise one activity record's metadata against the closed key set.
 * Returns { ok, value } or { ok:false, error }. Unknown keys and non-string values are
 * refused rather than dropped, so a caller can never believe it recorded something the
 * ledger did not store.
 */
function normalizeActivityMetadata(value) {
  if (value === undefined || value === null) return { ok: true, value: {} };
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'Invalid activity: metadata' };
  }
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!ACTIVITY_METADATA_KEYS.includes(key)) return { ok: false, error: 'Invalid activity: metadata key: ' + key };
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== 'string') return { ok: false, error: 'Invalid activity: metadata value: ' + key };
    if (raw.length > ACTIVITY_METADATA_MAX_LENGTH) return { ok: false, error: 'Invalid activity: metadata value: ' + key };
    out[key] = raw;
  }
  return { ok: true, value: out };
}

/**
 * Read query for activity history: bounded paging, optionally narrowed to one lead or
 * one pitch. A caller can never ask for the whole ledger, because limit is capped.
 */
function normalizeActivityQuery(query) {
  const q = query && typeof query === 'object' && !Array.isArray(query) ? query : {};
  const clampInt = (value, fallback, max) => {
    if (value === undefined || value === null) return fallback;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0) return fallback;
    return Math.min(n, max);
  };
  const limit = clampInt(q.limit, ACTIVITY_DEFAULT_LIMIT, ACTIVITY_MAX_LIMIT) || ACTIVITY_DEFAULT_LIMIT;
  const offset = clampInt(q.offset, 0, ACTIVITY_MAX_OFFSET);
  const leadId = typeof q.leadId === 'string' && q.leadId ? q.leadId : null;
  const pitchId = typeof q.pitchId === 'string' && q.pitchId ? q.pitchId : null;
  return { limit, offset, leadId, pitchId };
}

// === F19: the send ledger ===

// The CLOSED set of send states. Each one is a fact provable at the send boundary.
// Note what is absent: there is no `delivered`, `opened`, `clicked`, `bounced` or
// `queued`. A provider acknowledgement proves only that the provider accepted the
// message; it does not prove arrival, and this build observes no inbox.
const SEND_STATES = Object.freeze(['attempted', 'accepted', 'failed', 'blocked']);

// F19 ships the email channel. F20 adds WhatsApp. The table is channel-shaped
// (not email-shaped) so channels are data; the allowlist stays CLOSED.
const SEND_CHANNELS = Object.freeze(['email', 'whatsapp']);

// Bounds a provider's own identifier may occupy. A provider message id is remote text, so
// it is length-capped before it can ever reach a row, a log or the renderer.
const SEND_PROVIDER_ID_MAX_LENGTH = 200;
const SEND_FAILURE_MESSAGE_MAX_LENGTH = 200;

/**
 * The idempotency key for one send.
 *
 * Derived ONLY from facts that identify WHAT is being sent - channel, pitch and the exact
 * approved content hash. It deliberately contains no timestamp, counter, random id or
 * attempt number, because any of those would produce a different key on a retry and defeat
 * the guarantee entirely. The same approved content therefore always maps to the same key,
 * and the database's partial unique index (one ACCEPTED per key) does the rest.
 */
function sendIdempotencyKey({ channel, pitchId, contentHash }) {
  return require('crypto')
    .createHash('sha256')
    .update(`ztech-outreach-send ${String(channel)} ${String(pitchId)} ${String(contentHash)}`)
    .digest('hex');
}

/**
 * Validate one send-state transition record before it reaches the store.
 * Returns { ok, value } or { ok:false, error }. Remote provider text is never copied into
 * failure_message - only ZTech's own code is recorded - so no provider payload, address
 * or credential can leak into a row or a log through this path.
 */
function normalizeSendRecord(rec) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
    return { ok: false, error: 'Invalid send record' };
  }
  if (!SEND_CHANNELS.includes(rec.channel)) return { ok: false, error: 'Invalid send: channel' };
  if (!SEND_STATES.includes(rec.state)) return { ok: false, error: 'Invalid send: state' };
  const str = (v) => (v === undefined || v === null ? null : String(v));
  const providerId = str(rec.provider_id);
  const providerMessageId = str(rec.provider_message_id);
  const failureCode = str(rec.failure_code);
  const failureMessage = str(rec.failure_message);
  if (providerId && providerId.length > SEND_PROVIDER_ID_MAX_LENGTH) return { ok: false, error: 'Invalid send: provider_id' };
  if (providerMessageId && providerMessageId.length > SEND_PROVIDER_ID_MAX_LENGTH) return { ok: false, error: 'Invalid send: provider_message_id' };
  if (failureCode && failureCode.length > SEND_PROVIDER_ID_MAX_LENGTH) return { ok: false, error: 'Invalid send: failure_code' };
  if (failureMessage && failureMessage.length > SEND_FAILURE_MESSAGE_MAX_LENGTH) return { ok: false, error: 'Invalid send: failure_message' };
  return {
    ok: true,
    value: {
      channel: rec.channel,
      state: rec.state,
      provider_id: providerId,
      provider_message_id: providerMessageId,
      failure_code: failureCode,
      failure_message: failureMessage
    }
  };
}

/**
 * Bounded read query for the send ledger, mirroring normalizeActivityQuery: a caller can
 * never ask for the whole ledger, because limit is capped.
 */
function normalizeSendQuery(query) {
  const q = query && typeof query === 'object' && !Array.isArray(query) ? query : {};
  const clampInt = (value, fallback, max) => {
    if (value === undefined || value === null) return fallback;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0) return fallback;
    return Math.min(n, max);
  };
  const limit = clampInt(q.limit, ACTIVITY_DEFAULT_LIMIT, ACTIVITY_MAX_LIMIT) || ACTIVITY_DEFAULT_LIMIT;
  const offset = clampInt(q.offset, 0, ACTIVITY_MAX_OFFSET);
  const leadId = typeof q.leadId === 'string' && q.leadId ? q.leadId : null;
  const pitchId = typeof q.pitchId === 'string' && q.pitchId ? q.pitchId : null;
  return { limit, offset, leadId, pitchId };
}

// === F16: the derived Ready query ===
//
// Readiness is NOT a status and NOT a stored flag. A pitch is Ready only when the
// existing OutreachGate returns `allowed`. So the query is a DERIVED, gate-filtered view,
// which has a property no plain table read has: an exact row count is unknowable without
// evaluating the gate for every persisted pitch.
//
// Therefore there is deliberately NO `total` here and none in the response. Returning one
// would mean either scanning the whole pitch table (unbounded work per request) or
// inventing a number. Instead the envelope is cursor-shaped:
//
//   rows        the ready pitches actually found inside this scan window
//   scanned     how many candidates were gate-evaluated in this call
//   cursor      the scan position this call started at
//   nextCursor  where the next call resumes, or null when nothing remains
//   hasMore     whether any candidate remains unscanned
//
// `scanLimit` is the hard bound on gate evaluations per call, which is what keeps this
// honest: a caller can never make the main process evaluate an unbounded number of gates.
const READY_PAGE_DEFAULT_LIMIT = 10;
const READY_PAGE_MAX_LIMIT = 25;
const READY_SCAN_DEFAULT = 50;
const READY_SCAN_MAX = 200;

/** Bounded inputs for the derived Ready query. Returns { cursor, limit, scanLimit }. */
function normalizeReadyQuery(query) {
  const q = query && typeof query === 'object' && !Array.isArray(query) ? query : {};
  const int = (value, fallback, max) => {
    if (value === undefined || value === null) return fallback;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0) return fallback;
    return Math.min(n, max);
  };
  const scanLimit = int(q.scanLimit, READY_SCAN_DEFAULT, READY_SCAN_MAX);
  return {
    cursor: int(q.cursor, 0, PITCH_LIST_MAX_OFFSET),
    // Never ask for more ready rows than we are willing to evaluate in one call.
    limit: Math.min(int(q.limit, READY_PAGE_DEFAULT_LIMIT, READY_PAGE_MAX_LIMIT), scanLimit),
    scanLimit
  };
}

module.exports = {
  PACKET_META_FIELDS,
  packetMeta,
  PITCH_STATUSES,
  normalizePitchListQuery,
  PITCH_LIST_DEFAULT_LIMIT,
  PITCH_LIST_MAX_LIMIT,
  PITCH_LIST_MAX_OFFSET,
  ACTIVITY_TYPES,
  ACTIVITY_METADATA_KEYS,
  ACTIVITY_DEFAULT_LIMIT,
  ACTIVITY_MAX_LIMIT,
  ACTIVITY_MAX_OFFSET,
  normalizeActivityMetadata,
  normalizeActivityQuery,

  SEND_STATES,
  SEND_CHANNELS,
  SEND_PROVIDER_ID_MAX_LENGTH,
  SEND_FAILURE_MESSAGE_MAX_LENGTH,
  sendIdempotencyKey,
  normalizeSendRecord,
  normalizeSendQuery,
  READY_PAGE_DEFAULT_LIMIT,
  READY_PAGE_MAX_LIMIT,
  READY_SCAN_DEFAULT,
  READY_SCAN_MAX,
  normalizeReadyQuery,
};
