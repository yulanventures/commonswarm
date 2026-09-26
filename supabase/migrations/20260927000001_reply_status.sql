BEGIN;

ALTER TABLE swarm.signals
  ADD COLUMN reply_status text,
  ADD CONSTRAINT signals_reply_status_valid CHECK (
    reply_status IS NULL OR (
      reply_status IN ('answered', 'failed', 'declined')
      AND in_reply_to IS NOT NULL
    )
  );

COMMENT ON COLUMN swarm.signals.reply_status IS
  'Optional sender-declared outcome for a private reply. NULL preserves replies from older clients.';

-- Preserve the live reader predicate and every existing explicit projection,
-- adding the new column at the select-list boundary rather than rebuilding the
-- security-barrier view from an older migration.
SELECT set_config(
  'swarm.signals_view_before',
  pg_get_viewdef('swarm_read.signals'::regclass, true),
  false
);

DO $$
DECLARE
  live_def text := current_setting('swarm.signals_view_before');
  body text;
BEGIN
  IF live_def !~ '\sFROM\s+(swarm\.)?signals\s' THEN
    RAISE EXCEPTION 'could not locate the swarm_read.signals select-list boundary';
  END IF;
  body := regexp_replace(
    live_def,
    '(\s)(FROM\s+(?:swarm\.)?signals\s)',
    E',\n    s.reply_status\\1\\2'
  );
  body := rtrim(body, E' ;\n\t');
  EXECUTE 'CREATE OR REPLACE VIEW swarm_read.signals WITH (security_barrier = true) AS ' || body;
END;
$$;

ALTER VIEW swarm_read.signals OWNER TO swarm_admin;
GRANT SELECT ON swarm_read.signals TO authenticated, swarm_read;
REVOKE ALL ON swarm_read.signals FROM anon;
SELECT swarm.assert_view_clauses_preserved(
  'swarm_read.signals', current_setting('swarm.signals_view_before')
);
SELECT set_config('swarm.signals_view_before', '', false);

-- This is the current 20260925000001 wrapper with one additive `replies`
-- field. The underlying receipt function still owns author/member scoping and
-- every existing receipt field keeps its prior meaning.
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

  IF v_result ->> 'addressed' = 'true' THEN
    SELECT COALESCE(jsonb_agg(
      CASE WHEN receipt.value ? 'recipient_agent_principal_id' THEN
        receipt.value || jsonb_build_object('wake_path_observing', EXISTS (
          SELECT 1 FROM swarm.wake_path_eligible_deliveries AS d
          WHERE d.workspace_id = p_workspace_id AND d.signal_id = p_signal_id
            AND d.principal_id = (receipt.value ->> 'recipient_agent_principal_id')::uuid
        ))
      ELSE receipt.value END ORDER BY receipt.ordinality), '[]'::jsonb)
    INTO v_receipts FROM jsonb_array_elements(v_result -> 'receipts')
      WITH ORDINALITY AS receipt(value, ordinality);
    v_result := jsonb_set(v_result, '{receipts}', v_receipts, false);
  END IF;

  -- The inner function accepts an agent only for its own authored signal, so
  -- that signal's author is the authenticated agent principal on this branch.
  IF v_human_user_id IS NULL AND p_agent_token_hash IS NOT NULL THEN
    SELECT original.from_principal
    INTO v_agent_principal_id
    FROM swarm.signals AS original
    WHERE original.workspace_id = p_workspace_id
      AND original.id = p_signal_id
      AND original.from_kind = 'agent';
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
   AND responder_agent.workspace_id = reply.workspace_id
   AND responder_agent.principal_id = reply.from_principal
  WHERE reply.workspace_id = p_workspace_id
    AND reply.in_reply_to = p_signal_id
    AND (
      (v_human_user_id IS NOT NULL AND (
        reply.to_user_id = v_human_user_id OR
        (reply.from_kind = 'user' AND reply.from_principal = v_human_user_id) OR
        EXISTS (
          SELECT 1 FROM swarm.agent_principals AS owned
          WHERE owned.workspace_id = reply.workspace_id
            AND owned.owner_user_id = v_human_user_id
            AND (
              owned.principal_id = reply.to_agent_principal_id OR
              (reply.from_kind = 'agent' AND owned.principal_id = reply.from_principal)
            )
        )
      ))
      OR
      (v_agent_principal_id IS NOT NULL AND (
        reply.to_agent_principal_id = v_agent_principal_id OR
        (reply.from_kind = 'agent' AND reply.from_principal = v_agent_principal_id)
      ))
    );

  RETURN v_result || jsonb_build_object('replies', v_replies);
END;
$$;
ALTER FUNCTION swarm_read.signal_delivery_receipts(uuid, uuid, bytea) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm_read.signal_delivery_receipts(uuid, uuid, bytea) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION swarm_read.signal_delivery_receipts(uuid, uuid, bytea)
  TO authenticated, swarm_read;

COMMIT;
