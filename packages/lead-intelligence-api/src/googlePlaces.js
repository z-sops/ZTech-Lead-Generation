'use strict';

/**
 * Google rating and reviews, ON DEMAND, for one business of a research result.
 *
 * Google's terms allow Places content (rating, reviews) to be SHOWN but not
 * stored or cached, so this is a live lookup each time someone presses the
 * button: nothing it returns is written to the database, and the answer
 * carries the attribution Google requires (the "Google Maps" source, each
 * review's author with a link to their profile, and a link to the place).
 *
 * Off unless GOOGLE_PLACES_API_KEY is set. The key is sent only to
 * places.googleapis.com, in a header, and is never logged or returned.
 *
 * Cost: one Text Search (New) request with rating and reviews in the field
 * mask per press; the server throttles it per workspace.
 */

const ENDPOINT_HOST = 'places.googleapis.com';
const ENDPOINT = `https://${ENDPOINT_HOST}/v1/places:searchText`;
const TIMEOUT_MS = 15000;
const MAX_RESPONSE_BYTES = 524288;
const FIELD_MASK = [
  'places.id', 'places.displayName', 'places.formattedAddress', 'places.rating', 'places.userRatingCount',
  'places.googleMapsUri', 'places.reviews',
].join(',');
const MAX_REVIEWS = 5;

/** A tiny transport over the built-in fetch, fixed to the Places host. */
async function request({ method, url, headers, body, signal }) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || u.hostname !== ENDPOINT_HOST) return { ok: false, error: 'refused_host' };
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const res = await fetch(u, { method, headers, body, signal: combined, redirect: 'error' });
    const text = await res.text();
    return { ok: true, status: res.status, body: text.slice(0, MAX_RESPONSE_BYTES) };
  } catch (err) {
    return { ok: false, error: err && err.name === 'TimeoutError' ? 'timeout' : 'network_error' };
  }
}

/** @returns {{request: Function, apiKey: string}|null} */
function placesConfigFromEnv(env) {
  const apiKey = String(env.GOOGLE_PLACES_API_KEY || '').trim();
  return apiKey ? { request, apiKey } : null;
}

function str(v, max) {
  return typeof v === 'string' ? v.slice(0, max) : null;
}

function httpsUrl(v) {
  return typeof v === 'string' && /^https:\/\//i.test(v) ? v.slice(0, 500) : null;
}

/** Tokens of a name, for the "is it the same business" check. */
function tokens(name) {
  return new Set(String(name || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((t) => t.length > 2));
}

/**
 * @param {{request: Function, apiKey: string, business: object, signal?: AbortSignal}} args
 * @returns {Promise<object>} { status: 'found'|'not_found'|'error', ... }
 */
async function lookupPlace({ request: send, apiKey, business, signal }) {
  const textQuery = [business.name, business.address].filter(Boolean).join(', ').slice(0, 300);
  const body = { textQuery, maxResultCount: 1, languageCode: 'en' };
  if (Number.isFinite(business.lat) && Number.isFinite(business.lon)) {
    body.locationBias = { circle: { center: { latitude: business.lat, longitude: business.lon }, radius: 500 } };
  }
  const res = await send({
    method: 'POST',
    url: ENDPOINT,
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': FIELD_MASK },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) return { status: 'error', note: `Google did not answer (${res.error || 'no response'}).` };
  if (res.status === 403 || res.status === 401) return { status: 'error', note: 'Google refused the API key (check that Places API (New) is enabled for it).' };
  if (res.status === 429) return { status: 'error', note: 'Google asked us to slow down; try again in a minute.' };
  if (res.status >= 400) return { status: 'error', note: `Google answered HTTP ${res.status}.` };
  let data;
  try {
    data = JSON.parse(res.body || '{}');
  } catch {
    return { status: 'error', note: 'Google sent an unreadable answer.' };
  }
  const p = Array.isArray(data.places) ? data.places[0] : null;
  if (!p) return { status: 'not_found', note: 'Google Maps has no listing that matches this business.' };
  const name = str(p.displayName && p.displayName.text, 200);
  // A different business at the top of the results is not shown as this one.
  const a = tokens(business.name);
  const b = tokens(name);
  const shared = [...a].filter((t) => b.has(t)).length;
  if (!shared) return { status: 'not_found', note: `The closest Google Maps listing ("${name}") looks like a different business.` };
  const reviews = (Array.isArray(p.reviews) ? p.reviews : []).slice(0, MAX_REVIEWS).map((r) => ({
    rating: Number.isFinite(r.rating) ? r.rating : null,
    text: str((r.text && r.text.text) || (r.originalText && r.originalText.text), 2000),
    relative_time: str(r.relativePublishTimeDescription, 60),
    published_at: str(r.publishTime, 40),
    author: str(r.authorAttribution && r.authorAttribution.displayName, 120),
    author_url: httpsUrl(r.authorAttribution && r.authorAttribution.uri),
    author_photo: httpsUrl(r.authorAttribution && r.authorAttribution.photoUri),
    google_maps_uri: httpsUrl(r.googleMapsUri),
  }));
  return {
    status: 'found',
    place_id: str(p.id, 300),
    name,
    address: str(p.formattedAddress, 300),
    rating: Number.isFinite(p.rating) ? p.rating : null,
    rating_count: Number.isInteger(p.userRatingCount) ? p.userRatingCount : null,
    google_maps_uri: httpsUrl(p.googleMapsUri),
    reviews,
    attribution: 'Google Maps',
    note: 'Shown live from Google Maps; not stored.',
  };
}

module.exports = { placesConfigFromEnv, lookupPlace, request, ENDPOINT, ENDPOINT_HOST, FIELD_MASK };
