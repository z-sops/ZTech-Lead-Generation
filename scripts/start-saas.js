#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { Pool } = require('pg');
const { ApiServer } = require('../packages/lead-intelligence-api/src/server');
const { PostgresStore } = require('../packages/lead-intelligence-postgres/src/PostgresStore');

const DEFAULT_PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const STATIC_DIR = path.join(__dirname, '..', 'src', 'saas-client');

function parseArgs(argv) {
  const opts = {
    port: DEFAULT_PORT,
    postgres: Boolean(process.env.ZTECH_PG_URL),
    demoAutologin: process.env.ALLOW_DEMO_AUTOLOGIN === 'true' || process.env.ALLOW_DEMO_AUTOLOGIN === '1',
    demoSeed: process.env.ZTECH_DEMO_SEED === 'true' || process.env.ZTECH_DEMO_SEED === '1',
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--postgres' || arg === '--pg') opts.postgres = true;
    else if (arg === '--demo') opts.postgres = false;
    else if (arg === '--allow-demo-autologin') opts.demoAutologin = true;
    else if (arg === '--seed' || arg === '--demo-seed') opts.demoSeed = true;
    else if (arg.startsWith('--port=')) opts.port = Number(arg.slice(7)) || DEFAULT_PORT;
    else if (arg === '-p' && argv[i + 1]) opts.port = Number(argv[++i]) || DEFAULT_PORT;
  }
  return opts;
}

async function main(listenPort = DEFAULT_PORT, cliArgs = process.argv) {
  const opts = parseArgs(cliArgs);
  const port = listenPort !== DEFAULT_PORT ? listenPort : opts.port;
  const isProduction = process.env.NODE_ENV === 'production' || process.env.ZTECH_ENV === 'production';

  // Production containment checks
  if (isProduction) {
    if (opts.demoSeed) {
      throw new Error('Demo account seeding is strictly forbidden in production mode');
    }
    if (opts.demoAutologin) {
      throw new Error('Demo auto-login is strictly forbidden in production mode');
    }
    if (!process.env.ZTECH_PG_URL) {
      throw new Error('Production mode requires PostgreSQL persistent storage (ZTECH_PG_URL)');
    }
  }

  let identityPool = null;
  let tenantPool = null;
  let controlPool = null;
  let storeFor = null;
  let activeMode = 'local-demo';

  if (opts.postgres || process.env.ZTECH_PG_URL) {
    const pgUrl = process.env.ZTECH_PG_URL;
    if (!pgUrl) {
      throw new Error('PostgreSQL mode requested but ZTECH_PG_URL is not set. Refusing to fall back to in-memory storage.');
    }

    try {
      // Connect to PostgreSQL 16
      identityPool = new Pool({ connectionString: pgUrl });
      tenantPool = new Pool({ connectionString: pgUrl });
      controlPool = new Pool({ connectionString: pgUrl });

      // Verify connection immediately - DO NOT SILENTLY FALL BACK!
      await identityPool.query('SELECT 1');
      activeMode = 'postgres';
      console.log('✓ Connected to PostgreSQL persistent storage');

      storeFor = async (session, workspaceId) => new PostgresStore({
        pool: tenantPool,
        controlPool,
        workspaceId,
        sessionId: session?.session_id,
        userId: session?.user_id,
        logger: console,
      });
    } catch (err) {
      if (identityPool) await identityPool.end().catch(() => {});
      if (tenantPool) await tenantPool.end().catch(() => {});
      if (controlPool) await controlPool.end().catch(() => {});
      throw new Error(`PostgreSQL integration connection failed: ${err.message}. Refusing to fall back to in-memory mode.`);
    }
  }

  const server = new ApiServer({
    identity: identityPool,
    tenant: tenantPool,
    storeFor,
    mode: isProduction ? 'production' : activeMode,
    allowDemoAutologin: opts.demoAutologin && !isProduction,
    staticDir: STATIC_DIR,
    logger: console,
  });

  // Opt-in demo seeding (forbidden in production)
  if (opts.demoSeed && !isProduction) {
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
  }

  const addr = await server.listen(port, HOST);
  const actualPort = addr.port;

  const originalClose = server.close.bind(server);
  server.close = async () => {
    await originalClose();
    if (identityPool) await identityPool.end().catch(() => {});
    if (tenantPool) await tenantPool.end().catch(() => {});
    if (controlPool) await controlPool.end().catch(() => {});
  };

  console.log('\n================================================================');
  console.log('  ZTech Lead Generation — SaaS Customer Workspace');
  console.log(`  Local Browser App: http://${HOST}:${actualPort}`);
  console.log(`  Runtime Storage:   ${activeMode.toUpperCase()}${activeMode === 'local-demo' ? ' (Ephemeral In-Memory)' : ' (Persistent PostgreSQL)'}`);
  console.log(`  Demo Auto-Login:   ${opts.demoAutologin ? 'ENABLED (Loopback Only)' : 'DISABLED'}`);
  console.log(`  Demo Seeding:      ${opts.demoSeed ? 'ENABLED' : 'DISABLED (Opt-in)'}`);
  console.log('----------------------------------------------------------------');
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
