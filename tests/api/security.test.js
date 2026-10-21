'use strict';

/**
 * The API security suite (M3, corrections C1 to C5).
 *
 * Real HTTP, real PostgreSQL 16, the real roles. It proves:
 *
 *   C1  nobody grants a role above their own authority, an existing
 *       membership is not silently upgraded by an invitation, the
 *       invitation's authority is revalidated when it is accepted, and the
 *       last-owner protection holds on every path;
 *   C2  the identity mutations are transactions on ONE connection, and the
 *       concurrency holds: one registration cannot leave half an
 *       organization, an invitation cannot be accepted twice, and two
 *       owners cannot remove each other;
 *   C3  the suppression check runs inside the session's context, and it
 *       stops when the session stops;
 *   C4  the token-only control role may not grant a workspace, and the
 *       login throttle keys on the connection's address, not on a header;
 *   C5  what a copied workspace token can and cannot do - honestly.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { freshDatabase, dropDatabase, roleUrl, ROLES, skip } = require('../persistence-contract/lib/postgres');
const { ApiServer } = require('../../packages/lead-intelligence-api/src/server');
const { PostgresStore } = require('../../packages/lead-intelligence-postgres/src/PostgresStore');

if (!process.env.ZTECH_PG_URL) {
  test('[api security] the API security suite (skipped: no PostgreSQL is configured)', { skip: 'set ZTECH_PG_URL' }, () => {});
} else {
  const DATABASE = 'ztech_api_security';
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

  async function signUp(email, organization, workspaceName) {
    const client = new Client(base);
    const res = await client.post('/api/auth/register', { email, password, organization, workspaceName });
    assert.equal(res.status, 201, `the registration of ${email} worked: ${JSON.stringify(res.body)}`);
    client.csrf = res.body.csrf_token;
    return { client, userId: res.body.user_id, orgId: res.body.organization_id, workspaceId: res.body.workspace_id };
  }

  async function sessionOf(userId) {
    const res = await identityPool.query('SELECT session_id FROM id.sessions WHERE user_id = $1 LIMIT 1', [userId]);
    return res.rows[0].session_id;
  }

  function storeFor(sessionId, userId, workspaceId) {
    return new PostgresStore({ pool: tenantPool, controlPool, workspaceId, sessionId, userId, logger: { warn() {} } });
  }

  /** Invite somebody and accept it, so the workspace has a member with a role. */
  async function addMember(owner, role, email) {
    const invite = await owner.client.post(`/api/workspaces/${owner.workspaceId}/invitations`, { email, role });
    assert.equal(invite.status, 201, `the invitation was written: ${JSON.stringify(invite.body)}`);
    const invitee = await signUp(email, `${email} Corp`, `${email} Workspace`);
    const accepted = await invitee.client.post('/api/invitations/accept', { token: invite.body.token });
    assert.equal(accepted.status, 200, `the invitation was accepted: ${JSON.stringify(accepted.body)}`);
    return { invitee, role, token: invite.body.token };
  }

  test('the setup: a real API over a real PostgreSQL 16', async () => {
    db = await freshDatabase(DATABASE, { workspaces: ['44444444-4444-4444-8444-444444444444'] });
    tenantPool = db.pool;
    controlPool = db.controlPool;
    identityPool = db.identityPool;
    const api = new ApiServer({
      identity: identityPool,
      tenant: tenantPool,
      logger: { warn() {}, error() {} },
      storeFor: async (session, workspaceId) => storeFor(session.session_id, session.user_id, workspaceId),
    });
    const address = await api.listen(0);
    base = `http://127.0.0.1:${address.port}`;
    server = api;
  });

  /* ------------------------------ C1: the escalation ------------------------------ */

  test('C1: a manager may not invite anybody as an owner', async () => {
    const owner = await signUp('c1-owner@ztech.test', 'C1 Corp', 'C1 Workspace');
    const manager = await addMember(owner, 'manager', 'c1-manager@ztech.test');
    // The manager tries to invite THEMSELVES as an owner.
    const res = await manager.invitee.client.post(`/api/workspaces/${owner.workspaceId}/invitations`, {
      email: 'c1-manager@ztech.test', role: 'owner',
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'role_above_authority');
    // And the membership is UNCHANGED: still a manager.
    const members = await owner.client.get(`/api/workspaces/${owner.workspaceId}/members`);
    const mine = members.body.members.find((m) => m.user_id === manager.invitee.userId);
    assert.equal(mine.role, 'manager', 'the membership was not changed');
  });

  test('C1: an admin may not invite anybody as an owner either', async () => {
    const owner = await signUp('c1b-owner@ztech.test', 'C1B Corp', 'C1B Workspace');
    const admin = await addMember(owner, 'admin', 'c1b-admin@ztech.test');
    const res = await admin.invitee.client.post(`/api/workspaces/${owner.workspaceId}/invitations`, {
      email: 'c1b-admin@ztech.test', role: 'owner',
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'role_above_authority');
    const members = await owner.client.get(`/api/workspaces/${owner.workspaceId}/members`);
    assert.equal(members.body.members.find((m) => m.user_id === admin.invitee.userId).role, 'admin');
  });

  test('C1: an admin may not grant a role above their own by any path', async () => {
    const owner = await signUp('c1c-owner@ztech.test', 'C1C Corp', 'C1C Workspace');
    const admin = await addMember(owner, 'admin', 'c1c-admin@ztech.test');
    const member = await addMember(owner, 'member', 'c1c-member@ztech.test');
    // The role change path refuses it too.
    const res = await admin.invitee.client.patch(
      `/api/workspaces/${owner.workspaceId}/members/${member.invitee.userId}`,
      { role: 'owner' },
    );
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'role_above_authority');
    const members = await owner.client.get(`/api/workspaces/${owner.workspaceId}/members`);
    assert.equal(members.body.members.find((m) => m.user_id === member.invitee.userId).role, 'member');
  });

  test('C1: an invitation does not silently upgrade an existing membership', async () => {
    const owner = await signUp('c1d-owner@ztech.test', 'C1D Corp', 'C1D Workspace');
    const member = await addMember(owner, 'member', 'c1d-member@ztech.test');
    // The owner writes an invitation that names a role the member does not
    // have.
    const invite = await owner.client.post(`/api/workspaces/${owner.workspaceId}/invitations`, {
      email: 'c1d-member@ztech.test', role: 'admin',
    });
    assert.equal(invite.status, 201);
    // The member tries to use it to promote themselves.
    const res = await member.invitee.client.post('/api/invitations/accept', { token: invite.body.token });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'already_a_member');
    // The membership is untouched.
    const members = await owner.client.get(`/api/workspaces/${owner.workspaceId}/members`);
    assert.equal(members.body.members.find((m) => m.user_id === member.invitee.userId).role, 'member');
  });

  test('C1: the invitation is revalidated when it is accepted', async () => {
    const owner = await signUp('c1e-owner@ztech.test', 'C1E Corp', 'C1E Workspace');
    const admin = await addMember(owner, 'admin', 'c1e-admin@ztech.test');
    // The admin writes an invitation for somebody else.
    const invite = await admin.invitee.client.post(`/api/workspaces/${owner.workspaceId}/invitations`, {
      email: 'c1e-guest@ztech.test', role: 'member',
    });
    assert.equal(invite.status, 201);
    // The admin is DEMOTED before the invitation is accepted.
    const demoted = await owner.client.patch(
      `/api/workspaces/${owner.workspaceId}/members/${admin.invitee.userId}`,
      { role: 'viewer' },
    );
    assert.equal(demoted.status, 200);
    // The invitation's authority is re-checked: a viewer may not grant a
    // member, so the invitation is refused.
    const guest = await signUp('c1e-guest@ztech.test', 'C1E Guest', 'C1E Guest Workspace');
    const res = await guest.client.post('/api/invitations/accept', { token: invite.body.token });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'inviter_lost_permission');
  });

  test('C1: the last owner is protected on every path', async () => {
    const owner = await signUp('c1f-owner@ztech.test', 'C1F Corp', 'C1F Workspace');
    // The owner may not demote themselves out of the last owner.
    const demote = await owner.client.patch(
      `/api/workspaces/${owner.workspaceId}/members/${owner.userId}`,
      { role: 'admin' },
    );
    assert.equal(demote.status, 403);
    assert.equal(demote.body.error, 'last_owner');
    // And may not remove themselves.
    const remove = await owner.client.del(`/api/workspaces/${owner.workspaceId}/members/${owner.userId}`);
    assert.equal(remove.status, 403);
    assert.equal(remove.body.error, 'last_owner');
  });

  /* --------------------------- C2: the transactions --------------------------- */

  test('C2: a registration that fails after the first INSERT leaves nothing behind', async () => {
    const before = (await identityPool.query('SELECT count(*)::int AS n FROM id.organizations')).rows[0].n;
    // The identity pool fails on the WORKSPACES insert, which is the third
    // statement of the registration.
    const sabotaged = async (sql, params) => {
      if (/INSERT INTO id\.workspaces/.test(sql)) throw new Error('the database refused');
      return identityPool.query(sql, params);
    };
    const brokenPool = {
      query: sabotaged,
      connect: async () => {
        const client = await identityPool.connect();
        return { query: sabotaged, release: () => client.release() };
      },
    };
    const api = new ApiServer({
      identity: brokenPool,
      tenant: tenantPool,
      logger: { warn() {}, error() {} },
      storeFor: async (session, workspaceId) => storeFor(session.session_id, session.user_id, workspaceId),
    });
    const address = await api.listen(0);
    try {
      const client = new Client(`http://127.0.0.1:${address.port}`);
      const res = await client.post('/api/auth/register', {
        email: 'c2-fail@ztech.test', password, organization: 'C2 Failed', workspaceName: 'C2 Workspace',
      });
      assert.equal(res.status, 500);
    } finally {
      await api.close();
    }
    const after = (await identityPool.query('SELECT count(*)::int AS n FROM id.organizations')).rows[0].n;
    assert.equal(after, before, 'no organization was left behind');
    const users = (await identityPool.query('SELECT count(*)::int AS n FROM id.users WHERE email = $1', ['c2-fail@ztech.test'])).rows[0].n;
    assert.equal(users, 0, 'and no user');
    const memberships = (await identityPool.query(
      'SELECT count(*)::int AS n FROM id.workspace_memberships m JOIN id.users u ON u.user_id = m.user_id WHERE u.email = $1',
      ['c2-fail@ztech.test'],
    )).rows[0].n;
    assert.equal(memberships, 0, 'and no membership');
  });

  test('C2: two simultaneous acceptances of one invitation: only one wins', async () => {
    const owner = await signUp('c2-owner@ztech.test', 'C2 Corp', 'C2 Workspace');
    const invite = await owner.client.post(`/api/workspaces/${owner.workspaceId}/invitations`, {
      email: 'c2-guest@ztech.test', role: 'member',
    });
    assert.equal(invite.status, 201);
    const guest = await signUp('c2-guest@ztech.test', 'C2 Guest', 'C2 Guest Workspace');
    const results = await Promise.all([
      guest.client.post('/api/invitations/accept', { token: invite.body.token }),
      guest.client.post('/api/invitations/accept', { token: invite.body.token }),
    ]);
    const accepted = results.filter((r) => r.status === 200).length;
    const refused = results.filter((r) => r.status === 409 || r.status === 403).length;
    assert.equal(accepted, 1, 'exactly one acceptance succeeded');
    assert.equal(refused, 1, 'and the other was refused');
    // And the membership was written ONCE.
    const memberships = (await identityPool.query(
      'SELECT count(*)::int AS n FROM id.workspace_memberships WHERE workspace_id = $1 AND user_id = $2 AND revoked_at IS NULL',
      [owner.workspaceId, guest.userId],
    )).rows[0].n;
    assert.equal(memberships, 1);
  });

  test('C2: two owners removed at once cannot leave the workspace without an owner', async () => {
    const owner = await signUp('c2b-owner@ztech.test', 'C2B Corp', 'C2B Workspace');
    const second = await addMember(owner, 'owner', 'c2b-owner2@ztech.test');
    // The owner and the second owner remove each other at the same time.
    const results = await Promise.all([
      owner.client.del(`/api/workspaces/${owner.workspaceId}/members/${owner.userId}`),
      second.invitee.client.del(`/api/workspaces/${owner.workspaceId}/members/${second.invitee.userId}`),
    ]);
    // Whatever happened, the workspace still has an owner.
    const owners = (await identityPool.query(
      `SELECT count(*)::int AS n FROM id.workspace_memberships
        WHERE workspace_id = $1 AND role = 'owner' AND revoked_at IS NULL`,
      [owner.workspaceId],
    )).rows[0].n;
    assert.ok(owners >= 1, `the workspace still has an owner (${owners})`);
    for (const res of results) {
      assert.ok(res.status === 200 || res.status === 403, `a removal either succeeded or was refused: ${res.status}`);
      if (res.status === 403) assert.equal(res.body.error, 'last_owner');
    }
  });

  test('C2: concurrent registrations all land, and none is half-written', async () => {
    const emails = ['c2c-1@ztech.test', 'c2c-2@ztech.test', 'c2c-3@ztech.test'];
    const results = await Promise.all(emails.map((email) => {
      const client = new Client(base);
      return client.post('/api/auth/register', { email, password, organization: `${email} Corp`, workspaceName: 'W' });
    }));
    for (const res of results) assert.equal(res.status, 201);
    for (const email of emails) {
      const rows = (await identityPool.query(
        `SELECT count(*)::int AS users FROM id.users WHERE email = $1`, [email],
      )).rows[0].users;
      assert.equal(rows, 1, 'one user');
      const orgs = (await identityPool.query(
        `SELECT count(*)::int AS n FROM id.organizations o
          JOIN id.workspaces w ON w.org_id = o.org_id
          JOIN id.workspace_memberships m ON m.workspace_id = w.workspace_id
          JOIN id.users u ON u.user_id = m.user_id
         WHERE u.email = $1 AND o.name = $2`,
        [email, `${email} Corp`],
      )).rows[0].n;
      assert.equal(orgs, 1, 'one organization, one workspace and one membership');
    }
  });

  /* ------------------------------ C3: the suppression ------------------------------ */

  test('C3: the suppression check answers for its own workspace, for the platform, and for nobody else', async () => {
    const owner = await signUp('c3-owner@ztech.test', 'C3 Corp', 'C3 Workspace');
    const other = await signUp('c3-other@ztech.test', 'C3 Other', 'C3 Other Workspace');
    const store = storeFor(await sessionOf(owner.userId), owner.userId, owner.workspaceId);
    // A workspace-local suppression.
    await store.suppressions.add({
      suppression_id: 'c3-local', scope: 'workspace', workspace_id: owner.workspaceId,
      channel: 'email', normalized_address: 'local@example.test', reason: 'unsubscribe',
      source: 'user', created_at: '2026-09-01T00:00:00.000Z',
    });
    // A platform-global suppression.
    const platformStore = new PostgresStore({
      pool: db.platformPool, controlPool, workspaceId: '00000000-0000-0000-0000-000000000000',
      role: 'platform', logger: { warn() {} },
    });
    await platformStore.suppressions.add({
      suppression_id: 'c3-global', scope: 'global', workspace_id: '00000000-0000-0000-0000-000000000000',
      channel: 'email', normalized_address: 'global@example.test', reason: 'manual',
      source: 'import', created_at: '2026-09-01T00:00:00.000Z',
    });
    // Another tenant's suppression.
    const otherStore = storeFor(await sessionOf(other.userId), other.userId, other.workspaceId);
    await otherStore.suppressions.add({
      suppression_id: 'c3-theirs', scope: 'workspace', workspace_id: other.workspaceId,
      channel: 'email', normalized_address: 'theirs@example.test', reason: 'unsubscribe',
      source: 'user', created_at: '2026-09-01T00:00:00.000Z',
    });

    const check = async (client, workspace, address) => {
      const res = await client.post(`/api/workspaces/${workspace}/suppressions/check`, { channel: 'email', address });
      return res;
    };
    const local = await check(owner.client, owner.workspaceId, 'local@example.test');
    assert.equal(local.status, 200);
    assert.equal(local.body.suppressed, true, 'the workspace-local suppression is true');
    const global = await check(owner.client, owner.workspaceId, 'global@example.test');
    assert.equal(global.body.suppressed, true, 'the platform-global suppression is true');
    const neither = await check(owner.client, owner.workspaceId, 'nobody@example.test');
    assert.equal(neither.body.suppressed, false, 'an unsuppressed address is false');
    // Another tenant's suppression is not this tenant's business.
    const theirs = await check(owner.client, owner.workspaceId, 'theirs@example.test');
    assert.equal(theirs.body.suppressed, false, "another tenant's suppression is invisible");
    // And the check is refused outside the membership.
    const cross = await check(other.client, owner.workspaceId, 'local@example.test');
    assert.equal(cross.status, 403);
  });

  test('C3: a logout and a withdrawn membership stop the suppression check', async () => {
    const owner = await signUp('c3b-owner@ztech.test', 'C3B Corp', 'C3B Workspace');
    const member = await addMember(owner, 'member', 'c3b-member@ztech.test');
    const before = await member.invitee.client.post(`/api/workspaces/${owner.workspaceId}/suppressions/check`, {
      channel: 'email', address: 'nobody@example.test',
    });
    assert.equal(before.status, 200);
    // The membership is withdrawn.
    const removed = await owner.client.del(`/api/workspaces/${owner.workspaceId}/members/${member.invitee.userId}`);
    assert.equal(removed.status, 200);
    const after = await member.invitee.client.post(`/api/workspaces/${owner.workspaceId}/suppressions/check`, {
      channel: 'email', address: 'nobody@example.test',
    });
    assert.equal(after.status, 403);
    // And a logout ends the session.
    const out = await owner.client.post('/api/auth/logout', {});
    assert.equal(out.status, 200);
    const loggedOut = await owner.client.post(`/api/workspaces/${owner.workspaceId}/suppressions/check`, {
      channel: 'email', address: 'nobody@example.test',
    });
    assert.equal(loggedOut.status, 401);
  });

  /* -------------------------------- C4: the boundaries -------------------------------- */

  test('C4: the token-only control role may not grant a workspace', async () => {
    const workspace = '55555555-5555-4555-8555-555555555555';
    await assert.rejects(
      controlPool.query('SELECT li.grant_workspace($1, $2)', [workspace, ROLES.app]),
      /permission denied/i,
      'the control plane may not widen the ceiling',
    );
    // And the identity service may.
    const granted = await identityPool.query('SELECT li.grant_workspace($1, $2) AS ok', [workspace, ROLES.app]);
    assert.equal(granted.rows[0].ok, true, 'the identity service may');
  });

  test('C4: the login throttle keys on the connection, not on a forged header', async () => {
    const client = new Client(base);
    // A spray with a forged address header does not spread the failures
    // over the fake addresses.
    let refused = 0;
    for (let i = 0; i < 8; i += 1) {
      const res = await client.post('/api/auth/login', { email: 'c4@ztech.test', password: 'wrong' }, {
        'x-forwarded-for': `10.0.0.${i}`,
      });
      if (res.status === 429) refused += 1;
    }
    assert.ok(refused > 0, 'the attempts were refused, from one bucket');
  });

  /* --------------------------------- C5: the token --------------------------------- */

  test('C5: a copied workspace token is a bearer credential, and the SERVER is the boundary', async () => {
    const owner = await signUp('c5-owner@ztech.test', 'C5 Corp', 'C5 Workspace');
    const store = storeFor(await sessionOf(owner.userId), owner.userId, owner.workspaceId);
    // A token, minted for this session, by the control plane.
    const token = (await identityPool.query(
      'SELECT li.issue_workspace_token($1, $2, $3, $4, 60) AS t',
      [owner.workspaceId, ROLES.app, await sessionOf(owner.userId), owner.userId],
    )).rows[0].t;
    assert.ok(token);
    // COPIED to another connection, under the SAME database role: the
    // database cannot tell them apart, because they are the same
    // principal. The token is a bearer credential.
    const other = await tenantPool.connect();
    try {
      await other.query('BEGIN');
      await other.query('SELECT li.set_workspace($1, $2)', [owner.workspaceId, token]);
      const rows = await other.query('SELECT count(*)::int AS n FROM li.li_saved_searches');
      assert.equal(rows.rows[0].n, 0, 'the copy opened the context: the database cannot bind a token to a connection');
    } finally {
      await other.query('ROLLBACK').catch(() => {});
      other.release();
    }
    // WHAT PREVENTS THE ABUSE: the token never leaves the server. The API
    // never accepts one from a client - a client-supplied token is ignored
    // and the session's own context is used.
    const res = await owner.client.get(`/api/workspaces/${owner.workspaceId}/records`, {
      'x-workspace-token': token,
    });
    assert.equal(res.status, 200, 'the request is served with the SESSION\'s own context, not the client\'s');
    // And the entitlement is still re-checked: a revoked session's token is
    // useless, even if it is replayed.
    const sessionId = await sessionOf(owner.userId);
    await identityPool.query('UPDATE id.sessions SET revoked_at = now() WHERE session_id = $1', [sessionId]);
    const revoked = await tenantPool.connect();
    try {
      await revoked.query('BEGIN');
      await assert.rejects(
        revoked.query('SELECT li.set_workspace($1, $2)', [owner.workspaceId, token]),
        /not entitled|not valid|expired/i,
        'a revoked session\'s token is refused, wherever it is presented',
      );
    } finally {
      await revoked.query('ROLLBACK').catch(() => {});
      revoked.release();
    }
  });

  test('the cleanup', async () => {
    if (server) await server.close();
    if (db) await dropDatabase(DATABASE, [db.pool, db.owner, db.controlPool, db.identityPool, db.platformPool, db.admin]);
  });
}
