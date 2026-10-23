-- PostgreSQL 16 schema, migration 010: the native mailbox transport.
-- The counterpart of the desktop's migrations/010_mailbox_transport.sql.
--
-- 1. li_outreach_sends gains a nullable mailbox_id.
-- 2. li_mailboxes: one row per connected mailbox. Sanitized identity, status and
--    limits only: no token, no auth code, no client secret.
-- 3. li_mailbox_sent: the identifiers the provider stored, and the normalized
--    address the send went to.
-- 4. li_market_rules: the per-country market rule. This table is GLOBAL - a
--    market rule is the same in every workspace - so it carries no workspace.
-- 5. li_trust_events and li_suppressions are widened to admit the source
--    'mailbox'. The constraint is dropped and re-added; no row is touched.

ALTER TABLE li_outreach_sends ADD COLUMN IF NOT EXISTS mailbox_id TEXT;
CREATE INDEX IF NOT EXISTS li_sends_by_mailbox ON li_outreach_sends (workspace_id, mailbox_id, created_at DESC);

CREATE TABLE IF NOT EXISTS li_mailboxes (
  workspace_id    UUID NOT NULL,
  mailbox_id      TEXT NOT NULL,
  PRIMARY KEY (workspace_id, mailbox_id),
  provider        TEXT NOT NULL CHECK (provider IN ('gmail', 'microsoft365')),
  email_address   TEXT NOT NULL,
  display_name    TEXT,
  status          TEXT NOT NULL CHECK (status IN ('needs_check', 'ready', 'paused', 'reconnect_needed')),
  status_code     TEXT,
  paused_until    TIMESTAMPTZ,
  daily_cap       INTEGER NOT NULL CHECK (daily_cap BETWEEN 1 AND 200),
  hourly_cap      INTEGER NOT NULL CHECK (hourly_cap BETWEEN 1 AND 30),
  min_gap_seconds INTEGER NOT NULL CHECK (min_gap_seconds >= 60),
  window_start    TIME NOT NULL,
  window_end      TIME NOT NULL,
  window_days     TEXT NOT NULL,
  time_zone       TEXT NOT NULL,
  is_default      BOOLEAN NOT NULL DEFAULT false,
  sync_cursor     TEXT,
  connected_at    TIMESTAMPTZ NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS li_mailboxes_one_address ON li_mailboxes (workspace_id, provider, email_address);

CREATE TABLE IF NOT EXISTS li_mailbox_sent (
  workspace_id        UUID NOT NULL,
  send_id             TEXT NOT NULL,
  PRIMARY KEY (workspace_id, send_id),
  mailbox_id          TEXT NOT NULL,
  provider_message_id TEXT,
  stored_message_id   TEXT,
  thread_id           TEXT,
  recipient_address   TEXT,
  recorded_at         TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS li_mailbox_sent_stored_id
  ON li_mailbox_sent (workspace_id, mailbox_id, stored_message_id) WHERE stored_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS li_market_rules (
  country_code TEXT PRIMARY KEY CHECK (length(country_code) = 2),
  rule         TEXT NOT NULL CHECK (rule IN ('consent_required', 'opt_out_allowed')),
  note         TEXT NOT NULL,
  reviewed_by  TEXT NOT NULL,
  reviewed_at  TIMESTAMPTZ NOT NULL
);

ALTER TABLE li_trust_events DROP CONSTRAINT IF EXISTS li_trust_events_source_check;
ALTER TABLE li_trust_events ADD CONSTRAINT li_trust_events_source_check CHECK (source IN ('relay', 'user', 'mailbox'));

ALTER TABLE li_suppressions DROP CONSTRAINT IF EXISTS li_suppressions_source_check;
ALTER TABLE li_suppressions ADD CONSTRAINT li_suppressions_source_check CHECK (source IN ('user', 'relay', 'import', 'mailbox'));