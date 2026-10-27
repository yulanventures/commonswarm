-- Rollback reserve for 20261019000007 (local auth lock order). Apply inside one
-- transaction as a swarm_admin member, in reverse version order: the reserves
-- for 20261025000001, 20261022000992, 20261021000990, 20261019000010,
-- 20261019000009 and 20261019000008 must already have run. 20261019000010 and
-- 20261021000990 replace functions this file drops or restores (the two
-- readers, the discovery and guard functions, the delivery read context, the
-- successor fence, use recording and prepare), and 20261025000001 relies on
-- the family binding trigger dropped here.
-- Restores verbatim, each with its own owner, ACL and comment statements:
-- swarm.renewal_grants_spend_or_revoke_only(), swarm.prepare_renewal_grant(uuid,uuid),
-- swarm.resume_renewal_grant(uuid,uuid,uuid), swarm_read.renewal_grant_roster(uuid)
-- and swarm_read.renewal_grant_for_token(uuid,uuid) from 20260904000001;
-- swarm.record_renewal_grant_use(uuid,uuid,text) and swarm.agent_tokens_successor_fence()
-- from 20260925000002; swarm.agent_delivery_read_context(bytea,uuid) from
-- 20261001000004. The two readers change return type, so they are dropped and
-- recreated; CREATE OR REPLACE keeps every other oid, trigger binding and comment.
-- Drops: the five discovery functions, both guard functions with their triggers,
-- swarm_command's UPDATE on household_content_connections.renewal_grant_id, and
-- the column swarm.renewal_grants.local_content_approval_token_id.
-- Data this loses: local_content_approval_token_id holds, per family, the
-- owner's latest deliberate local Allow (the approved token the family runs
-- under). Dropping the column discards every such choice. After a later
-- roll-forward each family reads NULL again, which the runtime treats as the
-- conservative legacy ceiling until the owner allows once more.
-- Kept on purpose: every renewal grant, token, tombstone, approval and audit
-- row, including renewal_grant_id bindings on household_content_connections
-- (that column belongs to 20261019000002; the pre-00007 edge tolerates it, as
-- it tolerates NULL expiry since 20261004000015). Table owners, RLS and table
-- ACLs are untouched. The migration ledger row belongs to the operator step.

-- 1. The grant row fence goes back to the 20260904000001 text (no owner-only
--    conversion carve-out).
CREATE OR REPLACE FUNCTION swarm.renewal_grants_spend_or_revoke_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  resuming boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_GRANT_UNDELETABLE' USING ERRCODE = '55000';
  END IF;

  IF NEW.renewal_grant_id IS DISTINCT FROM OLD.renewal_grant_id
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.principal_id IS DISTINCT FROM OLD.principal_id
    OR NEW.run_id IS DISTINCT FROM OLD.run_id
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.max_successors IS DISTINCT FROM OLD.max_successors
    OR NEW.horizon_expires_at IS DISTINCT FROM OLD.horizon_expires_at
    OR NEW.bound_device_id IS DISTINCT FROM OLD.bound_device_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.created_by IS DISTINCT FROM OLD.created_by
  THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_GRANT_IMMUTABLE' USING ERRCODE = '55000';
  END IF;

  IF NEW.successors_used < OLD.successors_used THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_COUNTER_REWOUND' USING ERRCODE = '55000';
  END IF;
  IF NEW.successors_stranded < OLD.successors_stranded THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_STRANDED_REWOUND' USING ERRCODE = '55000';
  END IF;
  IF OLD.last_used_at IS NOT NULL
     AND (NEW.last_used_at IS NULL OR NEW.last_used_at < OLD.last_used_at)
  THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_LAST_USE_REWOUND' USING ERRCODE = '55000';
  END IF;
  IF (
    NEW.last_used_device_id IS DISTINCT FROM OLD.last_used_device_id
    OR NEW.last_used_from IS DISTINCT FROM OLD.last_used_from
  ) AND NEW.last_used_at IS NOT DISTINCT FROM OLD.last_used_at
  THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_USE_WITHOUT_TIMESTAMP' USING ERRCODE = '55000';
  END IF;
  IF OLD.new_host_at IS NOT NULL
     AND NEW.new_host_at IS DISTINCT FROM OLD.new_host_at
  THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_NEW_HOST_REWOUND' USING ERRCODE = '55000';
  END IF;

  -- The suspension RECORD is still one-way. Clearing suspended_at is refused as
  -- it always was, and it may not move backwards either: a resume is written to
  -- resumed_at, so the lapse that happened stays on the row forever.
  IF OLD.suspended_at IS NOT NULL AND NEW.suspended_at IS NULL THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_GRANT_UNSUSPEND' USING ERRCODE = '55000';
  END IF;
  IF OLD.suspended_at IS NOT NULL AND NEW.suspended_at < OLD.suspended_at THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_SUSPENSION_REWOUND' USING ERRCODE = '55000';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_GRANT_UNREVOKE' USING ERRCODE = '55000';
  END IF;

  resuming := NEW.resumed_at IS DISTINCT FROM OLD.resumed_at;

  IF OLD.resumed_at IS NOT NULL
     AND (NEW.resumed_at IS NULL OR NEW.resumed_at < OLD.resumed_at)
  THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_RESUME_REWOUND' USING ERRCODE = '55000';
  END IF;
  IF NEW.resume_count < OLD.resume_count THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_RESUME_REWOUND' USING ERRCODE = '55000';
  END IF;

  IF resuming THEN
    -- REVOCATION IS FOREVER. This is the fence that keeps "suspended, a person
    -- can bring it back" and "revoked, dead" from ever being the same state.
    IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'SWARM_RENEWAL_GRANT_RESUME_AFTER_REVOKE'
        USING ERRCODE = '55000';
    END IF;
    -- A resume answers a suspension that already happened, in a statement that
    -- does not also suspend. Without the second clause a single UPDATE could
    -- suspend and resume at once and mean nothing.
    IF OLD.suspended_at IS NULL
       OR NEW.suspended_at IS DISTINCT FROM OLD.suspended_at
       OR NEW.resumed_at <= OLD.suspended_at
    THEN
      RAISE EXCEPTION 'SWARM_RENEWAL_RESUME_WITHOUT_SUSPENSION'
        USING ERRCODE = '55000';
    END IF;
    IF NEW.resumed_by IS NULL OR NEW.resume_count <> OLD.resume_count + 1 THEN
      RAISE EXCEPTION 'SWARM_RENEWAL_RESUME_UNATTRIBUTED' USING ERRCODE = '55000';
    END IF;
  ELSE
    -- Attribution and the counter move only WITH a resume, so neither can be
    -- edited to imply a resume that did not occur.
    IF NEW.resumed_by IS DISTINCT FROM OLD.resumed_by
       OR NEW.resume_count <> OLD.resume_count
    THEN
      RAISE EXCEPTION 'SWARM_RENEWAL_RESUME_UNATTRIBUTED' USING ERRCODE = '55000';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

ALTER FUNCTION swarm.renewal_grants_spend_or_revoke_only() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.renewal_grants_spend_or_revoke_only() FROM PUBLIC;

COMMENT ON FUNCTION swarm.renewal_grants_spend_or_revoke_only() IS
  'Grant row fence: authority fields immutable; counters, last use, suspension and resume forward-only; suspended_at never cleared; revoked_at never cleared; and a revoked grant can never be resumed.';

-- 2. The Allow pointer guard and its trigger leave with the column below.
DROP TRIGGER aa_local_content_approval_pointer ON swarm.renewal_grants;
DROP FUNCTION swarm.local_content_approval_pointer_guard();

-- 3. Both readers return to the 19-column STABLE shape of 20260904000001. The
--    return type differs, so each is dropped and recreated with its ACL and comment.
DROP FUNCTION swarm_read.renewal_grant_for_token(uuid,uuid);
CREATE OR REPLACE FUNCTION swarm_read.renewal_grant_for_token(
  p_workspace_id uuid,
  p_token_id uuid
)
RETURNS TABLE (
  renewal_grant_id uuid,
  principal_id uuid,
  owner_user_id uuid,
  agent_name text,
  model text,
  kind text,
  horizon_expires_at timestamptz,
  bound_device_id uuid,
  last_used_at timestamptz,
  last_used_device_id uuid,
  last_used_from text,
  new_host_at timestamptz,
  suspended_at timestamptz,
  revoked_at timestamptz,
  token_id uuid,
  issued_at timestamptz,
  token_expires_at timestamptz,
  first_used_at timestamptz,
  token_revoked_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = swarm, pg_catalog
AS $$
  SELECT
    grant_row.renewal_grant_id,
    principal.principal_id,
    principal.owner_user_id,
    principal.name,
    principal.model,
    grant_row.kind,
    grant_row.horizon_expires_at,
    grant_row.bound_device_id,
    grant_row.last_used_at,
    grant_row.last_used_device_id,
    grant_row.last_used_from,
    grant_row.new_host_at,
    CASE WHEN grant_row.suspension_active THEN grant_row.suspended_at END,
    grant_row.revoked_at,
    latest.token_id,
    latest.issued_at,
    latest.expires_at,
    latest.first_used_at,
    latest.revoked_at
  FROM swarm.agent_tokens AS presenting
  JOIN swarm.renewal_grants AS grant_row
    ON grant_row.renewal_grant_id = presenting.renewal_grant_id
  JOIN swarm.agent_principals AS principal
    ON principal.principal_id = grant_row.principal_id
  LEFT JOIN LATERAL (
    SELECT candidate.token_id, candidate.issued_at,
           candidate.expires_at, candidate.first_used_at, candidate.revoked_at
    FROM swarm.agent_tokens AS candidate
    WHERE candidate.renewal_grant_id = grant_row.renewal_grant_id
    ORDER BY candidate.issued_at DESC, candidate.token_id DESC
    LIMIT 1
  ) AS latest ON true
  WHERE presenting.token_id = p_token_id
    AND grant_row.workspace_id = p_workspace_id
    AND principal.workspace_id = p_workspace_id
    AND principal.revoked_at IS NULL;
$$;

ALTER FUNCTION swarm_read.renewal_grant_for_token(uuid, uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm_read.renewal_grant_for_token(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION swarm_read.renewal_grant_for_token(uuid, uuid)
  TO swarm_read;

COMMENT ON FUNCTION swarm_read.renewal_grant_for_token(uuid, uuid) IS
  'The current renewal grant for one already-authenticated agent token. suspended_at reports CURRENT suspension: a resumed grant reads NULL. Never returns another principal or workspace.';

DROP FUNCTION swarm_read.renewal_grant_roster(uuid);
CREATE OR REPLACE FUNCTION swarm_read.renewal_grant_roster(p_workspace_id uuid)
RETURNS TABLE (
  renewal_grant_id uuid,
  principal_id uuid,
  owner_user_id uuid,
  agent_name text,
  model text,
  kind text,
  horizon_expires_at timestamptz,
  bound_device_id uuid,
  last_used_at timestamptz,
  last_used_device_id uuid,
  last_used_from text,
  new_host_at timestamptz,
  suspended_at timestamptz,
  revoked_at timestamptz,
  token_id uuid,
  issued_at timestamptz,
  token_expires_at timestamptz,
  first_used_at timestamptz,
  token_revoked_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = swarm, pg_catalog
AS $$
DECLARE
  v_user_id uuid := NULLIF(
    NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub',
    ''
  )::uuid;
BEGIN
  IF v_user_id IS NULL OR NOT swarm.is_member(p_workspace_id, v_user_id) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    grant_row.renewal_grant_id,
    principal.principal_id,
    principal.owner_user_id,
    principal.name,
    principal.model,
    grant_row.kind,
    grant_row.horizon_expires_at,
    grant_row.bound_device_id,
    grant_row.last_used_at,
    grant_row.last_used_device_id,
    grant_row.last_used_from,
    grant_row.new_host_at,
    CASE WHEN grant_row.suspension_active THEN grant_row.suspended_at END,
    grant_row.revoked_at,
    token.token_id,
    token.issued_at,
    token.expires_at,
    token.first_used_at,
    token.revoked_at
  FROM swarm.agent_principals AS principal
  JOIN LATERAL (
    SELECT candidate.*
    FROM swarm.renewal_grants AS candidate
    WHERE candidate.workspace_id = p_workspace_id
      AND candidate.principal_id = principal.principal_id
    ORDER BY
      (candidate.revoked_at IS NULL) DESC,
      candidate.created_at DESC,
      candidate.renewal_grant_id DESC
    LIMIT 1
  ) AS grant_row ON true
  LEFT JOIN LATERAL (
    SELECT candidate.token_id, candidate.issued_at,
           candidate.expires_at, candidate.first_used_at, candidate.revoked_at
    FROM swarm.agent_tokens AS candidate
    WHERE candidate.renewal_grant_id = grant_row.renewal_grant_id
    ORDER BY candidate.issued_at DESC, candidate.token_id DESC
    LIMIT 1
  ) AS token ON true
  WHERE principal.workspace_id = p_workspace_id
    AND principal.revoked_at IS NULL
  ORDER BY principal.principal_id;
END;
$$;

ALTER FUNCTION swarm_read.renewal_grant_roster(uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm_read.renewal_grant_roster(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION swarm_read.renewal_grant_roster(uuid)
  TO authenticated, swarm_read;

COMMENT ON FUNCTION swarm_read.renewal_grant_roster(uuid) IS
  'One current grant row per live principal for a verified live workspace member. suspended_at reports CURRENT suspension: a resumed grant reads NULL. Includes token ids and timestamps, never token hashes or bearer secrets.';

-- 4. The five replaced functions return to their previous definers.
CREATE OR REPLACE FUNCTION swarm.resume_renewal_grant(
  p_workspace_id uuid,
  p_renewal_grant_id uuid,
  p_user_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = swarm, pg_catalog
AS $$
DECLARE
  grant_row swarm.renewal_grants%ROWTYPE;
  actor_role text;
  principal_owner uuid;
BEGIN
  IF p_workspace_id IS NULL OR p_renewal_grant_id IS NULL OR p_user_id IS NULL THEN
    RETURN 'renewal_resume_forbidden';
  END IF;

  /* The workspace comes from the route, not from the grant, and both must
     agree. Without this a member of workspace A could name a grant id belonging
     to workspace B and be authorised by A's membership. */
  SELECT * INTO grant_row
  FROM swarm.renewal_grants
  WHERE renewal_grant_id = p_renewal_grant_id
    AND workspace_id = p_workspace_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'renewal_grant_not_found';
  END IF;

  /* The closed-workspace gate is repeated here rather than left to the command
     edge's resolveRoute. This function is the whole authorization decision, and
     a second caller wired to it later must not be able to resume an agent in a
     workspace the owner has closed. */
  SELECT m.role INTO actor_role
  FROM swarm.memberships AS m
  JOIN swarm.workspaces AS w
    ON w.workspace_id = m.workspace_id
   AND w.archived_at IS NULL
  WHERE m.workspace_id = p_workspace_id
    AND m.user_id = p_user_id
    AND m.revoked_at IS NULL;
  IF actor_role IS NULL THEN
    RETURN 'renewal_resume_forbidden';
  END IF;

  SELECT p.owner_user_id INTO principal_owner
  FROM swarm.agent_principals AS p
  WHERE p.principal_id = grant_row.principal_id
    AND p.workspace_id = p_workspace_id
    AND p.revoked_at IS NULL;
  IF principal_owner IS NULL THEN
    /* The principal is gone or revoked. Resuming its grant would restore
       renewal for an agent the workspace has already retired. */
    RETURN 'renewal_grant_not_found';
  END IF;

  /* The same gate as revoke_agent_principal: owner/admin manage any agent in
     the workspace, a plain member manages only their own. Whoever may kill this
     grant may also bring it back; nobody else may do either. */
  IF actor_role NOT IN ('owner', 'admin') AND principal_owner <> p_user_id THEN
    RETURN 'renewal_resume_forbidden';
  END IF;

  IF grant_row.revoked_at IS NOT NULL THEN
    RETURN 'renewal_grant_revoked';
  END IF;
  IF NOT grant_row.suspension_active THEN
    RETURN 'renewal_grant_not_suspended';
  END IF;

  UPDATE swarm.renewal_grants
  SET resumed_at = statement_timestamp(),
      resumed_by = p_user_id,
      resume_count = resume_count + 1
  WHERE renewal_grant_id = grant_row.renewal_grant_id;

  RETURN NULL;
END;
$$;

ALTER FUNCTION swarm.resume_renewal_grant(uuid, uuid, uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.resume_renewal_grant(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION swarm.resume_renewal_grant(uuid, uuid, uuid)
  TO swarm_command;

COMMENT ON FUNCTION swarm.resume_renewal_grant(uuid, uuid, uuid) IS
  'One human resume of an idle-suspended grant, gated like revoke_agent_principal. Refuses a revoked grant, a grant in another workspace, a retired principal, and any caller who could not revoke it. Returns NULL on success or a stable refusal code.';

CREATE OR REPLACE FUNCTION swarm.prepare_renewal_grant(
  p_renewal_grant_id uuid,
  p_device_id uuid
)
RETURNS text
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  grant_row swarm.renewal_grants%ROWTYPE;
  idle_since timestamptz;
BEGIN
  SELECT * INTO grant_row
  FROM swarm.renewal_grants
  WHERE renewal_grant_id = p_renewal_grant_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'renewal_grant_not_found';
  END IF;
  IF grant_row.revoked_at IS NOT NULL THEN
    RETURN 'renewal_grant_revoked';
  END IF;
  IF grant_row.suspension_active THEN
    RETURN 'renewal_grant_suspended';
  END IF;

  /* THE IDLE CLOCK RESTARTS AT THE RESUME, and this is the line that makes the
     resume mean anything. A grant is suspended precisely because it has been
     idle for more than 14 days, so at the instant a person resumes it its
     last_used_at is still old. Measured from last_used_at alone, the very next
     renewal attempt would re-suspend it before the agent could record a use —
     the resume would be a no-op that looked like a fix. The baseline is
     therefore the later of "last measured use" and "last human resume". */
  idle_since := COALESCE(grant_row.last_used_at, grant_row.created_at);
  IF grant_row.resumed_at IS NOT NULL AND grant_row.resumed_at > idle_since THEN
    idle_since := grant_row.resumed_at;
  END IF;

  IF grant_row.kind = 'standing'
     AND idle_since < statement_timestamp() - interval '14 days'
  THEN
    UPDATE swarm.renewal_grants
    SET suspended_at = statement_timestamp()
    WHERE renewal_grant_id = grant_row.renewal_grant_id
      AND (suspended_at IS NULL OR suspended_at < statement_timestamp());
    RETURN 'renewal_idle_suspended';
  END IF;

  IF grant_row.kind = 'timeboxed'
     AND grant_row.horizon_expires_at <= statement_timestamp()
  THEN
    RETURN 'renewal_horizon_reached';
  END IF;

  IF grant_row.bound_device_id IS NOT NULL AND p_device_id IS NULL THEN
    RETURN 'renewal_device_unavailable';
  END IF;
  IF grant_row.bound_device_id IS NOT NULL
     AND p_device_id IS DISTINCT FROM grant_row.bound_device_id
  THEN
    UPDATE swarm.renewal_grants
    SET new_host_at = COALESCE(new_host_at, statement_timestamp())
    WHERE renewal_grant_id = grant_row.renewal_grant_id;
    RETURN 'renewal_device_mismatch';
  END IF;
  IF grant_row.last_used_device_id IS NOT NULL
     AND p_device_id IS DISTINCT FROM grant_row.last_used_device_id
  THEN
    UPDATE swarm.renewal_grants
    SET new_host_at = COALESCE(new_host_at, statement_timestamp())
    WHERE renewal_grant_id = grant_row.renewal_grant_id;
  END IF;

  RETURN NULL;
END
$$;

ALTER FUNCTION swarm.prepare_renewal_grant(uuid, uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.prepare_renewal_grant(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION swarm.prepare_renewal_grant(uuid, uuid) TO swarm_command;

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
  'Standing/timeboxed successor fence: validates predecessor lineage and liveness, grant revocation/active suspension/horizon/device binding, scope attenuation, short bearer TTL, and atomically records spend, plus use unless a newer use is already recorded.';

CREATE OR REPLACE FUNCTION swarm.agent_delivery_read_context(
  p_token_hash bytea,
  p_workspace_id uuid
)
RETURNS TABLE (
  token_id uuid,
  principal_id uuid,
  owner_user_id uuid,
  principal_workspace_id uuid,
  run_id uuid,
  device_id uuid,
  first_use boolean,
  membership_revoked_at timestamptz,
  is_revoked boolean,
  pending_delivery_count integer,
  wake_id text,
  managed_at timestamptz
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = swarm, pg_catalog
AS $fn$
DECLARE
  v_token_id uuid;
  v_first_use boolean;
  v_principal_id uuid;
  v_owner_user_id uuid;
  v_principal_workspace_id uuid;
  v_run_id uuid;
  v_device_id uuid;
  v_lineage_id uuid;
  v_token_revoked_at timestamptz;
  v_principal_revoked_at timestamptz;
  v_run_ended_at timestamptz;
  v_device_revoked_at timestamptz;
  v_surrender_only boolean;
  v_unexpired boolean;
  v_membership_revoked_at timestamptz;
  v_revoked boolean := false;
  v_pending integer := 0;
  v_ids uuid[];
  v_wake_id text;
  v_managed_at timestamptz;
  v_parent_admin_grant_id uuid;
  v_worker_scopes jsonb;
  v_parent_workspace_id uuid;
BEGIN
  -- This definer owns agent_tokens and bypasses its RLS policies. Check the
  -- parent directly before first-use stamping, supersession or private reads.
  -- admin_child_live locks the grant so a committed revoke/narrow wins.
  SELECT t.parent_admin_grant_id, t.scopes, p.workspace_id
  INTO v_parent_admin_grant_id, v_worker_scopes, v_parent_workspace_id
  FROM swarm.agent_tokens t JOIN swarm.agent_principals p USING (principal_id)
  WHERE t.token_hash = p_token_hash;
  IF NOT FOUND OR NOT swarm.admin_child_live(v_parent_admin_grant_id, v_parent_workspace_id)
    OR NOT swarm.admin_child_scopes_live(v_parent_admin_grant_id, v_worker_scopes) THEN
    RETURN;
  END IF;

  WITH presented AS (
    SELECT t.token_id, t.predecessor_token_id, t.first_used_at
    FROM swarm.agent_tokens AS t
    JOIN swarm.agent_principals AS p ON p.principal_id = t.principal_id
    JOIN swarm.agent_runs AS r
      ON r.run_id = t.run_id AND r.principal_id = t.principal_id
    JOIN swarm.devices AS d ON d.device_id = r.device_id
    WHERE t.token_hash = p_token_hash
    LIMIT 1
  ),
  stamp AS (
    UPDATE swarm.agent_tokens AS s
    SET first_used_at = statement_timestamp()
    FROM presented AS pre
    WHERE s.token_id = pre.token_id
      AND s.first_used_at IS NULL
      AND s.revoked_at IS NULL
      AND s.expires_at > statement_timestamp()
    RETURNING s.token_id
  ),
  handover AS (
    UPDATE swarm.agent_tokens AS pred
    SET expires_at = statement_timestamp()
    FROM presented AS pre
    JOIN stamp AS st ON st.token_id = pre.token_id
    WHERE pred.token_id = pre.predecessor_token_id
      AND pred.revoked_at IS NULL
      AND pred.expires_at > statement_timestamp()
    RETURNING pred.token_id
  )
  SELECT pre.token_id, pre.first_used_at IS NULL
  INTO v_token_id, v_first_use
  FROM presented AS pre;

  IF v_token_id IS NULL THEN
    RETURN;
  END IF;

  SELECT
    t.token_id,
    t.principal_id,
    p.owner_user_id,
    p.workspace_id,
    t.run_id,
    r.device_id,
    t.lineage_id,
    t.revoked_at,
    p.revoked_at,
    r.ended_at,
    d.revoked_at,
    t.surrender_only,
    t.expires_at > statement_timestamp(),
    p.wake_id,
    p.managed_at
  INTO
    v_token_id,
    v_principal_id,
    v_owner_user_id,
    v_principal_workspace_id,
    v_run_id,
    v_device_id,
    v_lineage_id,
    v_token_revoked_at,
    v_principal_revoked_at,
    v_run_ended_at,
    v_device_revoked_at,
    v_surrender_only,
    v_unexpired,
    v_wake_id,
    v_managed_at
  FROM swarm.agent_tokens AS t
  JOIN swarm.agent_principals AS p ON p.principal_id = t.principal_id
  JOIN swarm.agent_runs AS r
    ON r.run_id = t.run_id AND r.principal_id = t.principal_id
  JOIN swarm.devices AS d ON d.device_id = r.device_id
  WHERE t.token_id = v_token_id;

  IF NOT COALESCE(v_unexpired, false) THEN
    RETURN;
  END IF;

  SELECT m.revoked_at
  INTO v_membership_revoked_at
  FROM swarm.memberships AS m
  WHERE m.workspace_id = v_principal_workspace_id
    AND m.user_id = v_owner_user_id
  LIMIT 1;

  IF NOT FOUND THEN
    v_revoked := true;
  ELSIF NOT swarm.is_member(v_principal_workspace_id, v_owner_user_id)
     OR v_membership_revoked_at IS NOT NULL
     OR v_token_revoked_at IS NOT NULL
     OR v_principal_revoked_at IS NOT NULL
     OR v_run_ended_at IS NOT NULL
     OR v_device_revoked_at IS NOT NULL
     OR v_surrender_only
  THEN
    v_revoked := true;
  ELSE
    v_ids := ARRAY[
      v_token_id,
      v_principal_id,
      v_run_id,
      v_device_id,
      v_owner_user_id,
      v_lineage_id
    ];
    IF EXISTS (
      SELECT 1
      FROM swarm.revocation_tombstones AS rt
      WHERE rt.target_id = ANY (v_ids)
        AND (
          (rt.kind = 'token' AND rt.target_id = v_token_id)
          OR (rt.kind = 'principal' AND rt.target_id = v_principal_id)
          OR (rt.kind = 'run' AND rt.target_id = v_run_id)
          OR (rt.kind = 'device' AND rt.target_id = v_device_id)
          OR (rt.kind = 'membership' AND rt.target_id = v_owner_user_id)
          OR (rt.kind = 'lineage' AND rt.target_id = v_lineage_id)
          OR (rt.kind = 'family' AND rt.target_id = v_lineage_id)
        )
    ) THEN
      v_revoked := true;
    END IF;
  END IF;

  IF NOT v_revoked
     AND p_workspace_id IS NOT NULL
     AND p_workspace_id = v_principal_workspace_id
  THEN
    SELECT count(*)::integer
    INTO v_pending
    FROM swarm.signal_deliveries AS d
    JOIN swarm.signals AS s
      ON s.id = d.signal_id
     AND s.workspace_id = d.workspace_id
    WHERE d.recipient_agent_principal_id = v_principal_id
      AND d.workspace_id = v_principal_workspace_id
      AND d.acked_at IS NULL
      AND s.until > statement_timestamp();
  END IF;

  token_id := v_token_id;
  principal_id := v_principal_id;
  owner_user_id := v_owner_user_id;
  principal_workspace_id := v_principal_workspace_id;
  run_id := v_run_id;
  device_id := v_device_id;
  first_use := v_first_use;
  membership_revoked_at := v_membership_revoked_at;
  is_revoked := v_revoked;
  pending_delivery_count := COALESCE(v_pending, 0);
  wake_id := v_wake_id;
  managed_at := v_managed_at;
  RETURN NEXT;
END;
$fn$;

ALTER FUNCTION swarm.agent_delivery_read_context(bytea, uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.agent_delivery_read_context(bytea, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION swarm.agent_delivery_read_context(bytea, uuid) TO swarm_read;

-- 5. The family binding grant, guard and trigger, then the discovery functions.
REVOKE UPDATE(renewal_grant_id) ON swarm.household_content_connections FROM swarm_command;
DROP TRIGGER aa_household_local_family_binding ON swarm.household_content_connections;
DROP FUNCTION swarm.household_local_family_binding_guard();
DROP FUNCTION swarm.discover_local_join_ids(bytea,uuid);
DROP FUNCTION swarm.discover_local_target_ids(uuid,uuid,uuid[],uuid[],boolean);
DROP FUNCTION swarm.discover_local_target_ids(uuid,uuid,uuid[],uuid[],boolean,uuid);
DROP FUNCTION swarm.discover_local_target_ids(uuid,uuid,uuid[],uuid[],boolean,uuid,boolean);
DROP FUNCTION swarm.discover_local_credential_ids(bytea);

-- 6. The owner Allow pointer column. See the data note at the top.
ALTER TABLE swarm.renewal_grants DROP COLUMN local_content_approval_token_id;
