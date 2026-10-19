-- Replace only the existing definer body; owner, signature and ACL are retained.
-- A pending partial consent is not a refreshable family and must not be retired.
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
