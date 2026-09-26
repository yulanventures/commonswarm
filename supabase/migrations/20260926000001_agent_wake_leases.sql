-- One renewable watcher lease per seat. No bearer secret is stored here.
CREATE TABLE swarm.agent_wake_leases (
  workspace_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  watcher_id uuid NOT NULL,
  host_label text NOT NULL CHECK (length(host_label) BETWEEN 1 AND 120),
  host_id uuid NOT NULL,
  host_session_ref text,
  generation bigint NOT NULL CHECK (generation > 0),
  claimed_at timestamptz NOT NULL,
  renewed_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, principal_id),
  FOREIGN KEY (principal_id, workspace_id)
    REFERENCES swarm.agent_principals (principal_id, workspace_id)
);
ALTER TABLE swarm.agent_wake_leases OWNER TO swarm_admin;
ALTER TABLE swarm.agent_wake_leases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON swarm.agent_wake_leases FROM PUBLIC, anon, authenticated, swarm_read;
GRANT SELECT ON swarm.agent_wake_leases TO swarm_command;
CREATE POLICY wake_lease_server_read ON swarm.agent_wake_leases
  FOR SELECT TO swarm_command USING (true);

-- Every contender takes this same advisory transaction lock before inspecting
-- either table. H0's poll path uses it before inserting its own lock.
CREATE FUNCTION swarm.wake_seat_lock(p_workspace uuid, p_principal uuid)
RETURNS void LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog AS $$
  SELECT pg_advisory_xact_lock(1936142697, hashtext(p_workspace::text || ':' || p_principal::text))
$$;
ALTER FUNCTION swarm.wake_seat_lock(uuid, uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.wake_seat_lock(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION swarm.wake_seat_lock(uuid, uuid) TO swarm_command;

CREATE FUNCTION swarm.claim_agent_wake_lease(
  p_workspace uuid, p_principal uuid, p_watcher uuid, p_host text,
  p_host_id uuid, p_session text, p_take_over boolean, p_stale_ms integer
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog AS $$
DECLARE
  prior swarm.agent_wake_leases%ROWTYPE;
  poll_held boolean;
  age_ms bigint;
  next_generation bigint;
  stolen boolean;
BEGIN
  PERFORM swarm.wake_seat_lock(p_workspace, p_principal);
  SELECT EXISTS (
    SELECT 1 FROM swarm.h0_poll_locks
    WHERE workspace_id = p_workspace AND principal_id = p_principal
      AND expires_at > clock_timestamp()
  ) INTO poll_held;
  IF poll_held THEN
    RETURN jsonb_build_object('error', 'notify_held_elsewhere', 'surface', 'h0_poll');
  END IF;
  SELECT * INTO prior FROM swarm.agent_wake_leases
  WHERE workspace_id = p_workspace AND principal_id = p_principal FOR UPDATE;
  age_ms := CASE WHEN prior.principal_id IS NULL THEN NULL
    ELSE greatest(0, floor(extract(epoch FROM (clock_timestamp() - prior.renewed_at)) * 1000)::bigint) END;
  IF prior.principal_id IS NOT NULL AND prior.watcher_id <> p_watcher
     AND age_ms < p_stale_ms AND NOT p_take_over
     AND prior.host_id <> p_host_id THEN
    RETURN jsonb_build_object('error', 'notify_held_elsewhere', 'surface', 'watcher',
      'host_label', prior.host_label, 'lease_age_ms', age_ms);
  END IF;
  stolen := prior.principal_id IS NOT NULL AND prior.watcher_id <> p_watcher;
  next_generation := CASE WHEN prior.principal_id IS NULL THEN 1
    WHEN stolen THEN prior.generation + 1 ELSE prior.generation END;
  INSERT INTO swarm.agent_wake_leases AS lease
    (workspace_id, principal_id, watcher_id, host_label, host_id, host_session_ref,
     generation, claimed_at, renewed_at)
  VALUES (p_workspace, p_principal, p_watcher, p_host, p_host_id, p_session,
          next_generation, clock_timestamp(), clock_timestamp())
  ON CONFLICT (workspace_id, principal_id) DO UPDATE SET
    watcher_id = EXCLUDED.watcher_id, host_label = EXCLUDED.host_label,
    host_id = EXCLUDED.host_id,
    host_session_ref = EXCLUDED.host_session_ref,
    generation = EXCLUDED.generation,
    claimed_at = CASE WHEN lease.watcher_id = EXCLUDED.watcher_id
      THEN lease.claimed_at ELSE EXCLUDED.claimed_at END,
    renewed_at = EXCLUDED.renewed_at;
  RETURN jsonb_build_object('generation', next_generation, 'stolen', stolen);
END $$;
ALTER FUNCTION swarm.claim_agent_wake_lease(uuid, uuid, uuid, text, uuid, text, boolean, integer) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.claim_agent_wake_lease(uuid, uuid, uuid, text, uuid, text, boolean, integer)
  FROM PUBLIC, anon, authenticated, swarm_read;
GRANT EXECUTE ON FUNCTION swarm.claim_agent_wake_lease(uuid, uuid, uuid, text, uuid, text, boolean, integer)
  TO swarm_command;

CREATE FUNCTION swarm.renew_agent_wake_lease(
  p_workspace uuid, p_principal uuid, p_watcher uuid, p_generation bigint
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog AS $$
DECLARE holder text;
BEGIN
  PERFORM swarm.wake_seat_lock(p_workspace, p_principal);
  IF EXISTS (SELECT 1 FROM swarm.h0_poll_locks
    WHERE workspace_id = p_workspace AND principal_id = p_principal
      AND expires_at > clock_timestamp()) THEN
    RETURN jsonb_build_object('error', 'wake_lease_superseded', 'surface', 'h0_poll');
  END IF;
  UPDATE swarm.agent_wake_leases SET renewed_at = clock_timestamp()
  WHERE workspace_id = p_workspace AND principal_id = p_principal
    AND watcher_id = p_watcher AND generation = p_generation;
  IF FOUND THEN RETURN jsonb_build_object('renewed', true); END IF;
  SELECT host_label INTO holder FROM swarm.agent_wake_leases
    WHERE workspace_id = p_workspace AND principal_id = p_principal;
  RETURN jsonb_build_object('error', 'wake_lease_superseded', 'surface', 'watcher',
    'host_label', holder);
END $$;
ALTER FUNCTION swarm.renew_agent_wake_lease(uuid, uuid, uuid, bigint) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.renew_agent_wake_lease(uuid, uuid, uuid, bigint)
  FROM PUBLIC, anon, authenticated, swarm_read;
GRANT EXECUTE ON FUNCTION swarm.renew_agent_wake_lease(uuid, uuid, uuid, bigint)
  TO swarm_command;

CREATE FUNCTION swarm.release_agent_wake_lease(
  p_workspace uuid, p_principal uuid, p_watcher uuid, p_generation bigint
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog AS $$
BEGIN
  PERFORM swarm.wake_seat_lock(p_workspace, p_principal);
  DELETE FROM swarm.agent_wake_leases WHERE workspace_id = p_workspace
    AND principal_id = p_principal AND watcher_id = p_watcher
    AND generation = p_generation;
  RETURN jsonb_build_object('released', FOUND);
END $$;
ALTER FUNCTION swarm.release_agent_wake_lease(uuid, uuid, uuid, bigint) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.release_agent_wake_lease(uuid, uuid, uuid, bigint)
  FROM PUBLIC, anon, authenticated, swarm_read;
GRANT EXECUTE ON FUNCTION swarm.release_agent_wake_lease(uuid, uuid, uuid, bigint)
  TO swarm_command;

-- Browser membership, never a direct table grant. Ages are measured at read.
CREATE VIEW swarm_read.agent_wake_leases WITH (security_barrier = true) AS
SELECT l.workspace_id, l.principal_id, l.host_label, l.generation,
  greatest(0, floor(extract(epoch FROM (clock_timestamp() - l.claimed_at)) * 1000))::bigint AS claimed_age_ms,
  greatest(0, floor(extract(epoch FROM (clock_timestamp() - l.renewed_at)) * 1000))::bigint AS renewed_age_ms
FROM swarm.agent_wake_leases l
WHERE swarm.is_member(l.workspace_id, auth.uid());
ALTER VIEW swarm_read.agent_wake_leases OWNER TO swarm_admin;
REVOKE ALL ON swarm_read.agent_wake_leases FROM PUBLIC, anon;
GRANT SELECT ON swarm_read.agent_wake_leases TO authenticated, swarm_read;

-- The read edge passes a previously authenticated agent token hash. Recheck
-- identity here, so a direct RPC cannot enumerate another seat's lease.
CREATE FUNCTION swarm.agent_wake_lease_for_token(p_hash bytea, p_workspace uuid)
RETURNS TABLE (watcher_id uuid, host_label text, generation bigint, renewed_age_ms bigint)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT l.watcher_id, l.host_label, l.generation,
    greatest(0, floor(extract(epoch FROM (clock_timestamp() - l.renewed_at)) * 1000))::bigint
  FROM swarm.agent_delivery_read_context(p_hash, p_workspace) c
  JOIN swarm.agent_wake_leases l ON l.principal_id = c.principal_id
    AND l.workspace_id = c.principal_workspace_id
  WHERE c.principal_workspace_id = p_workspace AND NOT c.is_revoked
$$;
ALTER FUNCTION swarm.agent_wake_lease_for_token(bytea, uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.agent_wake_lease_for_token(bytea, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION swarm.agent_wake_lease_for_token(bytea, uuid) TO swarm_read;
