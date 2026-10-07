'use strict';

const { OpportunityIntelligenceGateway, DEFAULT_CONFIG } = require('./OpportunityIntelligenceGateway');
const { OpportunityAssociationStore, MIGRATION_NEED } = require('./OpportunityAssociationStore');
const { buildOpportunityReadModel, summariseReadModel } = require('./OpportunityReadModel');
const { buildPitchEvidenceBridge } = require('./PitchEvidenceBridge');
const { generatePitch } = require('../outreach/PitchGenerator');
const { classifyOiFreshness } = require('./oiFreshness');
const { OpportunityRefreshLedger } = require('./OpportunityRefreshLedger');

/** I5 (E2): how many associations, newest first, are tried before "no longer available". */
const MAX_REPORT_LOOKUPS = 5;

/** I5 user-facing copy (approved wording). */
const I5_COPY = Object.freeze({
  confirmFresh: 'This report is still fresh. Refreshing may call configured paid providers again. Continue?',
  olderReport: 'Showing an older report because the latest report is no longer available.',
  noneAvailable: "This lead's reports are no longer available. Run research again.",
  alreadyRunning: 'Research is already running for this lead.',
  stillRunningInOi: 'Research is still running in Opportunity Intelligence. Check again shortly; no new paid run will start.',
  retrySafe: 'Retry reuses the same request, so it will not start a second paid run.',
  notRecorded: 'The refresh request could not be recorded, so nothing was sent to Opportunity Intelligence.',
});

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
  constructor({ config = {}, fetchImpl, clock, logger, gateway, associationBacking = null, refreshBacking = null } = {}) {
    this.clock = clock || (() => new Date());
    this.gateway = gateway || new OpportunityIntelligenceGateway({ config, fetchImpl, clock, logger });
    this.associations = new OpportunityAssociationStore({ clock: this.clock, backing: associationBacking, logger });
    // I5 (E4): persisted refresh intents, and the per-lead in-flight lock (process-local by
    // design: after a restart nothing is in flight, and the persisted intent carries on).
    this.refresh = new OpportunityRefreshLedger({ backing: refreshBacking, clock: this.clock });
    this.inflight = new Set();
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
      // The OI destination is main-process configuration; the renderer never sees it.
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
  async researchForLead({ leadId, leadView, options = {}, confirmFresh = false }) {
    if (!this.enabled) return this.unavailableView('Opportunity Intelligence is disabled in configuration.');
    const lead = String(leadId);
    const identity = identityFromView(leadView);
    if (!identity.companyName) {
      return { ...this.unavailableView('Lead has no company name, so Opportunity Intelligence cannot be asked.'), state: 'invalid_input' };
    }
    // One run per lead at a time. A second request is refused here and nothing reaches OI.
    if (this.inflight.has(lead)) {
      return { ...this.unavailableView(I5_COPY.alreadyRunning), state: 'in_progress', code: 'OI_RUN_IN_PROGRESS', lead_id: lead, running: true };
    }
    this.inflight.add(lead);
    try {
      let requestId;
      let pending;
      try {
        pending = await this.refresh.pending(lead);
      } catch {
        return { ...this.unavailableView(I5_COPY.notRecorded), state: 'refresh_store_unavailable', lead_id: lead };
      }
      if (pending) {
        // An open intent: this is a RETRY of it. Same key, no confirmation - it cannot
        // start a second paid run, because OI answers a known key from what it already did.
        requestId = pending.request_id;
      } else {
        // E3: a deliberate refresh of a still-fresh report needs an explicit confirmation.
        // Enforced here, in main, so a renderer cannot skip it.
        const latest = this.associations.latestForLead(lead);
        if (latest && confirmFresh !== true) {
          const freshness = classifyOiFreshness(latest.generated_at, this.clock());
          if (freshness.state === 'fresh') {
            return { available: false, state: 'confirm_required', message: I5_COPY.confirmFresh, lead_id: lead, freshness, model: null, summary: null, sections: null, affects_outreach: false };
          }
        }
        try {
          requestId = await this.refresh.open(lead);
        } catch {
          return { ...this.unavailableView(I5_COPY.notRecorded), state: 'refresh_store_unavailable', lead_id: lead };
        }
      }

      const res = await this.gateway.requestResearch({ leadId, ...identity, options: { ...options, idempotency_key: requestId } });
      if (res.ok) {
        const view = this.absorb(lead, res.report);
        if (view.model) {
          await this.closeIntent(requestId, 'succeeded', res.report.research_id);
          return { ...view, freshness: classifyOiFreshness(res.report.generated_at, this.clock()), refresh: { retried: Boolean(pending) } };
        }
        await this.closeIntent(requestId, 'failed', 'ASSOCIATION_REFUSED');
        return view;
      }
      const outcome = classifyResearchFailure(res);
      if (outcome === 'in_progress') {
        return { ...this.unavailableView(I5_COPY.stillRunningInOi), state: 'in_progress', lead_id: lead, refresh_pending: true };
      }
      if (outcome === 'terminal') {
        await this.closeIntent(requestId, 'failed', (res.oiError && res.oiError.code) || res.state || 'FAILED');
        return { ...this.unavailableView(res.error), state: res.state, status: res.status, errors: res.errors, lead_id: lead, terminal: true };
      }
      // Retryable (OI unreachable, timed out, 5xx, 429): the intent stays open.
      return {
        ...this.unavailableView(`${res.error || 'Opportunity Intelligence did not answer.'} ${I5_COPY.retrySafe}`),
        state: res.state, status: res.status, lead_id: lead, refresh_pending: true,
      };
    } finally {
      this.inflight.delete(lead);
    }
  }

  async closeIntent(requestId, state, detail) {
    try {
      if (state === 'succeeded') await this.refresh.succeed(requestId, detail);
      else await this.refresh.fail(requestId, detail);
    } catch {
      // The intent stays pending: the next Run reuses the key and OI replays the outcome.
    }
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

  /**
   * The lead's report for the drawer (I5).
   *
   * Tries the newest association first, then up to MAX_REPORT_LOOKUPS in total, newest to
   * oldest (E2). An older report is never presented as current: its state is
   * `older_report` with the approved message, its own date and freshness, and how many
   * newer reports are gone. A network failure stops the walk and is reported as
   * unavailable - ZTech never says a report is missing when it could not ask. Nothing is
   * deleted; no row is changed.
   */
  async latestForLead({ leadId }) {
    if (!this.enabled) return this.unavailableView('Opportunity Intelligence is disabled in configuration.');
    const lead = leadId == null ? null : String(leadId);
    const live = await this.liveState(lead);
    const list = this.associations.listForLead(lead);
    if (list.length === 0) {
      return {
        available: false,
        state: 'not_researched',
        message: 'No Opportunity Intelligence research has been run for this lead yet.',
        lead_id: lead,
        model: null,
        summary: null,
        sections: null,
        freshness: null,
        affects_outreach: false,
        ...live,
      };
    }
    const now = this.clock();
    let missing = 0;
    for (const assoc of list.slice(0, MAX_REPORT_LOOKUPS)) {
      const res = await this.gateway.getReport(assoc.research_id);
      if (res.ok) {
        const view = this.toView(lead, res.report, assoc);
        const freshness = classifyOiFreshness(res.report.generated_at || assoc.generated_at, now);
        if (missing === 0) return { ...view, freshness, ...live };
        return {
          ...view,
          state: 'older_report',
          message: I5_COPY.olderReport,
          freshness,
          missing_newer: missing,
          latest_generated_at: list[0].generated_at,
          ...live,
        };
      }
      if (res.status === 404) { missing += 1; continue; }
      // Could not ask: unavailable, with the stored age of the newest report.
      return {
        ...this.unavailableView(res.error),
        state: res.state,
        lead_id: lead,
        research_id: list[0].research_id,
        freshness: classifyOiFreshness(list[0].generated_at, now),
        ...live,
      };
    }
    return {
      available: false,
      state: 'report_missing',
      message: I5_COPY.noneAvailable,
      lead_id: lead,
      research_id: list[0].research_id,
      checked: missing,
      model: null,
      summary: null,
      sections: null,
      freshness: null,
      affects_outreach: false,
      ...live,
    };
  }

  /** Running in this process, and/or an open refresh intent left by an earlier attempt. */
  async liveState(lead) {
    const running = lead != null && this.inflight.has(lead);
    let pending = null;
    try { pending = lead == null ? null : await this.refresh.pending(lead); } catch { pending = null; }
    return { running, refresh_pending: Boolean(pending) && !running };
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

/**
 * How a failed research request is settled (E4):
 *   in_progress - OI is still running this key: keep the intent open
 *   terminal    - OI gave a final answer (a replayed failure, a refusal, an invalid report):
 *                 close the intent; the next deliberate Refresh mints a new key
 *   retryable   - OI was not reached or could not answer (network, timeout, 5xx, 429,
 *                 not configured): keep the intent open so a retry reuses the key
 */
function classifyResearchFailure(res) {
  const err = res && res.oiError ? res.oiError : {};
  if (res && res.status === 409 && err.code === 'IN_PROGRESS') return 'in_progress';
  if (err.replay === true) return 'terminal';
  if (res && res.state === 'invalid_input') return 'terminal';
  if (res && res.state === 'invalid_response' && res.status === undefined) return 'terminal';
  const st = res ? res.status : undefined;
  if (typeof st === 'number' && st >= 400 && st < 500 && st !== 429) return 'terminal';
  return 'retryable';
}

module.exports = { OpportunityIntelligenceService, READ_SECTIONS, identityFromView, projectSections, classifyResearchFailure, MAX_REPORT_LOOKUPS, I5_COPY };