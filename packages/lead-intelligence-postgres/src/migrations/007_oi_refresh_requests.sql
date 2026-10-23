-- PostgreSQL 16 schema, migration 007: Opportunity Intelligence refresh requests.
-- The counterpart of the desktop's migrations/007_oi_refresh_requests.sql.
--
-- The request_id IS the idempotency key sent to OI, written BEFORE the request
-- leaves ZTech. A lead has at most one pending intent - a partial unique index,
-- the same technique as migrations 001, 002 and 004.

CREATE TABLE IF NOT EXISTS li_oi_refresh_requests (
  workspace_id UUID NOT NULL,
  request_id  TEXT NOT NULL,
  PRIMARY KEY (workspace_id, request_id),
  lead_id     TEXT NOT NULL,
  state       TEXT NOT NULL CHECK (state IN ('pending', 'succeeded', 'failed')),
  research_id TEXT,
  error_code  TEXT,
  created_at  TIMESTAMPTZ NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS li_oi_refresh_one_pending
  ON li_oi_refresh_requests (workspace_id, lead_id) WHERE state = 'pending';

CREATE INDEX IF NOT EXISTS li_oi_refresh_lead ON li_oi_refresh_requests (workspace_id, lead_id, created_at DESC);
