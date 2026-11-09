'use strict';

/**
 * Competitor ads, week against week.
 *
 * A check is one snapshot of the ads an advertiser runs (the connector's
 * ads_search result). Comparing two snapshots says what changed: which ads
 * are new, which stopped, which keep running. Nobody outside Meta knows
 * whether an ad brings leads; the best public signal is time - advertisers
 * do not keep paying for ads that fail - so an ad running for at least
 * LONG_RUN_DAYS is flagged "likely working". That flag is a signal with a
 * stated rule, never a claim of results.
 */

const RESULT_SCHEMA = 'ztech.competitor_ads.v1';
const LONG_RUN_DAYS = 21;
const DAY = 86400000;

function runningDays(ad, nowMs) {
  const start = Date.parse(ad.started_at);
  if (!Number.isFinite(start)) return null;
  const end = ad.is_active || !ad.stopped_at ? nowMs : Date.parse(ad.stopped_at);
  return Math.max(0, Math.floor(((Number.isFinite(end) ? end : nowMs) - start) / DAY));
}

function tally(list, key) {
  const out = {};
  for (const ad of list) {
    const values = Array.isArray(ad[key]) ? ad[key] : [ad[key]];
    for (const v of values) {
      const k = v === null || v === undefined || v === '' ? 'unknown' : String(v);
      out[k] = (out[k] || 0) + 1;
    }
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

/**
 * @param {object|null} previous earlier check result (or null for the first)
 * @param {object} current latest check result
 * @param {Date} [now]
 */
function compareChecks(previous, current, now = new Date()) {
  const nowMs = now.getTime();
  const prevIds = new Map((previous ? previous.ads : []).map((a) => [a.ad_id, a]));
  const currIds = new Map(current.ads.map((a) => [a.ad_id, a]));
  const ads = current.ads.map((a) => {
    const days = runningDays(a, nowMs);
    return {
      ...a,
      running_days: days,
      is_new: previous ? !prevIds.has(a.ad_id) : null,
      likely_working: Boolean(a.is_active && days !== null && days >= LONG_RUN_DAYS),
    };
  }).sort((x, y) => (Number(y.is_active) - Number(x.is_active)) || ((y.running_days ?? -1) - (x.running_days ?? -1)) || x.ad_id.localeCompare(y.ad_id));

  const active = ads.filter((a) => a.is_active);
  const stopped = previous
    ? [...prevIds.values()].filter((p) => p.is_active && (!currIds.has(p.ad_id) || !currIds.get(p.ad_id).is_active))
      .map((p) => ({ ad_id: p.ad_id, body: p.body, started_at: p.started_at, stopped_at: (currIds.get(p.ad_id) || {}).stopped_at || null }))
    : [];
  return {
    checked_at: current.fetched_at,
    previous_checked_at: previous ? previous.fetched_at : null,
    first_check: !previous,
    counts: {
      active: active.length,
      total_seen: ads.length,
      new_since_last: previous ? ads.filter((a) => a.is_new).length : null,
      stopped_since_last: previous ? stopped.length : null,
      likely_working: ads.filter((a) => a.likely_working).length,
    },
    longest_running: active[0] && active[0].running_days !== null ? { ad_id: active[0].ad_id, running_days: active[0].running_days, body: active[0].body } : null,
    by_cta: tally(active, 'cta'),
    by_platform: tally(active, 'platforms'),
    by_format: tally(active, 'display_format'),
    stopped,
    ads,
    rule: `"Likely working" = still running after ${LONG_RUN_DAYS} days. Meta does not publish another advertiser's leads or clicks.`,
  };
}

/** Active-ad counts per check, oldest first, for the trend line. */
function history(results) {
  return [...results]
    .sort((a, b) => String(a.fetched_at).localeCompare(String(b.fetched_at)))
    .map((r) => ({ checked_at: r.fetched_at, active: r.ads.filter((a) => a.is_active).length, total: r.ads.length }));
}

/** ISO week label, e.g. 2026-W46, for one-check-per-week keys. */
function isoWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / DAY + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

module.exports = { compareChecks, history, isoWeek, runningDays, RESULT_SCHEMA, LONG_RUN_DAYS };
