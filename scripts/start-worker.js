#!/usr/bin/env node
'use strict';

/**
 * ZTech Phase 1 — the background worker startup.
 *
 * Starts the M4 P1 worker with the correct, least-privilege credentials.
 * The worker connects as `ztech_worker` (no BYPASSRLS, not the migrator,
 * not the control plane) and receives an identity credential that it never
 * signs itself.
 *
 * The startup orchestrator holds the control-plane credential only long
 * enough to mint the worker's identity credential (the one thing the control
 * plane exists to do). The worker runtime itself never sees the control-plane
 * credential, the migrator credential or any administrative credential.
 *
 * Usage:
 *   node scripts/start-worker.js
 *
 * Environment:
 *   ZTECH_PG_URL                        the base PostgreSQL URL (host/db only)
 *   ZTECH_PG_PASSWORD_ZTECH_WORKER      the worker role credential
 *   ZTECH_PG_PASSWORD_ZTECH_CONTROL      the control-plane credential (to mint
 *                                        the identity credential; optional when
 *                                        ZTECH_WORKER_IDENTITY_TOKEN is set)
 *   ZTECH_WORKER_ID                     the worker's identity (required)
 *   ZTECH_WORKER_IDENTITY_TOKEN         a pre-minted identity credential
 *                                       (optional; minted if absent)
 *   ZTECH_WORKER_LEASE_SECONDS          optional, default 120
 *   ZTECH_WORKER_HEARTBEAT_SECONDS      optional, default 30
 *   ZTECH_WORKER_TOKEN_TTL_SECONDS      optional, default 120
 *   ZTECH_WORKER_POLL_MS                optional, default 500
 *   ZTECH_WORKER_MAX_JOBS               optional, default 0 (run until stopped)
 */

const { Pool } = require('pg');
const { collectCredentials, credentialUrl } = require('./lib/postgres-credentials');
const { main } = require('../packages/lead-intelligence-worker/src/index');

/** The identity credential lifetime the startup mints (seconds). */
const IDENTITY_TTL_SECONDS = 300;

/**
 * Build the worker's own connection string from the base URL and the worker
 * role credential, and mint the identity credential through the control plane
 * when one is not already supplied. Then hand off to the worker's `main()`.
 */
async function start() {
  const baseUrl = process.env.ZTECH_PG_URL;
  if (!baseUrl) {
    throw new Error(
      'ZTECH_PG_URL is required: the base PostgreSQL URL. The worker role credential is added from ZTECH_PG_PASSWORD_ZTECH_WORKER.',
    );
  }

  // The worker connects as ztech_worker, never as an administrator.
  const workerCreds = collectCredentials(['ztech_worker']);
  if (workerCreds.missing.length > 0) {
    throw new Error(`Missing worker credential: ${workerCreds.missing.join(', ')}`);
  }
  if (workerCreds.malformed.length > 0) {
    throw new Error(`Malformed worker credential: ${workerCreds.malformed.join(', ')}`);
  }
  const worker = workerCreds.credentials[0];
  process.env.ZTECH_PG_URL = credentialUrl(baseUrl, 'ztech_worker', worker.password);

  // The worker never signs its own identity credential. When a bootstrap token
  // is not already provided, mint one through the control plane — the only
  // role that may call li.issue_worker_identity.
  if (!process.env.ZTECH_WORKER_IDENTITY_TOKEN && !process.env.ZTECH_WORKER_IDENTITY_URL) {
    const workerId = String(process.env.ZTECH_WORKER_ID || '').trim();
    if (!workerId) {
      throw new Error('ZTECH_WORKER_ID is required to mint a worker identity credential');
    }
    const controlCreds = collectCredentials(['ztech_control']);
    if (controlCreds.missing.length > 0) {
      throw new Error(
        `Missing control-plane credential to mint a worker identity: ${controlCreds.missing.join(', ')}. `
        + 'Set ZTECH_WORKER_IDENTITY_TOKEN to a pre-minted credential instead.',
      );
    }
    if (controlCreds.malformed.length > 0) {
      throw new Error(`Malformed control-plane credential: ${controlCreds.malformed.join(', ')}`);
    }
    const control = controlCreds.credentials[0];
    const controlPool = new Pool({
      connectionString: credentialUrl(baseUrl, 'ztech_control', control.password),
      options: '-c search_path=li',
    });
    try {
      const r = await controlPool.query(
        'SELECT li.issue_worker_identity($1, $2) AS token',
        [workerId, IDENTITY_TTL_SECONDS],
      );
      process.env.ZTECH_WORKER_IDENTITY_TOKEN = r.rows[0].token;
    } finally {
      await controlPool.end().catch(() => {});
    }
  }

  await main();
}

if (require.main === module) {
  start().catch((err) => {
    console.error('Fatal worker startup error:', err.message);
    process.exit(1);
  });
}

module.exports = { start, IDENTITY_TTL_SECONDS };
