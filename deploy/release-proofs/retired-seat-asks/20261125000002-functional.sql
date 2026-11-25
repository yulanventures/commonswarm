-- Read-only functional invariant proof for 20261125000002 (retired_seat_asks_prep).
DO $proof$
DECLARE
  v_trigger_src text;
  v_withdraw_src text;
  v_enabled boolean;
BEGIN
  IF EXISTS (
    SELECT 1 FROM swarm.agent_ask_lifecycle al
    WHERE NOT EXISTS (
      SELECT 1 FROM swarm.agent_workspace_memberships am
      WHERE am.workspace_id = al.workspace_id AND am.principal_id = al.principal_id
    )
  ) THEN
    RAISE EXCEPTION 'agent_ask_lifecycle row references missing seat membership' USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1 FROM swarm.agent_ask_clear_events ce
    WHERE NOT EXISTS (
      SELECT 1 FROM swarm.agent_workspace_memberships am
      WHERE am.workspace_id = ce.workspace_id AND am.principal_id = ce.principal_id
    )
  ) THEN
    RAISE EXCEPTION 'agent_ask_clear_events row references missing seat membership' USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1 FROM swarm.signals s
    WHERE (s.from_kind <> 'agent' OR s.kind <> 'ask')
      AND s.sender_lifecycle_epoch IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'non-agent or non-ask signal carries sender_lifecycle_epoch' USING ERRCODE = '55000';
  END IF;

  IF swarm.seat_is_disconnected_for_ask_clear(NULL, NULL) IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'seat_is_disconnected_for_ask_clear failed null fail-closed check' USING ERRCODE = '55000';
  END IF;

  IF swarm.seat_ask_lifecycle_epoch(NULL, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'seat_ask_lifecycle_epoch failed null fail-closed check' USING ERRCODE = '55000';
  END IF;

  IF swarm.advance_seat_lifecycle_epoch(NULL, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'advance_seat_lifecycle_epoch failed null fail-closed check' USING ERRCODE = '55000';
  END IF;

  IF (swarm.clear_retired_seat_asks(NULL, NULL, NULL)->>'status') IS DISTINCT FROM 'invalid_request' THEN
    RAISE EXCEPTION 'clear_retired_seat_asks failed invalid_request check' USING ERRCODE = '55000';
  END IF;

  IF swarm.seat_ask_clear_release_allowed(NULL, NULL, NULL, NULL, NULL) IS DISTINCT FROM false
     OR swarm.seat_ask_clear_release_allowed(NULL, NULL, NULL, 1, now()) IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'seat_ask_clear_release_allowed failed null fail-closed check' USING ERRCODE = '55000';
  END IF;

  IF swarm.ask_is_withdrawn(NULL, NULL) IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'ask_is_withdrawn failed null fail-closed check' USING ERRCODE = '55000';
  END IF;

  IF (swarm.withdraw_ask(NULL, 'user', NULL, NULL, NULL)->>'status') IS DISTINCT FROM 'invalid_request' THEN
    RAISE EXCEPTION 'withdraw_ask failed invalid_request check' USING ERRCODE = '55000';
  END IF;

  SELECT (c.value = 'true'::jsonb)
  INTO v_enabled
  FROM swarm.config AS c
  WHERE c.key = 'retired_seat_ask_clear_enabled';

  IF v_enabled IS NULL THEN
    RAISE EXCEPTION 'retired_seat_ask_clear_enabled missing from swarm.config' USING ERRCODE = '55000';
  END IF;

  -- When Phase 1 only (flag false), clear_retired_seat_asks must refuse clearing_not_enabled
  -- and advance_seat_lifecycle_epoch must be a no-op returning 1.
  IF NOT v_enabled THEN
    IF (swarm.clear_retired_seat_asks(
      '00000000-0000-4000-8000-000000000001'::uuid,
      '00000000-0000-4000-8000-000000000002'::uuid,
      '00000000-0000-4000-8000-000000000003'::uuid
    )->>'status') IS DISTINCT FROM 'clearing_not_enabled' THEN
      RAISE EXCEPTION 'clear_retired_seat_asks did not refuse clearing_not_enabled while flag is false'
        USING ERRCODE = '55000';
    END IF;
    IF swarm.advance_seat_lifecycle_epoch(
      '00000000-0000-4000-8000-000000000003'::uuid,
      '00000000-0000-4000-8000-000000000001'::uuid
    ) IS DISTINCT FROM 1 THEN
      RAISE EXCEPTION 'advance_seat_lifecycle_epoch did not no-op to 1 while flag is false'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  SELECT prosrc INTO v_trigger_src
  FROM pg_proc
  WHERE oid = 'swarm.signals_bind_seat_lifecycle_epoch()'::regprocedure;
  IF position('NEW.sender_lifecycle_epoch :=' IN coalesce(v_trigger_src, '')) > 0 THEN
    RAISE EXCEPTION 'signals_bind_seat_lifecycle_epoch must never synthesize or backfill sender_lifecycle_epoch'
      USING ERRCODE = '55000';
  END IF;

  SELECT prosrc INTO v_withdraw_src
  FROM pg_proc
  WHERE oid = 'swarm.withdraw_ask(uuid,text,uuid,uuid,uuid)'::regprocedure;
  IF position('swarm.waiting_ask_autoclear_status(' IN coalesce(v_withdraw_src, '')) = 0
     OR position('swarm.ask_complete_for_withdrawal(' IN coalesce(v_withdraw_src, '')) = 0
     OR position('swarm.waiting_ask_autoclear_status(' IN v_withdraw_src)
        > position('swarm.ask_complete_for_withdrawal(' IN v_withdraw_src) THEN
    RAISE EXCEPTION 'withdraw_ask must evaluate cutoff/autoclear before ask_complete_for_withdrawal'
      USING ERRCODE = '55000';
  END IF;
END $proof$;
