-- Restore the resolver bodies installed before 20261019000003 verbatim: the
-- three swarm resolvers from 20260928000002 and
-- commonswarm_oauth.resolve_hosted_grant_status from 20261019000001. CREATE OR
-- REPLACE keeps every owner, security definer setting, search_path and grantee.
-- Drop the family lock this migration added; no migration or database object
-- references it. Apply after the 20261019000004 reserve and before the
-- 20261019000002 reserve. Kept on purpose: the 20261019000002 deadline columns
-- (that version's own reserve drops them) and every hosted grant, workspace,
-- seat, binding and tombstone row.
CREATE OR REPLACE FUNCTION swarm.resolve_hosted_grant_authorization(
  p_grant_id uuid,
  p_owner_user_id uuid,
  p_workspace_id uuid,
  p_tool text
)
RETURNS TABLE (
  grant_id uuid,
  owner_user_id uuid,
  provider_grant_id text,
  workspace_id uuid,
  stream_id uuid,
  manifest_digest bytea
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = swarm, pg_catalog
AS $fn$
  SELECT g.grant_id, g.owner_user_id, g.provider_grant_id,
         c.workspace_id, s.stream_id, g.manifest_digest
  FROM swarm.hosted_mcp_grants AS g
  JOIN swarm.hosted_mcp_grant_workspaces AS c
    ON c.grant_id = g.grant_id
   AND c.owner_user_id = g.owner_user_id
   AND c.workspace_id = p_workspace_id
   AND c.revoked_at IS NULL
  JOIN swarm.workspaces AS w
    ON w.workspace_id = c.workspace_id AND w.archived_at IS NULL
  JOIN swarm.memberships AS m
    ON m.workspace_id = c.workspace_id
   AND m.user_id = g.owner_user_id
   AND m.revoked_at IS NULL
  JOIN swarm.streams AS s
    ON s.workspace_id = c.workspace_id AND s.kind = 'workspace'
  WHERE p_tool = 'claim_hosted_seat'
    AND g.grant_id = p_grant_id
    AND g.owner_user_id = p_owner_user_id
    AND g.state = 'active'
    AND g.revoked_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM swarm.revocation_tombstones AS t
      WHERE (t.kind = 'membership' AND t.target_id = g.owner_user_id)
         OR (t.kind = 'hosted_grant' AND t.target_id = g.grant_id)
    )
$fn$;

CREATE OR REPLACE FUNCTION swarm.resolve_hosted_seat_command_authorization(
  p_grant_id uuid,
  p_handle text,
  p_tool text
)
RETURNS TABLE (
  grant_id uuid,
  provider_grant_id text,
  seat_id uuid,
  handle text,
  workspace_id uuid,
  stream_id uuid,
  owner_user_id uuid,
  principal_id uuid,
  name text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = swarm, pg_catalog
AS $fn$
  SELECT g.grant_id, g.provider_grant_id, hs.seat_id, h.handle,
         hs.workspace_id, st.stream_id, hs.owner_user_id,
         hs.principal_id, hs.name
  FROM swarm.hosted_mcp_grants AS g
  JOIN swarm.hosted_mcp_grant_workspaces AS c
    ON c.grant_id = g.grant_id AND c.revoked_at IS NULL
  JOIN swarm.hosted_mcp_seats AS hs
    ON hs.grant_id = c.grant_id AND hs.workspace_id = c.workspace_id
   AND hs.owner_user_id = g.owner_user_id AND hs.revoked_at IS NULL
  JOIN swarm.hosted_mcp_seat_handles AS h
    ON h.seat_id = hs.seat_id AND h.grant_id = hs.grant_id
   AND h.workspace_id = hs.workspace_id AND h.principal_id = hs.principal_id
   AND h.revoked_at IS NULL
  JOIN swarm.agent_principals AS p
    ON p.principal_id = hs.principal_id AND p.workspace_id = hs.workspace_id
   AND p.owner_user_id = hs.owner_user_id AND p.revoked_at IS NULL
   AND p.transport = 'hosted_mcp' AND p.turn_only = true
  JOIN swarm.workspaces AS w
    ON w.workspace_id = hs.workspace_id AND w.archived_at IS NULL
  JOIN swarm.memberships AS m
    ON m.workspace_id = hs.workspace_id AND m.user_id = hs.owner_user_id
   AND m.revoked_at IS NULL
  JOIN swarm.streams AS st
    ON st.workspace_id = hs.workspace_id AND st.kind = 'workspace'
  WHERE p_tool IN ('ask', 'note', 'reply', 'working_on')
    AND g.grant_id = p_grant_id AND h.handle = p_handle
    AND g.state = 'active' AND g.revoked_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM swarm.revocation_tombstones AS t
      WHERE (t.kind = 'membership' AND t.target_id = hs.owner_user_id)
         OR (t.kind = 'principal' AND t.target_id = hs.principal_id)
         OR (t.kind = 'hosted_grant' AND t.target_id = hs.grant_id)
         OR (t.kind = 'hosted_seat' AND t.target_id = hs.seat_id)
    )
$fn$;

CREATE OR REPLACE FUNCTION swarm.resolve_hosted_seat_read_authorization(
  p_grant_id uuid,
  p_handle text,
  p_tool text
)
RETURNS TABLE (
  grant_id uuid,
  provider_grant_id text,
  seat_id uuid,
  handle text,
  workspace_id uuid,
  stream_id uuid,
  owner_user_id uuid,
  principal_id uuid,
  name text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = swarm, pg_catalog
AS $fn$
  SELECT g.grant_id, g.provider_grant_id, hs.seat_id, h.handle,
         hs.workspace_id, st.stream_id, hs.owner_user_id,
         hs.principal_id, hs.name
  FROM swarm.hosted_mcp_grants AS g
  JOIN swarm.hosted_mcp_grant_workspaces AS c
    ON c.grant_id = g.grant_id AND c.revoked_at IS NULL
  JOIN swarm.hosted_mcp_seats AS hs
    ON hs.grant_id = c.grant_id AND hs.workspace_id = c.workspace_id
   AND hs.owner_user_id = g.owner_user_id AND hs.revoked_at IS NULL
  JOIN swarm.hosted_mcp_seat_handles AS h
    ON h.seat_id = hs.seat_id AND h.grant_id = hs.grant_id
   AND h.workspace_id = hs.workspace_id AND h.principal_id = hs.principal_id
   AND h.revoked_at IS NULL
  JOIN swarm.agent_principals AS p
    ON p.principal_id = hs.principal_id AND p.workspace_id = hs.workspace_id
   AND p.owner_user_id = hs.owner_user_id AND p.revoked_at IS NULL
   AND p.transport = 'hosted_mcp' AND p.turn_only = true
  JOIN swarm.workspaces AS w
    ON w.workspace_id = hs.workspace_id AND w.archived_at IS NULL
  JOIN swarm.memberships AS m
    ON m.workspace_id = hs.workspace_id AND m.user_id = hs.owner_user_id
   AND m.revoked_at IS NULL
  JOIN swarm.streams AS st
    ON st.workspace_id = hs.workspace_id AND st.kind = 'workspace'
  WHERE p_tool IN ('whoami', 'members', 'check')
    AND g.grant_id = p_grant_id AND h.handle = p_handle
    AND g.state = 'active' AND g.revoked_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM swarm.revocation_tombstones AS t
      WHERE (t.kind = 'membership' AND t.target_id = hs.owner_user_id)
         OR (t.kind = 'principal' AND t.target_id = hs.principal_id)
         OR (t.kind = 'hosted_grant' AND t.target_id = hs.grant_id)
         OR (t.kind = 'hosted_seat' AND t.target_id = hs.seat_id)
    )
$fn$;

CREATE OR REPLACE FUNCTION commonswarm_oauth.resolve_hosted_grant_status(p_provider_grant_id text)
RETURNS TABLE (
  grant_id uuid,
  client_id text,
  owner_user_id uuid,
  resource text,
  active boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  RETURN QUERY EXECUTE
    'SELECT g.grant_id, g.client_id, g.owner_user_id, g.resource,
            commonswarm_oauth.hosted_grant_is_active(
              g.state, g.revoked_at, u.user_id IS NOT NULL, t.grant_id IS NOT NULL
            ) AND EXISTS (
              SELECT 1 FROM swarm.hosted_mcp_grant_workspaces AS c
              CROSS JOIN LATERAL swarm.resolve_hosted_grant_authorization(
                c.grant_id, g.owner_user_id, c.workspace_id, ''claim_hosted_seat''
              ) AS authorized
              WHERE c.grant_id = g.grant_id
            ) AS active
       FROM swarm.hosted_mcp_grants AS g
       LEFT JOIN swarm.users AS u ON u.user_id = g.owner_user_id
       LEFT JOIN commonswarm_oauth.refresh_family_tombstones AS t
         ON t.grant_id = g.provider_grant_id
      WHERE g.provider_grant_id = $1 AND g.state <> ''pending''
      LIMIT 1'
  USING p_provider_grant_id;
END
$function$;

DROP FUNCTION IF EXISTS commonswarm_oauth.lock_hosted_family(text, uuid, text, text);
