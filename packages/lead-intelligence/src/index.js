'use strict';

/**
 * @zunitech/lead-intelligence - the public surface of the shared core.
 *
 * This package holds the Lead Intelligence domain and application logic that
 * has NO environment binding: no Electron, no file system, no child process,
 * no OS credential store. Everything that needs one of those stayed in the
 * desktop application, behind an adapter:
 *
 *   desktop-only (stayed behind)                why
 *   -------------------------------------------  ---------------------------------
 *   index.js                                     the composition root
 *   lead-intelligence-runtime.js                 the composition root
 *   integration/*                                wires the desktop wiring
 *   ipc/*, *-ipc.js                              the Electron IPC registrars that
 *                                                 depend on a desktop-bound module
 *   outreach/OutreachService.js                  electron + electron-store
 *   outreach/outreachSettings.js                 electron (safeStorage)
 *   outreach/email/resendConfig.js               the app's credential vault
 *   outreach/whatsapp/whatsappConfig.js         the app's credential vault
 *   opportunity/oiProviderConfig.js              electron (safeStorage)
 *   opportunity/OpportunityServiceSupervisor.js  child_process, fs, net
 *   opportunity/oi-config-ipc.js, oi-service-ipc.js  depend on the two above
 *   mailbox/MailboxService.js                    the local OAuth callback server
 *   mailbox/gmail/{GmailApi,GoogleOAuth}.js      the local OAuth callback server
 *   mailbox/mailboxPersistence.js                a persistence adapter
 *   persistence/SqlJsStore.js                    the SQLite adapter (M1 adds PG)
 *   persistence/atomicFile.js, migrations.js     the file system
 *   providers/transports/ArtifactImporter.js     the file system
 *
 * The public surface below is the contract the cloud service will use. The
 * desktop application reaches the same modules through the compatibility
 * shims in src/main/lead-intelligence/, so there is exactly ONE implementation
 * of the intelligence engine.
 */

// --- core: ids, validation, urls, errors, safe objects ----------------------
const core = {
  errors: require('./core/errors'),
  ids: require('./core/ids'),
  objects: require('./core/objects'),
  urls: require('./core/urls'),
  validate: require('./core/validate'),
};

// --- the evidence contract ---------------------------------------------------
const contracts = {
  constants: require('./contracts/constants'),
  evidencePacket: require('./contracts/evidencePacket'),
  leadView: require('./contracts/leadView'),
  provenance: require('./contracts/provenance'),
};

// --- ICP, the agent and the outreach gate ------------------------------------
const icp = { icpFit: require('./icp/icpFit'), IcpService: require('./icp/IcpService') };
const agent = { LeadAgent: require('./agent/LeadAgent'), sanitize: require('./agent/sanitize') };
const outreach = {
  OutreachGate: require('./outreach/OutreachGate'),
  PitchGenerator: require('./outreach/PitchGenerator'),
  businessProfile: require('./outreach/businessProfile'),
};

// --- research ----------------------------------------------------------------
const research = {
  FreshnessPolicy: require('./research/FreshnessPolicy'),
  ProspectIntelligenceGateway: require('./research/ProspectIntelligenceGateway'),
  ResearchCoordinator: require('./research/ResearchCoordinator'),
  Round1ResearchBridge: require('./research/Round1ResearchBridge'),
  changeDetection: require('./research/changeDetection'),
  digitalFootprint: require('./research/digitalFootprint'),
  researchState: require('./research/researchState'),
  signals: require('./research/signals'),
  stateMachine: require('./research/stateMachine'),
  round1PacketMapper: require('./round1PacketMapper'),
};

// --- trust, consent and suppression ------------------------------------------
const trust = {
  TrustPolicy: require('./trust/TrustPolicy'),
  TrustService: require('./trust/TrustService'),
  trustContract: require('./trust/trustContract'),
  unsubscribe: require('./trust/unsubscribe'),
  relaySignature: require('./trust/relaySignature'),
};

// --- mailboxes, sequences, replies, enrichment, search, profile ---------------
const mailbox = {
  mailboxContract: require('./mailbox/mailboxContract'),
  pacing: require('./mailbox/pacing'),
};
const sequences = {
  sequenceContract: require('./sequences/sequenceContract'),
  SequenceService: require('./sequences/SequenceService'),
  SequenceScheduler: require('./sequences/SequenceScheduler'),
};
const replies = {
  replyRouteContract: require('./replies/replyRouteContract'),
  replyRules: require('./replies/replyRules'),
  ReplyRouterService: require('./replies/ReplyRouterService'),
};
const enrichment = {
  catalog: require('./enrichment/catalog'),
  selection: require('./enrichment/selection'),
  registry: require('./enrichment/registry'),
  EnrichmentProvider: require('./enrichment/EnrichmentProvider'),
  EnrichmentService: require('./enrichment/EnrichmentService'),
  EvidencePacketEnrichmentProvider: require('./enrichment/EvidencePacketEnrichmentProvider'),
  FakeEnrichmentProvider: require('./enrichment/FakeEnrichmentProvider'),
};
const search = {
  filters: require('./search/filters'),
  LeadContextService: require('./search/LeadContextService'),
  SearchServices: require('./search/SearchServices'),
};
const profile = { ProfileService: require('./profile/ProfileService') };
const exportService = { ResearchExport: require('./export/ResearchExport') };
const timeline = { LeadTimeline: require('./timeline/LeadTimeline') };

// --- the ZuniSEO integration (the anti-corruption layer) ---------------------
const providers = {
  envelopeMapper: require('./providers/envelopeMapper'),
  ProspectResearchProvider: require('./providers/ProspectResearchProvider'),
  ZuniSeoProvider: require('./providers/ZuniSeoProvider'),
  transports: {
    common: require('./providers/transports/common'),
    McpTransport: require('./providers/transports/McpTransport'),
    RestTransport: require('./providers/transports/RestTransport'),
  },
};

// --- the persistence CONTRACT (the SQLite adapter stays in the app) ---------
const persistence = { contract: require('./persistence/contract') };

// --- the opportunity intelligence integration --------------------------------
// The public surface mirrors the original module index exactly, so nothing
// changes meaning. The freshness policy and the refresh ledger are reachable
// through their explicit paths but are NOT re-exported here: the freshness
// policy must not appear in a module that an outreach or gate module could
// reach.
const opportunity = {
  oiContract: require('./opportunity/oiContract'),
  OpportunityAssociationStore: require('./opportunity/OpportunityAssociationStore'),
  OpportunityIntelligenceGateway: require('./opportunity/OpportunityIntelligenceGateway'),
  OpportunityIntelligenceService: require('./opportunity/OpportunityIntelligenceService'),
  OpportunityReadModel: require('./opportunity/OpportunityReadModel'),
  PitchEvidenceBridge: require('./opportunity/PitchEvidenceBridge'),
};

module.exports = {
  core,
  contracts,
  icp,
  agent,
  outreach,
  research,
  trust,
  mailbox,
  sequences,
  replies,
  enrichment,
  search,
  profile,
  exportService,
  timeline,
  providers,
  persistence,
  opportunity,

  // The most-used entry points are also exposed at the top level, so a
  // consumer does not have to know which area a helper lives in.
  buildEvidencePacket: contracts.evidencePacket.buildEvidencePacket,
  validateEvidencePacket: contracts.evidencePacket.validateEvidencePacket,
  indexPacket: contracts.evidencePacket.indexPacket,
  summarizePacket: contracts.evidencePacket.summarizePacket,
  PACKET_SCHEMA: contracts.evidencePacket.PACKET_SCHEMA,
  evaluateOutreachGate: outreach.OutreachGate.evaluateOutreachGate,
  mapZuniSeoEnvelope: providers.envelopeMapper.mapZuniSeoEnvelope,
  sendIdempotencyKey: persistence.contract.sendIdempotencyKey,
  evaluateIcpFit: icp.icpFit.evaluateIcpFit,
  targetToIcp: icp.icpFit.targetToIcp,
};
