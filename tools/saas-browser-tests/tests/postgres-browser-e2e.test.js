'use strict';

/**
 * ZTech SaaS PostgreSQL 16 Browser End-to-End Acceptance Suite
 *
 * Implements Workstream 2:
 * Real browser automation with Chromium against PostgreSQL 16:
 * 1. Register customer
 * 2. Create organization / workspace
 * 3. Open dashboard
 * 4. Enter business discovery criteria
 * 5. Submit synthetic research
 * 6. Inspect evidence in modal
 * 7. Save an opportunity to PostgreSQL
 * 8. Prepare outreach draft
 * 9. Review and approve using authorized account
 * 10. Reload browser and verify state
 * 11. Logout and log back in
 * 12. Restart API process (Server 1 shut down -> Server 2 started pointing to same DB)
 * 13. Recover saved opportunity from PostgreSQL
 * 14. Confirm evidence and pitch association remain intact
 * 15. Confirm unrelated tenant cannot access records (Cross-tenant denial)
 * 16. Capture comprehensive screenshots & failure traces to artifacts/browser-tests/
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
    // Handled in test guard
  }
}
const chromium = playwrightModule ? playwrightModule.chromium : null;

const { ApiServer } = require('../../../packages/lead-intelligence-api/src/server');
const { PostgresStore } = require('../../../packages/lead-intelligence-postgres/src/PostgresStore');
const { freshDatabase, dropDatabase } = require('../../../tests/persistence-contract/lib/postgres');

const STATIC_DIR = path.join(__dirname, '..', '..', '..', 'src', 'saas-client');
const ARTIFACTS_DIR = path.join(__dirname, '..', '..', '..', 'artifacts', 'browser-tests');
const DATABASE_NAME = 'ztech_pg_browser_e2e';

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
  if (executablePath) {
    options.executablePath = executablePath;
  }

  try {
    return await chromium.launch(options);
  } catch {
    delete options.executablePath;
    return await chromium.launch(options);
  }
}

test('ZTech SaaS PostgreSQL 16 Browser E2E Acceptance Journey', async (t) => {
  if (!chromium) {
    t.skip('Playwright is not installed; skipping browser E2E test');
    return;
  }

  const isPgReachable = await checkPg();
  if (!isPgReachable) {
    t.skip('Live PostgreSQL 16 instance not reachable at ZTECH_PG_URL; skipping PostgreSQL browser acceptance');
    return;
  }

  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

  let db;
  let tenantPool;
  let controlPool;
  let identityPool;
  let server1;
  let server2;
  let base1;
  let base2;
  let browser;

  t.before(async () => {
    db = await freshDatabase(DATABASE_NAME, { workspace: '11111111-1111-4111-8111-111111111111' });
    tenantPool = db.pool;
    controlPool = db.controlPool;
    identityPool = db.identityPool;

    browser = await launchBrowser();
  });

  t.after(async () => {
    if (browser) await browser.close().catch(() => {});
    if (server1) await server1.close().catch(() => {});
    if (server2) await server2.close().catch(() => {});
    if (db) await dropDatabase(DATABASE_NAME).catch(() => {});
  });

  const createServerInstance = async () => {
    const s = new ApiServer({
      staticDir: STATIC_DIR,
      identity: identityPool,
      tenant: tenantPool,
      storageMode: 'postgres',
      allowDemoAutologin: false,
      logger: { warn() {}, error() {}, log() {} },
      storeFor: async (session, workspaceId) => new PostgresStore({
        pool: tenantPool,
        controlPool,
        workspaceId,
        sessionId: session?.session_id,
        userId: session?.user_id,
        logger: { warn() {}, error() {}, log() {} },
      }),
    });
    const addr = await s.listen(0);
    return { server: s, baseUrl: `http://127.0.0.1:${addr.port}` };
  };

  const customerEmail = `e2e_founder_${Date.now()}@stjudemedical.co.uk`;
  const customerPassword = 'StJudeSecureClinical2026!';
  const orgName = 'St. Jude Clinical Care Group';
  const workspaceName = 'London Clinical Discovery Desk';

  let aliceWorkspaceId = '';
  let savedOpportunityDomain = '';

  await t.test('Phase 1: Customer Registration, Discovery, Evidence Inspection, Save & Outreach Approval', async (st) => {
    const inst1 = await createServerInstance();
    server1 = inst1.server;
    base1 = inst1.baseUrl;

    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      recordVideo: { dir: ARTIFACTS_DIR, size: { width: 1280, height: 800 } },
    });
    const page = await context.newPage();

    try {
      // 1. Open application & verify Auth screen
      await page.goto(base1, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#auth-screen', { state: 'visible', timeout: 5000 });
      await page.screenshot({ path: path.join(ARTIFACTS_DIR, '01_registration.png'), fullPage: true });

      // 2. Register customer & create organization / workspace
      await page.click('#tab-register');
      await page.waitForSelector('#register-form', { state: 'visible' });

      await page.fill('#reg-email', customerEmail);
      await page.fill('#reg-password', customerPassword);
      await page.fill('#reg-org', orgName);
      await page.fill('#reg-workspace', workspaceName);
      await page.click('#btn-register-submit');

      // 3. Open dashboard & verify authenticated workspace layout
      await page.waitForSelector('#workspace-layout', { state: 'visible', timeout: 8000 });
      await page.waitForSelector('#topbar', { state: 'visible' });

      const emailText = await page.textContent('#user-email-text');
      assert.equal(emailText.trim(), customerEmail);

      const orgText = await page.textContent('#display-org-name');
      assert.equal(orgText.trim(), orgName);

      const roleText = await page.textContent('#user-role-pill');
      assert.equal(roleText.trim(), 'OWNER');

      // Verify persistent PostgreSQL storage badge
      await page.waitForSelector('#storage-badge', { state: 'visible' });
      const storageText = await page.textContent('#storage-mode-text');
      assert.ok(storageText.includes('POSTGRESQL 16'), `Expected PostgreSQL storage badge, found: ${storageText}`);
      await page.screenshot({ path: path.join(ARTIFACTS_DIR, '02_dashboard_overview.png'), fullPage: true });

      // Retrieve workspace ID from page state (browser evaluated)
      // eslint-disable-next-line no-undef
      aliceWorkspaceId = await page.evaluate(() => window.state?.currentWorkspace?.workspace_id);
      assert.ok(aliceWorkspaceId, 'Workspace ID must be populated');

      // 4. Enter business discovery criteria
      await page.click('#nav-discovery');
      await page.waitForSelector('#view-discovery', { state: 'visible' });
      await page.fill('#disc-industry', 'Healthcare & Specialized Clinics');
      await page.selectOption('#disc-country', 'United Kingdom');
      await page.fill('#disc-region', 'London');
      await page.fill('#disc-customer-type', 'Private specialty medical clinics');
      await page.fill('#disc-requirements', 'Legacy appointment booking portal with severe mobile latency (>3s).');
      await page.screenshot({ path: path.join(ARTIFACTS_DIR, '03_discovery_form.png'), fullPage: true });

      // 5. Submit synthetic research
      await page.click('#submit-discovery-btn');
      await page.waitForSelector('#discovery-results-section', { state: 'visible', timeout: 12000 });
      await page.waitForSelector('.opportunity-card', { state: 'visible' });

      const cardCount = await page.locator('.opportunity-card').count();
      assert.ok(cardCount >= 2, `Expected at least 2 discovered cards, found ${cardCount}`);
      await page.screenshot({ path: path.join(ARTIFACTS_DIR, '04_discovered_opportunities.png'), fullPage: true });

      const firstCard = page.locator('.opportunity-card').first();
      savedOpportunityDomain = (await firstCard.locator('.company-domain').textContent()).replace('🌐', '').trim();

      // 6. Inspect evidence in modal
      await firstCard.locator('.inspect-btn').click();
      await page.waitForSelector('#modal-container', { state: 'visible' });

      const modalText = await page.textContent('#modal-body');
      assert.ok(modalText.includes('Technical Audit Findings'));
      assert.ok(modalText.includes('Simulated Demonstration') || modalText.includes('Controlled Synthetic'));
      assert.ok(modalText.includes('ICP Fit Analysis'));
      await page.screenshot({ path: path.join(ARTIFACTS_DIR, '05_evidence_inspection_modal.png'), fullPage: true });

      await page.click('#modal-close-btn');
      await page.waitForSelector('#modal-container', { state: 'hidden' });

      // 7. Save an opportunity to PostgreSQL database
      const saveBtn = firstCard.locator('.save-btn');
      await saveBtn.click();
      await firstCard.locator('.save-btn', { hasText: 'Saved' }).waitFor({ timeout: 6000 });
      await page.screenshot({ path: path.join(ARTIFACTS_DIR, '06_saved_opportunity.png'), fullPage: true });

      // 8. Prepare outreach draft
      await firstCard.locator('.outreach-btn').click();
      await page.waitForSelector('#modal-container', { state: 'visible' });
      await page.waitForSelector('.gate-checklist', { state: 'visible', timeout: 6000 });
      await page.waitForSelector('.pitch-preview-box', { state: 'visible' });

      const draftBody = await page.textContent('#modal-body');
      assert.ok(draftBody.includes('Human Oversight Safety Gate'));
      assert.ok(draftBody.includes('LEAD_IDENTITY'));
      assert.ok(draftBody.includes('HUMAN_APPROVAL'));
      await page.screenshot({ path: path.join(ARTIFACTS_DIR, '07_outreach_draft_modal.png'), fullPage: true });

      // 9. Review and approve using authorized owner account
      const approveBtn = page.locator('#approve-outreach-btn');
      assert.equal(await approveBtn.isDisabled(), false);
      await approveBtn.click();

      await page.waitForSelector('#modal-container', { state: 'hidden' });
      await page.waitForSelector('.toast.success', { state: 'visible' });
      await page.screenshot({ path: path.join(ARTIFACTS_DIR, '08_outreach_approved.png'), fullPage: true });

      // 10. Reload browser and verify session
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#workspace-layout', { state: 'visible', timeout: 6000 });
      const reloadedEmail = await page.textContent('#user-email-text');
      assert.equal(reloadedEmail.trim(), customerEmail);
      await page.screenshot({ path: path.join(ARTIFACTS_DIR, '09_reloaded_session.png'), fullPage: true });

      // 11. Logout and log in again
      await page.click('#logout-btn');
      await page.waitForSelector('#auth-screen', { state: 'visible' });
      await page.fill('#login-email', customerEmail);
      await page.fill('#login-password', customerPassword);
      await page.click('#btn-login-submit');

      await page.waitForSelector('#workspace-layout', { state: 'visible', timeout: 6000 });
      await page.screenshot({ path: path.join(ARTIFACTS_DIR, '10_logout_and_login.png'), fullPage: true });

      await context.close();
    } catch (err) {
      await page.screenshot({ path: path.join(ARTIFACTS_DIR, 'failure_phase1.png'), fullPage: true });
      await context.close();
      throw err;
    }
  });

  await t.test('Phase 2: Restart API Process, Recover Saved Opportunity & Verify Association', async (st) => {
    // 12. Shut down API Server 1
    await server1.close();
    server1 = null;

    // Start completely fresh API Server 2 pointing to the exact same PostgreSQL database
    const inst2 = await createServerInstance();
    server2 = inst2.server;
    base2 = inst2.baseUrl;

    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      recordVideo: { dir: ARTIFACTS_DIR, size: { width: 1280, height: 800 } },
    });
    const page = await context.newPage();

    try {
      // Open restarted server
      await page.goto(base2, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#auth-screen', { state: 'visible', timeout: 6000 });

      // Log in with customer credentials on restarted server
      await page.fill('#login-email', customerEmail);
      await page.fill('#login-password', customerPassword);
      await page.click('#btn-login-submit');
      await page.waitForSelector('#workspace-layout', { state: 'visible', timeout: 8000 });

      // 13. Recover saved opportunity from PostgreSQL
      await page.click('#nav-saved');
      await page.waitForSelector('#view-saved', { state: 'visible' });
      await page.waitForSelector('#saved-container .opportunity-card', { state: 'visible', timeout: 6000 });

      const savedCount = await page.locator('#saved-container .opportunity-card').count();
      assert.equal(savedCount, 1, 'Exactly 1 saved opportunity must be recovered from PostgreSQL');

      const savedCard = page.locator('#saved-container .opportunity-card').first();
      const domainRecovered = (await savedCard.locator('.company-domain').textContent()).replace('🌐', '').trim();
      assert.equal(domainRecovered, savedOpportunityDomain);
      await page.screenshot({ path: path.join(ARTIFACTS_DIR, '11_api_restart_recovery.png'), fullPage: true });

      // 14. Confirm evidence and pitch association remain intact on recovered opportunity
      await savedCard.locator('.outreach-btn').click();
      await page.waitForSelector('#modal-container', { state: 'visible' });
      await page.waitForSelector('.pitch-preview-box', { state: 'visible', timeout: 6000 });

      const pitchContent = await page.textContent('.pitch-preview-box');
      assert.ok(pitchContent.includes(savedOpportunityDomain), 'Pitch must be associated with the recovered domain');
      assert.ok(pitchContent.includes('Latency') || pitchContent.includes('Audit'), 'Evidence observations must remain intact');
      await page.screenshot({ path: path.join(ARTIFACTS_DIR, '12_recovered_pitch_evidence.png'), fullPage: true });

      await page.click('#modal-close-btn');
      await page.waitForSelector('#modal-container', { state: 'hidden' });

      await context.close();
    } catch (err) {
      await page.screenshot({ path: path.join(ARTIFACTS_DIR, 'failure_phase2.png'), fullPage: true });
      await context.close();
      throw err;
    }
  });

  await t.test('Phase 3: Confirm Unrelated Tenant Cannot Access Records (Multi-Tenant Isolation)', async (st) => {
    const competitorContext = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await competitorContext.newPage();

    const competitorEmail = `competitor_${Date.now()}@rivalgroup.co.uk`;
    const competitorPassword = 'RivalVaultPassword2026!';

    try {
      await page.goto(base2, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#auth-screen', { state: 'visible' });

      // Register competitor in separate organization & workspace
      await page.click('#tab-register');
      await page.waitForSelector('#register-form', { state: 'visible' });

      await page.fill('#reg-email', competitorEmail);
      await page.fill('#reg-password', competitorPassword);
      await page.fill('#reg-org', 'Rival Healthcare Holdings Ltd');
      await page.fill('#reg-workspace', 'Rival Clinical Intelligence Desk');
      await page.click('#btn-register-submit');

      await page.waitForSelector('#workspace-layout', { state: 'visible', timeout: 8000 });

      // 15. Confirm competitor has 0 saved opportunities
      await page.click('#nav-saved');
      await page.waitForSelector('#view-saved', { state: 'visible' });
      await page.waitForSelector('#saved-empty-state', { state: 'visible' });

      const competitorSavedCount = await page.locator('#saved-container .opportunity-card').count();
      assert.equal(competitorSavedCount, 0, 'Competitor must not see any saved opportunities');

      // Attempt cross-tenant breach by querying Alice workspace records directly from competitor browser session
      const breachStatus = await page.evaluate(async (targetWsId) => {
        try {
          const res = await fetch(`/api/workspaces/${targetWsId}/opportunities/saved`);
          return res.status;
        } catch {
          return 0;
        }
      }, aliceWorkspaceId);

      assert.equal(breachStatus, 403, 'Cross-workspace access must be denied with 403 Forbidden');
      await page.screenshot({ path: path.join(ARTIFACTS_DIR, '13_unrelated_tenant_isolation.png'), fullPage: true });

      await competitorContext.close();
    } catch (err) {
      await page.screenshot({ path: path.join(ARTIFACTS_DIR, 'failure_phase3.png'), fullPage: true });
      await competitorContext.close();
      throw err;
    }
  });
});
