'use strict';

const { FreshnessPolicy } = require('./research/FreshnessPolicy');
const { detectChanges } = require('./research/changeDetection');
const { deriveSignals } = require('./research/signals');
const { LeadContextService } = require('./search/LeadContextService');
const { SavedSearchService, SegmentService } = require('./search/SearchServices');
const { IcpService } = require('./icp/IcpService');
const { ProfileService } = require('./profile/ProfileService');
const { LeadAgent } = require('./agent/LeadAgent');
const { OutreachService } = require('./outreach/OutreachService');
const { ExportService } = require('./export/ResearchExport');
const { assertProvider } = require('./providers/ProspectResearchProvider');
const { Round1ResearchBridge } = require('./research/Round1ResearchBridge');
const { EnrichmentProviderRegistry } = require('./enrichment/registry');
const { EnrichmentService } = require('./enrichment/EnrichmentService');
const { EvidencePacketEnrichmentProvider } = require('./enrichment/EvidencePacketEnrichmentProvider');

/**
 * Composition root for the lead-intelligence module. Call ONCE in the Electron main
 * process after ZTech's database is open.
 *
 * @param {object} deps
 * @param {object} deps.store          SqlJsStore (production) or MemoryStore (tests)
 * @param {object} deps.leadSource     { getLead(id), listLeads() } over the existing Lead Library   (INTEGRATION POINT)
 * @param {object} deps.targetSource   { getTarget(id) } over the existing Target Builder            (INTEGRATION POINT)
 * @param {Map}    [deps.providers]    module mode only: Map<providerId, ProspectResearchProvider>
 * @param {object} [deps.round1]       round1 mode only: round-1 research port { getLatest, listByLead, listLatestPerLead }  (INTEGRATION POINT)
 *
 * config.research.mode:
 *   "round1" (Option A, ZTech default) — the existing round-1 prospect-research engine runs
 *            research; this module only converts its finished results into EvidencePackets.
 *            No coordinator, gateway, transports or research IPC are created.
 *   "module" — the module's own coordinator/gateway/transports (standalone use and tests).
 * @param {object} deps.config         see config/lead-intelligence.example.json
 * @param {Function} [deps.llmComplete] optional ({system,user,maxTokens}) => Promise<string>       (INTEGRATION POINT)
 * @param {object} [deps.emailProvider] optional EmailProvider (FakeEmailProvider in dev/tests only)
 * @param {object[]} [deps.enrichmentProviders] extra EnrichmentProvider instances (verified adapters or fakes)
 */
function createLeadIntelligence({ store, leadSource, targetSource = null, providers = new Map(), round1 = null, config = {}, clock = () => new Date(), logger = console, llmComplete = null, emailProvider = null, enrichmentProviders = [], round1ResultMapper = undefined }) {
  if (!store || !leadSource) throw new TypeError('store and leadSource are required');
  const research = config.research || {};
  const mode = research.mode || 'module';
  if (mode !== 'module' && mode !== 'round1') throw new TypeError(`config.research.mode must be "module" or "round1"`);

  const freshness = new FreshnessPolicy(config.freshness || {});
  const fieldMap = config.leadFieldMap;
  const limitedPageThreshold = research.limitedPageThreshold;

  let gateway = null;
  let coordinator = null;
  let bridge = null;
  if (mode === 'module') {
    if (!(providers instanceof Map)) throw new TypeError('providers (Map) is required in module mode');
    for (const p of providers.values()) assertProvider(p);
    // Lazy: in round1 mode these files are not even shipped.
    const { ResearchCoordinator } = require('./research/ResearchCoordinator');
    const { ProspectIntelligenceGateway } = require('./research/ProspectIntelligenceGateway');
    coordinator = new ResearchCoordinator({
      store,
      providers,
      freshness,
      clock,
      logger,
      identityForLead: (leadId) => gateway.identityForLead(leadId),
      onPacketStored: async ({ previous, packet }) => {
        if (!previous) return;
        const changes = detectChanges(previous, packet, { now: clock() });
        if (changes.length) await store.changes.insertMany(changes);
      },
      retry: research.retry,
      pollIntervalMs: research.pollIntervalMs,
      maxPollDurationMs: research.maxPollDurationMs,
      limitedPageThreshold,
    });
    gateway = new ProspectIntelligenceGateway({ leadSource, store, coordinator, freshness, config, clock, fieldMap, limitedPageThreshold, logger });
  } else {
    // A10: the Round-1 record -> ProviderResult mapping is an INJECTED mapper, so
    // the bridge holds no Round-1-specific knowledge. Left undefined, the bridge
    // uses its own default mapper.
    bridge = new Round1ResearchBridge({ round1, store, leadSource, freshness, fieldMap, recordPaths: research.round1RecordPaths, clock, logger, limitedPageThreshold, ...(round1ResultMapper ? { mapper: round1ResultMapper } : {}) });
  }

  const ecfg = config.enrichment || {};
  const enrichmentRegistry = new EnrichmentProviderRegistry({
    providers: [
      ...(ecfg.enableEvidenceProvider === false ? [] : [new EvidencePacketEnrichmentProvider({ store, freshness, clock })]),
      ...enrichmentProviders,
    ],
    order: ecfg.providerOrder || [],
  });
  const enrichment = new EnrichmentService({
    store,
    registry: enrichmentRegistry,
    leadSource,
    fieldMap,
    clock,
    logger,
    config: { maxAgeDays: ecfg.maxAgeDays, timeoutMs: ecfg.timeoutMs, maxProviderCalls: ecfg.maxProviderCalls, retry: ecfg.retry, ...(ecfg.defaultFields ? { defaultFields: ecfg.defaultFields } : {}) },
  });

  const contexts = new LeadContextService({
    leadSource, targetSource, store, freshness, fieldMap, targetFieldPaths: config.targetFieldPaths, enrichment, clock, logger,
    researchStates: bridge ? bridge.stateReader() : null,
    beforeLeadRead: bridge ? (leadId) => bridge.syncLead(leadId) : null,
  });
  const savedSearches = new SavedSearchService({ store, contexts, clock });
  const segments = new SegmentService({ store, contexts, leadSource, clock });
  const icp = new IcpService({ contexts });
  const profile = new ProfileService({ contexts, store, freshness, enrichment, clock });
  const agent = new LeadAgent({ complete: llmComplete, clock });
  const outreach = new OutreachService({ store, contexts, leadSource, freshness, config, emailProvider, fieldMap, clock });
  const exporter = new ExportService({ contexts, store, segments, savedSearches, freshness, clock });

  const agentService = {
    async analyze({ leadId, targetId, useLlm = false }) {
      const ctx = await contexts.getContext(leadId, { targetId });
      return agent.analyze({ view: ctx.view, packet: ctx.packet, icpFit: ctx.icp_fit, useLlm: Boolean(useLlm && llmComplete) });
    },
  };

  const research$ = {
    async changes({ leadId }) {
      const changes = await store.changes.listByLead(String(leadId));
      return { changes, signals: deriveSignals(changes) };
    },
    async sync({ leadId }) {
      if (!bridge) return { synced: false, reason: 'NOT_ROUND1_MODE' };
      return leadId === undefined ? bridge.syncAll() : bridge.syncLead(String(leadId));
    },
    async evidence({ leadId, packetId }) {
      if (bridge && !packetId) await bridge.syncLead(String(leadId));
      const packet = packetId ? await store.packets.get(packetId) : await store.packets.latestForLead(String(leadId));
      if (packet && packet.lead_id !== String(leadId)) return null;
      return packet;
    },
  };

  let enrichmentTimer = null;
  let bridgeTimer = null;
  const tickMs = research.tickIntervalMs || 10000;
  return {
    mode,
    freshness,
    coordinator,
    gateway,
    bridge,
    contexts,
    savedSearches,
    segments,
    icp,
    profile,
    agent: agentService,
    outreach,
    exporter,
    research: research$,
    enrichment,
    enrichmentRegistry,
    config,
    start: () => {
      if (gateway) gateway.start();
      if (bridge && !bridgeTimer) {
        bridge.syncAll().catch((e) => logger.error && logger.error(`[lead-intelligence] round-1 sync failed: ${e && e.message}`));
        bridgeTimer = setInterval(() => {
          bridge.syncAll().catch((e) => logger.error && logger.error(`[lead-intelligence] round-1 sync failed: ${e && e.message}`));
        }, tickMs);
        if (bridgeTimer.unref) bridgeTimer.unref();
      }
      if (!enrichmentTimer) {
        enrichment.recover().catch((e) => logger.error && logger.error(`[lead-intelligence] enrichment recovery failed: ${e && e.message}`));
        enrichmentTimer = setInterval(() => {
          enrichment.tick().catch((e) => logger.error && logger.error(`[lead-intelligence] enrichment tick failed: ${e && e.message}`));
        }, tickMs);
        if (enrichmentTimer.unref) enrichmentTimer.unref();
      }
    },
    stop: () => {
      if (gateway) gateway.stop();
      if (bridgeTimer) clearInterval(bridgeTimer);
      bridgeTimer = null;
      if (enrichmentTimer) clearInterval(enrichmentTimer);
      enrichmentTimer = null;
    },
  };
}

module.exports = { createLeadIntelligence };
