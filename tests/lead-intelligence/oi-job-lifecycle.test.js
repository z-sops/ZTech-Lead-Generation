'use strict';

// G-44 - the Opportunity Intelligence job lifecycle, from ZTech's side.
//
// A full research takes roughly 20-90 s. ZTech's gateway used to make ONE
// synchronous call with a 30 s budget, so a routine research timed out
// client-side while the service kept working: the report was never collected.
//
// The gateway now drives OI's asynchronous job lifecycle: start, poll, collect.
// These tests prove the lifecycle, the bounds, the retries, the explicit
// failure handling, and the fallback for a service that does not offer the
// job routes.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  OpportunityIntelligenceGateway,
  BOUNDS,
} = require('../../src/main/lead-intelligence/opportunity/OpportunityIntelligenceGateway');
const { report } = require('./opportunity-fixtures');

/** A canonical, contract-valid IntelligenceReport, as OI would return it. */
const REPORT = report();

function fakeFetch(routes, log = []) {
  return async (url, init) => {
    log.push({ url, init });
    const handler = routes[`${init.method} ${url}`];
    if (!handler) return { ok: false, status: 404, headers: { get: () => null }, text: async () => JSON.stringify({ error: 'NOT_FOUND' }) };
    if (handler === 'network') throw new TypeError('fetch failed');
    const body = typeof handler === 'function' ? handler() : handler;
    return {
      ok: (body.status || 200) < 400,
      status: body.status || 200,
      headers: { get: () => null },
      text: async () => JSON.stringify(body.body === undefined ? {} : body.body),
    };
  };
}

/** A clock that advances by a fixed step on every read, so the budget can expire. */
function steppingClock(startMs = 0, stepMs = 1000) {
  let t = startMs;
  return () => {
    const now = new Date(t);
    t += stepMs;
    return now;
  };
}

const BASE = 'http://127.0.0.1:8099';

test('G-44: the research runs through start, poll and result', async () => {
  const log = [];
  let polls = 0;
  const gateway = new OpportunityIntelligenceGateway({
    baseUrl: BASE,
    clock: steppingClock(0, 100),
    fetchImpl: fakeFetch({
      [`POST ${BASE}/v1/research/jobs`]: () => ({ status: 202, body: { research_id: 'res_20260101000000_abcdef01', status: 'running', replayed: false } }),
      [`GET ${BASE}/v1/research/jobs/res_20260101000000_abcdef01`]: () => {
        polls += 1;
        return { status: 200, body: { research_id: 'res_20260101000000_abcdef01', status: polls < 3 ? 'running' : 'completed' } };
      },
      [`GET ${BASE}/v1/research/jobs/res_20260101000000_abcdef01/result`]: { status: 200, body: REPORT },
    }, log),
  });

  const res = await gateway.requestResearch({ leadId: 'L1', companyName: 'Acme', domain: 'acme.com' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.report.research_id, REPORT.research_id);
  assert.equal(polls, 3, 'the job was polled until it finished');
  assert.ok(log.some((l) => l.url === `${BASE}/v1/research/jobs` && l.init.method === 'POST'), 'the job was started');
  assert.ok(!log.some((l) => l.url === `${BASE}/v1/research` && l.init.method === 'POST'), 'the synchronous route was NOT used');
});

test('G-44: the old synchronous route is still used when the service has no job routes', async () => {
  const log = [];
  const gateway = new OpportunityIntelligenceGateway({
    baseUrl: BASE,
    clock: steppingClock(0, 100),
    fetchImpl: fakeFetch({
      [`POST ${BASE}/v1/research/jobs`]: { status: 404, body: { error: 'NOT_FOUND' } },
      [`POST ${BASE}/v1/research`]: { status: 200, body: REPORT },
    }, log),
  });

  const res = await gateway.requestResearch({ leadId: 'L1', companyName: 'Acme', domain: 'acme.com' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(log.some((l) => l.url === `${BASE}/v1/research` && l.init.method === 'POST'), 'the fallback was used');
});

test('G-44: a replayed job is collected straight away, without a second run', async () => {
  const log = [];
  const gateway = new OpportunityIntelligenceGateway({
    baseUrl: BASE,
    clock: steppingClock(0, 100),
    fetchImpl: fakeFetch({
      [`POST ${BASE}/v1/research/jobs`]: { status: 200, body: { research_id: 'res_20260101000000_abcdef01', status: 'completed', replayed: true } },
      [`GET ${BASE}/v1/research/jobs/res_20260101000000_abcdef01/result`]: { status: 200, body: REPORT },
    }, log),
  });

  const res = await gateway.requestResearch({ leadId: 'L1', companyName: 'Acme', domain: 'acme.com', options: { idempotency_key: 'rjob_0001' } });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(!log.some((l) => l.url.endsWith('/status')), 'a replay is not polled');
});

test('G-44: a failed job is reported as a failure with the cause, not as a transport error', async () => {
  const gateway = new OpportunityIntelligenceGateway({
    baseUrl: BASE,
    clock: steppingClock(0, 100),
    fetchImpl: fakeFetch({
      [`POST ${BASE}/v1/research/jobs`]: { status: 202, body: { research_id: 'res_20260101000000_abcdef01', status: 'running' } },
      [`GET ${BASE}/v1/research/jobs/res_20260101000000_abcdef01`]: { status: 200, body: { research_id: 'res_20260101000000_abcdef01', status: 'failed' } },
      [`GET ${BASE}/v1/research/jobs/res_20260101000000_abcdef01/result`]: {
        status: 409,
        body: { error: 'PROVIDER_FAILED', message: 'the provider refused', retryable: false },
      },
    }),
  });

  const res = await gateway.requestResearch({ leadId: 'L1', companyName: 'Acme', domain: 'acme.com' });
  assert.equal(res.ok, false);
  assert.equal(res.state, 'failed');
  assert.equal(res.oiError && res.oiError.code, 'PROVIDER_FAILED');
  assert.equal(res.oiError && res.oiError.retryable, false);
  assert.equal(res.researchId, 'res_20260101000000_abcdef01', 'the research id is kept so the run can be inspected');
});

test('G-44: a job that is still running when the result is collected is reported as in-progress', async () => {
  const gateway = new OpportunityIntelligenceGateway({
    baseUrl: BASE,
    clock: steppingClock(0, 100),
    fetchImpl: fakeFetch({
      [`POST ${BASE}/v1/research/jobs`]: { status: 202, body: { research_id: 'res_20260101000000_abcdef01', status: 'running' } },
      // The status turns terminal, but the job row is still running when the
      // result is collected - the service says so, and ZTech must believe it.
      [`GET ${BASE}/v1/research/jobs/res_20260101000000_abcdef01`]: { status: 200, body: { research_id: 'res_20260101000000_abcdef01', status: 'completed' } },
      [`GET ${BASE}/v1/research/jobs/res_20260101000000_abcdef01/result`]: {
        status: 409,
        body: { error: 'IN_PROGRESS', message: 'still running', retryable: true },
      },
    }),
  });

  const res = await gateway.requestResearch({ leadId: 'L1', companyName: 'Acme', domain: 'acme.com' });
  assert.equal(res.ok, false);
  assert.equal(res.state, 'in_progress');
  assert.equal(res.oiError && res.oiError.retryable, true);
});

test('G-44: a job that never leaves "running" is given up on at the budget', async () => {
  let polls = 0;
  const gateway = new OpportunityIntelligenceGateway({
    baseUrl: BASE,
    clock: steppingClock(0, 60_000),
    pollInitialMs: 1,
    pollMaxMs: 1,
    researchBudgetMs: 120_000,
    fetchImpl: fakeFetch({
      [`POST ${BASE}/v1/research/jobs`]: { status: 202, body: { research_id: 'res_20260101000000_abcdef01', status: 'running' } },
      [`GET ${BASE}/v1/research/jobs/res_20260101000000_abcdef01`]: () => {
        polls += 1;
        return { status: 200, body: { research_id: 'res_20260101000000_abcdef01', status: 'running' } };
      },
    }),
  });

  const res = await gateway.requestResearch({ leadId: 'L1', companyName: 'Acme', domain: 'acme.com' });
  assert.equal(res.ok, false);
  assert.equal(res.state, 'timeout');
  assert.equal(res.researchId, 'res_20260101000000_abcdef01', 'the research id is kept so the run can be collected later');
  assert.ok(polls >= 1 && polls <= 5, 'the polling stopped at the budget (' + polls + ' polls)');
});

test('G-44: a transient poll failure is retried, because the run continues on the service side', async () => {
  let polls = 0;
  const gateway = new OpportunityIntelligenceGateway({
    baseUrl: BASE,
    clock: steppingClock(0, 100),
    pollInitialMs: 1,
    pollMaxMs: 1,
    fetchImpl: fakeFetch({
      [`POST ${BASE}/v1/research/jobs`]: { status: 202, body: { research_id: 'res_20260101000000_abcdef01', status: 'running' } },
      [`GET ${BASE}/v1/research/jobs/res_20260101000000_abcdef01`]: () => {
        polls += 1;
        if (polls === 1) return 'network';
        return { status: 200, body: { research_id: 'res_20260101000000_abcdef01', status: 'completed' } };
      },
      [`GET ${BASE}/v1/research/jobs/res_20260101000000_abcdef01/result`]: { status: 200, body: REPORT },
    }),
  });

  const res = await gateway.requestResearch({ leadId: 'L1', companyName: 'Acme', domain: 'acme.com' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(polls >= 2, 'the failed poll was retried (' + polls + ' polls)');
});

test('G-44: the report is still validated before ZTech believes it', async () => {
  const gateway = new OpportunityIntelligenceGateway({
    baseUrl: BASE,
    clock: steppingClock(0, 100),
    fetchImpl: fakeFetch({
      [`POST ${BASE}/v1/research/jobs`]: { status: 202, body: { research_id: 'res_20260101000000_abcdef01', status: 'running' } },
      [`GET ${BASE}/v1/research/jobs/res_20260101000000_abcdef01`]: { status: 200, body: { research_id: 'res_20260101000000_abcdef01', status: 'completed' } },
      [`GET ${BASE}/v1/research/jobs/res_20260101000000_abcdef01/result`]: { status: 200, body: { not: 'a report' } },
    }),
  });

  const res = await gateway.requestResearch({ leadId: 'L1', companyName: 'Acme', domain: 'acme.com' });
  assert.equal(res.ok, false);
  assert.equal(res.state, 'invalid_response');
});

test('G-44: the lifecycle bounds are bounded values', () => {
  assert.ok(BOUNDS.researchBudgetMs > BOUNDS.timeoutMs, 'the whole lifecycle may take longer than one call');
  assert.ok(BOUNDS.pollMaxMs >= BOUNDS.pollInitialMs);
  assert.ok(BOUNDS.pollRetries >= 1);
});
