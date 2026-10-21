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
  constructor({ identity, tenant, roles = { app: 'ztech_app' }, logger = console }) {
    this.db = identity;
    this.tenant = tenant;
    this.roles = roles;
    this.logger = logger;
  }

  /* ----------------------------- the audit ----------------------------- */

  async audit(entry) {
    try {
      await this.db.query(
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

  /* ----------------------------- the sessions -------------------------- */

  /**
   * The session behind a cookie value. The token is never stored: only its
   * hash is, so a database dump does not hand out sessions.
   */
  async sessionFor(token) {
    if (!token) return null;
    const res = await this.db.query(
      `SELECT s.session_id, s.user_id, s.csrf_hash, s.expires_at, s.revoked_at, u.email
         FROM id.sessions s JOIN id.users u ON u.user_id = s.user_id
        WHERE s.token_hash = $1`,
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
  async issueSession(userId) {
    const session = newToken(32);
    const csrf = newToken(24);
    const sessionId = newId();
    const expires = new Date(Date.now() + SESSION_LIFETIME_MS);
    await this.db.query(
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
  async revokeSession(sessionId) {
    await this.db.query(
      'UPDATE id.sessions SET revoked_at = now() WHERE session_id = $1 AND revoked_at IS NULL',
      [sessionId],
    );
  }

  /* ----------------------------- the users ----------------------------- */

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
    await this.db.query('BEGIN');
    try {
      await this.db.query(
        'INSERT INTO id.users (user_id, email, password_hash, display_name) VALUES ($1, $2, $3, $4)',
        [userId, clean, hashPassword(password), displayName || null],
      );
      await this.db.query(
        'INSERT INTO id.organizations (org_id, name, slug) VALUES ($1, $2, $3)',
        [orgId, orgName, slug],
      );
      await this.db.query(
        'INSERT INTO id.workspaces (workspace_id, org_id, name) VALUES ($1, $2, $3)',
        [workspaceId, orgId, String(workspaceName || `${orgName} workspace`).trim()],
      );
      await this.db.query(
        `INSERT INTO id.workspace_memberships (membership_id, workspace_id, user_id, role)
         VALUES ($1, $2, $3, 'owner')`,
        [newId(), workspaceId, userId],
      );
        // The database's CEILING: the role that serves the tenant may act
        // for this workspace. It is added through the control plane, because
        // the grants table is not the service's to write.
        await this.db.query('SELECT li.grant_workspace($1, $2)', [workspaceId, this.roles.app]);
        await this.db.query('COMMIT');
      } catch (err) {
        await this.db.query('ROLLBACK').catch(() => {});
        throw err;
      }
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
  async login({ email, password, throttle }) {
    const clean = String(email || '').trim();
    const key = `${clean.toLowerCase()}|${throttle.address || ''}`;
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

  /* ------------------------- the memberships --------------------------- */

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

  /* ------------------------- the organizations ------------------------- */

  async createOrganization(session, { name }) {
    const clean = String(name || '').trim();
    if (!clean) throw bad('invalid_organization', 'the organization needs a name');
    const orgId = newId();
    const slug = `${clean.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${orgId.slice(0, 8)}`;
    await this.db.query('INSERT INTO id.organizations (org_id, name, slug) VALUES ($1, $2, $3)', [orgId, clean, slug]);
    await this.audit({
      user_id: session.user_id, session_id: session.session_id, org_id: orgId,
      action: 'org.create', outcome: 'allow',
    });
    return { orgId, name: clean, slug };
  }

  /**
   * A new workspace in an organization. The caller must be an owner or an
   * admin in one of that organization's workspaces.
   */
  async createWorkspace(session, { orgId, name }) {
    const clean = String(name || '').trim();
    if (!clean) throw bad('invalid_workspace', 'the workspace needs a name');
    const memberships = await this.membershipsOf(session.user_id);
    const mine = memberships.filter((m) => m.org_id === orgId);
    if (!mine.length) {
      await this.audit({
        user_id: session.user_id, session_id: session.session_id, org_id: orgId,
        action: 'workspace.create', outcome: 'deny', reason: 'no_membership',
      });
      throw forbidden('no_membership', 'you are not a member of this organization');
    }
    const role = mine.reduce((best, m) => (ROLES.indexOf(m.role) < ROLES.indexOf(best) ? m.role : best), 'viewer');
    if (!hasPermission(role, 'workspace.create')) {
      await this.audit({
        user_id: session.user_id, session_id: session.session_id, org_id: orgId,
        action: 'workspace.create', outcome: 'deny', reason: 'role_insufficient',
      });
      throw forbidden('insufficient_role', 'your role does not allow creating a workspace');
    }
    const workspaceId = newId();
    await this.db.query(
      'INSERT INTO id.workspaces (workspace_id, org_id, name) VALUES ($1, $2, $3)',
      [workspaceId, orgId, clean],
    );
    await this.db.query('SELECT li.grant_workspace($1, $2)', [workspaceId, this.roles.app]);
    await this.db.query(
      `INSERT INTO id.workspace_memberships (membership_id, workspace_id, user_id, role) VALUES ($1, $2, $3, $4)`,
      [newId(), workspaceId, session.user_id, role],
    );
    await this.audit({
      user_id: session.user_id, session_id: session.session_id, org_id: orgId, workspace_id: workspaceId,
      action: 'workspace.create', outcome: 'allow',
    });
    return { workspaceId, orgId, name: clean, role };
  }

  /* -------------------------- the invitations -------------------------- */

  /**
   * Invite somebody to a workspace, with a role. The role is part of the
   * invitation, so accepting it can never grant more than it says.
   */
  async invite(session, { orgId, workspaceId, email, role, teamId }) {
    if (!isRole(role)) throw bad('invalid_role', 'that role does not exist');
    await this.authorize(session, workspaceId, 'member.invite');
    // The organization comes from the WORKSPACE, not from the caller: a
    // client may not name the organization it is inviting into.
    const workspace = await this.workspace(workspaceId);
    if (!workspace) throw missing('no_workspace', 'that workspace does not exist');
    const targetOrg = workspace.org_id;
    const target = String(email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(target)) throw bad('invalid_email', 'a valid email address is required');
    const existing = await this.db.query(
      `SELECT invitation_id FROM id.invitations
        WHERE workspace_id = $1 AND lower(email) = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
      [workspaceId, target],
    );
    if (existing.rows.length) throw conflict('already_invited', 'there is already an open invitation for that address');
    const token = newToken(32);
    const invitationId = newId();
    const expires = new Date(Date.now() + INVITATION_LIFETIME_MS);
    await this.db.query(
      `INSERT INTO id.invitations (invitation_id, org_id, workspace_id, email, role, team_id, token_hash, invited_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [invitationId, targetOrg, workspaceId, target, role, teamId || null, token.hash, session.user_id, expires.toISOString()],
    );
    await this.audit({
      user_id: session.user_id, session_id: session.session_id, org_id: orgId, workspace_id: workspaceId,
      action: 'member.invite', outcome: 'allow', detail: { role },
    });
    return { invitationId, email: target, role, expiresAt: expires, token: token.token };
  }

  /** Accept an invitation. The role comes from the invitation, never from the caller. */
  async acceptInvitation(session, { token }) {
    const res = await this.db.query(
      `SELECT * FROM id.invitations WHERE token_hash = $1`,
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
    await this.db.query('BEGIN');
    try {
      await this.db.query(
        `INSERT INTO id.workspace_memberships (membership_id, workspace_id, user_id, role, team_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (workspace_id, user_id) WHERE revoked_at IS NULL
         DO UPDATE SET role = EXCLUDED.role, team_id = EXCLUDED.team_id, revoked_at = NULL`,
        [newId(), invitation.workspace_id, session.user_id, invitation.role, invitation.team_id],
      );
      await this.db.query('UPDATE id.invitations SET accepted_at = now() WHERE invitation_id = $1', [invitation.invitation_id]);
      await this.db.query('COMMIT');
    } catch (err) {
      await this.db.query('ROLLBACK').catch(() => {});
      throw err;
    }
    await this.audit({
      user_id: session.user_id, session_id: session.session_id, org_id: invitation.org_id,
      workspace_id: invitation.workspace_id, action: 'member.invite.accept', outcome: 'allow',
      detail: { role: invitation.role },
    });
    return { workspaceId: invitation.workspace_id, orgId: invitation.org_id, role: invitation.role };
  }

  /* ------------------------- the member's life ------------------------- */

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
   * Remove a member. The owner cannot be removed by anybody but an owner,
   * and the last owner cannot be removed at all.
   */
  async removeMember(session, { workspaceId, userId }) {
    const actor = await this.authorize(session, workspaceId, 'member.remove');
    const target = await this.membershipOf(userId, workspaceId);
    if (!target) throw missing('no_membership', 'that person is not a member of this workspace');
    if (target.role === 'owner' && actor.role !== 'owner') {
      await this.audit({
        user_id: session.user_id, session_id: session.session_id, workspace_id: workspaceId,
        action: 'member.remove', outcome: 'deny', reason: 'owner_protected',
      });
      throw forbidden('owner_protected', 'only an owner may remove an owner');
    }
    if (target.role === 'owner') {
      const owners = (await this.db.query(
        `SELECT count(*)::int AS n FROM id.workspace_memberships
          WHERE workspace_id = $1 AND role = 'owner' AND revoked_at IS NULL`,
        [workspaceId],
      )).rows[0].n;
      if (owners <= 1) {
        await this.audit({
          user_id: session.user_id, session_id: session.session_id, workspace_id: workspaceId,
          action: 'member.remove', outcome: 'deny', reason: 'last_owner',
        });
        throw forbidden('last_owner', 'a workspace must keep at least one owner');
      }
    }
    await this.db.query(
      'UPDATE id.workspace_memberships SET revoked_at = now() WHERE workspace_id = $1 AND user_id = $2 AND revoked_at IS NULL',
      [workspaceId, userId],
    );
    await this.audit({
      user_id: session.user_id, session_id: session.session_id, workspace_id: workspaceId,
      action: 'member.remove', outcome: 'allow', detail: { removed: userId, role: target.role },
    });
    return { removed: userId };
  }

  /**
   * Change a member's role. It takes effect at once: the membership is
   * the authority, and the database re-checks it on every read.
   */
  async changeRole(session, { workspaceId, userId, role }) {
    if (!isRole(role)) throw bad('invalid_role', 'that role does not exist');
    const actor = await this.authorize(session, workspaceId, 'member.role');
    const target = await this.membershipOf(userId, workspaceId);
    if (!target) throw missing('no_membership', 'that person is not a member of this workspace');
    if (target.role === 'owner' && actor.role !== 'owner') {
      await this.audit({
        user_id: session.user_id, session_id: session.session_id, workspace_id: workspaceId,
        action: 'member.role', outcome: 'deny', reason: 'owner_protected',
      });
      throw forbidden('owner_protected', 'only an owner may change an owner\'s role');
    }
    if (target.role === 'owner' && role !== 'owner') {
      const owners = (await this.db.query(
        `SELECT count(*)::int AS n FROM id.workspace_memberships
          WHERE workspace_id = $1 AND role = 'owner' AND revoked_at IS NULL`,
        [workspaceId],
      )).rows[0].n;
      if (owners <= 1) {
        await this.audit({
          user_id: session.user_id, session_id: session.session_id, workspace_id: workspaceId,
          action: 'member.role', outcome: 'deny', reason: 'last_owner',
        });
        throw forbidden('last_owner', 'a workspace must keep at least one owner');
      }
    }
    await this.db.query(
      'UPDATE id.workspace_memberships SET role = $3 WHERE workspace_id = $1 AND user_id = $2 AND revoked_at IS NULL',
      [workspaceId, userId, role],
    );
    await this.audit({
      user_id: session.user_id, session_id: session.session_id, workspace_id: workspaceId,
      action: 'member.role', outcome: 'allow', detail: { user: userId, role },
    });
    return { userId, role };
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
