-- ZTech lead-intelligence schema, migration 005: WhatsApp send channel (F20).
--
-- F19 added li_outreach_sends with a CHECK constraint admitting only 'email'.
-- F20 adds WhatsApp behind the same provider-neutral send boundary. The payload
-- remains exactly { pitchId }; the service decides the channel from the stored
-- contact facts and the configured provider. The renderer cannot express a
-- channel choice.
--
-- SQLite cannot ALTER a CHECK constraint, so the table is REBUILT:
-- create the new shape, copy every existing row verbatim, drop the old table,
-- rename. No row is dropped, reworded or re-typed - existing history is
-- preserved byte-for-byte.
--
-- The activity table was already rebuilt in 004 with channel-neutral event
-- types (OUTREACH_SEND_BLOCKED, OUTREACH_SEND_ATTEMPTED, OUTREACH_SEND_ACCEPTED,
-- OUTREACH_SEND_FAILED) that record the channel in metadata. No further change
-- to li_outreach_activity is needed.

CREATE TABLE li_outreach_sends_f20 (
  send_id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL,
  pitch_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('email','whatsapp')),
  content_hash TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('attempted','accepted','failed','blocked')),
  provider_id TEXT,
  provider_message_id TEXT,
  provider_status TEXT,
  failure_code TEXT,
  failure_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- The 004 table lacks provider_status; default to 'unknown' for existing rows.
INSERT INTO li_outreach_sends_f20 (
  send_id, lead_id, pitch_id, channel, content_hash, idempotency_key, state,
  provider_id, provider_message_id, provider_status, failure_code, failure_message,
  created_at, updated_at
)
SELECT
  send_id, lead_id, pitch_id, channel, content_hash, idempotency_key, state,
  provider_id, provider_message_id, 'unknown' AS provider_status, failure_code, failure_message,
  created_at, updated_at
FROM li_outreach_sends;

DROP TABLE li_outreach_sends;
ALTER TABLE li_outreach_sends_f20 RENAME TO li_outreach_sends;

-- Unique index for the at-most-one-ACCEPTED-per-key rule: only one accepted row
-- per (channel, idempotency_key). FAILED/BLOCKED/ATTEMPTED rows are not unique.
CREATE UNIQUE INDEX IF NOT EXISTS li_sends_one_accepted
ON li_outreach_sends (channel, idempotency_key)
WHERE state = 'accepted';

-- Index for the 'by pitch' lookups the activity timeline needs.
CREATE INDEX IF NOT EXISTS li_sends_by_pitch ON li_outreach_sends (pitch_id, created_at DESC);