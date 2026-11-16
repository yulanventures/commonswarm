-- An agent belongs to every workspace it has a live row in swarm.agent_workspace_memberships
-- (20261028000002), not only the workspace its swarm.agent_principals row was created in. The
-- delivery path, the roster, agent_delivery_read_context and the read and command edges already
-- follow memberships. These read surfaces still asked agent_principals.workspace_id, so in every
-- workspace an agent was added to after its first:
--
--   * swarm_read.signals hid each message addressed to the agent (scalar to_agent_principal_id and
--     swarm.signal_recipients) from the agent's own reads, its check and its owner. The delivery row
--     stayed unacked, so the roster showed the agent as not_picking_up.
--   * swarm_read.signal_delivery_receipts gave the agent's replies no responder name and hid them
--     from the owner's receipt view.
--   * the broadcast rosters in signal_delivery_receipts_without_main_queue_count and
--     _without_wake_path left the agent out.
--   * swarm_read.home_overview kept an ask open after the owner's agent answered it, and never
--     listed a held to-do assigned to the agent under waiting.
--
-- Each predicate below changes from the agent's first workspace to its membership in the signal's,
-- reply's or to-do's workspace. Nothing else changes: every select list, column order, owner,
-- grant, security_barrier option, is_member wall, private-channel gate (claims_can_access_channel,
-- actor_can_access_channel) and the agent narrowing in the edges stay as they were.
--
-- swarm_read.signals: an addressed message's recipient always has a membership row in the
-- message's workspace (the foreign keys on swarm.signals and swarm.signal_recipients name
-- swarm.agent_workspace_memberships since 20261028000002), so the first-workspace test is replaced.
-- The other surfaces key on an author, an assignee or the whole agent list, where that is not
-- guaranteed (registrar principals have no membership row), so they keep the first-workspace test
-- beside the membership: the first workspace reads exactly as before. The broadcast rosters list
-- live members only, by the same admission swarm.actor_can_access_channel applies: a live
-- membership here, or this is the agent's first workspace and it has no membership row here.
--
-- Revocation: a removed membership already ends the agent's reads in that workspace at the
-- credential (agent_delivery_read_context, then 403 from the read edge), and an owner keeps reading
-- messages addressed to an agent it owns after the agent is removed, as in its first workspace.
-- What happened while the agent was a member stays as it was: its replies keep its name and the
-- owner's oversight, and an ask it answered stays answered. What is live follows the membership:
-- the broadcast rosters leave a removed agent out, and home_overview reports a to-do assigned to an
-- agent removed from the to-do's workspace as agent_removed. Messages an agent sends to someone
-- else stay readable only to their recipients.
--
-- Rollback: recreate swarm_read.signals by swapping each membership EXISTS below back to its
-- first-workspace equality, and the four functions from 20261113000003_private_channels.sql
-- (867-1130, 1132-1315, 1474-1574, 1926-2131).

-- 1. swarm_read.signals, spliced from the live definition as every recreation since 20260905000002.
SELECT set_config(
  'swarm.signals_view_before',
  pg_get_viewdef('swarm_read.signals'::regclass, true),
  false
);

DO $$
DECLARE
  live_def text := current_setting('swarm.signals_view_before');
  -- The scalar arm (20260730000002) and the recipient arm (20260905000010), as pg_get_viewdef
  -- renders them.
  scalar_arm constant text := '\mprincipal\.workspace_id\s*=\s*s\.workspace_id\M';
  recipient_arm constant text := '\mowned\.workspace_id\s*=\s*addressee\.workspace_id\M';
  body text;
BEGIN
  IF position('agent_workspace_memberships' IN live_def) > 0 THEN
    RAISE EXCEPTION 'swarm_read.signals already reads agent_workspace_memberships';
  END IF;
  IF (SELECT count(*) FROM regexp_matches(live_def, scalar_arm, 'g')) <> 1 THEN
    RAISE EXCEPTION 'expected exactly one first-workspace test on the scalar agent arm of swarm_read.signals';
  END IF;
  IF (SELECT count(*) FROM regexp_matches(live_def, recipient_arm, 'g')) <> 1 THEN
    RAISE EXCEPTION 'expected exactly one first-workspace test on the recipient agent arm of swarm_read.signals';
  END IF;

  body := regexp_replace(live_def, scalar_arm,
    '(EXISTS ( SELECT 1 FROM swarm.agent_workspace_memberships principal_seat'
    || ' WHERE principal_seat.principal_id = principal.principal_id'
    || ' AND principal_seat.owner_user_id = principal.owner_user_id'
    || ' AND principal_seat.workspace_id = s.workspace_id))');
  body := regexp_replace(body, recipient_arm,
    '(EXISTS ( SELECT 1 FROM swarm.agent_workspace_memberships owned_seat'
    || ' WHERE owned_seat.principal_id = owned.principal_id'
    || ' AND owned_seat.owner_user_id = owned.owner_user_id'
    || ' AND owned_seat.workspace_id = addressee.workspace_id))');
  body := rtrim(body, E' ;\n\t');

  EXECUTE 'CREATE OR REPLACE VIEW swarm_read.signals WITH (security_barrier = true) AS ' || body;
END;
$$;

ALTER VIEW swarm_read.signals OWNER TO swarm_admin;
GRANT SELECT ON swarm_read.signals TO authenticated, swarm_read;
REVOKE ALL ON swarm_read.signals FROM PUBLIC, anon;

SELECT swarm.assert_view_clauses_preserved(
  'swarm_read.signals',
  current_setting('swarm.signals_view_before')
);
SELECT set_config('swarm.signals_view_before', '', false);

-- Positive control: both arms now ask the membership and neither asks the first workspace, each
-- agent_principals lookup has its membership beside it, and the boundary the next splice
-- depends on is still unique.
DO $$
DECLARE
  after_def text := pg_get_viewdef('swarm_read.signals'::regclass, true);
BEGIN
  IF after_def ~ '\mprincipal\.workspace_id\s*=\s*s\.workspace_id\M'
     OR after_def ~ '\mowned\.workspace_id\s*=\s*addressee\.workspace_id\M' THEN
    RAISE EXCEPTION 'swarm_read.signals still tests an addressed agent''s first workspace';
  END IF;
  IF (SELECT count(*) FROM regexp_matches(after_def, 'agent_workspace_memberships', 'g')) <> 2
     OR (SELECT count(*) FROM regexp_matches(after_def, '\magent_principals\M', 'g')) <> 2 THEN
    RAISE EXCEPTION 'swarm_read.signals: expected two agent arms, each with its membership';
  END IF;
  IF position('claims_can_access_channel' IN after_def) = 0 THEN
    RAISE EXCEPTION 'swarm_read.signals lost its private-channel gate';
  END IF;
  IF (SELECT count(*) FROM regexp_matches(after_def, '\sFROM\s+(swarm\.)?signals\s', 'g')) <> 1 THEN
    RAISE EXCEPTION
      'swarm_read.signals now has more than one FROM swarm.signals boundary; the next migration cannot splice it';
  END IF;
END;
$$;

-- 2. Delivery receipts. The three functions below are 20261113000003_private_channels.sql
-- (867-1130, 1132-1315 and 1474-1574) unchanged except the agent's workspace: in the broadcast
-- rosters, an agent is listed in this workspace by its live membership here (and its owner's
-- membership and its seen receipt are this workspace's, as they always were for its first
-- workspace); in replies, a responder's name and the owner's oversight follow the membership too.

CREATE OR REPLACE FUNCTION swarm_read.signal_delivery_receipts_without_main_queue_count(
  p_workspace_id uuid,
  p_signal_id uuid,
  p_agent_token_hash bytea DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = swarm, pg_catalog
AS $$
DECLARE
  v_claims jsonb := NULLIF(current_setting('request.jwt.claims', true), '')::jsonb;
  v_human_user_id uuid := NULLIF(v_claims ->> 'sub', '')::uuid;
  v_author_kind text;
  v_author_id uuid;
  v_agent_principal_id uuid;
  v_agent_workspace_id uuid;
  v_agent_revoked boolean;
  v_to_user_id uuid;
  v_to_agent_principal_id uuid;
  v_channel_id uuid;
  v_addressed boolean;
  v_receipts jsonb;
  v_agent_principals jsonb;
  v_member_total bigint;
  v_member_seen_total bigint;
  v_member_returned bigint;
  v_agent_total bigint;
  v_agent_returned bigint;
  v_roster_limit constant integer := 50;
BEGIN
  IF v_human_user_id IS NOT NULL THEN
    IF p_agent_token_hash IS NOT NULL
       OR (v_claims ? 'agent_principal_id')
       OR NOT swarm.is_member(p_workspace_id, v_human_user_id)
    THEN
      RETURN NULL;
    END IF;
  ELSE
    IF p_agent_token_hash IS NULL THEN
      RETURN NULL;
    END IF;
    SELECT
      context.principal_id,
      context.principal_workspace_id,
      context.is_revoked
    INTO
      v_agent_principal_id,
      v_agent_workspace_id,
      v_agent_revoked
    FROM swarm.agent_delivery_read_context(
      p_agent_token_hash,
      p_workspace_id
    ) AS context
    LIMIT 1;

    IF v_agent_principal_id IS NULL
       OR v_agent_revoked
       OR v_agent_workspace_id <> p_workspace_id
    THEN
      RETURN NULL;
    END IF;
    v_author_kind := 'agent';
    v_author_id := v_agent_principal_id;
  END IF;

  SELECT signal.to_user_id, signal.to_agent_principal_id, signal.channel_id
  INTO v_to_user_id, v_to_agent_principal_id, v_channel_id
  FROM swarm.signals AS signal
  WHERE signal.id = p_signal_id
    AND signal.workspace_id = p_workspace_id
    AND (
      (
        v_human_user_id IS NOT NULL
        AND swarm.actor_can_access_channel(p_workspace_id, signal.channel_id, 'user', v_human_user_id)
        AND (
          (signal.from_kind = 'user' AND signal.from_principal = v_human_user_id)
          OR EXISTS (
            SELECT 1
            FROM swarm_read.signals AS readable
            WHERE readable.workspace_id = p_workspace_id
              AND readable.id = signal.id
          )
        )
      )
      OR (
        v_human_user_id IS NULL
        AND signal.from_kind = v_author_kind
        AND signal.from_principal = v_author_id
        AND swarm.actor_can_access_channel(p_workspace_id, signal.channel_id, 'agent', v_author_id)
      )
    );

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  v_addressed := v_to_user_id IS NOT NULL OR v_to_agent_principal_id IS NOT NULL;

  IF NOT v_addressed THEN
    SELECT
      count(*),
      count(human.first_seen_at)
    INTO v_member_total, v_member_seen_total
    FROM swarm.memberships AS membership
    JOIN swarm.users AS member_user
      ON member_user.user_id = membership.user_id
    LEFT JOIN swarm.signal_human_receipts AS human
      ON human.workspace_id = membership.workspace_id
     AND human.signal_id = p_signal_id
     AND human.user_id = membership.user_id
    WHERE membership.workspace_id = p_workspace_id
      AND membership.revoked_at IS NULL
      AND swarm.actor_can_access_channel(p_workspace_id, v_channel_id, 'user', membership.user_id);

    SELECT count(*)
    INTO v_agent_total
    FROM swarm.agent_principals AS principal
    JOIN swarm.memberships AS owner_membership
      ON owner_membership.workspace_id = p_workspace_id
     AND owner_membership.user_id = principal.owner_user_id
     AND owner_membership.revoked_at IS NULL
    WHERE (
      EXISTS (
        SELECT 1 FROM swarm.agent_workspace_memberships AS seat
        WHERE seat.principal_id = principal.principal_id
          AND seat.owner_user_id = principal.owner_user_id
          AND seat.workspace_id = p_workspace_id
          AND seat.revoked_at IS NULL
      )
      -- No membership row here at all (a join registrar): its first workspace, as before.
      OR (
        principal.workspace_id = p_workspace_id
        AND NOT EXISTS (
          SELECT 1 FROM swarm.agent_workspace_memberships AS any_seat
          WHERE any_seat.principal_id = principal.principal_id
            AND any_seat.workspace_id = p_workspace_id
        )
      )
    )
      AND principal.revoked_at IS NULL
      AND swarm.actor_can_access_channel(p_workspace_id, v_channel_id, 'agent', principal.principal_id);

    SELECT
      COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'recipient_user_id', member.user_id,
            'display_name', member.display_name,
            'seen_at', member.first_seen_at
          )
          ORDER BY
            member.first_seen_at IS NULL,
            lower(member.display_name),
            member.user_id
        ),
        '[]'::jsonb
      ),
      count(*)
    INTO v_receipts, v_member_returned
    FROM (
      SELECT
        membership.user_id,
        member_user.display_name,
        human.first_seen_at
      FROM swarm.memberships AS membership
      JOIN swarm.users AS member_user
        ON member_user.user_id = membership.user_id
      LEFT JOIN swarm.signal_human_receipts AS human
        ON human.workspace_id = membership.workspace_id
       AND human.signal_id = p_signal_id
       AND human.user_id = membership.user_id
      WHERE membership.workspace_id = p_workspace_id
        AND membership.revoked_at IS NULL
        AND swarm.actor_can_access_channel(p_workspace_id, v_channel_id, 'user', membership.user_id)
      ORDER BY
        human.first_seen_at IS NULL,
        lower(member_user.display_name),
        membership.user_id
      LIMIT v_roster_limit
    ) AS member;

    SELECT
      COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'recipient_agent_principal_id', agent.principal_id,
            'display_name', agent.name,
            'tracking_state', 'not_tracked',
            'observed_at', NULL
          )
          ORDER BY lower(agent.name), agent.principal_id
        ),
        '[]'::jsonb
      ),
      count(*)
    INTO v_agent_principals, v_agent_returned
    FROM (
      SELECT principal.principal_id, principal.name
      FROM swarm.agent_principals AS principal
      JOIN swarm.memberships AS owner_membership
        ON owner_membership.workspace_id = p_workspace_id
       AND owner_membership.user_id = principal.owner_user_id
       AND owner_membership.revoked_at IS NULL
      WHERE (
        EXISTS (
          SELECT 1 FROM swarm.agent_workspace_memberships AS seat
          WHERE seat.principal_id = principal.principal_id
            AND seat.owner_user_id = principal.owner_user_id
            AND seat.workspace_id = p_workspace_id
            AND seat.revoked_at IS NULL
        )
        -- No membership row here at all (a join registrar): its first workspace, as before.
        OR (
          principal.workspace_id = p_workspace_id
          AND NOT EXISTS (
            SELECT 1 FROM swarm.agent_workspace_memberships AS any_seat
            WHERE any_seat.principal_id = principal.principal_id
              AND any_seat.workspace_id = p_workspace_id
          )
        )
      )
        AND principal.revoked_at IS NULL
        AND swarm.actor_can_access_channel(p_workspace_id, v_channel_id, 'agent', principal.principal_id)
      ORDER BY lower(principal.name), principal.principal_id
      LIMIT v_roster_limit
    ) AS agent;

    RETURN jsonb_build_object(
      'addressed', false,
      'receipts', v_receipts,
      'broadcast_roster', jsonb_build_object(
        'members', jsonb_build_object(
          'total', v_member_total,
          'seen', v_member_seen_total,
          'returned', v_member_returned,
          'limit', v_roster_limit,
          'truncated', v_member_total > v_member_returned
        ),
        'agents', jsonb_build_object(
          'total', v_agent_total,
          'returned', v_agent_returned,
          'limit', v_roster_limit,
          'truncated', v_agent_total > v_agent_returned,
          'tracking_state', 'not_tracked',
          'principals', v_agent_principals
        )
      )
    );
  END IF;

  SELECT COALESCE(jsonb_agg(row.receipt ORDER BY row.sort_key), '[]'::jsonb)
  INTO v_receipts
  FROM (
    SELECT
      'agent:' || delivery.recipient_agent_principal_id::text AS sort_key,
      jsonb_build_object(
        'recipient_agent_principal_id', delivery.recipient_agent_principal_id,
        'enqueued_at', delivery.enqueued_at,
        'delivered_at', delivery.delivered_at,
        'leased_until', delivery.leased_until,
        'acked_at', delivery.acked_at,
        'ack_outcome', delivery.ack_outcome,
        'attempt_count', delivery.attempt_count,
        'lease_expiry_count', delivery.lease_expiry_count,
        'last_error_code', delivery.last_error_code
      ) AS receipt
    FROM swarm.signal_deliveries AS delivery
    WHERE delivery.signal_id = p_signal_id
      AND delivery.workspace_id = p_workspace_id

    UNION ALL

    SELECT
      'human:' || target.user_id::text AS sort_key,
      jsonb_build_object(
        'recipient_user_id', target.user_id,
        'seen_at', human.first_seen_at
      ) AS receipt
    FROM (SELECT v_to_user_id AS user_id) AS target
    LEFT JOIN swarm.signal_human_receipts AS human
      ON human.workspace_id = p_workspace_id
     AND human.signal_id = p_signal_id
     AND human.user_id = target.user_id
    WHERE target.user_id IS NOT NULL
  ) AS row;

  RETURN jsonb_build_object(
    'addressed', true,
    'receipts', v_receipts
  );
END;
$$;

ALTER FUNCTION swarm_read.signal_delivery_receipts_without_main_queue_count(uuid, uuid, bytea)
  OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm_read.signal_delivery_receipts_without_main_queue_count(uuid, uuid, bytea)
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;

CREATE OR REPLACE FUNCTION swarm_read.signal_delivery_receipts_without_wake_path(
  p_workspace_id uuid,
  p_signal_id uuid,
  p_agent_token_hash bytea DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = swarm, pg_catalog
AS $$
DECLARE
  v_claims jsonb := NULLIF(current_setting('request.jwt.claims', true), '')::jsonb;
  v_human_user_id uuid := NULLIF(v_claims ->> 'sub', '')::uuid;
  v_agent_principal_id uuid;
  v_result jsonb;
  v_receipts jsonb;
  v_channel_id uuid;
  v_agent_principals jsonb;
  v_agent_total bigint;
  v_agent_seen_total bigint;
  v_agent_returned bigint;
  v_roster_limit constant integer := 50;
BEGIN
  v_result := swarm_read.signal_delivery_receipts_without_main_queue_count(
    p_workspace_id,
    p_signal_id,
    p_agent_token_hash
  );
  IF v_result IS NULL THEN
    RETURN NULL;
  END IF;

  IF v_human_user_id IS NULL AND p_agent_token_hash IS NOT NULL THEN
    SELECT context.principal_id
    INTO v_agent_principal_id
    FROM swarm.agent_delivery_read_context(p_agent_token_hash, p_workspace_id) AS context
    LIMIT 1;
  END IF;

  SELECT s.channel_id INTO v_channel_id
  FROM swarm.signals AS s
  WHERE s.workspace_id = p_workspace_id AND s.id = p_signal_id;

  IF v_result ->> 'addressed' = 'false' THEN
    SELECT count(*), count(agent_receipt.first_seen_at)
    INTO v_agent_total, v_agent_seen_total
    FROM swarm.agent_principals AS principal
    JOIN swarm.memberships AS owner_membership
      ON owner_membership.workspace_id = p_workspace_id
     AND owner_membership.user_id = principal.owner_user_id
     AND owner_membership.revoked_at IS NULL
    LEFT JOIN swarm.signal_agent_receipts AS agent_receipt
      ON agent_receipt.workspace_id = p_workspace_id
     AND agent_receipt.signal_id = p_signal_id
     AND agent_receipt.principal_id = principal.principal_id
    WHERE (
      EXISTS (
        SELECT 1 FROM swarm.agent_workspace_memberships AS seat
        WHERE seat.principal_id = principal.principal_id
          AND seat.owner_user_id = principal.owner_user_id
          AND seat.workspace_id = p_workspace_id
          AND seat.revoked_at IS NULL
      )
      -- No membership row here at all (a join registrar): its first workspace, as before.
      OR (
        principal.workspace_id = p_workspace_id
        AND NOT EXISTS (
          SELECT 1 FROM swarm.agent_workspace_memberships AS any_seat
          WHERE any_seat.principal_id = principal.principal_id
            AND any_seat.workspace_id = p_workspace_id
        )
      )
    )
      AND principal.revoked_at IS NULL
      AND swarm.actor_can_access_channel(p_workspace_id, v_channel_id, 'agent', principal.principal_id);

    SELECT
      COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'principal_id', agent.principal_id,
            'recipient_agent_principal_id', agent.principal_id,
            'display_name', agent.name,
            'seen_at', agent.first_seen_at,
            'tracking_state', 'not_tracked',
            'observed_at', NULL
          )
          ORDER BY
            agent.first_seen_at IS NULL,
            lower(agent.name),
            agent.principal_id
        ),
        '[]'::jsonb
      ),
      count(*)
    INTO v_agent_principals, v_agent_returned
    FROM (
      SELECT principal.principal_id, principal.name, agent_receipt.first_seen_at
      FROM swarm.agent_principals AS principal
      JOIN swarm.memberships AS owner_membership
        ON owner_membership.workspace_id = p_workspace_id
       AND owner_membership.user_id = principal.owner_user_id
       AND owner_membership.revoked_at IS NULL
      LEFT JOIN swarm.signal_agent_receipts AS agent_receipt
        ON agent_receipt.workspace_id = p_workspace_id
       AND agent_receipt.signal_id = p_signal_id
       AND agent_receipt.principal_id = principal.principal_id
      WHERE (
        EXISTS (
          SELECT 1 FROM swarm.agent_workspace_memberships AS seat
          WHERE seat.principal_id = principal.principal_id
            AND seat.owner_user_id = principal.owner_user_id
            AND seat.workspace_id = p_workspace_id
            AND seat.revoked_at IS NULL
        )
        -- No membership row here at all (a join registrar): its first workspace, as before.
        OR (
          principal.workspace_id = p_workspace_id
          AND NOT EXISTS (
            SELECT 1 FROM swarm.agent_workspace_memberships AS any_seat
            WHERE any_seat.principal_id = principal.principal_id
              AND any_seat.workspace_id = p_workspace_id
          )
        )
      )
        AND principal.revoked_at IS NULL
        AND swarm.actor_can_access_channel(p_workspace_id, v_channel_id, 'agent', principal.principal_id)
      ORDER BY
        agent_receipt.first_seen_at IS NULL,
        lower(principal.name),
        principal.principal_id
      LIMIT v_roster_limit
    ) AS agent;

    v_result := jsonb_set(
      v_result,
      '{broadcast_roster,agents}',
      jsonb_build_object(
        'total', v_agent_total,
        'seen', v_agent_seen_total,
        'returned', v_agent_returned,
        'limit', v_roster_limit,
        'truncated', v_agent_total > v_agent_returned,
        'tracking_state', 'not_tracked',
        'principals', v_agent_principals
      ),
      false
    );
    RETURN v_result;
  END IF;

  SELECT COALESCE(
    jsonb_agg(
      CASE
        WHEN receipt.value ? 'recipient_agent_principal_id'
             AND receipt.value ->> 'ack_outcome' = 'queued'
        THEN receipt.value || jsonb_build_object(
          'pending_for_main_count',
          (
            SELECT count(*)
            FROM swarm.signal_deliveries AS pending
            JOIN swarm.signals AS ps
              ON ps.workspace_id = pending.workspace_id
             AND ps.id = pending.signal_id
            WHERE pending.workspace_id = p_workspace_id
              AND pending.recipient_agent_principal_id =
                (receipt.value ->> 'recipient_agent_principal_id')::uuid
              AND pending.ack_outcome = 'queued'
              AND (
                (
                  v_human_user_id IS NOT NULL
                  AND (
                    ps.channel_id IS NULL
                    OR swarm.actor_can_access_channel(p_workspace_id, ps.channel_id, 'user', v_human_user_id)
                  )
                )
                OR (
                  v_human_user_id IS NULL
                  AND v_agent_principal_id IS NOT NULL
                  AND (
                    ps.channel_id IS NULL
                    OR swarm.actor_can_access_channel(p_workspace_id, ps.channel_id, 'agent', v_agent_principal_id)
                  )
                  AND (
                    (ps.from_kind = 'agent' AND ps.from_principal = v_agent_principal_id)
                    OR ps.to_agent_principal_id = v_agent_principal_id
                    OR (ps.to_user_id IS NULL AND ps.to_agent_principal_id IS NULL)
                    OR EXISTS (
                      SELECT 1
                      FROM swarm.signal_recipients AS r
                      WHERE r.workspace_id = ps.workspace_id
                        AND r.signal_id = ps.id
                        AND r.recipient_agent_principal_id = v_agent_principal_id
                    )
                  )
                )
              )
          )
        )
        ELSE receipt.value
      END
      ORDER BY receipt.ordinality
    ),
    '[]'::jsonb
  )
  INTO v_receipts
  FROM jsonb_array_elements(v_result -> 'receipts')
    WITH ORDINALITY AS receipt(value, ordinality);

  RETURN jsonb_set(v_result, '{receipts}', v_receipts, false);
END;
$$;

ALTER FUNCTION swarm_read.signal_delivery_receipts_without_wake_path(uuid, uuid, bytea)
  OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm_read.signal_delivery_receipts_without_wake_path(uuid, uuid, bytea)
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;

CREATE OR REPLACE FUNCTION swarm_read.signal_delivery_receipts(
  p_workspace_id uuid, p_signal_id uuid, p_agent_token_hash bytea DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = swarm, pg_catalog AS $$
DECLARE
  v_result jsonb;
  v_receipts jsonb;
  v_replies jsonb;
  v_human_user_id uuid := NULLIF(
    NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub',
    ''
  )::uuid;
  v_agent_principal_id uuid;
BEGIN
  v_result := swarm_read.signal_delivery_receipts_without_wake_path(
    p_workspace_id, p_signal_id, p_agent_token_hash);
  IF v_result IS NULL THEN RETURN NULL; END IF;

  IF v_human_user_id IS NULL AND p_agent_token_hash IS NOT NULL THEN
    SELECT original.from_principal
    INTO v_agent_principal_id
    FROM swarm.signals AS original
    WHERE original.workspace_id = p_workspace_id
      AND original.id = p_signal_id
      AND original.from_kind = 'agent';
  END IF;

  IF v_result ->> 'addressed' = 'true' THEN
    SELECT COALESCE(jsonb_agg(
      CASE WHEN receipt.value ? 'recipient_agent_principal_id' THEN
        receipt.value || jsonb_build_object('wake_path_observing', EXISTS (
          SELECT 1 FROM swarm.actor_wake_path_eligible_deliveries(
            CASE WHEN v_human_user_id IS NOT NULL THEN 'user' ELSE 'agent' END,
            COALESCE(v_human_user_id, v_agent_principal_id)
          ) AS d
          WHERE d.workspace_id = p_workspace_id AND d.signal_id = p_signal_id
            AND d.principal_id = (receipt.value ->> 'recipient_agent_principal_id')::uuid
        ))
      ELSE receipt.value END ORDER BY receipt.ordinality), '[]'::jsonb)
    INTO v_receipts FROM jsonb_array_elements(v_result -> 'receipts')
      WITH ORDINALITY AS receipt(value, ordinality);
    v_result := jsonb_set(v_result, '{receipts}', v_receipts, false);
  END IF;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'responder_principal_id', reply.from_principal,
      'responder_display_name', CASE
        WHEN reply.from_kind = 'user' THEN responder_user.display_name
        ELSE responder_agent.name
      END,
      'reply_signal_id', reply.id,
      'reply_status', reply.reply_status,
      'created_at', reply.created_at
    ) ORDER BY reply.created_at, reply.id
  ), '[]'::jsonb)
  INTO v_replies
  FROM swarm.signals AS reply
  LEFT JOIN swarm.users AS responder_user
    ON reply.from_kind = 'user'
   AND responder_user.user_id = reply.from_principal
  LEFT JOIN swarm.agent_principals AS responder_agent
    ON reply.from_kind = 'agent'
   AND (
    responder_agent.workspace_id = reply.workspace_id
    OR EXISTS (
      SELECT 1 FROM swarm.agent_workspace_memberships AS responder_seat
      WHERE responder_seat.principal_id = responder_agent.principal_id
        AND responder_seat.owner_user_id = responder_agent.owner_user_id
        AND responder_seat.workspace_id = reply.workspace_id
    )
   )
   AND responder_agent.principal_id = reply.from_principal
  WHERE reply.workspace_id = p_workspace_id
    AND reply.in_reply_to = p_signal_id
    AND (
      (v_human_user_id IS NOT NULL
       AND (reply.channel_id IS NULL OR swarm.actor_can_access_channel(p_workspace_id, reply.channel_id, 'user', v_human_user_id))
       AND (
        reply.to_user_id = v_human_user_id OR
        (reply.from_kind = 'user' AND reply.from_principal = v_human_user_id) OR
        EXISTS (
          SELECT 1 FROM swarm.agent_principals AS owned
          WHERE (
            owned.workspace_id = reply.workspace_id
            OR EXISTS (
              SELECT 1 FROM swarm.agent_workspace_memberships AS owned_seat
              WHERE owned_seat.principal_id = owned.principal_id
                AND owned_seat.owner_user_id = owned.owner_user_id
                AND owned_seat.workspace_id = reply.workspace_id
            )
          )
            AND owned.owner_user_id = v_human_user_id
            AND (
              owned.principal_id = reply.to_agent_principal_id OR
              (reply.from_kind = 'agent' AND owned.principal_id = reply.from_principal)
            )
        )
      ))
      OR
      (v_agent_principal_id IS NOT NULL
       AND (reply.channel_id IS NULL OR swarm.actor_can_access_channel(p_workspace_id, reply.channel_id, 'agent', v_agent_principal_id))
       AND (
        reply.to_agent_principal_id = v_agent_principal_id OR
        (reply.from_kind = 'agent' AND reply.from_principal = v_agent_principal_id)
      ))
    );

  RETURN v_result || jsonb_build_object('replies', v_replies);
END;
$$;

ALTER FUNCTION swarm_read.signal_delivery_receipts(uuid, uuid, bytea) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm_read.signal_delivery_receipts(uuid, uuid, bytea)
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT EXECUTE ON FUNCTION swarm_read.signal_delivery_receipts(uuid, uuid, bytea)
  TO authenticated, swarm_read;

-- 3. swarm_read.home_overview: 20261113000003_private_channels.sql (1926-2131) unchanged except
-- the agent's workspace in two places: an ask stays answered when the viewer's agent answered it
-- here, and a to-do assigned to the viewer's agent here waits on the viewer when it is held, or when
-- the agent is removed (from this workspace or altogether).
-- Agents and their queues already came from swarm_read.agent_principals, which follows
-- memberships.
CREATE OR REPLACE FUNCTION swarm_read.home_overview() RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog AS $$
DECLARE
 claims jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
 viewer uuid;
 read_at timestamptz := statement_timestamp();
 workspace record;
 can_read boolean;
 last_seen timestamptz;
 new_messages integer;
 content jsonb;
 people jsonb;
 asks jsonb;
 assigned jsonb;
 waiting jsonb;
 result jsonb := '[]'::jsonb;
BEGIN
 IF claims IS NULL OR claims->>'role' IS DISTINCT FROM 'authenticated'
  OR claims ? 'agent_principal_id' OR nullif(claims->>'sub', '') IS NULL THEN
  RETURN NULL;
 END IF;
 IF claims->>'sub' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN NULL; END IF;
 viewer := (claims->>'sub')::uuid;
 FOR workspace IN
  SELECT w.workspace_id, w.name, m.role
  FROM swarm.workspaces w JOIN swarm.memberships m USING (workspace_id)
  WHERE m.user_id = viewer AND m.revoked_at IS NULL AND w.archived_at IS NULL
  ORDER BY w.created_at, w.workspace_id LIMIT 50
 LOOP
  can_read := swarm.household_human_can_read(workspace.workspace_id, viewer);
  SELECT max(r.first_seen_at) INTO last_seen FROM swarm.signal_human_receipts r
   WHERE r.workspace_id = workspace.workspace_id AND r.user_id = viewer;
  SELECT count(*) INTO new_messages FROM (
   SELECT s.id FROM swarm_read.signals s
   WHERE s.workspace_id = workspace.workspace_id
    AND NOT (s.from_kind = 'user' AND s."from" = viewer)
    AND s.created_at > coalesce(last_seen, read_at - interval '7 days')
   LIMIT 99
  ) messages;
  SELECT coalesce(jsonb_agg(a.value ORDER BY a.created_at DESC, a.id), '[]'::jsonb) INTO asks FROM (
   SELECT s.id, s.created_at, jsonb_build_object('signal_id', s.id,
    'from', jsonb_build_object('kind', s.from_kind, 'id', s."from"),
    'created_at', s.created_at, 'until', s.until) AS value
   FROM swarm_read.signals s
   WHERE s.workspace_id = workspace.workspace_id AND s.kind = 'ask' AND s.until > read_at
    AND (s."to" = viewer OR EXISTS (
     SELECT 1 FROM swarm.signal_recipients r WHERE r.workspace_id = s.workspace_id
      AND r.signal_id = s.id AND r.recipient_user_id = viewer))
    AND NOT EXISTS (
     SELECT 1 FROM swarm.signals reply WHERE reply.workspace_id = s.workspace_id AND reply.in_reply_to = s.id
      AND ((reply.from_kind = 'user' AND reply.from_principal = viewer)
       OR (reply.from_kind = 'agent' AND EXISTS (
        SELECT 1 FROM swarm.agent_principals p WHERE (p.workspace_id = reply.workspace_id
          OR EXISTS (SELECT 1 FROM swarm.agent_workspace_memberships seat WHERE seat.principal_id = p.principal_id
           AND seat.owner_user_id = p.owner_user_id AND seat.workspace_id = reply.workspace_id))
         AND p.principal_id = reply.from_principal AND p.owner_user_id = viewer))))
   ORDER BY s.created_at DESC, s.id LIMIT 10
  ) a;
  content := NULL;
  assigned := '[]'::jsonb;
  waiting := '[]'::jsonb;
  IF can_read THEN
   SELECT jsonb_build_object('open_todos', (
    SELECT count(*) FROM swarm.household_todos t WHERE t.workspace_id = workspace.workspace_id AND t.state IN ('open','doing')),
    'lists', count(*) FILTER (WHERE o.value->>'kind' = 'list'),
    'docs', count(*) FILTER (WHERE o.value->>'kind' = 'doc'),
    'files', count(*) FILTER (WHERE o.value->>'kind' = 'file')) INTO content
   FROM swarm.household_object_streams os
   CROSS JOIN LATERAL jsonb_each(coalesce(os.projection->'objects', '{}'::jsonb)) o
   WHERE os.workspace_id = workspace.workspace_id;
   SELECT coalesce(jsonb_agg(a.value ORDER BY a.state_at DESC, a.todo_id), '[]'::jsonb) INTO assigned FROM (
    SELECT t.todo_id, t.state_at, jsonb_build_object('todo_id',t.todo_id,'title',t.title,'state',t.state,'due_on',t.due_on) value
    FROM swarm.household_todos t WHERE t.workspace_id = workspace.workspace_id
     AND t.assignee_user = viewer AND t.state IN ('open','doing')
    ORDER BY t.state_at DESC, t.todo_id LIMIT 20
   ) a;
   SELECT coalesce(jsonb_agg(a.value ORDER BY a.state_at DESC, a.todo_id, a.reason), '[]'::jsonb) INTO waiting FROM (
    SELECT t.todo_id, t.state_at, reason.kind AS reason,
     jsonb_build_object('todo_id',t.todo_id,'title',t.title,'state',t.state,'due_on',t.due_on,
      'reason',reason.kind,'agent_id', CASE WHEN reason.kind = 'request' THEN t.offer_principal ELSE t.assignee_principal END) value
    FROM swarm.household_todos t
    -- The assignee as this workspace sees it: removed when the agent is, or when it is removed from here.
    LEFT JOIN LATERAL (
     SELECT ap.owner_user_id, coalesce(ap.revoked_at, seat.revoked_at) AS revoked_at
     FROM swarm.agent_principals ap
     LEFT JOIN swarm.agent_workspace_memberships seat ON seat.principal_id = ap.principal_id
      AND seat.owner_user_id = ap.owner_user_id AND seat.workspace_id = t.workspace_id
     WHERE ap.principal_id = t.assignee_principal
      AND (ap.workspace_id = t.workspace_id OR seat.principal_id IS NOT NULL)
    ) p ON true
    CROSS JOIN LATERAL (
     SELECT CASE
     WHEN t.offer_id IS NOT NULL AND t.offer_decider = viewer THEN 'request'
     WHEN t.gate_kind = 'after' AND EXISTS (
      SELECT 1 FROM swarm.household_todos prerequisite WHERE prerequisite.workspace_id = t.workspace_id
       AND prerequisite.todo_id = t.gate_todo_id AND prerequisite.assignee_user = viewer AND prerequisite.state IN ('open','doing')) THEN 'after'
     WHEN t.gate_kind = 'hold' AND p.owner_user_id = viewer AND p.revoked_at IS NULL THEN 'hold'
     WHEN p.owner_user_id = viewer AND p.revoked_at IS NOT NULL THEN 'agent_removed'
     END AS kind
    ) reason
    WHERE t.workspace_id = workspace.workspace_id AND t.state IN ('open','doing') AND reason.kind IS NOT NULL
    ORDER BY t.state_at DESC, t.todo_id, reason.kind LIMIT 20
   ) a;
  END IF;
  WITH members AS MATERIALIZED (
   SELECT m.user_id, m.role, u.display_name FROM swarm.memberships m JOIN swarm.users u USING (user_id)
   WHERE m.workspace_id = workspace.workspace_id AND m.revoked_at IS NULL
   ORDER BY (m.user_id = viewer) DESC, m.user_id LIMIT 25
  ), agents AS MATERIALIZED (
   SELECT p.* FROM swarm_read.agent_principals p JOIN members m ON m.user_id = p.owner_user_id
   WHERE p.workspace_id = workspace.workspace_id
   ORDER BY (p.owner_user_id = viewer) DESC, p.owner_user_id, p.principal_id LIMIT 50
  ), todo_facts AS MATERIALIZED (
   SELECT t.*, CASE t.gate_kind
    WHEN 'none' THEN true WHEN 'hold' THEN false WHEN 'at' THEN t.gate_at <= read_at
    WHEN 'after' THEN EXISTS (SELECT 1 FROM swarm.household_todos predecessor
     WHERE predecessor.workspace_id = t.workspace_id AND predecessor.todo_id = t.gate_todo_id AND predecessor.state IN ('done','dropped'))
    ELSE false END AS gate_clear
   FROM swarm.household_todos t WHERE t.workspace_id = workspace.workspace_id
  ), agent_facts AS (
   SELECT p.*, connection.kind AS connection,
    CASE WHEN p.transport='hosted_mcp' AND hosted_policy.grant_id IS NOT NULL THEN
      jsonb_build_object('connection_expires_at',hosted_policy.connection_expires_at,
        'connection_expired_at',coalesce(hosted_policy.connection_expired_at,
          CASE WHEN hosted_policy.connection_expires_at<=clock_timestamp() THEN hosted_policy.connection_expires_at END))
    WHEN p.transport='local' AND local_policy.renewal_grant_id IS NOT NULL THEN
      jsonb_build_object('renewal_grant_id',local_policy.renewal_grant_id,
        'connection_expires_at',local_policy.connection_expires_at,
        'connection_expired_at',coalesce(local_policy.connection_expired_at,
          CASE WHEN local_policy.connection_expires_at<=clock_timestamp() THEN local_policy.connection_expires_at END))
        || CASE WHEN selected.selected_token_id IS NOT NULL THEN jsonb_build_object('token_id',selected.selected_token_id) ELSE '{}'::jsonb END
    WHEN p.transport='local' AND selected.selected_token_id IS NOT NULL THEN
      jsonb_build_object('renewal_grant_id',NULL,'token_id',selected.selected_token_id)
    ELSE '{}'::jsonb END AS connection_policy,
    greatest(presence.last_command_at,
     (SELECT max(s.created_at) FROM swarm.signals s
      WHERE s.workspace_id = p.workspace_id AND s.from_kind = 'agent' AND s.from_principal = p.principal_id
        AND (s.channel_id IS NULL OR swarm.actor_can_access_channel(s.workspace_id, s.channel_id, 'user', viewer))),
     (SELECT max(greatest(b.created_at,b.acknowledged_at)) FROM swarm.hosted_mcp_check_batches b
      WHERE b.workspace_id = p.workspace_id AND b.principal_id = p.principal_id
        AND (cardinality(b.signal_ids) = 0 OR EXISTS (
         SELECT 1 FROM unnest(b.signal_ids) AS sid
         JOIN swarm.signals bs ON bs.workspace_id = b.workspace_id AND bs.id = sid
         WHERE bs.channel_id IS NULL OR swarm.actor_can_access_channel(bs.workspace_id, bs.channel_id, 'user', viewer)))),
     (SELECT max(e.occurred_at) FROM swarm.household_todo_events e WHERE e.workspace_id = p.workspace_id AND e.event->>'actor_agent_principal' = p.principal_id::text),
     (SELECT to_timestamp(max((e.event->>'occurred_at_server')::numeric)/1000) FROM swarm.household_object_events e
      WHERE e.workspace_id = p.workspace_id AND e.event->>'actor_agent_principal' = p.principal_id::text)) AS last_activity_at,
    (SELECT min(d.enqueued_at) FROM swarm.signal_deliveries d JOIN swarm.signals s ON s.workspace_id = d.workspace_id AND s.id = d.signal_id
     WHERE d.workspace_id = p.workspace_id AND d.recipient_agent_principal_id = p.principal_id AND d.acked_at IS NULL AND s.until > read_at
       AND (s.channel_id IS NULL OR swarm.actor_can_access_channel(s.workspace_id, s.channel_id, 'user', viewer))) AS messages_waiting_since,
    doing.value AS doing, working.value AS working_on,
    CASE WHEN can_read THEN jsonb_build_object(
     'working',(SELECT count(*) FROM todo_facts t WHERE t.assignee_principal = p.principal_id AND t.state = 'doing'),
     'up_next',(SELECT count(*) FROM todo_facts t WHERE t.assignee_principal = p.principal_id AND t.state = 'open' AND t.gate_clear),
     'not_yet',(SELECT count(*) FROM todo_facts t WHERE t.assignee_principal = p.principal_id AND t.state = 'open' AND NOT t.gate_clear),
     'requests',(SELECT count(*) FROM todo_facts t WHERE t.offer_principal = p.principal_id AND t.offer_id IS NOT NULL AND t.state IN ('open','doing'))) ELSE NULL END AS queue
   FROM agents p
   LEFT JOIN swarm.agent_presence presence ON presence.workspace_id = p.workspace_id AND presence.principal_id = p.principal_id
   LEFT JOIN LATERAL (
    SELECT jsonb_build_object('todo_id',t.todo_id,'title',CASE WHEN can_read THEN t.title ELSE NULL END,'since',t.state_at) value
    FROM todo_facts t WHERE t.assignee_principal = p.principal_id AND t.state = 'doing'
    ORDER BY t.state_at DESC, t.todo_id LIMIT 1
   ) doing ON true
   LEFT JOIN LATERAL (
    SELECT jsonb_build_object('signal_id',s.id,'at',s.created_at,'until',s.until) value
    FROM swarm_read.signals s WHERE s.workspace_id = p.workspace_id AND s.from_kind = 'agent' AND s."from" = p.principal_id
     AND s.kind = 'working-on' AND s.until > read_at ORDER BY s.created_at DESC, s.id LIMIT 1
   ) working ON true
   LEFT JOIN LATERAL swarm_read.local_connection_selection(p.workspace_id,p.principal_id,p.owner_user_id)
    selected ON p.transport='local'
   LEFT JOIN swarm.renewal_grants local_policy
    ON local_policy.renewal_grant_id=selected.selected_renewal_grant_id
   LEFT JOIN LATERAL swarm.hosted_connection_policy(p.workspace_id,p.principal_id,p.owner_user_id)
    hosted_policy ON p.transport='hosted_mcp'
   CROSS JOIN LATERAL (
    SELECT CASE
     WHEN p.revoked_at IS NOT NULL THEN 'removed'
     WHEN p.transport = 'hosted_mcp' THEN CASE
      WHEN hosted_policy.seat_revoked_at IS NULL AND hosted_policy.binding_revoked_at IS NULL
       AND hosted_policy.revoked_at IS NULL AND hosted_policy.state='active'
       AND hosted_policy.connection_expired_at IS NULL
       AND (hosted_policy.connection_expires_at IS NULL OR hosted_policy.connection_expires_at>clock_timestamp())
      THEN 'live' ELSE 'connection_off' END
     WHEN selected.is_live THEN 'live'
     WHEN local_policy.connection_expired_at IS NOT NULL OR local_policy.connection_expires_at<=clock_timestamp() THEN 'key_ended'
     WHEN local_policy.revoked_at IS NULL AND local_policy.suspension_active
      AND local_policy.connection_expired_at IS NULL
      AND (local_policy.connection_expires_at IS NULL OR local_policy.connection_expires_at>clock_timestamp()) THEN 'paused'
     WHEN local_policy.revoked_at IS NOT NULL THEN 'key_off'
     WHEN EXISTS (SELECT 1 FROM swarm.agent_tokens token WHERE token.principal_id = p.principal_id AND token.revoked_at IS NULL)
      THEN 'key_ended' ELSE 'key_off' END AS kind
   ) connection
  ), rows AS (
   SELECT m.*, coalesce((SELECT jsonb_agg(jsonb_build_object('principal_id',a.principal_id,'name',a.name,
    'status',jsonb_build_object('work',CASE WHEN a.connection <> 'live' THEN 'disconnected'
     WHEN (a.doing IS NOT NULL OR a.working_on IS NOT NULL) AND a.last_activity_at >= read_at - interval '30 minutes' THEN 'working' ELSE 'idle' END,
     'facts',jsonb_build_object('transport',a.transport,'turn_only',a.turn_only,'connection',a.connection,
      'last_activity_at',a.last_activity_at,'messages_waiting_since',a.messages_waiting_since,'doing',a.doing,'working_on',a.working_on) || a.connection_policy),
    'queue',a.queue) ORDER BY a.principal_id) FROM agent_facts a WHERE a.owner_user_id = m.user_id),'[]'::jsonb) AS agents
   FROM members m
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('user_id',r.user_id,'display_name',r.display_name,'role',r.role,
   'is_viewer',r.user_id = viewer,'agents',r.agents) ORDER BY (r.user_id = viewer) DESC,r.user_id),'[]'::jsonb) INTO people FROM rows r;
  result := result || jsonb_build_array(jsonb_build_object('workspace_id',workspace.workspace_id,'name',workspace.name,'role',workspace.role,
   'last_seen_at',last_seen,'new_messages',new_messages,'content',content,'people',people,
   'needs_you',jsonb_build_object('asks',asks,'assigned',assigned,'waiting',waiting)));
 END LOOP;
 RETURN jsonb_build_object('viewer_user_id',viewer,'generated_at',read_at,'workspaces',result);
END;
$$;

ALTER FUNCTION swarm_read.home_overview() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm_read.home_overview()
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT EXECUTE ON FUNCTION swarm_read.home_overview() TO authenticated;
