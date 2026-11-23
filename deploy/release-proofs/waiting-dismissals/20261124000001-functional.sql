-- Read-only functional invariant proof for 20261124000001 (waiting_dismissals).
DO $proof$
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
END $proof$;
