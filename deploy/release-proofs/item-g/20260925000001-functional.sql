-- Read-only box proof. Supply the exact post-migration, directed test note as
-- -v item_g_seed_signal_id=<uuid>. Its recipient must first have made one
-- unclaimed observed acknowledgement after the release cutoff. Leave this
-- particular note unchecked. A dedicated test seat avoids older competing mail.
\if :{?item_g_seed_signal_id}
\else
DO $$ BEGIN RAISE EXCEPTION 'item_g_seed_signal_id is required'; END $$;
\endif
SELECT set_config('item_g.seed_signal_id', :'item_g_seed_signal_id', false);
DO $proof$
DECLARE
  v_count bigint;
  v_workspace uuid;
  v_principal uuid;
  v_enqueued timestamptz;
  v_owner uuid;
  v_seed uuid := current_setting('item_g.seed_signal_id')::uuid;
BEGIN
  SELECT d.workspace_id, d.principal_id, d.enqueued_at, p.owner_user_id
    INTO v_workspace, v_principal, v_enqueued, v_owner
  FROM swarm.wake_path_eligible_deliveries AS d
  JOIN swarm.agent_principals AS p ON p.workspace_id = d.workspace_id
    AND p.principal_id = d.principal_id
  WHERE d.signal_id = v_seed
    AND swarm.is_member(d.workspace_id, p.owner_user_id);
  IF v_workspace IS NULL THEN
    RAISE EXCEPTION 'seed signal is not an eligible live unobserved delivery for a known, active seat';
  END IF;
  SELECT count(*) INTO v_count FROM swarm.wake_path_eligible_deliveries AS d
  WHERE d.workspace_id = v_workspace AND d.principal_id = v_principal
    AND d.signal_id <> v_seed;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'seed seat has other eligible mail; use a dedicated test seat';
  END IF;
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_owner::text)::text, true);
  SELECT count(*) INTO v_count FROM swarm_read.agent_wake_path AS w
  WHERE w.workspace_id = v_workspace AND w.principal_id = v_principal
    AND w.oldest_unobserved_at = v_enqueued;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'wake-path view omitted exact seeded unobserved delivery';
  END IF;
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', gen_random_uuid()::text)::text, true);
  SELECT count(*) INTO v_count FROM swarm_read.agent_wake_path AS w
  WHERE w.workspace_id = v_workspace AND w.principal_id = v_principal;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'wake-path view exposed a row to a nonmember';
  END IF;
  PERFORM set_config('request.jwt.claims', '', true);
  SELECT count(*) INTO v_count FROM swarm_read.agent_wake_path AS w
  WHERE w.workspace_id = v_workspace AND w.principal_id = v_principal;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'wake-path view exposed a row without member identity';
  END IF;
END $proof$;
