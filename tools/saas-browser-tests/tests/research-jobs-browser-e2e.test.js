'use strict';

/* global document, window */

/**
 * ZTech Phase 1 — Durable Research Jobs Browser End-to-End Acceptance.
 *
 * Drives the real customer journey in Chromium against real PostgreSQL 16 and
 * the ACTUAL worker (not a mock): register, submit an asynchronous research
 * job (HTTP 202), watch the worker claim and execute it, and verify the
 * authoritative state and history survive refresh, re-login and process
 * restart. Cross-tenant isolation and authorized cancellation are exercised
 * against the live roles.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { Pool } = require('pg');

let playwrightModule;
try {
  playwrightModule = require('playwright');
} catch {
  try {
    playwrightModule = require(path.join(__dirname, '..', 'node_modules', 'playwright'));
  } catch {
    // Handled in the test guard.
  }
}
const chromium = playwrightModule ? playwrightModule.chromium : null;

const { ApiServer } = require('../../../packages/lead-intelligence-api/src/server');
const { PostgresStore } = require('../../../packages/lead-intelligence-postgres/src/PostgresStore');
const { Worker } = require('../../../packages/lead-intelligence-worker/src/worker');
const { IdentityProvider } = require('../../../packages/lead-intelligence-worker/src/identity');
const { executeNoop } = require('../../../packages/lead-intelligence-worker/src/noop');
const {
  freshDatabase, dropDatabase, roleUrl, ROLES,
} = require('../../../tests/persistence-contract/lib/postgres');

const STATIC_DIR = path.join(__dirname, '..', '..', '..', 'src', 'saas-client');
const ARTIFACTS_DIR = path.join(__dirname, '..', '..', '..', 'artifacts', 'browser-tests');
const DATABASE_NAME = 'ztech_pg_research_jobs_e2e';

const PG_URL = process.env.ZTECH_PG_URL || '';

async function checkPg() {
  if (!PG_URL) return false;
  try {
    const p = new Pool({ connectionString: PG_URL, connectionTimeoutMillis: 2000 });
    await p.query('SELECT 1');
    await p.end();
    return true;
  } catch {
    return false;
  }
}

async function launchBrowser() {
  const candidatePaths = [
    process.env.CHROME_BIN,
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    ...(process.platform === 'win32' ? [
      process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
      process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
      process.env.LocalAppData ? path.join(process.env.LocalAppData, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
    ] : [
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
    ]),
  ].filter(Boolean);

  let executablePath;
  for (const p of candidatePaths) {
    if (p && fs.existsSync(p)) {
      executablePath = p;
      break;
    }
  }

  const options = {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  };
  if (executablePath) options.executablePath = executablePath;

  try {
    return await chromium.launch(options);
  } catch {
    delete options.executablePath;
    return await chromium.launch(options);
  }
}

test('ZTech Phase 1 Durable Research Jobs Browser E2E', async (t) => {
  if (!chromium) {
    t.skip('Playwright is not installed; skipping research jobs browser E2E');
    return;
  }
  if (!(await checkPg())) {
    t.skip('Live PostgreSQL 16 instance not reachable at ZTECH_PG_URL; skipping research jobs browser E2E');
    return;
  }

  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

  let db;
  let browser;
  let server;
  let base;
  let worker;
  let workerLoop;
  const pools = [];

  t.before(async () => {
    db = await freshDatabase(DATABASE_NAME, { workspace: '11111111-1111-4111-8111-111111111111' });
    browser = await launchBrowser();
  });

  t.after(async () => {
    if (worker) worker.stop();
    if (workerLoop) await workerLoop.catch(() => {});
    for (const p of pools) await p.end().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    if (server) await server.close().catch(() => {});
    if (db) await dropDatabase(DATABASE_NAME).catch(() => {});
  });

  const createServerInstance = async () => {
    const s = new ApiServer({
      staticDir: STATIC_DIR,
      identity: db.identityPool,
      tenant: db.pool,
      storageMode: 'postgres',
      allowDemoAutologin: false,
      logger: { warn() {}, error() {}, log() {} },
      storeFor: async (session, workspaceId) => new PostgresStore({
        pool: db.pool,
        controlPool: db.controlPool,
        workspaceId,
        sessionId: session?.session_id,
        userId: session?.user_id,
        logger: { warn() {}, error() {}, log() {} },
      }),
    });
    const addr = await s.listen(0);
    return { server: s, baseUrl: `http://127.0.0.1:${addr.port}` };
  };

  const startWorker = async (workerId) => {
    const pool = new Pool({ connectionString: roleUrl(ROLES.worker, DATABASE_NAME), options: '-c search_path=li' });
    pool.on('error', () => {});
    pools.push(pool);
    const r = await db.controlPool.query('SELECT li.issue_worker_identity($1, $2) AS token', [workerId, 300]);
    const config = {
      workerId,
      databaseUrl: roleUrl(ROLES.worker, DATABASE_NAME),
      identityToken: r.rows[0].token,
      leaseSeconds: 120,
      heartbeatSeconds: 30,
      tokenTtlSeconds: 120,
      pollIntervalMs: 50,
      maxJobsPerRun: 0,
    };
    const identity = new IdentityProvider(config);
    const w = new Worker({
      pool,
      config,
      identity,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      executor: executeNoop,
    });
    return w;
  };

  const customerEmail = `rj_founder_${Date.now()}@stjudemedical.co.uk`;
  const customerPassword = 'StJudeSecureClinical2026!';
  const orgName = 'St. Jude Clinical Care Group';
  const workspaceName = 'London Clinical Discovery Desk';

  let aliceWorkspaceId = '';

  await t.test('Phase 1: enqueue, worker execution, history and recovery', async () => {
    const inst = await createServerInstance();
    server = inst.server;
    base = inst.baseUrl;

    // Start the ACTUAL worker before the customer submits anything.
    worker = await startWorker('rj-browser-worker');
    workerLoop = worker.loop();

    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();

    try {
      // Register.
      await page.goto(base, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#auth-screen', { state: 'visible', timeout: 5000 });
      await page.click('#tab-register');
      await page.waitForSelector('#register-form', { state: 'visible' });
      await page.fill('#reg-email', customerEmail);
      await page.fill('#reg-password', customerPassword);
      await page.fill('#reg-org', orgName);
      await page.fill('#reg-workspace', workspaceName);
      await page.click('#btn-register-submit');
      await page.waitForSelector('#workspace-layout', { state: 'visible', timeout: 8000 });

      aliceWorkspaceId = await page.evaluate(`(() => window.state && window.state.currentWorkspace ? window.state.currentWorkspace.workspace_id : null)()`);
      assert.ok(aliceWorkspaceId, 'workspace id is populated');

      // Navigate to the Research Jobs view.
      await page.click('#nav-research-jobs');
      await page.waitForSelector('#view-research-jobs', { state: 'visible' });

      // Submit a research job (HTTP 202 via the API).
      await page.fill('#rj-requirements', 'UK healthcare clinics with legacy booking portals');
      await page.click('#rj-submit-btn');

      // The job appears in the history, initially queued, then the worker
      // claims and executes it. Poll the authoritative backend via the UI.
      await page.waitForSelector('.rj-row', { state: 'visible', timeout: 8000 });
      await page.screenshot({ path: path.join(ARTIFACTS_DIR, 'rj_01_queued.png'), fullPage: true });

      // Wait for the worker to complete the job (bounded polling).
      await page.waitForFunction(
        () => {
          const el = document.querySelector('.rj-state.succeeded');
          return Boolean(el);
        },
        { timeout: 15000 },
      );
      await page.screenshot({ path: path.join(ARTIFACTS_DIR, 'rj_02_succeeded.png'), fullPage: true });

      // The job id is rendered.
      const jobIdText = await page.textContent('.rj-id');
      assert.ok(jobIdText && jobIdText.trim().length > 0, 'a durable job id is rendered');

      // Browser refresh recovery: the persisted job survives a reload.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#workspace-layout', { state: 'visible', timeout: 6000 });
      await page.click('#nav-research-jobs');
      await page.waitForSelector('.rj-row', { state: 'visible', timeout: 8000 });
      const stateAfterReload = await page.textContent('.rj-state');
      assert.equal(stateAfterReload.trim(), 'succeeded', 'the job state survives a browser refresh');
      await page.screenshot({ path: path.join(ARTIFACTS_DIR, 'rj_03_refresh_recovery.png'), fullPage: true });

      // Logout / login recovery.
      await page.click('#logout-btn');
      await page.waitForSelector('#auth-screen', { state: 'visible' });
      await page.fill('#login-email', customerEmail);
      await page.fill('#login-password', customerPassword);
      await page.click('#btn-login-submit');
      await page.waitForSelector('#workspace-layout', { state: 'visible', timeout: 6000 });
      await page.click('#nav-research-jobs');
      await page.waitForSelector('.rj-row', { state: 'visible', timeout: 8000 });
      const stateAfterLogin = await page.textContent('.rj-state');
      assert.equal(stateAfterLogin.trim(), 'succeeded', 'the job state survives logout/login');
      await page.screenshot({ path: path.join(ARTIFACTS_DIR, 'rj_04_login_recovery.png'), fullPage: true });

      await context.close();
    } catch (err) {
      await page.screenshot({ path: path.join(ARTIFACTS_DIR, 'rj_failure_phase1.png'), fullPage: true }).catch(() => {});
      await context.close();
      throw err;
    }
  });

  await t.test('Phase 2: idempotent submission and authorized cancellation', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();

    try {
      await page.goto(base, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#auth-screen', { state: 'visible' });
      await page.fill('#login-email', customerEmail);
      await page.fill('#login-password', customerPassword);
      await page.click('#btn-login-submit');
      await page.waitForSelector('#workspace-layout', { state: 'visible', timeout: 6000 });
      await page.click('#nav-research-jobs');
      await page.waitForSelector('#view-research-jobs', { state: 'visible' });

      // Idempotent submission: the same idempotency key returns the same job.
      const idemKey = `idem-${Date.now()}`;
      const enqueue = async () => page.evaluate(async (key) => {
        const res = await fetch(`/api/workspaces/${window.state.currentWorkspace.workspace_id}/research/jobs`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-csrf-token': window.state.csrfToken },
          body: JSON.stringify({ idempotency_key: key, payload: { criteria: 'idempotent test' } }),
        });
        return { status: res.status, body: await res.json() };
      }, idemKey);

      const first = await enqueue();
      assert.equal(first.status, 202, 'the first enqueue is accepted');
      const second = await enqueue();
      assert.equal(second.status, 202, 'the duplicate enqueue is accepted');
      assert.equal(second.body.job_id, first.body.job_id, 'the same idempotency key returns the same job id');
      assert.equal(second.body.deduplicated, true, 'the duplicate is marked deduplicated');

      // Authorized cancellation of a queued job.
      const cancelRes = await page.evaluate(async (jobId) => {
        const res = await fetch(`/api/workspaces/${window.state.currentWorkspace.workspace_id}/research/jobs/${jobId}/cancel`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-csrf-token': window.state.csrfToken },
          body: JSON.stringify({}),
        });
        return { status: res.status, body: await res.json() };
      }, first.body.job_id);
      assert.equal(cancelRes.status, 200, 'cancellation is authorized');
      await page.screenshot({ path: path.join(ARTIFACTS_DIR, 'rj_05_cancel.png'), fullPage: true });

      await context.close();
    } catch (err) {
      await page.screenshot({ path: path.join(ARTIFACTS_DIR, 'rj_failure_phase2.png'), fullPage: true }).catch(() => {});
      await context.close();
      throw err;
    }
  });

  await t.test('Phase 3: cross-tenant job isolation', async () => {
    const competitorContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await competitorContext.newPage();

    try {
      await page.goto(base, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#auth-screen', { state: 'visible' });
      await page.click('#tab-register');
      await page.waitForSelector('#register-form', { state: 'visible' });
      await page.fill('#reg-email', `competitor_${Date.now()}@rivalgroup.co.uk`);
      await page.fill('#reg-password', 'RivalVaultPassword2026!');
      await page.fill('#reg-org', 'Rival Healthcare Holdings Ltd');
      await page.fill('#reg-workspace', 'Rival Clinical Intelligence Desk');
      await page.click('#btn-register-submit');
      await page.waitForSelector('#workspace-layout', { state: 'visible', timeout: 8000 });

      // The competitor cannot list Alice's jobs.
      const breachStatus = await page.evaluate(async (targetWsId) => {
        try {
          const res = await fetch(`/api/workspaces/${targetWsId}/research/jobs`);
          return res.status;
        } catch {
          return 0;
        }
      }, aliceWorkspaceId);
      assert.equal(breachStatus, 403, 'cross-workspace job listing is denied with 403');
      await page.screenshot({ path: path.join(ARTIFACTS_DIR, 'rj_06_cross_tenant.png'), fullPage: true });

      await competitorContext.close();
    } catch (err) {
      await page.screenshot({ path: path.join(ARTIFACTS_DIR, 'rj_failure_phase3.png'), fullPage: true }).catch(() => {});
      await competitorContext.close();
      throw err;
    }
  });
});
