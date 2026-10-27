'use strict';

/**
 * Checkpoint C - Durable Research Jobs API Contract Test Suite
 *
 * Verifies the durable asynchronous research-job queue HTTP API:
 *   - Route dispatch correctness (distinct from legacy synchronous research)
 *   - Authenticated enqueue (HTTP 202)
 *   - Idempotency & deduplication
 *   - CSRF & Session protection
 *   - Workspace authorization & Cross-tenant isolation
 *   - Job detail & list retrieval
 *   - Cancellation semantics (queued vs running vs terminal)
 *   - Input payload validation & byte size limits
 *   - Preservation of legacy M5 synchronous research flow
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { ApiServer } = require('../../packages/lead-intelligence-api/src/server');

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
}

test('Durable Research Jobs API Contract Suite', async (t) => {
  let server;
  let base;
  let tenantA;
  let tenantB;
  let clientA;
  let clientB;

  t.before(async () => {
    server = new ApiServer({
      logger: { warn() {}, error() {}, log() {} },
    });
    const addr = await server.listen(0);
    base = `http://127.0.0.1:${addr.port}`;

    // Register Tenant A
    clientA = new TestClient(base);
    const regA = await clientA.post('/api/auth/register', {
      email: 'ownerA@ztech.test',
      password: 'correct-horse-battery-staple-secure',
      organization: 'Tenant A Org',
      workspaceName: 'Tenant A Workspace',
    });
    assert.equal(regA.status, 201);
    tenantA = {
      userId: regA.body.user_id,
      workspaceId: regA.body.workspace_id,
      csrf: regA.body.csrf_token,
    };
    clientA.csrf = tenantA.csrf;

    // Register Tenant B
    clientB = new TestClient(base);
    const regB = await clientB.post('/api/auth/register', {
      email: 'ownerB@ztech.test',
      password: 'correct-horse-battery-staple-secure',
      organization: 'Tenant B Org',
      workspaceName: 'Tenant B Workspace',
    });
    assert.equal(regB.status, 201);
    tenantB = {
      userId: regB.body.user_id,
      workspaceId: regB.body.workspace_id,
      csrf: regB.body.csrf_token,
    };
    clientB.csrf = tenantB.csrf;
  });

  t.after(async () => {
    if (server) await server.close();
  });

  await t.test('1. Unauthenticated requests are rejected with HTTP 401', async () => {
    const unauthClient = new TestClient(base);
    const res = await unauthClient.get(`/api/workspaces/${tenantA.workspaceId}/research/jobs`);
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'not_authenticated');
  });

  await t.test('2. Missing or invalid CSRF header rejects state-changing requests with HTTP 403', async () => {
    const noCsrfClient = new TestClient(base);
    noCsrfClient.cookie = clientA.cookie;
    noCsrfClient.csrf = ''; // omit CSRF

    const res = await noCsrfClient.post(`/api/workspaces/${tenantA.workspaceId}/research/jobs`, {
      idempotency_key: 'test-no-csrf',
      payload: { query: 'test' },
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'csrf_failed');
  });

  await t.test('3. Enqueue validation rejects missing or invalid idempotency key', async () => {
    const emptyKey = await clientA.post(`/api/workspaces/${tenantA.workspaceId}/research/jobs`, {
      idempotency_key: '',
      payload: { query: 'test' },
    });
    assert.equal(emptyKey.status, 400);
    assert.equal(emptyKey.body.error, 'invalid_idempotency_key');

    const tooLongKey = await clientA.post(`/api/workspaces/${tenantA.workspaceId}/research/jobs`, {
      idempotency_key: 'x'.repeat(201),
      payload: { query: 'test' },
    });
    assert.equal(tooLongKey.status, 400);
    assert.equal(tooLongKey.body.error, 'invalid_idempotency_key');
  });

  await t.test('4. Enqueue validation rejects invalid or oversized payload', async () => {
    const arrayPayload = await clientA.post(`/api/workspaces/${tenantA.workspaceId}/research/jobs`, {
      idempotency_key: 'test-arr-payload',
      payload: ['not', 'an', 'object'],
    });
    assert.equal(arrayPayload.status, 400);
    assert.equal(arrayPayload.body.error, 'invalid_payload');

    const bigPayload = await clientA.post(`/api/workspaces/${tenantA.workspaceId}/research/jobs`, {
      idempotency_key: 'test-big-payload',
      payload: { large: 'a'.repeat(16385) },
    });
    assert.equal(bigPayload.status, 400);
    assert.equal(bigPayload.body.error, 'payload_too_large');
  });

  await t.test('4b. Payload at exactly 16,384 UTF-8 bytes is accepted', async () => {
    // {"large":"..."} is 12 bytes of framing, so 16,372 'a' characters
    // serialize to exactly 16,384 UTF-8 bytes.
    const payload = { large: 'a'.repeat(16372) };
    assert.equal(Buffer.byteLength(JSON.stringify(payload), 'utf8'), 16384);
    const res = await clientA.post(`/api/workspaces/${tenantA.workspaceId}/research/jobs`, {
      idempotency_key: 'test-boundary-exact',
      payload,
    });
    assert.equal(res.status, 202);
  });

  await t.test('4c. Payload one byte over the limit is rejected', async () => {
    const payload = { large: 'a'.repeat(16373) };
    assert.equal(Buffer.byteLength(JSON.stringify(payload), 'utf8'), 16385);
    const res = await clientA.post(`/api/workspaces/${tenantA.workspaceId}/research/jobs`, {
      idempotency_key: 'test-boundary-over',
      payload,
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'payload_too_large');
  });

  await t.test('4d. Multibyte UTF-8 payload is measured in bytes, not characters', async () => {
    // 5,000 emoji are 20,000 UTF-8 bytes but only 5,000 characters.
    const payload = { text: '😀'.repeat(5000) };
    assert.ok(Buffer.byteLength(JSON.stringify(payload), 'utf8') > 16384);
    const res = await clientA.post(`/api/workspaces/${tenantA.workspaceId}/research/jobs`, {
      idempotency_key: 'test-multibyte-oversized',
      payload,
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'payload_too_large');
  });

  await t.test('4e. Multibyte UTF-8 payload under the limit is accepted', async () => {
    // 4,000 emoji are 16,000 UTF-8 bytes, under the 16,384-byte limit.
    const payload = { text: '😀'.repeat(4000) };
    assert.ok(Buffer.byteLength(JSON.stringify(payload), 'utf8') <= 16384);
    const res = await clientA.post(`/api/workspaces/${tenantA.workspaceId}/research/jobs`, {
      idempotency_key: 'test-multibyte-valid',
      payload,
    });
    assert.equal(res.status, 202);
  });

  let createdJobId;

  await t.test('5. Authorized enqueue creates research job with HTTP 202', async () => {
    const res = await clientA.post(`/api/workspaces/${tenantA.workspaceId}/research/jobs`, {
      idempotency_key: 'research-run-001',
      payload: { company: 'Acme Medical', domain: 'acme.test' },
    });

    assert.equal(res.status, 202);
    assert.ok(res.body.job_id);
    assert.equal(res.body.workspace_id, tenantA.workspaceId);
    assert.equal(res.body.job_type, 'research');
    assert.equal(res.body.state, 'queued');
    assert.equal(res.body.idempotency_key, 'research-run-001');
    assert.equal(res.body.deduplicated, false);
    createdJobId = res.body.job_id;
  });

  await t.test('6. Duplicate enqueue with same idempotency key returns deduplicated: true', async () => {
    const res = await clientA.post(`/api/workspaces/${tenantA.workspaceId}/research/jobs`, {
      idempotency_key: 'research-run-001',
      payload: { company: 'Acme Medical', domain: 'acme.test' },
    });

    assert.equal(res.status, 202);
    assert.equal(res.body.job_id, createdJobId, 'returns original job_id');
    assert.equal(res.body.deduplicated, true, 'marked as deduplicated');
  });

  await t.test('7. Job list retrieval returns enqueued jobs for workspace', async () => {
    const res = await clientA.get(`/api/workspaces/${tenantA.workspaceId}/research/jobs`);
    assert.equal(res.status, 200);
    assert.equal(res.body.workspace_id, tenantA.workspaceId);
    assert.ok(Array.isArray(res.body.jobs));
    const found = res.body.jobs.find((j) => j.job_id === createdJobId);
    assert.ok(found, 'created job is present in list');
    assert.equal(found.state, 'queued');
  });

  await t.test('8. Job detail retrieval returns single job state via GET /research/jobs/:jobId', async () => {
    const res = await clientA.get(`/api/workspaces/${tenantA.workspaceId}/research/jobs/${createdJobId}`);
    assert.equal(res.status, 200);
    assert.ok(res.body.job);
    assert.equal(res.body.job.job_id, createdJobId);
    assert.equal(res.body.job.state, 'queued');
    assert.equal(res.body.job.payload.company, 'Acme Medical');
  });

  await t.test('9. Job detail retrieval returns 404 for non-existent job identifier', async () => {
    const res = await clientA.get(`/api/workspaces/${tenantA.workspaceId}/research/jobs/non-existent-job-id`);
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'not_found');
  });

  await t.test('10. Cross-tenant isolation: Tenant B cannot read or list Tenant A jobs', async () => {
    // Tenant B attempts to read Tenant A's workspace
    const listCross = await clientB.get(`/api/workspaces/${tenantA.workspaceId}/research/jobs`);
    assert.equal(listCross.status, 403, 'cross-workspace access refused');

    // Tenant B attempts to query job detail using Tenant A's workspace
    const detailCross = await clientB.get(`/api/workspaces/${tenantA.workspaceId}/research/jobs/${createdJobId}`);
    assert.equal(detailCross.status, 403, 'cross-workspace detail access refused');

    // Tenant B querying their OWN workspace for Tenant A's job id returns 404
    const ownWorkspaceOtherJob = await clientB.get(`/api/workspaces/${tenantB.workspaceId}/research/jobs/${createdJobId}`);
    assert.equal(ownWorkspaceOtherJob.status, 404);
  });

  await t.test('11. Cross-tenant isolation: Tenant B cannot cancel Tenant A jobs', async () => {
    const cancelCross = await clientB.post(`/api/workspaces/${tenantA.workspaceId}/research/jobs/${createdJobId}/cancel`, {});
    assert.equal(cancelCross.status, 403, 'cross-workspace cancel refused');
  });

  await t.test('12. Authorized cancellation transitions queued job to cancelled', async () => {
    const res = await clientA.post(`/api/workspaces/${tenantA.workspaceId}/research/jobs/${createdJobId}/cancel`, {});
    assert.equal(res.status, 200);
    assert.equal(res.body.job_id, createdJobId);
    assert.equal(res.body.action, 'cancelled');
    assert.equal(res.body.state, 'cancelled');
    assert.ok(res.body.cancel_requested_at);

    // Verify detail reflects cancelled state
    const detail = await clientA.get(`/api/workspaces/${tenantA.workspaceId}/research/jobs/${createdJobId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.job.state, 'cancelled');
  });

  await t.test('13. Cancellation of already terminal job returns unchanged action', async () => {
    const res = await clientA.post(`/api/workspaces/${tenantA.workspaceId}/research/jobs/${createdJobId}/cancel`, {});
    assert.equal(res.status, 200);
    assert.equal(res.body.action, 'unchanged');
    assert.equal(res.body.state, 'cancelled');
  });

  await t.test('14. Preservation of legacy M5 synchronous research endpoints', async () => {
    // Check that GET /api/workspaces/:id/research does not collide with /research/jobs
    const listLegacy = await clientA.get(`/api/workspaces/${tenantA.workspaceId}/research`);
    assert.equal(listLegacy.status, 200);
    assert.ok(Array.isArray(listLegacy.body.jobs));

    // Non-existent legacy research id still returns 404 through getResearch
    const getLegacy = await clientA.get(`/api/workspaces/${tenantA.workspaceId}/research/legacy-request-999`);
    assert.equal(getLegacy.status, 404);
    assert.ok(getLegacy.body.error === 'not_found' || getLegacy.body.message);
  });
});
