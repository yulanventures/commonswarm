-- Forward replacement preserves resolver signatures, owners and ACLs.
-- Check authorization inherits the read resolver; no new runtime authority rights.

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
    AND g.connection_expired_at IS NULL
    AND (g.connection_expires_at IS NULL OR g.connection_expires_at > clock_timestamp())
    AND NOT EXISTS (
      SELECT 1 FROM commonswarm_oauth.refresh_family_tombstones f
      WHERE f.grant_id = g.provider_grant_id
    )
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
    AND g.connection_expired_at IS NULL
    AND (g.connection_expires_at IS NULL OR g.connection_expires_at > clock_timestamp())
    AND NOT EXISTS (
      SELECT 1 FROM commonswarm_oauth.refresh_family_tombstones f
      WHERE f.grant_id = g.provider_grant_id
    )
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
    AND g.connection_expired_at IS NULL
    AND (g.connection_expires_at IS NULL OR g.connection_expires_at > clock_timestamp())
    AND NOT EXISTS (
      SELECT 1 FROM commonswarm_oauth.refresh_family_tombstones f
      WHERE f.grant_id = g.provider_grant_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM swarm.revocation_tombstones AS t
      WHERE (t.kind = 'membership' AND t.target_id = hs.owner_user_id)
         OR (t.kind = 'principal' AND t.target_id = hs.principal_id)
         OR (t.kind = 'hosted_grant' AND t.target_id = hs.grant_id)
         OR (t.kind = 'hosted_seat' AND t.target_id = hs.seat_id)
    )
$fn$;

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
            ) AND g.connection_expired_at IS NULL
              AND (g.connection_expires_at IS NULL OR g.connection_expires_at > clock_timestamp())
              AND EXISTS (
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


-- Runtime callers take any existing DCR row before entering this helper.
-- Commands already holding one workspace stream must never call this helper.
CREATE FUNCTION commonswarm_oauth.lock_hosted_family(
  p_provider_grant_id text, p_owner_user_id uuid, p_client_id text, p_resource text
)
RETURNS TABLE (
  grant_id uuid, state text, active boolean,
  connection_expires_at timestamptz, connection_expired_at timestamptz
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  initial swarm.hosted_mcp_grants%ROWTYPE;
  current_grant swarm.hosted_mcp_grants%ROWTYPE;
  stream_ids uuid[];
  current_stream_ids uuid[];
  pass integer;
BEGIN
  SELECT g.* INTO initial FROM swarm.hosted_mcp_grants g
  WHERE g.provider_grant_id = p_provider_grant_id;
  IF NOT FOUND THEN RETURN; END IF;
  FOR pass IN 1..2 LOOP
    -- Each pass is a fresh statement, including the one after all lock waits.
    SELECT g.* INTO current_grant FROM swarm.hosted_mcp_grants g
    WHERE g.grant_id = initial.grant_id;
    IF NOT FOUND OR
      ROW(current_grant.provider_grant_id,current_grant.owner_user_id,current_grant.client_id,
          current_grant.resource,current_grant.home_workspace_id,current_grant.selected_workspace_ids,
          current_grant.manifest_digest,current_grant.interaction_ref)
      IS DISTINCT FROM
      ROW(initial.provider_grant_id,initial.owner_user_id,initial.client_id,
          initial.resource,initial.home_workspace_id,initial.selected_workspace_ids,
          initial.manifest_digest,initial.interaction_ref)
      OR current_grant.owner_user_id IS DISTINCT FROM p_owner_user_id
      OR current_grant.client_id IS DISTINCT FROM p_client_id
      OR current_grant.resource IS DISTINCT FROM p_resource
      OR p_resource IS DISTINCT FROM 'https://mcp.commonswarm.com/mcp'
      OR NOT (current_grant.home_workspace_id = ANY(current_grant.selected_workspace_ids))
      OR array_position(current_grant.selected_workspace_ids,NULL) IS NOT NULL
      OR octet_length(current_grant.manifest_digest) <> 32
      OR EXISTS (
        SELECT 1 FROM commonswarm_oauth.provider_grant_resources r
        WHERE r.provider_grant_id = p_provider_grant_id AND
          ROW(r.grant_class,r.hosted_grant_id,r.owner_user_id,r.client_id,r.resource)
          IS DISTINCT FROM ROW('hosted_mcp'::text,current_grant.grant_id,p_owner_user_id,p_client_id,p_resource)
      ) OR EXISTS (
        SELECT 1 FROM swarm.hosted_mcp_grant_workspaces c
        WHERE c.grant_id = current_grant.grant_id AND
          (NOT (c.workspace_id = ANY(current_grant.selected_workspace_ids))
           OR c.owner_user_id <> p_owner_user_id OR c.manifest_digest <> current_grant.manifest_digest)
      ) OR EXISTS (
        SELECT 1 FROM swarm.hosted_mcp_seats hs
        WHERE hs.grant_id = current_grant.grant_id AND
          (NOT (hs.workspace_id = ANY(current_grant.selected_workspace_ids)) OR hs.owner_user_id <> p_owner_user_id)
      ) THEN RETURN; END IF;
    SELECT array_agg(s.stream_id ORDER BY s.workspace_id) INTO current_stream_ids
    FROM swarm.streams s
    WHERE s.kind = 'workspace' AND s.workspace_id = ANY(current_grant.selected_workspace_ids);
    IF coalesce(cardinality(current_stream_ids),0) <>
       (SELECT count(DISTINCT id) FROM unnest(current_grant.selected_workspace_ids) id)
       OR (pass = 2 AND current_stream_ids IS DISTINCT FROM stream_ids) THEN RETURN; END IF;
    IF pass = 1 THEN
      stream_ids := current_stream_ids;
      PERFORM s.stream_id FROM swarm.streams s
      WHERE s.stream_id = ANY(stream_ids) ORDER BY s.workspace_id FOR UPDATE;
      PERFORM pg_advisory_xact_lock(hashtextextended(p_provider_grant_id,484650));
      PERFORM g.grant_id FROM swarm.hosted_mcp_grants g
      WHERE g.grant_id = initial.grant_id FOR UPDATE;
    END IF;
  END LOOP;
  RETURN QUERY SELECT current_grant.grant_id,current_grant.state,
    coalesce((SELECT status.active FROM commonswarm_oauth.resolve_hosted_grant_status(p_provider_grant_id) status),false),
    current_grant.connection_expires_at,current_grant.connection_expired_at;
END
$function$;
ALTER FUNCTION commonswarm_oauth.lock_hosted_family(text,uuid,text,text) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION commonswarm_oauth.lock_hosted_family(text,uuid,text,text)
  FROM PUBLIC,anon,authenticated,swarm_read,swarm_command;
GRANT EXECUTE ON FUNCTION commonswarm_oauth.lock_hosted_family(text,uuid,text,text)
  TO commonswarm_oauth_runtime;
