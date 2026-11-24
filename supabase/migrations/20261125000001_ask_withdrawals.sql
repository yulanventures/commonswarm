-- Sender ask withdrawal & replacement, plus dismissal instance binding (HezSec C1 on #735):
--   1. swarm.ask_withdrawals records a sender's explicit withdrawal (or replacement by a newer
--      ask) of its own open ask. No client role can read or write it directly.
--   2. swarm.ask_is_withdrawn (swarm_command only) lets command handlers refuse answering or
--      re-raising a withdrawn/replaced ask with the same refusal semantics as an expired/closed ask.
--   3. Internal withdrawal helpers (swarm_admin-owned, no client roles; ask_complete_for_withdrawal
--      is owner-only with no runtime-role EXECUTE grants, while the other three grant swarm_command
--      EXECUTE only):
--      - swarm.ask_sender_can_access_placement: exact sender, live workspace authority, canonical
--        channel access (non-archived), direct/group conversation membership via
--        swarm.actor_can_access_direct_conversation (non-archived), or explicit legacy unfiled fallback.
--      - swarm.ask_complete_for_withdrawal (owner-only, called only inside swarm.withdraw_ask and
--        swarm_read.my_open_asks): true when swarm.ask_answered is true, a choice action completed
--        in swarm.ui_actions, or a directly addressed agent replied (without changing
--        swarm.ask_answered or any Waiting rule).
--      - swarm.ask_withdrawal_release_allowed: exact sender, live placement access, and existing
--        withdrawal row by this actor (with expected replacement id when expected) for post-fence
--        release rechecks (requiring s.until > clock_timestamp() on fresh paths) and receipt
--        replay reauthorization (deliberately omitting the deadline check on replays).
--      - swarm.ask_withdrawal_effective_channel_ids: given a workspace and an array of signal ids,
--        returns the distinct effective channel ids, coalesce(canonical conversation's channel,
--        scalar channel), with no actor or access check so withdrawal/replacement audit tags stay
--        intact on fresh, replay, and conflict paths even after access loss.
--   4. swarm.withdraw_ask (swarm_command only) enforces exact sender identity (same agent principal
--      or same person; never another agent of the same owner, never the agent's owner, never an
--      admin), requires current placement access and an open/incomplete target (uniform not_found
--      otherwise), makes plain repeated withdrawal idempotent (one row), rejects already-withdrawn
--      targets on replace, and re-verifies live authority/state after the row write under READ COMMITTED.
--   5. swarm.waiting_ask_autoclear_status adds outcomes 'withdrawn' ('Withdrawn') and 'replaced'
--      ('Replaced by a newer question') with explicit_rank = 0, taking precedence over all
--      passive auto-clear reasons because withdrawal/replacement is the sender's explicit act.
--      swarm.waiting_ask_eligible, decision_queue*, home_overview, waiting_archived_page, and
--      waiting dismissal/restore/replay all inherit this automatically.
--   6. swarm_read.my_open_asks (swarm_read EXECUTE only; served through the read edge, no direct
--      authenticated PostgREST RPC grant) lists only the caller's own open asks (person via JWT
--      claims installed by the read edge, agent via agent token hash or verified
--      agent_principal_id claim) using the shared placement and completion helpers, capped and
--      keyset-paged, returning id, created_at, until, addressee names, where label, and first 120
--      chars of body (never exposing addressee dismissals).
--   7. swarm_read.audit_log adds one condition so withdraw_ask rows are visible only when they
--      carry at least one channel tag (direct/group-conversation and unfiled withdrawals stay
--      server-only in swarm.audit_log).
--   8. swarm.waiting_dismissals gains dismissal_id uuid (unique per dismissal instance) so
--      swarm.dismiss_waiting_item reports created (true|false) and dismissal (uuid instance),
--      and swarm.restore_waiting_item(ws, user, kind, id, expected_dismissal_id) restores only
--      when the active dismissal matches expected_dismissal_id (or any active dismissal when NULL).
--   9. swarm_read.waiting_todos_page includes offer_id on rows whose reason is 'request' (and
--      omits the offer_id key on other rows) so reviews can participate in Dismiss all.
SET search_path = swarm, pg_catalog, public;

CREATE TABLE swarm.ask_withdrawals (
  workspace_id uuid NOT NULL,
  signal_id uuid NOT NULL,
  withdrawn_by_kind text NOT NULL CHECK (withdrawn_by_kind IN ('user', 'agent')),
  withdrawn_by uuid NOT NULL,
  replaced_by_signal_id uuid,
  withdrawn_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (workspace_id, signal_id),
  CHECK (replaced_by_signal_id IS NULL OR replaced_by_signal_id <> signal_id)
);

-- Read-only MVCC reference validator (zero parent row locks).
CREATE FUNCTION swarm.ask_withdrawal_validate_refs()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM swarm.workspaces AS w WHERE w.workspace_id = NEW.workspace_id
  ) THEN
    RAISE EXCEPTION 'ask_withdrawal workspace % does not exist', NEW.workspace_id
      USING ERRCODE = '23503';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM swarm.signals AS s
    WHERE s.workspace_id = NEW.workspace_id
      AND s.id = NEW.signal_id
      AND s.kind = 'ask'
  ) THEN
    RAISE EXCEPTION 'ask_withdrawal signal % is not an ask in workspace %', NEW.signal_id, NEW.workspace_id
      USING ERRCODE = '23503';
  END IF;
  IF NEW.replaced_by_signal_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM swarm.signals AS r
    WHERE r.workspace_id = NEW.workspace_id
      AND r.id = NEW.replaced_by_signal_id
      AND r.kind = 'ask'
  ) THEN
    RAISE EXCEPTION 'ask_withdrawal replacement signal % is not an ask in workspace %',
      NEW.replaced_by_signal_id, NEW.workspace_id
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER ask_withdrawals_validate_refs
  BEFORE INSERT OR UPDATE ON swarm.ask_withdrawals
  FOR EACH ROW EXECUTE FUNCTION swarm.ask_withdrawal_validate_refs();

ALTER TABLE swarm.ask_withdrawals OWNER TO swarm_admin;
ALTER TABLE swarm.ask_withdrawals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE swarm.ask_withdrawals FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;

ALTER FUNCTION swarm.ask_withdrawal_validate_refs() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.ask_withdrawal_validate_refs()
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;

-- Narrow existence predicate for command handlers (answer_choice, plain reply, reraise_ask).
CREATE FUNCTION swarm.ask_is_withdrawn(
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

-- Latest prior definition: 20261124000002_waiting_autoclear.sql
-- Single-source read-time auto-clear classifier for an ask (internal, swarm_admin only).
-- Explicit sender withdrawal/replacement (explicit_rank = 0) takes precedence over all passive
-- auto-clear reasons (explicit_rank = 1) because it is the sender's deliberate act.
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

-- C1 single-source placement predicate for sender ask listing, withdrawal, replacement, and replay
-- (internal: swarm_admin-owned, swarm_command EXECUTE only; never granted to client roles).
-- Answers whether this exact sender currently has live workspace authority and current access to
-- the ask's effective conversation (non-archived canonical channel, current direct/group
-- conversation membership via swarm.actor_can_access_direct_conversation, non-archived general, or
-- explicit legacy unfiled fallback).
CREATE FUNCTION swarm.ask_sender_can_access_placement(
  p_workspace_id uuid,
  p_signal_id uuid,
  p_actor_kind text,
  p_actor_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_actor_live boolean;
  v_place record;
BEGIN
  IF p_workspace_id IS NULL OR p_signal_id IS NULL OR p_actor_id IS NULL
     OR p_actor_kind IS NULL OR p_actor_kind NOT IN ('user', 'agent') THEN
    RETURN false;
  END IF;

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
    RETURN false;
  END IF;

  SELECT
    s.channel_id AS scalar_channel_id,
    c.conversation_id,
    c.kind AS conv_kind,
    c.channel_id AS conv_channel_id,
    c.archived_at AS conv_archived_at,
    ch.channel_id AS eff_channel_id,
    ch.archived_at AS eff_channel_archived_at
  INTO v_place
  FROM swarm.signals AS s
  LEFT JOIN swarm.conversation_signals AS cs
    ON cs.workspace_id = s.workspace_id
    AND cs.signal_id = s.id
  LEFT JOIN swarm.conversations AS c
    ON c.workspace_id = s.workspace_id
    AND c.conversation_id = cs.conversation_id
  LEFT JOIN swarm.channels AS ch
    ON ch.workspace_id = s.workspace_id
    AND ch.channel_id = coalesce(c.channel_id, s.channel_id)
  WHERE s.workspace_id = p_workspace_id
    AND s.id = p_signal_id
    AND s.kind = 'ask'
    AND s.from_kind = p_actor_kind
    AND s.from_principal = p_actor_id
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF v_place.conversation_id IS NOT NULL THEN
    IF v_place.conv_archived_at IS NOT NULL THEN
      RETURN false;
    END IF;

    IF v_place.conv_kind IN ('public_channel', 'private_channel') THEN
      RETURN v_place.conv_channel_id IS NOT NULL
        AND v_place.eff_channel_id IS NOT NULL
        AND v_place.eff_channel_archived_at IS NULL
        AND swarm.actor_can_access_channel(
          p_workspace_id, v_place.conv_channel_id, p_actor_kind, p_actor_id
        );
    ELSIF v_place.conv_kind IN ('dm', 'group_dm') THEN
      -- Reuse the canonical direct-conversation membership predicate from 20261120000002_waiting_dm_convergence.sql.
      RETURN v_place.scalar_channel_id IS NULL
        AND swarm.actor_can_access_direct_conversation(
          p_workspace_id, v_place.conversation_id, v_place.conv_kind, p_actor_kind, p_actor_id
        );
    ELSIF v_place.conv_kind = 'general' THEN
      IF v_place.scalar_channel_id IS NOT NULL THEN
        RETURN v_place.eff_channel_id IS NOT NULL
          AND v_place.eff_channel_archived_at IS NULL
          AND swarm.actor_can_access_channel(
            p_workspace_id, v_place.scalar_channel_id, p_actor_kind, p_actor_id
          );
      END IF;
      RETURN true;
    ELSE
      RETURN false;
    END IF;
  END IF;

  IF v_place.scalar_channel_id IS NOT NULL THEN
    RETURN v_place.eff_channel_id IS NOT NULL
      AND v_place.eff_channel_archived_at IS NULL
      AND swarm.actor_can_access_channel(
        p_workspace_id, v_place.scalar_channel_id, p_actor_kind, p_actor_id
      );
  END IF;

  -- Explicit fallback for legacy asks filed in neither swarm.conversation_signals nor a scalar
  -- channel: exact sender with live workspace authority (verified above).
  RETURN true;
END;
$$;

ALTER FUNCTION swarm.ask_sender_can_access_placement(uuid, uuid, text, uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.ask_sender_can_access_placement(uuid, uuid, text, uuid)
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT EXECUTE ON FUNCTION swarm.ask_sender_can_access_placement(uuid, uuid, text, uuid) TO swarm_command;

-- C2 single-source completion predicate for sender withdrawal and my_open_asks (internal:
-- swarm_admin-owned, owner-only with no runtime-role EXECUTE grants — called only inside the
-- swarm_admin-owned SECURITY DEFINER functions swarm.withdraw_ask and swarm_read.my_open_asks;
-- preserves swarm.ask_answered and all Waiting rules).
-- True when swarm.ask_answered is true, OR a choice action on this ask has completed in
-- swarm.ui_actions (including an unaddressed choice ask), OR a directly addressed agent replied.
CREATE FUNCTION swarm.ask_complete_for_withdrawal(
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
      swarm.ask_answered(p_workspace_id, p_signal_id)
      OR EXISTS (
        SELECT 1
        FROM swarm.ui_actions AS ua
        WHERE ua.workspace_id = p_workspace_id
          AND ua.signal_id = p_signal_id
          AND ua.state = 'completed'
      )
      OR EXISTS (
        SELECT 1
        FROM swarm.signals AS s
        CROSS JOIN LATERAL (
          SELECT s.to_agent_principal_id AS agent_id
          WHERE s.to_agent_principal_id IS NOT NULL
          UNION
          SELECT r.recipient_agent_principal_id AS agent_id
          FROM swarm.signal_recipients AS r
          WHERE r.workspace_id = s.workspace_id
            AND r.signal_id = s.id
            AND r.recipient_agent_principal_id IS NOT NULL
        ) AS addressed_agent
        JOIN swarm.signals AS reply
          ON reply.workspace_id = s.workspace_id
          AND reply.in_reply_to = s.id
        WHERE s.workspace_id = p_workspace_id
          AND s.id = p_signal_id
          AND s.kind = 'ask'
          AND NOT (reply.from_kind = s.from_kind AND reply.from_principal = s.from_principal)
          AND reply.from_kind = 'agent'
          AND reply.from_principal = addressed_agent.agent_id
      )
    );
$$;

ALTER FUNCTION swarm.ask_complete_for_withdrawal(uuid, uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.ask_complete_for_withdrawal(uuid, uuid)
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;

-- C3 release & replay reauthorization predicate (command-role only; no client roles).
-- Verifies exact sender, live workspace authority, current placement access (C1), and that the
-- withdrawal row for this ask exists and was recorded by this actor (with the expected replacement
-- signal id when one is expected).
--
-- Fresh vs replay deadline rule (made explicit by p_require_open_deadline):
--   - p_require_open_deadline = true (FRESH paths only: standalone withdraw_ask and both
--     replacement forms, called after the final receipt, audit, spend write and credential fence):
--     also requires the old ask's deadline (`s.until`) to still be in the future on the database
--     clock at that moment (`clock_timestamp()`, not statement start time), so a deadline passing
--     during any wait rolls back the entire transaction.
--   - p_require_open_deadline = false (REPLAY paths only): deliberately performs NO deadline check
--     so an authorized replay may still return the stored receipt of a withdrawal that committed
--     in time after the ask's deadline has passed.
-- Neither mode checks completion because an already-withdrawn ask reads as cleared.
CREATE FUNCTION swarm.ask_withdrawal_release_allowed(
  p_workspace_id uuid,
  p_actor_kind text,
  p_actor_id uuid,
  p_signal_id uuid,
  p_expected_replaced_by_signal_id uuid DEFAULT NULL,
  p_require_open_deadline boolean DEFAULT false
)
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT
    p_workspace_id IS NOT NULL
    AND p_actor_kind IN ('user', 'agent')
    AND p_actor_id IS NOT NULL
    AND p_signal_id IS NOT NULL
    AND p_require_open_deadline IS NOT NULL
    AND swarm.ask_sender_can_access_placement(p_workspace_id, p_signal_id, p_actor_kind, p_actor_id)
    AND EXISTS (
      SELECT 1
      FROM swarm.ask_withdrawals AS aw
      JOIN swarm.signals AS s
        ON s.workspace_id = aw.workspace_id
       AND s.id = aw.signal_id
      WHERE aw.workspace_id = p_workspace_id
        AND aw.signal_id = p_signal_id
        AND aw.withdrawn_by_kind = p_actor_kind
        AND aw.withdrawn_by = p_actor_id
        AND (
          p_expected_replaced_by_signal_id IS NULL
          OR aw.replaced_by_signal_id = p_expected_replaced_by_signal_id
        )
        AND (
          NOT p_require_open_deadline
          OR s.until > clock_timestamp()
        )
    );
$$;

ALTER FUNCTION swarm.ask_withdrawal_release_allowed(uuid, text, uuid, uuid, uuid, boolean) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.ask_withdrawal_release_allowed(uuid, text, uuid, uuid, uuid, boolean)
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT EXECUTE ON FUNCTION swarm.ask_withdrawal_release_allowed(uuid, text, uuid, uuid, uuid, boolean) TO swarm_command;

-- C4 narrow internal effective-channel resolver for withdrawal-related audit tagging
-- (swarm_admin-owned, swarm_command EXECUTE only; never granted to client roles).
-- Returns distinct effective channel ids, coalesce(canonical conversation's channel, scalar
-- channel), for signals in that workspace. Takes no actor and applies no access test so audit
-- tags are preserved even after access loss. Returns channel ids only, never content.
CREATE FUNCTION swarm.ask_withdrawal_effective_channel_ids(
  p_workspace_id uuid,
  p_signal_ids uuid[]
)
RETURNS TABLE (channel_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT DISTINCT coalesce(c.channel_id, s.channel_id) AS channel_id
  FROM swarm.signals AS s
  LEFT JOIN swarm.conversation_signals AS cs
    ON cs.workspace_id = s.workspace_id
   AND cs.signal_id = s.id
  LEFT JOIN swarm.conversations AS c
    ON c.workspace_id = s.workspace_id
   AND c.conversation_id = cs.conversation_id
  WHERE p_workspace_id IS NOT NULL
    AND p_signal_ids IS NOT NULL
    AND s.workspace_id = p_workspace_id
    AND s.id = ANY(p_signal_ids)
    AND coalesce(c.channel_id, s.channel_id) IS NOT NULL
  ORDER BY 1;
$$;

ALTER FUNCTION swarm.ask_withdrawal_effective_channel_ids(uuid, uuid[]) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.ask_withdrawal_effective_channel_ids(uuid, uuid[])
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT EXECUTE ON FUNCTION swarm.ask_withdrawal_effective_channel_ids(uuid, uuid[]) TO swarm_command;

-- Sender withdrawal/replacement of an open ask (command-role only).
-- Enforces exact sender identity (from_kind + from_principal): never another agent of the
-- same owner, never the agent's owner, never a workspace admin. Uses the shared placement (C1)
-- and completion (C2) helpers and re-verifies authority and ask state after acquiring locks /
-- writing under READ COMMITTED.
CREATE FUNCTION swarm.withdraw_ask(
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

-- List only the caller's own open asks in one workspace (capped and keyset-paged; swarm_read
-- EXECUTE only, served through the read edge — no direct PostgREST RPC grant to authenticated).
-- Person identity comes from request.jwt.claims installed by the read edge after GoTrue JWT
-- verification; agent identity comes from p_agent_token_hash (local agent via read edge, matching
-- signal_delivery_receipts) or verified agent_principal_id claim installed by the read edge for a
-- hosted seat.
CREATE FUNCTION swarm_read.my_open_asks(
  p_workspace_id uuid,
  p_limit integer DEFAULT 50,
  p_after_created_at timestamptz DEFAULT NULL,
  p_after_id uuid DEFAULT NULL,
  p_agent_token_hash bytea DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  claims jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  read_at timestamptz := statement_timestamp();
  v_user_id uuid;
  v_agent_principal_id uuid;
  v_agent_workspace_id uuid;
  v_agent_revoked boolean;
  v_sender_kind text;
  v_sender_id uuid;
  page_limit integer;
  total integer;
  has_more boolean;
  rows jsonb;
BEGIN
  IF p_workspace_id IS NULL THEN
    RETURN NULL;
  END IF;

  IF claims IS NOT NULL THEN
    -- A JWT caller can never supply an agent token hash.
    IF p_agent_token_hash IS NOT NULL
       OR claims->>'role' IS DISTINCT FROM 'authenticated'
       OR coalesce(claims->>'sub', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RETURN NULL;
    END IF;
    v_user_id := (claims->>'sub')::uuid;
    IF NOT swarm.is_member(p_workspace_id, v_user_id) THEN
      RETURN NULL;
    END IF;
    IF claims ? 'agent_principal_id' THEN
      IF coalesce(claims->>'agent_principal_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RETURN NULL;
      END IF;
      v_agent_principal_id := (claims->>'agent_principal_id')::uuid;
      IF NOT EXISTS (
        SELECT 1
        FROM swarm.agent_principals AS p
        JOIN swarm.agent_workspace_memberships AS am
          USING (principal_id, owner_user_id)
        WHERE am.workspace_id = p_workspace_id
          AND p.principal_id = v_agent_principal_id
          AND p.owner_user_id = v_user_id
          AND p.revoked_at IS NULL
          AND am.revoked_at IS NULL
      ) THEN
        RETURN NULL;
      END IF;
      v_sender_kind := 'agent';
      v_sender_id := v_agent_principal_id;
    ELSE
      v_sender_kind := 'user';
      v_sender_id := v_user_id;
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
    FROM swarm.agent_delivery_read_context(p_agent_token_hash, p_workspace_id) AS context
    LIMIT 1;

    IF v_agent_principal_id IS NULL
       OR v_agent_revoked
       OR v_agent_workspace_id <> p_workspace_id THEN
      RETURN NULL;
    END IF;
    v_sender_kind := 'agent';
    v_sender_id := v_agent_principal_id;
  END IF;

  IF (p_after_created_at IS NULL) <> (p_after_id IS NULL) THEN
    RAISE EXCEPTION 'my_open_asks cursor requires both p_after_created_at and p_after_id'
      USING ERRCODE = '22023';
  END IF;

  page_limit := greatest(1, least(coalesce(p_limit, 50), 100));

  WITH open_asks AS MATERIALIZED (
    SELECT
      s.id,
      s.workspace_id,
      s.created_at,
      s.until,
      s.body,
      s.to_user_id,
      s.to_agent_principal_id,
      coalesce(raw_c.channel_id, s.channel_id) AS eff_channel_id,
      raw_c.conversation_id,
      raw_c.kind AS conv_kind,
      ch.slug AS channel_slug,
      EXISTS (
        SELECT 1
        FROM swarm.signal_recipients AS r
        WHERE r.workspace_id = s.workspace_id
          AND r.signal_id = s.id
      ) AS has_recipients
    FROM swarm.signals AS s
    LEFT JOIN swarm.conversation_signals AS cs
      ON cs.workspace_id = s.workspace_id AND cs.signal_id = s.id
    LEFT JOIN swarm.conversations AS raw_c
      ON raw_c.workspace_id = s.workspace_id AND raw_c.conversation_id = cs.conversation_id
    LEFT JOIN swarm.channels AS ch
      ON ch.workspace_id = s.workspace_id
      AND ch.channel_id = coalesce(raw_c.channel_id, s.channel_id)
    WHERE s.workspace_id = p_workspace_id
      AND s.kind = 'ask'
      AND s.from_kind = v_sender_kind
      AND s.from_principal = v_sender_id
      AND s.until > read_at
      AND NOT swarm.ask_complete_for_withdrawal(s.workspace_id, s.id)
      AND NOT EXISTS (
        SELECT 1 FROM swarm.waiting_ask_autoclear_status(s.workspace_id, s.id, read_at)
      )
      AND swarm.ask_sender_can_access_placement(s.workspace_id, s.id, v_sender_kind, v_sender_id)
  ),
  anchor AS (
    SELECT coalesce(
      (SELECT oa.created_at FROM open_asks AS oa WHERE oa.id = p_after_id),
      p_after_created_at
    ) AS created_at
  ),
  page_probe AS MATERIALIZED (
    SELECT oa.*
    FROM open_asks AS oa, anchor AS a
    WHERE p_after_id IS NULL
      OR (oa.created_at, oa.id) > (a.created_at, p_after_id)
    ORDER BY oa.created_at ASC, oa.id ASC
    LIMIT page_limit + 1
  ),
  page AS (
    SELECT *
    FROM page_probe
    ORDER BY created_at ASC, id ASC
    LIMIT page_limit
  )
  SELECT
    (SELECT count(*) FROM open_asks)::integer,
    (SELECT count(*) > page_limit FROM page_probe),
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'signal_id', p.id,
          'created_at', p.created_at,
          'until', p.until,
          'addressees', addr.names,
          'where', CASE
            WHEN p.conv_kind IN ('public_channel', 'private_channel') AND p.channel_slug IS NOT NULL
              THEN '#' || p.channel_slug
            WHEN p.conv_kind = 'general' THEN '#general'
            WHEN p.conv_kind = 'dm' THEN 'DM'
            WHEN p.conv_kind = 'group_dm' THEN 'Group DM'
            WHEN p.channel_slug IS NOT NULL THEN '#' || p.channel_slug
            WHEN p.to_user_id IS NOT NULL OR p.to_agent_principal_id IS NOT NULL OR p.has_recipients
              THEN 'DM'
            ELSE '#general'
          END,
          'body_preview', pg_catalog.left(p.body, 120)
        )
        ORDER BY p.created_at ASC, p.id ASC
      ),
      '[]'::jsonb
    )
  INTO total, has_more, rows
  FROM page AS p
  CROSS JOIN LATERAL (
    SELECT coalesce(
      (
        SELECT jsonb_agg(
          CASE
            WHEN r.recipient_user_id IS NOT NULL
              THEN coalesce(u.display_name, r.recipient_user_id::text)
            ELSE coalesce(a.name, r.recipient_agent_principal_id::text)
          END
          ORDER BY r.position ASC
        )
        FROM swarm.signal_recipients AS r
        LEFT JOIN swarm.users AS u ON u.user_id = r.recipient_user_id
        LEFT JOIN swarm.agent_principals AS a ON a.principal_id = r.recipient_agent_principal_id
        WHERE r.workspace_id = p.workspace_id
          AND r.signal_id = p.id
      ),
      CASE
        WHEN p.to_user_id IS NOT NULL THEN jsonb_build_array(
          coalesce(
            (SELECT u.display_name FROM swarm.users AS u WHERE u.user_id = p.to_user_id),
            p.to_user_id::text
          )
        )
        WHEN p.to_agent_principal_id IS NOT NULL THEN jsonb_build_array(
          coalesce(
            (SELECT a.name FROM swarm.agent_principals AS a WHERE a.principal_id = p.to_agent_principal_id),
            p.to_agent_principal_id::text
          )
        )
        ELSE coalesce(
          (
            SELECT jsonb_agg(
              CASE
                WHEN m.mentioned_user_id IS NOT NULL
                  THEN coalesce(u.display_name, m.mentioned_user_id::text)
                ELSE coalesce(a.name, m.mentioned_agent_principal_id::text)
              END
              ORDER BY m.position ASC
            )
            FROM swarm.signal_mentions AS m
            LEFT JOIN swarm.users AS u ON u.user_id = m.mentioned_user_id
            LEFT JOIN swarm.agent_principals AS a ON a.principal_id = m.mentioned_agent_principal_id
            WHERE m.workspace_id = p.workspace_id
              AND m.signal_id = p.id
          ),
          '[]'::jsonb
        )
      END
    ) AS names
  ) AS addr;

  RETURN jsonb_build_object(
    'workspace_id', p_workspace_id,
    'generated_at', read_at,
    'total', coalesce(total, 0),
    'truncated', coalesce(has_more, false),
    'asks', coalesce(rows, '[]'::jsonb)
  );
END;
$$;

ALTER FUNCTION swarm_read.my_open_asks(uuid, integer, timestamptz, uuid, bytea) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm_read.my_open_asks(uuid, integer, timestamptz, uuid, bytea)
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT EXECUTE ON FUNCTION swarm_read.my_open_asks(uuid, integer, timestamptz, uuid, bytea)
  TO swarm_read;

-- ---------------------------------------------------------------------------
-- HezSec C1 on #735: Dismissal instance binding (dismissal_id uuid).
-- A generated uuid column is collision-free even across restore + re-dismiss within
-- the same microsecond or transaction, and avoids timestamp formatting ambiguity.
-- ---------------------------------------------------------------------------
ALTER TABLE swarm.waiting_dismissals
  ADD COLUMN dismissal_id uuid NOT NULL DEFAULT gen_random_uuid();

-- Latest prior definition: 20261124000001_waiting_dismissals.sql
-- Now returns created (true when this call activated the dismissal, false when already
-- active) and dismissal (the active dismissal_id uuid instance).
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
  v_new_id uuid := gen_random_uuid();
  v_dismissal_id uuid;
  v_dismissed_at timestamptz;
  v_created boolean := false;
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
      workspace_id, user_id, item_kind, item_id, dismissal_id, dismissed_at, restored_at, updated_at
    ) VALUES (
      p_workspace_id, p_user_id, p_item_kind, p_item_id, v_new_id, v_now, NULL, v_now
    )
    ON CONFLICT (workspace_id, user_id, item_kind, item_id) DO UPDATE
    SET
      dismissal_id = CASE
        WHEN swarm.waiting_dismissals.restored_at IS NULL THEN swarm.waiting_dismissals.dismissal_id
        ELSE v_new_id
      END,
      dismissed_at = CASE
        WHEN swarm.waiting_dismissals.restored_at IS NULL THEN swarm.waiting_dismissals.dismissed_at
        ELSE v_now
      END,
      restored_at = NULL,
      updated_at = v_now
    RETURNING dismissal_id, dismissed_at INTO v_dismissal_id, v_dismissed_at;

    v_created := (v_dismissal_id = v_new_id);

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
    'created', v_created,
    'dismissal', v_dismissal_id,
    'dismissed_at', v_dismissed_at
  );
END;
$$;

ALTER FUNCTION swarm.dismiss_waiting_item(uuid, uuid, text, uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.dismiss_waiting_item(uuid, uuid, text, uuid)
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT EXECUTE ON FUNCTION swarm.dismiss_waiting_item(uuid, uuid, text, uuid) TO swarm_command;

-- 5-arg restore overload supporting optional expected dismissal instance (p_expected_dismissal_id).
-- When p_expected_dismissal_id IS NOT NULL, restores ONLY if the active dismissal's dismissal_id
-- matches; otherwise changes nothing and returns uniform not_found.
CREATE FUNCTION swarm.restore_waiting_item(
  p_workspace_id uuid,
  p_user_id uuid,
  p_item_kind text,
  p_item_id uuid,
  p_expected_dismissal_id uuid
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
      AND restored_at IS NULL
      AND (p_expected_dismissal_id IS NULL OR dismissal_id = p_expected_dismissal_id);
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

ALTER FUNCTION swarm.restore_waiting_item(uuid, uuid, text, uuid, uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.restore_waiting_item(uuid, uuid, text, uuid, uuid)
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT EXECUTE ON FUNCTION swarm.restore_waiting_item(uuid, uuid, text, uuid, uuid) TO swarm_command;

-- Latest prior definition: 20261124000001_waiting_dismissals.sql
-- Keep the 4-arg signature intact for zero-downtime migration-before-edge rollout and prior
-- catalog proofs; delegates to the 5-arg implementation with NULL expected instance.
CREATE OR REPLACE FUNCTION swarm.restore_waiting_item(
  p_workspace_id uuid,
  p_user_id uuid,
  p_item_kind text,
  p_item_id uuid
)
RETURNS jsonb
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT swarm.restore_waiting_item(
    p_workspace_id, p_user_id, p_item_kind, p_item_id, NULL::uuid
  );
$$;

ALTER FUNCTION swarm.restore_waiting_item(uuid, uuid, text, uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.restore_waiting_item(uuid, uuid, text, uuid)
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT EXECUTE ON FUNCTION swarm.restore_waiting_item(uuid, uuid, text, uuid) TO swarm_command;

-- Latest prior definition: 20261124000001_waiting_dismissals.sql
-- Include offer_id on rows whose reason is 'request' (and omit the key on other rows).
CREATE OR REPLACE FUNCTION swarm_read.waiting_todos_page(
 p_workspace_id uuid,
 p_limit integer DEFAULT 50,
 p_after_state_at timestamptz DEFAULT NULL,
 p_after_todo_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog AS $$
DECLARE
 claims jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
 viewer uuid;
 read_at timestamptz := statement_timestamp();
 page_limit integer;
 total integer;
 has_more boolean;
 rows jsonb;
BEGIN
 -- A person's own session only. Reject agent claims and invalid sub UUIDs.
 IF claims IS NULL OR claims->>'role' IS DISTINCT FROM 'authenticated' OR claims ? 'agent_principal_id'
  OR coalesce(claims->>'sub', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
  RETURN NULL;
 END IF;
 viewer := (claims->>'sub')::uuid;

 IF p_workspace_id IS NULL OR NOT swarm.is_member(p_workspace_id, viewer) THEN
  RETURN NULL;
 END IF;
 IF (p_after_state_at IS NULL) <> (p_after_todo_id IS NULL) THEN
  RAISE EXCEPTION 'waiting_todos_page cursor requires both p_after_state_at and p_after_todo_id' USING ERRCODE = '22023';
 END IF;

 -- Match home_overview's exact household read gate (live member, shared boundary, confirmed role).
 IF NOT swarm.household_human_can_read(p_workspace_id, viewer) THEN
  RETURN jsonb_build_object(
   'workspace_id', p_workspace_id,
   'generated_at', read_at,
   'total', 0,
   'truncated', false,
   'todos', '[]'::jsonb
  );
 END IF;

 page_limit := greatest(1, least(coalesce(p_limit, 50), 100));

 WITH candidate_todos AS MATERIALIZED (
  SELECT
   t.todo_id,
   t.title,
   t.state,
   t.due_on,
   t.state_at,
   t.origin_placement,
   t.origin_channel_id,
   t.origin_conversation_id,
   t.offer_id,
   reason.kind AS reason,
   CASE
    WHEN reason.kind = 'request' THEN t.offer_principal
    WHEN reason.kind IN ('hold', 'agent_removed') THEN t.assignee_principal
    ELSE NULL
   END AS agent_id
  FROM swarm.household_todos t
  CROSS JOIN LATERAL (
   SELECT swarm.waiting_todo_reason(t.workspace_id, viewer, t.todo_id) AS kind
  ) reason
  WHERE t.workspace_id = p_workspace_id
   AND t.state IN ('open', 'doing')
   AND reason.kind IS NOT NULL
   AND NOT EXISTS (
    SELECT 1 FROM swarm.waiting_dismissals wd
    WHERE wd.workspace_id = t.workspace_id
     AND wd.user_id = viewer
     AND wd.restored_at IS NULL
     AND (
      (reason.kind = 'request' AND wd.item_kind = 'review' AND wd.item_id = t.offer_id)
      OR (reason.kind <> 'request' AND wd.item_kind = 'todo' AND wd.item_id = t.todo_id)
     )
   )
 ), anchor AS (
  SELECT coalesce(
   (SELECT c.state_at FROM candidate_todos c WHERE c.todo_id = p_after_todo_id),
   p_after_state_at
  ) AS state_at
 ), page_probe AS MATERIALIZED (
  SELECT c.*
  FROM candidate_todos c, anchor a
  WHERE p_after_todo_id IS NULL
   OR c.state_at < a.state_at
   OR (c.state_at = a.state_at AND c.todo_id > p_after_todo_id)
  ORDER BY c.state_at DESC, c.todo_id ASC
  LIMIT page_limit + 1
 ), page AS (
  SELECT * FROM page_probe
  ORDER BY state_at DESC, todo_id ASC
  LIMIT page_limit
 )
 SELECT
  (SELECT count(*) FROM candidate_todos)::integer,
  (SELECT count(*) > page_limit FROM page_probe),
  coalesce(jsonb_agg(jsonb_build_object(
   'todo_id', p.todo_id,
   'title', p.title,
   'state', p.state,
   'due_on', p.due_on,
   'reason', p.reason,
   'agent_id', p.agent_id,
   'state_at', p.state_at,
   'placement', vis.placement,
   'channel_id', vis.channel_id,
   'conversation_id', vis.conversation_id
  ) || CASE
   WHEN p.reason = 'request' THEN jsonb_build_object('offer_id', p.offer_id)
   ELSE '{}'::jsonb
  END ORDER BY p.state_at DESC, p.todo_id ASC), '[]'::jsonb)
 INTO total, has_more, rows
 FROM page p
 CROSS JOIN LATERAL (
  SELECT
   (p.origin_placement = 'channel'
    AND p.origin_channel_id IS NOT NULL
    AND swarm.claims_can_access_channel(p_workspace_id, p.origin_channel_id)) AS can_channel,
   (p.origin_placement IN ('dm', 'group_dm')
    AND p.origin_conversation_id IS NOT NULL
    AND swarm.actor_can_access_direct_conversation(p_workspace_id, p.origin_conversation_id, p.origin_placement, 'user', viewer)) AS can_direct
 ) access
 CROSS JOIN LATERAL (
  SELECT
   CASE
    WHEN access.can_channel THEN 'channel'
    WHEN access.can_direct THEN p.origin_placement
    WHEN p.origin_placement = 'general' THEN 'general'
    ELSE 'workspace'
   END AS placement,
   CASE WHEN access.can_channel THEN p.origin_channel_id ELSE NULL END AS channel_id,
   CASE WHEN access.can_direct THEN p.origin_conversation_id ELSE NULL END AS conversation_id
 ) vis;

 RETURN jsonb_build_object(
  'workspace_id', p_workspace_id,
  'generated_at', read_at,
  'total', coalesce(total, 0),
  'truncated', coalesce(has_more, false),
  'todos', coalesce(rows, '[]'::jsonb)
 );
END;
$$;

ALTER FUNCTION swarm_read.waiting_todos_page(uuid, integer, timestamptz, uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm_read.waiting_todos_page(uuid, integer, timestamptz, uuid)
 FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT EXECUTE ON FUNCTION swarm_read.waiting_todos_page(uuid, integer, timestamptz, uuid) TO authenticated;

-- Latest prior definition: 20261124000001_waiting_dismissals.sql.
-- Keep non-channel withdraw_ask rows (direct/group-conversation and unfiled withdrawals) server-only
-- in swarm.audit_log; channel-tagged withdraw_ask rows remain gated by the existing channel_ids rule.
CREATE OR REPLACE VIEW swarm_read.audit_log
WITH (security_barrier = true)
AS
  SELECT
    a.audit_id,
    a.occurred_at,
    a.actor_user,
    a.actor_agent_principal,
    a.actor_run,
    a.credential_kind,
    a.credential_id,
    a.device_id,
    a.command_kind,
    a.workspace_id,
    a.stream_id,
    a.outcome,
    a.reason,
    a.detail,
    a.request_hash,
    a.ip
  FROM swarm.audit_log AS a
  WHERE swarm.is_member(a.workspace_id, auth.uid())
    AND EXISTS (
      SELECT 1
      FROM swarm.memberships AS m
      WHERE m.workspace_id = a.workspace_id
        AND m.user_id = auth.uid()
        AND m.revoked_at IS NULL
        AND m.role IN ('owner', 'admin')
    )
    AND (
      COALESCE(cardinality(a.channel_ids), 0) = 0
      OR NOT EXISTS (
        SELECT 1
        FROM unnest(a.channel_ids) AS cid
        WHERE cid IS NULL
           OR NOT swarm.claims_can_access_channel(a.workspace_id, cid)
      )
    )
    AND (
      a.command_kind NOT IN (
        'private_channel_manager_promoted',
        'private_channel_auto_archived'
      )
      OR (
        a.stream_id IS NOT NULL
        AND swarm.claims_can_access_channel(a.workspace_id, a.stream_id)
      )
    )
    AND a.command_kind NOT IN (
      'dismiss_waiting_item',
      'restore_waiting_item'
    )
    AND (
      a.command_kind <> 'withdraw_ask'
      OR COALESCE(cardinality(a.channel_ids), 0) > 0
    );

ALTER VIEW swarm_read.audit_log OWNER TO swarm_admin;
GRANT SELECT ON swarm_read.audit_log TO authenticated, swarm_read;
REVOKE ALL ON swarm_read.audit_log FROM PUBLIC, anon;

RESET search_path;
