-- Read-only functional invariant proof for 20261125000001 (ask_withdrawals + dismissal instance).
DO $proof$
DECLARE
  v_autoclear_src text;
BEGIN
  IF EXISTS (
    SELECT 1 FROM swarm.ask_withdrawals aw
    WHERE NOT EXISTS (
      SELECT 1 FROM swarm.signals s
      WHERE s.workspace_id = aw.workspace_id AND s.id = aw.signal_id AND s.kind = 'ask'
    )
  ) THEN
    RAISE EXCEPTION 'ask_withdrawals row references missing or non-ask signal' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM swarm.ask_withdrawals aw
    WHERE aw.replaced_by_signal_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM swarm.signals r
        WHERE r.workspace_id = aw.workspace_id AND r.id = aw.replaced_by_signal_id AND r.kind = 'ask'
      )
  ) THEN
    RAISE EXCEPTION 'ask_withdrawals row references missing or non-ask replacement signal' USING ERRCODE = '55000';
  END IF;
  IF swarm.ask_is_withdrawn(NULL, NULL) IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'ask_is_withdrawn failed null fail-closed check' USING ERRCODE = '55000';
  END IF;
  IF (swarm.withdraw_ask(NULL, 'user', NULL, NULL, NULL)->>'status') IS DISTINCT FROM 'invalid_request' THEN
    RAISE EXCEPTION 'withdraw_ask failed invalid_request check' USING ERRCODE = '55000';
  END IF;
  IF swarm_read.my_open_asks(NULL, 50, NULL, NULL, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'my_open_asks failed null fail-closed check' USING ERRCODE = '55000';
  END IF;
  IF (swarm.restore_waiting_item(NULL, NULL, 'ask', NULL, NULL)->>'status') IS DISTINCT FROM 'invalid_request' THEN
    RAISE EXCEPTION 'restore_waiting_item(5-arg) failed invalid_request check' USING ERRCODE = '55000';
  END IF;
  SELECT prosrc INTO v_autoclear_src
  FROM pg_proc
  WHERE oid = 'swarm.waiting_ask_autoclear_status(uuid,uuid,timestamp with time zone)'::regprocedure;
  IF position('ask_withdrawals' IN coalesce(v_autoclear_src, '')) = 0
     OR position('Replaced by a newer question' IN coalesce(v_autoclear_src, '')) = 0 THEN
    RAISE EXCEPTION 'waiting_ask_autoclear_status missing withdrawn/replaced branches' USING ERRCODE = '55000';
  END IF;
END $proof$;
