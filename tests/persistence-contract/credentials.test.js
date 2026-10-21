'use strict';

/**
 * The credentials suite (M2, correction C3).
 *
 * THE PROBLEM THIS SUITE EXISTS FOR
 * --------------------------------
 * `roles.sql` created the roles with a KNOWN password — `CHANGE_ME_app` and
 * so on. A password that is written down in the repository is not a
 * password: anybody who has read the repository can log in as the API, as
 * the worker, or as the platform console. And `provision-postgres.js`
 * carried on when the environment had no password for a role, so the
 * placeholder stayed in force.
 *
 * What this suite proves:
 *
 *   1. no role is ever provisioned with a known default password;
 *   2. a role that has no credential cannot be logged into at all;
 *   3. the provisioning FAILS CLOSED when a credential is missing or
 *      malformed, and it changes nothing when it does;
 *   4. a malformed credential is refused, and so is a placeholder;
 *   5. the real role properties are verified against the live database;
 *   6. a role that still carries a placeholder can be rotated safely, and
 *      the placeholder stops working;
 *   7. no secret is ever printed.
 *
 * The provisioning is exercised against a PROBE role of its own, so the
 * cluster's real roles are never given a test credential.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { Pool } = require('pg');
const { ROLES, skip } = require('./lib/postgres');
const {
  MIN_LENGTH, PLACEHOLDERS, passwordEnvVar, validateCredential, canLogIn, roleProperties,
} = require('../../scripts/lib/postgres-credentials');

const ROOT = path.join(__dirname, '..', '..');
const ADMIN_URL = process.env.ZTECH_PG_URL || '';
const PROBE_ROLE = 'ztech_provision_probe';
const PROBE_PASSWORD = 'a-credential-for-the-probe-role-2026';
const PROBE_ENV = passwordEnvVar(PROBE_ROLE);
const PROBE_DATABASE = 'ztech_provision_probe';

/** Run a script, with a controlled environment. */
function run(script, env) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [path.join(ROOT, 'scripts', script)],
      { env: { PATH: process.env.PATH, ZTECH_PG_ADMIN_URL: ADMIN_URL, ...env }, cwd: ROOT },
      (error, stdout, stderr) => resolve({ code: error ? (error.code || 1) : 0, stdout, stderr }),
    );
  });
}

if (!process.env.ZTECH_PG_URL) {
  test('[credentials] the credentials suite (skipped: no PostgreSQL is configured)', { skip: 'set ZTECH_PG_URL' }, () => {});
} else {
  let admin = null;

  async function dropProbe() {
    // The database first: it holds a grant for the role, and a role cannot
    // be dropped while something depends on it.
    await admin.query(`DROP DATABASE IF EXISTS ${PROBE_DATABASE} WITH (FORCE)`);
    await admin.query(`DROP ROLE IF EXISTS ${PROBE_ROLE}`);
  }

  test('the setup', async () => {
    admin = new Pool({ connectionString: ADMIN_URL });
    await dropProbe();
  });

  test('roles.sql contains no password at all', async () => {
    const fs = require('node:fs');
    const sql = fs.readFileSync(path.join(ROOT, 'packages', 'lead-intelligence-postgres', 'src', 'roles.sql'), 'utf8');
    assert.ok(!/PASSWORD\s+'[^']*'/i.test(sql), 'roles.sql sets no password');
    assert.ok(!/CREATE ROLE[^;]*PASSWORD/i.test(sql), 'and no role is created with a password');
    assert.ok(/NOLOGIN/.test(sql), 'the roles are created NOLOGIN');
  });

  test('a credential is validated before it is used', () => {
    assert.equal(validateCredential('ztech_app', undefined).ok, false, 'a missing credential is refused');
    assert.equal(validateCredential('ztech_app', '').ok, false, 'an empty credential is refused');
    assert.equal(validateCredential('ztech_app', 'short').ok, false, 'a short credential is refused');
    assert.equal(validateCredential('ztech_app', 'x'.repeat(MIN_LENGTH - 1)).ok, false);
    assert.equal(validateCredential('ztech_app', 'x'.repeat(MIN_LENGTH)).ok, true, 'a long enough credential is accepted');
    assert.equal(validateCredential('ztech_app', 'CHANGE_ME_app').ok, false, 'a placeholder is refused');
    assert.equal(validateCredential('ztech_app', 'CHANGE_ME_something_else').ok, false);
    assert.equal(validateCredential('ztech_app', `a${'b'.repeat(MIN_LENGTH)}\nc`).ok, false, 'a line break is refused');
    assert.equal(validateCredential('ztech_app', 'ztech_app').ok, false, 'the role name is refused');
    for (const placeholder of PLACEHOLDERS) {
      assert.equal(validateCredential('ztech_app', placeholder).ok, false, `the placeholder ${placeholder} is refused`);
    }
  });

  test('a role with no credential cannot be logged into', async () => {
    // The role exists, and it may not log in.
    await admin.query(`CREATE ROLE ${PROBE_ROLE} NOLOGIN`);
    const properties = await roleProperties(admin, PROBE_ROLE);
    assert.equal(properties.rolcanlogin, false, 'the role may not log in');
    assert.equal(await canLogIn(ADMIN_URL, PROBE_ROLE, PROBE_PASSWORD), false, 'and no credential works');
    await dropProbe();
  });

  test('the provisioning fails closed when a credential is missing', async () => {
    // The probe role is provisioned on its own, so the cluster's real roles
    // are never touched by a test.
    const result = await run('provision-postgres.js', {
      ZTECH_PG_DATABASE: PROBE_DATABASE,
      ZTECH_PG_ROLES: PROBE_ROLE,
    });
    assert.notEqual(result.code, 0, 'the provisioning failed');
    assert.ok(/not in the environment/i.test(result.stderr), 'and it said which variable is missing');
    assert.ok(result.stderr.includes(PROBE_ENV), 'by name, and not by value');
    // And nothing was created: the role was not even enabled.
    const properties = await roleProperties(admin, PROBE_ROLE);
    assert.equal(properties, null, 'the role was not created');
  });

  test('the provisioning fails closed on a malformed credential', async () => {
    const result = await run('provision-postgres.js', {
      ZTECH_PG_DATABASE: PROBE_DATABASE,
      ZTECH_PG_ROLES: PROBE_ROLE,
      [PROBE_ENV]: 'too-short',
    });
    assert.notEqual(result.code, 0, 'the provisioning failed');
    assert.ok(/malformed/i.test(result.stderr), 'and it said the credential was malformed');
    assert.ok(!result.stderr.includes('too-short'), 'and it did not print the credential');
    const properties = await roleProperties(admin, PROBE_ROLE);
    assert.equal(properties, null, 'nothing was created');
  });

  test('the provisioning works with valid credentials, and verifies the result', async () => {
    const result = await run('provision-postgres.js', {
      ZTECH_PG_DATABASE: PROBE_DATABASE,
      ZTECH_PG_ROLES: PROBE_ROLE,
      [PROBE_ENV]: PROBE_PASSWORD,
    });
    assert.equal(result.code, 0, `the provisioning succeeded: ${result.stderr}`);
    assert.ok(!result.stdout.includes(PROBE_PASSWORD), 'no credential is printed');
    assert.ok(!result.stderr.includes(PROBE_PASSWORD), 'not in the error output either');
    assert.ok(/may log in/.test(result.stdout), 'and the role is reported');

    // The database says the same thing.
    const properties = await roleProperties(admin, PROBE_ROLE);
    assert.ok(properties, 'the role exists');
    assert.equal(properties.rolcanlogin, true, 'it may log in');
    assert.equal(properties.rolsuper, false, 'it is not a superuser');
    assert.equal(properties.rolbypassrls, false, 'it does not bypass the row-level security');
    assert.equal(await canLogIn(ADMIN_URL, PROBE_ROLE, PROBE_PASSWORD), true, 'it can log in with the credential that was set');
    // And no known placeholder works for it.
    for (const placeholder of PLACEHOLDERS) {
      assert.equal(await canLogIn(ADMIN_URL, PROBE_ROLE, placeholder), false, `it does not accept ${placeholder}`);
    }
    // And the database was created, with the role able to connect to it.
    const created = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [PROBE_DATABASE]);
    assert.equal(created.rows.length, 1, 'the database exists');
  });

  test('a placeholder credential can be rotated away safely', async () => {
    // A role that still carries the old placeholder.
    await dropProbe();
    await admin.query(`CREATE ROLE ${PROBE_ROLE} LOGIN PASSWORD 'CHANGE_ME_app'`);
    assert.equal(await canLogIn(ADMIN_URL, PROBE_ROLE, 'CHANGE_ME_app'), true, 'the placeholder works, before the rotation');

    const result = await run('rotate-postgres-role.js', {
      ZTECH_PG_ROTATE_ROLE: PROBE_ROLE,
      [PROBE_ENV]: PROBE_PASSWORD,
      ZTECH_PG_OLD_PASSWORD: 'CHANGE_ME_app',
    });
    assert.equal(result.code, 0, `the rotation succeeded: ${result.stderr}`);
    assert.ok(!result.stdout.includes(PROBE_PASSWORD), 'no credential is printed');
    assert.equal(await canLogIn(ADMIN_URL, PROBE_ROLE, 'CHANGE_ME_app'), false, 'the placeholder no longer works');
    assert.equal(await canLogIn(ADMIN_URL, PROBE_ROLE, PROBE_PASSWORD), true, 'and the new credential does');
    const properties = await roleProperties(admin, PROBE_ROLE);
    assert.equal(properties.rolcanlogin, true, 'the role is still usable');
    assert.equal(properties.rolsuper, false, 'and it is still not a superuser');
  });

  test('the rotation refuses a missing or malformed credential, and changes nothing', async () => {
    const before = await roleProperties(admin, PROBE_ROLE);
    for (const env of [{}, { [PROBE_ENV]: 'short' }]) {
      const result = await run('rotate-postgres-role.js', { ZTECH_PG_ROTATE_ROLE: PROBE_ROLE, ...env });
      assert.notEqual(result.code, 0, 'the rotation failed');
      assert.ok(!result.stderr.includes(PROBE_PASSWORD), 'and it printed no credential');
    }
    const after = await roleProperties(admin, PROBE_ROLE);
    assert.equal(after.rolcanlogin, before.rolcanlogin, 'the role was left as it was');
    assert.equal(await canLogIn(ADMIN_URL, PROBE_ROLE, PROBE_PASSWORD), true, 'and its credential still works');
  });

  test('the cluster roles are the ones the database says they are', async () => {
    // The harness provisions the roles the production way: NOLOGIN first,
    // then the credential, then LOGIN.
    for (const role of Object.values(ROLES)) {
      const properties = await roleProperties(admin, role);
      assert.ok(properties, `${role} exists`);
      assert.equal(properties.rolsuper, false, `${role} is not a superuser`);
      assert.equal(properties.rolbypassrls, role === ROLES.migrator, `${role} bypasses the policies only if it is the migration role`);
      for (const placeholder of PLACEHOLDERS) {
        assert.equal(await canLogIn(ADMIN_URL, role, placeholder), false, `${role} does not accept ${placeholder}`);
      }
    }
  });

  test('the cleanup', async () => {
    await dropProbe();
    await admin.query(`DROP DATABASE IF EXISTS ${PROBE_DATABASE} WITH (FORCE)`);
    await admin.end();
  });
}
