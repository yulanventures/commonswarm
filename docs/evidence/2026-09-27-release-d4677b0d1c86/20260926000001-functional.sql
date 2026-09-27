-- Read-only section-6 proof. The lead supplies a dedicated managed test seat
-- after one watcher has claimed its lease through the new command edge.
\if :{?item_g2b_principal_id}
\else
DO $$ BEGIN RAISE EXCEPTION 'item_g2b_principal_id is required'; END $$;
\endif
SELECT set_config('item_g2b.principal_id', :'item_g2b_principal_id', false);
DO $proof$
DECLARE
  seat uuid := current_setting('item_g2b.principal_id')::uuid;
  workspace uuid;
  owner_id uuid;
  holder text;
  lease_generation bigint;
  age_ms bigint;
  visible bigint;
BEGIN
  SELECT l.workspace_id, p.owner_user_id, l.host_label, l.generation,
    greatest(0, floor(extract(epoch FROM (clock_timestamp() - l.renewed_at)) * 1000))::bigint
    INTO workspace, owner_id, holder, lease_generation, age_ms
  FROM swarm.agent_wake_leases l JOIN swarm.agent_principals p
    ON p.workspace_id = l.workspace_id AND p.principal_id = l.principal_id
  WHERE l.principal_id = seat AND l.renewed_at > clock_timestamp() - interval '3 minutes';
  IF workspace IS NULL OR holder IS NULL OR lease_generation < 1 OR age_ms < 0 THEN
    RAISE EXCEPTION 'dedicated seat has no fresh watcher lease';
  END IF;
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', owner_id::text)::text, true);
  SELECT count(*) INTO visible FROM swarm_read.agent_wake_leases v
  WHERE v.workspace_id = workspace AND v.principal_id = seat
    AND v.host_label = holder AND v.generation = lease_generation AND v.renewed_age_ms >= 0;
  IF visible <> 1 THEN RAISE EXCEPTION 'member cannot see the exact lease'; END IF;
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', gen_random_uuid()::text)::text, true);
  SELECT count(*) INTO visible FROM swarm_read.agent_wake_leases v
  WHERE v.workspace_id = workspace AND v.principal_id = seat;
  IF visible <> 0 THEN RAISE EXCEPTION 'nonmember saw the lease'; END IF;
  PERFORM set_config('request.jwt.claims', '', true);
  SELECT count(*) INTO visible FROM swarm_read.agent_wake_leases v
  WHERE v.workspace_id = workspace AND v.principal_id = seat;
  IF visible <> 0 THEN RAISE EXCEPTION 'anonymous context saw the lease'; END IF;
END $proof$;
