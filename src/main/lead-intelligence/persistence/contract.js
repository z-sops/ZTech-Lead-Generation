'use strict';

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
 *   listMetaByLead(leadId)              newest first, meta only
 *   getMeta(packetId)
 *   latestMetaPerLead()                 Map<leadId, meta>
 * changes:      insertMany(changes), listByLead(leadId)
 * savedSearches: upsert(rec), get(id), list(), delete(id)
 * segments:     upsert(rec), get(id), list(), delete(id), addMembers(id, leadIds, atIso),
 *               removeMembers(id, leadIds), members(id)
 * pitches:      upsert(rec), get(id), latestForLead(leadId)
 * approvals:    insert(rec), latestForPitch(pitchId)
 * enrichmentJobs: insert(job) (DuplicateActiveJobError if the lead already has an active job),
 *               update(job, expectedVersion), get(id), findActiveForLead(leadId), listByLead(leadId),
 *               listDue(nowIso), listByStates(states)
 * enrichmentObservations: upsertMany(obs[]) (same observation_id -> refresh collected_at/job_id),
 *               listByLead(leadId), listAllGrouped() -> Map<leadId, obs[]>
 * purgeLead(leadId)                     remove all lead-intelligence rows for a deleted lead
 */

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

module.exports = { PACKET_META_FIELDS, packetMeta };
