-- PostgreSQL 16 schema, migration 012: the email follow-up sequences.
-- The counterpart of the desktop's migrations/012_sequences.sql.
--
-- The status allowlist, the one-open-sequence-per-lead partial unique index, the
-- one-sequence-per-first-email unique index and the CHECKs that tie a stopped
-- sequence to a stop reason and a paused one to a hold code are all kept
-- exactly as they are on the desktop.
--
-- li_sequence_control holds the one global "Pause all follow-ups" switch, so it
-- is GLOBAL and carries no workspace.

CREATE TABLE IF NOT EXISTS li_sequences (
  workspace_id      UUID NOT NULL,
  sequence_id       TEXT NOT NULL,
  PRIMARY KEY (workspace_id, sequence_id),
  lead_id           TEXT NOT NULL,
  mailbox_id        TEXT NOT NULL,
  first_send_id     TEXT NOT NULL,
  first_pitch_id    TEXT NOT NULL,
  thread_id         TEXT NOT NULL,
  first_subject     TEXT NOT NULL,
  recipient_address TEXT NOT NULL,
  first_accepted_at TIMESTAMPTZ NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('draft', 'active', 'paused', 'stopped', 'completed')),
  hold_code         TEXT,
  resume_at         TIMESTAMPTZ,
  replies_gap_at    TIMESTAMPTZ,
  stop_reason       TEXT CHECK (stop_reason IS NULL OR stop_reason IN ('replied', 'suppressed', 'manual', 'contact_changed')),
  activated_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL,
  updated_at        TIMESTAMPTZ NOT NULL,
  CHECK ((status = 'stopped') = (stop_reason IS NOT NULL)),
  CHECK ((status = 'paused') = (hold_code IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS li_sequences_one_open ON li_sequences (workspace_id, lead_id) WHERE status IN ('draft', 'active', 'paused');
CREATE UNIQUE INDEX IF NOT EXISTS li_sequences_one_per_first ON li_sequences (workspace_id, first_send_id);
CREATE INDEX IF NOT EXISTS li_sequences_by_status ON li_sequences (workspace_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS li_sequence_steps (
  workspace_id    UUID NOT NULL,
  sequence_id     TEXT NOT NULL,
  step_no         INTEGER NOT NULL CHECK (step_no BETWEEN 1 AND 3),
  pitch_id        TEXT NOT NULL,
  delay_days      INTEGER NOT NULL CHECK (delay_days BETWEEN 2 AND 60),
  state           TEXT NOT NULL CHECK (state IN ('waiting', 'scheduled', 'sending', 'sent', 'stopped')),
  due_at          TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ,
  send_id         TEXT,
  sent_at         TIMESTAMPTZ,
  last_code       TEXT,
  limit_strikes   INTEGER NOT NULL DEFAULT 0 CHECK (limit_strikes BETWEEN 0 AND 10),
  draft_json      JSONB NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (workspace_id, sequence_id, step_no)
);
CREATE UNIQUE INDEX IF NOT EXISTS li_sequence_steps_pitch ON li_sequence_steps (workspace_id, pitch_id);
CREATE INDEX IF NOT EXISTS li_sequence_steps_due ON li_sequence_steps (workspace_id, state, next_attempt_at);

CREATE TABLE IF NOT EXISTS li_sequence_events (
  workspace_id UUID NOT NULL,
  seq          BIGSERIAL,
  event_id     TEXT NOT NULL,
  PRIMARY KEY (workspace_id, event_id),
  sequence_id  TEXT NOT NULL,
  step_no      INTEGER,
  actor        TEXT NOT NULL CHECK (actor IN ('operator', 'scheduler')),
  event        TEXT NOT NULL CHECK (event IN ('created', 'activated', 'sent', 'rescheduled', 'paused', 'resumed', 'stopped', 'completed')),
  code         TEXT,
  at           TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS li_sequence_events_by_sequence ON li_sequence_events (workspace_id, sequence_id, at DESC);

-- The latest reply-history gap per mailbox.
CREATE TABLE IF NOT EXISTS li_sequence_gaps (
  workspace_id UUID NOT NULL,
  mailbox_id   TEXT NOT NULL,
  PRIMARY KEY (workspace_id, mailbox_id),
  gap_at       TIMESTAMPTZ NOT NULL
);

-- The "Pause all follow-ups" switch is WORKSPACE-SCOPED: one customer's pause
-- must not pause another customer's sequences. The key is (workspace_id, id)
-- and the id is still 1, so every workspace has exactly one switch.
CREATE TABLE IF NOT EXISTS li_sequence_control (
  workspace_id UUID NOT NULL,
  id           INTEGER NOT NULL CHECK (id = 1),
  paused       BOOLEAN NOT NULL DEFAULT false,
  updated_at   TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (workspace_id, id)
);