-- =====================================================================
-- 016_job_queue.sql — M4 P1
--
-- The durable PostgreSQL job queue, and the secure job-scoped worker
-- foundation that goes with it.
--
-- This migration is ADDITIVE and IDEMPOTENT. Migrations 014 and 015 are
-- NOT rewritten: every change to an existing object is a CREATE OR REPLACE
-- or a REVOKE made here, so the history stays a history and the replay
-- stays safe.
--
-- It contains:
--   1. li.job_queue — the durable queue, its constraints and its indexes
--   2. the job context: the protected readers and the context columns
--   3. the worker credentials: the identity and the execution token
--   4. claiming, lease renewal, the fenced write and the recovery
--   5. H1, H2 and H3 — the worker may not hold a workspace authority
--   6. H7 — the worker no longer holds legacy tenant-business DML
--
-- The rule that shapes everything here: a worker is JOB scoped. It never
-- holds a workspace-scoped context, so it never reaches workspace-wide
-- tenant data, and the only rows it can see are the rows of the one job
-- it holds.
-- =====================================================================

-- -------------------------------------------------------------------------
-- 1. The queue
-- -------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS li.job_queue (
  job_id           UUID PRIMARY KEY,
  workspace_id     UUID NOT NULL,
  job_type         TEXT NOT NULL,
  idempotency_key  TEXT NOT NULL,
  payload          JSONB NOT NULL DEFAULT '{}'::JSONB,
  state            TEXT NOT NULL DEFAULT 'queued',
  -- P1 runs NO-OP jobs only. A 'chargeable' job is accepted by the schema
  -- so the shape is forward compatible, but P1 never claims it and never
  -- recovers it: the provider ledger arrives in P2, and until it does the
  -- outcome of a chargeable invocation is UNKNOWN and must not be invented.
  job_class        TEXT NOT NULL DEFAULT 'noop',
  priority         INTEGER NOT NULL DEFAULT 100,
  attempt_count    INTEGER NOT NULL DEFAULT 0,
  max_attempts     INTEGER NOT NULL DEFAULT 5,
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  lease_owner      TEXT,
  lease_expires_at TIMESTAMPTZ,
  fencing_token    BIGINT NOT NULL DEFAULT 0,
  last_error       TEXT,
  result           JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  started_at       TIMESTAMPTZ,
  finished_at      TIMESTAMPTZ,

  CONSTRAINT job_queue_state_valid
    CHECK (state IN ('queued','leased','running','succeeded','failed','cancelled','uncertain')),
  CONSTRAINT job_queue_class_valid
    CHECK (job_class IN ('noop','chargeable')),
  CONSTRAINT job_queue_attempt_count_nonneg CHECK (attempt_count >= 0),
  CONSTRAINT job_queue_max_attempts_valid  CHECK (max_attempts >= 1),
  CONSTRAINT job_queue_fencing_nonneg     CHECK (fencing_token >= 0),
  CONSTRAINT job_queue_priority_nonneg     CHECK (priority >= 0),
  -- A lease exists exactly while the job is held. The two columns move
  -- together, so a job can never be 'leased' with nobody holding it.
  CONSTRAINT job_queue_lease_state
    CHECK ((state IN ('leased','running')) = (lease_owner IS NOT NULL)),
  CONSTRAINT job_queue_lease_expiry
    CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
  CONSTRAINT job_queue_lease_owner_valid
    CHECK (lease_owner IS NULL OR lease_owner ~ '^[A-Za-z0-9._-]{1,128}$')
);

-- The claim index: the queue is read by (state, due date, priority).
CREATE INDEX IF NOT EXISTS job_queue_claim_idx
  ON li.job_queue (state, next_attempt_at, priority, created_at);

-- The idempotency guarantee: one job per (workspace, type, key).
CREATE UNIQUE INDEX IF NOT EXISTS job_queue_idempotency_idx
  ON li.job_queue (workspace_id, job_type, idempotency_key);

-- The listing: a workspace's jobs, newest first.
CREATE INDEX IF NOT EXISTS job_queue_workspace_created_idx
  ON li.job_queue (workspace_id, created_at DESC);

-- The recovery sweep: the leases that have lapsed.
CREATE INDEX IF NOT EXISTS job_queue_lease_idx
  ON li.job_queue (state, lease_expires_at);

-- -------------------------------------------------------------------------
-- 2. The job context
--
-- The context table is the SAME table M3 uses, with four more columns.
-- It is still keyed by the backend and the transaction, so a context
-- belongs to ONE transaction and a pooled connection can never carry one
-- job's authority into another transaction's work.
-- -------------------------------------------------------------------------

ALTER TABLE li.workspace_context ADD COLUMN IF NOT EXISTS context_kind TEXT;
ALTER TABLE li.workspace_context ADD COLUMN IF NOT EXISTS job_id UUID;
ALTER TABLE li.workspace_context ADD COLUMN IF NOT EXISTS worker_id TEXT;
ALTER TABLE li.workspace_context ADD COLUMN IF NOT EXISTS fencing_token BIGINT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'li.workspace_context'::regclass AND conname = 'workspace_context_kind_check'
  ) THEN
    ALTER TABLE li.workspace_context ADD CONSTRAINT workspace_context_kind_check
      CHECK (context_kind IS NULL OR context_kind IN ('session','job'));
  END IF;
END;
$$;

-- -------------------------------------------------------------------------
-- 2a. The protected readers.
--
-- li.resolve_job_context() is the ONE place that decides whether the
-- current transaction holds a job context. It is SECURITY DEFINER and
-- owned by the migration role, so it can read the context table that the
-- runtime roles may not read.
--
-- li.current_workspace() is NOT TOUCHED by this migration. M3's session
-- branch keeps its exact meaning. A job context simply yields NULL there,
-- because a job context carries no session and no user — which is exactly
-- what keeps the legacy workspace-wide tables invisible to a worker.
-- -------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION li.resolve_job_context()
RETURNS TABLE (job_id UUID, workspace_id UUID, worker_id TEXT, fencing_token BIGINT)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, li, id
AS $$
DECLARE
  v_context li.workspace_context%ROWTYPE;
  v_xid     XID8;
  v_job     li.job_queue%ROWTYPE;
BEGIN
  BEGIN
    SELECT * INTO v_context
      FROM li.workspace_context c
     WHERE c.backend_pid = pg_backend_pid();
  EXCEPTION WHEN others THEN
    RETURN;
  END;
  IF NOT FOUND THEN RETURN; END IF;

  -- The transaction. The context belongs to the transaction that opened it.
  v_xid := pg_catalog.pg_current_xact_id_if_assigned();
  IF v_xid IS NULL OR v_xid <> v_context.xid THEN RETURN; END IF;

  -- The expiry, the role, and the KIND. A session context is not a job
  -- context: the two never mix.
  IF v_context.expires_at IS NULL OR v_context.expires_at <= pg_catalog.statement_timestamp() THEN RETURN; END IF;
  IF v_context.role_name <> session_user THEN RETURN; END IF;
  IF v_context.context_kind IS DISTINCT FROM 'job' THEN RETURN; END IF;
  IF v_context.job_id IS NULL THEN RETURN; END IF;
  -- A job context has NO session and NO user. Its authority is the job.
  IF v_context.session_id IS NOT NULL OR v_context.user_id IS NOT NULL THEN RETURN; END IF;
  IF v_context.worker_id IS NULL THEN RETURN; END IF;

  -- The job itself. It must still exist, still be held, still be held by
  -- THIS worker, with THIS fencing token, and the lease must not have
  -- lapsed. This is re-checked on EVERY read, so an expired lease or a
  -- re-claim (which advances the fencing token) revokes the authority
  -- immediately.
  SELECT * INTO v_job
    FROM li.job_queue j
   WHERE j.job_id = v_context.job_id;
  IF NOT FOUND THEN RETURN; END IF;
  IF v_job.state NOT IN ('leased','running') THEN RETURN; END IF;
  IF v_job.workspace_id <> v_context.workspace_id THEN RETURN; END IF;
  IF v_job.fencing_token <> v_context.fencing_token THEN RETURN; END IF;
  IF v_job.lease_owner IS DISTINCT FROM v_context.worker_id THEN RETURN; END IF;
  IF v_job.lease_expires_at IS NULL OR v_job.lease_expires_at <= pg_catalog.now() THEN RETURN; END IF;

  job_id       := v_job.job_id;
  workspace_id := v_job.workspace_id;
  worker_id    := v_job.lease_owner;
  fencing_token := v_job.fencing_token;
  RETURN NEXT;
END;
$$;
REVOKE ALL ON FUNCTION li.resolve_job_context() FROM PUBLIC;

CREATE OR REPLACE FUNCTION li.current_job() RETURNS UUID
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, li, id
AS $$
DECLARE
  v_job_id UUID;
  v_ws     UUID;
  v_worker TEXT;
  v_fence  BIGINT;
BEGIN
  SELECT job_id, workspace_id, worker_id, fencing_token
    INTO v_job_id, v_ws, v_worker, v_fence
    FROM li.resolve_job_context();
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN v_job_id;
END;
$$;
REVOKE ALL ON FUNCTION li.current_job() FROM PUBLIC;

CREATE OR REPLACE FUNCTION li.current_job_workspace() RETURNS UUID
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, li, id
AS $$
DECLARE
  v_job_id UUID;
  v_ws     UUID;
  v_worker TEXT;
  v_fence  BIGINT;
BEGIN
  SELECT job_id, workspace_id, worker_id, fencing_token
    INTO v_job_id, v_ws, v_worker, v_fence
    FROM li.resolve_job_context();
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN v_ws;
END;
$$;
REVOKE ALL ON FUNCTION li.current_job_workspace() FROM PUBLIC;

-- The predicate the queue's policy uses. It takes the ROW's values, so the
-- policy does not reference its own table (which PostgreSQL would reject
-- as an infinite recursion), and it compares the JOB, the WORKSPACE and
-- the FENCING TOKEN. A stale worker — one whose lease was reclaimed and
-- whose fencing token has advanced — matches nothing.
CREATE OR REPLACE FUNCTION li.job_row_authorized(
  p_job_id UUID, p_workspace_id UUID, p_fencing_token BIGINT
) RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, li, id
AS $$
DECLARE
  v_job_id UUID;
  v_ws     UUID;
  v_worker TEXT;
  v_fence  BIGINT;
BEGIN
  SELECT job_id, workspace_id, worker_id, fencing_token
    INTO v_job_id, v_ws, v_worker, v_fence
    FROM li.resolve_job_context();
  IF NOT FOUND THEN RETURN FALSE; END IF;
  RETURN v_job_id = p_job_id
     AND v_ws = p_workspace_id
     AND v_fence = p_fencing_token;
END;
$$;
REVOKE ALL ON FUNCTION li.job_row_authorized(UUID, UUID, BIGINT) FROM PUBLIC;

-- -------------------------------------------------------------------------
-- 2b. The queue's policy: EXACT job authorization.
--
-- There is no 'current_job() IS NULL means everything' branch. A row is
-- visible only when the transaction holds a VALID job context for that
-- exact job, with that exact workspace and that exact fencing token.
-- -------------------------------------------------------------------------

ALTER TABLE li.job_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE li.job_queue FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON li.job_queue;
CREATE POLICY tenant_isolation ON li.job_queue
  USING (li.job_row_authorized(job_id, workspace_id, fencing_token))
  WITH CHECK (li.job_row_authorized(job_id, workspace_id, fencing_token));

REVOKE ALL ON li.job_queue FROM PUBLIC;
GRANT SELECT, UPDATE ON li.job_queue TO ztech_worker;

-- -------------------------------------------------------------------------
-- 3. The bounds.
--
-- Every duration is validated against a SERVER-SIDE bound. The caller may
-- ask for a lease or a token lifetime; it may not exceed the bound, and it
-- may not make the bound larger.
-- -------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION li.lease_bounds()
RETURNS TABLE (min_seconds INTEGER, max_seconds INTEGER)
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $$ SELECT 30, 300; $$;
REVOKE ALL ON FUNCTION li.lease_bounds() FROM PUBLIC;

CREATE OR REPLACE FUNCTION li.job_token_ttl_bounds()
RETURNS TABLE (min_seconds INTEGER, max_seconds INTEGER)
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, li
AS $$ SELECT 30, li.max_token_lifetime(); $$;
REVOKE ALL ON FUNCTION li.job_token_ttl_bounds() FROM PUBLIC;

-- -------------------------------------------------------------------------
-- 4. The worker credentials.
--
-- Two credentials, and neither is a secret the worker keeps:
--
--   the IDENTITY credential  — who this worker instance IS. It is signed
--                              by the control plane, it expires, and it is
--                              the ONLY proof of identity. A caller-supplied
--                              worker id is NEVER proof of identity.
--   the EXECUTION credential — that worker, THIS job, THIS workspace, THIS
--                              fencing token, with an expiry.
--
-- The signing secret stays in li.control_plane_secret. It is read only by
-- migrator-owned SECURITY DEFINER functions and it is never returned to
-- anybody.
-- -------------------------------------------------------------------------

-- Parse and verify a worker IDENTITY token.
CREATE OR REPLACE FUNCTION li.parse_identity_token(p_token TEXT)
RETURNS TABLE (worker_id TEXT, expires_at TIMESTAMPTZ)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, li, id
AS $$
DECLARE
  v_secret     BYTEA;
  v_parts      TEXT[];
  v_payload    TEXT;
  v_sig        TEXT;
  v_recomputed TEXT;
  v_fields     TEXT[];
BEGIN
  IF p_token IS NULL OR p_token = '' THEN
    RAISE EXCEPTION 'the worker identity token is missing' USING ERRCODE = '22023';
  END IF;
  v_parts := string_to_array(p_token, '.');
  IF array_length(v_parts, 1) <> 2 THEN
    RAISE EXCEPTION 'the worker identity token is malformed' USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_payload := pg_catalog.convert_from(li.from_hex(v_parts[1]), 'UTF8');
    v_sig := v_parts[2];
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'the worker identity token is malformed' USING ERRCODE = '22023';
  END;
  SELECT secret INTO v_secret FROM li.control_plane_secret WHERE singleton;
  IF v_secret IS NULL THEN
    RAISE EXCEPTION 'the control plane secret is missing' USING ERRCODE = 'XX000';
  END IF;
  v_recomputed := li.to_hex(li.hmac_sha256(v_secret, pg_catalog.convert_to(v_payload, 'UTF8')));
  IF NOT li.constant_time_equals(pg_catalog.convert_to(v_sig, 'UTF8'),
                                 pg_catalog.convert_to(v_recomputed, 'UTF8')) THEN
    RAISE EXCEPTION 'the worker identity token is not valid' USING ERRCODE = '42501';
  END IF;
  v_fields := string_to_array(v_payload, '|');
  IF array_length(v_fields, 1) <> 4 OR v_fields[4] <> 'identity' THEN
    RAISE EXCEPTION 'the worker identity token is malformed' USING ERRCODE = '22023';
  END IF;
  BEGIN
    worker_id := v_fields[1];
    expires_at := pg_catalog.to_timestamp(v_fields[3]::BIGINT);
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'the worker identity token is malformed' USING ERRCODE = '22023';
  END;
  IF worker_id IS NULL OR worker_id !~ '^[A-Za-z0-9._-]{1,128}$' THEN
    RAISE EXCEPTION 'the worker identity token carries no valid worker identity' USING ERRCODE = '22023';
  END IF;
  IF expires_at <= pg_catalog.statement_timestamp() THEN
    RAISE EXCEPTION 'the worker identity token has expired' USING ERRCODE = '42501';
  END IF;
  RETURN NEXT;
END;
$$;
REVOKE ALL ON FUNCTION li.parse_identity_token(TEXT) FROM PUBLIC;

-- Parse and verify a job EXECUTION token.
CREATE OR REPLACE FUNCTION li.parse_job_token(p_token TEXT)
RETURNS TABLE (worker_id TEXT, workspace_id UUID, job_id UUID,
               fencing_token BIGINT, expires_at TIMESTAMPTZ)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, li, id
AS $$
DECLARE
  v_secret     BYTEA;
  v_parts      TEXT[];
  v_payload    TEXT;
  v_sig        TEXT;
  v_recomputed TEXT;
  v_fields     TEXT[];
BEGIN
  IF p_token IS NULL OR p_token = '' THEN
    RAISE EXCEPTION 'the job token is missing' USING ERRCODE = '22023';
  END IF;
  v_parts := string_to_array(p_token, '.');
  IF array_length(v_parts, 1) <> 2 THEN
    RAISE EXCEPTION 'the job token is malformed' USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_payload := pg_catalog.convert_from(li.from_hex(v_parts[1]), 'UTF8');
    v_sig := v_parts[2];
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'the job token is malformed' USING ERRCODE = '22023';
  END;
  SELECT secret INTO v_secret FROM li.control_plane_secret WHERE singleton;
  IF v_secret IS NULL THEN
    RAISE EXCEPTION 'the control plane secret is missing' USING ERRCODE = 'XX000';
  END IF;
  v_recomputed := li.to_hex(li.hmac_sha256(v_secret, pg_catalog.convert_to(v_payload, 'UTF8')));
  IF NOT li.constant_time_equals(pg_catalog.convert_to(v_sig, 'UTF8'),
                                 pg_catalog.convert_to(v_recomputed, 'UTF8')) THEN
    RAISE EXCEPTION 'the job token is not valid' USING ERRCODE = '42501';
  END IF;
  v_fields := string_to_array(v_payload, '|');
  IF array_length(v_fields, 1) <> 7 OR v_fields[7] <> 'job' THEN
    RAISE EXCEPTION 'the job token is malformed' USING ERRCODE = '22023';
  END IF;
  BEGIN
    worker_id := v_fields[3];
    workspace_id := v_fields[1]::UUID;
    job_id := v_fields[2]::UUID;
    fencing_token := v_fields[4]::BIGINT;
    expires_at := pg_catalog.to_timestamp(v_fields[6]::BIGINT);
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'the job token is malformed' USING ERRCODE = '22023';
  END;
  IF worker_id IS NULL OR worker_id !~ '^[A-Za-z0-9._-]{1,128}$' THEN
    RAISE EXCEPTION 'the job token carries no valid worker identity' USING ERRCODE = '22023';
  END IF;
  IF expires_at <= pg_catalog.statement_timestamp() THEN
    RAISE EXCEPTION 'the job token has expired' USING ERRCODE = '42501';
  END IF;
  RETURN NEXT;
END;
$$;
REVOKE ALL ON FUNCTION li.parse_job_token(TEXT) FROM PUBLIC;

-- The control plane issues the worker IDENTITY credential. It is the
-- authenticated bootstrap: only the control plane may call it, and the
-- worker receives the TOKEN and nothing else.
CREATE OR REPLACE FUNCTION li.issue_worker_identity(
  p_worker_id TEXT, p_ttl_seconds INTEGER DEFAULT 300
) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, li, id
AS $$
DECLARE
  v_secret  BYTEA;
  v_payload TEXT;
  v_issued  BIGINT;
  v_expires BIGINT;
  v_min     INTEGER;
  v_max     INTEGER;
BEGIN
  IF p_worker_id IS NULL OR p_worker_id !~ '^[A-Za-z0-9._-]{1,128}$' THEN
    RAISE EXCEPTION 'a worker identity must be 1 to 128 characters of A-Z, a-z, 0-9, dot, underscore or dash' USING ERRCODE = '22023';
  END IF;
  SELECT min_seconds, max_seconds INTO v_min, v_max FROM li.job_token_ttl_bounds();
  IF p_ttl_seconds IS NULL OR p_ttl_seconds < v_min OR p_ttl_seconds > v_max THEN
    RAISE EXCEPTION 'the worker identity lifetime must be between % and % seconds', v_min, v_max USING ERRCODE = '22023';
  END IF;
  SELECT secret INTO v_secret FROM li.control_plane_secret WHERE singleton;
  IF v_secret IS NULL THEN
    RAISE EXCEPTION 'the control plane secret is missing' USING ERRCODE = 'XX000';
  END IF;
  v_issued := EXTRACT(EPOCH FROM pg_catalog.clock_timestamp())::BIGINT;
  v_expires := v_issued + p_ttl_seconds;
  v_payload := p_worker_id || '|' || v_issued::TEXT || '|' || v_expires::TEXT || '|identity';
  RETURN li.to_hex(pg_catalog.convert_to(v_payload, 'UTF8'))
      || '.' || li.to_hex(li.hmac_sha256(v_secret, pg_catalog.convert_to(v_payload, 'UTF8')));
END;
$$;
REVOKE ALL ON FUNCTION li.issue_worker_identity(TEXT, INTEGER) FROM PUBLIC;

-- The control plane signs the EXECUTION credential. It binds the worker to
-- one job, one workspace, one fencing token and one expiry.
CREATE OR REPLACE FUNCTION li.issue_worker_token(
  p_job_id UUID, p_worker_id TEXT, p_ttl_seconds INTEGER
) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, li, id
AS $$
DECLARE
  v_secret  BYTEA;
  v_job     li.job_queue%ROWTYPE;
  v_payload TEXT;
  v_issued  BIGINT;
  v_expires BIGINT;
  v_min     INTEGER;
  v_max     INTEGER;
BEGIN
  IF p_worker_id IS NULL OR p_worker_id !~ '^[A-Za-z0-9._-]{1,128}$' THEN
    RAISE EXCEPTION 'a worker identity must be 1 to 128 characters of A-Z, a-z, 0-9, dot, underscore or dash' USING ERRCODE = '22023';
  END IF;
  SELECT min_seconds, max_seconds INTO v_min, v_max FROM li.job_token_ttl_bounds();
  IF p_ttl_seconds IS NULL OR p_ttl_seconds < v_min OR p_ttl_seconds > v_max THEN
    RAISE EXCEPTION 'the job token lifetime must be between % and % seconds', v_min, v_max USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_job FROM li.job_queue j WHERE j.job_id = p_job_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'there is no job %', p_job_id USING ERRCODE = '22023';
  END IF;
  IF v_job.state NOT IN ('leased','running') THEN
    RAISE EXCEPTION 'the job % is not held', p_job_id USING ERRCODE = '42501';
  END IF;
  IF v_job.lease_owner IS DISTINCT FROM p_worker_id THEN
    RAISE EXCEPTION 'the job % is not held by %', p_job_id, p_worker_id USING ERRCODE = '42501';
  END IF;
  IF v_job.lease_expires_at IS NULL OR v_job.lease_expires_at <= pg_catalog.now() THEN
    RAISE EXCEPTION 'the lease on job % has expired', p_job_id USING ERRCODE = '42501';
  END IF;
  SELECT secret INTO v_secret FROM li.control_plane_secret WHERE singleton;
  IF v_secret IS NULL THEN
    RAISE EXCEPTION 'the control plane secret is missing' USING ERRCODE = 'XX000';
  END IF;
  v_issued := EXTRACT(EPOCH FROM pg_catalog.clock_timestamp())::BIGINT;
  v_expires := v_issued + p_ttl_seconds;
  v_payload := v_job.workspace_id::TEXT || '|' || v_job.job_id::TEXT || '|' || p_worker_id
            || '|' || v_job.fencing_token::TEXT || '|' || v_issued::TEXT || '|' || v_expires::TEXT
            || '|job';
  RETURN li.to_hex(pg_catalog.convert_to(v_payload, 'UTF8'))
      || '.' || li.to_hex(li.hmac_sha256(v_secret, pg_catalog.convert_to(v_payload, 'UTF8')));
END;
$$;
REVOKE ALL ON FUNCTION li.issue_worker_token(UUID, TEXT, INTEGER) FROM PUBLIC;

-- The WORKER-FACING token request.
--
-- This is NOT a signing oracle. It is the only token function a worker may
-- call, and it verifies SIX things before it signs anything:
--   1. the worker identity is authentic and unexpired
--   2. the worker holds the ACTIVE lease
--   3. the job and the workspace match
--   4. the fencing token matches the job's CURRENT fencing token
--   5. the job is in an executable state
--   6. the requested TTL is within the server-side bounds
-- It then delegates to the issuer, which is not executable by the worker.
CREATE OR REPLACE FUNCTION li.request_job_token(
  p_job_id UUID, p_fencing_token BIGINT, p_identity_token TEXT, p_ttl_seconds INTEGER
) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, li, id
AS $$
DECLARE
  v_worker TEXT;
  v_exp    TIMESTAMPTZ;
  v_job    li.job_queue%ROWTYPE;
BEGIN
  SELECT worker_id, expires_at INTO v_worker, v_exp FROM li.parse_identity_token(p_identity_token);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the worker identity is not valid' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_job FROM li.job_queue j WHERE j.job_id = p_job_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'there is no job %', p_job_id USING ERRCODE = '22023';
  END IF;
  IF v_job.state NOT IN ('leased','running') THEN
    RAISE EXCEPTION 'the job % is not in an executable state', p_job_id USING ERRCODE = '42501';
  END IF;
  IF v_job.lease_owner IS DISTINCT FROM v_worker THEN
    RAISE EXCEPTION 'the worker does not hold the lease on job %', p_job_id USING ERRCODE = '42501';
  END IF;
  IF v_job.fencing_token <> p_fencing_token THEN
    RAISE EXCEPTION 'the fencing token does not match the job %', p_job_id USING ERRCODE = '42501';
  END IF;
  IF v_job.lease_expires_at IS NULL OR v_job.lease_expires_at <= pg_catalog.now() THEN
    RAISE EXCEPTION 'the lease on job % has expired', p_job_id USING ERRCODE = '42501';
  END IF;
  RETURN li.issue_worker_token(p_job_id, v_worker, p_ttl_seconds);
END;
$$;
REVOKE ALL ON FUNCTION li.request_job_token(UUID, BIGINT, TEXT, INTEGER) FROM PUBLIC;

-- -------------------------------------------------------------------------
-- 5. Claiming, renewal, the fenced write and the recovery.
-- -------------------------------------------------------------------------

-- Claim. ONE statement, so two workers can never hold the same job.
CREATE OR REPLACE FUNCTION li.claim_job(
  p_identity_token TEXT, p_lease_seconds INTEGER
) RETURNS TABLE (job_id UUID, workspace_id UUID, job_type TEXT, payload JSONB,
                 fencing_token BIGINT, lease_expires_at TIMESTAMPTZ,
                 attempt_count INTEGER)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, li, id
AS $$
DECLARE
  v_worker TEXT;
  v_exp    TIMESTAMPTZ;
  v_min    INTEGER;
  v_max    INTEGER;
BEGIN
  SELECT worker_id, expires_at INTO v_worker, v_exp FROM li.parse_identity_token(p_identity_token);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the worker identity is not valid' USING ERRCODE = '42501';
  END IF;
  SELECT min_seconds, max_seconds INTO v_min, v_max FROM li.lease_bounds();
  IF p_lease_seconds IS NULL OR p_lease_seconds < v_min OR p_lease_seconds > v_max THEN
    RAISE EXCEPTION 'the lease must be between % and % seconds', v_min, v_max USING ERRCODE = '22023';
  END IF;

  -- The claim is ONE statement. FOR UPDATE SKIP LOCKED takes the row and
  -- skips the rows other workers already hold, so two workers NEVER obtain
  -- simultaneously valid claims on the same job. The fencing token is
  -- advanced on the claim, so the previous holder's authority is dead the
  -- moment this one takes over.
  -- P1 claims NO-OP jobs only: a chargeable job is left for P2, which is
  -- where the provider ledger lives.
  RETURN QUERY
  WITH candidate AS (
    SELECT j.job_id
      FROM li.job_queue j
     WHERE j.state = 'queued'
       AND j.job_class = 'noop'
       AND j.next_attempt_at <= pg_catalog.now()
       AND j.attempt_count < j.max_attempts
     ORDER BY j.priority ASC, j.next_attempt_at ASC, j.created_at ASC
     FOR UPDATE SKIP LOCKED
     LIMIT 1
  )
  UPDATE li.job_queue q
     SET state = 'leased',
         lease_owner = v_worker,
         lease_expires_at = pg_catalog.now() + pg_catalog.make_interval(secs => p_lease_seconds),
         fencing_token = q.fencing_token + 1,
         attempt_count = q.attempt_count + 1,
         started_at = COALESCE(q.started_at, pg_catalog.now()),
         updated_at = pg_catalog.now()
   WHERE q.job_id = (SELECT c.job_id FROM candidate c)
  RETURNING q.job_id, q.workspace_id, q.job_type, q.payload,
            q.fencing_token, q.lease_expires_at, q.attempt_count;
END;
$$;
REVOKE ALL ON FUNCTION li.claim_job(TEXT, INTEGER) FROM PUBLIC;

-- Renew the lease. The worker proves who it is; the fencing token must
-- still be the job's current one.
CREATE OR REPLACE FUNCTION li.renew_lease(
  p_job_id UUID, p_fencing_token BIGINT, p_identity_token TEXT, p_lease_seconds INTEGER
) RETURNS TIMESTAMPTZ
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, li, id
AS $$
DECLARE
  v_worker TEXT;
  v_exp    TIMESTAMPTZ;
  v_job    li.job_queue%ROWTYPE;
  v_min    INTEGER;
  v_max    INTEGER;
  v_until  TIMESTAMPTZ;
BEGIN
  SELECT worker_id, expires_at INTO v_worker, v_exp FROM li.parse_identity_token(p_identity_token);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the worker identity is not valid' USING ERRCODE = '42501';
  END IF;
  SELECT min_seconds, max_seconds INTO v_min, v_max FROM li.lease_bounds();
  IF p_lease_seconds IS NULL OR p_lease_seconds < v_min OR p_lease_seconds > v_max THEN
    RAISE EXCEPTION 'the lease must be between % and % seconds', v_min, v_max USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_job FROM li.job_queue j WHERE j.job_id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'there is no job %', p_job_id USING ERRCODE = '22023';
  END IF;
  IF v_job.state NOT IN ('leased','running') THEN
    RAISE EXCEPTION 'the job % is not held', p_job_id USING ERRCODE = '42501';
  END IF;
  IF v_job.lease_owner IS DISTINCT FROM v_worker THEN
    RAISE EXCEPTION 'the worker does not hold the lease on job %', p_job_id USING ERRCODE = '42501';
  END IF;
  IF v_job.fencing_token <> p_fencing_token THEN
    RAISE EXCEPTION 'the fencing token does not match the job %', p_job_id USING ERRCODE = '42501';
  END IF;
  IF v_job.lease_expires_at IS NULL OR v_job.lease_expires_at <= pg_catalog.now() THEN
    RAISE EXCEPTION 'the lease on job % has expired', p_job_id USING ERRCODE = '42501';
  END IF;
  v_until := pg_catalog.now() + pg_catalog.make_interval(secs => p_lease_seconds);
  UPDATE li.job_queue
     SET lease_expires_at = v_until, updated_at = pg_catalog.now()
   WHERE job_id = p_job_id AND fencing_token = p_fencing_token;
  RETURN v_until;
END;
$$;
REVOKE ALL ON FUNCTION li.renew_lease(UUID, BIGINT, TEXT, INTEGER) FROM PUBLIC;

-- Open the job context. The context is bound to THIS transaction and THIS
-- backend, carries the verified worker, the job, the workspace and the
-- fencing token, and has NO session and NO user.
CREATE OR REPLACE FUNCTION li.set_workspace_for_job(p_job_id UUID, p_token TEXT) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, li, id
AS $$
DECLARE
  v_token_worker TEXT;
  v_token_ws     UUID;
  v_token_job    UUID;
  v_token_fence  BIGINT;
  v_token_exp    TIMESTAMPTZ;
  v_job  li.job_queue%ROWTYPE;
BEGIN
  SELECT worker_id, workspace_id, job_id, fencing_token, expires_at
    INTO v_token_worker, v_token_ws, v_token_job, v_token_fence, v_token_exp
    FROM li.parse_job_token(p_token);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the job token is not valid' USING ERRCODE = '42501';
  END IF;
  IF v_token_job <> p_job_id THEN
    RAISE EXCEPTION 'the job token is for another job' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_job FROM li.job_queue j WHERE j.job_id = p_job_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'there is no job %', p_job_id USING ERRCODE = '22023';
  END IF;
  IF v_job.state NOT IN ('leased','running') THEN
    RAISE EXCEPTION 'the job % is not in an executable state', p_job_id USING ERRCODE = '42501';
  END IF;
  IF v_job.workspace_id <> v_token_ws THEN
    RAISE EXCEPTION 'the job token is for another workspace' USING ERRCODE = '42501';
  END IF;
  IF v_job.fencing_token <> v_token_fence THEN
    RAISE EXCEPTION 'the fencing token does not match the job %', p_job_id USING ERRCODE = '42501';
  END IF;
  IF v_job.lease_owner IS DISTINCT FROM v_token_worker THEN
    RAISE EXCEPTION 'the worker does not hold the lease on job %', p_job_id USING ERRCODE = '42501';
  END IF;
  IF v_job.lease_expires_at IS NULL OR v_job.lease_expires_at <= pg_catalog.now() THEN
    RAISE EXCEPTION 'the lease on job % has expired', p_job_id USING ERRCODE = '42501';
  END IF;

  -- The context. ON CONFLICT REPLACES the row for this backend, and it
  -- CLEARS the session and the user: a job context never inherits a
  -- session-scoped authority, and a job context never leaves one behind.
  INSERT INTO li.workspace_context
         (backend_pid, xid, role_name, workspace_id, expires_at,
          session_id, user_id, context_kind, job_id, worker_id, fencing_token)
  VALUES (pg_backend_pid(), pg_catalog.pg_current_xact_id(), session_user,
          v_job.workspace_id, v_token_exp,
          NULL, NULL, 'job', v_job.job_id, v_token_worker, v_job.fencing_token)
  ON CONFLICT (backend_pid) DO UPDATE
    SET xid = EXCLUDED.xid,
        role_name = EXCLUDED.role_name,
        workspace_id = EXCLUDED.workspace_id,
        expires_at = EXCLUDED.expires_at,
        session_id = NULL,
        user_id = NULL,
        context_kind = EXCLUDED.context_kind,
        job_id = EXCLUDED.job_id,
        worker_id = EXCLUDED.worker_id,
        fencing_token = EXCLUDED.fencing_token;
END;
$$;
REVOKE ALL ON FUNCTION li.set_workspace_for_job(UUID, TEXT) FROM PUBLIC;

-- The fenced write. A stale worker — one whose lease was reclaimed and
-- whose fencing token has advanced — updates ZERO rows.
CREATE OR REPLACE FUNCTION li.write_job_result(
  p_job_id UUID, p_fencing_token BIGINT, p_state TEXT,
  p_result JSONB, p_error TEXT
) RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, li, id
AS $$
DECLARE
  v_job_id UUID;
  v_ws     UUID;
  v_worker TEXT;
  v_fence  BIGINT;
  v_rows   INTEGER;
BEGIN
  IF p_state IS NULL OR p_state NOT IN ('running','succeeded','failed','cancelled','uncertain') THEN
    RAISE EXCEPTION 'the state % is not one a job may be written into', p_state USING ERRCODE = '22023';
  END IF;
  -- The context decides. Without a valid job context there is nothing to
  -- write: the function refuses by writing ZERO rows.
  SELECT job_id, workspace_id, worker_id, fencing_token
    INTO v_job_id, v_ws, v_worker, v_fence
    FROM li.resolve_job_context();
  IF NOT FOUND OR v_job_id <> p_job_id THEN RETURN 0; END IF;
  IF v_fence <> p_fencing_token THEN RETURN 0; END IF;

  UPDATE li.job_queue
     SET state = p_state,
         result = p_result,
         last_error = p_error,
         updated_at = pg_catalog.now(),
         finished_at = CASE WHEN p_state IN ('succeeded','failed','cancelled') THEN pg_catalog.now() ELSE finished_at END,
         lease_owner = CASE WHEN p_state IN ('succeeded','failed','cancelled') THEN NULL ELSE lease_owner END,
         lease_expires_at = CASE WHEN p_state IN ('succeeded','failed','cancelled') THEN NULL ELSE lease_expires_at END
   WHERE job_id = p_job_id
     AND fencing_token = p_fencing_token
     AND lease_owner = v_worker
     AND state IN ('leased','running');
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$$;
REVOKE ALL ON FUNCTION li.write_job_result(UUID, BIGINT, TEXT, JSONB, TEXT) FROM PUBLIC;

-- The recovery.
--
-- P1 recovers NO-OP jobs only. A 'chargeable' job whose lease has lapsed is
-- NOT requeued and is NOT given an outcome: whether the provider was
-- called is UNKNOWN until the provider ledger exists, and inventing an
-- outcome is exactly the failure this design exists to prevent. Such a job
-- is reported as deferred and left untouched for P2.
CREATE OR REPLACE FUNCTION li.recover_expired_leases(p_limit INTEGER DEFAULT 100)
RETURNS TABLE (job_id UUID, action TEXT)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, li, id
AS $$
DECLARE
  v_row    RECORD;
  v_action TEXT;
  v_rows   INTEGER;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 10000 THEN
    RAISE EXCEPTION 'the recovery limit must be between 1 and 10000' USING ERRCODE = '22023';
  END IF;
  FOR v_row IN
    SELECT j.job_id, j.job_class, j.fencing_token, j.attempt_count, j.max_attempts
      FROM li.job_queue j
     WHERE j.state IN ('leased','running')
       AND j.lease_expires_at IS NOT NULL
       AND j.lease_expires_at <= pg_catalog.now()
     ORDER BY j.lease_expires_at ASC
     FOR UPDATE SKIP LOCKED
     LIMIT p_limit
  LOOP
    IF v_row.job_class <> 'noop' THEN
      v_action := 'deferred_to_p2';
    ELSIF v_row.attempt_count >= v_row.max_attempts THEN
      UPDATE li.job_queue j
         SET state = 'failed',
             lease_owner = NULL,
             lease_expires_at = NULL,
             fencing_token = j.fencing_token + 1,
             last_error = 'the lease expired and the retry limit was reached',
             updated_at = pg_catalog.now(),
             finished_at = pg_catalog.now()
       WHERE j.job_id = v_row.job_id AND j.fencing_token = v_row.fencing_token;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      v_action := CASE WHEN v_rows > 0 THEN 'failed_retry_limit' ELSE 'skipped' END;
    ELSE
      UPDATE li.job_queue j
         SET state = 'queued',
             lease_owner = NULL,
             lease_expires_at = NULL,
             fencing_token = j.fencing_token + 1,
             next_attempt_at = pg_catalog.now()
                              + pg_catalog.make_interval(secs => LEAST(300, 5 * (2 ^ GREATEST(v_row.attempt_count, 1)))),
             last_error = 'the lease expired and the job was requeued',
             updated_at = pg_catalog.now()
       WHERE j.job_id = v_row.job_id AND j.fencing_token = v_row.fencing_token;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      v_action := CASE WHEN v_rows > 0 THEN 'requeued' ELSE 'skipped' END;
    END IF;
    job_id := v_row.job_id;
    action := v_action;
    RETURN NEXT;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION li.recover_expired_leases(INTEGER) FROM PUBLIC;

-- -------------------------------------------------------------------------
-- 6. H1, H2 and H3 — the worker may not hold a workspace authority.
--
-- The worker role is the JOB-scoped role. It must never be able to open a
-- workspace-scoped context, because a workspace-scoped context reaches the
-- workspace's whole tenant data.
--
-- Three independent layers, so that closing one does not open another:
--   H1  a workspace grant may not be created for the worker role
--   H2  a workspace token may not be issued for the worker role
--   H3  the worker may not EXECUTE the workspace-context function, and the
--       function refuses the worker role in its own body as defence in depth
-- -------------------------------------------------------------------------

-- H1: no new workspace grant for the worker role. The refusal is
-- fail-closed and happens BEFORE any row is created or changed.
CREATE OR REPLACE FUNCTION li.grant_workspace(p_workspace UUID, p_role TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, li
AS $$
BEGIN
  IF p_workspace IS NULL OR p_role IS NULL OR p_role = '' THEN
    RETURN FALSE;
  END IF;
  -- H1: the worker role is job scoped. A workspace grant is the ceiling for
  -- a workspace-scoped context, and the worker must never have one.
  IF p_role = 'ztech_worker' THEN
    RETURN FALSE;
  END IF;
  INSERT INTO li.workspace_grants (role_name, workspace_id) VALUES (p_role, p_workspace)
  ON CONFLICT (role_name, workspace_id) DO NOTHING;
  RETURN TRUE;
END;
$$;
REVOKE ALL ON FUNCTION li.grant_workspace(UUID, TEXT) FROM PUBLIC;

-- H2: no workspace token for the worker role. The refusal happens BEFORE
-- the entitlement check, BEFORE the grant check and BEFORE anything is
-- signed, so a valid session and a valid grant do not help.
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
  -- H2: first, and fail-closed. Nothing below is reached for the worker.
  IF p_role = 'ztech_worker' THEN
    RAISE EXCEPTION 'a workspace token may not be issued for the worker role' USING ERRCODE = '42501';
  END IF;
  IF p_workspace IS NULL OR p_session IS NULL OR p_user IS NULL THEN
    RAISE EXCEPTION 'a workspace, a session and a user are required' USING ERRCODE = '22023';
  END IF;
  IF p_ttl_seconds IS NULL OR p_ttl_seconds <= 0 OR p_ttl_seconds > li.max_token_lifetime() THEN
    RAISE EXCEPTION 'the token lifetime must be between 1 and % seconds', li.max_token_lifetime() USING ERRCODE = '22023';
  END IF;
  IF NOT li.session_entitled(p_session, p_user, p_workspace) THEN
    RAISE EXCEPTION 'the session is not entitled to workspace %', p_workspace USING ERRCODE = '42501';
  END IF;
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

-- H3: the worker may not open a workspace context. The privilege is
-- revoked AND the function refuses the role in its own body, so a later
-- re-grant of the privilege does not silently reopen the path.
CREATE OR REPLACE FUNCTION li.set_workspace(p_workspace UUID, p_token TEXT) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, li, id
AS $$
DECLARE
  v_secret  BYTEA;
  v_fields  TEXT[];
  v_payload TEXT;
  v_sig     TEXT;
  v_ws      UUID;
  v_role    TEXT;
  v_session UUID;
  v_user    UUID;
  v_expires BIGINT;
  v_allowed BOOLEAN;
BEGIN
  -- H3, defence in depth: the worker role never opens a workspace context.
  IF session_user = 'ztech_worker' THEN
    RAISE EXCEPTION 'the worker role may not open a workspace context' USING ERRCODE = '42501';
  END IF;
  BEGIN
    v_fields := string_to_array(p_token, '.');
    IF array_length(v_fields, 1) <> 2 THEN
      RAISE EXCEPTION 'the workspace token is malformed' USING ERRCODE = '22023';
    END IF;
    v_payload := pg_catalog.convert_from(li.from_hex(v_fields[1]), 'UTF8');
    v_sig := v_fields[2];
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'the workspace token is malformed' USING ERRCODE = '22023';
  END;
  SELECT secret INTO v_secret FROM li.control_plane_secret WHERE singleton;
  IF v_secret IS NULL THEN
    RAISE EXCEPTION 'the control plane secret is missing' USING ERRCODE = 'XX000';
  END IF;
  IF NOT li.constant_time_equals(pg_catalog.convert_to(v_sig, 'UTF8'),
      pg_catalog.convert_to(li.to_hex(li.hmac_sha256(v_secret, pg_catalog.convert_to(v_payload, 'UTF8'))), 'UTF8')) THEN
    RAISE EXCEPTION 'the workspace token is not valid' USING ERRCODE = '42501';
  END IF;
  BEGIN
    v_fields := string_to_array(v_payload, '|');
    IF array_length(v_fields, 1) <> 6 THEN
      RAISE EXCEPTION 'the workspace token is malformed' USING ERRCODE = '22023';
    END IF;
    v_ws := v_fields[1]::UUID;
    v_role := v_fields[2];
    v_session := v_fields[3]::UUID;
    v_user := v_fields[4]::UUID;
    v_expires := v_fields[6]::BIGINT;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'the workspace token is malformed' USING ERRCODE = '22023';
  END;
  IF v_ws <> p_workspace THEN
    RAISE EXCEPTION 'the workspace token is for another workspace' USING ERRCODE = '42501';
  END IF;
  IF v_role <> session_user THEN
    RAISE EXCEPTION 'the workspace token is for another role' USING ERRCODE = '42501';
  END IF;
  IF v_expires <= EXTRACT(EPOCH FROM pg_catalog.clock_timestamp())::BIGINT THEN
    RAISE EXCEPTION 'the workspace token has expired' USING ERRCODE = '42501';
  END IF;
  IF NOT li.session_entitled(v_session, v_user, p_workspace) THEN
    RAISE EXCEPTION 'the session is not entitled to workspace %', p_workspace USING ERRCODE = '42501';
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM li.workspace_grants g
    WHERE g.role_name = session_user AND g.workspace_id = p_workspace
  ) INTO v_allowed;
  IF NOT v_allowed THEN
    RAISE EXCEPTION 'workspace % is not granted to %', p_workspace, session_user USING ERRCODE = '42501';
  END IF;
  INSERT INTO li.workspace_context
         (backend_pid, xid, role_name, workspace_id, expires_at, session_id, user_id,
          context_kind, job_id, worker_id, fencing_token)
  VALUES (pg_backend_pid(), pg_catalog.pg_current_xact_id(), session_user, p_workspace,
          pg_catalog.to_timestamp(v_expires), v_session, v_user, 'session', NULL, NULL, NULL)
  ON CONFLICT (backend_pid) DO UPDATE
    SET xid = EXCLUDED.xid,
        role_name = EXCLUDED.role_name,
        workspace_id = EXCLUDED.workspace_id,
        expires_at = EXCLUDED.expires_at,
        session_id = EXCLUDED.session_id,
        user_id = EXCLUDED.user_id,
        context_kind = 'session',
        job_id = NULL,
        worker_id = NULL,
        fencing_token = NULL;
END;
$$;
REVOKE ALL ON FUNCTION li.set_workspace(UUID, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION li.set_workspace(UUID, TEXT) FROM ztech_worker;
GRANT EXECUTE ON FUNCTION li.set_workspace(UUID, TEXT) TO ztech_app;

-- -------------------------------------------------------------------------
-- 7. H7 — the worker no longer holds legacy tenant-business DML.
--
-- The worker role was granted the tenant tables in migration 014, before
-- there was a worker. It never needed them: a worker is job scoped, and a
-- job context cannot reach the workspace-wide tenant data at all. These
-- privileges are therefore removed, one explicit statement per group, so
-- the removal is auditable.
--
-- What is NOT removed:
--   - USAGE ON SCHEMA li, and the sequence privileges: the worker needs
--     them to use the schema and to write the queue.
--   - SELECT ON li.li_market_rules: that is the platform's REFERENCE data
--     (the rules that say what is permitted). It is not tenant business
--     data, it is read-only, and a tenant reads it too.
--   - The job queue's own privileges and the job-scoped functions' EXECUTE.
-- -------------------------------------------------------------------------

REVOKE SELECT, INSERT, UPDATE, DELETE ON
  li.li_research_jobs, li.li_evidence_packets, li.li_research_changes, li.li_saved_searches,
  li.li_segments, li.li_segment_members, li.li_pitch_drafts, li.li_outreach_approvals,
  li.li_outreach_activity, li.li_outreach_sends, li.li_enrichment_jobs, li.li_enrichment_observations,
  li.li_oi_associations, li.li_oi_refresh_requests, li.li_contact_consents,
  li.li_contact_provenance, li.li_trust_events, li.li_recipient_refs, li.li_mailboxes,
  li.li_mailbox_sent, li.li_reply_reviews, li.li_sequences, li.li_sequence_steps,
  li.li_sequence_events, li.li_sequence_gaps, li.li_sequence_control, li.li_reply_routes
  FROM ztech_worker;

REVOKE SELECT, INSERT, UPDATE, DELETE ON li.li_suppressions FROM ztech_worker;

-- The reference data stays readable.
GRANT SELECT ON li.li_market_rules TO ztech_worker;

-- -------------------------------------------------------------------------
-- 8. The grants.
--
-- Every new function: revoked from PUBLIC, granted only to the role that
-- needs it. The exact matrix is asserted by assertRoles.js.
-- -------------------------------------------------------------------------

GRANT EXECUTE ON FUNCTION li.current_workspace() TO ztech_app, ztech_worker, ztech_platform;
GRANT EXECUTE ON FUNCTION li.current_job() TO ztech_app, ztech_worker, ztech_platform;
GRANT EXECUTE ON FUNCTION li.current_job_workspace() TO ztech_app, ztech_worker, ztech_platform;
GRANT EXECUTE ON FUNCTION li.job_row_authorized(UUID, UUID, BIGINT) TO ztech_app, ztech_worker, ztech_platform;
GRANT EXECUTE ON FUNCTION li.resolve_job_context() TO ztech_app, ztech_worker, ztech_platform;
GRANT EXECUTE ON FUNCTION li.lease_bounds() TO ztech_worker;
GRANT EXECUTE ON FUNCTION li.job_token_ttl_bounds() TO ztech_worker;

GRANT EXECUTE ON FUNCTION li.issue_worker_identity(TEXT, INTEGER) TO ztech_control;
GRANT EXECUTE ON FUNCTION li.issue_worker_token(UUID, TEXT, INTEGER) TO ztech_control;
GRANT EXECUTE ON FUNCTION li.request_job_token(UUID, BIGINT, TEXT, INTEGER) TO ztech_worker;
GRANT EXECUTE ON FUNCTION li.claim_job(TEXT, INTEGER) TO ztech_worker;
GRANT EXECUTE ON FUNCTION li.renew_lease(UUID, BIGINT, TEXT, INTEGER) TO ztech_worker;
GRANT EXECUTE ON FUNCTION li.set_workspace_for_job(UUID, TEXT) TO ztech_worker;
GRANT EXECUTE ON FUNCTION li.write_job_result(UUID, BIGINT, TEXT, JSONB, TEXT) TO ztech_worker;
GRANT EXECUTE ON FUNCTION li.recover_expired_leases(INTEGER) TO ztech_worker;

-- The control plane may only issue credentials. It may not read a row, it
-- may not write a row, and it may not open a context of its own.
GRANT EXECUTE ON FUNCTION li.issue_workspace_token(UUID, TEXT, UUID, UUID, INTEGER)
  TO ztech_control, ztech_identity;
GRANT EXECUTE ON FUNCTION li.grant_workspace(UUID, TEXT) TO ztech_identity;

-- The runtime role may consume the context, never issue one.
GRANT EXECUTE ON FUNCTION li.is_suppressed(TEXT, TEXT) TO ztech_app, ztech_worker;
