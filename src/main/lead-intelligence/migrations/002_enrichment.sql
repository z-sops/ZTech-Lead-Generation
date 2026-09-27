-- ZTech lead-intelligence schema, migration 002: enrichment (Round 1).
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
