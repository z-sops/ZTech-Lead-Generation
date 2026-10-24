'use strict';

/**
 * ZTech SaaS Product Vertical Slice Test Suite
 *
 * Verifies the complete customer journey, tenant boundaries, role-based
 * authorization, research evidence contracts, opportunity persistence,
 * and Outreach Gate compliance.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { ApiServer } = require('../packages/lead-intelligence-api/src/server');

const STATIC_DIR = path.join(__dirname, '..', 'src', 'saas-client');

class TestClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.cookie = '';
    this.csrf = '';
  }

  async call(method, pathName, body = undefined, headers = {}) {
    const res = await fetch(`${this.baseUrl}${pathName}`, {
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
    if (setCookie) {
      this.cookie = setCookie.split(';')[0];
    }

    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }

    return {
      status: res.status,
      headers: res.headers,
      body: json,
      rawText: text,
    };
  }

  get(p, h) { return this.call('GET', p, undefined, h); }
  post(p, b, h) { return this.call('POST', p, b, h); }
  patch(p, b, h) { return this.call('PATCH', p, b, h); }
  delete(p, b, h) { return this.call('DELETE', p, b, h); }
}

test('ZTech SaaS Vertical Slice Suite', async (t) => {
  let server;
  let base;

  t.before(async () => {
    server = new ApiServer({
      staticDir: STATIC_DIR,
      logger: { warn() {}, error() {}, log() {} },
    });
    const addr = await server.listen(0);
    base = `http://127.0.0.1:${addr.port}`;
  });

  t.after(async () => {
    if (server) await server.close();
  });

  await t.test('1. API Health Check', async () => {
    const client = new TestClient(base);
    const res = await client.get('/api/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.ok(Array.isArray(res.body.roles));
    assert.ok(res.body.roles.includes('owner'));
  });

  let aliceClient;
  let aliceWorkspaceId;

  await t.test('2. Registration & Session Establishment', async () => {
    aliceClient = new TestClient(base);
    const regRes = await aliceClient.post('/api/auth/register', {
      email: 'alice.founder@ztech.test',
      password: 'correct-horse-battery-staple-secure',
      organization: 'Alice Health Group',
      workspaceName: 'London Clinical Opportunities',
    });

    assert.equal(regRes.status, 201);
    assert.ok(regRes.body.user_id);
    assert.ok(regRes.body.workspace_id);
    assert.ok(regRes.body.csrf_token);
    assert.ok(aliceClient.cookie.startsWith('ztech_session='));

    aliceClient.csrf = regRes.body.csrf_token;
    aliceWorkspaceId = regRes.body.workspace_id;

    // Verify session info
    const sessRes = await aliceClient.get('/api/session');
    assert.equal(sessRes.status, 200);
    assert.equal(sessRes.body.email, 'alice.founder@ztech.test');
    assert.equal(sessRes.body.memberships.length, 1);
    assert.equal(sessRes.body.memberships[0].role, 'owner');
  });

  let bobClient;
  let bobWorkspaceId;

  await t.test('3. Cross-Tenant Denial & Workspace Boundaries', async () => {
    bobClient = new TestClient(base);
    const regBob = await bobClient.post('/api/auth/register', {
      email: 'bob.competitor@other.test',
      password: 'different-secure-password-1234',
      organization: 'Bob Logistics Ltd',
      workspaceName: 'Bob Global Operations',
    });
    assert.equal(regBob.status, 201);
    bobClient.csrf = regBob.body.csrf_token;
    bobWorkspaceId = regBob.body.workspace_id;

    // Alice attempts to read Bob's workspace -> 403 Forbidden
    const aliceBreach = await aliceClient.get(`/api/workspaces/${bobWorkspaceId}/opportunities/candidates`);
    assert.equal(aliceBreach.status, 403);
    assert.equal(aliceBreach.body.error, 'no_membership');

    // Bob attempts to write research into Alice's workspace -> 403 Forbidden
    const bobBreach = await bobClient.post(`/api/workspaces/${aliceWorkspaceId}/research`, {
      industry: 'Healthcare',
      businessRequirements: 'Test breach',
    });
    assert.equal(bobBreach.status, 403);
    assert.equal(bobBreach.body.error, 'no_membership');
  });

  await t.test('4. CSRF Protection on State-Changing Endpoints', async () => {
    const attackClient = new TestClient(base);
    attackClient.cookie = aliceClient.cookie; // stolen cookie
    attackClient.csrf = 'forged-csrf-token';

    const breach = await attackClient.post(`/api/workspaces/${aliceWorkspaceId}/research`, {
      industry: 'Healthcare',
      businessRequirements: 'Tampered research',
    });
    assert.equal(breach.status, 403);
    assert.equal(breach.body.error, 'csrf_failed');
  });

  let discoveredOpp;

  await t.test('5. Opportunity Discovery & Evidence Verification', async () => {
    const discRes = await aliceClient.post(`/api/workspaces/${aliceWorkspaceId}/research`, {
      industry: 'Healthcare & Specialized Clinics',
      targetCountry: 'United Kingdom',
      cityOrRegion: 'London',
      businessRequirements: 'Outdated legacy appointment booking portal, slow response time, and missing meta description.',
      isSynthetic: true,
    });

    assert.equal(discRes.status, 201);
    assert.equal(discRes.body.status, 'complete');
    assert.ok(discRes.body.candidates.length >= 2);

    discoveredOpp = discRes.body.candidates[0];
    assert.ok(discoveredOpp.opportunity_id);
    assert.ok(discoveredOpp.packet_id);
    assert.ok(discoveredOpp.company_name);
    assert.ok(discoveredOpp.detected_need);
    assert.equal(discoveredOpp.is_synthetic, true);
    assert.ok(discoveredOpp.synthetic_badge.includes('DEMO / SYNTHETIC RESEARCH'));
    assert.ok(discoveredOpp.evidence_summary.findings_count >= 1);
    assert.equal(discoveredOpp.icp_fit.status, 'fit');
    assert.ok(discoveredOpp.icp_fit.qualitative);
    assert.ok(Array.isArray(discoveredOpp.icp_fit.matched_criteria));

    // Retrieve research job details
    const jobRes = await aliceClient.get(`/api/workspaces/${aliceWorkspaceId}/research/${discRes.body.job_id}`);
    assert.equal(jobRes.status, 200);
    assert.equal(jobRes.body.job.state, 'complete');
  });

  await t.test('6. Opportunity Persistence & Workspace Isolation', async () => {
    // Negative test: Saving a forged/unverified opportunity must be rejected (404)
    const forgedOpp = { ...discoveredOpp, opportunity_id: 'opp_forged_untrusted_12345' };
    const forgedRes = await aliceClient.post(`/api/workspaces/${aliceWorkspaceId}/opportunities/save`, forgedOpp);
    assert.equal(forgedRes.status, 404);
    assert.equal(forgedRes.body.error, 'opportunity_not_found');

    // Negative test: Bob cannot save Alice's opportunity into his workspace (404)
    const crossSaveRes = await bobClient.post(`/api/workspaces/${bobWorkspaceId}/opportunities/save`, discoveredOpp);
    assert.equal(crossSaveRes.status, 404);

    // Alice saves the authentic discovered opportunity
    const saveRes = await aliceClient.post(`/api/workspaces/${aliceWorkspaceId}/opportunities/save`, discoveredOpp);
    assert.equal(saveRes.status, 200);
    assert.equal(saveRes.body.ok, true);
    assert.equal(saveRes.body.saved_opportunity.review_status, 'saved');

    // Alice retrieves saved opportunities
    const listRes = await aliceClient.get(`/api/workspaces/${aliceWorkspaceId}/opportunities/saved`);
    assert.equal(listRes.status, 200);
    assert.equal(listRes.body.opportunities.length, 1);
    assert.equal(listRes.body.opportunities[0].company_name, discoveredOpp.company_name);

    // Bob checks his saved opportunities -> exactly 0 (tenant isolation)
    const bobList = await bobClient.get(`/api/workspaces/${bobWorkspaceId}/opportunities/saved`);
    assert.equal(bobList.status, 200);
    assert.equal(bobList.body.opportunities.length, 0);
  });

  let pitchDraft;

  await t.test('7. Outreach Preparation & Safety Gate Inspection', async () => {
    const prepRes = await aliceClient.post(`/api/workspaces/${aliceWorkspaceId}/outreach/prepare`, {
      opportunity: discoveredOpp,
      offer: {
        sender_name: 'Alice Director of Healthcare Solutions',
        sender_company: 'Alice Health Group',
        value_proposition: 'We deploy high-converting patient booking infrastructure for London private clinics.',
        call_to_action: 'Would a brief 10-minute briefing next Tuesday be helpful to review the latency audit?',
      },
    });

    assert.equal(prepRes.status, 200);
    assert.equal(prepRes.body.human_review_required, true);
    assert.equal(prepRes.body.auto_send_prohibited, true);

    pitchDraft = prepRes.body.pitch;
    assert.ok(pitchDraft.pitch_id);
    assert.ok(pitchDraft.content_hash);
    assert.ok(pitchDraft.subject.length > 0);
    assert.ok(pitchDraft.opening.length > 0);
    assert.ok(pitchDraft.observations.length >= 1);
    // Verified citations to evidence refs
    assert.ok(pitchDraft.observations[0].refs.length >= 1);

    // OutreachGate check
    const gate = prepRes.body.gate;
    assert.ok(Array.isArray(gate.reasons));
    assert.ok(gate.checkedAt);
    assert.equal(gate.decision, 'blocked');
    assert.ok(gate.reasons.some((r) => r.code === 'HUMAN_APPROVAL'));
  });

  await t.test('8. Human Outreach Approval Ledger & Integrity Verification', async () => {
    // Negative test 1: Altered content hash must fail with 400 hash_mismatch
    const tamperedRes = await aliceClient.post(`/api/workspaces/${aliceWorkspaceId}/outreach/approve`, {
      pitch_id: pitchDraft.pitch_id,
      content_hash: 'forged_tampered_hash_0000000',
    });
    assert.equal(tamperedRes.status, 400);
    assert.equal(tamperedRes.body.error, 'hash_mismatch');

    // Negative test 2: Bob cannot approve Alice's workspace pitch (404 / cross-tenant)
    const crossPitchRes = await bobClient.post(`/api/workspaces/${bobWorkspaceId}/outreach/approve`, {
      pitch_id: pitchDraft.pitch_id,
      content_hash: pitchDraft.content_hash,
    });
    assert.equal(crossPitchRes.status, 404);

    // Positive test: Alice (owner) approves authentic pitch
    const approveRes = await aliceClient.post(`/api/workspaces/${aliceWorkspaceId}/outreach/approve`, {
      pitch_id: pitchDraft.pitch_id,
      content_hash: pitchDraft.content_hash,
    });

    assert.equal(approveRes.status, 200);
    assert.equal(approveRes.body.ok, true);
    assert.equal(approveRes.body.status, 'approved_for_human_dispatch');
    assert.equal(approveRes.body.auto_send_prohibited, true);

    // Negative test 3: Duplicate approval fails with 409 Conflict
    const duplicateRes = await aliceClient.post(`/api/workspaces/${aliceWorkspaceId}/outreach/approve`, {
      pitch_id: pitchDraft.pitch_id,
      content_hash: pitchDraft.content_hash,
    });
    assert.equal(duplicateRes.status, 409);
    assert.equal(duplicateRes.body.error, 'already_approved');
  });

  await t.test('9. Static Asset Delivery for Browser SaaS Dashboard', async () => {
    const client = new TestClient(base);

    // GET / serves index.html
    const rootRes = await client.get('/');
    assert.equal(rootRes.status, 200);
    assert.ok(rootRes.headers.get('content-type').includes('text/html'));
    assert.ok(rootRes.rawText.includes('ZTech Lead Generation'));

    // GET /styles.css serves CSS
    const cssRes = await client.get('/styles.css');
    assert.equal(cssRes.status, 200);
    assert.ok(cssRes.headers.get('content-type').includes('text/css'));
    assert.ok(cssRes.rawText.includes('--bg-canvas'));

    // GET /app.js serves JavaScript
    const jsRes = await client.get('/app.js');
    assert.equal(jsRes.status, 200);
    assert.ok(jsRes.headers.get('content-type').includes('application/javascript'));
    assert.ok(jsRes.rawText.includes('executeDiscovery'));

    // Directory traversal attempt blocked
    const traversal = await client.get('/../../package.json');
    // Sanitized path is either index.html fallback or 403/404, never raw package.json from parent
    assert.ok(!traversal.rawText.includes('"devDependencies"'));
  });
});
