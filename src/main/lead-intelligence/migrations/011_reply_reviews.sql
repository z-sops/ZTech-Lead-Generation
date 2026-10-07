-- ZTech lead-intelligence schema, migration 011: human review of mailbox replies (F26.6 follow-up).
--
-- A verified reply read from a connected mailbox proves only that the person answered. It no
-- longer, by itself, permits further email: a human reviews it, and only "interested" may
-- establish a prior relationship. "unsubscribe" and "not_interested" suppress (recorded as
-- suppressions); "neutral" records the review and establishes nothing.
--
-- One review per reply event (a re-review replaces it). Address-keyed like every trust table;
-- the reviewer is the operator, never a renderer value.

CREATE TABLE IF NOT EXISTS li_reply_reviews (
  review_id          TEXT PRIMARY KEY,
  event_id           TEXT NOT NULL,
  channel            TEXT NOT NULL CHECK (channel IN ('email')),
  normalized_address TEXT NOT NULL,
  outcome            TEXT NOT NULL CHECK (outcome IN ('interested', 'not_interested', 'unsubscribe', 'neutral')),
  reviewed_by        TEXT NOT NULL,
  reviewed_at        TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS li_reply_reviews_one_per_event ON li_reply_reviews (event_id);
CREATE INDEX IF NOT EXISTS li_reply_reviews_by_address ON li_reply_reviews (channel, normalized_address, reviewed_at DESC);
