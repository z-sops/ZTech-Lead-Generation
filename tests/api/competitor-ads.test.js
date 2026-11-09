'use strict';

/**
 * Competitor ads over HTTP, end to end: a watch is created, the worker's
 * executor runs each check through the REAL Meta Ads connector (MCP server
 * with a scripted source), and the API serves the week-against-week report.
 * In-memory always; PostgreSQL 16 too when ZTECH_PG_URL is set.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { ApiServer } = require('../../packages/lead-intelligence-api/src/server');
const { STORAGE } = require('../../packages/lead-intelligence-api/src/inMemoryStore');
const { createResearchExecutor } = require('../../packages/lead-intelligence-worker/src/research');
const { createAdsConnector } = require('../../packages/lead-intelligence-worker/src/adsConnector');
const { createConnectorServer } = require('../../packages/meta-ads-mcp/src/server');

const TOKEN = 'competitor-ads-test-token-0123456789';
const PASSWORD = 'correct-horse-battery-staple-secure';

class Client {
  constructor(base) { this.base = base; this.cookie = ''; this.csrf = ''; }

  async call(method, p, body) {
    const res = await fetch(`${this.base}${p}`, {
      method,
      headers: { 'content-type': 'application/json', ...(this.cookie ? { cookie: this.cookie } : {}), ...(this.csrf ? { 'x-csrf-token': this.csrf } : {}) },
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

/** What the competitor runs, week by week (the scripted source). */
const WEEKS = [
  [
    { ad_id: '9001', page_name: 'Bright Smile Dental', is_active: true, started_at: '2026-09-15T00:00:00.000Z', body: 'Free check-up this month', cta: 'Send WhatsApp message', platforms: ['facebook', 'instagram'], display_format: 'IMAGE' },
    { ad_id: '9002', page_name: 'Bright Smile Dental', is_active: true, started_at: '2026-10-28T00:00:00.000Z', body: 'Teeth whitening offer', cta: 'Learn more', platforms: ['facebook'], display_format: 'VIDEO' },
  ],
  [
    { ad_id: '9001', page_name: 'Bright Smile Dental', is_active: true, started_at: '2026-09-15T00:00:00.000Z', body: 'Free check-up this month', cta: 'Send WhatsApp message', platforms: ['facebook', 'instagram'], display_format: 'IMAGE' },
    { ad_id: '9002', page_name: 'Bright Smile Dental', is_active: false, started_at: '2026-10-28T00:00:00.000Z', stopped_at: '2026-11-05T00:00:00.000Z', body: 'Teeth whitening offer', cta: 'Learn more', platforms: ['facebook'], display_format: 'VIDEO' },
    { ad_id: '9003', page_name: 'Bright Smile Dental', is_active: true, started_at: '2026-11-06T00:00:00.000Z', body: 'Braces from PKR 5,000 a month', cta: 'Send WhatsApp message', platforms: ['instagram'], display_format: 'CAROUSEL' },
  ],
];

async function harness(mode) {
  if (mode === 'memory') {
    const server = new ApiServer({ logger: { warn() {}, error() {}, log() {}, info() {} }, llm: null });
    const addr = await server.listen(0);
    return {
      server,
      base: `http://127.0.0.1:${addr.port}`,
      queued: async (ws) => [...STORAGE.researchJobs.get(ws).values()].filter((j) => j.state === 'queued' && j.payload.kind === 'competitor_ads'),
      finish: async (ws, job, result) => { Object.assign(STORAGE.researchJobs.get(ws).get(job.job_id), { state: 'succeeded', result, finished_at: new Date().toISOString() }); },
      close: () => server.close(),
    };
  }
  const { freshDatabase, dropDatabase } = require('../persistence-contract/lib/postgres');
  const { PostgresStore } = require('../../packages/lead-intelligence-postgres/src/PostgresStore');
  const db = await freshDatabase('ztech_api_ads', { workspaces: ['55555555-5555-4555-8555-555555555555'] });
  const server = new ApiServer({
    identity: db.identityPool, tenant: db.pool, llm: null,
    logger: { warn() {}, error(...a) { if (process.env.ZTECH_API_DEBUG) console.error('[api]', ...a); }, log() {}, info() {} },
    storeFor: async (session, workspaceId) => new PostgresStore({ pool: db.pool, controlPool: db.controlPool, workspaceId, sessionId: session.session_id, userId: session.user_id, logger: { warn() {} } }),
  });
  const addr = await server.listen(0);
  return {
    server,
    base: `http://127.0.0.1:${addr.port}`,
    db,
    queued: async (ws) => (await db.owner.query("SELECT job_id, payload FROM li.job_queue WHERE workspace_id = $1 AND state = 'queued' AND payload->>'kind' = 'competitor_ads'", [ws])).rows,
    finish: async (ws, job, result) => {
      await db.owner.query("UPDATE li.job_queue SET state = 'succeeded', result = $2::jsonb, finished_at = now() WHERE job_id = $1", [job.job_id, JSON.stringify(result)]);
    },
    close: async () => {
      await server.close();
      await dropDatabase('ztech_api_ads', [db.pool, db.owner, db.controlPool, db.identityPool, db.platformPool, db.admin]);
    },
  };
}

const MODES = ['memory', ...(process.env.ZTECH_PG_URL ? ['postgres'] : [])];

for (const mode of MODES) {
  test(`[${mode}] competitor ads: watch, weekly checks through the connector, report`, async (t) => {
    let week = 0;
    const calls = [];
    const source = { name: 'apify', describe: 'scripted', search: async (q) => { calls.push(q); return WEEKS[week]; } };
    const connector = createConnectorServer({ token: TOKEN, sources: new Map([['apify', source]]), logger: { warn() {}, error() {} } });
    await new Promise((r) => connector.listen(0, '127.0.0.1', r));
    const exec = createResearchExecutor({ env: {}, adsConnector: createAdsConnector({ url: new URL(`http://127.0.0.1:${connector.address().port}/mcp`), token: TOKEN }) });
    const h = await harness(mode);
    t.after(async () => { await h.close(); connector.close(); });

    /** The worker: run every queued competitor check. */
    async function runWorker(ws) {
      for (const job of await h.queued(ws)) {
        const result = await exec({ jobType: 'research', jobClass: 'noop', payload: job.payload });
        await h.finish(ws, job, result);
      }
    }

    const tag = `${mode}-${Date.now()}`;
    const signUp = async (name) => {
      const c = new Client(h.base);
      const r = await c.post('/api/auth/register', { email: `${name}-${tag}@ztech.test`, password: PASSWORD, organization: `${name} Org`, workspaceName: `${name} WS` });
      assert.equal(r.status, 201);
      c.csrf = r.body.csrf_token;
      return { client: c, ws: r.body.workspace_id };
    };
    const owner = await signUp('agency');
    const rival = await signUp('rival');
    const base = `/api/workspaces/${owner.ws}/competitors`;
    let watchId;

    await t.test('a watch is created and its first check is queued', async () => {
      const bad = await owner.client.post(base, { query: 'Bright Smile Dental', country: 'Pakistan' });
      assert.equal(bad.status, 400);
      assert.equal(bad.body.field, 'country');
      const r = await owner.client.post(base, { label: 'Bright Smile (competitor of Old Town Dental)', query: 'Bright Smile Dental', country: 'pk' });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      watchId = r.body.watch.watch_id;
      assert.equal(r.body.watch.country, 'PK');
      const dup = await owner.client.post(base, { query: 'bright smile dental', country: 'PK' });
      assert.equal(dup.status, 409);
      assert.equal((await h.queued(owner.ws)).length, 1);
    });

    await t.test('week 1: the first check shows the ads, no "new" yet', async () => {
      await runWorker(owner.ws);
      assert.deepEqual(calls[0], { query: 'Bright Smile Dental', pageId: null, country: 'PK', active: 'all', max: 200, source: 'auto' });
      const d = await owner.client.get(`${base}/${watchId}`);
      assert.equal(d.status, 200);
      assert.equal(d.body.report.first_check, true);
      assert.equal(d.body.report.counts.active, 2);
      assert.equal(d.body.source, 'apify');
      assert.equal(d.body.history.length, 1);
    });

    await t.test('no second check in the same week; a week later one is queued exactly once', async () => {
      await owner.client.get(base);
      assert.equal((await h.queued(owner.ws)).length, 0, 'a fresh check is not repeated');
      // Eight days later (the service's clock; the stored checks keep their real time).
      const later = Date.now() + 8 * 86400000;
      h.server.competitors.now = () => new Date(later);
      week = 1;
      const l1 = await owner.client.get(base);
      assert.equal(l1.body.watches[0].checking, true);
      await owner.client.get(base);
      assert.equal((await h.queued(owner.ws)).length, 1, 'opening the list twice queues one check');
      await runWorker(owner.ws);
    });

    await t.test('week 2: new, stopped, likely working, and the trend', async () => {
      const d = await owner.client.get(`${base}/${watchId}`);
      const r = d.body.report;
      assert.equal(r.first_check, false);
      assert.equal(r.counts.active, 2);
      assert.equal(r.counts.new_since_last, 1);
      assert.equal(r.counts.stopped_since_last, 1);
      assert.equal(r.counts.likely_working, 1);
      assert.equal(r.longest_running.ad_id, '9001');
      assert.deepEqual(r.stopped.map((s) => s.ad_id), ['9002']);
      assert.equal(r.ads.find((a) => a.ad_id === '9003').is_new, true);
      assert.equal(r.by_cta['Send WhatsApp message'], 2);
      assert.equal(d.body.history.length, 2);
      const list = await owner.client.get(base);
      assert.equal(list.body.watches[0].summary.counts.new_since_last, 1);
    });

    await t.test('"Check now" queues one check per hour', async () => {
      const a = await owner.client.post(`${base}/${watchId}/check`, {});
      assert.equal(a.status, 202);
      const b = await owner.client.post(`${base}/${watchId}/check`, {});
      assert.equal(b.body.deduplicated, true);
      assert.equal((await h.queued(owner.ws)).length, 1);
    });

    await t.test('another workspace sees nothing', async () => {
      assert.equal((await rival.client.get(`/api/workspaces/${owner.ws}/competitors`)).status, 403);
      assert.equal((await rival.client.get(`/api/workspaces/${rival.ws}/competitors/${watchId}`)).status, 404);
      assert.equal((await rival.client.post(`/api/workspaces/${rival.ws}/competitors/${watchId}/check`, {})).status, 404);
      assert.equal((await rival.client.get(`/api/workspaces/${rival.ws}/competitors`)).body.watches.length, 0);
    });

    await t.test('archiving stops the watch', async () => {
      const r = await owner.client.post(`${base}/${watchId}/archive`, {});
      assert.equal(r.status, 200);
      assert.equal((await owner.client.get(base)).body.watches.length, 0);
      assert.equal((await owner.client.post(`${base}/${watchId}/check`, {})).status, 404);
    });

    await t.test('a check with no connector configured fails with a clear reason', async () => {
      const bare = createResearchExecutor({ env: {} });
      await assert.rejects(bare({ jobType: 'research', jobClass: 'noop', payload: { kind: 'competitor_ads', watch_id: 'x', watch: { query: 'x', country: 'PK' } } }), /connector_not_configured/);
    });

    if (mode === 'postgres') {
      await t.test('the database: the watch table is isolated and the worker has no access', async () => {
        const row = (await h.db.owner.query("SELECT c.relrowsecurity, c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'li' AND c.relname = 'li_competitor_watches'")).rows[0];
        assert.deepEqual([row.relrowsecurity, row.relforcerowsecurity], [true, true]);
        const p = async (role, priv) => (await h.db.owner.query('SELECT has_table_privilege($1, $2, $3) AS ok', [role, 'li.li_competitor_watches', priv])).rows[0].ok;
        assert.equal(await p('ztech_worker', 'SELECT'), false);
        assert.equal(await p('ztech_app', 'DELETE'), false);
        const { assertRuntimeRoles } = require('../../packages/lead-intelligence-postgres/src/assertRoles');
        assert.deepEqual((await assertRuntimeRoles(h.db.pool)).problems, []);
      });
    }
  });
}
