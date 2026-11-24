-- Read-only functional invariant proof for 20261125000001 (ask_withdrawals + dismissal instance).
DO $proof$
DECLARE
  v_autoclear_src text;
  v_open_asks_src text;
  v_waiting_todos_src text;
  v_audit_def text := pg_get_viewdef('swarm_read.audit_log'::regclass, true);
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
  IF swarm.ask_sender_can_access_placement(NULL, NULL, 'user', NULL) IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'ask_sender_can_access_placement failed null fail-closed check' USING ERRCODE = '55000';
  END IF;
  IF swarm.ask_complete_for_withdrawal(NULL, NULL) IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'ask_complete_for_withdrawal failed null fail-closed check' USING ERRCODE = '55000';
  END IF;
  IF swarm.ask_withdrawal_release_allowed(NULL, 'user', NULL, NULL, NULL, true) IS DISTINCT FROM false
     OR swarm.ask_withdrawal_release_allowed(NULL, 'user', NULL, NULL, NULL, false) IS DISTINCT FROM false
     OR swarm.ask_withdrawal_release_allowed(NULL, 'user', NULL, NULL, NULL, NULL) IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'ask_withdrawal_release_allowed failed null fail-closed check' USING ERRCODE = '55000';
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
  SELECT prosrc INTO v_open_asks_src
  FROM pg_proc
  WHERE oid = 'swarm_read.my_open_asks(uuid,integer,timestamp with time zone,uuid,bytea)'::regprocedure;
  IF position('waiting_dismissals' IN coalesce(v_open_asks_src, '')) > 0
     OR position('dismiss' IN lower(coalesce(v_open_asks_src, ''))) > 0 THEN
    RAISE EXCEPTION 'my_open_asks must not expose dismissal state' USING ERRCODE = '55000';
  END IF;
  IF swarm_read.waiting_todos_page(NULL, 50, NULL, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'waiting_todos_page failed null fail-closed check' USING ERRCODE = '55000';
  END IF;
  SELECT prosrc INTO v_waiting_todos_src
  FROM pg_proc
  WHERE oid = 'swarm_read.waiting_todos_page(uuid,integer,timestamp with time zone,uuid)'::regprocedure;
  IF position('''offer_id''' IN coalesce(v_waiting_todos_src, '')) = 0 THEN
    RAISE EXCEPTION 'waiting_todos_page missing offer_id projection for request rows' USING ERRCODE = '55000';
  END IF;
  IF position('withdraw_ask' IN coalesce(v_audit_def, '')) = 0
     OR position('dismiss_waiting_item' IN coalesce(v_audit_def, '')) = 0
     OR position('restore_waiting_item' IN coalesce(v_audit_def, '')) = 0 THEN
    RAISE EXCEPTION 'swarm_read.audit_log missing withdraw_ask or waiting dismissal filters' USING ERRCODE = '55000';
  END IF;
END $proof$;
