'use strict';

/**
 * I5 - report-level freshness for Opportunity Intelligence (decision E1).
 *
 * ONE global policy, named here and nowhere else. Freshness is DERIVED on every read
 * from the report's `generated_at`; it is never stored, never typed by a user, and the
 * renderer only ever receives the derived result.
 *
 *   fresh    age <  FRESH_MAX_DAYS
 *   stale    FRESH_MAX_DAYS <= age <= EXPIRED_AFTER_DAYS
 *   expired  age >  EXPIRED_AFTER_DAYS
 *   unknown  no / unparseable time, or a time more than FUTURE_SKEW_MS ahead of now
 *
 * The thresholds match OI's own evidence policy (STALE_AFTER 7d / EXPIRED_AFTER 30d), so
 * the report chip and the evidence lines inside it never disagree.
 *
 * WHAT FRESHNESS NEVER DOES: block, hide or delete a report; change readiness, the gate,
 * send capability or pitch content; or start a run. It is display and a recommendation.
 */

const OI_FRESHNESS_POLICY = Object.freeze({
  FRESH_MAX_DAYS: 7,
  EXPIRED_AFTER_DAYS: 30,
  FUTURE_SKEW_MS: 5 * 60 * 1000,
});

const OI_REPORT_FRESHNESS_STATES = Object.freeze(['fresh', 'stale', 'expired', 'unknown']);

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @param {string|null|undefined} generatedAt  ISO time OI minted for the report
 * @param {Date} now
 * @returns {{state:string, ageDays:number|null, generatedAt:string|null, refreshRecommended:boolean}}
 */
function classifyOiFreshness(generatedAt, now = new Date(), policy = OI_FRESHNESS_POLICY) {
  const at = typeof generatedAt === 'string' && generatedAt.trim() ? generatedAt.trim() : null;
  const t = at ? Date.parse(at) : NaN;
  const n = now instanceof Date ? now.getTime() : Number(now);
  if (!at || !Number.isFinite(t) || !Number.isFinite(n) || t - n > policy.FUTURE_SKEW_MS) {
    return Object.freeze({ state: 'unknown', ageDays: null, generatedAt: at, refreshRecommended: true });
  }
  const ageMs = Math.max(0, n - t);
  const ageDays = Math.floor(ageMs / DAY_MS);
  let state;
  if (ageMs < policy.FRESH_MAX_DAYS * DAY_MS) state = 'fresh';
  else if (ageMs <= policy.EXPIRED_AFTER_DAYS * DAY_MS) state = 'stale';
  else state = 'expired';
  return Object.freeze({ state, ageDays, generatedAt: at, refreshRecommended: state !== 'fresh' });
}

module.exports = { OI_FRESHNESS_POLICY, OI_REPORT_FRESHNESS_STATES, classifyOiFreshness };
