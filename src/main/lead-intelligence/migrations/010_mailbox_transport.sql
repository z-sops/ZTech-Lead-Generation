-- ZTech lead-intelligence schema, migration 010: Native Mailbox Transport (F26.6).
--
-- 1. li_outreach_sends gains a NULLABLE mailbox_id. Every existing row (legacy and transactional-
--    provider sends) keeps NULL and its exact meaning; only a send through a connected mailbox sets it.
--    Pacing counts are keyed by this column, never by provider name.
-- 2. li_mailboxes: one row per connected mailbox. Sanitized identity, status and limits only:
--    no token, no auth code, no PKCE verifier, no client secret (those live in the main
--    process credential vault and never reach this database).
-- 3. li_mailbox_sent: for each mailbox send, the identifiers the PROVIDER stored (read back
--    after sending). Reply matching uses stored_message_id, never a ZTech-supplied value.
-- 4. li_market_rules: the per-country market (jurisdiction) rule Zee sets after review.
--    No row = "consent required".
-- 5. li_trust_events is rebuilt to admit the source 'mailbox' (verified replies and
--    unsubscribe replies read from a connected mailbox). Every row is copied verbatim.
-- 6. li_suppressions is rebuilt the same way, so a suppression caused by an unsubscribe reply
--    read from a mailbox is recorded with its true source. Every row is copied verbatim.

ALTER TABLE li_outreach_sends ADD COLUMN mailbox_id TEXT;
CREATE INDEX IF NOT EXISTS li_sends_by_mailbox ON li_outreach_sends (mailbox_id, created_at);

CREATE TABLE IF NOT EXISTS li_mailboxes (
  mailbox_id      TEXT PRIMARY KEY,
  provider        TEXT NOT NULL CHECK (provider IN ('gmail', 'microsoft365')),
  email_address   TEXT NOT NULL,
  display_name    TEXT,
  status          TEXT NOT NULL CHECK (status IN ('needs_check', 'ready', 'paused', 'reconnect_needed')),
  status_code     TEXT,
  paused_until    TEXT,
  daily_cap       INTEGER NOT NULL CHECK (daily_cap BETWEEN 1 AND 200),
  hourly_cap      INTEGER NOT NULL CHECK (hourly_cap BETWEEN 1 AND 30),
  min_gap_seconds INTEGER NOT NULL CHECK (min_gap_seconds >= 60),
  window_start    TEXT NOT NULL,
  window_end      TEXT NOT NULL,
  window_days     TEXT NOT NULL,
  time_zone       TEXT NOT NULL,
  is_default      INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  sync_cursor     TEXT,
  connected_at    TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS li_mailboxes_one_address ON li_mailboxes (provider, email_address);

CREATE TABLE IF NOT EXISTS li_mailbox_sent (
  send_id             TEXT PRIMARY KEY,
  mailbox_id          TEXT NOT NULL,
  provider_message_id TEXT,
  stored_message_id   TEXT,
  thread_id           TEXT,
  recorded_at         TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS li_mailbox_sent_stored_id
  ON li_mailbox_sent (mailbox_id, stored_message_id) WHERE stored_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS li_market_rules (
  country_code TEXT PRIMARY KEY CHECK (length(country_code) = 2),
  rule         TEXT NOT NULL CHECK (rule IN ('consent_required', 'opt_out_allowed')),
  note         TEXT NOT NULL,
  reviewed_by  TEXT NOT NULL,
  reviewed_at  TEXT NOT NULL
);

CREATE TABLE li_trust_events_f266 (
  row_id             TEXT PRIMARY KEY,
  event_id           TEXT NOT NULL,
  kind               TEXT NOT NULL CHECK (kind IN ('unsubscribe', 'bounce', 'complaint', 'reply', 'whatsapp_inbound')),
  channel            TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp')),
  recipient_ref      TEXT,
  normalized_address TEXT,
  source             TEXT NOT NULL CHECK (source IN ('relay', 'user', 'mailbox')),
  state              TEXT NOT NULL CHECK (state IN ('applied', 'stored', 'unresolved', 'rejected')),
  reject_code        TEXT,
  received_at        TEXT NOT NULL,
  recorded_at        TEXT NOT NULL
);
INSERT INTO li_trust_events_f266 (row_id, event_id, kind, channel, recipient_ref, normalized_address, source, state, reject_code, received_at, recorded_at)
  SELECT row_id, event_id, kind, channel, recipient_ref, normalized_address, source, state, reject_code, received_at, recorded_at FROM li_trust_events;
DROP TABLE li_trust_events;
ALTER TABLE li_trust_events_f266 RENAME TO li_trust_events;
CREATE UNIQUE INDEX IF NOT EXISTS li_trust_events_once
  ON li_trust_events (event_id) WHERE state != 'rejected';
CREATE INDEX IF NOT EXISTS li_trust_events_by_address ON li_trust_events (channel, normalized_address, received_at DESC);

CREATE TABLE li_suppressions_f266 (
  suppression_id     TEXT PRIMARY KEY,
  scope              TEXT NOT NULL CHECK (scope IN ('workspace', 'global')),
  workspace_id       TEXT,
  channel            TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp')),
  normalized_address TEXT NOT NULL,
  reason             TEXT NOT NULL CHECK (reason IN ('unsubscribe', 'bounce', 'complaint', 'manual')),
  source             TEXT NOT NULL CHECK (source IN ('user', 'relay', 'import', 'mailbox')),
  created_at         TEXT NOT NULL,
  CHECK ((scope = 'global' AND workspace_id IS NULL) OR (scope = 'workspace' AND workspace_id IS NOT NULL))
);
INSERT INTO li_suppressions_f266 (suppression_id, scope, workspace_id, channel, normalized_address, reason, source, created_at)
  SELECT suppression_id, scope, workspace_id, channel, normalized_address, reason, source, created_at FROM li_suppressions;
DROP TABLE li_suppressions;
ALTER TABLE li_suppressions_f266 RENAME TO li_suppressions;
CREATE UNIQUE INDEX IF NOT EXISTS li_suppressions_one
  ON li_suppressions (scope, IFNULL(workspace_id, ''), channel, normalized_address);
CREATE INDEX IF NOT EXISTS li_suppressions_by_address ON li_suppressions (channel, normalized_address);
