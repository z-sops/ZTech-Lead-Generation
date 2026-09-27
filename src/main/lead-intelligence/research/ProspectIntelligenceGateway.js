'use strict';

const { NotFoundError } = require('../core/errors');
const { normalizeDomain } = require('../core/urls');
const { toLeadView, identityFromView } = require('../contracts/leadView');
const { summarizePacket } = require('../contracts/evidencePacket');
const { computeDigitalFootprint } = require('./digitalFootprint');
const { requestKeyFor } = require('./ResearchCoordinator');
const { effectiveState, publicJob } = require('./researchState');

/**
 * ProspectIntelligenceGateway — the single entry point for "research this lead".
 *
 * - Receives a ZTech lead id, loads the lead through the injected leadSource.
 * - Checks identity: a lead needs a name or website; research needs a website.
 * - Uses the domain ONLY when the lead already has one. It never searches for a domain
 *   and never fetches anything itself (no crawling in ZTech).
 * - Chooses the configured provider id; knows nothing about MCP/REST/files.
 * - Prevents duplicate research (active job wins) and skips research while evidence
 *   is fresh (unless force=true).
 * - Starts the job without waiting for the network (IPC stays responsive).
 *
 * leadSource (INTEGRATION POINT): { getLead(id): Promise<object|null>, listLeads(): Promise<object[]> }
 */
class ProspectIntelligenceGateway {
  constructor({ leadSource, store, coordinator, freshness, config = {}, clock = () => new Date(), fieldMap, limitedPageThreshold, logger = console }) {
    this.leadSource = leadSource;
    this.store = store;
    this.coordinator = coordinator;
    this.freshness = freshness;
    this.research = {
      providerId: 'zuni-seo',
      artifactProviderId: 'zuni-seo-artifact',
      tickIntervalMs: 10000,
      ...(config.research || {}),
    };
    this.clock = clock;
    this.fieldMap = fieldMap;
    this.limitedPageThreshold = limitedPageThreshold;
    this.logger = logger;
    this._kicks = new Set();
    this._timer = null;
  }

  async loadLead(leadId) {
    const raw = await this.leadSource.getLead(leadId);
    if (!raw) throw new NotFoundError('Lead', leadId);
    return { raw, view: toLeadView(raw, this.fieldMap) };
  }

  /** Used by the coordinator when it builds a packet. */
  async identityForLead(leadId) {
    try {
      const { view } = await this.loadLead(leadId);
      return { identity: identityFromView(view), view };
    } catch (e) {
      if (e instanceof NotFoundError) return { identity: null, view: null };
      throw e;
    }
  }

  static identityCheck(view) {
    const missing = [];
    if (!view.name && !view.website) missing.push('name_or_website');
    return { ok: missing.length === 0, missing };
  }

  /**
   * @returns {Promise<{outcome: 'started'|'already_active'|'fresh'|'blocked', job?: object, packet?: object, reason?: {code:string,message:string}}>}
   */
  async requestResearch({ leadId, force = false, providerId, options = {} }) {
    const { view } = await this.loadLead(leadId);
    const pid = providerId || this.research.providerId;

    const idc = ProspectIntelligenceGateway.identityCheck(view);
    if (!idc.ok) {
      return this._blocked(view.id, pid, null, 'INSUFFICIENT_IDENTITY', 'The lead has neither a name nor a website. Add at least one before research.');
    }
    if (!view.website) {
      return this._blocked(view.id, pid, null, 'NO_DOMAIN',
        'No website is recorded for this lead. ZTech does not search the web for websites; add the website to the lead first.');
    }
    const domain = normalizeDomain(view.website);
    if (!domain.ok) {
      return this._blocked(view.id, pid, null, 'INVALID_DOMAIN', `The lead's website cannot be researched (${domain.reason}).`);
    }
    if (!this.coordinator.providers.has(pid)) {
      return this._blocked(view.id, pid, domain, 'PROVIDER_NOT_CONFIGURED', 'The research provider is not configured.');
    }

    const active = await this.store.jobs.findActive(requestKeyFor(view.id, domain.key, pid));
    if (active) return { outcome: 'already_active', job: active };

    if (!force) {
      const latest = await this.store.packets.latestForLead(view.id);
      if (latest && this.freshness.isFresh(latest, this.clock()) && normalizeDomain(latest.requested_domain).key === domain.key) {
        return { outcome: 'fresh', packet: summarizePacket(latest) };
      }
    }

    const { job, created } = await this.coordinator.createJob({ leadId: view.id, providerId: pid, domain, options });
    if (!created) return { outcome: 'already_active', job };
    this._kick(job.job_id);
    return { outcome: 'started', job };
  }

  /** Import a Zuni-SEO envelope file the user selected in a main-process dialog. */
  async importArtifact({ leadId, artifactPath }) {
    return this.requestResearch({ leadId, force: true, providerId: this.research.artifactProviderId, options: { artifactPath } });
  }

  async _blocked(leadId, providerId, domain, code, message) {
    const job = await this.coordinator.createBlockedJob({ leadId, providerId, domain, code, message });
    return { outcome: 'blocked', job, reason: { code, message } };
  }

  _kick(jobId) {
    const p = this.coordinator.advance(jobId)
      .catch((e) => this.logger.error && this.logger.error(`[lead-intelligence] advance failed for ${jobId}: ${e && e.message}`))
      .finally(() => this._kicks.delete(p));
    this._kicks.add(p);
  }

  /** Wait for started jobs' first advance (tests, shutdown). */
  async idle() {
    while (this._kicks.size) await Promise.allSettled([...this._kicks]);
  }

  async getStatus(leadId) {
    const { view } = await this.loadLead(leadId);
    const jobs = await this.store.jobs.listByLead(view.id);
    const job = jobs[0] || null;
    const packet = await this.store.packets.latestForLead(view.id);
    const now = this.clock();
    const fresh = packet ? this.freshness.isFresh(packet, now) : false;
    const footprint = packet
      ? packet.digital_footprint
      : computeDigitalFootprint({ packet: null, leadView: view, limitedPageThreshold: this.limitedPageThreshold });
    return {
      lead_id: view.id,
      job: job ? publicJob(job) : null,
      research_state: effectiveState(job, packet, fresh),
      packet: summarizePacket(packet),
      fresh,
      age_days: packet ? this.freshness.ageDays(packet, now) : null,
      digital_footprint: footprint,
    };
  }

  async getHistory(leadId) {
    const { view } = await this.loadLead(leadId);
    const jobs = await this.store.jobs.listByLead(view.id);
    const packets = await this.store.packets.listMetaByLead(view.id);
    return { lead_id: view.id, jobs: jobs.map(publicJob), packets };
  }

  start() {
    if (this._timer) return;
    this.coordinator.recover().catch((e) => this.logger.error && this.logger.error(`[lead-intelligence] recovery failed: ${e && e.message}`));
    this._timer = setInterval(() => {
      this.coordinator.tick().catch((e) => this.logger.error && this.logger.error(`[lead-intelligence] tick failed: ${e && e.message}`));
    }, this.research.tickIntervalMs);
    if (this._timer.unref) this._timer.unref();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }
}

module.exports = { ProspectIntelligenceGateway, effectiveState, publicJob };
