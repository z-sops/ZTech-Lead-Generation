-- ZTech lead-intelligence schema, migration 009: the mail-app handoff activity type (F26.5).
--
-- Widens the li_outreach_activity.activity_type CHECK allowlist by ONE event:
--
--   OUTREACH_HANDOFF_CREATED  the person opened an approved pitch in their own mail app
--                             (mailto) or copied it. It is NOT a send: ZTech cannot know
--                             whether the person sent it. It never writes li_outreach_sends,
--                             is never counted as a send, and says nothing about delivery.
--
-- SQLite cannot ALTER a CHECK constraint, so the table is REBUILT exactly as migration 004
-- did: create the new shape, copy every existing row verbatim, drop the old table, rename.
-- No row is dropped, reworded or re-typed. No other table is touched.

CREATE TABLE li_outreach_activity_f265 (
  activity_id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL,
  pitch_id TEXT,
  activity_type TEXT NOT NULL CHECK (activity_type IN ('PITCH_APPROVED','OUTREACH_READY','APPROVAL_INVALIDATED','OUTREACH_SEND_BLOCKED','OUTREACH_SEND_ATTEMPTED','OUTREACH_SEND_ACCEPTED','OUTREACH_SEND_FAILED','OUTREACH_HANDOFF_CREATED')),
  metadata_json TEXT,
  created_at TEXT NOT NULL
);
INSERT INTO li_outreach_activity_f265 (activity_id, lead_id, pitch_id, activity_type, metadata_json, created_at)
  SELECT activity_id, lead_id, pitch_id, activity_type, metadata_json, created_at FROM li_outreach_activity;
DROP TABLE li_outreach_activity;
ALTER TABLE li_outreach_activity_f265 RENAME TO li_outreach_activity;
CREATE INDEX IF NOT EXISTS li_activity_by_lead ON li_outreach_activity (lead_id, created_at);
CREATE INDEX IF NOT EXISTS li_activity_by_pitch ON li_outreach_activity (pitch_id, created_at);
