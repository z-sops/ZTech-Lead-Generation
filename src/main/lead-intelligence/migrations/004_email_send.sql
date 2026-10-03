-- ZTech lead-intelligence schema, migration 004: email send boundary (F19).
--
-- Two things, both strictly additive:
--
-- 1. Widen the li_outreach_activity.activity_type CHECK allowlist by four send events.
--    SQLite cannot ALTER a CHECK constraint, so the table is REBUILT: create the new
--    shape, copy every existing row verbatim, drop the old table, rename. No row is
--    dropped, reworded or re-typed - existing history is preserved byte-for-byte.
--
-- 2. Add li_outreach_sends, the idempotency ledger for the send boundary.
--
-- THE FOUR NEW EVENT TYPES are named CHANNEL-NEUTRALLY on purpose, exactly like the
-- F18 preparation shape: the channel is recorded in metadata, not baked into the type
-- name. So a later WhatsApp send (F20) records the SAME four events with channel
-- "whatsapp" and needs no change to this activity allowlist, which stays CLOSED.
--
-- Note the limit of that claim: it is about the activity table ONLY. li_outreach_sends
-- below carries channel TEXT NOT NULL CHECK (channel IN ('email')), so it admits
-- exactly what F19 can actually do. A WhatsApp send must widen THAT check by rebuilding
-- the table in a later migration - it cannot be smuggled in by relaxing this comment.
--
-- What the four events mean, and what they deliberately do NOT mean:
--   OUTREACH_SEND_BLOCKED    a human asked to send and the product refused BEFORE any
--                            provider was contacted (gate not allowed, not configured,
--                            or the message failed validation).
--   OUTREACH_SEND_ATTEMPTED  the provider WAS called. Written BEFORE the call, so a
--                            crash mid-send still leaves proof the provider was reached
--                            rather than silence.
--   OUTREACH_SEND_ACCEPTED   the provider returned its own message id. That is an
--                            ACKNOWLEDGEMENT and nothing more.
--   OUTREACH_SEND_FAILED     the provider refused or the call failed.
--
-- There is STILL no delivered / opened / clicked / bounced event. A provider accepting a
-- message does not prove it arrived, and nothing in this build observes an inbox, so such
-- a row could only ever be a lie. Delivery, open and click stay 'unknown' forever unless a
-- real observer exists.

CREATE TABLE li_outreach_activity_f19 (
  activity_id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL,
  pitch_id TEXT,
  activity_type TEXT NOT NULL CHECK (activity_type IN ('PITCH_APPROVED','OUTREACH_READY','APPROVAL_INVALIDATED','OUTREACH_SEND_BLOCKED','OUTREACH_SEND_ATTEMPTED','OUTREACH_SEND_ACCEPTED','OUTREACH_SEND_FAILED')),
  metadata_json TEXT,
  created_at TEXT NOT NULL
);
INSERT INTO li_outreach_activity_f19 (activity_id, lead_id, pitch_id, activity_type, metadata_json, created_at)
  SELECT activity_id, lead_id, pitch_id, activity_type, metadata_json, created_at FROM li_outreach_activity;
DROP TABLE li_outreach_activity;
ALTER TABLE li_outreach_activity_f19 RENAME TO li_outreach_activity;
CREATE INDEX IF NOT EXISTS li_activity_by_lead ON li_outreach_activity (lead_id, created_at);
CREATE INDEX IF NOT EXISTS li_activity_by_pitch ON li_outreach_activity (pitch_id, created_at);

-- The send ledger. One row per send ATTEMPT, keyed by a deterministic idempotency key
-- derived from (channel, pitch_id, content_hash) - never from a timestamp, a counter or a
-- random id, so the same approved content can never produce two different keys.
--
-- state is a CLOSED set of the four provable states:
--   attempted - the provider was called; the outcome was not observed
--   accepted  - the provider returned a message id
--   failed    - the provider refused or the call failed
--   blocked   - refused by ZTech before the provider was contacted
--
-- provider_message_id is the provider's OWN id, kept so a future status lookup can ask the
-- provider what it thinks happened. It is never interpreted as proof of delivery.
-- failure_message is ZTech-authored text only; remote provider text is never copied in.
--
-- Like the activity ledger, send rows deliberately SURVIVE purgeLead: a historical fact
-- about a real send must not disappear when the lead it referred to is removed. There is
-- no foreign key to leads for exactly that reason.
CREATE TABLE IF NOT EXISTS li_outreach_sends (
  send_id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL,
  pitch_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('email')),
  content_hash TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('attempted','accepted','failed','blocked')),
  provider_id TEXT,
  provider_message_id TEXT,
  failure_code TEXT,
  failure_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS li_sends_by_pitch ON li_outreach_sends (pitch_id, created_at);
CREATE INDEX IF NOT EXISTS li_sends_by_key ON li_outreach_sends (idempotency_key);

-- THE IDEMPOTENCY GUARANTEE, enforced by the database rather than by application code.
-- At most ONE accepted send may exist per idempotency key. A failed or blocked attempt is
-- NOT final, so those states are deliberately outside the index: a human may legitimately
-- retry after a failure. This is the same partial-unique-index technique migration 001
-- already uses for one-active-job-per-request-key.
--
-- If two sends race, the loser hits this constraint instead of sending a second copy, and
-- the service treats that as an idempotent replay rather than an error.
CREATE UNIQUE INDEX IF NOT EXISTS li_sends_one_accepted
  ON li_outreach_sends (idempotency_key) WHERE state = 'accepted';
