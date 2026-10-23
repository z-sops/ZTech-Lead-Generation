'use strict';

/**
 * The production provisioning suite (M2).
 *
 * This suite runs the REAL production path - `scripts/provision-postgres.js`
 * with its DEFAULT role list, all five roles, and the real database
 * creation - against an ISOLATED PostgreSQL 16 cluster. Not a probe role
 * and not a mocked script: the script that the deployment runs, on a
 * cluster that nothing else is using, so the credentials it sets are the
 * credentials the test chose and nothing else is disturbed.
 *
 * What it proves:
 *
 *   1. the script configures ALL FIVE roles, and they are the roles the
 *      deployment uses;
 *   2. the MIGRATOR can connect, create the `li` schema and apply the
 *      migrations - the schema and everything in it are owned by it;
 *   3. a RUNTIME role can NOT create that schema, and does not bypass the
 *      row-level security;
 *   4. a missing or an invalid credential FAILS BEFORE ANY CHANGE - no
 *      role is created, no role is enabled, no database is created;
 *   5. the credentials work, and no known placeholder does;
 *   6. the password never appears in a statement: the value that is stored
 *      is a SCRAM verifier, and the password is in no SQL text at all.
 *
 * The isolated cluster is named by ZTECH_PG_PROVISION_URL. Without it the
 * suite is SKIPPED, and it says so - it never pretends to have run.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { Pool } = require('pg');
const { PLACEHOLDERS, passwordEnvVar, roleProperties, canLogIn } = require('../../scripts/lib/postgres-credentials');

const ROOT = path.join(__dirname, '..', '..');
const ADMIN_URL = process.env.ZTECH_PG_PROVISION_URL || '';
const DATABASE = 'ztech_provisioned';
const ROLES = ['ztech_migrator', 'ztech_control', 'ztech_app', 'ztech_worker', 'ztech_platform'];
const PASSWORD = 'a-production-provisioning-credential-2026';

/** Run the provisioning script, with a controlled environment. */
function provision(env) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [path.join(ROOT, 'scripts', 'provision-postgres.js')],
      { env: { PATH: process.env.PATH, ZTECH_PG_ADMIN_URL: ADMIN_URL, ...env }, cwd: ROOT },
      (error, stdout, stderr) => resolve({ code: error ? (error.code || 1) : 0, stdout, stderr }),
    );
  });
}

/** The environment that provisions all five roles. */
function allRoleCredentials() {
  const env = {};
  for (const role of ROLES) env[passwordEnvVar(role)] = `${PASSWORD}-${role}`;
  return env;
}

if (!ADMIN_URL) {
  test('[provisioning] the production provisioning suite (skipped: no isolated PostgreSQL is configured)', { skip: 'set ZTECH_PG_PROVISION_URL to run the production provisioning path against an isolated cluster' }, () => {});
} else {
  let admin = null;

  /** A clean cluster: no roles, no database. */
  async function reset() {
    await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
    for (const role of ROLES) await admin.query(`DROP ROLE IF EXISTS ${role}`);
  }

  test('the setup: an empty cluster', async () => {
    admin = new Pool({ connectionString: ADMIN_URL });
    await reset();
  });

  test('a missing credential fails BEFORE anything is changed', async () => {
    const env = allRoleCredentials();
    delete env[passwordEnvVar('ztech_worker')];
    const result = await provision({ ZTECH_PG_DATABASE: DATABASE, ...env });
    assert.notEqual(result.code, 0, 'the provisioning failed');
    assert.ok(/not in the environment/i.test(result.stderr), 'and it said which variable is missing');
    assert.ok(!result.stdout.includes(PASSWORD), 'and it printed no credential');
    // Nothing was created: not a role, not a database.
    for (const role of ROLES) {
      const properties = await roleProperties(admin, role);
      assert.equal(properties, null, `${role} was not created`);
    }
    const database = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [DATABASE]);
    assert.equal(database.rows.length, 0, 'and the database was not created');
  });

  test('an invalid credential fails BEFORE anything is changed', async () => {
    const env = allRoleCredentials();
    env[passwordEnvVar('ztech_app')] = 'too-short';
    const result = await provision({ ZTECH_PG_DATABASE: DATABASE, ...env });
    assert.notEqual(result.code, 0, 'the provisioning failed');
    assert.ok(/malformed/i.test(result.stderr), 'and it said the credential was malformed');
    assert.ok(!result.stdout.includes('too-short'), 'and it did not print the credential');
    for (const role of ROLES) {
      const properties = await roleProperties(admin, role);
      assert.equal(properties, null, `${role} was not created`);
    }
    const database = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [DATABASE]);
    assert.equal(database.rows.length, 0, 'and the database was not created');
  });

  test('the production path configures all five roles', async () => {
    const result = await provision({ ZTECH_PG_DATABASE: DATABASE, ...allRoleCredentials() });
    assert.equal(result.code, 0, `the provisioning succeeded: ${result.stderr}`);
    assert.ok(!result.stdout.includes(PASSWORD), 'no credential is printed');
    assert.ok(!result.stderr.includes(PASSWORD), 'and none in the error output either');
    for (const role of ROLES) {
      assert.ok(result.stdout.includes(role), `${role} is reported`);
      const properties = await roleProperties(admin, role);
      assert.ok(properties, `${role} exists`);
      assert.equal(properties.rolcanlogin, true, `${role} may log in`);
      assert.equal(properties.rolsuper, false, `${role} is not a superuser`);
      assert.equal(properties.rolbypassrls, role === 'ztech_migrator', `${role} bypasses the policies only if it is the migration role`);
      assert.equal(properties.rolcreaterole, false, `${role} may not create roles`);
      assert.equal(properties.rolcreatedb, false, `${role} may not create databases`);
      assert.equal(properties.rolvaliduntil, null, `${role}'s login does not expire`);
      assert.equal(await canLogIn(ADMIN_URL, role, `${PASSWORD}-${role}`), true, `${role} can log in with the credential that was set`);
    }
    // The database exists, and the roles may connect to it.
    const database = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [DATABASE]);
    assert.equal(database.rows.length, 1, 'the database was created');
  });

  test('the stored value is a verifier, and the password is in no statement', async () => {
    const stored = (await admin.query(
      'SELECT rolpassword FROM pg_authid WHERE rolname = $1',
      ['ztech_app'],
    )).rows[0].rolpassword;
    assert.ok(stored.startsWith('SCRAM-SHA-256$'), 'what is stored is a SCRAM-SHA-256 verifier');
    assert.ok(!stored.includes(PASSWORD), 'and the password is not in it');
    // The statement that sets it carries the verifier as a bind parameter,
    // so the password was never in the SQL text either. The check looks at
    // the EXECUTABLE form: a password inside a format() call, or quoted
    // straight into a statement.
    const fs = require('node:fs');
    for (const file of ['scripts/lib/postgres-credentials.js', 'scripts/provision-postgres.js', 'scripts/rotate-postgres-role.js']) {
      const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
      assert.ok(!/PASSWORD\s+%L/.test(source), `${file} puts no password into a format()`);
      assert.ok(!/format\([^)]*PASSWORD\s+'/.test(source), `${file} quotes no password into a statement`);
    }
  });

  test('no known placeholder works', async () => {
    for (const role of ROLES) {
      for (const placeholder of PLACEHOLDERS) {
        assert.equal(await canLogIn(ADMIN_URL, role, placeholder), false, `${role} does not accept ${placeholder}`);
      }
    }
  });

  test('the MIGRATOR creates the schema and applies the migrations', async () => {
    const url = new URL(`postgres://${'ztech_migrator'}:${encodeURIComponent(`${PASSWORD}-ztech_migrator`)}@127.0.0.1:${new URL(ADMIN_URL).port}/${DATABASE}`);
    const migrator = new Pool({ connectionString: url.toString(), options: '-c search_path=li' });
    try {
      await migrator.query('CREATE SCHEMA IF NOT EXISTS li');
      const { MIGRATIONS } = require('../../packages/lead-intelligence-postgres/src/index');
      for (const m of MIGRATIONS) await migrator.query(m.sql);
      // The schema and its tables belong to the migration role.
      const owner = (await migrator.query(
        `SELECT r.rolname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_roles r ON r.oid = c.relowner
          WHERE n.nspname = 'li' AND c.relname = 'li_saved_searches'`,
      )).rows[0];
      assert.equal(owner.rolname, 'ztech_migrator', 'the migration role owns the tables');
      // And the tenant tables are isolated.
      const isolated = (await migrator.query(
        `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'li' AND c.relkind = 'r' AND c.relrowsecurity AND c.relforcerowsecurity`,
      )).rows[0].n;
      assert.ok(isolated >= 28, `the tenant tables have row-level security enabled and forced (${isolated})`);
    } finally {
      await migrator.end();
    }
  });

  test('a RUNTIME role can not create the schema, and does not bypass RLS', async () => {
    const url = new URL(ADMIN_URL);
    url.username = 'ztech_app';
    url.password = `${PASSWORD}-ztech_app`;
    url.pathname = `/${DATABASE}`;
    const runtime = new Pool({ connectionString: url.toString() });
    try {
      // It may not create a schema.
      await assert.rejects(runtime.query('CREATE SCHEMA ztech_app_schema'), /permission denied|must be owner/i);
      // And it does not bypass the row-level security: the properties say
      // so, and the policies say so. The catalogue is read in the
      // PROVISIONED database, which is where the migrations landed.
      const properties = await roleProperties(admin, 'ztech_app');
      assert.equal(properties.rolbypassrls, false, 'the runtime role does not bypass the policies');
      const provisioned = new Pool({ connectionString: `${ADMIN_URL.replace(/\/[^/]*$/, `/${DATABASE}`)}` });
      try {
        const policies = (await provisioned.query(
          `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'li' AND c.relkind = 'r' AND c.relrowsecurity AND c.relforcerowsecurity`,
        )).rows[0].n;
        assert.ok(policies >= 28, `and every tenant table has the policies enabled and forced (${policies})`);
      } finally {
        await provisioned.end();
      }
    } finally {
      await runtime.end();
    }
  });

  test('the cleanup', async () => {
    await reset();
    await admin.end();
  });
}
