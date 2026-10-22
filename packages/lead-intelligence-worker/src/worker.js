'use strict';

const { withJobContext, withTransaction } = require('./db');
const { IdentityProvider } = require('./identity');
const { executeNoop } = require('./noop');

/**
 * The worker runtime.
 *
 * The loop is: claim a job, obtain an execution credential for it, open
 * the job context, run the job, write the result. A heartbeat renews the
 * lease while the job runs. A graceful shutdown stops the loop, lets the
 * current job finish, and releases it.
 *
 * Every step is authorised by the DATABASE, not by this process: the claim
 * verifies the identity credential, the execution credential is signed only
 * after the lease and the fencing token have been checked, and the write is
 * fenced. A worker that cannot renew or refresh its authority stops doing
 * protected work.
 */
class Worker {
  /**
   * @param {{pool: import('pg').Pool, config: object, logger: object,
   *          identity?: IdentityProvider, executor?: Function, now?: () => number}} deps
   */
  constructor(deps) {
    this.pool = deps.pool;
    this.config = deps.config;
    this.log = deps.logger;
    this.identity = deps.identity || new IdentityProvider(deps.config);
    this.executor = deps.executor || executeNoop;
    this.now = deps.now || (() => Date.now());
    this.running = false;
    this.stopping = false;
    this.current = null;
    this.heartbeat = null;
    this.processed = 0;
  }

  /** Ask the loop to stop. The current job is allowed to finish. */
  stop() {
    this.stopping = true;
    this.running = false;
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  /**
   * Claim one job.
   *
   * @returns {Promise<object|null>}
   */
  async claim() {
    const identityToken = await this.identity.get();
    const rows = await withTransaction(this.pool, (client) => client.query(
      'SELECT * FROM li.claim_job($1, $2)',
      [identityToken, this.config.leaseSeconds],
    ));
    return rows.rows.length ? rows.rows[0] : null;
  }

  /**
   * Renew the lease of the job that is running.
   *
   * @param {object} job
   * @returns {Promise<boolean>} whether the renewal was accepted
   */
  async renew(job) {
    try {
      const identityToken = await this.identity.get();
      await withTransaction(this.pool, (client) => client.query(
        'SELECT li.renew_lease($1, $2, $3, $4)',
        [job.job_id, job.fencing_token, identityToken, this.config.leaseSeconds],
      ));
      return true;
    } catch (err) {
      // A worker that cannot renew its lease must stop doing protected work.
      this.log.warn('lease.renewal_failed', { job_id: job.job_id, error: err });
      this.stop();
      return false;
    }
  }

  /**
   * Obtain the execution credential for a claimed job.
   *
   * @param {object} job
   * @returns {Promise<string>}
   */
  async executionToken(job) {
    const identityToken = await this.identity.get();
    const rows = await withTransaction(this.pool, (client) => client.query(
      'SELECT li.request_job_token($1, $2, $3, $4)',
      [job.job_id, job.fencing_token, identityToken, this.config.tokenTtlSeconds],
    ));
    return rows.rows[0].request_job_token;
  }

  /**
   * Is the job still to be run? The cancellation checkpoint.
   *
   * @param {object} job
   * @returns {Promise<boolean>}
   */
  async isCancelled(job) {
    const rows = await withJobContext(this.pool, job.job_id, job.token, (client) => client.query(
      'SELECT state FROM li.job_queue WHERE job_id = $1',
      [job.job_id],
    ));
    return rows.rows.length ? rows.rows[0].state === 'cancelled' : true;
  }

  /**
   * Write the outcome. The write is FENCED: a worker whose lease was
   * reclaimed writes ZERO rows, and the worker knows it.
   *
   * @param {object} job
   * @param {string} state
   * @param {object|null} result
   * @param {string|null} error
   * @returns {Promise<number>} the rows written
   */
  async writeResult(job, state, result, error) {
    const rows = await withJobContext(this.pool, job.job_id, job.token, (client) => client.query(
      'SELECT li.write_job_result($1, $2, $3, $4, $5)',
      [job.job_id, job.fencing_token, state, result ? JSON.stringify(result) : null, error],
    ));
    return rows.rows[0].write_job_result;
  }

  /**
   * Run one claimed job, end to end.
   *
   * @param {object} job
   */
  async runJob(job) {
    this.current = job;
    this.log.info('job.claimed', {
      job_id: job.job_id, job_type: job.job_type, fencing_token: job.fencing_token,
      attempt_count: job.attempt_count,
    });

    // The heartbeat: the lease is renewed while the job runs. A worker
    // that cannot renew stops.
    this.heartbeat = setInterval(() => {
      this.renew(job).catch(() => {});
    }, this.config.heartbeatSeconds * 1000);
    if (this.heartbeat.unref) this.heartbeat.unref();

    try {
      job.token = await this.executionToken(job);

      // The cancellation checkpoint: before the work, and before the write.
      if (await this.isCancelled(job)) {
        await this.writeResult(job, 'cancelled', null, 'the job was cancelled');
        this.log.info('job.cancelled', { job_id: job.job_id });
        return;
      }

      const outcome = await this.executor({
        jobId: job.job_id,
        jobType: job.job_type,
        payload: job.payload || {},
        jobClass: job.job_class || 'noop',
      });
      const written = await this.writeResult(job, 'succeeded', outcome, null);
      if (written === 0) {
        // The fencing token moved on: another worker owns this job now.
        this.log.warn('job.stale_write', { job_id: job.job_id, fencing_token: job.fencing_token });
        return;
      }
      this.processed += 1;
      this.log.info('job.succeeded', { job_id: job.job_id, status: outcome && outcome.status });
    } catch (err) {
      this.log.error('job.failed', { job_id: job.job_id, error: err });
      try {
        await this.writeResult(job, 'failed', null, err.message);
      } catch (writeErr) {
        this.log.error('job.write_failed', { job_id: job.job_id, error: writeErr });
      }
    } finally {
      if (this.heartbeat) {
        clearInterval(this.heartbeat);
        this.heartbeat = null;
      }
      this.current = null;
    }
  }

  /**
   * The loop.
   *
   * @returns {Promise<void>}
   */
  async loop() {
    this.running = true;
    this.log.info('worker.started', {
      worker_id: this.config.workerId,
      lease_seconds: this.config.leaseSeconds,
      heartbeat_seconds: this.config.heartbeatSeconds,
    });
    while (this.running && !this.stopping) {
      let job = null;
      try {
        job = await this.claim();
      } catch (err) {
        this.log.warn('claim.failed', { error: err });
      }
      if (!job) {
        await new Promise((resolve) => { setTimeout(resolve, this.config.pollIntervalMs); });
        continue;
      }
      await this.runJob(job);
      if (this.config.maxJobsPerRun > 0 && this.processed >= this.config.maxJobsPerRun) {
        this.log.info('worker.max_jobs_reached', { processed: this.processed });
        break;
      }
    }
    this.running = false;
    this.log.info('worker.stopped', { processed: this.processed });
  }
}

module.exports = { Worker };
