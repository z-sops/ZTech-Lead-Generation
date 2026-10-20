'use strict';

const { stableId } = require('../core/ids');
const { FACT_KEYS } = require('../contracts/constants');
const { sanitizeUntrusted } = require('../agent/sanitize');

/**
 * Research / business signals.
 *
 * Only signals that Zuni-SEO evidence can actually support are implemented. Every
 * signal is derived from a ResearchChange between two measured research runs; nothing
 * is inferred from a single run and nothing comes from outside the evidence.
 */
const SIGNAL_TYPES = Object.freeze({
  WEBSITE_CHANGE: 'website_change',
  TECHNOLOGY_CHANGE: 'technology_change',
  CONTENT_ACTIVITY: 'content_activity',
  DIGITAL_VISIBILITY_CHANGE: 'digital_visibility_change',
});

/** Declared so the UI can explain why they never appear. Not implemented on purpose. */
const UNSUPPORTED_SIGNALS = Object.freeze([
  { type: 'hiring_signal', reason: 'Zuni-SEO does not collect job postings or hiring data.' },
  { type: 'business_expansion', reason: 'No evidence source for new locations or expansion is connected.' },
]);

const CONFIDENCE_BASIS = 'direct_comparison_of_two_measured_research_runs';

function short(v) {
  if (v === null || v === undefined) return 'none';
  return sanitizeUntrusted(String(v), 120).text;
}

function classify(change) {
  if (change.type === 'domain_changed' || change.type === 'redirect_chain_changed') {
    return { type: SIGNAL_TYPES.WEBSITE_CHANGE, description: `Website address behaviour changed (${change.subject}): "${short(change.previousValue)}" -> "${short(change.newValue)}".` };
  }
  if (change.type === 'fact_changed' && change.subject === FACT_KEYS.TECH_PLATFORM) {
    return { type: SIGNAL_TYPES.TECHNOLOGY_CHANGE, description: `Detected website platform changed from "${short(change.previousValue)}" to "${short(change.newValue)}".` };
  }
  if (change.type === 'fact_changed' && change.subject === FACT_KEYS.CRAWL_HTML_PAGES) {
    return { type: SIGNAL_TYPES.CONTENT_ACTIVITY, description: `Crawlable HTML page count changed from ${short(change.previousValue)} to ${short(change.newValue)}.` };
  }
  if (change.area === 'visibility' && ['fact_changed', 'visibility_finding_appeared', 'visibility_finding_resolved'].includes(change.type)) {
    const what = change.type === 'fact_changed' ? `${change.subject} changed from ${short(change.previousValue)} to ${short(change.newValue)}`
      : change.type === 'visibility_finding_appeared' ? `new visibility finding: ${short(change.newValue)}`
        : `visibility finding no longer reported: ${short(change.previousValue)}`;
    return { type: SIGNAL_TYPES.DIGITAL_VISIBILITY_CHANGE, description: `Measured visibility changed: ${what}.` };
  }
  return null;
}

/** @param {object[]} changes ResearchChange[] for one lead */
function deriveSignals(changes) {
  const out = [];
  for (const c of changes) {
    const k = classify(c);
    if (!k) continue;
    out.push({
      signal_id: stableId('sig', c.change_id),
      lead_id: c.lead_id,
      type: k.type,
      status: 'observed',
      observedAt: c.provenance.current_captured_at,
      detectedAt: c.detectedAt,
      source: c.provenance.provider,
      description: k.description,
      change_ids: [c.change_id],
      factIds: [...c.fact_refs.previous, ...c.fact_refs.current],
      findingIds: [...c.finding_refs.previous, ...c.finding_refs.current],
      confidence_basis: CONFIDENCE_BASIS,
      provenance: c.provenance,
    });
  }
  return out;
}

module.exports = { SIGNAL_TYPES, UNSUPPORTED_SIGNALS, deriveSignals, CONFIDENCE_BASIS };
