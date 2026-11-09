'use strict';

/**
 * Meta's official Ad Library API (Graph API `ads_archive`).
 *
 * What it covers (Meta's rules, not ours): political and issue ads in every
 * country, and ALL ads that were delivered in the EU (and the UK). An
 * ordinary business ad shown only in Pakistan or the US is NOT returned.
 * Needs a user access token of a Meta app with Ad Library API access
 * (META_ACCESS_TOKEN). The token is sent to graph.facebook.com only and is
 * never logged or returned (the snapshot URL's copy is redacted).
 */

const { SourceError, timedFetch, parseJson } = require('./common');
const { fromMetaApi, tidy } = require('../normalize');

const FIELDS = [
  'id', 'page_id', 'page_name', 'ad_delivery_start_time', 'ad_delivery_stop_time', 'ad_creative_bodies',
  'ad_creative_link_titles', 'ad_creative_link_captions', 'ad_snapshot_url', 'publisher_platforms',
  'spend', 'impressions', 'currency', 'eu_total_reach', 'languages',
].join(',');
const HOST = 'graph.facebook.com';

function createMetaApiSource({ accessToken, version = 'v26.0', fetchImpl = globalThis.fetch, timeoutMs = 30000, baseUrl = `https://${HOST}` }) {
  if (!accessToken) return null;
  if (!/^v\d{1,3}\.\d$/.test(version)) throw new Error('META_GRAPH_VERSION must look like v26.0');
  return {
    name: 'meta_api',
    describe: 'Meta Ad Library API: political/issue ads everywhere, and all ads delivered in the EU/UK.',
    async search({ query, pageId, country, active, max }) {
      const params = new URLSearchParams({
        ad_reached_countries: JSON.stringify([country]),
        ad_active_status: active === 'active' ? 'ACTIVE' : 'ALL',
        ad_type: 'ALL',
        fields: FIELDS,
        limit: String(Math.min(max, 100)),
      });
      if (pageId) params.set('search_page_ids', JSON.stringify([pageId]));
      else params.set('search_terms', query);
      let url = `${baseUrl}/${version}/ads_archive?${params}`;
      const ads = [];
      for (let page = 0; page < 10 && url && ads.length < max; page += 1) {
        const res = await timedFetch(fetchImpl, url, { headers: { Authorization: `Bearer ${accessToken}` } }, timeoutMs, 'Meta Ad Library API');
        const data = parseJson(res.body, 'Meta Ad Library API');
        if (res.status === 429 || (data.error && [4, 17, 613].includes(data.error.code))) {
          throw new SourceError('source_rate_limited', 'Meta asked us to slow down; try again later', { retryable: true });
        }
        if (res.status >= 400 || data.error) {
          const code = data.error && data.error.code === 190 ? 'source_auth' : 'source_error';
          throw new SourceError(code, code === 'source_auth' ? 'the Meta access token is invalid or expired' : `Meta Ad Library API answered HTTP ${res.status}`);
        }
        for (const a of Array.isArray(data.data) ? data.data : []) ads.push(fromMetaApi(a));
        const next = data.paging && data.paging.next;
        // Follow Meta's own next page only; drop the token Meta copies into it.
        if (next && new URL(next).hostname === new URL(baseUrl).hostname) {
          const u = new URL(next);
          u.searchParams.delete('access_token');
          url = u.toString();
        } else url = null;
      }
      return tidy(ads, max);
    },
  };
}

module.exports = { createMetaApiSource, FIELDS };
