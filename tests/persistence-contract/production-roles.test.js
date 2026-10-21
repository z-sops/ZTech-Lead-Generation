'use strict';

/**
 * The production roles suite (M2, correction C2).
 *
 * THE PROBLEM THIS SUITE EXISTS FOR
 * --------------------------------
 * A SECURITY DEFINER function runs with the rights of its OWNER. The owner
 * is therefore part of the security boundary: a function owned by a
 * superuser is a function whose every caller is a superuser.
 *
 * The first implementation of the test harness applied the migrations
 * through the ADMINISTRATOR connection - a superuser - so the functions
 * under test were owned by a superuser, and the suite proved properties
 * that a deployment would not have. The owner decides what the function can
 * do, so the test must get the owner right.
 *
 * This suite therefore proves:
 *
 *   1. the tables AND the SECURITY DEFINER functions are owned by the
 *      MIGRATION role - the role that owns them in production - and by
 *      nobody else;
 *   2. every role's real properties: SUPERUSER, BYPASSRLS, ownership;
 *   3. the EFFECTIVE privileges: who may execute what, who may read what;
 *   4. `li.is_suppressed()` for a tenant's own address, for a platform
 *      global address and for an address that is not suppressed;
 *   5. that a tenant cannot ENUMERATE the global suppression rows, and
 *      that the function cannot be used to read or write tenant data.
 *
 * Everything runs against a real PostgreSQL 16, as the real roles.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { freshDatabase, dropDatabase, roleUrl, ROLES, skip, PLATFORM_WORKSPACE_ID } = require('./lib/postgres');

const A = '11111111-1111-4111-8111-111111111111';
const T1 = '2026-09-01T00:00:00.000Z';

if (!process.env.ZTECH_PG_URL) {
  test('[production roles] the production roles suite (skipped: no PostgreSQL is configured)', { skip: 'set ZTECH_PG_URL' }, () => {});
} else {
  const DATABASE = 'ztech_production_roles';
  let db = null;
  let app = null;
  let platform = null;
  let control = null;

  const INSERT_SUPPRESSION = 'INSERT INTO li.li_suppressions (suppression_id, scope, workspace_id, channel, normalized_address, reason, source, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)';

  /** Run fn inside a transaction with a context, on the runtime role. */
  async function asTenant(fn) {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT li.set_workspace($1, $2)', [A, await db.mintToken(A, ROLES.app)]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  test('the setup: the roles exist, and the data is there', async () => {
    db = await freshDatabase(DATABASE, { workspaces: [A] });
    app = new Pool({ connectionString: roleUrl(ROLES.app, DATABASE), options: '-c search_path=li' });
    platform = new Pool({ connectionString: roleUrl(ROLES.platform, DATABASE), options: '-c search_path=li' });
    control = new Pool({ connectionString: roleUrl(ROLES.control, DATABASE), options: '-c search_path=li' });
    // The tenant's own suppression, and the platform's global one.
    await db.owner.query(INSERT_SUPPRESSION, ['sup_own', 'workspace', A, 'email', 'own@example.test', 'unsubscribe', 'user', T1]);
    await db.owner.query(INSERT_SUPPRESSION, ['sup_global', 'global', PLATFORM_WORKSPACE_ID, 'email', 'global@example.test', 'manual', 'import', T1]);
  });

  test('the tables are owned by the MIGRATION role, not by the administrator', async () => {
    const owners = (await db.owner.query(
      `SELECT c.relname, r.rolname AS owner FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_roles r ON r.oid = c.relowner
        WHERE n.nspname = 'li' AND c.relkind = 'r' AND c.relname <> 'li_schema_migrations'`,
    )).rows;
    assert.ok(owners.length > 20, 'the schema has its tables');
    for (const t of owners) {
      assert.equal(t.owner, ROLES.migrator, `${t.relname} is owned by the migration role`);
    }
    // And the administrator is NOT the owner of anything: the test does not
    // exercise a schema that a deployment would not have.
    const adminOwned = (await db.owner.query(
      `SELECT count(*)::int AS n FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_roles r ON r.oid = c.relowner
        WHERE n.nspname = 'li' AND c.relkind = 'r' AND r.rolsuper`,
    )).rows[0].n;
    assert.equal(adminOwned, 0, 'no table is owned by a superuser');
  });

  test('the SECURITY DEFINER functions are owned by the migration role', async () => {
    const fns = (await db.owner.query(
      `SELECT p.proname, oidvectortypes(p.proargtypes) AS args, p.prosecdef AS security_definer,
              r.rolname AS owner, r.rolsuper AS owner_is_superuser
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         JOIN pg_roles r ON r.oid = p.proowner
        WHERE n.nspname = 'li' AND p.prosecdef`,
    )).rows;
    assert.ok(fns.length >= 4, 'the schema has SECURITY DEFINER functions');
    for (const f of fns) {
      assert.equal(f.owner, ROLES.migrator, `${f.proname} is owned by the migration role`);
      assert.equal(f.owner_is_superuser, false, `${f.proname} is not owned by a superuser`);
    }
    // The four that matter are all there.
    const names = fns.map((f) => f.proname).sort();
    for (const expected of ['current_workspace', 'is_suppressed', 'issue_workspace_token', 'set_workspace']) {
      assert.ok(names.includes(expected), `${expected} is SECURITY DEFINER`);
    }
  });

  test('the real properties of every role', async () => {
    const roles = (await db.owner.query(
      'SELECT rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = ANY($1)',
      [[ROLES.app, ROLES.worker, ROLES.platform, ROLES.control, ROLES.migrator]],
    )).rows;
    const byName = new Map(roles.map((r) => [r.rolname, r]));
    for (const name of [ROLES.app, ROLES.worker, ROLES.platform, ROLES.control]) {
      const r = byName.get(name);
      assert.ok(r, `${name} exists`);
      assert.equal(r.rolsuper, false, `${name} is not a superuser`);
      assert.equal(r.rolbypassrls, false, `${name} does not bypass the row-level security`);
      assert.equal(r.rolcreaterole, false, `${name} may not create roles`);
      assert.equal(r.rolcreatedb, false, `${name} may not create databases`);
    }
    // The migration role is the trusted one: it bypasses the policies, and
    // it is not a superuser. The documentation says exactly this, and the
    // database says exactly this.
    const migrator = byName.get(ROLES.migrator);
    assert.equal(migrator.rolsuper, false, 'the migration role is not a superuser');
    assert.equal(migrator.rolbypassrls, true, 'the migration role bypasses the row-level security - it is the trusted role, and it never serves a request');
  });

  test('no runtime role owns anything', async () => {
    const owned = (await db.owner.query(
      `SELECT r.rolname, c.relname, c.relkind FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_roles r ON r.oid = c.relowner
        WHERE n.nspname = 'li' AND r.rolname = ANY($1)`,
      [[ROLES.app, ROLES.worker, ROLES.platform, ROLES.control]],
    )).rows;
    assert.deepEqual(owned, [], 'no table, sequence or function is owned by a runtime role');
  });

  test('the effective privileges: the runtime role may consume, not issue', async () => {
    const rows = (await app.query(
      `SELECT has_function_privilege(current_user, 'li.set_workspace(uuid,text)', 'EXECUTE') AS may_set,
              has_function_privilege(current_user, 'li.current_workspace()', 'EXECUTE') AS may_current,
              has_function_privilege(current_user, 'li.is_suppressed(text,text)', 'EXECUTE') AS may_suppressed,
              has_function_privilege(current_user, 'li.issue_workspace_token(uuid,text,integer)', 'EXECUTE') AS may_issue,
              has_function_privilege(current_user, 'li.to_hex(bytea)', 'EXECUTE') AS may_helper,
              has_table_privilege(current_user, 'li.workspace_grants', 'SELECT') AS may_read_grants,
              has_table_privilege(current_user, 'li.workspace_context', 'SELECT') AS may_read_context,
              has_table_privilege(current_user, 'li.control_plane_secret', 'SELECT') AS may_read_secret`,
    )).rows[0];
    assert.equal(rows.may_set, true, 'the runtime role may open a context - with a token');
    assert.equal(rows.may_current, true);
    assert.equal(rows.may_suppressed, true);
    assert.equal(rows.may_issue, false, 'the runtime role may NOT issue a token');
    assert.equal(rows.may_helper, false, 'and not the helpers either');
    assert.equal(rows.may_read_grants, false, 'the runtime role may not read the workspace grants');
    assert.equal(rows.may_read_context, false, 'the runtime role may not read the context');
    assert.equal(rows.may_read_secret, false, 'the runtime role may not read the control plane secret');
  });

  test('the control plane may issue a token, and may do nothing else', async () => {
    const token = await control.query('SELECT li.issue_workspace_token($1, $2, 60) AS token', [A, ROLES.app]);
    assert.ok(token.rows[0].token, 'the control plane may issue a token');
    // It may not read a row.
    await assert.rejects(control.query('SELECT count(*) FROM li.li_saved_searches'), /permission denied/i);
    await assert.rejects(control.query('SELECT count(*) FROM li.workspace_grants'), /permission denied/i);
    // It may not write a row.
    await assert.rejects(control.query('SELECT li.set_workspace($1, $2)', [A, token.rows[0].token]), /permission denied/i);
    // And it holds no privilege on any table in the schema.
    const tables = (await control.query(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'li' AND c.relkind = 'r' AND c.relacl::TEXT LIKE ('%' || $1 || '=%')`,
      [ROLES.control],
    )).rows;
    assert.deepEqual(tables, [], 'the control plane holds no privileges on any table');
  });

  test('is_suppressed: the tenant\'s own address, a global one, and neither', async () => {
    const result = await asTenant(async (client) => {
      const own = await client.query('SELECT li.is_suppressed($1, $2) AS s', ['email', 'own@example.test']);
      const global = await client.query('SELECT li.is_suppressed($1, $2) AS s', ['email', 'global@example.test']);
      const neither = await client.query('SELECT li.is_suppressed($1, $2) AS s', ['email', 'nobody@example.test']);
      const otherChannel = await client.query('SELECT li.is_suppressed($1, $2) AS s', ['whatsapp', 'own@example.test']);
      return { own: own.rows[0].s, global: global.rows[0].s, neither: neither.rows[0].s, otherChannel: otherChannel.rows[0].s };
    });
    assert.equal(result.own, true, 'the tenant\'s own address is suppressed');
    assert.equal(result.global, true, 'and the platform\'s global suppression blocks the tenant too');
    assert.equal(result.neither, false, 'an address that is not suppressed is not');
    assert.equal(result.otherChannel, false, 'and the channel is part of the question');
  });

  test('the function answers with a BOOLEAN, never with a row', async () => {
    const type = (await db.owner.query(
      `SELECT pg_typeof(li.is_suppressed('email', 'own@example.test'))::TEXT AS t`,
    )).rows[0].t;
    assert.equal(type, 'boolean', 'the answer is a boolean, so no address and no row can leak through it');
  });

  test('a tenant cannot enumerate the global suppression rows', async () => {
    const seen = await asTenant(async (client) => {
      const all = await client.query('SELECT suppression_id, scope, normalized_address FROM li.li_suppressions ORDER BY suppression_id');
      const global = await client.query("SELECT count(*)::int AS n FROM li.li_suppressions WHERE scope = 'global'");
      return { all: all.rows, global: global.rows[0].n };
    });
    assert.deepEqual(seen.all.map((r) => r.suppression_id), ['sup_own'], 'the tenant sees its own row and nothing else');
    assert.equal(seen.global, 0, 'and the global rows cannot even be counted');
    // They are really there.
    const truth = await db.owner.query("SELECT count(*)::int AS n FROM li.li_suppressions WHERE scope = 'global'");
    assert.equal(truth.rows[0].n, 1);
  });

  test('the function cannot be used to read or write tenant data', async () => {
    // It is STABLE, so it cannot write: PostgreSQL will not run a write
    // inside a STABLE function.
    const stable = (await db.owner.query(
      `SELECT provolatile FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'li' AND p.proname = 'is_suppressed'`,
    )).rows[0].provolatile;
    assert.notEqual(stable, 'v', 'is_suppressed is STABLE - it cannot write');
    // And it returns a boolean whatever it is asked, so it cannot be used
    // as a way out of a table.
    const sneaky = await asTenant(async (client) => {
      const r = await client.query('SELECT li.is_suppressed($1, $2) AS s', ['email', 'own@example.test']);
      return r.rows[0];
    });
    assert.deepEqual(Object.keys(sneaky), ['s'], 'the result is one boolean and nothing else');
    // The tenant may not read the platform's rows through any other path:
    // the policy filters them out, so the query answers with nothing.
    const direct = await asTenant(async (client) => {
      const r = await client.query("SELECT normalized_address FROM li.li_suppressions WHERE scope = 'global'");
      return r.rows;
    });
    assert.deepEqual(direct, [], 'the global rows are invisible, not refused: the answer is an empty set');
  });

  test('the cleanup', async () => {
    if (app) await app.end();
    if (platform) await platform.end();
    if (control) await control.end();
    if (db) await dropDatabase(DATABASE, [db.pool, db.owner, db.controlPool, db.platformPool, db.admin]);
  });
}
