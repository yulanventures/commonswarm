-- Read-only positive control: HezLead seeds a directed note to an attended
-- test seat BEFORE the migration window and does not run check. The roster
-- view must expose that unobserved row to the seat owner's member identity.
DO $proof$
DECLARE
  v_count bigint;
  v_workspace uuid;
  v_principal uuid;
  v_oldest timestamptz;
  v_owner uuid;
BEGIN
  SELECT d.workspace_id, d.recipient_agent_principal_id, min(d.enqueued_at), p.owner_user_id
    INTO v_workspace, v_principal, v_oldest, v_owner
  FROM swarm.signal_deliveries AS d
  JOIN swarm.signals AS s ON s.id = d.signal_id AND s.workspace_id = d.workspace_id
  JOIN swarm.agent_principals AS p ON p.workspace_id = d.workspace_id
    AND p.principal_id = d.recipient_agent_principal_id
  WHERE d.acked_at IS NULL
    AND d.last_lease_id IS NULL AND d.last_leased_by IS NULL
    AND d.lease_id IS NULL AND d.leased_by IS NULL
    AND s.kind IN ('ask', 'note')
    AND (s.to_agent_principal_id = d.recipient_agent_principal_id
      OR EXISTS (SELECT 1 FROM swarm.signal_recipients AS r
        WHERE r.workspace_id = s.workspace_id AND r.signal_id = s.id
          AND r.recipient_agent_principal_id = d.recipient_agent_principal_id))
  GROUP BY d.workspace_id, d.recipient_agent_principal_id, p.owner_user_id
  ORDER BY min(d.enqueued_at) ASC LIMIT 1;
  IF v_workspace IS NULL THEN
    RAISE EXCEPTION 'no seeded directed unclaimed delivery for wake-path view proof';
  END IF;
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_owner::text)::text, true);
  SELECT count(*) INTO v_count FROM swarm_read.agent_wake_path AS w
  WHERE w.workspace_id = v_workspace AND w.principal_id = v_principal
    AND w.oldest_unobserved_at <= v_oldest;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'wake-path view omitted seeded unobserved directed delivery';
  END IF;
  PERFORM set_config('request.jwt.claims', '', true);
  SELECT count(*) INTO v_count FROM swarm_read.agent_wake_path AS w
  WHERE w.workspace_id = v_workspace AND w.principal_id = v_principal;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'wake-path view exposed a row without member identity';
  END IF;
END $proof$;
