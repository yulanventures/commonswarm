-- Read-only smoke. The release must have at least one pending row in a live
-- workspace before this proof runs; otherwise the positive gate cannot be
-- measured. The operator seeds it through the normal product path beforehand.
DO $proof$
DECLARE
  v_workspace uuid;
  v_user uuid;
  v_count bigint;
  v_candidate record;
BEGIN
  FOR v_candidate IN
    SELECT m.workspace_id, m.user_id
    FROM swarm.memberships AS m
    JOIN swarm.workspaces AS w ON w.workspace_id = m.workspace_id
    WHERE m.revoked_at IS NULL AND w.archived_at IS NULL
  LOOP
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_candidate.user_id::text)::text, true);
    SELECT count(*) INTO v_count FROM swarm_read.pending_access(v_candidate.workspace_id);
    IF v_count > 0 THEN
      v_workspace := v_candidate.workspace_id;
      v_user := v_candidate.user_id;
      EXIT;
    END IF;
  END LOOP;
  IF v_workspace IS NULL THEN
    RAISE EXCEPTION 'no seeded pending row visible to a live member for pending access functional proof';
  END IF;
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_user::text)::text, true);
  SELECT count(*) INTO v_count FROM swarm_read.pending_access(v_workspace);
  IF v_count < 1 THEN RAISE EXCEPTION 'seeded pending row is not visible to its workspace member'; END IF;
  PERFORM set_config('request.jwt.claims', '', true);
  SELECT count(*) INTO v_count FROM swarm_read.pending_access(v_workspace);
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'pending access returned rows without a member identity';
  END IF;
END $proof$;
