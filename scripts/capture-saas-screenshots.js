#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { startSaasServer } = require('./start-saas');

const OUTPUT_DIR = path.join(__dirname, '..', 'docs', 'screenshots');
function findBrowser() {
  const candidates = [
    process.env.CHROME_BIN,
    process.env.EDGE_BIN,
    process.env['PROGRAMFILES'] && path.join(process.env['PROGRAMFILES'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env['PROGRAMFILES'] && path.join(process.env['PROGRAMFILES'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].filter(Boolean);

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function captureScreenshot(browserPath, url, outputPath, delayMs = 2500) {
  return new Promise((resolve, reject) => {
    const args = [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--window-size=1280,850',
      `--virtual-time-budget=${delayMs}`,
      `--screenshot=${outputPath}`,
      url,
    ];

    const proc = spawn(browserPath, args, { stdio: 'inherit' });
    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputPath)) {
        resolve(outputPath);
      } else {
        // Fallback check if file exists despite code
        if (fs.existsSync(outputPath)) {
          resolve(outputPath);
        } else {
          reject(new Error(`Browser screenshot failed for ${url} (exit code ${code})`));
        }
      }
    });
    proc.on('error', reject);
  });
}

async function main() {
  const browser = findBrowser();
  if (!browser) {
    console.error('No supported browser (Chrome or Edge) found for headless screenshot capture.');
    process.exit(1);
  }

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const server = await startSaasServer(3912);
  const baseUrl = server.url;

  try {
    console.log('Capturing SaaS browser screenshots to docs/screenshots/...\n');

    const screens = [
      { name: '01_auth_onboarding.png', url: `${baseUrl}/`, delay: 1500 },
      { name: '02_workspace_overview.png', url: `${baseUrl}/?autologin=1&view=overview`, delay: 2000 },
      { name: '03_opportunity_discovery.png', url: `${baseUrl}/?autologin=1&execute_demo=1`, delay: 3500 },
      { name: '04_opportunity_evidence_detail.png', url: `${baseUrl}/?autologin=1&execute_demo=1&modal=detail`, delay: 3500 },
      { name: '05_outreach_preparation_gate.png', url: `${baseUrl}/?autologin=1&execute_demo=1&modal=outreach`, delay: 3500 },
    ];

    for (const s of screens) {
      const outPath = path.join(OUTPUT_DIR, s.name);
      await captureScreenshot(browser, s.url, outPath, s.delay);
      const stats = fs.statSync(outPath);
      console.log(`✓ [${s.name}] captured (${stats.size} bytes)`);
    }

    console.log('\nAll 5 SaaS vertical slice screenshots captured successfully!');
  } finally {
    await server.close();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Screenshot capture failed:', err);
    process.exit(1);
  });
}

module.exports = { captureScreenshots: main };
