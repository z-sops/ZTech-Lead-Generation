'use strict';

const { domainToASCII } = require('node:url');

/**
 * Domain / URL safety.
 *
 * ZTech never crawls. The only place a website URL is used is to tell the research
 * provider which site to audit, so the domain must be a public hostname:
 * no IPs, no localhost, no private/reserved suffixes, no credentials, no odd ports.
 */

const RESERVED_TLDS = new Set([
  'localhost', 'local', 'internal', 'intranet', 'lan', 'home', 'corp', 'invalid',
  'onion', 'arpa', 'test', 'localdomain', 'private',
]);

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * @param {string} input  e.g. "example.com", "https://www.example.com/about"
 * @returns {{ok:true, host:string, key:string} | {ok:false, reason:string}}
 *   host: ASCII hostname as given (www kept)
 *   key:  hostname without a leading "www." — used for de-duplication
 */
function normalizeDomain(input) {
  if (typeof input !== 'string') return { ok: false, reason: 'NOT_A_STRING' };
  let s = input.trim();
  if (!s) return { ok: false, reason: 'EMPTY' };
  if (s.length > 2048) return { ok: false, reason: 'TOO_LONG' };
  if (/\s/.test(s)) return { ok: false, reason: 'INVALID_HOST' };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[^:]+:\d/.test(s)) return { ok: false, reason: 'UNSUPPORTED_SCHEME' };
    s = `http://${s}`;
  }
  let u;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, reason: 'UNPARSEABLE' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: 'UNSUPPORTED_SCHEME' };
  if (u.username || u.password) return { ok: false, reason: 'CREDENTIALS_IN_URL' };
  if (u.port && u.port !== '80' && u.port !== '443') return { ok: false, reason: 'NON_STANDARD_PORT' };
  let host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[') || host.includes(':') || IPV4.test(host)) return { ok: false, reason: 'IP_ADDRESS' };
  const ascii = domainToASCII(host);
  if (!ascii) return { ok: false, reason: 'INVALID_HOST' };
  host = ascii;
  if (host.length > 253) return { ok: false, reason: 'INVALID_HOST' };
  const labels = host.split('.');
  if (labels.length < 2) return { ok: false, reason: 'NOT_A_PUBLIC_DOMAIN' };
  if (!labels.every((l) => LABEL.test(l))) return { ok: false, reason: 'INVALID_HOST' };
  const tld = labels[labels.length - 1];
  if (!TLD.test(tld)) return { ok: false, reason: 'NOT_A_PUBLIC_DOMAIN' };
  if (RESERVED_TLDS.has(tld)) return { ok: false, reason: 'PRIVATE_OR_RESERVED_DOMAIN' };
  return { ok: true, host, key: host.replace(/^www\./, '') };
}

function domainKey(input) {
  const d = normalizeDomain(input);
  return d.ok ? d.key : null;
}

/**
 * Validate the base URL of the Zuni-SEO service (REST or MCP endpoint).
 * This is the only user-editable network setting; paths are fixed in code.
 * https is required, except http://localhost / 127.0.0.1 when allowLocalhost is true
 * (Zuni-SEO running on the same machine during development).
 */
function validateServiceBaseUrl(input, { allowLocalhost = false } = {}) {
  if (typeof input !== 'string' || !input.trim()) return { ok: false, reason: 'EMPTY' };
  let u;
  try {
    u = new URL(input.trim());
  } catch {
    return { ok: false, reason: 'UNPARSEABLE' };
  }
  if (u.username || u.password) return { ok: false, reason: 'CREDENTIALS_IN_URL' };
  if (u.search || u.hash) return { ok: false, reason: 'QUERY_OR_FRAGMENT_NOT_ALLOWED' };
  const host = u.hostname.toLowerCase();
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  if (isLocal) {
    if (!allowLocalhost) return { ok: false, reason: 'LOCALHOST_NOT_ALLOWED' };
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: 'UNSUPPORTED_SCHEME' };
  } else {
    if (u.protocol !== 'https:') return { ok: false, reason: 'HTTPS_REQUIRED' };
    const d = normalizeDomain(u.hostname);
    if (!d.ok) return { ok: false, reason: d.reason };
  }
  const base = `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
  return { ok: true, base, origin: `${u.protocol}//${u.host}` };
}

module.exports = { normalizeDomain, domainKey, validateServiceBaseUrl };
