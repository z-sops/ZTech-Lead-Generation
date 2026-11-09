'use strict';

/**
 * A local stand-in for the internet, for the Phase 2 tests.
 *
 * It serves the evaluation websites under tests/fixtures/phase2-sites/sites,
 * chosen by the Host header, over plain HTTP and (with a throwaway
 * self-signed certificate) HTTPS, and it plays Nominatim and Overpass for
 * maps.ztech-fixture.com. The worker reaches it through
 * ZTECH_INSPECT_HOST_MAP, which only works with ZTECH_INSPECT_ALLOW_PRIVATE=1
 * outside production.
 *
 * Each site directory may hold a site.json:
 *   { "https": bool, "redirect_http_to_https": bool, "status": number }
 * "status" applies to the home page only.
 */

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'fixtures', 'phase2-sites');
const SITES = path.join(ROOT, 'sites');
const TYPES = { '.html': 'text/html; charset=utf-8', '.txt': 'text/plain', '.xml': 'application/xml', '.json': 'application/json' };

function siteConfig(host) {
  const file = path.join(SITES, host, 'site.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
}

function handler(scheme, requests) {
  return (req, res) => {
    const host = String(req.headers.host || '').split(':')[0].toLowerCase();
    const url = new URL(req.url, `${scheme}://${host}`);
    requests.push({ scheme, host, path: url.pathname, method: req.method, ua: req.headers['user-agent'] });

    if (host === 'maps.ztech-fixture.com') {
      if (url.pathname === '/search') {
        const q = url.searchParams.get('q') || '';
        const body = /nowhere/i.test(q) ? '[]' : fs.readFileSync(path.join(SITES, host, 'nominatim.json'));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(body);
        return;
      }
      if (url.pathname === '/api/interpreter' && req.method === 'POST') {
        let data = '';
        req.on('data', (c) => { data += c; });
        req.on('end', () => {
          requests[requests.length - 1].body = decodeURIComponent(data.replace(/^data=/, ''));
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(fs.readFileSync(path.join(SITES, host, 'overpass.json')));
        });
        return;
      }
      res.writeHead(404);
      res.end();
      return;
    }

    if (host === 'ch.ztech-fixture.com') {
      // Companies House stand-in: Basic auth with the key as the user name.
      const api = JSON.parse(fs.readFileSync(path.join(SITES, host, 'api.json'), 'utf8'));
      const expected = `Basic ${Buffer.from(`${api.key}:`).toString('base64')}`;
      if (req.headers.authorization !== expected) { res.writeHead(401); res.end('{}'); return; }
      res.setHeader('content-type', 'application/json');
      if (url.pathname === '/search/companies') {
        res.end(JSON.stringify({ items: api.search[(url.searchParams.get('q') || '').toLowerCase()] || [] }));
        return;
      }
      const m = /^\/company\/([A-Z0-9]{8})\/officers$/.exec(url.pathname);
      if (m) { res.end(JSON.stringify({ items: api.officers[m[1]] || [] })); return; }
      res.writeHead(404); res.end('{}');
      return;
    }
    if (host === 'graph.ztech-fixture.com') {
      // Instagram Business Discovery stand-in.
      const api = JSON.parse(fs.readFileSync(path.join(SITES, host, 'api.json'), 'utf8'));
      res.setHeader('content-type', 'application/json');
      if (req.headers.authorization !== `Bearer ${api.token}`) { res.end(JSON.stringify({ error: { code: 190, message: 'Invalid OAuth access token' } })); return; }
      const handle = (/username\(([^)]+)\)/.exec(url.searchParams.get('fields') || '') || [])[1];
      const acct = api.accounts[handle];
      if (!acct) { res.end(JSON.stringify({ error: { code: 110, message: `Invalid user id: cannot find business account ${handle}` } })); return; }
      res.end(JSON.stringify({ id: '1789', business_discovery: { username: handle, followers_count: acct.followers_count, media_count: acct.media_count, media: { data: [{ timestamp: acct.last, id: 'm1' }] } } }));
      return;
    }

    const dir = path.join(SITES, host);
    if (!host || !fs.existsSync(dir)) {
      res.writeHead(404);
      res.end('no such site');
      return;
    }
    const cfg = siteConfig(host);
    if (scheme === 'http' && cfg.https && cfg.redirect_http_to_https) {
      res.writeHead(301, { location: `https://${host}${url.pathname}${url.search}` });
      res.end();
      return;
    }
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
    const file = path.join(dir, rel);
    if (!file.startsWith(dir) || !fs.existsSync(file) || !fs.statSync(file).isFile() || rel === 'site.json') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    const status = url.pathname === '/' && cfg.status ? cfg.status : 200;
    res.writeHead(status, { 'content-type': TYPES[path.extname(file)] || (path.extname(file) === '' ? 'text/html; charset=utf-8' : 'application/octet-stream') });
    res.end(fs.readFileSync(file));
  };
}

/**
 * @returns {Promise<{hostMap: string, nominatimUrl: string, overpassUrl: string,
 *   requests: object[], close: () => Promise<void>}>}
 */
async function startFixtureServer() {
  const requests = [];
  const plain = http.createServer(handler('http', requests));
  const secure = https.createServer({
    key: fs.readFileSync(path.join(ROOT, 'tls', 'key.pem')),
    cert: fs.readFileSync(path.join(ROOT, 'tls', 'cert.pem')),
  }, handler('https', requests));
  // A port nothing listens on, for the "website is down" business.
  const closed = http.createServer();
  await Promise.all([plain, secure, closed].map((s) => new Promise((r) => s.listen(0, '127.0.0.1', r))));
  const deadPort = closed.address().port;
  await new Promise((r) => closed.close(r));
  const hp = plain.address().port;
  const sp = secure.address().port;
  const hosts = fs.readdirSync(SITES).filter((h) => fs.statSync(path.join(SITES, h)).isDirectory());
  const entries = hosts.map((h) => {
    const cfg = siteConfig(h);
    return `${h}=${hp}${cfg.https || ['maps.ztech-fixture.com', 'ch.ztech-fixture.com', 'graph.ztech-fixture.com'].includes(h) ? `:${sp}` : ''}`;
  });
  entries.push(`down-dental.ztech-fixture.com=${deadPort}:${deadPort}`);
  return {
    hostMap: entries.join(','),
    nominatimUrl: 'http://maps.ztech-fixture.com/search',
    overpassUrl: 'http://maps.ztech-fixture.com/api/interpreter',
    companiesHouseUrl: 'https://ch.ztech-fixture.com',
    graphUrl: 'https://graph.ztech-fixture.com',
    requests,
    expected: JSON.parse(fs.readFileSync(path.join(ROOT, 'expected.json'), 'utf8')),
    close: () => Promise.all([plain, secure].map((s) => new Promise((r) => { s.closeAllConnections(); s.close(r); }))).then(() => {}),
  };
}

module.exports = { startFixtureServer };
