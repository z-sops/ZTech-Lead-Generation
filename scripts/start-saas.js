#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { ApiServer } = require('../packages/lead-intelligence-api/src/server');

const DEFAULT_PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const STATIC_DIR = path.join(__dirname, '..', 'src', 'saas-client');

async function main(listenPort = DEFAULT_PORT) {
  const server = new ApiServer({
    staticDir: STATIC_DIR,
    logger: console,
  });

  // Pre-seed demo user in identity store if needed
  try {
    const existing = await server.service.findUserByEmail('alice@ztech.test');
    if (!existing) {
      await server.service.register({
        email: 'alice@ztech.test',
        password: 'correct-horse-battery-staple',
        displayName: 'Alice Lead Strategist',
        organization: 'Alice Opportunity Ventures',
        workspaceName: 'London Healthcare & Clinics',
      });
      console.log('✓ Demo account provisioned: alice@ztech.test');
    }
  } catch (err) {
    console.warn(`Note: Demo seed check: ${err.message}`);
  }

  const addr = await server.listen(listenPort, HOST);
  const actualPort = addr.port;

  console.log('\n================================================================');
  console.log('  ZTech Lead Generation — SaaS Customer Workspace');
  console.log(`  Local Browser App: http://${HOST}:${actualPort}`);
  console.log('----------------------------------------------------------------');
  console.log('  Demo Credentials:');
  console.log('    Email:    alice@ztech.test');
  console.log('    Password: correct-horse-battery-staple');
  console.log('  Features:');
  console.log('    • Real M3 Session & CSRF Security');
  console.log('    • Evidence-Backed Opportunity Discovery');
  console.log('    • PitchGenerator & Outreach Gate Human Oversight');
  console.log('    • Tenant-Isolated Workspace Data Persistence');
  console.log('    • Auto-send & Live Provider Spend: PROHIBITED (Controlled Demo)');
  console.log('================================================================\n');

  server.port = actualPort;
  server.url = `http://${HOST}:${actualPort}`;
  return server;
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal startup error:', err);
    process.exit(1);
  });
}

module.exports = { startSaasServer: main };
