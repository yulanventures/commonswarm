-- Choice questions v2: an ask's options can carry a description and one recommended option, an
-- ask can take several answers (multi), and a person can answer with "Other" text. Channel asks
-- nobody is addressed in can be answered by any person who can read them; the command edge
-- enforces who may answer. Everything stays behind SWARM_INTERACTIVE_REPLIES.
--
-- Additive for clients still on v1: ui_actions.option_id stays filled (the first chosen id, or
-- 'other' for an answer that is only text), and swarm_read.ask_choices adds keys only.
--
-- Rollback: put back the v1 swarm_read.ask_choices body (20261107000003_interactive_replies.sql),
-- then drop ui_actions.other_text and option_ids, ask_choices.multi, and restore the 2048 options
-- bound once no stored options exceed it.

ALTER TABLE swarm.ask_choices ADD COLUMN multi boolean NOT NULL DEFAULT false;

-- The v1 options CHECK is unnamed; find it by its size bound rather than guess its name.
DO $$
DECLARE
  bound text;
BEGIN
  SELECT c.conname INTO STRICT bound
  FROM pg_constraint c
  WHERE c.conrelid = 'swarm.ask_choices'::regclass AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) LIKE '%pg_column_size(options)%2048%';
  EXECUTE format('ALTER TABLE swarm.ask_choices DROP CONSTRAINT %I', bound);
END;
$$;

ALTER TABLE swarm.ask_choices ADD CONSTRAINT ask_choices_options_shape CHECK (
  jsonb_typeof(options) = 'array'
  AND jsonb_array_length(options) BETWEEN 2 AND 6
  AND pg_column_size(options) <= 4096
);

ALTER TABLE swarm.ui_actions
  ADD COLUMN option_ids text[],
  ADD COLUMN other_text text;
ALTER TABLE swarm.ui_actions
  ADD CONSTRAINT ui_actions_option_ids_shape CHECK (
    option_ids IS NULL OR (cardinality(option_ids) <= 6 AND array_position(option_ids, NULL) IS NULL)
  ),
  ADD CONSTRAINT ui_actions_other_text_shape CHECK (
    other_text IS NULL OR (
      char_length(other_text) BETWEEN 1 AND 500
      AND other_text = btrim(other_text)
      AND other_text !~ '[[:cntrl:]]'
    )
  );

-- Adds multi on each ask, and on the answer the chosen ids, the "Other" text and who chose.
-- v1 answers have no option_ids; their one option_id stands in.
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
 RETURN jsonb_build_object('workspace_id', p_workspace_id, 'untrusted_content', true, 'asks', (
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'signal_id', c.signal_id,
    'options', c.options,
    'multi', c.multi,
    'answer', (SELECT jsonb_build_object('option_id', a.option_id,
        'option_ids', to_jsonb(coalesce(a.option_ids, ARRAY[a.option_id])),
        'other_text', a.other_text, 'actor_user_id', a.actor_user_id,
        'by_viewer', a.actor_user_id = viewer,
        'reply_signal_id', a.reply_signal_id, 'at', a.completed_at)
      FROM swarm.ui_actions a WHERE a.signal_id = c.signal_id AND a.state = 'completed'))
    ORDER BY c.signal_id), '[]'::jsonb)
  FROM swarm.ask_choices c
  JOIN swarm_read.signals s ON s.id = c.signal_id AND s.workspace_id = c.workspace_id
  WHERE c.workspace_id = p_workspace_id AND c.signal_id = ANY (p_signal_ids)));
END;
$$;
ALTER FUNCTION swarm_read.ask_choices(uuid, uuid[]) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm_read.ask_choices(uuid, uuid[])
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT EXECUTE ON FUNCTION swarm_read.ask_choices(uuid, uuid[]) TO authenticated;
