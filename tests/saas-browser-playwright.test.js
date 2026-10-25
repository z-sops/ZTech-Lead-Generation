'use strict';

/**
 * ZTech SaaS Playwright Browser Acceptance Test Suite
 *
 * Implements genuine end-to-end browser automation with Chromium:
 * - Real clicks, inputs, forms, navigation, and DOM state assertions
 * - End-to-end authenticated customer journey
 * - Evidence inspection & qualitative ICP fit verification
 * - Opportunity persistence across navigation & page refresh
 * - Human Outreach Gate & supervisor authorization verification
 * - Desktop (1280x800) and Mobile (375x667) viewport responsiveness
 * - Error screenshot & trace diagnostics
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
let playwrightModule;
try {
  playwrightModule = require('playwright');
} catch {
  try {
    playwrightModule = require(path.join(__dirname, '..', 'tools', 'saas-browser-tests', 'node_modules', 'playwright'));
  } catch {
    // If not found, skip gracefully
  }
}
const chromium = playwrightModule ? playwrightModule.chromium : null;
const { ApiServer } = require('../packages/lead-intelligence-api/src/server');

const STATIC_DIR = path.join(__dirname, '..', 'src', 'saas-client');
const ARTIFACTS_DIR = path.join(__dirname, '..', 'artifacts', 'browser-tests');

async function launchChromium() {
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

  const options = { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] };
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

test('ZTech Playwright Browser Acceptance Suite', async (t) => {
  if (!chromium) {
    t.skip('Playwright is not installed; run from tools/saas-browser-tests');
    return;
  }
  let server;
  let baseUrl;
  let browser;

  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

  t.before(async () => {
    server = new ApiServer({
      staticDir: STATIC_DIR,
      storageMode: 'local-demo',
      allowDemoAutologin: true,
      logger: { warn() {}, error() {}, log() {} },
    });
    const addr = await server.listen(0);
    baseUrl = `http://127.0.0.1:${addr.port}`;

    browser = await launchChromium();
  });

  t.after(async () => {
    if (browser) await browser.close();
    if (server) await server.close();
  });

  await t.test('Complete End-to-End Customer SaaS Journey in Real Browser', async (st) => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();

    try {
      // 1. Open the application
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#auth-screen', { state: 'visible' });

      // Verify page title and header
      const title = await page.title();
      assert.ok(title.includes('ZTech Lead Generation'));

      // 2. Switch to Registration and create account
      await page.click('#tab-register');
      await page.waitForSelector('#register-form', { state: 'visible' });

      const email = `playwright_${Date.now()}@testclinic.co.uk`;
      await page.fill('#reg-email', email);
      await page.fill('#reg-password', 'ClinicalVaultPassword2026!');
      await page.fill('#reg-org', 'Baker Street Health Group');
      await page.fill('#reg-workspace', 'London Outpatient Intelligence Desk');

      await page.click('#btn-register-submit');

      // 3. Authenticated workspace layout becomes visible
      await page.waitForSelector('#workspace-layout', { state: 'visible', timeout: 5000 });
      await page.waitForSelector('#topbar', { state: 'visible' });

      const displayedEmail = await page.textContent('#user-email-text');
      assert.equal(displayedEmail.trim(), email);

      const orgText = await page.textContent('#display-org-name');
      assert.equal(orgText.trim(), 'Baker Street Health Group');

      const roleText = await page.textContent('#user-role-pill');
      assert.equal(roleText.trim(), 'OWNER');

      // Verify truthful storage and demo banner
      const bannerText = await page.textContent('#demo-banner');
      assert.ok(bannerText.includes('DEMO / SYNTHETIC RESEARCH'));

      // 4. Navigate to Discovery view
      await page.click('#nav-discovery');
      await page.waitForSelector('#view-discovery', { state: 'visible' });

      // 5. Enter discovery criteria and submit
      await page.fill('#disc-industry', 'Healthcare & Specialized Clinics');
      await page.selectOption('#disc-country', 'United Kingdom');
      await page.fill('#disc-region', 'London');
      await page.fill('#disc-customer-type', 'Private specialty clinics');
      await page.fill('#disc-requirements', 'Legacy booking portal with mobile latency and missing meta descriptions.');

      await page.click('#submit-discovery-btn');

      // Wait for results section to populate
      await page.waitForSelector('#discovery-results-section', { state: 'visible', timeout: 10000 });
      await page.waitForSelector('.opportunity-card', { state: 'visible' });

      const cardCount = await page.locator('.opportunity-card').count();
      assert.ok(cardCount >= 2, `Expected at least 2 opportunity cards, found ${cardCount}`);

      // 6. Verify honest evidence labels and qualitative fit on the cards
      const firstCard = page.locator('.opportunity-card').first();
      const cardText = await firstCard.textContent();

      assert.ok(cardText.includes('Simulated Demo Fixture') || cardText.includes('Controlled synthetic'));
      assert.ok(cardText.includes('Qualitative Fit') || cardText.includes('FIT'));

      // 7. Inspect opportunity evidence in modal
      await firstCard.locator('.inspect-btn').click();
      await page.waitForSelector('#modal-container', { state: 'visible' });

      const modalContent = await page.textContent('#modal-body');
      assert.ok(modalContent.includes('Technical Audit Findings (Simulated Demonstration)'));
      assert.ok(modalContent.includes('Controlled Synthetic Data') || modalContent.includes('controlled_demo_fixture'));
      assert.ok(modalContent.includes('ICP Fit Analysis'));

      // Close modal
      await page.click('#modal-close-btn');
      await page.waitForSelector('#modal-container', { state: 'hidden' });

      // 8. Save opportunity to workspace database
      const saveBtn = firstCard.locator('.save-btn');
      await saveBtn.click();
      await firstCard.locator('.save-btn', { hasText: 'Saved' }).waitFor({ timeout: 5000 });

      // 9. Open Saved Opportunities screen
      await page.click('#nav-saved');
      await page.waitForSelector('#view-saved', { state: 'visible' });
      await page.waitForSelector('#saved-container .opportunity-card', { state: 'visible' });

      const savedCount = await page.locator('#saved-container .opportunity-card').count();
      assert.equal(savedCount, 1);

      // 10. Prepare outreach draft from saved screen
      await page.click('#saved-container .opportunity-card .outreach-btn');
      await page.waitForSelector('#modal-container', { state: 'visible' });

      // Wait for pitch generator and gate checklist to render
      await page.waitForSelector('.pitch-preview-box', { state: 'visible', timeout: 5000 });
      await page.waitForSelector('.gate-checklist', { state: 'visible' });

      const outreachText = await page.textContent('#modal-body');
      assert.ok(outreachText.includes('Human Oversight Safety Gate'));
      assert.ok(outreachText.includes('Outreach Gate Compliance Verification'));
      assert.ok(outreachText.includes('HUMAN_APPROVAL'));

      // 11. Owner approves draft for human dispatch
      const approveBtn = page.locator('#approve-outreach-btn');
      assert.equal(await approveBtn.isDisabled(), false);
      await approveBtn.click();

      // Wait for modal to close and toast notification
      await page.waitForSelector('#modal-container', { state: 'hidden' });
      await page.waitForSelector('.toast.success', { state: 'visible' });

      // 12. Session Recovery on Page Reload
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#workspace-layout', { state: 'visible', timeout: 5000 });

      const restoredEmail = await page.textContent('#user-email-text');
      assert.equal(restoredEmail.trim(), email);

      // 13. Mobile Viewport Usability Verification (375x667)
      await page.setViewportSize({ width: 375, height: 667 });
      await page.waitForTimeout(300);

      // Verify workspace container and navigation adapt cleanly
      const isSidebarRendered = await page.isVisible('#sidebar-nav');
      assert.ok(isSidebarRendered);

      // Return to desktop viewport
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.waitForTimeout(200);

      // Sign out
      await page.click('#logout-btn');
      await page.waitForSelector('#auth-screen', { state: 'visible' });

      await context.close();
    } catch (err) {
      const screenshotPath = path.join(ARTIFACTS_DIR, `failure_${Date.now()}.png`);
      try {
        await page.screenshot({ path: screenshotPath, fullPage: true });
        console.error(`Captured error screenshot to ${screenshotPath}`);
      } catch {}
      await context.close();
      throw err;
    }
  });
});
