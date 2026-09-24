-- Read-only smoke: a live member can query the function and a caller with no
-- member identity sees no rows for the same workspace.
DO $proof$
DECLARE
  v_workspace uuid;
  v_user uuid;
  v_count bigint;
BEGIN
  SELECT m.workspace_id, m.user_id INTO v_workspace, v_user
  FROM swarm.memberships AS m
  JOIN swarm.workspaces AS w ON w.workspace_id = m.workspace_id
  WHERE m.revoked_at IS NULL AND w.archived_at IS NULL LIMIT 1;
  IF v_workspace IS NULL THEN
    RAISE EXCEPTION 'no live member for pending access functional proof';
  END IF;
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_user::text)::text, true);
  SELECT count(*) INTO v_count FROM swarm_read.pending_access(v_workspace);
  IF v_count < 0 THEN RAISE EXCEPTION 'invalid pending access count'; END IF;
  PERFORM set_config('request.jwt.claims', '', true);
  IF EXISTS (SELECT 1 FROM swarm_read.pending_access(v_workspace)) THEN
    RAISE EXCEPTION 'pending access returned rows without a member identity';
  END IF;
END $proof$;
