'use strict';

const { OpportunityIntelligenceService } = require('./OpportunityIntelligenceService');
const { OpportunityIntelligenceGateway, DEFAULT_CONFIG, ROUTES } = require('./OpportunityIntelligenceGateway');
const { OpportunityAssociationStore, MIGRATION_NEED } = require('./OpportunityAssociationStore');
const { buildOpportunityReadModel, summariseReadModel } = require('./OpportunityReadModel');
const {
  buildPitchEvidenceBridge, CLAIM_KIND_TO_BASIS, isPitchEligible, basisFor,
} = require('./PitchEvidenceBridge');
const {
  CHANNELS, INPUT_SCHEMAS, registerOpportunityIpc, registerUnavailableOpportunityIpc,
} = require('./opportunity-ipc');
const oiContract = require('./oiContract');

/**
 * Composition root for Opportunity Intelligence inside ZTech.
 *
 * Deliberately separate from `lead-intelligence/index.js`, which is the Zuni-SEO
 * composition root. OI is constructed here, wired here and can be absent without
 * the Zuni-SEO root ever noticing.
 *
 * @param {object} input
 * @param {object} [input.config] { enabled, baseUrl, timeoutMs, healthTimeoutMs, allowLocalhost, maxCompetitors }
 * @param {Function} [input.fetchImpl]
 * @param {object} [input.leadSource] anything with .get(leadId) -> lead view
 * @returns {{service, gateway, associations, migration, start, stop, registerIpc}}
 */
function createOpportunityIntelligence({ config = {}, fetchImpl, clock, logger, gateway, associationBacking = null, refreshBacking = null } = {}) {
  const resolved = {
    enabled: config.enabled !== undefined ? Boolean(config.enabled) : DEFAULT_CONFIG.enabled,
    baseUrl: config.baseUrl === undefined ? DEFAULT_CONFIG.baseUrl : String(config.baseUrl),
    timeoutMs: config.timeoutMs === undefined ? DEFAULT_CONFIG.timeoutMs : Number(config.timeoutMs),
    healthTimeoutMs: config.healthTimeoutMs === undefined ? DEFAULT_CONFIG.healthTimeoutMs : Number(config.healthTimeoutMs),
    // Loopback is the default posture: a remote OI host must be opted into, and
    // even then validateServiceBaseUrl will refuse it unless it is HTTPS.
    allowLocalhost: config.allowLocalhost === undefined ? DEFAULT_CONFIG.allowLocalhost : Boolean(config.allowLocalhost),
    maxCompetitors: config.maxCompetitors === undefined ? DEFAULT_CONFIG.maxCompetitors : Number(config.maxCompetitors),
  };

  const service = new OpportunityIntelligenceService({ config: resolved, fetchImpl, clock, logger, gateway, associationBacking, refreshBacking });

  return {
    service,
    gateway: service.gateway,
    associations: service.associations,
    config: resolved,
    migration: MIGRATION_NEED,
    async start() { return service.start(); },
    async stop() { await service.associations.flush(); return service.stop(); },
    /** Load persisted lead <-> research associations (migration 006). Never throws. */
    async loadAssociations() { return service.associations.load(); },
    registerIpc({ ipcMain, isTrustedSender, leadSource, logger: lg }) {
      if (!service.enabled) {
        return registerUnavailableOpportunityIpc({
          ipcMain,
          isTrustedSender,
          reason: service.healthView().message || 'Opportunity Intelligence is disabled.',
          logger: lg || logger,
        });
      }
      return registerOpportunityIpc({ ipcMain, opportunity: service, isTrustedSender, leadSource, logger: lg || logger });
    },
  };
}

module.exports = {
  createOpportunityIntelligence,
  OpportunityIntelligenceService,
  OpportunityIntelligenceGateway,
  OpportunityAssociationStore,
  buildOpportunityReadModel,
  summariseReadModel,
  buildPitchEvidenceBridge,
  CLAIM_KIND_TO_BASIS,
  isPitchEligible,
  basisFor,
  OI_CHANNELS: CHANNELS,
  OI_INPUT_SCHEMAS: INPUT_SCHEMAS,
  registerOpportunityIpc,
  registerUnavailableOpportunityIpc,
  MIGRATION_NEED,
  OI_ROUTES: ROUTES,
  OI_DEFAULT_CONFIG: DEFAULT_CONFIG,
  oiContract,
};