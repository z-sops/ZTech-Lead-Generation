'use strict';

const { Pool } = require('pg');

/**
 * The database access.
 *
 * Two rules, and they are the whole design:
 *
 *   1. The worker connects with the WORKER role. It never holds the
 *      migrator credential, a BYPASSRLS credential, the control-plane
 *      credential or the signing secret.
 *   2. A job context is TRANSACTION scoped. The worker opens a transaction,
 *      establishes the context inside it, does the work inside it, and
 *      commits. When the transaction ends the authority ends with it, so a
 *      pooled connection can never carry one job's authority into another
 *      job's work.
 */

/**
 * @param {{databaseUrl: string, max?: number}} config
 * @returns {import('pg').Pool}
 */
function createPool(config) {
  return new Pool({
    connectionString: config.databaseUrl,
    max: config.max || 4,
    // The search path is pinned, and the worker's role is the only thing
    // that connects.
    options: '-c search_path=li',
    application_name: 'ztech-worker',
  });
}

/**
 * Run fn inside a transaction that carries the job context.
 *
 * The context is established INSIDE the transaction, so it is bound to
 * this transaction's id. The commit releases it.
 *
 * @param {import('pg').Pool} pool
 * @param {string} jobId
 * @param {string} jobToken
 * @param {(client: import('pg').PoolClient) => Promise<unknown>} fn
 * @returns {Promise<unknown>}
 */
async function withJobContext(pool, jobId, jobToken, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT li.set_workspace_for_job($1, $2)', [jobId, jobToken]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Run fn inside a transaction, with no job context.
 *
 * Used for the claim and the renewal, which are authorised by the worker's
 * IDENTITY credential rather than by a job context.
 *
 * @param {import('pg').Pool} pool
 * @param {(client: import('pg').PoolClient) => Promise<unknown>} fn
 * @returns {Promise<unknown>}
 */
async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { createPool, withJobContext, withTransaction };
