'use strict';

/**
 * The migration-016 staging proof.
 *
 * A database is staged at migrations 001-015 — the state before M4 — and a
 * WORKER-role workspace token is minted under the OLD rules, where the
 * identity service could grant the worker role a workspace and the control
 * plane could mint a token for it. Migration 016 is then applied, and the
 * historical authority must be GONE.
 *
 * This is the proof that a deployment which already had a worker role with
 * a workspace grant is safe after the upgrade.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const { URL, ROLES, roleUrl, ensureRoles } = require('./lib/postgres');
const { MIGRATIONS } = require('../../packages/lead-intelligence-postgres/src/index');

const A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const ORG = 'cccccccc-1111-4111-8111-cccccccccccc';
const USER = 'dddddddd-1111-4111-8111-dddddddddddd';
const SESSION = 'eeeeeeee-1111-4111-8111-eeeeeeeeeeee';

if (!process.env.ZTECH_PG_URL) {
  test('[staging] the migration staging suite (skipped: no PostgreSQL is configured)', { skip: 'set ZTECH_PG_URL' }, () => {});
} else {
  const DATABASE = 'ztech_staged';
  let admin = null;
  let owner = null;
  let control = null;
  let worker = null;
  let historicalToken = null;

  test('stage a database at migrations 001 to 015, with a worker-role workspace token', async () => {
    admin = new Pool({ connectionString: URL });
    await ensureRoles(admin);
    await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${DATABASE}`);
    // Who may connect to it, and who may create objects in it: the
    // administrator's job, exactly as a deployment does it.
    await admin.query(`GRANT CONNECT ON DATABASE ${DATABASE} TO ${Object.values(ROLES).join(', ')}`);
    await admin.query(`GRANT CREATE ON DATABASE ${DATABASE} TO ${ROLES.migrator}`);
    owner = new Pool({ connectionString: roleUrl(ROLES.migrator, DATABASE), options: '-c search_path=li' });
    owner.on('error', () => {});
    await owner.query('CREATE SCHEMA IF NOT EXISTS li');
    for (const m of MIGRATIONS.filter((x) => x.version <= 15)) await owner.query(m.sql);

    // The identity, so the control plane may mint a token.
    await owner.query("INSERT INTO id.organizations (org_id, name, slug) VALUES ($1, 'S', 's') ON CONFLICT DO NOTHING", [ORG]);
    await owner.query('INSERT INTO id.workspaces (workspace_id, org_id, name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [A, ORG, 'W']);
    await owner.query("INSERT INTO id.users (user_id, email, password_hash) VALUES ($1, 's@example.invalid', 'x') ON CONFLICT DO NOTHING", [USER]);
    await owner.query(
      'INSERT INTO id.workspace_memberships (membership_id, workspace_id, user_id, role) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
      [crypto.randomUUID(), A, USER, 'owner'],
    );
    await owner.query(
      'INSERT INTO id.sessions (session_id, user_id, token_hash, csrf_hash, expires_at) VALUES ($1, $2, $3, $4, now() + interval \'1 hour\') ON CONFLICT DO NOTHING',
      [SESSION, USER, 'staged-hash', 'staged-csrf'],
    );

    // THE HISTORICAL GRANT: the identity service grants the worker role a
    // workspace, directly in the table, exactly as the pre-016 harness did.
    await owner.query(
      'INSERT INTO li.workspace_grants (role_name, workspace_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [ROLES.worker, A],
    );

    control = new Pool({ connectionString: roleUrl(ROLES.control, DATABASE), options: '-c search_path=li' });
    control.on('error', () => {});
    worker = new Pool({ connectionString: roleUrl(ROLES.worker, DATABASE), options: '-c search_path=li' });
    worker.on('error', () => {});

    // THE HISTORICAL TOKEN: under 015 the control plane may mint one for
    // the worker role, and it works.
    const minted = await control.query(
      'SELECT li.issue_workspace_token($1, $2, $3, $4, 300) AS token', [A, ROLES.worker, SESSION, USER],
    );
    historicalToken = minted.rows[0].token;
    assert.ok(historicalToken, 'the historical worker-role token was minted under the old rules');

    const client = await worker.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT li.set_workspace($1, $2)', [A, historicalToken]);
      const ws = await client.query('SELECT li.current_workspace() AS ws');
      assert.equal(ws.rows[0].ws, A, 'and under 015 it OPENS a workspace context');
      await client.query('COMMIT');
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  test('apply migration 016', async () => {
    const m016 = MIGRATIONS.find((x) => x.version === 16);
    assert.ok(m016, 'migration 016 exists');
    await owner.query(m016.sql);
  });

  test('H1: the historical workspace grant is harmless: no token may be minted from it', async () => {
    await assert.rejects(
      control.query('SELECT li.issue_workspace_token($1, $2, $3, $4, 300)', [A, ROLES.worker, SESSION, USER]),
      /worker role/i,
      'the control plane may no longer mint a worker-role token',
    );
    // The grant row is still there — it is inert, not deleted.
    const grant = await owner.query(
      'SELECT count(*)::int AS n FROM li.workspace_grants WHERE role_name = $1 AND workspace_id = $2', [ROLES.worker, A],
    );
    assert.equal(grant.rows[0].n, 1, 'the historical grant row is still present, and it is inert');
  });

  test('H3: the worker may no longer execute the workspace-context function at all', async () => {
    const may = await owner.query(
      "SELECT has_function_privilege($1, 'li.set_workspace(uuid,text)', 'EXECUTE') AS may", [ROLES.worker],
    );
    assert.equal(may.rows[0].may, false, 'the privilege is revoked');
    await assert.rejects(
      worker.query('SELECT li.set_workspace($1, $2)', [A, historicalToken]),
      /permission denied/i,
      'and the call is refused with a permission denial',
    );
  });

  test('H3 defence in depth: even with the privilege restored, the function refuses the worker role', async () => {
    // The privilege is restored ON PURPOSE, to prove the guard inside the
    // function is what refuses, and not the privilege alone.
    await owner.query('GRANT EXECUTE ON FUNCTION li.set_workspace(UUID, TEXT) TO ztech_worker');
    try {
      await assert.rejects(
        worker.query('SELECT li.set_workspace($1, $2)', [A, historicalToken]),
        /worker role may not open a workspace context/i,
        'the function itself refuses the worker role',
      );
    } finally {
      await owner.query('REVOKE EXECUTE ON FUNCTION li.set_workspace(UUID, TEXT) FROM ztech_worker');
    }
  });

  test('the historical token is unusable: it opens nothing', async () => {
    const client = await worker.connect();
    try {
      await client.query('BEGIN');
      await assert.rejects(
        client.query('SELECT li.set_workspace($1, $2)', [A, historicalToken]),
        /permission denied|worker role/i,
        'the historical token opens no context',
      );
      await client.query('ROLLBACK');
      const ws = await client.query('SELECT li.current_workspace() AS ws');
      assert.equal(ws.rows[0].ws, null, 'and the worker holds no workspace authority');
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  test('the cleanup', async () => {
    for (const p of [worker, control, owner]) if (p) await p.end().catch(() => {});
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`).catch(() => {});
      await admin.end();
    }
  });
}
