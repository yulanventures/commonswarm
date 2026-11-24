-- Rollback for 20261125000001 (ask_withdrawals + dismissal instance):
-- Restores swarm.waiting_ask_autoclear_status exactly from 20261124000002_waiting_autoclear.sql,
-- restores swarm.dismiss_waiting_item and swarm.restore_waiting_item(uuid,uuid,text,uuid)
-- exactly from 20261124000001_waiting_dismissals.sql, drops the 5-arg restore_waiting_item
-- overload, drops dismissal_id from swarm.waiting_dismissals, and drops swarm_read.my_open_asks,
-- swarm.withdraw_ask, swarm.ask_is_withdrawn, swarm.ask_withdrawals, and its validator trigger.
SET search_path = swarm, pg_catalog, public;

-- Restore swarm.waiting_ask_autoclear_status from 20261124000002_waiting_autoclear.sql
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
    SELECT
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
  ORDER BY cand.archived_at ASC, cand.prio ASC
  LIMIT 1;
$$;

ALTER FUNCTION swarm.waiting_ask_autoclear_status(uuid, uuid, timestamptz) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.waiting_ask_autoclear_status(uuid, uuid, timestamptz)
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;

-- Restore swarm.dismiss_waiting_item from 20261124000001_waiting_dismissals.sql
CREATE OR REPLACE FUNCTION swarm.dismiss_waiting_item(
  p_workspace_id uuid,
  p_user_id uuid,
  p_item_kind text,
  p_item_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_now timestamptz := statement_timestamp();
  v_dismissed_at timestamptz;
BEGIN
  IF p_workspace_id IS NULL OR p_user_id IS NULL OR p_item_id IS NULL
     OR p_item_kind IS NULL OR p_item_kind NOT IN ('ask', 'todo', 'review') THEN
    RETURN jsonb_build_object('status', 'invalid_request');
  END IF;

  IF NOT swarm.is_member(p_workspace_id, p_user_id) THEN
    RETURN jsonb_build_object('status', 'forbidden');
  END IF;

  IF NOT swarm.waiting_item_eligible(p_workspace_id, p_user_id, p_item_kind, p_item_id, v_now) THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  BEGIN
    INSERT INTO swarm.waiting_dismissals (
      workspace_id, user_id, item_kind, item_id, dismissed_at, restored_at, updated_at
    ) VALUES (
      p_workspace_id, p_user_id, p_item_kind, p_item_id, v_now, NULL, v_now
    )
    ON CONFLICT (workspace_id, user_id, item_kind, item_id) DO UPDATE
    SET
      dismissed_at = CASE
        WHEN swarm.waiting_dismissals.restored_at IS NULL THEN swarm.waiting_dismissals.dismissed_at
        ELSE v_now
      END,
      restored_at = NULL,
      updated_at = v_now
    RETURNING dismissed_at INTO v_dismissed_at;

    -- Re-verify authority in a fresh READ COMMITTED snapshot after the row write completes.
    IF NOT swarm.is_member(p_workspace_id, p_user_id) THEN
      RAISE EXCEPTION 'waiting_dismissal_forbidden' USING ERRCODE = 'P0001';
    END IF;
    IF NOT swarm.waiting_item_eligible(p_workspace_id, p_user_id, p_item_kind, p_item_id, clock_timestamp()) THEN
      RAISE EXCEPTION 'waiting_item_not_found' USING ERRCODE = 'P0001';
    END IF;
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN
      IF SQLERRM = 'waiting_dismissal_forbidden' THEN
        RETURN jsonb_build_object('status', 'forbidden');
      END IF;
      RETURN jsonb_build_object('status', 'not_found');
  END;

  RETURN jsonb_build_object(
    'status', 'ok',
    'item_kind', p_item_kind,
    'item_id', p_item_id,
    'dismissed', true,
    'dismissed_at', v_dismissed_at
  );
END;
$$;

ALTER FUNCTION swarm.dismiss_waiting_item(uuid, uuid, text, uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.dismiss_waiting_item(uuid, uuid, text, uuid)
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT EXECUTE ON FUNCTION swarm.dismiss_waiting_item(uuid, uuid, text, uuid) TO swarm_command;

-- Restore swarm.restore_waiting_item(4-arg) from 20261124000001_waiting_dismissals.sql
CREATE OR REPLACE FUNCTION swarm.restore_waiting_item(
  p_workspace_id uuid,
  p_user_id uuid,
  p_item_kind text,
  p_item_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_now timestamptz := statement_timestamp();
  v_changed integer := 0;
BEGIN
  IF p_workspace_id IS NULL OR p_user_id IS NULL OR p_item_id IS NULL
     OR p_item_kind IS NULL OR p_item_kind NOT IN ('ask', 'todo', 'review') THEN
    RETURN jsonb_build_object('status', 'invalid_request');
  END IF;

  IF NOT swarm.is_member(p_workspace_id, p_user_id) THEN
    RETURN jsonb_build_object('status', 'forbidden');
  END IF;

  IF NOT swarm.waiting_item_eligible(p_workspace_id, p_user_id, p_item_kind, p_item_id, v_now) THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  BEGIN
    UPDATE swarm.waiting_dismissals
    SET
      restored_at = v_now,
      updated_at = v_now
    WHERE workspace_id = p_workspace_id
      AND user_id = p_user_id
      AND item_kind = p_item_kind
      AND item_id = p_item_id
      AND restored_at IS NULL;
    GET DIAGNOSTICS v_changed = ROW_COUNT;

    IF v_changed = 0 THEN
      RAISE EXCEPTION 'waiting_item_not_found' USING ERRCODE = 'P0001';
    END IF;

    -- Re-verify authority in a fresh READ COMMITTED snapshot after the row write completes.
    IF NOT swarm.is_member(p_workspace_id, p_user_id) THEN
      RAISE EXCEPTION 'waiting_dismissal_forbidden' USING ERRCODE = 'P0001';
    END IF;
    IF NOT swarm.waiting_item_eligible(p_workspace_id, p_user_id, p_item_kind, p_item_id, clock_timestamp()) THEN
      RAISE EXCEPTION 'waiting_item_not_found' USING ERRCODE = 'P0001';
    END IF;
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN
      IF SQLERRM = 'waiting_dismissal_forbidden' THEN
        RETURN jsonb_build_object('status', 'forbidden');
      END IF;
      RETURN jsonb_build_object('status', 'not_found');
  END;

  RETURN jsonb_build_object(
    'status', 'ok',
    'item_kind', p_item_kind,
    'item_id', p_item_id,
    'restored', true,
    'restored_at', v_now
  );
END;
$$;

ALTER FUNCTION swarm.restore_waiting_item(uuid, uuid, text, uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.restore_waiting_item(uuid, uuid, text, uuid)
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT EXECUTE ON FUNCTION swarm.restore_waiting_item(uuid, uuid, text, uuid) TO swarm_command;

DROP FUNCTION IF EXISTS swarm.restore_waiting_item(uuid, uuid, text, uuid, uuid);
ALTER TABLE swarm.waiting_dismissals DROP COLUMN IF EXISTS dismissal_id;

DROP FUNCTION IF EXISTS swarm_read.my_open_asks(uuid, integer, timestamptz, uuid, bytea);
DROP FUNCTION IF EXISTS swarm.withdraw_ask(uuid, text, uuid, uuid, uuid);
DROP FUNCTION IF EXISTS swarm.ask_is_withdrawn(uuid, uuid);
DROP TRIGGER IF EXISTS ask_withdrawals_validate_refs ON swarm.ask_withdrawals;
DROP TABLE IF EXISTS swarm.ask_withdrawals;
DROP FUNCTION IF EXISTS swarm.ask_withdrawal_validate_refs();

RESET search_path;
