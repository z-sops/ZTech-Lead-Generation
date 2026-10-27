'use strict';

/**
 * The worker identity credential.
 *
 * The worker NEVER signs its own credential. It asks the CONTROL PLANE for
 * one, and the control plane calls li.issue_worker_identity() — the only
 * function that may do so — with the database's control-plane credential.
 *
 * The worker therefore receives a token and nothing else: no control-plane
 * credential, no signing secret, no migrator credential.
 */

/**
 * Fetch an identity credential from the control plane.
 *
 * @param {{workerId: string, identityUrl: string|null, identityToken: string|null,
 *          tokenTtlSeconds: number, fetchImpl?: typeof fetch}} config
 * @returns {Promise<string>}
 */
async function fetchIdentityToken(config) {
  if (config.identityToken) return config.identityToken;
  if (!config.identityUrl) {
    throw new Error('no identity bootstrap is configured: the worker cannot sign its own credential');
  }
  const doFetch = config.fetchImpl || fetch;
  const response = await doFetch(config.identityUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ worker_id: config.workerId, ttl_seconds: config.tokenTtlSeconds }),
  });
  if (!response || !response.ok) {
    const status = response ? response.status : 'no response';
    throw new Error(`the control plane refused the identity bootstrap (${status})`);
  }
  const body = await response.json();
  const token = body && body.token;
  if (!token || typeof token !== 'string') {
    throw new Error('the control plane returned no identity credential');
  }
  return token;
}

/**
 * An identity credential that is refreshed before it expires.
 *
 * The credential is cached, and re-fetched when it is close enough to its
 * expiry that a job in flight could outlive it.
 */
class IdentityProvider {
  /**
   * @param {object} config
   * @param {{fetch?: typeof fetch, now?: () => number}} [deps]
   */
  constructor(config, deps = {}) {
    this.config = config;
    this.fetch = deps.fetch || fetchIdentityToken;
    this.now = deps.now || (() => Date.now());
    this.token = null;
    this.expiresAt = 0;
  }

  /**
   * The current identity credential, fetching one if needed.
   *
   * @returns {Promise<string>}
   */
  async get() {
    const now = this.now();
    // Refresh when less than a quarter of the lifetime remains, so a job
    // that starts now does not outlive the credential.
    const margin = Math.floor((this.config.tokenTtlSeconds * 1000) / 4);
    if (!this.token || now >= this.expiresAt - margin) {
      this.token = await this.fetch(this.config);
      this.expiresAt = now + this.config.tokenTtlSeconds * 1000;
    }
    return this.token;
  }

  /** Forget the cached credential, so the next call fetches a new one. */
  invalidate() {
    this.token = null;
    this.expiresAt = 0;
  }
}

module.exports = { fetchIdentityToken, IdentityProvider };
