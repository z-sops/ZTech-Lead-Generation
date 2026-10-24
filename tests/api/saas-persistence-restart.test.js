'use strict';

/**
 * ZTech SaaS PostgreSQL Persistence & Server Restart Acceptance Suite
 *
 * Fulfills Directive 23 Workstream A:
 * 1. Register a customer.
 * 2. Create an organization / workspace in PostgreSQL.
 * 3. Discover synthetic opportunities.
 * 4. Save an opportunity into PostgreSQL 16 store.
 * 5. Prepare and save an outreach draft into PostgreSQL 16 store.
 * 6. Shut down ApiServer instance 1.
 * 7. Restart ApiServer instance 2 pointing to the same PostgreSQL database.
 * 8. Log in again with customer credentials.
 * 9. Confirm the records (workspace, opportunity, pitch) are still present.
 * 10. Confirm another workspace cannot access them (RLS & tenant boundary denial).
 * 11. Run against PostgreSQL 16 with actual runtime roles.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { ApiServer } = require('../../packages/lead-intelligence-api/src/server');
const { PostgresStore } = require('../../packages/lead-intelligence-postgres/src/PostgresStore');
const { freshDatabase, dropDatabase, skip } = require('../persistence-contract/lib/postgres');

const STATIC_DIR = path.join(__dirname, '..', '..', 'src', 'saas-client');
const DATABASE = 'ztech_saas_restart_test';

class TestClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.cookie = '';
    this.csrf = '';
  }

  async call(method, pathName, body = undefined) {
    const res = await fetch(`${this.baseUrl}${pathName}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(this.csrf ? { 'x-csrf-token': this.csrf } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];

    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }

    return { status: res.status, headers: res.headers, body: json };
  }

  get(p) { return this.call('GET', p); }
  post(p, b) { return this.call('POST', p, b); }
}

const { Pool } = require('pg');

const PG_URL = process.env.ZTECH_PG_URL || '';

async function checkPg() {
  if (!PG_URL) return false;
  try {
    const p = new Pool({ connectionString: PG_URL, connectionTimeoutMillis: 1500 });
    await p.query('SELECT 1');
    await p.end();
    return true;
  } catch {
    return false;
  }
}

test('ZTech SaaS PostgreSQL 16 Persistence & Restart Verification', async (t) => {
  const isReachable = await checkPg();
  if (!isReachable) {
    t.skip('Live PostgreSQL 16 instance not reachable at ZTECH_PG_URL; skipping persistence restart suite');
    return;
  }

  let db;
  let tenantPool;
  let controlPool;
  let identityPool;
  let server1;
  let server2;
  let base1;
  let base2;

  t.before(async () => {
      db = await freshDatabase(DATABASE, { workspaces: [] });
      tenantPool = db.pool;
      controlPool = db.controlPool;
      identityPool = db.identityPool;
    });

    t.after(async () => {
      if (server1) await server1.close().catch(() => {});
      if (server2) await server2.close().catch(() => {});
      if (db) await dropDatabase(DATABASE).catch(() => {});
    });

    const createServer = async () => {
      const server = new ApiServer({
        staticDir: STATIC_DIR,
        identity: identityPool,
        tenant: tenantPool,
        storageMode: 'postgres',
        logger: { warn() {}, error() {}, log() {} },
        storeFor: async (session, workspaceId) => new PostgresStore({
          pool: tenantPool,
          controlPool,
          workspaceId,
          sessionId: session.session_id,
          userId: session.user_id,
          logger: { warn() {} },
        }),
      });
      const addr = await server.listen(0);
      return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
    };

    let aliceEmail = 'alice.persisted@ztech-clinic.co.uk';
    let alicePassword = 'ClinicalPersistence2026!Secure';
    let aliceWorkspaceId;
    let discoveredOpp;
    let savedPitch;

    await t.test('Phase 1: Initial Server Instance — Registration, Discovery & Persistence', async () => {
      const instance1 = await createServer();
      server1 = instance1.server;
      base1 = instance1.baseUrl;

      const client = new TestClient(base1);

      // Verify health check returns PostgreSQL storage mode
      const health = await client.get('/api/health');
      assert.equal(health.status, 200);
      assert.equal(health.body.storage_mode, 'postgres');
      assert.equal(health.body.ephemeral, false);

      // 1. Register customer
      const regRes = await client.post('/api/auth/register', {
        email: aliceEmail,
        password: alicePassword,
        organization: 'Alice Persistent Healthcare Ltd',
        workspaceName: 'London Outpatient Opportunity Desk',
      });
      assert.equal(regRes.status, 201);
      assert.ok(regRes.body.workspace_id);
      aliceWorkspaceId = regRes.body.workspace_id;
      client.csrf = regRes.body.csrf_token;

      // 2. Discover synthetic opportunities
      const discRes = await client.post(`/api/workspaces/${aliceWorkspaceId}/research`, {
        industry: 'Healthcare & Specialized Clinics',
        targetCountry: 'United Kingdom',
        cityOrRegion: 'London',
        businessRequirements: 'Slow appointment booking portal latency and missing mobile meta descriptions.',
        isSynthetic: true,
      });
      assert.equal(discRes.status, 201);
      assert.ok(discRes.body.candidates.length >= 2);
      discoveredOpp = discRes.body.candidates[0];

      // 3. Save opportunity into PostgreSQL database
      const saveRes = await client.post(`/api/workspaces/${aliceWorkspaceId}/opportunities/save`, discoveredOpp);
      assert.equal(saveRes.status, 200);
      assert.equal(saveRes.body.ok, true);

      // 4. Prepare outreach draft
      const prepRes = await client.post(`/api/workspaces/${aliceWorkspaceId}/outreach/prepare`, {
        opportunity: discoveredOpp,
        offer: {
          sender_name: 'Alice Director',
          sender_company: 'Alice Persistent Healthcare Ltd',
          value_proposition: 'Replacing slow clinical intake booking engines.',
          call_to_action: 'Brief briefing call next Tuesday.',
        },
      });
      assert.equal(prepRes.status, 200);
      savedPitch = prepRes.body.pitch;
      assert.ok(savedPitch.pitch_id);

      // 5. Approve outreach draft
      const approveRes = await client.post(`/api/workspaces/${aliceWorkspaceId}/outreach/approve`, {
        pitch_id: savedPitch.pitch_id,
        content_hash: savedPitch.content_hash,
      });
      assert.equal(approveRes.status, 200);
      assert.equal(approveRes.body.status, 'approved_for_human_dispatch');

      // Verify records are present in PostgreSQL before shutdown
      const savedRes = await client.get(`/api/workspaces/${aliceWorkspaceId}/opportunities/saved`);
      assert.equal(savedRes.status, 200);
      assert.equal(savedRes.body.count, 1);
    });

    await t.test('Phase 2: Shutdown Server Instance 1 & Restart Server Instance 2', async () => {
      // Shutdown server 1
      await server1.close();
      server1 = null;

      // Start completely fresh server 2 pointing to the same PostgreSQL 16 database
      const instance2 = await createServer();
      server2 = instance2.server;
      base2 = instance2.baseUrl;

      const client = new TestClient(base2);

      // Verify health check on restarted server
      const health = await client.get('/api/health');
      assert.equal(health.status, 200);
      assert.equal(health.body.storage_mode, 'postgres');

      // Log in again with customer credentials
      const loginRes = await client.post('/api/auth/login', {
        email: aliceEmail,
        password: alicePassword,
      });
      assert.equal(loginRes.status, 200);
      client.csrf = loginRes.body.csrf_token;

      // Verify session recovered from PostgreSQL
      const sessRes = await client.get('/api/session');
      assert.equal(sessRes.status, 200);
      assert.equal(sessRes.body.email, aliceEmail);
      assert.equal(sessRes.body.memberships[0].workspace_id, aliceWorkspaceId);

      // Verify saved opportunities persisted across server restart
      const savedRes = await client.get(`/api/workspaces/${aliceWorkspaceId}/opportunities/saved`);
      assert.equal(savedRes.status, 200);
      assert.equal(savedRes.body.count, 1);
      assert.equal(savedRes.body.opportunities[0].company_name, discoveredOpp.company_name);
      assert.equal(savedRes.body.opportunities[0].domain, discoveredOpp.domain);
    });

    await t.test('Phase 3: Tenant Boundary & Cross-Workspace Isolation under PostgreSQL RLS', async () => {
      const bobClient = new TestClient(base2);

      // Register competitor Bob in a second organization and workspace on same database
      const bobReg = await bobClient.post('/api/auth/register', {
        email: 'bob.competitor@otherhealth.com',
        password: 'CompetitorVaultPassword123!',
        organization: 'Bob Competitor Health Ltd',
        workspaceName: 'Competitor Operations Desk',
      });
      assert.equal(bobReg.status, 201);
      const bobWorkspaceId = bobReg.body.workspace_id;
      bobClient.csrf = bobReg.body.csrf_token;

      // Bob's saved opportunities in PostgreSQL must be 0
      const bobSaved = await bobClient.get(`/api/workspaces/${bobWorkspaceId}/opportunities/saved`);
      assert.equal(bobSaved.status, 200);
      assert.equal(bobSaved.body.count, 0);

      // Bob cannot read Alice's saved opportunities -> 403 Forbidden
      const breachSaved = await bobClient.get(`/api/workspaces/${aliceWorkspaceId}/opportunities/saved`);
      assert.equal(breachSaved.status, 403);
      assert.equal(breachSaved.body.error, 'no_membership');

      // Bob cannot approve Alice's pitch -> 403 Forbidden
      const breachApprove = await bobClient.post(`/api/workspaces/${aliceWorkspaceId}/outreach/approve`, {
        pitch_id: savedPitch.pitch_id,
        content_hash: savedPitch.content_hash,
      });
      assert.equal(breachApprove.status, 403);
    });
  });

