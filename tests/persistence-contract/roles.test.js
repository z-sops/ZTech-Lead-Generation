'use strict';

/**
 * The role separation and the startup assertions (M2).
 *
 * A tenant table without a policy, or a runtime role that owns a table or
 * has BYPASSRLS, would make the isolation a promise rather than a fact. So
 * the service CHECKS the live database before it serves anything - and these
 * tests prove that the check is real, by showing it FAILING when the
 * database is wrong.
 */

const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { freshDatabase, dropDatabase, roleUrl, ROLES, skip } = require('./lib/postgres');
const { assertRuntimeRoles, TENANT_TABLES } = require('../../packages/lead-intelligence-postgres/src/assertRoles');
const { PostgresStore } = require('../../packages/lead-intelligence-postgres/src/PostgresStore');
const { PLATFORM_WORKSPACE_ID } = require('../../packages/lead-intelligence-postgres/src/dialect');

const A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const T1 = '2026-09-01T00:00:00.000Z';

if (!process.env.ZTECH_PG_URL) {
  test('[roles] the role separation (skipped: no PostgreSQL is configured)', { skip: 'set ZTECH_PG_URL' }, () => {});
} else {
  const DATABASE = 'ztech_roles';
  let db = null;

  test('the runtime role passes the startup assertion', async () => {
    db = await freshDatabase(DATABASE, { workspace: A, workspaces: [A, PLATFORM_WORKSPACE_ID] });
    const pool = new Pool({ connectionString: roleUrl(ROLES.app, DATABASE), options: '-c search_path=li' });
    const result = await assertRuntimeRoles(pool);
    assert.deepEqual(result.problems, [], 'the runtime role satisfies every assertion');
    assert.equal(result.ok, true);
    assert.equal(result.checked.role, ROLES.app);
    assert.equal(result.checked.superuser, false);
    assert.equal(result.checked.bypassRls, false);
    assert.equal(result.checked.ownedTables.length, 0, 'it owns no table');
    assert.equal(result.checked.tenantTables, TENANT_TABLES.length);
    await pool.end();
  });

  test('the assertion FAILS for a role that bypasses the row security', async () => {
    // The owner of the tables, with BYPASSRLS: exactly the situation the
    // assertion exists to catch.
    const owner = new Pool({ connectionString: roleUrl(ROLES.migrator, DATABASE), options: '-c search_path=li' });
    await owner.query('SET ROLE ztech_migrator');
    const result = await assertRuntimeRoles(owner);
    assert.equal(result.ok, false, 'the assertion does not pass for a privileged role');
    await owner.end();
  });

  test('every tenant table has row-level security enabled AND forced', async () => {
    const owner = new Pool({ connectionString: roleUrl(ROLES.migrator, DATABASE), options: '-c search_path=li' });
    const rows = (await owner.query(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
              (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation') AS policies
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'li' AND c.relkind = 'r'`,
    )).rows;
    for (const table of TENANT_TABLES) {
      const row = rows.find((r) => r.relname === table);
      assert.ok(row, `${table} exists`);
      assert.equal(row.relrowsecurity, true, `${table} has row-level security ENABLED`);
      assert.equal(row.relforcerowsecurity, true, `${table} has row-level security FORCED`);
      assert.ok(Number(row.policies) >= 1, `${table} has the isolation policy`);
    }
    await owner.end();
  });

  test('a tenant may read the market rules, and may not write them', async () => {
    const tenant = new Pool({ connectionString: roleUrl(ROLES.app, DATABASE), options: '-c search_path=li' });
    const platform = new Pool({ connectionString: roleUrl(ROLES.platform, DATABASE), options: '-c search_path=li' });

    const platformStore = new PostgresStore({ pool: platform, controlPool: db.controlPool, workspaceId: PLATFORM_WORKSPACE_ID, role: 'platform', logger: { warn() {} } });
    await platformStore.marketRules.set({ country_code: 'PK', rule: 'consent_required', note: 'note', reviewed_by: 'Zee', reviewed_at: T1 });

    const tenantStore = new PostgresStore({ pool: tenant, controlPool: db.controlPool, workspaceId: A, role: 'tenant', logger: { warn() {} } });
    assert.equal((await tenantStore.marketRules.get('pk')).rule, 'consent_required', 'a tenant may read it');
    await assert.rejects(
      tenantStore.marketRules.set({ country_code: 'GB', rule: 'consent_required', note: 'n', reviewed_by: 'X', reviewed_at: T1 }),
      (e) => e.code === 'FORBIDDEN',
      'a tenant may not write it',
    );

    // And the DATABASE refuses it too, not only the application.
    await assert.rejects(tenant.query("INSERT INTO li.li_market_rules (country_code, rule, note, reviewed_by, reviewed_at) VALUES ('GB', 'consent_required', 'n', 'X', $1)", [T1]), /permission denied/);
    await tenant.end();
    await platform.end();
  });

  test('a tenant may not create, change or delete a platform-global suppression', async () => {
    const tenant = new Pool({ connectionString: roleUrl(ROLES.app, DATABASE), options: '-c search_path=li' });
    const platform = new Pool({ connectionString: roleUrl(ROLES.platform, DATABASE), options: '-c search_path=li' });
    const tenantStore = new PostgresStore({ pool: tenant, controlPool: db.controlPool, workspaceId: A, role: 'tenant', logger: { warn() {} } });
    const platformStore = new PostgresStore({ pool: platform, controlPool: db.controlPool, workspaceId: PLATFORM_WORKSPACE_ID, role: 'platform', logger: { warn() {} } });

    // The application refuses it.
    await assert.rejects(
      tenantStore.suppressions.add({ suppression_id: 'sup_x', scope: 'global', channel: 'email', normalized_address: 'a@b.test', reason: 'unsubscribe', source: 'relay', created_at: T1 }),
      (e) => e.code === 'FORBIDDEN',
    );
    // And the DATABASE refuses it: the tenant's context cannot write a
    // global row, and the global row is in the platform's workspace.
    await assert.rejects(tenant.query(
      "INSERT INTO li.li_suppressions (workspace_id, suppression_id, scope, channel, normalized_address, reason, source, created_at) VALUES ($1, 'sup_y', 'global', 'email', 'c@d.test', 'unsubscribe', 'relay', $2)",
      [A, T1],
    ));

    // The platform may.
    await platformStore.suppressions.add({ suppression_id: 'sup_g', scope: 'global', channel: 'email', normalized_address: 'secret@platform.test', reason: 'unsubscribe', source: 'relay', created_at: T1 });

    // And the tenant may not enumerate it, nor read its address.
    const visible = await tenant.query('SELECT * FROM li.li_suppressions');
    assert.deepEqual(visible.rows, [], 'the tenant sees no suppression row at all');
    const globals = await tenant.query('SELECT normalized_address FROM li.li_suppressions WHERE scope = $1', ['global']);
    assert.deepEqual(globals.rows, [], 'the global rows are not readable either');
    await tenant.end();
    await platform.end();
  });

  test('the tenant can ask whether an address is suppressed, without seeing it', async () => {
    const tenant = new Pool({ connectionString: roleUrl(ROLES.app, DATABASE), options: '-c search_path=li' });
    const platform = new Pool({ connectionString: roleUrl(ROLES.platform, DATABASE), options: '-c search_path=li' });
    const tenantStore = new PostgresStore({ pool: tenant, controlPool: db.controlPool, workspaceId: A, role: 'tenant', logger: { warn() {} } });
    const platformStore = new PostgresStore({ pool: platform, controlPool: db.controlPool, workspaceId: PLATFORM_WORKSPACE_ID, role: 'platform', logger: { warn() {} } });
    await platformStore.suppressions.add({ suppression_id: 'sup_g2', scope: 'global', channel: 'email', normalized_address: 'hidden@platform.test', reason: 'bounce', source: 'relay', created_at: T1 });

    assert.equal(await tenantStore.suppressions.isSuppressed({ channel: 'email', address: 'hidden@platform.test' }), true, 'the answer is yes');
    assert.equal(await tenantStore.suppressions.isSuppressed({ channel: 'email', address: 'free@example.test' }), false, 'and no for an unsuppressed address');
    const listed = await tenantStore.suppressions.list({});
    assert.equal(listed.rows.length, 0, 'and the row itself is never listed');
    await tenant.end();
    await platform.end();
  });

  after(async () => {
    if (db) await dropDatabase(DATABASE, [db.pool, db.owner, db.admin]);
  });
}
