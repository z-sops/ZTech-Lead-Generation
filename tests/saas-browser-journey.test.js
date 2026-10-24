'use strict';

/**
 * ZTech SaaS End-to-End Customer Journey & Browser Contract Test
 *
 * Validates the full browser application workflow:
 * User Onboarding -> Workspace Selection -> Opportunity Discovery ->
 * Evidence Inspection -> Persistence -> Outreach Gate Review & Approval.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ApiServer } = require('../packages/lead-intelligence-api/src/server');

const STATIC_DIR = path.join(__dirname, '..', 'src', 'saas-client');

class JourneyClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.cookie = '';
    this.csrf = '';
  }

  async req(method, pathName, body = undefined) {
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

    return { status: res.status, headers: res.headers, body: json, text };
  }

  get(p) { return this.req('GET', p); }
  post(p, b) { return this.req('POST', p, b); }
}

test('ZTech SaaS Browser Customer Journey', async (t) => {
  let server;
  let base;
  let client;
  let workspaceId;

  t.before(async () => {
    server = new ApiServer({
      staticDir: STATIC_DIR,
      logger: { warn() {}, error() {}, log() {} },
    });
    const addr = await server.listen(0);
    base = `http://127.0.0.1:${addr.port}`;
    client = new JourneyClient(base);
  });

  t.after(async () => {
    if (server) await server.close();
  });

  await t.test('Phase 1: Customer Onboarding & Workspace Entry', async () => {
    const regRes = await client.post('/api/auth/register', {
      email: 'dr.watson@bakerstreethealth.co.uk',
      password: 'diagnostic-intelligence-vault-2026',
      organization: 'Baker Street Clinical Innovations',
      workspaceName: 'London Outpatient Opportunity Desk',
    });

    assert.equal(regRes.status, 201);
    assert.ok(regRes.body.user_id);
    assert.ok(regRes.body.workspace_id);
    assert.ok(regRes.body.csrf_token);

    client.csrf = regRes.body.csrf_token;
    workspaceId = regRes.body.workspace_id;

    // Verify session
    const sessRes = await client.get('/api/session');
    assert.equal(sessRes.status, 200);
    assert.equal(sessRes.body.email, 'dr.watson@bakerstreethealth.co.uk');
    assert.equal(sessRes.body.memberships[0].role, 'owner');
    assert.equal(sessRes.body.memberships[0].workspace_name, 'London Outpatient Opportunity Desk');
  });

  let candidates;

  await t.test('Phase 2: Customer Enters Requirements & Discovers Opportunities', async () => {
    const discRes = await client.post(`/api/workspaces/${workspaceId}/research`, {
      industry: 'Healthcare & Specialized Clinics',
      targetCountry: 'United Kingdom',
      cityOrRegion: 'London',
      targetCustomerType: 'Private specialist clinics',
      businessRequirements: 'Outdated booking system with severe mobile latency (>3s) and missing clinical schema.',
      isSynthetic: true,
    });

    assert.equal(discRes.status, 201);
    assert.equal(discRes.body.status, 'complete');
    assert.ok(discRes.body.candidates.length >= 2);

    candidates = discRes.body.candidates;
    const first = candidates[0];

    // Verify opportunity structure
    assert.ok(first.company_name);
    assert.ok(first.domain);
    assert.ok(first.detected_need.length > 10);
    assert.ok(first.recommended_next_step.length > 10);
    assert.equal(first.is_synthetic, true);
    assert.ok(first.synthetic_badge.includes('DEMO / SYNTHETIC RESEARCH'));
  });

  let selectedOpp;

  await t.test('Phase 3: Customer Inspects Evidence & Provenance', async () => {
    selectedOpp = candidates[0];
    assert.ok(selectedOpp.findings.length >= 2);

    const slowResponseFinding = selectedOpp.findings.find((f) => f.finding_id.includes('slow_server_response') || f.title.includes('Latency'));
    assert.ok(slowResponseFinding, 'Technical latency finding must be present');
    assert.ok(slowResponseFinding.observed.includes('latency') || slowResponseFinding.observed.includes('response'));
    assert.ok(slowResponseFinding.recommendation.length > 0);
    assert.ok(slowResponseFinding.urls.length >= 1);
    assert.ok(slowResponseFinding.fact_ids.length >= 1);

    // Verify ICP fit match
    assert.equal(selectedOpp.icp_fit.status, 'fit');
    assert.ok(selectedOpp.icp_fit.score >= 80);
    assert.ok(selectedOpp.uncertainty_notes.length >= 2);
  });

  await t.test('Phase 4: Customer Saves Opportunity & Verifies Persistence', async () => {
    const saveRes = await client.post(`/api/workspaces/${workspaceId}/opportunities/save`, selectedOpp);
    assert.equal(saveRes.status, 200);
    assert.equal(saveRes.body.ok, true);
    assert.equal(saveRes.body.saved_opportunity.review_status, 'saved');

    // Retrieve saved records
    const listRes = await client.get(`/api/workspaces/${workspaceId}/opportunities/saved`);
    assert.equal(listRes.status, 200);
    assert.equal(listRes.body.count, 1);
    assert.equal(listRes.body.opportunities[0].company_name, selectedOpp.company_name);
    assert.equal(listRes.body.opportunities[0].domain, selectedOpp.domain);
  });

  let pitch;

  await t.test('Phase 5: Customer Prepares Evidence-Backed Outreach Draft', async () => {
    const prepRes = await client.post(`/api/workspaces/${workspaceId}/outreach/prepare`, {
      opportunity: selectedOpp,
      offer: {
        sender_name: 'Dr. John Watson',
        sender_company: 'Baker Street Clinical Innovations',
        value_proposition: 'We deploy low-latency, modern clinical intake architectures for London private medical providers.',
        call_to_action: 'Would a brief 10-minute briefing next Tuesday be helpful to review the latency audit findings?',
      },
    });

    assert.equal(prepRes.status, 200);
    assert.equal(prepRes.body.human_review_required, true);
    assert.equal(prepRes.body.auto_send_prohibited, true);

    pitch = prepRes.body.pitch;
    assert.ok(pitch.pitch_id);
    assert.ok(pitch.content_hash);
    assert.ok(pitch.subject.includes(selectedOpp.domain));
    assert.ok(pitch.opening.includes(selectedOpp.domain));
    assert.ok(pitch.observations.length >= 1);
    assert.ok(pitch.observations[0].text.includes('Latency') || pitch.observations[0].text.includes('Descriptions'));

    // Outreach Gate verification
    const gate = prepRes.body.gate;
    assert.equal(gate.decision, 'blocked'); // Blocked pending human approval
    assert.ok(gate.reasons.some((r) => r.code === 'HUMAN_APPROVAL'));
  });

  await t.test('Phase 6: Human Supervisor Approves Outreach Draft', async () => {
    const approveRes = await client.post(`/api/workspaces/${workspaceId}/outreach/approve`, {
      pitch_id: pitch.pitch_id,
      content_hash: pitch.content_hash,
    });

    assert.equal(approveRes.status, 200);
    assert.equal(approveRes.body.ok, true);
    assert.equal(approveRes.body.status, 'approved_for_human_dispatch');
    assert.equal(approveRes.body.auto_send_prohibited, true);
    assert.ok(approveRes.body.approval.approval_id);
    assert.equal(approveRes.body.approval.approved_by, 'dr.watson@bakerstreethealth.co.uk');
  });

  await t.test('Phase 7: Browser UI Assets & DOM Structure Contract', async () => {
    const htmlPath = path.join(STATIC_DIR, 'index.html');
    const cssPath = path.join(STATIC_DIR, 'styles.css');
    const jsPath = path.join(STATIC_DIR, 'app.js');

    assert.ok(fs.existsSync(htmlPath), 'index.html must exist');
    assert.ok(fs.existsSync(cssPath), 'styles.css must exist');
    assert.ok(fs.existsSync(jsPath), 'app.js must exist');

    const html = fs.readFileSync(htmlPath, 'utf8');
    assert.ok(html.includes('id="topbar"'), 'topbar element present');
    assert.ok(html.includes('id="sidebar-nav"'), 'sidebar-nav element present');
    assert.ok(html.includes('id="view-overview"'), 'overview view present');
    assert.ok(html.includes('id="view-discovery"'), 'discovery view present');
    assert.ok(html.includes('id="view-saved"'), 'saved view present');
    assert.ok(html.includes('id="view-outreach-review"'), 'outreach view present');
    assert.ok(html.includes('id="view-security"'), 'security view present');
    assert.ok(html.includes('DEMO / SYNTHETIC RESEARCH'), 'honest demo badge present');

    const css = fs.readFileSync(cssPath, 'utf8');
    assert.ok(css.includes('--bg-canvas'), 'CSS design system tokens present');
    assert.ok(css.includes('--accent-primary'), 'accent colors present');

    const js = fs.readFileSync(jsPath, 'utf8');
    assert.ok(js.includes('executeDiscovery'), 'discovery execution function present');
    assert.ok(js.includes('saveOpportunity'), 'save function present');
    assert.ok(js.includes('openOutreachPreparationModal'), 'outreach drafter present');
  });
});
