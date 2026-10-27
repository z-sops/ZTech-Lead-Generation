-- =====================================================================
-- 018_research_jobs_api_fix.sql — M5 P1 / Checkpoint C fix
--
-- Fix ambiguity in li.enqueue_research_job() ON CONFLICT clause.
-- Migration 016 already creates the unique index:
--   CREATE UNIQUE INDEX IF NOT EXISTS job_queue_idempotency_idx
--     ON li.job_queue (workspace_id, job_type, idempotency_key)
-- The column-list ON CONFLICT (workspace_id, job_type, idempotency_key)
-- is ambiguous in certain role/context combinations. Switch to the
-- named-constraint form which is idempotent and unambiguous.
-- This migration is ADDITIVE and IDEMPOTENT: it only modifies a function
-- definition and does not rewrite migration 017 history.
-- =====================================================================

-- -------------------------------------------------------------------------
-- 1. Fix ON CONFLICT in li.enqueue_research_job()
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
) LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, li, id
AS $$
DECLARE
  v_workspace UUID;
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
  IF octet_length(p_payload::text) > 16384 THEN
    RAISE EXCEPTION 'the payload is larger than 16 KiB' USING ERRCODE = '22023';
  END IF;

  INSERT INTO li.job_queue
       (job_id, workspace_id, job_type, idempotency_key, payload, job_class, state)
  VALUES (p_job_id, li.current_workspace(), p_job_type, p_idempotency_key, p_payload, 'noop', 'queued')
  ON CONFLICT ON CONSTRAINT job_queue_idempotency_idx DO NOTHING;
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