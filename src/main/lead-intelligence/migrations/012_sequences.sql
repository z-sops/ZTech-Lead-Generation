-- ZTech lead-intelligence schema, migration 012: email follow-up sequences (F28).
--
-- A sequence belongs to ONE lead and ONE connected mailbox and starts from ONE first email that
-- the mailbox sent, Gmail accepted and ZTech read back (its provider-stored Message-ID and thread).
-- It holds 1-3 follow-up steps. Each step carries its own follow-up pitch (draft_json) and is
-- approved like any pitch (li_outreach_approvals, bound to its content hash).
--
-- F28 D1 (Zee, 7 Oct 2026): once a human has approved every step and ACTIVATED the sequence,
-- ZTech's scheduler may send each due step by itself - for these steps only. Every send re-runs
-- every gate. Nothing here can send: these tables only record what was decided and what happened.
--
-- status (closed):
--   draft      steps being written / approved; nothing is scheduled
--   active     the scheduler may send due steps
--   paused     held; hold_code says why (some resume by themselves, see SequenceService)
--   stopped    final (stop_reason); a stopped sequence never restarts
--   completed  every step was accepted
-- At most ONE open (draft / active / paused) sequence per lead, and one sequence per first email
-- ever: a new sequence needs a new first email.
-- replies_gap_at: set when Gmail could no longer give the reply history (a cursor reset) while
-- this sequence was open. A reply in that gap was never read, so nothing is sent until a human
-- has looked (Resume, or Activate for a draft, clears it).
--
-- Retention: purgeLead removes a lead's sequences and steps (lead data). li_sequence_events is an
-- append-only audit (ids, codes, times - never content or an address) and is KEPT, like the send
-- ledger. li_sequence_control holds the one global "Pause all follow-ups" switch; li_sequence_gaps
-- the latest reply-history gap per mailbox (no content, no address).

CREATE TABLE IF NOT EXISTS li_sequences (
  sequence_id       TEXT PRIMARY KEY,
  lead_id           TEXT NOT NULL,
  mailbox_id        TEXT NOT NULL,
  first_send_id     TEXT NOT NULL,
  first_pitch_id    TEXT NOT NULL,
  thread_id         TEXT NOT NULL,
  first_subject     TEXT NOT NULL,
  recipient_address TEXT NOT NULL,
  first_accepted_at TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('draft', 'active', 'paused', 'stopped', 'completed')),
  hold_code         TEXT,
  resume_at         TEXT,
  replies_gap_at    TEXT,
  stop_reason       TEXT CHECK (stop_reason IS NULL OR stop_reason IN ('replied', 'suppressed', 'manual', 'contact_changed')),
  activated_at      TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  CHECK ((status = 'stopped') = (stop_reason IS NOT NULL)),
  CHECK ((status = 'paused') = (hold_code IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS li_sequences_one_open ON li_sequences (lead_id) WHERE status IN ('draft', 'active', 'paused');
CREATE UNIQUE INDEX IF NOT EXISTS li_sequences_one_per_first ON li_sequences (first_send_id);
CREATE INDEX IF NOT EXISTS li_sequences_by_status ON li_sequences (status, updated_at);

CREATE TABLE IF NOT EXISTS li_sequence_steps (
  sequence_id     TEXT NOT NULL,
  step_no         INTEGER NOT NULL CHECK (step_no BETWEEN 1 AND 3),
  pitch_id        TEXT NOT NULL,
  delay_days      INTEGER NOT NULL CHECK (delay_days BETWEEN 2 AND 60),
  state           TEXT NOT NULL CHECK (state IN ('waiting', 'scheduled', 'sending', 'sent', 'stopped')),
  due_at          TEXT,
  next_attempt_at TEXT,
  send_id         TEXT,
  sent_at         TEXT,
  last_code       TEXT,
  limit_strikes   INTEGER NOT NULL DEFAULT 0 CHECK (limit_strikes BETWEEN 0 AND 10),
  draft_json      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (sequence_id, step_no)
);
CREATE UNIQUE INDEX IF NOT EXISTS li_sequence_steps_pitch ON li_sequence_steps (pitch_id);
CREATE INDEX IF NOT EXISTS li_sequence_steps_due ON li_sequence_steps (state, next_attempt_at);

CREATE TABLE IF NOT EXISTS li_sequence_events (
  event_id    TEXT PRIMARY KEY,
  sequence_id TEXT NOT NULL,
  step_no     INTEGER,
  actor       TEXT NOT NULL CHECK (actor IN ('operator', 'scheduler')),
  event       TEXT NOT NULL CHECK (event IN ('created', 'activated', 'sent', 'rescheduled', 'paused', 'resumed', 'stopped', 'completed')),
  code        TEXT,
  at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS li_sequence_events_by_sequence ON li_sequence_events (sequence_id, at);

-- The latest reply-history gap per mailbox, so a sequence created AFTER a gap (from a first email
-- sent before it) still knows a reply may be unread.
CREATE TABLE IF NOT EXISTS li_sequence_gaps (
  mailbox_id TEXT PRIMARY KEY,
  gap_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS li_sequence_control (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  paused     INTEGER NOT NULL CHECK (paused IN (0, 1)),
  updated_at TEXT NOT NULL
);
