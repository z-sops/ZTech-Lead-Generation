-- ZTech lead-intelligence schema, migration 008: Compliance & Trust Foundation (F26.5).
--
-- Five NEW tables. No existing table is altered, rebuilt or read here.
--
--   li_suppressions        who must never be contacted again on a channel (address-keyed, so it
--                          also blocks FUTURE leads with the same address). Survives purgeLead.
--   li_contact_consents    recorded opt-ins: method + timestamp + evidence note + recorder.
--                          Append-only. Withdrawal is a suppression, which is checked first.
--   li_contact_provenance  where each contact field of a lead came from, and when. Lead data:
--                          removed by purgeLead.
--   li_trust_events        append-only inbox of unsubscribe / bounce / complaint / reply /
--                          whatsapp_inbound events, idempotent by event_id. Survives purgeLead.
--   li_recipient_refs      DESKTOP-ONLY map from the opaque recipient_ref the relay sees to the
--                          address it stands for. The relay never receives a clear address and
--                          the renderer never receives a recipient_ref.
--
-- Addresses are stored NORMALIZED: email lower-cased and trimmed, phone as E.164.
-- IDs, codes, short notes and timestamps only: no pitch text, no research, no credentials.

CREATE TABLE IF NOT EXISTS li_suppressions (
  suppression_id     TEXT PRIMARY KEY,
  scope              TEXT NOT NULL CHECK (scope IN ('workspace', 'global')),
  workspace_id       TEXT,
  channel            TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp')),
  normalized_address TEXT NOT NULL,
  reason             TEXT NOT NULL CHECK (reason IN ('unsubscribe', 'bounce', 'complaint', 'manual')),
  source             TEXT NOT NULL CHECK (source IN ('user', 'relay', 'import')),
  created_at         TEXT NOT NULL,
  CHECK ((scope = 'global' AND workspace_id IS NULL) OR (scope = 'workspace' AND workspace_id IS NOT NULL))
);
-- One row per (scope, workspace, channel, address): suppressing twice is a no-op, never a duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS li_suppressions_one
  ON li_suppressions (scope, IFNULL(workspace_id, ''), channel, normalized_address);
CREATE INDEX IF NOT EXISTS li_suppressions_by_address ON li_suppressions (channel, normalized_address);

CREATE TABLE IF NOT EXISTS li_contact_consents (
  consent_id         TEXT PRIMARY KEY,
  lead_id            TEXT NOT NULL,
  channel            TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp')),
  normalized_address TEXT NOT NULL,
  method             TEXT NOT NULL CHECK (method IN ('inbound_message', 'website_form', 'in_person', 'other')),
  evidence_note      TEXT NOT NULL,
  recorded_by        TEXT NOT NULL,
  consented_at       TEXT NOT NULL,
  recorded_at        TEXT NOT NULL,
  source             TEXT NOT NULL CHECK (source IN ('user', 'relay')),
  event_id           TEXT
);
CREATE INDEX IF NOT EXISTS li_consents_by_address ON li_contact_consents (channel, normalized_address, consented_at DESC);
CREATE INDEX IF NOT EXISTS li_consents_by_lead ON li_contact_consents (lead_id, recorded_at DESC);

CREATE TABLE IF NOT EXISTS li_contact_provenance (
  lead_id      TEXT NOT NULL,
  field        TEXT NOT NULL CHECK (field IN ('email', 'phone', 'website')),
  source_kind  TEXT NOT NULL CHECK (source_kind IN ('collection_run', 'import', 'manual', 'enrichment', 'unknown')),
  source_ref   TEXT,
  collected_at TEXT,
  backfilled   INTEGER NOT NULL DEFAULT 0 CHECK (backfilled IN (0, 1)),
  recorded_at  TEXT NOT NULL,
  PRIMARY KEY (lead_id, field)
);

CREATE TABLE IF NOT EXISTS li_trust_events (
  row_id             TEXT PRIMARY KEY,
  event_id           TEXT NOT NULL,
  kind               TEXT NOT NULL CHECK (kind IN ('unsubscribe', 'bounce', 'complaint', 'reply', 'whatsapp_inbound')),
  channel            TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp')),
  recipient_ref      TEXT,
  normalized_address TEXT,
  source             TEXT NOT NULL CHECK (source IN ('relay', 'user')),
  state              TEXT NOT NULL CHECK (state IN ('applied', 'stored', 'unresolved', 'rejected')),
  reject_code        TEXT,
  received_at        TEXT NOT NULL,
  recorded_at        TEXT NOT NULL
);
-- Idempotency by event_id for every ACCEPTED event. A rejected (bad-signature) row is kept for
-- the record but stays outside the index, so a forged copy can never block the genuine event.
CREATE UNIQUE INDEX IF NOT EXISTS li_trust_events_once
  ON li_trust_events (event_id) WHERE state != 'rejected';
CREATE INDEX IF NOT EXISTS li_trust_events_by_address ON li_trust_events (channel, normalized_address, received_at DESC);

CREATE TABLE IF NOT EXISTS li_recipient_refs (
  recipient_ref      TEXT PRIMARY KEY,
  channel            TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp')),
  normalized_address TEXT NOT NULL,
  created_at         TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS li_recipient_refs_one ON li_recipient_refs (channel, normalized_address);
