'use strict';

/**
 * Provision the PostgreSQL roles and the database (M2).
 *
 * The deployment runs this ONCE, as the cluster administrator, before the
 * first migration. It does three things:
 *
 *   1. creates the roles (roles.sql) with the right properties;
 *   2. creates the database, and grants the roles what they need to
 *      connect to it;
 *   3. gives the MIGRATION role the right to create the schema, so that
 *      the schema, the tables and the SECURITY DEFINER functions are owned
 *      by the migration role - and by nobody else.
 *
 * The owner of a SECURITY DEFINER function is part of the security
 * boundary, so the ownership is deliberate and is not left to chance.
 *
 * The passwords come from the environment. This script never contains one,
 * and it never prints one.
 *
 *   ZTECH_PG_ADMIN_URL   the administrator's connection string
 *   ZTECH_PG_DATABASE    the database to create (default: ztech)
 *   ZTECH_PG_MIGRATOR_PASSWORD / _APP_ / _WORKER_ / _PLATFORM_ / _CONTROL_
 *
 * Usage: node scripts/provision-postgres.js
 */

const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const ADMIN_URL = process.env.ZTECH_PG_ADMIN_URL || '';
const DATABASE = process.env.ZTECH_PG_DATABASE || 'ztech';

const ROLE_ENV = Object.freeze({
  ztech_migrator: 'ZTECH_PG_MIGRATOR_PASSWORD',
  ztech_control: 'ZTECH_PG_CONTROL_PASSWORD',
  ztech_app: 'ZTECH_PG_APP_PASSWORD',
  ztech_worker: 'ZTECH_PG_WORKER_PASSWORD',
  ztech_platform: 'ZTECH_PG_PLATFORM_PASSWORD',
});

/**
 * The roles, with their passwords. A role whose password is not in the
 * environment is created without one - it can still be used, but nobody
 * can log in as it until the deployment sets one.
 */
function rolesSql() {
  const file = fs.readFileSync(path.join(__dirname, '..', 'packages', 'lead-intelligence-postgres', 'src', 'roles.sql'), 'utf8');
  // The passwords in the file are placeholders. The real ones come from the
  // environment, and are applied after the file.
  return file;
}

async function main() {
  if (!ADMIN_URL) {
    console.error('ZTECH_PG_ADMIN_URL is required: this script runs as the cluster administrator.');
    process.exit(2);
  }
  const admin = new Pool({ connectionString: ADMIN_URL });
  try {
    // 1. The roles.
    await admin.query(rolesSql());
    // 2. Their real passwords.
    for (const [role, env] of Object.entries(ROLE_ENV)) {
      const password = process.env[env];
      if (!password) {
        console.log(`  ${role}: no password in ${env} - the role is created without one`);
        continue;
      }
      // The password is a literal, not a parameter: ALTER ROLE ... PASSWORD
      // does not take a parameter. It is quoted, never interpolated raw.
      const quoted = password.replace(/'/g, "''");
      await admin.query(`ALTER ROLE ${role} PASSWORD '${quoted}'`);
      console.log(`  ${role}: password set from ${env}`);
    }
    // 3. The database, and who may connect to it and create in it.
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [DATABASE]);
    if (!exists.rows.length) {
      await admin.query(`CREATE DATABASE ${DATABASE}`);
      console.log(`  the database ${DATABASE} is created`);
    } else {
      console.log(`  the database ${DATABASE} is already there`);
    }
    await admin.query(`GRANT CONNECT ON DATABASE ${DATABASE} TO ${Object.keys(ROLE_ENV).join(', ')}`);
    // The migration role creates the schema, and owns everything in it.
    await admin.query(`GRANT CREATE ON DATABASE ${DATABASE} TO ztech_migrator`);
    console.log('  the migration role may create the schema; the runtime roles may only connect');
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
