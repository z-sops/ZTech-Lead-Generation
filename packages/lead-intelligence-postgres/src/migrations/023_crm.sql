-- 023: CRM and sales pipeline (Phase 3, P09).
--
-- Three tenant tables, isolated exactly like every other tenant table
-- (014): row-level security ENABLED and FORCED, the tenant_isolation policy
-- on li.current_workspace(), and workspace-aware foreign keys so a note or an
-- activity can only point at an account of the SAME workspace.
--
--   li_crm_accounts  a business the customer is selling to, its pipeline
--                    stage, owner, value and next step. Never deleted:
--                    archived, so the history stays whole.
--   li_crm_notes     what a person wrote about an account. Append-only.
--   li_crm_activity  the audit trail of every change (who, what, when).
--                    Append-only: the runtime role may INSERT and SELECT,
--                    never UPDATE or DELETE, so the trail cannot be edited.
--
-- Only the API role (ztech_app) is granted these tables. The worker has no
-- reason to touch the CRM and gets nothing.

CREATE TABLE IF NOT EXISTS li.li_crm_accounts (
  workspace_id          UUID        NOT NULL,
  account_id            UUID        NOT NULL,
  name                  TEXT        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  website               TEXT        CHECK (website IS NULL OR char_length(website) <= 500),
  phone                 TEXT        CHECK (phone IS NULL OR char_length(phone) <= 60),
  address               TEXT        CHECK (address IS NULL OR char_length(address) <= 300),
  stage                 TEXT        NOT NULL DEFAULT 'new'
                        CHECK (stage IN ('new','contacted','replied','meeting','proposal','won','lost')),
  lost_reason           TEXT        CHECK (lost_reason IS NULL OR char_length(lost_reason) <= 300),
  owner_user_id         UUID,
  estimated_value_cents BIGINT      CHECK (estimated_value_cents IS NULL OR estimated_value_cents BETWEEN 0 AND 100000000000),
  currency              TEXT        NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  next_step             TEXT        CHECK (next_step IS NULL OR char_length(next_step) <= 300),
  next_step_at          TIMESTAMPTZ,
  source                TEXT        NOT NULL CHECK (source IN ('manual','research')),
  source_job_id         UUID,
  source_business_id    TEXT        CHECK (source_business_id IS NULL OR char_length(source_business_id) <= 120),
  source_url            TEXT        CHECK (source_url IS NULL OR char_length(source_url) <= 500),
  research_score        INTEGER     CHECK (research_score IS NULL OR research_score BETWEEN 0 AND 100),
  created_by            UUID        NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by            UUID        NOT NULL,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at           TIMESTAMPTZ,
  version               INTEGER     NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (workspace_id, account_id),
  CONSTRAINT li_crm_accounts_lost_reason CHECK (stage = 'lost' OR lost_reason IS NULL),
  CONSTRAINT li_crm_accounts_research_source CHECK (source = 'manual' OR (source_job_id IS NOT NULL AND source_business_id IS NOT NULL))
);
-- One account per researched business per workspace: importing the same
-- business twice (from two research jobs) finds the existing account.
CREATE UNIQUE INDEX IF NOT EXISTS li_crm_accounts_source_business
  ON li.li_crm_accounts (workspace_id, source_business_id) WHERE source_business_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS li_crm_accounts_stage ON li.li_crm_accounts (workspace_id, stage, updated_at DESC);

CREATE TABLE IF NOT EXISTS li.li_crm_notes (
  workspace_id   UUID        NOT NULL,
  note_id        UUID        NOT NULL,
  account_id     UUID        NOT NULL,
  body           TEXT        NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  author_user_id UUID        NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, note_id),
  CONSTRAINT li_crm_notes_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES li.li_crm_accounts (workspace_id, account_id)
);
CREATE INDEX IF NOT EXISTS li_crm_notes_account ON li.li_crm_notes (workspace_id, account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS li.li_crm_activity (
  workspace_id  UUID        NOT NULL,
  activity_id   UUID        NOT NULL,
  account_id    UUID        NOT NULL,
  kind          TEXT        NOT NULL CHECK (kind IN ('created','imported','updated','stage_changed','assigned','note_added','archived','restored')),
  detail        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  actor_user_id UUID        NOT NULL,
  at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, activity_id),
  CONSTRAINT li_crm_activity_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES li.li_crm_accounts (workspace_id, account_id)
);
CREATE INDEX IF NOT EXISTS li_crm_activity_account ON li.li_crm_activity (workspace_id, account_id, at DESC);

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['li_crm_accounts', 'li_crm_notes', 'li_crm_activity'] LOOP
    EXECUTE format('ALTER TABLE li.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE li.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON li.%I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON li.%I '
      'USING (workspace_id = li.current_workspace()) '
      'WITH CHECK (workspace_id = li.current_workspace())', t);
    EXECUTE format('REVOKE ALL ON li.%I FROM PUBLIC', t);
  END LOOP;
END;
$$;

-- Accounts are updated (stage, owner, next step) and archived, never deleted.
GRANT SELECT, INSERT, UPDATE ON li.li_crm_accounts TO ztech_app;
-- Notes and the activity trail are append-only.
GRANT SELECT, INSERT ON li.li_crm_notes, li.li_crm_activity TO ztech_app;
