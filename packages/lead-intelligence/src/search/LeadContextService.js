'use strict';

const { toLeadView } = require('../contracts/leadView');
const { computeDigitalFootprint } = require('../research/digitalFootprint');
const { effectiveState, moduleStateReader } = require('../research/researchState');
const { evaluateIcpFit, targetToIcp } = require('../icp/icpFit');
const { NotFoundError } = require('../core/errors');

/**
 * LeadContextService — computes, on demand, the per-lead facts that searches, segments,
 * profile and export filter on. Nothing is copied: it reads the current Lead Library
 * (leadSource) plus the latest research rows each time.
 *
 * targetSource (INTEGRATION POINT): { getTarget(id): Promise<object|null> } over the
 * existing Target Builder storage.
 */
class LeadContextService {
  constructor({ leadSource, targetSource, store, freshness, fieldMap, targetFieldPaths, enrichment = null, researchStates = null, beforeLeadRead = null, clock = () => new Date(), logger = console }) {
    this.enrichment = enrichment;
    // Where research job state comes from: the module's own jobs (module mode) or the
    // round-1 engine via Round1ResearchBridge.stateReader() (round1 mode).
    this.researchStates = researchStates || moduleStateReader(store);
    // Optional hook run before one lead is read (round1 mode: convert a newly finished
    // round-1 result into an EvidencePacket).
    this.beforeLeadRead = beforeLeadRead;
    this.leadSource = leadSource;
    this.targetSource = targetSource;
    this.store = store;
    this.freshness = freshness;
    this.fieldMap = fieldMap;
    this.targetFieldPaths = targetFieldPaths;
    this.clock = clock;
    this.logger = logger;
  }

  async icpForTarget(targetId) {
    if (targetId === undefined || targetId === null || targetId === '') return null;
    if (!this.targetSource) throw new NotFoundError('Target', targetId);
    const t = await this.targetSource.getTarget(targetId);
    if (!t) throw new NotFoundError('Target', targetId);
    return targetToIcp(t, this.targetFieldPaths);
  }

  _state(view, job, meta, now) {
    const fresh = meta ? !this.freshness.isExpiredAt(meta.expires_at, now) && meta.research_status !== 'failed' : false;
    const research_state = effectiveState(job, meta, fresh);
    const footprint_state = meta ? meta.footprint_state : computeDigitalFootprint({ packet: null, leadView: view }).state;
    return { research_state, footprint_state, fresh };
  }

  static needsEvidence(icp) {
    return Boolean(icp) && [...icp.criteria, ...(icp.exclusions || [])].some((c) => c.field.startsWith('fact:') || c.field.startsWith('finding:') || c.field === 'digital_footprint');
  }

  /** Contexts for every lead in the library. */
  async listContexts({ targetId } = {}) {
    const now = this.clock();
    const icp = await this.icpForTarget(targetId);
    const needPackets = LeadContextService.needsEvidence(icp);
    const raws = await this.leadSource.listLeads();
    const jobs = await this.researchStates.latestPerLead();
    const metas = await this.store.packets.latestMetaPerLead();
    const enrichedByLead = icp && this.enrichment ? await this.store.enrichmentObservations.listAllGrouped() : new Map();
    const out = [];
    for (const raw of raws) {
      let view;
      try {
        view = toLeadView(raw, this.fieldMap);
      } catch {
        continue; // a lead without id cannot be referenced; skip it
      }
      const job = jobs.get(view.id) || null;
      const meta = metas.get(view.id) || null;
      const st = this._state(view, job, meta, now);
      let icpFit = null;
      if (icp) {
        const packet = needPackets && meta ? await this.store.packets.latestForLead(view.id) : null;
        const enriched = this.enrichment ? this.enrichment.enrichedForIcp(enrichedByLead.get(view.id) || []) : null;
        icpFit = evaluateIcpFit({ view, icp, packet, researchState: st.research_state, footprintState: st.footprint_state, enriched, now });
      }
      out.push({ view, job, packet_meta: meta, ...st, icp_fit: icpFit });
    }
    return out;
  }

  /** Context for one lead, with the full latest packet. */
  async getContext(leadId, { targetId } = {}) {
    const raw = await this.leadSource.getLead(leadId);
    if (!raw) throw new NotFoundError('Lead', leadId);
    const view = toLeadView(raw, this.fieldMap);
    if (this.beforeLeadRead) {
      try {
        await this.beforeLeadRead(view.id);
      } catch (e) {
        if (this.logger && this.logger.warn) this.logger.warn(`[lead-intelligence] pre-read sync failed for ${view.id}: ${e && e.code ? e.code : 'ERROR'}`);
      }
    }
    const now = this.clock();
    const jobs = await this.researchStates.listByLead(view.id);
    const packet = await this.store.packets.latestForLead(view.id);
    const meta = packet ? await this.store.packets.getMeta(packet.packet_id) : null;
    const st = this._state(view, jobs[0] || null, meta, now);
    const icp = await this.icpForTarget(targetId);
    let icpFit = null;
    if (icp) {
      const enriched = this.enrichment ? this.enrichment.enrichedForIcp(await this.store.enrichmentObservations.listByLead(view.id)) : null;
      icpFit = evaluateIcpFit({ view, icp, packet, researchState: st.research_state, footprintState: st.footprint_state, enriched, now });
    }
    return { raw, view, job: jobs[0] || null, jobs, packet, packet_meta: meta, ...st, icp, icp_fit: icpFit };
  }
}

module.exports = { LeadContextService };
