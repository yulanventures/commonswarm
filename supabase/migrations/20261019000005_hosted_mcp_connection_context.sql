-- Additive private response context, never a new source of hosted authority.
-- The edge installs checked hosted owner/principal claims only after canonical
-- authorization. No caller-selected owner argument or account-wide membership
-- enumeration is accepted. Unique provider_grant_id binds the stored client;
-- resource remains the existing exact MCP resource. Provider family status and
-- canonical resolvers retain all current (and future permanence) fences.
CREATE FUNCTION swarm.resolve_hosted_mcp_connection_context(
  p_grant_id uuid,
  p_provider_grant_id text,
  p_tool text,
  p_workspace_id uuid,
  p_handle text
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  WITH claims AS (
    SELECT nullif(current_setting('request.jwt.claims', true), '')::jsonb AS value
  ), authorized AS (
    SELECT g.*
    FROM swarm.hosted_mcp_grants AS g
    CROSS JOIN claims AS c
    WHERE g.grant_id = p_grant_id
      AND g.provider_grant_id = p_provider_grant_id
      AND g.owner_user_id::text = c.value ->> 'sub'
      AND c.value ->> 'role' = 'authenticated'
      AND g.resource = 'https://mcp.commonswarm.com/mcp'
      AND g.state = 'active' AND g.revoked_at IS NULL
      AND commonswarm_oauth.provider_family_active(g.provider_grant_id)
      AND CASE WHEN p_tool = 'claim_hosted_seat' THEN
        EXISTS (
          SELECT 1 FROM swarm.resolve_hosted_grant_authorization(
            g.grant_id, g.owner_user_id, p_workspace_id, p_tool
          ) AS a WHERE a.provider_grant_id = g.provider_grant_id
        ) AND (
          (p_handle IS NULL AND c.value ->> 'agent_principal_id' IS NULL)
          OR EXISTS (
            SELECT 1 FROM swarm.resolve_hosted_seat_read_authorization(
              g.grant_id, p_handle, 'whoami'
            ) AS a
            WHERE a.provider_grant_id = g.provider_grant_id
              AND a.workspace_id = p_workspace_id
              AND a.owner_user_id = g.owner_user_id
              AND a.principal_id::text = c.value ->> 'agent_principal_id'
          )
        )
      WHEN p_tool IN ('whoami', 'members', 'check') THEN
        EXISTS (
          SELECT 1 FROM swarm.resolve_hosted_seat_read_authorization(
            g.grant_id, p_handle, p_tool
          ) AS a
          WHERE a.provider_grant_id = g.provider_grant_id
            AND a.workspace_id = p_workspace_id
            AND a.owner_user_id = g.owner_user_id
            AND a.principal_id::text = c.value ->> 'agent_principal_id'
        )
      ELSE false END
  ), reachable AS (
    SELECT g.grant_id, w.workspace_id, w.name
    FROM authorized AS g
    JOIN swarm.hosted_mcp_grant_workspaces AS c
      ON c.grant_id = g.grant_id AND c.owner_user_id = g.owner_user_id
     AND c.manifest_digest = g.manifest_digest AND c.revoked_at IS NULL
     AND c.workspace_id = ANY(g.selected_workspace_ids)
    CROSS JOIN LATERAL swarm.resolve_hosted_grant_authorization(
      g.grant_id, g.owner_user_id, c.workspace_id, 'claim_hosted_seat'
    ) AS a
    JOIN swarm.workspaces AS w ON w.workspace_id = a.workspace_id
    WHERE a.provider_grant_id = g.provider_grant_id
      AND a.manifest_digest = g.manifest_digest
      AND btrim(w.name) <> ''
  )
  SELECT jsonb_build_object(
    'account', jsonb_build_object('user_id', u.user_id,
      'display_name', u.display_name, 'email', u.email),
    'workspace', jsonb_build_object('workspace_id', w.workspace_id, 'name', w.name),
    'connection', jsonb_build_object('grant_id', g.grant_id,
      'home_workspace_id', CASE WHEN EXISTS (
        SELECT 1 FROM reachable AS home
        WHERE home.grant_id = g.grant_id AND home.workspace_id = g.home_workspace_id
      ) THEN g.home_workspace_id ELSE NULL END,
      'reachable_workspaces', (
        SELECT jsonb_agg(jsonb_build_object('workspace_id', r.workspace_id,
          'name', r.name) ORDER BY r.workspace_id)
        FROM reachable AS r WHERE r.grant_id = g.grant_id
      )),
    'summary', regexp_replace(format('Connected as %s%s in %s; %s approved workspace(s) available.',
      u.display_name, CASE WHEN u.email IS NULL THEN '' ELSE format(' (%s)', u.email) END,
      w.name, (SELECT count(*) FROM reachable AS r WHERE r.grant_id = g.grant_id)),
      U&'[[:cntrl:]\2028\2029]', ' ', 'g')
  )
  FROM authorized AS g
  JOIN swarm.users AS u ON u.user_id = g.owner_user_id
  JOIN reachable AS w ON w.grant_id = g.grant_id AND w.workspace_id = p_workspace_id
  WHERE btrim(u.display_name) <> ''
$function$;

ALTER FUNCTION swarm.resolve_hosted_mcp_connection_context(uuid,text,text,uuid,text)
  OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.resolve_hosted_mcp_connection_context(uuid,text,text,uuid,text)
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command, commonswarm_oauth_runtime;
GRANT EXECUTE ON FUNCTION swarm.resolve_hosted_mcp_connection_context(uuid,text,text,uuid,text)
  TO swarm_read, swarm_command;
