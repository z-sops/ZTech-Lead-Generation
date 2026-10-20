-- PostgreSQL 16 schema, migration 004: the email send boundary.
-- The counterpart of the desktop's migrations/004_email_send.sql.
--
-- The desktop rebuilds the activity table to widen its CHECK, because SQLite
-- cannot alter a constraint. PostgreSQL can: the constraint is dropped and
-- re-added, so no row is copied, dropped or reworded.
--
-- The send ledger is the same table, with the same idempotency guarantee: at
-- most ONE accepted send per idempotency key, enforced by the database and
-- not by application code.

ALTER TABLE li_outreach_activity DROP CONSTRAINT IF EXISTS li_outreach_activity_activity_type_check;
ALTER TABLE li_outreach_activity ADD CONSTRAINT li_outreach_activity_activity_type_check
  CHECK (activity_type IN ('PITCH_APPROVED','OUTREACH_READY','APPROVAL_INVALIDATED','OUTREACH_SEND_BLOCKED','OUTREACH_SEND_ATTEMPTED','OUTREACH_SEND_ACCEPTED','OUTREACH_SEND_FAILED'));

CREATE TABLE IF NOT EXISTS li_outreach_sends (
  workspace_id        TEXT NOT NULL,
  send_id             TEXT PRIMARY KEY,
  lead_id             TEXT NOT NULL,
  pitch_id            TEXT NOT NULL,
  channel             TEXT NOT NULL CHECK (channel IN ('email')),
  content_hash        TEXT NOT NULL,
  idempotency_key     TEXT NOT NULL,
  state               TEXT NOT NULL CHECK (state IN ('attempted','accepted','failed','blocked')),
  provider_id         TEXT,
  provider_message_id TEXT,
  failure_code        TEXT,
  failure_message     TEXT,
  created_at          TIMESTAMPTZ NOT NULL,
  updated_at          TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS li_sends_by_pitch ON li_outreach_sends (pitch_id, created_at DESC);
CREATE INDEX IF NOT EXISTS li_sends_by_key ON li_outreach_sends (idempotency_key);

-- THE IDEMPOTENCY GUARANTEE, enforced by the database rather than by application code.
-- At most ONE accepted send may exist per idempotency key. A failed or blocked attempt is
-- NOT final, so those states are deliberately outside the index.
CREATE UNIQUE INDEX IF NOT EXISTS li_sends_one_accepted
  ON li_outreach_sends (idempotency_key) WHERE state = 'accepted';