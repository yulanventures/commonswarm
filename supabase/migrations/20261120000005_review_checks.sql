-- Revision-bound review checks (C3):
-- One canonical record per (workspace, scope_key, subject_kind, subject_repo, subject_ref) holding:
--   - the subject (repo and PR) and current full head_sha (40-char SHA-1 or 64-char SHA-256);
--   - immutable canonical placement (conversation_id, thread_root_id, root_audience, scope_key);
--   - the required seats (active workspace people and/or agents authorized to read the check);
--   - per-seat stamps of pass or hold bound to a specific full head_sha.
--
-- Security & concurrency invariants:
--   1. Only the named seat stamps its own row: review_check_stamp derives (seat_kind, seat_id)
--      strictly from the authenticated caller identity and requires membership in required_seats.
--   2. Update authority (Condition 1): only an explicit authorized operator — the check's opener,
--      a live workspace owner/admin with read access, the live channel lead, or (on non-DM scopes
--      without an overriding channel lead) the live workspace lead — may advance head_sha or change
--      required_seats. Ordinary viewers and required reviewers receive 403. Every update records
--      updated_by_kind/updated_by_id, and head_sha is bound to one full revision (40 or 64 hex).
--   3. Canonical placement & audience (Condition 2): thread_root_id MUST resolve to a mapped,
--      unarchived swarm.conversation_signals row whose conversation AND per-message audience
--      (conversation_visible + conversation_signal_visible_to) the caller can read. Unmapped or
--      unsupported roots fail closed (404). Placement is immutable (trigger + open guard). Read,
--      stamp, replay (review_check_replay_visible), and satisfaction thread-note delivery all
--      enforce the exact same conversation + root_audience policy. Subject uniqueness is scoped
--      by (workspace_id, scope_key, subject_kind, subject_repo, subject_ref) so public creation
--      never probes hidden private/DM checks.
--   4. Private audit isolation (Condition 3): open and stamp return audit_channel_id ONLY when the
--      target is accessible and channel-scoped (NULL on not_found so unknown and inaccessible
--      targets are indistinguishable). The check payload carries canonical channel_id for replay
--      and conflict audit tagging.
--   5. Once-only satisfied thread note: serialized under FOR UPDATE on swarm.review_checks and
--      guarded by satisfied_head_sha IS DISTINCT FROM head_sha.
--   6. Zero parent-locking FOREIGN KEY constraints on swarm.workspaces, swarm.conversations,
--      swarm.signals, swarm.memberships, or swarm.agent_principals (MVCC trigger validates).
SET search_path = swarm, pg_catalog, public;

CREATE TABLE swarm.review_checks (
  check_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  subject_kind text NOT NULL DEFAULT 'pr' CHECK (subject_kind IN ('pr')),
  subject_repo text NOT NULL CHECK (
    char_length(subject_repo) BETWEEN 1 AND 160
    AND subject_repo = btrim(subject_repo)
    AND subject_repo !~ '[[:cntrl:]]'
  ),
  subject_ref text NOT NULL CHECK (
    char_length(subject_ref) BETWEEN 1 AND 80
    AND subject_ref = btrim(subject_ref)
    AND subject_ref !~ '[[:cntrl:]]'
  ),
  head_sha text NOT NULL CHECK (head_sha ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'),
  conversation_id uuid,
  thread_root_id uuid,
  root_audience text NOT NULL DEFAULT 'conversation' CHECK (root_audience IN ('conversation', 'addressed')),
  scope_key text NOT NULL CHECK (char_length(scope_key) BETWEEN 1 AND 200),
  required_seats jsonb NOT NULL CHECK (
    jsonb_typeof(required_seats) = 'array'
    AND jsonb_array_length(required_seats) BETWEEN 1 AND 20
  ),
  created_by_kind text NOT NULL CHECK (created_by_kind IN ('user', 'agent')),
  created_by_id uuid NOT NULL,
  updated_by_kind text NOT NULL CHECK (updated_by_kind IN ('user', 'agent')),
  updated_by_id uuid NOT NULL,
  satisfied_head_sha text CHECK (
    satisfied_head_sha IS NULL
    OR satisfied_head_sha ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'
  ),
  satisfied_signal_id uuid,
  satisfied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CHECK (thread_root_id IS NULL OR conversation_id IS NOT NULL),
  CHECK (root_audience = 'conversation' OR thread_root_id IS NOT NULL),
  UNIQUE (workspace_id, scope_key, subject_kind, subject_repo, subject_ref)
);

CREATE INDEX review_checks_workspace_updated
  ON swarm.review_checks (workspace_id, updated_at DESC, check_id ASC);

CREATE INDEX review_checks_workspace_subject
  ON swarm.review_checks (workspace_id, subject_kind, subject_repo, subject_ref, updated_at DESC, check_id ASC);

CREATE INDEX review_checks_workspace_thread
  ON swarm.review_checks (workspace_id, thread_root_id)
  WHERE thread_root_id IS NOT NULL;

CREATE INDEX review_checks_workspace_conversation
  ON swarm.review_checks (workspace_id, conversation_id)
  WHERE conversation_id IS NOT NULL;

CREATE TABLE swarm.review_check_stamps (
  stamp_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  check_id uuid NOT NULL REFERENCES swarm.review_checks(check_id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  seat_kind text NOT NULL CHECK (seat_kind IN ('user', 'agent')),
  seat_id uuid NOT NULL,
  head_sha text NOT NULL CHECK (head_sha ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'),
  verdict text NOT NULL CHECK (verdict IN ('pass', 'hold')),
  note text CHECK (
    note IS NULL
    OR (
      char_length(note) BETWEEN 1 AND 2000
      AND note = btrim(note)
    )
  ),
  stamped_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (check_id, seat_kind, seat_id)
);

CREATE INDEX review_check_stamps_check_head
  ON swarm.review_check_stamps (check_id, head_sha);

-- Read-only MVCC reference validator (zero parent row locks).
CREATE FUNCTION swarm.review_check_validate_refs()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM swarm.workspaces AS w WHERE w.workspace_id = NEW.workspace_id
  ) THEN
    RAISE EXCEPTION 'review_check workspace % does not exist', NEW.workspace_id
      USING ERRCODE = '23503';
  END IF;
  IF NEW.conversation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM swarm.conversations AS c
    WHERE c.workspace_id = NEW.workspace_id AND c.conversation_id = NEW.conversation_id
  ) THEN
    RAISE EXCEPTION 'review_check conversation % does not exist in workspace %', NEW.conversation_id, NEW.workspace_id
      USING ERRCODE = '23503';
  END IF;
  IF NEW.thread_root_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM swarm.signals AS s
    WHERE s.workspace_id = NEW.workspace_id AND s.id = NEW.thread_root_id
  ) THEN
    RAISE EXCEPTION 'review_check thread root % does not exist in workspace %', NEW.thread_root_id, NEW.workspace_id
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;

-- Placement, subject, audience, and opener identity are immutable after creation.
CREATE FUNCTION swarm.review_check_placement_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.subject_kind IS DISTINCT FROM OLD.subject_kind
    OR NEW.subject_repo IS DISTINCT FROM OLD.subject_repo
    OR NEW.subject_ref IS DISTINCT FROM OLD.subject_ref
    OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
    OR NEW.thread_root_id IS DISTINCT FROM OLD.thread_root_id
    OR NEW.root_audience IS DISTINCT FROM OLD.root_audience
    OR NEW.scope_key IS DISTINCT FROM OLD.scope_key
    OR NEW.created_by_kind IS DISTINCT FROM OLD.created_by_kind
    OR NEW.created_by_id IS DISTINCT FROM OLD.created_by_id THEN
    RAISE EXCEPTION 'review_check placement, subject, audience, and opener are immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER review_checks_validate_refs
  BEFORE INSERT OR UPDATE ON swarm.review_checks
  FOR EACH ROW EXECUTE FUNCTION swarm.review_check_validate_refs();

CREATE TRIGGER review_checks_placement_immutable
  BEFORE UPDATE ON swarm.review_checks
  FOR EACH ROW EXECUTE FUNCTION swarm.review_check_placement_immutable();

ALTER TABLE swarm.review_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE swarm.review_check_stamps ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE swarm.review_checks FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
REVOKE ALL ON TABLE swarm.review_check_stamps FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;

-- Unified visibility predicate: active workspace member + conversation visibility + addressed root audience.
CREATE FUNCTION swarm.review_check_can_read(
  p_workspace_id uuid,
  p_actor_kind text,
  p_actor_id uuid,
  p_conversation_id uuid,
  p_thread_root_id uuid DEFAULT NULL,
  p_root_audience text DEFAULT 'conversation'
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_sig record;
BEGIN
  IF p_workspace_id IS NULL OR p_actor_kind NOT IN ('user', 'agent') OR p_actor_id IS NULL THEN
    RETURN false;
  END IF;
  IF NOT swarm.actor_can_access_channel(p_workspace_id, NULL, p_actor_kind, p_actor_id) THEN
    RETURN false;
  END IF;
  IF p_conversation_id IS NOT NULL THEN
    IF NOT swarm.conversation_visible(p_workspace_id, p_actor_kind, p_actor_id, p_conversation_id) THEN
      RETURN false;
    END IF;
  END IF;
  IF p_root_audience = 'addressed' THEN
    IF p_thread_root_id IS NULL THEN
      RETURN false;
    END IF;
    SELECT s.id, s.from_kind, s.from_principal, s.to_user_id, s.to_agent_principal_id
    INTO v_sig
    FROM swarm.signals AS s
    WHERE s.workspace_id = p_workspace_id AND s.id = p_thread_root_id;
    IF NOT FOUND THEN
      RETURN false;
    END IF;
    IF NOT swarm.conversation_signal_visible_to(
      p_workspace_id, v_sig.id, 'addressed',
      v_sig.from_kind::text, v_sig.from_principal,
      v_sig.to_user_id, v_sig.to_agent_principal_id,
      p_actor_kind, p_actor_id
    ) THEN
      RETURN false;
    END IF;
  END IF;
  RETURN true;
END;
$$;

-- Canonical channel_id for a review check's conversation (NULL for workspace, #general, DM, group DM).
CREATE FUNCTION swarm.review_check_channel_id(
  p_workspace_id uuid,
  p_conversation_id uuid
)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT CASE
    WHEN c.kind IN ('public_channel', 'private_channel') THEN c.channel_id
    ELSE NULL
  END
  FROM swarm.conversations AS c
  WHERE c.workspace_id = p_workspace_id
    AND c.conversation_id = p_conversation_id;
$$;

-- Explicit operator authorization for advancing head_sha or updating required_seats on an existing check.
-- Caller must already satisfy review_check_can_read. Authorized operators:
--   1. The check's opener (created_by_kind, created_by_id);
--   2. A live workspace owner or admin (human) with read access to the check's placement/audience;
--   3. The live configured channel lead (when the check is in a channel with lead_mode = 'agent');
--   4. The live workspace lead (only on non-DM scopes without an overriding channel lead).
CREATE FUNCTION swarm.review_check_can_manage(
  p_workspace_id uuid,
  p_actor_kind text,
  p_actor_id uuid,
  p_check_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_check swarm.review_checks%ROWTYPE;
  v_conv record;
  v_ch record;
  v_ws_lead uuid;
BEGIN
  SELECT * INTO v_check
  FROM swarm.review_checks AS rc
  WHERE rc.workspace_id = p_workspace_id AND rc.check_id = p_check_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF NOT swarm.review_check_can_read(
    p_workspace_id, p_actor_kind, p_actor_id,
    v_check.conversation_id, v_check.thread_root_id, v_check.root_audience
  ) THEN
    RETURN false;
  END IF;

  -- 1. Opener
  IF p_actor_kind = v_check.created_by_kind AND p_actor_id = v_check.created_by_id THEN
    RETURN true;
  END IF;

  -- 2. Live workspace owner or admin (human, with verified read access above)
  IF p_actor_kind = 'user' THEN
    RETURN EXISTS (
      SELECT 1
      FROM swarm.memberships AS m
      WHERE m.workspace_id = p_workspace_id
        AND m.user_id = p_actor_id
        AND m.revoked_at IS NULL
        AND m.role IN ('owner', 'admin')
    );
  END IF;

  -- 3 & 4. Live channel lead or workspace lead (never implicitly on DM / group_dm)
  IF p_actor_kind = 'agent' THEN
    IF v_check.conversation_id IS NOT NULL THEN
      SELECT c.kind, c.channel_id
      INTO v_conv
      FROM swarm.conversations AS c
      WHERE c.workspace_id = p_workspace_id AND c.conversation_id = v_check.conversation_id;
      IF NOT FOUND THEN
        RETURN false;
      END IF;
      IF v_conv.kind IN ('dm', 'group_dm') THEN
        RETURN false;
      END IF;
      IF v_conv.kind IN ('public_channel', 'private_channel') AND v_conv.channel_id IS NOT NULL THEN
        SELECT ch.lead_mode, ch.lead_agent_principal_id, ch.archived_at
        INTO v_ch
        FROM swarm.channels AS ch
        WHERE ch.workspace_id = p_workspace_id AND ch.channel_id = v_conv.channel_id;
        IF NOT FOUND OR v_ch.archived_at IS NOT NULL THEN
          RETURN false;
        END IF;
        IF v_ch.lead_mode = 'agent' THEN
          RETURN v_ch.lead_agent_principal_id = p_actor_id;
        END IF;
      END IF;
    END IF;

    SELECT w.lead_agent_principal_id
    INTO v_ws_lead
    FROM swarm.workspaces AS w
    WHERE w.workspace_id = p_workspace_id AND w.archived_at IS NULL;
    RETURN v_ws_lead IS NOT NULL AND v_ws_lead = p_actor_id;
  END IF;

  RETURN false;
END;
$$;

-- Replay visibility check for command/index.ts (enforces BOTH conversation AND addressed root audience).
CREATE FUNCTION swarm.review_check_replay_visible(
  p_workspace_id uuid,
  p_actor_kind text,
  p_actor_id uuid,
  p_check_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_check swarm.review_checks%ROWTYPE;
BEGIN
  IF p_workspace_id IS NULL OR p_check_id IS NULL THEN
    RETURN false;
  END IF;
  SELECT * INTO v_check
  FROM swarm.review_checks AS rc
  WHERE rc.workspace_id = p_workspace_id AND rc.check_id = p_check_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  RETURN swarm.review_check_can_read(
    p_workspace_id, p_actor_kind, p_actor_id,
    v_check.conversation_id, v_check.thread_root_id, v_check.root_audience
  );
END;
$$;

-- Canonical JSON payload for one review check including current/stale stamp status and canonical channel_id.
CREATE FUNCTION swarm.review_check_payload(p_check_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_check swarm.review_checks%ROWTYPE;
  v_channel_id uuid := NULL;
  v_seats jsonb;
  v_stamps jsonb;
  v_required_count integer := 0;
  v_passed_count integer := 0;
  v_hold_count integer := 0;
  v_status text := 'pending';
BEGIN
  SELECT * INTO v_check
  FROM swarm.review_checks AS rc
  WHERE rc.check_id = p_check_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF v_check.conversation_id IS NOT NULL THEN
    v_channel_id := swarm.review_check_channel_id(v_check.workspace_id, v_check.conversation_id);
  END IF;

  SELECT coalesce(jsonb_agg(
    jsonb_build_object(
      'kind', seat_item->>'kind',
      'id', seat_item->>'id',
      'name', CASE
        WHEN seat_item->>'kind' = 'agent' THEN (
          SELECT ap.name FROM swarm.agent_principals AS ap
          WHERE ap.workspace_id = v_check.workspace_id
            AND ap.principal_id = (seat_item->>'id')::uuid
        )
        ELSE (
          SELECT nullif(btrim(u.display_name), '')
          FROM swarm.users AS u
          WHERE u.user_id = (seat_item->>'id')::uuid
        )
      END
    ) ORDER BY ordinality
  ), '[]'::jsonb)
  INTO v_seats
  FROM jsonb_array_elements(v_check.required_seats) WITH ORDINALITY AS s(seat_item, ordinality);

  SELECT coalesce(jsonb_agg(
    jsonb_build_object(
      'seat_kind', seat_item->>'kind',
      'seat_id', seat_item->>'id',
      'name', CASE
        WHEN seat_item->>'kind' = 'agent' THEN (
          SELECT ap.name FROM swarm.agent_principals AS ap
          WHERE ap.workspace_id = v_check.workspace_id
            AND ap.principal_id = (seat_item->>'id')::uuid
        )
        ELSE (
          SELECT nullif(btrim(u.display_name), '')
          FROM swarm.users AS u
          WHERE u.user_id = (seat_item->>'id')::uuid
        )
      END,
      'verdict', st.verdict,
      'head_sha', st.head_sha,
      'note', st.note,
      'stamped_at', st.stamped_at,
      'stale', CASE WHEN st.stamp_id IS NULL THEN false ELSE st.head_sha <> v_check.head_sha END,
      'effective_verdict', CASE
        WHEN st.stamp_id IS NOT NULL AND st.head_sha = v_check.head_sha THEN st.verdict
        ELSE 'pending'
      END
    ) ORDER BY ordinality
  ), '[]'::jsonb)
  INTO v_stamps
  FROM jsonb_array_elements(v_check.required_seats) WITH ORDINALITY AS s(seat_item, ordinality)
  LEFT JOIN swarm.review_check_stamps AS st
    ON st.check_id = v_check.check_id
   AND st.seat_kind = seat_item->>'kind'
   AND st.seat_id = (seat_item->>'id')::uuid;

  v_required_count := jsonb_array_length(v_check.required_seats);
  SELECT
    count(*) FILTER (WHERE item->>'effective_verdict' = 'pass'),
    count(*) FILTER (WHERE item->>'effective_verdict' = 'hold')
  INTO v_passed_count, v_hold_count
  FROM jsonb_array_elements(v_stamps) AS item;

  IF v_hold_count > 0 THEN
    v_status := 'hold';
  ELSIF v_required_count > 0 AND v_passed_count = v_required_count THEN
    v_status := 'satisfied';
  ELSE
    v_status := 'pending';
  END IF;

  RETURN jsonb_build_object(
    'check_id', v_check.check_id,
    'workspace_id', v_check.workspace_id,
    'subject', jsonb_build_object(
      'kind', v_check.subject_kind,
      'repo', v_check.subject_repo,
      'ref', v_check.subject_ref
    ),
    'head_sha', v_check.head_sha,
    'conversation_id', v_check.conversation_id,
    'channel_id', v_channel_id,
    'thread_root_id', v_check.thread_root_id,
    'root_audience', v_check.root_audience,
    'required_seats', v_seats,
    'stamps', v_stamps,
    'status', v_status,
    'satisfied', v_status = 'satisfied',
    'satisfied_head_sha', v_check.satisfied_head_sha,
    'satisfied_signal_id', v_check.satisfied_signal_id,
    'satisfied_at', v_check.satisfied_at,
    'created_by', jsonb_build_object('kind', v_check.created_by_kind, 'id', v_check.created_by_id),
    'updated_by', jsonb_build_object('kind', v_check.updated_by_kind, 'id', v_check.updated_by_id),
    'created_at', v_check.created_at,
    'updated_at', v_check.updated_at
  );
END;
$$;

-- Open (or advance head / update required seats on) a revision-bound review check.
CREATE FUNCTION swarm.review_check_open(
  p_workspace_id uuid,
  p_actor_kind text,
  p_actor_id uuid,
  p_subject_repo text,
  p_subject_ref text,
  p_head_sha text,
  p_required_seats jsonb,
  p_conversation_id uuid DEFAULT NULL,
  p_thread_root_id uuid DEFAULT NULL,
  p_check_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_repo text := btrim(coalesce(p_subject_repo, ''));
  v_ref text := btrim(coalesce(p_subject_ref, ''));
  v_sha text := lower(btrim(coalesce(p_head_sha, '')));
  v_conv_id uuid := p_conversation_id;
  v_root_id uuid := p_thread_root_id;
  v_root_audience text := 'conversation';
  v_scope_key text := 'workspace';
  v_audit_channel_id uuid := NULL;
  v_root record;
  v_conv record;
  v_seat jsonb;
  v_seat_kind text;
  v_seat_id uuid;
  v_dedup jsonb := '[]'::jsonb;
  v_seen text[] := ARRAY[]::text[];
  v_key text;
  v_existing swarm.review_checks%ROWTYPE;
  v_check_id uuid;
  v_created boolean := false;
  v_head_changed boolean := false;
  v_now timestamptz := statement_timestamp();
BEGIN
  IF p_actor_kind IS NULL OR p_actor_kind NOT IN ('user', 'agent') OR p_actor_id IS NULL
     OR NOT swarm.actor_can_access_channel(p_workspace_id, NULL, p_actor_kind, p_actor_id) THEN
    RETURN jsonb_build_object('status', 'forbidden');
  END IF;

  IF char_length(v_repo) NOT BETWEEN 1 AND 160 OR v_repo ~ '[[:cntrl:]]'
     OR char_length(v_ref) NOT BETWEEN 1 AND 80 OR v_ref ~ '[[:cntrl:]]'
     OR v_sha !~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'
     OR p_required_seats IS NULL
     OR jsonb_typeof(p_required_seats) <> 'array'
     OR jsonb_array_length(p_required_seats) NOT BETWEEN 1 AND 20 THEN
    RETURN jsonb_build_object('status', 'invalid_request');
  END IF;

  -- Path A: Explicit update by check_id (never mutates placement/subject/audience).
  IF p_check_id IS NOT NULL THEN
    SELECT * INTO v_existing
    FROM swarm.review_checks AS rc
    WHERE rc.workspace_id = p_workspace_id AND rc.check_id = p_check_id
    FOR UPDATE;

    IF NOT FOUND OR NOT swarm.review_check_can_read(
      p_workspace_id, p_actor_kind, p_actor_id,
      v_existing.conversation_id, v_existing.thread_root_id, v_existing.root_audience
    ) THEN
      RETURN jsonb_build_object('status', 'not_found');
    END IF;

    v_audit_channel_id := CASE
      WHEN v_existing.conversation_id IS NOT NULL
        THEN swarm.review_check_channel_id(p_workspace_id, v_existing.conversation_id)
      ELSE NULL
    END;

    IF v_existing.subject_repo <> v_repo OR v_existing.subject_ref <> v_ref
      OR (p_conversation_id IS NOT NULL AND p_conversation_id IS DISTINCT FROM v_existing.conversation_id)
      OR (p_thread_root_id IS NOT NULL AND p_thread_root_id IS DISTINCT FROM v_existing.thread_root_id) THEN
      RETURN jsonb_build_object('status', 'placement_immutable', 'audit_channel_id', v_audit_channel_id);
    END IF;

    IF NOT swarm.review_check_can_manage(p_workspace_id, p_actor_kind, p_actor_id, v_existing.check_id) THEN
      RETURN jsonb_build_object('status', 'update_forbidden', 'audit_channel_id', v_audit_channel_id);
    END IF;

    v_conv_id := v_existing.conversation_id;
    v_root_id := v_existing.thread_root_id;
    v_root_audience := v_existing.root_audience;
    v_scope_key := v_existing.scope_key;
  ELSE
    -- Path B: Resolve canonical placement & audience (fail closed on unmapped/unsupported roots).
    IF v_root_id IS NOT NULL THEN
      SELECT
        s.id, s.thread_root_id, s.from_kind, s.from_principal, s.to_user_id, s.to_agent_principal_id,
        cs.conversation_id AS mapped_conversation_id,
        cs.audience AS mapped_audience
      INTO v_root
      FROM swarm.signals AS s
      LEFT JOIN swarm.conversation_signals AS cs
        ON cs.workspace_id = s.workspace_id AND cs.signal_id = s.id
      WHERE s.workspace_id = p_workspace_id AND s.id = v_root_id;

      IF NOT FOUND
        OR v_root.thread_root_id IS NOT NULL
        OR v_root.mapped_conversation_id IS NULL
        OR v_root.mapped_audience NOT IN ('conversation', 'addressed') THEN
        RETURN jsonb_build_object('status', 'not_found');
      END IF;

      IF v_conv_id IS NOT NULL AND v_conv_id <> v_root.mapped_conversation_id THEN
        RETURN jsonb_build_object('status', 'not_found');
      END IF;

      SELECT c.conversation_id, c.kind, c.channel_id, c.archived_at
      INTO v_conv
      FROM swarm.conversations AS c
      WHERE c.workspace_id = p_workspace_id AND c.conversation_id = v_root.mapped_conversation_id;
      IF NOT FOUND OR v_conv.archived_at IS NOT NULL THEN
        RETURN jsonb_build_object('status', 'not_found');
      END IF;

      IF NOT swarm.conversation_visible(p_workspace_id, p_actor_kind, p_actor_id, v_conv.conversation_id) THEN
        RETURN jsonb_build_object('status', 'not_found');
      END IF;

      IF NOT swarm.conversation_signal_visible_to(
        p_workspace_id, v_root.id, v_root.mapped_audience,
        v_root.from_kind::text, v_root.from_principal,
        v_root.to_user_id, v_root.to_agent_principal_id,
        p_actor_kind, p_actor_id
      ) THEN
        RETURN jsonb_build_object('status', 'not_found');
      END IF;

      -- Step 2b thread eligibility for DM / group_dm: a narrow addressed root that is not
      -- visible to every live DM member cannot admit a thread check whose fulfillment note
      -- routes to the conversation.
      IF v_conv.kind IN ('dm', 'group_dm')
        AND v_root.mapped_audience = 'addressed'
        AND EXISTS (
          SELECT 1
          FROM swarm.conversation_members AS lm
          WHERE lm.conversation_id = v_conv.conversation_id
            AND lm.workspace_id = p_workspace_id
            AND lm.left_at IS NULL
            AND swarm.conversation_signal_visible_to(
              p_workspace_id, v_root.id, v_root.mapped_audience,
              v_root.from_kind::text, v_root.from_principal,
              v_root.to_user_id, v_root.to_agent_principal_id,
              CASE WHEN lm.member_user_id IS NOT NULL THEN 'user' ELSE 'agent' END,
              COALESCE(lm.member_user_id, lm.member_agent_principal_id)
            ) IS NOT TRUE
        ) THEN
        RETURN jsonb_build_object('status', 'not_found');
      END IF;

      v_conv_id := v_conv.conversation_id;
      v_root_audience := v_root.mapped_audience;
      v_audit_channel_id := CASE
        WHEN v_conv.kind IN ('public_channel', 'private_channel') THEN v_conv.channel_id
        ELSE NULL
      END;
      v_scope_key := CASE
        WHEN v_root_audience = 'addressed'
          THEN 'conv:' || v_conv_id::text || ':root:' || v_root_id::text
        ELSE 'conv:' || v_conv_id::text
      END;
    ELSIF v_conv_id IS NOT NULL THEN
      SELECT c.conversation_id, c.kind, c.channel_id, c.archived_at
      INTO v_conv
      FROM swarm.conversations AS c
      WHERE c.workspace_id = p_workspace_id AND c.conversation_id = v_conv_id;
      IF NOT FOUND OR v_conv.archived_at IS NOT NULL
        OR NOT swarm.conversation_visible(p_workspace_id, p_actor_kind, p_actor_id, v_conv.conversation_id) THEN
        RETURN jsonb_build_object('status', 'not_found');
      END IF;

      v_root_audience := 'conversation';
      v_audit_channel_id := CASE
        WHEN v_conv.kind IN ('public_channel', 'private_channel') THEN v_conv.channel_id
        ELSE NULL
      END;
      v_scope_key := 'conv:' || v_conv_id::text;
    ELSE
      v_conv_id := NULL;
      v_root_id := NULL;
      v_root_audience := 'conversation';
      v_audit_channel_id := NULL;
      v_scope_key := 'workspace';
    END IF;

    SELECT * INTO v_existing
    FROM swarm.review_checks AS rc
    WHERE rc.workspace_id = p_workspace_id
      AND rc.scope_key = v_scope_key
      AND rc.subject_kind = 'pr'
      AND rc.subject_repo = v_repo
      AND rc.subject_ref = v_ref
    FOR UPDATE;

    IF FOUND THEN
      IF NOT swarm.review_check_can_read(
        p_workspace_id, p_actor_kind, p_actor_id,
        v_existing.conversation_id, v_existing.thread_root_id, v_existing.root_audience
      ) THEN
        RETURN jsonb_build_object('status', 'not_found');
      END IF;
      IF v_existing.thread_root_id IS DISTINCT FROM v_root_id THEN
        RETURN jsonb_build_object('status', 'placement_immutable', 'audit_channel_id', v_audit_channel_id);
      END IF;
      IF NOT swarm.review_check_can_manage(p_workspace_id, p_actor_kind, p_actor_id, v_existing.check_id) THEN
        RETURN jsonb_build_object('status', 'update_forbidden', 'audit_channel_id', v_audit_channel_id);
      END IF;
    END IF;
  END IF;

  -- Validate and deduplicate every required seat against the exact check audience.
  FOR v_seat IN SELECT value FROM jsonb_array_elements(p_required_seats) LOOP
    IF jsonb_typeof(v_seat) <> 'object' THEN
      RETURN jsonb_build_object('status', 'invalid_request', 'audit_channel_id', v_audit_channel_id);
    END IF;
    v_seat_kind := v_seat->>'kind';
    IF v_seat_kind NOT IN ('user', 'agent') OR coalesce(v_seat->>'id', '') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
      RETURN jsonb_build_object('status', 'invalid_request', 'audit_channel_id', v_audit_channel_id);
    END IF;
    v_seat_id := (v_seat->>'id')::uuid;
    v_key := v_seat_kind || ':' || v_seat_id::text;
    IF v_key = ANY (v_seen) THEN
      CONTINUE;
    END IF;
    IF NOT swarm.review_check_can_read(
      p_workspace_id, v_seat_kind, v_seat_id, v_conv_id, v_root_id, v_root_audience
    ) THEN
      RETURN jsonb_build_object(
        'status', 'invalid_seat',
        'seat_kind', v_seat_kind,
        'seat_id', v_seat_id,
        'audit_channel_id', v_audit_channel_id
      );
    END IF;
    v_seen := array_append(v_seen, v_key);
    v_dedup := v_dedup || jsonb_build_array(jsonb_build_object('kind', v_seat_kind, 'id', v_seat_id::text));
  END LOOP;

  IF v_existing.check_id IS NOT NULL THEN
    v_head_changed := v_existing.head_sha <> v_sha;
    UPDATE swarm.review_checks
    SET
      head_sha = v_sha,
      required_seats = v_dedup,
      updated_by_kind = p_actor_kind,
      updated_by_id = p_actor_id,
      satisfied_head_sha = CASE
        WHEN v_head_changed OR v_existing.required_seats IS DISTINCT FROM v_dedup THEN NULL
        ELSE satisfied_head_sha
      END,
      satisfied_signal_id = CASE
        WHEN v_head_changed OR v_existing.required_seats IS DISTINCT FROM v_dedup THEN NULL
        ELSE satisfied_signal_id
      END,
      satisfied_at = CASE
        WHEN v_head_changed OR v_existing.required_seats IS DISTINCT FROM v_dedup THEN NULL
        ELSE satisfied_at
      END,
      updated_at = v_now
    WHERE check_id = v_existing.check_id;
    v_check_id := v_existing.check_id;
  ELSE
    INSERT INTO swarm.review_checks (
      workspace_id, subject_kind, subject_repo, subject_ref, head_sha,
      conversation_id, thread_root_id, root_audience, scope_key, required_seats,
      created_by_kind, created_by_id, updated_by_kind, updated_by_id, created_at, updated_at
    ) VALUES (
      p_workspace_id, 'pr', v_repo, v_ref, v_sha,
      v_conv_id, v_root_id, v_root_audience, v_scope_key, v_dedup,
      p_actor_kind, p_actor_id, p_actor_kind, p_actor_id, v_now, v_now
    )
    RETURNING check_id INTO v_check_id;
    v_created := true;
    v_head_changed := true;
  END IF;

  RETURN jsonb_build_object(
    'status', 'ok',
    'created', v_created,
    'head_changed', v_head_changed,
    'audit_channel_id', v_audit_channel_id,
    'check', swarm.review_check_payload(v_check_id)
  );
END;
$$;

-- Record caller's own pass/hold stamp for the current head_sha; post one thread note once satisfied
-- preserving the check's exact conversation and narrow root_audience.
CREATE FUNCTION swarm.review_check_stamp(
  p_workspace_id uuid,
  p_actor_kind text,
  p_actor_id uuid,
  p_check_id uuid,
  p_head_sha text,
  p_verdict text,
  p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_sha text := lower(btrim(coalesce(p_head_sha, '')));
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_check swarm.review_checks%ROWTYPE;
  v_audit_channel_id uuid := NULL;
  v_is_required boolean := false;
  v_required_count integer := 0;
  v_passed_count integer := 0;
  v_satisfied_now boolean := false;
  v_signal_id uuid := NULL;
  v_conv record;
  v_root record;
  v_named_agents uuid[];
  v_route jsonb;
  v_to jsonb;
  v_to_user uuid := NULL;
  v_to_agent uuid := NULL;
  v_rec jsonb;
  v_pos smallint := 0;
  v_body text;
  v_now timestamptz := statement_timestamp();
BEGIN
  IF p_actor_kind IS NULL OR p_actor_kind NOT IN ('user', 'agent') OR p_actor_id IS NULL
     OR NOT swarm.actor_can_access_channel(p_workspace_id, NULL, p_actor_kind, p_actor_id) THEN
    RETURN jsonb_build_object('status', 'forbidden');
  END IF;

  IF p_check_id IS NULL OR v_sha !~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'
     OR p_verdict NOT IN ('pass', 'hold')
     OR (v_note IS NOT NULL AND char_length(v_note) > 2000) THEN
    RETURN jsonb_build_object('status', 'invalid_request');
  END IF;

  SELECT * INTO v_check
  FROM swarm.review_checks AS rc
  WHERE rc.workspace_id = p_workspace_id AND rc.check_id = p_check_id
  FOR UPDATE;

  IF NOT FOUND OR NOT swarm.review_check_can_read(
    p_workspace_id, p_actor_kind, p_actor_id,
    v_check.conversation_id, v_check.thread_root_id, v_check.root_audience
  ) THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  IF v_check.conversation_id IS NOT NULL THEN
    v_audit_channel_id := swarm.review_check_channel_id(p_workspace_id, v_check.conversation_id);
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_check.required_seats) AS s(item)
    WHERE item->>'kind' = p_actor_kind
      AND (item->>'id')::uuid = p_actor_id
  ) INTO v_is_required;

  IF NOT v_is_required THEN
    RETURN jsonb_build_object('status', 'not_required_seat', 'audit_channel_id', v_audit_channel_id);
  END IF;

  IF v_check.head_sha <> v_sha THEN
    RETURN jsonb_build_object(
      'status', 'stale_head',
      'current_head_sha', v_check.head_sha,
      'audit_channel_id', v_audit_channel_id
    );
  END IF;

  INSERT INTO swarm.review_check_stamps (
    check_id, workspace_id, seat_kind, seat_id, head_sha, verdict, note, stamped_at
  ) VALUES (
    v_check.check_id, p_workspace_id, p_actor_kind, p_actor_id, v_sha, p_verdict, v_note, v_now
  )
  ON CONFLICT (check_id, seat_kind, seat_id) DO UPDATE
  SET
    head_sha = EXCLUDED.head_sha,
    verdict = EXCLUDED.verdict,
    note = EXCLUDED.note,
    stamped_at = EXCLUDED.stamped_at;

  UPDATE swarm.review_checks
  SET updated_at = v_now
  WHERE check_id = v_check.check_id;

  v_required_count := jsonb_array_length(v_check.required_seats);
  SELECT count(*)
  INTO v_passed_count
  FROM jsonb_array_elements(v_check.required_seats) AS s(item)
  JOIN swarm.review_check_stamps AS st
    ON st.check_id = v_check.check_id
   AND st.seat_kind = item->>'kind'
   AND st.seat_id = (item->>'id')::uuid
   AND st.head_sha = v_check.head_sha
   AND st.verdict = 'pass';

  IF v_required_count > 0
     AND v_passed_count = v_required_count
     AND v_check.satisfied_head_sha IS DISTINCT FROM v_check.head_sha THEN
    v_satisfied_now := true;

    IF v_check.conversation_id IS NOT NULL THEN
      SELECT c.conversation_id, c.kind, c.channel_id, c.archived_at
      INTO v_conv
      FROM swarm.conversations AS c
      WHERE c.workspace_id = p_workspace_id AND c.conversation_id = v_check.conversation_id;

      IF FOUND AND v_conv.archived_at IS NULL THEN
        v_body := format(
          'Review check satisfied for %s#%s @ %s (%s/%s required seats passed).',
          v_check.subject_repo,
          v_check.subject_ref,
          left(v_check.head_sha, 9),
          v_passed_count,
          v_required_count
        );

        IF v_conv.kind IN ('general', 'public_channel', 'private_channel') THEN
          IF v_check.root_audience = 'addressed' AND v_check.thread_root_id IS NOT NULL THEN
            -- Preserve the narrow addressed root audience: address ONLY the root's live participants
            -- (excluding the stamping actor when others exist, else self) so bystanders never see it.
            SELECT s.from_kind, s.from_principal, s.to_user_id, s.to_agent_principal_id
            INTO v_root
            FROM swarm.signals AS s
            WHERE s.workspace_id = p_workspace_id AND s.id = v_check.thread_root_id;

            IF FOUND THEN
              SELECT coalesce(jsonb_agg(jsonb_build_object('kind', p.kind, 'id', p.id) ORDER BY p.kind DESC, p.id), '[]'::jsonb)
              INTO v_to
              FROM (
                SELECT DISTINCT kind, id
                FROM (
                  SELECT v_root.from_kind::text AS kind, v_root.from_principal AS id
                  UNION ALL
                  SELECT 'user', v_root.to_user_id WHERE v_root.to_user_id IS NOT NULL
                  UNION ALL
                  SELECT 'agent', v_root.to_agent_principal_id WHERE v_root.to_agent_principal_id IS NOT NULL
                  UNION ALL
                  SELECT CASE WHEN sr.recipient_user_id IS NOT NULL THEN 'user' ELSE 'agent' END,
                         coalesce(sr.recipient_user_id, sr.recipient_agent_principal_id)
                  FROM swarm.signal_recipients AS sr
                  WHERE sr.workspace_id = p_workspace_id AND sr.signal_id = v_check.thread_root_id
                ) AS all_p
                WHERE id IS NOT NULL
                  AND NOT (kind = p_actor_kind AND id = p_actor_id)
                  AND swarm.review_check_can_read(
                    p_workspace_id, kind, id,
                    v_check.conversation_id, v_check.thread_root_id, 'addressed'
                  )
              ) AS p;

              IF jsonb_array_length(v_to) = 0 THEN
                v_to := jsonb_build_array(jsonb_build_object('kind', p_actor_kind, 'id', p_actor_id));
              END IF;

              v_to_user := NULL;
              v_to_agent := NULL;
              IF jsonb_array_length(v_to) = 1 THEN
                IF (v_to->0)->>'kind' = 'user' THEN
                  v_to_user := ((v_to->0)->>'id')::uuid;
                ELSE
                  v_to_agent := ((v_to->0)->>'id')::uuid;
                END IF;
              END IF;

              v_signal_id := gen_random_uuid();
              INSERT INTO swarm.signals (
                id, workspace_id, from_principal, from_kind,
                to_user_id, to_agent_principal_id,
                about, kind, body, until, created_at,
                channel_id, thread_root_id, broadcast_to_channel
              ) VALUES (
                v_signal_id, p_workspace_id, p_actor_id, p_actor_kind,
                v_to_user, v_to_agent,
                left(v_check.subject_repo || '#' || v_check.subject_ref, 500),
                'note', v_body, v_now + interval '30 days', v_now,
                v_conv.channel_id, v_check.thread_root_id, false
              );
              v_pos := 0;
              FOR v_rec IN SELECT value FROM jsonb_array_elements(v_to) LOOP
                INSERT INTO swarm.signal_recipients (
                  signal_id, workspace_id, position,
                  recipient_user_id, recipient_agent_principal_id, created_at
                ) VALUES (
                  v_signal_id, p_workspace_id, v_pos,
                  CASE WHEN v_rec->>'kind' = 'user' THEN (v_rec->>'id')::uuid ELSE NULL END,
                  CASE WHEN v_rec->>'kind' = 'agent' THEN (v_rec->>'id')::uuid ELSE NULL END,
                  v_now
                );
                v_pos := v_pos + 1;
              END LOOP;
            END IF;
          ELSE
            v_signal_id := gen_random_uuid();
            INSERT INTO swarm.signals (
              id, workspace_id, from_principal, from_kind,
              about, kind, body, until, created_at,
              channel_id, thread_root_id, broadcast_to_channel
            ) VALUES (
              v_signal_id, p_workspace_id, p_actor_id, p_actor_kind,
              left(v_check.subject_repo || '#' || v_check.subject_ref, 500),
              'note', v_body, v_now + interval '30 days', v_now,
              v_conv.channel_id, v_check.thread_root_id, false
            );
          END IF;
        ELSIF v_conv.kind IN ('dm', 'group_dm') THEN
          -- Re-verify Step 2b thread eligibility before writing a conversation-wide DM fulfillment note.
          -- If a live member added after open cannot read the narrow addressed root, skip the DM
          -- note cleanly rather than aborting the final stamp or exposing it to the new member.
          IF v_check.thread_root_id IS NULL
            OR EXISTS (
              SELECT 1
              FROM swarm.signals AS r
              JOIN swarm.conversation_signals AS rcs
                ON rcs.workspace_id = r.workspace_id AND rcs.signal_id = r.id
              WHERE r.workspace_id = p_workspace_id
                AND r.id = v_check.thread_root_id
                AND r.thread_root_id IS NULL
                AND rcs.conversation_id = v_conv.conversation_id
                AND (
                  rcs.audience = 'conversation'
                  OR (
                    rcs.audience = 'addressed'
                    AND NOT EXISTS (
                      SELECT 1
                      FROM swarm.conversation_members AS lm
                      WHERE lm.conversation_id = v_conv.conversation_id
                        AND lm.workspace_id = p_workspace_id
                        AND lm.left_at IS NULL
                        AND swarm.conversation_signal_visible_to(
                          p_workspace_id, r.id, rcs.audience,
                          r.from_kind::text, r.from_principal,
                          r.to_user_id, r.to_agent_principal_id,
                          CASE WHEN lm.member_user_id IS NOT NULL THEN 'user' ELSE 'agent' END,
                          COALESCE(lm.member_user_id, lm.member_agent_principal_id)
                        ) IS NOT TRUE
                    )
                  )
                )
            ) THEN
            v_named_agents := NULL;
            IF v_conv.kind = 'group_dm' THEN
              SELECT coalesce(array_agg(m.member_agent_principal_id), '{}')
              INTO v_named_agents
              FROM swarm.conversation_members AS m
              WHERE m.conversation_id = v_conv.conversation_id
                AND m.workspace_id = p_workspace_id
                AND m.left_at IS NULL
                AND m.member_agent_principal_id IS NOT NULL
                AND NOT (p_actor_kind = 'agent' AND m.member_agent_principal_id = p_actor_id)
                AND swarm.actor_can_access_channel(p_workspace_id, NULL, 'agent', m.member_agent_principal_id);
            END IF;
            v_route := swarm.conversation_post_route(
              p_workspace_id, p_actor_kind, p_actor_id, v_conv.conversation_id, NULL, v_named_agents
            );
            IF v_route->>'status' = 'ok' AND jsonb_array_length(v_route->'to') > 0 THEN
              v_to := v_route->'to';
              v_to_user := NULL;
              v_to_agent := NULL;
              IF jsonb_array_length(v_to) = 1 THEN
                IF (v_to->0)->>'kind' = 'user' THEN
                  v_to_user := ((v_to->0)->>'id')::uuid;
                ELSE
                  v_to_agent := ((v_to->0)->>'id')::uuid;
                END IF;
              END IF;
              v_signal_id := gen_random_uuid();
              INSERT INTO swarm.signals (
                id, workspace_id, from_principal, from_kind,
                to_user_id, to_agent_principal_id,
                about, kind, body, until, created_at,
                thread_root_id, broadcast_to_channel
              ) VALUES (
                v_signal_id, p_workspace_id, p_actor_id, p_actor_kind,
                v_to_user, v_to_agent,
                left(v_check.subject_repo || '#' || v_check.subject_ref, 500),
                'note', v_body, v_now + interval '30 days', v_now,
                v_check.thread_root_id, false
              );
              v_pos := 0;
              FOR v_rec IN SELECT value FROM jsonb_array_elements(v_to) LOOP
                INSERT INTO swarm.signal_recipients (
                  signal_id, workspace_id, position,
                  recipient_user_id, recipient_agent_principal_id, created_at
                ) VALUES (
                  v_signal_id, p_workspace_id, v_pos,
                  CASE WHEN v_rec->>'kind' = 'user' THEN (v_rec->>'id')::uuid ELSE NULL END,
                  CASE WHEN v_rec->>'kind' = 'agent' THEN (v_rec->>'id')::uuid ELSE NULL END,
                  v_now
                );
                v_pos := v_pos + 1;
              END LOOP;
              PERFORM swarm.conversation_prefile(p_workspace_id, v_signal_id, v_conv.conversation_id);
            END IF;
          END IF;
        END IF;
      END IF;
    END IF;

    UPDATE swarm.review_checks
    SET
      satisfied_head_sha = v_check.head_sha,
      satisfied_signal_id = v_signal_id,
      satisfied_at = v_now,
      updated_at = v_now
    WHERE check_id = v_check.check_id;
  END IF;

  RETURN jsonb_build_object(
    'status', 'ok',
    'satisfied_now', v_satisfied_now,
    'satisfied_signal_id', v_signal_id,
    'audit_channel_id', v_audit_channel_id,
    'check', swarm.review_check_payload(v_check.check_id)
  );
END;
$$;

-- Read one review check (by check_id or repo+ref) or a bounded list of readable checks.
CREATE FUNCTION swarm.review_check_read(
  p_workspace_id uuid,
  p_actor_kind text,
  p_actor_id uuid,
  p_check_id uuid DEFAULT NULL,
  p_subject_repo text DEFAULT NULL,
  p_subject_ref text DEFAULT NULL,
  p_thread_root_id uuid DEFAULT NULL,
  p_conversation_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 20
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_check swarm.review_checks%ROWTYPE;
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_rows jsonb;
BEGIN
  IF p_actor_kind IS NULL OR p_actor_kind NOT IN ('user', 'agent') OR p_actor_id IS NULL
     OR NOT swarm.actor_can_access_channel(p_workspace_id, NULL, p_actor_kind, p_actor_id) THEN
    RETURN jsonb_build_object('status', 'forbidden');
  END IF;

  IF p_check_id IS NOT NULL THEN
    SELECT * INTO v_check
    FROM swarm.review_checks AS rc
    WHERE rc.workspace_id = p_workspace_id AND rc.check_id = p_check_id;
    IF NOT FOUND OR NOT swarm.review_check_can_read(
      p_workspace_id, p_actor_kind, p_actor_id,
      v_check.conversation_id, v_check.thread_root_id, v_check.root_audience
    ) THEN
      RETURN jsonb_build_object('status', 'not_found');
    END IF;
    RETURN jsonb_build_object('status', 'ok', 'check', swarm.review_check_payload(v_check.check_id));
  END IF;

  IF p_subject_repo IS NOT NULL AND p_subject_ref IS NOT NULL THEN
    SELECT * INTO v_check
    FROM swarm.review_checks AS rc
    WHERE rc.workspace_id = p_workspace_id
      AND rc.subject_kind = 'pr'
      AND rc.subject_repo = btrim(p_subject_repo)
      AND rc.subject_ref = btrim(p_subject_ref)
      AND (p_thread_root_id IS NULL OR rc.thread_root_id = p_thread_root_id)
      AND (p_conversation_id IS NULL OR rc.conversation_id = p_conversation_id)
      AND swarm.review_check_can_read(
        p_workspace_id, p_actor_kind, p_actor_id,
        rc.conversation_id, rc.thread_root_id, rc.root_audience
      )
    ORDER BY rc.updated_at DESC, rc.check_id ASC
    LIMIT 1;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('status', 'not_found');
    END IF;
    RETURN jsonb_build_object('status', 'ok', 'check', swarm.review_check_payload(v_check.check_id));
  END IF;

  SELECT coalesce(jsonb_agg(swarm.review_check_payload(sub.check_id)), '[]'::jsonb)
  INTO v_rows
  FROM (
    SELECT rc.check_id
    FROM swarm.review_checks AS rc
    WHERE rc.workspace_id = p_workspace_id
      AND (p_thread_root_id IS NULL OR rc.thread_root_id = p_thread_root_id)
      AND (p_conversation_id IS NULL OR rc.conversation_id = p_conversation_id)
      AND swarm.review_check_can_read(
        p_workspace_id, p_actor_kind, p_actor_id,
        rc.conversation_id, rc.thread_root_id, rc.root_audience
      )
    ORDER BY rc.updated_at DESC, rc.check_id ASC
    LIMIT v_limit
  ) AS sub;

  RETURN jsonb_build_object('status', 'ok', 'checks', v_rows);
END;
$$;

ALTER TABLE swarm.review_checks OWNER TO swarm_admin;
ALTER TABLE swarm.review_check_stamps OWNER TO swarm_admin;

ALTER FUNCTION swarm.review_check_validate_refs() OWNER TO swarm_admin;
ALTER FUNCTION swarm.review_check_placement_immutable() OWNER TO swarm_admin;
ALTER FUNCTION swarm.review_check_can_read(uuid, text, uuid, uuid, uuid, text) OWNER TO swarm_admin;
ALTER FUNCTION swarm.review_check_channel_id(uuid, uuid) OWNER TO swarm_admin;
ALTER FUNCTION swarm.review_check_can_manage(uuid, text, uuid, uuid) OWNER TO swarm_admin;
ALTER FUNCTION swarm.review_check_replay_visible(uuid, text, uuid, uuid) OWNER TO swarm_admin;
ALTER FUNCTION swarm.review_check_payload(uuid) OWNER TO swarm_admin;
ALTER FUNCTION swarm.review_check_open(uuid, text, uuid, text, text, text, jsonb, uuid, uuid, uuid) OWNER TO swarm_admin;
ALTER FUNCTION swarm.review_check_stamp(uuid, text, uuid, uuid, text, text, text) OWNER TO swarm_admin;
ALTER FUNCTION swarm.review_check_read(uuid, text, uuid, uuid, text, text, uuid, uuid, integer) OWNER TO swarm_admin;

REVOKE ALL ON FUNCTION swarm.review_check_validate_refs() FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
REVOKE ALL ON FUNCTION swarm.review_check_placement_immutable() FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
REVOKE ALL ON FUNCTION swarm.review_check_can_read(uuid, text, uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
REVOKE ALL ON FUNCTION swarm.review_check_channel_id(uuid, uuid) FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
REVOKE ALL ON FUNCTION swarm.review_check_can_manage(uuid, text, uuid, uuid) FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
REVOKE ALL ON FUNCTION swarm.review_check_replay_visible(uuid, text, uuid, uuid) FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
REVOKE ALL ON FUNCTION swarm.review_check_payload(uuid) FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
REVOKE ALL ON FUNCTION swarm.review_check_open(uuid, text, uuid, text, text, text, jsonb, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
REVOKE ALL ON FUNCTION swarm.review_check_stamp(uuid, text, uuid, uuid, text, text, text) FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
REVOKE ALL ON FUNCTION swarm.review_check_read(uuid, text, uuid, uuid, text, text, uuid, uuid, integer) FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;

GRANT EXECUTE ON FUNCTION swarm.review_check_open(uuid, text, uuid, text, text, text, jsonb, uuid, uuid, uuid) TO swarm_command;
GRANT EXECUTE ON FUNCTION swarm.review_check_stamp(uuid, text, uuid, uuid, text, text, text) TO swarm_command;
GRANT EXECUTE ON FUNCTION swarm.review_check_replay_visible(uuid, text, uuid, uuid) TO swarm_command;
GRANT EXECUTE ON FUNCTION swarm.review_check_read(uuid, text, uuid, uuid, text, text, uuid, uuid, integer) TO swarm_read;

RESET search_path;
