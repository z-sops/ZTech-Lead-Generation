-- PostgreSQL 16 schema, migration 006: Opportunity Intelligence associations.
-- The counterpart of the desktop's migrations/006_oi_associations.sql. IDs and
-- metadata only: no report JSON, no provider credentials, no OI data.

CREATE TABLE IF NOT EXISTS li_oi_associations (
  workspace_id UUID NOT NULL,
  research_id  TEXT NOT NULL,
  PRIMARY KEY (workspace_id, research_id),
  lead_id      TEXT NOT NULL,
  snapshot_id  TEXT NOT NULL,
  entity_key   TEXT NOT NULL,
  status       TEXT NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL,
  recorded_at  TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS li_oi_assoc_lead ON li_oi_associations (workspace_id, lead_id, recorded_at DESC);
