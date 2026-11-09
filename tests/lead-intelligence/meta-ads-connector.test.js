'use strict';

/**
 * The Meta Ads connector (packages/meta-ads-mcp): normalising both sources,
 * the official API's request and token handling, the scraper's request,
 * source choice, and the MCP server itself (auth, tools, errors).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { fromMetaApi, fromScraper, tidy } = require('../../packages/meta-ads-mcp/src/normalize');
const { createMetaApiSource } = require('../../packages/meta-ads-mcp/src/sources/metaApi');
const { createApifySource, flatten } = require('../../packages/meta-ads-mcp/src/sources/apify');
const { searchAds, sourcesFromEnv, validate } = require('../../packages/meta-ads-mcp/src');
const { createConnectorServer } = require('../../packages/meta-ads-mcp/src/server');
const { createAdsConnector, connectorConfig } = require('../../packages/lead-intelligence-worker/src/adsConnector');
const { intel } = require('@zunitech/lead-intelligence');

const TOKEN = 'connector-test-token-0123456789';
const META_TOKEN = 'EAAB-secret-meta-token';

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    const { status = 200, body } = await handler(String(url), init, calls.length);
    return { status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
  };
  fn.calls = calls;
  return fn;
}

test('official API ads are normalised and never carry the token', () => {
  const ad = fromMetaApi({
    id: '123456789', page_id: '987654', page_name: 'Bright Smile Dental', ad_delivery_start_time: '2026-10-01',
    ad_creative_bodies: ['  Book your  check-up today ', 'second'], ad_creative_link_titles: ['Book now'],
    ad_snapshot_url: `https://www.facebook.com/ads/archive/render_ad/?id=123456789&access_token=${META_TOKEN}`,
    publisher_platforms: ['instagram', 'facebook'], eu_total_reach: 12000, spend: { lower_bound: '100', upper_bound: '199' },
  });
  assert.equal(ad.ad_id, '123456789');
  assert.equal(ad.body, 'Book your check-up today');
  assert.equal(ad.is_active, true);
  assert.equal(ad.started_at, '2026-10-01T00:00:00.000Z');
  assert.deepEqual(ad.platforms, ['facebook', 'instagram']);
  assert.equal(ad.eu_reach, 12000);
  assert.deepEqual(ad.spend, { lower: 100, upper: 199 });
  assert.ok(!ad.snapshot_url.includes(META_TOKEN), 'the token is redacted');
  assert.equal(ad.cta, null, 'nothing is invented');
});

test('scraper ads with different key spellings normalise the same', () => {
  const a = fromScraper({ library_id: '111', page_name: 'A', ad_body: 'Hi', cta_text: 'Send WhatsApp message', start_date: 1759276800, is_active: true, publisher_platforms: ['FACEBOOK'], collation_count: 4, display_format: 'VIDEO' });
  const b = fromScraper({ adArchiveID: '222', pageName: 'A', snapshot: { body: { text: 'Hello' }, cta_text: 'Learn more' }, startDate: '2026-09-01T00:00:00Z', isActive: false, endDate: 1761955200, publisherPlatform: 'instagram,facebook' });
  assert.equal(a.ad_id, '111');
  assert.equal(a.cta, 'Send WhatsApp message');
  assert.equal(a.variants, 4);
  assert.equal(a.started_at, '2025-10-01T00:00:00.000Z');
  assert.equal(a.snapshot_url, 'https://www.facebook.com/ads/library/?id=111');
  assert.equal(b.ad_id, '222');
  assert.equal(b.body, 'Hello');
  assert.equal(b.is_active, false);
  assert.ok(b.stopped_at);
  assert.deepEqual(b.platforms, ['facebook', 'instagram']);
  assert.deepEqual(flatten([{ results: JSON.stringify([{ library_id: '1' }, { library_id: '2' }]) }, { library_id: '3' }]).length, 3);
  assert.deepEqual(tidy([a, a, { ad_id: null }], 10).map((x) => x.ad_id), ['111'], 'duplicates and id-less rows are dropped');
});

test('the official API source: the right query, the token in a header, Meta\'s next page only', async () => {
  const fetchImpl = fakeFetch(async (url, init, n) => {
    assert.ok(!url.includes(META_TOKEN), 'the token is never in the URL');
    assert.equal(init.headers.Authorization, `Bearer ${META_TOKEN}`);
    if (n === 1) {
      return { body: { data: [{ id: '1', page_id: '9', page_name: 'P', ad_delivery_start_time: '2026-10-01' }], paging: { next: `https://graph.facebook.com/v26.0/ads_archive?after=abc&access_token=${META_TOKEN}` } } };
    }
    return { body: { data: [{ id: '2', page_id: '9', page_name: 'P', ad_delivery_start_time: '2026-10-02', ad_delivery_stop_time: '2026-10-20' }] } };
  });
  const src = createMetaApiSource({ accessToken: META_TOKEN, fetchImpl });
  const ads = await src.search({ query: 'P', pageId: '9', country: 'GB', active: 'all', max: 50 });
  const first = new URL(fetchImpl.calls[0].url);
  assert.equal(first.pathname, '/v26.0/ads_archive');
  assert.equal(first.searchParams.get('ad_reached_countries'), '["GB"]');
  assert.equal(first.searchParams.get('search_page_ids'), '["9"]');
  assert.equal(first.searchParams.get('ad_active_status'), 'ALL');
  assert.equal(new URL(fetchImpl.calls[1].url).searchParams.get('access_token'), null, 'the token Meta copies into "next" is dropped');
  assert.deepEqual(ads.map((a) => [a.ad_id, a.is_active]), [['2', false], ['1', true]]);

  const expired = createMetaApiSource({ accessToken: META_TOKEN, fetchImpl: fakeFetch(async () => ({ status: 400, body: { error: { code: 190, message: `bad token ${META_TOKEN}` } } })) });
  await assert.rejects(expired.search({ query: 'P', country: 'GB', active: 'all', max: 5 }), (e) => e.code === 'source_auth' && !e.message.includes(META_TOKEN));
});

test('the scraper source: actor URL, input and errors', async () => {
  const fetchImpl = fakeFetch(async (url, init) => {
    assert.match(url, /^https:\/\/api\.apify\.com\/v2\/acts\/good-apis~facebook-ads-scraper\/run-sync-get-dataset-items\?/);
    assert.deepEqual(JSON.parse(init.body), { slug: 'brightsmile', country: 'PK', max_ads: 20, active_only: false });
    return { body: [{ library_id: '5', page_name: 'Bright Smile', ad_body: 'x', start_date: '2026-10-01', is_active: true }] };
  });
  const src = createApifySource({ token: 'apify-token', fetchImpl });
  const ads = await src.search({ query: 'brightsmile', country: 'PK', active: 'all', max: 20 });
  assert.equal(ads[0].ad_id, '5');
  const broke = createApifySource({ token: 'apify-token', fetchImpl: fakeFetch(async () => ({ status: 402, body: {} })) });
  await assert.rejects(broke.search({ query: 'x', country: 'PK', active: 'all', max: 5 }), (e) => e.code === 'source_payment');
  const custom = createApifySource({ token: 't', inputTemplate: { startUrls: [{ url: 'https://www.facebook.com/ads/library/?country={{country}}&q={{query}}' }], count: '{{max}}' }, fetchImpl: fakeFetch(async (u, init) => {
    assert.deepEqual(JSON.parse(init.body), { startUrls: [{ url: 'https://www.facebook.com/ads/library/?country=US&q=acme' }], count: 7 });
    return { body: [] };
  }) });
  await custom.search({ query: 'acme', country: 'US', active: 'all', max: 7 });
});

test('source choice: official API for EU/UK, scraper elsewhere, and a note when the API cannot see business ads', async () => {
  const meta = { name: 'meta_api', search: async () => [] };
  const apify = { name: 'apify', search: async () => [] };
  assert.equal((await searchAds(new Map([['meta_api', meta], ['apify', apify]]), { query: 'x', country: 'GB' })).source, 'meta_api');
  assert.equal((await searchAds(new Map([['meta_api', meta], ['apify', apify]]), { query: 'x', country: 'PK' })).source, 'apify');
  const onlyApi = await searchAds(new Map([['meta_api', meta]]), { query: 'x', country: 'PK' });
  assert.match(onlyApi.notes[0], /only political and issue ads/);
  await assert.rejects(searchAds(new Map(), { query: 'x', country: 'PK' }), (e) => e.code === 'source_not_configured');
  assert.throws(() => validate({ country: 'PK' }), /page name/);
  assert.throws(() => validate({ query: 'x', country: 'Pakistan' }), /two-letter/);
  assert.throws(() => validate({ page_id: 'abc', country: 'PK' }), /numeric/);
  assert.deepEqual([...sourcesFromEnv({}).keys()], []);
  assert.deepEqual([...sourcesFromEnv({ APIFY_TOKEN: 't', META_ACCESS_TOKEN: 'm' }).keys()].sort(), ['apify', 'meta_api']);
});

test('the MCP server: bearer token required, two tools, clean errors; the worker client talks to it', async () => {
  const fake = { name: 'apify', describe: 'fake', search: async (q) => [{ ad_id: '1', page_name: q.query, is_active: true, started_at: '2026-10-01T00:00:00.000Z', platforms: ['facebook'] }] };
  const srv = createConnectorServer({ token: TOKEN, sources: new Map([['apify', fake]]), logger: { warn() {}, error() {} } });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const anon = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(anon.status, 401);
    const wrong = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer nope' }, body: '{}' });
    assert.equal(wrong.status, 401);
    assert.equal((await fetch(`${base}/health`)).status, 200);

    const cfg = connectorConfig({ ZTECH_ADS_MCP_URL: `${base}/mcp`, ZTECH_ADS_MCP_TOKEN: TOKEN });
    const client = createAdsConnector(cfg);
    const out = await client.search({ query: 'Bright Smile', country: 'PK', active: 'all', max_ads: 10 });
    assert.equal(out.source, 'apify');
    assert.equal(out.ads[0].page_name, 'Bright Smile');
    await assert.rejects(client.search({ country: 'PK' }), (e) => e.code === 'invalid_input');
    const noAuth = createAdsConnector({ url: new URL(`${base}/mcp`), token: 'x'.repeat(30) });
    await assert.rejects(noAuth.search({ query: 'x', country: 'PK' }), (e) => e.code === 'connector_unreachable');
    assert.throws(() => connectorConfig({ ZTECH_ADS_MCP_URL: 'http://ads.example.com/mcp', ZTECH_ADS_MCP_TOKEN: TOKEN }), /https/);
    assert.throws(() => connectorConfig({ ZTECH_ADS_MCP_URL: 'https://ads.example.com/mcp', ZTECH_ADS_MCP_TOKEN: 'short' }), /24/);
  } finally {
    srv.close();
  }
});

test('week against week: new, stopped, long-running, and the stated rule', () => {
  const { compareChecks, history, isoWeek } = intel.adsDiff;
  const week1 = { fetched_at: '2026-10-26T09:00:00.000Z', ads: [
    { ad_id: 'a', is_active: true, started_at: '2026-09-20T00:00:00.000Z', cta: 'Send WhatsApp message', platforms: ['facebook', 'instagram'] },
    { ad_id: 'b', is_active: true, started_at: '2026-10-20T00:00:00.000Z', cta: 'Learn more', platforms: ['facebook'] },
  ] };
  const week2 = { fetched_at: '2026-11-02T09:00:00.000Z', ads: [
    { ad_id: 'a', is_active: true, started_at: '2026-09-20T00:00:00.000Z', cta: 'Send WhatsApp message', platforms: ['facebook', 'instagram'] },
    { ad_id: 'b', is_active: false, started_at: '2026-10-20T00:00:00.000Z', stopped_at: '2026-10-30T00:00:00.000Z', cta: 'Learn more', platforms: ['facebook'] },
    { ad_id: 'c', is_active: true, started_at: '2026-11-01T00:00:00.000Z', cta: 'Send WhatsApp message', platforms: ['instagram'] },
  ] };
  const r = compareChecks(week1, week2, new Date('2026-11-02T09:00:00.000Z'));
  assert.deepEqual(r.counts, { active: 2, total_seen: 3, new_since_last: 1, stopped_since_last: 1, likely_working: 1 });
  assert.equal(r.longest_running.ad_id, 'a');
  assert.equal(r.longest_running.running_days, 43);
  assert.deepEqual(r.stopped.map((s) => s.ad_id), ['b']);
  assert.equal(r.ads.find((a) => a.ad_id === 'c').is_new, true);
  assert.deepEqual(r.by_cta, { 'Send WhatsApp message': 2 });
  assert.deepEqual(r.by_platform, { instagram: 2, facebook: 1 });
  assert.match(r.rule, /21 days/);
  const first = compareChecks(null, week1, new Date('2026-10-26T09:00:00.000Z'));
  assert.equal(first.first_check, true);
  assert.equal(first.counts.new_since_last, null, 'no "new" on a first check');
  assert.deepEqual(history([week2, week1]).map((h) => h.active), [2, 2]);
  assert.equal(isoWeek(new Date('2026-11-09T10:00:00Z')), '2026-W46');
  assert.equal(isoWeek(new Date('2027-01-01T10:00:00Z')), '2026-W53');
});
