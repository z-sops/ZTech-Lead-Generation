-- ZTech lead-intelligence schema, migration 003: outreach activity.

CREATE TABLE IF NOT EXISTS li_outreach_activity (
  activity_id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL,
  pitch_id TEXT,
  activity_type TEXT NOT NULL CHECK (activity_type IN ('PITCH_APPROVED','OUTREACH_READY','APPROVAL_INVALIDATED')),
  metadata_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS li_activity_by_lead ON li_outreach_activity (lead_id, created_at);
CREATE INDEX IF NOT EXISTS li_activity_by_pitch ON li_outreach_activity (pitch_id, created_at);
