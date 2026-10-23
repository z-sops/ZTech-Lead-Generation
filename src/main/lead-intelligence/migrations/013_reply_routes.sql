-- ZTech lead-intelligence schema, migration 013: the Reply Router's suggested categories (F29).
--
-- One row per VERIFIED mailbox message that cited a provider-stored Message-ID of one of this
-- mailbox's own sends, from the address that send went to:
--   kind 'reply'       - a verified reply the trust intake accepted (it already stopped F28)
--   kind 'unsubscribe' - an "unsubscribe" reply the trust intake accepted (already suppressed)
--   kind 'away'        - an automatic reply (out of office). Trust intake still SKIPS it: no
--                        trust event exists behind it, it is not permission and it never stops F28.
--
-- A route is a SUGGESTION. Nothing in the trust policy, the gates or F28 reads this table: a
-- category, suggested or confirmed, never suppresses, permits, sends, schedules or resumes.
--
-- Gmail returns no snippet under gmail.metadata (live Step 1 probe, 8 Oct 2026), so a route is
-- decided from the subject and headers only. NO TEXT COLUMN EXISTS: the subject, a snippet or a
-- body is never stored here (or anywhere). Only ids, closed codes and times.

CREATE TABLE IF NOT EXISTS li_reply_routes (
  event_id     TEXT PRIMARY KEY,
  lead_id      TEXT NOT NULL,
  mailbox_id   TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('reply', 'unsubscribe', 'away')),
  suggested    TEXT NOT NULL CHECK (suggested IN ('interested', 'not_interested', 'pricing_request', 'meeting_request', 'later', 'out_of_office', 'unsubscribe', 'unknown')),
  rule_id      TEXT NOT NULL CHECK (length(rule_id) BETWEEN 1 AND 40),
  input        TEXT NOT NULL CHECK (input IN ('subject', 'headers')),
  confidence   TEXT NOT NULL CHECK (confidence IN ('high', 'low')),
  confirmed    TEXT CHECK (confirmed IS NULL OR confirmed IN ('interested', 'not_interested', 'pricing_request', 'meeting_request', 'later', 'out_of_office', 'unsubscribe', 'unknown')),
  confirmed_by TEXT,
  confirmed_at TEXT,
  routed_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS li_reply_routes_by_lead ON li_reply_routes (lead_id, routed_at DESC);
CREATE INDEX IF NOT EXISTS li_reply_routes_by_time ON li_reply_routes (routed_at DESC);
