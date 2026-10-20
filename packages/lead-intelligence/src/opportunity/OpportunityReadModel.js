'use strict';

const {
  OI_REPORT_CONTRACT_VERSION, OI_CLAIM_KINDS, OI_PROVIDER_STATUSES,
  OI_RESEARCH_STATUSES, OI_FRESHNESS_STATES,
  flattenProviderStatus, summariseProviders,
} = require('./oiContract');

/**
 * The ZTech-owned read model for Opportunity Intelligence.
 *
 * WHY THIS EXISTS INSTEAD OF REUSING EvidencePacket
 * -------------------------------------------------
 * The Zuni-SEO EvidencePacket has exactly one area vocabulary
 * (identity/technical/content/visibility/crawl/other) and one basis vocabulary
 * (standard/research/heuristic/unknown). Opportunity Intelligence reports
 * competitors, ad-channel intelligence, social-channel intelligence,
 * comparisons, changes, opportunities, sales angles and a research timeline -
 * none of which fit that contract without being thrown away. Forcing OI into
 * EvidencePacket would silently discard OI-specific semantics, so ZTech keeps
 * its own read model and the two meet only at the narrow Pitch Evidence Bridge.
 *
 * WHAT IS PRESERVED, NOT TRANSLATED
 * ---------------------------------
 * ClaimKind stays one of `fact` / `estimate` / `inference` on every claim that
 * carries one. It is never folded into a boolean, a number or a coarser label,
 * and a claim that arrives without one is reported as `claim_kind: null` rather
 * than being defaulted to `fact`. Defaulting would be an upgrade.
 *
 * Provider status stays one of the six OI statuses per provider. The report is
 * summarised with `usable` / `degraded`, and a report that degraded because a
 * provider was unavailable still returns `usable: true` for the providers that
 * worked - there is no code path here that turns "some providers unavailable"
 * into "research failed".
 *
 * Identity is preserved, not recomputed: research_id, snapshot_id and the
 * prospect entity_key are carried straight through from OI.
 */

const MAX_ITEMS = Object.freeze({
  competitors: 50,
  opportunities: 200,
  salesAngles: 200,
  timeline: 500,
  evidence: 400,
  comparisons: 300,
  changes: 300,
  signals: 300,
  observations: 300,
  conflicts: 100,
  limitations: 100,
});

function clip(list, n) { return Array.isArray(list) ? list.slice(0, n) : []; }

/** OI EstimateRange, bounded. `null` when OI attached none - never synthesised. */
function estimateOf(est) {
  if (!est || typeof est !== 'object') return null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    low: num(est.low),
    high: num(est.high),
    unit: est.unit == null ? null : String(est.unit).slice(0, 50),
    method: est.method == null ? null : String(est.method).slice(0, 200),
    source: est.source == null ? null : String(est.source).slice(0, 200),
  };
}
function text(v, max = 1000) { return v == null ? null : String(v).slice(0, max); }

/** How a claim should be presented. `null` means OI asserted no claim kind. */
function claimKindOf(source) {
  const k = source && source.claim_kind != null ? String(source.claim_kind) : null;
  return k && OI_CLAIM_KINDS.includes(k) ? k : null;
}

/**
 * Group channels the way the UI shows them (Ads / Content & Social), keeping each
 * provider's own status string next to it.
 */
function channelBuckets(report) {
  const pick = (src) => Object.entries(src && typeof src === 'object' ? src : {})
    .map(([entityKey, channels]) => ({
      entity_key: entityKey,
      channels: (Array.isArray(channels) ? channels : []).map((c) => ({
        provider: text(c && c.provider, 100),
        status: c && typeof c.status === 'string' ? c.status : null,
        metrics: (c && c.metrics) || {},
        observation_refs: clip(c && c.observation_refs, MAX_ITEMS.observations),
        limitations: clip(c && c.limitations, 20).map((l) => text(l, 500)),
      })),
    }));
  return {
    advertising: pick(report.advertising_intelligence),
    content: pick(report.content_intelligence),
    social: pick(report.social_intelligence),
  };
}

/**
 * Build the read model.
 *
 * @param {object} input
 * @param {object} input.report     a report that already passed validateIntelligenceReport
 * @param {string|number|null} input.leadId  ZTech's authoritative lead id, if known
 * @returns {object} the read model
 */
function buildOpportunityReadModel({ report, leadId = null, association = null }) {
  if (!report || typeof report !== 'object') throw new TypeError('buildOpportunityReadModel requires a report');

  const prospects = [];

  // Prospect: OI's own entity, preserved. company_name is display only.
  const p = report.prospect || {};
  prospects.push({
    entity_id: p.entity_id,
    entity_key: p.entity_key,
    kind: 'prospect',
    company_name: text(p.company_name, 300),
    domain: text(p.domain, 253),
    location: text(p.location, 300),
    industry: text(p.industry, 200),
    profile: p.profile || null,
  });

  // Competitors: identity preserved exactly as OI resolved it, including
  // entity_key, relationship_type and the evidence that established it. ZTech
  // never re-ranks them and never merges them by name.
  const competitors = clip(report.competitors, MAX_ITEMS.competitors).map((c) => ({
    entity_id: c.entity_id,
    entity_key: c.entity_key,
    kind: 'competitor',
    company_name: text(c.company_name, 300),
    domain: text(c.domain, 253),
    location: text(c.location, 300),
    industry: text(c.industry, 200),
    relationship_type: text(c.relationship_type, 100),
    relationship_confidence: typeof c.relationship_confidence === 'number' ? c.relationship_confidence : null,
    reason: text(c.reason, 1000),
    discovered_via: text(c.discovered_via, 50),
    evidence_refs: clip(c.evidence_refs, MAX_ITEMS.evidence),
    profile: c.profile || null,
  }));

  const evidence = clip(report.evidence, MAX_ITEMS.evidence).map((e) => ({
    evidence_id: e.evidence_id,
    entity_id: e.entity_id,
    provider: text(e.provider, 100),
    claim: text(e.claim, 1000),
    claim_kind: claimKindOf(e),
    metric: text(e.metric, 200),
    value: e.value === undefined ? null : e.value,
    // An ESTIMATE without its range is just a number; keep the range OI attached.
    estimate: estimateOf(e.estimate),
    freshness: e.freshness ? String(e.freshness) : null,
    source_type: text(e.source_type, 100),
    source_url: text(e.source_url, 2048),
    observed_at: e.observed_at || null,
    captured_at: e.captured_at || null,
    confidence: typeof e.confidence === 'number' ? e.confidence : null,
    conflicts_with: clip(e.conflicts_with, MAX_ITEMS.evidence),
  }));

  const observations = clip(report.observations, MAX_ITEMS.observations).map((o) => ({
    observation_id: o.observation_id,
    entity_id: o.entity_id,
    provider: text(o.provider, 100),
    type: text(o.type, 100),
    claim_kind: claimKindOf(o),
    captured_at: o.captured_at || null,
    metrics: (o && o.metrics) || {},
    items: Array.isArray(o && o.items) ? o.items.slice(0, 50) : [],
    evidence_refs: clip(o && o.evidence_refs, MAX_ITEMS.evidence),
  }));

  const signals = clip(report.signals, MAX_ITEMS.signals).map((s) => ({
    signal_id: s.signal_id,
    type: text(s.type, 100),
    subject_id: text(s.subject_id, 128),
    summary: text(s.summary, 1000),
    strength: typeof s.strength === 'number' ? s.strength : null,
    confidence: typeof s.confidence === 'number' ? s.confidence : null,
    claim_kind: claimKindOf(s),
    observed_at: s.observed_at || null,
    evidence_refs: clip(s.evidence_refs, MAX_ITEMS.evidence),
    comparison_refs: clip(s.comparison_refs, MAX_ITEMS.comparisons),
    change_refs: clip(s.change_refs, MAX_ITEMS.changes),
  }));

  const comparisons = clip(report.comparisons, MAX_ITEMS.comparisons).map((c) => ({
    comparison_id: c.comparison_id,
    dimension: text(c.dimension, 100),
    prospect_id: text(c.prospect_id, 128),
    competitor_id: text(c.competitor_id, 128),
    competitor_entity_key: competitorKeyById(competitors, c.competitor_id),
    prospect_observed: c.prospect_observed === undefined ? null : c.prospect_observed,
    competitor_observed: c.competitor_observed === undefined ? null : c.competitor_observed,
    unit: text(c.unit, 50),
    topic: text(c.topic, 200),
    window: text(c.window, 50),
    interpretation: text(c.interpretation, 100),
    confidence: typeof c.confidence === 'number' ? c.confidence : null,
    note: text(c.note, 1000),
    evidence_refs: clip(c.evidence_refs, MAX_ITEMS.evidence),
  }));

  const changes = clip(report.changes, MAX_ITEMS.changes).map((c) => ({
    change_id: c.change_id,
    type: text(c.type, 100),
    channel: text(c.channel, 100),
    entity_id: text(c.entity_id, 128),
    entity_name: text(c.entity_name, 300),
    previous_snapshot_id: text(c.previous_snapshot_id, 128),
    current_snapshot_id: text(c.current_snapshot_id, 128),
    before: c.before === undefined ? null : c.before,
    after: c.after === undefined ? null : c.after,
    detail: text(c.detail, 1000),
    claim_kind: claimKindOf(c),
    confidence: typeof c.confidence === 'number' ? c.confidence : null,
    evidence_refs: clip(c.evidence_refs, MAX_ITEMS.evidence),
  }));

  // Opportunities. OI types these as `claim_kind: inference` and this model keeps
  // that. `what_was_observed` and `why_it_matters` are both carried so the UI can
  // show the reasoning next to the conclusion rather than only the conclusion.
  const opportunities = clip(report.opportunities, MAX_ITEMS.opportunities).map((o) => ({
    opportunity_id: o.opportunity_id,
    type: text(o.type, 100),
    title: text(o.title, 300),
    severity: text(o.severity, 20),
    confidence: typeof o.confidence === 'number' ? o.confidence : null,
    claim_kind: claimKindOf(o),
    what_was_observed: text(o.what_was_observed, 2000),
    why_it_matters: text(o.why_it_matters, 2000),
    reasoning_summary: text(o.reasoning_summary, 2000),
    prospect_state: text(o.prospect_state, 1000),
    who: clip(o.who, 50).map((w) => text(w, 300)),
    evidence_refs: clip(o.evidence_refs, MAX_ITEMS.evidence),
    signal_refs: clip(o.signal_refs, MAX_ITEMS.signals),
    comparison_refs: clip(o.comparison_refs, MAX_ITEMS.comparisons),
    change_refs: clip(o.change_refs, MAX_ITEMS.changes),
    limitations: clip(o.limitations, 20).map((l) => text(l, 500)),
  }));

  const score = report.opportunity_score || {};
  const opportunityScore = {
    score: Number.isInteger(score.score) ? score.score : null,
    previous_score: Number.isInteger(score.previous_score) ? score.previous_score : null,
    model_version: text(score.model_version, 50),
    explanation: clip(score.explanation, 100).map((e) => text(e, 1000)),
    components: (Array.isArray(score.components) ? score.components : []).slice(0, 40).map((c) => ({
      key: text(c.key, 100),
      value: c.value === undefined ? null : c.value,
      weight: typeof c.weight === 'number' ? c.weight : null,
      effective_weight: typeof c.effective_weight === 'number' ? c.effective_weight : null,
      computed: Boolean(c.computed),
      rationale: text(c.rationale, 1000),
    })),
  };

  const salesAngles = clip(report.sales_angles, MAX_ITEMS.salesAngles).map((a) => ({
    angle_id: a.angle_id,
    angle: text(a.angle, 300),
    summary: text(a.summary, 1000),
    confidence: typeof a.confidence === 'number' ? a.confidence : null,
    evidence_refs: clip(a.evidence_refs, MAX_ITEMS.evidence),
    opportunity_refs: clip(a.opportunity_refs, MAX_ITEMS.opportunities),
    limitations: clip(a.limitations, 20).map((l) => text(l, 500)),
    do_not_claim: clip(a.do_not_claim, 50).map((d) => text(d, 500)),
  }));

  const timeline = clip(report.timeline, MAX_ITEMS.timeline).map((e) => ({
    event_id: e.event_id,
    event_type: text(e.event_type, 100),
    entity_id: text(e.entity_id, 128),
    occurred_at: e.occurred_at || null,
    title: text(e.title, 300),
    summary: text(e.summary, 1000),
    claim_kind: claimKindOf(e),
    research_id: text(e.research_id, 128),
    evidence_refs: clip(e.evidence_refs, MAX_ITEMS.evidence),
  }));

  const conflicts = clip(report.conflicts, MAX_ITEMS.conflicts).map((c) => ({
    entity_id: text(c.entity_id, 128),
    metric: text(c.metric, 200),
    evidence_refs: clip(c.evidence_refs, MAX_ITEMS.evidence),
    values: Array.isArray(c.values) ? c.values.slice(0, 20) : [],
    resolution: text(c.resolution, 1000),
  }));

  const limitations = clip(report.limitations, MAX_ITEMS.limitations).map((l) => text(l, 1000));

  const providerStatus = flattenProviderStatus(report);
  const providers = summariseProviders(report);

  // `research_failed` is true only when OI itself says the report failed. A
  // degraded provider set produces usable > 0 and research_failed false.
  const researchFailed = report.status === 'failed';

  return {
    contract_version: OI_REPORT_CONTRACT_VERSION,
    schema_version: String(report.schema_version),
    // --- authoritative identity (never name-matched) ---
    lead_id: leadId === null || leadId === undefined ? null : String(leadId),
    research_id: String(report.research_id),
    snapshot_id: String(report.snapshot_id),
    previous_snapshot_id: text(report.previous_snapshot_id, 128),
    entity_key: text(p.entity_key, 300),
    association: association ? { ...association } : null,

    // --- canonical OI payload, preserved ---
    generated_at: report.generated_at || null,
    status: String(report.status),
    research_failed: researchFailed,
    available: !researchFailed && providers.usable > 0,

    prospect: prospects[0],
    prospects,
    competitors,
    evidence,
    observations,
    signals,
    advertising_intelligence: channelBuckets(report).advertising,
    content_intelligence: channelBuckets(report).content,
    social_intelligence: channelBuckets(report).social,
    comparisons,
    changes,
    opportunities,
    opportunity_score: opportunityScore,
    sales_angles: salesAngles,
    timeline,
    conflicts,
    limitations,

    // --- provider honesty, preserved one-for-one ---
    provider_status: providerStatus,
    provider_summary: providers,
    degraded: providers.degraded,

    // --- counts for the UI, no verdict implied ---
    counts: {
      competitors: competitors.length,
      evidence: evidence.length,
      observations: observations.length,
      signals: signals.length,
      comparisons: comparisons.length,
      changes: changes.length,
      opportunities: opportunities.length,
      sales_angles: salesAngles.length,
      timeline: timeline.length,
      conflicts: conflicts.length,
      limitations: limitations.length,
      providers_usable: providers.usable,
      providers_total: providers.total,
    },
  };
}

function competitorKeyById(competitors, id) {
  if (id == null) return null;
  const hit = competitors.find((c) => c.entity_id === id);
  return hit ? hit.entity_key : null;
}

/**
 * A small, flat projection for lists and the drawer header. It reports the
 * counts and the provider posture and nothing that would need interpretation.
 */
function summariseReadModel(model) {
  if (!model) return null;
  return {
    lead_id: model.lead_id,
    research_id: model.research_id,
    snapshot_id: model.snapshot_id,
    entity_key: model.entity_key,
    generated_at: model.generated_at,
    status: model.status,
    available: model.available,
    research_failed: model.research_failed,
    degraded: model.degraded,
    opportunity_score: model.opportunity_score.score,
    provider_summary: model.provider_summary,
    counts: model.counts,
  };
}

module.exports = {
  buildOpportunityReadModel,
  summariseReadModel,
  OI_REPORT_CONTRACT_VERSION,
  OI_CLAIM_KINDS,
  OI_PROVIDER_STATUSES,
  OI_RESEARCH_STATUSES,
  OI_FRESHNESS_STATES,
};