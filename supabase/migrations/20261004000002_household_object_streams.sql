-- Private reducer stream: drafts and receipts must not enter member-readable raw events.
CREATE TABLE swarm.household_object_streams (
 workspace_id uuid PRIMARY KEY REFERENCES swarm.household_workspace_boundaries(workspace_id),
 stream_id uuid NOT NULL UNIQUE,
 last_seq bigint NOT NULL DEFAULT -1 CHECK (last_seq >= -1),
 projection jsonb NOT NULL CHECK (jsonb_typeof(projection) = 'object')
);
CREATE TABLE swarm.household_object_events (
 workspace_id uuid NOT NULL REFERENCES swarm.household_object_streams(workspace_id),
 seq bigint NOT NULL CHECK (seq >= 0),
 event_id uuid NOT NULL UNIQUE,
 event jsonb NOT NULL CHECK (jsonb_typeof(event) = 'object' AND octet_length(event::text) <= 65536),
 PRIMARY KEY (workspace_id, seq),
 CHECK (coalesce(event->>'workspace_id' = workspace_id::text AND (event->>'seq')::bigint = seq AND event->>'event_id' = event_id::text, false))
);
CREATE TRIGGER household_object_events_append_only BEFORE UPDATE OR DELETE ON swarm.household_object_events
 FOR EACH ROW EXECUTE FUNCTION swarm.prevent_append_only_mutation();
CREATE TABLE swarm.household_object_audit (
 audit_id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL REFERENCES swarm.workspaces(workspace_id),
 command_id text NOT NULL,
 actor_user uuid NOT NULL,
 actor_principal uuid,
 occurred_at timestamptz NOT NULL,
 command_kind text NOT NULL,
 request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
 outcome text NOT NULL,
 reason_code text
);
CREATE TRIGGER household_object_audit_append_only BEFORE UPDATE OR DELETE ON swarm.household_object_audit
 FOR EACH ROW EXECUTE FUNCTION swarm.prevent_append_only_mutation();
ALTER TABLE swarm.household_object_streams OWNER TO swarm_admin;
ALTER TABLE swarm.household_object_streams ENABLE ROW LEVEL SECURITY;
CREATE POLICY swarm_command_all ON swarm.household_object_streams FOR ALL TO swarm_command USING (true) WITH CHECK (true);
REVOKE ALL ON swarm.household_object_streams FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT SELECT, INSERT, UPDATE ON swarm.household_object_streams TO swarm_command;
ALTER TABLE swarm.household_object_events OWNER TO swarm_admin;
ALTER TABLE swarm.household_object_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY swarm_command_all ON swarm.household_object_events FOR ALL TO swarm_command USING (true) WITH CHECK (true);
REVOKE ALL ON swarm.household_object_events FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT INSERT ON swarm.household_object_events TO swarm_command;
ALTER TABLE swarm.household_object_audit OWNER TO swarm_admin;
ALTER TABLE swarm.household_object_audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY swarm_command_all ON swarm.household_object_audit FOR ALL TO swarm_command USING (true) WITH CHECK (true);
REVOKE ALL ON swarm.household_object_audit FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT INSERT ON swarm.household_object_audit TO swarm_command;

-- Reserve rollback (verbatim in supabase/household-storage-reserve/ and
-- deploy/release-proofs/household-storage/; approved release procedure only):
-- -- Dropping the ledgers removes their INSERT-only command grants.
-- DROP TABLE IF EXISTS swarm.household_object_audit;
-- DROP TABLE IF EXISTS swarm.household_object_events;
-- DROP TABLE IF EXISTS swarm.household_object_streams;
