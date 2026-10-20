-- PostgreSQL 16 schema, migration 013: the Reply Router's suggested categories.
-- The counterpart of the desktop's migrations/013_reply_routes.sql.
--
-- A route is a SUGGESTION. Nothing in the trust policy, the gates or the
-- scheduler reads this table. There is NO text column here - not a subject, not
-- a snippet, not a body - only ids, closed codes and times.

CREATE TABLE IF NOT EXISTS li_reply_routes (
  workspace_id       UUID NOT NULL,
  event_id           TEXT NOT NULL,
  PRIMARY KEY (workspace_id, event_id),
  lead_id            TEXT NOT NULL,
  mailbox_id         TEXT NOT NULL,
  kind               TEXT NOT NULL CHECK (kind IN ('reply', 'unsubscribe', 'away')),
  suggested          TEXT NOT NULL CHECK (suggested IN ('interested', 'not_interested', 'pricing_request', 'meeting_request', 'later', 'out_of_office', 'unsubscribe', 'unknown')),
  rule_id            TEXT NOT NULL CHECK (length(rule_id) BETWEEN 1 AND 40),
  input              TEXT NOT NULL CHECK (input IN ('subject', 'headers')),
  confidence         TEXT NOT NULL CHECK (confidence IN ('high', 'low')),
  confirmed          TEXT CHECK (confirmed IS NULL OR confirmed IN ('interested', 'not_interested', 'pricing_request', 'meeting_request', 'later', 'out_of_office', 'unsubscribe', 'unknown')),
  confirmed_by       TEXT,
  confirmed_at       TIMESTAMPTZ,
  routed_at           TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS li_reply_routes_by_lead ON li_reply_routes (workspace_id, lead_id, routed_at DESC);
CREATE INDEX IF NOT EXISTS li_reply_routes_by_time ON li_reply_routes (workspace_id, routed_at DESC);