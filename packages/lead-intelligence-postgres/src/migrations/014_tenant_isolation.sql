-- PostgreSQL 16 schema, migration 014: tenant isolation (M2).
--
-- This migration turns the workspace column from a CONVENTION into an
-- ENFORCED boundary. After it, a customer in workspace A cannot read,
-- modify, delete, reference or control workspace B's records - not because
-- the application filters by workspace, but because the DATABASE refuses.
--
-- ---------------------------------------------------------------------------
-- THE TRUST BOUNDARY
-- ---------------------------------------------------------------------------
--
-- The database is told which tenant a session is acting for. The question
-- this migration answers is: WHO is allowed to say that, and HOW is it
-- proved?
--
-- The first implementation put the context in the custom setting
-- `app.workspace_id` and had the policy compare the row's workspace with
-- `current_setting('app.workspace_id')`. That was FORGEABLE: a custom
-- setting is ordinary configuration, and ANY role may write one with
-- `set_config()`. A session that was authorised for workspace A could
-- simply write B's id into the setting and read - and write - B's rows.
-- The RLS policy trusted a value the caller controlled.
--
-- PostgreSQL 16 cannot close that door by locking the setting down:
-- `REVOKE SET ON PARAMETER` only applies to KNOWN parameters, and a custom
-- placeholder is not one. The setting is, and always will be, writable by
-- whoever runs the SQL. So the context must not live in a setting at all.
--
-- It lives in a TABLE instead:
--
--   1. THE CONTEXT is a row in li.workspace_context. The runtime roles have
--      NO privilege on that table - not SELECT, not INSERT, not UPDATE, not
--      DELETE, not TRUNCATE. The only writer is the SECURITY DEFINER
--      function below, which runs with the migration role's rights. A
--      session that runs SQL cannot put a row there, so it cannot choose
--      its own tenant.
--
--   2. THE TOKEN is the proof that the context is legitimate. The control
--      plane (the ztech_control role) asks the database to issue a token
--      for a (role, workspace) pair; the database signs it with a secret
--      that never leaves the database. The runtime session may not issue a
--      token - it may only present one. The token is bound to the
--      workspace, to the role, and to a moment in time.
--
--   3. THE CONTEXT IS TRANSACTIONAL. The row carries the transaction id it
--      was written in, so a context does not outlive its transaction. A
--      pooled connection that is handed to another tenant starts with NO
--      context, and the policies refuse everything. A missing, invalid,
--      expired or mismatched context FAILS CLOSED: no row is visible and no
--      write is allowed.
--
-- The role's grant is a CEILING, not the authority: a role that is granted
-- two workspaces may not reach the second one without a token for it. That
-- is what makes the isolation PER-CUSTOMER rather than "one role, many
-- tenants": a session authorised for A holds a token for A, and no amount of
-- SQL in that session can turn it into a session for B.
--
-- The roles are provisioned separately (roles.sql): this file is applied by
-- the MIGRATION role, which owns the tables and the functions, and the
-- runtime roles get the minimum they need.

-- ---------------------------------------------------------------------------
-- 1. The security tables
-- ---------------------------------------------------------------------------

-- Which workspaces a database role may act for. The table is owned by the
-- migration role and is NOT readable by the runtime roles: only the
-- SECURITY DEFINER functions below read it, and they do so with the
-- owner's rights.
CREATE TABLE IF NOT EXISTS li.workspace_grants (
  role_name    TEXT NOT NULL,
  workspace_id UUID NOT NULL,
  PRIMARY KEY (role_name, workspace_id)
);
REVOKE ALL ON li.workspace_grants FROM PUBLIC;

-- The CONTEXT of the current transaction.
--
-- One row per backend. The row is written by li.set_workspace() and read by
-- li.current_workspace(); the runtime roles have no privilege on the table
-- at all, so this is the one place a tenant's scope can live that a caller
-- cannot reach.
--
-- The transaction id is what makes the context transactional: a row written
-- in one transaction does not answer for the next one, so a connection that
-- is reused carries no context into the next tenant's work.
CREATE TABLE IF NOT EXISTS li.workspace_context (
  backend_pid  INTEGER NOT NULL,
  xid          XID8 NOT NULL,
  role_name    NAME NOT NULL,
  workspace_id UUID NOT NULL,
  PRIMARY KEY (backend_pid)
);
REVOKE ALL ON li.workspace_context FROM PUBLIC;

-- The control plane's secret: the key the workspace tokens are signed with.
--
-- It is generated once, on the first application of this migration, and it
-- NEVER leaves the database: the function that signs and the function that
-- verifies both run with the migration role's rights, and neither of them
-- returns the key. The application never holds it either - it asks the
-- control plane for a token.
CREATE TABLE IF NOT EXISTS li.control_plane_secret (
  singleton BOOLEAN NOT NULL DEFAULT TRUE PRIMARY KEY CHECK (singleton),
  secret    BYTEA NOT NULL
);
REVOKE ALL ON li.control_plane_secret FROM PUBLIC;

-- The secret is written ONCE. Re-applying the migration must not change
-- it: the tokens already issued would stop verifying.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM li.control_plane_secret) THEN
    -- gen_random_uuid() is built in (PostgreSQL 13 and later), so this
    -- needs no extension and no superuser.
    INSERT INTO li.control_plane_secret (singleton, secret) VALUES (
      TRUE,
      decode(
        replace(gen_random_uuid()::TEXT, '-', '') || replace(gen_random_uuid()::TEXT, '-', ''),
        'hex'
      )
    );
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. The small cryptographic helpers
-- ---------------------------------------------------------------------------

-- The exclusive-or of two byte strings. PostgreSQL has no bytea XOR
-- operator, so it is written out: HMAC needs it.
CREATE OR REPLACE FUNCTION li.bytea_xor(p_a BYTEA, p_b BYTEA) RETURNS BYTEA
LANGUAGE plpgsql IMMUTABLE STRICT
SET search_path = pg_catalog
AS $$
DECLARE
  v_out BYTEA;
  v_i   INTEGER;
  v_len INTEGER;
BEGIN
  v_len := least(length(p_a), length(p_b));
  v_out := p_a;
  FOR v_i IN 0..v_len - 1 LOOP
    v_out := set_byte(v_out, v_i, get_byte(p_a, v_i) # get_byte(p_b, v_i));
  END LOOP;
  RETURN v_out;
END;
$$;
REVOKE ALL ON FUNCTION li.bytea_xor(BYTEA, BYTEA) FROM PUBLIC;

-- HMAC-SHA256, from the built-in sha256() (PostgreSQL 11 and later - no
-- pgcrypto, no extension, no superuser needed).
--
-- HMAC(K, m) = SHA256((K' XOR opad) || SHA256((K' XOR ipad) || m))
CREATE OR REPLACE FUNCTION li.hmac_sha256(p_key BYTEA, p_data BYTEA) RETURNS BYTEA
LANGUAGE plpgsql IMMUTABLE STRICT
SET search_path = pg_catalog
AS $$
DECLARE
  v_key   BYTEA;
  v_ipad  BYTEA;
  v_opad  BYTEA;
  v_block CONSTANT INTEGER := 64;
BEGIN
  IF length(p_key) > v_block THEN
    v_key := pg_catalog.sha256(p_key);
  ELSE
    v_key := p_key || pg_catalog.decode(pg_catalog.repeat('00', v_block - length(p_key)), 'hex');
  END IF;
  v_ipad := li.bytea_xor(v_key, pg_catalog.decode(pg_catalog.repeat('36', v_block), 'hex'));
  v_opad := li.bytea_xor(v_key, pg_catalog.decode(pg_catalog.repeat('5c', v_block), 'hex'));
  RETURN pg_catalog.sha256(v_opad || pg_catalog.sha256(v_ipad || p_data));
END;
$$;
REVOKE ALL ON FUNCTION li.hmac_sha256(BYTEA, BYTEA) FROM PUBLIC;

-- A comparison that does not leak how much of the signature matched.
CREATE OR REPLACE FUNCTION li.constant_time_equals(p_a BYTEA, p_b BYTEA) RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE STRICT
SET search_path = pg_catalog
AS $$
DECLARE
  v_diff INTEGER := 0;
  v_i    INTEGER;
  v_len  INTEGER;
BEGIN
  IF length(p_a) <> length(p_b) THEN
    RETURN FALSE;
  END IF;
  v_len := length(p_a);
  FOR v_i IN 0..v_len - 1 LOOP
    v_diff := v_diff | (get_byte(p_a, v_i) # get_byte(p_b, v_i));
  END LOOP;
  RETURN v_diff = 0;
END;
$$;
REVOKE ALL ON FUNCTION li.constant_time_equals(BYTEA, BYTEA) FROM PUBLIC;

-- Hex, not base64. A token is one unbroken string, and hex has no padding
-- and no alphabet to translate - so a token can be read back exactly as it
-- was written, with no ambiguity about its length.
CREATE OR REPLACE FUNCTION li.to_hex(p_bytes BYTEA) RETURNS TEXT
LANGUAGE sql IMMUTABLE STRICT
SET search_path = pg_catalog
AS $$
  SELECT pg_catalog.encode(p_bytes, 'hex');
$$;
REVOKE ALL ON FUNCTION li.to_hex(BYTEA) FROM PUBLIC;

CREATE OR REPLACE FUNCTION li.from_hex(p_text TEXT) RETURNS BYTEA
LANGUAGE sql IMMUTABLE STRICT
SET search_path = pg_catalog
AS $$
  SELECT pg_catalog.decode(p_text, 'hex');
$$;
REVOKE ALL ON FUNCTION li.from_hex(TEXT) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 3. The workspace context
-- ---------------------------------------------------------------------------

-- The workspace of the current transaction, or NULL when there is none.
--
-- NULL means "no context", and every policy compares against NULL - so a
-- missing, invalid, expired or mismatched context matches no row and
-- allows no write. It fails closed, it never fails open.
--
-- The row is read from li.workspace_context, which the runtime roles cannot
-- write. That is the point: the context is not a value the caller controls.
CREATE OR REPLACE FUNCTION li.current_workspace() RETURNS UUID
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, li
AS $$
DECLARE
  v_context li.workspace_context%ROWTYPE;
  v_xid     XID8;
  v_allowed BOOLEAN;
BEGIN
  BEGIN
    SELECT * INTO v_context
    FROM li.workspace_context
    WHERE backend_pid = pg_backend_pid();
  EXCEPTION WHEN others THEN
    RETURN NULL;
  END;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  -- The context belongs to ONE transaction. The next transaction on the
  -- same connection has a different transaction id, so it has no context.
  v_xid := pg_catalog.pg_current_xact_id_if_assigned();
  IF v_xid IS NULL OR v_xid <> v_context.xid THEN
    RETURN NULL;
  END IF;
  -- The context belongs to ONE role. A connection that changes role mid
  -- transaction does not inherit the context.
  IF v_context.role_name <> session_user THEN
    RETURN NULL;
  END IF;
  -- The grant is re-checked at read time: a grant that was withdrawn takes
  -- effect at once, not at the next token.
  SELECT EXISTS (
    SELECT 1 FROM li.workspace_grants g
    WHERE g.role_name = session_user AND g.workspace_id = v_context.workspace_id
  ) INTO v_allowed;
  IF NOT v_allowed THEN
    RETURN NULL;
  END IF;
  RETURN v_context.workspace_id;
END;
$$;
REVOKE ALL ON FUNCTION li.current_workspace() FROM PUBLIC;

-- Issue a workspace token.
--
-- SECURITY DEFINER, because the runtime role may not read the secret. It is
-- restricted to the CONTROL PLANE (ztech_control) and to the migration
-- role: a runtime session may never issue a token for itself.
--
-- The token is bound to the workspace, to the role it is for, and to a
-- lifetime. It is signed with the control plane's secret, which never
-- leaves the database.
CREATE OR REPLACE FUNCTION li.issue_workspace_token(
  p_workspace    UUID,
  p_role         TEXT,
  p_ttl_seconds  INTEGER DEFAULT 300
) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, li
AS $$
DECLARE
  v_secret  BYTEA;
  v_payload TEXT;
  v_issued  BIGINT;
  v_expires BIGINT;
  v_allowed BOOLEAN;
BEGIN
  IF p_workspace IS NULL THEN
    RAISE EXCEPTION 'a workspace is required' USING ERRCODE = '22023';
  END IF;
  IF p_ttl_seconds IS NULL OR p_ttl_seconds <= 0 OR p_ttl_seconds > 3600 THEN
    RAISE EXCEPTION 'the token lifetime must be between 1 and 3600 seconds' USING ERRCODE = '22023';
  END IF;
  -- The ceiling: the role must be granted the workspace, or there is no
  -- token for it.
  SELECT EXISTS (
    SELECT 1 FROM li.workspace_grants g
    WHERE g.role_name = p_role AND g.workspace_id = p_workspace
  ) INTO v_allowed;
  IF NOT v_allowed THEN
    RAISE EXCEPTION 'role % is not granted workspace %', p_role, p_workspace USING ERRCODE = '42501';
  END IF;
  SELECT secret INTO v_secret FROM li.control_plane_secret WHERE singleton;
  IF v_secret IS NULL THEN
    RAISE EXCEPTION 'the control plane secret is missing' USING ERRCODE = 'XX000';
  END IF;
  v_issued := EXTRACT(EPOCH FROM pg_catalog.clock_timestamp())::BIGINT;
  v_expires := v_issued + p_ttl_seconds;
  v_payload := p_workspace::TEXT || '|' || p_role || '|' || v_issued::TEXT || '|' || v_expires::TEXT;
  RETURN li.to_hex(pg_catalog.convert_to(v_payload, 'UTF8'))
      || '.' || li.to_hex(li.hmac_sha256(v_secret, pg_catalog.convert_to(v_payload, 'UTF8')));
END;
$$;
REVOKE ALL ON FUNCTION li.issue_workspace_token(UUID, TEXT, INTEGER) FROM PUBLIC;

-- Set the workspace context for the CURRENT transaction.
--
-- SECURITY DEFINER, because the runtime role may neither read the secret
-- nor write the context table.
--
-- The token is what makes this safe: the caller PROVES which workspace it
-- is acting for. A caller that passes somebody else's token gets an error
-- and no context. The token is bound to the workspace, to the calling role
-- and to a lifetime, so it cannot be replayed for another workspace, for
-- another role, or for ever.
--
-- The context is transactional: the row carries the transaction id, and it
-- is written inside the transaction, so a ROLLBACK removes it and a COMMIT
-- retires it. A pooled connection can never carry one tenant's context into
-- another tenant's work.
CREATE OR REPLACE FUNCTION li.set_workspace(p_workspace UUID, p_token TEXT) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, li
AS $$
DECLARE
  v_secret  BYTEA;
  v_parts   TEXT[];
  v_fields  TEXT[];
  v_payload TEXT;
  v_sig     BYTEA;
  v_ws      UUID;
  v_role    TEXT;
  v_expires BIGINT;
  v_allowed BOOLEAN;
BEGIN
  IF p_workspace IS NULL THEN
    RAISE EXCEPTION 'a workspace context is required' USING ERRCODE = '22023';
  END IF;
  IF p_token IS NULL OR p_token = '' THEN
    RAISE EXCEPTION 'a workspace token is required' USING ERRCODE = '22023';
  END IF;
  v_parts := string_to_array(p_token, '.');
  IF array_length(v_parts, 1) <> 2 THEN
    RAISE EXCEPTION 'the workspace token is malformed' USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_payload := pg_catalog.convert_from(li.from_hex(v_parts[1]), 'UTF8');
    v_sig := li.from_hex(v_parts[2]);
    v_fields := string_to_array(v_payload, '|');
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'the workspace token is malformed' USING ERRCODE = '22023';
  END;
  IF array_length(v_fields, 1) <> 4 THEN
    RAISE EXCEPTION 'the workspace token is malformed' USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_ws := v_fields[1]::UUID;
    v_role := v_fields[2];
    v_expires := v_fields[4]::BIGINT;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'the workspace token is malformed' USING ERRCODE = '22023';
  END;
  SELECT secret INTO v_secret FROM li.control_plane_secret WHERE singleton;
  IF v_secret IS NULL THEN
    RAISE EXCEPTION 'the control plane secret is missing' USING ERRCODE = 'XX000';
  END IF;
  IF NOT li.constant_time_equals(v_sig, li.hmac_sha256(v_secret, pg_catalog.convert_to(v_payload, 'UTF8'))) THEN
    RAISE EXCEPTION 'the workspace token is not valid' USING ERRCODE = '42501';
  END IF;
  IF v_ws <> p_workspace THEN
    RAISE EXCEPTION 'the workspace token is for another workspace' USING ERRCODE = '42501';
  END IF;
  IF v_role <> session_user THEN
    RAISE EXCEPTION 'the workspace token is for another role' USING ERRCODE = '42501';
  END IF;
  IF v_expires <= EXTRACT(EPOCH FROM pg_catalog.clock_timestamp())::BIGINT THEN
    RAISE EXCEPTION 'the workspace token has expired' USING ERRCODE = '42501';
  END IF;
  -- The ceiling, checked again at the moment the context is taken.
  SELECT EXISTS (
    SELECT 1 FROM li.workspace_grants g
    WHERE g.role_name = session_user AND g.workspace_id = p_workspace
  ) INTO v_allowed;
  IF NOT v_allowed THEN
    RAISE EXCEPTION 'workspace % is not granted to %', p_workspace, session_user USING ERRCODE = '42501';
  END IF;
  INSERT INTO li.workspace_context (backend_pid, xid, role_name, workspace_id)
  VALUES (pg_backend_pid(), pg_catalog.pg_current_xact_id(), session_user, p_workspace)
  ON CONFLICT (backend_pid) DO UPDATE
    SET xid = EXCLUDED.xid,
        role_name = EXCLUDED.role_name,
        workspace_id = EXCLUDED.workspace_id;
END;
$$;
REVOKE ALL ON FUNCTION li.set_workspace(UUID, TEXT) FROM PUBLIC;

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

-- The old, single-argument set_workspace() is removed: a context without a
-- token is a context anyone can ask for.
DROP FUNCTION IF EXISTS li.set_workspace(UUID);

-- ---------------------------------------------------------------------------
-- 4. The policies
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
-- 5. The relationships
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
-- 6. The permissions
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

-- The control plane may ONLY issue tokens. It may not read a row, it may
-- not write a row, and it may not open a context of its own.
GRANT USAGE ON SCHEMA li TO ztech_control;

-- The functions the runtime roles may call. Everything else is revoked from
-- PUBLIC above.
--
-- set_workspace() is the only way to open a context, and it needs a token.
-- current_workspace() is what the policies call. is_suppressed() answers
-- the privacy-preserving question.
GRANT EXECUTE ON FUNCTION li.set_workspace(UUID, TEXT) TO ztech_app, ztech_worker;
GRANT EXECUTE ON FUNCTION li.current_workspace() TO ztech_app, ztech_worker, ztech_platform;
GRANT EXECUTE ON FUNCTION li.is_suppressed(TEXT, TEXT) TO ztech_app, ztech_worker;

-- The token issuer. The runtime roles may NOT issue a token - that is what
-- stops a session from choosing its own tenant.
GRANT EXECUTE ON FUNCTION li.issue_workspace_token(UUID, TEXT, INTEGER) TO ztech_control, ztech_migrator;

-- The migration role keeps everything it owns, and it alone may change the
-- schema. The runtime roles may not.
GRANT ALL ON SCHEMA li TO ztech_migrator;
GRANT ALL ON ALL TABLES IN SCHEMA li TO ztech_migrator;
GRANT ALL ON ALL SEQUENCES IN SCHEMA li TO ztech_migrator;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA li TO ztech_migrator;
