'use strict';

const { ProviderError } = require('../../core/errors');
const { assertJobId, errorForHttpStatus, withTimeout, parseJsonLimited, pickJobId, pickStatus } = require('./common');

/**
 * McpTransport — talks to the Zuni-SEO MCP server (Streamable HTTP, stateless).
 *
 * The MCP SDK is NOT required here. The integration layer injects `connect`, which
 * returns a connected client exposing the standard MCP SDK client methods:
 *   client.callTool({ name, arguments }) -> { content, structuredContent?, isError? }
 *   client.close()
 * See src/integration/zuniSeoFactory.js for how the client is created with the
 * fixed server URL and the Authorization header from the credential store.
 *
 * Tool names below were VERIFIED against zuni-seo src/zunitech_seo/server/mcp_app.py
 * (TOOLS table, 2026-09-27): zuni_capabilities, zuni_site_preflight, zuni_research_start,
 * zuni_research_status, zuni_research_result. zuni_site_preflight is not used here.
 */
const DEFAULT_TOOL_NAMES = Object.freeze({
  health: 'zuni_capabilities',
  start: 'zuni_research_start',
  status: 'zuni_research_status',
  envelope: 'zuni_research_result',
});

const DEFAULT_ARG_NAMES = Object.freeze({
  url: 'url',
  idempotencyKey: 'idempotency_key',
  jobId: 'job_id',
});

function extractPayload(res, maxBytes, what) {
  if (res && res.structuredContent && typeof res.structuredContent === 'object') return res.structuredContent;
  const items = Array.isArray(res && res.content) ? res.content : [];
  const textItem = items.find((c) => c && c.type === 'text' && typeof c.text === 'string');
  if (!textItem) throw new ProviderError('PROVIDER_BAD_RESPONSE', `Research tool returned no data (${what})`);
  return parseJsonLimited(textItem.text, maxBytes, what);
}

function classify(err, what) {
  if (err instanceof ProviderError) return err;
  const status = Number(err && (err.code || err.status || err.statusCode));
  if (Number.isInteger(status) && status >= 400 && status <= 599) return errorForHttpStatus(status, what);
  // Network, DNS, reset, abort, SDK connection errors -> temporary outage
  return new ProviderError('PROVIDER_UNAVAILABLE', `Research service could not be reached (${what})`, { retryable: true });
}

class McpTransport {
  /**
   * @param {{connect: () => Promise<object>, toolNames?: object, argNames?: object, timeoutMs?: number, maxBytes?: number}} opts
   */
  constructor({ connect, toolNames = {}, argNames = {}, timeoutMs = 60000, maxBytes = 25 * 1024 * 1024 }) {
    if (typeof connect !== 'function') throw new TypeError('connect is required');
    this.connect = connect;
    this.tools = { ...DEFAULT_TOOL_NAMES, ...toolNames };
    this.args = { ...DEFAULT_ARG_NAMES, ...argNames };
    this.timeoutMs = timeoutMs;
    this.maxBytes = maxBytes;
  }

  async _call(toolKey, args) {
    const name = this.tools[toolKey];
    let client;
    try {
      client = await withTimeout(Promise.resolve().then(() => this.connect()), this.timeoutMs, `connect:${toolKey}`);
    } catch (e) {
      throw classify(e, `connect:${toolKey}`);
    }
    try {
      const res = await withTimeout(client.callTool({ name, arguments: args }), this.timeoutMs, toolKey);
      if (res && res.isError) {
        throw new ProviderError('PROVIDER_TOOL_ERROR', `Research tool reported an error (${toolKey})`, { retryable: false });
      }
      return extractPayload(res, this.maxBytes, toolKey);
    } catch (e) {
      throw classify(e, toolKey);
    } finally {
      try {
        if (client && typeof client.close === 'function') await client.close();
      } catch {
        /* closing a stateless client must never fail the call */
      }
    }
  }

  async health() {
    const p = await this._call('health', {});
    return { ok: p && p.ok !== false };
  }

  async start({ url, idempotencyKey }) {
    const p = await this._call('start', { [this.args.url]: url, [this.args.idempotencyKey]: idempotencyKey });
    const jobId = pickJobId(p);
    if (!jobId) throw new ProviderError('PROVIDER_BAD_RESPONSE', 'Research tool did not return a job id');
    return { jobId, status: pickStatus(p) || 'running' };
  }

  async status(jobId) {
    assertJobId(jobId);
    const p = await this._call('status', { [this.args.jobId]: jobId });
    return { status: pickStatus(p) };
  }

  async envelope(jobId) {
    assertJobId(jobId);
    const p = await this._call('envelope', { [this.args.jobId]: jobId });
    return p && typeof p.envelope === 'object' && p.envelope !== null ? p.envelope : p;
  }
}

module.exports = { McpTransport, DEFAULT_TOOL_NAMES, DEFAULT_ARG_NAMES };
