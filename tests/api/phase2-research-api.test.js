'use strict';

/**
 * Phase 2 API: research criteria, research results and proposal drafts.
 *
 * The research result used here is REAL pipeline output: the pipeline runs
 * against the evaluation websites (tests/lib/phase2-fixture-server.js) and
 * its result is stored on the job the way the worker stores it, so the API
 * is tested against the exact shape it will serve.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { ApiServer } = require('../../packages/lead-intelligence-api/src/server');
const { STORAGE } = require('../../packages/lead-intelligence-api/src/inMemoryStore');
const { createResearchExecutor } = require('../../packages/lead-intelligence-worker/src/research');
const { startFixtureServer } = require('../lib/phase2-fixture-server');

class Client {
  constructor(base) { this.base = base; this.cookie = ''; this.csrf = ''; }

  async call(method, p, body) {
    const res = await fetch(`${this.base}${p}`, {
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
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  get(p) { return this.call('GET', p); }
  post(p, b) { return this.call('POST', p, b); }
}

const CRITERIA = {
  industry: 'dentist', location: 'Leeds, UK', offer_categories: ['seo', 'security', 'web_design', 'booking'], max_results: 25,
};
const OFFER = {
  sender_name: 'Zee', sender_company: 'Zunitech', offer_summary: 'We fix small-business websites: mobile layout, HTTPS and search basics, for a fixed price.',
};

async function register(base, n) {
  const c = new Client(base);
  const r = await c.post('/api/auth/register', {
    email: `phase2-${n}@ztech.test`, password: 'correct-horse-battery-staple-secure', organization: `P2 Org ${n}`, workspaceName: `P2 WS ${n}`,
  });
  assert.equal(r.status, 201);
  c.csrf = r.body.csrf_token;
  return { client: c, ws: r.body.workspace_id };
}

/** Store a result on a job exactly as the worker's write_job_result does. */
function completeJob(ws, jobId, result) {
  const rec = STORAGE.researchJobs.get(ws).get(jobId);
  Object.assign(rec, { state: 'succeeded', result, finished_at: new Date().toISOString() });
}

test('Phase 2 research API', async (t) => {
  const fx = await startFixtureServer();
  const exec = createResearchExecutor({ env: {
    ZTECH_INSPECT_ALLOW_PRIVATE: '1', ZTECH_INSPECT_HOST_MAP: fx.hostMap, ZTECH_NOMINATIM_URL: fx.nominatimUrl, ZTECH_OVERPASS_URL: fx.overpassUrl,
  } });
  const realResult = await exec({ jobType: 'research', jobClass: 'noop', payload: { kind: 'business_research', criteria: CRITERIA } });
  await fx.close();

  const server = new ApiServer({ logger: { warn() {}, error() {}, log() {}, info() {} }, llm: null });
  const addr = await server.listen(0);
  const base = `http://127.0.0.1:${addr.port}`;
  t.after(() => server.close());

  const a = await register(base, 'a');
  const b = await register(base, 'b');
  const jobsA = `/api/workspaces/${a.ws}/research/jobs`;
  let jobId;

  await t.test('the form options list the industries, services and limits', async () => {
    const r = await a.client.get(`/api/workspaces/${a.ws}/research/options`);
    assert.equal(r.status, 200);
    assert.ok(r.body.industries.some((i) => i.id === 'dentist'));
    assert.ok(r.body.offer_categories.some((o) => o.id === 'seo'));
    assert.equal(r.body.ai_drafts_available, false);
    assert.match(r.body.sources[0].attribution, /OpenStreetMap contributors/);
  });

  await t.test('bad criteria are refused with the field that is wrong', async () => {
    const cases = [
      [{ ...CRITERIA, industry: 'spaceships' }, 'industry'],
      [{ ...CRITERIA, location: ' ' }, 'location'],
      [{ ...CRITERIA, offer_categories: [] }, 'offer_categories'],
      [{ ...CRITERIA, offer_categories: ['seo', 'crypto'] }, 'offer_categories'],
      [{ ...CRITERIA, max_results: 500 }, 'max_results'],
      [{ ...CRITERIA, website_filter: 'maybe' }, 'website_filter'],
    ];
    for (const [criteria, field] of cases) {
      const r = await a.client.post(jobsA, { idempotency_key: `bad-${field}-${Math.random()}`, payload: { kind: 'business_research', criteria } });
      assert.equal(r.status, 400, field);
      assert.equal(r.body.error, 'invalid_criteria');
      assert.equal(r.body.field, field);
    }
  });

  await t.test('valid criteria are queued, normalised', async () => {
    const r = await a.client.post(jobsA, {
      idempotency_key: 'p2-real-1',
      payload: { kind: 'business_research', criteria: { ...CRITERIA, industry: 'Dentist', offer_categories: ['web_design', 'seo', 'seo', 'security', 'booking'], extra: 'dropped' } },
    });
    assert.equal(r.status, 202);
    jobId = r.body.job_id;
    const stored = STORAGE.researchJobs.get(a.ws).get(jobId).payload;
    assert.deepEqual(stored, { kind: 'business_research', criteria: { ...CRITERIA, offer_categories: ['booking', 'security', 'seo', 'web_design'], website_filter: 'any', notes: '' } });
  });

  await t.test('a job that has not finished has no result, and says so', async () => {
    const r = await a.client.get(`${jobsA}/${jobId}/result`);
    assert.equal(r.status, 200);
    assert.equal(r.body.state, 'queued');
    assert.equal(r.body.result, null);
  });

  await t.test('a finished job serves its real result', async () => {
    completeJob(a.ws, jobId, realResult);
    const r = await a.client.get(`${jobsA}/${jobId}/result`);
    assert.equal(r.status, 200);
    assert.equal(r.body.result.schema, 'ztech.research.v1');
    assert.equal(r.body.result.synthetic, false);
    assert.equal(r.body.result.businesses.length, 9);
    for (const f of r.body.result.findings) {
      for (const id of f.evidence_ids) assert.ok(r.body.result.evidence.some((e) => e.evidence_id === id), 'every finding has its evidence');
    }
  });

  await t.test('another workspace cannot read the result or draft from it', async () => {
    const r = await b.client.get(`/api/workspaces/${a.ws}/research/jobs/${jobId}/result`);
    assert.ok([403, 404].includes(r.status));
    const own = await b.client.get(`/api/workspaces/${b.ws}/research/jobs/${jobId}/result`);
    assert.equal(own.status, 404, 'the job id does not exist in the other workspace');
    const d = await b.client.post(`/api/workspaces/${b.ws}/research/jobs/${jobId}/proposals`, { opportunity_id: realResult.opportunities[0].opportunity_id, offer: OFFER });
    assert.equal(d.status, 404);
  });

  await t.test('a draft cites real evidence, separates facts from inferences, and cannot be sent', async () => {
    const top = realResult.opportunities[0];
    const r = await a.client.post(`${jobsA}/${jobId}/proposals`, { opportunity_id: top.opportunity_id, offer: OFFER });
    assert.equal(r.status, 200);
    const d = r.body.draft;
    assert.equal(d.can_send, false);
    assert.equal(d.status, 'draft_requires_human_review');
    assert.equal(d.generator, 'template');
    assert.ok(d.facts.length > 0);
    const ids = new Set(realResult.evidence.map((e) => e.evidence_id));
    for (const f of d.facts) {
      assert.ok(ids.has(f.evidence_id), 'the fact is stored evidence');
      assert.ok(f.source_url && f.observed_at, 'the fact says where and when');
    }
    assert.ok(d.inferences.length > 0);
    assert.match(d.body, /my reading, not a certainty/);
    assert.match(d.body, new RegExp(top.business_name));
  });

  await t.test('no draft for a business without a matching, evidenced need', async () => {
    const zero = realResult.opportunities.find((o) => o.score === 0);
    const r = await a.client.post(`${jobsA}/${jobId}/proposals`, { opportunity_id: zero.opportunity_id, offer: OFFER });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'no_matching_need');
  });

  await t.test('drafts need CSRF, a valid offer, and an AI configuration for AI drafts', async () => {
    const top = realResult.opportunities[0];
    const noCsrf = new Client(base);
    noCsrf.cookie = a.client.cookie;
    const r1 = await noCsrf.post(`${jobsA}/${jobId}/proposals`, { opportunity_id: top.opportunity_id, offer: OFFER });
    assert.equal(r1.status, 403);
    const r2 = await a.client.post(`${jobsA}/${jobId}/proposals`, { opportunity_id: top.opportunity_id, offer: { sender_name: 'Zee' } });
    assert.equal(r2.status, 400);
    assert.equal(r2.body.error, 'invalid_offer');
    const r3 = await a.client.post(`${jobsA}/${jobId}/proposals`, { opportunity_id: top.opportunity_id, offer: OFFER, use_ai: true });
    assert.equal(r3.status, 409);
    assert.equal(r3.body.error, 'ai_not_configured');
  });

  await t.test('an AI draft is used only when it passes the checks', async () => {
    const top = realResult.opportunities[0];
    const factIds = realResult.needs.filter((n) => top.need_ids.includes(n.need_id)).flatMap((n) => n.evidence_ids);
    const answers = [
      { subject: 'Your website', body: 'Hello, we saw your website is slow and you lose 40% of visitors; see https://scam.example/offer for details and more text here.', cited_evidence_ids: [factIds[0]] },
      { subject: 'Your website', body: 'Hello, we checked your home page and noticed it is not set up for mobile screens. That may put some visitors off. Happy to help.', cited_evidence_ids: ['ev_invented'] },
      { subject: 'A note about your website', body: 'Hello, we checked your home page and noticed it is not set up for mobile screens. That may put some visitors off. Happy to help if useful.', cited_evidence_ids: [factIds[0]] },
    ];
    const calls = [];
    const aiServer = new ApiServer({
      logger: { warn() {}, error() {}, log() {}, info() {} },
      llm: {
        apiKey: 'test-key', model: 'test-model',
        request: async (req) => {
          calls.push(req);
          const answer = answers.shift();
          return { ok: true, status: 200, body: JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] }) };
        },
      },
    });
    const aiAddr = await aiServer.listen(0);
    try {
      const c = await register(`http://127.0.0.1:${aiAddr.port}`, 'ai');
      const r = await c.client.post(`/api/workspaces/${c.ws}/research/jobs`, { idempotency_key: 'ai-1', payload: { kind: 'business_research', criteria: CRITERIA } });
      completeJob(c.ws, r.body.job_id, realResult);
      const url = `/api/workspaces/${c.ws}/research/jobs/${r.body.job_id}/proposals`;
      const d1 = await c.client.post(url, { opportunity_id: top.opportunity_id, offer: OFFER, use_ai: true });
      assert.equal(d1.body.draft.generator, 'template');
      assert.match(d1.body.draft.notes[0], /scam\.example/);
      const d2 = await c.client.post(url, { opportunity_id: top.opportunity_id, offer: OFFER, use_ai: true });
      assert.equal(d2.body.draft.generator, 'template');
      assert.match(d2.body.draft.notes[0], /does not exist/);
      const d3 = await c.client.post(url, { opportunity_id: top.opportunity_id, offer: OFFER, use_ai: true });
      assert.equal(d3.body.draft.generator, 'gemini:test-model');
      assert.equal(d3.body.draft.can_send, false);
      assert.deepEqual(d3.body.draft.facts.map((f) => f.evidence_id), [factIds[0]]);
      // The key travels in a header to Google's host only.
      assert.equal(calls[0].headers['x-goog-api-key'], 'test-key');
      assert.match(calls[0].url, /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/test-model:generateContent$/);
      assert.ok(!calls[0].body.includes('test-key'));
    } finally {
      await aiServer.close();
    }
  });
});
