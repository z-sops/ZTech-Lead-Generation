-- =====================================================================
-- 017_research_jobs_api.sql ï¿½?" M4 P1 / Checkpoint C
--
-- The app-facing, durable research-job pathway on top of li.job_queue.
--
-- This migration is ADDITIVE and IDEMPOTENT. It adds one column to
-- li.job_queue (cancel_requested_at) and five SECURITY DEFINER functions:
--
--   li.enqueue_research_job        - the customer creates a research job
--   li.list_research_jobs          - the customer lists this workspace's jobs
--   li.get_research_job            - the customer inspects one job
--   li.cancel_research_job         - the customer requests cancellation
--   li.fail_or_retry_job           - the worker records failure or requeue
--
-- Every function is owned by ztech_migrator, runs SECURITY DEFINER, and is
-- revoked from PUBLIC. Only the approved role may execute each one.
-- =====================================================================

-- -------------------------------------------------------------------------
-- 1. The cancellation column
-- -------------------------------------------------------------------------

ALTER TABLE li.job_queue ADD COLUMN IF NOT EXISTS cancel_requested_at TIMESTAMPTZ;

-- -------------------------------------------------------------------------
-- 2. Enqueue: the customer creates a research job, idempotently
-- -------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION li.enqueue_research_job(
  p_job_id UUID,
  p_job_type TEXT,
  p_idempotency_key TEXT,
  p_payload JSONB
) RETURNS TABLE (
  job_id UUID,
  workspace_id UUID,
  job_type TEXT,
  state TEXT,
  idempotency_key TEXT,
  created_at TIMESTAMPTZ,
  deduplicated BOOLEAN
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, li, id
AS $$
DECLARE
  v_workspace UUID;
  v_inserted INTEGER;
BEGIN
  v_workspace := li.current_workspace();
  IF v_workspace IS NULL THEN
    RAISE EXCEPTION 'no workspace is in scope for the current session' USING ERRCODE = '42501';
  END IF;
  IF p_job_type IS NULL OR p_job_type <> 'research' THEN
    RAISE EXCEPTION 'only research jobs may be enqueued through this API' USING ERRCODE = '22023';
  END IF;
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) < 1 OR length(p_idempotency_key) > 200 THEN
    RAISE EXCEPTION 'the idempotency key must be between 1 and 200 characters' USING ERRCODE = '22023';
  END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'the payload must be a JSON object' USING ERRCODE = '22023';
  END IF;
-- The payload limit is 16,384 bytes of UTF-8 JSON serialization, matching
  -- the HTTP layer's Buffer.byteLength(JSON.stringify(payload), 'utf8').
  -- jsonb normalizes its input (drops insignificant whitespace, sorts object
  -- keys, deduplicates keys, stores numbers in binary), so the canonical text
  -- form measured here is a LOWER BOUND on the client's serialization: a
  -- payload that passes the HTTP check can never exceed this check. We measure
  -- octet_length(p_payload::text) (UTF-8 bytes, not characters) so multibyte
  -- content is counted correctly.
  IF octet_length(p_payload::text) > 16384 THEN
    RAISE EXCEPTION 'the payload is larger than 16 KiB' USING ERRCODE = '22023';
  END IF;

  INSERT INTO li.job_queue
         (job_id, workspace_id, job_type, idempotency_key, payload, job_class, state)
  VALUES (p_job_id, v_workspace, p_job_type, p_idempotency_key, p_payload, 'noop', 'queued')
  ON CONFLICT (workspace_id, job_type, idempotency_key) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  RETURN QUERY
  SELECT j.job_id, j.workspace_id, j.job_type, j.state, j.idempotency_key, j.created_at,
         (v_inserted = 0) AS deduplicated
    FROM li.job_queue j
   WHERE j.workspace_id = v_workspace
     AND j.job_type = p_job_type
     AND j.idempotency_key = p_idempotency_key;
END;
$$;
REVOKE ALL ON FUNCTION li.enqueue_research_job(UUID, TEXT, TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION li.enqueue_research_job(UUID, TEXT, TEXT, JSONB) TO ztech_app;

-- -------------------------------------------------------------------------
-- 3. List: the customer lists this workspace's research jobs, newest first
-- -------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION li.list_research_jobs(p_limit INTEGER DEFAULT 50)
RETURNS TABLE (
  job_id UUID, workspace_id UUID, job_type TEXT, state TEXT,
  idempotency_key TEXT, payload JSONB, created_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ,
  attempt_count INTEGER, cancel_requested_at TIMESTAMPTZ, last_error TEXT
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, li, id
AS $$
DECLARE
  v_workspace UUID;
  v_limit INTEGER;
BEGIN
  v_workspace := li.current_workspace();
  IF v_workspace IS NULL THEN
    RAISE EXCEPTION 'no workspace is in scope for the current session' USING ERRCODE = '42501';
  END IF;
  v_limit := COALESCE(p_limit, 50);
  IF v_limit < 1 OR v_limit > 1000 THEN
    RAISE EXCEPTION 'the limit must be between 1 and 1000' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT j.job_id, j.workspace_id, j.job_type, j.state, j.idempotency_key, j.payload,
         j.created_at, j.started_at, j.finished_at, j.attempt_count,
         j.cancel_requested_at, j.last_error
    FROM li.job_queue j
   WHERE j.workspace_id = v_workspace
     AND j.job_type = 'research'
   ORDER BY j.created_at DESC
   LIMIT v_limit;
END;
$$;
REVOKE ALL ON FUNCTION li.list_research_jobs(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION li.list_research_jobs(INTEGER) TO ztech_app;

-- -------------------------------------------------------------------------
-- 4. Get: the customer inspects one research job in this workspace
-- -------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION li.get_research_job(p_job_id UUID)
RETURNS TABLE (
  job_id UUID, workspace_id UUID, job_type TEXT, state TEXT,
  idempotency_key TEXT, payload JSONB, created_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ,
  attempt_count INTEGER, cancel_requested_at TIMESTAMPTZ, last_error TEXT
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, li, id
AS $$
DECLARE
  v_workspace UUID;
BEGIN
  v_workspace := li.current_workspace();
  IF v_workspace IS NULL THEN
    RAISE EXCEPTION 'no workspace is in scope for the current session' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT j.job_id, j.workspace_id, j.job_type, j.state, j.idempotency_key, j.payload,
         j.created_at, j.started_at, j.finished_at, j.attempt_count,
         j.cancel_requested_at, j.last_error
    FROM li.job_queue j
   WHERE j.job_id = p_job_id AND j.workspace_id = v_workspace;
END;
$$;
REVOKE ALL ON FUNCTION li.get_research_job(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION li.get_research_job(UUID) TO ztech_app;

-- -------------------------------------------------------------------------
-- 5. Cancel: the customer requests cancellation of one research job
-- -------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION li.cancel_research_job(p_job_id UUID)
RETURNS TABLE (job_id UUID, action TEXT, state TEXT, cancel_requested_at TIMESTAMPTZ)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, li, id
AS \$\$
DECLARE
  v_workspace UUID;
  v_state TEXT;
  v_now TIMESTAMPTZ := pg_catalog.now();
BEGIN
  v_workspace := li.current_workspace();
  IF v_workspace IS NULL THEN
    RAISE EXCEPTION 'no workspace is in scope for the current session' USING ERRCODE = '42501';
  END IF;

  SELECT j.state INTO v_state
    FROM li.job_queue j
   WHERE j.job_id = p_job_id AND j.workspace_id = v_workspace;
  IF NOT FOUND THEN
    RETURN QUERY SELECT p_job_id, 'not_found', NULL, NULL;
    RETURN;
  END IF;

  IF v_state = ANY (ARRAY['succeeded','failed','cancelled']) THEN
    RETURN QUERY SELECT p_job_id, 'unchanged', v_state,
           (SELECT j2.cancel_requested_at FROM li.job_queue j2
             WHERE j2.job_id = p_job_id AND j2.workspace_id = v_workspace);
    RETURN;
  END IF;

  IF v_state = 'queued' THEN
    UPDATE li.job_queue AS jq
       SET state = 'cancelled',
           cancel_requested_at = v_now,
           finished_at = v_now,
           lease_owner = NULL,
           lease_expires_at = NULL,
           fencing_token = fencing_token + 1,
           updated_at = v_now
     WHERE jq.job_id = p_job_id AND jq.workspace_id = v_workspace AND jq.state = 'queued';
    RETURN QUERY SELECT p_job_id, 'cancelled', 'cancelled', v_now;
    RETURN;
  END IF;

  UPDATE li.job_queue AS jq
     SET cancel_requested_at = COALESCE(cancel_requested_at, v_now),
         updated_at = v_now
   WHERE jq.job_id = p_job_id AND jq.workspace_id = v_workspace
     AND jq.state IN ('leased','running');
  RETURN QUERY SELECT p_job_id, 'cancel_requested', v_state,
         COALESCE((SELECT j2.cancel_requested_at FROM li.job_queue j2
                   WHERE j2.job_id = p_job_id AND j2.workspace_id = v_workspace), v_now);
  RETURN;
END;
\$\$;
REVOKE ALL ON FUNCTION li.cancel_research_job(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION li.cancel_research_job(UUID) TO ztech_app;

-- -------------------------------------------------------------------------
-- 6. Fail or retry: the worker records the outcome of a held job
-- -------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION li.fail_or_retry_job(
  p_job_id UUID, p_fencing_token BIGINT, p_error TEXT
) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, li, id
AS $$
DECLARE
  v_job_id UUID;
  v_ws UUID;
  v_worker TEXT;
  v_fence BIGINT;
  v_job li.job_queue%ROWTYPE;
  v_now TIMESTAMPTZ := pg_catalog.now();
  v_backoff INTEGER;
BEGIN
  SELECT job_id, workspace_id, worker_id, fencing_token
    INTO v_job_id, v_ws, v_worker, v_fence
    FROM li.resolve_job_context();
  IF NOT FOUND THEN RETURN 'refused'; END IF;
  IF v_job_id <> p_job_id OR v_fence <> p_fencing_token THEN RETURN 'refused'; END IF;

  SELECT * INTO v_job FROM li.job_queue j WHERE j.job_id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'refused'; END IF;
  IF v_job.lease_owner IS DISTINCT FROM v_worker THEN RETURN 'refused'; END IF;
  IF v_job.state NOT IN ('leased','running') THEN RETURN 'refused'; END IF;

  IF v_job.cancel_requested_at IS NOT NULL THEN
    UPDATE li.job_queue
       SET state = 'cancelled',
           lease_owner = NULL,
           lease_expires_at = NULL,
           fencing_token = fencing_token + 1,
           last_error = COALESCE(p_error, 'the job was cancelled'),
           updated_at = v_now,
           finished_at = v_now
     WHERE job_id = p_job_id AND fencing_token = p_fencing_token AND workspace_id = v_ws;
    RETURN 'cancelled';
  ELSIF v_job.attempt_count < v_job.max_attempts THEN
    v_backoff := LEAST(60, floor(pow(2::DOUBLE PRECISION, GREATEST(v_job.attempt_count, 1))))::INTEGER;
    UPDATE li.job_queue
       SET state = 'queued',
           lease_owner = NULL,
           lease_expires_at = NULL,
           fencing_token = fencing_token + 1,
           attempt_count = attempt_count + 1,
           next_attempt_at = v_now + pg_catalog.make_interval(secs => v_backoff),
           last_error = p_error,
           updated_at = v_now
     WHERE job_id = p_job_id AND fencing_token = p_fencing_token AND workspace_id = v_ws;
    RETURN 'requeued';
  ELSE
    UPDATE li.job_queue
       SET state = 'failed',
           lease_owner = NULL,
           lease_expires_at = NULL,
           fencing_token = fencing_token + 1,
           last_error = p_error,
           updated_at = v_now,
           finished_at = v_now
     WHERE job_id = p_job_id AND fencing_token = p_fencing_token AND workspace_id = v_ws;
    RETURN 'failed';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION li.fail_or_retry_job(UUID, BIGINT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION li.fail_or_retry_job(UUID, BIGINT, TEXT) TO ztech_worker;
