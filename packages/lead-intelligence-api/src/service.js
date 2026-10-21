'use strict';

const {
  ROLES, isRole, hasPermission, hashPassword, verifyPassword, newToken, hashToken, newId, safeEqual, MIN_PASSWORD,
} = require('./security');

/** How long a session lives. */
const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;
/** How long an invitation lives. */
const INVITATION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

class ServiceError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const bad = (code, message) => new ServiceError(400, code, message);
const forbidden = (code, message) => new ServiceError(403, code, message);
const unauthorized = (code, message) => new ServiceError(401, code, message);
const missing = (code, message) => new ServiceError(404, code, message);
const conflict = (code, message) => new ServiceError(409, code, message);

class AuthService {
  /**
   * @param {{identity: object, tenant: object, roles?: object, logger?: object}} deps
   */
  constructor({ identity, tenant, roles = { app: 'ztech_app' }, logger = console, platformConsole = false }) {
    this.db = identity;
    this.tenant = tenant;
    this.roles = roles;
    this.logger = logger;
    /**
     * Whether this service is the PLATFORM CONSOLE. It is a MARKER, and
     * it is NOT an authorization: a configuration flag is not an
     * authentication, and no operation here is reachable because of it.
     */
    this.platformConsole = platformConsole;
    /**
     * Pause points for the concurrency tests.
     *
     * A concurrency test that sleeps is a test that is sometimes wrong. The
     * hook lets a test hold a transaction at a known point, so the ordering
     * is decided rather than hoped for. It is inert unless a test sets it.
     */
    this.hooks = {};
  }

  /* ------------------------------- the audit ------------------------------- */

  /**
   * Write an audit record.
   *
   * `client` is the transaction's own connection, when the record belongs to
   * a transaction: an ALLOW record written inside the transaction is rolled
   * back with it, so a record can never claim a mutation that did not
   * happen. A DENIAL is written outside, on the pool, so it is durable
   * even though the transaction it refused is gone.
   */
  async audit(entry, client) {
    const runner = client || this.db;
    try {
      await runner.query(
        `INSERT INTO id.authorization_audit (user_id, session_id, org_id, workspace_id, action, outcome, reason, detail)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          entry.user_id || null, entry.session_id || null, entry.org_id || null, entry.workspace_id || null,
          entry.action, entry.outcome, entry.reason || null, entry.detail ? JSON.stringify(entry.detail) : null,
        ],
      );
    } catch (err) {
      this.logger.warn(`the audit could not be written: ${err.message}`);
    }
  }

  /* ------------------------------- the transaction -------------------------- */

  /**
   * A transaction, on ONE connection.
   *
   * A PostgreSQL transaction belongs to one connection: the BEGIN, the
   * statements and the COMMIT must all run on the connection that was
   * acquired for it. A pool hands out a different connection for every
   * query, so a transaction spread over the pool is not a transaction at
   * all - and, with a pool of one, it is a deadlock.
   *
   * The client is always given back: on success, on failure, and on a
   * rollback that failed too.
   */
  async tx(fn) {
    const client = await this.db.connect();
    let began = false;
    try {
      await client.query('BEGIN');
      began = true;
      const result = await fn(client);
      await client.query('COMMIT');
      began = false;
      return result;
    } catch (err) {
      if (began) await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** Pause a transaction at a known point, for the concurrency tests. */
  async pause(name) {
    const hook = this.hooks[name];
    if (hook) await hook();
  }

  /* ------------------------------- the sessions --------------------------- */

  /**
   * The session behind a cookie value. The token is never stored: only its
   * hash is, so a database dump does not hand out sessions.
   *
   * A DISABLED account has no session: `disabled_at` is enforced here and
   * in the database, so the access stops at once and not at the next token.
   */
  async sessionFor(token) {
    if (!token) return null;
    const res = await this.db.query(
      `SELECT s.session_id, s.user_id, s.csrf_hash, s.expires_at, s.revoked_at, u.email
         FROM id.sessions s JOIN id.users u ON u.user_id = s.user_id
        WHERE s.token_hash = $1 AND u.disabled_at IS NULL`,
      [hashToken(token)],
    );
    const row = res.rows[0];
    if (!row) return null;
    if (row.revoked_at) return null;
    if (new Date(row.expires_at) <= new Date()) return null;
    return {
      session_id: row.session_id,
      user_id: row.user_id,
      email: row.email,
      csrf_hash: row.csrf_hash,
      expires_at: row.expires_at,
    };
  }

  /** A new session for a user. */
  async issueSession(userId, client) {
    const session = newToken(32);
    const csrf = newToken(24);
    const sessionId = newId();
    const expires = new Date(Date.now() + SESSION_LIFETIME_MS);
    const runner = client || this.db;
    await runner.query(
      `INSERT INTO id.sessions (session_id, user_id, token_hash, csrf_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [sessionId, userId, session.hash, csrf.hash, expires.toISOString()],
    );
    return { sessionId, token: session.token, csrf: csrf.token, expiresAt: expires };
  }

  /**
   * Replace a session with a new one: the old one is revoked and the new
   * one is issued. The client's cookie is the only thing that changes.
   */
  async rotateSession(session) {
    const issued = await this.issueSession(session.user_id);
    await this.revokeSession(session.session_id);
    return issued;
  }

  /** Revoke a session. It is revoked now, not at its expiry. */
  async revokeSession(sessionId, client) {
    const runner = client || this.db;
    await runner.query(
      'UPDATE id.sessions SET revoked_at = now() WHERE session_id = $1 AND revoked_at IS NULL',
      [sessionId],
    );
  }

  /**
  /**
   * Suspending an account is NOT a service operation.
   *
   * There is no method here that a session can call to close an account,
   * on any server, with any flag set. An account is suspended by a
   * PRIVILEGED DATABASE OPERATION - the same kind of operation that
   * applies a migration - and until there is an independent platform-
   * operator authentication, that is the only way it happens.
   *
   * The ENFORCEMENT is here and it is unchanged: a disabled account's
   * sessions are ignored by sessionFor(), and the database's
   * li.session_entitled() ignores it too, so the account's entitlement
   * dies with its sessions - even in a transaction that is already open.
   */
  /* -------------------------------- the users ----------------------------- */

  async findUserByEmail(email) {
    const res = await this.db.query('SELECT * FROM id.users WHERE lower(email) = lower($1)', [email]);
    return res.rows[0] || null;
  }

  async findUser(userId) {
    const res = await this.db.query('SELECT * FROM id.users WHERE user_id = $1', [userId]);
    return res.rows[0] || null;
  }

  /**
   * Register a customer: the user, the organization, the first workspace,
   * and the owner's membership of it.
   *
   * It is ONE transaction, on one connection: a failure after the first
   * INSERT leaves no organization, no workspace and no membership.
   */
  async register({ email, password, displayName, organization, workspaceName }) {
    const clean = String(email || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean)) throw bad('invalid_email', 'a valid email address is required');
    if (String(password || '').length < MIN_PASSWORD) {
      throw bad('weak_password', `the password must be at least ${MIN_PASSWORD} characters`);
    }
    if (await this.findUserByEmail(clean)) throw conflict('email_taken', 'that email address is already registered');
    const orgName = String(organization || '').trim();
    if (!orgName) throw bad('invalid_organization', 'the organization needs a name');

    const userId = newId();
    const orgId = newId();
    const workspaceId = newId();
    const slug = `${orgName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${orgId.slice(0, 8)}`;
    await this.tx(async (client) => {
      await client.query(
        'INSERT INTO id.users (user_id, email, password_hash, display_name) VALUES ($1, $2, $3, $4)',
        [userId, clean, hashPassword(password), displayName || null],
      );
      await client.query(
        'INSERT INTO id.organizations (org_id, name, slug) VALUES ($1, $2, $3)',
        [orgId, orgName, slug],
      );
      await client.query(
        `INSERT INTO id.organization_memberships (membership_id, org_id, user_id, role) VALUES ($1, $2, $3, 'owner')`,
        [newId(), orgId, userId],
      );
      await client.query(
        'INSERT INTO id.workspaces (workspace_id, org_id, name) VALUES ($1, $2, $3)',
        [workspaceId, orgId, String(workspaceName || `${orgName} workspace`).trim()],
      );
      await client.query(
        `INSERT INTO id.workspace_memberships (membership_id, workspace_id, user_id, role) VALUES ($1, $2, $3, 'owner')`,
        [newId(), workspaceId, userId],
      );
      // The database's CEILING: the role that serves the tenant may act
      // for this workspace. It is added through the control plane, because
      // the grants table is not the service's to write.
      await client.query('SELECT li.grant_workspace($1, $2)', [workspaceId, this.roles.app]);
      await this.audit({
        user_id: userId, org_id: orgId, workspace_id: workspaceId,
        action: 'auth.register', outcome: 'allow',
      }, client);
    });
    const issued = await this.issueSession(userId);
    await this.audit({
      user_id: userId, session_id: issued.sessionId, org_id: orgId, workspace_id: workspaceId,
      action: 'auth.register', outcome: 'allow',
    });
    return { ...issued, userId, orgId, workspaceId };
  }

  /**
   * Log in. The password is checked against the stored verifier, and the
   * session token is a fresh random value.
   */
  async login({ email, password, throttle, address }) {
    const clean = String(email || '').trim();
    // The throttle's key is the ADDRESS as well as the email address: a
    // failure from one place must not lock out the same person from
    // another, and a spray from one place must not lock out an address it
    // does not own. The address is the CONNECTION's, not a header's.
    const key = `${clean.toLowerCase()}|${address || ''}`;
    if (throttle.blocked(key)) {
      await this.audit({ action: 'auth.login', outcome: 'deny', reason: 'throttled' });
      throw new ServiceError(429, 'too_many_attempts', 'too many attempts; try again later');
    }
    const user = await this.findUserByEmail(clean);
    const ok = user && !user.disabled_at && verifyPassword(String(password || ''), user.password_hash);
    if (!ok) {
      throttle.fail(key);
      await this.audit({ user_id: user ? user.user_id : null, action: 'auth.login', outcome: 'deny', reason: 'bad_credentials' });
      throw unauthorized('bad_credentials', 'the email address or the password is not right');
    }
    throttle.succeed(key);
    const issued = await this.issueSession(user.user_id);
    await this.db.query('UPDATE id.sessions SET last_seen_at = now() WHERE session_id = $1', [issued.sessionId]);
    await this.audit({ user_id: user.user_id, session_id: issued.sessionId, action: 'auth.login', outcome: 'allow' });
    return { ...issued, userId: user.user_id };
  }

  async logout(session) {
    await this.revokeSession(session.session_id);
    await this.audit({
      user_id: session.user_id, session_id: session.session_id, action: 'auth.logout', outcome: 'allow',
    });
  }

  /* ------------------------------ the memberships -------------------------- */

  /**
   * The membership of a user in a workspace, with its role and its team.
   *
   * The rows are LOCKED, so the decision is made on the membership as it is
   * at that moment - not on the membership as it was when the request
   * arrived.
   */
  async lockedWorkspaceMemberships(client, workspaceId) {
    const res = await client.query(
      `SELECT m.user_id, m.role, m.team_id FROM id.workspace_memberships m
        WHERE m.workspace_id = $1 AND m.revoked_at IS NULL
        ORDER BY m.user_id
        FOR UPDATE`,
      [workspaceId],
    );
    return res.rows;
  }

  /** The membership of a user in a workspace, with its role and its team. */
  async membershipOf(userId, workspaceId) {
    const res = await this.db.query(
      `SELECT membership_id, workspace_id, user_id, role, team_id
         FROM id.workspace_memberships
        WHERE workspace_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
      [workspaceId, userId],
    );
    return res.rows[0] || null;
  }

  /** The membership of a user in an organization, with its role. */
  async organizationMembershipOf(userId, orgId) {
    const res = await this.db.query(
      `SELECT membership_id, org_id, user_id, role FROM id.organization_memberships
        WHERE org_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
      [orgId, userId],
    );
    return res.rows[0] || null;
  }

  /** Every membership of a user, with the workspace and the organization. */
  async membershipsOf(userId) {
    const res = await this.db.query(
      `SELECT m.membership_id, m.workspace_id, m.role, m.team_id, w.name AS workspace_name, w.org_id,
              o.name AS organization_name
         FROM id.workspace_memberships m
         JOIN id.workspaces w ON w.workspace_id = m.workspace_id
         JOIN id.organizations o ON o.org_id = w.org_id
        WHERE m.user_id = $1 AND m.revoked_at IS NULL
        ORDER BY o.name, w.name`,
      [userId],
    );
    return res.rows;
  }

  /**
   * The authorization decision for one action in one workspace.
   *
   * The membership is the authority: the user's ROLE in the WORKSPACE, and
   * the team that scopes what they may see. The shared database role is
   * not part of it.
   */
  async authorize(session, workspaceId, permission, { address } = {}) {
    const membership = await this.membershipOf(session.user_id, workspaceId);
    if (!membership) {
      await this.audit({
        user_id: session.user_id, session_id: session.session_id, workspace_id: workspaceId,
        action: `authorize:${permission}`, outcome: 'deny', reason: 'no_membership',
        detail: address ? { address } : null,
      });
      throw forbidden('no_membership', 'you are not a member of this workspace');
    }
    if (!hasPermission(membership.role, permission)) {
      await this.audit({
        user_id: session.user_id, session_id: session.session_id, workspace_id: workspaceId,
        action: `authorize:${permission}`, outcome: 'deny', reason: 'role_insufficient',
        detail: { role: membership.role, address: address || null },
      });
      throw forbidden('insufficient_role', 'your role in this workspace does not allow that');
    }
    await this.audit({
      user_id: session.user_id, session_id: session.session_id, workspace_id: workspaceId,
      action: `authorize:${permission}`, outcome: 'allow', detail: { role: membership.role },
    });
    return membership;
  }

  /* -------------------------- the organizations -------------------------- */

  /**
   * A new organization, with the creator as its OWNER.
   *
   * The organization is not a thing without an owner: the creator gets the
   * organization's owner membership in the same transaction, so it may
   * create the organization's first workspace, and so may nobody else.
   */
  async createOrganization(session, { name }) {
    const clean = String(name || '').trim();
    if (!clean) throw bad('invalid_organization', 'the organization needs a name');
    const orgId = newId();
    const slug = `${clean.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${orgId.slice(0,8)}`;
    await this.tx(async (client) => {
      await client.query('INSERT INTO id.organizations (org_id, name, slug) VALUES ($1, $2, $3)', [orgId, clean, slug]);
      await client.query(
        `INSERT INTO id.organization_memberships (membership_id, org_id, user_id, role) VALUES ($1, $2, $3, 'owner')`,
        [newId(), orgId, session.user_id],
      );
      await this.audit({
        user_id: session.user_id, session_id: session.session_id, org_id: orgId,
        action: 'org.create', outcome: 'allow',
      }, client);
    });
    await this.audit({
      user_id: session.user_id, session_id: session.session_id, org_id: orgId,
      action: 'org.create', outcome: 'allow',
    });
    return { orgId, name: clean, slug, role: 'owner' };
  }

  /**
   * The caller's role IN THE ORGANIZATION.
   *
   * It comes from the organization's own membership, and from nothing else.
   * A workspace role never becomes an organization role: an admin who owns
   * a workspace is an admin OF THAT WORKSPACE, and an organization owner
   * is the organization's owner, which is a different thing with different
   * powers.
   */
  async organizationRole(client, userId, orgId) {
    const row = (await client.query(
      `SELECT role FROM id.organization_memberships
        WHERE org_id = $1 AND user_id = $2 AND revoked_at IS NULL FOR UPDATE`,
      [orgId, userId],
    )).rows[0];
    return row ? row.role : null;
  }

  /**
   * The caller's authority to act OVER an organization.
   *
   * It is the STRONGEST of two things: their membership of the
   * organization, and their strongest membership in one of the
   * organization's workspaces. The organization's own owner is the first
   * case, and it is what lets the creator of an organization create its
   * FIRST workspace; an admin of a workspace is the second, and it is what
   * lets them create more.
   *
   * This is an authority OVER the organization, and it is deliberately not
   * the same thing as the organization's ROLE: it is used for one
   * decision, and it never becomes a role anybody else can see.
   *
   * The rows are LOCKED, so the decision is made on the memberships as
   * they are at that moment.
   */
  async workspaceAuthorityOverOrg(client, userId, orgId) {
    const orgMembership = (await client.query(
      `SELECT role FROM id.organization_memberships
        WHERE org_id = $1 AND user_id = $2 AND revoked_at IS NULL FOR UPDATE`,
      [orgId, userId],
    )).rows[0];
    const workspaceRoles = (await client.query(
      `SELECT m.role FROM id.workspace_memberships m
         JOIN id.workspaces w ON w.workspace_id = m.workspace_id
        WHERE w.org_id = $1 AND m.user_id = $2 AND m.revoked_at IS NULL
        ORDER BY m.user_id
        FOR UPDATE OF m`,
      [orgId, userId],
    )).rows.map((r) => r.role);
    const roles = [orgMembership ? orgMembership.role : null, ...workspaceRoles].filter(Boolean);
    if (!roles.length) return null;
    return roles.reduce((best, role) => (ROLES.indexOf(role) < ROLES.indexOf(best) ? role : best));
  }

  /**
   * A new workspace in an organization.
   *
   * The caller must hold `workspace.create` over the organization, and the
   * check is made inside the transaction, on the locked membership rows: an
   * actor whose authority was withdrawn concurrently cannot create a
   * workspace.
   *
   * The workspace, the database grant and the membership are ONE
   * transaction, and the creator is the workspace's OWNER - so a new
   * workspace always has at least one owner, whoever created it.
   */
  async createWorkspace(session, { orgId, name }) {
    const clean = String(name || '').trim();
    if (!clean) throw bad('invalid_workspace', 'the workspace needs a name');
    try {
      return await this.tx(async (client) => {
        const role = await this.workspaceAuthorityOverOrg(client, session.user_id, orgId);
        if (!role) throw forbidden('no_membership', 'you are not a member of this organization');
        if (!hasPermission(role, 'workspace.create')) {
          throw forbidden('insufficient_role', 'your role does not allow creating a workspace');
        }
        await this.pause('createWorkspace:locked');
        const workspaceId = newId();
        await client.query(
          'INSERT INTO id.workspaces (workspace_id, org_id, name) VALUES ($1, $2, $3)',
          [workspaceId, orgId, clean],
        );
        await client.query(
          `INSERT INTO id.workspace_memberships (membership_id, workspace_id, user_id, role) VALUES ($1, $2, $3, 'owner')`,
          [newId(), workspaceId, session.user_id],
        );
        await client.query('SELECT li.grant_workspace($1, $2)', [workspaceId, this.roles.app]);
        await this.audit({
          user_id: session.user_id, session_id: session.session_id, org_id: orgId, workspace_id: workspaceId,
          action: 'workspace.create', outcome: 'allow',
        }, client);
        return { workspaceId, orgId, name: clean, role: 'owner' };
      });
    } catch (err) {
      await this.audit({
        user_id: session.user_id, session_id: session.session_id, org_id: orgId,
        action: 'workspace.create', outcome: 'deny', reason: err.code || 'error',
      });
      throw err;
    }
  }

  /* --------------------------- the invitations --------------------------- */

  /**
   * Invite somebody to a workspace, with a role. The role is part of the
   * invitation, so accepting it can never grant more than it says.
   */
  async invite(session, { orgId, workspaceId, email, role, teamId }) {
    if (!isRole(role)) throw bad('invalid_role', 'that role does not exist');
    try {
      return await this.tx(async (client) => {
        // The authority is decided on the LOCKED membership, inside the
        // transaction: an actor whose role was withdrawn concurrently
        // cannot invite.
        const memberships = await this.lockedWorkspaceMemberships(client, workspaceId);
        const actor = memberships.find((m) => m.user_id === session.user_id);
        if (!actor) throw forbidden('no_membership', 'you are not a member of this workspace');
        if (!hasPermission(actor.role, 'member.invite')) {
          throw forbidden('insufficient_role', 'your role in this workspace does not allow that');
        }
        // NOBODY GRANTS A ROLE ABOVE THEIR OWN AUTHORITY. The roles are
        // ordered, and the first is the strongest, so a grant may not be
        // stronger than the one the inviter holds. This is what closes the
        // self-promotion path: a manager or an admin cannot invite
        // themselves as an owner, and the invitation is refused before it
        // is written.
        if (ROLES.indexOf(role) < ROLES.indexOf(actor.role)) {
          throw forbidden('role_above_authority', `you may not grant a role above your own (${actor.role})`);
        }
        // The organization comes from the WORKSPACE, not from the caller.
        const workspace = (await client.query(
          'SELECT org_id FROM id.workspaces WHERE workspace_id = $1',
          [workspaceId],
        )).rows[0];
        if (!workspace) throw missing('no_workspace', 'that workspace does not exist');
        const targetOrg = workspace.org_id;
        const target = String(email || '').trim().toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(target)) throw bad('invalid_email', 'a valid email address is required');
        const existing = await client.query(
          `SELECT invitation_id FROM id.invitations
            WHERE workspace_id = $1 AND lower(email) = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
          [workspaceId, target],
        );
        if (existing.rows.length) throw conflict('already_invited', 'there is already an open invitation for that address');
        const token = newToken(32);
        const invitationId = newId();
        const expires = new Date(Date.now() + INVITATION_LIFETIME_MS);
        await client.query(
          `INSERT INTO id.invitations (invitation_id, org_id, workspace_id, email, role, team_id, token_hash, invited_by, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [invitationId, targetOrg, workspaceId, target, role, teamId || null, token.hash, session.user_id, expires.toISOString()],
        );
        await this.audit({
          user_id: session.user_id, session_id: session.session_id, org_id: targetOrg, workspace_id: workspaceId,
          action: 'member.invite', outcome: 'allow', detail: { role, actor: actor.role },
        }, client);
        return { invitationId, email: target, role, expiresAt: expires, token: token.token };
      });
    } catch (err) {
      await this.audit({
        user_id: session.user_id, session_id: session.session_id, workspace_id: workspaceId,
        action: 'member.invite', outcome: 'deny', reason: err.code || 'error',
        detail: { requested: role },
      });
      throw err;
    }
  }

  /**
   * Accept an invitation.
   *
   * EVERYTHING IS IN ONE TRANSACTION, on one connection, with the
   * invitation and the membership rows LOCKED:
   *
   *   - the invitation is re-read under its lock: its expiry, its
   *     revocation and its consumption are checked again;
   *   - the invitee's active membership is re-checked under the lock, so
   *     an invitation can never silently upgrade one;
   *   - the INVITER's membership is re-validated in the same transaction,
   *     and the inviter must still hold `member.invite` and a role strong
   *     enough for the grant it names - so an inviter who was demoted or
   *     removed while the invitation was open cannot have it accepted.
   *
   * The membership and the consumption of the invitation are committed
   * together, and the allow-audit record is written inside the
   * transaction, so a record can never claim a mutation that did not
   * happen.
   */
  async acceptInvitation(session, { token }) {
    const res = await this.db.query(
      'SELECT * FROM id.invitations WHERE token_hash = $1',
      [hashToken(token)],
    );
    const invitation = res.rows[0];
    if (!invitation) throw missing('no_invitation', 'that invitation does not exist');
    if (invitation.revoked_at) throw forbidden('invitation_revoked', 'that invitation was withdrawn');
    if (invitation.accepted_at) throw conflict('invitation_used', 'that invitation was already used');
    if (new Date(invitation.expires_at) <= new Date()) throw forbidden('invitation_expired', 'that invitation has expired');
    if (String(invitation.email).toLowerCase() !== String(session.email).toLowerCase()) {
      await this.audit({
        user_id: session.user_id, session_id: session.session_id, workspace_id: invitation.workspace_id,
        action: 'member.invite.accept', outcome: 'deny', reason: 'wrong_address',
      });
      throw forbidden('wrong_address', 'that invitation was sent to somebody else');
    }
    try {
      return await this.tx(async (client) => {
        // The invitation, under its lock.
        const locked = (await client.query(
          'SELECT * FROM id.invitations WHERE invitation_id = $1 FOR UPDATE',
          [invitation.invitation_id],
        )).rows[0];
        if (!locked) throw missing('no_invitation', 'that invitation does not exist');
        if (locked.revoked_at) throw forbidden('invitation_revoked', 'that invitation was withdrawn');
        if (locked.accepted_at) throw conflict('invitation_used', 'that invitation was already used');
        if (new Date(locked.expires_at) <= new Date()) throw forbidden('invitation_expired', 'that invitation has expired');
        // The workspace's memberships, under their lock.
        const memberships = await this.lockedWorkspaceMemberships(client, locked.workspace_id);
        // The invitee may not already be a member: an invitation is not a
        // role change, and it may not silently upgrade one.
        if (memberships.some((m) => m.user_id === session.user_id)) {
          throw conflict('already_a_member', 'you are already a member of this workspace');
        }
        // The inviter's authority, re-validated NOW.
        const inviter = memberships.find((m) => m.user_id === locked.invited_by);
        if (!inviter) throw forbidden('inviter_gone', 'the invitation is no longer valid');
        if (!hasPermission(inviter.role, 'member.invite')) {
          throw forbidden('inviter_lost_permission', 'the invitation is no longer valid');
        }
        if (ROLES.indexOf(locked.role) < ROLES.indexOf(inviter.role)) {
          throw forbidden('role_above_authority', 'that invitation grants more than its author may grant');
        }
        await this.pause('acceptInvitation:locked');
        await client.query(
          `INSERT INTO id.workspace_memberships (membership_id, workspace_id, user_id, role, team_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [newId(), locked.workspace_id, session.user_id, locked.role, locked.team_id],
        );
        await client.query('UPDATE id.invitations SET accepted_at = now() WHERE invitation_id = $1', [locked.invitation_id]);
        await this.audit({
          user_id: session.user_id, session_id: session.session_id, org_id: locked.org_id,
          workspace_id: locked.workspace_id, action: 'member.invite.accept', outcome: 'allow',
          detail: { role: locked.role },
        }, client);
        return { workspaceId: locked.workspace_id, orgId: locked.org_id, role: locked.role };
      });
    } catch (err) {
      await this.audit({
        user_id: session.user_id, session_id: session.session_id, workspace_id: invitation.workspace_id,
        action: 'member.invite.accept', outcome: 'deny', reason: err.code || 'error',
      });
      throw err;
    }
  }

  /* -------------------------- the member's life ------------------------- */

  /** The members of a workspace, with their roles. */
  async listMembers(session, { workspaceId, teamId }) {
    const membership = await this.authorize(session, workspaceId, 'member.read');
    const scope = teamId || membership.team_id || null;
    const res = await this.db.query(
      `SELECT m.user_id, u.email, m.role, m.team_id, m.created_at
         FROM id.workspace_memberships m JOIN id.users u ON u.user_id = m.user_id
        WHERE m.workspace_id = $1 AND m.revoked_at IS NULL
          AND ($2::uuid IS NULL OR m.team_id = $2::uuid OR m.team_id IS NULL)
        ORDER BY u.email`,
      [workspaceId, scope],
    );
    return res.rows;
  }

  /**
   * Remove a member.
   *
   * The authorization and the last-owner protection are decided INSIDE the
   * transaction, on the LOCKED membership rows: an actor who was demoted
   * or removed concurrently cannot complete the removal with the
   * authority they had when the request arrived.
   */
  async removeMember(session, { workspaceId, userId }) {
    try {
      return await this.tx(async (client) => {
        const memberships = await this.lockedWorkspaceMemberships(client, workspaceId);
        const actor = memberships.find((m) => m.user_id === session.user_id);
        if (!actor) throw forbidden('no_membership', 'you are not a member of this workspace');
        if (!hasPermission(actor.role, 'member.remove')) {
          throw forbidden('insufficient_role', 'your role in this workspace does not allow that');
        }
        const target = memberships.find((m) => m.user_id === userId);
        if (!target) throw missing('no_membership', 'that person is not a member of this workspace');
        if (target.role === 'owner' && actor.role !== 'owner') {
          throw forbidden('owner_protected', 'only an owner may remove an owner');
        }
        if (target.role === 'owner') {
          const owners = memberships.filter((m) => m.role === 'owner').length;
          if (owners <= 1) throw forbidden('last_owner', 'a workspace must keep at least one owner');
        }
        await this.pause('removeMember:locked');
        await client.query(
          'UPDATE id.workspace_memberships SET revoked_at = now() WHERE workspace_id = $1 AND user_id = $2 AND revoked_at IS NULL',
          [workspaceId, userId],
        );
        await this.audit({
          user_id: session.user_id, session_id: session.session_id, workspace_id: workspaceId,
          action: 'member.remove', outcome: 'allow', detail: { removed: userId, role: target.role },
        }, client);
        return { removed: userId };
      });
    } catch (err) {
      await this.audit({
        user_id: session.user_id, session_id: session.session_id, workspace_id: workspaceId,
        action: 'member.remove', outcome: 'deny', reason: err.code || 'error',
      });
      throw err;
    }
  }

  /**
   * Change a member's role. It takes effect at once: the membership is
   * the authority, and the database re-checks it on every read.
   */
  async changeRole(session, { workspaceId, userId, role }) {
    if (!isRole(role)) throw bad('invalid_role', 'that role does not exist');
    try {
      return await this.tx(async (client) => {
        const memberships = await this.lockedWorkspaceMemberships(client, workspaceId);
        const actor = memberships.find((m) => m.user_id === session.user_id);
        if (!actor) throw forbidden('no_membership', 'you are not a member of this workspace');
        if (!hasPermission(actor.role, 'member.role')) {
          throw forbidden('insufficient_role', 'your role in this workspace does not allow that');
        }
        // NOBODY GRANTS A ROLE ABOVE THEIR OWN AUTHORITY, here either.
        if (ROLES.indexOf(role) < ROLES.indexOf(actor.role)) {
          throw forbidden('role_above_authority', `you may not grant a role above your own (${actor.role})`);
        }
        const target = memberships.find((m) => m.user_id === userId);
        if (!target) throw missing('no_membership', 'that person is not a member of this workspace');
        if (target.role === 'owner' && actor.role !== 'owner') {
          throw forbidden('owner_protected', 'only an owner may change an owner\'s role');
        }
        if (target.role === 'owner' && role !== 'owner') {
          const owners = memberships.filter((m) => m.role === 'owner').length;
          if (owners <= 1) throw forbidden('last_owner', 'a workspace must keep at least one owner');
        }
        await this.pause('changeRole:locked');
        await client.query(
          'UPDATE id.workspace_memberships SET role = $3 WHERE workspace_id = $1 AND user_id = $2 AND revoked_at IS NULL',
          [workspaceId, userId, role],
        );
        await this.audit({
          user_id: session.user_id, session_id: session.session_id, workspace_id: workspaceId,
          action: 'member.role', outcome: 'allow', detail: { user: userId, role },
        }, client);
        return { userId, role };
      });
    } catch (err) {
      await this.audit({
        user_id: session.user_id, session_id: session.session_id, workspace_id: workspaceId,
        action: 'member.role', outcome: 'deny', reason: err.code || 'error',
      });
      throw err;
    }
  }

  /* --------------------------- the workspace --------------------------- */

  /** The workspace's own record. */
  async workspace(workspaceId) {
    const res = await this.db.query(
      `SELECT w.workspace_id, w.org_id, w.name, o.name AS organization_name
         FROM id.workspaces w JOIN id.organizations o ON o.org_id = w.org_id
        WHERE w.workspace_id = $1`,
      [workspaceId],
    );
    return res.rows[0] || null;
  }

  /**
   * A workspace token for a session, from the CONTROL PLANE.
   *
   * The control plane is reached with the identity role, which may issue a
   * token and may not read a tenant row. The token is bound to the
   * session, so it cannot be used by another session.
   */
  async issueWorkspaceToken(session, workspaceId) {
    const res = await this.db.query(
      'SELECT li.issue_workspace_token($1, $2, $3, $4, $5) AS token',
      [workspaceId, this.roles.app, session.session_id, session.user_id, 300],
    );
    return res.rows[0].token;
  }

  /** Is this CSRF token the one this session was issued? */
  csrfMatches(session, csrf) {
    return safeEqual(session.csrf_hash, hashToken(csrf || ''));
  }
}

module.exports = { AuthService, ServiceError, SESSION_LIFETIME_MS, INVITATION_LIFETIME_MS };
