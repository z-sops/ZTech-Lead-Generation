-- PostgreSQL 16 schema, migration 014: tenant isolation (M2).
--
-- This migration turns the workspace column from a CONVENTION into an
-- ENFORCED boundary. After it, a customer in workspace A cannot read,
-- modify, delete, reference or control workspace B's records - not because
-- the application filters by workspace, but because the DATABASE refuses.
--
-- The three parts:
--
--   1. The workspace CONTEXT. A transaction-local setting, `app.workspace_id`,
--      that the server sets from the authenticated session and that the
--      database derives from the connection's ROLE - never from the request.
--
--   2. The POLICIES. Every tenant-owned table has row-level security
--      ENABLED and FORCED, with a policy that compares the row's workspace
--      with the context. A missing context, an invalid context, or a
--      mismatched context all FAIL CLOSED: the context function returns NULL
--      and no row is ever visible or writable.
--
--   3. The RELATIONSHIPS. The foreign keys are workspace-aware, so a tenant
--      cannot point a row at another tenant's record even if the id is
--      known.
--
-- The roles are provisioned separately (roles.sql): this file is applied by
-- the MIGRATION role, which owns the tables, and the runtime roles get the
-- minimum they need.

-- ---------------------------------------------------------------------------
-- 1. The workspace context
-- ---------------------------------------------------------------------------

-- Which workspaces a database role may act for. The table is owned by the
-- migration role and is NOT readable by the runtime roles: only the
-- set_workspace() function below reads it, and it does so with the owner's
-- rights.
CREATE TABLE IF NOT EXISTS li.workspace_grants (
  role_name    TEXT NOT NULL,
  workspace_id UUID NOT NULL,
  PRIMARY KEY (role_name, workspace_id)
);
REVOKE ALL ON li.workspace_grants FROM PUBLIC;

-- The workspace of the current transaction, or NULL when there is none (or
-- when the setting is not a uuid). NULL means "no context", and every policy
-- compares against NULL - so a missing or invalid context matches no row
-- and allows no write. It fails closed, it never fails open.
--
-- It is a plain STABLE function: it needs no elevated rights, and it is
-- REVOKEd from PUBLIC so that only the runtime roles may call it.
CREATE OR REPLACE FUNCTION li.current_workspace() RETURNS UUID
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  v TEXT;
BEGIN
  v := current_setting('app.workspace_id', TRUE);
  IF v IS NULL OR v = '' THEN
    RETURN NULL;
  END IF;
  RETURN v::UUID;
EXCEPTION WHEN others THEN
  -- An invalid context is a closed door, not a crash and not a wildcard.
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION li.current_workspace() FROM PUBLIC;

-- Set the workspace context for the CURRENT transaction.
--
-- SECURITY DEFINER, because the runtime role may not read the grants table.
-- It is restricted to the workspaces the CALLING role is entitled to, so a
-- caller that passes somebody else's workspace id gets an error and no
-- context: the request can never choose the security context.
--
-- `SET LOCAL` semantics: the setting disappears at COMMIT or ROLLBACK, so a
-- pooled connection can never carry one tenant's context into another
-- tenant's work.
CREATE OR REPLACE FUNCTION li.set_workspace(p_workspace UUID) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, li
AS $$
DECLARE
  v_allowed BOOLEAN;
BEGIN
  IF p_workspace IS NULL THEN
    RAISE EXCEPTION 'a workspace context is required' USING ERRCODE = '22023';
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM li.workspace_grants g
    WHERE g.role_name = session_user AND g.workspace_id = p_workspace
  ) INTO v_allowed;
  IF NOT v_allowed THEN
    RAISE EXCEPTION 'workspace % is not granted to %', p_workspace, session_user USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('app.workspace_id', p_workspace::TEXT, TRUE);
END;
$$;
REVOKE ALL ON FUNCTION li.set_workspace(UUID) FROM PUBLIC;

-- The privacy-preserving suppression check. It answers "is this address
-- suppressed, here or globally?" and returns a BOOLEAN - never an address,
-- never a row. It is SECURITY DEFINER because the tenant must not be able to
-- read the platform's suppression rows at all.
CREATE OR REPLACE FUNCTION li.is_suppressed(p_channel TEXT, p_address TEXT) RETURNS BOOLEAN
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = pg_catalog, li
AS $$
  SELECT EXISTS (
    SELECT 1 FROM li_suppressions s
    WHERE s.channel = p_channel
      AND s.normalized_address = p_address
      AND (
        s.workspace_id = li.current_workspace()
        OR (s.scope = 'global' AND s.workspace_id = '00000000-0000-0000-0000-000000000000'::UUID)
      )
  );
$$;
REVOKE ALL ON FUNCTION li.is_suppressed(TEXT, TEXT) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 2. The policies
-- ---------------------------------------------------------------------------

-- Every tenant-owned table. The list is explicit: a table that is forgotten
-- here is a table with no isolation, and the startup assertion (assertRoles.js)
-- compares this list with the live database and fails if they differ.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'li_research_jobs', 'li_evidence_packets', 'li_research_changes', 'li_saved_searches',
    'li_segments', 'li_segment_members', 'li_pitch_drafts', 'li_outreach_approvals',
    'li_outreach_activity', 'li_outreach_sends', 'li_enrichment_jobs', 'li_enrichment_observations',
    'li_oi_associations', 'li_oi_refresh_requests', 'li_suppressions', 'li_contact_consents',
    'li_contact_provenance', 'li_trust_events', 'li_recipient_refs', 'li_mailboxes',
    'li_mailbox_sent', 'li_reply_reviews', 'li_sequences', 'li_sequence_steps',
    'li_sequence_events', 'li_sequence_gaps', 'li_sequence_control', 'li_reply_routes'
  ] LOOP
    EXECUTE format('ALTER TABLE li.%I ENABLE ROW LEVEL SECURITY', t);
    -- FORCE makes the policy apply to the TABLE OWNER too. Without it the
    -- owner (the migration role) would still see every tenant's rows.
    EXECUTE format('ALTER TABLE li.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON li.%I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON li.%I '
      'USING (workspace_id = li.current_workspace()) '
      'WITH CHECK (workspace_id = li.current_workspace())', t);
  END LOOP;
END;
$$;

-- The suppressions need their own policies: a tenant sees and writes only
-- its OWN rows, and the platform's global rows are invisible to it - the
-- privacy-preserving li.is_suppressed() function is the only way to ask
-- about them.
DROP POLICY IF EXISTS tenant_isolation ON li.li_suppressions;
CREATE POLICY tenant_isolation ON li.li_suppressions
  USING (workspace_id = li.current_workspace() AND scope = 'workspace')
  WITH CHECK (workspace_id = li.current_workspace() AND scope = 'workspace');

-- The platform's own policy on the same table: it may manage the global
-- rows, and ONLY the global rows. A tenant's suppression rows are not the
-- platform's to read - the platform console reaches a tenant's data through
-- the break-glass path, which is audited, not through this table.
DROP POLICY IF EXISTS platform_global ON li.li_suppressions;
CREATE POLICY platform_global ON li.li_suppressions FOR ALL TO ztech_platform
  USING (workspace_id = '00000000-0000-0000-0000-000000000000'::UUID)
  WITH CHECK (workspace_id = '00000000-0000-0000-0000-000000000000'::UUID);

-- ---------------------------------------------------------------------------
-- 3. The relationships
-- ---------------------------------------------------------------------------

-- A workspace-aware foreign key: a step or an approval may only point at a
-- record of the SAME workspace. The business identifiers are unchanged - the
-- composite key is (workspace_id, <id>), and the id itself keeps its format.
--
-- A row of another tenant can therefore be neither referenced nor shadowed:
-- the reference does not exist for this workspace, and the primary key
-- collision creates a separate row rather than blocking the tenant.
ALTER TABLE li.li_sequence_steps DROP CONSTRAINT IF EXISTS li_sequence_steps_sequence_fk;
ALTER TABLE li.li_sequence_steps ADD CONSTRAINT li_sequence_steps_sequence_fk
  FOREIGN KEY (workspace_id, sequence_id) REFERENCES li.li_sequences (workspace_id, sequence_id)
  ON DELETE CASCADE;

ALTER TABLE li.li_outreach_approvals DROP CONSTRAINT IF EXISTS li_outreach_approvals_pitch_fk;
ALTER TABLE li.li_outreach_approvals ADD CONSTRAINT li_outreach_approvals_pitch_fk
  FOREIGN KEY (workspace_id, pitch_id) REFERENCES li.li_pitch_drafts (workspace_id, pitch_id)
  ON DELETE CASCADE;

-- ---------------------------------------------------------------------------
-- 4. The permissions
-- ---------------------------------------------------------------------------

-- Nothing is granted to PUBLIC. The runtime roles get exactly what they
-- need, and the owner keeps everything.
REVOKE ALL ON SCHEMA li FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA li FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA li FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA li FROM PUBLIC;
REVOKE CREATE ON SCHEMA li FROM PUBLIC;

-- The sequences behind the `seq` columns are for the insertion order.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA li TO ztech_app, ztech_worker, ztech_platform;

-- The tenant tables. The runtime roles may read and write them; they do NOT
-- own them, and they cannot change them. The list is the tenant inventory,
-- so the global tables are NOT included: the market rules are read-only for
-- a tenant, and the migration ledger is nobody's business but the migrator's.
GRANT USAGE ON SCHEMA li TO ztech_app, ztech_worker, ztech_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  li.li_research_jobs, li.li_evidence_packets, li.li_research_changes, li.li_saved_searches,
  li.li_segments, li.li_segment_members, li.li_pitch_drafts, li.li_outreach_approvals,
  li.li_outreach_activity, li.li_outreach_sends, li.li_enrichment_jobs, li.li_enrichment_observations,
  li.li_oi_associations, li.li_oi_refresh_requests, li.li_contact_consents,
  li.li_contact_provenance, li.li_trust_events, li.li_recipient_refs, li.li_mailboxes,
  li.li_mailbox_sent, li.li_reply_reviews, li.li_sequences, li.li_sequence_steps,
  li.li_sequence_events, li.li_sequence_gaps, li.li_sequence_control, li.li_reply_routes
  TO ztech_app, ztech_worker;

-- The suppressions: a tenant may manage its OWN rows, and the platform may
-- manage the global ones. Nobody else.
GRANT SELECT, INSERT, UPDATE, DELETE ON li.li_suppressions TO ztech_app, ztech_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON li.li_suppressions TO ztech_platform;

-- The platform's own powers: the global reference data, and the platform's
-- suppression rows. A tenant READS the market rules - they decide what is
-- permitted - and may not write them.
GRANT SELECT ON li.li_market_rules TO ztech_app, ztech_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON li.li_market_rules TO ztech_platform;

-- The functions the runtime roles may call. Everything else is revoked from
-- PUBLIC above.
GRANT EXECUTE ON FUNCTION li.set_workspace(UUID) TO ztech_app, ztech_worker, ztech_platform;
GRANT EXECUTE ON FUNCTION li.current_workspace() TO ztech_app, ztech_worker, ztech_platform;
GRANT EXECUTE ON FUNCTION li.is_suppressed(TEXT, TEXT) TO ztech_app, ztech_worker;

-- The migration role keeps everything it owns, and it alone may change the
-- schema. The runtime roles may not.
GRANT ALL ON SCHEMA li TO ztech_migrator;
GRANT ALL ON ALL TABLES IN SCHEMA li TO ztech_migrator;
GRANT ALL ON ALL SEQUENCES IN SCHEMA li TO ztech_migrator;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA li TO ztech_migrator;
