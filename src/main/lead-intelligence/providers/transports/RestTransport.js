'use strict';

const { ProviderError } = require('../../core/errors');
const { validateServiceBaseUrl } = require('../../core/urls');
const { assertJobId, errorForHttpStatus, withTimeout, parseJsonLimited, pickJobId, pickStatus } = require('./common');

/**
 * RestTransport — Zuni-SEO REST research twin (/v1/research...).
 *
 * - Base URL is validated (https, or localhost only when allowed). Paths are fixed here.
 * - Redirects are refused (redirect: 'error') so a response can never send ZTech's
 *   token to another host.
 * - The bearer token is read in the main process via getToken() at call time
 *   (SafeStorage-backed credential store). It is never stored on this object.
 *
 * Paths VERIFIED against zuni-seo src/zunitech_seo/server/app.py (2026-09-27):
 * GET /v1/research/capabilities, POST /v1/research, GET /v1/research/{job_id},
 * GET /v1/research/{job_id}/result. Whether POST /v1/research reads the Idempotency-Key
 * header is UNVERIFIED (the MCP tool's idempotency_key argument is verified).
 */
const DEFAULT_PATHS = Object.freeze({
  health: '/v1/research/capabilities',
  start: '/v1/research',
  status: '/v1/research/{id}',
  envelope: '/v1/research/{id}/result',
});

class RestTransport {
  /**
   * @param {{baseUrl: string, getToken: () => Promise<string|null>, fetchImpl?: Function,
   *          timeoutMs?: number, maxBytes?: number, allowLocalhost?: boolean, paths?: object}} opts
   */
  constructor({ baseUrl, getToken, fetchImpl = globalThis.fetch, timeoutMs = 60000, maxBytes = 25 * 1024 * 1024, allowLocalhost = false, paths = {} }) {
    const v = validateServiceBaseUrl(baseUrl, { allowLocalhost });
    if (!v.ok) throw new ProviderError('PROVIDER_CONFIG_INVALID', `Research service URL is not allowed (${v.reason})`, { blocking: true });
    if (typeof getToken !== 'function') throw new TypeError('getToken is required');
    if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
    this.base = v.base;
    this.getToken = getToken;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.maxBytes = maxBytes;
    this.paths = { ...DEFAULT_PATHS, ...paths };
  }

  _url(pathKey, id) {
    let p = this.paths[pathKey];
    if (id !== undefined) p = p.replace('{id}', encodeURIComponent(assertJobId(id)));
    return `${this.base}${p}`;
  }

  async _request(method, pathKey, { id, body, idempotencyKey } = {}) {
    const token = await this.getToken();
    if (!token) throw new ProviderError('PROVIDER_CREDENTIALS_MISSING', 'No research service credential is configured', { blocking: true });
    const url = this._url(pathKey, id);
    const controller = new AbortController();
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    let res;
    try {
      res = await withTimeout(
        this.fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: controller.signal }),
        this.timeoutMs,
        pathKey,
      );
    } catch (e) {
      controller.abort();
      if (e instanceof ProviderError) throw e;
      throw new ProviderError('PROVIDER_UNAVAILABLE', `Research service could not be reached (${pathKey})`, { retryable: true });
    }
    if (!res.ok) throw errorForHttpStatus(res.status, pathKey);
    const len = Number(res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : NaN);
    if (Number.isFinite(len) && len > this.maxBytes) {
      throw new ProviderError('PROVIDER_RESPONSE_TOO_LARGE', `Research service response is too large (${pathKey})`);
    }
    const textValue = await res.text();
    return parseJsonLimited(textValue, this.maxBytes, pathKey);
  }

  async health() {
    const p = await this._request('GET', 'health');
    return { ok: p && p.ok !== false && p.status !== 'error' };
  }

  async start({ url, idempotencyKey }) {
    const p = await this._request('POST', 'start', { body: { url }, idempotencyKey });
    const jobId = pickJobId(p);
    if (!jobId) throw new ProviderError('PROVIDER_BAD_RESPONSE', 'Research service did not return a job id');
    return { jobId, status: pickStatus(p) || 'running' };
  }

  async status(jobId) {
    const p = await this._request('GET', 'status', { id: jobId });
    return { status: pickStatus(p) };
  }

  async envelope(jobId) {
    const p = await this._request('GET', 'envelope', { id: jobId });
    return p && typeof p.envelope === 'object' && p.envelope !== null ? p.envelope : p;
  }
}

module.exports = { RestTransport, DEFAULT_PATHS };
