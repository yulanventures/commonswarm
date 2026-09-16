-- H0 agent-join credentials are multi-use, seat-capped credentials. They are
-- separate from capability_urls: the public locator authorises nothing, while
-- only the SHA-256 digest of the secret swm_join_ value is stored here.

CREATE UNIQUE INDEX IF NOT EXISTS agent_principals_principal_workspace_owner
  ON swarm.agent_principals (principal_id, workspace_id, owner_user_id);

CREATE TABLE IF NOT EXISTS swarm.agent_join_credentials (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES swarm.workspaces (workspace_id),
  owner_user_id uuid NOT NULL REFERENCES swarm.users (user_id),
  registrar_principal_id uuid NOT NULL,
  registrar_run_id uuid NOT NULL,
  credential_hash bytea NOT NULL UNIQUE
    CHECK (octet_length(credential_hash) = 32),
  -- 128 random bits. This value is safe to put in the fetched document URL:
  -- resolving it grants no authority and never selects the secret digest.
  locator text NOT NULL UNIQUE
    CHECK (locator ~ '^[A-Za-z0-9_-]{22}$'),
  seat_cap integer NOT NULL CHECK (seat_cap BETWEEN 1 AND 10),
  seats_used integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by uuid REFERENCES swarm.users (user_id),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  mint_command_id text NOT NULL
    CHECK (mint_command_id ~ '^[A-Za-z0-9_-]{8,72}$'),
  CHECK (seats_used BETWEEN 0 AND seat_cap),
  CHECK (expires_at > created_at),
  -- 24 hours gives a person the same-day handoff window H0 needs while
  -- bounding a secret that is pasted into a model context. The unit stays in
  -- hours so this relation cannot inherit capability_urls' seven-day window.
  CHECK (expires_at <= created_at + interval '24 hours'),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL)),
  UNIQUE (owner_user_id, mint_command_id),
  UNIQUE (registrar_principal_id),
  UNIQUE (registrar_run_id),
  FOREIGN KEY (registrar_principal_id, workspace_id, owner_user_id)
    REFERENCES swarm.agent_principals (
      principal_id, workspace_id, owner_user_id
    ),
  FOREIGN KEY (registrar_run_id, registrar_principal_id)
    REFERENCES swarm.agent_runs (run_id, principal_id)
);

COMMENT ON TABLE swarm.agent_join_credentials IS
  'H0 human-minted, multi-use agent-join credentials. One credential owns one hidden registrar principal, device and run; its public locator grants no authority, and credential_hash is the only stored form of the secret.';
COMMENT ON COLUMN swarm.agent_join_credentials.credential_hash IS
  'SHA-256 digest of the full swm_join_ credential, including its prefix. The plaintext secret is returned only by the fresh mint response and is never stored.';
COMMENT ON COLUMN swarm.agent_join_credentials.locator IS
  'Independent 128-bit public document locator. It authorises no registration or other mutation.';
COMMENT ON COLUMN swarm.agent_join_credentials.registrar_principal_id IS
  'One server-created registrar per credential. Future registration derives G3 attribution from this row, never from request fields.';
COMMENT ON COLUMN swarm.agent_join_credentials.registrar_run_id IS
  'The registrar run created with its principal and device in the credential mint transaction.';

CREATE INDEX IF NOT EXISTS agent_join_credentials_live_by_workspace
  ON swarm.agent_join_credentials (workspace_id, expires_at)
  WHERE revoked_at IS NULL;

ALTER TABLE swarm.agent_join_credentials OWNER TO swarm_admin;
ALTER TABLE swarm.agent_join_credentials ENABLE ROW LEVEL SECURITY;

-- Seats may only move forward, and revocation is terminal. DELETE is forbidden
-- so issuance and later registration attribution cannot be erased.
CREATE OR REPLACE FUNCTION swarm.agent_join_credentials_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'SWARM_AGENT_JOIN_CREDENTIAL_IMMUTABLE'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
    OR NEW.registrar_principal_id IS DISTINCT FROM OLD.registrar_principal_id
    OR NEW.registrar_run_id IS DISTINCT FROM OLD.registrar_run_id
    OR NEW.credential_hash IS DISTINCT FROM OLD.credential_hash
    OR NEW.locator IS DISTINCT FROM OLD.locator
    OR NEW.seat_cap IS DISTINCT FROM OLD.seat_cap
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.mint_command_id IS DISTINCT FROM OLD.mint_command_id
    OR NEW.seats_used < OLD.seats_used
    -- An expired credential can create no seat. Registration will check expiry too; this makes it an
    -- invariant of the table rather than a promise of one caller. Added after a review arm noted it.
    OR (NEW.seats_used > OLD.seats_used AND OLD.expires_at <= statement_timestamp())
    OR (
      NEW.seats_used IS DISTINCT FROM OLD.seats_used
      AND (OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NOT NULL)
    )
    OR (OLD.revoked_at IS NOT NULL AND (
      NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
      OR NEW.revoked_by IS DISTINCT FROM OLD.revoked_by
    ))
  THEN
    RAISE EXCEPTION 'SWARM_AGENT_JOIN_CREDENTIAL_IMMUTABLE'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END
$$;

ALTER FUNCTION swarm.agent_join_credentials_guard() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.agent_join_credentials_guard() FROM PUBLIC;

CREATE TRIGGER agent_join_credentials_guard
  BEFORE UPDATE OR DELETE ON swarm.agent_join_credentials
  FOR EACH ROW EXECUTE FUNCTION swarm.agent_join_credentials_guard();

-- Follow the existing authority-table privilege pattern exactly: PostgREST
-- roles get no CRUD, while only the command role can resolve, mint, consume or
-- revoke a join credential.
REVOKE ALL ON TABLE swarm.agent_join_credentials FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON swarm.agent_join_credentials TO swarm_command;

CREATE POLICY swarm_command_all ON swarm.agent_join_credentials
  AS PERMISSIVE FOR ALL TO swarm_command
  USING (true) WITH CHECK (true);

-- Registrar identities are service actors, not workspace seats. Keep them out
-- of every user-facing identity view while retaining the base rows for G3
-- attribution and future registration. The relation above is the marker; no
-- caller-supplied name or label decides visibility.
CREATE OR REPLACE VIEW swarm_read.agent_principals
WITH (security_barrier = true)
AS
  -- Keep the enumerated projection from 20260906000020. p.* would publish
  -- wake_id and also changes this view's established column order.
  SELECT
    p.principal_id,
    p.workspace_id,
    p.owner_user_id,
    p.name,
    p.created_at,
    p.revoked_at,
    p.model,
    p.managed_at
  FROM swarm.agent_principals AS p
  WHERE swarm.is_member(p.workspace_id, auth.uid())
    AND NOT EXISTS (
      SELECT 1
      FROM swarm.agent_join_credentials AS c
      WHERE c.registrar_principal_id = p.principal_id
    );

CREATE OR REPLACE VIEW swarm_read.agent_runs
WITH (security_barrier = true)
AS
  SELECT r.*
  FROM swarm.agent_runs AS r
  JOIN swarm.agent_principals AS p USING (principal_id)
  WHERE swarm.is_member(p.workspace_id, auth.uid())
    AND NOT EXISTS (
      SELECT 1
      FROM swarm.agent_join_credentials AS c
      WHERE c.registrar_run_id = r.run_id
    );

CREATE OR REPLACE VIEW swarm_read.my_devices
WITH (security_barrier = true)
AS
  SELECT d.*
  FROM swarm.devices AS d
  WHERE d.user_id = auth.uid()
    AND NOT EXISTS (
      SELECT 1
      FROM swarm.agent_runs AS r
      JOIN swarm.agent_join_credentials AS c
        ON c.registrar_run_id = r.run_id
      WHERE r.device_id = d.device_id
    );

ALTER VIEW swarm_read.agent_principals OWNER TO swarm_admin;
ALTER VIEW swarm_read.agent_runs OWNER TO swarm_admin;
ALTER VIEW swarm_read.my_devices OWNER TO swarm_admin;
