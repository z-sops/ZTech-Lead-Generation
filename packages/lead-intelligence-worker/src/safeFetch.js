'use strict';

/**
 * The worker's only way onto the internet.
 *
 * Website addresses come from public map data, so they are untrusted. Every
 * request made through here:
 *   - uses http or https only, on the default ports (80/443);
 *   - resolves the host itself and REFUSES private, loopback, link-local,
 *     carrier-grade NAT, multicast and reserved addresses - checked on the
 *     address actually connected to, so a DNS answer cannot point the worker
 *     at the server's own network (and the check repeats on every redirect);
 *   - follows at most 5 redirects;
 *   - stops after `timeoutMs` and reads at most `maxBytes` of the body;
 *   - identifies itself with an honest User-Agent.
 * It never sends cookies or credentials of its own, and it never throws for
 * a network failure: it answers { ok: false, error } with a short code.
 */

const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');
const net = require('node:net');
const zlib = require('node:zlib');

const BLOCKED = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) BLOCKED.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32],
  ['64:ff9b::', 96], ['100::', 64], ['2001::', 32], ['2002::', 16],
]) BLOCKED.addSubnet(addr, prefix, 'ipv6');

function isBlockedAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return BLOCKED.check(address, 'ipv4');
  if (family === 6) {
    const mapped = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return BLOCKED.check(mapped[1], 'ipv4');
    return BLOCKED.check(address, 'ipv6');
  }
  return true; // not an address at all: refuse
}

class BlockedAddressError extends Error {
  constructor() {
    super('the address is private or reserved');
    this.code = 'EBLOCKEDADDRESS';
  }
}

function guardedLookup(allowPrivate) {
  return (hostname, options, callback) => {
    const opts = typeof options === 'object' && options ? options : {};
    dns.lookup(hostname, { ...opts, all: true }, (err, addresses) => {
      if (err) return callback(err);
      if (!allowPrivate && addresses.some((a) => isBlockedAddress(a.address))) {
        return callback(new BlockedAddressError());
      }
      if (opts.all) return callback(null, addresses);
      return callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function errorCode(err) {
  if (!err) return 'unknown_error';
  if (err.code === 'EBLOCKEDADDRESS') return 'blocked_private_address';
  if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') return 'dns_not_found';
  if (err.code === 'ECONNREFUSED') return 'connection_refused';
  if (err.code === 'ECONNRESET') return 'connection_reset';
  if (err.code === 'ETIMEDOUT' || err.code === 'TIMEOUT') return 'timeout';
  if (err.code === 'ABORT_ERR' || err.name === 'AbortError') return 'aborted';
  if (typeof err.code === 'string' && /CERT|SSL|TLS|EPROTO|ERR_TLS/i.test(err.code)) return 'tls_error';
  return typeof err.code === 'string' ? err.code.toLowerCase().slice(0, 40) : 'network_error';
}

/**
 * @param {{userAgent: string, timeoutMs?: number, maxBytes?: number, maxRedirects?: number,
 *          allowPrivate?: boolean, now?: () => number}} config
 */
function createSafeFetch(config) {
  if (!config || !config.userAgent) throw new Error('safeFetch needs a User-Agent');
  const timeoutMs = config.timeoutMs || 10000;
  const maxBytes = config.maxBytes || 1572864;
  const maxRedirects = config.maxRedirects === undefined ? 5 : config.maxRedirects;
  const allowPrivate = Boolean(config.allowPrivate);
  // TESTS ONLY (requires allowPrivate): host name -> {http, https} local
  // ports, so the evaluation websites are served from 127.0.0.1 under
  // realistic names. A missing https port behaves like a site without TLS.
  const hostMap = config.hostMap || null;
  if (hostMap && !allowPrivate) throw new Error('a host map is a test facility and needs allowPrivate');
  const clock = config.now || (() => Date.now());
  const lookup = guardedLookup(allowPrivate);

  function once(url, { method, headers, body, signal, deadline }) {
    return new Promise((resolve) => {
      let u;
      try {
        u = new URL(url);
      } catch {
        resolve({ ok: false, error: 'invalid_url' });
        return;
      }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        resolve({ ok: false, error: 'unsupported_scheme' });
        return;
      }
      if (u.username || u.password) {
        resolve({ ok: false, error: 'credentials_in_url' });
        return;
      }
      if (!allowPrivate && u.port && !['80', '443'].includes(u.port)) {
        resolve({ ok: false, error: 'non_default_port' });
        return;
      }
      const host = u.hostname.replace(/^\[|\]$/g, '');
      if (net.isIP(host) && !allowPrivate && isBlockedAddress(host)) {
        resolve({ ok: false, error: 'blocked_private_address' });
        return;
      }
      const remaining = deadline - clock();
      if (remaining <= 0) {
        resolve({ ok: false, error: 'timeout' });
        return;
      }
      const lib = u.protocol === 'https:' ? https : http;
      let target = u;
      let hostHeader = null;
      let tlsOverride = null;
      if (hostMap && hostMap.has(host)) {
        const ports = hostMap.get(host);
        const port = u.protocol === 'https:' ? ports.https : ports.http;
        if (!port) {
          resolve({ ok: false, error: 'connection_refused' });
          return;
        }
        target = new URL(u.toString());
        target.hostname = '127.0.0.1';
        target.port = String(port);
        hostHeader = u.host;
        // The evaluation sites use a throwaway self-signed certificate.
        if (u.protocol === 'https:') tlsOverride = { servername: host, rejectUnauthorized: false };
      }
      let settled = false;
      let timer = null;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(value);
      };
      const req = lib.request(target, {
        method,
        headers: {
          'User-Agent': config.userAgent,
          Accept: headers && headers.Accept ? headers.Accept : 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
          'Accept-Encoding': 'gzip, deflate, br',
          ...headers,
          ...(hostHeader ? { Host: hostHeader } : {}),
        },
        lookup,
        timeout: remaining,
        signal,
        agent: false,
        ...(tlsOverride || {}),
      }, (res) => {
        const status = res.statusCode || 0;
        if (REDIRECTS.has(status) && res.headers.location) {
          res.resume();
          finish({ ok: true, redirect: res.headers.location, status });
          return;
        }
        let stream = res;
        const enc = String(res.headers['content-encoding'] || '').toLowerCase();
        if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip());
        else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
        else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
        const chunks = [];
        let size = 0;
        let truncated = false;
        stream.on('data', (chunk) => {
          if (truncated) return;
          size += chunk.length;
          if (size > maxBytes) {
            chunks.push(chunk.subarray(0, chunk.length - (size - maxBytes)));
            truncated = true;
            req.destroy();
            finish({ ok: true, status, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'), truncated: true });
            return;
          }
          chunks.push(chunk);
        });
        stream.on('end', () => finish({ ok: true, status, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'), truncated }));
        stream.on('error', (err) => finish({ ok: false, error: errorCode(err) }));
      });
      // A whole-request deadline, not only an idle-socket one: a server that
      // trickles one byte a second cannot hold the worker.
      timer = setTimeout(() => req.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })), remaining);
      req.on('timeout', () => {
        req.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' }));
      });
      req.on('error', (err) => finish({ ok: false, error: errorCode(err) }));
      if (body) req.write(body);
      req.end();
    });
  }

  /**
   * @param {{method?: string, url: string, headers?: object, body?: string, signal?: AbortSignal}} request
   */
  async function request({ method = 'GET', url, headers = {}, body, signal }) {
    const started = clock();
    const deadline = started + timeoutMs;
    let current = url;
    let currentMethod = method;
    let currentBody = body;
    const redirects = [];
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const res = await once(current, { method: currentMethod, headers, body: currentBody, signal, deadline });
      if (!res.ok) return { ok: false, error: res.error, redirects, elapsedMs: clock() - started };
      if (res.redirect) {
        let next;
        try {
          next = new URL(res.redirect, current).toString();
        } catch {
          return { ok: false, error: 'bad_redirect', redirects, elapsedMs: clock() - started };
        }
        redirects.push({ from: current, status: res.status, to: next });
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && currentMethod === 'POST')) {
          currentMethod = 'GET';
          currentBody = undefined;
        }
        current = next;
        continue;
      }
      return {
        ok: true,
        status: res.status,
        finalUrl: current,
        contentType: String(res.headers['content-type'] || ''),
        body: res.body,
        truncated: res.truncated,
        elapsedMs: clock() - started,
        redirects,
      };
    }
    return { ok: false, error: 'too_many_redirects', redirects, elapsedMs: clock() - started };
  }

  /** The inspector's page fetcher. */
  function fetchPage(url, { signal } = {}) {
    return request({ method: 'GET', url, signal });
  }

  return { request, fetchPage };
}

module.exports = { createSafeFetch, isBlockedAddress };
