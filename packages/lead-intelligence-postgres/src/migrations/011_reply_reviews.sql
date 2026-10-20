-- PostgreSQL 16 schema, migration 011: the human review of mailbox replies.
-- The counterpart of the desktop's migrations/011_reply_reviews.sql. One review
-- per reply event; a re-review replaces it.

CREATE TABLE IF NOT EXISTS li_reply_reviews (
  workspace_id       TEXT NOT NULL,
  review_id          TEXT PRIMARY KEY,
  event_id           TEXT NOT NULL,
  channel            TEXT NOT NULL CHECK (channel IN ('email')),
  normalized_address TEXT NOT NULL,
  outcome            TEXT NOT NULL CHECK (outcome IN ('interested', 'not_interested', 'unsubscribe', 'neutral')),
  reviewed_by        TEXT NOT NULL,
  reviewed_at        TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS li_reply_reviews_one_per_event ON li_reply_reviews (event_id);
CREATE INDEX IF NOT EXISTS li_reply_reviews_by_address ON li_reply_reviews (channel, normalized_address, reviewed_at DESC);