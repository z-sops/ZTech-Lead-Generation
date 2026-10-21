-- PostgreSQL 16 schema, migration 015: identity, sessions and session-bound
-- workspace tokens (M3).
--
-- M2 made the DATABASE the tenant boundary: a session could not choose its
-- tenant, a token was bound to a workspace, and the grant was a ceiling.
-- But the grant was per PostgreSQL ROLE, and every end user of the service
-- shares the role `ztech_app`. That is not a user boundary.
--
-- This migration adds the identity the service needs to be one:
--
--   1. THE IDENTITY. Users, organizations, workspaces, memberships,
--      sessions and invitations, in their own `id` schema. The service's
--      own data, with the service's own role, and no tenant data in it.
--
--   2. THE SESSION GRANT. A session's entitlement in a workspace is a ROW,
--      and it belongs to the SESSION - not to the shared role. Removing
--      one user's membership therefore removes that user's access, and
--      nobody else's.
--
--   3. THE SESSION-BOUND TOKEN. The token now carries the session and the
--      user, and the database checks BOTH: the token must have been
--      issued for this session, the session must still be alive, and the
--      user must still be a member of the workspace. The check happens on
--      EVERY read, so a revocation or a membership change takes effect
--      against a transaction that is ALREADY OPEN.
--
-- The trust boundary does not move: the service still decides which
-- workspace a request is for, and the database still decides whether that
-- claim is well-formed, current and effective. What changes is that the
-- claim must now name a SESSION and a USER, and the database can hold both
-- of them to it.

-- ---------------------------------------------------------------------------
-- 1. The identity schema
-- ---------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS id;
REVOKE ALL ON SCHEMA id FROM PUBLIC;

-- The people. The password is a scrypt verifier; the session token is
-- never stored, only its SHA-256.
CREATE TABLE IF NOT EXISTS id.users (
  user_id       UUID PRIMARY KEY,
  email         TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  display_name  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  disabled_at   TIMESTAMPTZ
);
-- The email is compared case-insensitively, so the unique index is on the
-- folded form.
CREATE UNIQUE INDEX IF NOT EXISTS id_users_email_key ON id.users (lower(email));

CREATE TABLE IF NOT EXISTS id.organizations (
  org_id     UUID PRIMARY KEY,
  name       TEXT NOT NULL,
  slug       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS id_organizations_slug_key ON id.organizations (lower(slug));

-- A workspace IS a tenant: its id is the workspace_id every tenant table
-- is keyed by. It belongs to an organization.
CREATE TABLE IF NOT EXISTS id.workspaces (
  workspace_id UUID PRIMARY KEY,
  org_id       UUID NOT NULL REFERENCES id.organizations (org_id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS id_workspaces_org_name ON id.workspaces (org_id, lower(name));

-- A user's membership of a workspace, with the ROLE they hold there and
-- the TEAM (group) filter that scopes what they may see.
--
-- The five roles, in order of authority: owner, admin, manager, member,
-- viewer. The permission matrix lives in the service, in one place.
CREATE TABLE IF NOT EXISTS id.workspace_memberships (
  membership_id UUID PRIMARY KEY,
  workspace_id  UUID NOT NULL REFERENCES id.workspaces (workspace_id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES id.users (user_id) ON DELETE CASCADE,
  role          TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'manager', 'member', 'viewer')),
  team_id       UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at    TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS id_workspace_memberships_active
  ON id.workspace_memberships (workspace_id, user_id) WHERE revoked_at IS NULL;

-- The sessions. The token itself is NEVER stored: only its SHA-256, so a
-- database dump does not hand out sessions.
CREATE TABLE IF NOT EXISTS id.sessions (
  session_id   UUID PRIMARY KEY,
  user_id      UUID NOT NULL REFERENCES id.users (user_id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL,
  csrf_hash    TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ,
  rotated_from UUID
);
CREATE UNIQUE INDEX IF NOT EXISTS id_sessions_token_key ON id.sessions (token_hash);

-- The invitations. An invitation names the ROLE it grants, so accepting it
-- can never grant more than it says.
CREATE TABLE IF NOT EXISTS id.invitations (
  invitation_id UUID PRIMARY KEY,
  org_id        UUID NOT NULL REFERENCES id.organizations (org_id) ON DELETE CASCADE,
  workspace_id  UUID NOT NULL REFERENCES id.workspaces (workspace_id) ON DELETE CASCADE,
  email         TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'manager', 'member', 'viewer')),
  team_id       UUID,
  token_hash    TEXT NOT NULL,
  invited_by    UUID NOT NULL REFERENCES id.users (user_id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  accepted_at   TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS id_invitations_token_key ON id.invitations (token_hash);

-- The authorization audit: who asked for what, in which workspace, and
-- whether it was allowed. It is append-only by convention and by grants.
CREATE TABLE IF NOT EXISTS id.authorization_audit (
  audit_id     BIGSERIAL PRIMARY KEY,
  at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id      UUID,
  session_id   UUID,
  org_id       UUID,
  workspace_id UUID,
  action       TEXT NOT NULL,
  outcome      TEXT NOT NULL CHECK (outcome IN ('allow', 'deny')),
  reason       TEXT,
  detail       JSONB
);
CREATE INDEX IF NOT EXISTS id_authorization_audit_at ON id.authorization_audit (at DESC);

-- ---------------------------------------------------------------------------
-- 2. The session's entitlement
-- ---------------------------------------------------------------------------

-- Is this session alive, and is this user still a member of this
-- workspace?
--
-- This is the check that makes the tenant boundary a USER boundary. It is
-- SECURITY DEFINER because the runtime role may not read the identity
-- tables at all, and it is STABLE because it is read on every query.
--
-- It answers FALSE for anything it cannot prove: an unknown session, a
-- revoked session, an expired session, a session that belongs to another
-- user, a membership that was withdrawn, and a membership that never
-- existed. It fails closed.
CREATE OR REPLACE FUNCTION li.session_entitled(
  p_session   UUID,
  p_user      UUID,
  p_workspace UUID
) RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, li, id
AS $$
DECLARE
  v_alive   BOOLEAN;
  v_member  BOOLEAN;
BEGIN
  IF p_session IS NULL OR p_user IS NULL OR p_workspace IS NULL THEN
    RETURN FALSE;
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM id.sessions s
     WHERE s.session_id = p_session
       AND s.user_id = p_user
       AND s.revoked_at IS NULL
       AND s.expires_at > pg_catalog.clock_timestamp()
  ) INTO v_alive;
  IF NOT v_alive THEN
    RETURN FALSE;
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM id.workspace_memberships m
     WHERE m.workspace_id = p_workspace
       AND m.user_id = p_user
       AND m.revoked_at IS NULL
  ) INTO v_member;
  RETURN COALESCE(v_member, FALSE);
EXCEPTION WHEN others THEN
  RETURN FALSE;
END;
$$;
REVOKE ALL ON FUNCTION li.session_entitled(UUID, UUID, UUID) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 3. The session-bound token
-- ---------------------------------------------------------------------------

-- The context now carries the session and the user, so that a revocation
-- can be enforced against a transaction that is ALREADY OPEN.
ALTER TABLE li.workspace_context ADD COLUMN IF NOT EXISTS session_id UUID;
ALTER TABLE li.workspace_context ADD COLUMN IF NOT EXISTS user_id UUID;

-- Issue a workspace token, for a SESSION and a USER.
--
-- The token is bound to FOUR things: the workspace, the role, the session
-- and the user. It is also bound to a lifetime.
--
-- The entitlement is checked HERE, at issue time, against the identity
-- tables: the session must be alive, and the user must be a member of the
-- workspace. The grant ceiling is checked too: the role must be granted
-- the workspace.
--
-- The old signature is removed: a token without a session and a user is a
-- token that any session of the role could use.
DROP FUNCTION IF EXISTS li.issue_workspace_token(UUID, TEXT, INTEGER);
CREATE OR REPLACE FUNCTION li.issue_workspace_token(
  p_workspace    UUID,
  p_role         TEXT,
  p_session      UUID,
  p_user         UUID,
  p_ttl_seconds  INTEGER DEFAULT 300
) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, li, id
AS $$
DECLARE
  v_secret  BYTEA;
  v_payload TEXT;
  v_issued  BIGINT;
  v_expires BIGINT;
  v_allowed BOOLEAN;
BEGIN
  IF p_workspace IS NULL OR p_session IS NULL OR p_user IS NULL THEN
    RAISE EXCEPTION 'a workspace, a session and a user are required' USING ERRCODE = '22023';
  END IF;
  IF p_ttl_seconds IS NULL OR p_ttl_seconds <= 0 OR p_ttl_seconds > li.max_token_lifetime() THEN
    RAISE EXCEPTION 'the token lifetime must be between 1 and % seconds', li.max_token_lifetime() USING ERRCODE = '22023';
  END IF;
  -- The entitlement: the session must be alive and the user must be a
  -- member of the workspace. A token is never issued for a membership
  -- that does not exist.
  IF NOT li.session_entitled(p_session, p_user, p_workspace) THEN
    RAISE EXCEPTION 'the session is not entitled to workspace %', p_workspace USING ERRCODE = '42501';
  END IF;
  -- The ceiling: the role must be granted the workspace.
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
  v_payload := p_workspace::TEXT || '|' || p_role || '|' || p_session::TEXT || '|'
            || p_user::TEXT || '|' || v_issued::TEXT || '|' || v_expires::TEXT;
  RETURN li.to_hex(pg_catalog.convert_to(v_payload, 'UTF8'))
      || '.' || li.to_hex(li.hmac_sha256(v_secret, pg_catalog.convert_to(v_payload, 'UTF8')));
END;
$$;
REVOKE ALL ON FUNCTION li.issue_workspace_token(UUID, TEXT, UUID, UUID, INTEGER) FROM PUBLIC;

-- Set the workspace context for the CURRENT transaction, from a token.
--
-- The token must be valid, for this workspace, for this role, for this
-- session and this user, and it must not have expired. The session's
-- entitlement is checked again HERE, so a membership that was withdrawn
-- between the issue and the use is refused.
CREATE OR REPLACE FUNCTION li.set_workspace(p_workspace UUID, p_token TEXT) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, li, id
AS $$
DECLARE
  v_secret  BYTEA;
  v_parts   TEXT[];
  v_fields  TEXT[];
  v_payload TEXT;
  v_sig     BYTEA;
  v_ws      UUID;
  v_role    TEXT;
  v_session UUID;
  v_user    UUID;
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
  IF array_length(v_fields, 1) <> 6 THEN
    RAISE EXCEPTION 'the workspace token is malformed' USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_ws := v_fields[1]::UUID;
    v_role := v_fields[2];
    v_session := v_fields[3]::UUID;
    v_user := v_fields[4]::UUID;
    v_expires := v_fields[6]::BIGINT;
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
  -- The entitlement, checked at the moment the context is taken.
  IF NOT li.session_entitled(v_session, v_user, p_workspace) THEN
    RAISE EXCEPTION 'the session is not entitled to workspace %', p_workspace USING ERRCODE = '42501';
  END IF;
  -- The ceiling, checked again at the moment the context is taken.
  SELECT EXISTS (
    SELECT 1 FROM li.workspace_grants g
    WHERE g.role_name = session_user AND g.workspace_id = p_workspace
  ) INTO v_allowed;
  IF NOT v_allowed THEN
    RAISE EXCEPTION 'workspace % is not granted to %', p_workspace, session_user USING ERRCODE = '42501';
  END IF;
  INSERT INTO li.workspace_context (backend_pid, xid, role_name, workspace_id, expires_at, session_id, user_id)
  VALUES (pg_backend_pid(), pg_catalog.pg_current_xact_id(), session_user, p_workspace,
          pg_catalog.to_timestamp(v_expires), v_session, v_user)
  ON CONFLICT (backend_pid) DO UPDATE
    SET xid = EXCLUDED.xid,
        role_name = EXCLUDED.role_name,
        workspace_id = EXCLUDED.workspace_id,
        expires_at = EXCLUDED.expires_at,
        session_id = EXCLUDED.session_id,
        user_id = EXCLUDED.user_id;
END;
$$;
REVOKE ALL ON FUNCTION li.set_workspace(UUID, TEXT) FROM PUBLIC;

-- The workspace of the current transaction, or NULL when there is none.
--
-- The session's entitlement is re-checked HERE, on every read. That is
-- what makes a revocation effective against a transaction that is ALREADY
-- OPEN: the membership is withdrawn, or the session is revoked, and the
-- next statement in that transaction sees nothing.
CREATE OR REPLACE FUNCTION li.current_workspace() RETURNS UUID
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, li, id
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
  v_xid := pg_catalog.pg_current_xact_id_if_assigned();
  IF v_xid IS NULL OR v_xid <> v_context.xid THEN
    RETURN NULL;
  END IF;
  IF v_context.expires_at IS NULL OR v_context.expires_at <= pg_catalog.statement_timestamp() THEN
    RETURN NULL;
  END IF;
  IF v_context.role_name <> session_user THEN
    RETURN NULL;
  END IF;
  -- The SESSION and the USER. A context that was opened for a session
  -- that has been revoked, or for a membership that has been withdrawn, is
  -- no context at all.
  IF v_context.session_id IS NULL OR v_context.user_id IS NULL THEN
    RETURN NULL;
  END IF;
  IF NOT li.session_entitled(v_context.session_id, v_context.user_id, v_context.workspace_id) THEN
    RETURN NULL;
  END IF;
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

-- Add a workspace to a role's CEILING.
--
-- The grant is the database's ceiling: a role that is not granted a
-- workspace cannot open a context for it, whatever the service says. The
-- service creates workspaces at runtime, so it needs to add them - and it
-- may only do it through this function, because the grants table is the
-- migrator's and the runtime roles may not write it.
CREATE OR REPLACE FUNCTION li.grant_workspace(p_workspace UUID, p_role TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, li
AS $$
BEGIN
  IF p_workspace IS NULL OR p_role IS NULL OR p_role = '' THEN
    RETURN FALSE;
  END IF;
  INSERT INTO li.workspace_grants (role_name, workspace_id) VALUES (p_role, p_workspace)
  ON CONFLICT (role_name, workspace_id) DO NOTHING;
  RETURN TRUE;
END;
$$;
REVOKE ALL ON FUNCTION li.grant_workspace(UUID, TEXT) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 4. The permissions
-- ---------------------------------------------------------------------------

-- The service's own role for the identity: it may read and write the
-- identity tables, and it may issue the workspace tokens. It may NOT read
-- the tenant tables, it is not a superuser, and it does not bypass the
-- row-level security.
--
-- The ROLE is created by roles.sql, as the cluster administrator: the
-- migration role may not create roles, and it is not a superuser. What
-- this migration does is grant the role its powers.

GRANT USAGE ON SCHEMA id TO ztech_identity;
-- The identity service calls the token issuer, which lives in the tenant
-- schema. USAGE on the SCHEMA is not a privilege on its tables: the
-- identity role still may not read a single tenant row.
GRANT USAGE ON SCHEMA li TO ztech_identity;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA id TO ztech_identity;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA id TO ztech_identity;

-- The control plane, for the identity service: it may issue a token and
-- nothing else.
GRANT EXECUTE ON FUNCTION li.issue_workspace_token(UUID, TEXT, UUID, UUID, INTEGER)
  TO ztech_control, ztech_identity;
-- The workspace ceiling is the IDENTITY SERVICE's business, and only the
-- identity service may widen it. The control plane may issue a token and
-- nothing else: it may not grant a workspace.
GRANT EXECUTE ON FUNCTION li.grant_workspace(UUID, TEXT) TO ztech_identity;

-- The audit log is append-only for the identity service: it may add a
-- record, and it may not change or erase one.
REVOKE UPDATE, DELETE ON id.authorization_audit FROM ztech_identity;
