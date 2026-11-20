-- Revision-bound review checks (C3):
-- One canonical record per (workspace, subject_kind, subject_repo, subject_ref) holding:
--   - the subject (repo and PR) and current head_sha;
--   - the required seats (active workspace people and/or agents);
--   - per-seat stamps of pass or hold bound to a specific head_sha.
--
-- Security & concurrency invariants:
--   1. Only the named seat stamps its own row: review_check_stamp derives (seat_kind, seat_id)
--      strictly from the authenticated caller identity and requires membership in required_seats.
--   2. A new head_sha invalidates earlier stamps (stamps with stamp.head_sha <> check.head_sha
--      report stale = true and effective_verdict = 'pending'); stamping an old head_sha is refused
--      with status = 'stale_head'.
--   3. When every required seat passes at the current head_sha, post ONE thread note, once per
--      head_sha (serialized under FOR UPDATE on swarm.review_checks and guarded by
--      satisfied_head_sha IS DISTINCT FROM head_sha).
--   4. Conversation-scoped checks enforce swarm.conversation_visible uniform 404 on open, stamp,
--      and read so private conversations/DMs are never disclosed.
--   5. Zero parent-locking FOREIGN KEY constraints on swarm.workspaces, swarm.conversations,
--      swarm.signals, swarm.memberships, or swarm.agent_principals: referential checks use a
--      read-only MVCC trigger so check writes never acquire FOR KEY SHARE locks on parent tables.
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
  head_sha text NOT NULL CHECK (head_sha ~ '^[0-9a-f]{7,64}$'),
  conversation_id uuid,
  thread_root_id uuid,
  required_seats jsonb NOT NULL CHECK (
    jsonb_typeof(required_seats) = 'array'
    AND jsonb_array_length(required_seats) BETWEEN 1 AND 20
  ),
  created_by_kind text NOT NULL CHECK (created_by_kind IN ('user', 'agent')),
  created_by_id uuid NOT NULL,
  satisfied_head_sha text CHECK (satisfied_head_sha IS NULL OR satisfied_head_sha ~ '^[0-9a-f]{7,64}$'),
  satisfied_signal_id uuid,
  satisfied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, subject_kind, subject_repo, subject_ref)
);

CREATE INDEX review_checks_workspace_updated
  ON swarm.review_checks (workspace_id, updated_at DESC, check_id ASC);

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
  head_sha text NOT NULL CHECK (head_sha ~ '^[0-9a-f]{7,64}$'),
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

CREATE TRIGGER review_checks_validate_refs
  BEFORE INSERT OR UPDATE ON swarm.review_checks
  FOR EACH ROW EXECUTE FUNCTION swarm.review_check_validate_refs();

ALTER TABLE swarm.review_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE swarm.review_check_stamps ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE swarm.review_checks FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
REVOKE ALL ON TABLE swarm.review_check_stamps FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;

-- Caller visibility predicate: active workspace member + conversation visibility when scoped.
CREATE FUNCTION swarm.review_check_can_read(
  p_workspace_id uuid,
  p_actor_kind text,
  p_actor_id uuid,
  p_conversation_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT
    p_actor_kind IN ('user', 'agent')
    AND p_actor_id IS NOT NULL
    AND swarm.actor_can_access_channel(p_workspace_id, NULL, p_actor_kind, p_actor_id)
    AND (
      p_conversation_id IS NULL
      OR swarm.conversation_visible(p_workspace_id, p_actor_kind, p_actor_id, p_conversation_id)
    );
$$;

-- Canonical JSON payload for one review check including current/stale stamp status.
CREATE FUNCTION swarm.review_check_payload(p_check_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_check swarm.review_checks%ROWTYPE;
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
    'thread_root_id', v_check.thread_root_id,
    'required_seats', v_seats,
    'stamps', v_stamps,
    'status', v_status,
    'satisfied', v_status = 'satisfied',
    'satisfied_head_sha', v_check.satisfied_head_sha,
    'satisfied_signal_id', v_check.satisfied_signal_id,
    'satisfied_at', v_check.satisfied_at,
    'created_by', jsonb_build_object('kind', v_check.created_by_kind, 'id', v_check.created_by_id),
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
  p_thread_root_id uuid DEFAULT NULL
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
  v_root_conv uuid;
  v_root_parent uuid;
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
     OR v_sha !~ '^[0-9a-f]{7,64}$'
     OR p_required_seats IS NULL
     OR jsonb_typeof(p_required_seats) <> 'array'
     OR jsonb_array_length(p_required_seats) NOT BETWEEN 1 AND 20 THEN
    RETURN jsonb_build_object('status', 'invalid_request');
  END IF;

  IF v_root_id IS NOT NULL THEN
    SELECT s.thread_root_id, cs.conversation_id
    INTO v_root_parent, v_root_conv
    FROM swarm.signals AS s
    LEFT JOIN swarm.conversation_signals AS cs
      ON cs.workspace_id = s.workspace_id AND cs.signal_id = s.id
    WHERE s.workspace_id = p_workspace_id AND s.id = v_root_id;
    IF NOT FOUND OR v_root_parent IS NOT NULL THEN
      RETURN jsonb_build_object('status', 'not_found');
    END IF;
    IF v_conv_id IS NOT NULL AND v_root_conv IS NOT NULL AND v_conv_id <> v_root_conv THEN
      RETURN jsonb_build_object('status', 'not_found');
    END IF;
    v_conv_id := coalesce(v_conv_id, v_root_conv);
  END IF;

  IF v_conv_id IS NOT NULL THEN
    IF NOT swarm.conversation_visible(p_workspace_id, p_actor_kind, p_actor_id, v_conv_id) THEN
      RETURN jsonb_build_object('status', 'not_found');
    END IF;
  END IF;

  -- Validate and deduplicate every required seat.
  FOR v_seat IN SELECT value FROM jsonb_array_elements(p_required_seats) LOOP
    IF jsonb_typeof(v_seat) <> 'object' THEN
      RETURN jsonb_build_object('status', 'invalid_request');
    END IF;
    v_seat_kind := v_seat->>'kind';
    IF v_seat_kind NOT IN ('user', 'agent') OR coalesce(v_seat->>'id', '') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
      RETURN jsonb_build_object('status', 'invalid_request');
    END IF;
    v_seat_id := (v_seat->>'id')::uuid;
    v_key := v_seat_kind || ':' || v_seat_id::text;
    IF v_key = ANY (v_seen) THEN
      CONTINUE;
    END IF;
    IF NOT swarm.actor_can_access_channel(p_workspace_id, NULL, v_seat_kind, v_seat_id) THEN
      RETURN jsonb_build_object('status', 'invalid_seat', 'seat_kind', v_seat_kind, 'seat_id', v_seat_id);
    END IF;
    IF v_conv_id IS NOT NULL AND NOT swarm.conversation_visible(p_workspace_id, v_seat_kind, v_seat_id, v_conv_id) THEN
      RETURN jsonb_build_object('status', 'invalid_seat', 'seat_kind', v_seat_kind, 'seat_id', v_seat_id);
    END IF;
    v_seen := array_append(v_seen, v_key);
    v_dedup := v_dedup || jsonb_build_array(jsonb_build_object('kind', v_seat_kind, 'id', v_seat_id::text));
  END LOOP;

  SELECT * INTO v_existing
  FROM swarm.review_checks AS rc
  WHERE rc.workspace_id = p_workspace_id
    AND rc.subject_kind = 'pr'
    AND rc.subject_repo = v_repo
    AND rc.subject_ref = v_ref
  FOR UPDATE;

  IF FOUND THEN
    IF NOT swarm.review_check_can_read(p_workspace_id, p_actor_kind, p_actor_id, v_existing.conversation_id) THEN
      RETURN jsonb_build_object('status', 'not_found');
    END IF;
    v_head_changed := v_existing.head_sha <> v_sha;
    UPDATE swarm.review_checks
    SET
      head_sha = v_sha,
      required_seats = v_dedup,
      conversation_id = coalesce(v_conv_id, conversation_id),
      thread_root_id = coalesce(v_root_id, thread_root_id),
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
      conversation_id, thread_root_id, required_seats,
      created_by_kind, created_by_id, created_at, updated_at
    ) VALUES (
      p_workspace_id, 'pr', v_repo, v_ref, v_sha,
      v_conv_id, v_root_id, v_dedup,
      p_actor_kind, p_actor_id, v_now, v_now
    )
    RETURNING check_id INTO v_check_id;
    v_created := true;
    v_head_changed := true;
  END IF;

  RETURN jsonb_build_object(
    'status', 'ok',
    'created', v_created,
    'head_changed', v_head_changed,
    'check', swarm.review_check_payload(v_check_id)
  );
END;
$$;

-- Record caller's own pass/hold stamp for the current head_sha; post one thread note once satisfied.
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
  v_is_required boolean := false;
  v_required_count integer := 0;
  v_passed_count integer := 0;
  v_satisfied_now boolean := false;
  v_signal_id uuid := NULL;
  v_conv record;
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

  IF p_check_id IS NULL OR v_sha !~ '^[0-9a-f]{7,64}$'
     OR p_verdict NOT IN ('pass', 'hold')
     OR (v_note IS NOT NULL AND char_length(v_note) > 2000) THEN
    RETURN jsonb_build_object('status', 'invalid_request');
  END IF;

  SELECT * INTO v_check
  FROM swarm.review_checks AS rc
  WHERE rc.workspace_id = p_workspace_id AND rc.check_id = p_check_id
  FOR UPDATE;

  IF NOT FOUND OR NOT swarm.review_check_can_read(p_workspace_id, p_actor_kind, p_actor_id, v_check.conversation_id) THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_check.required_seats) AS s(item)
    WHERE item->>'kind' = p_actor_kind
      AND (item->>'id')::uuid = p_actor_id
  ) INTO v_is_required;

  IF NOT v_is_required THEN
    RETURN jsonb_build_object('status', 'not_required_seat');
  END IF;

  IF v_check.head_sha <> v_sha THEN
    RETURN jsonb_build_object(
      'status', 'stale_head',
      'current_head_sha', v_check.head_sha
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
      SELECT c.conversation_id, c.kind, c.channel_id
      INTO v_conv
      FROM swarm.conversations AS c
      WHERE c.workspace_id = p_workspace_id AND c.conversation_id = v_check.conversation_id;

      IF FOUND THEN
        v_body := format(
          'Review check satisfied for %s#%s @ %s (%s/%s required seats passed).',
          v_check.subject_repo,
          v_check.subject_ref,
          left(v_check.head_sha, 9),
          v_passed_count,
          v_required_count
        );

        IF v_conv.kind IN ('general', 'channel') THEN
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
        ELSIF v_conv.kind IN ('dm', 'group_dm') THEN
          v_route := swarm.conversation_post_route(
            p_workspace_id, p_actor_kind, p_actor_id, v_conv.conversation_id, NULL, NULL
          );
          IF v_route->>'status' = 'ok' AND jsonb_array_length(v_route->'to') > 0 THEN
            v_to := v_route->'to';
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
    IF NOT FOUND OR NOT swarm.review_check_can_read(p_workspace_id, p_actor_kind, p_actor_id, v_check.conversation_id) THEN
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
      AND rc.subject_ref = btrim(p_subject_ref);
    IF NOT FOUND OR NOT swarm.review_check_can_read(p_workspace_id, p_actor_kind, p_actor_id, v_check.conversation_id) THEN
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
      AND swarm.review_check_can_read(p_workspace_id, p_actor_kind, p_actor_id, rc.conversation_id)
    ORDER BY rc.updated_at DESC, rc.check_id ASC
    LIMIT v_limit
  ) AS sub;

  RETURN jsonb_build_object('status', 'ok', 'checks', v_rows);
END;
$$;

ALTER TABLE swarm.review_checks OWNER TO swarm_admin;
ALTER TABLE swarm.review_check_stamps OWNER TO swarm_admin;

ALTER FUNCTION swarm.review_check_validate_refs() OWNER TO swarm_admin;
ALTER FUNCTION swarm.review_check_can_read(uuid, text, uuid, uuid) OWNER TO swarm_admin;
ALTER FUNCTION swarm.review_check_payload(uuid) OWNER TO swarm_admin;
ALTER FUNCTION swarm.review_check_open(uuid, text, uuid, text, text, text, jsonb, uuid, uuid) OWNER TO swarm_admin;
ALTER FUNCTION swarm.review_check_stamp(uuid, text, uuid, uuid, text, text, text) OWNER TO swarm_admin;
ALTER FUNCTION swarm.review_check_read(uuid, text, uuid, uuid, text, text, uuid, uuid, integer) OWNER TO swarm_admin;

REVOKE ALL ON FUNCTION swarm.review_check_validate_refs() FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
REVOKE ALL ON FUNCTION swarm.review_check_can_read(uuid, text, uuid, uuid) FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
REVOKE ALL ON FUNCTION swarm.review_check_payload(uuid) FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
REVOKE ALL ON FUNCTION swarm.review_check_open(uuid, text, uuid, text, text, text, jsonb, uuid, uuid) FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
REVOKE ALL ON FUNCTION swarm.review_check_stamp(uuid, text, uuid, uuid, text, text, text) FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
REVOKE ALL ON FUNCTION swarm.review_check_read(uuid, text, uuid, uuid, text, text, uuid, uuid, integer) FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;

GRANT EXECUTE ON FUNCTION swarm.review_check_open(uuid, text, uuid, text, text, text, jsonb, uuid, uuid) TO swarm_command;
GRANT EXECUTE ON FUNCTION swarm.review_check_stamp(uuid, text, uuid, uuid, text, text, text) TO swarm_command;
GRANT EXECUTE ON FUNCTION swarm.review_check_read(uuid, text, uuid, uuid, text, text, uuid, uuid, integer) TO swarm_read;

RESET search_path;
