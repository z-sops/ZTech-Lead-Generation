#!/usr/bin/env node
'use strict';

/**
 * The Meta Ads connector as an MCP server (Streamable HTTP, stateless).
 *
 * Tools:
 *   ads_capabilities  which sources are set up
 *   ads_search        the ads one advertiser runs in one country, cleaned
 *
 * Every request needs `Authorization: Bearer <META_ADS_MCP_TOKEN>`: the
 * connector spends paid credits and holds API keys, so it is never open.
 * It stores nothing and logs no query, token or ad text.
 *
 * Environment:
 *   META_ADS_MCP_TOKEN   required, at least 24 characters
 *   PORT                 default 8787;  HOST default 127.0.0.1
 *   META_ACCESS_TOKEN, META_GRAPH_VERSION         the official API (optional)
 *   APIFY_TOKEN, APIFY_ACTOR, APIFY_INPUT_JSON    the hosted scraper (optional)
 */

const http = require('node:http');
const crypto = require('node:crypto');
const { McpServer, createMcpHandler } = require('@modelcontextprotocol/server');
const { z } = require('zod');
const { sourcesFromEnv, searchAds, capabilities, InputError, SourceError } = require('./index');

const BODY_MAX = 1024 * 1024;

function buildServer(sources) {
  const server = new McpServer({ name: 'zunitech-meta-ads', version: '0.1.0' });
  server.registerTool('ads_capabilities', {
    title: 'Ads sources',
    description: 'Which ad sources this connector can use.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true },
  }, async () => {
    const out = capabilities(sources);
    return { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out };
  });
  server.registerTool('ads_search', {
    title: 'Advertiser ads',
    description: 'The Facebook/Instagram ads one advertiser runs in one country: text, button, platforms, start/stop dates, and spend/reach where Meta publishes them. Read-only.',
    inputSchema: z.object({
      query: z.string().max(120).optional().describe('Facebook page name, page slug or keyword'),
      page_id: z.string().max(25).optional().describe('Numeric Facebook page id (more exact than a name)'),
      country: z.string().length(2).describe('Two-letter country code, e.g. PK, GB, US'),
      active: z.enum(['active', 'all']).optional().describe('Only running ads, or running and stopped'),
      max_ads: z.number().int().min(1).max(500).optional(),
      source: z.enum(['auto', 'meta_api', 'apify']).optional(),
    }),
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async (args) => {
    try {
      const out = await searchAds(sources, args);
      return { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out };
    } catch (err) {
      if (err instanceof InputError || err instanceof SourceError) {
        const out = { error: err.code, message: err.message, retryable: Boolean(err.retryable) };
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(out) }] };
      }
      throw err;
    }
  });
  return server;
}

function tokenOk(header, expected) {
  const m = /^Bearer\s+(.+)$/i.exec(String(header || ''));
  if (!m) return false;
  const a = crypto.createHash('sha256').update(m[1]).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/** A node:http server around the MCP handler. */
function createConnectorServer({ token, sources, logger = console }) {
  if (!token || token.length < 24) throw new Error('META_ADS_MCP_TOKEN must be set (at least 24 characters)');
  const handler = createMcpHandler(() => buildServer(sources), { onerror: (e) => logger.warn(`[meta-ads-mcp] ${e.message}`) });
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, sources: [...sources.keys()] }));
        return;
      }
      if (url.pathname !== '/mcp') { res.writeHead(404); res.end(); return; }
      if (!tokenOk(req.headers.authorization, token)) {
        res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > BODY_MAX) { res.writeHead(413); res.end(); return; }
        chunks.push(chunk);
      }
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
      const request = new Request(`http://${req.headers.host || 'localhost'}${req.url}`, {
        method: req.method,
        headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
      });
      const response = await handler.fetch(request);
      const out = {};
      response.headers.forEach((v, k) => { out[k] = v; });
      res.writeHead(response.status, out);
      if (response.body) {
        for await (const chunk of response.body) res.write(chunk);
      }
      res.end();
    } catch (err) {
      logger.error(`[meta-ads-mcp] request failed: ${err.message}`);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal_error' }));
    }
  });
}

if (require.main === module) {
  const sources = sourcesFromEnv(process.env);
  const server = createConnectorServer({ token: process.env.META_ADS_MCP_TOKEN, sources });
  const port = Number(process.env.PORT) || 8787;
  const host = process.env.HOST || '127.0.0.1';
  server.listen(port, host, () => {
    console.log(`Meta Ads connector on http://${host}:${port}/mcp (sources: ${[...sources.keys()].join(', ') || 'none - set META_ACCESS_TOKEN or APIFY_TOKEN'})`);
  });
}

module.exports = { createConnectorServer, buildServer };
