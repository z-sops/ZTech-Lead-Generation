-- PostgreSQL 16 schema, migration 002: enrichment (Round 1).
-- The counterpart of the desktop's migrations/002_enrichment.sql. Same tables, same
-- columns, same identifiers. The JSON documents are JSONB; the timestamps are
-- TIMESTAMPTZ. The partial unique index - at most one active enrichment job per
-- lead - is kept exactly as it is on the desktop.

CREATE TABLE IF NOT EXISTS li_enrichment_jobs (
  workspace_id     TEXT NOT NULL,
  seq              BIGSERIAL,
  job_id           TEXT PRIMARY KEY,
  lead_id          TEXT NOT NULL,
  state            TEXT NOT NULL CHECK (state IN ('requested','running','pending','complete','partial','no_result','failed','blocked','stale')),
  fields_json      JSONB NOT NULL,
  steps_json       JSONB NOT NULL,
  next_attempt_at  TIMESTAMPTZ,
  last_error_code  TEXT,
  created_at       TIMESTAMPTZ NOT NULL,
  updated_at       TIMESTAMPTZ NOT NULL,
  finished_at      TIMESTAMPTZ,
  version          INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS li_ejobs_by_lead ON li_enrichment_jobs (workspace_id, lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS li_ejobs_due ON li_enrichment_jobs (state, next_attempt_at);
-- Duplicate prevention: at most one active enrichment job per lead.
CREATE UNIQUE INDEX IF NOT EXISTS li_ejobs_one_active ON li_enrichment_jobs (lead_id)
  WHERE state IN ('requested','running','pending');

CREATE TABLE IF NOT EXISTS li_enrichment_observations (
  workspace_id             TEXT NOT NULL,
  observation_id           TEXT PRIMARY KEY,
  lead_id                  TEXT NOT NULL,
  job_id                   TEXT NOT NULL,
  field                    TEXT NOT NULL,
  status                   TEXT NOT NULL CHECK (status IN ('FOUND','NOT_FOUND')),
  value_json               JSONB,
  provider_id              TEXT NOT NULL,
  tier                     TEXT NOT NULL,
  source_ref               TEXT,
  provider_confidence_json JSONB,
  collected_at             TIMESTAMPTZ NOT NULL,
  first_seen_at            TIMESTAMPTZ NOT NULL,
  provenance_id            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS li_eobs_by_lead ON li_enrichment_observations (workspace_id, lead_id, field);