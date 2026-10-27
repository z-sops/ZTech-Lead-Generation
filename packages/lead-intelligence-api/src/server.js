'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const { Throttle, ROLES, PERMISSIONS, newId } = require('./security');
const { AuthService, ServiceError } = require('./service');
const { InMemoryIdentityPool } = require('./inMemoryIdentity');
const { InMemoryStoreForApi } = require('./inMemoryStore');
const { executeResearchDiscovery, prepareOutreachDraft } = require('./researchEngine');

const SESSION_COOKIE = 'ztech_session';
const CSRF_HEADER = 'x-csrf-token';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

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
  constructor({
    identity,
    tenant,
    storeFor,
    logger = console,
    secureCookies = false,
    trustedProxyHops = 0,
    platformConsole = false,
    staticDir = null,
    mode = null,
    allowDemoAutologin = false,
    demoEmail = 'alice@ztech.test',
  } = {}) {
    const isProduction = process.env.NODE_ENV === 'production' || process.env.ZTECH_ENV === 'production';
    const requestedMode = mode || process.env.ZTECH_STORAGE_MODE;

    if (isProduction) {
      this.mode = 'production';
      if (!identity || identity instanceof InMemoryIdentityPool) {
        throw new Error('Production mode requires PostgreSQL persistent storage and secure configuration');
      }
      if (allowDemoAutologin) {
        throw new Error('Demo auto-login is strictly prohibited in production mode');
      }
    } else if (requestedMode === 'postgres' || process.env.ZTECH_PG_URL) {
      this.mode = 'postgres';
    } else {
      this.mode = 'local-demo';
    }

    const idPool = identity || new InMemoryIdentityPool();
    this.service = new AuthService({ identity: idPool, tenant, logger, platformConsole });
    /**
     * Whether this server is the platform console. It is a MARKER, and it
     * is NOT an authorization: a configuration flag is not an
     * authentication, and nothing here is reachable because of it.
     */
    this.platformConsole = platformConsole;
    this.storeFor = storeFor || (async (session, workspaceId) => new InMemoryStoreForApi({
      workspaceId,
      sessionId: session?.session_id,
      userId: session?.user_id,
    }));
    this.logger = logger;
    this.secureCookies = secureCookies;
    this.trustedProxyHops = Number(trustedProxyHops) || 0;
    this.staticDir = staticDir ? path.resolve(staticDir) : null;
    this.allowDemoAutologin = Boolean(allowDemoAutologin);
    this.demoEmail = demoEmail;
    this.loginThrottle = new Throttle({ limit: 5, windowMs: 15 * 60 * 1000 });
    this.suppressionThrottle = new Throttle({ limit: 30, windowMs: 60 * 1000 });
    this.activeCandidatesByWorkspace = new Map();
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
    return new Promise((resolve) => {
      this.server.close(resolve);
    });
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
    const pathName = url.pathname;
    const method = req.method;

    if (pathName === '/api/health') {
      this.json(res, 200, {
        ok: true,
        storage_mode: this.mode,
        ephemeral: this.mode === 'local-demo',
        roles: ROLES,
        permissions: PERMISSIONS,
      });
      return;
    }
    if (pathName === '/api/auth/register' && method === 'POST') return this.register(req, res);
    if (pathName === '/api/auth/login' && method === 'POST') return this.login(req, res);
    if (pathName === '/api/auth/demo-login' && method === 'POST') return this.demoLogin(req, res);
    if (pathName === '/api/auth/logout' && method === 'POST') return this.logout(req, res);
    if (pathName === '/api/session' && method === 'GET') return this.sessionInfo(req, res);
    if (pathName === '/api/organizations' && method === 'POST') return this.createOrganization(req, res);
    if (pathName === '/api/invitations/accept' && method === 'POST') return this.acceptInvitation(req, res);

    const members = pathName.match(/^\/api\/workspaces\/([0-9a-f-]+)\/members(?:\/([0-9a-f-]+))?$/i);
    if (members) return this.members(req, res, members[1], members[2]);

    const invites = pathName.match(/^\/api\/workspaces\/([0-9a-f-]+)\/invitations$/i);
    if (invites && method === 'POST') return this.invite(req, res, invites[1]);

    const workspaces = pathName.match(/^\/api\/organizations\/([0-9a-f-]+)\/workspaces$/i);
    if (workspaces && method === 'POST') return this.createWorkspace(req, res, workspaces[1]);

    const checks = pathName.match(/^\/api\/workspaces\/([0-9a-f-]+)\/suppressions\/check$/i);
    if (checks && method === 'POST') return this.suppressionCheck(req, res, checks[1]);

    const records = pathName.match(/^\/api\/workspaces\/([0-9a-f-]+)\/records$/i);
    if (records && method === 'GET') return this.records(req, res, records[1]);

    // Research Discovery Endpoints
    const researchReq = pathName.match(/^\/api\/workspaces\/([0-9a-f-]+)\/research$/i);
    if (researchReq && method === 'POST') return this.createResearch(req, res, researchReq[1]);
    if (researchReq && method === 'GET') return this.listResearch(req, res, researchReq[1]);

    // Async research-job endpoints (registered before the generic
    // /research/:id route so /research/jobs is not mistaken for a job id).
    const researchJobs = pathName.match(/^\/api\/workspaces\/([0-9a-f-]+)\/research\/jobs$/i);
    if (researchJobs && method === 'POST') return this.enqueueResearchJob(req, res, researchJobs[1]);
    if (researchJobs && method === 'GET') return this.listResearchJobs(req, res, researchJobs[1]);

    const researchJobCancel = pathName.match(/^\/api\/workspaces\/([0-9a-f-]+)\/research\/jobs\/([a-zA-Z0-9_-]+)\/cancel$/i);
    if (researchJobCancel && method === 'POST') return this.cancelResearchJob(req, res, researchJobCancel[1], researchJobCancel[2]);

    const researchJobDetail = pathName.match(/^\/api\/workspaces\/([0-9a-f-]+)\/research\/jobs\/([a-zA-Z0-9_-]+)$/i);
    if (researchJobDetail && method === 'GET') return this.getResearchJob(req, res, researchJobDetail[1], researchJobDetail[2]);

    const researchJob = pathName.match(/^\/api\/workspaces\/([0-9a-f-]+)\/research\/([a-zA-Z0-9_-]+)$/i);
    if (researchJob && method === 'GET') return this.getResearch(req, res, researchJob[1], researchJob[2]);

    // Opportunities Endpoints
    const candidates = pathName.match(/^\/api\/workspaces\/([0-9a-f-]+)\/opportunities\/candidates$/i);
    if (candidates && method === 'GET') return this.opportunityCandidates(req, res, candidates[1]);

    const saveOpp = pathName.match(/^\/api\/workspaces\/([0-9a-f-]+)\/opportunities(?:\/([a-zA-Z0-9_-]+))?\/save$/i);
    if (saveOpp && method === 'POST') return this.saveOpportunity(req, res, saveOpp[1], saveOpp[2]);

    const savedOpps = pathName.match(/^\/api\/workspaces\/([0-9a-f-]+)\/opportunities\/saved$/i);
    if (savedOpps && method === 'GET') return this.listSavedOpportunities(req, res, savedOpps[1]);

    // Outreach Preparation & Safety Gate Endpoints
    const prepareOutreach = pathName.match(/^\/api\/workspaces\/([0-9a-f-]+)\/outreach\/prepare$/i);
    if (prepareOutreach && method === 'POST') return this.prepareOutreach(req, res, prepareOutreach[1]);

    const approveOutreach = pathName.match(/^\/api\/workspaces\/([0-9a-f-]+)\/outreach\/approve$/i);
    if (approveOutreach && method === 'POST') return this.approveOutreach(req, res, approveOutreach[1]);

    // Static Assets for Browser SaaS Dashboard
    if (this.staticDir && method === 'GET' && !pathName.startsWith('/api/')) {
      return this.serveStatic(req, res, pathName);
    }

    this.json(res, 404, { error: 'not_found', message: 'there is nothing here' });
  }

  serveStatic(req, res, requestPath) {
    let cleanPath = requestPath === '/' ? '/index.html' : requestPath;
    cleanPath = path.normalize(cleanPath).replace(/^(\.\.[/\\])+/, '');
    let filePath = path.join(this.staticDir, cleanPath);

    // Prevent directory traversal
    if (!filePath.startsWith(this.staticDir)) {
      this.json(res, 403, { error: 'forbidden', message: 'access denied' });
      return;
    }

    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(this.staticDir, 'index.html');
      if (!fs.existsSync(filePath)) {
        this.json(res, 404, { error: 'not_found', message: 'file not found' });
        return;
      }
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    try {
      const content = fs.readFileSync(filePath);
      res.writeHead(200, {
        'content-type': contentType,
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
      });
      res.end(content);
    } catch (err) {
      this.fail(res, err);
    }
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

  async demoLogin(req, res) {
    if (this.mode === 'production' || process.env.NODE_ENV === 'production') {
      this.json(res, 403, { error: 'forbidden', message: 'Demo auto-login is forbidden in production mode' });
      return;
    }
    if (!this.allowDemoAutologin) {
      this.json(res, 403, { error: 'forbidden', message: 'Demo auto-login is disabled. Explicit local configuration is required.' });
      return;
    }
    const caller = this.callerAddress(req);
    const isLoopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(caller) || !caller;
    if (!isLoopback) {
      this.json(res, 403, { error: 'forbidden', message: 'Demo auto-login is restricted to loopback connections.' });
      return;
    }
    const demoEmail = this.demoEmail || 'alice@ztech.test';
    const user = await this.service.findUserByEmail(demoEmail);
    if (!user) {
      this.json(res, 404, { error: 'demo_user_not_found', message: 'Demo user is not provisioned.' });
      return;
    }
    const issued = await this.service.issueSession(user.user_id);
    await this.service.audit({ user_id: user.user_id, session_id: issued.sessionId, action: 'auth.demo_login', outcome: 'allow' });
    this.json(res, 200, {
      ok: true,
      user_id: user.user_id,
      csrf_token: issued.csrf,
      email: user.email,
      storage_mode: this.mode,
      ephemeral: this.mode === 'local-demo',
    }, {
      'set-cookie': this.sessionCookie(issued.token, 12 * 60 * 60),
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
      user_id: session.user_id,
      email: session.email,
      memberships,
      storage_mode: this.mode,
      ephemeral: this.mode === 'local-demo',
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
    const suppressed = await store.tx(async () => store.isSuppressed(body.channel, body.address));
    this.suppressionThrottle.fail(key);
    this.json(res, 200, { suppressed: Boolean(suppressed) });
  }

  async records(req, res, workspaceId) {
    const session = await this.requireSession(req, res);
    if (!session) return;
    await this.service.authorize(session, workspaceId, 'workspace.read');
    const store = await this.storeFor(session, workspaceId);
    const records = await store.savedSearches.list();
    this.json(res, 200, { records });
  }

  /* ------------------- Research & Opportunity Intelligence ------------------ */

  async createResearch(req, res, workspaceId) {
    const session = await this.requireSession(req, res);
    if (!session) return;
    if (!await this.requireCsrf(req, res, session)) return;
    await this.service.authorize(session, workspaceId, 'workspace.write');

    const body = await this.body(req);
    const store = await this.storeFor(session, workspaceId);
    const discoveryResult = await executeResearchDiscovery({
      workspaceId,
      criteria: body,
      store,
      userId: session.user_id,
    });

    this.activeCandidatesByWorkspace.set(workspaceId, discoveryResult.candidates);
    this.json(res, 201, discoveryResult);
  }

  async listResearch(req, res, workspaceId) {
    const session = await this.requireSession(req, res);
    if (!session) return;
    await this.service.authorize(session, workspaceId, 'workspace.read');

    const store = await this.storeFor(session, workspaceId);
    const jobs = await store.jobs.list();
    this.json(res, 200, {
      workspace_id: workspaceId,
      jobs: jobs.map((j) => ({
        job_id: j.job_id,
        state: j.state,
        created_at: j.created_at,
        finished_at: j.finished_at,
        candidate_count: j.options?.candidate_count || j.options?.candidates?.length || 0,
        industry: j.options?.industry || j.requested_domain,
        requirements: j.options?.businessRequirements,
        packet_id: j.packet_id,
      })),
    });
  }

  async getResearch(req, res, workspaceId, jobId) {
    const session = await this.requireSession(req, res);
    if (!session) return;
    await this.service.authorize(session, workspaceId, 'workspace.read');

    const store = await this.storeFor(session, workspaceId);
    const job = await store.jobs.get(jobId);
    if (!job) {
      this.json(res, 404, { error: 'not_found', message: `research job "${jobId}" not found` });
      return;
    }

    let packetMeta = null;
    if (job.packet_id) {
      const packet = await store.packets.get(job.packet_id);
      if (packet) {
        packetMeta = {
          packet_id: packet.packet_id,
          captured_at: packet.captured_at,
          research_status: packet.research_status,
          facts_count: packet.facts?.length || 0,
          findings_count: packet.findings?.length || 0,
        };
      }
    }

    this.json(res, 200, {
      job,
      packet_meta: packetMeta,
      candidates: job.options?.candidates || [],
    });
  }

  async enqueueResearchJob(req, res, workspaceId) {
    const session = await this.requireSession(req, res);
    if (!session) return;
    if (!await this.requireCsrf(req, res, session)) return;
    await this.service.authorize(session, workspaceId, 'workspace.write');

    const body = await this.body(req);
    const idempotencyKey = body && body.idempotency_key;
    if (!idempotencyKey || typeof idempotencyKey !== 'string' || idempotencyKey.length < 1 || idempotencyKey.length > 200) {
      this.json(res, 400, { error: 'invalid_idempotency_key', message: 'the idempotency key must be 1 to 200 characters' });
      return;
    }
    const payload = body && body.payload !== undefined ? body.payload : {};
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      this.json(res, 400, { error: 'invalid_payload', message: 'the payload must be a JSON object' });
      return;
    }
    if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > 16384) {
      this.json(res, 400, { error: 'payload_too_large', message: 'the payload is larger than 16 KiB' });
      return;
    }
    const store = await this.storeFor(session, workspaceId);
    const result = await store.tx(async () => store.researchJobs.enqueue({
      jobId: newId(),
      jobType: 'research',
      idempotencyKey,
      payload,
    }));

    this.json(res, 202, {
      job_id: result.job_id,
      workspace_id: workspaceId,
      job_type: result.job_type,
      state: result.state,
      idempotency_key: result.idempotency_key,
      created_at: result.created_at,
      deduplicated: Boolean(result.deduplicated),
    });
  }

  async listResearchJobs(req, res, workspaceId) {
    const session = await this.requireSession(req, res);
    if (!session) return;
    await this.service.authorize(session, workspaceId, 'workspace.read');

    const url = new URL(req.url, 'http://localhost');
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 50), 1), 1000);
    const store = await this.storeFor(session, workspaceId);
    const jobs = await store.tx(async () => store.researchJobs.list({ limit }));

    this.json(res, 200, {
      workspace_id: workspaceId,
      jobs: jobs.map((j) => ({
        job_id: j.job_id, state: j.state, created_at: j.created_at,
        started_at: j.started_at, finished_at: j.finished_at,
        cancel_requested_at: j.cancel_requested_at,
        attempt_count: j.attempt_count, last_error: j.last_error,
        idempotency_key: j.idempotency_key, job_type: j.job_type,
      })),
    });
  }

  async getResearchJob(req, res, workspaceId, jobId) {
    const session = await this.requireSession(req, res);
    if (!session) return;
    await this.service.authorize(session, workspaceId, 'workspace.read');

    const store = await this.storeFor(session, workspaceId);
    let job = null;
    try {
      job = await store.tx(async () => store.researchJobs.get({ jobId }));
    } catch (err) {
      if (err.code === '22P02') {
        this.json(res, 404, { error: 'not_found', message: `research job "${jobId}" not found` });
        return;
      }
      throw err;
    }
    if (!job) {
      this.json(res, 404, { error: 'not_found', message: `research job "${jobId}" not found` });
      return;
    }

    this.json(res, 200, { job });
  }

  async cancelResearchJob(req, res, workspaceId, jobId) {
    const session = await this.requireSession(req, res);
    if (!session) return;
    if (!await this.requireCsrf(req, res, session)) return;
    await this.service.authorize(session, workspaceId, 'workspace.write');

    const store = await this.storeFor(session, workspaceId);
    let result = null;
    try {
      result = await store.tx(async () => store.researchJobs.cancel({ jobId }));
    } catch (err) {
      if (err.code === '22P02') {
        this.json(res, 200, { job_id: jobId, action: 'not_found', state: null, cancel_requested_at: null });
        return;
      }
      throw err;
    }

    this.json(res, 200, result);
  }

  async opportunityCandidates(req, res, workspaceId) {
    const session = await this.requireSession(req, res);
    if (!session) return;
    await this.service.authorize(session, workspaceId, 'workspace.read');

    const store = await this.storeFor(session, workspaceId);
    let candidates = this.activeCandidatesByWorkspace.get(workspaceId);
    if (!candidates || candidates.length === 0) {
      // Durable retrieval from persistent jobs repository
      const jobs = await store.jobs.list();
      const latestJob = jobs.find((j) => j.state === 'complete' && j.options?.candidates?.length > 0);
      if (latestJob) {
        candidates = latestJob.options.candidates;
        this.activeCandidatesByWorkspace.set(workspaceId, candidates);
      } else {
        candidates = [];
      }
    }

    // Reflect saved status against persistent saved searches
    const savedList = await store.savedSearches.list();
    const savedIds = new Set(savedList.map((s) => s.search_id || s.filter?.opportunity_id));
    const resultCandidates = (candidates || []).map((c) => ({
      ...c,
      review_status: savedIds.has(c.opportunity_id) ? 'saved' : (c.review_status || 'unreviewed'),
    }));

    this.json(res, 200, { candidates: resultCandidates, workspace_id: workspaceId });
  }

  async saveOpportunity(req, res, workspaceId, opportunityId) {
    const session = await this.requireSession(req, res);
    if (!session) return;
    if (!await this.requireCsrf(req, res, session)) return;
    await this.service.authorize(session, workspaceId, 'workspace.write');

    const body = await this.body(req);
    const id = opportunityId || body.opportunity_id;
    if (!id) {
      throw new ServiceError(400, 'missing_opportunity_id', 'Opportunity ID is required');
    }

    const store = await this.storeFor(session, workspaceId);

    // 1. Authoritative candidate verification against server-generated discovery
    let candidates = this.activeCandidatesByWorkspace.get(workspaceId) || [];
    let candidate = candidates.find((c) => c.opportunity_id === id);
    if (!candidate) {
      // Check durable storage across completed research jobs for this workspace
      const jobs = await store.jobs.list();
      for (const j of jobs) {
        const found = j.options?.candidates?.find((c) => c.opportunity_id === id);
        if (found) {
          candidate = found;
          if (!this.activeCandidatesByWorkspace.has(workspaceId)) {
            this.activeCandidatesByWorkspace.set(workspaceId, j.options.candidates);
          }
          break;
        }
      }
    }

    // Check if previously saved
    if (!candidate) {
      const existing = await store.savedSearches.get(id);
      if (existing) {
        candidate = existing.filter || existing;
      }
    }

    if (!candidate) {
      throw new ServiceError(404, 'opportunity_not_found', `Opportunity "${id}" was not discovered or verified in workspace "${workspaceId}"`);
    }

    // 2. Verify workspace ownership
    if (candidate.workspace_id && candidate.workspace_id !== workspaceId) {
      throw new ServiceError(403, 'cross_workspace_denied', 'Opportunity belongs to another workspace');
    }

    // 3. Verify associated research job and evidence packet exist in workspace store
    if (candidate.job_id) {
      const job = await store.jobs.get(candidate.job_id);
      if (!job) {
        throw new ServiceError(400, 'invalid_job_association', 'Associated research job not found in workspace store');
      }
    }
    if (candidate.packet_id) {
      const packet = await store.packets.get(candidate.packet_id);
      if (!packet) {
        throw new ServiceError(400, 'invalid_packet_association', 'Associated evidence packet not found in workspace store');
      }
    }

    // 4. Server-side authoritative filter — never trust client-supplied source claims, scores or approval metadata
    const authoritativeFilter = {
      opportunity_id: candidate.opportunity_id,
      lead_id: candidate.lead_id || (candidate.packet_id ? `lead_${candidate.opportunity_id.replace(/^opp_/, '')}` : 'lead_default'),
      job_id: candidate.job_id,
      packet_id: candidate.packet_id,
      workspace_id: workspaceId,
      company_name: candidate.company_name,
      domain: candidate.domain,
      contact_info: candidate.contact_info || null,
      market_location: candidate.market_location || '',
      detected_need: candidate.detected_need,
      recommended_next_step: candidate.recommended_next_step,
      evidence_summary: candidate.evidence_summary,
      findings: candidate.findings,
      icp_fit: candidate.icp_fit,
      uncertainty_notes: candidate.uncertainty_notes,
      is_synthetic: candidate.is_synthetic,
      synthetic_badge: candidate.synthetic_badge,
      review_status: 'saved',
      saved_at: new Date().toISOString(),
      saved_by: session.email,
    };

    const savedRecord = {
      search_id: candidate.opportunity_id,
      name: candidate.company_name,
      filter: authoritativeFilter,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    await store.savedSearches.upsert(savedRecord);
    candidate.review_status = 'saved';

    this.json(res, 200, { ok: true, saved_opportunity: authoritativeFilter });
  }

  async listSavedOpportunities(req, res, workspaceId) {
    const session = await this.requireSession(req, res);
    if (!session) return;
    await this.service.authorize(session, workspaceId, 'workspace.read');

    const store = await this.storeFor(session, workspaceId);
    const list = await store.savedSearches.list();
    const opportunities = list.map((item) => (item.filter ? item.filter : item));

    this.json(res, 200, { opportunities, count: opportunities.length, workspace_id: workspaceId });
  }

  async prepareOutreach(req, res, workspaceId) {
    const session = await this.requireSession(req, res);
    if (!session) return;
    if (!await this.requireCsrf(req, res, session)) return;
    await this.service.authorize(session, workspaceId, 'workspace.write');

    const body = await this.body(req);
    if (!body.opportunity || typeof body.opportunity !== 'object') {
      throw new ServiceError(400, 'missing_opportunity', 'Valid opportunity object is required');
    }

    if (body.opportunity.workspace_id && body.opportunity.workspace_id !== workspaceId) {
      throw new ServiceError(403, 'cross_workspace_denied', 'Opportunity belongs to another workspace');
    }

    const store = await this.storeFor(session, workspaceId);

    const result = await prepareOutreachDraft({
      workspaceId,
      opportunity: body.opportunity,
      offer: body.offer,
      store,
      userId: session.user_id,
    });

    this.json(res, 200, result);
  }

  async approveOutreach(req, res, workspaceId) {
    const session = await this.requireSession(req, res);
    if (!session) return;
    if (!await this.requireCsrf(req, res, session)) return;

    // 1. Enforce stronger role authority: requires outreach.approve permission
    await this.service.authorize(session, workspaceId, 'outreach.approve');

    const body = await this.body(req);
    if (!body.pitch_id || !body.content_hash) {
      throw new ServiceError(400, 'missing_parameters', 'pitch_id and content_hash are required');
    }

    const store = await this.storeFor(session, workspaceId);

    // 2. Verify pitch exists in workspace store
    const pitch = await store.pitches.get(body.pitch_id);
    if (!pitch) {
      throw new ServiceError(404, 'pitch_not_found', `Persisted pitch "${body.pitch_id}" not found in workspace store`);
    }

    // 3. Verify workspace ownership (cross-workspace reference must fail)
    if (pitch.workspace_id && pitch.workspace_id !== workspaceId) {
      throw new ServiceError(403, 'cross_workspace_denied', 'Pitch does not belong to this workspace');
    }

    // 4. Verify content hash (altered hash must fail)
    if (pitch.content_hash && pitch.content_hash !== body.content_hash) {
      throw new ServiceError(400, 'hash_mismatch', 'Pitch content hash does not match stored authoritative record');
    }

    // 5. Verify applicable OutreachGate decision (must not have policy violations other than pending human approval)
    if (pitch.gate_reasons && pitch.gate_reasons.some((r) => r.code !== 'HUMAN_APPROVAL')) {
      throw new ServiceError(400, 'gate_blocked', 'Pitch was rejected by safety gate policy and cannot be approved');
    }

    // 6. Duplicate approval behavior: cannot approve twice
    const duplicate = await store.approvals.latestForPitch(body.pitch_id);
    if (duplicate) {
      throw new ServiceError(409, 'already_approved', `Pitch "${body.pitch_id}" has already been approved by ${duplicate.approved_by}`);
    }

    const approval = await store.approvals.insert({
      approval_id: `appr_${newId().slice(0, 12)}`,
      pitch_id: body.pitch_id,
      content_hash: body.content_hash,
      approved_by: session.email,
      approved_at: new Date().toISOString(),
    });

    this.json(res, 200, {
      ok: true,
      approval,
      status: 'approved_for_human_dispatch',
      auto_send_prohibited: true,
      notice: 'Outreach draft is formally approved by human supervisor. Automatic email or WhatsApp transmission is prohibited.',
    });
  }
}

module.exports = { ApiServer, SESSION_COOKIE, CSRF_HEADER };
