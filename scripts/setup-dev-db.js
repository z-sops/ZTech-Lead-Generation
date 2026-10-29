'use strict';

/**
 * ZTech Development Database Setup & Provisioning Script
 *
 * Implements Directive 23 Workstream A:
 * Provides automated setup for local PostgreSQL 16 development database,
 * provisions runtime roles with correct NOLOGIN/BYPASSRLS behavior,
 * and applies schema migrations for persistent customer storage.
 *
 * Usage:
 *   node scripts/setup-dev-db.js
 *   node scripts/setup-dev-db.js --url=postgres://postgres:postgres@localhost:5432/postgres
 */
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const {
  collectCredentials, setCredential, roleProperties, describeRole
} = require('../scripts/lib/postgres-credentials');

const ROLES_FILE = path.join(__dirname, '..', 'packages', 'lead-intelligence-postgres', 'src', 'roles.sql');
const TARGET_DB = process.env.ZTECH_DEV_DATABASE || 'ztech_dev';
const ADMIN_URL = process.env.ZTECH_PG_ADMIN_URL || process.env.ZTECH_PG_URL || 'postgres://postgres:postgres@localhost:5432/postgres';

const ROLES_ORDER = [
  'ztech_migrator',
  'ztech_identity',
  'ztech_app',
  'ztech_worker',
  'ztech_platform',
  'ztech_control',
];

/**
 * The schemas the migrations require, all owned by the migration role.
 *
 * Migrations 001-013 create UNQUALIFIED tables, and the deployment connects
 * as ztech_migrator with `search_path=li` (the same way the PostgreSQL test
 * harness does), so `li` must exist and be owned by the migration role
 * before the first migration runs. Migration 015 creates `id` itself, but
 * creating it here with the same owner keeps the ownership rule in one place
 * and makes that migration's `CREATE SCHEMA IF NOT EXISTS id` a no-op.
 */
const REQUIRED_SCHEMAS = ['li', 'id'];

const MIGRATION_ROLE = 'ztech_migrator';

/** Approved development database name patterns. */
const DEV_DB_PATTERNS = [
  /^ztech_dev$/,
  /^ztech_dev_/,
  /^ztech_test$/,
  /^ztech_test_/,
  /^test_/,
];

function isApprovedDevDatabase(dbName) {
  return DEV_DB_PATTERNS.some((p) => p.test(dbName));
}

async function setup() {
  console.log('--- ZTech Development PostgreSQL 16 Setup ---');
  console.log(`Target Database: ${TARGET_DB}`);
  console.log(`Admin Connection: ${ADMIN_URL.replace(/:.[^:@]+@/, ':****@')}`);

  // Refuse to run against non-development databases.
  if (!isApprovedDevDatabase(TARGET_DB)) {
    console.error(`Refusing to run: "${TARGET_DB}" does not match an approved development database pattern.`);
    console.error('Set ZTECH_DEV_DATABASE to a development database name (e.g., ztech_dev, ztech_test).');
    return false;
  }

  // Validate ALL SIX credentials BEFORE any change: not a database, not a
  // role, not a credential. A half-provisioned cluster is harder to reason
  // about than one that was never touched.
  const collected = collectCredentials(ROLES_ORDER);
  if (collected.missing.length > 0) {
    console.error('Missing required role credential(s): ' + collected.missing.join(', '));
    console.error('Set them in the environment before running the development setup.');
    return false;
  }
  if (collected.malformed.length > 0) {
    console.error('Malformed role credential(s): ' + collected.malformed.join(', '));
    return false;
  }

  let adminPool;
  try {
    adminPool = new Pool({ connectionString: ADMIN_URL, connectionTimeoutMillis: 3000 });
    await adminPool.query('SELECT 1');
    console.log('Connected to PostgreSQL server.');
  } catch (err) {
    console.error('Could not connect to PostgreSQL instance: ' + err.message);
    console.log('To launch a local PostgreSQL 16 container via Docker:');
    console.log('  docker run -d --name ztech-postgres -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:16-alpine');
    console.log('Then re-run:');
    console.log('  node scripts/setup-dev-db.js\n');
    return false;
  }

  try {
    // 1. Create target database if it doesn't exist
    const dbCheck = await adminPool.query('SELECT 1 FROM pg_database WHERE datname = $1', [TARGET_DB]);
    if (dbCheck.rows.length === 0) {
      console.log(`Creating database "${TARGET_DB}"...`);
      await adminPool.query(`CREATE DATABASE "${TARGET_DB}"`);
      console.log('Database created.');
    } else {
      console.log('Database exists.');
    }

    // 2. Apply role definitions from roles.sql (M2/M3 architecture)
    console.log('Configuring development roles...');
    if (fs.existsSync(ROLES_FILE)) {
      await adminPool.query(fs.readFileSync(ROLES_FILE, 'utf8'));
    }

    // Set passwords and enable login.
    // The worker role MUST be able to log in: it connects as ztech_worker to
    // claim and execute jobs (assertWorkerIdentity requires session_user = 'ztech_worker').
    // The migrator role requires BYPASSRLS to create SECURITY DEFINER functions and own schema objects.
    // Use the validated setCredential module (SCRAM verifier, no clear-text SQL).
    // The credentials were validated in full before the first change.
    const BYPASSRLS_ALLOWED = new Set([MIGRATION_ROLE]);
    for (const roleCreds of collected.credentials) {
      await setCredential(adminPool, roleCreds.name, roleCreds.password);
      const props = await roleProperties(adminPool, roleCreds.name);
      // Enforce: no runtime role is superuser; BYPASSRLS is allowed ONLY for
      // the migrator role. The worker role must be able to log in.
      if (roleCreds.name === 'ztech_worker' && !props.rolcanlogin) {
        throw new Error('Worker role must be able to log in (the worker connects as ztech_worker)');
      }
      if (props.rolsuper) {
        throw new Error(`Role ${roleCreds.name} must not be SUPERUSER`);
      }
      if (props.rolbypassrls && !BYPASSRLS_ALLOWED.has(roleCreds.name)) {
        throw new Error(`Role ${roleCreds.name} must not bypass RLS (only ztech_migrator may have BYPASSRLS)`);
      }
      console.log(`${roleCreds.name}: ${describeRole(props)}`);
    }

    // Grant permissions on target database. Every one of the six roles is
    // granted CONNECT EXPLICITLY: ztech_identity is not in the five-role
    // default list in postgres-credentials.js, so relying on PostgreSQL's
    // default PUBLIC grant would leave it connected only by accident.
    // The migrator gets ALL for schema creation; the others get CONNECT.
    await adminPool.query(`GRANT CONNECT ON DATABASE "${TARGET_DB}" TO ${ROLES_ORDER.join(', ')}`);
    // Only the migrator gets ALL on database (for schema creation).
    await adminPool.query(`GRANT ALL ON DATABASE "${TARGET_DB}" TO ${MIGRATION_ROLE}`);

    // 3. Create the schemas the migrations require, owned by the migration
    // role. This must happen BEFORE the migrations: the first migration
    // creates unqualified tables, and without `li` they land in `public`
    // (or fail once a qualified li.* table is reached).
    //
    // NOTE: schemas are per-DATABASE, so the statements must run on a
    // connection to the TARGET database - not on the administrative
    // connection, which is connected to `postgres`.
    const targetAdminUrl = new URL(ADMIN_URL);
    targetAdminUrl.pathname = `/${TARGET_DB}`;
    const targetAdmin = new Pool({ connectionString: targetAdminUrl.toString(), connectionTimeoutMillis: 3000 });
    try {
      console.log(`Creating schemas owned by ${MIGRATION_ROLE}...`);
      for (const schema of REQUIRED_SCHEMAS) {
        await targetAdmin.query(`CREATE SCHEMA IF NOT EXISTS ${schema} AUTHORIZATION ${MIGRATION_ROLE}`);
      }
      const owners = await targetAdmin.query(
        `SELECT n.nspname, r.rolname
           FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner
          WHERE n.nspname = ANY($1)`,
        [REQUIRED_SCHEMAS],
      );
      const ownerOf = new Map(owners.rows.map((row) => [row.nspname, row.rolname]));
      for (const schema of REQUIRED_SCHEMAS) {
        const owner = ownerOf.get(schema);
        if (owner !== MIGRATION_ROLE) {
          throw new Error(`Schema ${schema} must be owned by ${MIGRATION_ROLE} (found: ${owner || 'absent'})`);
        }
        console.log(`  ${schema}: owned by ${owner}`);
      }
    } finally {
      await targetAdmin.end();
    }

    await adminPool.end();

    // 4. Connect as migrator and apply migrations - abort on FIRST failure.
    // The search_path is what puts the unqualified tables of migrations
    // 001-013 in `li`, exactly as the deployment and the test harness do.
    const migratorPassword = collected.credentials.find((c) => c.name === MIGRATION_ROLE).password;

    const parsed = new URL(ADMIN_URL);
    parsed.pathname = `/${TARGET_DB}`;
    parsed.username = MIGRATION_ROLE;
    parsed.password = migratorPassword;
    const migratorUrl = parsed.toString();

    console.log(`Applying schema migrations as ${MIGRATION_ROLE}...`);
    const { MIGRATIONS } = require('../packages/lead-intelligence-postgres/src/index');
    const migratorPool = new Pool({ connectionString: migratorUrl, options: '-c search_path=li' });

    const appliedMigrations = [];
    for (const migration of MIGRATIONS) {
      try {
        await migratorPool.query(migration.sql);
        appliedMigrations.push(migration.version);
        console.log(`  Applied migration ${migration.version}`);
      } catch (migErr) {
        console.error('Migration failed:', migErr.message);
        console.error('Aborting on first migration failure. Applied so far:', appliedMigrations.join(', ') || 'none');
        await migratorPool.end();
        return false;
      }
    }
    await migratorPool.end();
    console.log('All PostgreSQL schema migrations applied:', appliedMigrations.join(', '));

    console.log('\nDevelopment PostgreSQL setup complete!');
    console.log('Run the persistent SaaS product with:');
    console.log("  node scripts/start-saas.js --postgres");
    console.log('======================================================\n');
    return true;
  } catch (err) {
    console.error('Setup failed:', err);
    if (adminPool) await adminPool.end();
    return false;
  }
}

if (require.main === module) {
  setup().then((ok) => {
    process.exit(ok ? 0 : 1);
  });
}

module.exports = { setup };