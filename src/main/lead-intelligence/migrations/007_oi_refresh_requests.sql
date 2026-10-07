-- ZTech lead-intelligence schema, migration 007: Opportunity Intelligence refresh requests (I5).
--
-- One row per HUMAN refresh intent. request_id IS the idempotency key sent to OI, written
-- BEFORE the request leaves ZTech, so a retry after a timeout or an app restart re-sends the
-- SAME key and OI answers from the run it already did instead of calling paid providers twice.
--
--   pending    the intent is open; any Run/Retry for the lead reuses this request_id
--   succeeded  OI returned a validated report (research_id set); the next Refresh is a new intent
--   failed     OI gave a terminal answer (error_code set); the next Refresh is a new intent
--
-- IDs and state only: no report JSON, no credentials, no OI data. A lead has at most one
-- pending intent (partial unique index, the same technique as migrations 001 and 004).

CREATE TABLE IF NOT EXISTS li_oi_refresh_requests (
  request_id  TEXT PRIMARY KEY,
  lead_id     TEXT NOT NULL,
  state       TEXT NOT NULL CHECK (state IN ('pending', 'succeeded', 'failed')),
  research_id TEXT,
  error_code  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS li_oi_refresh_one_pending
  ON li_oi_refresh_requests (lead_id) WHERE state = 'pending';

CREATE INDEX IF NOT EXISTS li_oi_refresh_lead ON li_oi_refresh_requests (lead_id, created_at DESC);
