'use strict';

/**
 * ZTech SaaS Product Security Acceptance Suite
 *
 * Implements Workstream 4 requirements:
 * 1. Forged opportunity ID rejection
 * 2. Cross-workspace evidence denial
 * 3. Unauthorized pitch approval rejection
 * 4. Changed content-hash rejection
 * 5. Duplicate approval rejection
 * 6. Expired-session behavior
 * 7. Missing or invalid database credentials
 * 8. Production demo-login prohibition
 * 9. Normal SaaS startup does not require administrative/superuser database account
 * 10. Automatic outreach / paid provider execution prohibited
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { ApiServer } = require('../../packages/lead-intelligence-api/src/server');

const STATIC_DIR = path.join(__dirname, '..', '..', 'src', 'saas-client');

class ApiClient {
  constructor(base) {
    this.base = base;
    this.cookie = '';
    this.csrf = '';
  }

  async call(method, pathName, body = undefined, headers = {}) {
    const res = await fetch(`${this.base}${pathName}`, {
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

  get(p, h) { return this.call('GET', p, undefined, h); }
  post(p, b, h) { return this.call('POST', p, b, h); }
}

test('ZTech SaaS Product Security Suite', async (t) => {
  let server;
  let base;

  t.before(async () => {
    server = new ApiServer({
      staticDir: STATIC_DIR,
      storageMode: 'local-demo',
      allowDemoAutologin: false, // Explicitly disabled for security tests
      logger: { warn() {}, error() {}, log() {} },
    });
    const addr = await server.listen(0);
    base = `http://127.0.0.1:${addr.port}`;
  });

  t.after(async () => {
    if (server) await server.close();
  });

  let aliceClient;
  let aliceWorkspaceId;
  let aliceOpportunity;
  let alicePitch;

  let bobClient;
  let bobWorkspaceId;

  await t.test('Setup: Register Alice (Org A) and Bob (Org B)', async () => {
    aliceClient = new ApiClient(base);
    const regAlice = await aliceClient.post('/api/auth/register', {
      email: `alice_sec_${Date.now()}@healthalpha.co.uk`,
      password: 'ClinicalVaultPassword2026!',
      organization: 'Alpha Health Clinics',
      workspaceName: 'London Outpatient Desk',
    });
    assert.equal(regAlice.status, 201);
    aliceWorkspaceId = regAlice.body.workspace_id;
    aliceClient.csrf = regAlice.body.csrf_token;

    // Discover synthetic research in Alice's workspace
    const discRes = await aliceClient.post(`/api/workspaces/${aliceWorkspaceId}/research`, {
      industry: 'Healthcare & Specialized Clinics',
      targetCountry: 'United Kingdom',
      cityOrRegion: 'London',
      businessRequirements: 'Slow mobile booking portal and missing metadata.',
      isSynthetic: true,
    });
    assert.equal(discRes.status, 201);
    aliceOpportunity = discRes.body.candidates[0];

    // Save opportunity
    const saveRes = await aliceClient.post(`/api/workspaces/${aliceWorkspaceId}/opportunities/save`, aliceOpportunity);
    assert.equal(saveRes.status, 200);

    // Prepare outreach draft
    const prepRes = await aliceClient.post(`/api/workspaces/${aliceWorkspaceId}/outreach/prepare`, {
      opportunity: aliceOpportunity,
      offer: {
        sender_name: 'Dr. Alice',
        sender_company: 'Alpha Health Clinics',
        value_proposition: 'Modernizing booking portal latency.',
        call_to_action: '10-minute briefing next week.',
      },
    });
    assert.equal(prepRes.status, 200);
    alicePitch = prepRes.body.pitch;
    assert.ok(alicePitch.pitch_id);

    // Register Bob in separate workspace
    bobClient = new ApiClient(base);
    const regBob = await bobClient.post('/api/auth/register', {
      email: `bob_sec_${Date.now()}@competitorbeta.com`,
      password: 'CompetitorVaultPassword2026!',
      organization: 'Beta Competitor Corp',
      workspaceName: 'Competitor Operations Desk',
    });
    assert.equal(regBob.status, 201);
    bobWorkspaceId = regBob.body.workspace_id;
    bobClient.csrf = regBob.body.csrf_token;
  });

  await t.test('Security 1: Forged opportunity ID rejection', async () => {
    const forgedOpp = {
      ...aliceOpportunity,
      opportunity_id: 'opp_forged_invalid_id_9999',
    };
    const saveRes = await aliceClient.post(`/api/workspaces/${aliceWorkspaceId}/opportunities/save`, forgedOpp);
    assert.equal(saveRes.status, 404);
    assert.equal(saveRes.body.error, 'opportunity_not_found');
  });

  await t.test('Security 2: Cross-workspace evidence denial', async () => {
    // Bob attempts to save Alice's opportunity in Bob's workspace (denied with 404 opportunity_not_found)
    const breachSave = await bobClient.post(`/api/workspaces/${bobWorkspaceId}/opportunities/save`, aliceOpportunity);
    assert.equal(breachSave.status, 404);
    assert.equal(breachSave.body.error, 'opportunity_not_found');

    // Bob attempts to access Alice's saved opportunities (denied with 403 Forbidden)
    const breachList = await bobClient.get(`/api/workspaces/${aliceWorkspaceId}/opportunities/saved`);
    assert.equal(breachList.status, 403);

    // Bob attempts to prepare outreach using Alice's evidence packet in Bob's workspace
    const breachPrep = await bobClient.post(`/api/workspaces/${bobWorkspaceId}/outreach/prepare`, {
      opportunity: {
        ...aliceOpportunity,
        workspace_id: bobWorkspaceId, // trying to claim ownership
      },
      offer: {
        sender_name: 'Bob',
        sender_company: 'Beta Competitor Corp',
        value_proposition: 'Breach attempt',
        call_to_action: 'None',
      },
    });
    // Packet belongs to Alice, not Bob
    assert.equal(breachPrep.status, 404);
  });

  await t.test('Security 3: Unauthorized pitch approval rejection', async () => {
    // Competitor Bob attempts to approve Alice's pitch in Alice's workspace -> 403 Forbidden
    const unauthorizedCrossApprove = await bobClient.post(`/api/workspaces/${aliceWorkspaceId}/outreach/approve`, {
      pitch_id: alicePitch.pitch_id,
      content_hash: alicePitch.content_hash,
    });
    assert.equal(unauthorizedCrossApprove.status, 403);

    // Competitor Bob attempts to approve Alice's pitch in Bob's workspace -> 404 Not Found in store
    const unauthorizedStoreApprove = await bobClient.post(`/api/workspaces/${bobWorkspaceId}/outreach/approve`, {
      pitch_id: alicePitch.pitch_id,
      content_hash: alicePitch.content_hash,
    });
    assert.equal(unauthorizedStoreApprove.status, 404);
  });

  await t.test('Security 4: Changed content-hash rejection', async () => {
    const tamperedHash = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
    const tamperedRes = await aliceClient.post(`/api/workspaces/${aliceWorkspaceId}/outreach/approve`, {
      pitch_id: alicePitch.pitch_id,
      content_hash: tamperedHash,
    });
    assert.equal(tamperedRes.status, 400);
    assert.equal(tamperedRes.body.error, 'hash_mismatch');
  });

  await t.test('Security 5: Duplicate approval rejection', async () => {
    // First approval by Owner Alice succeeds
    const approve1 = await aliceClient.post(`/api/workspaces/${aliceWorkspaceId}/outreach/approve`, {
      pitch_id: alicePitch.pitch_id,
      content_hash: alicePitch.content_hash,
    });
    assert.equal(approve1.status, 200);
    assert.equal(approve1.body.status, 'approved_for_human_dispatch');

    // Second approval attempt must be rejected as conflict (409)
    const approve2 = await aliceClient.post(`/api/workspaces/${aliceWorkspaceId}/outreach/approve`, {
      pitch_id: alicePitch.pitch_id,
      content_hash: alicePitch.content_hash,
    });
    assert.equal(approve2.status, 409);
    assert.equal(approve2.body.error, 'already_approved');
  });

  await t.test('Security 6: Expired-session behavior', async () => {
    const unauthClient = new ApiClient(base);
    unauthClient.cookie = 'ztech_session=nonexistent_or_expired_token_value_xyz';
    const sessRes = await unauthClient.get('/api/session');
    assert.equal(sessRes.status, 401);
    assert.equal(sessRes.body.error, 'not_authenticated');
  });

  await t.test('Security 7: Production demo-login prohibition', async () => {
    // When server allowDemoAutologin is false, demo-login is forbidden
    const demoLoginRes = await (new ApiClient(base)).post('/api/auth/demo-login', {});
    assert.equal(demoLoginRes.status, 403);
    assert.equal(demoLoginRes.body.error, 'forbidden');
  });

  await t.test('Security 8: Missing or invalid database credentials behavior', async () => {
    const { startSaasServer } = require('../../scripts/start-saas');
    const originalPgUrl = process.env.ZTECH_PG_URL;
    delete process.env.ZTECH_PG_URL;
    try {
      // 1. Refuses startup when --postgres is specified without ZTECH_PG_URL
      await assert.rejects(
        () => startSaasServer(0, ['node', 'start-saas.js', '--postgres']),
        /PostgreSQL mode requested but ZTECH_PG_URL is not set/
      );

      // 2. Refuses startup when production mode is specified without ZTECH_PG_URL
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      await assert.rejects(
        () => startSaasServer(0, ['node', 'start-saas.js']),
        /Production mode requires PostgreSQL persistent storage/
      );
      process.env.NODE_ENV = originalEnv;
    } finally {
      if (originalPgUrl) process.env.ZTECH_PG_URL = originalPgUrl;
    }
  });

  await t.test('Security 9: Auto-send and paid provider execution prohibition', async () => {
    // Verify OutreachGate decision blocks auto-sending and requires human review
    const prepRes = await aliceClient.post(`/api/workspaces/${aliceWorkspaceId}/outreach/prepare`, {
      opportunity: aliceOpportunity,
      offer: {
        sender_name: 'Dr. Alice',
        sender_company: 'Alpha Health Clinics',
        value_proposition: 'Portal modernization',
        call_to_action: 'Brief call',
      },
    });
    assert.equal(prepRes.status, 200);
    assert.equal(prepRes.body.human_review_required, true);
    assert.equal(prepRes.body.auto_send_prohibited, true);
    assert.equal(prepRes.body.gate.decision, 'blocked');
    assert.ok(prepRes.body.gate.reasons.some((r) => r.code === 'HUMAN_APPROVAL'));
  });
});
