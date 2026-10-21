'use strict';

/**
 * The startup assertions (M2).
 *
 * A tenant table without a policy, or a runtime role that owns a table or
 * has BYPASSRLS, would make the isolation a promise rather than a fact. So
 * the service CHECKS, against the LIVE database, before it serves anything:
 *
 *   1. the runtime role is not a superuser, has no BYPASSRLS, and cannot
 *      create roles or databases;
 *   2. the runtime role does NOT own any tenant table;
 *   3. every tenant table has row-level security ENABLED and FORCED;
 *   4. every tenant table has the isolation policy, and it is PERMISSIVE
 *      (no restrictive policy that would silently narrow or widen it);
 *   5. the tenant-table INVENTORY matches: a table that was added and not
 *      protected is caught, and so is one that was protected and dropped;
 *   6. PUBLIC holds no privileges on the schema, the tables or the
 *      functions;
 *   7. the platform's global reference data is read-only for the tenant
 *      roles.
 *
 * The check is deliberately against the catalogue, not against a list the
 * application carries: the application can be wrong, the database cannot.
 */

/** The tables that are tenant-owned. Every one of them must be isolated. */
const TENANT_TABLES = Object.freeze([
  'li_research_jobs', 'li_evidence_packets', 'li_research_changes', 'li_saved_searches',
  'li_segments', 'li_segment_members', 'li_pitch_drafts', 'li_outreach_approvals',
  'li_outreach_activity', 'li_outreach_sends', 'li_enrichment_jobs', 'li_enrichment_observations',
  'li_oi_associations', 'li_oi_refresh_requests', 'li_suppressions', 'li_contact_consents',
  'li_contact_provenance', 'li_trust_events', 'li_recipient_refs', 'li_mailboxes',
  'li_mailbox_sent', 'li_reply_reviews', 'li_sequences', 'li_sequence_steps',
  'li_sequence_events', 'li_sequence_gaps', 'li_sequence_control', 'li_reply_routes',
]);

/**
 * The tables that are NOT tenant-owned, and must not be isolated.
 *
 * `workspace_grants` is the platform's table: it says which workspace a
 * role may act for, and the runtime roles may not read it at all - only the
 * SECURITY DEFINER function that checks the grant may.
 */
const GLOBAL_TABLES = Object.freeze(['li_schema_migrations', 'li_market_rules', 'workspace_grants']);

/** The policy every tenant table must carry. */
const POLICY_NAME = 'tenant_isolation';

/**
 * Assert everything, against the live database.
 *
 * @param {object} pool a pg pool connected as the RUNTIME role
 * @param {{role?: string, schema?: string}} [opts]
 * @returns {Promise<{ok: boolean, problems: string[], checked: object}>}
 */
async function assertRuntimeRoles(pool, opts = {}) {
  const schema = opts.schema || 'li';
  const role = opts.role || 'current_user';
  const problems = [];

  // 1. The runtime role's own properties.
  const roleRows = (await pool.query(
    'SELECT r.rolname, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, r.rolinherit FROM pg_roles r WHERE r.rolname = current_user',
  )).rows;
  if (!roleRows.length) {
    problems.push('the runtime role does not exist');
    return { ok: false, problems, checked: {} };
  }
  const me = roleRows[0];
  if (me.rolsuper) problems.push(`${me.rolname} is a SUPERUSER`);
  if (me.rolbypassrls) problems.push(`${me.rolname} has BYPASSRLS`);
  if (me.rolcreaterole) problems.push(`${me.rolname} may create roles`);
  if (me.rolcreatedb) problems.push(`${me.rolname} may create databases`);

  // 2. The runtime role must not own a tenant table.
  const owned = (await pool.query(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     JOIN pg_roles r ON r.oid = c.relowner
     WHERE n.nspname = $1 AND c.relkind = 'r' AND r.rolname = current_user`,
    [schema],
  )).rows.map((r) => r.relname);
  for (const table of owned) problems.push(`${table} is owned by the runtime role`);

  // 3, 4 and 5. The tenant-table inventory and every table's isolation.
  const catalogue = (await pool.query(
    `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
            EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = $2) AS has_policy,
            (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid AND p.polpermissive = false) AS restrictive
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind = 'r'`,
    [schema, POLICY_NAME],
  )).rows;
  const byName = new Map(catalogue.map((r) => [r.relname, r]));
  for (const table of TENANT_TABLES) {
    const row = byName.get(table);
    if (!row) { problems.push(`${table} does not exist`); continue; }
    if (!row.relrowsecurity) problems.push(`${table} does not have row-level security ENABLED`);
    if (!row.relforcerowsecurity) problems.push(`${table} does not have row-level security FORCED`);
    if (!row.has_policy) problems.push(`${table} does not have the ${POLICY_NAME} policy`);
    if (Number(row.restrictive) > 0) problems.push(`${table} has ${row.restrictive} restrictive policies`);
  }
  const protectedTables = new Set(TENANT_TABLES);
  for (const row of catalogue) {
    if (protectedTables.has(row.relname)) continue;
    if (GLOBAL_TABLES.includes(row.relname)) continue;
    problems.push(`${row.relname} is a table nobody protects: it is neither tenant-owned nor global`);
  }

  // 6. PUBLIC must hold no privileges.
  const publicSchema = (await pool.query(
    "SELECT has_schema_privilege('public', $1, 'USAGE') AS usage, has_schema_privilege('public', $1, 'CREATE') AS create",
    [schema],
  )).rows[0];
  if (publicSchema.usage) problems.push(`PUBLIC has USAGE on the ${schema} schema`);
  if (publicSchema.create) problems.push(`PUBLIC may CREATE in the ${schema} schema`);
  const publicTables = (await pool.query(
    `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind = 'r'
        AND (has_table_privilege('public', c.oid, 'SELECT') OR has_table_privilege('public', c.oid, 'INSERT')
          OR has_table_privilege('public', c.oid, 'UPDATE') OR has_table_privilege('public', c.oid, 'DELETE'))`,
    [schema],
  )).rows[0];
  if (publicTables.n > 0) problems.push(`PUBLIC holds privileges on ${publicTables.n} table(s)`);
  const publicFunctions = (await pool.query(
    `SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = $1 AND has_function_privilege('public', p.oid, 'EXECUTE')`,
    [schema],
  )).rows[0];
  if (publicFunctions.n > 0) problems.push(`PUBLIC may execute ${publicFunctions.n} function(s)`);

  // 7. The platform data: the tenant roles may read it, never write it.
  const marketRules = (await pool.query(
    `SELECT has_table_privilege(current_user, 'li.li_market_rules', 'SELECT') AS can_read,
            has_table_privilege(current_user, 'li.li_market_rules', 'INSERT') AS can_insert,
            has_table_privilege(current_user, 'li.li_market_rules', 'UPDATE') AS can_update,
            has_table_privilege(current_user, 'li.li_market_rules', 'DELETE') AS can_delete`,
  )).rows[0];
  if (!marketRules.can_read) problems.push('the runtime role may not read the market rules');
  if (marketRules.can_insert || marketRules.can_update || marketRules.can_delete) {
    problems.push('the runtime role may WRITE the platform data');
  }

  // 8. The grants table is the platform's: the runtime role may not read it.
  const grants = (await pool.query(
    "SELECT has_table_privilege(current_user, 'li.workspace_grants', 'SELECT') AS can_read",
  )).rows[0];
  if (grants.can_read) problems.push('the runtime role may read the workspace grants');

  return {
    ok: problems.length === 0,
    problems,
    checked: {
      role: me.rolname,
      superuser: me.rolsuper,
      bypassRls: me.rolbypassrls,
      createRole: me.rolcreaterole,
      createDb: me.rolcreatedb,
      ownedTables: owned,
      tenantTables: TENANT_TABLES.length,
      globalTables: GLOBAL_TABLES,
      publicTablePrivileges: publicTables.n,
      publicFunctionPrivileges: publicFunctions.n,
    },
  };
}

module.exports = { TENANT_TABLES, GLOBAL_TABLES, POLICY_NAME, assertRuntimeRoles };
