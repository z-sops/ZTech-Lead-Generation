'use strict';

/**
 * A hosted Ad Library scraper on Apify (pay per result). It reads the
 * public Ad Library in every country, which Meta's official API does not
 * cover for ordinary business ads. The scraping is the actor's: it uses no
 * Facebook login of ours. Needs APIFY_TOKEN; the actor is APIFY_ACTOR
 * (default good-apis/facebook-ads-scraper, $0.75 per 1,000 ads as listed
 * in Nov 2026).
 *
 * Actors differ in input. The default input below is the default actor's
 * documented one; another actor's input is given as APIFY_INPUT_JSON with
 * the placeholders "{{query}}", "{{country}}", "{{max}}" and "{{active}}".
 */

const { SourceError, timedFetch, parseJson } = require('./common');
const { fromScraper, tidy } = require('../normalize');

const DEFAULT_ACTOR = 'good-apis/facebook-ads-scraper';

function buildInput(template, { query, country, max, active }) {
  if (!template) return { slug: query, country, max_ads: max, active_only: active === 'active' };
  const fill = (v) => {
    if (typeof v === 'string') {
      if (v === '{{max}}') return max;
      if (v === '{{active}}') return active === 'active';
      return v.replace(/\{\{query\}\}/g, query).replace(/\{\{country\}\}/g, country);
    }
    if (Array.isArray(v)) return v.map(fill);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]));
    return v;
  };
  return fill(template);
}

/** Dataset items -> ads (some actors return one item per ad, some a `results` list). */
function flatten(items) {
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    let inner = item && item.results;
    if (typeof inner === 'string') { try { inner = JSON.parse(inner); } catch { inner = null; } }
    if (Array.isArray(inner)) out.push(...inner);
    else if (item && typeof item === 'object') out.push(item);
  }
  return out;
}

function createApifySource({ token, actor = DEFAULT_ACTOR, inputTemplate = null, fetchImpl = globalThis.fetch, timeoutMs = 180000, baseUrl = 'https://api.apify.com' }) {
  if (!token) return null;
  if (!/^[A-Za-z0-9._-]+[/~][A-Za-z0-9._-]+$/.test(actor)) throw new Error('APIFY_ACTOR must look like owner/actor-name');
  const actorPath = actor.replace('/', '~');
  return {
    name: 'apify',
    describe: `Hosted Ad Library scraper (${actor}): ads in every country, as the public Ad Library shows them.`,
    async search({ query, pageId, country, active, max }) {
      const input = buildInput(inputTemplate, { query: pageId || query, country, max, active });
      const url = `${baseUrl}/v2/acts/${encodeURIComponent(actorPath)}/run-sync-get-dataset-items?timeout=${Math.floor(timeoutMs / 1000) - 10}&format=json&clean=true`;
      const res = await timedFetch(fetchImpl, url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }, timeoutMs, 'The Apify scraper');
      if (res.status === 401 || res.status === 403) throw new SourceError('source_auth', 'the Apify token was refused');
      if (res.status === 402) throw new SourceError('source_payment', 'the Apify account has no credit left');
      if (res.status === 429) throw new SourceError('source_rate_limited', 'Apify asked us to slow down; try again later', { retryable: true });
      if (res.status === 408) throw new SourceError('source_timeout', 'the scraper did not finish in time', { retryable: true });
      if (res.status >= 400) throw new SourceError('source_error', `the Apify scraper answered HTTP ${res.status}`);
      return tidy(flatten(parseJson(res.body, 'The Apify scraper')).map(fromScraper), max);
    },
  };
}

module.exports = { createApifySource, buildInput, flatten, DEFAULT_ACTOR };
