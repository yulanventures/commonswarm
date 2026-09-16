-- One durable row identifies one H0 seat. The attempt id is the retry
-- discriminator; the principal, run, and current token are all server-created
-- in the same registration transaction.

CREATE UNIQUE INDEX IF NOT EXISTS agent_join_credentials_id_workspace_owner
  ON swarm.agent_join_credentials (id, workspace_id, owner_user_id);

CREATE UNIQUE INDEX IF NOT EXISTS agent_tokens_token_principal_run
  ON swarm.agent_tokens (token_id, principal_id, run_id);

CREATE TABLE IF NOT EXISTS swarm.agent_join_attempts (
  join_credential_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  run_id uuid NOT NULL,
  token_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (join_credential_id, attempt_id),
  UNIQUE (principal_id),
  UNIQUE (run_id),
  UNIQUE (token_id),
  FOREIGN KEY (join_credential_id, workspace_id, owner_user_id)
    REFERENCES swarm.agent_join_credentials (id, workspace_id, owner_user_id),
  FOREIGN KEY (principal_id, workspace_id, owner_user_id)
    REFERENCES swarm.agent_principals (
      principal_id, workspace_id, owner_user_id
    ),
  FOREIGN KEY (run_id, principal_id)
    REFERENCES swarm.agent_runs (run_id, principal_id),
  FOREIGN KEY (token_id, principal_id, run_id)
    REFERENCES swarm.agent_tokens (token_id, principal_id, run_id)
);

COMMENT ON TABLE swarm.agent_join_attempts IS
  'H0 seat marker and retry record. A principal is an H0 seat exactly when this relation names it.';
COMMENT ON COLUMN swarm.agent_join_attempts.attempt_id IS
  'Client-generated registration UUID. Reusing it recovers the same seat; a different value consumes another seat.';
COMMENT ON COLUMN swarm.agent_join_attempts.token_id IS
  'Current token for this attempt. It may advance only from an unused, revoked token to a fresh token for the same principal and run.';

ALTER TABLE swarm.agent_join_attempts OWNER TO swarm_admin;
ALTER TABLE swarm.agent_join_attempts ENABLE ROW LEVEL SECURITY;

-- The seat identity never changes and the marker can never be erased. The one
-- allowed update is recovery from a lost response: replace an unused token
-- after the old row has been revoked, keeping the same principal and run.
CREATE OR REPLACE FUNCTION swarm.agent_join_attempts_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'SWARM_AGENT_JOIN_ATTEMPT_IMMUTABLE'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.join_credential_id IS DISTINCT FROM OLD.join_credential_id
    OR NEW.attempt_id IS DISTINCT FROM OLD.attempt_id
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
    OR NEW.principal_id IS DISTINCT FROM OLD.principal_id
    OR NEW.run_id IS DISTINCT FROM OLD.run_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'SWARM_AGENT_JOIN_ATTEMPT_IMMUTABLE'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.token_id IS DISTINCT FROM OLD.token_id AND (
    NOT EXISTS (
      SELECT 1
      FROM swarm.agent_tokens AS old_token
      WHERE old_token.token_id = OLD.token_id
        AND old_token.principal_id = OLD.principal_id
        AND old_token.run_id = OLD.run_id
        AND old_token.first_used_at IS NULL
        AND old_token.revoked_at IS NOT NULL
    )
    OR NOT EXISTS (
      SELECT 1
      FROM swarm.agent_tokens AS new_token
      WHERE new_token.token_id = NEW.token_id
        AND new_token.principal_id = OLD.principal_id
        AND new_token.run_id = OLD.run_id
        AND new_token.first_used_at IS NULL
        AND new_token.revoked_at IS NULL
    )
  ) THEN
    RAISE EXCEPTION 'SWARM_AGENT_JOIN_ATTEMPT_TOKEN_NOT_REPLACEABLE'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END
$$;

ALTER FUNCTION swarm.agent_join_attempts_guard() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.agent_join_attempts_guard()
  FROM PUBLIC, anon, authenticated;

CREATE TRIGGER agent_join_attempts_guard
  BEFORE UPDATE OR DELETE ON swarm.agent_join_attempts
  FOR EACH ROW EXECUTE FUNCTION swarm.agent_join_attempts_guard();

REVOKE ALL ON TABLE swarm.agent_join_attempts
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON swarm.agent_join_attempts TO swarm_command;

CREATE POLICY swarm_command_all ON swarm.agent_join_attempts
  AS PERMISSIVE FOR ALL TO swarm_command
  USING (true) WITH CHECK (true);

-- Registration stores a replay-safe response under the credential itself.
-- The raw seat token is fresh-response-only and never enters this table.
ALTER TABLE swarm.idempotency_keys
  DROP CONSTRAINT IF EXISTS idempotency_keys_principal_kind_check;
ALTER TABLE swarm.idempotency_keys
  ADD CONSTRAINT idempotency_keys_principal_kind_check
  CHECK (principal_kind IN ('user', 'agent', 'join'));
