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

/**
 * The role the worker MUST connect as.
 *
 * The worker is the JOB-scoped role. It is not the migrator, it does not
 * bypass the row-level security, and it is not the control plane or the
 * identity service.
 */
const WORKER_ROLE = 'ztech_worker';

/** The roles the worker must never be. */
const FORBIDDEN_ROLES = Object.freeze([
  'ztech_migrator', 'ztech_control', 'ztech_identity', 'ztech_platform',
]);

/**
 * Prove that the connection is the WORKER role.
 *
 * This is a FAIL-CLOSED startup check: the worker asks the live session
 * who it is, and it refuses to poll or claim a single job if the answer
 * is wrong. A worker that connected with the migrator's or the control
 * plane's credential would hold a far larger authority than its own, and
 * nothing in the database would stop it from using it.
 *
 * @param {import('pg').Pool} pool
 * @returns {Promise<{ok: boolean, problems: string[], sessionUser: string}>}
 */
async function assertWorkerIdentity(pool) {
  const problems = [];
  const r = await pool.query(
    `SELECT session_user AS session_user,
            r.rolsuper AS superuser,
            r.rolbypassrls AS bypass_rls,
            r.rolcreatedb AS createdb,
            r.rolcreaterole AS createdrole,
            (SELECT array_agg(g.rolname ORDER BY g.rolname)
               FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid
              WHERE m.member = r.oid) AS inherited,
            (SELECT count(*)::int FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'li' AND c.relkind = 'r' AND c.relowner = r.oid) AS owned_tables
       FROM pg_roles r
      WHERE r.rolname = session_user`,
  );
  if (!r.rows.length) {
    return { ok: false, problems: ['the session user does not exist'], sessionUser: '' };
  }
  const me = r.rows[0];
  const sessionUser = me.session_user;

  if (sessionUser !== WORKER_ROLE) {
    problems.push(`the worker connected as ${sessionUser}, not ${WORKER_ROLE}`);
  }
  if (FORBIDDEN_ROLES.includes(sessionUser)) {
    problems.push(`the worker may never connect as ${sessionUser}`);
  }
  if (me.superuser) problems.push('the worker role is a SUPERUSER');
  if (me.bypass_rls) problems.push('the worker role has BYPASSRLS');
  if (me.createdb) problems.push('the worker role may create databases');
  if (me.createdrole) problems.push('the worker role may create roles');
  if (Number(me.owned_tables) > 0) problems.push('the worker role owns a table in the tenant schema');

  // No unauthorised inheritance: the worker may be a member of nothing, and
  // in particular of nothing that owns the schema or bypasses the policies.
  const inherited = me.inherited || [];
  for (const role of inherited) {
    if (FORBIDDEN_ROLES.includes(role)) {
      problems.push(`the worker role is a member of ${role}`);
    }
  }
  if (inherited.length) {
    const parent = await pool.query(
      `SELECT r.rolname, r.rolsuper, r.rolbypassrls,
              (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'li' AND c.relkind = 'r' AND c.relowner = r.oid) AS owned_tables
         FROM pg_roles r WHERE r.rolname = ANY($1)`,
      [inherited],
    );
    for (const p of parent.rows) {
      if (p.rolsuper) problems.push(`the worker inherits ${p.rolname}, which is a SUPERUSER`);
      if (p.rolbypassrls) problems.push(`the worker inherits ${p.rolname}, which has BYPASSRLS`);
      if (Number(p.owned_tables) > 0) problems.push(`the worker inherits ${p.rolname}, which owns tenant tables`);
    }
  }

  return { ok: problems.length === 0, problems, sessionUser };
}

module.exports = { createPool, withJobContext, withTransaction, assertWorkerIdentity, WORKER_ROLE, FORBIDDEN_ROLES };
