-- PostgreSQL 16 schema, migration 008: the Compliance & Trust Foundation.
-- The counterpart of the desktop's migrations/008_trust_foundation.sql. Five
-- tables, the same columns, the same allowlists.
--
-- li_suppressions is the one table that already has a workspace column of its
-- own: `scope` is 'workspace' or 'global', and a global row has no workspace.
-- It therefore keeps that shape here, and the store reads a global row as
-- visible to every workspace.

CREATE TABLE IF NOT EXISTS li_suppressions (
  suppression_id     TEXT PRIMARY KEY,
  scope              TEXT NOT NULL CHECK (scope IN ('workspace', 'global')),
  workspace_id       TEXT,
  channel            TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp')),
  normalized_address TEXT NOT NULL,
  reason             TEXT NOT NULL CHECK (reason IN ('unsubscribe', 'bounce', 'complaint', 'manual')),
  source             TEXT NOT NULL CHECK (source IN ('user', 'relay', 'import')),
  created_at         TIMESTAMPTZ NOT NULL,
  CHECK ((scope = 'global' AND workspace_id IS NULL) OR (scope = 'workspace' AND workspace_id IS NOT NULL))
);
-- One row per (scope, workspace, channel, address): suppressing twice is a no-op, never a duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS li_suppressions_one
  ON li_suppressions (scope, COALESCE(workspace_id, ''), channel, normalized_address);
CREATE INDEX IF NOT EXISTS li_suppressions_by_address ON li_suppressions (channel, normalized_address);

CREATE TABLE IF NOT EXISTS li_contact_consents (
  workspace_id       TEXT NOT NULL,
  consent_id         TEXT PRIMARY KEY,
  lead_id            TEXT NOT NULL,
  channel            TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp')),
  normalized_address TEXT NOT NULL,
  method             TEXT NOT NULL CHECK (method IN ('inbound_message', 'website_form', 'in_person', 'other')),
  evidence_note      TEXT NOT NULL,
  recorded_by        TEXT NOT NULL,
  consented_at       TIMESTAMPTZ NOT NULL,
  recorded_at        TIMESTAMPTZ NOT NULL,
  source             TEXT NOT NULL CHECK (source IN ('user', 'relay')),
  event_id           TEXT
);
CREATE INDEX IF NOT EXISTS li_consents_by_address ON li_contact_consents (channel, normalized_address, consented_at DESC);
CREATE INDEX IF NOT EXISTS li_consents_by_lead ON li_contact_consents (workspace_id, lead_id, recorded_at DESC);

CREATE TABLE IF NOT EXISTS li_contact_provenance (
  workspace_id TEXT NOT NULL,
  lead_id      TEXT NOT NULL,
  field        TEXT NOT NULL CHECK (field IN ('email', 'phone', 'website')),
  source_kind  TEXT NOT NULL CHECK (source_kind IN ('collection_run', 'import', 'manual', 'enrichment', 'unknown')),
  source_ref   TEXT,
  collected_at TIMESTAMPTZ,
  backfilled   BOOLEAN NOT NULL DEFAULT false,
  recorded_at  TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (lead_id, field)
);

CREATE TABLE IF NOT EXISTS li_trust_events (
  workspace_id       TEXT NOT NULL,
  row_id             TEXT PRIMARY KEY,
  event_id           TEXT NOT NULL,
  kind               TEXT NOT NULL CHECK (kind IN ('unsubscribe', 'bounce', 'complaint', 'reply', 'whatsapp_inbound')),
  channel            TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp')),
  recipient_ref      TEXT,
  normalized_address TEXT,
  source             TEXT NOT NULL CHECK (source IN ('relay', 'user')),
  state              TEXT NOT NULL CHECK (state IN ('applied', 'stored', 'unresolved', 'rejected')),
  reject_code        TEXT,
  received_at        TIMESTAMPTZ NOT NULL,
  recorded_at        TIMESTAMPTZ NOT NULL
);
-- Idempotency by event_id for every ACCEPTED event. A rejected row is kept for the
-- record but stays outside the index, so a forged copy can never block the genuine event.
CREATE UNIQUE INDEX IF NOT EXISTS li_trust_events_once
  ON li_trust_events (event_id) WHERE state != 'rejected';
CREATE INDEX IF NOT EXISTS li_trust_events_by_address ON li_trust_events (channel, normalized_address, received_at DESC);

CREATE TABLE IF NOT EXISTS li_recipient_refs (
  workspace_id       TEXT NOT NULL,
  recipient_ref      TEXT PRIMARY KEY,
  channel            TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp')),
  normalized_address TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS li_recipient_refs_by_address ON li_recipient_refs (channel, normalized_address, created_at DESC);