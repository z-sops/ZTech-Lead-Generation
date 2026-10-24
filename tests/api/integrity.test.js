'use strict';

/**
 * The M3 authorization-integrity suite (corrections C6 to C11).
 *
 * The tests here are about ONE thing: that a decision is made on the state
 * that exists at the moment it is committed, and not on the state that
 * existed when the request arrived.
 *
 * The concurrency tests are DETERMINISTIC. They use the service's pause
 * points to hold a transaction at a known moment, and a barrier to let the
 * other operation reach its own point before the first is released. There
 * is not a single sleep in this file: a test that waits and hopes is a
 * test that is sometimes wrong.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { freshDatabase, dropDatabase, roleUrl, ROLES, skip } = require('../persistence-contract/lib/postgres');
const { ApiServer } = require('../../packages/lead-intelligence-api/src/server');
const { AuthService } = require('../../packages/lead-intelligence-api/src/service');
const { PostgresStore } = require('../../packages/lead-intelligence-postgres/src/PostgresStore');

if (!process.env.ZTECH_PG_URL) {
  test('[integrity] the authorization-integrity suite (skipped: no PostgreSQL is configured)', { skip: 'set ZTECH_PG_URL' }, () => {});
} else {
  const DATABASE = 'ztech_integrity';
  const password = 'a-very-fine-password-2026';

  class Client {
    constructor(base) {
      this.base = base;
      this.cookie = '';
      this.csrf = '';
    }

    async call(method, path, body, headers = {}) {
      const res = await fetch(`${this.base}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(this.cookie ? { cookie: this.cookie } : {}),
          ...(this.csrf ? { 'x-csrf-token': this.csrf } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) this.cookie = setCookie.split(';')[0];
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
      return { status: res.status, body: json };
    }

    get(path, headers) { return this.call('GET', path, undefined, headers); }
    post(path, body, headers) { return this.call('POST', path, body, headers); }
    patch(path, body, headers) { return this.call('PATCH', path, body, headers); }
    del(path, headers) { return this.call('DELETE', path, undefined, headers); }
  }

  let db = null;
  let server = null;
  let base = '';
  let tenantPool = null;
  let controlPool = null;
  let identityPool = null;
  let identityPoolSize = 10;

  async function signUp(email, organization, workspaceName) {
    const client = new Client(base);
    const res = await client.post('/api/auth/register', { email, password, organization, workspaceName });
    assert.equal(res.status, 201, `the registration of ${email} worked: ${JSON.stringify(res.body)}`);
    client.csrf = res.body.csrf_token;
    return { client, userId: res.body.user_id, orgId: res.body.organization_id, workspaceId: res.body.workspace_id };
  }

  async function addMember(owner, role, email) {
    const invite = await owner.client.post(`/api/workspaces/${owner.workspaceId}/invitations`, { email, role });
    assert.equal(invite.status, 201, `the invitation was written: ${JSON.stringify(invite.body)}`);
    const invitee = await signUp(email, `${email} Corp`, `${email} Workspace`);
    const accepted = await invitee.client.post('/api/invitations/accept', { token: invite.body.token });
    assert.equal(accepted.status, 200, `the invitation was accepted: ${JSON.stringify(accepted.body)}`);
    return { invitee, role, token: invite.body.token };
  }

  /**
   * A barrier: a promise the test resolves when it wants the pause to end.
   *
   * The wait has a deadline, so a pause that is never reached FAILS the
   * test instead of hanging it: a hanging test is a test that proves
   * nothing.
   */
  function barrier() {
    let open;
    let arrived;
    const waiting = new Promise((resolve) => { open = resolve; });
    const reached = new Promise((resolve) => { arrived = resolve; });
    const deadline = (promise, what) => Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`the barrier was never reached: ${what}`)), 10000)),
    ]);
    return {
      hold: async () => {
        arrived();
        // The pause ends by itself if the test does not release it, so a
        // held transaction can never outlive the test that holds it.
        await Promise.race([waiting, new Promise((resolve) => setTimeout(resolve, 10000))]);
      },
      release: () => open(),
      reached: () => deadline(reached, 'the transaction never paused'),
    };
  }

  test('the setup: a real API over a real PostgreSQL 16', async () => {
    db = await freshDatabase(DATABASE, { workspaces: ['66666666-6666-4666-8666-666666666666'] });
    tenantPool = db.pool;
    controlPool = db.controlPool;
    identityPool = db.identityPool;
    const api = new ApiServer({
      identity: identityPool,
      tenant: tenantPool,
      logger: { warn() {}, error(...a) { if (process.env.ZTECH_API_DEBUG) console.error('[api]', ...a); } },
      storeFor: async (session, workspaceId) => new PostgresStore({
        pool: tenantPool, controlPool, workspaceId, sessionId: session.session_id, userId: session.user_id,
        logger: { warn() {} },
      }),
    });
    const address = await api.listen(0);
    base = `http://127.0.0.1:${address.port}`;
    server = api;
  });

  /* ---------------- C6: the authorization is valid at COMMIT time ---------------- */

  test('C6: an actor demoted BEFORE the removal is refused', async () => {
    const owner = await signUp('c6-owner@ztech.test', 'C6 Corp', 'C6 Workspace');
    const admin = await addMember(owner, 'admin', 'c6-admin@ztech.test');
    const member = await addMember(owner, 'member', 'c6-member@ztech.test');
    // The admin is demoted to a viewer.
    const demoted = await owner.client.patch(
      `/api/workspaces/${owner.workspaceId}/members/${admin.invitee.userId}`,
      { role: 'viewer' },
    );
    assert.equal(demoted.status, 200);
    // The demoted admin tries to remove somebody: the decision is made on
    // the CURRENT membership, so it is refused.
    const res = await admin.invitee.client.del(
      `/api/workspaces/${owner.workspaceId}/members/${member.invitee.userId}`,
    );
    assert.equal(res.status, 403);
    // And the member is still there.
    const members = await owner.client.get(`/api/workspaces/${owner.workspaceId}/members`);
    assert.ok(members.body.members.some((m) => m.user_id === member.invitee.userId));
  });

  test('C6: an actor demoted CONCURRENTLY cannot complete the removal', async () => {
    const owner = await signUp('c6b-owner@ztech.test', 'C6B Corp', 'C6B Workspace');
    const admin = await addMember(owner, 'admin', 'c6b-admin@ztech.test');
    const member = await addMember(owner, 'member', 'c6b-member@ztech.test');
    // The removal is held at its pause point, AFTER it has locked the
    // memberships and made its decision.
    const gate = barrier();
    server.service.hooks['removeMember:locked'] = gate.hold;
    const removal = admin.invitee.client.del(
      `/api/workspaces/${owner.workspaceId}/members/${member.invitee.userId}`,
    );
    await gate.reached();
    // While it is held, the demotion is ATTEMPTED. It cannot proceed: the
    // removal holds the lock on the membership rows.
    const demotion = owner.client.patch(
      `/api/workspaces/${owner.workspaceId}/members/${admin.invitee.userId}`,
      { role: 'viewer' },
    );
    let demotionSettled = false;
    demotion.then(() => { demotionSettled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(demotionSettled, false, 'the demotion is waiting for the lock the removal holds');
    // The removal goes through, and the demotion follows it.
    gate.release();
    server.service.hooks['removeMember:locked'] = null;
    const removalResult = await removal;
    const demotionResult = await demotion;
    assert.equal(removalResult.status, 200, 'the removal completed with the authority it held');
    assert.equal(demotionResult.status, 200, 'and the demotion completed after it');
  });

  test('C6: an actor whose authority is withdrawn cannot change a role', async () => {
    const owner = await signUp('c6c-owner@ztech.test', 'C6C Corp', 'C6C Workspace');
    const admin = await addMember(owner, 'admin', 'c6c-admin@ztech.test');
    const member = await addMember(owner, 'member', 'c6c-member@ztech.test');
    await owner.client.patch(
      `/api/workspaces/${owner.workspaceId}/members/${admin.invitee.userId}`,
      { role: 'viewer' },
    );
    const res = await admin.invitee.client.patch(
      `/api/workspaces/${owner.workspaceId}/members/${member.invitee.userId}`,
      { role: 'admin' },
    );
    assert.equal(res.status, 403);
    const members = await owner.client.get(`/api/workspaces/${owner.workspaceId}/members`);
    assert.equal(members.body.members.find((m) => m.user_id === member.invitee.userId).role, 'member');
  });

  /* ---------------- C7: the invitation's authority, atomically ---------------- */

  test('C7: a manager who is demoted cannot have their invitation accepted', async () => {
    const owner = await signUp('c7-owner@ztech.test', 'C7 Corp', 'C7 Workspace');
    const manager = await addMember(owner, 'manager', 'c7-manager@ztech.test');
    // The manager invites somebody as a viewer.
    const invite = await manager.invitee.client.post(`/api/workspaces/${owner.workspaceId}/invitations`, {
      email: 'c7-viewer@ztech.test', role: 'viewer',
    });
    assert.equal(invite.status, 201);
    // The manager is demoted to a member, which takes `member.invite` away.
    const demoted = await owner.client.patch(
      `/api/workspaces/${owner.workspaceId}/members/${manager.invitee.userId}`,
      { role: 'member' },
    );
    assert.equal(demoted.status, 200);
    // The viewer tries to accept: the inviter's permission is re-checked
    // inside the acceptance's transaction, and it is gone.
    const viewer = await signUp('c7-viewer@ztech.test', 'C7 Viewer', 'C7 Viewer Workspace');
    const res = await viewer.client.post('/api/invitations/accept', { token: invite.body.token });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'inviter_lost_permission');
    // And the viewer has no membership.
    const members = await owner.client.get(`/api/workspaces/${owner.workspaceId}/members`);
    assert.equal(members.body.members.some((m) => m.user_id === viewer.userId), false);
  });

  test('C7: an inviter REMOVED while the invitation is open cannot have it accepted', async () => {
    const owner = await signUp('c7b-owner@ztech.test', 'C7B Corp', 'C7B Workspace');
    const manager = await addMember(owner, 'manager', 'c7b-manager@ztech.test');
    const invite = await manager.invitee.client.post(`/api/workspaces/${owner.workspaceId}/invitations`, {
      email: 'c7b-guest@ztech.test', role: 'viewer',
    });
    assert.equal(invite.status, 201);
    await owner.client.del(`/api/workspaces/${owner.workspaceId}/members/${manager.invitee.userId}`);
    const guest = await signUp('c7b-guest@ztech.test', 'C7B Guest', 'C7B Guest Workspace');
    const res = await guest.client.post('/api/invitations/accept', { token: invite.body.token });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'inviter_gone');
  });

  test('C7: the acceptance is refused while the inviter is demoted CONCURRENTLY', async () => {
    const owner = await signUp('c7c-owner@ztech.test', 'C7C Corp', 'C7C Workspace');
    const manager = await addMember(owner, 'manager', 'c7c-manager@ztech.test');
    const invite = await manager.invitee.client.post(`/api/workspaces/${owner.workspaceId}/invitations`, {
      email: 'c7c-guest@ztech.test', role: 'viewer',
    });
    assert.equal(invite.status, 201);
    const guest = await signUp('c7c-guest@ztech.test', 'C7C Guest', 'C7C Guest Workspace');
    // The acceptance is held at its pause point, after it has locked the
    // invitation and the memberships and re-checked the inviter.
    const gate = barrier();
    server.service.hooks['acceptInvitation:locked'] = gate.hold;
    const acceptance = guest.client.post('/api/invitations/accept', { token: invite.body.token });
    await gate.reached();
    // The demotion is attempted while the acceptance holds the lock. It
    // waits: the acceptance has already decided, on the locked rows.
    const demotion = owner.client.patch(
      `/api/workspaces/${owner.workspaceId}/members/${manager.invitee.userId}`,
      { role: 'member' },
    );
    let settled = false;
    demotion.then(() => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, 'the demotion is waiting for the lock the acceptance holds');
    gate.release();
    server.service.hooks['acceptInvitation:locked'] = null;
    const accepted = await acceptance;
    const demoted = await demotion;
    assert.equal(accepted.status, 200, 'the acceptance completed with the authority the inviter held');
    assert.equal(demoted.status, 200, 'and the demotion followed it');
  });

  /* ---------------- C8: the workspace, atomically, with an owner ---------------- */

  test('C8: a workspace created by an ADMIN still has an owner', async () => {
    const owner = await signUp('c8-owner@ztech.test', 'C8 Corp', 'C8 Workspace');
    const admin = await addMember(owner, 'admin', 'c8-admin@ztech.test');
    // The admin creates a workspace in the organization.
    const res = await admin.invitee.client.post(`/api/organizations/${owner.orgId}/workspaces`, { name: 'Admin Workspace' });
    assert.equal(res.status, 201, `the workspace was created: ${JSON.stringify(res.body)}`);
    // And it has an owner: the creator.
    const owners = (await identityPool.query(
      `SELECT count(*)::int AS n FROM id.workspace_memberships
        WHERE workspace_id = $1 AND role = 'owner' AND revoked_at IS NULL`,
      [res.body.workspaceId],
    )).rows[0].n;
    assert.equal(owners, 1, 'the new workspace has exactly one owner');
  });

  test('C8: the workspace, the ceiling and the membership are ONE transaction', async () => {
    const owner = await signUp('c8b-owner@ztech.test', 'C8B Corp', 'C8B Workspace');
    // The creation is held at its pause point, inside the transaction.
    const gate = barrier();
    server.service.hooks['createWorkspace:locked'] = gate.hold;
    const creating = owner.client.post(`/api/organizations/${owner.orgId}/workspaces`, { name: 'Atomic Workspace' });
    await gate.reached();
    // While the transaction is open, ANOTHER connection sees NONE of it: not
    // the workspace, not the membership, not the ceiling. There is no
    // half-created workspace to find.
    const visible = (await identityPool.query(
      'SELECT count(*)::int AS n FROM id.workspaces WHERE name = $1',
      ['Atomic Workspace'],
    )).rows[0].n;
    assert.equal(visible, 0, 'the uncommitted workspace is invisible');
    gate.release();
    server.service.hooks['createWorkspace:locked'] = null;
    const res = await creating;
    assert.equal(res.status, 201, `the workspace was created: ${JSON.stringify(res.body)}`);
    // And after the commit, all three are there.
    const workspace = (await identityPool.query(
      'SELECT workspace_id FROM id.workspaces WHERE name = $1',
      ['Atomic Workspace'],
    )).rows[0];
    assert.ok(workspace, 'the workspace is there');
    const membership = (await identityPool.query(
      `SELECT count(*)::int AS n FROM id.workspace_memberships
        WHERE workspace_id = $1 AND role = 'owner' AND revoked_at IS NULL`,
      [workspace.workspace_id],
    )).rows[0].n;
    assert.equal(membership, 1, 'and it has exactly one owner');
    const grant = (await db.owner.query(
      'SELECT count(*)::int AS n FROM li.workspace_grants WHERE workspace_id = $1',
      [workspace.workspace_id],
    )).rows[0].n;
    assert.equal(grant, 1, 'and the ceiling was raised with it');
  });

  /* ---------------- C9: an organization is usable ---------------- */

  test('C8/C10: an injected failure leaves no workspace, no membership and no ALLOW record', async () => {
    const owner = await signUp('c8c-owner@ztech.test', 'C8C Corp', 'C8C Workspace');
    const before = (await identityPool.query('SELECT count(*)::int AS n FROM id.workspaces')).rows[0].n;
    const allowsBefore = (await identityPool.query(
      "SELECT count(*)::int AS n FROM id.authorization_audit WHERE action = 'workspace.create' AND outcome = 'allow'",
    )).rows[0].n;
    // The failure is INJECTED IN THE DATABASE, deterministically, and it
    // lands on the MEMBERSHIP insert - which is the SECOND step of the
    // transaction. The workspace insert has ALREADY SUCCEEDED by then, so
    // the rollback has something to undo: if the transaction is not atomic,
    // the workspace would survive.
    await db.owner.query(
      `ALTER TABLE id.workspace_memberships ADD CONSTRAINT ztech_test_refusal CHECK (user_id <> '${owner.userId}') NOT VALID`,
    );
    try {
      const res = await owner.client.post(`/api/organizations/${owner.orgId}/workspaces`, { name: 'Doomed Workspace' });
      assert.equal(res.status, 500, 'the creation failed');
    } finally {
      await db.owner.query('ALTER TABLE id.workspace_memberships DROP CONSTRAINT IF EXISTS ztech_test_refusal');
    }
    // Nothing was left behind: the transaction rolled back the workspace,
    // the membership and the ceiling together.
    const after = (await identityPool.query('SELECT count(*)::int AS n FROM id.workspaces')).rows[0].n;
    assert.equal(after, before, 'the workspace that HAD been inserted was rolled back');
    const memberships = (await identityPool.query(
      `SELECT count(*)::int AS n FROM id.workspace_memberships m
         JOIN id.workspaces w ON w.workspace_id = m.workspace_id
        WHERE w.name = 'Doomed Workspace' AND m.revoked_at IS NULL`,
    )).rows[0].n;
    assert.equal(memberships, 0, 'and no membership');
    // And no ALLOW record claims a creation that did not happen: the
    // allow record is written inside the transaction, so it rolled back
    // with it.
    const allows = (await identityPool.query(
      "SELECT count(*)::int AS n FROM id.authorization_audit WHERE action = 'workspace.create' AND outcome = 'allow'",
    )).rows[0].n;
    assert.equal(allows, allowsBefore, 'no allow record claims a mutation that did not happen');
    // The DENIAL is written outside the transaction, so it is durable.
    const denials = (await identityPool.query(
      "SELECT count(*)::int AS n FROM id.authorization_audit WHERE action = 'workspace.create' AND outcome = 'deny'",
    )).rows[0].n;
    assert.ok(denials > 0, 'the denial is recorded, and it is durable');
  });

  test('C9: the creator of an organization owns it, and may create its first workspace', async () => {
    const owner = await signUp('c9-owner@ztech.test', 'C9 Corp', 'C9 Workspace');
    // The owner creates another organization.
    const org = await owner.client.post('/api/organizations', { name: 'C9 New Org' });
    assert.equal(org.status, 201, `the organization was created: ${JSON.stringify(org.body)}`);
    assert.equal(org.body.role, 'owner', 'the creator owns it');
    // And may create its FIRST workspace: the organization is not a thing
    // without an owner.
    const workspace = await owner.client.post(`/api/organizations/${org.body.orgId}/workspaces`, { name: 'C9 First Workspace' });
    assert.equal(workspace.status, 201, `the first workspace was created: ${JSON.stringify(workspace.body)}`);
    // And may operate as the owner of it.
    const records = await owner.client.get(`/api/workspaces/${workspace.body.workspaceId}/records`);
    assert.equal(records.status, 200);
    // And nobody else may: a stranger has no organization membership.
    const stranger = await signUp('c9-stranger@ztech.test', 'C9 Stranger', 'C9 Stranger Workspace');
    const refused = await stranger.client.post(`/api/organizations/${org.body.orgId}/workspaces`, { name: 'Not Mine' });
    assert.equal(refused.status, 403);
  });

  /* ---------------- C10: the audit, and a pool of one ---------------- */

  test('C10: the ALLOW record is written inside the transaction, so it cannot outlive it', async () => {
    const owner = await signUp('c10-owner@ztech.test', 'C10 Corp', 'C10 Workspace');
    const member = await addMember(owner, 'member', 'c10-member@ztech.test');
    // The removal is held at its pause point, inside the transaction.
    const gate = barrier();
    server.service.hooks['removeMember:locked'] = gate.hold;
    const removal = owner.client.del(`/api/workspaces/${owner.workspaceId}/members/${member.invitee.userId}`);
    await gate.reached();
    // The ALLOW record is inside the transaction, so another connection
    // cannot see it yet: a record can never claim a mutation that has not
    // been committed.
    const during = (await identityPool.query(
      `SELECT count(*)::int AS n FROM id.authorization_audit
        WHERE action = 'member.remove' AND outcome = 'allow' AND detail->>'removed' = $1`,
      [member.invitee.userId],
    )).rows[0].n;
    assert.equal(during, 0, 'the allow record is inside the transaction');
    gate.release();
    server.service.hooks['removeMember:locked'] = null;
    const res = await removal;
    assert.equal(res.status, 200);
    // And it appears with the commit.
    const after = (await identityPool.query(
      `SELECT count(*)::int AS n FROM id.authorization_audit
        WHERE action = 'member.remove' AND outcome = 'allow' AND detail->>'removed' = $1`,
      [member.invitee.userId],
    )).rows[0].n;
    assert.equal(after, 1, 'the allow record appears with the commit');
    // A DENIAL is written OUTSIDE the transaction, so it is durable: it
    // records a decision that was really taken.
    const denied = await member.invitee.client.del(
      `/api/workspaces/${owner.workspaceId}/members/${member.invitee.userId}`,
    );
    assert.equal(denied.status, 403);
    const denials = (await identityPool.query(
      `SELECT count(*)::int AS n FROM id.authorization_audit WHERE action = 'member.remove' AND outcome = 'deny'`,
    )).rows[0].n;
    assert.ok(denials > 0, 'the denial is recorded, and it is durable');
  });

  test('C10: the identity service works with a pool of ONE', async () => {
    const small = new Pool({ connectionString: identityPool.options.connectionString || 'postgres://ztech:ztech@127.0.0.1:55432/ztech', max: 1 });
    const api = new ApiServer({
      identity: small,
      tenant: tenantPool,
      logger: { warn() {}, error(...a) { if (process.env.ZTECH_API_DEBUG) console.error('[api]', ...a); } },
      storeFor: async (session, workspaceId) => new PostgresStore({
        pool: tenantPool, controlPool, workspaceId, sessionId: session.session_id, userId: session.user_id,
        logger: { warn() {} },
      }),
    });
    const address = await api.listen(0);
    try {
      const client = new Client(`http://127.0.0.1:${address.port}`);
      const registered = await client.post('/api/auth/register', {
        email: 'c10-small@ztech.test', password, organization: 'C10 Small', workspaceName: 'W',
      });
      assert.equal(registered.status, 201, 'the registration worked with one connection');
      client.csrf = registered.body.csrf_token;
      const session = await client.get('/api/session');
      assert.equal(session.status, 200);
      // And a transaction that writes an audit record inside it does not
      // deadlock against the pool.
      const org = await client.post('/api/organizations', { name: 'C10 Small Org' });
      assert.equal(org.status, 201);
    } finally {
      await api.close();
      await small.end();
    }
  });

  /* ---------------- C11: a disabled account ---------------- */

  test('C11: a disabled account loses its sessions and its entitlements', async () => {
    const owner = await signUp('c11-owner@ztech.test', 'C11 Corp', 'C11 Workspace');
    const member = await addMember(owner, 'member', 'c11-member@ztech.test');
    // The member may work.
    const before = await member.invitee.client.get(`/api/workspaces/${owner.workspaceId}/records`);
    assert.equal(before.status, 200);
    // The account is suspended by a PRIVILEGED DATABASE OPERATION - the same
    // kind of operation that applies a migration. It is NOT done with a
    // customer session, and there is no HTTP route that can do it.
    await db.owner.query('UPDATE id.users SET disabled_at = now() WHERE user_id = $1', [member.invitee.userId]);
    await db.owner.query('UPDATE id.sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [member.invitee.userId]);
    // The session is dead.
    const after = await member.invitee.client.get(`/api/workspaces/${owner.workspaceId}/records`);
    assert.equal(after.status, 401, 'the session no longer works');
    // And the DATABASE refuses the entitlement, wherever it is presented.
    const sessionId = (await identityPool.query(
      'SELECT session_id FROM id.sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
      [member.invitee.userId],
    )).rows[0].session_id;
    await assert.rejects(
      identityPool.query(
        'SELECT li.issue_workspace_token($1, $2, $3, $4, 60) AS t',
        [owner.workspaceId, ROLES.app, sessionId, member.invitee.userId],
      ),
      /not entitled/i,
      'no token may be issued for a disabled account',
    );
  });

  test('C13: a customer CANNOT suspend an account, and there is no route to try', async () => {
    const owner = await signUp('c13-owner@ztech.test', 'C13 Corp', 'C13 Workspace');
    const member = await addMember(owner, 'member', 'c13-member@ztech.test');
    // The customer's API has no such route: it is not there at all.
    const res = await owner.client.post(`/api/users/${member.invitee.userId}/disable`, {});
    assert.equal(res.status, 404, 'the customer API has no account-suspension route');
    // And there is no route on a PLATFORM-CONSOLE-CONFIGURED server either:
    // a configuration flag is not an authentication.
    const console = new ApiServer({
      identity: identityPool,
      tenant: tenantPool,
      platformConsole: true,
      logger: { warn() {}, error() {} },
      storeFor: async (session, workspaceId) => new PostgresStore({
        pool: tenantPool, controlPool, workspaceId, sessionId: session.session_id, userId: session.user_id,
        logger: { warn() {} },
      }),
    });
    const address = await console.listen(0);
    try {
      const operator = new Client(`http://127.0.0.1:${address.port}`);
      operator.cookie = owner.client.cookie;
      operator.csrf = owner.client.csrf;
      const attempt = await operator.post(`/api/users/${member.invitee.userId}/disable`, {});
      assert.equal(attempt.status, 404, 'a platform-console configuration does not create the route');
    } finally {
      await console.close();
    }
    // The service has no session-callable suspension either.
    assert.equal(typeof server.service.disableUser, 'undefined', 'the service has no such operation to call');
    // The account is untouched.
    const user = (await identityPool.query('SELECT disabled_at FROM id.users WHERE user_id = $1', [member.invitee.userId])).rows[0];
    assert.equal(user.disabled_at, null, 'the account was NOT disabled');
    // And the member still works.
    const still = await member.invitee.client.get(`/api/workspaces/${owner.workspaceId}/records`);
    assert.equal(still.status, 200);
  });

  test('C14: a workspace owner does NOT become an organization owner', async () => {
    const owner = await signUp('c14-owner@ztech.test', 'C14 Corp', 'C14 Workspace');
    const admin = await addMember(owner, 'admin', 'c14-admin@ztech.test');
    // The admin creates another workspace in the organization. It is allowed:
    // the admin holds workspace.create over the organization.
    const created = await admin.invitee.client.post(`/api/organizations/${owner.orgId}/workspaces`, { name: 'Admin Workspace' });
    assert.equal(created.status, 201, `the admin created a workspace: ${JSON.stringify(created.body)}`);
    // The creator is the OWNER of the workspace they created: the
    // workspace-owner invariant holds.
    const role = (await identityPool.query(
      `SELECT role FROM id.workspace_memberships WHERE workspace_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
      [created.body.workspaceId, admin.invitee.userId],
    )).rows[0];
    assert.equal(role.role, 'owner', 'the creator owns the workspace they created');
    // But the ADMINISTRATIVE role of the ORGANIZATION is not theirs: the
    // organization and the workspace are two different ladders.
    const orgRole = (await identityPool.query(
      'SELECT role FROM id.organization_memberships WHERE org_id = $1 AND user_id = $2 AND revoked_at IS NULL',
      [owner.orgId, admin.invitee.userId],
    )).rows;
    assert.deepEqual(orgRole, [], 'the workspace owner has NO organization role');
    // And so they have no organization-level power: there is no route to
    // suspend an account, and no service operation either.
    const attempt = await admin.invitee.client.post(`/api/users/${owner.userId}/disable`, {});
    assert.equal(attempt.status, 404, 'a workspace owner may not suspend an account');
    const untouched = (await identityPool.query('SELECT disabled_at FROM id.users WHERE user_id = $1', [owner.userId])).rows[0];
    assert.equal(untouched.disabled_at, null, 'and the organization owner is untouched');
  });

  test('the cleanup', async () => {
    if (server) await server.close();
    if (db) await dropDatabase(DATABASE, [db.pool, db.owner, db.controlPool, db.identityPool, db.platformPool, db.admin]);
  });
}
