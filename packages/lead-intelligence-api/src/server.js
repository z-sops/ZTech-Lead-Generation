'use strict';

const http = require('node:http');
const { URL } = require('node:url');
const { Throttle, ROLES, MATRIX, PERMISSIONS } = require('./security');
const { AuthService, ServiceError } = require('./service');

const SESSION_COOKIE = 'ztech_session';
const CSRF_HEADER = 'x-csrf-token';

/**
 * The HTTP surface of the service.
 *
 * The rules it holds to:
 *
 *   - the session is a cookie, HttpOnly and SameSite=Strict, and the
 *     token is NEVER in a response body;
 *   - a state-changing request must carry the CSRF token the session was
 *     issued;
 *   - the authorization is the MEMBERSHIP, not the shared database role;
 *   - the workspace comes from the request path and is checked against
 *     the membership - a client cannot name a workspace it does not
 *     belong to and have it honoured;
 *   - the login is throttled, and the suppression check is throttled too;
 *   - every authorization decision is audited.
 */
class ApiServer {
  constructor({ identity, tenant, storeFor, logger = console, secureCookies = false, trustedProxyHops = 0, platformConsole = false } = {}) {
    this.service = new AuthService({ identity, tenant, logger, platformConsole });
    /**
     * Whether this server is the platform console. It is a MARKER, and it
     * is NOT an authorization: a configuration flag is not an
     * authentication, and nothing here is reachable because of it.
     */
    this.platformConsole = platformConsole;
    this.storeFor = storeFor;
    this.logger = logger;
    this.secureCookies = secureCookies;
    this.trustedProxyHops = Number(trustedProxyHops) || 0;
    this.loginThrottle = new Throttle({ limit: 5, windowMs: 15 * 60 * 1000 });
    this.suppressionThrottle = new Throttle({ limit: 30, windowMs: 60 * 1000 });
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => this.fail(res, err));
    });
  }

  /**
   * The address of the caller, for the throttles.
   *
   * It is the CONNECTION's address. A proxy header - `X-Forwarded-For` and
   * its relatives - is written by the client, so it is not evidence of
   * anything: a forged one would let an attacker spread the failures over
   * a thousand fake addresses, and would hide the spray.
   *
   * Behind a proxy the connection's address is the proxy's, so the
   * deployment says how many proxies it trusts: the address is then taken
   * from the rightmost UNTRUSTED hop. With the default of zero, no header
   * is believed at all.
   */
  callerAddress(req) {
    const socket = req.socket.remoteAddress || '';
    if (!this.trustedProxyHops) return socket;
    const header = req.headers['x-forwarded-for'];
    if (!header) return socket;
    const hops = String(header).split(',').map((h) => h.trim()).filter(Boolean);
    if (hops.length < this.trustedProxyHops) return socket;
    return hops[hops.length - this.trustedProxyHops];
  }

  listen(port, host = '127.0.0.1') {
    return new Promise((resolve) => {
      this.server.listen(port, host, () => resolve(this.server.address()));
    });
  }

  close() {
    return new Promise((resolve) => this.server.close(resolve));
  }

  /* ------------------------------ the plumbing ------------------------------ */

  async body(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 64 * 1024) throw new ServiceError(413, 'body_too_large', 'the request body is too large');
      chunks.push(chunk);
    }
    if (!chunks.length) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new ServiceError(400, 'invalid_json', 'the request body is not JSON');
    }
  }

  cookies(req) {
    const header = req.headers.cookie || '';
    const out = {};
    for (const part of header.split(';')) {
      const index = part.indexOf('=');
      if (index < 0) continue;
      out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
    }
    return out;
  }

  json(res, status, payload, headers = {}) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      ...headers,
    });
    res.end(body);
  }

  fail(res, err) {
    if (res.headersSent) { res.end(); return; }
    if (err instanceof ServiceError) {
      this.json(res, err.status, { error: err.code, message: err.message });
      return;
    }
    this.logger.error(`unhandled: ${err.stack || err.message}`);
    this.json(res, 500, { error: 'internal_error', message: 'something went wrong' });
  }

  /** The session behind the cookie, or null. */
  async session(req) {
    const token = this.cookies(req)[SESSION_COOKIE];
    if (!token) return null;
    return this.service.sessionFor(token);
  }

  /** The session, or a 401. */
  async requireSession(req, res) {
    const session = await this.session(req);
    if (!session) {
      this.json(res, 401, { error: 'not_authenticated', message: 'log in first' });
      return null;
    }
    return session;
  }

  /** The CSRF token of a state-changing request. */
  async requireCsrf(req, res, session) {
    const token = req.headers[CSRF_HEADER];
    if (!this.service.csrfMatches(session, token)) {
      await this.service.audit({
        user_id: session.user_id, session_id: session.session_id,
        action: 'csrf', outcome: 'deny', reason: 'csrf_mismatch',
      });
      this.json(res, 403, { error: 'csrf_failed', message: 'the request could not be verified' });
      return false;
    }
    return true;
  }

  /** The cookie header for a session token. */
  sessionCookie(token, maxAgeSeconds) {
    const parts = [
      `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
      'Path=/', 'HttpOnly', 'SameSite=Strict',
      `Max-Age=${maxAgeSeconds}`,
    ];
    if (this.secureCookies) parts.push('Secure');
    return parts.join('; ');
  }

  /* -------------------------------- the routes ------------------------------- */

  async handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    const method = req.method;

    if (path === '/api/health') {
      this.json(res, 200, { ok: true, roles: ROLES, permissions: PERMISSIONS });
      return;
    }
    if (path === '/api/auth/register' && method === 'POST') return this.register(req, res);
    if (path === '/api/auth/login' && method === 'POST') return this.login(req, res);
    if (path === '/api/auth/logout' && method === 'POST') return this.logout(req, res);
    if (path === '/api/session' && method === 'GET') return this.sessionInfo(req, res);
    if (path === '/api/organizations' && method === 'POST') return this.createOrganization(req, res);
    if (path === '/api/invitations/accept' && method === 'POST') return this.acceptInvitation(req, res);

    const members = path.match(/^\/api\/workspaces\/([0-9a-f-]+)\/members(?:\/([0-9a-f-]+))?$/i);
    if (members) return this.members(req, res, members[1], members[2]);

    const invites = path.match(/^\/api\/workspaces\/([0-9a-f-]+)\/invitations$/i);
    if (invites && method === 'POST') return this.invite(req, res, invites[1]);

    const workspaces = path.match(/^\/api\/organizations\/([0-9a-f-]+)\/workspaces$/i);
    if (workspaces && method === 'POST') return this.createWorkspace(req, res, workspaces[1]);

    const checks = path.match(/^\/api\/workspaces\/([0-9a-f-]+)\/suppressions\/check$/i);
    if (checks && method === 'POST') return this.suppressionCheck(req, res, checks[1]);

    // THERE IS NO ACCOUNT-SUSPENSION ROUTE. Not on the customer API and
    // not on a platform-console configuration either: a configuration flag
    // is not an authentication, and until there is an independent
    // platform-operator authentication there is no way to reach a
    // suspension from HTTP at all. An account is suspended by a privileged
    // database operation, and the enforcement of a suspension is in
    // sessionFor() and in the database's entitlement check.

    const records = path.match(/^\/api\/workspaces\/([0-9a-f-]+)\/records$/i);
    if (records && method === 'GET') return this.records(req, res, records[1]);

    this.json(res, 404, { error: 'not_found', message: 'there is nothing here' });
  }

  async register(req, res) {
    const body = await this.body(req);
    const result = await this.service.register(body);
    this.json(res, 201, {
      user_id: result.userId, organization_id: result.orgId, workspace_id: result.workspaceId,
      csrf_token: result.csrf,
    }, { 'set-cookie': this.sessionCookie(result.token, 12 * 60 * 60) });
  }

  async login(req, res) {
    const body = await this.body(req);
    const address = this.callerAddress(req);
    const result = await this.service.login({
      email: body.email, password: body.password, throttle: this.loginThrottle, address,
    });
    this.json(res, 200, { user_id: result.userId, csrf_token: result.csrf }, {
      'set-cookie': this.sessionCookie(result.token, 12 * 60 * 60),
    });
  }

  async logout(req, res) {
    const session = await this.requireSession(req, res);
    if (!session) return;
    if (!await this.requireCsrf(req, res, session)) return;
    await this.service.logout(session);
    this.json(res, 200, { ok: true }, { 'set-cookie': this.sessionCookie('', 0) });
  }

  async sessionInfo(req, res) {
    const session = await this.requireSession(req, res);
    if (!session) return;
    const memberships = await this.service.membershipsOf(session.user_id);
    this.json(res, 200, {
      user_id: session.user_id, email: session.email, memberships,
    });
  }

  async createOrganization(req, res) {
    const session = await this.requireSession(req, res);
    if (!session) return;
    if (!await this.requireCsrf(req, res, session)) return;
    const org = await this.service.createOrganization(session, await this.body(req));
    this.json(res, 201, org);
  }

  async createWorkspace(req, res, orgId) {
    const session = await this.requireSession(req, res);
    if (!session) return;
    if (!await this.requireCsrf(req, res, session)) return;
    const workspace = await this.service.createWorkspace(session, { orgId, ...(await this.body(req)) });
    this.json(res, 201, workspace);
  }

  async invite(req, res, workspaceId) {
    const session = await this.requireSession(req, res);
    if (!session) return;
    if (!await this.requireCsrf(req, res, session)) return;
    const invitation = await this.service.invite(session, { workspaceId, ...(await this.body(req)) });
    this.json(res, 201, {
      invitation_id: invitation.invitationId, email: invitation.email, role: invitation.role,
      expires_at: invitation.expiresAt, token: invitation.token,
    });
  }

  async acceptInvitation(req, res) {
    const session = await this.requireSession(req, res);
    if (!session) return;
    if (!await this.requireCsrf(req, res, session)) return;
    const body = await this.body(req);
    const accepted = await this.service.acceptInvitation(session, { token: body.token });
    this.json(res, 200, accepted);
  }

  async members(req, res, workspaceId, userId) {
    const session = await this.requireSession(req, res);
    if (!session) return;
    if (req.method === 'GET') {
      const list = await this.service.listMembers(session, { workspaceId });
      this.json(res, 200, { members: list });
      return;
    }
    if (req.method === 'DELETE' && userId) {
      if (!await this.requireCsrf(req, res, session)) return;
      const removed = await this.service.removeMember(session, { workspaceId, userId });
      this.json(res, 200, removed);
      return;
    }
    if (req.method === 'PATCH' && userId) {
      if (!await this.requireCsrf(req, res, session)) return;
      const body = await this.body(req);
      const changed = await this.service.changeRole(session, { workspaceId, userId, role: body.role });
      this.json(res, 200, changed);
      return;
    }
    this.json(res, 405, { error: 'method_not_allowed', message: 'not that way' });
  }

  /**
   * The suppression check: authenticated, authorized, and rate-limited.
   *
   * The answer is a boolean, never a row, and never an address.
   */
  async suppressionCheck(req, res, workspaceId) {
    const session = await this.requireSession(req, res);
    if (!session) return;
    if (!await this.requireCsrf(req, res, session)) return;
    const key = `${session.session_id}`;
    if (this.suppressionThrottle.blocked(key)) {
      this.json(res, 429, { error: 'too_many_requests', message: 'slow down' });
      return;
    }
    await this.service.authorize(session, workspaceId, 'suppression.check');
    const body = await this.body(req);
    const store = await this.storeFor(session, workspaceId);
    // The check runs INSIDE a transaction that carries the workspace
    // context: the context is bound to THIS session and to THIS user, and
    // the database re-checks the session's entitlement on every read. A
    // logout, a withdrawn membership or a revoked session therefore stops
    // the check, even in a transaction that was already open.
    const suppressed = await store.tx(async () => store.isSuppressed(body.channel, body.address));
    this.suppressionThrottle.fail(key);
    this.json(res, 200, { suppressed: Boolean(suppressed) });
  }

  /**
   * The tenant's records, through the store, with a token that is bound to
   * THIS session.
   */
  async records(req, res, workspaceId) {
    const session = await this.requireSession(req, res);
    if (!session) return;
    await this.service.authorize(session, workspaceId, 'workspace.read');
    const store = await this.storeFor(session, workspaceId);
    const records = await store.savedSearches.list();
    this.json(res, 200, { records });
  }
}

module.exports = { ApiServer, SESSION_COOKIE, CSRF_HEADER };
