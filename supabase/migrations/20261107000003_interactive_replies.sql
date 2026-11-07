-- Interactive agent replies, G1: an agent's ask can carry fixed choices, and a person answers by
-- clicking one. The click is only that person's ordinary reply to the ask; it grants nothing else.
-- Everything is behind SWARM_INTERACTIVE_REPLIES (off), enforced in the command edge.
--
-- The choices are stored once, with the ask, and never change: the command role can insert and
-- read them but has no UPDATE or DELETE. An answer is checked against this stored copy, never
-- against anything the browser sends. ui_actions records every attempt (pending, approved,
-- completed, failed); the first completed answer per ask wins, enforced by a unique index.

CREATE TABLE swarm.ask_choices (
  signal_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  options jsonb NOT NULL CHECK (
    jsonb_typeof(options) = 'array'
    AND jsonb_array_length(options) BETWEEN 2 AND 6
    AND pg_column_size(options) <= 2048
  ),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  FOREIGN KEY (signal_id, workspace_id) REFERENCES swarm.signals (id, workspace_id)
);

ALTER TABLE swarm.ask_choices ADD CONSTRAINT ask_choices_signal_workspace UNIQUE (signal_id, workspace_id);

CREATE TABLE swarm.ui_actions (
  action_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  signal_id uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  option_id text NOT NULL CHECK (option_id ~ '^[a-z0-9][a-z0-9_-]{0,31}$'),
  state text NOT NULL CHECK (state IN ('pending', 'approved', 'completed', 'failed')),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  reply_signal_id uuid,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  completed_at timestamptz,
  FOREIGN KEY (signal_id, workspace_id) REFERENCES swarm.ask_choices (signal_id, workspace_id),
  CHECK ((state = 'completed') = (reply_signal_id IS NOT NULL AND completed_at IS NOT NULL)),
  CHECK (state <> 'failed' OR error_code IS NOT NULL)
);
-- The first completed answer wins; a second can never complete.
CREATE UNIQUE INDEX ui_actions_first_answer ON swarm.ui_actions (signal_id) WHERE state = 'completed';
CREATE INDEX ui_actions_attempts ON swarm.ui_actions (signal_id, actor_user_id, created_at);

ALTER TABLE swarm.ask_choices OWNER TO swarm_admin;
ALTER TABLE swarm.ui_actions OWNER TO swarm_admin;
ALTER TABLE swarm.ask_choices ENABLE ROW LEVEL SECURITY;
ALTER TABLE swarm.ui_actions ENABLE ROW LEVEL SECURITY;
CREATE POLICY ask_choices_command_all ON swarm.ask_choices AS PERMISSIVE FOR ALL TO swarm_command
  USING (true) WITH CHECK (true);
CREATE POLICY ui_actions_command_all ON swarm.ui_actions AS PERMISSIVE FOR ALL TO swarm_command
  USING (true) WITH CHECK (true);
REVOKE ALL ON swarm.ask_choices, swarm.ui_actions FROM PUBLIC, anon, authenticated, swarm_read;
-- Choices are write-once: no UPDATE or DELETE for anyone but the owner.
GRANT SELECT, INSERT ON swarm.ask_choices TO swarm_command;
GRANT SELECT, INSERT, UPDATE ON swarm.ui_actions TO swarm_command;

-- For the signed-in person: the stored choices of up to 50 asks they can read (through
-- swarm_read.signals under their claims), and the winning answer if one exists. People only;
-- claims naming an agent, non-members, and unreadable or unknown ids all get nothing.
CREATE FUNCTION swarm_read.ask_choices(p_workspace_id uuid, p_signal_ids uuid[])
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
    'answer', (SELECT jsonb_build_object('option_id', a.option_id, 'by_viewer', a.actor_user_id = viewer,
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
