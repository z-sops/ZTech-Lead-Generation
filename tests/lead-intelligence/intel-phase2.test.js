'use strict';

/**
 * Phase 2 intelligence: the evaluation dataset, the permission policy, the
 * network guard, discovery, scoring and drafts.
 *
 * The EVALUATION test is the false-positive gate: the inspector runs over
 * labelled websites (tests/fixtures/phase2-sites/expected.json) through the
 * real guarded fetcher, and must report exactly the labelled findings - no
 * more (precision 1.0) and no fewer (recall 1.0).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { intel } = require('@zunitech/lead-intelligence');
const { createResearchExecutor, researchConfig } = require('../../packages/lead-intelligence-worker/src/research');
const { createSafeFetch, isBlockedAddress } = require('../../packages/lead-intelligence-worker/src/safeFetch');
const { startFixtureServer } = require('../lib/phase2-fixture-server');

const CRITERIA = { industry: 'dentist', location: 'Leeds, UK', offer_categories: ['seo', 'security', 'web_design', 'booking'], max_results: 25 };
const NOW = () => new Date('2026-11-09T10:00:00Z');

function fixtureEnv(fx) {
  return {
    ZTECH_INSPECT_ALLOW_PRIVATE: '1', ZTECH_INSPECT_HOST_MAP: fx.hostMap, ZTECH_NOMINATIM_URL: fx.nominatimUrl, ZTECH_OVERPASS_URL: fx.overpassUrl,
  };
}

test('evaluation: the inspector reports exactly the labelled findings (no false positives)', async () => {
  const fx = await startFixtureServer();
  try {
    const exec = createResearchExecutor({ env: fixtureEnv(fx), now: NOW });
    const result = await exec({ jobType: 'research', jobClass: 'noop', payload: { kind: 'business_research', criteria: CRITERIA } });
    let truePositives = 0;
    let falsePositives = 0;
    let falseNegatives = 0;
    for (const [id, label] of Object.entries(fx.expected)) {
      if (id.startsWith('_')) continue;
      const business = result.businesses.find((b) => b.business_id === id);
      assert.ok(business, `${id} was discovered`);
      assert.equal(business.inspection.status, label.status, `${id} inspection status`);
      const got = new Set(result.findings.filter((f) => f.business_id === id).map((f) => f.check_id));
      for (const c of got) {
        if (label.findings.includes(c)) truePositives += 1;
        else { falsePositives += 1; assert.fail(`${id}: unexpected finding ${c} (false positive)`); }
      }
      for (const c of label.findings) if (!got.has(c)) { falseNegatives += 1; assert.fail(`${id}: missed ${c}`); }
    }
    assert.equal(falsePositives, 0);
    assert.equal(falseNegatives, 0);
    assert.ok(truePositives >= 17);

    // Every finding has evidence; every evidence item says where and when.
    const evidenceIds = new Set(result.evidence.map((e) => e.evidence_id));
    for (const f of result.findings) {
      assert.ok(f.evidence_ids.length > 0 && f.evidence_ids.every((e) => evidenceIds.has(e)), `${f.check_id} has evidence`);
      assert.ok(f.confidence > 0 && f.confidence <= 1);
    }
    for (const e of result.evidence) {
      assert.match(e.source_url, /^https?:\/\//);
      assert.equal(e.observed_at, NOW().toISOString());
      assert.ok(e.method && e.excerpt);
    }
    // Real businesses only: each one is an OSM object with its URL.
    for (const b of result.businesses) {
      assert.match(b.source_url, /^https:\/\/www\.openstreetmap\.org\/(node|way|relation)\/\d+$/);
      assert.equal(b.retrieved_at, NOW().toISOString());
    }
    assert.equal(result.synthetic, false);
    assert.equal(result.summary.found_in_area, 9, 'the unnamed object is dropped and the duplicate website merged');
  } finally {
    await fx.close();
  }
});

test('permission policy: robots.txt is obeyed, and every request identifies the bot', async () => {
  const fx = await startFixtureServer();
  try {
    const exec = createResearchExecutor({ env: fixtureEnv(fx), now: NOW });
    await exec({ jobType: 'research', jobClass: 'noop', payload: { kind: 'business_research', criteria: CRITERIA } });
    const privatePaths = fx.requests.filter((r) => r.host === 'private-dental.ztech-fixture.com').map((r) => r.path);
    assert.deepEqual(privatePaths, ['/robots.txt'], 'only robots.txt was read from the site that disallows us');
    assert.ok(fx.requests.every((r) => /^ZTechResearchBot\/1\.0 \(\+https:\/\/zunitech\.ai\/bot\)$/.test(r.ua)), 'honest User-Agent on every request');
    const perSite = {};
    for (const r of fx.requests) perSite[r.host] = (perSite[r.host] || 0) + 1;
    for (const [host, n] of Object.entries(perSite)) {
      if (host !== 'maps.ztech-fixture.com') assert.ok(n <= 5, `${host}: at most 5 requests (${n})`);
    }
    const overpass = fx.requests.find((r) => r.path === '/api/interpreter');
    assert.match(overpass.body, /area\(id:3600118362\)/);
    assert.match(overpass.body, /nwr\["amenity"="dentist"\]\["name"\]\(area\.a\)/);
  } finally {
    await fx.close();
  }
});

test('robots.txt parsing follows RFC 9309', () => {
  const r = intel.robots.parseRobots('User-agent: *\nDisallow: /private\nAllow: /private/ok$\n\nUser-agent: ZTechResearchBot\nDisallow: /no-bots\n# comment\nSitemap: https://x.example/s.xml');
  assert.deepEqual(r.sitemaps, ['https://x.example/s.xml']);
  assert.equal(intel.robots.isAllowed(r, '/private').allowed, true, 'our own group applies, not "*"');
  assert.equal(intel.robots.isAllowed(r, '/no-bots/page').allowed, false);
  const star = intel.robots.parseRobots('User-agent: *\nDisallow: /a\nAllow: /a/b\nDisallow: /*.pdf$\nDisallow:');
  assert.equal(intel.robots.isAllowed(star, '/a/x').allowed, false);
  assert.equal(intel.robots.isAllowed(star, '/a/b/c').allowed, true, 'the longest rule wins');
  assert.equal(intel.robots.isAllowed(star, '/f.pdf').allowed, false);
  assert.equal(intel.robots.isAllowed(star, '/f.pdf?x').allowed, true);
  assert.equal(intel.robots.isAllowed(intel.robots.parseRobots(''), '/').allowed, true);
});

test('the network guard refuses private addresses, odd ports and credentials', async () => {
  for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1']) {
    assert.equal(isBlockedAddress(a), true, a);
  }
  for (const a of ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946']) assert.equal(isBlockedAddress(a), false, a);
  const f = createSafeFetch({ userAgent: 'test (+https://x.example)' });
  assert.equal((await f.fetchPage('http://127.0.0.1/')).error, 'blocked_private_address');
  assert.equal((await f.fetchPage('http://169.254.169.254/latest/meta-data/')).error, 'blocked_private_address');
  assert.equal((await f.fetchPage('http://localhost/')).error, 'blocked_private_address', 'a name that resolves to loopback is refused');
  assert.equal((await f.fetchPage('http://example.com:8080/')).error, 'non_default_port');
  assert.equal((await f.fetchPage('http://user:pw@example.com/')).error, 'credentials_in_url');
  assert.equal((await f.fetchPage('ftp://example.com/')).error, 'unsupported_scheme');
  assert.throws(() => researchConfig({ ZTECH_INSPECT_ALLOW_PRIVATE: '1', NODE_ENV: 'production' }), /tests only/);
  assert.throws(() => researchConfig({ ZTECH_INSPECT_HOST_MAP: 'a=1234' }), /tests only/);
  assert.throws(() => researchConfig({ ZTECH_RESEARCH_USER_AGENT: 'nobody' }), /contact URL/);
});

test('the network guard limits redirects, size and time', async () => {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/loop')) { res.writeHead(302, { location: `/loop${Number(req.url.slice(5) || 0) + 1}` }); res.end(); return; }
    if (req.url === '/big') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('x'.repeat(5000)); return; }
    if (req.url === '/slow') { res.writeHead(200, { 'content-type': 'text/html' }); res.write('a'); setTimeout(() => res.end('b'), 2000); return; }
    res.end('ok');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const f = createSafeFetch({ userAgent: 't (+https://x.example)', allowPrivate: true, maxBytes: 1000, timeoutMs: 500 });
    assert.equal((await f.fetchPage(`${base}/loop`)).error, 'too_many_redirects');
    const big = await f.fetchPage(`${base}/big`);
    assert.equal(big.truncated, true);
    assert.equal(big.body.length, 1000);
    assert.equal((await f.fetchPage(`${base}/slow`)).error, 'timeout', 'a whole-request deadline, not an idle one');
    const strict = createSafeFetch({ userAgent: 't (+https://x.example)', hostMap: null });
    assert.equal((await strict.fetchPage(`${base}/`)).error, 'non_default_port');
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

test('discovery: real objects only, deduplicated, deterministic, with clear failures', async () => {
  const el = (id, tags, type = 'node') => ({ type, id, lat: 1, lon: 2, tags });
  const els = [el(3, { name: 'B', website: 'https://www.b.example/' }), el(1, { name: 'A' }), el(2, {}), el(4, { name: 'B again', website: 'http://b.example' })];
  const calls = [];
  const request = async (req) => {
    calls.push(req);
    if (req.url.includes('search')) return { ok: true, status: 200, body: JSON.stringify([{ osm_type: 'node', osm_id: 5, boundingbox: ['1', '2', '3', '4'], display_name: 'X' }]) };
    return { ok: true, status: 200, body: JSON.stringify({ elements: els }) };
  };
  const d = new intel.discovery.OsmDiscovery({ request, userAgent: 'ua (+https://x.example)', now: NOW, nominatimUrl: 'https://n.example/search', overpassUrl: 'https://o.example/i' });
  const out = await d.discover(intel.criteria.validateCriteria({ ...CRITERIA, max_results: 5 }));
  assert.deepEqual(out.businesses.map((b) => b.name).sort(), ['A', 'B']);
  assert.match(decodeURIComponent(calls[1].body), /\(1,3,2,4\)/, 'a point location searches its bounding box');
  const again = await d.discover(intel.criteria.validateCriteria({ ...CRITERIA, max_results: 5 }));
  assert.deepEqual(again.businesses.map((b) => b.business_id), out.businesses.map((b) => b.business_id), 'same input, same order');
  const onlyWith = await d.discover(intel.criteria.validateCriteria({ ...CRITERIA, website_filter: 'with_website' }));
  assert.deepEqual(onlyWith.businesses.map((b) => b.name), ['B']);

  const empty = new intel.discovery.OsmDiscovery({ request: async () => ({ ok: true, status: 200, body: '[]' }), userAgent: 'ua (+https://x.example)' });
  await assert.rejects(empty.discover(intel.criteria.validateCriteria(CRITERIA)), (e) => e.code === 'location_not_found');
  const limited = new intel.discovery.OsmDiscovery({ request: async () => ({ ok: true, status: 429, body: '' }), userAgent: 'ua (+https://x.example)' });
  await assert.rejects(limited.discover(intel.criteria.validateCriteria(CRITERIA)), (e) => e.code === 'provider_rate_limited');
  const down = new intel.discovery.OsmDiscovery({ request: async () => ({ ok: false, error: 'timeout' }), userAgent: 'ua (+https://x.example)' });
  await assert.rejects(down.discover(intel.criteria.validateCriteria(CRITERIA)), (e) => e.code === 'provider_unreachable');
});

test('a slow page is reported with its caveat; an unreadable page is not judged', async () => {
  const page = '<html><head><title>T</title></head><body>' + 'word '.repeat(40) + '</body></html>';
  const fetchPage = async (url) => (url.endsWith('robots.txt')
    ? { ok: true, status: 200, finalUrl: url, body: 'Sitemap: https://slow.example/s.xml' }
    : { ok: true, status: 200, finalUrl: url, contentType: 'text/html', body: page, elapsedMs: 5200 });
  const out = await intel.inspector.inspectWebsite({ business: { business_id: 'b1', website: 'https://slow.example/', source_url: 'https://www.openstreetmap.org/node/1' }, industryBooking: false, fetchPage, now: NOW });
  const slow = out.findings.find((f) => f.check_id === 'SLOW_RESPONSE');
  assert.ok(slow);
  assert.match(slow.caveat, /One measurement/);
  assert.equal(slow.confidence, 0.5);

  const pdf = async (url) => ({ ok: true, status: 200, finalUrl: url, contentType: url.endsWith('robots.txt') ? 'text/plain' : 'application/pdf', body: '%PDF-1.4', elapsedMs: 100 });
  const none = await intel.inspector.inspectWebsite({ business: { business_id: 'b2', website: 'https://pdf.example/', source_url: 'https://www.openstreetmap.org/node/2' }, industryBooking: true, fetchPage: pdf, now: NOW });
  assert.deepEqual(none.findings.filter((f) => f.check_id !== 'NO_SITEMAP').map((f) => f.check_id), []);
  assert.match(none.notes.join(' '), /could not be read/);

  const bad = await intel.inspector.inspectWebsite({ business: { business_id: 'b3', website: 'http://10.0.0.1/', source_url: 'https://www.openstreetmap.org/node/3' }, industryBooking: true, fetchPage: () => assert.fail('must not fetch'), now: NOW });
  assert.equal(bad.status, 'unusable_url');
});

test('scoring: documented weights, low-confidence penalty, deterministic ties', () => {
  const { detectNeeds, scoreOpportunity, rankOpportunities, WEIGHTS } = intel.scoring;
  assert.equal(Object.values(WEIGHTS).reduce((a, b) => a + b, 0).toFixed(6), '1.000000');
  const f = (check_id, extra = {}) => ({ finding_id: `f_${check_id}`, business_id: 'b', check_id, ...intel.checks.CHECKS[check_id], evidence_ids: [`e_${check_id}`], ...extra });
  const business = { phone: 'x', website: 'y', address: 'z', opening_hours: 'w' };
  const strong = scoreOpportunity(business, detectNeeds([f('NO_HTTPS'), f('MISSING_VIEWPORT'), f('NOINDEX')], ['security', 'web_design', 'seo']));
  assert.equal(strong.factors.offer_fit, 1);
  assert.equal(strong.factors.penalty, 1);
  const weak = scoreOpportunity(business, detectNeeds([f('NO_ONLINE_BOOKING')], ['booking']));
  assert.equal(weak.factors.penalty, intel.scoring.LOW_CONFIDENCE_FACTOR, 'evidence below 0.6 is penalised');
  assert.ok(weak.score < strong.score);
  const none = scoreOpportunity(business, detectNeeds([f('IMAGES_MISSING_ALT')], ['seo']));
  assert.equal(none.score, 0, 'no need the customer serves, no score');
  const ranked = rankOpportunities([
    { business_id: 'z', business_name: 'Same', score: 50 }, { business_id: 'a', business_name: 'Same', score: 50 }, { business_id: 'm', business_name: 'Alpha', score: 50 },
  ]);
  assert.deepEqual(ranked.map((o) => o.business_id), ['m', 'a', 'z']);
});

test('cancellation stops the research between websites', async () => {
  const fx = await startFixtureServer();
  try {
    const exec = createResearchExecutor({ env: { ...fixtureEnv(fx), ZTECH_RESEARCH_CONCURRENCY: '1' }, now: NOW });
    let checks = 0;
    const result = await exec({
      jobType: 'research', jobClass: 'noop', payload: { kind: 'business_research', criteria: CRITERIA },
      isCancelled: async () => { checks += 1; return checks > 2; },
    });
    assert.equal(result.cancelled, true);
    assert.equal(result.businesses.filter((b) => b.inspection.status === 'skipped').length, result.businesses.length - 2);
  } finally {
    await fx.close();
  }
});

test('Phase 1 jobs still run as no-op, and chargeable jobs are still refused', async () => {
  const exec = createResearchExecutor({ env: {} });
  const out = await exec({ jobType: 'research', jobClass: 'noop', payload: { criteria: 'old style' } });
  assert.equal(out.detail.executed, 'noop');
  await assert.rejects(exec({ jobId: 'j', jobType: 'research', jobClass: 'chargeable', payload: { kind: 'business_research', criteria: CRITERIA } }), /no-op jobs only/);
});

test('a template draft for a business without a website does not claim to have seen one', () => {
  const result = {
    schema: 'ztech.research.v1',
    businesses: [{ business_id: 'b', name: 'Beeston Dental', website: null }],
    opportunities: [{ opportunity_id: 'o', business_id: 'b', need_ids: ['n'] }],
    needs: [{ need_id: 'n', service: 'Website design', problems: ['No site.'], caveats: ['Listing may be incomplete.'], finding_ids: ['f'] }],
    findings: [{ finding_id: 'f', title: 'No website listed', evidence_ids: ['e'] }],
    evidence: [{ evidence_id: 'e', excerpt: 'no website', source_url: 'https://www.openstreetmap.org/node/1', method: 'listing', observed_at: NOW().toISOString() }],
  };
  return intel.proposal.generateProposal({ result, opportunityId: 'o', offer: { sender_name: 'Z', sender_company: 'Zunitech', offer_summary: 'We build websites.' }, now: NOW }).then((d) => {
    assert.match(d.body, /could not find a website listed/);
    assert.doesNotMatch(d.body, /looked at your website/);
    assert.match(d.body, /Listing may be incomplete/);
    assert.equal(d.can_send, false);
  });
});
