-- Rollback for 20261125000002 (retired_seat_asks_prep):
-- Restores swarm.hosted_connection_policy verbatim from 20261111000004_hosted_pre_claim_connection.sql,
-- restores swarm.waiting_ask_autoclear_status, swarm.ask_is_withdrawn, and swarm.withdraw_ask
-- verbatim from 20261125000001_ask_withdrawals.sql, restores swarm.change_hosted_agent_membership
-- and swarm.change_local_agent_membership verbatim from 20261028000003_hosted_agent_workspaces.sql,
-- removes the swarm.config rollout key, and drops all new definers, helper, triggers, column, and tables.
SET search_path = swarm, pg_catalog, public;

-- Restore swarm.hosted_connection_policy from 20261111000004_hosted_pre_claim_connection.sql
CREATE OR REPLACE FUNCTION swarm.hosted_connection_policy(p_workspace uuid, p_principal uuid, p_owner uuid)
RETURNS TABLE(grant_id uuid, state text, revoked_at timestamptz, connection_expires_at timestamptz,
  connection_expired_at timestamptz, seat_revoked_at timestamptz, binding_revoked_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
 SELECT c.grant_id, c.state, c.revoked_at, c.connection_expires_at, c.connection_expired_at,
  c.seat_revoked_at, c.binding_revoked_at
 FROM (
  SELECT g.grant_id, g.state, g.revoked_at, g.connection_expires_at, g.connection_expired_at,
   seat.revoked_at AS seat_revoked_at,
   CASE WHEN swarm.hosted_binding_eligible(g.grant_id, seat.workspace_id, seat.principal_id)
    THEN NULL::timestamptz ELSE clock_timestamp() END AS binding_revoked_at,
   CASE WHEN seat.revoked_at IS NULL THEN 0 ELSE 3 END AS rank, seat.created_at AS at, seat.seat_id AS tie
  FROM swarm.hosted_mcp_seats seat
  JOIN swarm.hosted_mcp_grants g ON g.grant_id = seat.grant_id AND g.owner_user_id = seat.owner_user_id
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

-- Restore swarm.waiting_ask_autoclear_status from 20261125000001_ask_withdrawals.sql
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

-- Restore swarm.ask_is_withdrawn from 20261125000001_ask_withdrawals.sql
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
    AND EXISTS (
      SELECT 1
      FROM swarm.ask_withdrawals AS aw
      WHERE aw.workspace_id = p_workspace_id
        AND aw.signal_id = p_signal_id
    );
$$;

ALTER FUNCTION swarm.ask_is_withdrawn(uuid, uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.ask_is_withdrawn(uuid, uuid)
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT EXECUTE ON FUNCTION swarm.ask_is_withdrawn(uuid, uuid) TO swarm_command;

-- Restore swarm.withdraw_ask from 20261125000001_ask_withdrawals.sql
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

  IF swarm.ask_complete_for_withdrawal(p_workspace_id, p_signal_id) THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

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

  -- Fresh withdrawal or replacement requires an open ask (not expired, not archived/cleared).
  IF v_ask.until <= v_now
     OR EXISTS (
       SELECT 1 FROM swarm.waiting_ask_autoclear_status(p_workspace_id, p_signal_id, v_now)
     ) THEN
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

    -- Re-verify authority, placement (C1), completion (C2), and deadline in a fresh READ COMMITTED
    -- snapshot after the row write.
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

    IF swarm.ask_complete_for_withdrawal(p_workspace_id, p_signal_id)
       OR NOT EXISTS (
         SELECT 1
         FROM swarm.signals AS s
         WHERE s.workspace_id = p_workspace_id
           AND s.id = p_signal_id
           AND s.until > clock_timestamp()
       )
       OR NOT swarm.ask_sender_can_access_placement(p_workspace_id, p_signal_id, p_actor_kind, p_actor_id)
       OR (
         p_replaced_by_signal_id IS NOT NULL
         AND NOT swarm.ask_sender_can_access_placement(
           p_workspace_id, p_replaced_by_signal_id, p_actor_kind, p_actor_id
         )
       ) THEN
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

-- Restore swarm.change_hosted_agent_membership from 20261028000003_hosted_agent_workspaces.sql
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

-- Restore swarm.change_local_agent_membership from 20261028000003_hosted_agent_workspaces.sql
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

DROP FUNCTION IF EXISTS swarm.seat_ask_clear_release_allowed(uuid, uuid, uuid, bigint, timestamptz);
DROP FUNCTION IF EXISTS swarm.clear_retired_seat_asks(uuid, uuid, uuid);
DROP FUNCTION IF EXISTS swarm.advance_seat_lifecycle_epoch(uuid, uuid);
DROP FUNCTION IF EXISTS swarm.seat_ask_lifecycle_epoch(uuid, uuid);
DROP FUNCTION IF EXISTS swarm.seat_is_disconnected_for_ask_clear(uuid, uuid);

DROP TRIGGER IF EXISTS signals_bind_seat_lifecycle_epoch ON swarm.signals;
DROP FUNCTION IF EXISTS swarm.signals_bind_seat_lifecycle_epoch();
ALTER TABLE swarm.signals DROP COLUMN IF EXISTS sender_lifecycle_epoch;

DROP TRIGGER IF EXISTS agent_ask_clear_events_validate_refs ON swarm.agent_ask_clear_events;
DROP TABLE IF EXISTS swarm.agent_ask_clear_events;
DROP FUNCTION IF EXISTS swarm.agent_ask_clear_events_validate_refs();

DROP TRIGGER IF EXISTS agent_workspace_memberships_seed_ask_lifecycle ON swarm.agent_workspace_memberships;
DROP FUNCTION IF EXISTS swarm.agent_workspace_memberships_seed_ask_lifecycle();
DROP TRIGGER IF EXISTS agent_ask_lifecycle_validate_refs ON swarm.agent_ask_lifecycle;
DROP TABLE IF EXISTS swarm.agent_ask_lifecycle;
DROP FUNCTION IF EXISTS swarm.agent_ask_lifecycle_validate_refs();

DELETE FROM swarm.config WHERE key = 'retired_seat_ask_clear_enabled';

RESET search_path;
