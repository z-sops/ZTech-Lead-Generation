'use strict';

/**
 * The PostgreSQL test harness (M2).
 *
 * Every suite gets its OWN DATABASE, and inside it the schema is named `li`
 * - the name the production schema has. That matters: the migrations and the
 * functions are the production ones, with no test-only rewriting, so what
 * the tests exercise is what a deployment runs.
 *
 * The harness also PROVISIONS THE ROLES, because the isolation only exists
 * once there are roles to be isolated from:
 *
 *   - ztech_app, ztech_worker, ztech_platform: the runtime roles. They are
 *     not superusers, they do not have BYPASSRLS, and they do not own the
 *     tables.
 *   - the grants that say which workspace a role may act for.
 *
 * The connection string of a runtime role is what the denial tests use: they
 * connect as a NON-OWNER and try to reach another tenant's rows.
 */

const { Pool } = require('pg');
const { URL: Url } = require('node:url');

const URL = process.env.ZTECH_PG_URL || '';

/** The runtime roles, and the passwords the tests use. */
const ROLES = Object.freeze({
  app: 'ztech_app',
  worker: 'ztech_worker',
  platform: 'ztech_platform',
  migrator: 'ztech_migrator',
});

const ROLE_PASSWORD = 'ztech_test_only';

/** The advisory lock that serialises the cluster-wide setup between the suites. */
const SETUP_LOCK = 20260921;

/** A connection string for one of the roles. */
function roleUrl(role, database) {
  const url = new Url(URL);
  url.username = role;
  url.password = ROLE_PASSWORD;
  if (database) url.pathname = `/${database}`;
  return url.toString();
}

/**
 * The same connection string, in another database.
 *
 * The database is part of the PATH: the `database` option of the driver does
 * NOT override a database named in the connection string, so the path is
 * rewritten instead.
 */
function urlWithDatabase(urlString, database) {
  const url = new Url(urlString);
  url.pathname = `/${database}`;
  return url.toString();
}

/**
 * Create the runtime roles, once per cluster.
 *
 * The roles are cluster-level, so they survive the databases they are used
 * with. Their passwords are test-only.
 *
 * The test files run in parallel and they all touch the same roles, so a
 * concurrent "tuple concurrently updated" is retried rather than failing the
 * suite: it is the catalogue's row lock, not a defect.
 */
async function ensureRoles(admin) {
  for (const role of Object.values(ROLES)) {
    const existing = (await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rows;
    if (existing.length) {
      // The password is NOT re-set here: the roles are shared by every suite
      // in the cluster, and changing a password while the other suites are
      // connecting to it disturbs their sessions. The password is constant.
      continue;
    }
    await retry(() => admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${ROLE_PASSWORD}'`));
  }
  for (const role of [ROLES.app, ROLES.worker, ROLES.platform]) {
    await retry(() => admin.query(`ALTER ROLE ${role} NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`));
  }
}

/** Run fn while holding the cluster-wide setup lock. */
async function withSetupLock(pool, fn) {
  await pool.query('SELECT pg_advisory_lock($1)', [SETUP_LOCK]);
  try {
    return await fn();
  } finally {
    await pool.query('SELECT pg_advisory_unlock($1)', [SETUP_LOCK]).catch(() => {});
  }
}

/** Retry a statement that lost a race on a catalogue row. */
async function retry(fn, attempts = 12) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      const contended = err && (err.code === '40001' || err.code === '40P01' || (err.code === 'XX000' && /tuple concurrently updated/.test(String(err.message))));
      if (contended && i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 100 * (i + 1)));
        continue;
      }
      throw err;
    }
  }
  return undefined;
}

/**
 * A fresh database with the `li` schema, the migrations applied and the
 * grants provisioned.
 *
 * @param {string} name the database name
 * @param {{workspace?: string, roles?: string[]}} [opts] the workspaces the
 *   listed roles may act for (default: every role, for the given workspace)
 * @returns {Promise<{admin: object, pool: object, url: string, workspace: string}>}
 */
async function freshDatabase(name, opts = {}) {
  const workspace = opts.workspace || '11111111-1111-4111-8111-111111111111';
  const workspaces = opts.workspaces || [workspace];
  const admin = new Pool({ connectionString: URL });
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${name}`);
  const pool = new Pool({ connectionString: roleUrl(ROLES.app, name), options: '-c search_path=li' });
  pool.on('error', () => { /* the database is dropped at the end of the suite */ });
  // The schema and the migrations are applied by the ADMIN, which owns them:
  // in a deployment that is the migrator role.
  const owner = new Pool({ connectionString: urlWithDatabase(URL, name) });
  // The suites run in parallel, and the roles and the grants are CLUSTER
  // wide. An advisory lock serialises the setup, so two suites never race on
  // the same catalogue row.
  // The advisory lock lives in the ADMIN database, which every suite shares:
  // an advisory lock is per-database, so a lock taken in the suite's own
  // database would not serialise anything.
  await admin.query('SELECT pg_advisory_lock($1)', [SETUP_LOCK]);
  try {
    await ensureRoles(owner);
    await owner.query('CREATE SCHEMA IF NOT EXISTS li');
    const { MIGRATIONS } = require('../../../packages/lead-intelligence-postgres/src/index');
    for (const m of MIGRATIONS) {
      await owner.query('SET search_path TO li');
      await owner.query(m.sql);
    }
    // The grants: which role may act for which workspace.
    const roles = opts.roles || [ROLES.app, ROLES.worker, ROLES.platform];
    for (const role of roles) {
      for (const ws of workspaces) {
        await owner.query('INSERT INTO li.workspace_grants (role_name, workspace_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [role, ws]);
      }
    }
  } finally {
    await admin.query('SELECT pg_advisory_unlock($1)', [SETUP_LOCK]);
  }
  // A pool for the platform role: it is a DIFFERENT database role, and the
  // platform's own policies are written for it.
  const platformPool = new Pool({ connectionString: roleUrl(ROLES.platform, name), options: '-c search_path=li' });
  platformPool.on('error', () => {});
  return { admin, pool, owner, platformPool, url: roleUrl(ROLES.app, name), workspace };
}

/**
 * Empty every table in the schema, so one test cannot see another's rows.
 * TRUNCATE is not subject to row-level security, so the owner may do it.
 */
async function truncateAll(owner) {
  const tables = (await owner.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'li' AND table_type = 'BASE TABLE' AND table_name NOT IN ('li_schema_migrations', 'workspace_grants')",
  )).rows.map((r) => `"${r.table_name}"`);
  if (!tables.length) return;
  await owner.query(`TRUNCATE ${tables.join(', ')} RESTART IDENTITY CASCADE`);
}

/**
 * Drop the database and close the pools.
 */
async function dropDatabase(name, handles = []) {
  for (const h of handles) {
    if (h && typeof h.end === 'function') await h.end();
  }
  const admin = new Pool({ connectionString: URL });
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.end();
}

/** The skip reason when there is no PostgreSQL. */
const skip = URL ? false : 'set ZTECH_PG_URL to run the PostgreSQL suites against a real PostgreSQL';

module.exports = { URL, ROLES, ROLE_PASSWORD, roleUrl, urlWithDatabase, ensureRoles, freshDatabase, dropDatabase, truncateAll, withSetupLock, skip };
