'use strict';

class SourceError extends Error {
  /** @param {string} code a short, stable code; the message never holds a secret */
  constructor(code, message, { retryable = false } = {}) {
    super(message);
    this.name = 'SourceError';
    this.code = code;
    this.retryable = retryable;
  }
}

/** fetch with a whole-request deadline; network failures become SourceErrors. */
async function timedFetch(fetchImpl, url, init, timeoutMs, what) {
  const signal = AbortSignal.timeout(timeoutMs);
  let res;
  try {
    res = await fetchImpl(url, { ...init, signal, redirect: 'error' });
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new SourceError(timeout ? 'source_timeout' : 'source_unreachable', `${what} did not answer${timeout ? ' in time' : ''}`, { retryable: true });
  }
  const body = await res.text();
  return { status: res.status, body: body.slice(0, 32 * 1024 * 1024) };
}

function parseJson(body, what) {
  try {
    return JSON.parse(body);
  } catch {
    throw new SourceError('source_bad_response', `${what} sent a response that is not JSON`);
  }
}

module.exports = { SourceError, timedFetch, parseJson };
