'use strict';

/**
 * Provision the PostgreSQL roles and the database (M2).
 *
 * The deployment runs this ONCE, as the cluster administrator, before the
 * first migration. It does four things:
 *
 *   1. creates the roles (roles.sql) with NO password and with NOLOGIN;
 *   2. sets each role's credential from the environment, and only then
 *      enables the login;
 *   3. creates the database, and grants the roles what they need to connect
 *      to it and to create the schema;
 *   4. VERIFIES the result against the live database.
 *
 * There is no default password. A role that is created and never given a
 * credential stays NOLOGIN, so it cannot be used at all - which is the safe
 * way to be wrong. If a credential is missing or malformed, this script
 * changes NOTHING and exits with an error.
 *
 * The credentials come from the environment, one variable per role:
 *
 *   ZTECH_PG_ADMIN_URL        the administrator's connection string
 *   ZTECH_PG_DATABASE         the database to create (default: ztech)
 *   ZTECH_PG_PASSWORD_<ROLE>  the credential for a role, e.g.
 *                              ZTECH_PG_PASSWORD_ZTECH_APP
 *
 * The credentials are never printed, never written to a file, and never put
 * on a command line.
 *
 * Usage: node scripts/provision-postgres.js
 */

const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const {
  ROLES, collectCredentials, setCredential, roleProperties, canLogIn, describeRole, PLACEHOLDERS,
} = require('./lib/postgres-credentials');

const ADMIN_URL = process.env.ZTECH_PG_ADMIN_URL || '';
const DATABASE = process.env.ZTECH_PG_DATABASE || 'ztech';
/** The roles to provision. The five, unless the deployment says otherwise. */
const ROLE_NAMES = (process.env.ZTECH_PG_ROLES || ROLES.map((r) => r.name).join(','))
  .split(',').map((s) => s.trim()).filter(Boolean);

const ROLES_FILE = path.join(__dirname, '..', 'packages', 'lead-intelligence-postgres', 'src', 'roles.sql');

/** Apply roles.sql: it creates the roles, NOLOGIN and with no password. */
async function createRoles(admin) {
  await admin.query(fs.readFileSync(ROLES_FILE, 'utf8'));
}

async function main() {
  if (!ADMIN_URL) {
    console.error('ZTECH_PG_ADMIN_URL is required: this script runs as the cluster administrator.');
    process.exit(2);
  }

  // 1. The credentials are collected and checked BEFORE anything is
  //    changed. A missing or malformed credential stops the whole thing.
  const { credentials, missing, malformed } = collectCredentials(ROLE_NAMES);
  if (missing.length || malformed.length) {
    if (missing.length) {
      console.error('These credentials are not in the environment:');
      for (const env of missing) console.error(`  ${env}`);
    }
    if (malformed.length) {
      console.error('These credentials are malformed:');
      for (const env of malformed) console.error(`  ${env}`);
    }
    console.error('');
    console.error('Nothing has been changed. Every role stays NOLOGIN until it is');
    console.error('given a credential. A role with no credential cannot be used.');
    process.exit(1);
  }

  const admin = new Pool({ connectionString: ADMIN_URL });
  try {
    // 2. The roles: created with no password, and enabled only now.
    await createRoles(admin);
    for (const role of credentials) {
      // A role that is not one of the five is created here, with no
      // password and with no login, exactly like the five.
      const { rows: created } = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role.name]);
      if (!created.length) {
        const { rows: make } = await admin.query("SELECT format('CREATE ROLE %I NOLOGIN', $1::text) AS statement", [role.name]);
        await admin.query(make[0].statement);
      }
      await setCredential(admin, role.name, role.password);
      console.log(`  ${role.name}: credential set from ${role.env}`);
    }

    // 3. The database, and who may connect to it and create in it.
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [DATABASE]);
    if (!exists.rows.length) {
      await admin.query(`CREATE DATABASE ${DATABASE}`);
      console.log(`  the database ${DATABASE} is created`);
    } else {
      console.log(`  the database ${DATABASE} is already there`);
    }
    await admin.query(`GRANT CONNECT ON DATABASE ${DATABASE} TO ${credentials.map((r) => r.name).join(', ')}`);
    // The migration role creates the schema, and owns everything in it.
    if (credentials.some((r) => r.name === 'ztech_migrator')) {
      await admin.query('GRANT CREATE ON DATABASE $1 TO ztech_migrator'.replace('$1', `'${DATABASE}'`));
    }

    // 4. The verification, against the live database.
    console.log('');
    console.log('The roles, as the database reports them:');
    let wrong = 0;
    for (const role of credentials) {
      const properties = await roleProperties(admin, role.name);
      const problems = [];
      if (!properties) problems.push('the role does not exist');
      else {
        if (!properties.rolcanlogin) problems.push('it may not log in');
        if (properties.rolsuper) problems.push('it is a superuser');
        if (properties.rolbypassrls !== role.bypassesRls) {
          problems.push(role.bypassesRls ? 'it does not bypass the row-level security' : 'it bypasses the row-level security');
        }
        if (properties.rolvaliduntil) problems.push('its login expires');
        const works = await canLogIn(ADMIN_URL, role.name, role.password, DATABASE);
        if (!works) problems.push('it cannot log in with the credential that was just set');
        for (const placeholder of PLACEHOLDERS) {
          if (placeholder === role.password) continue;
          if (await canLogIn(ADMIN_URL, role.name, placeholder, DATABASE)) {
            problems.push('a known placeholder credential still works');
          }
        }
      }
      if (problems.length) {
        wrong += 1;
        console.error(`  ${describeRole(properties)} -- ${problems.join('; ')}`);
      } else {
        console.log(`  ${describeRole(properties)}`);
      }
    }
    if (wrong) {
      console.error('');
      console.error('The provisioning did not produce the expected result. Read the lines above.');
      process.exit(1);
    }
    console.log('');
    console.log('Next: apply the migrations as ztech_migrator.');
  } finally {
    await admin.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
