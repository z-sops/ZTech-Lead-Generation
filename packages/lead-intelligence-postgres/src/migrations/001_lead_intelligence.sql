-- PostgreSQL 16 schema, migration 001: the lead-intelligence core.
--
-- The counterpart of the desktop's migrations/001_lead_intelligence.sql. The same
-- tables, the same column names, the same identifiers - so the repository code
-- and every stored identifier mean exactly the same thing on both backends.
--
-- The differences are the ones PostgreSQL is better at, and they are all
-- documented in docs/PERSISTENCE-M1.md:
--   * timestamps are TIMESTAMPTZ, not TEXT, so they are compared as instants
--     rather than as strings;
--   * the JSON documents are JSONB, so a document is never stored unparsed;
--   * every tenant-owned table carries workspace_id, so the structure is ready
--     for the row-level security of M2. M1 does NOT enable any policy: the
--     isolation is not proved here.
--   * the tables that the desktop orders by SQLite's rowid carry a `seq`, so
--     "newest first, insertion order for ties" means the same thing on both
--     engines.

CREATE TABLE IF NOT EXISTS li_schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS li_research_jobs (
  workspace_id      UUID NOT NULL,
  seq               BIGSERIAL,
  job_id            TEXT NOT NULL,
  PRIMARY KEY (workspace_id, job_id),
  lead_id           TEXT NOT NULL,
  provider_id       TEXT NOT NULL,
  request_key       TEXT NOT NULL,
  requested_domain  TEXT,
  domain_key        TEXT,
  state             TEXT NOT NULL CHECK (state IN ('requested','preflight','started','polling','complete','partial','failed','pending','stale','blocked')),
  provider_job_id   TEXT,
  attempts          INTEGER NOT NULL DEFAULT 0,
  poll_count        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at   TIMESTAMPTZ,
  last_error_code   TEXT,
  last_error_message TEXT,
  packet_id         TEXT,
  options_json      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL,
  updated_at        TIMESTAMPTZ NOT NULL,
  started_at        TIMESTAMPTZ,
  finished_at       TIMESTAMPTZ,
  version           INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS li_jobs_by_lead ON li_research_jobs (workspace_id, lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS li_jobs_due ON li_research_jobs (workspace_id, state, next_attempt_at);
-- Duplicate prevention at the database level: one active job per request key.
CREATE UNIQUE INDEX IF NOT EXISTS li_jobs_one_active ON li_research_jobs (workspace_id, request_key)
  WHERE state IN ('requested','preflight','started','polling','pending');

CREATE TABLE IF NOT EXISTS li_evidence_packets (
  workspace_id      UUID NOT NULL,
  seq               BIGSERIAL,
  packet_id         TEXT NOT NULL,
  PRIMARY KEY (workspace_id, packet_id),
  lead_id           TEXT NOT NULL,
  job_id            TEXT NOT NULL,
  research_status   TEXT NOT NULL,
  footprint_state   TEXT NOT NULL,
  requested_domain  TEXT NOT NULL,
  captured_at       TIMESTAMPTZ NOT NULL,
  expires_at        TIMESTAMPTZ NOT NULL,
  packet_json       JSONB NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS li_packets_by_lead ON li_evidence_packets (workspace_id, lead_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS li_research_changes (
  workspace_id   UUID NOT NULL,
  seq            BIGSERIAL,
  change_id      TEXT NOT NULL,
  PRIMARY KEY (workspace_id, change_id),
  lead_id        TEXT NOT NULL,
  from_packet_id TEXT NOT NULL,
  to_packet_id   TEXT NOT NULL,
  type           TEXT NOT NULL,
  change_json    JSONB NOT NULL,
  detected_at    TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS li_changes_by_lead ON li_research_changes (workspace_id, lead_id, detected_at DESC);

CREATE TABLE IF NOT EXISTS li_saved_searches (
  workspace_id    UUID NOT NULL,
  search_id       TEXT NOT NULL,
  PRIMARY KEY (workspace_id, search_id),
  name            TEXT NOT NULL,
  definition_json JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS li_segments (
  workspace_id    UUID NOT NULL,
  segment_id      TEXT NOT NULL,
  PRIMARY KEY (workspace_id, segment_id),
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('static','dynamic')),
  definition_json JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL
);

-- Static segment membership: references to existing leads only (no lead copies).
CREATE TABLE IF NOT EXISTS li_segment_members (
  workspace_id UUID NOT NULL,
  segment_id   TEXT NOT NULL,
  lead_id      TEXT NOT NULL,
  added_at     TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (workspace_id, segment_id, lead_id)
);

CREATE TABLE IF NOT EXISTS li_pitch_drafts (
  workspace_id UUID NOT NULL,
  seq          BIGSERIAL,
  pitch_id     TEXT NOT NULL,
  PRIMARY KEY (workspace_id, pitch_id),
  lead_id      TEXT NOT NULL,
  packet_id    TEXT,
  status       TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  draft_json   JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS li_pitches_by_lead ON li_pitch_drafts (workspace_id, lead_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS li_outreach_approvals (
  workspace_id UUID NOT NULL,
  seq          BIGSERIAL,
  approval_id  TEXT NOT NULL,
  PRIMARY KEY (workspace_id, approval_id),
  pitch_id     TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  approved_by  TEXT NOT NULL,
  approved_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS li_approvals_by_pitch ON li_outreach_approvals (workspace_id, pitch_id, approved_at DESC);
