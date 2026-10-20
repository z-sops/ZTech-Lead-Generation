'use strict';

const { ProviderError } = require('../../core/errors');

/** Shared helpers for all Zuni-SEO transports. */

const JOB_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

function assertJobId(jobId) {
  if (typeof jobId !== 'string' || !JOB_ID.test(jobId)) {
    throw new ProviderError('PROVIDER_BAD_JOB_ID', 'Invalid research job id', { retryable: false });
  }
  return jobId;
}

/** Map an HTTP status code to a ProviderError. Response bodies are never copied. */
function errorForHttpStatus(status, what) {
  if (status === 401 || status === 403) {
    return new ProviderError('PROVIDER_AUTH', `Research service rejected the credentials (${what}, HTTP ${status})`, { blocking: true });
  }
  if (status === 402) {
    return new ProviderError('PROVIDER_QUOTA', `Research service plan or quota does not allow this request (${what}, HTTP 402)`, { blocking: true });
  }
  if (status === 404) {
    return new ProviderError('PROVIDER_JOB_NOT_FOUND', `Research job not found (${what}, HTTP 404)`, { retryable: false });
  }
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return new ProviderError('PROVIDER_UNAVAILABLE', `Research service temporarily unavailable (${what}, HTTP ${status})`, { retryable: true });
  }
  return new ProviderError('PROVIDER_REJECTED', `Research service rejected the request (${what}, HTTP ${status})`, { retryable: false });
}

function withTimeout(promise, ms, what) {
  let timer;
  const t = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new ProviderError('PROVIDER_TIMEOUT', `Research service timed out (${what})`, { retryable: true })), ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}

function parseJsonLimited(textValue, maxBytes, what) {
  if (typeof textValue !== 'string') throw new ProviderError('PROVIDER_BAD_RESPONSE', `Research service returned no data (${what})`);
  if (Buffer.byteLength(textValue, 'utf8') > maxBytes) {
    throw new ProviderError('PROVIDER_RESPONSE_TOO_LARGE', `Research service response is too large (${what})`);
  }
  try {
    return JSON.parse(textValue);
  } catch {
    throw new ProviderError('PROVIDER_BAD_RESPONSE', `Research service returned invalid JSON (${what})`);
  }
}

function pickJobId(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const v = obj.job_id || obj.jobId || obj.id || (obj.job && (obj.job.id || obj.job.job_id));
  return typeof v === 'string' ? v : null;
}

function pickStatus(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const v = obj.status || obj.state || (obj.job && (obj.job.status || obj.job.state));
  return typeof v === 'string' ? v : null;
}

module.exports = { assertJobId, errorForHttpStatus, withTimeout, parseJsonLimited, pickJobId, pickStatus, JOB_ID };
