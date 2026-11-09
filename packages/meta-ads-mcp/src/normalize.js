'use strict';

/**
 * One clean shape for an ad, whatever the source.
 *
 *   {
 *     ad_id, page_id, page_name, is_active, started_at, stopped_at,
 *     platforms: [], body, title, caption, cta, link_url, display_format,
 *     variants,               // how many near-identical copies Meta groups under it
 *     snapshot_url,           // Meta's own page for the ad
 *     spend, impressions,     // { lower, upper, currency? } or null (political/EU only)
 *     eu_reach,               // number or null (ads delivered in the EU)
 *     source,
 *   }
 *
 * Nothing is invented: a field the source does not give is null. Text is
 * trimmed and bounded so one advertiser cannot flood a result.
 */

const TEXT_MAX = 2000;

function text(v, max = TEXT_MAX) {
  if (v === undefined || v === null) return null;
  if (Array.isArray(v)) v = v.filter((x) => typeof x === 'string' && x.trim())[0];
  if (typeof v !== 'string') return null;
  const s = v.replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}

function iso(v) {
  if (v === undefined || v === null || v === '') return null;
  // Unix seconds (scrapers) or an ISO / "YYYY-MM-DD" string (Meta's API).
  const n = typeof v === 'number' || /^\d{9,13}$/.test(String(v)) ? Number(v) : NaN;
  const d = Number.isFinite(n) ? new Date(n < 1e12 ? n * 1000 : n) : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function range(v) {
  if (!v || typeof v !== 'object') return null;
  const lower = v.lower_bound ?? v.lowerBound ?? v.lower ?? null;
  const upper = v.upper_bound ?? v.upperBound ?? v.upper ?? null;
  if (lower === null && upper === null) return null;
  const out = { lower: lower === null ? null : Number(lower), upper: upper === null ? null : Number(upper) };
  if (v.currency) out.currency = String(v.currency).slice(0, 3);
  return out;
}

function platforms(v) {
  const list = Array.isArray(v) ? v : (typeof v === 'string' ? v.split(',') : []);
  return [...new Set(list.map((p) => String(p).trim().toLowerCase()).filter(Boolean))].sort();
}

function idOf(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return /^[0-9A-Za-z_-]{1,64}$/.test(s) ? s : null;
}

/** An ad from Meta's official Ad Library API (ArchivedAd). */
function fromMetaApi(a) {
  const stop = iso(a.ad_delivery_stop_time);
  return {
    ad_id: idOf(a.id),
    page_id: idOf(a.page_id),
    page_name: text(a.page_name, 200),
    is_active: stop === null,
    started_at: iso(a.ad_delivery_start_time),
    stopped_at: stop,
    platforms: platforms(a.publisher_platforms),
    body: text(a.ad_creative_bodies),
    title: text(a.ad_creative_link_titles, 300),
    caption: text(a.ad_creative_link_captions, 300),
    cta: null, // the official API does not give the button
    link_url: null,
    display_format: null,
    variants: null,
    snapshot_url: typeof a.ad_snapshot_url === 'string' ? a.ad_snapshot_url.replace(/access_token=[^&]+/, 'access_token=REDACTED') : null,
    spend: range(a.spend),
    impressions: range(a.impressions),
    eu_reach: Number.isFinite(Number(a.eu_total_reach)) && a.eu_total_reach !== null ? Number(a.eu_total_reach) : null,
    source: 'meta_api',
  };
}

/**
 * An ad from a hosted Ad Library scraper (Apify actors). Scrapers differ in
 * key names, so the common spellings are all read.
 */
function fromScraper(a) {
  const snap = a.snapshot && typeof a.snapshot === 'object' ? a.snapshot : {};
  const body = a.ad_body ?? a.body ?? (snap.body && (snap.body.text ?? snap.body)) ?? a.adText;
  const isActive = a.is_active ?? a.isActive ?? a.active;
  const stop = iso(a.end_date ?? a.endDate ?? a.stop_date);
  const id = idOf(a.library_id ?? a.ad_archive_id ?? a.adArchiveID ?? a.adArchiveId ?? a.id);
  return {
    ad_id: id,
    page_id: idOf(a.page_id ?? a.pageID ?? a.pageId ?? snap.page_id),
    page_name: text(a.page_name ?? a.pageName ?? snap.page_name, 200),
    is_active: typeof isActive === 'boolean' ? isActive : stop === null,
    started_at: iso(a.start_date ?? a.startDate ?? a.startDateFormatted),
    stopped_at: stop,
    platforms: platforms(a.publisher_platforms ?? a.publisherPlatform ?? a.publisherPlatforms ?? a.platforms),
    body: text(body),
    title: text(a.ad_title ?? a.title ?? snap.title, 300),
    caption: text(a.link_caption ?? a.caption ?? snap.caption, 300),
    cta: text(a.cta_text ?? a.ctaText ?? snap.cta_text, 60),
    link_url: typeof (a.link_url ?? a.linkUrl ?? snap.link_url) === 'string' ? (a.link_url ?? a.linkUrl ?? snap.link_url).slice(0, 1000) : null,
    display_format: text(a.display_format ?? a.displayFormat ?? snap.display_format, 40),
    variants: Number.isInteger(a.collation_count ?? a.collationCount) ? (a.collation_count ?? a.collationCount) : null,
    snapshot_url: id ? `https://www.facebook.com/ads/library/?id=${id}` : null,
    spend: range(a.spend),
    impressions: range(a.impressions),
    eu_reach: Number.isFinite(Number(a.eu_total_reach ?? a.euTotalReach)) && (a.eu_total_reach ?? a.euTotalReach) != null ? Number(a.eu_total_reach ?? a.euTotalReach) : null,
    source: 'apify',
  };
}

/** Drop ads without an id and duplicates; newest first. */
function tidy(ads, max) {
  const seen = new Set();
  const out = [];
  for (const ad of ads) {
    if (!ad || !ad.ad_id || seen.has(ad.ad_id)) continue;
    seen.add(ad.ad_id);
    out.push(ad);
  }
  out.sort((x, y) => String(y.started_at || '').localeCompare(String(x.started_at || '')) || x.ad_id.localeCompare(y.ad_id));
  return out.slice(0, max);
}

module.exports = { fromMetaApi, fromScraper, tidy, iso, text };
