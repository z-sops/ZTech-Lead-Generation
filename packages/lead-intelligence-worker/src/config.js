'use strict';

/**
 * The worker's configuration, and the bounds it must respect.
 *
 * Every duration is validated here, at start-up, against the SAME bounds the
 * database enforces. A worker that asks for a lease the database would
 * refuse must fail before it connects, not after it has claimed a job.
 */

/** The defaults. The lease, the heartbeat and the token lifetime. */
const DEFAULTS = Object.freeze({
  leaseSeconds: 120,
  heartbeatSeconds: 30,
  tokenTtlSeconds: 120,
});

/**
 * The approved bounds.
 *
 * The lease may not exceed the maximum token lifetime: a lease longer than
 * the longest-lived credential would outlive its own authority.
 */
const LIMITS = Object.freeze({
  leaseSeconds: Object.freeze([30, 300]),
  heartbeatSeconds: Object.freeze([5, 300]),
  tokenTtlSeconds: Object.freeze([30, 300]),
});

class ConfigurationError extends Error {}

/**
 * Read one integer from the environment, or fall back to the default.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
function readInt(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^-?\d+$/.test(String(raw).trim())) {
    throw new ConfigurationError(`${name} must be an integer, got ${JSON.stringify(raw)}`);
  }
  return Number(String(raw).trim());
}

/**
 * @param {number} value
 * @param {[number, number]} range
 * @param {string} name
 * @returns {number}
 */
function checkRange(value, range, name) {
  if (!Number.isInteger(value) || value < range[0] || value > range[1]) {
    throw new ConfigurationError(
      `${name} must be an integer between ${range[0]} and ${range[1]} seconds, got ${value}`,
    );
  }
  return value;
}

/**
 * Build the configuration from the environment.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{workerId: string, databaseUrl: string, identityUrl: string|null,
 *            identityToken: string|null, leaseSeconds: number,
 *            heartbeatSeconds: number, tokenTtlSeconds: number,
 *            pollIntervalMs: number, maxJobsPerRun: number}}
 */
function loadConfig(env = process.env) {
  const workerId = String(env.ZTECH_WORKER_ID || '').trim();
  if (!workerId) throw new ConfigurationError('ZTECH_WORKER_ID is required');
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(workerId)) {
    throw new ConfigurationError('ZTECH_WORKER_ID must be 1 to 128 characters of A-Z, a-z, 0-9, dot, underscore or dash');
  }

  const databaseUrl = String(env.ZTECH_PG_URL || '').trim();
  if (!databaseUrl) throw new ConfigurationError('ZTECH_PG_URL is required');

  const identityUrl = env.ZTECH_WORKER_IDENTITY_URL ? String(env.ZTECH_WORKER_IDENTITY_URL).trim() : null;
  const identityToken = env.ZTECH_WORKER_IDENTITY_TOKEN ? String(env.ZTECH_WORKER_IDENTITY_TOKEN).trim() : null;
  if (!identityUrl && !identityToken) {
    throw new ConfigurationError(
      'one of ZTECH_WORKER_IDENTITY_URL or ZTECH_WORKER_IDENTITY_TOKEN is required: the worker never signs its own credential',
    );
  }

  const leaseSeconds = checkRange(
    readInt(env, 'ZTECH_WORKER_LEASE_SECONDS', DEFAULTS.leaseSeconds),
    LIMITS.leaseSeconds, 'ZTECH_WORKER_LEASE_SECONDS',
  );
  const heartbeatSeconds = checkRange(
    readInt(env, 'ZTECH_WORKER_HEARTBEAT_SECONDS', DEFAULTS.heartbeatSeconds),
    LIMITS.heartbeatSeconds, 'ZTECH_WORKER_HEARTBEAT_SECONDS',
  );
  const tokenTtlSeconds = checkRange(
    readInt(env, 'ZTECH_WORKER_TOKEN_TTL_SECONDS', DEFAULTS.tokenTtlSeconds),
    LIMITS.tokenTtlSeconds, 'ZTECH_WORKER_TOKEN_TTL_SECONDS',
  );
  if (heartbeatSeconds >= leaseSeconds) {
    throw new ConfigurationError(
      `the heartbeat (${heartbeatSeconds}s) must be shorter than the lease (${leaseSeconds}s)`,
    );
  }
  if (tokenTtlSeconds > leaseSeconds) {
    throw new ConfigurationError(
      `the token lifetime (${tokenTtlSeconds}s) may not exceed the lease (${leaseSeconds}s)`,
    );
  }

  return {
    workerId,
    databaseUrl,
    identityUrl,
    identityToken,
    leaseSeconds,
    heartbeatSeconds,
    tokenTtlSeconds,
    pollIntervalMs: checkRange(
      readInt(env, 'ZTECH_WORKER_POLL_MS', 500), [50, 60000], 'ZTECH_WORKER_POLL_MS',
    ),
    maxJobsPerRun: checkRange(
      readInt(env, 'ZTECH_WORKER_MAX_JOBS', 0), [0, 100000], 'ZTECH_WORKER_MAX_JOBS',
    ),
  };
}

module.exports = { DEFAULTS, LIMITS, ConfigurationError, loadConfig };
