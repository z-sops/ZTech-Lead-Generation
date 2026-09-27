'use strict';

/**
 * Embedded copies of migrations/*.sql so the module works when bundled into a single
 * CommonJS file (no fs reads at runtime). test/migrations.test.js asserts that each
 * embedded string is byte-identical to its .sql file. Regenerate with:
 *   node scripts/embed-migrations.js
 */

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

const MIGRATIONS = Object.freeze([
  Object.freeze({ version: 1, name: '001_lead_intelligence.sql', sql: MIGRATION_001 }),
  Object.freeze({ version: 2, name: '002_enrichment.sql', sql: MIGRATION_002 }),
]);

module.exports = { MIGRATIONS };
