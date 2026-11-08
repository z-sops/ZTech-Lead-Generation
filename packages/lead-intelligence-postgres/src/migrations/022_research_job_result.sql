-- 022: read the result of a finished research job (Phase 2).
--
-- The worker writes a research job's result (businesses, evidence, findings,
-- needs, scored opportunities) through li.write_job_result, under its
-- job-scoped authority. The customer reads it back through this function,
-- under the same rule as li.get_research_job: only a job of the workspace in
-- scope for the current session, never another workspace's.
--
-- Only a SUCCEEDED job has a result to show; for any other state the result
-- is NULL, so a half-written or failed job can never be shown as findings.

CREATE OR REPLACE FUNCTION li.get_research_job_result(p_job_id UUID)
RETURNS TABLE (job_id UUID, state TEXT, finished_at TIMESTAMPTZ, result JSONB)
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
  SELECT j.job_id, j.state, j.finished_at,
         CASE WHEN j.state = 'succeeded' THEN j.result ELSE NULL END
    FROM li.job_queue j
   WHERE j.job_id = p_job_id AND j.workspace_id = v_workspace;
END;
$$;
REVOKE ALL ON FUNCTION li.get_research_job_result(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION li.get_research_job_result(UUID) TO ztech_app;
