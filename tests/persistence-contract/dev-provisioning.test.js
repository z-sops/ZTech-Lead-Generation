'use strict';

/**
 * The development provisioning suite (N-004).
 *
 * This suite runs the REAL development path - `scripts/setup-dev-db.js`
 * with all SIX roles - against a DISPOSABLE PostgreSQL 16 cluster. It exists
 * because the path had two gaps that a fresh database would hit:
 *
 *   1. migration 001 creates unqualified tables and the deployment connects
 *      with `search_path=li`, but nothing created the `li` schema; migration
 *      014 then fails on `li.workspace_grants`;
 *   2. `ztech_identity` was missing from the explicit `GRANT CONNECT` list,
 *      so it could connect only because PostgreSQL grants CONNECT to PUBLIC
 *      by default.
 *
 * What it proves:
 *
 *   1. a fresh development database is created with the `li` and `id`
 *      schemas, both owned by the migration role;
 *   2. migrations 001-021 are applied, in order, and the runtime schema is
 *      usable;
 *   3. all six roles are provisioned (LOGIN, not SUPERUSER, and only the
 *      migrator has BYPASSRLS);
 *   4. every role has an EXPLICIT CONNECT grant, including ztech_identity;
 *   5. the worker and the API are separate roles with no membership between
 *      them, and the identity role cannot read a tenant table;
 *   6. an existing database is not dropped or overwritten;
 *   7. an invalid database name or a missing/malformed credential fails
 *      before the first change.
 *
 * The disposable cluster is named by ZTECH_PG_DEV_PROVISION_URL. Without it
 * the suite is SKIPPED, and it says so - it never pretends to have run.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { Pool } = require('pg');
const {
  passwordEnvVar, roleProperties, canLogIn,
} = require('../../scripts/lib/postgres-credentials');

const ROOT = path.join(__dirname, '..', '..');
const { MIGRATIONS } = require('../../packages/lead-intelligence-postgres/src/index');

const ADMIN_URL = process.env.ZTECH_PG_DEV_PROVISION_URL || '';
const NEW_DB = 'ztech_dev_n004_new';
const EXISTING_DB = 'ztech_dev_n004_existing';
const MISSING_DB = 'ztech_dev_n004_missing';
const MALFORMED_DB = 'ztech_dev_n004_malformed';
const INVALID_DB = 'ztech_n004_production';
const RERUN_DB = 'ztech_dev_n004_rerun';
const LEGACY_DB = 'ztech_dev_n004_legacy';
const CONCURRENT_DB = 'ztech_dev_n004_concurrent';

const ROLES = [
  'ztech_migrator',
  'ztech_identity',
  'ztech_app',
  'ztech_worker',
  'ztech_platform',
  'ztech_control',
];

/** Test-only credentials. Every one is long enough and unique. */
const PASSWORDS = Object.fromEntries(
  ROLES.map((role) => [role, `n004-${role}-credential-${'x'.repeat(24)}`]),
);

/** Every credential, as the environment the setup script reads. */
function allCredentials() {
  const env = {};
  for (const role of ROLES) env[passwordEnvVar(role)] = PASSWORDS[role];
  return env;
}

/** Run the development setup script with a controlled environment. */
function setup(env) {
  return runScript('setup-dev-db.js', env);
}

/** Run one of the development scripts with a controlled environment. */
function runScript(script, env) {
  const childEnv = {
    PATH: process.env.PATH,
    ZTECH_PG_ADMIN_URL: ADMIN_URL,
    ...env,
  };
  // Local checkouts without the npm workspace links need NODE_PATH; CI has
  // the links, so the variable is only forwarded when it is actually set.
  if (process.env.NODE_PATH) childEnv.NODE_PATH = process.env.NODE_PATH;
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [path.join(ROOT, 'scripts', script)],
      { env: childEnv, cwd: ROOT },
      (error, stdout, stderr) => resolve({
        code: error ? (error.code || 1) : 0,
        stdout,
        stderr,
      }),
    );
  });
}

/** A connection string for one role on one database. */
function roleUrl(role, database) {
  const url = new URL(ADMIN_URL);
  url.username = role;
  url.password = PASSWORDS[role];
  url.pathname = `/${database}`;
  return url.toString();
}

/** The administrator's connection string on a specific database. */
function databaseUrl(database) {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${database}`;
  return url.toString();
}

if (!ADMIN_URL) {
  test('[dev-provisioning] the development provisioning suite (skipped: no disposable PostgreSQL is configured)', { skip: 'set ZTECH_PG_DEV_PROVISION_URL to a DISPOSABLE cluster to run the development provisioning path' }, () => {});
} else {
  let admin = null;

  async function dropDatabase(name) {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  }

  async function dropAllTestDatabases() {
    for (const name of [NEW_DB, EXISTING_DB, MISSING_DB, MALFORMED_DB, INVALID_DB, RERUN_DB, LEGACY_DB, CONCURRENT_DB]) {
      await dropDatabase(name);
    }
  }

  async function dropRoles() {
    for (const role of ROLES) await admin.query(`DROP ROLE IF EXISTS ${role}`);
  }

  test('the setup: a disposable cluster with no test roles or databases', async () => {
    admin = new Pool({ connectionString: ADMIN_URL });
    await dropAllTestDatabases();
    await dropRoles();
  });

  test('an invalid database name is refused before any change', async () => {
    const result = await setup({ ZTECH_DEV_DATABASE: INVALID_DB, ...allCredentials() });
    assert.notEqual(result.code, 0, 'the setup failed');
    assert.ok(/Refusing to run/.test(result.stderr), 'and it said why');
    assert.ok(!result.stdout.includes(PASSWORDS.ztech_app), 'and printed no credential');
    for (const secret of Object.values(PASSWORDS)) {
      assert.ok(!result.stdout.includes(secret), 'no credential is printed');
      assert.ok(!result.stderr.includes(secret), 'and none in the error output either');
    }
    const database = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [INVALID_DB]);
    assert.equal(database.rows.length, 0, 'the database was not created');
    for (const role of ROLES) {
      assert.equal(await roleProperties(admin, role), null, `${role} was not created`);
    }
  });

  test('a missing credential fails before any change', async () => {
    const env = allCredentials();
    delete env[passwordEnvVar('ztech_worker')];
    const result = await setup({ ZTECH_DEV_DATABASE: MISSING_DB, ...env });
    assert.notEqual(result.code, 0, 'the setup failed');
    assert.ok(result.stderr.includes(passwordEnvVar('ztech_worker')), 'and it named the missing variable');
    for (const secret of Object.values(PASSWORDS)) {
      assert.ok(!result.stderr.includes(secret), 'no credential is printed');
    }
    const database = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [MISSING_DB]);
    assert.equal(database.rows.length, 0, 'the database was not created');
    for (const role of ROLES) {
      assert.equal(await roleProperties(admin, role), null, `${role} was not created`);
    }
  });

  test('a malformed credential fails before any change', async () => {
    const env = allCredentials();
    env[passwordEnvVar('ztech_app')] = 'too-short';
    const result = await setup({ ZTECH_DEV_DATABASE: MALFORMED_DB, ...env });
    assert.notEqual(result.code, 0, 'the setup failed');
    assert.ok(/Malformed role credential/.test(result.stderr), 'and it said the credential was malformed');
    assert.ok(!result.stderr.includes('too-short'), 'and did not print it');
    const database = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [MALFORMED_DB]);
    assert.equal(database.rows.length, 0, 'the database was not created');
    for (const role of ROLES) {
      assert.equal(await roleProperties(admin, role), null, `${role} was not created`);
    }
  });

  test('a fresh database gets the schemas, the migrations and the six roles', async () => {
    const result = await setup({ ZTECH_DEV_DATABASE: NEW_DB, ...allCredentials() });
    assert.equal(result.code, 0, `the setup succeeded: ${result.stderr}`);
    for (const secret of Object.values(PASSWORDS)) {
      assert.ok(!result.stdout.includes(secret), 'no credential is printed');
      assert.ok(!result.stderr.includes(secret), 'and none in the error output either');
    }

    // Migrations 001-022, in order, each exactly once.
    const applied = [...result.stdout.matchAll(/Applied migration (\d+)/g)].map((m) => Number(m[1]));
    assert.deepEqual(applied, MIGRATIONS.map((m) => m.version), 'every migration was applied in order');
    assert.equal(applied.length, 22, 'there are twenty-two migrations');
    assert.equal(new Set(applied).size, applied.length, 'no migration was applied twice');
    assert.ok(result.stdout.includes('All PostgreSQL schema migrations applied'), 'the run reported success');

    // The schemas and their objects are per-DATABASE, so they are read on a
    // connection to the target database, not on the administrative
    // connection (which is connected to `postgres`).
    const target = new Pool({ connectionString: databaseUrl(NEW_DB) });
    try {
      // The schemas exist, owned by the migration role.
      const schemas = await target.query(
        `SELECT n.nspname, r.rolname
           FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner
          WHERE n.nspname = ANY($1) ORDER BY n.nspname`,
        [['li', 'id']],
      );
      assert.deepEqual(schemas.rows.map((row) => row.nspname), ['id', 'li'], 'both schemas exist');
      for (const row of schemas.rows) {
        assert.equal(row.rolname, 'ztech_migrator', `${row.nspname} is owned by the migration role`);
      }

      // The migration's objects landed in `li` (the search_path), owned by
      // the migration role; the identity objects landed in `id`.
      const objects = await target.query(
        `SELECT n.nspname, c.relname, r.rolname AS owner
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_roles r ON r.oid = c.relowner
          WHERE (n.nspname = 'li' AND c.relname IN ('li_research_jobs', 'job_queue'))
             OR (n.nspname = 'id' AND c.relname IN ('users', 'sessions'))
          ORDER BY n.nspname, c.relname`,
      );
      assert.equal(objects.rows.length, 4, 'the expected tables exist in the expected schemas');
      for (const row of objects.rows) {
        assert.equal(row.owner, 'ztech_migrator', `${row.nspname}.${row.relname} is owned by the migration role`);
      }

      // The tenant tables are protected by forced row-level security.
      const isolated = (await target.query(
        `SELECT count(*)::int AS n
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'li' AND c.relkind = 'r'
            AND c.relrowsecurity AND c.relforcerowsecurity`,
      )).rows[0].n;
      assert.ok(isolated >= 28, `the tenant tables have RLS enabled and forced (${isolated})`);
    } finally {
      await target.end();
    }

    // All six roles: LOGIN, no SUPERUSER, only the migrator bypasses RLS.
    for (const role of ROLES) {
      const properties = await roleProperties(admin, role);
      assert.ok(properties, `${role} exists`);
      assert.equal(properties.rolcanlogin, true, `${role} may log in`);
      assert.equal(properties.rolsuper, false, `${role} is not a superuser`);
      assert.equal(properties.rolbypassrls, role === 'ztech_migrator', `${role} bypasses RLS only if it is the migrator`);
      assert.equal(properties.rolcreaterole, false, `${role} may not create roles`);
      assert.equal(properties.rolcreatedb, false, `${role} may not create databases`);
    }

    // Every role has an EXPLICIT CONNECT grant, ztech_identity included.
    const grants = await admin.query(
      `SELECT r.rolname, count(*)::int AS n
         FROM pg_database d,
              aclexplode(d.datacl) a
              JOIN pg_roles r ON r.oid = a.grantee
        WHERE d.datname = $1 AND a.privilege_type = 'CONNECT'
        GROUP BY r.rolname`,
      [NEW_DB],
    );
    const granted = new Map(grants.rows.map((row) => [row.rolname, row.n]));
    for (const role of ROLES) {
      assert.ok(granted.get(role) >= 1, `${role} has an explicit CONNECT grant`);
    }

    // The credentials really work, on the target database.
    for (const role of ROLES) {
      assert.equal(
        await canLogIn(ADMIN_URL, role, PASSWORDS[role], NEW_DB),
        true,
        `${role} can log in with the credential that was set`,
      );
    }

    // The worker and the API are separate roles, not members of each other
    // (and neither is a member of the migrator).
    const separation = (await admin.query(
      `SELECT pg_has_role('ztech_worker', 'ztech_app', 'MEMBER') AS worker_in_app,
              pg_has_role('ztech_app', 'ztech_worker', 'MEMBER') AS app_in_worker,
              pg_has_role('ztech_worker', 'ztech_migrator', 'MEMBER') AS worker_in_migrator,
              pg_has_role('ztech_app', 'ztech_migrator', 'MEMBER') AS app_in_migrator`,
    )).rows[0];
    assert.equal(separation.worker_in_app, false, 'the worker is not a member of the API role');
    assert.equal(separation.app_in_worker, false, 'the API role is not a member of the worker');
    assert.equal(separation.worker_in_migrator, false, 'the worker is not a member of the migrator');
    assert.equal(separation.app_in_migrator, false, 'the API role is not a member of the migrator');

    // Each role connects as itself.
    for (const role of ['ztech_app', 'ztech_worker']) {
      const pool = new Pool({ connectionString: roleUrl(role, NEW_DB) });
      try {
        const who = await pool.query('SELECT session_user');
        assert.equal(who.rows[0].session_user, role, `the ${role} connection is ${role}`);
      } finally {
        await pool.end();
      }
    }

    // The API role may not create a schema.
    const app = new Pool({ connectionString: roleUrl('ztech_app', NEW_DB) });
    try {
      await assert.rejects(app.query('CREATE SCHEMA n004_app_schema'), /permission denied|must be owner/i);
    } finally {
      await app.end();
    }

    // The identity role may read and write `id`, and may not read a tenant
    // table.
    const identity = new Pool({ connectionString: roleUrl('ztech_identity', NEW_DB) });
    try {
      await identity.query('SELECT count(*) FROM id.users');
      await assert.rejects(identity.query('SELECT count(*) FROM li.li_research_jobs'), /permission denied/i);
    } finally {
      await identity.end();
    }

    await dropDatabase(NEW_DB);
  });

  test('an existing development database is not overwritten', async () => {
    await admin.query(`CREATE DATABASE ${EXISTING_DB}`);
    const existing = new Pool({ connectionString: databaseUrl(EXISTING_DB) });
    try {
      await existing.query('CREATE TABLE public.n004_marker (id INTEGER PRIMARY KEY, note TEXT)');
      await existing.query("INSERT INTO public.n004_marker (id, note) VALUES (1, 'preserve me')");
    } finally {
      await existing.end();
    }

    const result = await setup({ ZTECH_DEV_DATABASE: EXISTING_DB, ...allCredentials() });
    assert.equal(result.code, 0, `the setup succeeded: ${result.stderr}`);
    assert.ok(result.stdout.includes('Database exists.'), 'the setup found the existing database');

    const check = new Pool({ connectionString: databaseUrl(EXISTING_DB) });
    try {
      const marker = await check.query('SELECT note FROM public.n004_marker WHERE id = 1');
      assert.equal(marker.rows[0].note, 'preserve me', 'the existing data is still there');
      const schema = await check.query(
        `SELECT r.rolname FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner WHERE n.nspname = 'li'`,
      );
      assert.equal(schema.rows[0].rolname, 'ztech_migrator', 'and the li schema was added');
    } finally {
      await check.end();
    }

    await dropDatabase(EXISTING_DB);
  });

  test('the setup can be re-run: nothing is applied twice and nothing is lost', async () => {
    const first = await setup({ ZTECH_DEV_DATABASE: RERUN_DB, ...allCredentials() });
    assert.equal(first.code, 0, `the first run succeeded: ${first.stderr}`);
    const target = new Pool({ connectionString: databaseUrl(RERUN_DB) });
    try {
      await target.query("INSERT INTO li.li_market_rules (country_code, rule, note, reviewed_by, reviewed_at) VALUES ('ZZ', 'consent_required', 'n004 marker', 'test', now())");
    } finally {
      await target.end();
    }

    const second = await setup({ ZTECH_DEV_DATABASE: RERUN_DB, ...allCredentials() });
    assert.equal(second.code, 0, `the second run succeeded: ${second.stderr}`);
    assert.equal([...second.stdout.matchAll(/Applied migration (\d+)/g)].length, 0, 'no migration was applied again');
    assert.ok(second.stdout.includes('nothing new'), 'and it said the database is up to date');

    const check = new Pool({ connectionString: databaseUrl(RERUN_DB) });
    try {
      const ledger = await check.query('SELECT version FROM li.li_schema_migrations ORDER BY version');
      assert.deepEqual(ledger.rows.map((r) => Number(r.version)), MIGRATIONS.map((m) => m.version), 'every version is recorded once');
      const marker = await check.query("SELECT note FROM li.li_market_rules WHERE country_code = 'ZZ'");
      assert.equal(marker.rows[0].note, 'n004 marker', 'the data written between the runs is still there');
    } finally {
      await check.end();
    }
  });

  test('the services are pointed at the development database, and refuse the administrative one', async () => {
    const { assertZtechSchema } = require('../../scripts/lib/schema-check');
    // The setup tells the owner which URL the services must use: the
    // development database, with no user name and no credential in it.
    const rerun = await setup({ ZTECH_DEV_DATABASE: RERUN_DB, ...allCredentials() });
    assert.equal(rerun.code, 0, rerun.stderr);
    const admin0 = new URL(ADMIN_URL);
    assert.ok(rerun.stdout.includes(`postgres://${admin0.hostname}:${admin0.port || 5432}/${RERUN_DB}`), 'setup prints the development database URL');
    for (const role of ROLES) assert.ok(!rerun.stdout.includes(PASSWORDS[role]), `no ${role} credential is printed`);

    // The development database passes the start-up check, as the API's role.
    const appPool = new Pool({ connectionString: roleUrl('ztech_identity', RERUN_DB) });
    try {
      assert.equal(await assertZtechSchema(appPool), RERUN_DB);
    } finally {
      await appPool.end();
    }
    // The administrative database is refused with a message that says what to do,
    // instead of an "internal_error" on the first request.
    await assert.rejects(assertZtechSchema(admin), (err) => {
      assert.match(err.message, /has no ZTech schema \(missing id\.users, li\.job_queue\)/);
      assert.match(err.message, /ZTECH_PG_URL must name the development database/);
      return true;
    });
  });

  test('migrate-dev-db applies only what is new, and needs the migrator credential', async () => {
    const env = allCredentials();
    const upToDate = await runScript('migrate-dev-db.js', { ZTECH_DEV_DATABASE: RERUN_DB, ...env });
    assert.equal(upToDate.code, 0, `the run succeeded: ${upToDate.stderr}`);
    assert.ok(upToDate.stdout.includes('Nothing new'), 'nothing was applied to an up-to-date database');
    for (const secret of Object.values(PASSWORDS)) {
      assert.ok(!upToDate.stdout.includes(secret) && !upToDate.stderr.includes(secret), 'no credential is printed');
    }

    delete env[passwordEnvVar('ztech_migrator')];
    const missing = await runScript('migrate-dev-db.js', { ZTECH_DEV_DATABASE: RERUN_DB, ...env });
    assert.notEqual(missing.code, 0, 'the run failed without the migrator credential');
    assert.ok(missing.stderr.includes(passwordEnvVar('ztech_migrator')), 'and named the missing variable');

    const refused = await runScript('migrate-dev-db.js', { ZTECH_DEV_DATABASE: INVALID_DB, ...allCredentials() });
    assert.notEqual(refused.code, 0, 'a non-development database name is refused');
    assert.ok(/Refusing to run/.test(refused.stderr), 'and it said why');
    await dropDatabase(RERUN_DB);
  });

  test('a database with tables but no migration record is refused, not replayed', async () => {
    const first = await setup({ ZTECH_DEV_DATABASE: LEGACY_DB, ...allCredentials() });
    assert.equal(first.code, 0, `the first run succeeded: ${first.stderr}`);
    const legacy = new Pool({ connectionString: databaseUrl(LEGACY_DB) });
    let tablesBefore;
    try {
      // What a database made by the pre-2026-11 setup looks like: the
      // migrations' tables exist, and the ledger is empty.
      await legacy.query('DELETE FROM li.li_schema_migrations');
      tablesBefore = (await legacy.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname IN ('li', 'id')")).rows[0].n;
    } finally {
      await legacy.end();
    }

    const result = await setup({ ZTECH_DEV_DATABASE: LEGACY_DB, ...allCredentials() });
    assert.notEqual(result.code, 0, 'the setup failed closed');
    assert.ok(result.stderr.includes('no migration record'), 'and it said why');
    assert.equal([...result.stdout.matchAll(/Applied migration (\d+)/g)].length, 0, 'nothing was replayed');

    const check = new Pool({ connectionString: databaseUrl(LEGACY_DB) });
    try {
      const ledger = await check.query('SELECT count(*)::int AS n FROM li.li_schema_migrations');
      assert.equal(ledger.rows[0].n, 0, 'the ledger was not filled in by guesswork');
      const tablesAfter = (await check.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname IN ('li', 'id')")).rows[0].n;
      assert.equal(tablesAfter, tablesBefore, 'no table was created or dropped');
    } finally {
      await check.end();
    }
    await dropDatabase(LEGACY_DB);
  });

  test('two runners at once apply every migration exactly once', async () => {
    const { applyPendingMigrations } = require('../../scripts/lib/dev-migrations');
    await admin.query(`CREATE DATABASE ${CONCURRENT_DB}`);
    await admin.query(`GRANT ALL ON DATABASE ${CONCURRENT_DB} TO ztech_migrator`);
    const target = new Pool({ connectionString: databaseUrl(CONCURRENT_DB) });
    try {
      for (const schema of ['li', 'id']) await target.query(`CREATE SCHEMA ${schema} AUTHORIZATION ztech_migrator`);
    } finally {
      await target.end();
    }
    const pools = [0, 1].map(() => new Pool({ connectionString: roleUrl('ztech_migrator', CONCURRENT_DB), options: '-c search_path=li' }));
    try {
      const quiet = () => {};
      const [a, b] = await Promise.all(pools.map((pool) => applyPendingMigrations(pool, { log: quiet })));
      const all = [...a.applied, ...b.applied].sort((x, y) => x - y);
      assert.deepEqual(all, MIGRATIONS.map((m) => m.version), 'between them, each migration was applied once');
      assert.ok(a.applied.length === 0 || b.applied.length === 0, 'one runner waited for the other, then had nothing to do');
    } finally {
      await Promise.all(pools.map((pool) => pool.end()));
    }
    await dropDatabase(CONCURRENT_DB);
  });

  test('the cleanup', async () => {
    await dropAllTestDatabases();
    await dropRoles();
    await admin.end();
  });
}
