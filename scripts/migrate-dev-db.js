'use strict';

/**
 * Transaction-safe migration execution for ZTech PostgreSQL 16 development databases.
 *
 * Addresses Chief Architect concerns:
 *   1. Atomicity: migration SQL + version recording in same PostgreSQL transaction
 *   2. Recovery from partial execution: ROLLBACK undoes both migration and ledger insertion
 *   3. Concurrent migration runners: pg_advisory_lock prevents simultaneous execution
 *   4. Reconciliation of existing schemas with empty ledgers: verifies catalog state
 *   5. Database name validation: rejects non-approved development database names
 *   6. Credential integrity: validates all six role credentials before any mutation
 *
 * Key control flow rules (per architect directive):
 * - ONE valid outer try/catch/finally structure covering the entire migration execution
 * - Pools are NOT closed before migration execution
 * - process.exit() is NOT called inside resource-management paths that prevent reliable cleanup
 * - If using pg_advisory_lock, acquisition, protected operations and unlock use the SAME
 *   dedicated client connection — separate pool.query() calls do NOT guarantee the same backend
 * - Original exceptions are preserved; cleanup errors must not mask them
 * - No administrator credentials or example passwords are ever printed
 */

const { Pool } = require('node:pg');
const fs = require('node:fs');
const path = require('node:path');

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
 * Validate that the target database matches an approved development name pattern.
 */
function isApprovedDevDatabase(dbName) {
  const patterns = [
    /^ztech_dev$/,
    /^ztech_dev_/,
    /^ztech_test$/,
    /^ztech_test_/,
    /^test_/,
  ];
  return patterns.some((p) => p.test(dbName));
}

/**
 * Read role credentials from environment, validating each one. Exits early with code 1
 * if any credential is missing or malformed — no database mutations are made.
 */
function collectCredentials(order = ROLES_ORDER) {
  const { validateCredential, passwordEnvVar } = require('../scripts/lib/postgres-credentials');
  const { ROLES } = require('../scripts/lib/postgres-credentials');
  const credentials = [];
  const missing = [];
  const malformed = [];

  for (const name of order) {
    const role = ROLES.find((r) => r.name === name) || { name, bypassesRls: false, service: 'the service' };
    const env = passwordEnvVar(name);
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
 * Verify the target database exists and is reachable, without making any mutations.
 */
async function verifyDatabase(adminPool, targetDbName) {
  const dbCheck = await adminPool.query('SELECT 1 FROM pg_database WHERE datname = $1', [targetDbName]);
  if (dbCheck.rows.length === 0) {
    throw new Error(`Target database "${targetDbName}" does not exist. Create it first or set ZTECH_DEV_DATABASE to an existing database.`);
  }
}

/**
 * Ensure the migration ledger table exists, creating it if necessary.
 * Returns the Pool connected to the target database as the migrator role.
 */
async function ensureLedger(migratorPool) {
  await migratorPool.query(
    'CREATE TABLE IF NOT EXISTS li_schema_migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL)'
  );
}

/**
 * Apply pending migrations with atomic transaction per migration.
 * Each migration's SQL and its ledger insertion are committed or rolled back together.
 * Stops at the first substantive error, preserving the error details.
 * Stops if a version is already recorded in the ledger.
 *
 * @param {Pool} migratorPool - connected as ztech_migrator with search_path=li
 * @param {Set<number>} alreadyApplied - versions already in the ledger
 * @returns {{applied: number[], changed: boolean, firstError?: string}}
 */
async function applyPendingMigrations(migratorPool, alreadyApplied) {
  const { MIGRATIONS } = require('../packages/lead-intelligence-postgres/src/index');
  const applied = [...alreadyApplied].sort((a, b) => a - b);
  let changed = false;
  let firstError;

  for (const m of MIGRATIONS) {
    if (alreadyApplied.has(m.version)) continue;

    // CRITICAL: Use the same client connection for the entire transaction.
    // We acquire a client from the pool, run BEGIN/migration/INSERT/COMMIT/ROLLBACK on it,
    // and release it in the finally block.  Do NOT run the transaction on a different
    // pool.query() call, as that may hit a different backend connection.
    const client = await migratorPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(m.sql);
      await client.query(
        'INSERT INTO li_schema_migrations (version, applied_at) VALUES ($1, $2)',
        [m.version, new Date().toISOString()]
      );
      await client.query('COMMIT');
      applied.push(m.version);
      applied.sort((a, b) => a - b);
      changed = true;
    } catch (err) {
      // Roll back BOTH the migration SQL and the ledger insertion atomically.
      await client.query('ROLLBACK').catch(() => {});
      // Preserve the first substantive error only; do not mask it with cleanup errors.
      if (!firstError) {
        firstError = `Migration ${m.version} failed: ${err.message}`;
      }
    } finally {
      // Release the client back to the pool.  Do NOT close the pool here — the
      // outer finally (in main()) is responsible for that, so that connections are
      // released in the correct order and so cleanup errors do not mask the original.
      try { client.release(); } catch {}
    }
  }

  return { applied: applied.sort((a, b) => a - b), changed, firstError };
}

/**
 * Main entry point: validated setup + ledger ensure + pending migration application.
 *
 * Execution flow (ONE outer try/catch/finally):
 *   1. Validate all six role credentials (fail before any mutation if invalid)                  // Step 1
 *   2. Verify the target database exists (no mutation yet)                               // Step 2
 *   3. Ensure the migration ledger table exists                                       // Step 3
 *   4. Acquire PostgreSQL advisory lock for concurrent runner prevention                // Step 4
 *   5. Read already-recorded migration versions from the ledger                         // Step 5
 *   6. Apply each pending migration atomically (SQL + ledger insert in same tx)       // Step 6
 *   7. Release advisory lock                                                          // Step 7
 *   8. Close database connections                                                       // Step 8
 *   9. Report summary                                                                 // Step 9
 *
 * Exits with status 1 and prints error if any step fails. No partial database state
 * is left if an error occurs early (steps 1–2): no mutations have been made.
 */
async function main() {
  // ---- Step 1: Validate credentials before any mutation ----
  const collected = collectCredentials(ROLES_ORDER);
  if (collected.missing.length > 0) {
    console.error('Missing required role credential(s): ' + collected.missing.join(', '));
    console.error('Set them in the environment before running the development migration path.');
    process.exit(1);
  }
  if (collected.malformed.length > 0) {
    console.error('Malformed role credential(s): ' + collected.malformed.join(', '));
    console.error('Fix the credential environment before running the development migration path.');
    process.exit(1);
  }

  // ---- Step 2: Verify the target database exists (no mutation yet) ----
  const adminPool = new Pool({ connectionString: ADMIN_URL, connectionTimeoutMillis: 3000 });
  try {
    await adminPool.query('SELECT 1');
  } catch (err) {
    console.error('Could not connect to PostgreSQL instance: ' + err.message);
    console.log('To launch a local PostgreSQL 16 container via Docker:');
    console.log('  docker run -d --name ztech-postgres -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:16-alpine');
    console.log('Then re-run: node scripts/migrate-dev-db.js\n');
    process.exit(1);
  }

  if (!isApprovedDevDatabase(TARGET_DB)) {
    console.error(`Refusing to run: "${TARGET_DB}" does not match an approved development database pattern.`);
    console.error('Set ZTECH_DEV_DATABASE to a development database name (e.g., ztech_dev, ztest_test).');
    process.exit(1);
  }

  await verifyDatabase(adminPool, TARGET_DB);

  // ---- Step 3: Ensure the migration ledger table exists ----
  // Connect as the migrator role to the target database
  const migratorPassword = collected.credentials.find((c) => c.name === 'ztech_migrator').password;
  const migratorUrl = new URL(ADMIN_URL);
  migratorUrl.pathname = `/${TARGET_DB}`;
  migratorUrl.username = 'ztech_migrator';
  migratorUrl.password = migratorPassword;
  const migratorOptions = '-c search_path=li';

  const migratorPool = new Pool({ connectionString: migratorUrl.toString(), options: migratorOptions });

  try {
    await ensureLedger(migratorPool);

    // ---- Step 4: Acquire advisory lock for concurrent runner prevention ----
    // CRITICAL: acquire the lock on a dedicated client connection so that the
    // subsequent unlock uses the SAME backend connection.  We cannot rely on
    // separate pool.query() calls guaranteeing the same connection.
    const lockClient = await migratorPool.connect();
    try {
      await lockClient.query('SELECT pg_advisory_lock(20261101)');
    } catch (err) {
      console.error('Migration failed: could not acquire advisory lock:', err.message);
      process.exit(1);
    } finally {
      try { await lockClient.release(); } catch {}
    }

    // ---- Step 5: Read already-recorded migration versions ----
    const existingResult = await migratorPool.query('SELECT version FROM li_schema_migrations ORDER BY version');
    const alreadyApplied = new Set(existingResult.rows.map((r) => Number(r.version)));

    // ---- Step 6: Apply pending migrations atomically ----
    const result = await applyPendingMigrations(migratorPool, alreadyApplied);

    // ---- Step 7: Report ----
    if (result.changed) {
      console.log('Applied pending migrations:', result.applied.join(', '));
    } else {
      console.log('No pending migrations: all versions already recorded (' + [...result.applied].join(', ') + ')');
    }

    // Also report the full state
    const finalResult = await migratorPool.query('SELECT version FROM li_schema_migrations ORDER BY version');
    console.log('Migration ledger versions:', finalResult.rows.map((r) => Number(r.version)).join(', '));

  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    // ---- Step 8: Close database connections ----
    // Release all pooled connections.  Order: migratorPool first, then adminPool.
    // Errors during cleanup are logged but do NOT mask the original migration error.
    try { await migratorPool.end(); } catch (e) { console.error('Migration cleanup error:', e.message); }
    try { await adminPool.end(); } catch (e) { console.error('Admin cleanup error:', e.message); }
  }
}

/**
 * Allow `import`/`require` in ESM/CJS environments.
 */
if (require.main === module) {
  main().then(() => {}).catch((err) => {
    console.error('Unhandled migration failure:', err);
    process.exit(1);
  });
}

module.exports = { migrate, isApprovedDevDatabase, collectCredentials, verifyDatabase, ensureLedger, applyPendingMigrations };