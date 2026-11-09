-- 024: competitor ad watches (Phase 3 add-on: Meta ads monitoring).
--
-- A watch = one advertiser (a Facebook page name, slug or id) in one country
-- that the workspace follows week by week. The ads themselves are fetched by
-- the worker through the Meta Ads connector and stored as job results in
-- li.job_queue (kind = competitor_ads), exactly like research results: the
-- worker gains no new privilege. This table only says WHAT is watched.
--
-- Isolation as every tenant table (014): RLS enabled and forced with the
-- tenant_isolation policy; an optional link to a CRM account of the SAME
-- workspace. The API role may read, add and update watches (archive, not
-- delete); the worker gets nothing.

CREATE TABLE IF NOT EXISTS li.li_competitor_watches (
  workspace_id  UUID        NOT NULL,
  watch_id      UUID        NOT NULL,
  label         TEXT        NOT NULL CHECK (char_length(label) BETWEEN 1 AND 120),
  query         TEXT        NOT NULL CHECK (char_length(query) BETWEEN 1 AND 120),
  page_id       TEXT        CHECK (page_id IS NULL OR page_id ~ '^[0-9]{3,25}$'),
  country       TEXT        NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  account_id    UUID,
  created_by    UUID        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at   TIMESTAMPTZ,
  PRIMARY KEY (workspace_id, watch_id),
  CONSTRAINT li_competitor_watches_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES li.li_crm_accounts (workspace_id, account_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS li_competitor_watches_unique
  ON li.li_competitor_watches (workspace_id, lower(query), country) WHERE archived_at IS NULL;

ALTER TABLE li.li_competitor_watches ENABLE ROW LEVEL SECURITY;
ALTER TABLE li.li_competitor_watches FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON li.li_competitor_watches;
CREATE POLICY tenant_isolation ON li.li_competitor_watches
  USING (workspace_id = li.current_workspace())
  WITH CHECK (workspace_id = li.current_workspace());
REVOKE ALL ON li.li_competitor_watches FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON li.li_competitor_watches TO ztech_app;
