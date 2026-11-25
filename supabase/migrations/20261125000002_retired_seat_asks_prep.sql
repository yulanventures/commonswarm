-- Retired-seat ask clearing (Phase 1 / prep, R4 design):
--   1. Adds rollout gate 'retired_seat_ask_clear_enabled' = false in swarm.config so Phase 1 can
--      deploy before the new command edge drains old writers; Phase 2 (20261125000003) flips it
--      to true atomically.
--   2. Creates lock-free lifecycle leaf table swarm.agent_ask_lifecycle (Step 17, owner swarm_admin,
--      RLS enabled, zero runtime grants, no FKs, read-only MVCC ref validator), backfills from
--      swarm.agent_workspace_memberships, and seeds new memberships via AFTER INSERT trigger.
--   3. Creates blind cutoff table swarm.agent_ask_clear_events (owner swarm_admin, RLS enabled,
--      zero runtime grants, no FKs, read-only MVCC ref validator).
--   4. Adds metadata-only column swarm.signals.sender_lifecycle_epoch and strict BEFORE INSERT
--      trigger swarm.signals_bind_seat_lifecycle_epoch() (never backfilling NULL with current
--      epoch; rejecting NULL with 42501 SEAT_LIFECYCLE_EPOCH_REQUIRED once enabled or past epoch 1
--      or any clear event; rejecting unexpected or out-of-range epochs with 42501).
--   5. Updates swarm.hosted_connection_policy(uuid, uuid, uuid) so claimed hosted seats join
--      commonswarm_oauth.refresh_family_tombstones identically to pre-claim candidates (rank drops
--      from 0 to 3 when tombstoned).
--   6. Creates owner-only read-only helper swarm.seat_is_disconnected_for_ask_clear(uuid, uuid)
--      (zero grants, zero target row locks) enforcing authoritative provider-family and revocation
--      tombstone state for hosted seats and agent_connection_kind for local seats.
--   7. Creates the four narrow swarm_command-only definers:
--      - swarm.seat_ask_lifecycle_epoch(uuid, uuid)
--      - swarm.advance_seat_lifecycle_epoch(uuid, uuid)
--      - swarm.clear_retired_seat_asks(uuid, uuid, uuid)
--      - swarm.seat_ask_clear_release_allowed(uuid, uuid, uuid, bigint, timestamptz)
--   8. Updates swarm.waiting_ask_autoclear_status (adds seat_cleared branch), swarm.ask_is_withdrawn
--      (adds uniform cutoff check with zero completion exception), swarm.withdraw_ask (evaluates
--      own-withdrawal, deadline, and cutoff strictly before ask_complete_for_withdrawal), and
--      swarm.change_local_agent_membership / swarm.change_hosted_agent_membership (advance epoch
--      on p_add = true). Preserves all existing signatures, owners, and grants; leaves
--      swarm.resume_renewal_grant and swarm_read.home_overview untouched.
SET search_path = swarm, pg_catalog, public;

INSERT INTO swarm.config (key, value)
VALUES ('retired_seat_ask_clear_enabled', 'false'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- 1. Dedicated lifecycle leaf table (Step 17; no FKs -> zero parent row locks).
CREATE TABLE swarm.agent_ask_lifecycle (
  workspace_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  ask_lifecycle_epoch bigint NOT NULL DEFAULT 1 CHECK (ask_lifecycle_epoch >= 1),
  PRIMARY KEY (workspace_id, principal_id)
);

CREATE FUNCTION swarm.agent_ask_lifecycle_validate_refs()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM swarm.workspaces AS w
    WHERE w.workspace_id = NEW.workspace_id
  ) THEN
    RAISE EXCEPTION 'agent_ask_lifecycle workspace % does not exist', NEW.workspace_id
      USING ERRCODE = '23503';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM swarm.agent_workspace_memberships AS am
    JOIN swarm.agent_principals AS ap
      ON ap.principal_id = am.principal_id
     AND ap.owner_user_id = am.owner_user_id
    WHERE am.workspace_id = NEW.workspace_id
      AND am.principal_id = NEW.principal_id
  ) THEN
    RAISE EXCEPTION 'agent_ask_lifecycle seat % does not exist in workspace %',
      NEW.principal_id, NEW.workspace_id
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER agent_ask_lifecycle_validate_refs
  BEFORE INSERT OR UPDATE ON swarm.agent_ask_lifecycle
  FOR EACH ROW EXECUTE FUNCTION swarm.agent_ask_lifecycle_validate_refs();

ALTER TABLE swarm.agent_ask_lifecycle OWNER TO swarm_admin;
ALTER TABLE swarm.agent_ask_lifecycle ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE swarm.agent_ask_lifecycle
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;

ALTER FUNCTION swarm.agent_ask_lifecycle_validate_refs() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.agent_ask_lifecycle_validate_refs()
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;

INSERT INTO swarm.agent_ask_lifecycle (workspace_id, principal_id, ask_lifecycle_epoch)
SELECT am.workspace_id, am.principal_id, 1
FROM swarm.agent_workspace_memberships AS am
JOIN swarm.workspaces AS w
  ON w.workspace_id = am.workspace_id
JOIN swarm.agent_principals AS ap
  ON ap.principal_id = am.principal_id
 AND ap.owner_user_id = am.owner_user_id
ON CONFLICT (workspace_id, principal_id) DO NOTHING;

CREATE FUNCTION swarm.agent_workspace_memberships_seed_ask_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  INSERT INTO swarm.agent_ask_lifecycle (workspace_id, principal_id, ask_lifecycle_epoch)
  VALUES (NEW.workspace_id, NEW.principal_id, 1)
  ON CONFLICT (workspace_id, principal_id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER agent_workspace_memberships_seed_ask_lifecycle
  AFTER INSERT ON swarm.agent_workspace_memberships
  FOR EACH ROW EXECUTE FUNCTION swarm.agent_workspace_memberships_seed_ask_lifecycle();

ALTER FUNCTION swarm.agent_workspace_memberships_seed_ask_lifecycle() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.agent_workspace_memberships_seed_ask_lifecycle()
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;

-- 2. Append-only cutoff table (no FKs -> zero parent row locks).
CREATE TABLE swarm.agent_ask_clear_events (
  workspace_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  cutoff_epoch bigint NOT NULL CHECK (cutoff_epoch >= 1),
  cleared_at timestamptz NOT NULL,
  cleared_by_user_id uuid NOT NULL,
  PRIMARY KEY (workspace_id, principal_id, cutoff_epoch)
);

CREATE FUNCTION swarm.agent_ask_clear_events_validate_refs()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM swarm.workspaces AS w
    WHERE w.workspace_id = NEW.workspace_id
  ) THEN
    RAISE EXCEPTION 'agent_ask_clear_events workspace % does not exist', NEW.workspace_id
      USING ERRCODE = '23503';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM swarm.agent_workspace_memberships AS am
    JOIN swarm.agent_principals AS ap
      ON ap.principal_id = am.principal_id
     AND ap.owner_user_id = am.owner_user_id
    WHERE am.workspace_id = NEW.workspace_id
      AND am.principal_id = NEW.principal_id
  ) THEN
    RAISE EXCEPTION 'agent_ask_clear_events seat % does not exist in workspace %',
      NEW.principal_id, NEW.workspace_id
      USING ERRCODE = '23503';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM swarm.users AS u
    WHERE u.user_id = NEW.cleared_by_user_id
  ) THEN
    RAISE EXCEPTION 'agent_ask_clear_events actor % does not exist', NEW.cleared_by_user_id
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER agent_ask_clear_events_validate_refs
  BEFORE INSERT OR UPDATE ON swarm.agent_ask_clear_events
  FOR EACH ROW EXECUTE FUNCTION swarm.agent_ask_clear_events_validate_refs();

ALTER TABLE swarm.agent_ask_clear_events OWNER TO swarm_admin;
ALTER TABLE swarm.agent_ask_clear_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE swarm.agent_ask_clear_events
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;

ALTER FUNCTION swarm.agent_ask_clear_events_validate_refs() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.agent_ask_clear_events_validate_refs()
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;

-- 3. Ask epoch binding on swarm.signals (metadata-only DDL + strict BEFORE INSERT trigger).
ALTER TABLE swarm.signals
  ADD COLUMN IF NOT EXISTS sender_lifecycle_epoch bigint
  CHECK (sender_lifecycle_epoch IS NULL OR sender_lifecycle_epoch >= 1);

CREATE OR REPLACE FUNCTION swarm.signals_bind_seat_lifecycle_epoch()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_current_epoch bigint;
  v_clearing_enabled boolean;
BEGIN
  -- Human signals and non-ask agent signals (notes, working-on, review-check notes,
  -- reraise notes) never carry a seat lifecycle epoch.
  IF NEW.from_kind <> 'agent' OR NEW.kind <> 'ask' THEN
    IF NEW.sender_lifecycle_epoch IS NOT NULL THEN
      RAISE EXCEPTION 'SEAT_LIFECYCLE_EPOCH_UNEXPECTED' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  SELECT COALESCE(
    (SELECT al.ask_lifecycle_epoch
       FROM swarm.agent_ask_lifecycle AS al
      WHERE al.workspace_id = NEW.workspace_id
        AND al.principal_id = NEW.from_principal),
    1
  ) INTO v_current_epoch;

  IF NEW.sender_lifecycle_epoch IS NULL THEN
    SELECT COALESCE(
      (SELECT c.value = 'true'::jsonb
         FROM swarm.config AS c
        WHERE c.key = 'retired_seat_ask_clear_enabled'),
      false
    ) INTO v_clearing_enabled;

    -- Fail closed once clearing can run (or if this seat already moved past epoch 1 or
    -- has any clear event): NEVER synthesize or backfill v_current_epoch.
    IF v_clearing_enabled
       OR v_current_epoch > 1
       OR EXISTS (
         SELECT 1
         FROM swarm.agent_ask_clear_events AS ce
         WHERE ce.workspace_id = NEW.workspace_id
           AND ce.principal_id = NEW.from_principal
       ) THEN
      RAISE EXCEPTION 'SEAT_LIFECYCLE_EPOCH_REQUIRED' USING ERRCODE = '42501';
    END IF;

    -- Pre-enablement rollout window only (clearing disabled, epoch = 1, zero clears):
    -- preserve NULL as NULL (evaluated as 1 by COALESCE(..., 1)); NEVER fill v_current_epoch.
    RETURN NEW;
  END IF;

  -- Reject non-positive or forged future epochs; accept any explicitly captured epoch
  -- 1 <= NEW.sender_lifecycle_epoch <= v_current_epoch so delayed explicit-E asks land
  -- under cutoff_epoch = E.
  IF NEW.sender_lifecycle_epoch < 1 OR NEW.sender_lifecycle_epoch > v_current_epoch THEN
    RAISE EXCEPTION 'SEAT_LIFECYCLE_EPOCH_INVALID' USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER signals_bind_seat_lifecycle_epoch
  BEFORE INSERT ON swarm.signals
  FOR EACH ROW EXECUTE FUNCTION swarm.signals_bind_seat_lifecycle_epoch();

ALTER FUNCTION swarm.signals_bind_seat_lifecycle_epoch() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.signals_bind_seat_lifecycle_epoch()
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;

-- 4. Update swarm.hosted_connection_policy so claimed hosted seats join refresh_family_tombstones
--    identically to pre-claim candidates (rank drops from 0 to 3 when tombstoned).
--    Latest prior definition: 20261111000004_hosted_pre_claim_connection.sql.
CREATE OR REPLACE FUNCTION swarm.hosted_connection_policy(p_workspace uuid, p_principal uuid, p_owner uuid)
RETURNS TABLE(grant_id uuid, state text, revoked_at timestamptz, connection_expires_at timestamptz,
  connection_expired_at timestamptz, seat_revoked_at timestamptz, binding_revoked_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
 SELECT c.grant_id, c.state, c.revoked_at, c.connection_expires_at, c.connection_expired_at,
  c.seat_revoked_at, c.binding_revoked_at
 FROM (
  SELECT g.grant_id, g.state, coalesce(g.revoked_at, family.revoked_at) AS revoked_at,
   g.connection_expires_at, g.connection_expired_at,
   seat.revoked_at AS seat_revoked_at,
   CASE WHEN swarm.hosted_binding_eligible(g.grant_id, seat.workspace_id, seat.principal_id)
    THEN NULL::timestamptz ELSE clock_timestamp() END AS binding_revoked_at,
   CASE WHEN seat.revoked_at IS NULL AND family.revoked_at IS NULL THEN 0 ELSE 3 END AS rank,
   seat.created_at AS at, seat.seat_id AS tie
  FROM swarm.hosted_mcp_seats seat
  JOIN swarm.hosted_mcp_grants g ON g.grant_id = seat.grant_id AND g.owner_user_id = seat.owner_user_id
  LEFT JOIN commonswarm_oauth.refresh_family_tombstones family ON family.grant_id = g.provider_grant_id
  WHERE seat.workspace_id = p_workspace AND seat.principal_id = p_principal AND seat.owner_user_id = p_owner
  UNION ALL
  -- A retired refresh family (reconnect, then revoke) ends the grant here even while the grant row
  -- itself stays active.
  SELECT g.grant_id, g.state, coalesce(g.revoked_at, family.revoked_at), g.connection_expires_at, g.connection_expired_at,
   NULL::timestamptz, NULL::timestamptz,
   CASE WHEN g.state = 'active' AND g.revoked_at IS NULL AND family.revoked_at IS NULL THEN 1 ELSE 2 END, g.created_at, g.grant_id
  FROM swarm.hosted_mcp_grant_agents ga
  JOIN swarm.hosted_mcp_grants g ON g.grant_id = ga.grant_id AND g.owner_user_id = ga.owner_user_id
  LEFT JOIN commonswarm_oauth.refresh_family_tombstones family ON family.grant_id = g.provider_grant_id
  WHERE ga.principal_id = p_principal AND ga.owner_user_id = p_owner AND ga.revoked_at IS NULL
   AND swarm.hosted_binding_eligible(g.grant_id, p_workspace, p_principal)
   -- An ended seat here is final until a person adds the agent again: this grant's own ended seat, or any
   -- deliberately ended one (seat_release or removal, which tombstone it). Only a live add receipt newer than
   -- that seat's end restores the pre-claim reading. A different grant's seat closed without a tombstone
   -- (reconnect moving the agent to this grant) does not block it.
   AND NOT EXISTS (
    SELECT 1 FROM swarm.hosted_mcp_seats prior
    WHERE prior.workspace_id = p_workspace AND prior.principal_id = p_principal AND prior.owner_user_id = p_owner
     AND prior.revoked_at IS NOT NULL
     AND (prior.grant_id = g.grant_id OR EXISTS (
      SELECT 1 FROM swarm.revocation_tombstones ended WHERE ended.kind = 'hosted_seat' AND ended.target_id = prior.seat_id))
     AND NOT EXISTS (
      SELECT 1 FROM swarm.hosted_mcp_agent_workspace_adds again
      WHERE again.grant_id = g.grant_id AND again.workspace_id = p_workspace AND again.principal_id = p_principal
       AND again.owner_user_id = p_owner AND again.revoked_at IS NULL AND again.added_at > prior.revoked_at))
 ) c
 ORDER BY c.rank, c.at DESC, c.tie
 LIMIT 1
$$;

ALTER FUNCTION swarm.hosted_connection_policy(uuid, uuid, uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.hosted_connection_policy(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT EXECUTE ON FUNCTION swarm.hosted_connection_policy(uuid, uuid, uuid) TO swarm_command;

-- 5. Owner-only read-only helper checking whether a seat is disconnected or removed for ask clearing.
--    Pure read-only MVCC; zero target row locks; zero runtime grants.
CREATE FUNCTION swarm.seat_is_disconnected_for_ask_clear(
  p_workspace_id uuid,
  p_principal_id uuid
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT COALESCE((
    SELECT
      ap.revoked_at IS NOT NULL
      OR am.revoked_at IS NOT NULL
      OR om.user_id IS NULL
      OR om.revoked_at IS NOT NULL
      OR EXISTS (
        SELECT 1
        FROM swarm.revocation_tombstones AS rt
        WHERE (rt.kind = 'principal' AND rt.target_id = ap.principal_id)
           OR (rt.kind = 'membership' AND rt.target_id = ap.owner_user_id)
      )
      OR CASE
        WHEN ap.transport = 'hosted_mcp' THEN NOT (
          hp.grant_id IS NOT NULL
          AND hp.seat_revoked_at IS NULL
          AND hp.binding_revoked_at IS NULL
          AND hp.revoked_at IS NULL
          AND hp.state = 'active'
          AND hp.connection_expired_at IS NULL
          AND (hp.connection_expires_at IS NULL OR hp.connection_expires_at > clock_timestamp())
          -- Authoritative provider-family and tombstone checks for the selected hosted seat
          -- (claimed or pre-claim), matching swarm.resolve_hosted_seat_command_authorization
          -- (20261028000003:176-186) and commonswarm_oauth.resolve_hosted_grant_status
          -- (20261028000003:250-280). Pure read-only MVCC; zero target row locks.
          AND hg.grant_id IS NOT NULL
          AND commonswarm_oauth.provider_family_active(hg.provider_grant_id)
          AND NOT EXISTS (
            SELECT 1
            FROM commonswarm_oauth.refresh_family_tombstones AS rf
            WHERE rf.grant_id = hg.provider_grant_id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM swarm.revocation_tombstones AS rt
            WHERE (rt.kind = 'hosted_grant' AND rt.target_id = hg.grant_id)
               OR (
                 rt.kind = 'hosted_seat'
                 AND EXISTS (
                   SELECT 1
                   FROM swarm.hosted_mcp_seats AS hs
                   WHERE hs.workspace_id = am.workspace_id
                     AND hs.principal_id = ap.principal_id
                     AND hs.owner_user_id = ap.owner_user_id
                     AND hs.grant_id = hg.grant_id
                     AND hs.revoked_at IS NULL
                     AND hs.seat_id = rt.target_id
                 )
               )
          )
        )
        ELSE swarm_read.agent_connection_kind(p_workspace_id, p_principal_id) <> 'live'
      END
    FROM swarm.agent_workspace_memberships AS am
    JOIN swarm.agent_principals AS ap
      ON ap.principal_id = am.principal_id
     AND ap.owner_user_id = am.owner_user_id
    LEFT JOIN swarm.memberships AS om
      ON om.workspace_id = am.workspace_id
     AND om.user_id = ap.owner_user_id
    LEFT JOIN LATERAL swarm.hosted_connection_policy(
      am.workspace_id, ap.principal_id, ap.owner_user_id
    ) AS hp ON ap.transport = 'hosted_mcp'
    LEFT JOIN swarm.hosted_mcp_grants AS hg
      ON ap.transport = 'hosted_mcp'
     AND hg.grant_id = hp.grant_id
     AND hg.owner_user_id = ap.owner_user_id
    WHERE am.workspace_id = p_workspace_id
      AND am.principal_id = p_principal_id
  ), false)
$$;

ALTER FUNCTION swarm.seat_is_disconnected_for_ask_clear(uuid, uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.seat_is_disconnected_for_ask_clear(uuid, uuid)
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;

-- 6. The four swarm_command-only definers.

-- 6a. Read-only seat ask lifecycle epoch lookup (zero locks).
CREATE FUNCTION swarm.seat_ask_lifecycle_epoch(
  p_workspace_id uuid,
  p_principal_id uuid
)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT CASE
    WHEN p_workspace_id IS NULL OR p_principal_id IS NULL THEN NULL::bigint
    ELSE COALESCE(
      (
        SELECT al.ask_lifecycle_epoch
        FROM swarm.agent_ask_lifecycle AS al
        WHERE al.workspace_id = p_workspace_id
          AND al.principal_id = p_principal_id
      ),
      1::bigint
    )
  END;
$$;

ALTER FUNCTION swarm.seat_ask_lifecycle_epoch(uuid, uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.seat_ask_lifecycle_epoch(uuid, uuid)
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT EXECUTE ON FUNCTION swarm.seat_ask_lifecycle_epoch(uuid, uuid) TO swarm_command;

-- 6b. Advance seat ask lifecycle epoch at Step 17 (sorted workspace_id ASC, principal_id ASC).
--     Returns 1 as a no-op while retired_seat_ask_clear_enabled is false.
CREATE FUNCTION swarm.advance_seat_lifecycle_epoch(
  p_principal_id uuid,
  p_workspace_id uuid DEFAULT NULL
)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_clearing_enabled boolean;
  v_epoch bigint;
  v_max_epoch bigint;
  v_row record;
BEGIN
  IF p_principal_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(
    (SELECT c.value = 'true'::jsonb
       FROM swarm.config AS c
      WHERE c.key = 'retired_seat_ask_clear_enabled'),
    false
  ) INTO v_clearing_enabled;

  IF NOT v_clearing_enabled THEN
    RETURN 1;
  END IF;

  IF p_workspace_id IS NOT NULL THEN
    INSERT INTO swarm.agent_ask_lifecycle (workspace_id, principal_id, ask_lifecycle_epoch)
    SELECT am.workspace_id, am.principal_id, 1
    FROM swarm.agent_workspace_memberships AS am
    WHERE am.workspace_id = p_workspace_id
      AND am.principal_id = p_principal_id
    ON CONFLICT (workspace_id, principal_id) DO NOTHING;

    SELECT al.ask_lifecycle_epoch
    INTO v_epoch
    FROM swarm.agent_ask_lifecycle AS al
    WHERE al.workspace_id = p_workspace_id
      AND al.principal_id = p_principal_id
    ORDER BY al.workspace_id ASC, al.principal_id ASC
    FOR NO KEY UPDATE;

    IF FOUND THEN
      UPDATE swarm.agent_ask_lifecycle
      SET ask_lifecycle_epoch = ask_lifecycle_epoch + 1
      WHERE workspace_id = p_workspace_id
        AND principal_id = p_principal_id
      RETURNING ask_lifecycle_epoch INTO v_epoch;
      RETURN v_epoch;
    END IF;

    RETURN 1;
  END IF;

  -- Multi-workspace reconnect: seed and lock Step 17 leaf rows across all live memberships
  -- in strict canonical (workspace_id ASC, principal_id ASC) order, locking ONLY al (never am).
  INSERT INTO swarm.agent_ask_lifecycle (workspace_id, principal_id, ask_lifecycle_epoch)
  SELECT am.workspace_id, am.principal_id, 1
  FROM swarm.agent_workspace_memberships AS am
  WHERE am.principal_id = p_principal_id
    AND am.revoked_at IS NULL
  ORDER BY am.workspace_id ASC, am.principal_id ASC
  ON CONFLICT (workspace_id, principal_id) DO NOTHING;

  FOR v_row IN
    SELECT al.workspace_id, al.principal_id
    FROM swarm.agent_ask_lifecycle AS al
    JOIN swarm.agent_workspace_memberships AS am
      ON am.workspace_id = al.workspace_id
     AND am.principal_id = al.principal_id
    WHERE al.principal_id = p_principal_id
      AND am.revoked_at IS NULL
    ORDER BY al.workspace_id ASC, al.principal_id ASC
    FOR NO KEY UPDATE OF al
  LOOP
    UPDATE swarm.agent_ask_lifecycle
    SET ask_lifecycle_epoch = ask_lifecycle_epoch + 1
    WHERE workspace_id = v_row.workspace_id
      AND principal_id = v_row.principal_id
    RETURNING ask_lifecycle_epoch INTO v_epoch;
    v_max_epoch := GREATEST(COALESCE(v_max_epoch, v_epoch), v_epoch);
  END LOOP;

  RETURN COALESCE(v_max_epoch, 1);
END;
$$;

ALTER FUNCTION swarm.advance_seat_lifecycle_epoch(uuid, uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.advance_seat_lifecycle_epoch(uuid, uuid)
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT EXECUTE ON FUNCTION swarm.advance_seat_lifecycle_epoch(uuid, uuid) TO swarm_command;

-- 6c. Blind O(1) retired-seat ask cutoff definer (canonical lock order: Step 3 -> Step 5 -> Step 17).
CREATE FUNCTION swarm.clear_retired_seat_asks(
  p_workspace_id uuid,
  p_actor_user_id uuid,
  p_principal_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_clearing_enabled boolean;
  v_workspace_archived_at timestamptz;
  v_peek_role text;
  v_owner_user_id uuid;
  v_actor_role text;
  v_actor_revoked_at timestamptz;
  v_cutoff_epoch bigint;
  v_cleared_at timestamptz;
BEGIN
  IF p_workspace_id IS NULL OR p_actor_user_id IS NULL OR p_principal_id IS NULL THEN
    RETURN jsonb_build_object('status', 'invalid_request');
  END IF;

  SELECT COALESCE(
    (SELECT c.value = 'true'::jsonb
       FROM swarm.config AS c
      WHERE c.key = 'retired_seat_ask_clear_enabled'),
    false
  ) INTO v_clearing_enabled;

  IF NOT v_clearing_enabled THEN
    RETURN jsonb_build_object('status', 'clearing_not_enabled');
  END IF;

  -- Step 3: Defensive canonical FOR SHARE lock on swarm.workspaces.
  SELECT w.archived_at
  INTO v_workspace_archived_at
  FROM swarm.workspaces AS w
  WHERE w.workspace_id = p_workspace_id
  FOR SHARE;

  IF NOT FOUND OR v_workspace_archived_at IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'forbidden');
  END IF;

  -- Non-locking MVCC peek to determine whether actor may lock target owner's membership row.
  -- Unauthorized probes lock ONLY the actor's own row, never a foreign seat or owner.
  SELECT m.role
  INTO v_peek_role
  FROM swarm.memberships AS m
  WHERE m.workspace_id = p_workspace_id
    AND m.user_id = p_actor_user_id
    AND m.revoked_at IS NULL;

  IF NOT FOUND THEN
    PERFORM 1
    FROM swarm.memberships AS m
    WHERE m.workspace_id = p_workspace_id
      AND m.user_id = p_actor_user_id
    FOR SHARE;
    RETURN jsonb_build_object('status', 'forbidden');
  END IF;

  SELECT ap.owner_user_id
  INTO v_owner_user_id
  FROM swarm.agent_workspace_memberships AS am
  JOIN swarm.agent_principals AS ap
    ON ap.principal_id = am.principal_id
   AND ap.owner_user_id = am.owner_user_id
  WHERE am.workspace_id = p_workspace_id
    AND am.principal_id = p_principal_id
    AND NOT EXISTS (
      SELECT 1
      FROM swarm.agent_join_credentials AS jc
      WHERE jc.registrar_principal_id = ap.principal_id
    );

  IF v_owner_user_id IS NULL
     OR (v_owner_user_id <> p_actor_user_id AND v_peek_role NOT IN ('owner', 'admin')) THEN
    -- Step 5 (actor-only): lock only the actor's membership row.
    SELECT m.role, m.revoked_at
    INTO v_actor_role, v_actor_revoked_at
    FROM swarm.memberships AS m
    WHERE m.workspace_id = p_workspace_id
      AND m.user_id = p_actor_user_id
    FOR SHARE;

    IF NOT FOUND OR v_actor_revoked_at IS NOT NULL THEN
      RETURN jsonb_build_object('status', 'forbidden');
    END IF;

    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  -- Step 5: Lock actor (and target owner if distinct) membership rows in canonical user_id ASC order.
  PERFORM count(*)
  FROM (
    SELECT m.user_id
    FROM swarm.memberships AS m
    WHERE m.workspace_id = p_workspace_id
      AND m.user_id = ANY(
        CASE
          WHEN v_owner_user_id = p_actor_user_id THEN ARRAY[p_actor_user_id]
          ELSE ARRAY[p_actor_user_id, v_owner_user_id]
        END
      )
    ORDER BY m.user_id ASC
    FOR SHARE
  ) AS locked_memberships;

  -- Re-verify live workspace membership and role under held Step 3/5 locks.
  SELECT m.role, m.revoked_at
  INTO v_actor_role, v_actor_revoked_at
  FROM swarm.memberships AS m
  WHERE m.workspace_id = p_workspace_id
    AND m.user_id = p_actor_user_id;

  IF NOT FOUND OR v_actor_revoked_at IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'forbidden');
  END IF;

  -- Re-verify target membership and non-registrar identity (read-only MVCC; zero target locks).
  SELECT ap.owner_user_id
  INTO v_owner_user_id
  FROM swarm.agent_workspace_memberships AS am
  JOIN swarm.agent_principals AS ap
    ON ap.principal_id = am.principal_id
   AND ap.owner_user_id = am.owner_user_id
  WHERE am.workspace_id = p_workspace_id
    AND am.principal_id = p_principal_id
    AND NOT EXISTS (
      SELECT 1
      FROM swarm.agent_join_credentials AS jc
      WHERE jc.registrar_principal_id = ap.principal_id
    );

  IF v_owner_user_id IS NULL
     OR (v_owner_user_id <> p_actor_user_id AND v_actor_role NOT IN ('owner', 'admin')) THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  -- Step 17: Ensure lifecycle leaf row exists and lock it FOR NO KEY UPDATE.
  INSERT INTO swarm.agent_ask_lifecycle (workspace_id, principal_id, ask_lifecycle_epoch)
  VALUES (p_workspace_id, p_principal_id, 1)
  ON CONFLICT (workspace_id, principal_id) DO NOTHING;

  SELECT al.ask_lifecycle_epoch
  INTO v_cutoff_epoch
  FROM swarm.agent_ask_lifecycle AS al
  WHERE al.workspace_id = p_workspace_id
    AND al.principal_id = p_principal_id
  ORDER BY al.workspace_id ASC, al.principal_id ASC
  FOR NO KEY UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  -- Re-check disconnected state under held Step 3/5/17 locks (zero target row locks).
  IF NOT swarm.seat_is_disconnected_for_ask_clear(p_workspace_id, p_principal_id) THEN
    RETURN jsonb_build_object('status', 'seat_still_live');
  END IF;

  v_cleared_at := clock_timestamp();

  INSERT INTO swarm.agent_ask_clear_events (
    workspace_id, principal_id, cutoff_epoch, cleared_at, cleared_by_user_id
  ) VALUES (
    p_workspace_id, p_principal_id, v_cutoff_epoch, v_cleared_at, p_actor_user_id
  );

  UPDATE swarm.agent_ask_lifecycle
  SET ask_lifecycle_epoch = ask_lifecycle_epoch + 1
  WHERE workspace_id = p_workspace_id
    AND principal_id = p_principal_id;

  RETURN jsonb_build_object(
    'status', 'ok',
    'principal_id', p_principal_id,
    'cutoff_epoch', v_cutoff_epoch,
    'cleared_at', v_cleared_at
  );
END;
$$;

ALTER FUNCTION swarm.clear_retired_seat_asks(uuid, uuid, uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.clear_retired_seat_asks(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT EXECUTE ON FUNCTION swarm.clear_retired_seat_asks(uuid, uuid, uuid) TO swarm_command;

-- 6d. Read-only zero-lock replay reauthorization predicate for clear_retired_seat_asks.
--     Deliberately omits seat_is_disconnected_for_ask_clear so retries after reconnect succeed
--     without touching agent_ask_lifecycle or waiting on held private posts.
CREATE FUNCTION swarm.seat_ask_clear_release_allowed(
  p_workspace_id uuid,
  p_actor_user_id uuid,
  p_principal_id uuid,
  p_cutoff_epoch bigint,
  p_cleared_at timestamptz
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT
    p_workspace_id IS NOT NULL
    AND p_actor_user_id IS NOT NULL
    AND p_principal_id IS NOT NULL
    AND p_cutoff_epoch IS NOT NULL
    AND p_cutoff_epoch >= 1
    AND p_cleared_at IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM swarm.workspaces AS w
      JOIN swarm.memberships AS m
        ON m.workspace_id = w.workspace_id
       AND m.user_id = p_actor_user_id
      JOIN swarm.agent_workspace_memberships AS am
        ON am.workspace_id = w.workspace_id
       AND am.principal_id = p_principal_id
      JOIN swarm.agent_principals AS ap
        ON ap.principal_id = am.principal_id
       AND ap.owner_user_id = am.owner_user_id
      JOIN swarm.agent_ask_clear_events AS ce
        ON ce.workspace_id = w.workspace_id
       AND ce.principal_id = p_principal_id
       AND ce.cutoff_epoch = p_cutoff_epoch
       AND ce.cleared_at = p_cleared_at
       AND ce.cleared_by_user_id = p_actor_user_id
      WHERE w.workspace_id = p_workspace_id
        AND w.archived_at IS NULL
        AND m.revoked_at IS NULL
        AND (m.role IN ('owner', 'admin') OR ap.owner_user_id = p_actor_user_id)
        AND NOT EXISTS (
          SELECT 1
          FROM swarm.agent_join_credentials AS jc
          WHERE jc.registrar_principal_id = ap.principal_id
        )
    );
$$;

ALTER FUNCTION swarm.seat_ask_clear_release_allowed(uuid, uuid, uuid, bigint, timestamptz) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.seat_ask_clear_release_allowed(uuid, uuid, uuid, bigint, timestamptz)
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT EXECUTE ON FUNCTION swarm.seat_ask_clear_release_allowed(uuid, uuid, uuid, bigint, timestamptz) TO swarm_command;

-- 7. Update existing functions (preserving exact signatures, owners, and grants).

-- 7a. swarm.waiting_ask_autoclear_status: add seat_cleared branch (explicit_rank = 1, prio = 0).
--     Latest prior definition: 20261125000001_ask_withdrawals.sql.
CREATE OR REPLACE FUNCTION swarm.waiting_ask_autoclear_status(
  p_workspace_id uuid,
  p_signal_id uuid,
  p_read_at timestamptz
)
RETURNS TABLE (
  outcome_kind text,
  outcome_text text,
  archived_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT cand.outcome_kind, cand.outcome_text, cand.archived_at
  FROM swarm.signals AS s
  LEFT JOIN swarm.ask_withdrawals AS aw
    ON aw.workspace_id = s.workspace_id
    AND aw.signal_id = s.id
  LEFT JOIN swarm.agent_principals AS ap
    ON s.from_kind = 'agent'
    AND ap.principal_id = s.from_principal
  LEFT JOIN swarm.agent_workspace_memberships AS am
    ON s.from_kind = 'agent'
    AND am.principal_id = ap.principal_id
    AND am.workspace_id = s.workspace_id
    AND am.owner_user_id = ap.owner_user_id
  LEFT JOIN swarm.memberships AS om
    ON s.from_kind = 'agent'
    AND om.workspace_id = s.workspace_id
    AND om.user_id = ap.owner_user_id
  LEFT JOIN swarm.memberships AS sm
    ON s.from_kind = 'user'
    AND sm.workspace_id = s.workspace_id
    AND sm.user_id = s.from_principal
  LEFT JOIN swarm.conversation_signals AS cs
    ON cs.workspace_id = s.workspace_id
    AND cs.signal_id = s.id
  LEFT JOIN swarm.conversations AS c
    ON c.workspace_id = s.workspace_id
    AND c.conversation_id = cs.conversation_id
  LEFT JOIN swarm.channels AS ch
    ON ch.workspace_id = s.workspace_id
    AND ch.channel_id = coalesce(c.channel_id, s.channel_id)
  CROSS JOIN LATERAL (
    -- Explicit sender act (withdrawn or replaced) always takes precedence over passive reasons.
    SELECT
      0 AS explicit_rank,
      0 AS prio,
      CASE
        WHEN aw.replaced_by_signal_id IS NOT NULL THEN 'replaced'::text
        ELSE 'withdrawn'::text
      END AS outcome_kind,
      CASE
        WHEN aw.replaced_by_signal_id IS NOT NULL THEN 'Replaced by a newer question'::text
        ELSE 'Withdrawn'::text
      END AS outcome_text,
      greatest(s.created_at, aw.withdrawn_at) AS archived_at
    WHERE aw.signal_id IS NOT NULL
    UNION ALL
    -- Blind seat-level clear cutoff for retired/disconnected agent seats; pins archived_at to
    -- the first matching cutoff_epoch so repeated clears never shift keyset cursors.
    SELECT
      1 AS explicit_rank,
      0 AS prio,
      'seat_cleared'::text AS outcome_kind,
      'Cleared (seat inactive)'::text AS outcome_text,
      greatest(s.created_at, first_clear.cleared_at) AS archived_at
    FROM (
      SELECT ce.cleared_at
      FROM swarm.agent_ask_clear_events AS ce
      WHERE s.from_kind = 'agent'
        AND ce.workspace_id = s.workspace_id
        AND ce.principal_id = s.from_principal
        AND ce.cutoff_epoch >= COALESCE(s.sender_lifecycle_epoch, 1)
      ORDER BY ce.cutoff_epoch ASC
      LIMIT 1
    ) AS first_clear
    UNION ALL
    SELECT
      1 AS explicit_rank,
      1 AS prio,
      'agent_removed'::text AS outcome_kind,
      'Agent removed'::text AS outcome_text,
      greatest(
        s.created_at,
        coalesce(least(ap.revoked_at, am.revoked_at, om.revoked_at), s.created_at)
      ) AS archived_at
    WHERE s.from_kind = 'agent'
      AND (
        ap.principal_id IS NULL
        OR ap.revoked_at IS NOT NULL
        OR am.principal_id IS NULL
        OR am.revoked_at IS NOT NULL
        OR om.user_id IS NULL
        OR om.revoked_at IS NOT NULL
      )
    UNION ALL
    SELECT
      1 AS explicit_rank,
      2 AS prio,
      'sender_left'::text AS outcome_kind,
      'Sender left'::text AS outcome_text,
      greatest(
        s.created_at,
        coalesce(sm.revoked_at, s.created_at)
      ) AS archived_at
    WHERE s.from_kind = 'user'
      AND (
        sm.user_id IS NULL
        OR sm.revoked_at IS NOT NULL
      )
    UNION ALL
    SELECT
      1 AS explicit_rank,
      3 AS prio,
      'channel_archived'::text AS outcome_kind,
      'Channel archived'::text AS outcome_text,
      greatest(
        s.created_at,
        least(ch.archived_at, c.archived_at)
      ) AS archived_at
    WHERE least(ch.archived_at, c.archived_at) IS NOT NULL
    UNION ALL
    SELECT
      1 AS explicit_rank,
      4 AS prio,
      'expired'::text AS outcome_kind,
      'Expired'::text AS outcome_text,
      s.until AS archived_at
    WHERE s.until <= p_read_at
  ) AS cand
  WHERE p_workspace_id IS NOT NULL
    AND p_signal_id IS NOT NULL
    AND p_read_at IS NOT NULL
    AND s.workspace_id = p_workspace_id
    AND s.id = p_signal_id
    AND s.kind = 'ask'
  ORDER BY cand.explicit_rank ASC, cand.archived_at ASC, cand.prio ASC
  LIMIT 1;
$$;

ALTER FUNCTION swarm.waiting_ask_autoclear_status(uuid, uuid, timestamptz) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.waiting_ask_autoclear_status(uuid, uuid, timestamptz)
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;

-- 7b. swarm.ask_is_withdrawn: add uniform cutoff check with zero completion exception.
--     Latest prior definition: 20261125000001_ask_withdrawals.sql.
CREATE OR REPLACE FUNCTION swarm.ask_is_withdrawn(
  p_workspace_id uuid,
  p_signal_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT
    p_workspace_id IS NOT NULL
    AND p_signal_id IS NOT NULL
    AND (
      EXISTS (
        SELECT 1
        FROM swarm.ask_withdrawals AS aw
        WHERE aw.workspace_id = p_workspace_id
          AND aw.signal_id = p_signal_id
      )
      OR EXISTS (
        SELECT 1
        FROM swarm.signals AS s
        JOIN swarm.agent_ask_clear_events AS ce
          ON ce.workspace_id = s.workspace_id
         AND ce.principal_id = s.from_principal
        WHERE s.workspace_id = p_workspace_id
          AND s.id = p_signal_id
          AND s.kind = 'ask'
          AND s.from_kind = 'agent'
          AND ce.cutoff_epoch >= COALESCE(s.sender_lifecycle_epoch, 1)
      )
    );
$$;

ALTER FUNCTION swarm.ask_is_withdrawn(uuid, uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.ask_is_withdrawn(uuid, uuid)
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT EXECUTE ON FUNCTION swarm.ask_is_withdrawn(uuid, uuid) TO swarm_command;

-- 7c. swarm.withdraw_ask: evaluate own-withdrawal and deadline/cutoff/autoclear strictly before
--     swarm.ask_complete_for_withdrawal (both pre-INSERT and split post-INSERT READ COMMITTED).
--     Latest prior definition: 20261125000001_ask_withdrawals.sql.
CREATE OR REPLACE FUNCTION swarm.withdraw_ask(
  p_workspace_id uuid,
  p_actor_kind text,
  p_actor_id uuid,
  p_signal_id uuid,
  p_replaced_by_signal_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_now timestamptz := statement_timestamp();
  v_actor_live boolean;
  v_ask record;
  v_existing record;
  v_withdrawn_at timestamptz;
  v_created boolean := false;
BEGIN
  IF p_workspace_id IS NULL OR p_actor_id IS NULL OR p_signal_id IS NULL
     OR p_actor_kind IS NULL OR p_actor_kind NOT IN ('user', 'agent') THEN
    RETURN jsonb_build_object('status', 'invalid_request');
  END IF;

  IF p_replaced_by_signal_id IS NOT NULL AND p_replaced_by_signal_id = p_signal_id THEN
    RETURN jsonb_build_object('status', 'invalid_request');
  END IF;

  -- Serialize with concurrent replies (plain or choice), re-raise, and concurrent withdraw/replace on the same ask.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('answer_choice:' || p_workspace_id::text || ':' || p_signal_id::text, 0)
  );
  PERFORM pg_advisory_xact_lock(
    hashtextextended('withdraw_ask:' || p_workspace_id::text || ':' || p_signal_id::text, 0)
  );

  IF p_actor_kind = 'user' THEN
    v_actor_live := swarm.is_member(p_workspace_id, p_actor_id);
  ELSE
    SELECT EXISTS (
      SELECT 1
      FROM swarm.agent_principals AS ap
      JOIN swarm.agent_workspace_memberships AS am
        ON am.principal_id = ap.principal_id
        AND am.owner_user_id = ap.owner_user_id
        AND am.workspace_id = p_workspace_id
      JOIN swarm.memberships AS om
        ON om.workspace_id = p_workspace_id
        AND om.user_id = ap.owner_user_id
      WHERE ap.principal_id = p_actor_id
        AND ap.revoked_at IS NULL
        AND am.revoked_at IS NULL
        AND om.revoked_at IS NULL
    ) INTO v_actor_live;
  END IF;

  IF NOT coalesce(v_actor_live, false) THEN
    RETURN jsonb_build_object('status', 'forbidden');
  END IF;

  -- Exact sender match plus current effective-conversation placement access (C1).
  SELECT s.id, coalesce(c.channel_id, s.channel_id) AS channel_id, s.until
  INTO v_ask
  FROM swarm.signals AS s
  LEFT JOIN swarm.conversation_signals AS cs
    ON cs.workspace_id = s.workspace_id
    AND cs.signal_id = s.id
  LEFT JOIN swarm.conversations AS c
    ON c.workspace_id = s.workspace_id
    AND c.conversation_id = cs.conversation_id
  WHERE s.workspace_id = p_workspace_id
    AND s.id = p_signal_id
    AND s.kind = 'ask'
    AND s.from_kind = p_actor_kind
    AND s.from_principal = p_actor_id
    AND swarm.ask_sender_can_access_placement(s.workspace_id, s.id, p_actor_kind, p_actor_id)
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  -- 1. Idempotent own-withdrawal check FIRST (preserves own withdrawal replay identically and
  --    matches ask_withdrawal_release_allowed without invoking completion predicates).
  SELECT aw.withdrawn_at
  INTO v_existing
  FROM swarm.ask_withdrawals AS aw
  WHERE aw.workspace_id = p_workspace_id
    AND aw.signal_id = p_signal_id
  FOR UPDATE;

  IF FOUND THEN
    -- Replacing an already-withdrawn ask is refused (not an open ask).
    IF p_replaced_by_signal_id IS NOT NULL THEN
      RETURN jsonb_build_object('status', 'not_found');
    END IF;
    -- Plain withdraw called twice is idempotent: one row, original timestamp preserved.
    -- Standalone withdrawal never projects replaced_by_signal_id (HezSec C3).
    RETURN jsonb_build_object(
      'status', 'ok',
      'signal_id', p_signal_id,
      'withdrawn', true,
      'created', false,
      'withdrawn_at', v_existing.withdrawn_at,
      'channel_id', v_ask.channel_id
    );
  END IF;

  -- 2. Deadline and cutoff/autoclear check SECOND, strictly BEFORE ask_complete_for_withdrawal.
  --    waiting_ask_autoclear_status never reads replies, ui_actions, or completion predicates.
  IF v_ask.until <= v_now
     OR EXISTS (
       SELECT 1 FROM swarm.waiting_ask_autoclear_status(p_workspace_id, p_signal_id, v_now)
     ) THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  -- 3. Global completion check THIRD, only for still-open, non-cutoff asks.
  IF swarm.ask_complete_for_withdrawal(p_workspace_id, p_signal_id) THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  -- Replacement must point to an ask of the exact same sender with current placement access (C1).
  IF p_replaced_by_signal_id IS NOT NULL
     AND NOT swarm.ask_sender_can_access_placement(
       p_workspace_id, p_replaced_by_signal_id, p_actor_kind, p_actor_id
     ) THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  BEGIN
    INSERT INTO swarm.ask_withdrawals (
      workspace_id, signal_id, withdrawn_by_kind, withdrawn_by, replaced_by_signal_id, withdrawn_at
    ) VALUES (
      p_workspace_id, p_signal_id, p_actor_kind, p_actor_id, p_replaced_by_signal_id, v_now
    )
    RETURNING withdrawn_at INTO v_withdrawn_at;
    v_created := true;

    -- Re-verify authority, deadline/cutoff, placement (C1), and completion (C2) in separate
    -- PL/pgSQL IF checks under a fresh READ COMMITTED snapshot after the row write.
    IF p_actor_kind = 'user' THEN
      v_actor_live := swarm.is_member(p_workspace_id, p_actor_id);
    ELSE
      SELECT EXISTS (
        SELECT 1
        FROM swarm.agent_principals AS ap
        JOIN swarm.agent_workspace_memberships AS am
          ON am.principal_id = ap.principal_id
          AND am.owner_user_id = ap.owner_user_id
          AND am.workspace_id = p_workspace_id
        JOIN swarm.memberships AS om
          ON om.workspace_id = p_workspace_id
          AND om.user_id = ap.owner_user_id
        WHERE ap.principal_id = p_actor_id
          AND ap.revoked_at IS NULL
          AND am.revoked_at IS NULL
          AND om.revoked_at IS NULL
      ) INTO v_actor_live;
    END IF;

    IF NOT coalesce(v_actor_live, false) THEN
      RAISE EXCEPTION 'ask_withdrawal_forbidden' USING ERRCODE = 'P0001';
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM swarm.signals AS s
      WHERE s.workspace_id = p_workspace_id
        AND s.id = p_signal_id
        AND s.until > clock_timestamp()
        AND NOT (
          s.from_kind = 'agent'
          AND EXISTS (
            SELECT 1
            FROM swarm.agent_ask_clear_events AS ce
            WHERE ce.workspace_id = s.workspace_id
              AND ce.principal_id = s.from_principal
              AND ce.cutoff_epoch >= COALESCE(s.sender_lifecycle_epoch, 1)
          )
        )
    ) THEN
      RAISE EXCEPTION 'ask_not_found' USING ERRCODE = 'P0001';
    END IF;

    IF NOT swarm.ask_sender_can_access_placement(p_workspace_id, p_signal_id, p_actor_kind, p_actor_id)
       OR (
         p_replaced_by_signal_id IS NOT NULL
         AND NOT swarm.ask_sender_can_access_placement(
           p_workspace_id, p_replaced_by_signal_id, p_actor_kind, p_actor_id
         )
       ) THEN
      RAISE EXCEPTION 'ask_not_found' USING ERRCODE = 'P0001';
    END IF;

    IF swarm.ask_complete_for_withdrawal(p_workspace_id, p_signal_id) THEN
      RAISE EXCEPTION 'ask_not_found' USING ERRCODE = 'P0001';
    END IF;
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN
      IF SQLERRM = 'ask_withdrawal_forbidden' THEN
        RETURN jsonb_build_object('status', 'forbidden');
      END IF;
      RETURN jsonb_build_object('status', 'not_found');
  END;

  RETURN jsonb_build_object(
    'status', 'ok',
    'signal_id', p_signal_id,
    'withdrawn', true,
    'created', v_created,
    'withdrawn_at', v_withdrawn_at,
    'channel_id', v_ask.channel_id
  );
END;
$$;

ALTER FUNCTION swarm.withdraw_ask(uuid, text, uuid, uuid, uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.withdraw_ask(uuid, text, uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT EXECUTE ON FUNCTION swarm.withdraw_ask(uuid, text, uuid, uuid, uuid) TO swarm_command;

-- 7d. swarm.change_hosted_agent_membership: advance seat lifecycle epoch on p_add = true.
--     Latest prior definition: 20261028000003_hosted_agent_workspaces.sql.
CREATE OR REPLACE FUNCTION swarm.change_hosted_agent_membership(p_workspace uuid,p_principal uuid,p_actor uuid,p_add boolean)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT swarm.hosted_agent_membership_allowed(p_workspace,p_principal,p_actor,p_add) THEN RETURN false; END IF;
 IF p_add THEN
  INSERT INTO swarm.agent_workspace_memberships(principal_id,workspace_id,owner_user_id,added_by)
   SELECT principal_id,p_workspace,owner_user_id,p_actor FROM swarm.agent_principals WHERE principal_id=p_principal
   ON CONFLICT(principal_id,workspace_id) DO UPDATE SET revoked_at=NULL,added_by=p_actor,added_at=clock_timestamp()
    WHERE swarm.agent_workspace_memberships.revoked_at IS NOT NULL;
  INSERT INTO swarm.hosted_mcp_agent_workspace_adds(grant_id,principal_id,workspace_id,owner_user_id,added_by)
   SELECT ga.grant_id,ga.principal_id,p_workspace,ga.owner_user_id,p_actor
   FROM swarm.hosted_mcp_grant_agents ga JOIN swarm.hosted_mcp_grants g USING(grant_id,owner_user_id)
   WHERE ga.principal_id=p_principal AND ga.revoked_at IS NULL
    AND commonswarm_oauth.provider_family_active(g.provider_grant_id)
   ON CONFLICT(grant_id,principal_id,workspace_id) WHERE revoked_at IS NULL DO NOTHING;
  PERFORM swarm.advance_seat_lifecycle_epoch(p_principal, p_workspace);
 ELSE
  UPDATE swarm.agent_workspace_memberships SET revoked_at=clock_timestamp()
   WHERE principal_id=p_principal AND workspace_id=p_workspace AND revoked_at IS NULL;
  UPDATE swarm.hosted_mcp_agent_workspace_adds SET revoked_at=clock_timestamp()
   WHERE principal_id=p_principal AND workspace_id=p_workspace AND revoked_at IS NULL;
  -- Original approval is withdrawn once its last bound identity leaves. An
  -- explicit human re-add uses a new receipt and never clears this deny fence.
  UPDATE swarm.hosted_mcp_grant_workspaces c SET revoked_at=clock_timestamp()
   WHERE c.workspace_id=p_workspace AND c.revoked_at IS NULL
   AND EXISTS(SELECT 1 FROM swarm.hosted_mcp_grant_agents ga WHERE ga.grant_id=c.grant_id AND ga.principal_id=p_principal)
   AND NOT EXISTS(SELECT 1 FROM swarm.hosted_mcp_grant_agents ga
     JOIN swarm.agent_workspace_memberships am USING(principal_id,owner_user_id)
     JOIN swarm.agent_principals p USING(principal_id,owner_user_id)
     WHERE ga.grant_id=c.grant_id AND ga.revoked_at IS NULL AND p.revoked_at IS NULL
       AND am.workspace_id=p_workspace AND am.revoked_at IS NULL);
  UPDATE swarm.hosted_mcp_seats SET revoked_at=clock_timestamp()
   WHERE principal_id=p_principal AND workspace_id=p_workspace AND revoked_at IS NULL;
  UPDATE swarm.hosted_mcp_seat_handles SET revoked_at=clock_timestamp()
   WHERE principal_id=p_principal AND workspace_id=p_workspace AND revoked_at IS NULL;
  INSERT INTO swarm.revocation_tombstones(kind,target_id,created_by)
   SELECT 'hosted_seat',seat_id,p_actor FROM swarm.hosted_mcp_seats WHERE principal_id=p_principal AND workspace_id=p_workspace
   ON CONFLICT DO NOTHING;
  UPDATE swarm.household_content_connections SET revoked_at=clock_timestamp()
   WHERE principal_id=p_principal AND workspace_id=p_workspace AND revoked_at IS NULL;
 END IF;
 RETURN true;
END $$;

ALTER FUNCTION swarm.change_hosted_agent_membership(uuid,uuid,uuid,boolean) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.change_hosted_agent_membership(uuid,uuid,uuid,boolean)
  FROM PUBLIC,anon,authenticated,swarm_read,swarm_command,commonswarm_oauth_runtime;
GRANT EXECUTE ON FUNCTION swarm.change_hosted_agent_membership(uuid,uuid,uuid,boolean) TO swarm_command;

-- 7e. swarm.change_local_agent_membership: advance seat lifecycle epoch on p_add = true.
--     Latest prior definition: 20261028000003_hosted_agent_workspaces.sql.
CREATE OR REPLACE FUNCTION swarm.change_local_agent_membership(p_workspace uuid,p_principal uuid,p_actor uuid,p_add boolean)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE changed boolean;
BEGIN
 IF EXISTS(SELECT 1 FROM swarm.agent_principals WHERE principal_id=p_principal AND transport='hosted_mcp') THEN
 RETURN swarm.change_hosted_agent_membership(p_workspace,p_principal,p_actor,p_add); END IF;
 IF NOT swarm.local_agent_membership_allowed(p_workspace,p_principal,p_actor,p_add) THEN RETURN false; END IF;
 IF p_add THEN
   INSERT INTO swarm.agent_workspace_memberships(principal_id,workspace_id,owner_user_id,added_by)
   SELECT p_principal,p_workspace,p.owner_user_id,p_actor FROM swarm.agent_principals p WHERE p.principal_id=p_principal
   ON CONFLICT(principal_id,workspace_id) DO UPDATE SET revoked_at=NULL,added_by=p_actor,added_at=clock_timestamp()
   WHERE swarm.agent_workspace_memberships.revoked_at IS NOT NULL;
   PERFORM set_config('cswarm.membership_removal','true',true);
   INSERT INTO swarm.agent_execution_sessions(principal_id,workspace_id,session_id,lifecycle_state,expired_at)
   SELECT principal_id,p_workspace,gen_random_uuid(),'enabled',clock_timestamp() FROM swarm.agent_principals
   WHERE principal_id=p_principal AND managed_at IS NOT NULL
   ON CONFLICT(principal_id,workspace_id) DO UPDATE SET lifecycle_state='enabled' WHERE swarm.agent_execution_sessions.lifecycle_state='disabled';
   PERFORM set_config('cswarm.membership_removal','false',true);
   PERFORM swarm.advance_seat_lifecycle_epoch(p_principal, p_workspace);
 ELSE
   UPDATE swarm.agent_workspace_memberships SET revoked_at=clock_timestamp()
   WHERE principal_id=p_principal AND workspace_id=p_workspace AND revoked_at IS NULL;
   -- End only the removed target's proof, delivery, wake and content authority.
   PERFORM set_config('cswarm.membership_removal','true',true);
   UPDATE swarm.agent_execution_sessions SET key_hash=NULL,lifecycle_state='disabled',expired_at=clock_timestamp(),generation=generation+1
   WHERE principal_id=p_principal AND workspace_id=p_workspace;
   PERFORM set_config('cswarm.membership_removal','false',true);
   DELETE FROM swarm.agent_wake_leases WHERE principal_id=p_principal AND workspace_id=p_workspace;
   DELETE FROM swarm.h0_poll_locks WHERE principal_id=p_principal AND workspace_id=p_workspace;
   UPDATE swarm.signal_deliveries SET leased_until=NULL,leased_by=NULL,lease_id=NULL,session_id=NULL,session_generation=NULL
   WHERE recipient_agent_principal_id=p_principal AND workspace_id=p_workspace AND acked_at IS NULL;
   UPDATE swarm.household_content_connections SET revoked_at=clock_timestamp()
   WHERE principal_id=p_principal AND workspace_id=p_workspace AND hosted_grant_id IS NULL AND revoked_at IS NULL;
 END IF;
 RETURN true;
END $$;

ALTER FUNCTION swarm.change_local_agent_membership(uuid,uuid,uuid,boolean) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.change_local_agent_membership(uuid,uuid,uuid,boolean)
  FROM PUBLIC,anon,authenticated,swarm_read,swarm_command,commonswarm_oauth_runtime;
GRANT EXECUTE ON FUNCTION swarm.change_local_agent_membership(uuid,uuid,uuid,boolean) TO swarm_command;

RESET search_path;
