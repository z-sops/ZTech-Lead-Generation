'use strict';

/**
 * ZTech SaaS Standalone Playwright Demo Acceptance Test
 *
 * Runs the demo customer journey in headless Chromium using local-demo mode.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { ApiServer } = require('../../../packages/lead-intelligence-api/src/server');

const STATIC_DIR = path.join(__dirname, '..', '..', '..', 'src', 'saas-client');
const ARTIFACTS_DIR = path.join(__dirname, '..', '..', '..', 'artifacts', 'browser-tests');

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

test('ZTech SaaS Standalone Browser Demo Acceptance', async (t) => {
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

    browser = await launchBrowser();
  });

  t.after(async () => {
    if (browser) await browser.close();
    if (server) await server.close();
  });

  await t.test('Complete End-to-End Customer Journey in Browser', async (st) => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();

    try {
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#auth-screen', { state: 'visible' });

      // Register customer
      await page.click('#tab-register');
      await page.waitForSelector('#register-form', { state: 'visible' });

      const email = `playwright_demo_${Date.now()}@testclinic.co.uk`;
      await page.fill('#reg-email', email);
      await page.fill('#reg-password', 'ClinicalVaultPassword2026!');
      await page.fill('#reg-org', 'Mayfair Diagnostic Centre');
      await page.fill('#reg-workspace', 'London Outpatient Intelligence Desk');
      await page.click('#btn-register-submit');

      // Authenticated layout
      await page.waitForSelector('#workspace-layout', { state: 'visible', timeout: 6000 });
      const displayedEmail = await page.textContent('#user-email-text');
      assert.equal(displayedEmail.trim(), email);

      // Discovery
      await page.click('#nav-discovery');
      await page.waitForSelector('#view-discovery', { state: 'visible' });
      await page.fill('#disc-industry', 'Healthcare & Specialized Clinics');
      await page.selectOption('#disc-country', 'United Kingdom');
      await page.fill('#disc-region', 'London');
      await page.fill('#disc-requirements', 'Legacy booking portal with mobile latency.');
      await page.click('#submit-discovery-btn');

      // Results
      await page.waitForSelector('#discovery-results-section', { state: 'visible', timeout: 10000 });
      await page.waitForSelector('.opportunity-card', { state: 'visible' });

      const cardCount = await page.locator('.opportunity-card').count();
      assert.ok(cardCount >= 2);

      const firstCard = page.locator('.opportunity-card').first();

      // Inspect Evidence
      await firstCard.locator('.inspect-btn').click();
      await page.waitForSelector('#modal-container', { state: 'visible' });
      await page.click('#modal-close-btn');
      await page.waitForSelector('#modal-container', { state: 'hidden' });

      // Save
      await firstCard.locator('.save-btn').click();
      await firstCard.locator('.save-btn', { hasText: 'Saved' }).waitFor({ timeout: 5000 });

      // Saved view
      await page.click('#nav-saved');
      await page.waitForSelector('#view-saved', { state: 'visible' });
      await page.waitForSelector('#saved-container .opportunity-card', { state: 'visible' });

      // Outreach
      await page.click('#saved-container .opportunity-card .outreach-btn');
      await page.waitForSelector('#modal-container', { state: 'visible' });
      await page.waitForSelector('.gate-checklist', { state: 'visible' });

      // Approve
      await page.click('#approve-outreach-btn');
      await page.waitForSelector('#modal-container', { state: 'hidden' });

      // Reload
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#workspace-layout', { state: 'visible' });

      // Mobile viewport
      await page.setViewportSize({ width: 375, height: 667 });
      await page.waitForTimeout(200);
      assert.ok(await page.isVisible('#sidebar-nav'));

      await context.close();
    } catch (err) {
      await context.close();
      throw err;
    }
  });
});
