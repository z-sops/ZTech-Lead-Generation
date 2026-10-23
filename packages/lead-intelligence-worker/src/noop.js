'use strict';

/**
 * The no-op job executor.
 *
 * P1 runs NO-OP jobs only. There is no provider, no network call and no
 * money: the executor proves the queue, the lease, the fencing token and
 * the context work end to end, and nothing else.
 *
 * A CHARGEABLE job is never executed here. It is refused, and the refusal
 * is loud: whether a chargeable invocation was dispatched is a question the
 * provider ledger answers, and P1 has no ledger, so it must not guess.
 */

/**
 * @param {{jobId: string, jobType: string, payload: object, jobClass: string}} job
 * @returns {Promise<{status: string, detail: object}>}
 */
async function executeNoop(job) {
  if (job.jobClass && job.jobClass !== 'noop') {
    const err = new Error(
      `the job ${job.jobId} is a ${job.jobClass} job and P1 executes no-op jobs only: `
      + 'the provider ledger arrives in P2 and an outcome may not be invented',
    );
    err.code = 'JOB_CLASS_NOT_EXECUTABLE';
    throw err;
  }
  return {
    status: 'ok',
    detail: {
      executed: 'noop',
      job_type: job.jobType,
      payload_keys: Object.keys(job.payload || {}).sort(),
    },
  };
}

module.exports = { executeNoop };
