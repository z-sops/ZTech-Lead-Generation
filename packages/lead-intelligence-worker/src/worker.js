'use strict';

const { withJobContext, withTransaction } = require('./db');
const { IdentityProvider } = require('./identity');
const { executeNoop } = require('./noop');

/**
 * The worker runtime.
 *
 * The loop is: claim a job, obtain an execution credential for it, open
 * the job context, run the job, write the result. A heartbeat renews the
 * lease AND refreshes the execution credential, so a job that outlives the
 * token's lifetime keeps a valid authority. A graceful shutdown stops the
 * CLAIMS and cancels the in-flight work cooperatively, while the heartbeat
 * keeps the lease alive for as long as the completion is authorised.
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
   *          identity?: IdentityProvider, executor?: Function,
   *          now?: () => number, setIntervalImpl?: Function,
   *          clearIntervalImpl?: Function}} deps
   */
  constructor(deps) {
    this.pool = deps.pool;
    this.config = deps.config;
    this.log = deps.logger;
    this.identity = deps.identity || new IdentityProvider(deps.config);
    this.executor = deps.executor || executeNoop;
    this.now = deps.now || (() => Date.now());
    this.setIntervalImpl = deps.setIntervalImpl || setInterval;
    this.clearIntervalImpl = deps.clearIntervalImpl || clearInterval;

    this.running = false;
    this.stopping = false;
    this.current = null;
    this.heartbeat = null;
    this.processed = 0;

    // The authority of the job that is running.
    this.authorityLost = false;
    this.jobToken = null;
    this.jobTokenExpiresAt = 0;
    this.activeController = null;
    this.heartbeatInFlight = false;
    this._heartbeatPromise = null;
  }

  /**
   * Ask the loop to stop.
   *
   * New claims stop. The job that is running is cancelled COOPERATIVELY:
   * the executor is told, through an AbortSignal, that it should stop.
   * The heartbeat is deliberately NOT cleared here — the lease must stay
   * alive for as long as the completion is authorised, and the heartbeat
   * stops when the job ends.
   */
  stop() {
    this.stopping = true;
    this.running = false;
    if (this.activeController) this.activeController.abort();
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
      this.loseAuthority('lease.renewal_failed', job, err);
      return false;
    }
  }

  /**
   * The execution credential of the running job, and when it expires.
   *
   * @param {object} job
   * @returns {Promise<{token: string, expiresAt: number}>}
   */
  async executionCredential(job) {
    const identityToken = await this.identity.get();
    const rows = await withTransaction(this.pool, (client) => client.query(
      'SELECT li.request_job_token($1, $2, $3, $4)',
      [job.job_id, job.fencing_token, identityToken, this.config.tokenTtlSeconds],
    ));
    // The database decides: it refuses the request when the lease has
    // lapsed, when the fencing token has moved on, or when the job is no
    // longer held by this worker. A refreshed credential can therefore
    // NEVER resurrect a stale or reclaimed lease.
    return {
      token: rows.rows[0].request_job_token,
      expiresAt: this.now() + this.config.tokenTtlSeconds * 1000,
    };
  }

  /**
   * Refresh the execution credential before it expires.
   *
   * @param {object} job
   * @returns {Promise<boolean>} whether the authority is still valid
   */
  async refreshToken(job) {
    const margin = Math.floor((this.config.tokenTtlSeconds * 1000) / 2);
    if (this.jobToken && this.now() < this.jobTokenExpiresAt - margin) return true;
    try {
      const credential = await this.executionCredential(job);
      this.jobToken = credential.token;
      this.jobTokenExpiresAt = credential.expiresAt;
      return true;
    } catch (err) {
      this.loseAuthority('token.refresh_failed', job, err);
      return false;
    }
  }

  /**
   * The authority is gone. Nothing protected may be written from now on.
   *
   * @param {string} event
   * @param {object} job
   * @param {Error} err
   */
  loseAuthority(event, job, err) {
    this.authorityLost = true;
    this.log.warn(event, { job_id: job && job.job_id, error: err });
    // The in-flight work is cancelled cooperatively: there is no authority
    // to finish it with.
    if (this.activeController) this.activeController.abort();
    this.stop();
  }

  /**
   * One heartbeat: renew the lease, then refresh the credential.
   *
   * There is never more than one heartbeat in flight: a slow renewal must
   * not queue another one behind it, or the worker would send a burst of
   * renewals and of token requests.
   *
   * @param {object} job
   */
  heartbeatOnce(job) {
    // Every caller receives the actual pending operation, not a fresh
    // resolved Promise from an overlapping interval tick.
    if (this._heartbeatPromise) return this._heartbeatPromise;
    this.heartbeatInFlight = true;
    const pending = (async () => {
      const renewed = await this.renew(job);
      if (!renewed) return;
      await this.refreshToken(job);
    })();
    this._heartbeatPromise = pending;
    const settled = () => {
      if (this._heartbeatPromise === pending) {
        this._heartbeatPromise = null;
        this.heartbeatInFlight = false;
      }
    };
    // Attach both settlement handlers; do not create an unhandled
    // rejected Promise in the timer or cleanup paths.
    pending.then(settled, settled);
    return pending;
  }

  /**
   * Obtain the execution credential for a claimed job.
   *
   * @param {object} job
   * @returns {Promise<string>}
   */
  async executionToken(job) {
    const credential = await this.executionCredential(job);
    this.jobToken = credential.token;
    this.jobTokenExpiresAt = credential.expiresAt;
    return credential.token;
  }

  /**
   * Is the job still to be run? The cancellation checkpoint.
   *
   * A job is cancelled when its state is 'cancelled' or when a
   * cancel_requested_at has been recorded against it, even while the job
   * is still leased or running. The worker observes the request
   * cooperatively and must not write a success for it.
   *
   * @param {object} job
   * @returns {Promise<boolean>}
   */
  async isCancelled(job) {
    const rows = await withJobContext(this.pool, job.job_id, this.jobToken, (client) => client.query(
      'SELECT state, cancel_requested_at FROM li.job_queue WHERE job_id = $1',
      [job.job_id],
    ));
    if (!rows.rows.length) return true;
    const row = rows.rows[0];
    return row.state === 'cancelled' || row.cancel_requested_at !== null;
  }

  /**
   * Record failure or requeue for the running job, decided by the database.
   *
   * Delegates to li.fail_or_retry_job, which validates the job context,
   * the lease and the fencing token before writing anything. A cancelled
   * job is marked cancelled; a job within its retry budget is requeued with
   * a capped exponential backoff; an exhausted job is marked failed.
   *
   * @param {object} job
   * @param {string} error
   * @returns {Promise<string>} 'requeued' | 'failed' | 'cancelled' | 'refused'
   */
  async failOrRetry(job, error) {
    if (this.authorityLost) {
      this.log.warn('worker.authority_lost', { job_id: job.job_id, reason: 'suppressed failOrRetry' });
      return 'refused';
    }
    const rows = await withJobContext(this.pool, job.job_id, this.jobToken, (client) => client.query(
      'SELECT li.fail_or_retry_job($1, $2, $3)',
      [job.job_id, job.fencing_token, error],
    ));
    return rows.rows[0].fail_or_retry_job;
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
    if (this.authorityLost) {
      this.log.warn('write.refused_no_authority', { job_id: job.job_id, state });
      return 0;
    }
    const rows = await withJobContext(this.pool, job.job_id, this.jobToken, (client) => client.query(
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
    // A previous job's heartbeat must never be allowed to mutate this
    // job's authority. Refuse an unsafe direct runJob transition.
    if (this._heartbeatPromise) throw new Error('previous heartbeat is still in flight');
    this.current = job;
    this.authorityLost = false;
    this.jobToken = null;
    this.jobTokenExpiresAt = 0;

    const controller = new AbortController();
    this.activeController = controller;

    this.log.info('job.claimed', {
      job_id: job.job_id, job_type: job.job_type, fencing_token: job.fencing_token,
      attempt_count: job.attempt_count,
    });

    try {
      await this.executionToken(job);

      // The heartbeat: the lease is renewed AND the credential is refreshed,
      // so a job that outlives the token's lifetime keeps a valid
      // authority. It keeps running while a graceful shutdown is in
      // progress, because the completion is still authorised.
      this.heartbeat = this.setIntervalImpl(() => {
        this.heartbeatOnce(job).catch((err) => {
          this.loseAuthority('heartbeat.unexpected_failure', job, err);
        });
      }, this.config.heartbeatSeconds * 1000);
      if (this.heartbeat && this.heartbeat.unref) this.heartbeat.unref();

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
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        // The work was cancelled cooperatively. There may be no authority
        // to write with, and a cancelled job must not be written as
        // succeeded.
        this.log.info('job.aborted', { job_id: job.job_id });
        return;
      }
      // A second cancellation checkpoint: the work may have been cancelled
      // while it was in flight. A cancelled job must not be written as
      // succeeded.
      if (await this.isCancelled(job)) {
        await this.writeResult(job, 'cancelled', null, 'the job was cancelled');
        this.log.info('job.cancelled', { job_id: job.job_id });
        return;
      }
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
      if (!this.authorityLost) {
        try {
          await this.failOrRetry(job, err.message);
        } catch (dbErr) {
          if (dbErr && dbErr.code === '42883') {
            this.log.warn('migration.missing_function', { job_id: job.job_id, error: dbErr });
          } else {
            this.log.warn('failOrRetry.error', { job_id: job.job_id, error: dbErr });
          }
          // No fallback writeResult('failed')
        }
      }
    } finally {
      // The heartbeat stops when the JOB ends, not when the worker is asked
      // to stop: the lease must stay alive for as long as the completion
      // is authorised.
      if (this.heartbeat) {
        this.clearIntervalImpl(this.heartbeat);
        this.heartbeat = null;
      }
      // Clearing the timer does not cancel a renewal already in flight.
      // Drain it before allowing the loop to claim another job.
      if (this._heartbeatPromise) {
        try {
          await this._heartbeatPromise;
        } catch (err) {
          this.loseAuthority('heartbeat.cleanup_failed', job, err);
        }
      }
      this.activeController = null;
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
