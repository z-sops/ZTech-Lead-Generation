'use strict';

/**
 * Embedded copies of migrations/*.sql so the module works when bundled into a single
 * CommonJS file (no fs reads at runtime). test/migrations.test.js asserts that each
 * embedded string is byte-identical to its .sql file. Regenerate with:
 *   node scripts/embed-migrations.js
 */

const fs = require('fs');
const path = require('path');

const MIGRATION_001 = `-- ZTech lead-intelligence schema, migration 001.
-- Runs inside ZTech's EXISTING sql.js database (same file). No second database.
-- All tables are prefixed li_ so they cannot collide with existing ZTech tables.
-- No foreign keys to the existing leads table: its name/key type is not known to this
-- module. Lead deletion must call store.purgeLead(leadId) (see INTEGRATION_POINTS.md).

CREATE TABLE IF NOT EXISTS li_schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS li_research_jobs (
  job_id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  requested_domain TEXT,
  domain_key TEXT,
  state TEXT NOT NULL CHECK (state IN ('requested','preflight','started','polling','complete','partial','failed','pending','stale','blocked')),
  provider_job_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  poll_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  packet_id TEXT,
  options_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS li_jobs_by_lead ON li_research_jobs (lead_id, created_at);
CREATE INDEX IF NOT EXISTS li_jobs_due ON li_research_jobs (state, next_attempt_at);
-- Duplicate prevention at the database level: one active job per request key.
CREATE UNIQUE INDEX IF NOT EXISTS li_jobs_one_active ON li_research_jobs (request_key)
  WHERE state IN ('requested','preflight','started','polling','pending');

CREATE TABLE IF NOT EXISTS li_evidence_packets (
  packet_id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  research_status TEXT NOT NULL,
  footprint_state TEXT NOT NULL,
  requested_domain TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  packet_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS li_packets_by_lead ON li_evidence_packets (lead_id, captured_at);

CREATE TABLE IF NOT EXISTS li_research_changes (
  change_id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL,
  from_packet_id TEXT NOT NULL,
  to_packet_id TEXT NOT NULL,
  type TEXT NOT NULL,
  change_json TEXT NOT NULL,
  detected_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS li_changes_by_lead ON li_research_changes (lead_id, detected_at);

CREATE TABLE IF NOT EXISTS li_saved_searches (
  search_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS li_segments (
  segment_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('static','dynamic')),
  definition_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Static segment membership: references to existing leads only (no lead copies).
CREATE TABLE IF NOT EXISTS li_segment_members (
  segment_id TEXT NOT NULL,
  lead_id TEXT NOT NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (segment_id, lead_id)
);

CREATE TABLE IF NOT EXISTS li_pitch_drafts (
  pitch_id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL,
  packet_id TEXT,
  status TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  draft_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS li_pitches_by_lead ON li_pitch_drafts (lead_id, updated_at);

CREATE TABLE IF NOT EXISTS li_outreach_approvals (
  approval_id TEXT PRIMARY KEY,
  pitch_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  approved_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS li_approvals_by_pitch ON li_outreach_approvals (pitch_id, approved_at);
`;

const MIGRATION_002 = `-- ZTech lead-intelligence schema, migration 002: enrichment (Round 1).
-- Same sql.js database file as 001. Enrichment never writes into the Lead Library table;
-- observations are stored here with field-level provenance and selected at read time.

-- One enrichment waterfall run per row. steps_json holds the per-provider steps
-- (state, fields requested/found/not found, rejected values, attempts, error code).
CREATE TABLE IF NOT EXISTS li_enrichment_jobs (
  job_id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('requested','running','pending','complete','partial','no_result','failed','blocked','stale')),
  fields_json TEXT NOT NULL,
  steps_json TEXT NOT NULL,
  next_attempt_at TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS li_ejobs_by_lead ON li_enrichment_jobs (lead_id, created_at);
CREATE INDEX IF NOT EXISTS li_ejobs_due ON li_enrichment_jobs (state, next_attempt_at);
-- Duplicate prevention: at most one active enrichment job per lead.
CREATE UNIQUE INDEX IF NOT EXISTS li_ejobs_one_active ON li_enrichment_jobs (lead_id)
  WHERE state IN ('requested','running','pending');

-- One row per distinct (lead, provider, field, status, value, source_ref).
-- observation_id is deterministic, so a repeated identical provider answer updates
-- collected_at instead of creating a duplicate.
-- value_json: normalised value (JSON) or null for NOT_FOUND.
-- tier: evidence tier declared by the provider adapter (first_party/third_party/derived).
-- provider_confidence_json: only when the provider itself returned a confidence value,
--   stored with the provider's own scale label; never computed by ZTech.
-- provenance_id: stable id cited by profile, ICP entries and exports.
CREATE TABLE IF NOT EXISTS li_enrichment_observations (
  observation_id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  field TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('FOUND','NOT_FOUND')),
  value_json TEXT,
  provider_id TEXT NOT NULL,
  tier TEXT NOT NULL,
  source_ref TEXT,
  provider_confidence_json TEXT,
  collected_at TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  provenance_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS li_eobs_by_lead ON li_enrichment_observations (lead_id, field);
`;

// ZTech lead-intelligence schema, migration 003: outreach activity (F15).
//
// One canonical, APPEND-ONLY ledger of outreach events for a lead/pitch. It exists
// because approval is the only outreach fact that was already stored, while
// "became ready" and "approval was invalidated" are transitions that CANNOT be
// reconstructed later: readiness depends on the clock (evidence freshness) and on
// mutable research/ICP state, and no history of a pitch's previous content exists.
// So those transitions have to be recorded when they actually happen.
//
// Deliberately NARROW. The activity_type CHECK constraint is a closed allowlist of
// three facts this codebase can prove at a real mutation boundary. There is
// deliberately NO sent, delivered, opened, clicked, queued, retried or campaign state:
// nothing in this build sends anything, so such a row could only ever be a lie.
// There is also no foreign key to leads by design - an activity row is a historical
// fact and must survive the lead it referred to.
const MIGRATION_003 = `-- ZTech lead-intelligence schema, migration 003: outreach activity.

CREATE TABLE IF NOT EXISTS li_outreach_activity (
  activity_id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL,
  pitch_id TEXT,
  activity_type TEXT NOT NULL CHECK (activity_type IN ('PITCH_APPROVED','OUTREACH_READY','APPROVAL_INVALIDATED')),
  metadata_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS li_activity_by_lead ON li_outreach_activity (lead_id, created_at);
CREATE INDEX IF NOT EXISTS li_activity_by_pitch ON li_outreach_activity (pitch_id, created_at);
`;

// ZTech lead-intelligence schema, migration 004: email send boundary (F19).
//
// Embedded verbatim from migrations/004_email_send.sql - see the comment block in that
// file for why the activity table is rebuilt and why the four new event types are named
// channel-neutrally. test/lead-intelligence/persistence.test.js asserts this string is
// byte-identical to the .sql file.
const MIGRATION_004 = `-- ZTech lead-intelligence schema, migration 004: email send boundary (F19).
--
-- Two things, both strictly additive:
--
-- 1. Widen the li_outreach_activity.activity_type CHECK allowlist by four send events.
--    SQLite cannot ALTER a CHECK constraint, so the table is REBUILT: create the new
--    shape, copy every existing row verbatim, drop the old table, rename. No row is
--    dropped, reworded or re-typed - existing history is preserved byte-for-byte.
--
-- 2. Add li_outreach_sends, the idempotency ledger for the send boundary.
--
-- THE FOUR NEW EVENT TYPES are named CHANNEL-NEUTRALLY on purpose, exactly like the
-- F18 preparation shape: the channel is recorded in metadata, not baked into the type
-- name. So a later WhatsApp send (F20) records the SAME four events with channel
-- "whatsapp" and needs no change to this activity allowlist, which stays CLOSED.
--
-- Note the limit of that claim: it is about the activity table ONLY. li_outreach_sends
-- below carries channel TEXT NOT NULL CHECK (channel IN ('email')), so it admits
-- exactly what F19 can actually do. A WhatsApp send must widen THAT check by rebuilding
-- the table in a later migration - it cannot be smuggled in by relaxing this comment.
--
-- What the four events mean, and what they deliberately do NOT mean:
--   OUTREACH_SEND_BLOCKED    a human asked to send and the product refused BEFORE any
--                            provider was contacted (gate not allowed, not configured,
--                            or the message failed validation).
--   OUTREACH_SEND_ATTEMPTED  the provider WAS called. Written BEFORE the call, so a
--                            crash mid-send still leaves proof the provider was reached
--                            rather than silence.
--   OUTREACH_SEND_ACCEPTED   the provider returned its own message id. That is an
--                            ACKNOWLEDGEMENT and nothing more.
--   OUTREACH_SEND_FAILED     the provider refused or the call failed.
--
-- There is STILL no delivered / opened / clicked / bounced event. A provider accepting a
-- message does not prove it arrived, and nothing in this build observes an inbox, so such
-- a row could only ever be a lie. Delivery, open and click stay 'unknown' forever unless a
-- real observer exists.

CREATE TABLE li_outreach_activity_f19 (
  activity_id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL,
  pitch_id TEXT,
  activity_type TEXT NOT NULL CHECK (activity_type IN ('PITCH_APPROVED','OUTREACH_READY','APPROVAL_INVALIDATED','OUTREACH_SEND_BLOCKED','OUTREACH_SEND_ATTEMPTED','OUTREACH_SEND_ACCEPTED','OUTREACH_SEND_FAILED')),
  metadata_json TEXT,
  created_at TEXT NOT NULL
);
INSERT INTO li_outreach_activity_f19 (activity_id, lead_id, pitch_id, activity_type, metadata_json, created_at)
  SELECT activity_id, lead_id, pitch_id, activity_type, metadata_json, created_at FROM li_outreach_activity;
DROP TABLE li_outreach_activity;
ALTER TABLE li_outreach_activity_f19 RENAME TO li_outreach_activity;
CREATE INDEX IF NOT EXISTS li_activity_by_lead ON li_outreach_activity (lead_id, created_at);
CREATE INDEX IF NOT EXISTS li_activity_by_pitch ON li_outreach_activity (pitch_id, created_at);

-- The send ledger. One row per send ATTEMPT, keyed by a deterministic idempotency key
-- derived from (channel, pitch_id, content_hash) - never from a timestamp, a counter or a
-- random id, so the same approved content can never produce two different keys.
--
-- state is a CLOSED set of the four provable states:
--   attempted - the provider was called; the outcome was not observed
--   accepted  - the provider returned a message id
--   failed    - the provider refused or the call failed
--   blocked   - refused by ZTech before the provider was contacted
--
-- provider_message_id is the provider's OWN id, kept so a future status lookup can ask the
-- provider what it thinks happened. It is never interpreted as proof of delivery.
-- failure_message is ZTech-authored text only; remote provider text is never copied in.
--
-- Like the activity ledger, send rows deliberately SURVIVE purgeLead: a historical fact
-- about a real send must not disappear when the lead it referred to is removed. There is
-- no foreign key to leads for exactly that reason.
CREATE TABLE IF NOT EXISTS li_outreach_sends (
  send_id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL,
  pitch_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('email')),
  content_hash TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('attempted','accepted','failed','blocked')),
  provider_id TEXT,
  provider_message_id TEXT,
  failure_code TEXT,
  failure_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS li_sends_by_pitch ON li_outreach_sends (pitch_id, created_at);
CREATE INDEX IF NOT EXISTS li_sends_by_key ON li_outreach_sends (idempotency_key);

-- THE IDEMPOTENCY GUARANTEE, enforced by the database rather than by application code.
-- At most ONE accepted send may exist per idempotency key. A failed or blocked attempt is
-- NOT final, so those states are deliberately outside the index: a human may legitimately
-- retry after a failure. This is the same partial-unique-index technique migration 001
-- already uses for one-active-job-per-request-key.
--
-- If two sends race, the loser hits this constraint instead of sending a second copy, and
-- the service treats that as an idempotent replay rather than an error.
CREATE UNIQUE INDEX IF NOT EXISTS li_sends_one_accepted
  ON li_outreach_sends (idempotency_key) WHERE state = 'accepted';
`;

// F20: WhatsApp send channel - widens li_outreach_sends.channel CHECK to include
// 'whatsapp'. The payload stays { pitchId } only; the service derives channel.
const MIGRATION_005 = fs.readFileSync(
  path.join(__dirname, '..', 'migrations', '005_whatsapp_send.sql'),
  'utf8'
);

// I3: Opportunity Intelligence associations - lead_id <-> research_id/snapshot_id/entity_key,
// IDs and metadata only. The report body never enters this database.
const MIGRATION_006 = fs.readFileSync(
  path.join(__dirname, '..', 'migrations', '006_oi_associations.sql'),
  'utf8'
);

const MIGRATIONS = Object.freeze([
  Object.freeze({ version: 1, name: '001_lead_intelligence.sql', sql: MIGRATION_001 }),
  Object.freeze({ version: 2, name: '002_enrichment.sql', sql: MIGRATION_002 }),
  Object.freeze({ version: 3, name: '003_outreach_activity.sql', sql: MIGRATION_003 }),
  Object.freeze({ version: 4, name: '004_email_send.sql', sql: MIGRATION_004 }),
  Object.freeze({ version: 5, name: '005_whatsapp_send.sql', sql: MIGRATION_005 }),
  Object.freeze({ version: 6, name: '006_oi_associations.sql', sql: MIGRATION_006 }),
]);

module.exports = { MIGRATIONS };
