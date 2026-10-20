'use strict';

const { TIER_RANK } = require('./EnrichmentProvider');
const { FIELD_NAMES } = require('./catalog');

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Deterministic selection of one value per field from all stored observations.
 *
 * Ranking (first difference wins) — no confidence scores are invented:
 *   1. fresh before stale            (collected_at within maxAgeDays)
 *   2. evidence tier                 first_party > third_party > derived
 *   3. configured waterfall order    earlier provider wins
 *   4. most recently collected
 * A weaker observation therefore never replaces a stronger one; the stronger stays
 * selected and the weaker is listed in `alternatives`.
 *
 * Field status:
 *   FOUND      at least one provider returned a valid value
 *   NOT_FOUND  providers answered, none had a value (scoped: "these providers had none",
 *              not "the company has none")
 *   UNKNOWN    no provider has answered for this field
 * `conflict` is true when fresh observations disagree; all distinct values are kept.
 */
function isFresh(obs, now, maxAgeDays) {
  return Date.parse(obs.collected_at) + maxAgeDays * DAY_MS > now.getTime();
}

function rank(obs, { now, maxAgeDays, providerOrder }) {
  const orderIdx = providerOrder.indexOf(obs.provider_id);
  return [
    isFresh(obs, now, maxAgeDays) ? 0 : 1,
    TIER_RANK[obs.tier] ?? 9,
    orderIdx === -1 ? 999 : orderIdx,
    -Date.parse(obs.collected_at),
  ];
}

function cmp(a, b) {
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

function publicObservation(o, fresh) {
  return {
    observation_id: o.observation_id,
    value: o.value,
    provider_id: o.provider_id,
    tier: o.tier,
    source_ref: o.source_ref,
    provider_confidence: o.provider_confidence || null,
    collected_at: o.collected_at,
    provenance_id: o.provenance_id,
    fresh,
  };
}

/**
 * @param {object[]} observations all observations for ONE lead
 * @returns {Record<string, {field, status, conflict, stale, selected, alternatives, not_found_by}>}
 */
function selectFields(observations, { now = new Date(), maxAgeDays = 90, providerOrder = [], fields = FIELD_NAMES } = {}) {
  const out = {};
  for (const field of fields) {
    const obs = observations.filter((o) => o.field === field);
    const found = obs.filter((o) => o.status === 'FOUND');
    const notFound = obs.filter((o) => o.status === 'NOT_FOUND');
    if (!found.length) {
      out[field] = {
        field,
        status: notFound.length ? 'NOT_FOUND' : 'UNKNOWN',
        conflict: false,
        stale: false,
        selected: null,
        alternatives: [],
        not_found_by: [...new Set(notFound.map((o) => o.provider_id))],
      };
      continue;
    }
    const opts = { now, maxAgeDays, providerOrder };
    const sorted = [...found].sort((a, b) => cmp(rank(a, opts), rank(b, opts)));
    const best = sorted[0];
    const bestFresh = isFresh(best, now, maxAgeDays);
    const freshValues = new Set(found.filter((o) => isFresh(o, now, maxAgeDays)).map((o) => JSON.stringify(o.value)));
    out[field] = {
      field,
      status: 'FOUND',
      conflict: freshValues.size > 1,
      stale: !bestFresh,
      selected: publicObservation(best, bestFresh),
      alternatives: sorted.slice(1).map((o) => publicObservation(o, isFresh(o, now, maxAgeDays))),
      not_found_by: [...new Set(notFound.map((o) => o.provider_id))],
    };
  }
  return out;
}

module.exports = { selectFields, isFresh };
