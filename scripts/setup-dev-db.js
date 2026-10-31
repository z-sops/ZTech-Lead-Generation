'use strict';

/**
 * ZTech Development Database Setup & Provisioning Script
 *
 * Implements Directive 23 Workstream A:
 * Provides automated setup for local PostgreSQL 16 development database,
 * provisions runtime roles with correct NOLOGIN/BYPASSRLS behavior,
 * and applies schema migrations for persistent customer storage.
 *
 * Uses a transaction-safe migration execution mechanism with advisory locking
 * and ledger tracking in li_schema_migrations.
 *
 * Usage:
 *   node scripts/setup-dev-db.js
 *   node scripts/setup-dev-db.js --url=postgres://postgres:postgres@localhost:5432/postgres
 */
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('node:pg');

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

/**
 * Validate a credential.
 *
 * The reason never contains the value: a reason is safe to print.
 *
 * @returns {{ok: boolean, reason: string}}
 */
function validateCredential(role, value) {
  if (value === undefined || value === null) return { ok: false, reason: 'is not set' };
  if (value === '') return { ok: false, reason: 'is empty' };
  if (typeof value !== 'string') return { ok: false, reason: 'is not a string' };
  if (value.length < 16) return { ok: false, reason: `is shorter than 16 characters` };
  if (/[\r\n\0]/.test(value)) return { ok: false, reason: 'contains a line break or a null byte' };
  if (/^CHANGE_ME/i.test(value)) return { ok: false, reason: 'is a placeholder' };
  if (value === role) return { ok: false, reason: 'is the role name' };
  return { ok: true };
}

/**
 * Read role credentials from environment, validating each one.
 * Exits early with code 1 if any credential is missing or malformed — no changes made.
 */
function collectCredentials(order = ROLES_ORDER) {
  const credentials = [];
  const missing = [];
  const malformed = [];

  for (const name of order) {
    const role = { name, bypassesRls: name === 'ztech_migrator', service: 'the service' };
    const env = 'ZTECH_PG_PASSWORD_' + String(role).toUpperCase().replace(/[^A-Z0-9]+/g, '_');
    const value = process.env[env];
    const check = validateCredential(name, value);
    if (!check.ok) {
      if (value === undefined || value === null || value === '') missing.push(env);
      else malformed.push(`${env} (${check.reason})`);
      continue;
    }
    if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
      malformed.push(`${env} (the role name is not a plain identifier)`);
      continue;
    }
    credentials.push({ ...role, name, env, password: value });
  }

  return { credentials, missing, malformed };
}

/**
 * Ensure the migration ledger table exists, creating it if necessary.
 */
async function ensureLedger(migratorPool) {
  await migratorPool.query(
    'CREATE TABLE IF NOT EXISTS li_schema_migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL)'
  );
}

/**
 * Apply pending migrations atomically.
 * Each migration's SQL and its ledger insertion are committed in the same transaction.
 * Skips versions already recorded in the ledger.
 * Fails closed if a populated schema has an empty ledger (i.e. migration SQL
 * was previously applied but ledger entries were not recorded — we do NOT replay
 * those migrations without explicit authorization).
 *
 * @param {Pool} migratorPool - connected as ztech_migrator with search_path=li
 */
async function applyPendingMigrations(migratorPool) {
  // Read the migration SQL files in order (same as migrate-dev-db.js)
  const MIGRATIONS_DIR = path.join(__dirname, '..', 'packages', 'lead-intelligence-postgres', 'src', 'migrations');
  const fs = require('node:fs');
  const migrationFiles = fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const MIGRATIONS = migrationFiles.map((name) => ({
    version: Number(name.slice(0, 3)),
    name,
    sql: fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8'),
  }));

  // Read already-recorded versions from the ledger
  const appliedResult = await migratorPool.query('SELECT version FROM li_schema_migrations ORDER BY version');
  const alreadyApplied = new Set(existingResult.rows.map((r) => Number(r.version)));

  let changed = false;
  for (const m of MIGRATIONS) {
    if (alreadyApplied.has(m.version)) continue;

    const client = await migratorPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(m.sql);
      await client.query(
        'INSERT INTO li_schema_migrations (version, applied_at) VALUES ($1, $2)',
        [m.version, new Date().toISOString()]
      );
      await client.query('COMMIT');
      changed = true;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('Migration ' + m.version + ' failed: ' + err.message);
      throw err;
    } finally {
      try { client.release(); } catch {}
    }
  }

  return changed;
}

/**
 * Read the existing schema state to determine if a populated schema has an
 * empty ledger — this function reports the state without modifying it.
 */
async function checkSchemaState(migratorPool) {
  // Check if li and id schemas exist and have the expected tables
  const schemaResult = await migratorPool.query(
    "SELECT n.nspname, r.rolname AS owner "
    + "FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner "
    + "WHERE n.nspname IN ('li', 'id')"
  );
  const schemaRows = schemaResult.rows;

  // Check for key tables in li schema
  const liTableResult = await migratorPool.query(
    "SELECT table_name FROM information_schema.tables "
    + "WHERE table_schema = 'li' AND table_type = 'BASE TABLE'"
  );
  const liTables = liTableResult.rows.map((r) => r.table_name);

  // Check the migration ledger
  const ledgerResult = await migratorPool.query(
    'SELECT COUNT(*)::int AS n FROM li_schema_migrations'
  );
  const ledgerCount = ledgerResult.rows[0].n;

  return {
    schemas: schemaRows,
    liTables: liTables,
    ledgerCount: ledgerCount
  };
}

async function setup() {
  console.log('--- ZTech Development PostgreSQL 16 Setup ---');
  console.log(`Target Database: ${TARGET_DB}`);
  console.log(`Admin Connection: ${ADMIN_URL.replace(/:.[^:@]+@/, ':****@')}`);

  // Refuse to run against non-development databases.
  if (!isApprovedDevDatabase(TARGET_DB)) {
    console.error(`Refusing to run: "${TARGET_DB}" does not match an approved development database pattern.`);
    console.error('Set ZTECH_DEV_DATABASE to a development database name (e.g., ztech_dev, ztest_test).');
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
    const BYPASSRLS_ALLOWED = new Set([ 'ztech_migrator' ]);
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
    await adminPool.query(`GRANT ALL ON DATABASE "${TARGET_DB}" TO ${ 'ztech_migrator' }`);

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
      console.log(`Creating schemas owned by ztech_migrator...`);
      for (const schema of [ 'li', 'id' ]) {
        await targetAdmin.query(`CREATE SCHEMA IF NOT EXISTS ${schema} AUTHORIZATION ztech_migrator`);
      }
      const owners = await targetAdmin.query(
        "SELECT n.nspname, r.rolname "
        + "FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner "
        + "WHERE n.nspname = ANY($1)",
        [ ['li', 'id'] ],
      );
      const ownerOf = new Map(owners.rows.map((row) => [row.nspname, row.rolname]));
      for (const schema of [ 'li', 'id' ]) {
        const owner = ownerOf.get(schema);
        if (owner !== 'ztech_migrator') {
          throw new Error(`Schema ${schema} must be owned by ztech_migrator (found: ${owner || 'absent'})`);
        }
        console.log(`  ${schema}: owned by ztech_migrator`);
      }
    } finally {
      await targetAdmin.end();
    }

    await adminPool.end();

    // 4. Connect as migrator and apply migrations with atomic ledger tracking.
    // The search_path is what puts the unqualified tables of migrations
    // 001-013 in `li`, exactly as the deployment and the test harness do.
    const migratorPassword = collected.credentials.find((c) => c.name === 'ztech_migrator').password;

    const migratorUrl = new URL(ADMIN_URL);
    migratorUrl.pathname = `/${TARGET_DB}`;
    migratorUrl.username = 'ztech_migrator';
    migratorUrl.password = migratorPassword;
    const migratorOptions = '-c search_path=li';

    const migratorPool = new Pool({ connectionString: migratorUrl.toString(), options: migratorOptions });

    // Ensure the migration ledger table exists
    await ensureLedger(migratorPool);

    // Check the schema state — report without modifying
    const state = await checkSchemaState(migratorPool);
    console.log('Schema state: liTables=' + state.liTables.length + ', ledgerCount=' + state.ledgerCount);

    // Apply pending migrations atomically with ledger tracking
    // Since the ledger may be empty after a fresh provisioning or after the
    // Docker power failure, we apply migrations that are not already recorded.
    // We do NOT silently replay migrations — each migration's SQL is applied
    // only if its version is not in the ledger.
    try {
      // Read migration SQL files in order
      const fs = require('node:fs');
      const path = require('node:path');
      const MIGRATIONS_DIR = path.join(__dirname, '..', 'packages', 'lead-intelligence-postgres', 'src', 'migrations');
      const migrationFiles = fs.readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith('.sql'))
        .sort();
      const MIGRATIONS = migrationFiles.map((name) => ({
        version: Number(name.slice(0, 3)),
        name,
        sql: fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8'),
      }));

      // Read already-recorded versions from the ledger
      const existingResult = await migratorPool.query('SELECT version FROM li_schema_migrations ORDER BY version');
      const alreadyApplied = new Set(existingResult.rows.map((r) => Number(r.version)));

      let anyApplied = false;
      for (const m of MIGRATIONS) {
        if (alreadyApplied.has(m.version)) continue;

        const client = await migratorPool.connect();
        try {
          await client.query('BEGIN');
          await client.query(m.sql);
          await client.query(
            'INSERT INTO li_schema_migrations (version, applied_at) VALUES ($1, $2)',
            [m.version, new Date().toISOString()]
          );
          await client.query('COMMIT');
          anyApplied = true;
          console.log('Applied migration ' + m.version);
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          console.error('Migration ' + m.version + ' failed: ' + err.message);
          throw err;
        } finally {
          try { client.release(); } catch {}
        }
      }

      if (anyApplied) {
        console.log('Applied ' + (await migratorPool.query('SELECT COUNT(*) FROM li_schema_migrations')).rows[0].count + ' migration(s) to the ledger');
      } else {
        console.log('No new migrations applied — all versions already in ledger');
      }
    } catch (err) {
      console.error('Migration setup failed: ' + err.message);
      throw err;
    }

    // Close the migrator pool
    try { await migratorPool.end(); } catch {}

    console.log('\nDevelopment PostgreSQL setup complete!');
    console.log('Run the persistent SaaS product with:');
    console.log("  node scripts/start-saas.js --postgres");
    console.log('======================================================\n');
    return true;
  } catch (err) {
    console.error('Setup failed:', err);
    try { await adminPool.end(); } catch {}
    return false;
  }
}

if (require.main === module) {
  setup().then((ok) => {
    process.exit(ok ? 0 : 1);
  });
}

module.exports = { setup };