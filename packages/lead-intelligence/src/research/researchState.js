'use strict';

/**
 * Research-state helpers shared by every research source (the module's own coordinator
 * in "module" mode, or the round-1 prospect-research engine in "round1" mode).
 * Kept separate so profile/search code does not need to load the coordinator.
 */

/** Research state shown to users: stale overrides complete/partial when evidence expired. */
function effectiveState(job, packet, fresh) {
  if (!job && !packet) return 'not_researched';
  if (job && !['complete', 'partial', 'stale'].includes(job.state)) return job.state;
  if (packet && !fresh && packet.research_status !== 'failed') return 'stale';
  return job ? job.state : packet.research_status;
}

/** Job shape safe for the renderer (no options/paths). */
function publicJob(j) {
  return {
    job_id: j.job_id,
    lead_id: j.lead_id,
    provider_id: j.provider_id,
    requested_domain: j.requested_domain,
    state: j.state,
    provider_job_id: j.provider_job_id,
    attempts: j.attempts,
    next_attempt_at: j.next_attempt_at,
    last_error_code: j.last_error_code,
    last_error_message: j.last_error_message,
    packet_id: j.packet_id,
    created_at: j.created_at,
    updated_at: j.updated_at,
    finished_at: j.finished_at,
  };
}

/** Reads research job state from the module's own li_research_jobs table. */
function moduleStateReader(store) {
  return {
    latestPerLead: () => store.jobs.latestPerLead(),
    listByLead: (leadId) => store.jobs.listByLead(leadId),
  };
}

module.exports = { effectiveState, publicJob, moduleStateReader };
