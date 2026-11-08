'use strict';

/**
 * Apply only the NEW schema migrations to an existing ZTech development
 * database. It changes no role, no credential and no grant: run
 * `npm run db:dev:setup` for a first setup.
 *
 * It connects as ztech_migrator with search_path=li and uses the shared,
 * ledger-aware runner (scripts/lib/dev-migrations.js): each migration and its
 * ledger row commit together, recorded versions are skipped, an advisory lock
 * keeps two runners apart, and a database with tables but no migration record
 * is refused rather than replayed.
 *
 * Usage:
 *   set ZTECH_PG_PASSWORD_ZTECH_MIGRATOR=...   (the migrator's credential)
 *   node scripts/migrate-dev-db.js
 * Environment: ZTECH_DEV_DATABASE (default ztech_dev), ZTECH_PG_ADMIN_URL or
 * ZTECH_PG_URL (host and port only are used; the user is the migrator).
 */

const { Pool } = require('pg');
const { validateCredential, passwordEnvVar } = require('./lib/postgres-credentials');
const { applyPendingMigrations, MigrationStateError } = require('./lib/dev-migrations');

const MIGRATION_ROLE = 'ztech_migrator';
const DEV_DB_PATTERNS = [/^ztech_dev$/, /^ztech_dev_/, /^ztech_test$/, /^ztech_test_/, /^test_/];

function isApprovedDevDatabase(name) {
  return DEV_DB_PATTERNS.some((pattern) => pattern.test(name));
}

async function migrate(env = process.env, log = console.log, logError = console.error) {
  const targetDb = env.ZTECH_DEV_DATABASE || 'ztech_dev';
  const baseUrl = env.ZTECH_PG_ADMIN_URL || env.ZTECH_PG_URL || 'postgres://postgres:postgres@localhost:5432/postgres';

  if (!isApprovedDevDatabase(targetDb)) {
    logError(`Refusing to run: "${targetDb}" does not match an approved development database pattern.`);
    return false;
  }
  const variable = passwordEnvVar(MIGRATION_ROLE);
  const password = env[variable];
  const check = validateCredential(MIGRATION_ROLE, password);
  if (!check.ok) {
    logError(`${variable} ${check.reason}. Set the migrator's credential before running the migrations.`);
    return false;
  }

  const url = new URL(baseUrl);
  url.pathname = `/${targetDb}`;
  url.username = MIGRATION_ROLE;
  url.password = password;
  const pool = new Pool({ connectionString: url.toString(), options: '-c search_path=li', connectionTimeoutMillis: 5000 });
  log(`Applying new schema migrations to "${targetDb}" as ${MIGRATION_ROLE}...`);
  try {
    const result = await applyPendingMigrations(pool, { log });
    log(result.applied.length ? `Applied: ${result.applied.join(', ')}` : 'Nothing new: the database is up to date.');
    return true;
  } catch (err) {
    if (err instanceof MigrationStateError) logError(err.message);
    else logError(`Migration ${err.migrationVersion || ''} failed: ${err.message}. It was rolled back; earlier migrations stay applied.`);
    return false;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  migrate().then((ok) => { process.exitCode = ok ? 0 : 1; });
}

module.exports = { migrate, isApprovedDevDatabase };
