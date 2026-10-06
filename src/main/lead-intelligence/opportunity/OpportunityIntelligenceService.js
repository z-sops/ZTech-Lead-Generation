'use strict';

const { OpportunityIntelligenceGateway, DEFAULT_CONFIG } = require('./OpportunityIntelligenceGateway');
const { OpportunityAssociationStore, MIGRATION_NEED } = require('./OpportunityAssociationStore');
const { buildOpportunityReadModel, summariseReadModel } = require('./OpportunityReadModel');
const { buildPitchEvidenceBridge } = require('./PitchEvidenceBridge');
const { generatePitch } = require('../outreach/PitchGenerator');

/**
 * OpportunityIntelligenceService - the composition ZTech talks to.
 *
 * This is where the "OI may be absent" rule becomes structural rather than a
 * convention. Every public method returns a view object with an `available`
 * flag instead of throwing, so a caller can render "Opportunity Intelligence is
 * unavailable" and carry on. Nothing in this file can change Zuni-SEO behaviour,
 * outreach readiness, approval, send capability or the Activity ledger.
 *
 * THE ZUNI-SEO COEXISTENCE RULE
 * ----------------------------
 * ZTech has two intelligence systems and this service is only the second one:
 *
 *   lead-intelligence/                 Zuni-SEO. Unchanged. Owns research jobs,
 *     research/ProspectIntelligenceGateway   the EvidencePacket contract, and the
 *     contracts/evidencePacket.js      only evidence a pitch may quote.
 *
 *   lead-intelligence/opportunity/     Opportunity Intelligence. This service.
 *     OpportunityIntelligenceService   Owns the OI read model, the association
 *                                      ledger and the Pitch Evidence Bridge.
 *
 * They share `lead_id`, nothing else. `research` (Zuni-SEO) and `opportunity`
 * (OI) are separate namespaces with separate channels and separate stores; there
 * is no fallback from one to the other, and neither one's absence affects the
 * other. In particular `researchReady()` is unaffected by anything here, and
 * nothing in this file is consulted by the OutreachGate.
 */

const READ_SECTIONS = Object.freeze(['overview', 'opportunities', 'competitors', 'ads', 'content', 'social', 'timeline', 'evidence', 'angles']);

class OpportunityIntelligenceService {
  constructor({ config = {}, fetchImpl, clock, logger, gateway } = {}) {
    this.gateway = gateway || new OpportunityIntelligenceGateway({ config, fetchImpl, clock, logger });
    this.associations = new OpportunityAssociationStore({ clock: clock || (() => new Date()) });
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.migration = MIGRATION_NEED;
  }

  get enabled() { return this.gateway.enabled; }
  get health() { return this.gateway.health; }

  /** Start-up probe. A failure here is already non-fatal by construction. */
  async start() {
    const health = await this.gateway.checkHealth();
    return this.healthView();
  }

  async stop() { /* nothing to tear down: no socket is held open */ }

  healthView() {
    const h = this.gateway.health;
    return {
      enabled: this.enabled,
      state: h.state,
      message: h.message,
      schema_version: h.schema_version || null,
      checked_at: h.checked_at || null,
      base_url: this.gateway.baseUrl || null,
      affects_outreach: false,
    };
  }

  async describeEngine() {
    const res = await this.gateway.describeEngine();
    if (!res.ok) return { available: false, state: res.state, error: res.error, health: this.healthView() };
    return { available: true, engine: res.engine, schema_version: res.schema_version, providers: res.providers, configuration: res.configuration };
  }

  // --- lead intelligence ----------------------------------------------------

  /**
   * Run OI research for a lead and record the association.
   *
   * The prospect identity comes from the lead view supplied by the CALLER IN THE
   * MAIN PROCESS - not from the renderer, and not from a URL. `leadView` is the
   * same shape the Zuni-SEO gateway consumes.
   */
  async researchForLead({ leadId, leadView, options = {} }) {
    if (!this.enabled) return this.unavailableView('Opportunity Intelligence is disabled in configuration.');
    const identity = identityFromView(leadView);
    if (!identity.companyName) {
      return { ...this.unavailableView('Lead has no company name, so Opportunity Intelligence cannot be asked.'), state: 'invalid_input' };
    }
    const res = await this.gateway.requestResearch({ leadId, ...identity, options });
    if (!res.ok) return { ...this.unavailableView(res.error), state: res.state, status: res.status, errors: res.errors };
    return this.absorb(leadId, res.report);
  }

  /** Fetch a previously stored OI report by research_id and rebuild the view. */
  async reportForResearchId({ leadId, researchId }) {
    if (!this.enabled) return this.unavailableView('Opportunity Intelligence is disabled in configuration.');
    const res = await this.gateway.getReport(researchId);
    if (!res.ok) return { ...this.unavailableView(res.error), state: res.state, status: res.status, errors: res.errors };
    // A report fetched by id is only attached to a lead if the association already
    // exists. It is never attached by comparing company names.
    const known = this.associations.leadForResearch(researchId);
    if (leadId != null && known !== null && known !== String(leadId)) {
      return { ...this.unavailableView('That report belongs to a different lead.'), state: 'conflict' };
    }
    const association = this.associations.associationForResearch(researchId);
    return this.toView(leadId != null ? leadId : known, res.report, association);
  }

  /** The lead's most recent OI report, if one was recorded this session. */
  async latestForLead({ leadId }) {
    if (!this.enabled) return this.unavailableView('Opportunity Intelligence is disabled in configuration.');
    const assoc = this.associations.latestForLead(leadId);
    if (!assoc) {
      return {
        available: false,
        state: 'not_researched',
        message: 'No Opportunity Intelligence research has been run for this lead yet.',
        lead_id: leadId == null ? null : String(leadId),
        model: null,
        summary: null,
        sections: null,
        affects_outreach: false,
      };
    }
    const res = await this.gateway.getReport(assoc.research_id);
    if (!res.ok) return { ...this.unavailableView(res.error), state: res.state, lead_id: String(leadId), research_id: assoc.research_id };
    return this.toView(leadId, res.report, assoc);
  }

  /** Association ledger for a lead. Ids only. */
  associationsForLead({ leadId }) {
    return { ...this.associations.toView(leadId), available: this.enabled, affects_outreach: false };
  }

  /**
   * OI's own research timeline for a lead.
   *
   * This is NOT ZTech's Activity ledger. Nothing here is written to it, and it
   * does not appear in it: research history and operational history stay two
   * separate things with two separate stores.
   */
  async timelineForLead({ leadId } = {}) {
    if (!this.enabled) return { available: false, state: 'unavailable', reason: this.gateway.unavailableReason(), events: [], separate_from_activity: true, affects_outreach: false };
    const assoc = this.associations.latestForLead(leadId);
    const res = await this.gateway.getTimeline({ researchId: assoc ? assoc.research_id : null, entityKey: assoc ? assoc.entity_key : null });
    if (!res.ok) return { available: false, state: res.state, reason: res.error, events: [], separate_from_activity: true, affects_outreach: false };
    return {
      available: true,
      state: 'ok',
      research_id: assoc ? assoc.research_id : null,
      entity_key: assoc ? assoc.entity_key : null,
      events: res.timeline.events,
      separate_from_activity: true,
      affects_outreach: false,
    };
  }

  // --- views ----------------------------------------------------------------

  /**
   * Full read model plus the section projections the UI renders.
   * `sections` narrows the payload; `undefined` returns everything.
   */
  toView(leadId, report, association = null) {
    const model = buildOpportunityReadModel({ report, leadId, association });
    return {
      available: model.available,
      state: model.research_failed ? 'failed' : 'ok',
      message: model.research_failed
        ? 'Opportunity Intelligence could not observe this prospect.'
        : (model.degraded ? 'Some Opportunity Intelligence providers were unavailable; the report is still usable.' : 'Opportunity Intelligence report available.'),
      model,
      summary: summariseReadModel(model),
      sections: projectSections(model),
      affects_outreach: false,
    };
  }

  unavailableView(message) {
    return {
      available: false,
      state: 'unavailable',
      message: message || 'Opportunity Intelligence is unavailable.',
      model: null,
      summary: null,
      sections: null,
      affects_outreach: false,
    };
  }

  // --- pitch bridge ---------------------------------------------------------

  /**
   * Build an EvidencePacket-compatible context from an OI report, and record
   * what the bridge deliberately left out.
   *
   * This returns CONTEXT. It does not send, approve, schedule or persist
   * anything, and it does not touch the Zuni-SEO packet, the pitch draft or the
   * Activity ledger.
   */
  async pitchContextForLead({ leadId, leadView = {} }) {
    if (!this.enabled) {
      return { available: false, reason: 'Opportunity Intelligence is unavailable.', bridge: null, affects_outreach: false };
    }
    const assoc = this.associations.latestForLead(leadId);
    if (!assoc) return { available: false, reason: 'No Opportunity Intelligence research for this lead yet.', bridge: null, affects_outreach: false };
    const res = await this.gateway.getReport(assoc.research_id);
    if (!res.ok) return { available: false, reason: res.error, bridge: null, research_id: assoc.research_id, affects_outreach: false };
    return this.bridge({ leadId, leadView, report: res.report, association: assoc });
  }

  bridge({ leadId, leadView = {}, report, association = null, freshness = {} }) {
    const built = buildPitchEvidenceBridge({ report, leadId, view: leadView, freshness });
    return {
      available: Boolean(built.ok),
      reason: built.ok ? null : 'The OI report could not be projected into a valid EvidencePacket.',
      errors: built.ok ? [] : built.packet_errors,
      bridge: {
        packet: built.packet,
        claim_kinds: built.claim_kinds,
        oi: built.oi,
        oi_ids: built.oi_ids,
        counts: built.counts,
        excluded: built.excluded,
        // A human reviewer can see exactly what was declined and why.
        boundaries: {
          never_upgrades_claim_kind: true,
          opportunities_bridged_as_findings: false,
          inference_findings_are_pitch_ineligible: true,
          missing_provider_data_is_not_refutation: true,
        },
      },
      affects_outreach: false,
    };
  }

  /**
   * Run the EXISTING PitchGenerator against the bridge output.
   *
   * This is additive and opt-in: it is only ever called when a caller explicitly
   * asks for OI-informed pitch context. It returns a preview object. It does not
   * write a pitch draft, does not approve, and does not touch the gate - those
   * remain the existing F12-F25 pipeline's job, unchanged.
   */
  async previewPitchFromOI({ leadId, leadView = {}, offer = {}, icpFit = null, now = new Date(), freshness = {} }) {
    const ctx = await this.pitchContextForLead({ leadId, leadView, freshness });
    if (!ctx.available) return { available: false, reason: ctx.reason, pitch: null, affects_outreach: false };
    const draft = generatePitch({
      view: { id: leadId, ...leadView },
      packet: ctx.bridge.packet,
      icpFit,
      offer,
      now,
      targetId: null,
    });
    return {
      available: true,
      pitch: draft,
      provenance: {
        source: 'opportunity-intelligence',
        research_id: ctx.bridge.oi.research_id,
        snapshot_id: ctx.bridge.oi.snapshot_id,
        entity_key: ctx.bridge.oi.entity_key,
        claim_kinds: ctx.bridge.claim_kinds,
      },
      // Explicitly NOT persisted, NOT approved, NOT sendable from here.
      persisted: false,
      approved: false,
      affects_outreach: false,
    };
  }

  absorb(leadId, report) {
    const assoc = this.associations.assertLeadAssociation({ leadId, report });
    if (!assoc.ok) return this.unavailableView(assoc.error);
    return this.toView(leadId, report, assoc.association);
  }
}

// --- section projections -----------------------------------------------------

/** Exactly the surfaces named in the I2 UI plan. Nothing more. */
function projectSections(model) {
  return {
    overview: {
      opportunity_score: model.opportunity_score,
      providers: model.provider_status,
      provider_summary: model.provider_summary,
      limitations: model.limitations,
      generated_at: model.generated_at,
      status: model.status,
      degraded: model.degraded,
    },
    opportunities: {
      items: model.opportunities,
      scores: model.opportunity_score.components,
      note: 'Every opportunity is an inference. The evidence each one rests on is listed and openable.',
    },
    competitors: {
      items: model.competitors,
      comparisons: model.comparisons,
    },
    ads: {
      channels: model.advertising_intelligence,
      signals: model.signals.filter((s) => String(s.type || '').startsWith('AD')),
    },
    content: {
      channels: model.content_intelligence,
      changes: model.changes,
    },
    social: {
      channels: model.social_intelligence,
    },
    timeline: {
      items: model.timeline,
      note: 'OI research events. ZTech operational Activity is a separate ledger and is not merged.',
    },
    evidence: {
      items: model.evidence,
      conflicts: model.conflicts,
      observations: model.observations,
    },
    angles: {
      items: model.sales_angles,
      note: 'OI sales angles. Every angle is an inference and carries do_not_claim guidance.',
    },
  };
}

/** Prospect identity from a ZTech lead view. No URL is ever accepted here. */
function identityFromView(view) {
  const v = view && typeof view === 'object' ? view : {};
  return {
    companyName: firstText(v.company_name, v.companyName, v.name),
    domain: firstText(v.domain, v.website, v.url),
    location: firstText(v.city, v.location),
    industry: firstText(v.industry, v.category),
  };
}

function firstText(...candidates) {
  for (const c of candidates) {
    if (c == null) continue;
    const s = String(c).trim();
    if (s) return s;
  }
  return null;
}

module.exports = { OpportunityIntelligenceService, READ_SECTIONS, identityFromView, projectSections };