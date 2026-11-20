-- Fix statement timeouts (SQLSTATE 57014) in swarm_read.ask_choices at production signal volume.
--
-- Previously ask_choices filtered swarm.ask_choices (c.workspace_id = p_workspace_id AND
-- c.signal_id = ANY (p_signal_ids)) and joined swarm_read.signals s on (s.id = c.signal_id AND
-- s.workspace_id = c.workspace_id). Because swarm_read.signals is a security_barrier view,
-- PostgreSQL cannot push the join predicate into the view subquery: it scanned every signal in
-- the workspace (evaluating is_member, claims_can_access_channel, claims_is_signal_sender, and
-- signal_recipients across the workspace), materialized all visible rows, and nested-looped
-- against p_signal_ids, exceeding the 8 s authenticated statement_timeout on active workspaces.
--
-- Filtering swarm_read.signals directly with the leakproof predicates (s.workspace_id =
-- p_workspace_id AND s.id = ANY (p_signal_ids)) lets PostgreSQL push both predicates inside the
-- security_barrier view into signals_id_workspace, then probe ask_choices_signal_workspace and
-- the partial unique index ui_actions_first_answer in O(|p_signal_ids|) (at most 50 rows) for
-- both custom and cached generic plans. Visibility, output shape, and grants are unchanged.
--
-- Rollback: restore swarm_read.ask_choices(uuid, uuid[]) from
-- supabase/migrations/20261116000004_choice_asks_v2.sql (lines 51-86).

CREATE OR REPLACE FUNCTION swarm_read.ask_choices(p_workspace_id uuid, p_signal_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog AS $$
DECLARE
 claims jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
 viewer uuid;
BEGIN
 IF claims IS NULL OR claims->>'role' IS DISTINCT FROM 'authenticated' OR claims ? 'agent_principal_id'
  OR coalesce(claims->>'sub', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
  RETURN NULL;
 END IF;
 viewer := (claims->>'sub')::uuid;
 IF p_workspace_id IS NULL OR NOT swarm.is_member(p_workspace_id, viewer) THEN RETURN NULL; END IF;
 IF p_signal_ids IS NULL OR cardinality(p_signal_ids) > 50 THEN RETURN NULL; END IF;
 IF cardinality(p_signal_ids) = 0 THEN
  RETURN jsonb_build_object('workspace_id', p_workspace_id, 'untrusted_content', true, 'asks', '[]'::jsonb);
 END IF;
 RETURN jsonb_build_object('workspace_id', p_workspace_id, 'untrusted_content', true, 'asks', (
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'signal_id', c.signal_id,
    'options', c.options,
    'multi', c.multi,
    'answer', CASE WHEN a.action_id IS NOT NULL THEN jsonb_build_object(
        'option_id', a.option_id,
        'option_ids', to_jsonb(coalesce(a.option_ids, ARRAY[a.option_id])),
        'other_text', a.other_text, 'actor_user_id', a.actor_user_id,
        'by_viewer', a.actor_user_id = viewer,
        'reply_signal_id', a.reply_signal_id, 'at', a.completed_at)
      ELSE NULL END)
    ORDER BY c.signal_id), '[]'::jsonb)
  FROM swarm_read.signals s
  JOIN swarm.ask_choices c ON c.signal_id = s.id AND c.workspace_id = s.workspace_id
  LEFT JOIN swarm.ui_actions a ON a.signal_id = c.signal_id AND a.state = 'completed'
  WHERE s.workspace_id = p_workspace_id AND s.id = ANY (p_signal_ids)));
END;
$$;

ALTER FUNCTION swarm_read.ask_choices(uuid, uuid[]) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm_read.ask_choices(uuid, uuid[])
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT EXECUTE ON FUNCTION swarm_read.ask_choices(uuid, uuid[]) TO authenticated;
