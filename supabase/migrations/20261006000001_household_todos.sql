CREATE TABLE swarm.household_todo_streams (
 workspace_id uuid PRIMARY KEY REFERENCES swarm.workspaces(workspace_id),
 stream_id uuid NOT NULL UNIQUE, last_seq bigint NOT NULL DEFAULT -1 CHECK (last_seq >= -1));
CREATE TABLE swarm.household_todo_events (
 workspace_id uuid NOT NULL REFERENCES swarm.household_todo_streams(workspace_id),
 seq bigint NOT NULL CHECK (seq >= 0), event_id uuid NOT NULL UNIQUE, occurred_at timestamptz NOT NULL,
 event jsonb NOT NULL CHECK (jsonb_typeof(event)='object' AND octet_length(event::text) <= 65536), PRIMARY KEY (workspace_id, seq),
 CHECK (coalesce(event->>'workspace_id'=workspace_id::text AND (event->>'seq')::bigint=seq AND event->>'event_id'=event_id::text,false)));
CREATE TABLE swarm.household_todos (
 workspace_id uuid NOT NULL REFERENCES swarm.workspaces(workspace_id), todo_id uuid NOT NULL,
 version int NOT NULL CHECK (version >= 1),
 title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200 AND title !~ '[[:cntrl:]]'),
 notes text NOT NULL DEFAULT '' CHECK (char_length(notes) <= 4000 AND notes !~ U&'[\0001-\0008\000B-\001F\007F-\009F]'),
 state text NOT NULL CHECK (state IN ('open','doing','done','dropped')), due_on date,
 created_by_user uuid NOT NULL, created_by_principal uuid, created_at timestamptz NOT NULL,
 assignee_user uuid, assignee_principal uuid, assigned_by_user uuid, assigned_by_principal uuid,
 assigned_at timestamptz, CHECK (assignee_user IS NULL OR assignee_principal IS NULL),
 offer_id uuid, offer_user uuid, offer_principal uuid, offer_decider uuid,
 offer_start text CHECK (offer_start IN ('queue','now')), offer_gate jsonb,
 offer_by_user uuid, offer_by_principal uuid, offered_at timestamptz,
 CHECK ((offer_id IS NULL) = (offer_decider IS NULL)),
 CHECK (offer_user IS NULL OR offer_principal IS NULL),
 CHECK (offer_id IS NULL OR (offer_user IS NOT NULL)::int + (offer_principal IS NOT NULL)::int = 1),
 CHECK (offer_id IS NOT NULL OR (offer_user IS NULL AND offer_principal IS NULL)),
 gate_kind text NOT NULL DEFAULT 'none' CHECK (gate_kind IN ('none','hold','after','at')),
 gate_note text CHECK (char_length(gate_note) <= 200), gate_todo_id uuid, gate_at timestamptz,
 gate_set_by uuid, CHECK ((gate_kind='after') = (gate_todo_id IS NOT NULL)),
 CHECK ((gate_kind='at') = (gate_at IS NOT NULL)),
 queue_rank bigint CHECK (queue_rank IS NULL OR assignee_principal IS NOT NULL),
 state_by_user uuid NOT NULL, state_by_principal uuid, state_at timestamptz NOT NULL,
 comment_count int NOT NULL DEFAULT 0 CHECK (comment_count >= 0),
 last_seq bigint NOT NULL, PRIMARY KEY (workspace_id, todo_id),
 FOREIGN KEY (assignee_principal, workspace_id) REFERENCES swarm.agent_principals(principal_id, workspace_id),
 FOREIGN KEY (offer_principal, workspace_id) REFERENCES swarm.agent_principals(principal_id, workspace_id),
 FOREIGN KEY (workspace_id, assignee_user) REFERENCES swarm.memberships(workspace_id, user_id),
 FOREIGN KEY (workspace_id, offer_user) REFERENCES swarm.memberships(workspace_id, user_id),
 FOREIGN KEY (workspace_id, gate_todo_id) REFERENCES swarm.household_todos(workspace_id, todo_id));
CREATE INDEX household_todos_queue ON swarm.household_todos (workspace_id, assignee_principal, queue_rank) WHERE state IN ('open','doing');
CREATE INDEX household_todos_person ON swarm.household_todos (workspace_id, assignee_user) WHERE state IN ('open','doing');
CREATE INDEX household_todos_offer ON swarm.household_todos (offer_decider) WHERE offer_id IS NOT NULL;
CREATE TABLE swarm.household_comments (
 workspace_id uuid NOT NULL REFERENCES swarm.workspaces(workspace_id), comment_id uuid NOT NULL,
 target_kind text NOT NULL CHECK (target_kind IN ('todo','list','doc','file')),
 target_id text NOT NULL CHECK (char_length(target_id) BETWEEN 1 AND 255),
 author_user uuid NOT NULL, author_principal uuid,
 body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000 AND body !~ U&'[\0001-\0008\000B-\001F\007F-\009F]'),
 mentions jsonb NOT NULL CHECK (jsonb_typeof(mentions)='array' AND jsonb_array_length(mentions) <= 8),
 notice_signal_id uuid, seq bigint NOT NULL, created_at timestamptz NOT NULL,
 PRIMARY KEY (workspace_id, comment_id));
CREATE INDEX household_comments_target ON swarm.household_comments (workspace_id, target_kind, target_id, seq);
CREATE TABLE swarm.household_agent_work_policies (
 workspace_id uuid NOT NULL, principal_id uuid NOT NULL,
 accepts_from text NOT NULL CHECK (accepts_from IN ('anyone','owner')),
 set_by_user uuid NOT NULL, set_at timestamptz NOT NULL, PRIMARY KEY (workspace_id, principal_id),
 FOREIGN KEY (principal_id, workspace_id) REFERENCES swarm.agent_principals(principal_id, workspace_id));
CREATE TABLE swarm.household_todo_receipts (
 workspace_id uuid NOT NULL REFERENCES swarm.workspaces(workspace_id), principal uuid NOT NULL,
 command_id text NOT NULL, request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
 outcome jsonb NOT NULL, created_at timestamptz NOT NULL, PRIMARY KEY (workspace_id, principal, command_id));
CREATE TRIGGER household_todo_events_append_only BEFORE UPDATE OR DELETE ON swarm.household_todo_events
 FOR EACH ROW EXECUTE FUNCTION swarm.prevent_append_only_mutation();
CREATE TRIGGER household_comments_append_only BEFORE UPDATE OR DELETE ON swarm.household_comments
 FOR EACH ROW EXECUTE FUNCTION swarm.prevent_append_only_mutation();
CREATE TRIGGER household_todo_receipts_append_only BEFORE UPDATE OR DELETE ON swarm.household_todo_receipts
 FOR EACH ROW EXECUTE FUNCTION swarm.prevent_append_only_mutation();
ALTER TABLE swarm.household_todo_streams OWNER TO swarm_admin;
ALTER TABLE swarm.household_todo_streams ENABLE ROW LEVEL SECURITY;
CREATE POLICY swarm_command_all ON swarm.household_todo_streams FOR ALL TO swarm_command USING (true) WITH CHECK (true);
REVOKE ALL ON swarm.household_todo_streams FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT SELECT, INSERT, UPDATE ON swarm.household_todo_streams TO swarm_command;
ALTER TABLE swarm.household_todo_events OWNER TO swarm_admin;
ALTER TABLE swarm.household_todo_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY swarm_command_all ON swarm.household_todo_events FOR ALL TO swarm_command USING (true) WITH CHECK (true);
REVOKE ALL ON swarm.household_todo_events FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT SELECT, INSERT ON swarm.household_todo_events TO swarm_command;
ALTER TABLE swarm.household_todos OWNER TO swarm_admin;
ALTER TABLE swarm.household_todos ENABLE ROW LEVEL SECURITY;
CREATE POLICY swarm_command_all ON swarm.household_todos FOR ALL TO swarm_command USING (true) WITH CHECK (true);
REVOKE ALL ON swarm.household_todos FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT SELECT, INSERT, UPDATE ON swarm.household_todos TO swarm_command;
ALTER TABLE swarm.household_comments OWNER TO swarm_admin;
ALTER TABLE swarm.household_comments ENABLE ROW LEVEL SECURITY;
CREATE POLICY swarm_command_all ON swarm.household_comments FOR ALL TO swarm_command USING (true) WITH CHECK (true);
REVOKE ALL ON swarm.household_comments FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT SELECT, INSERT ON swarm.household_comments TO swarm_command;
ALTER TABLE swarm.household_agent_work_policies OWNER TO swarm_admin;
ALTER TABLE swarm.household_agent_work_policies ENABLE ROW LEVEL SECURITY;
CREATE POLICY swarm_command_all ON swarm.household_agent_work_policies FOR ALL TO swarm_command USING (true) WITH CHECK (true);
REVOKE ALL ON swarm.household_agent_work_policies FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT SELECT, INSERT, UPDATE ON swarm.household_agent_work_policies TO swarm_command;
ALTER TABLE swarm.household_todo_receipts OWNER TO swarm_admin;
ALTER TABLE swarm.household_todo_receipts ENABLE ROW LEVEL SECURITY;
CREATE POLICY swarm_command_all ON swarm.household_todo_receipts FOR ALL TO swarm_command USING (true) WITH CHECK (true);
REVOKE ALL ON swarm.household_todo_receipts FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT SELECT, INSERT ON swarm.household_todo_receipts TO swarm_command;
