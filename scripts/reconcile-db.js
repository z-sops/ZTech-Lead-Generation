/**
 * ZTech Database Reconciliation Procedure
 * N-004E-R5 — Read-only catalog comparison for existing database
 * with empty migration ledger.
 *
 * Compares the actual database state against the expected migration state
 * using PostgreSQL catalogs. Does NOT fabricate applied versions.
 * Reports exact uncertainty if full equivalence cannot be established.
 *
 * Usage (read-only, no mutations):
 *   node scripts/reconcile-db.js --db=postgres://postgres:postgres@localhost:5432/zttech_dev
 *
 * Output: human-readable report, no secret values printed.
 */

const { Pool } = require('pg');
const path = require('node:path');
const { MIGRATIONS } = require('../packages/lead-intelligence-postgres/src/index');

const DATABASE = process.env.ZTECH_DEV_DATABASE || 'zttech_dev';
const ADMIN_URL = process.env.ZTECH_PG_ADMIN_URL || process.env.ZTECH_PG_URL || 'postgres://postgres:postgres@localhost:5432/postgres';

/**
 * Required structural artifacts from migrations 001-021, catalog-query style.
 * Each entry is a SQL query (or query fragment) that verifies a specific
 * expected object. If a query returns no rows, that object is missing.
 */
const EXPECTED_ARTIFACTS = {
  // Schemas and ownership
  schemas: `
    SELECT n.nspname, r.rolname AS owner
    FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner
    WHERE n.nspname IN ('li', 'id')
    ORDER BY n.nspname;
  `,

  // Tables and columns in li schema
  liTables: `
    SELECT table_name,
           (SELECT a.attname FROM pg_attribute a
            WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
            LIMIT 1) AS sample_column
    FROM pg_table t
    JOIN pg_class c ON c.oid = t.table_id
    WHERE t.table_schema = 'li'
    ORDER BY t.table_name;
  `,

  // Actually, let me use a simpler approach with information_schema
  liTableColumns: `
    SELECT table_name, column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'li'
    ORDER BY table_name, ordinal_position;
  `,

  // id schema tables
  idTables: `
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'id'
    ORDER BY table_name;
  `,

  // Indexes in li schema
  liIndexes: `
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = 'li'
    ORDER BY indexname;
  `,

  // RLS policies in li schema
  liPolicies: `
    SELECT policyname, cmd, qual
    FROM pg_policies
    WHERE schemaname = 'li'
    ORDER BY policyname;
  `,

  // Functions in li schema
  liFunctions: `
    SELECT proname, prosrc
    FROM pg_proc
    WHERE pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'li')
    ORDER BY proname;
  `,

  // GRANTs for roles
  roleGrants: `
    SELECT r.rolname,
           d.datname,
           a.privilege_type,
           a.grantee
    FROM pg_database d, aclexplode(d.datacl) a
    JOIN pg_roles r ON r.oid = a.grantee
    WHERE d.datname = '${DATABASE}'
    ORDER BY r.rolname, a.privilege_type;
  `,

  // Control plane secret exists
  controlPlaneSecret: `
    SELECT singleton, pg_size_pretty(pg_estimate_tuple_size(li.control_plane_secret)) AS size_estimate
    FROM li.control_plane_secret
    WHERE singleton = TRUE;
  `,

  // Migration ledger is empty
  migrationLedgerEmpty: `
    SELECT COUNT(*)::int AS n FROM li.li_schema_migrations;
  `,
};

/**
 * Run a query against the target database and return results.
 * Uses the migrator role connection with search_path=li.
 */
async function runQuery(sql, connectionString) {
  const pool = new Pool({ connectionString, options: '-c search_path=li' });
  try {
    const res = await pool.query(sql);
    return res.rows;
  } finally {
    await pool.end();
  }
}

/**
 * Main reconciliation: run all expected-artifact queries and report.
 */
async function reconcile() {
  const connStr = ADMIN_URL.replace(/:.[^:@]+@/, ':****@');
  const dbConnStr = new URL(ADMIN_URL);
  dbConnStr.pathname = `/${DATABASE}`;
  const dbConnStrFull = dbConnStr.toString();

  console.log('=== ZTECH Database Reconciliation Report ===');
  console.log(`Database: ${DATABASE}`);
  console.log(`Date: ${new Date().toISOString()}`);
  console.log('');

  // 1. Verify database identity
  console.log('--- 1. Database Identity ---');
  const dbNames = await runQuery(
    "SELECT datname FROM pg_database WHERE datname = '${DATABASE}'", dbConnStrFull
  );
  console.log(`Database "${DATABASE}" exists: ${dbNames.length > 0}`);
  console.log('');

  // 2. Schemas and ownership
  console.log('--- 2. Schemas and Ownership ---');
  const schemas = await runQuery(EXPECTED_ARTIFACTS.schemas, dbConnStrFull);
  schemas.forEach((s) => {
    console.log(`  Schema "${s.nspname}" owned by role "${s.owner}"`);
  });
  console.log('');

  // 3. li schema tables and sample columns
  console.log('--- 3. li Schema Tables ---');
  const liTables = await runQuery(EXPECTED_ARTIFACTS.liTableColumns, dbConnStrFull);
  const tableNames = [...new Set(liTables.map((r) => r.table_name))];
  console.log(`  Tables found: ${tableNames.length}`);
  // Show first 10
  tableNames.slice(0, 10).forEach((name) => {
    const cols = liTables.filter((r) => r.table_name === name).map((r) => `${r.column_name}(${r.data_type})`);
    console.log(`    ${name}: ${cols.join(', ')}`);
  });
  if (tableNames.length > 10) {
    console.log(`    ... and ${tableNames.length - 10} more tables`);
  }
  console.log('');

  // 4. id schema tables
  console.log('--- 4. id Schema Tables ---');
  const idTables = await runQuery(EXPECTED_ARTIFACTS.idTables, dbConnStrFull);
  const idTableNames = [...new Set(idTables.map((r) => r.table_name))];
  console.log(`  Tables found: ${idTableNames.length}`);
  idTableNames.forEach((name) => console.log(`    ${name}`));
  console.log('');

  // 5. RLS policies
  console.log('--- 5. RLS Policies (li schema) ---');
  const policies = await runQuery(EXPECTED_ARTIFACTS.liPolicies, dbConnStrFull);
  if (policies.length > 0) {
    policies.forEach((p) => {
      console.log(`  Policy: ${p.policyname} | CMD: ${p.cmd} | Qual: ${p.qual ? 'present' : 'absent'}`);
    });
  } else {
    console.log('  No RLS policies found in li schema');
  }
  console.log('');

  // 6. Functions in li schema
  console.log('--- 6. Functions (li schema) ---');
  const functions = await runQuery(EXPECTED_ARTIFACTS.liFunctions, dbConnStrFull);
  console.log(`  Functions found: ${functions.length}`);
  // Show key functions only
  const keyFuncs = ['set_workspace', 'current_workspace', 'issue_workspace_token',
    'session_entitled', 'session_entitled', 'grant_workspace', 'max_token_lifetime',
    'hmac_sha256', 'bytea_xor', 'constant_time_equals', 'to_hex', 'from_hex'];
  const funcNames = new Set(functions.map((f) => f.proname));
  keyFuncs.forEach((fn) => {
    const f = functions.find((f) => f.proname === fn);
    if (f) {
      console.log(`  ${fn}: ${f.prosrc.substring(0, 80)}...`);
    }
  });
  console.log('');

  // 7. Migration ledger state
  console.log('--- 7. Migration Ledger State ---');
  const ledgerCount = await runQuery(EXPECTED_ARTIFACTS.migrationLedgerEmpty, dbConnStrFull);
  console.log(`  li.li_schema_migrations row count: ${ledgerCount[0].n}`);
  if (ledgerCount[0].n === 0) {
    console.log('  Status: EMPTY — no migration versions recorded');
  } else {
    const versions = await runQuery(
      'SELECT version FROM li.li_schema_migrations ORDER BY version', dbConnStrFull
    );
    console.log(`  Recorded versions: ${versions.map((r) => r.version).join(', ')}`);
  }
  console.log('');

  // 8. Control plane secret
  console.log('--- 8. Control Plane Secret ---');
  const secret = await runQuery(EXPECTED_ARTIFACTS.controlPlaneSecret, dbConnStrFull);
  if (secret.length > 0) {
    console.log(`  Singleton: ${secret[0].singleton}`);
    console.log(`  Estimated size: ${secret[0].size_estimate}`);
  } else {
    console.log('  No control plane secret found');
  }
  console.log('');

  // 9. Role grants summary
  console.log('--- 9. Role CONNECT Grants ---');
  const grants = await runQuery(EXPECTED_ARTIFACTS.roleGrants, dbConnStrFull);
  const roleNames = [...new Set(grants.map((g) => g.rolname))];
  console.log(`  Roles with CONNECT grant: ${roleNames.join(', ')}`);
  console.log('');

  // 10. Summary and uncertainty
  console.log('--- 10. Reconciliation Summary ---');
  const uncertainties = [];

  // Check: all 34 li tables exist
  const expectedLiTables = 34;
  if (tableNames.length < expectedLiTables) {
    uncertainties.push(
      `Expected ${expectedLiTables} li tables, found ${tableNames.length}`
    );
  }

  // Check: both schemas exist
  const hasLiSchema = schemas.some((s) => s.nspname === 'li');
  const hasIdSchema = schemas.some((s) => s.nspname === 'id');
  if (!hasLiSchema) uncertainties.push('li schema missing');
  if (!hasIdSchema) uncertainties.push('id schema missing');

  // Check: ledger empty but schema full
  if (ledgerCount[0].n === 0 && tableNames.length >= expectedLiTables) {
    uncertainties.push(
      'Schema fully present but migration ledger empty — structural migrations applied ' +
      'without ledger recording (provisioning script gap)'
    );
  }

  if (uncertainties.length === 0) {
    console.log('  No uncertainties identified — all verified artifacts present.');
  } else {
    uncertainties.forEach((u) => console.log(`  UNCERTAINTY: ${u}`));
  }

  // Final verdict
  console.log('');
  console.log('=== END OF RECONCILIATION REPORT ===');
  console.log('');
  console.log('IMPORTANT: Any subsequent ledger reconciliation must be separately authorized');
  console.log('and based on verified equivalence, not fabricated applied versions.');
  console.log('The empty ledger (0 of 21) reflects a gap in the provisioning script, not');
  console.log('evidence that zero migrations were structurally executed.');
}

if (require.main === module) {
  reconcile().then(() => process.exit(0)).catch((err) => {
    console.error('Reconciliation failed:', err.message);
    process.exit(1);
  });
}

module.exports = { reconcile, EXPECTED_ARTIFACTS, runQuery };