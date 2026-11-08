'use strict';

/**
 * Structured logging that cannot leak a credential.
 *
 * The worker holds an identity credential, an execution credential and a
 * database credential. None of them may ever reach a log line, an error
 * message or a stack trace. Every value that goes through here is either
 * a plain scalar or is REDACTED, and the redaction is applied to the
 * KEYS as well as to the values.
 */

/** The keys whose values are never written. */
const SECRET_KEYS = new Set([
  'token', 'identitytoken', 'jobtoken', 'password', 'secret', 'authorization',
  'cookie', 'credential', 'identity', 'idtoken', 'accesstoken',
  'workertoken', 'sessiontoken', 'apikey', 'dbpassword', 'databaseurl',
]);

/* The replacement for a redacted value. */
const REDACTED = '[redacted]';

/**
 * Redact one value, by key name.
 *
 * @param {string} key
 * @param {unknown} value
 * @returns {unknown}
 */
function redactValue(key, value) {
  // The comparison ignores the separators, so 'identity_token' and
  // 'identityToken' are the same key.
  const normalised = String(key).toLowerCase().replace(/[-_]/g, '');
  if (SECRET_KEYS.has(normalised)) return REDACTED;
  if (typeof value === 'string') {
    // A token-shaped string is redacted wherever it appears: the key may be
    // innocent, but the value is a credential.
    if (/^[0-9a-f]{64,}\.[0-9a-f]{64,}$/i.test(value)) return REDACTED;
  }
  return value;
}

/**
 * Redact an object, recursively.
 *
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {unknown}
 */
function redact(value, depth = 0) {
  if (depth > 6) return '[deep]';
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message), code: value.code };
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactValue(k, redact(v, depth + 1));
    return out;
  }
  return value;
}

/**
 * Redact a string that may carry a credential.
 *
 * @param {string} text
 * @returns {string}
 */
function redactString(text) {
  return String(text)
    .replace(/[0-9a-f]{64,}\.[0-9a-f]{64,}/gi, REDACTED)
    .replace(/(password|secret|token)\s*=\s*\S+/gi, `$1=${REDACTED}`);
}

/**
 * A logger that writes one JSON object per line.
 *
 * @param {{write?: (line: string) => void, level?: string}} [opts]
 */
function createLogger(opts = {}) {
  const write = opts.write || ((line) => process.stdout.write(`${line}\n`));
  const levels = { debug: 10, info: 20, warn: 30, error: 40 };
  const threshold = levels[opts.level || process.env.ZTECH_WORKER_LOG_LEVEL || 'info'] || 20;

  /**
   * @param {string} level
   * @param {string} event
   * @param {object} [fields]
   */
  function log(level, event, fields = {}) {
    if ((levels[level] || 20) < threshold) return;
    const record = { ts: new Date().toISOString(), level, event, ...redact(fields) };
    write(JSON.stringify(record));
  }

  return {
    debug: (event, fields) => log('debug', event, fields),
    info: (event, fields) => log('info', event, fields),
    warn: (event, fields) => log('warn', event, fields),
    error: (event, fields) => log('error', event, fields),
    child: (base) => createLogger({ ...opts, write: opts.write || ((line) => write(line)) }),
    redact,
    redactString,
  };
}

module.exports = { createLogger, redact, redactString, SECRET_KEYS, REDACTED };
