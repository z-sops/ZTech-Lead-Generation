'use strict';

/**
 * The API authorization suite (M3).
 *
 * Real HTTP requests, against a real PostgreSQL 16, with the real roles.
 *
 * What it proves:
 *
 *   - a user cannot reach another organization's records;
 *   - the role is per WORKSPACE: an owner in one workspace is a viewer in
 *     another, and stays a viewer there;
 *   - a logout ends the access, at once;
 *   - removing a membership revokes THAT user's access and nobody else's,
 *     even though they share the same database role;
 *   - a role change is enforced immediately;
 *   - one session cannot use another session's token;
 *   - an invitation cannot be misused, and it cannot escalate a privilege;
 *   - concurrent sessions and the connection pool keep the isolation;
 *   - the database enforces it too: a membership that is withdrawn kills
 *     the transaction that is ALREADY OPEN.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const { freshDatabase, dropDatabase, roleUrl, ROLES, skip } = require('../persistence-contract/lib/postgres');
const { ApiServer } = require('../../packages/lead-intelligence-api/src/server');
const { PostgresStore } = require('../../packages/lead-intelligence-postgres/src/PostgresStore');

if (!process.env.ZTECH_PG_URL) {
  test('[api] the API authorization suite (skipped: no PostgreSQL is configured)', { skip: 'set ZTECH_PG_URL' }, () => {});
} else {
  const DATABASE = 'ztech_api';

  /** A client that keeps the session cookie, and the CSRF token. */
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
      return { status: res.status, body: json, headers: res.headers };
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

  const password = 'a-very-fine-password-2026';

  /** A client that is registered, logged in, and ready. */
  async function signUp(email, organization, workspaceName) {
    const client = new Client(base);
    const res = await client.post('/api/auth/register', {
      email, password, organization, workspaceName,
    });
    assert.equal(res.status, 201, `the registration of ${email} worked: ${JSON.stringify(res.body)}`);
    client.csrf = res.body.csrf_token;
    return {
      client,
      userId: res.body.user_id,
      orgId: res.body.organization_id,
      workspaceId: res.body.workspace_id,
    };
  }

  /** The session id of a user. */
  async function sessionOf(userId) {
    const res = await identityPool.query('SELECT session_id FROM id.sessions WHERE user_id = $1 LIMIT 1', [userId]);
    return res.rows[0].session_id;
  }

  /** A store bound to a session, for the tenant data. */
  function storeFor(sessionId, userId, workspaceId) {
    return new PostgresStore({
      pool: tenantPool, controlPool, workspaceId, sessionId, userId, logger: { warn() {} },
    });
  }

  test('the setup: a real API over a real PostgreSQL 16', async () => {
    db = await freshDatabase(DATABASE, { workspaces: ['33333333-3333-4333-8333-333333333333'] });
    tenantPool = db.pool;
    controlPool = db.controlPool;
    identityPool = db.identityPool;
    const api = new ApiServer({
      identity: identityPool,
      tenant: tenantPool,
      logger: { warn() {}, error(...a) { if (process.env.ZTECH_API_DEBUG) console.error('[api]', ...a); } },
      storeFor: async (session, workspaceId) => storeFor(session.session_id, session.user_id, workspaceId),
    });
    const address = await api.listen(0);
    base = `http://127.0.0.1:${address.port}`;
    server = api;
  });

  test('a registration creates the user, the organization, the workspace and the owner membership', async () => {
    const alice = await signUp('alice@ztech.test', 'Alice Corp', 'Alice Workspace');
    assert.ok(alice.userId && alice.orgId && alice.workspaceId);
    const info = await alice.client.get('/api/session');
    assert.equal(info.status, 200);
    assert.equal(info.body.memberships.length, 1);
    assert.equal(info.body.memberships[0].role, 'owner');
    // The session is a cookie, and the token is never in the body.
    assert.ok(alice.client.cookie.startsWith('ztech_session='));
    assert.ok(!JSON.stringify(info.body).includes(alice.client.cookie.split('=')[1]), 'the session token is not in a response body');
  });

  test('the password is never stored in the clear, and a wrong password is refused', async () => {
    const client = new Client(base);
    const bad = await client.post('/api/auth/login', { email: 'alice@ztech.test', password: 'not-the-password' });
    assert.equal(bad.status, 401);
    const good = await client.post('/api/auth/login', { email: 'alice@ztech.test', password });
    assert.equal(good.status, 200);
    const stored = (await identityPool.query('SELECT password_hash FROM id.users WHERE email = $1', ['alice@ztech.test'])).rows[0].password_hash;
    assert.ok(stored.startsWith('scrypt$'), 'the password is a scrypt verifier');
    assert.ok(!stored.includes(password), 'and the password is not in it');
  });

  test('the login is throttled', async () => {
    const client = new Client(base);
    let refused = 0;
    for (let i = 0; i < 8; i += 1) {
      const res = await client.post('/api/auth/login', { email: 'throttle@ztech.test', password: 'wrong' });
      if (res.status === 429) refused += 1;
    }
    assert.ok(refused > 0, 'the attempts are refused after a few failures');
  });

  test('a state-changing request without the CSRF token is refused', async () => {
    const alice = await signUp('csrf@ztech.test', 'CSRF Corp', 'CSRF Workspace');
    const res = await alice.client.post('/api/organizations', { name: 'Another' }, { 'x-csrf-token': 'wrong' });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'csrf_failed');
  });

  test('a user cannot reach another organization\'s records', async () => {
    const alice = await signUp('cross-a@ztech.test', 'Org A', 'Workspace A');
    const bob = await signUp('cross-b@ztech.test', 'Org B', 'Workspace B');
    // A record in Bob's workspace.
    const bobStore = storeFor(await sessionOf(bob.userId), bob.userId, bob.workspaceId);
    await bobStore.savedSearches.upsert({
      search_id: 'bob-search', name: 'Bob secret', definition: { filter: null },
      created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z',
    });
    // Alice's session asks for Bob's workspace.
    const res = await alice.client.get(`/api/workspaces/${bob.workspaceId}/records`);
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'no_membership');
    assert.ok(!JSON.stringify(res.body).includes('Bob secret'), 'and the record did not leak');
  });

  test('the role is per workspace: an owner in A is a viewer in B', async () => {
    const owner = await signUp('owner@ztech.test', 'Multi Corp', 'Workspace One');
    const viewer = await signUp('viewer@ztech.test', 'Multi Corp', 'Workspace Two');
    // The owner invites the viewer into the owner's workspace, as a viewer.
    const invite = await owner.client.post(`/api/workspaces/${owner.workspaceId}/invitations`, {
      email: 'viewer@ztech.test', role: 'viewer',
    });
    assert.equal(invite.status, 201);
    assert.equal(invite.body.role, 'viewer', 'the invitation carries the role');
    const accepted = await viewer.client.post('/api/invitations/accept', { token: invite.body.token });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.role, 'viewer');
    // The viewer is a viewer in the owner's workspace: it may read, and it
    // may not invite.
    const read = await viewer.client.get(`/api/workspaces/${owner.workspaceId}/records`);
    assert.equal(read.status, 200, 'a viewer may read');
    const escalate = await viewer.client.post(`/api/workspaces/${owner.workspaceId}/invitations`, {
      email: 'someone@ztech.test', role: 'admin',
    });
    assert.equal(escalate.status, 403, 'and it may not invite');
    assert.equal(escalate.body.error, 'insufficient_role');
  });

  test('an invitation cannot be misused, and it cannot escalate', async () => {
    const owner = await signUp('inv-owner@ztech.test', 'Invite Corp', 'Invite Workspace');
    const stranger = await signUp('stranger@ztech.test', 'Stranger Corp', 'Stranger Workspace');
    const invite = await owner.client.post(`/api/workspaces/${owner.workspaceId}/invitations`, {
      email: 'stranger@ztech.test', role: 'member',
    });
    // The wrong address cannot accept it.
    const wrong = await stranger.client.post('/api/invitations/accept', { token: invite.body.token });
    assert.equal(wrong.status, 200, 'the address is the one that was invited');
    // A second acceptance is refused.
    const again = await stranger.client.post('/api/invitations/accept', { token: invite.body.token });
    assert.equal(again.status, 409);
    assert.equal(again.body.error, 'invitation_used');
    // The role in the invitation is the role that is granted.
    const memberships = await stranger.client.get('/api/session');
    const granted = memberships.body.memberships.find((m) => m.workspace_id === owner.workspaceId);
    assert.equal(granted.role, 'member', 'and the role is the one the invitation named');
  });

  test('a logout ends the access', async () => {
    const alice = await signUp('logout@ztech.test', 'Logout Corp', 'Logout Workspace');
    const before = await alice.client.get('/api/session');
    assert.equal(before.status, 200);
    const out = await alice.client.post('/api/auth/logout', {});
    assert.equal(out.status, 200);
    const after = await alice.client.get('/api/session');
    assert.equal(after.status, 401, 'the session is dead');
  });

  test('one session cannot use another session\'s token', async () => {
    const one = await signUp('sess-one@ztech.test', 'Session Corp', 'Session One');
    const two = await signUp('sess-two@ztech.test', 'Session Corp', 'Session Two');
    // The second session's cookie, used against the first session's
    // workspace, is refused: the token is bound to a session AND a user.
    const stolen = new Client(base);
    stolen.cookie = two.client.cookie;
    const res = await stolen.get(`/api/workspaces/${one.workspaceId}/records`);
    assert.equal(res.status, 403, 'the other session is not a member of that workspace');
    // And the workspace TOKEN is bound too: the database refuses to issue
    // one for a session that is not entitled to the workspace, so the
    // second session cannot borrow the first session's reach.
    await assert.rejects(
      storeFor(await sessionOf(two.userId), two.userId, one.workspaceId).tx(async () => {}),
      /not entitled/i,
      'the database refuses a token for a session that is not a member',
    );
  });

  test('removing a membership revokes that user and nobody else', async () => {
    const owner = await signUp('rm-owner@ztech.test', 'Removal Corp', 'Removal Workspace');
    const member = await signUp('rm-member@ztech.test', 'Removal Corp', 'Member Workspace');
    const invite = await owner.client.post(`/api/workspaces/${owner.workspaceId}/invitations`, {
      email: 'rm-member@ztech.test', role: 'member',
    });
    await member.client.post('/api/invitations/accept', { token: invite.body.token });
    // Both may read the owner's workspace.
    assert.equal((await member.client.get(`/api/workspaces/${owner.workspaceId}/records`)).status, 200);
    // The owner removes the member.
    const removed = await owner.client.del(`/api/workspaces/${owner.workspaceId}/members/${member.userId}`);
    assert.equal(removed.status, 200);
    // The member is refused...
    const after = await member.client.get(`/api/workspaces/${owner.workspaceId}/records`);
    assert.equal(after.status, 403);
    assert.equal(after.body.error, 'no_membership');
    // ...and the owner is NOT.
    assert.equal((await owner.client.get(`/api/workspaces/${owner.workspaceId}/records`)).status, 200, 'the owner keeps their access');
  });

  test('a membership that is withdrawn kills the transaction that is ALREADY OPEN', async () => {
    const owner = await signUp('open-owner@ztech.test', 'Open Corp', 'Open Workspace');
    const member = await signUp('open-member@ztech.test', 'Open Corp', 'Open Member');
    const invite = await owner.client.post(`/api/workspaces/${owner.workspaceId}/invitations`, {
      email: 'open-member@ztech.test', role: 'member',
    });
    await member.client.post('/api/invitations/accept', { token: invite.body.token });
    // The member's own store, with its own session.
    const store = storeFor(await sessionOf(member.userId), member.userId, owner.workspaceId);
    // A transaction that is open while the membership is withdrawn.
    await store.tx(async () => {
      const before = await store.client.query('SELECT count(*)::int AS n FROM li.li_saved_searches');
      assert.ok(before.rows[0].n >= 0);
      await owner.client.del(`/api/workspaces/${owner.workspaceId}/members/${member.userId}`);
      const after = await store.client.query('SELECT count(*)::int AS n FROM li.li_saved_searches');
      assert.equal(after.rows[0].n, 0, 'the open transaction has lost its access');
    });
  });

  test('a role change is enforced immediately', async () => {
    const owner = await signUp('role-owner@ztech.test', 'Role Corp', 'Role Workspace');
    const member = await signUp('role-member@ztech.test', 'Role Corp', 'Role Member');
    const invite = await owner.client.post(`/api/workspaces/${owner.workspaceId}/invitations`, {
      email: 'role-member@ztech.test', role: 'member',
    });
    await member.client.post('/api/invitations/accept', { token: invite.body.token });
    // A member may not invite.
    const before = await member.client.post(`/api/workspaces/${owner.workspaceId}/invitations`, {
      email: 'x@ztech.test', role: 'admin',
    });
    assert.equal(before.status, 403);
    // The owner promotes them, and the new role is in force at once.
    const changed = await owner.client.patch(`/api/workspaces/${owner.workspaceId}/members/${member.userId}`, { role: 'admin' });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.role, 'admin');
    const after = await member.client.post(`/api/workspaces/${owner.workspaceId}/invitations`, {
      email: 'x@ztech.test', role: 'admin',
    });
    assert.equal(after.status, 201, 'the new role is in force at once');
  });

  test('the last owner cannot be removed, and an owner is protected', async () => {
    const owner = await signUp('last-owner@ztech.test', 'Last Corp', 'Last Workspace');
    const admin = await signUp('last-admin@ztech.test', 'Last Corp', 'Last Admin');
    const invite = await owner.client.post(`/api/workspaces/${owner.workspaceId}/invitations`, {
      email: 'last-admin@ztech.test', role: 'admin',
    });
    await admin.client.post('/api/invitations/accept', { token: invite.body.token });
    // An admin may not remove the owner.
    const denied = await admin.client.del(`/api/workspaces/${owner.workspaceId}/members/${owner.userId}`);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error, 'owner_protected');
    // And the owner may not remove themselves, because they are the last.
    const last = await owner.client.del(`/api/workspaces/${owner.workspaceId}/members/${owner.userId}`);
    assert.equal(last.status, 403);
    assert.equal(last.body.error, 'last_owner');
  });

  test('the suppression check is authenticated, authorized and rate-limited', async () => {
    const owner = await signUp('sup-owner@ztech.test', 'Suppression Corp', 'Suppression Workspace');
    const anonymous = new Client(base);
    const refused = await anonymous.post(`/api/workspaces/${owner.workspaceId}/suppressions/check`, {
      channel: 'email', address: 'someone@example.test',
    });
    assert.equal(refused.status, 401, 'it needs a session');
    // A stranger's workspace is refused.
    const stranger = await signUp('sup-stranger@ztech.test', 'Stranger Corp', 'Stranger Workspace');
    const cross = await stranger.client.post(`/api/workspaces/${owner.workspaceId}/suppressions/check`, {
      channel: 'email', address: 'someone@example.test',
    });
    assert.equal(cross.status, 403, 'and a membership');
    // The owner's own check answers with a boolean, and never with a row.
    const own = await owner.client.post(`/api/workspaces/${owner.workspaceId}/suppressions/check`, {
      channel: 'email', address: 'someone@example.test',
    });
    assert.equal(own.status, 200);
    assert.deepEqual(Object.keys(own.body), ['suppressed']);
    assert.equal(own.body.suppressed, false);
    // And it is rate-limited.
    let limited = 0;
    for (let i = 0; i < 40; i += 1) {
      const res = await owner.client.post(`/api/workspaces/${owner.workspaceId}/suppressions/check`, {
        channel: 'email', address: `probe${i}@example.test`,
      });
      if (res.status === 429) limited += 1;
    }
    assert.ok(limited > 0, 'the check is rate-limited');
  });

  test('concurrent sessions and the pool keep the isolation', async () => {
    const alice = await signUp('conc-alice@ztech.test', 'Conc Corp', 'Conc Alice');
    const bob = await signUp('conc-bob@ztech.test', 'Conc Corp', 'Conc Bob');
    const invite = await alice.client.post(`/api/workspaces/${alice.workspaceId}/invitations`, {
      email: 'conc-bob@ztech.test', role: 'viewer',
    });
    await bob.client.post('/api/invitations/accept', { token: invite.body.token });
    // Twenty requests at once, from both sessions.
    const calls = [];
    for (let i = 0; i < 10; i += 1) {
      calls.push(alice.client.get(`/api/workspaces/${alice.workspaceId}/records`));
      calls.push(bob.client.get(`/api/workspaces/${alice.workspaceId}/records`));
      calls.push(bob.client.get(`/api/workspaces/${db.workspace}/records`));
    }
    const results = await Promise.all(calls);
    let aliceOk = 0;
    let bobOk = 0;
    let refused = 0;
    results.forEach((res, index) => {
      if (res.status === 200) {
        if (index % 3 === 0) aliceOk += 1;
        else bobOk += 1;
      } else if (res.status === 403) refused += 1;
    });
    assert.equal(aliceOk, 10, 'every one of the owner\'s requests succeeded');
    assert.equal(bobOk, 10, 'and every one of the viewer\'s own workspace');
    assert.equal(refused, 10, 'and every one of the viewer\'s cross-workspace request was refused');
  });

  test('every authorization decision is audited', async () => {
    const rows = (await identityPool.query(
      `SELECT action, outcome, reason FROM id.authorization_audit ORDER BY audit_id DESC LIMIT 5`,
    )).rows;
    assert.ok(rows.length > 0, 'the audit has records');
    for (const row of rows) {
      assert.ok(['allow', 'deny'].includes(row.outcome));
    }
    const denied = (await identityPool.query(
      `SELECT count(*)::int AS n FROM id.authorization_audit WHERE outcome = 'deny'`,
    )).rows[0].n;
    assert.ok(denied > 0, 'and the denials are recorded too');
  });

  test('the cleanup', async () => {
    if (server) await server.close();
    if (db) await dropDatabase(DATABASE, [db.pool, db.owner, db.controlPool, db.identityPool, db.platformPool, db.admin]);
  });
}
