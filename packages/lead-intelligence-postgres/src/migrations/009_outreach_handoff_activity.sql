-- PostgreSQL 16 schema, migration 009: the mail-app handoff activity type.
-- The counterpart of the desktop's migrations/009_outreach_handoff_activity.sql.
--
-- One event type is added to the closed allowlist: OUTREACH_HANDOFF_CREATED, the
-- person opening an approved pitch in their own mail app. It is NOT a send: it
-- never writes li_outreach_sends and is never counted as one.
--
-- On the desktop the table is rebuilt because SQLite cannot alter a CHECK.
-- Here the constraint is dropped and re-added, so no row is copied or dropped.

ALTER TABLE li_outreach_activity DROP CONSTRAINT IF EXISTS li_outreach_activity_activity_type_check;
ALTER TABLE li_outreach_activity ADD CONSTRAINT li_outreach_activity_activity_type_check
  CHECK (activity_type IN ('PITCH_APPROVED','OUTREACH_READY','APPROVAL_INVALIDATED','OUTREACH_SEND_BLOCKED','OUTREACH_SEND_ATTEMPTED','OUTREACH_SEND_ACCEPTED','OUTREACH_SEND_FAILED','OUTREACH_HANDOFF_CREATED'));