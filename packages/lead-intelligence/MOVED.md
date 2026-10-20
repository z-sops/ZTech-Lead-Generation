# Moved modules (M0)

These modules moved from `src/main/lead-intelligence/` to
`packages/lead-intelligence/src/` (the package
`@zunitech/lead-intelligence`). Every original path keeps a
compatibility shim that re-exports the package, so nothing that requires
them changed, and there is still exactly ONE implementation of the
intelligence engine.

The package's public entry point, `src/index.js`, is NEW: it is the export
surface the cloud service will use, and it mirrors the original module
index exactly.

- `agent/LeadAgent.js`
- `agent/sanitize.js`
- `contracts/constants.js`
- `contracts/evidencePacket.js`
- `contracts/leadView.js`
- `contracts/provenance.js`
- `core/errors.js`
- `core/ids.js`
- `core/objects.js`
- `core/urls.js`
- `core/validate.js`
- `enrichment/EnrichmentProvider.js`
- `enrichment/EnrichmentService.js`
- `enrichment/EvidencePacketEnrichmentProvider.js`
- `enrichment/FakeEnrichmentProvider.js`
- `enrichment/catalog.js`
- `enrichment/registry.js`
- `enrichment/selection.js`
- `export/ResearchExport.js`
- `icp/IcpService.js`
- `icp/icpFit.js`
- `ipc/channels.js`
- `ipc/preloadBridge.js`
- `ipc/registerLeadIntelligenceIpc.js`
- `ipc/schemas.js`
- `mailbox/gmail/GmailMailboxTransport.js`
- `mailbox/gmail/rfc2822.js`
- `mailbox/graph/GraphMailboxTransport.js`
- `mailbox/mailbox-ipc.js`
- `mailbox/mailboxContract.js`
- `mailbox/pacing.js`
- `opportunity/OpportunityAssociationStore.js`
- `opportunity/OpportunityIntelligenceGateway.js`
- `opportunity/OpportunityIntelligenceService.js`
- `opportunity/OpportunityReadModel.js`
- `opportunity/OpportunityRefreshLedger.js`
- `opportunity/PitchEvidenceBridge.js`
- `opportunity/index.js`
- `opportunity/oiContract.js`
- `opportunity/oiFreshness.js`
- `opportunity/opportunity-ipc.js`
- `outreach-ipc.js`
- `outreach/OutreachGate.js`
- `outreach/PitchGenerator.js`
- `outreach/businessProfile.js`
- `outreach/email/EmailProvider.js`
- `outreach/email/FakeEmailProvider.js`
- `outreach/email/ResendEmailProvider.js`
- `outreach/email/sendConfig.js`
- `outreach/whatsapp/MetaCloudWhatsAppProvider.js`
- `outreach/whatsapp/WhatsAppProvider.js`
- `outreach/whatsapp/sendConfig.js`
- `persistence/MemoryStore.js`
- `persistence/contract.js`
- `persistence/mailboxRepos.js`
- `persistence/replyRouteRepos.js`
- `persistence/sequenceRepos.js`
- `persistence/trustRepos.js`
- `profile/ProfileService.js`
- `providers/FakeResearchProvider.js`
- `providers/ProspectResearchProvider.js`
- `providers/ZuniSeoProvider.js`
- `providers/envelopeMapper.js`
- `providers/transports/McpTransport.js`
- `providers/transports/RestTransport.js`
- `providers/transports/common.js`
- `replies/ReplyRouterService.js`
- `replies/reply-router-ipc.js`
- `replies/replyRouteContract.js`
- `replies/replyRules.js`
- `research/FreshnessPolicy.js`
- `research/ProspectIntelligenceGateway.js`
- `research/ResearchCoordinator.js`
- `research/Round1ResearchBridge.js`
- `research/changeDetection.js`
- `research/digitalFootprint.js`
- `research/researchState.js`
- `research/signals.js`
- `research/stateMachine.js`
- `round1PacketMapper.js`
- `search/LeadContextService.js`
- `search/SearchServices.js`
- `search/filters.js`
- `sequences/SequenceScheduler.js`
- `sequences/SequenceService.js`
- `sequences/sequence-ipc.js`
- `sequences/sequenceContract.js`
- `timeline/LeadTimeline.js`
- `timeline/timeline-ipc.js`
- `trust/RelayClient.js`
- `trust/TrustPolicy.js`
- `trust/TrustService.js`
- `trust/relaySignature.js`
- `trust/trust-ipc.js`
- `trust/trustContract.js`
- `trust/unsubscribe.js`
