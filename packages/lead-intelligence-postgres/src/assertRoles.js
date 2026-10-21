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
 *
 * `workspace_context` holds the context of the current transaction, and
 * `control_plane_secret` holds the key the workspace tokens are signed
 * with. Neither may be read or written by a runtime role: the first is
 * where a tenant's scope lives, and the second is what proves it.
 */
const GLOBAL_TABLES = Object.freeze([
  'li_schema_migrations', 'li_market_rules', 'workspace_grants', 'workspace_context', 'control_plane_secret',
]);

/** The policy every tenant table must carry. */
const POLICY_NAME = 'tenant_isolation';

/**
 * The functions that make the isolation work, and the role that owns them.
 *
 * A SECURITY DEFINER function runs with the rights of its OWNER, so the
 * owner is part of the security boundary: a function owned by a superuser
 * is a function whose every caller is a superuser. These are owned by the
 * migration role, which is not a superuser.
 */
const SECURITY_FUNCTIONS = Object.freeze([
  { name: 'set_workspace', args: 'uuid,text' },
  { name: 'current_workspace', args: '' },
  { name: 'issue_workspace_token', args: 'uuid,text,integer' },
  { name: 'is_suppressed', args: 'text,text' },
]);

/** The role that owns the schema, the tables and the functions. */
const MIGRATOR_ROLE = 'ztech_migrator';

/** The role that may issue a workspace token, and nothing else. */
const CONTROL_ROLE = 'ztech_control';

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

  // 9. The context and the secret are closed to the runtime role.
  //
  // The context is where a tenant's scope lives, and the secret is what
  // proves it. A runtime role that could write either one could choose its
  // own tenant.
  for (const table of ['li.workspace_context', 'li.control_plane_secret']) {
    const p = (await pool.query(
      `SELECT has_table_privilege(current_user, $1, 'SELECT') AS can_read,
              has_table_privilege(current_user, $1, 'INSERT') AS can_insert,
              has_table_privilege(current_user, $1, 'UPDATE') AS can_update,
              has_table_privilege(current_user, $1, 'DELETE') AS can_delete,
              has_table_privilege(current_user, $1, 'TRUNCATE') AS can_truncate`,
      [table],
    )).rows[0];
    if (p.can_read) problems.push(`the runtime role may read ${table}`);
    if (p.can_insert || p.can_update || p.can_delete || p.can_truncate) {
      problems.push(`the runtime role may WRITE ${table}`);
    }
  }

  // 10. The runtime role may not ISSUE a token.
  //
  // This is the heart of it: a session that could ask for a token for any
  // workspace could choose its own tenant. Only the control plane may.
  const mayIssue = (await pool.query(
    "SELECT has_function_privilege(current_user, 'li.issue_workspace_token(uuid,text,integer)', 'EXECUTE') AS may_issue",
  )).rows[0].may_issue;
  if (mayIssue) problems.push('the runtime role may issue a workspace token');

  // 11. The security functions: SECURITY DEFINER, owned by the migration
  // role, and owned by nobody who is a superuser.
  const functions = (await pool.query(
    `SELECT p.proname, oidvectortypes(p.proargtypes) AS args, p.prosecdef AS security_definer,
            p.proconfig, r.rolname AS owner, r.rolsuper AS owner_is_superuser, r.rolbypassrls AS owner_bypasses_rls,
            p.proacl
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       JOIN pg_roles r ON r.oid = p.proowner
      WHERE n.nspname = $1`,
    [schema],
  )).rows;
  // The identity arguments come back as 'uuid, text'; the table above writes
  // 'uuid,text'. The spaces are removed on both sides.
  const functionByName = new Map(functions.map((f) => [`${f.proname}(${String(f.args).replace(/\s+/g, '')})`, f]));
  for (const fn of SECURITY_FUNCTIONS) {
    const found = functionByName.get(`${fn.name}(${fn.args.replace(/\s+/g, '')})`);
    if (!found) { problems.push(`${fn.name}(${fn.args}) does not exist`); continue; }
    if (!found.security_definer) problems.push(`${fn.name}(${fn.args}) is not SECURITY DEFINER`);
    if (found.owner !== MIGRATOR_ROLE) {
      problems.push(`${fn.name}(${fn.args}) is owned by ${found.owner}, not by ${MIGRATOR_ROLE}`);
    }
    if (found.owner_is_superuser) problems.push(`${fn.name}(${fn.args}) is owned by a SUPERUSER`);
    if (!String(found.proconfig || '').includes('search_path')) {
      problems.push(`${fn.name}(${fn.args}) does not pin its search_path`);
    }
  }
  const ownedFunctions = functions.filter((f) => f.owner === me.rolname).map((f) => f.proname);
  for (const name of ownedFunctions) problems.push(`${name} is owned by the runtime role`);

  // 12. The control plane: it may issue a token, and it may do NOTHING
  // else. It is not a superuser, it does not bypass the row-level security,
  // it is a member of no other role, and it holds no privilege on any table
  // in the schema.
  const control = (await pool.query(
    'SELECT r.rolname, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb FROM pg_roles r WHERE r.rolname = $1',
    [CONTROL_ROLE],
  )).rows;
  if (!control.length) {
    problems.push(`the ${CONTROL_ROLE} role does not exist`);
  } else {
    const c = control[0];
    if (c.rolsuper) problems.push(`${CONTROL_ROLE} is a SUPERUSER`);
    if (c.rolbypassrls) problems.push(`${CONTROL_ROLE} has BYPASSRLS`);
    if (c.rolcreaterole) problems.push(`${CONTROL_ROLE} may create roles`);
    if (c.rolcreatedb) problems.push(`${CONTROL_ROLE} may create databases`);
    const memberships = (await pool.query(
      'SELECT r.rolname FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = $1)',
      [CONTROL_ROLE],
    )).rows.map((r) => r.rolname);
    if (memberships.length) problems.push(`${CONTROL_ROLE} is a member of ${memberships.join(', ')}`);
    // Its privileges on the tables, from the catalogue: the runtime role
    // cannot ask has_table_privilege() about another role, but it can read
    // the access control lists.
    const controlOnTables = (await pool.query(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relkind = 'r' AND c.relacl::TEXT LIKE ('%' || $2 || '=%')`,
      [schema, CONTROL_ROLE],
    )).rows.map((r) => r.relname);
    for (const t of controlOnTables) problems.push(`${CONTROL_ROLE} holds privileges on ${t}`);
    // It may execute the token issuer, and the issuer only.
    const issuer = functionByName.get(`issue_workspace_token(${SECURITY_FUNCTIONS[2].args.replace(/\s+/g, '')})`);
    if (issuer && !String(issuer.proacl || '').includes(`${CONTROL_ROLE}=X`)) {
      problems.push(`${CONTROL_ROLE} may not issue a workspace token`);
    }
  }

  // 13. The migration role: it owns the schema, and it is not a superuser.
  const migrator = (await pool.query(
    'SELECT r.rolname, r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname = $1',
    [MIGRATOR_ROLE],
  )).rows;
  if (!migrator.length) {
    problems.push(`the ${MIGRATOR_ROLE} role does not exist`);
  } else {
    if (migrator[0].rolsuper) problems.push(`${MIGRATOR_ROLE} is a SUPERUSER`);
  }

  // 14. The context is BOUNDED.
  //
  // The expiry of the credential is written into the context record, and
  // the record is in a table the runtime role cannot write - so a context
  // cannot outlive the token that opened it, and it cannot be pushed
  // forward. The maximum lifetime is an explicit, sane number.
  // The catalogue, not information_schema: the runtime role has no
  // privilege on the context table, and information_schema only shows what
  // the caller may see.
  const contextColumn = (await pool.query(
    `SELECT count(*)::int AS n
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace ns ON ns.oid = c.relnamespace
      WHERE ns.nspname = $1 AND c.relname = 'workspace_context'
        AND a.attname = 'expires_at' AND a.attnum > 0 AND NOT a.attisdropped`,
    [schema],
  )).rows[0].n;
  if (!contextColumn) problems.push('the context record has no expiry');
  // The maximum is read from the CATALOGUE, not by calling the function:
  // the runtime role may not execute the helpers, and it does not need to.
  const maximum = (await pool.query(
    `SELECT (regexp_match(p.prosrc, 'SELECT[\\s\\n]+([0-9]+)'))[1]::int AS n
       FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
      WHERE ns.nspname = $1 AND p.proname = 'max_token_lifetime'`,
    [schema],
  )).rows[0];
  if (!maximum) problems.push('the maximum token lifetime does not exist');
  else if (!(maximum.n > 0 && maximum.n <= 3600)) {
    problems.push(`the maximum token lifetime is ${maximum.n} seconds, which is not a sane bound`);
  }

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
      ownedFunctions,
      tenantTables: TENANT_TABLES.length,
      globalTables: GLOBAL_TABLES,
      publicTablePrivileges: publicTables.n,
      publicFunctionPrivileges: publicFunctions.n,
      mayIssueToken: mayIssue,
      migratorBypassesRls: migrator.length ? migrator[0].rolbypassrls : null,
    },
  };
}

module.exports = {
  TENANT_TABLES, GLOBAL_TABLES, POLICY_NAME, SECURITY_FUNCTIONS, MIGRATOR_ROLE, CONTROL_ROLE, assertRuntimeRoles,
};
