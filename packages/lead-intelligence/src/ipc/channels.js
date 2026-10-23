'use strict';

/**
 * Every IPC channel added by the lead-intelligence module.
 *
 * Naming follows ZTech's verified convention `domain:verb-kebab-case` (Step 0, #8),
 * domain = `lead-intel`. ZTech pins its channel list in tests (ipc-hygiene); adding these
 * requires updating that pinned list — with Zee's approval.
 *
 * Mode rules (config.research.mode):
 *   round1 (Option A): the four RESEARCH_* channels are NOT registered — round-1's own
 *                      `prospect-research:*` channels and panel run research.
 *   module:            all research channels are registered.
 * research-import-artifact takes NO path from the renderer; main opens the dialog.
 * email-send is registered ONLY when config.email.enabled === true and a provider exists.
 */
const CHANNELS = Object.freeze({
  RESEARCH_REQUEST: 'lead-intel:research-request',
  RESEARCH_IMPORT_ARTIFACT: 'lead-intel:research-import-artifact',
  RESEARCH_STATUS: 'lead-intel:research-status',
  RESEARCH_HISTORY: 'lead-intel:research-history',
  PROFILE_GET: 'lead-intel:profile-get',
  EVIDENCE_GET: 'lead-intel:evidence-get',
  CHANGES_LIST: 'lead-intel:changes-list',
  ICP_EVALUATE: 'lead-intel:icp-evaluate',
  SEARCHES_LIST: 'lead-intel:searches-list',
  SEARCHES_SAVE: 'lead-intel:searches-save',
  SEARCHES_DELETE: 'lead-intel:searches-delete',
  SEARCHES_RUN: 'lead-intel:searches-run',
  SEGMENTS_LIST: 'lead-intel:segments-list',
  SEGMENTS_SAVE: 'lead-intel:segments-save',
  SEGMENTS_DELETE: 'lead-intel:segments-delete',
  SEGMENTS_MEMBERS: 'lead-intel:segments-members',
  SEGMENTS_ADD_LEADS: 'lead-intel:segments-add-leads',
  SEGMENTS_REMOVE_LEADS: 'lead-intel:segments-remove-leads',
  AGENT_ANALYZE: 'lead-intel:agent-analyze',
  PITCH_GENERATE: 'lead-intel:pitch-generate',
  PITCH_GET: 'lead-intel:pitch-get',
  PITCH_UPDATE: 'lead-intel:pitch-update',
  OUTREACH_APPROVE: 'lead-intel:outreach-approve',
  OUTREACH_GATE: 'lead-intel:outreach-gate',
  EXPORT_RESEARCH: 'lead-intel:export-research',
  EMAIL_SEND: 'lead-intel:email-send',
  // Round 1 — enrichment
  ENRICHMENT_REQUEST: 'lead-intel:enrichment-request',
  ENRICHMENT_STATUS: 'lead-intel:enrichment-status',
  ENRICHMENT_PROFILE: 'lead-intel:enrichment-profile',
  ENRICHMENT_PROVIDERS: 'lead-intel:enrichment-providers',
});

const MODULE_ONLY_CHANNELS = Object.freeze([
  CHANNELS.RESEARCH_REQUEST, CHANNELS.RESEARCH_IMPORT_ARTIFACT, CHANNELS.RESEARCH_STATUS, CHANNELS.RESEARCH_HISTORY,
]);

module.exports = { CHANNELS, MODULE_ONLY_CHANNELS };
