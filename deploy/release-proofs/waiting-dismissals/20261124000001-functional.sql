-- Read-only functional invariant proof for 20261124000001 (waiting_dismissals).
DO $proof$
DECLARE
  v_audit_def text := pg_get_viewdef('swarm_read.audit_log'::regclass, true);
BEGIN
  IF EXISTS (
    SELECT 1 FROM swarm.waiting_dismissals wd
    WHERE NOT EXISTS (SELECT 1 FROM swarm.workspaces w WHERE w.workspace_id = wd.workspace_id)
  ) THEN
    RAISE EXCEPTION 'waiting_dismissals row references missing workspace' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM swarm.waiting_dismissals wd
    WHERE NOT EXISTS (SELECT 1 FROM swarm.users u WHERE u.user_id = wd.user_id)
  ) THEN
    RAISE EXCEPTION 'waiting_dismissals row references missing user' USING ERRCODE = '55000';
  END IF;
  IF (swarm.dismiss_waiting_item(NULL, NULL, 'ask', NULL)->>'status') IS DISTINCT FROM 'invalid_request' THEN
    RAISE EXCEPTION 'dismiss_waiting_item failed invalid_request check' USING ERRCODE = '55000';
  END IF;
  IF (swarm.restore_waiting_item(NULL, NULL, 'ask', NULL)->>'status') IS DISTINCT FROM 'invalid_request' THEN
    RAISE EXCEPTION 'restore_waiting_item failed invalid_request check' USING ERRCODE = '55000';
  END IF;
  IF swarm.waiting_dismissal_replay_allowed(NULL, NULL, 'ask', NULL) IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'waiting_dismissal_replay_allowed failed null fail-closed check' USING ERRCODE = '55000';
  END IF;
  IF position('dismiss_waiting_item' IN v_audit_def) = 0
     OR position('restore_waiting_item' IN v_audit_def) = 0 THEN
    RAISE EXCEPTION 'swarm_read.audit_log does not exclude waiting dismissal commands' USING ERRCODE = '55000';
  END IF;
END $proof$;
