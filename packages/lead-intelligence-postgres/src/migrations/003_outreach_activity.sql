-- PostgreSQL 16 schema, migration 003: outreach activity.
-- The counterpart of the desktop's migrations/003_outreach_activity.sql. The
-- activity_type allowlist is a CHECK constraint, widened by migration 004 and
-- migration 009 - in PostgreSQL a constraint is dropped and re-added, so no
-- table has to be rebuilt and no row is copied.

CREATE TABLE IF NOT EXISTS li_outreach_activity (
  workspace_id   UUID NOT NULL,
  activity_id    TEXT NOT NULL,
  PRIMARY KEY (workspace_id, activity_id),
  lead_id        TEXT NOT NULL,
  pitch_id       TEXT,
  activity_type  TEXT NOT NULL CHECK (activity_type IN ('PITCH_APPROVED','OUTREACH_READY','APPROVAL_INVALIDATED')),
  metadata_json  JSONB,
  created_at     TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS li_activity_by_lead ON li_outreach_activity (workspace_id, lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS li_activity_by_pitch ON li_outreach_activity (workspace_id, pitch_id, created_at DESC);
