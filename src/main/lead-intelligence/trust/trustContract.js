'use strict';

/**
 * F26.5 Compliance & Trust Foundation - the ONE definition of the trust vocabulary.
 *
 * Both stores (SqlJsStore and MemoryStore), the send boundary, the event intake and the IPC
 * schemas read these lists, so a value can never be legal in one place and illegal in another.
 * The same lists appear as CHECK constraints in migrations/008_trust_foundation.sql; a test
 * asserts the two agree.
 *
 * Pure module: no I/O, no clock, no store.
 */

const { EMAIL, toE164 } = require('../contracts/leadView');

const TRUST_CHANNELS = Object.freeze(['email', 'whatsapp']);
const SUPPRESSION_SCOPES = Object.freeze(['workspace', 'global']);
const SUPPRESSION_REASONS = Object.freeze(['unsubscribe', 'bounce', 'complaint', 'manual']);
// F26.6: + 'mailbox' (an unsubscribe reply read from a connected mailbox; migration 010).
const SUPPRESSION_SOURCES = Object.freeze(['user', 'relay', 'import', 'mailbox']);
const CONSENT_METHODS = Object.freeze(['inbound_message', 'website_form', 'in_person', 'other']);
const CONSENT_SOURCES = Object.freeze(['user', 'relay']);
const PROVENANCE_FIELDS = Object.freeze(['email', 'phone', 'website']);
const PROVENANCE_SOURCE_KINDS = Object.freeze(['collection_run', 'import', 'manual', 'enrichment', 'unknown']);
const TRUST_EVENT_KINDS = Object.freeze(['unsubscribe', 'bounce', 'complaint', 'reply', 'whatsapp_inbound']);
// F26.6: 'mailbox' = read from a connected mailbox by the main-process sync (verified replies
// and unsubscribe replies only). Never entered by a user.
const TRUST_EVENT_SOURCES = Object.freeze(['relay', 'user', 'mailbox']);
const TRUST_EVENT_STATES = Object.freeze(['applied', 'stored', 'unresolved', 'rejected']);

/** One install is one workspace today. The column exists so a multi-workspace build needs no migration. */
const DEFAULT_WORKSPACE_ID = 'local';

const TRUST_LIMITS = Object.freeze({
  EVIDENCE_NOTE_MAX: 500,
  RECORDED_BY_MAX: 80,
  SOURCE_REF_MAX: 300,
  EVENT_ID_MAX: 128,
  RECIPIENT_REF_MAX: 128,
  // Meta's customer-service window opened by the person's own message.
  WHATSAPP_SESSION_MS: 24 * 60 * 60 * 1000,
});

const EVENT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const RECIPIENT_REF_RE = /^rref_[a-f0-9]{32,64}$/;

/** Lower-cased, trimmed email, or null when it is not a syntactically valid address. */
function normalizeEmail(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  return EMAIL.test(s) ? s : null;
}

/** E.164 phone, or null. The same toE164 the WhatsApp send boundary uses, so a match is exact. */
function normalizePhone(raw) {
  return toE164(typeof raw === 'string' ? raw : null);
}

/** Normalize an address for one channel, or null. */
function normalizeAddress(channel, raw) {
  if (channel === 'email') return normalizeEmail(raw);
  if (channel === 'whatsapp') return normalizePhone(raw);
  return null;
}

/** Single-line bounded text with control characters removed; '' when not a string. */
function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// A UTC timestamp exactly as Date#toISOString writes it. A zone-less value would be read in
// local time and shift windows (for example the 24h WhatsApp session), so it is refused.
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
function isIso(value) {
  return typeof value === 'string' && ISO_UTC_RE.test(value) && Number.isFinite(Date.parse(value));
}

function fail(error) { return { ok: false, error }; }

function normalizeSuppressionRecord(rec) {
  if (!rec || typeof rec !== 'object') return fail('suppression: record');
  if (typeof rec.suppression_id !== 'string' || !rec.suppression_id) return fail('suppression: suppression_id');
  if (!SUPPRESSION_SCOPES.includes(rec.scope)) return fail('suppression: scope');
  const workspaceId = rec.scope === 'global' ? null : (typeof rec.workspace_id === 'string' && rec.workspace_id ? rec.workspace_id : null);
  if (rec.scope === 'workspace' && !workspaceId) return fail('suppression: workspace_id');
  if (rec.scope === 'global' && rec.workspace_id != null) return fail('suppression: global rows carry no workspace_id');
  if (!TRUST_CHANNELS.includes(rec.channel)) return fail('suppression: channel');
  const address = normalizeAddress(rec.channel, rec.normalized_address);
  if (!address) return fail('suppression: address');
  if (!SUPPRESSION_REASONS.includes(rec.reason)) return fail('suppression: reason');
  if (!SUPPRESSION_SOURCES.includes(rec.source)) return fail('suppression: source');
  if (!isIso(rec.created_at)) return fail('suppression: created_at');
  return {
    ok: true,
    value: {
      suppression_id: rec.suppression_id, scope: rec.scope, workspace_id: workspaceId, channel: rec.channel,
      normalized_address: address, reason: rec.reason, source: rec.source, created_at: rec.created_at,
    },
  };
}

function normalizeConsentRecord(rec) {
  if (!rec || typeof rec !== 'object') return fail('consent: record');
  if (typeof rec.consent_id !== 'string' || !rec.consent_id) return fail('consent: consent_id');
  if (typeof rec.lead_id !== 'string' || !rec.lead_id) return fail('consent: lead_id');
  if (!TRUST_CHANNELS.includes(rec.channel)) return fail('consent: channel');
  const address = normalizeAddress(rec.channel, rec.normalized_address);
  if (!address) return fail('consent: address');
  if (!CONSENT_METHODS.includes(rec.method)) return fail('consent: method');
  const note = cleanText(rec.evidence_note, TRUST_LIMITS.EVIDENCE_NOTE_MAX);
  if (!note) return fail('consent: evidence_note');
  const by = cleanText(rec.recorded_by, TRUST_LIMITS.RECORDED_BY_MAX);
  if (!by) return fail('consent: recorded_by');
  if (!isIso(rec.consented_at)) return fail('consent: consented_at');
  if (!isIso(rec.recorded_at)) return fail('consent: recorded_at');
  if (!CONSENT_SOURCES.includes(rec.source)) return fail('consent: source');
  const eventId = rec.event_id == null ? null : String(rec.event_id);
  if (eventId !== null && !EVENT_ID_RE.test(eventId)) return fail('consent: event_id');
  return {
    ok: true,
    value: {
      consent_id: rec.consent_id, lead_id: rec.lead_id, channel: rec.channel, normalized_address: address,
      method: rec.method, evidence_note: note, recorded_by: by, consented_at: rec.consented_at,
      recorded_at: rec.recorded_at, source: rec.source, event_id: eventId,
    },
  };
}

function normalizeProvenanceRecord(rec) {
  if (!rec || typeof rec !== 'object') return fail('provenance: record');
  if (typeof rec.lead_id !== 'string' || !rec.lead_id) return fail('provenance: lead_id');
  if (!PROVENANCE_FIELDS.includes(rec.field)) return fail('provenance: field');
  if (!PROVENANCE_SOURCE_KINDS.includes(rec.source_kind)) return fail('provenance: source_kind');
  const ref = rec.source_ref == null ? null : cleanText(rec.source_ref, TRUST_LIMITS.SOURCE_REF_MAX) || null;
  if (rec.collected_at != null && !isIso(rec.collected_at)) return fail('provenance: collected_at');
  if (!isIso(rec.recorded_at)) return fail('provenance: recorded_at');
  // "unknown" is a statement that nothing is known: it may not carry an invented date or ref.
  if (rec.source_kind === 'unknown' && (ref !== null || rec.collected_at != null)) return fail('provenance: unknown carries no ref or date');
  return {
    ok: true,
    value: {
      lead_id: rec.lead_id, field: rec.field, source_kind: rec.source_kind, source_ref: ref,
      collected_at: rec.collected_at == null ? null : rec.collected_at, backfilled: rec.backfilled === true ? 1 : 0,
      recorded_at: rec.recorded_at,
    },
  };
}

function normalizeTrustEventRecord(rec) {
  if (!rec || typeof rec !== 'object') return fail('trust event: record');
  if (typeof rec.row_id !== 'string' || !rec.row_id) return fail('trust event: row_id');
  if (typeof rec.event_id !== 'string' || !EVENT_ID_RE.test(rec.event_id)) return fail('trust event: event_id');
  if (!TRUST_EVENT_KINDS.includes(rec.kind)) return fail('trust event: kind');
  if (!TRUST_CHANNELS.includes(rec.channel)) return fail('trust event: channel');
  if (rec.kind === 'whatsapp_inbound' && rec.channel !== 'whatsapp') return fail('trust event: whatsapp_inbound is a whatsapp event');
  const ref = rec.recipient_ref == null ? null : String(rec.recipient_ref);
  if (ref !== null && !RECIPIENT_REF_RE.test(ref)) return fail('trust event: recipient_ref');
  const address = rec.normalized_address == null ? null : normalizeAddress(rec.channel, rec.normalized_address);
  if (rec.normalized_address != null && !address) return fail('trust event: address');
  if (!TRUST_EVENT_SOURCES.includes(rec.source)) return fail('trust event: source');
  if (!TRUST_EVENT_STATES.includes(rec.state)) return fail('trust event: state');
  const rejectCode = rec.reject_code == null ? null : cleanText(rec.reject_code, 64) || null;
  if ((rec.state === 'rejected') !== (rejectCode !== null)) return fail('trust event: reject_code goes with rejected only');
  if (!isIso(rec.received_at)) return fail('trust event: received_at');
  if (!isIso(rec.recorded_at)) return fail('trust event: recorded_at');
  return {
    ok: true,
    value: {
      row_id: rec.row_id, event_id: rec.event_id, kind: rec.kind, channel: rec.channel, recipient_ref: ref,
      normalized_address: address, source: rec.source, state: rec.state, reject_code: rejectCode,
      received_at: rec.received_at, recorded_at: rec.recorded_at,
    },
  };
}

function normalizeRecipientRefRecord(rec) {
  if (!rec || typeof rec !== 'object') return fail('recipient ref: record');
  if (typeof rec.recipient_ref !== 'string' || !RECIPIENT_REF_RE.test(rec.recipient_ref)) return fail('recipient ref: recipient_ref');
  if (!TRUST_CHANNELS.includes(rec.channel)) return fail('recipient ref: channel');
  const address = normalizeAddress(rec.channel, rec.normalized_address);
  if (!address) return fail('recipient ref: address');
  if (!isIso(rec.created_at)) return fail('recipient ref: created_at');
  return { ok: true, value: { recipient_ref: rec.recipient_ref, channel: rec.channel, normalized_address: address, created_at: rec.created_at } };
}

/** Throw a typed validation error for a store write that fails its contract. */
function requireValid(result) {
  if (result.ok) return result.value;
  const { ValidationError } = require('../core/errors');
  throw new ValidationError('Invalid trust record', [{ path: '$', message: result.error }]);
}

module.exports = {
  TRUST_CHANNELS,
  SUPPRESSION_SCOPES,
  SUPPRESSION_REASONS,
  SUPPRESSION_SOURCES,
  CONSENT_METHODS,
  CONSENT_SOURCES,
  PROVENANCE_FIELDS,
  PROVENANCE_SOURCE_KINDS,
  TRUST_EVENT_KINDS,
  TRUST_EVENT_SOURCES,
  TRUST_EVENT_STATES,
  DEFAULT_WORKSPACE_ID,
  TRUST_LIMITS,
  EVENT_ID_RE,
  RECIPIENT_REF_RE,
  normalizeEmail,
  normalizePhone,
  normalizeAddress,
  cleanText,
  isIso,
  normalizeSuppressionRecord,
  normalizeConsentRecord,
  normalizeProvenanceRecord,
  normalizeTrustEventRecord,
  normalizeRecipientRefRecord,
  requireValid,
};
