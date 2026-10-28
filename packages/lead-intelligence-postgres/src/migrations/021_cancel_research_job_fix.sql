-- 021_cancel_research_job_fix.sql
CREATE OR REPLACE FUNCTION li.cancel_research_job(p_job_id UUID)
RETURNS TABLE (job_id UUID, action TEXT, state TEXT, cancel_requested_at TIMESTAMPTZ)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, li, id
AS $$
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
           fencing_token = jq.fencing_token + 1,
           updated_at = v_now
     WHERE jq.job_id = p_job_id AND jq.workspace_id = v_workspace AND jq.state = 'queued';
    RETURN QUERY SELECT p_job_id, 'cancelled', 'cancelled', v_now;
    RETURN;
  END IF;

  UPDATE li.job_queue AS jq
     SET cancel_requested_at = COALESCE(jq.cancel_requested_at, v_now),
         updated_at = v_now
   WHERE jq.job_id = p_job_id AND jq.workspace_id = v_workspace
     AND jq.state IN ('leased','running');
  RETURN QUERY SELECT p_job_id, 'cancel_requested', v_state,
          COALESCE((SELECT j2.cancel_requested_at FROM li.job_queue j2
                    WHERE j2.job_id = p_job_id AND j2.workspace_id = v_workspace), v_now);
  RETURN;
END;
$$;
REVOKE ALL ON FUNCTION li.cancel_research_job(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION li.cancel_research_job(UUID) TO ztech_app;
