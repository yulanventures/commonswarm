-- Phase 1 reserve. Operator owns the transaction, ledger and checksum.
-- Allocation stays disabled until the separately reviewed phase-6 activation.
ALTER TABLE swarm.agent_principals
  ADD COLUMN identity_lifetime text NOT NULL DEFAULT 'durable',
  ADD CONSTRAINT agent_principals_identity_lifetime_check CHECK (identity_lifetime IN ('durable', 'ephemeral'));
ALTER TABLE swarm.hosted_mcp_seats
  ADD COLUMN display_name text,
  ADD COLUMN disambiguator text,
  ADD CONSTRAINT hosted_mcp_seats_display_name_check CHECK (display_name IS NULL OR (
    length(display_name) BETWEEN 1 AND 80 AND display_name=btrim(display_name, ' ') AND display_name !~ '[[:cntrl:]]')),
  ADD CONSTRAINT hosted_mcp_seats_disambiguator_check CHECK (disambiguator IS NULL OR disambiguator ~ '^[A-Z2-7]{4}$');
CREATE TABLE swarm.hosted_agent_contexts (
  context_id uuid NOT NULL PRIMARY KEY,
  handle text NOT NULL UNIQUE CHECK (handle ~ '^seat_[A-Za-z0-9_-]{22,64}$'),
  seat_id uuid NOT NULL REFERENCES swarm.hosted_mcp_seats(seat_id),
  kind text NOT NULL CHECK (kind IN ('chat', 'task', 'scheduled', 'subagent')),
  created_at timestamptz NOT NULL,
  last_business_at timestamptz NOT NULL,
  idle_expires_at timestamptz,
  absolute_expires_at timestamptz,
  closed_at timestamptz,
  close_reason text,
  parent_context uuid REFERENCES swarm.hosted_agent_contexts(context_id),
  origin text NOT NULL CHECK (origin IN ('new', 'continue', 'legacy')),
  CONSTRAINT hosted_agent_contexts_clocks_check CHECK (
    last_business_at >= created_at
    AND (idle_expires_at IS NULL OR idle_expires_at > last_business_at)
    AND (absolute_expires_at IS NULL OR absolute_expires_at > created_at)
    AND (closed_at IS NULL OR closed_at >= created_at)
    AND ((closed_at IS NULL AND close_reason IS NULL) OR (closed_at IS NOT NULL AND close_reason IS NOT NULL))
    AND ((origin='legacy' AND idle_expires_at IS NULL AND absolute_expires_at IS NULL)
      OR (origin<>'legacy' AND idle_expires_at IS NOT NULL AND absolute_expires_at IS NOT NULL))
  )
);
CREATE INDEX hosted_agent_contexts_seat ON swarm.hosted_agent_contexts (seat_id, created_at DESC);
CREATE INDEX hosted_agent_contexts_created ON swarm.hosted_agent_contexts (created_at, seat_id);
CREATE INDEX hosted_agent_contexts_idle ON swarm.hosted_agent_contexts (idle_expires_at) WHERE closed_at IS NULL;
CREATE INDEX hosted_agent_contexts_absolute ON swarm.hosted_agent_contexts (absolute_expires_at) WHERE closed_at IS NULL;
ALTER TABLE swarm.hosted_agent_contexts OWNER TO swarm_admin;
ALTER TABLE swarm.hosted_agent_contexts ENABLE ROW LEVEL SECURITY;
CREATE POLICY swarm_command_all ON swarm.hosted_agent_contexts
  AS PERMISSIVE FOR ALL TO swarm_command USING (true) WITH CHECK (true);
REVOKE ALL ON swarm.hosted_agent_contexts FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT SELECT, INSERT, UPDATE ON swarm.hosted_agent_contexts TO swarm_command;
INSERT INTO swarm.config(key, value) VALUES ('hosted_context_allocation_enabled', 'false'::jsonb);

-- Return bounded status only, never provider payloads. Missing/purged Grant
-- artifacts do not prove expiry. Provider-family inactivity is not expiry.
CREATE FUNCTION swarm.hosted_predecessor_status(p_grant_id uuid)
RETURNS TABLE (grant_id uuid, owner_user_id uuid, client_id text,
  revoked boolean, provider_expires_at timestamptz, predecessor_unavailable boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
  SELECT g.grant_id, g.owner_user_id, g.client_id,
    (g.state='revoked' OR g.revoked_at IS NOT NULL OR t.grant_id IS NOT NULL) AS revoked,
    a.expires_at AS provider_expires_at,
    (g.state='revoked' OR g.revoked_at IS NOT NULL OR t.grant_id IS NOT NULL
      OR (a.expires_at IS NOT NULL AND a.expires_at <= statement_timestamp())) AS predecessor_unavailable
  FROM swarm.hosted_mcp_grants g
  LEFT JOIN commonswarm_oauth.refresh_family_tombstones t ON t.grant_id=g.provider_grant_id
  LEFT JOIN commonswarm_oauth.provider_artifacts a
    ON a.model='Grant'
    AND a.artifact_id_hash=rtrim(translate(encode(sha256(convert_to(g.provider_grant_id, 'UTF8')), 'base64'), '+/', '-_'), '=')
    AND a.payload->>'accountId'=g.owner_user_id::text
    AND a.payload->>'clientId'=g.client_id
  WHERE g.grant_id=p_grant_id
$function$;
ALTER FUNCTION swarm.hosted_predecessor_status(uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.hosted_predecessor_status(uuid)
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command, commonswarm_oauth_runtime;
GRANT EXECUTE ON FUNCTION swarm.hosted_predecessor_status(uuid) TO swarm_command;

-- Canonical data-free reserve begins. Strip exactly "-- " from each line.
-- -- Data-free reserve inverse ONLY. Apply in the reviewed outer transaction.
-- -- Phase 3 and phase 5 dependents must already be reversed or absent.
-- DO $reserve$
-- BEGIN
--   IF EXISTS (SELECT 1 FROM swarm.hosted_agent_contexts)
--      OR EXISTS (SELECT 1 FROM swarm.agent_principals WHERE identity_lifetime <> 'durable')
--      OR EXISTS (SELECT 1 FROM swarm.hosted_mcp_seats WHERE display_name IS NOT NULL OR disambiguator IS NOT NULL)
--      OR EXISTS (SELECT 1 FROM swarm.config WHERE key = 'hosted_context_allocation_enabled' AND value <> 'false'::jsonb) THEN
--     RAISE EXCEPTION 'reserve rollback refused: hosted identity data' USING ERRCODE = '55000';
--   END IF;
-- END
-- $reserve$;
-- DROP FUNCTION IF EXISTS swarm.hosted_predecessor_status(uuid);
-- DROP TABLE swarm.hosted_agent_contexts;
-- ALTER TABLE swarm.hosted_mcp_seats DROP COLUMN display_name, DROP COLUMN disambiguator;
-- ALTER TABLE swarm.agent_principals DROP COLUMN identity_lifetime;
-- DELETE FROM swarm.config WHERE key = 'hosted_context_allocation_enabled';
-- -- No CASCADE. Unexpected later-phase dependencies refuse the transaction.
-- Canonical data-free reserve ends.
