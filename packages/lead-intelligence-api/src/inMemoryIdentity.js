'use strict';

/**
 * InMemoryIdentityPool
 *
 * NON-SECURITY-CONFORMANCE TEST ADAPTER ONLY.
 *
 * Implements the pg.Pool query and connection interface required by AuthService,
 * storing users, organizations, workspaces, memberships, sessions, and audits
 * in memory. Enables complete standalone demonstration and testing when a live
 * PostgreSQL 16 cluster is not active.
 *
 * IMPORTANT SECURITY BOUNDARY NOTICE:
 * This adapter is strictly for local demo mode and non-security-conformance unit
 * testing. It is NOT equivalent to PostgreSQL transactional security or PostgreSQL 16
 * Row-Level Security (RLS). It does not provide multi-connection MVCC, serialized
 * snapshot isolation, or cluster-level role separation. Only real PostgreSQL tests
 * (e.g. tests/api/integrity.test.js and tests/persistence-contract/*) establish
 * M3 transaction and RLS security guarantees.
 */
class InMemoryIdentityPool {
  constructor() {
    this.users = new Map();             // userId -> user
    this.organizations = new Map();     // orgId -> org
    this.workspaces = new Map();        // wsId -> ws
    this.orgMemberships = new Map();    // id -> membership
    this.wsMemberships = new Map();     // id -> membership
    this.sessions = new Map();          // sessionId -> session
    this.invitations = new Map();       // invitationId -> invite
    this.audit = [];
  }

  async connect() {
    let inTransaction = false;
    const undoStack = [];

    return {
      query: async (sql, params = []) => {
        const s = String(sql).trim();

        if (/^BEGIN/i.test(s)) {
          inTransaction = true;
          undoStack.length = 0;
          return { rows: [], rowCount: 0 };
        }

        if (/^COMMIT/i.test(s)) {
          inTransaction = false;
          undoStack.length = 0;
          return { rows: [], rowCount: 0 };
        }

        if (/^ROLLBACK/i.test(s)) {
          inTransaction = false;
          while (undoStack.length > 0) {
            const undo = undoStack.pop();
            try { undo(); } catch {}
          }
          return { rows: [], rowCount: 0 };
        }

        return this._execute(sql, params, inTransaction ? undoStack : null);
      },
      release: () => {
        if (inTransaction) {
          while (undoStack.length > 0) {
            const undo = undoStack.pop();
            try { undo(); } catch {}
          }
          inTransaction = false;
        }
      },
    };
  }

  async query(sql, params = []) {
    return this._execute(sql, params, null);
  }

  _execute(sql, params = [], undoStack = null) {
    const s = String(sql).trim();

    // 1. Transaction markers on direct pool (handled gracefully)
    if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(s)) {
      return { rows: [], rowCount: 0 };
    }

    // 2. Grant workspace ceiling (noop in memory)
    if (/SELECT\s+li\.grant_workspace/i.test(s)) {
      return { rows: [{ grant_workspace: true }], rowCount: 1 };
    }

    // 3. User operations
    if (/SELECT \* FROM id\.users WHERE lower\(email\) = lower\(\$1\)/i.test(s)) {
      const email = String(params[0] || '').toLowerCase().trim();
      for (const u of this.users.values()) {
        if (u.email.toLowerCase() === email) return { rows: [u], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    if (/SELECT \* FROM id\.users WHERE user_id = \$1/i.test(s)) {
      const u = this.users.get(params[0]);
      return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
    }

    if (/INSERT INTO id\.users/i.test(s)) {
      const [userId, email, passwordHash, displayName] = params;
      const user = {
        user_id: userId,
        email,
        password_hash: passwordHash,
        display_name: displayName || null,
        disabled_at: null,
        created_at: new Date().toISOString(),
      };
      this.users.set(userId, user);
      if (undoStack) undoStack.push(() => this.users.delete(userId));
      return { rows: [user], rowCount: 1 };
    }

    // 4. Organization operations
    if (/INSERT INTO id\.organizations/i.test(s)) {
      const [orgId, name, slug] = params;
      const org = { org_id: orgId, name, slug, created_at: new Date().toISOString() };
      this.organizations.set(orgId, org);
      if (undoStack) undoStack.push(() => this.organizations.delete(orgId));
      return { rows: [org], rowCount: 1 };
    }

    if (/SELECT role FROM id\.organization_memberships WHERE org_id = \$1 AND user_id = \$2/i.test(s)) {
      const [orgId, userId] = params;
      for (const m of this.orgMemberships.values()) {
        if (m.org_id === orgId && m.user_id === userId && !m.revoked_at) {
          return { rows: [{ role: m.role }], rowCount: 1 };
        }
      }
      return { rows: [], rowCount: 0 };
    }

    if (/INSERT INTO id\.organization_memberships/i.test(s)) {
      const [membershipId, orgId, userId] = params;
      let role = params[3];
      if (!role) {
        const match = s.match(/'(owner|admin|manager|member|viewer)'/i);
        if (match) role = match[1].toLowerCase();
      }
      const m = { membership_id: membershipId, org_id: orgId, user_id: userId, role: role || 'member', revoked_at: null };
      this.orgMemberships.set(membershipId, m);
      if (undoStack) undoStack.push(() => this.orgMemberships.delete(membershipId));
      return { rows: [m], rowCount: 1 };
    }

    // 5. Workspace operations
    if (/INSERT INTO id\.workspaces/i.test(s)) {
      const [workspaceId, orgId, name] = params;
      const ws = { workspace_id: workspaceId, org_id: orgId, name, created_at: new Date().toISOString() };
      this.workspaces.set(workspaceId, ws);
      if (undoStack) undoStack.push(() => this.workspaces.delete(workspaceId));
      return { rows: [ws], rowCount: 1 };
    }

    if (/SELECT workspace_id, org_id, name FROM id\.workspaces WHERE org_id = \$1/i.test(s)) {
      const [orgId] = params;
      const rows = [];
      for (const ws of this.workspaces.values()) {
        if (ws.org_id === orgId) rows.push(ws);
      }
      return { rows, rowCount: rows.length };
    }

    // 6. Workspace Memberships
    if (/INSERT INTO id\.workspace_memberships/i.test(s)) {
      const [membershipId, workspaceId, userId] = params;
      let role = params[3];
      if (!role) {
        const match = s.match(/'(owner|admin|manager|member|viewer)'/i);
        if (match) role = match[1].toLowerCase();
      }
      const m = {
        membership_id: membershipId,
        workspace_id: workspaceId,
        user_id: userId,
        role: role || 'member',
        team_id: null,
        revoked_at: null,
      };
      this.wsMemberships.set(membershipId, m);
      if (undoStack) undoStack.push(() => this.wsMemberships.delete(membershipId));
      return { rows: [m], rowCount: 1 };
    }

    if (/SELECT m\.user_id, m\.role, m\.team_id FROM id\.workspace_memberships m\s+WHERE m\.workspace_id = \$1/i.test(s)) {
      const [workspaceId] = params;
      const rows = [];
      for (const m of this.wsMemberships.values()) {
        if (m.workspace_id === workspaceId && !m.revoked_at) {
          rows.push({ user_id: m.user_id, role: m.role, team_id: m.team_id });
        }
      }
      return { rows, rowCount: rows.length };
    }

    if (/SELECT membership_id, workspace_id, user_id, role, team_id\s+FROM id\.workspace_memberships\s+WHERE workspace_id = \$1 AND user_id = \$2/i.test(s)) {
      const [workspaceId, userId] = params;
      for (const m of this.wsMemberships.values()) {
        if (m.workspace_id === workspaceId && m.user_id === userId && !m.revoked_at) {
          return { rows: [m], rowCount: 1 };
        }
      }
      return { rows: [], rowCount: 0 };
    }

    if (/FROM id\.workspace_memberships m\s+JOIN id\.workspaces w ON w\.workspace_id = m\.workspace_id\s+JOIN id\.organizations o ON o\.org_id = w\.org_id\s+WHERE m\.user_id = \$1/i.test(s)) {
      const [userId] = params;
      const rows = [];
      for (const m of this.wsMemberships.values()) {
        if (m.user_id === userId && !m.revoked_at) {
          const ws = this.workspaces.get(m.workspace_id);
          const org = ws ? this.organizations.get(ws.org_id) : null;
          rows.push({
            membership_id: m.membership_id,
            workspace_id: m.workspace_id,
            role: m.role,
            team_id: m.team_id,
            workspace_name: ws ? ws.name : 'Workspace',
            org_id: ws ? ws.org_id : null,
            organization_name: org ? org.name : 'Organization',
          });
        }
      }
      return { rows, rowCount: rows.length };
    }

    // 7. Session operations
    if (/SELECT s\.session_id, s\.user_id, s\.csrf_hash, s\.expires_at, s\.revoked_at, u\.email/i.test(s)) {
      const tokenHash = params[0];
      for (const sess of this.sessions.values()) {
        if (sess.token_hash === tokenHash) {
          const u = this.users.get(sess.user_id);
          if (u && !u.disabled_at && !sess.revoked_at && new Date(sess.expires_at) > new Date()) {
            return {
              rows: [{
                session_id: sess.session_id,
                user_id: sess.user_id,
                csrf_hash: sess.csrf_hash,
                expires_at: sess.expires_at,
                revoked_at: sess.revoked_at,
                email: u.email,
              }],
              rowCount: 1,
            };
          }
        }
      }
      return { rows: [], rowCount: 0 };
    }

    if (/INSERT INTO id\.sessions/i.test(s)) {
      const [sessionId, userId, tokenHash, csrfHash, expiresAt] = params;
      const sess = {
        session_id: sessionId,
        user_id: userId,
        token_hash: tokenHash,
        csrf_hash: csrfHash,
        expires_at: expiresAt,
        revoked_at: null,
        created_at: new Date().toISOString(),
      };
      this.sessions.set(sessionId, sess);
      if (undoStack) undoStack.push(() => this.sessions.delete(sessionId));
      return { rows: [sess], rowCount: 1 };
    }

    if (/UPDATE id\.sessions SET last_seen_at = now\(\) WHERE session_id = \$1/i.test(s)) {
      const sess = this.sessions.get(params[0]);
      if (sess) sess.last_seen_at = new Date().toISOString();
      return { rows: [], rowCount: sess ? 1 : 0 };
    }

    if (/UPDATE id\.sessions SET revoked_at = now\(\) WHERE session_id = \$1/i.test(s)) {
      const sess = this.sessions.get(params[0]);
      if (sess && !sess.revoked_at) {
        const prev = sess.revoked_at;
        sess.revoked_at = new Date().toISOString();
        if (undoStack) undoStack.push(() => { sess.revoked_at = prev; });
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    // 8. Audits
    if (/INSERT INTO id\.authorization_audit/i.test(s)) {
      this.audit.push({
        entry: params,
        at: new Date().toISOString(),
      });
      return { rows: [], rowCount: 1 };
    }

    // Fallback for unhandled queries
    return { rows: [], rowCount: 0 };
  }
}

module.exports = { InMemoryIdentityPool };
