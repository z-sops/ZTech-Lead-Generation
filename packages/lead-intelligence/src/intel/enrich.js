'use strict';

/**
 * Enrichment from official sources, after a website was inspected:
 *
 *   - OWNERS (UK): Companies House, the public register of companies. The
 *     business is matched by name AND postcode; its active directors are
 *     listed with the company link. A match is never assumed: every owner
 *     list says how it was matched, and a weak match is not used.
 *   - INSTAGRAM: Meta's Instagram Business Discovery API, for the handle the
 *     business itself links to: followers, posts, date of the last post. An
 *     account with no post for INSTAGRAM_STALE_DAYS becomes a finding.
 *
 * The transport is injected: request({method, url, headers, body, signal}) ->
 * {ok, status, body, error}. Keys travel in headers only.
 */

const INSTAGRAM_STALE_DAYS = 90;
const CH_BASE = 'https://api.company-information.service.gov.uk';
const CH_WEB = 'https://find-and-update.company-information.service.gov.uk/company';
const UK_POSTCODE = /^([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})$/i;
const NAME_NOISE = /\b(ltd|limited|llp|plc|lp|the|and|co|company|uk|group|services|t\/a)\b/g;

function normPostcode(p) {
  const m = UK_POSTCODE.exec(String(p || '').trim());
  return m ? { full: `${m[1]} ${m[2]}`.toUpperCase(), outward: m[1].toUpperCase() } : null;
}

function nameTokens(name) {
  return new Set(String(name || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ').replace(NAME_NOISE, ' ')
    .split(/\s+/).filter((t) => t.length > 1));
}

function nameScore(a, b) {
  const x = nameTokens(a);
  const y = nameTokens(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const t of x) if (y.has(t)) both += 1;
  return both / new Set([...x, ...y]).size;
}

function json(res) {
  try {
    return JSON.parse(res.body || '');
  } catch {
    return null;
  }
}

/**
 * @returns {Promise<{status: string, company?: object, owners?: object[], match?: object, note?: string}>}
 */
async function companiesHouseOwners({ request, apiKey, business, signal, baseUrl = CH_BASE }) {
  const pc = normPostcode(business.postcode);
  if (!pc) return { status: 'not_checked', note: 'No UK postcode in the listing, so the company register was not searched.' };
  const auth = { Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`, Accept: 'application/json' };
  const search = await request({ method: 'GET', url: `${baseUrl}/search/companies?${new URLSearchParams({ q: business.name, items_per_page: '20' })}`, headers: auth, signal });
  if (!search.ok) return { status: 'error', note: `Companies House did not answer (${search.error || 'no response'}).` };
  if (search.status === 401) return { status: 'error', note: 'The Companies House API key was refused.' };
  if (search.status === 429) return { status: 'error', note: 'Companies House asked us to slow down.' };
  if (search.status >= 400) return { status: 'error', note: `Companies House answered HTTP ${search.status}.` };
  const items = (json(search) || {}).items || [];
  let best = null;
  for (const it of items) {
    if (it.company_status && it.company_status !== 'active') continue;
    const itPc = normPostcode(it.address && it.address.postal_code);
    const score = nameScore(business.name, it.title);
    const postcode = itPc && itPc.full === pc.full ? 'same' : itPc && itPc.outward === pc.outward ? 'same_area' : 'different';
    // Same postcode + some name overlap, or same area + a close name.
    const ok = (postcode === 'same' && score >= 0.34) || (postcode === 'same_area' && score >= 0.6);
    if (!ok) continue;
    const rank = (postcode === 'same' ? 1 : 0) + score;
    if (!best || rank > best.rank) best = { it, score, postcode, rank };
  }
  if (!best) return { status: 'no_match', note: 'No active company with this name at this postcode (it may be a sole trader or partnership, which are not on the register).' };
  const number = String(best.it.company_number);
  if (!/^[A-Z0-9]{8}$/i.test(number)) return { status: 'no_match', note: 'The register returned an unusable company number.' };
  const off = await request({ method: 'GET', url: `${baseUrl}/company/${number}/officers?items_per_page=35`, headers: auth, signal });
  const officers = off.ok && off.status < 400 ? ((json(off) || {}).items || []) : [];
  const owners = officers
    .filter((o) => !o.resigned_on && /director|member|partner/i.test(o.officer_role || ''))
    .slice(0, 5)
    .map((o) => ({ name: String(o.name || '').slice(0, 120), role: String(o.officer_role || '').replace(/-/g, ' '), appointed_on: o.appointed_on || null }));
  return {
    status: 'matched',
    company: { name: String(best.it.title || '').slice(0, 200), number, url: `${CH_WEB}/${number}`, address: String(best.it.address_snippet || '').slice(0, 300) },
    owners,
    match: { name_score: Math.round(best.score * 100) / 100, postcode: best.postcode },
    retrieved_at: new Date().toISOString(),
  };
}

/**
 * @returns {Promise<{status: string, handle: string, followers?: number, posts?: number, last_post_at?: string|null, stale?: boolean, note?: string}>}
 */
async function instagramActivity({ request, token, igUserId, handle, version = 'v26.0', now = () => new Date(), signal, baseUrl = 'https://graph.facebook.com' }) {
  if (!/^[A-Za-z0-9._]{1,30}$/.test(handle)) return { status: 'error', handle, note: 'Not an Instagram username.' };
  const fields = `business_discovery.username(${handle}){username,followers_count,media_count,media.limit(1){timestamp}}`;
  const res = await request({
    method: 'GET',
    url: `${baseUrl}/${version}/${encodeURIComponent(igUserId)}?${new URLSearchParams({ fields })}`,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal,
  });
  if (!res.ok) return { status: 'error', handle, note: `Instagram did not answer (${res.error || 'no response'}).` };
  const data = json(res) || {};
  if (data.error) {
    // A personal account, or a handle that does not exist, cannot be read.
    const personal = /business|not found|cannot find|does not exist/i.test(String(data.error.message || ''));
    return { status: personal ? 'not_business_account' : 'error', handle, note: personal ? 'Not a public business/creator account, so Instagram does not share its numbers.' : 'Instagram refused the request.' };
  }
  const bd = data.business_discovery || {};
  const last = bd.media && Array.isArray(bd.media.data) && bd.media.data[0] ? bd.media.data[0].timestamp : null;
  const lastMs = last ? Date.parse(last) : NaN;
  const days = Number.isFinite(lastMs) ? Math.floor((now().getTime() - lastMs) / 86400000) : null;
  return {
    status: 'ok',
    handle,
    followers: Number.isInteger(bd.followers_count) ? bd.followers_count : null,
    posts: Number.isInteger(bd.media_count) ? bd.media_count : null,
    last_post_at: Number.isFinite(lastMs) ? new Date(lastMs).toISOString() : null,
    days_since_last_post: days,
    stale: days === null ? (bd.media_count === 0) : days >= INSTAGRAM_STALE_DAYS,
    retrieved_at: now().toISOString(),
  };
}

module.exports = { companiesHouseOwners, instagramActivity, nameScore, normPostcode, INSTAGRAM_STALE_DAYS };
