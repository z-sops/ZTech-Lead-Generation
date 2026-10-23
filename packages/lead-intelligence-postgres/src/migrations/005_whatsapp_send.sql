-- PostgreSQL 16 schema, migration 005: the WhatsApp send channel.
-- The counterpart of the desktop's migrations/005_whatsapp_send.sql. The channel
-- CHECK is widened from 'email' to both channels, and the provider_status column
-- is added - with the same 'unknown' default for the rows that already exist.

ALTER TABLE li_outreach_sends DROP CONSTRAINT IF EXISTS li_outreach_sends_channel_check;
ALTER TABLE li_outreach_sends ADD CONSTRAINT li_outreach_sends_channel_check CHECK (channel IN ('email','whatsapp'));
ALTER TABLE li_outreach_sends ADD COLUMN IF NOT EXISTS provider_status TEXT;

-- The desktop's rule is one accepted row per (channel, idempotency_key).
DROP INDEX IF EXISTS li_sends_one_accepted;
CREATE UNIQUE INDEX IF NOT EXISTS li_sends_one_accepted
ON li_outreach_sends (workspace_id, channel, idempotency_key)
WHERE state = 'accepted';

CREATE INDEX IF NOT EXISTS li_sends_by_pitch ON li_outreach_sends (workspace_id, pitch_id, created_at DESC);