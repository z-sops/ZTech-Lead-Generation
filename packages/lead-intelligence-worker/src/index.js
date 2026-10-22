'use strict';

const { loadConfig } = require('./config');
const { createLogger } = require('./log');
const { createPool } = require('./db');
const { Worker } = require('./worker');
const { executeNoop } = require('./noop');
const { fetchIdentityToken, IdentityProvider } = require('./identity');

/**
 * The worker's entry point.
 *
 * The worker starts, claims jobs, runs them, and stops when it is asked.
 * It holds three credentials and no others: the worker's own database
 * credential (no BYPASSRLS, not the migrator, not the control plane), an
 * expiring identity credential, and short-lived execution credentials.
 */

async function main() {
  const config = loadConfig();
  const logger = createLogger();
  const pool = createPool(config);
  const worker = new Worker({ pool, config, logger });

  const shutdown = (signal) => {
    logger.info('worker.signal', { signal });
    worker.stop();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  try {
    await worker.loop();
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    // The error is redacted: it may carry a credential in its message.
    const logger = createLogger();
    logger.error('worker.failed', { error: err });
    process.exitCode = 1;
  });
}

module.exports = {
  main, Worker, loadConfig, createLogger, createPool, executeNoop, fetchIdentityToken, IdentityProvider,
};
