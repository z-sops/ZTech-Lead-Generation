'use strict';

/**
 * Needs detection (P05) and opportunity scoring (P06).
 *
 * A NEED is a business problem backed by at least one finding, attached to
 * the service category that fixes it. Needs are derived only from findings;
 * findings exist only with evidence. Nothing here can create a need out of
 * nothing.
 *
 * The SCORE (0-100) is a weighted sum, and every factor is returned with the
 * score so a person can see exactly why one business ranks above another:
 *
 *   evidence_quality  35%  mean confidence of the needs the customer can serve
 *   offer_fit         30%  how many of the customer's services are needed
 *                          (1 matched service = 0.5, 2 = 0.8, 3 or more = 1)
 *   urgency           20%  the most severe matching need (high 1, medium 0.6, low 0.3)
 *   reachability      15%  how complete the public listing is (phone, website,
 *                          address, opening hours): a business you can reach
 *                          and verify is a better opportunity
 *
 * Penalty: when evidence_quality is below 0.6 the score is multiplied by 0.7,
 * so a ranking is never led by guesses. A business with no need the customer
 * can serve scores 0. Ties are broken by name, then by business id, so the
 * order is the same every time.
 */

const { CHECKS, SEVERITY_WEIGHT } = require('./checks');
const { OFFER_CATEGORIES } = require('./criteria');
const { stableId } = require('./inspector');

const WEIGHTS = Object.freeze({ evidence_quality: 0.35, offer_fit: 0.30, urgency: 0.20, reachability: 0.15 });
const LOW_CONFIDENCE = 0.6;
const LOW_CONFIDENCE_FACTOR = 0.7;
const FIT_STEPS = [0, 0.5, 0.8, 1];

const SEVERITY_ORDER = { high: 3, medium: 2, low: 1 };

/**
 * @param {object[]} findings one business's findings
 * @param {string[]} offerCategories the customer's services
 */
function detectNeeds(findings, offerCategories) {
  const byCategory = new Map();
  for (const f of findings) {
    if (!byCategory.has(f.category)) byCategory.set(f.category, []);
    byCategory.get(f.category).push(f);
  }
  const needs = [];
  for (const [category, list] of byCategory) {
    const sorted = [...list].sort((a, b) => (SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity]) || (b.confidence - a.confidence) || a.check_id.localeCompare(b.check_id));
    const top = sorted[0];
    needs.push({
      need_id: stableId('nd', top.business_id, category),
      business_id: top.business_id,
      category,
      service: OFFER_CATEGORIES[category] || category,
      in_offer: offerCategories.includes(category),
      severity: top.severity,
      confidence: Math.max(...sorted.map((f) => f.confidence)),
      problems: sorted.map((f) => f.problem),
      finding_ids: sorted.map((f) => f.finding_id),
      evidence_ids: [...new Set(sorted.flatMap((f) => f.evidence_ids))],
      caveats: [...new Set(sorted.map((f) => f.caveat).filter(Boolean))],
      basis: 'inferred from observed findings',
    });
  }
  return needs.sort((a, b) => (Number(b.in_offer) - Number(a.in_offer)) || (SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity]) || a.category.localeCompare(b.category));
}

function reachabilityOf(business) {
  const fields = [business.phone, business.website, business.address, business.opening_hours];
  return fields.filter(Boolean).length / fields.length;
}

const round = (n, d = 3) => Math.round(n * 10 ** d) / 10 ** d;

/**
 * @param {object} business
 * @param {object[]} needs detectNeeds() result for the business
 * @returns {{score: number, factors: object, explanation: string[]}}
 */
function scoreOpportunity(business, needs) {
  const matching = needs.filter((n) => n.in_offer);
  const reachability = reachabilityOf(business);
  if (matching.length === 0) {
    return {
      score: 0,
      factors: { evidence_quality: 0, offer_fit: 0, urgency: 0, reachability: round(reachability), penalty: 1 },
      explanation: ['No need was found that matches the services you offer.'],
    };
  }
  const evidenceQuality = matching.reduce((s, n) => s + n.confidence, 0) / matching.length;
  const offerFit = FIT_STEPS[Math.min(matching.length, 3)];
  const urgency = Math.max(...matching.map((n) => SEVERITY_WEIGHT[n.severity] || 0));
  const raw = WEIGHTS.evidence_quality * evidenceQuality + WEIGHTS.offer_fit * offerFit
    + WEIGHTS.urgency * urgency + WEIGHTS.reachability * reachability;
  const penalty = evidenceQuality < LOW_CONFIDENCE ? LOW_CONFIDENCE_FACTOR : 1;
  const score = Math.round(raw * penalty * 100);
  const explanation = [
    `Evidence quality ${Math.round(evidenceQuality * 100)}% (weight ${WEIGHTS.evidence_quality * 100}%)`,
    `Matches ${matching.length} of your services (fit ${Math.round(offerFit * 100)}%, weight ${WEIGHTS.offer_fit * 100}%)`,
    `Most urgent need: ${matching.map((n) => n.severity).sort((a, b) => SEVERITY_ORDER[b] - SEVERITY_ORDER[a])[0]} (weight ${WEIGHTS.urgency * 100}%)`,
    `Listing completeness ${Math.round(reachability * 100)}% (weight ${WEIGHTS.reachability * 100}%)`,
  ];
  if (penalty < 1) explanation.push(`Low-confidence evidence: score multiplied by ${LOW_CONFIDENCE_FACTOR}`);
  return {
    score,
    factors: {
      evidence_quality: round(evidenceQuality),
      offer_fit: round(offerFit),
      urgency: round(urgency),
      reachability: round(reachability),
      penalty,
    },
    explanation,
  };
}

/** Deterministic ranking: score, then name, then id. */
function rankOpportunities(opportunities) {
  const ranked = [...opportunities].sort((a, b) => (b.score - a.score)
    || a.business_name.localeCompare(b.business_name)
    || a.business_id.localeCompare(b.business_id));
  ranked.forEach((o, i) => { o.rank = i + 1; });
  return ranked;
}

module.exports = {
  detectNeeds, scoreOpportunity, rankOpportunities, reachabilityOf, WEIGHTS, LOW_CONFIDENCE, LOW_CONFIDENCE_FACTOR, CHECKS,
};
