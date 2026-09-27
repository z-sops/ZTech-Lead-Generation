'use strict';

const { S } = require('../core/validate');
const { FILTER_SCHEMA } = require('../search/filters');
const { CHANNELS: C } = require('./channels');
const { FIELD_NAMES } = require('../enrichment/catalog');

/**
 * Input schemas for every channel. Validated in the MAIN process before any service
 * call. additionalProperties:false everywhere, so the renderer cannot smuggle extra
 * fields (paths, URLs, provider ids, credentials).
 */
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const leadIdList = { type: 'array', minItems: 1, maxItems: 1000, items: S.leadId };
const targetId = S.leadId;

const INPUT_SCHEMAS = Object.freeze({
  [C.RESEARCH_REQUEST]: obj({ leadId: S.leadId, force: { type: 'boolean' } }, ['leadId']),
  [C.RESEARCH_IMPORT_ARTIFACT]: obj({ leadId: S.leadId }, ['leadId']),
  [C.RESEARCH_STATUS]: obj({ leadId: S.leadId }, ['leadId']),
  [C.RESEARCH_HISTORY]: obj({ leadId: S.leadId }, ['leadId']),
  [C.PROFILE_GET]: obj({ leadId: S.leadId, targetId }, ['leadId']),
  [C.EVIDENCE_GET]: obj({ leadId: S.leadId, packetId: S.id }, ['leadId']),
  [C.CHANGES_LIST]: obj({ leadId: S.leadId }, ['leadId']),
  [C.ICP_EVALUATE]: obj({ leadId: S.leadId, targetId }, ['leadId', 'targetId']),
  [C.SEARCHES_LIST]: obj({}),
  [C.SEARCHES_SAVE]: obj({ searchId: S.id, name: { type: 'string', minLength: 1, maxLength: 120 }, filter: FILTER_SCHEMA }, ['name', 'filter']),
  [C.SEARCHES_DELETE]: obj({ searchId: S.id }, ['searchId']),
  [C.SEARCHES_RUN]: { anyOf: [obj({ searchId: S.id }, ['searchId']), obj({ filter: FILTER_SCHEMA }, ['filter'])] },
  [C.SEGMENTS_LIST]: obj({}),
  [C.SEGMENTS_SAVE]: obj({ segmentId: S.id, name: { type: 'string', minLength: 1, maxLength: 120 }, kind: { type: 'string', enum: ['static', 'dynamic'] }, filter: FILTER_SCHEMA }, ['name', 'kind']),
  [C.SEGMENTS_DELETE]: obj({ segmentId: S.id }, ['segmentId']),
  [C.SEGMENTS_MEMBERS]: obj({ segmentId: S.id }, ['segmentId']),
  [C.SEGMENTS_ADD_LEADS]: obj({ segmentId: S.id, leadIds: leadIdList }, ['segmentId', 'leadIds']),
  [C.SEGMENTS_REMOVE_LEADS]: obj({ segmentId: S.id, leadIds: leadIdList }, ['segmentId', 'leadIds']),
  [C.AGENT_ANALYZE]: obj({ leadId: S.leadId, targetId, useLlm: { type: 'boolean' } }, ['leadId']),
  [C.PITCH_GENERATE]: obj({ leadId: S.leadId, targetId }, ['leadId']),
  [C.PITCH_GET]: obj({ leadId: S.leadId, pitchId: S.id }, ['leadId']),
  [C.PITCH_UPDATE]: obj({
    pitchId: S.id,
    subject: { type: 'string', maxLength: 150 },
    opening: { type: 'string', maxLength: 600 },
    valueProposition: { type: 'string', maxLength: 1200 },
    callToAction: { type: 'string', maxLength: 400 },
    removeObservations: { type: 'array', maxItems: 10, items: { type: 'integer', minimum: 0, maximum: 9 } },
  }, ['pitchId']),
  [C.OUTREACH_APPROVE]: obj({ pitchId: S.id }, ['pitchId']),
  [C.OUTREACH_GATE]: obj({ pitchId: S.id, channel: { type: 'string', enum: ['email'] } }, ['pitchId']),
  [C.EXPORT_RESEARCH]: obj({
    scope: {
      anyOf: [
        obj({ leadIds: leadIdList }, ['leadIds']),
        obj({ segmentId: S.id }, ['segmentId']),
        obj({ searchId: S.id }, ['searchId']),
      ],
    },
    format: { type: 'string', enum: ['csv', 'json'] },
    targetId,
  }, ['scope', 'format']),
  [C.EMAIL_SEND]: obj({ pitchId: S.id }, ['pitchId']),
  [C.ENRICHMENT_REQUEST]: obj({
    leadId: S.leadId,
    fields: { type: 'array', minItems: 1, maxItems: FIELD_NAMES.length, uniqueItems: true, items: { type: 'string', enum: FIELD_NAMES } },
    force: { type: 'boolean' },
  }, ['leadId']),
  [C.ENRICHMENT_STATUS]: obj({ leadId: S.leadId }, ['leadId']),
  [C.ENRICHMENT_PROFILE]: obj({ leadId: S.leadId }, ['leadId']),
  [C.ENRICHMENT_PROVIDERS]: obj({}),
});

/**
 * Output schemas (documentation + tests). Every response is wrapped as
 *   { ok: true, data } | { ok: false, error: { code, message, errors? } }
 */
const OUTPUT_SHAPES = Object.freeze({
  [C.RESEARCH_REQUEST]: '{ outcome: "started"|"already_active"|"fresh"|"blocked", job?: PublicJob, packet?: PacketSummary, reason?: {code,message} }',
  [C.RESEARCH_IMPORT_ARTIFACT]: '{ cancelled: true } | same as research:request',
  [C.RESEARCH_STATUS]: '{ lead_id, job: PublicJob|null, research_state, packet: PacketSummary|null, fresh, age_days, digital_footprint }',
  [C.RESEARCH_HISTORY]: '{ lead_id, jobs: PublicJob[], packets: PacketMeta[] }',
  [C.PROFILE_GET]: 'LeadResearchProfile (15 sections, see src/profile/ProfileService.js)',
  [C.EVIDENCE_GET]: 'EvidencePacket (website text sanitised) | null',
  [C.CHANGES_LIST]: '{ changes: ResearchChange[], signals: Signal[] }',
  [C.ICP_EVALUATE]: '{ fitStatus, reason, matchedCriteria[], unmetCriteria[], unknownCriteria[], exclusions[], evaluatedAt }',
  [C.SEARCHES_LIST]: 'SavedSearch[]',
  [C.SEARCHES_SAVE]: 'SavedSearch',
  [C.SEARCHES_DELETE]: '{ deleted: true }',
  [C.SEARCHES_RUN]: '{ search_id, total, evaluated_at, rows: ResultRow[] }',
  [C.SEGMENTS_LIST]: 'Segment[]',
  [C.SEGMENTS_SAVE]: 'Segment',
  [C.SEGMENTS_DELETE]: '{ deleted: true }',
  [C.SEGMENTS_MEMBERS]: '{ segment_id, kind, total, rows: ResultRow[], missing_lead_ids[], evaluated_at }',
  [C.SEGMENTS_ADD_LEADS]: '{ size }',
  [C.SEGMENTS_REMOVE_LEADS]: '{ size }',
  [C.AGENT_ANALYZE]: 'AgentResult { summary[], observations[], strengths[], opportunities[], missing_information[], pitch_angles[], outreach_prep, injection_flags[], llm? }',
  [C.PITCH_GENERATE]: 'PitchDraft',
  [C.PITCH_GET]: 'PitchDraft | null',
  [C.PITCH_UPDATE]: 'PitchDraft',
  [C.OUTREACH_APPROVE]: '{ approval_id, pitch_id, content_hash, approved_by, approved_at }',
  [C.OUTREACH_GATE]: '{ decision: "allowed"|"blocked", reasons[], warnings[], channel, pitch_id, packet_id, checkedAt }',
  [C.EXPORT_RESEARCH]: 'renderer-download: { mode, filename, mimeType, content, count } | save-dialog: { saved: boolean, count, filename }',
  [C.EMAIL_SEND]: '{ sent: boolean, messageId?, status?, gate }',
  [C.ENRICHMENT_REQUEST]: '{ outcome: "started"|"already_active"|"fresh"|"blocked", job?: EnrichmentJob, reason? }',
  [C.ENRICHMENT_STATUS]: '{ lead_id, job: EnrichmentJob|null }',
  [C.ENRICHMENT_PROFILE]: '{ lead_id, fields: {[field]: {status, conflict, stale, selected, alternatives, not_found_by}}, summary, latest_job, jobs, max_age_days }',
  [C.ENRICHMENT_PROVIDERS]: '{ id, name, state: READY|NOT_CONFIGURED|UNAVAILABLE, reason, fields, tier }[]',
});

module.exports = { INPUT_SCHEMAS, OUTPUT_SHAPES };
