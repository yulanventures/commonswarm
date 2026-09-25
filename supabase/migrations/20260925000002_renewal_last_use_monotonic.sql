-- A statement can start before another grant use, wait for that row's lock,
-- then see the later use and try to replace it with its older start time.
-- Keep the no-rewind trigger. Skip an older use on both active writers so
-- its device, source, and new-host fields cannot replace the newer use.

CREATE OR REPLACE FUNCTION swarm.record_renewal_grant_use(
  p_token_id uuid,
  p_device_id uuid,
  p_last_used_from text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = swarm, pg_catalog
AS $$
BEGIN
  UPDATE swarm.renewal_grants AS grant_row
  SET last_used_at = statement_timestamp(),
      last_used_device_id = p_device_id,
      last_used_from = COALESCE(p_last_used_from, grant_row.last_used_from),
      new_host_at = CASE
        WHEN grant_row.new_host_at IS NOT NULL THEN grant_row.new_host_at
        WHEN grant_row.bound_device_id IS NOT NULL
             AND p_device_id IS DISTINCT FROM grant_row.bound_device_id
          THEN statement_timestamp()
        WHEN grant_row.last_used_device_id IS NOT NULL
             AND p_device_id IS DISTINCT FROM grant_row.last_used_device_id
          THEN statement_timestamp()
        ELSE NULL
      END
  FROM swarm.agent_tokens AS token
  WHERE token.token_id = p_token_id
    AND token.renewal_grant_id = grant_row.renewal_grant_id
    AND grant_row.revoked_at IS NULL
    AND NOT grant_row.suspension_active
    AND (grant_row.last_used_at IS NULL
         OR grant_row.last_used_at <= statement_timestamp());
END;
$$;

ALTER FUNCTION swarm.record_renewal_grant_use(uuid, uuid, text) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.record_renewal_grant_use(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION swarm.record_renewal_grant_use(uuid, uuid, text)
  TO swarm_command, swarm_read;

-- Successor issuance also waits on this row before recording use.
CREATE OR REPLACE FUNCTION swarm.agent_tokens_successor_fence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  pred swarm.agent_tokens%ROWTYPE;
  grant_row swarm.renewal_grants%ROWTYPE;
  owner_user uuid;
  run_device uuid;
  run_ended timestamptz;
  principal_revoked timestamptz;
  device_revoked timestamptz;
BEGIN
  NEW.issued_at := statement_timestamp();

  SELECT * INTO pred
  FROM swarm.agent_tokens
  WHERE token_id = NEW.predecessor_token_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_PREDECESSOR_MISSING' USING ERRCODE = '55000';
  END IF;

  IF NEW.principal_id IS DISTINCT FROM pred.principal_id
    OR NEW.run_id IS DISTINCT FROM pred.run_id
    OR NEW.task_id IS DISTINCT FROM pred.task_id
    OR NEW.epoch IS DISTINCT FROM pred.epoch
  THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_TARGET_MISMATCH' USING ERRCODE = '55000';
  END IF;
  IF NEW.lineage_id IS DISTINCT FROM pred.lineage_id THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_LINEAGE_MISMATCH' USING ERRCODE = '55000';
  END IF;
  IF pred.renewal_grant_id IS NULL THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_UNGRANTED_PREDECESSOR' USING ERRCODE = '55000';
  END IF;
  IF NEW.renewal_grant_id IS DISTINCT FROM pred.renewal_grant_id THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_GRANT_MISMATCH' USING ERRCODE = '55000';
  END IF;
  IF pred.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_PREDECESSOR_REVOKED' USING ERRCODE = '55000';
  END IF;
  IF pred.expires_at <= statement_timestamp() THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_PREDECESSOR_EXPIRED' USING ERRCODE = '55000';
  END IF;
  IF pred.surrender_only THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_PREDECESSOR_SURRENDERED' USING ERRCODE = '55000';
  END IF;

  SELECT p.owner_user_id, p.revoked_at, r.device_id, r.ended_at, d.revoked_at
    INTO owner_user, principal_revoked, run_device, run_ended, device_revoked
  FROM swarm.agent_principals AS p
  JOIN swarm.agent_runs AS r ON r.run_id = pred.run_id
  JOIN swarm.devices AS d ON d.device_id = r.device_id
  WHERE p.principal_id = pred.principal_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_BINDING_MISSING' USING ERRCODE = '55000';
  END IF;
  IF principal_revoked IS NOT NULL THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_PRINCIPAL_REVOKED' USING ERRCODE = '55000';
  END IF;
  IF run_ended IS NOT NULL THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_RUN_ENDED' USING ERRCODE = '55000';
  END IF;
  IF device_revoked IS NOT NULL THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_DEVICE_REVOKED' USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1 FROM swarm.revocation_tombstones AS tombstone
    WHERE (tombstone.kind, tombstone.target_id) IN (
      ('token', pred.token_id),
      ('lineage', pred.lineage_id),
      ('family', pred.lineage_id),
      ('principal', pred.principal_id),
      ('run', pred.run_id),
      ('device', run_device),
      ('membership', owner_user),
      ('renewal_grant', pred.renewal_grant_id)
    )
  ) THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_LINEAGE_REVOKED' USING ERRCODE = '55000';
  END IF;

  IF jsonb_typeof(NEW.scopes) <> 'array'
     OR jsonb_typeof(pred.scopes) <> 'array'
  THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_SCOPES_MALFORMED' USING ERRCODE = '55000';
  END IF;
  IF NOT (pred.scopes @> NEW.scopes) THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_SCOPE_WIDENED' USING ERRCODE = '55000';
  END IF;

  SELECT * INTO grant_row
  FROM swarm.renewal_grants
  WHERE renewal_grant_id = pred.renewal_grant_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_GRANT_MISSING' USING ERRCODE = '55000';
  END IF;
  IF grant_row.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_GRANT_REVOKED' USING ERRCODE = '55000';
  END IF;
  IF grant_row.suspension_active THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_GRANT_SUSPENDED' USING ERRCODE = '55000';
  END IF;
  IF grant_row.kind = 'timeboxed'
     AND grant_row.horizon_expires_at <= statement_timestamp()
  THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_HORIZON_REACHED' USING ERRCODE = '55000';
  END IF;
  IF grant_row.bound_device_id IS NOT NULL
     AND run_device IS DISTINCT FROM grant_row.bound_device_id
  THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_DEVICE_MISMATCH' USING ERRCODE = '55000';
  END IF;
  IF grant_row.max_successors IS NOT NULL
     AND grant_row.successors_used - grant_row.successors_stranded >= grant_row.max_successors
  THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_GRANT_EXHAUSTED' USING ERRCODE = '55000';
  END IF;

  IF NEW.expires_at <= NEW.issued_at THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_TTL_INVALID' USING ERRCODE = '55000';
  END IF;
  IF NEW.expires_at > NEW.issued_at + interval '8 hours' THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_TTL_EXCEEDED'
      USING ERRCODE = '55000', CONSTRAINT = 'renewal_ttl_exceeded';
  END IF;
  IF grant_row.kind = 'timeboxed'
     AND NEW.expires_at > grant_row.horizon_expires_at
  THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_BEYOND_HORIZON' USING ERRCODE = '55000';
  END IF;

  -- A successor spends capacity even when its use timestamp became stale
  -- while waiting for the grant row. Do not skip this counter increment.
  UPDATE swarm.renewal_grants
  SET successors_used = successors_used + 1
  WHERE renewal_grant_id = grant_row.renewal_grant_id;

  UPDATE swarm.renewal_grants
  SET last_used_at = statement_timestamp(),
      last_used_device_id = run_device,
      new_host_at = CASE
        WHEN new_host_at IS NOT NULL THEN new_host_at
        WHEN last_used_device_id IS NOT NULL
             AND run_device IS DISTINCT FROM last_used_device_id
          THEN statement_timestamp()
        ELSE NULL
      END
  WHERE renewal_grant_id = grant_row.renewal_grant_id
    AND (last_used_at IS NULL OR last_used_at <= statement_timestamp());

  RETURN NEW;
END
$$;

ALTER FUNCTION swarm.agent_tokens_successor_fence() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.agent_tokens_successor_fence() FROM PUBLIC;

COMMENT ON FUNCTION swarm.agent_tokens_successor_fence() IS
  'Standing/timeboxed successor fence: validates predecessor lineage and liveness, grant revocation/active suspension/horizon/device binding, scope attenuation, short bearer TTL, and atomically records spend plus use.';
