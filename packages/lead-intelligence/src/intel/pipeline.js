'use strict';

/**
 * The Phase 2 research pipeline: discover real businesses, inspect their
 * websites, keep the evidence, detect needs, score and rank.
 *
 *   criteria -> discovery (OSM) -> per business: inspection -> evidence,
 *   findings -> needs -> score -> ranked opportunities
 *
 * One business failing (a timeout, a broken page) never fails the job: it is
 * recorded on that business, and the rest continue. Discovery failing DOES
 * fail the job, with a message that says why, because without businesses
 * there is nothing true to show.
 */

const { validateCriteria } = require('./criteria');
const { INDUSTRIES } = require('./criteria');
const { inspectWebsite, stableId } = require('./inspector');
const { detectNeeds, scoreOpportunity, rankOpportunities, WEIGHTS } = require('./scoring');

const RESULT_SCHEMA = 'ztech.research.v1';

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * @param {{
 *   criteria: object,
 *   discovery: {discover: (criteria: object, signal?: AbortSignal) => Promise<object>},
 *   fetchPage: Function,
 *   now?: () => Date,
 *   signal?: AbortSignal,
 *   concurrency?: number,
 *   isCancelled?: () => Promise<boolean>,
 * }} deps
 */
async function runResearch(deps) {
  const now = deps.now || (() => new Date());
  const criteria = validateCriteria(deps.criteria);
  const startedAt = now().toISOString();
  const industryBooking = INDUSTRIES[criteria.industry].booking;

  const discovered = await deps.discovery.discover(criteria, deps.signal);

  const evidence = [];
  const findings = [];
  const needs = [];
  const opportunities = [];
  let pagesFetched = 0;
  let cancelled = false;

  const businesses = await mapLimit(discovered.businesses, deps.concurrency || 3, async (business) => {
    if (cancelled || (deps.signal && deps.signal.aborted)) {
      return { ...business, inspection: { status: 'skipped', notes: ['The research was stopped before this business was inspected.'], pages_fetched: 0 } };
    }
    if (deps.isCancelled && await deps.isCancelled()) {
      cancelled = true;
      return { ...business, inspection: { status: 'skipped', notes: ['The research was cancelled before this business was inspected.'], pages_fetched: 0 } };
    }
    let inspection;
    try {
      inspection = await inspectWebsite({
        business, industryBooking, fetchPage: deps.fetchPage, now, signal: deps.signal,
      });
    } catch (err) {
      if (err && err.code === 'ABORTED') {
        return { ...business, inspection: { status: 'skipped', notes: ['The research was stopped while this business was being inspected.'], pages_fetched: 0 } };
      }
      inspection = {
        status: 'error', evidence: [], findings: [], pages_fetched: 0,
        notes: [`The inspection failed: ${String((err && err.message) || err).slice(0, 200)}`],
      };
    }
    pagesFetched += inspection.pages_fetched;
    evidence.push(...inspection.evidence);
    findings.push(...inspection.findings);
    const businessNeeds = detectNeeds(inspection.findings, criteria.offer_categories);
    needs.push(...businessNeeds);
    const scored = scoreOpportunity(business, businessNeeds);
    opportunities.push({
      opportunity_id: stableId('op', business.business_id, criteria.offer_categories.join(',')),
      business_id: business.business_id,
      business_name: business.name,
      score: scored.score,
      factors: scored.factors,
      explanation: scored.explanation,
      need_ids: businessNeeds.filter((n) => n.in_offer).map((n) => n.need_id),
      other_need_ids: businessNeeds.filter((n) => !n.in_offer).map((n) => n.need_id),
      evidence_status: inspection.evidence.length ? 'evidenced' : 'no_evidence',
    });
    return {
      ...business,
      inspection: { status: inspection.status, notes: inspection.notes, pages_fetched: inspection.pages_fetched },
    };
  });

  const ranked = rankOpportunities(opportunities);
  const needsByCategory = {};
  for (const n of needs) {
    if (!n.in_offer) continue;
    needsByCategory[n.category] = (needsByCategory[n.category] || 0) + 1;
  }
  const inspectionCounts = {};
  for (const b of businesses) inspectionCounts[b.inspection.status] = (inspectionCounts[b.inspection.status] || 0) + 1;

  return {
    schema: RESULT_SCHEMA,
    synthetic: false,
    status: 'ok',
    criteria,
    place: discovered.place,
    provider: discovered.provider,
    started_at: startedAt,
    finished_at: now().toISOString(),
    cancelled,
    summary: {
      found_in_area: discovered.found,
      businesses: businesses.length,
      with_website: businesses.filter((b) => b.website).length,
      inspections: inspectionCounts,
      pages_fetched: pagesFetched,
      evidence: evidence.length,
      findings: findings.length,
      needs_by_category: needsByCategory,
      opportunities_with_need: ranked.filter((o) => o.score > 0).length,
    },
    scoring: { weights: WEIGHTS, documentation: 'docs/PHASE-2-INTELLIGENCE.md#scoring' },
    businesses,
    evidence,
    findings,
    needs,
    opportunities: ranked,
  };
}

module.exports = { runResearch, RESULT_SCHEMA, mapLimit };
