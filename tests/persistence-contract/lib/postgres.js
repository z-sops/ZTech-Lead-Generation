'use strict';

/**
 * The PostgreSQL test harness (M2).
 *
 * Every suite gets its OWN DATABASE, and inside it the schema is named `li`
 * - the name the production schema has. That matters: the migrations and the
 * functions are the production ones, with no test-only rewriting, so what
 * the tests exercise is what a deployment runs.
 *
 * The harness PROVISIONS THE ROLES and applies the migrations THE WAY A
 * DEPLOYMENT DOES:
 *
 *   - the cluster administrator creates the database and grants the
 *     permissions to connect to it;
 *   - the MIGRATION ROLE (ztech_migrator) creates the schema and applies
 *     the migrations, so the tables AND the SECURITY DEFINER functions are
 *     owned by the role that owns them in production - not by the
 *     administrator, and not by a superuser;
 *   - the runtime roles (ztech_app, ztech_worker, ztech_platform) and the
 *     control plane (ztech_control) are only ever used to CONNECT.
 *
 * A test that applied the migrations as the administrator would be testing
 * a schema that no deployment has: the owner of a SECURITY DEFINER function
 * decides what that function can do, so the owner is part of the security
 * boundary and the test must get it right.
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
  control: 'ztech_control',
  identity: 'ztech_identity',
});

/** The reserved workspace of the platform. */
const PLATFORM_WORKSPACE_ID = '00000000-0000-0000-0000-000000000000';

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
  const fs = require('node:fs');
  const path = require('node:path');
  const { setCredential } = require('../../../scripts/lib/postgres-credentials');
  const rolesFile = path.join(__dirname, '..', '..', '..', 'packages', 'lead-intelligence-postgres', 'src', 'roles.sql');
  // The procedure is the PRODUCTION one: the roles are created NOLOGIN,
  // with no password at all (roles.sql), and only then is the test
  // credential set and the login enabled. A test that provisioned the
  // roles differently would not be exercising what a deployment runs.
  await retry(() => admin.query(fs.readFileSync(rolesFile, 'utf8')));
  for (const role of Object.values(ROLES)) {
    // The credential is set as a SCRAM VERIFIER, transported as a bind
    // parameter, so the password appears in no statement and in no log.
    await retry(() => setCredential(admin, role, ROLE_PASSWORD));
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
 * @param {{workspace?: string, workspaces?: string[], roles?: string[]}} [opts]
 *   the workspaces the listed roles may act for (default: every role, for
 *   the given workspace)
 * @returns {Promise<{admin: object, owner: object, pool: object, controlPool: object, platformPool: object, url: string, workspace: string, mintToken: Function}>}
 */
async function freshDatabase(name, opts = {}) {
  const workspace = opts.workspace || '11111111-1111-4111-8111-111111111111';
  const workspaces = opts.workspaces || [workspace];
  const admin = new Pool({ connectionString: URL });
  // The suites run in parallel, and the roles and the grants are CLUSTER
  // wide. An advisory lock serialises the setup, so two suites never race on
  // the same catalogue row.
  //
  // The lock belongs to the SESSION that took it, so it is taken on one
  // dedicated connection - a pool.query would take it on whichever
  // connection happened to be free, and the next query would run on
  // another one.
  const lock = await admin.connect();
  await lock.query('SELECT pg_advisory_lock($1)', [SETUP_LOCK]);
  try {
    // The roles come first: a role must exist before it can be granted
    // anything.
    await ensureRoles(lock);
    await lock.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await lock.query(`CREATE DATABASE ${name}`);
    // The administrator's job is the database itself: who may connect to
    // it, and who may create objects in it. Everything inside it belongs to
    // the migration role, exactly as in a deployment.
    await lock.query(`GRANT CONNECT ON DATABASE ${name} TO ${Object.values(ROLES).join(', ')}`);
    await lock.query(`GRANT CREATE ON DATABASE ${name} TO ${ROLES.migrator}`);

    // The MIGRATION role: it creates the schema and applies the migrations,
    // so it owns the tables and the SECURITY DEFINER functions. Its
    // search_path is set in the connection, so the unqualified names in the
    // earlier migrations land in the `li` schema - and they land there on
    // EVERY connection of the pool, not on whichever one happens to be idle.
    const owner = new Pool({ connectionString: roleUrl(ROLES.migrator, name), options: '-c search_path=li' });
    owner.on('error', () => { /* the database is dropped at the end of the suite */ });
    await owner.query('CREATE SCHEMA IF NOT EXISTS li');
    const { MIGRATIONS } = require('../../../packages/lead-intelligence-postgres/src/index');
    for (const m of MIGRATIONS) {
      await owner.query(m.sql);
    }
    // The grants: which role may act for which workspace.
    const roles = opts.roles || [ROLES.app, ROLES.worker, ROLES.platform];
    for (const role of roles) {
      for (const ws of workspaces) {
        await owner.query('INSERT INTO li.workspace_grants (role_name, workspace_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [role, ws]);
      }
    }
    // The platform console may open the platform's own workspace.
    await owner.query('INSERT INTO li.workspace_grants (role_name, workspace_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [ROLES.platform, PLATFORM_WORKSPACE_ID]);

    // THE IDENTITY. Since M3 a workspace token is bound to a SESSION and a
    // USER, so the suites need one: a user, a membership of the workspace,
    // and a session. The suites use it to open their contexts, exactly as
    // the service does.
    const identity = await createIdentity(owner, opts, workspaces);
    // The pools for the runtime roles and for the control plane.
    const pool = new Pool({ connectionString: roleUrl(ROLES.app, name), options: '-c search_path=li' });
    pool.on('error', () => { /* the database is dropped at the end of the suite */ });
    // A pool for the platform role: it is a DIFFERENT database role, and the
    // platform's own policies are written for it.
    const platformPool = new Pool({ connectionString: roleUrl(ROLES.platform, name), options: '-c search_path=li' });
    platformPool.on('error', () => {});
    // A pool for the CONTROL PLANE. It may do exactly one thing: ask the
    // database to issue a workspace token. It may not read a row, and it may
    // not open a context of its own.
    const controlPool = new Pool({ connectionString: roleUrl(ROLES.control, name), options: '-c search_path=li' });
    controlPool.on('error', () => {});
    // The identity service's pool: it may read and write the `id` tables and
    // issue the workspace tokens, and it may not read a tenant row.
    const identityPool = new Pool({ connectionString: roleUrl(ROLES.identity, name), options: '-c search_path=li,id' });
    identityPool.on('error', () => {});

  /**
   * A workspace token, from the control plane. This is the only way to get
   * one: the runtime role may not issue a token for itself, and the token
   * is bound to a SESSION and a USER as well as to the workspace.
   */
  async function mintToken(forWorkspace, forRole = ROLES.app, ttl = 300, forSession = null, forUser = null) {
    const res = await controlPool.query(
      'SELECT li.issue_workspace_token($1, $2, $3, $4, $5) AS token',
      [forWorkspace, forRole, forSession || identity.sessionId, forUser || identity.userId, ttl],
    );
    return res.rows[0].token;
  }

    return {
      admin, pool, owner, controlPool, identityPool, platformPool, url: roleUrl(ROLES.app, name), workspace, mintToken,
      ...identity,
    };
  } finally {
    await lock.query('SELECT pg_advisory_unlock($1)', [SETUP_LOCK]).catch(() => {});
    lock.release();
  }
}

/**
 * Create the identity the suites need: a user, a membership of the
 * workspace, and a session.
 *
 * Since M3 a workspace token is bound to a SESSION and a USER, so the
 * suites cannot open a context with a database role alone - and that is the
 * point: the role is a ceiling, the session is the entitlement.
 */
async function createIdentity(owner, opts, workspaces) {
  const crypto = require('node:crypto');
  const userId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const orgId = crypto.randomUUID();
  const email = `suite-${userId.slice(0, 8)}@ztech.test`;
  const tokenHash = crypto.createHash('sha256').update('suite-token').digest('hex');
  const csrfHash = crypto.createHash('sha256').update('suite-csrf').digest('hex');
  await owner.query(
    'INSERT INTO id.users (user_id, email, password_hash) VALUES ($1, $2, $3)',
    [userId, email, 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA'],
  );
  await owner.query('INSERT INTO id.organizations (org_id, name, slug) VALUES ($1, $2, $3)', [orgId, 'The Suite', `suite-${orgId.slice(0, 8)}`]);
  const primary = opts.workspace || workspaces[0];
  await owner.query(
    'INSERT INTO id.workspaces (workspace_id, org_id, name) VALUES ($1, $2, $3)',
    [primary, orgId, 'The Suite Workspace'],
  );
  await owner.query(
    `INSERT INTO id.workspace_memberships (membership_id, workspace_id, user_id, role) VALUES ($1, $2, $3, 'owner')`,
    [crypto.randomUUID(), primary, userId],
  );
  await owner.query(
    `INSERT INTO id.sessions (session_id, user_id, token_hash, csrf_hash, expires_at)
     VALUES ($1, $2, $3, $4, now() + interval '1 day')`,
    [sessionId, userId, tokenHash, csrfHash],
  );

  /**
   * A second identity, for another workspace: a different user, with
   * their own session and their own membership. Two users of the SAME
   * database role, which is what the multi-workspace suite needs.
   */
  async function sessionFor(workspaceId, role = 'owner') {
    const otherUser = crypto.randomUUID();
    const otherSession = crypto.randomUUID();
    await owner.query(
      'INSERT INTO id.users (user_id, email, password_hash) VALUES ($1, $2, $3)',
      [otherUser, `suite-${otherUser.slice(0, 8)}@ztech.test`, 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA'],
    );
    await owner.query(
      'INSERT INTO id.workspaces (workspace_id, org_id, name) VALUES ($1, $2, $3) ON CONFLICT (workspace_id) DO NOTHING',
      [workspaceId, orgId, `Suite Workspace ${workspaceId.slice(0, 8)}`],
    );
    await owner.query(
      `INSERT INTO id.workspace_memberships (membership_id, workspace_id, user_id, role) VALUES ($1, $2, $3, $4)`,
      [crypto.randomUUID(), workspaceId, otherUser, role],
    );
    await owner.query(
      `INSERT INTO id.sessions (session_id, user_id, token_hash, csrf_hash, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '1 day')`,
      [otherSession, otherUser, crypto.createHash('sha256').update(otherUser).digest('hex'), csrfHash],
    );
    return { sessionId: otherSession, userId: otherUser };
  }

  return { userId, sessionId, sessionFor };
}

/**
 * Empty every table in the schema, so one test cannot see another's rows.
 * TRUNCATE is not subject to row-level security, so the owner may do it.
 */
async function truncateAll(owner) {
  const tables = (await owner.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'li' AND table_type = 'BASE TABLE' AND table_name NOT IN ('li_schema_migrations', 'workspace_grants', 'workspace_context', 'control_plane_secret')",
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

module.exports = {
  URL, ROLES, ROLE_PASSWORD, PLATFORM_WORKSPACE_ID, roleUrl, urlWithDatabase, ensureRoles,
  freshDatabase, dropDatabase, truncateAll, withSetupLock, skip,
};
