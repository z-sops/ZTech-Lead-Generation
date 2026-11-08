'use strict';

/**
 * PgResearchJobs - the app-facing research-job queue operations on top of
 * li.job_queue, exposed through SECURITY DEFINER database functions.
 *
 * Every method is scoped to the store's workspace by the database itself
 * (li.current_workspace()), so the runtime role can never reach another
 * workspace's jobs. No table privilege is granted to the runtime role:
 * every mutation goes through a migrator-owned SECURITY DEFINER function
 * that is revoked from PUBLIC.
 */

class PgResearchJobs {
  constructor(store) { this.store = store; }

  /** Create a research job idempotently. Returns the job and a deduplicated flag. */
  async enqueue({ jobId, jobType, idempotencyKey, payload }) {
    return this.store.one('li_job_queue',
      'SELECT * FROM li.enqueue_research_job($1, $2, $3, $4::jsonb)',
      [jobId, jobType, idempotencyKey, JSON.stringify(payload)]);
  }

  /** List this workspace's research jobs, newest first. */
  async list({ limit = 50 } = {}) {
    return this.store.q('li_job_queue',
      'SELECT * FROM li.list_research_jobs($1)', [limit]);
  }

  /** Inspect one research job in this workspace. Null when it does not belong here. */
  async get({ jobId }) {
    return this.store.one('li_job_queue',
      'SELECT * FROM li.get_research_job($1)', [jobId]);
  }

  /** Request cancellation of one research job in this workspace. */
  async cancel({ jobId }) {
    return this.store.one('li_job_queue',
      'SELECT * FROM li.cancel_research_job($1)', [jobId]);
  }
}

module.exports = { PgResearchJobs };
