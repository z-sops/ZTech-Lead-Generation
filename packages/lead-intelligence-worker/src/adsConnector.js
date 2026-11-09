'use strict';

/**
 * The worker's client for the Meta Ads connector (packages/meta-ads-mcp).
 *
 *   ZTECH_ADS_MCP_URL    e.g. https://ads.zunitech.ai/mcp (http only on localhost)
 *   ZTECH_ADS_MCP_TOKEN  the connector's bearer token
 *
 * One short-lived MCP connection per check; the token travels in a header.
 */

const { Client, StreamableHTTPClientTransport } = require('@modelcontextprotocol/client');

class ConnectorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ConnectorError';
    this.code = code;
  }
}

function connectorConfig(env = process.env) {
  if (!env.ZTECH_ADS_MCP_URL) return null;
  let url;
  try {
    url = new URL(env.ZTECH_ADS_MCP_URL);
  } catch {
    throw new Error('ZTECH_ADS_MCP_URL is not a URL');
  }
  const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('ZTECH_ADS_MCP_URL must use https (plain http only on localhost)');
  }
  if (!env.ZTECH_ADS_MCP_TOKEN || env.ZTECH_ADS_MCP_TOKEN.length < 24) {
    throw new Error('ZTECH_ADS_MCP_TOKEN must be set (at least 24 characters) when ZTECH_ADS_MCP_URL is');
  }
  return { url, token: env.ZTECH_ADS_MCP_TOKEN };
}

function createAdsConnector({ url, token, timeoutMs = 240000 }) {
  return {
    async search(args) {
      const client = new Client({ name: 'ztech-worker', version: '1.0.0' });
      const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
      try {
        await client.connect(transport);
        const res = await client.callTool({ name: 'ads_search', arguments: args }, undefined, { timeout: timeoutMs });
        let data = res.structuredContent;
        if (!data) {
          const t = (res.content || []).find((c) => c.type === 'text');
          try { data = t ? JSON.parse(t.text) : null; } catch { data = null; }
        }
        if (res.isError) {
          throw new ConnectorError((data && data.error) || 'connector_error', (data && data.message) || 'the ads connector reported an error');
        }
        if (!data || !Array.isArray(data.ads)) throw new ConnectorError('connector_bad_response', 'the ads connector sent no ads list');
        return data;
      } catch (err) {
        if (err instanceof ConnectorError) throw err;
        throw new ConnectorError('connector_unreachable', `the ads connector could not be reached (${String(err && err.message).slice(0, 120)})`);
      } finally {
        await client.close().catch(() => {});
      }
    },
  };
}

module.exports = { createAdsConnector, connectorConfig, ConnectorError };
