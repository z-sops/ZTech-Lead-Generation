'use strict';

const { validate } = require('../core/validate');

/**
 * The Opportunity Intelligence (OI) contract as seen from ZTech.
 *
 * OI is a separate Python service with its own canonical `IntelligenceReport`
 * (`schemas/intelligence_report.v1.schema.json`). This module is the ONLY place
 * that knows OI's wire shapes. Nothing here interprets, scores or derives
 * anything: it checks that a payload from OI is a well-formed report and it
 * preserves every value OI sent, unchanged.
 *
 * Three things are deliberately NOT weakened on the way in:
 *
 *   1. ClaimKind. OI says `fact` / `estimate` / `inference`. ZTech stores those
 *      three strings verbatim. It never collapses them into one "kind" field,
 *      and it never re-labels an inference as an observation.
 *   2. ProviderStatus. `success` / `partial` / `unavailable` / `unsupported` /
 *      `failed` / `rate_limited` are preserved one-for-one, so a report that
 *      succeeded on three providers and was unavailable on two still reads as
 *      exactly that in ZTech.
 *   3. Identifiers. `research_id`, `snapshot_id` and `entity_key` are carried
 *      through untouched, because they are the only trustworthy link back to a
 *      stored OI report. Business name is never used as a join key.
 */

/** Bump only on a breaking OI report change. Mirrors OI's SCHEMA_VERSION. */
const OI_REPORT_CONTRACT_VERSION = 'ztech.oi-report/1';

/** OI IntelligenceReport.schema_version values this build understands. */
const OI_SCHEMA_VERSIONS = Object.freeze(['1.0']);

/** OI domain/taxonomy.ClaimKind. Preserved verbatim, never remapped. */
const OI_CLAIM_KINDS = Object.freeze(['fact', 'estimate', 'inference']);

/** OI domain/taxonomy.ProviderStatus. Preserved verbatim, never remapped. */
const OI_PROVIDER_STATUSES = Object.freeze([
  'success', 'partial', 'unavailable', 'unsupported', 'failed', 'rate_limited',
]);

/** OI domain/taxonomy.ResearchStatus. */
const OI_RESEARCH_STATUSES = Object.freeze(['running', 'completed', 'partial', 'failed']);

/** OI domain/taxonomy.FreshnessState. */
const OI_FRESHNESS_STATES = Object.freeze(['fresh', 'stale', 'expired', 'unknown']);

/**
 * ZTech gateway availability states. Distinct from OI provider status: this
 * describes whether ZTech can TALK to the service at all, not whether OI's
 * providers worked.
 */
const OI_SERVICE_STATES = Object.freeze([
  'available',        // health OK
  'unavailable',      // cannot reach the service (down, refused, timeout, DNS)
  'misconfigured',    // base URL failed validation
  'invalid_response', // reached it, but it did not speak the OI contract
  'disabled',         // switched off in configuration
]);

const ID = { type: 'string', minLength: 1, maxLength: 128, pattern: /^[A-Za-z0-9_.:-]+$/ };
const NAME = { type: 'string', minLength: 1, maxLength: 300 };
const ISO = { type: 'string', maxLength: 40 };
/** OI emits null for "not timestamped"; that must not read as a validation failure. */
const ISO_OR_NULL = { anyOf: [{ type: 'string', maxLength: 40 }, { type: 'null' }] };
const REF_LIST = { type: 'array', maxItems: 200, items: ID };
const CLAIM = { type: 'string', enum: OI_CLAIM_KINDS };
const STATUS = { type: 'string', enum: OI_PROVIDER_STATUSES };

const ENTITY = {
  type: 'object',
  required: ['entity_id', 'entity_key', 'kind', 'company_name'],
  properties: {
    entity_id: ID,
    entity_key: ID,
    kind: { type: 'string', enum: ['prospect', 'competitor'] },
    company_name: NAME,
    domain: { type: 'string', maxLength: 253, nullable: true },
    location: { type: 'string', maxLength: 300, nullable: true },
    industry: { type: 'string', maxLength: 200, nullable: true },
  },
  additionalProperties: true,
};

const EVIDENCE = {
  type: 'object',
  required: ['evidence_id', 'entity_id', 'provider', 'claim', 'claim_kind', 'captured_at', 'confidence'],
  properties: {
    evidence_id: ID,
    entity_id: ID,
    provider: { type: 'string', maxLength: 100 },
    source_type: { type: 'string', maxLength: 100 },
    source_url: { type: 'string', maxLength: 2048, nullable: true },
    claim: { type: 'string', maxLength: 2000 },
    claim_kind: CLAIM,
    metric: { type: 'string', maxLength: 200, nullable: true },
    value: {
      anyOf: [
        { type: 'number' },
        { type: 'string', maxLength: 5000 },
        { type: 'boolean' },
        { type: 'null' },
      ],
    },
    freshness: { anyOf: [{ type: 'string', enum: OI_FRESHNESS_STATES }, { type: 'null' }] },
    captured_at: ISO,
    observed_at: ISO_OR_NULL,
    expires_at: ISO_OR_NULL,
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    evidence_refs: REF_LIST,
    conflicts_with: REF_LIST,
  },
  additionalProperties: true,
};

const OPPORTUNITY = {
  type: 'object',
  required: ['opportunity_id', 'type', 'title', 'confidence', 'severity', 'claim_kind',
    'what_was_observed', 'why_it_matters', 'evidence_refs'],
  properties: {
    opportunity_id: ID,
    type: { type: 'string', maxLength: 100 },
    title: { type: 'string', minLength: 1, maxLength: 300 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    severity: { type: 'string', enum: ['low', 'medium', 'high'] },
    // OI fixes this to `inference`: an opportunity is a conclusion, never an
    // observation. The literal is enforced so an "observed opportunity" can
    // never arrive from a tampered or buggy engine.
    claim_kind: { type: 'string', enum: ['inference'] },
    what_was_observed: { type: 'string', maxLength: 4000 },
    who: { type: 'array', maxItems: 100, items: { type: 'string', maxLength: 300 } },
    prospect_state: { type: 'string', maxLength: 2000 },
    why_it_matters: { type: 'string', maxLength: 4000 },
    reasoning_summary: { type: 'string', maxLength: 4000 },
    evidence_refs: REF_LIST,
    signal_refs: REF_LIST,
    comparison_refs: REF_LIST,
    change_refs: REF_LIST,
    limitations: { type: 'array', maxItems: 100, items: { type: 'string', maxLength: 1000 } },
  },
  additionalProperties: true,
};

const SALES_ANGLE = {
  type: 'object',
  required: ['angle_id', 'angle', 'summary', 'confidence'],
  properties: {
    angle_id: ID,
    angle: { type: 'string', minLength: 1, maxLength: 300 },
    summary: { type: 'string', maxLength: 2000 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    evidence_refs: REF_LIST,
    opportunity_refs: REF_LIST,
    limitations: { type: 'array', maxItems: 100, items: { type: 'string', maxLength: 1000 } },
    // OI tells us what must NOT be said. This is a safety property, so it is
    // carried rather than summarised away.
    do_not_claim: { type: 'array', maxItems: 100, items: { type: 'string', maxLength: 500 } },
  },
  additionalProperties: true,
};

const TIMELINE_EVENT = {
  type: 'object',
  required: ['event_id', 'event_type', 'entity_id', 'occurred_at', 'title', 'claim_kind'],
  properties: {
    event_id: ID,
    event_type: { type: 'string', maxLength: 100 },
    entity_id: ID,
    occurred_at: ISO,
    title: { type: 'string', minLength: 1, maxLength: 300 },
    summary: { type: 'string', maxLength: 2000 },
    claim_kind: CLAIM,
    research_id: ID,
    evidence_refs: REF_LIST,
  },
  additionalProperties: true,
};

/**
 * Structural contract for a canonical IntelligenceReport.
 *
 * `additionalProperties: true` everywhere below the top level is intentional:
 * this validates the fields ZTech depends on without freezing OI's own schema,
 * so an OI release that adds a field still reaches the read model intact.
 * The TOP level is strict, because a missing or misnamed top-level section is
 * exactly the malformed-report case ZTech must refuse.
 */
const INTELLIGENCE_REPORT_SCHEMA = {
  type: 'object',
  required: [
    'schema_version', 'research_id', 'snapshot_id', 'status', 'generated_at',
    'prospect', 'competitors', 'evidence', 'observations', 'signals',
    'advertising_intelligence', 'content_intelligence', 'social_intelligence',
    'comparisons', 'changes', 'opportunities', 'opportunity_score', 'sales_angles',
    'timeline', 'conflicts', 'limitations', 'provider_status', 'telemetry',
  ],
  properties: {
    schema_version: { type: 'string', enum: OI_SCHEMA_VERSIONS },
    research_id: ID,
    snapshot_id: ID,
    previous_snapshot_id: { anyOf: [{ type: 'string', maxLength: 128 }, { type: 'null' }] },
    status: { type: 'string', enum: OI_RESEARCH_STATUSES },
    generated_at: ISO,
    prospect: ENTITY,
    competitors: { type: 'array', maxItems: 50, items: ENTITY },
    evidence: { type: 'array', maxItems: 5000, items: EVIDENCE },
    observations: { type: 'array', maxItems: 5000, items: { type: 'object', required: ['observation_id', 'claim_kind'], properties: { observation_id: ID, claim_kind: CLAIM }, additionalProperties: true } },
    signals: { type: 'array', maxItems: 5000, items: { type: 'object', required: ['signal_id', 'claim_kind'], properties: { signal_id: ID, claim_kind: CLAIM }, additionalProperties: true } },
    advertising_intelligence: { type: 'object' },
    content_intelligence: { type: 'object' },
    social_intelligence: { type: 'object' },
    comparisons: { type: 'array', maxItems: 5000, items: { type: 'object', required: ['comparison_id'], properties: { comparison_id: ID, interpretation: { type: 'string', maxLength: 100 }, confidence: { type: 'number', minimum: 0, maximum: 1 }, evidence_refs: REF_LIST }, additionalProperties: true } },
    changes: { type: 'array', maxItems: 5000, items: { type: 'object', required: ['change_id'], properties: { change_id: ID, claim_kind: CLAIM, evidence_refs: REF_LIST }, additionalProperties: true } },
    opportunities: { type: 'array', maxItems: 500, items: OPPORTUNITY },
    opportunity_score: {
      type: 'object',
      required: ['score'],
      properties: {
        score: { type: 'integer', minimum: 0, maximum: 100 },
        model_version: { type: 'string', maxLength: 50 },
        previous_score: { type: 'integer', minimum: 0, maximum: 100, nullable: true },
        explanation: { type: 'array', maxItems: 100, items: { type: 'string', maxLength: 1000 } },
      },
      additionalProperties: true,
    },
    sales_angles: { type: 'array', maxItems: 200, items: SALES_ANGLE },
    timeline: { type: 'array', maxItems: 2000, items: TIMELINE_EVENT },
    conflicts: { type: 'array', maxItems: 500, items: { type: 'object', additionalProperties: true } },
    limitations: { type: 'array', maxItems: 200, items: { type: 'string', maxLength: 1000 } },
    // entity_key -> provider -> status. Structure is checked; every status value
    // must be one of the six OI statuses, and none is defaulted or invented.
    provider_status: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        additionalProperties: STATUS,
      },
    },
    telemetry: { type: 'object' },
  },
  additionalProperties: true,
};

/** Validate a canonical IntelligenceReport. Returns { valid, errors }. */
function validateIntelligenceReport(report) {
  const errors = validate(INTELLIGENCE_REPORT_SCHEMA, report);
  if (errors.length) return { valid: false, errors: errors.slice(0, 50) };
  // Referential integrity OI guarantees and ZTech depends on: a report must not
  // point at evidence it does not carry, or ZTech could show a conclusion whose
  // provenance it cannot open.
  const evidenceIds = new Set((report.evidence || []).map((e) => e.evidence_id));
  const opportunityIds = new Set((report.opportunities || []).map((o) => o.opportunity_id));
  for (const o of report.opportunities || []) {
    for (const ref of o.evidence_refs || []) {
      if (!evidenceIds.has(ref)) errors.push({ path: `$.opportunities.${o.opportunity_id}.evidence_refs`, message: `unknown evidence ${ref}` });
    }
    for (const ref of o.opportunity_refs || []) {
      if (!opportunityIds.has(ref)) errors.push({ path: `$.opportunities.${o.opportunity_id}.opportunity_refs`, message: `unknown opportunity ${ref}` });
    }
  }
  for (const a of report.sales_angles || []) {
    for (const ref of a.opportunity_refs || []) {
      if (!opportunityIds.has(ref)) errors.push({ path: `$.sales_angles.${a.angle_id}.opportunity_refs`, message: `unknown opportunity ${ref}` });
    }
  }
  return { valid: errors.length === 0, errors: errors.slice(0, 50) };
}

/**
 * Flatten `provider_status` into a stable, sorted list so the UI and tests can
 * reason about provider health without walking a nested object. No value is
 * changed: `status` is the exact string OI produced.
 */
function flattenProviderStatus(report) {
  const byEntity = report.provider_status || {};
  const out = [];
  for (const entityKey of Object.keys(byEntity).sort()) {
    const providers = byEntity[entityKey] || {};
    for (const provider of Object.keys(providers).sort()) {
      out.push({ entity_key: entityKey, provider, status: providers[provider] });
    }
  }
  return out;
}

/**
 * Summarise provider health without inventing an aggregate verdict.
 *
 * `degraded` means "at least one provider was not `success`", which is the
 * normal state for a free configuration. It deliberately does NOT mean failure:
 * an OI report with six unavailable providers is still a usable report, and this
 * function must never let a caller render it as "research failed".
 */
function summariseProviders(report) {
  const flat = flattenProviderStatus(report);
  const counts = Object.fromEntries(OI_PROVIDER_STATUSES.map((s) => [s, 0]));
  for (const p of flat) {
    if (Object.prototype.hasOwnProperty.call(counts, p.status)) counts[p.status] += 1;
  }
  const usable = counts.success + counts.partial;
  return {
    total: flat.length,
    counts,
    usable,
    degraded: flat.length > 0 && usable < flat.length,
    all_usable: flat.length > 0 && usable === flat.length,
  };
}

module.exports = {
  OI_REPORT_CONTRACT_VERSION,
  OI_SCHEMA_VERSIONS,
  OI_CLAIM_KINDS,
  OI_PROVIDER_STATUSES,
  OI_RESEARCH_STATUSES,
  OI_FRESHNESS_STATES,
  OI_SERVICE_STATES,
  INTELLIGENCE_REPORT_SCHEMA,
  validateIntelligenceReport,
  flattenProviderStatus,
  summariseProviders,
};