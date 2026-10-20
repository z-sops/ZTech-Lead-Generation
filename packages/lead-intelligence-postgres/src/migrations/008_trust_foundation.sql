-- PostgreSQL 16 schema, migration 008: the Compliance & Trust Foundation.
-- The counterpart of the desktop's migrations/008_trust_foundation.sql. Five
-- tables, the same columns, the same allowlists.
--
-- li_suppressions is the one table that already has a workspace column of its
-- own: `scope` is 'workspace' or 'global', and a global row has no workspace.
-- It therefore keeps that shape here, and the store reads a global row as
-- visible to every workspace.

CREATE TABLE IF NOT EXISTS li_suppressions (
  suppression_id     TEXT NOT NULL,
  scope              TEXT NOT NULL CHECK (scope IN ('workspace', 'global')),
  workspace_id       UUID NOT NULL,
  channel            TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp')),
  normalized_address TEXT NOT NULL,
  reason             TEXT NOT NULL CHECK (reason IN ('unsubscribe', 'bounce', 'complaint', 'manual')),
  source             TEXT NOT NULL CHECK (source IN ('user', 'relay', 'import')),
  created_at         TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (workspace_id, suppression_id),
  -- A GLOBAL suppression belongs to the PLATFORM workspace - the reserved
  -- all-zero uuid - and a workspace suppression belongs to a tenant. So a
  -- global row is never NULL-scoped, and the key is tenant-safe like every
  -- other one. A tenant may be BLOCKED by a global row, but that row's
  -- address is never shown to it: the tenant store redacts it.
  CHECK ((scope = 'global' AND workspace_id = '00000000-0000-0000-0000-000000000000'::uuid)
      OR (scope = 'workspace' AND workspace_id <> '00000000-0000-0000-0000-000000000000'::uuid))
);
-- One row per (scope, workspace, channel, address): suppressing twice is a no-op, never a duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS li_suppressions_one
  ON li_suppressions (workspace_id, scope, channel, normalized_address);
CREATE INDEX IF NOT EXISTS li_suppressions_by_address ON li_suppressions (workspace_id, channel, normalized_address);

CREATE TABLE IF NOT EXISTS li_contact_consents (
  workspace_id       UUID NOT NULL,
  consent_id         TEXT NOT NULL,
  PRIMARY KEY (workspace_id, consent_id),
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
CREATE INDEX IF NOT EXISTS li_consents_by_address ON li_contact_consents (workspace_id, channel, normalized_address, consented_at DESC);
CREATE INDEX IF NOT EXISTS li_consents_by_lead ON li_contact_consents (workspace_id, lead_id, recorded_at DESC);

CREATE TABLE IF NOT EXISTS li_contact_provenance (
  workspace_id UUID NOT NULL,
  lead_id      TEXT NOT NULL,
  field        TEXT NOT NULL CHECK (field IN ('email', 'phone', 'website')),
  source_kind  TEXT NOT NULL CHECK (source_kind IN ('collection_run', 'import', 'manual', 'enrichment', 'unknown')),
  source_ref   TEXT,
  collected_at TIMESTAMPTZ,
  backfilled   BOOLEAN NOT NULL DEFAULT false,
  recorded_at  TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (workspace_id, lead_id, field)
);

CREATE TABLE IF NOT EXISTS li_trust_events (
  workspace_id       UUID NOT NULL,
  row_id             TEXT NOT NULL,
  PRIMARY KEY (workspace_id, row_id),
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
  ON li_trust_events (workspace_id, event_id) WHERE state != 'rejected';
CREATE INDEX IF NOT EXISTS li_trust_events_by_address ON li_trust_events (workspace_id, channel, normalized_address, received_at DESC);

CREATE TABLE IF NOT EXISTS li_recipient_refs (
  workspace_id       UUID NOT NULL,
  recipient_ref      TEXT NOT NULL,
  PRIMARY KEY (workspace_id, recipient_ref),
  channel            TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp')),
  normalized_address TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS li_recipient_refs_by_address ON li_recipient_refs (workspace_id, channel, normalized_address, created_at DESC);