'use strict';

/**
 * Real business discovery from OpenStreetMap.
 *
 * Why OpenStreetMap: it is free, its data may be stored and reused under the
 * ODbL with attribution, and every business has a stable public URL that
 * proves where the record came from. (Google Places was considered and not
 * used: its terms forbid storing the results, which a research history must
 * do, and it is charged per request. See docs/PHASE-2-INTELLIGENCE.md.)
 *
 * Two public services are used, each politely and at most once per job:
 *   - Nominatim, to turn the location the customer typed into an area;
 *   - Overpass, to list the businesses with the industry's tags in that area.
 * No business is ever invented: a business in the result is a real OSM
 * object, with its URL, and the time it was retrieved.
 *
 * The transport is injected:
 *   request({ method, url, headers, body, signal }) ->
 *     Promise<{ ok: boolean, status?: number, body?: string, error?: string }>
 */

const crypto = require('node:crypto');
const { INDUSTRIES } = require('./criteria');
const { normalizeDomain } = require('../core/urls');

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const ATTRIBUTION = '© OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright)';
/** Overpass returns at most this many objects; we select from them. */
const OVERPASS_CAP = 200;

class DiscoveryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DiscoveryError';
    this.code = code;
  }
}

function parseJson(res, what) {
  if (!res.ok) throw new DiscoveryError('provider_unreachable', `${what} did not respond (${res.error || 'no response'})`);
  if (res.status === 429) throw new DiscoveryError('provider_rate_limited', `${what} asked us to slow down (HTTP 429); try again in a few minutes`);
  if (res.status < 200 || res.status >= 300) throw new DiscoveryError('provider_error', `${what} answered HTTP ${res.status}`);
  try {
    return JSON.parse(res.body || '');
  } catch {
    throw new DiscoveryError('provider_bad_response', `${what} sent a response that is not JSON`);
  }
}

/** The Overpass area id for an OSM relation or way (the documented offsets). */
function areaIdFor(place) {
  const id = Number(place.osm_id);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  if (place.osm_type === 'relation') return 3600000000 + id;
  if (place.osm_type === 'way') return 2400000000 + id;
  return null;
}

function overpassQuery(industry, place) {
  const tags = INDUSTRIES[industry].osm;
  const areaId = areaIdFor(place);
  let scope;
  let prelude = '';
  if (areaId) {
    prelude = `area(id:${areaId})->.a;`;
    scope = '(area.a)';
  } else {
    // A point (a node): a bounding box from the geocoder instead.
    const bb = (place.boundingbox || []).map(Number);
    if (bb.length !== 4 || bb.some((n) => !Number.isFinite(n))) {
      throw new DiscoveryError('location_unusable', 'the location could not be turned into an area to search');
    }
    scope = `(${bb[0]},${bb[2]},${bb[1]},${bb[3]})`;
  }
  const selectors = tags.map(([k, v]) => `nwr["${k}"="${v}"]["name"]${scope};`).join('');
  return `[out:json][timeout:25];${prelude}(${selectors});out center tags ${OVERPASS_CAP};`;
}

function firstTag(tags, keys) {
  for (const k of keys) {
    if (typeof tags[k] === 'string' && tags[k].trim()) return tags[k].trim();
  }
  return null;
}

function addressOf(tags) {
  const parts = [
    [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' '),
    tags['addr:city'] || tags['addr:town'] || tags['addr:village'],
    tags['addr:postcode'],
  ].filter((p) => p && String(p).trim());
  return parts.length ? parts.join(', ') : null;
}

/** One OSM element -> one business record (or null when it cannot be one). */
function toBusiness(el, retrievedAt, industry) {
  const tags = el.tags || {};
  const name = typeof tags.name === 'string' ? tags.name.trim() : '';
  if (!name) return null;
  if (!['node', 'way', 'relation'].includes(el.type) || !Number.isSafeInteger(el.id)) return null;
  const sourceUrl = `https://www.openstreetmap.org/${el.type}/${el.id}`;
  const website = firstTag(tags, ['website', 'contact:website', 'url']);
  return {
    business_id: `osm_${el.type}_${el.id}`,
    name: name.slice(0, 200),
    industry,
    address: addressOf(tags),
    phone: firstTag(tags, ['phone', 'contact:phone']),
    website,
    opening_hours: firstTag(tags, ['opening_hours']),
    lat: typeof el.lat === 'number' ? el.lat : el.center && el.center.lat,
    lon: typeof el.lon === 'number' ? el.lon : el.center && el.center.lon,
    source: 'openstreetmap',
    source_url: sourceUrl,
    attribution: ATTRIBUTION,
    retrieved_at: retrievedAt,
  };
}

/** Deduplicate by website host, then by name + postcode-ish address. */
function dedupe(businesses) {
  const seen = new Map();
  const out = [];
  for (const b of businesses) {
    let key;
    const d = b.website ? normalizeDomain(b.website) : null;
    if (d && d.ok) key = `web:${d.key}`;
    else key = `name:${b.name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}|${(b.address || '').toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.set(key, true);
    out.push(b);
  }
  return out;
}

/**
 * The businesses to research, chosen deterministically: the same OSM data
 * and the same criteria give the same list.
 */
function selectBusinesses(businesses, criteria) {
  let list = businesses;
  if (criteria.website_filter === 'with_website') list = list.filter((b) => b.website);
  if (criteria.website_filter === 'without_website') list = list.filter((b) => !b.website);
  const ordered = [...list].sort((a, b) => {
    const ha = crypto.createHash('sha256').update(a.business_id).digest('hex');
    const hb = crypto.createHash('sha256').update(b.business_id).digest('hex');
    return ha < hb ? -1 : ha > hb ? 1 : 0;
  });
  return ordered.slice(0, criteria.max_results);
}

class OsmDiscovery {
  /**
   * @param {{request: Function, userAgent: string, now?: () => Date,
   *          nominatimUrl?: string, overpassUrl?: string}} deps
   */
  constructor(deps) {
    if (typeof deps.request !== 'function') throw new Error('OsmDiscovery needs a request transport');
    if (!deps.userAgent) throw new Error('OsmDiscovery needs an identifying User-Agent (the Nominatim usage policy requires one)');
    this.request = deps.request;
    this.userAgent = deps.userAgent;
    this.now = deps.now || (() => new Date());
    this.nominatimUrl = deps.nominatimUrl || NOMINATIM_URL;
    this.overpassUrl = deps.overpassUrl || OVERPASS_URL;
  }

  async geocode(location, signal) {
    const url = `${this.nominatimUrl}?${new URLSearchParams({ q: location, format: 'jsonv2', limit: '1' })}`;
    const res = await this.request({ method: 'GET', url, headers: { 'User-Agent': this.userAgent, Accept: 'application/json' }, signal });
    const rows = parseJson(res, 'The location service (Nominatim)');
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new DiscoveryError('location_not_found', `no place called "${location}" was found; add the country, e.g. "Leeds, UK"`);
    }
    const place = rows[0];
    return {
      osm_type: place.osm_type,
      osm_id: place.osm_id,
      display_name: String(place.display_name || location).slice(0, 300),
      boundingbox: place.boundingbox,
      source_url: place.osm_type && place.osm_id ? `https://www.openstreetmap.org/${place.osm_type}/${place.osm_id}` : null,
    };
  }

  /**
   * @param {object} criteria validated criteria
   * @param {AbortSignal} [signal]
   * @returns {Promise<{place: object, businesses: object[], found: number, provider: object}>}
   */
  async discover(criteria, signal) {
    const place = await this.geocode(criteria.location, signal);
    const query = overpassQuery(criteria.industry, place);
    const res = await this.request({
      method: 'POST',
      url: this.overpassUrl,
      headers: { 'User-Agent': this.userAgent, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: `data=${encodeURIComponent(query)}`,
      signal,
    });
    const data = parseJson(res, 'The map data service (Overpass)');
    const retrievedAt = this.now().toISOString();
    const elements = Array.isArray(data.elements) ? data.elements : [];
    const all = dedupe(elements.map((el) => toBusiness(el, retrievedAt, criteria.industry)).filter(Boolean));
    return {
      place,
      businesses: selectBusinesses(all, criteria),
      found: all.length,
      provider: { name: 'openstreetmap', attribution: ATTRIBUTION, requests: 2, chargeable: false },
    };
  }
}

module.exports = {
  OsmDiscovery, DiscoveryError, overpassQuery, toBusiness, dedupe, selectBusinesses, areaIdFor, ATTRIBUTION,
};
