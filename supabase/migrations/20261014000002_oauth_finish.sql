-- Durable browser-bound finish records, derived from activated consent inputs.
-- Outputs private AS resume responses; immutable bindings and fixed deadlines
-- survive restart. No authorization code or client callback is stored here.
CREATE TABLE commonswarm_oauth.finish_records (
  interaction_uid text PRIMARY KEY REFERENCES commonswarm_oauth.interactions(interaction_uid) ON DELETE CASCADE,
  session_hash bytea NOT NULL REFERENCES commonswarm_oauth.browser_sessions(session_hash),
  user_id uuid NOT NULL,
  provider_grant_id text NOT NULL,
  commonswarm_grant_id uuid NOT NULL,
  validated_request jsonb NOT NULL CHECK (jsonb_typeof(validated_request) = 'object'),
  display_model jsonb NOT NULL CHECK (jsonb_typeof(display_model) = 'object'),
  provider_result jsonb NOT NULL CHECK (jsonb_typeof(provider_result) = 'object'),
  state text NOT NULL DEFAULT 'prepared' CHECK (state IN ('prepared', 'preparing_resume', 'resume_ready')),
  resume_response jsonb CHECK (jsonb_typeof(resume_response) = 'object'),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '2 minutes'),
  CHECK ((state = 'resume_ready') = (resume_response IS NOT NULL))
);
ALTER TABLE commonswarm_oauth.finish_records OWNER TO swarm_admin;
ALTER TABLE commonswarm_oauth.finish_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY oauth_runtime_finish ON commonswarm_oauth.finish_records
  FOR ALL TO commonswarm_oauth_runtime USING (true) WITH CHECK (true);
REVOKE ALL ON commonswarm_oauth.finish_records FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT SELECT ON commonswarm_oauth.finish_records TO commonswarm_oauth_runtime;
GRANT INSERT (interaction_uid, session_hash, user_id, provider_grant_id, commonswarm_grant_id,
  validated_request, display_model, provider_result, expires_at)
  ON commonswarm_oauth.finish_records TO commonswarm_oauth_runtime;
GRANT UPDATE (state, resume_response) ON commonswarm_oauth.finish_records TO commonswarm_oauth_runtime;
