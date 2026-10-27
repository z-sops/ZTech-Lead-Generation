'use strict';

/**
 * The PostgreSQL dialect layer (M1).
 *
 * The desktop's sql.js store and this PostgreSQL store must produce the SAME
 * results for the same calls. Three things differ between the two engines,
 * and this module is where those differences are absorbed, so that the store
 * code above it stays identical in behaviour:
 *
 *   1. PLACEHOLDERS. SQLite uses `?`; PostgreSQL uses `$1, $2, ...`.
 *   2. TIMESTAMPS. SQLite keeps the caller's ISO string as TEXT and compares
 *      it lexicographically. PostgreSQL keeps a real TIMESTAMPTZ. The
 *      conversion is explicit in both directions: on the way in an ISO string
 *      becomes an instant, on the way out an instant becomes the SAME
 *      canonical string the desktop would have kept. A value that is not a
 *      valid instant is never guessed at: it becomes NULL and is reported as
 *      a corrupt value.
 *   3. JSON. SQLite keeps a JSON document as TEXT and parses it on read.
 *      PostgreSQL keeps it as JSONB. A document that cannot be read as an
 *      object is never trusted: the row is skipped and reported, exactly as
 *      the desktop store does.
 *
 * The boolean flags (0/1 in SQLite) become real BOOLEANs in PostgreSQL and
 * are converted back to 0/1 on the way out, so the application sees the same
 * value on both backends.
 */

const crypto = require('node:crypto');

/**
 * The reserved workspace of the PLATFORM. A global suppression belongs to
 * it, so a global row is never NULL-scoped and every key stays tenant-safe.
 */
const PLATFORM_WORKSPACE_ID = '00000000-0000-0000-0000-000000000000';

/** The canonical timestamp format: ISO-8601, UTC, milliseconds. */
function canonicalIso(value) {
  if (value === undefined || value === null || value === '') return null;
  const d = value instanceof Date ? value : new Date(String(value));
  const t = d.getTime();
  if (!Number.isFinite(t)) return null;
  return d.toISOString();
}

/**
 * The instant for a timestamp, or null when the value is not one.
 * @param {*} value
 * @returns {Date|null}
 */
function toInstant(value) {
  if (value === undefined || value === null || value === '') return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  const d = new Date(String(value));
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * Rewrite `?` placeholders into PostgreSQL's `$1, $2, ...`.
 *
 * A `?` inside a string literal is left alone, so a query that contains a
 * literal question mark is not corrupted.
 */
function rewritePlaceholders(sql) {
  let out = '';
  let index = 0;
  let quote = null;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    if (quote) {
      out += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '?') {
      index += 1;
      out += `$${index}`;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * The column types, per table, that the two engines represent differently.
 *
 *   ts    a timestamp: TEXT in SQLite, TIMESTAMPTZ in PostgreSQL
 *   json  a JSON document: TEXT in SQLite, JSONB in PostgreSQL
 *   bool  a 0/1 flag: INTEGER in SQLite, BOOLEAN in PostgreSQL
 */
const TYPES = Object.freeze({
  li_schema_migrations: { applied_at: 'ts' },
  li_research_jobs: {
    created_at: 'ts', updated_at: 'ts', started_at: 'ts', finished_at: 'ts', next_attempt_at: 'ts', options_json: 'json',
  },
  li_evidence_packets: {
    captured_at: 'ts', expires_at: 'ts', created_at: 'ts', packet_json: 'json',
  },
  li_research_changes: { detected_at: 'ts', change_json: 'json' },
  li_saved_searches: { created_at: 'ts', updated_at: 'ts', definition_json: 'json' },
  li_segments: { created_at: 'ts', updated_at: 'ts', definition_json: 'json' },
  li_segment_members: { added_at: 'ts' },
  li_pitch_drafts: { created_at: 'ts', updated_at: 'ts', draft_json: 'json' },
  li_outreach_approvals: { approved_at: 'ts' },
  li_outreach_activity: { created_at: 'ts', metadata_json: 'json' },
  li_outreach_sends: {
    created_at: 'ts', updated_at: 'ts',
  },
  li_enrichment_jobs: {
    created_at: 'ts', updated_at: 'ts', finished_at: 'ts', next_attempt_at: 'ts', fields_json: 'json', steps_json: 'json',
  },
  li_enrichment_observations: {
    collected_at: 'ts', first_seen_at: 'ts', value_json: 'json', provider_confidence_json: 'json',
  },
  li_oi_associations: { generated_at: 'ts', recorded_at: 'ts' },
  li_oi_refresh_requests: { created_at: 'ts', updated_at: 'ts' },
  li_suppressions: { created_at: 'ts' },
  li_job_queue: {
    created_at: 'ts', updated_at: 'ts', started_at: 'ts', finished_at: 'ts',
    next_attempt_at: 'ts', cancel_requested_at: 'ts',
    payload: 'json', result: 'json',
  },
  li_contact_consents: { consented_at: 'ts', recorded_at: 'ts' },
  li_contact_provenance: { collected_at: 'ts', recorded_at: 'ts', backfilled: 'bool' },
  li_trust_events: { received_at: 'ts', recorded_at: 'ts' },
  li_recipient_refs: { created_at: 'ts' },
  li_mailboxes: {
    paused_until: 'ts', connected_at: 'ts', updated_at: 'ts', is_default: 'bool', window_start: 'time', window_end: 'time',
  },
  li_mailbox_sent: { recorded_at: 'ts' },
  li_market_rules: { reviewed_at: 'ts' },
  li_reply_reviews: { reviewed_at: 'ts' },
  li_sequences: {
    first_accepted_at: 'ts', activated_at: 'ts', created_at: 'ts', updated_at: 'ts',
    resume_at: 'ts', replies_gap_at: 'ts',
  },
  li_sequence_steps: { due_at: 'ts', next_attempt_at: 'ts', sent_at: 'ts', updated_at: 'ts', draft_json: 'json' },
  li_sequence_events: { at: 'ts' },
  li_sequence_gaps: { gap_at: 'ts' },
  li_sequence_control: { updated_at: 'ts', paused: 'bool' },
  li_reply_routes: { routed_at: 'ts', confirmed_at: 'ts' },
});

/** The type of one column, or undefined. */
function columnType(table, column) {
  const t = TYPES[table];
  return t ? t[column] : undefined;
}

/**
 * Convert a value for the way in.
 * @returns {{value: *, corrupt: boolean}}
 */
function encodeValue(table, column, value) {
  const type = columnType(table, column);
  if (type === 'ts') {
    if (value === undefined || value === null || value === '') return { value: null, corrupt: false };
    const instant = toInstant(value);
    if (!instant) return { value: null, corrupt: true };
    return { value: instant, corrupt: false };
  }
  if (type === 'json') {
    if (value === undefined || value === null) return { value: null, corrupt: false };
    if (typeof value === 'string') {
      // A string is either a document that is already serialised, or a plain
      // string value (an address, a code). The first is kept, the second is
      // quoted - never dropped, never guessed.
      try {
        JSON.parse(value);
      } catch {
        return { value: JSON.stringify(value), corrupt: false };
      }
      return { value, corrupt: false };
    }
    try {
      return { value: JSON.stringify(value), corrupt: false };
    } catch {
      return { value: null, corrupt: true };
    }
  }
  if (type === 'bool') {
    if (value === undefined || value === null) return { value: null, corrupt: false };
    return { value: Boolean(value), corrupt: false };
  }
  if (type === 'time') {
    // A time of day: the desktop keeps it as 'HH:MM', and so does this.
    if (value === undefined || value === null || value === '') return { value: null, corrupt: false };
    const text = String(value);
    if (!/^\d{2}:\d{2}(:\d{2})?$/.test(text)) return { value: null, corrupt: true };
    return { value: text.slice(0, 5), corrupt: false };
  }
  return { value: value === undefined ? null : value, corrupt: false };
}

/**
 * Convert a value for the way out.
 * @returns {{value: *, corrupt: boolean}}
 */
function decodeValue(table, column, value) {
  const type = columnType(table, column);
  if (type === 'ts') {
    if (value === undefined || value === null) return { value: null, corrupt: false };
    const iso = canonicalIso(value);
    if (!iso) return { value: null, corrupt: true };
    return { value: iso, corrupt: false };
  }
  if (type === 'json') {
    if (value === undefined || value === null) return { value: null, corrupt: false };
    // The column is JSONB, so the driver has already read the document. A
    // string is a JSON string value (an address, a code) and is kept as it
    // is; a document is kept as a document.
    if (typeof value === 'object') return { value, corrupt: false };
    if (typeof value === 'string') {
      try {
        return { value: JSON.parse(value), corrupt: false };
      } catch {
        return { value, corrupt: false };
      }
    }
    return { value, corrupt: false };
  }
  if (type === 'bool') {
    if (value === undefined || value === null) return { value: null, corrupt: false };
    return { value: value ? 1 : 0, corrupt: false };
  }
  if (type === 'time') {
    if (value === undefined || value === null) return { value: null, corrupt: false };
    const text = String(value);
    if (!/^\d{2}:\d{2}(:\d{2})?$/.test(text)) return { value: null, corrupt: true };
    return { value: text.slice(0, 5), corrupt: false };
  }
  return { value: value === undefined ? null : value, corrupt: false };
}

/**
 * Is this PostgreSQL error a unique violation?
 * @param {Error} err
 */
function isUniqueViolation(err) {
  return Boolean(err) && err.code === '23505';
}

/**
 * The name of the index that was violated, for a unique violation.
 * @param {Error} err
 */
function violatedConstraint(err) {
  return err && err.constraint ? String(err.constraint) : '';
}

module.exports = {
  PLATFORM_WORKSPACE_ID,
  canonicalIso,
  toInstant,
  rewritePlaceholders,
  TYPES,
  columnType,
  encodeValue,
  decodeValue,
  isUniqueViolation,
  violatedConstraint,
  crypto,
};
