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

module.exports = {
  PACKET_META_FIELDS,
  packetMeta,
  PITCH_STATUSES,
  normalizePitchListQuery,
  PITCH_LIST_DEFAULT_LIMIT,
  PITCH_LIST_MAX_LIMIT,
  PITCH_LIST_MAX_OFFSET,
};
