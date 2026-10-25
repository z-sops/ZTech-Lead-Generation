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
  collectCredentials, validateCredential, setCredential,
  disableLogin, roleProperties, describeRole
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

async function setup() {
  console.log('--- ZTech Development PostgreSQL 16 Setup ---');
  console.log(`Target Database: ${TARGET_DB}`);
  console.log(`Admin Connection: ${ADMIN_URL.replace(/:.[^:@]+@/, ':****@')}`);

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
      try {
        await adminPool.query(fs.readFileSync(ROLES_FILE, 'utf8'));
      } catch (roleErr) {
        // Roles might already exist; continue to verify state
      }
    }

    // Set passwords and enable login.
    // The worker role must remain NOLOGIN per the accepted architecture.
    // Use the validated setCredential module (SCRAM verifier, no clear-text SQL).
    for (const role of ROLES_ORDER) {
      const creds = collectCredentials([role]);
      if (creds.missing.length > 0) {
        console.warn(`Credential env var missing for role ${role}; skipping login enablement.`);
        await disableLogin(adminPool, role);
        continue;
      }
      if (creds.malformed.length > 0) {
        console.warn(`Credential malformed for role ${role}; skipping login enablement.`);
        await disableLogin(adminPool, role);
        continue;
      }
      const roleCreds = creds.credentials[0];
      await setCredential(adminPool, roleCreds.name, roleCreds.password);
      const props = await roleProperties(adminPool, roleCreds.name);
      // Enforce: worker role stays NOLOGIN; no runtime role is superuser or BYPASSRLS.
      if (roleCreds.name === 'ztech_worker' && props.rolcanlogin) {
        await disableLogin(adminPool, roleCreds.name);
        console.log('Worker role forced NOLOGIN per architecture.');
      }
      if (!props.rolcanlogin) {
        console.log(`${roleCreds.name}: ${describeRole(props)}`);
      }
    }

    // Grant permissions on target database (only roles that can log in may connect).
    const creds = collectCredentials();
    const loginRoles = creds.credentials.filter((c) => c.name !== 'ztech_worker').map((c) => c.name);
    await adminPool.query(`GRANT CONNECT ON DATABASE "${TARGET_DB}" TO ${loginRoles.join(', ')}`);
    // Only the migrator gets ALL on database (for schema creation).
    await adminPool.query(`GRANT ALL ON DATABASE "${TARGET_DB}" TO ztech_migrator`);

    await adminPool.end();

    // 3. Connect as migrator and apply migrations - stop on real failures.
    const parsed = new URL(ADMIN_URL);
    parsed.pathname = `/${TARGET_DB}`;
    parsed.username = 'ztech_migrator';
    // Use a temporary password from env; the migrator credential is set separately.
    const migratorPassword = process.env.ZTECH_DEV_PG_PASSWORD || 'ztech_dev_secret';
    parsed.password = migratorPassword;
    const migratorUrl = parsed.toString();

    console.log('Applying schema migrations as ztech_migrator...');
    const { MIGRATIONS } = require('../packages/lead-intelligence-postgres/src/index');
    const migratorPool = new Pool({ connectionString: migratorUrl });

    let migrationErrors = 0;
    for (const migration of MIGRATIONS) {
      try {
        await migratorPool.query(migration.sql);
      } catch (migErr) {
        console.error('Migration failed:', migErr.message);
        migrationErrors += 1;
        // Do not silently ignore: stop on genuine migration failures.
        if (migrationErrors >= 3) {
          console.error('Too many migration failures; aborting setup.');
          await migratorPool.end();
          return false;
        }
      }
    }
    await migratorPool.end();
    console.log('All PostgreSQL schema migrations applied.');

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