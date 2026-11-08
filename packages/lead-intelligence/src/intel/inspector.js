'use strict';

/**
 * Inspect one business website and turn what was observed into evidence and
 * findings.
 *
 * The inspector does not touch the network itself: it is given `fetchPage`,
 * which the worker implements with the SSRF guard, the timeouts and the size
 * limits (packages/lead-intelligence-worker/src/safeFetch.js). It makes at
 * most five requests per website: robots.txt, the page, one retry over the
 * other scheme, and the sitemap.
 *
 *   fetchPage(url, { signal }) -> Promise<{
 *     ok: boolean,            // a response arrived (any status)
 *     status?: number, finalUrl?: string, contentType?: string,
 *     body?: string, elapsedMs?: number, truncated?: boolean,
 *     error?: string,         // why no response arrived (a code, no secrets)
 *   }>
 */

const crypto = require('node:crypto');
const { normalizeDomain } = require('../core/urls');
const { readHtml } = require('./html');
const { parseRobots, isAllowed } = require('./robots');
const { CHECKS, SLOW_MS, MIN_TEXT_FOR_CONTENT_CHECKS, contentChecks, excerpt } = require('./checks');

function stableId(prefix, ...parts) {
  return `${prefix}_${crypto.createHash('sha256').update(parts.join('\u0001')).digest('hex').slice(0, 16)}`;
}

class Recorder {
  constructor(businessId, now) {
    this.businessId = businessId;
    this.observedAt = now().toISOString();
    this.evidence = [];
    this.findings = [];
    this.notes = [];
  }

  /** Evidence of something observed (or observed to be absent). */
  addEvidence({ source_url, method, excerpt: text, kind = 'observed' }) {
    const evidence_id = stableId('ev', this.businessId, method, source_url, String(this.evidence.length));
    this.evidence.push({
      evidence_id,
      business_id: this.businessId,
      source_url,
      method,
      kind,
      excerpt: excerpt(text, 300),
      observed_at: this.observedAt,
    });
    return evidence_id;
  }

  addFinding(checkId, evidenceIds) {
    const def = CHECKS[checkId];
    if (!def) throw new Error(`unknown check ${checkId}`);
    if (this.findings.some((f) => f.check_id === checkId)) return;
    this.findings.push({
      finding_id: stableId('fd', this.businessId, checkId),
      business_id: this.businessId,
      check_id: checkId,
      area: def.area,
      severity: def.severity,
      category: def.category,
      title: def.title,
      problem: def.problem,
      caveat: def.caveat,
      confidence: def.confidence,
      evidence_ids: evidenceIds,
    });
  }
}

function originOf(url) {
  const u = new URL(url);
  return `${u.protocol}//${u.host}`;
}

function swapScheme(url) {
  const u = new URL(url);
  u.protocol = u.protocol === 'https:' ? 'http:' : 'https:';
  return u.toString();
}

/**
 * @param {{
 *   business: {business_id: string, website: string|null, source_url: string},
 *   industryBooking: boolean,
 *   fetchPage: Function,
 *   now?: () => Date,
 *   signal?: AbortSignal,
 * }} input
 * @returns {Promise<{status: string, evidence: object[], findings: object[], pages_fetched: number, notes: string[]}>}
 */
async function inspectWebsite({ business, industryBooking, fetchPage, now = () => new Date(), signal }) {
  const rec = new Recorder(business.business_id, now);
  let fetches = 0;
  const get = async (url) => {
    if (signal && signal.aborted) throw Object.assign(new Error('the research was stopped'), { code: 'ABORTED' });
    fetches += 1;
    return fetchPage(url, { signal });
  };
  const done = (status) => ({
    status, evidence: rec.evidence, findings: rec.findings, pages_fetched: fetches, notes: rec.notes,
  });

  // 1. No website in the listing: that absence is the observation.
  if (!business.website) {
    const ev = rec.addEvidence({
      source_url: business.source_url,
      method: 'listing website field',
      kind: 'absence',
      excerpt: 'The public listing for this business has no website address.',
    });
    rec.addFinding('NO_WEBSITE', [ev]);
    return done('no_website');
  }

  const normalized = normalizeDomain(business.website);
  if (!normalized.ok) {
    rec.notes.push(`The listed website "${excerpt(business.website, 80)}" is not a public web address (${normalized.reason}); it was not visited.`);
    return done('unusable_url');
  }
  let listed;
  try {
    listed = new URL(/^https?:\/\//i.test(business.website.trim()) ? business.website.trim() : `https://${normalized.host}/`);
  } catch {
    rec.notes.push('The listed website could not be read as an address; it was not visited.');
    return done('unusable_url');
  }
  if (listed.protocol !== 'http:' && listed.protocol !== 'https:') {
    rec.notes.push('The listed website does not use http or https; it was not visited.');
    return done('unusable_url');
  }
  listed.hash = '';
  const pagePath = `${listed.pathname || '/'}${listed.search || ''}`;

  // 2. robots.txt decides whether we may look at all.
  const robotsUrl = `${originOf(listed.toString())}/robots.txt`;
  let robotsRes = await get(robotsUrl);
  if (!robotsRes.ok && listed.protocol === 'https:') {
    // The secure origin did not answer; the plain one's robots.txt governs
    // the plain origin, which is what we would then read.
    const plain = await get(swapScheme(robotsUrl));
    if (plain.ok) robotsRes = plain;
  }
  if (!robotsRes.ok) {
    const ev = rec.addEvidence({
      source_url: listed.toString(),
      method: 'HTTP request (robots.txt)',
      kind: 'absence',
      excerpt: `No response from the website (${robotsRes.error || 'no response'}).`,
    });
    rec.addFinding('SITE_UNREACHABLE', [ev]);
    return done('unreachable');
  }
  let robots = { groups: [], sitemaps: [] };
  if (robotsRes.status >= 500) {
    // RFC 9309: an unreachable robots.txt means "assume everything is disallowed".
    rec.notes.push(`robots.txt answered ${robotsRes.status}; the site was not inspected, as the robots standard requires.`);
    rec.addEvidence({ source_url: robotsRes.finalUrl || robotsUrl, method: 'robots.txt', kind: 'observed', excerpt: `robots.txt returned HTTP ${robotsRes.status}.` });
    return done('not_permitted');
  }
  if (robotsRes.status >= 200 && robotsRes.status < 300) robots = parseRobots(robotsRes.body || '');
  const permission = isAllowed(robots, pagePath);
  if (!permission.allowed) {
    rec.notes.push('The website\'s robots.txt does not allow automated visits to this page; it was not inspected.');
    rec.addEvidence({ source_url: robotsRes.finalUrl || robotsUrl, method: 'robots.txt', kind: 'observed', excerpt: `${permission.rule} (group ${permission.group})` });
    return done('not_permitted');
  }

  // 3. The page, over the listed scheme first.
  let page = await get(listed.toString());
  let usedPlainFallback = false;
  if (!page.ok && listed.protocol === 'https:') {
    const plain = await get(swapScheme(listed.toString()));
    if (plain.ok) {
      page = plain;
      usedPlainFallback = true;
    }
  }
  if (!page.ok) {
    const ev = rec.addEvidence({
      source_url: listed.toString(),
      method: 'HTTP request (home page)',
      kind: 'absence',
      excerpt: `No response from the website (${page.error || 'no response'}).`,
    });
    rec.addFinding('SITE_UNREACHABLE', [ev]);
    return done('unreachable');
  }
  const finalUrl = page.finalUrl || listed.toString();

  // 4. HTTPS.
  if (usedPlainFallback) {
    const ev = rec.addEvidence({
      source_url: listed.toString(),
      method: 'HTTPS request',
      kind: 'absence',
      excerpt: `The secure address did not answer; the plain http:// address did (${finalUrl}).`,
    });
    rec.addFinding('NO_HTTPS', [ev]);
  } else if (finalUrl.startsWith('http://')) {
    const secure = await get(swapScheme(finalUrl));
    if (secure.ok && secure.status < 400) {
      const ev = rec.addEvidence({
        source_url: finalUrl,
        method: 'HTTP request without redirect to HTTPS',
        excerpt: `${finalUrl} answered ${page.status} without redirecting to https://, although the secure address works.`,
      });
      rec.addFinding('HTTP_NOT_REDIRECTED', [ev]);
    } else {
      const ev = rec.addEvidence({
        source_url: swapScheme(finalUrl),
        method: 'HTTPS request',
        kind: 'absence',
        excerpt: `The secure address did not answer successfully (${secure.ok ? `HTTP ${secure.status}` : secure.error || 'no response'}).`,
      });
      rec.addFinding('NO_HTTPS', [ev]);
    }
  }

  // 5. Error status.
  if (page.status >= 400) {
    const ev = rec.addEvidence({ source_url: finalUrl, method: 'HTTP status (home page)', excerpt: `The home page returned HTTP ${page.status}.` });
    rec.addFinding('SITE_ERROR', [ev]);
    return done('inspected');
  }

  // 6. Response time (one sample; the caveat says so).
  if (typeof page.elapsedMs === 'number' && page.elapsedMs > SLOW_MS) {
    const ev = rec.addEvidence({ source_url: finalUrl, method: 'response time, one request', excerpt: `The home page took ${(page.elapsedMs / 1000).toFixed(1)} s to load.` });
    rec.addFinding('SLOW_RESPONSE', [ev]);
  }

  // 7. Content checks, only on a page we can actually read.
  const isHtml = /html/i.test(page.contentType || '') || /^\s*<(!doctype|html)/i.test(page.body || '');
  const doc = isHtml ? readHtml(page.body || '') : null;
  if (!doc || !doc.looksLikeHtml || doc.text.length < MIN_TEXT_FOR_CONTENT_CHECKS) {
    rec.notes.push('The home page could not be read as a normal HTML page (it may be built entirely by scripts); its content was not judged.');
  } else {
    if (page.truncated) rec.notes.push('The home page is very large; only its first part was read.');
    const nowYear = now().getUTCFullYear();
    for (const hit of contentChecks(doc, { url: finalUrl, elapsedMs: page.elapsedMs, industryBooking, nowYear })) {
      const ev = rec.addEvidence({ source_url: finalUrl, method: hit.method, excerpt: hit.excerpt, kind: /^(NO_|MISSING_)/.test(hit.check_id) ? 'absence' : 'observed' });
      rec.addFinding(hit.check_id, [ev]);
    }
  }

  // 8. Sitemap: declared in robots.txt, or at the conventional address.
  if (robots.sitemaps.length === 0 && isAllowed(robots, '/sitemap.xml').allowed) {
    const sitemapUrl = `${originOf(finalUrl)}/sitemap.xml`;
    const sm = await get(sitemapUrl);
    if (sm.ok && (sm.status === 404 || sm.status === 410)) {
      const ev = rec.addEvidence({ source_url: sitemapUrl, method: 'HTTP request (sitemap.xml) and robots.txt', kind: 'absence', excerpt: `No Sitemap line in robots.txt, and ${sitemapUrl} returned HTTP ${sm.status}.` });
      rec.addFinding('NO_SITEMAP', [ev]);
    }
  }

  return done('inspected');
}

module.exports = { inspectWebsite, stableId };
