'use strict';

/**
 * The connector's core, without the HTTP: which sources are configured, and
 * one validated `searchAds` that picks a source and returns clean ads.
 */

const { createMetaApiSource } = require('./sources/metaApi');
const { createApifySource } = require('./sources/apify');
const { SourceError } = require('./sources/common');

const EU_UK = new Set(['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'GB']);
const MAX_ADS = 500;

class InputError extends Error {
  constructor(message) { super(message); this.name = 'InputError'; this.code = 'invalid_input'; }
}

function sourcesFromEnv(env = process.env, deps = {}) {
  let inputTemplate = null;
  if (env.APIFY_INPUT_JSON) {
    try { inputTemplate = JSON.parse(env.APIFY_INPUT_JSON); } catch { throw new Error('APIFY_INPUT_JSON is not valid JSON'); }
  }
  const list = [
    createMetaApiSource({ accessToken: env.META_ACCESS_TOKEN, version: env.META_GRAPH_VERSION || undefined, fetchImpl: deps.fetchImpl, baseUrl: env.META_GRAPH_BASE_URL || undefined }),
    createApifySource({ token: env.APIFY_TOKEN, actor: env.APIFY_ACTOR || undefined, inputTemplate, fetchImpl: deps.fetchImpl, baseUrl: env.APIFY_BASE_URL || undefined }),
  ].filter(Boolean);
  return new Map(list.map((s) => [s.name, s]));
}

function validate(input) {
  const i = input || {};
  const query = typeof i.query === 'string' ? i.query.replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, 120) : '';
  const pageId = i.page_id === undefined || i.page_id === null || i.page_id === '' ? null : String(i.page_id).trim();
  if (pageId && !/^\d{3,25}$/.test(pageId)) throw new InputError('page_id must be the numeric Facebook page id');
  if (!query && !pageId) throw new InputError('give a page name or keyword (query), or a page_id');
  const country = String(i.country || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) throw new InputError('country must be a two-letter code such as PK, GB or US');
  const active = i.active === 'active' ? 'active' : 'all';
  const max = i.max_ads === undefined ? 100 : Number(i.max_ads);
  if (!Number.isInteger(max) || max < 1 || max > MAX_ADS) throw new InputError(`max_ads must be 1 to ${MAX_ADS}`);
  const source = i.source || 'auto';
  if (!['auto', 'meta_api', 'apify'].includes(source)) throw new InputError('source must be auto, meta_api or apify');
  return { query: query || pageId, pageId, country, active, max, source };
}

/**
 * auto: the official API where it covers ordinary ads (EU/UK), else the
 * scraper; whichever exists if only one is configured.
 */
function pickSource(sources, wanted, country) {
  if (wanted !== 'auto') {
    const s = sources.get(wanted);
    if (!s) throw new SourceError('source_not_configured', `the ${wanted} source is not set up on this connector`);
    return s;
  }
  if (EU_UK.has(country) && sources.get('meta_api')) return sources.get('meta_api');
  if (sources.get('apify')) return sources.get('apify');
  if (sources.get('meta_api')) return sources.get('meta_api');
  throw new SourceError('source_not_configured', 'no ads source is set up (META_ACCESS_TOKEN or APIFY_TOKEN)');
}

async function searchAds(sources, input, now = () => new Date()) {
  const q = validate(input);
  const source = pickSource(sources, q.source, q.country);
  const ads = await source.search(q);
  const notes = [];
  if (source.name === 'meta_api' && !EU_UK.has(q.country)) {
    notes.push('Outside the EU/UK, Meta\'s API returns only political and issue ads; ordinary business ads may be missing.');
  }
  return {
    source: source.name,
    fetched_at: now().toISOString(),
    query: q.query,
    page_id: q.pageId,
    country: q.country,
    active: q.active,
    count: ads.length,
    ads,
    notes,
  };
}

function capabilities(sources) {
  return {
    sources: [...sources.values()].map((s) => ({ name: s.name, describe: s.describe })),
    max_ads: MAX_ADS,
    stores_data: false,
  };
}

module.exports = { sourcesFromEnv, searchAds, capabilities, validate, pickSource, InputError, SourceError, EU_UK };
