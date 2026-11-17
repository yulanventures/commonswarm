-- Wake-path eligibility for an agent in every workspace it belongs to, and for its mentions.
--
-- swarm.wake_path_eligible_deliveries (the admin view) and swarm.actor_wake_path_eligible_deliveries
-- (what swarm_read.agent_wake_path_deliveries and signal_delivery_receipts.wake_path_observing read)
-- still joined swarm.agent_principals on the delivery's workspace. An agent added to a second
-- workspace (swarm.agent_workspace_memberships, 20261028000002) has its agent_principals row in its
-- first workspace only, so none of its deliveries in any other workspace could ever count as
-- waiting on its wake path. Both also counted a delivery as directed only through
-- signals.to_agent_principal_id and swarm.signal_recipients, while the delivery path and the
-- unclaimed observation (supabase/functions/command/durable-delivery.ts) count a mention as well.
--
-- Both definitions below are 20261113000003_private_channels.sql (1322-1424 and 1728-1793) with
-- three changes and nothing else:
--   1. the agent joins by principal alone, and its live membership in the delivery's workspace is
--      required instead, as swarm.agent_delivery_is_wakeable asks it when the delivery is written;
--   2. the candidate's directed test also admits a swarm.signal_mentions row naming the agent;
--   3. the later-observed supersession's directed test admits the same mention.
-- Select lists, owners, grants, security_barrier, the release cutoff, the lease-free observed seed,
-- the turn_only fence and every private-channel gate are unchanged.
--
-- The function is plpgsql and names swarm.agent_workspace_memberships directly: a plpgsql body
-- records no pg_depend edge. The view cannot: a view that named the table would record a rewrite
-- dependency on it, and the 20261028000001 rollback drill drops that table (2BP01, as #471 found
-- for swarm_read.signals). The view asks swarm.agent_has_live_workspace_seat instead.
--
-- Rollback: deploy/release-proofs/wake-multiworkspace/20261117000003-rollback.sql.

-- 1. The view's membership test. Unlike swarm.agent_has_workspace_membership (20261116000005) it is
-- not owner-gated: the view is evaluated by swarm_admin and the cluster administrator, never under
-- a person's claims. It answers for any principal, so no client role may call it: only its owner,
-- swarm_admin, the only role that reads the view. Without the memberships table (the
-- 20261028000001 rollback drill) it answers as the view did before: the agent's first workspace.
CREATE FUNCTION swarm.agent_has_live_workspace_seat(
  p_principal_id uuid,
  p_workspace_id uuid
) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog AS $$
BEGIN
  IF p_principal_id IS NULL OR p_workspace_id IS NULL THEN
    RETURN false;
  END IF;
  IF to_regclass('swarm.agent_workspace_memberships') IS NULL THEN
    RETURN EXISTS (
      SELECT 1 FROM swarm.agent_principals AS p
      WHERE p.principal_id = p_principal_id
        AND p.workspace_id = p_workspace_id
    );
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM swarm.agent_workspace_memberships AS seat
    WHERE seat.principal_id = p_principal_id
      AND seat.workspace_id = p_workspace_id
      AND seat.revoked_at IS NULL
  );
END;
$$;

ALTER FUNCTION swarm.agent_has_live_workspace_seat(uuid, uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.agent_has_live_workspace_seat(uuid, uuid)
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;

-- 2. Caller-scoped wake-path eligibility (20261113000003, changes 1-3 above).
CREATE OR REPLACE FUNCTION swarm.actor_wake_path_eligible_deliveries(
  p_actor_kind text,
  p_actor_id uuid
)
RETURNS TABLE (
  workspace_id uuid,
  signal_id uuid,
  principal_id uuid,
  enqueued_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
#variable_conflict use_column
BEGIN
  IF p_actor_id IS NULL OR p_actor_kind IS NULL OR p_actor_kind NOT IN ('user', 'agent') THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT d.workspace_id, d.signal_id, d.recipient_agent_principal_id AS principal_id,
         d.enqueued_at
  FROM swarm.signal_deliveries AS d
  JOIN swarm.signals AS s
    ON s.workspace_id = d.workspace_id AND s.id = d.signal_id
  JOIN swarm.agent_principals AS p
    ON p.principal_id = d.recipient_agent_principal_id
  WHERE d.acked_at IS NULL AND d.lease_id IS NULL AND d.leased_by IS NULL
    AND d.last_lease_id IS NULL AND d.last_leased_by IS NULL
    AND d.enqueued_at >= (SELECT wpr.applied_at FROM swarm.wake_path_release AS wpr WHERE wpr.singleton)
    AND s.until > statement_timestamp()
    AND s.kind IN ('ask', 'note')
    AND swarm.actor_can_access_channel(d.workspace_id, s.channel_id, p_actor_kind, p_actor_id)
    AND (
      s.channel_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM swarm.channels AS ch
        WHERE ch.workspace_id = s.workspace_id
          AND ch.channel_id = s.channel_id
          AND (
            ch.visibility = 'open'
            OR EXISTS (
              SELECT 1
              FROM swarm.channel_members AS cm
              WHERE cm.workspace_id = s.workspace_id
                AND cm.channel_id = s.channel_id
                AND cm.member_kind = 'agent'
                AND cm.agent_principal_id = d.recipient_agent_principal_id
            )
          )
      )
    )
    AND (s.to_agent_principal_id = d.recipient_agent_principal_id
      OR EXISTS (SELECT 1 FROM swarm.signal_recipients AS r
        WHERE r.workspace_id = s.workspace_id AND r.signal_id = s.id
          AND r.recipient_agent_principal_id = d.recipient_agent_principal_id)
      OR EXISTS (SELECT 1 FROM swarm.signal_mentions AS m
        WHERE m.workspace_id = s.workspace_id AND m.signal_id = s.id
          AND m.mentioned_agent_principal_id = d.recipient_agent_principal_id))
    AND p.revoked_at IS NULL
    AND p.turn_only = false
    AND EXISTS (SELECT 1 FROM swarm.agent_workspace_memberships AS seat
      WHERE seat.principal_id = d.recipient_agent_principal_id
        AND seat.workspace_id = d.workspace_id
        AND seat.revoked_at IS NULL)
    AND EXISTS (SELECT 1 FROM swarm.signal_deliveries AS observed
      JOIN swarm.signals AS observed_signal
        ON observed_signal.workspace_id = observed.workspace_id
       AND observed_signal.id = observed.signal_id
      WHERE observed.workspace_id = d.workspace_id
        AND observed.recipient_agent_principal_id = d.recipient_agent_principal_id
        AND observed.ack_outcome = 'observed' AND observed.last_lease_id IS NULL
        AND observed.last_leased_by IS NULL
        AND observed.acked_at >= (SELECT wpr2.applied_at FROM swarm.wake_path_release AS wpr2 WHERE wpr2.singleton)
        AND swarm.actor_can_access_channel(
          observed_signal.workspace_id,
          observed_signal.channel_id,
          p_actor_kind,
          p_actor_id
        ))
    AND NOT EXISTS (SELECT 1 FROM swarm.signal_deliveries AS later
      JOIN swarm.signals AS later_signal
        ON later_signal.workspace_id = later.workspace_id AND later_signal.id = later.signal_id
      WHERE later.workspace_id = d.workspace_id
        AND later.recipient_agent_principal_id = d.recipient_agent_principal_id
        AND (date_trunc('milliseconds', later_signal.created_at), later_signal.id)
          > (date_trunc('milliseconds', s.created_at), s.id)
        AND later_signal.kind IN ('ask', 'note')
        AND swarm.actor_can_access_channel(
          later_signal.workspace_id,
          later_signal.channel_id,
          p_actor_kind,
          p_actor_id
        )
        AND (later_signal.to_agent_principal_id = d.recipient_agent_principal_id
          OR EXISTS (SELECT 1 FROM swarm.signal_recipients AS later_recipient
            WHERE later_recipient.workspace_id = later_signal.workspace_id
              AND later_recipient.signal_id = later_signal.id
              AND later_recipient.recipient_agent_principal_id = d.recipient_agent_principal_id)
          OR EXISTS (SELECT 1 FROM swarm.signal_mentions AS later_mention
            WHERE later_mention.workspace_id = later_signal.workspace_id
              AND later_mention.signal_id = later_signal.id
              AND later_mention.mentioned_agent_principal_id = d.recipient_agent_principal_id))
        AND later.ack_outcome = 'observed' AND later.last_lease_id IS NULL
        AND later.last_leased_by IS NULL);
END;
$$;

ALTER FUNCTION swarm.actor_wake_path_eligible_deliveries(text, uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.actor_wake_path_eligible_deliveries(text, uuid)
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;

-- 3. The admin view (20261113000003, changes 1-3 above; the membership through the function).
CREATE OR REPLACE VIEW swarm.wake_path_eligible_deliveries
WITH (security_barrier = true)
AS
SELECT d.workspace_id, d.signal_id, d.recipient_agent_principal_id AS principal_id,
       d.enqueued_at
FROM swarm.signal_deliveries AS d
JOIN swarm.signals AS s
  ON s.workspace_id = d.workspace_id AND s.id = d.signal_id
JOIN swarm.agent_principals AS p
  ON p.principal_id = d.recipient_agent_principal_id
WHERE d.acked_at IS NULL AND d.lease_id IS NULL AND d.leased_by IS NULL
  AND d.last_lease_id IS NULL AND d.last_leased_by IS NULL
  AND d.enqueued_at >= (SELECT applied_at FROM swarm.wake_path_release WHERE singleton)
  AND s.until > statement_timestamp()
  AND s.kind IN ('ask', 'note')
  AND (
    s.channel_id IS NULL
    OR EXISTS (
      SELECT 1
      FROM swarm.channels AS ch
      WHERE ch.workspace_id = s.workspace_id
        AND ch.channel_id = s.channel_id
        AND (
          ch.visibility = 'open'
          OR EXISTS (
            SELECT 1
            FROM swarm.channel_members AS cm
            WHERE cm.workspace_id = s.workspace_id
              AND cm.channel_id = s.channel_id
              AND cm.member_kind = 'agent'
              AND cm.agent_principal_id = d.recipient_agent_principal_id
          )
        )
    )
  )
  AND (s.to_agent_principal_id = d.recipient_agent_principal_id
    OR EXISTS (SELECT 1 FROM swarm.signal_recipients AS r
      WHERE r.workspace_id = s.workspace_id AND r.signal_id = s.id
        AND r.recipient_agent_principal_id = d.recipient_agent_principal_id)
    OR EXISTS (SELECT 1 FROM swarm.signal_mentions AS m
      WHERE m.workspace_id = s.workspace_id AND m.signal_id = s.id
        AND m.mentioned_agent_principal_id = d.recipient_agent_principal_id))
  AND p.revoked_at IS NULL
  AND p.turn_only = false
  AND swarm.agent_has_live_workspace_seat(d.recipient_agent_principal_id, d.workspace_id)
  AND EXISTS (SELECT 1 FROM swarm.signal_deliveries AS observed
    WHERE observed.workspace_id = d.workspace_id
      AND observed.recipient_agent_principal_id = d.recipient_agent_principal_id
      AND observed.ack_outcome = 'observed' AND observed.last_lease_id IS NULL
      AND observed.last_leased_by IS NULL
      AND observed.acked_at >= (SELECT applied_at FROM swarm.wake_path_release WHERE singleton))
  AND NOT EXISTS (SELECT 1 FROM swarm.signal_deliveries AS later
    JOIN swarm.signals AS later_signal
      ON later_signal.workspace_id = later.workspace_id AND later_signal.id = later.signal_id
    WHERE later.workspace_id = d.workspace_id
      AND later.recipient_agent_principal_id = d.recipient_agent_principal_id
      AND (date_trunc('milliseconds', later_signal.created_at), later_signal.id)
        > (date_trunc('milliseconds', s.created_at), s.id)
      AND later_signal.kind IN ('ask', 'note')
      AND (later_signal.to_agent_principal_id = d.recipient_agent_principal_id
        OR EXISTS (SELECT 1 FROM swarm.signal_recipients AS later_recipient
          WHERE later_recipient.workspace_id = later_signal.workspace_id
            AND later_recipient.signal_id = later_signal.id
            AND later_recipient.recipient_agent_principal_id = d.recipient_agent_principal_id)
        OR EXISTS (SELECT 1 FROM swarm.signal_mentions AS later_mention
          WHERE later_mention.workspace_id = later_signal.workspace_id
            AND later_mention.signal_id = later_signal.id
            AND later_mention.mentioned_agent_principal_id = d.recipient_agent_principal_id))
      AND later.ack_outcome = 'observed' AND later.last_lease_id IS NULL
      AND later.last_leased_by IS NULL);

ALTER VIEW swarm.wake_path_eligible_deliveries OWNER TO swarm_admin;
REVOKE ALL ON swarm.wake_path_eligible_deliveries
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;

-- 4. Positive control: both definitions ask the live membership and the mention in both directed
-- tests, neither joins the agent on the delivery's workspace, and the view records no dependency
-- on the memberships table (only on the function), so the 20261028000001 rollback can still drop it.
DO $$
DECLARE
  view_def text := pg_get_viewdef('swarm.wake_path_eligible_deliveries'::regclass, true);
  fn_def text := (SELECT prosrc FROM pg_proc
    WHERE oid = 'swarm.actor_wake_path_eligible_deliveries(text,uuid)'::regprocedure);
BEGIN
  IF view_def ~ '\mp\.workspace_id\s*=\s*d\.workspace_id\M' OR fn_def ~ '\mp\.workspace_id\s*=\s*d\.workspace_id\M' THEN
    RAISE EXCEPTION 'wake-path eligibility still joins the agent on the delivery''s workspace';
  END IF;
  IF (SELECT count(*) FROM regexp_matches(view_def, 'agent_has_live_workspace_seat', 'g')) <> 1
     OR (SELECT count(*) FROM regexp_matches(fn_def, 'agent_workspace_memberships', 'g')) <> 1 THEN
    RAISE EXCEPTION 'wake-path eligibility: expected one live-membership test in each definition';
  END IF;
  IF (SELECT count(*) FROM regexp_matches(view_def, 'signal_mentions', 'g')) <> 2
     OR (SELECT count(*) FROM regexp_matches(fn_def, 'signal_mentions', 'g')) <> 2 THEN
    RAISE EXCEPTION 'wake-path eligibility: expected a mention arm in the candidate and the later test';
  END IF;
  IF (SELECT count(*) FROM regexp_matches(fn_def, 'actor_can_access_channel', 'g')) <> 3
     OR position('channel_members' IN view_def) = 0 OR position('channel_members' IN fn_def) = 0 THEN
    RAISE EXCEPTION 'wake-path eligibility lost a private-channel gate';
  END IF;
  IF position('agent_workspace_memberships' IN view_def) > 0 OR EXISTS (
    SELECT 1
    FROM pg_depend AS d
    JOIN pg_rewrite AS rule ON d.classid = 'pg_rewrite'::regclass AND d.objid = rule.oid
    WHERE rule.ev_class = 'swarm.wake_path_eligible_deliveries'::regclass
      AND d.refclassid = 'pg_class'::regclass
      AND d.refobjid = 'swarm.agent_workspace_memberships'::regclass
  ) THEN
    RAISE EXCEPTION 'swarm.wake_path_eligible_deliveries depends on swarm.agent_workspace_memberships; the 20261028000001 rollback could not drop it';
  END IF;
END;
$$;
