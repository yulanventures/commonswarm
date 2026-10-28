-- Never discard added authority or undo target withdrawal by reverting this schema.
LOCK TABLE swarm.hosted_mcp_grant_agents,swarm.hosted_mcp_agent_workspace_adds,swarm.hosted_mcp_seats,swarm.hosted_mcp_seat_handles,swarm.agent_workspace_memberships IN SHARE ROW EXCLUSIVE MODE;
DO $guard$ BEGIN
 IF EXISTS(SELECT 1 FROM swarm.hosted_mcp_agent_workspace_adds)
 OR EXISTS(SELECT 1 FROM swarm.hosted_mcp_seats s JOIN swarm.agent_principals p USING(principal_id) WHERE s.workspace_id<>p.workspace_id)
 OR EXISTS(SELECT principal_id FROM swarm.hosted_mcp_seats GROUP BY principal_id HAVING count(*)>1)
 OR EXISTS(SELECT 1 FROM swarm.agent_workspace_memberships am JOIN swarm.agent_principals p USING(principal_id)
   WHERE p.transport='hosted_mcp' AND am.revoked_at IS DISTINCT FROM p.revoked_at)
 THEN RAISE EXCEPTION 'Independent hosted authority exists; preserve it before rollback' USING ERRCODE='55000'; END IF;
END $guard$;
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

CREATE OR REPLACE FUNCTION commonswarm_oauth.lock_hosted_family(
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
      OR NOT EXISTS (
        SELECT 1 FROM commonswarm_oauth.provider_grant_resources r
        WHERE r.provider_grant_id = p_provider_grant_id AND
          ROW(r.grant_class,r.hosted_grant_id,r.owner_user_id,r.client_id,r.resource)
          IS NOT DISTINCT FROM ROW('hosted_mcp'::text,current_grant.grant_id,p_owner_user_id,p_client_id,p_resource)
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

CREATE OR REPLACE FUNCTION commonswarm_oauth.lock_hosted_client_streams(p_client_id text)
RETURNS TABLE (provider_grant_id text, owner_user_id uuid, client_id text, resource text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  initial_bindings jsonb;
  current_bindings jsonb;
  initial_streams uuid[];
  current_streams uuid[];
  pass integer;
BEGIN
  -- Existing registered clients serialize both retention and new bindings.
  -- CIMD clients have no registration row to retain.
  PERFORM c.client_id FROM commonswarm_oauth.registered_clients c
    WHERE c.client_id = p_client_id FOR UPDATE;
  FOR pass IN 1..2 LOOP
    SELECT coalesce(jsonb_agg(jsonb_build_array(
      r.provider_grant_id,r.owner_user_id,r.client_id,r.resource,r.hosted_grant_id,
      g.provider_grant_id,g.owner_user_id,g.client_id,g.resource,g.home_workspace_id,
      g.selected_workspace_ids,encode(g.manifest_digest,'hex'),g.interaction_ref)
      ORDER BY r.provider_grant_id),'[]'::jsonb)
    INTO current_bindings
    FROM commonswarm_oauth.provider_grant_resources r
    JOIN swarm.hosted_mcp_grants g ON g.grant_id = r.hosted_grant_id
    WHERE r.client_id = p_client_id AND r.grant_class = 'hosted_mcp';
    SELECT coalesce(array_agg(s.stream_id ORDER BY s.stream_id),ARRAY[]::uuid[])
    INTO current_streams FROM swarm.streams s
    WHERE s.kind = 'workspace' AND EXISTS (
      SELECT 1 FROM commonswarm_oauth.provider_grant_resources r
      JOIN swarm.hosted_mcp_grants g ON g.grant_id = r.hosted_grant_id
      WHERE r.client_id = p_client_id AND r.grant_class = 'hosted_mcp'
        AND s.workspace_id = ANY(g.selected_workspace_ids)
    );
    IF EXISTS (
      SELECT 1 FROM commonswarm_oauth.provider_grant_resources r
      JOIN swarm.hosted_mcp_grants g ON g.grant_id = r.hosted_grant_id
      WHERE r.client_id = p_client_id AND r.grant_class = 'hosted_mcp'
        AND (SELECT count(*) FROM swarm.streams s WHERE s.kind = 'workspace'
          AND s.workspace_id = ANY(g.selected_workspace_ids)) <>
            (SELECT count(DISTINCT id) FROM unnest(g.selected_workspace_ids) id)
    ) THEN
      RAISE EXCEPTION 'hosted client stream set unavailable' USING ERRCODE = '40001';
    END IF;
    IF pass = 1 THEN
      initial_bindings := current_bindings;
      initial_streams := current_streams;
      -- One global stream-id order across every family of this client.
      PERFORM s.stream_id FROM swarm.streams s
        WHERE s.stream_id = ANY(initial_streams)
        ORDER BY s.stream_id FOR UPDATE;
    ELSIF current_bindings IS DISTINCT FROM initial_bindings
       OR current_streams IS DISTINCT FROM initial_streams THEN
      -- Roll back the WHOLE transaction; never add a late, unsorted stream.
      RAISE EXCEPTION 'hosted client bindings changed; retry transaction' USING ERRCODE = '40001';
    END IF;
  END LOOP;
  -- Return the revalidated snapshot, never a later un-locked candidate.
  RETURN QUERY SELECT b.value->>0,(b.value->>1)::uuid,b.value->>2,b.value->>3
    FROM jsonb_array_elements(initial_bindings) b(value)
    ORDER BY b.value->>0;
END
$function$;

CREATE OR REPLACE FUNCTION swarm.resolve_hosted_mcp_connection_context(
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

CREATE OR REPLACE FUNCTION swarm.discover_local_target_ids(
  p_workspace_id uuid, p_target_user_id uuid, p_principal_ids uuid[],
  p_token_ids uuid[], p_all_workspace boolean, p_resume_family_id uuid, p_revoke_token boolean
)
RETURNS TABLE (
  token_id uuid,
  predecessor_token_id uuid,
  renewal_grant_id uuid,
  principal_id uuid,
  run_id uuid,
  device_id uuid,
  owner_user_id uuid,
  workspace_id uuid,
  lineage_id uuid,
  token_parent_admin_grant_id uuid,
  principal_parent_admin_grant_id uuid
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE
  bindings jsonb;
  cycle_found boolean;
BEGIN
  IF p_workspace_id IS NULL OR p_principal_ids IS NULL OR p_token_ids IS NULL
    OR p_all_workspace IS NULL OR p_revoke_token IS NULL
    OR (p_revoke_token AND (p_resume_family_id IS NOT NULL OR p_target_user_id IS NOT NULL
      OR p_all_workspace OR cardinality(p_principal_ids)<>0 OR cardinality(p_token_ids)<>1))
    OR array_position(p_principal_ids,NULL) IS NOT NULL
    OR array_position(p_token_ids,NULL) IS NOT NULL
    OR cardinality(p_principal_ids)>64 OR cardinality(p_token_ids)>64
    OR cardinality(p_principal_ids)+cardinality(p_token_ids)>128
    OR NOT (
      (p_resume_family_id IS NOT NULL AND p_target_user_id IS NULL AND NOT p_all_workspace
        AND cardinality(p_principal_ids)+cardinality(p_token_ids)=0)
      OR (p_resume_family_id IS NULL AND (
      (p_target_user_id IS NOT NULL AND NOT p_all_workspace AND cardinality(p_principal_ids)+cardinality(p_token_ids)=0)
      OR (p_target_user_id IS NULL AND NOT p_all_workspace AND cardinality(p_principal_ids)+cardinality(p_token_ids)>0)
      OR (p_target_user_id IS NULL AND p_all_workspace AND cardinality(p_principal_ids)+cardinality(p_token_ids)=0)
    ))) THEN
    RAISE EXCEPTION 'LOCAL_DISCOVERY_SELECTOR' USING ERRCODE='22023';
  END IF;
  IF EXISTS (SELECT 1 FROM swarm.agent_principals p
      WHERE p.principal_id=ANY(p_principal_ids) AND p.workspace_id<>p_workspace_id AND p.transport<>'local')
    OR EXISTS (SELECT 1 FROM swarm.agent_tokens t JOIN swarm.agent_principals p USING(principal_id)
      WHERE t.token_id=ANY(p_token_ids) AND p.workspace_id<>p_workspace_id AND p.transport<>'local') THEN
    RAISE EXCEPTION 'LOCAL_DISCOVERY_SCOPE' USING ERRCODE='22023';
  END IF;
  -- Current operation closure: exact proof, its immediate predecessor and
  -- pending/replacement child. History is checked with indexed EXISTS at the
  -- authority gate; it is never recursively enlisted into every request.
  WITH seed_principals AS (
    SELECT p.principal_id FROM swarm.agent_principals p
    WHERE (p.workspace_id=p_workspace_id OR EXISTS(SELECT 1 FROM swarm.agent_workspace_memberships am WHERE am.principal_id=p.principal_id AND am.workspace_id=p_workspace_id) OR (p.transport='local' AND p.principal_id=ANY(p_principal_ids))) AND
      (p_all_workspace OR p.owner_user_id=p_target_user_id OR p.principal_id=ANY(p_principal_ids)
       OR EXISTS(SELECT 1 FROM swarm.renewal_grants g WHERE g.renewal_grant_id=p_resume_family_id
         AND g.principal_id=p.principal_id AND g.workspace_id=p_workspace_id))
  ), current_tokens AS (
    SELECT t.token_id FROM swarm.agent_tokens t WHERE t.token_id=ANY(p_token_ids)
    UNION
    SELECT t.token_id FROM seed_principals sp JOIN swarm.agent_tokens t USING(principal_id)
    WHERE (p_all_workspace OR cardinality(p_principal_ids)>0 OR p_resume_family_id IS NOT NULL)
      AND (p_resume_family_id IS NULL OR t.renewal_grant_id=p_resume_family_id)
      AND t.revoked_at IS NULL AND (p_resume_family_id IS NULL OR NOT t.surrender_only)
      AND NOT EXISTS(SELECT 1 FROM swarm.agent_tokens child
        WHERE child.predecessor_token_id=t.token_id AND child.revoked_at IS NULL
          AND child.first_used_at IS NOT NULL)
  ), family_tokens(id) AS (
    SELECT c.token_id FROM current_tokens c
    UNION SELECT t.predecessor_token_id FROM current_tokens c
      JOIN swarm.agent_tokens t ON t.token_id=c.token_id WHERE t.predecessor_token_id IS NOT NULL
    UNION SELECT child.token_id FROM current_tokens c JOIN swarm.agent_tokens child
      ON child.predecessor_token_id=c.token_id
      WHERE child.revoked_at IS NULL AND (child.first_used_at IS NULL OR p_revoke_token)
        AND (NOT p_revoke_token OR child.lineage_id=(SELECT t.lineage_id FROM swarm.agent_tokens t WHERE t.token_id=c.token_id))
  ), rows AS (
    SELECT t.token_id,t.predecessor_token_id,t.renewal_grant_id,t.principal_id,
      t.run_id,r.device_id,p.owner_user_id,p.workspace_id,t.lineage_id,
      t.parent_admin_grant_id AS token_parent_admin_grant_id,
      p.parent_admin_grant_id AS principal_parent_admin_grant_id
    FROM family_tokens f JOIN swarm.agent_tokens t ON t.token_id=f.id
    JOIN swarm.agent_principals p ON p.principal_id=t.principal_id
    JOIN swarm.agent_runs r ON r.run_id=t.run_id AND r.principal_id=t.principal_id
    UNION
    SELECT NULL::uuid,NULL::uuid,g.renewal_grant_id,p.principal_id,g.run_id,r.device_id,
      p.owner_user_id,p.workspace_id,NULL::uuid,parents.parent_admin_grant_id,p.parent_admin_grant_id
    FROM seed_principals sp JOIN swarm.agent_principals p ON p.principal_id=sp.principal_id
    LEFT JOIN swarm.renewal_grants g ON g.principal_id=p.principal_id
      AND (g.revoked_at IS NULL OR p_resume_family_id IS NOT NULL)
      AND (p_resume_family_id IS NULL OR g.renewal_grant_id=p_resume_family_id)
    LEFT JOIN swarm.agent_runs r ON r.run_id=g.run_id AND r.principal_id=p.principal_id
    LEFT JOIN LATERAL (
      SELECT DISTINCT t.parent_admin_grant_id FROM swarm.agent_tokens t
      WHERE t.principal_id=p.principal_id AND t.renewal_grant_id IS NOT DISTINCT FROM g.renewal_grant_id
        AND t.revoked_at IS NULL AND NOT EXISTS(SELECT 1 FROM swarm.agent_tokens child
          WHERE child.predecessor_token_id=t.token_id AND child.revoked_at IS NULL AND child.first_used_at IS NOT NULL)
    ) parents ON true
    WHERE (p_resume_family_id IS NULL OR g.renewal_grant_id=p_resume_family_id)
      AND (g.renewal_grant_id IS NULL OR NOT EXISTS
      (SELECT 1 FROM family_tokens f JOIN swarm.agent_tokens t ON t.token_id=f.id
       WHERE t.renewal_grant_id=g.renewal_grant_id))
  )
  SELECT coalesce(jsonb_agg(to_jsonb(rows) ORDER BY rows.token_id,rows.principal_id,rows.renewal_grant_id),'[]'::jsonb)
  INTO bindings FROM rows;
  IF EXISTS (SELECT 1 FROM jsonb_to_recordset(bindings) b(token_id uuid, predecessor_token_id uuid, renewal_grant_id uuid, principal_id uuid, run_id uuid, device_id uuid, owner_user_id uuid, workspace_id uuid, lineage_id uuid, token_parent_admin_grant_id uuid, principal_parent_admin_grant_id uuid)
      WHERE b.workspace_id<>p_workspace_id AND NOT EXISTS(SELECT 1 FROM swarm.agent_principals p WHERE p.principal_id=b.principal_id AND p.transport='local')) THEN
    RAISE EXCEPTION 'LOCAL_DISCOVERY_BINDING' USING ERRCODE='22023',DETAIL='LOCAL_DISCOVERY_BINDING';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_to_recordset(bindings) b(token_id uuid,renewal_grant_id uuid,principal_id uuid,
      run_id uuid,device_id uuid,workspace_id uuid,owner_user_id uuid)
    LEFT JOIN swarm.renewal_grants g ON g.renewal_grant_id=b.renewal_grant_id
    LEFT JOIN swarm.devices d ON d.device_id=b.device_id
    WHERE (b.renewal_grant_id IS NOT NULL AND
      (g.renewal_grant_id IS NULL OR ROW(g.principal_id,g.run_id,g.workspace_id,g.created_by)
        IS DISTINCT FROM ROW(b.principal_id,b.run_id,b.workspace_id,b.owner_user_id)))
      OR (b.device_id IS NOT NULL AND (d.device_id IS NULL OR d.user_id<>b.owner_user_id))
      OR (p_resume_family_id IS NOT NULL AND (g.renewal_grant_id IS DISTINCT FROM p_resume_family_id
        OR (g.bound_device_id IS NOT NULL AND g.bound_device_id IS DISTINCT FROM b.device_id)))
  ) THEN
    RAISE EXCEPTION 'LOCAL_DISCOVERY_BINDING' USING ERRCODE='22023',DETAIL='LOCAL_DISCOVERY_BINDING';
  END IF;
  IF EXISTS(SELECT 1 FROM swarm.agent_tokens child LEFT JOIN swarm.agent_tokens pred
      ON pred.token_id=child.predecessor_token_id
      WHERE child.token_id IN (SELECT b.token_id FROM jsonb_to_recordset(bindings) b(token_id uuid))
        AND child.predecessor_token_id IS NOT NULL AND (pred.token_id IS NULL OR
          ROW(child.principal_id,child.run_id,child.task_id,child.epoch,child.lineage_id,child.renewal_grant_id)
          IS DISTINCT FROM ROW(pred.principal_id,pred.run_id,pred.task_id,pred.epoch,pred.lineage_id,pred.renewal_grant_id)))
    OR EXISTS(SELECT b.lineage_id FROM jsonb_to_recordset(bindings)
      b(lineage_id uuid,principal_id uuid,run_id uuid,renewal_grant_id uuid,owner_user_id uuid,workspace_id uuid)
      WHERE b.lineage_id IS NOT NULL GROUP BY b.lineage_id
      HAVING count(DISTINCT ROW(b.principal_id,b.run_id,b.renewal_grant_id,b.owner_user_id,b.workspace_id))>1) THEN
    RAISE EXCEPTION 'LOCAL_DISCOVERY_BINDING' USING ERRCODE='22023',DETAIL='LOCAL_DISCOVERY_BINDING';
  END IF;
  IF (p_all_workspace OR cardinality(p_token_ids)>0 OR p_resume_family_id IS NOT NULL) AND (jsonb_array_length(bindings)>4096 OR
    (SELECT count(DISTINCT b.owner_user_id)>256 OR count(DISTINCT b.principal_id)>256
      OR count(DISTINCT b.run_id)>256 OR count(DISTINCT b.device_id)>256
      OR count(DISTINCT b.renewal_grant_id)>256 OR count(DISTINCT b.token_id)>2048
     FROM jsonb_to_recordset(bindings) b(token_id uuid, predecessor_token_id uuid, renewal_grant_id uuid, principal_id uuid, run_id uuid, device_id uuid, owner_user_id uuid, workspace_id uuid, lineage_id uuid, token_parent_admin_grant_id uuid, principal_parent_admin_grant_id uuid))
    OR (SELECT count(*)>256 FROM (
      SELECT b.owner_user_id AS id FROM jsonb_to_recordset(bindings) b(owner_user_id uuid)
      UNION SELECT a.owner_user_id FROM swarm.admin_grants a
        WHERE a.grant_id IN (SELECT b.token_parent_admin_grant_id FROM jsonb_to_recordset(bindings) b(token_parent_admin_grant_id uuid)
          UNION SELECT b.principal_parent_admin_grant_id FROM jsonb_to_recordset(bindings) b(principal_parent_admin_grant_id uuid))
    ) owners)
    OR (SELECT count(DISTINCT id)>256 FROM jsonb_to_recordset(bindings) b(token_id uuid, predecessor_token_id uuid, renewal_grant_id uuid, principal_id uuid, run_id uuid, device_id uuid, owner_user_id uuid, workspace_id uuid, lineage_id uuid, token_parent_admin_grant_id uuid, principal_parent_admin_grant_id uuid)
      CROSS JOIN LATERAL unnest(ARRAY[b.token_parent_admin_grant_id,b.principal_parent_admin_grant_id]) id)
    OR (SELECT count(*)>256 FROM swarm.agent_execution_sessions s
      WHERE s.principal_id IN (SELECT b.principal_id FROM jsonb_to_recordset(bindings) b(token_id uuid, predecessor_token_id uuid, renewal_grant_id uuid, principal_id uuid, run_id uuid, device_id uuid, owner_user_id uuid, workspace_id uuid, lineage_id uuid, token_parent_admin_grant_id uuid, principal_parent_admin_grant_id uuid)))
    ) THEN
    RAISE EXCEPTION 'LOCAL_DISCOVERY_CAP' USING ERRCODE='54000';
  END IF;
  -- Required R/E keys are enumerated and capped by the caller before row
  -- locks; unrelated workspace streams are not an auth work bound.
  -- Detect malformed directed predecessor cycles independently of fixed-point expansion.
  WITH RECURSIVE walk(id,pred,path,cycle) AS (
    SELECT t.token_id,t.predecessor_token_id,ARRAY[t.token_id],false
    FROM swarm.agent_tokens t WHERE t.token_id IN
      (SELECT b.token_id FROM jsonb_to_recordset(bindings) b(token_id uuid, predecessor_token_id uuid, renewal_grant_id uuid, principal_id uuid, run_id uuid, device_id uuid, owner_user_id uuid, workspace_id uuid, lineage_id uuid, token_parent_admin_grant_id uuid, principal_parent_admin_grant_id uuid))
    UNION ALL
    SELECT t.token_id,t.predecessor_token_id,w.path||t.token_id,t.token_id=ANY(w.path)
    FROM walk w JOIN swarm.agent_tokens t ON t.token_id=w.pred
    WHERE NOT w.cycle AND t.token_id IN
      (SELECT b.token_id FROM jsonb_to_recordset(bindings) b(token_id uuid))
  ) SELECT coalesce(bool_or(w.cycle),false) INTO cycle_found FROM walk w;
  IF cycle_found THEN
    RAISE EXCEPTION 'LOCAL_DISCOVERY_CYCLE' USING ERRCODE='22023';
  END IF;
  RETURN QUERY SELECT b.token_id, b.predecessor_token_id, b.renewal_grant_id, b.principal_id, b.run_id, b.device_id, b.owner_user_id, b.workspace_id, b.lineage_id, b.token_parent_admin_grant_id, b.principal_parent_admin_grant_id FROM jsonb_to_recordset(bindings) b(token_id uuid, predecessor_token_id uuid, renewal_grant_id uuid, principal_id uuid, run_id uuid, device_id uuid, owner_user_id uuid, workspace_id uuid, lineage_id uuid, token_parent_admin_grant_id uuid, principal_parent_admin_grant_id uuid)
    ORDER BY b.token_id,b.principal_id,b.renewal_grant_id;
END
$fn$;

CREATE OR REPLACE FUNCTION swarm.local_agent_membership_allowed(p_workspace uuid,p_principal uuid,p_actor uuid,p_add boolean)
RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM swarm.agent_principals p
 JOIN swarm.memberships actor ON actor.workspace_id=p_workspace AND actor.user_id=p_actor
 JOIN swarm.memberships owner ON owner.workspace_id=p_workspace AND owner.user_id=p.owner_user_id
 JOIN swarm.workspaces target ON target.workspace_id=p_workspace
 WHERE p.principal_id=p_principal AND p.transport='local' AND NOT p.turn_only AND p.revoked_at IS NULL
 AND actor.revoked_at IS NULL AND owner.revoked_at IS NULL AND target.archived_at IS NULL
 AND (p.owner_user_id=p_actor OR actor.role IN ('owner','admin'))
 AND NOT EXISTS(SELECT 1 FROM swarm.agent_join_credentials c WHERE c.registrar_principal_id=p_principal)
 AND (NOT p_add OR EXISTS(SELECT 1 FROM swarm.agent_workspace_memberships am
   JOIN swarm.workspaces origin ON origin.workspace_id=am.workspace_id
   JOIN swarm.memberships om ON om.workspace_id=am.workspace_id AND om.user_id=p.owner_user_id
   WHERE am.principal_id=p_principal AND origin.org_id=target.org_id AND am.revoked_at IS NULL
     AND om.revoked_at IS NULL AND origin.archived_at IS NULL)
   -- Explicitly restoring an existing membership works even when the connection is dormant.
   OR EXISTS(SELECT 1 FROM swarm.agent_workspace_memberships am JOIN swarm.workspaces origin ON origin.workspace_id=p.workspace_id
     WHERE am.principal_id=p_principal AND am.workspace_id=p_workspace AND origin.org_id=target.org_id)))
$$;

CREATE OR REPLACE FUNCTION swarm.change_local_agent_membership(p_workspace uuid,p_principal uuid,p_actor uuid,p_add boolean)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE changed boolean;
BEGIN
 IF NOT swarm.local_agent_membership_allowed(p_workspace,p_principal,p_actor,p_add) THEN RETURN false; END IF;
 IF p_add THEN
   INSERT INTO swarm.agent_workspace_memberships(principal_id,workspace_id,owner_user_id,added_by)
   SELECT p_principal,p_workspace,p.owner_user_id,p_actor FROM swarm.agent_principals p WHERE p.principal_id=p_principal
   ON CONFLICT(principal_id,workspace_id) DO UPDATE SET revoked_at=NULL,added_by=p_actor,added_at=clock_timestamp()
   WHERE swarm.agent_workspace_memberships.revoked_at IS NOT NULL;
   PERFORM set_config('cswarm.membership_removal','true',true);
   INSERT INTO swarm.agent_execution_sessions(principal_id,workspace_id,session_id,lifecycle_state,expired_at)
   SELECT principal_id,p_workspace,gen_random_uuid(),'enabled',clock_timestamp() FROM swarm.agent_principals
   WHERE principal_id=p_principal AND managed_at IS NOT NULL
   ON CONFLICT(principal_id,workspace_id) DO UPDATE SET lifecycle_state='enabled' WHERE swarm.agent_execution_sessions.lifecycle_state='disabled';
   PERFORM set_config('cswarm.membership_removal','false',true);
 ELSE
   UPDATE swarm.agent_workspace_memberships SET revoked_at=clock_timestamp()
   WHERE principal_id=p_principal AND workspace_id=p_workspace AND revoked_at IS NULL;
   -- End only the removed target's proof, delivery, wake and content authority.
   PERFORM set_config('cswarm.membership_removal','true',true);
   UPDATE swarm.agent_execution_sessions SET key_hash=NULL,lifecycle_state='disabled',expired_at=clock_timestamp(),generation=generation+1
   WHERE principal_id=p_principal AND workspace_id=p_workspace;
   PERFORM set_config('cswarm.membership_removal','false',true);
   DELETE FROM swarm.agent_wake_leases WHERE principal_id=p_principal AND workspace_id=p_workspace;
   DELETE FROM swarm.h0_poll_locks WHERE principal_id=p_principal AND workspace_id=p_workspace;
   UPDATE swarm.signal_deliveries SET leased_until=NULL,leased_by=NULL,lease_id=NULL,session_id=NULL,session_generation=NULL
   WHERE recipient_agent_principal_id=p_principal AND workspace_id=p_workspace AND acked_at IS NULL;
   UPDATE swarm.household_content_connections SET revoked_at=clock_timestamp()
   WHERE principal_id=p_principal AND workspace_id=p_workspace AND hosted_grant_id IS NULL AND revoked_at IS NULL;
 END IF;
 RETURN true;
END $$;

CREATE OR REPLACE FUNCTION swarm.audit_household_hosted_restriction() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE actor uuid; command_kind text; request_id text; digest text; expected jsonb; prior_markers jsonb;
BEGIN
 actor := nullif(current_setting('cswarm.household_actor',true),'')::uuid;
 command_kind := current_setting('cswarm.household_command',true);
 request_id := nullif(current_setting('cswarm.household_request',true),'');
 digest := nullif(current_setting('cswarm.household_digest',true),'');
 IF current_user<>'swarm_command' OR actor IS NULL OR request_id IS NULL OR digest IS NULL
   OR digest !~ '^[0-9a-f]{64}$' OR command_kind IS NULL OR command_kind='' OR actor<>NEW.owner_user_id
   OR NOT EXISTS(SELECT 1 FROM swarm.memberships m JOIN swarm.workspaces w USING(workspace_id)
     WHERE m.workspace_id=NEW.workspace_id AND m.user_id=actor AND m.revoked_at IS NULL AND w.archived_at IS NULL)
   OR NOT EXISTS(SELECT 1 FROM swarm.hosted_mcp_seats s WHERE s.workspace_id=NEW.workspace_id
     AND s.grant_id=NEW.grant_id AND s.principal_id=NEW.principal_id AND s.owner_user_id=actor) THEN
  RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='owned hosted restriction context required';
 END IF;
 IF TG_OP='UPDATE' AND (NEW.grant_id,NEW.workspace_id,NEW.owner_user_id,NEW.principal_id)
   IS DISTINCT FROM (OLD.grant_id,OLD.workspace_id,OLD.owner_user_id,OLD.principal_id) THEN
  RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='hosted restriction scope is immutable';
 END IF;
 -- New grant-wide restrictions originate only while this human is a current
 -- workspace owner. An existing owner-origin target can still be changed after
 -- downgrade; ordinary never-owner admin/member per-seat approvals are unchanged.
 IF TG_OP='INSERT' AND NOT EXISTS(SELECT 1 FROM swarm.memberships m
   WHERE m.workspace_id=NEW.workspace_id AND m.user_id=actor AND m.role='owner' AND m.revoked_at IS NULL) THEN
  RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='current owner required for new hosted restriction';
 END IF;
 IF NEW.origin='human_allow' THEN
  IF command_kind NOT IN ('household_permissions','household_approve_connection') OR NOT EXISTS(
    SELECT 1 FROM swarm.household_content_connections c
    JOIN swarm.household_member_content_roles r ON r.workspace_id=c.workspace_id AND r.user_id=c.owner_user_id
    JOIN swarm.household_workspace_boundaries b ON b.workspace_id=c.workspace_id
    JOIN swarm.hosted_mcp_grants g ON g.grant_id=c.hosted_grant_id
    JOIN swarm.hosted_mcp_grant_workspaces gw ON gw.grant_id=g.grant_id AND gw.workspace_id=c.workspace_id
    JOIN swarm.hosted_mcp_seats s ON s.seat_id=c.connection_id AND s.grant_id=g.grant_id AND s.principal_id=c.principal_id
    WHERE c.workspace_id=NEW.workspace_id AND c.hosted_grant_id=NEW.grant_id AND c.principal_id=NEW.principal_id
      AND c.owner_user_id=actor AND c.revoked_at IS NULL AND (c.expires_at IS NULL OR c.expires_at>clock_timestamp())
      AND c.operations=NEW.operations AND c.consent_receipt_id=r.content_consent_id AND r.revoked_at IS NULL
      AND (r.content_role='editor' OR NEW.operations=ARRAY['read']::text[])
      AND c.purpose=b.purpose AND (b.purpose='shared' OR b.owner_user_id=actor)
      AND g.state='active' AND g.revoked_at IS NULL AND gw.revoked_at IS NULL AND s.revoked_at IS NULL) THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='live human connection approval required';
  END IF;
 ELSIF NEW.origin='human_withdraw' THEN
  IF command_kind IS DISTINCT FROM 'household_withdraw_connection' THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='human withdrawal context required';
  END IF;
 ELSE
  IF command_kind IS DISTINCT FROM 'household_connection_invalidation' THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='connection invalidation context required';
  END IF;
 END IF;
 -- Replacement authorization is separate from ordinary per-seat Allow.
 -- Exact JSON equality includes every relevant legacy field and restriction
 -- version; containment would wrongly accept subsets of operation arrays.
 IF jsonb_typeof(NEW.closed_target_replacements) IS DISTINCT FROM 'array' THEN
  RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='closed target snapshots must be an array';
 END IF;
 IF jsonb_array_length(NEW.closed_target_replacements)>256 THEN
  RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='closed target snapshot bound exceeded';
 END IF;
 IF NEW.closed_target_replacements<>'[]'::jsonb THEN
  IF NEW.origin<>'human_allow' OR command_kind NOT IN ('household_permissions','household_approve_connection')
    OR NOT EXISTS(SELECT 1 FROM swarm.memberships m WHERE m.workspace_id=NEW.workspace_id
      AND m.user_id=actor AND m.role='owner' AND m.revoked_at IS NULL) THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='current owner human Allow required for closed target replacement';
  END IF;
  SELECT coalesce(jsonb_agg(snapshot ORDER BY snapshot::text),'[]'::jsonb) INTO expected FROM (
      SELECT jsonb_build_object('kind','restriction','principal_id',r.principal_id,'operations',r.operations,'origin',r.origin,'changed_at',r.changed_at,'changed_by',r.changed_by) AS snapshot FROM swarm.household_hosted_content_restrictions r
        WHERE r.grant_id=NEW.grant_id AND r.workspace_id=NEW.workspace_id AND EXISTS(SELECT 1 FROM swarm.hosted_mcp_seats cs WHERE cs.grant_id=r.grant_id
          AND cs.workspace_id=r.workspace_id AND cs.principal_id=r.principal_id AND cs.owner_user_id=r.owner_user_id)
        AND NOT EXISTS(SELECT 1 FROM swarm.hosted_mcp_seats ls JOIN swarm.agent_principals lp USING(principal_id)
          WHERE ls.grant_id=r.grant_id AND ls.workspace_id=r.workspace_id
            AND ls.principal_id=r.principal_id AND ls.owner_user_id=r.owner_user_id
            AND ls.revoked_at IS NULL AND lp.revoked_at IS NULL)
      UNION ALL
      SELECT jsonb_build_object('kind','legacy','row',to_jsonb(c)) AS snapshot FROM swarm.household_content_connections c
        WHERE c.hosted_grant_id=NEW.grant_id AND c.workspace_id=NEW.workspace_id AND EXISTS(SELECT 1 FROM swarm.hosted_mcp_seats cs WHERE cs.grant_id=c.grant_id
          AND cs.workspace_id=c.workspace_id AND cs.principal_id=c.principal_id AND cs.owner_user_id=c.owner_user_id)
        AND NOT EXISTS(SELECT 1 FROM swarm.hosted_mcp_seats ls JOIN swarm.agent_principals lp USING(principal_id)
          WHERE ls.grant_id=c.grant_id AND ls.workspace_id=c.workspace_id
            AND ls.principal_id=c.principal_id AND ls.owner_user_id=c.owner_user_id
            AND ls.revoked_at IS NULL AND lp.revoked_at IS NULL)
      LIMIT 257
  ) targets;
  -- Retain exact wrapper/row fields, array length and ordinal. Only a
  -- legacy inner-row key absent in the saved marker may match a new JSON null.
  -- IS DISTINCT FROM keeps SQL NULL and malformed values fail closed.
  IF jsonb_array_length(NEW.closed_target_replacements) IS DISTINCT FROM jsonb_array_length(expected)
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(NEW.closed_target_replacements) WITH ORDINALITY AS saved(value,ordinal)
      FULL JOIN jsonb_array_elements(expected) WITH ORDINALITY AS live(value,ordinal) USING(ordinal)
      WHERE saved.value IS DISTINCT FROM live.value AND (
        jsonb_typeof(saved.value->'row')='object'
        AND live.value->>'kind'='legacy'
        AND NOT (saved.value->'row' ? 'renewal_grant_id')
        AND live.value->'row'->'renewal_grant_id'='null'::jsonb
        AND saved.value=jsonb_set(live.value,'{row}',(live.value->'row')-'renewal_grant_id')
      ) IS DISTINCT FROM true
    ) THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='exact closed target snapshots required';
  END IF;
 END IF;
 prior_markers := CASE WHEN TG_OP='UPDATE' THEN OLD.closed_target_replacements ELSE '[]'::jsonb END;
 IF prior_markers IS DISTINCT FROM NEW.closed_target_replacements THEN
  -- Keep both marker versions in the existing append-only audit. No approval,
  -- restriction, consent or historical audit row is deleted or rewritten.
  INSERT INTO swarm.household_object_audit(audit_id,workspace_id,command_id,actor_user,actor_principal,occurred_at,command_kind,request_digest,outcome,reason_code)
  VALUES(gen_random_uuid(),NEW.workspace_id,request_id,actor,NULL,clock_timestamp(),command_kind,digest,'committed',
    'closed_target_replacements:' || jsonb_build_object('principal_id',NEW.principal_id,'old',prior_markers,'new',NEW.closed_target_replacements)::text);
 END IF;
 NEW.changed_by := actor;
 NEW.changed_at := clock_timestamp();
 INSERT INTO swarm.household_object_audit(audit_id,workspace_id,command_id,actor_user,actor_principal,occurred_at,command_kind,request_digest,outcome,reason_code)
 VALUES(gen_random_uuid(),NEW.workspace_id,request_id,actor,NULL,NEW.changed_at,command_kind,digest,'committed',NEW.origin);
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION swarm_read.home_overview() RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog AS $$
DECLARE
 claims jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
 viewer uuid;
 read_at timestamptz := statement_timestamp();
 workspace record;
 can_read boolean;
 last_seen timestamptz;
 new_messages integer;
 content jsonb;
 people jsonb;
 asks jsonb;
 assigned jsonb;
 waiting jsonb;
 result jsonb := '[]'::jsonb;
BEGIN
 IF claims IS NULL OR claims->>'role' IS DISTINCT FROM 'authenticated'
  OR claims ? 'agent_principal_id' OR nullif(claims->>'sub', '') IS NULL THEN
  RETURN NULL;
 END IF;
 -- Malformed identity is refused rather than cast into a different identity.
 IF claims->>'sub' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN NULL; END IF;
 viewer := (claims->>'sub')::uuid;
 FOR workspace IN
  SELECT w.workspace_id, w.name, m.role
  FROM swarm.workspaces w JOIN swarm.memberships m USING (workspace_id)
  WHERE m.user_id = viewer AND m.revoked_at IS NULL AND w.archived_at IS NULL
  ORDER BY w.created_at, w.workspace_id LIMIT 50
 LOOP
  can_read := swarm.household_human_can_read(workspace.workspace_id, viewer);
  SELECT max(r.first_seen_at) INTO last_seen FROM swarm.signal_human_receipts r
   WHERE r.workspace_id = workspace.workspace_id AND r.user_id = viewer;
  SELECT count(*) INTO new_messages FROM (
   SELECT s.id FROM swarm_read.signals s
   WHERE s.workspace_id = workspace.workspace_id
    AND NOT (s.from_kind = 'user' AND s."from" = viewer)
    AND s.created_at > coalesce(last_seen, read_at - interval '7 days')
   LIMIT 99
  ) messages;
  SELECT coalesce(jsonb_agg(a.value ORDER BY a.created_at DESC, a.id), '[]'::jsonb) INTO asks FROM (
   SELECT s.id, s.created_at, jsonb_build_object('signal_id', s.id,
    'from', jsonb_build_object('kind', s.from_kind, 'id', s."from"),
    'created_at', s.created_at, 'until', s.until) AS value
   FROM swarm_read.signals s
   WHERE s.workspace_id = workspace.workspace_id AND s.kind = 'ask' AND s.until > read_at
    AND (s."to" = viewer OR EXISTS (
     SELECT 1 FROM swarm.signal_recipients r WHERE r.workspace_id = s.workspace_id
      AND r.signal_id = s.id AND r.recipient_user_id = viewer))
    AND NOT EXISTS (
     SELECT 1 FROM swarm.signals reply WHERE reply.workspace_id = s.workspace_id AND reply.in_reply_to = s.id
      AND ((reply.from_kind = 'user' AND reply.from_principal = viewer)
       OR (reply.from_kind = 'agent' AND EXISTS (
        SELECT 1 FROM swarm.agent_principals p WHERE p.workspace_id = reply.workspace_id
         AND p.principal_id = reply.from_principal AND p.owner_user_id = viewer))))
   ORDER BY s.created_at DESC, s.id LIMIT 10
  ) a;
  content := NULL;
  assigned := '[]'::jsonb;
  waiting := '[]'::jsonb;
  IF can_read THEN
   SELECT jsonb_build_object('open_todos', (
    SELECT count(*) FROM swarm.household_todos t WHERE t.workspace_id = workspace.workspace_id AND t.state IN ('open','doing')),
    'lists', count(*) FILTER (WHERE o.value->>'kind' = 'list'),
    'docs', count(*) FILTER (WHERE o.value->>'kind' = 'doc'),
    'files', count(*) FILTER (WHERE o.value->>'kind' = 'file')) INTO content
   FROM swarm.household_object_streams os
   CROSS JOIN LATERAL jsonb_each(coalesce(os.projection->'objects', '{}'::jsonb)) o
   WHERE os.workspace_id = workspace.workspace_id;
   SELECT coalesce(jsonb_agg(a.value ORDER BY a.state_at DESC, a.todo_id), '[]'::jsonb) INTO assigned FROM (
    SELECT t.todo_id, t.state_at, jsonb_build_object('todo_id',t.todo_id,'title',t.title,'state',t.state,'due_on',t.due_on) value
    FROM swarm.household_todos t WHERE t.workspace_id = workspace.workspace_id
     AND t.assignee_user = viewer AND t.state IN ('open','doing')
    ORDER BY t.state_at DESC, t.todo_id LIMIT 20
   ) a;
   SELECT coalesce(jsonb_agg(a.value ORDER BY a.state_at DESC, a.todo_id, a.reason), '[]'::jsonb) INTO waiting FROM (
    SELECT t.todo_id, t.state_at, reason.kind AS reason,
     jsonb_build_object('todo_id',t.todo_id,'title',t.title,'state',t.state,'due_on',t.due_on,
      'reason',reason.kind,'agent_id', CASE WHEN reason.kind = 'request' THEN t.offer_principal ELSE t.assignee_principal END) value
    FROM swarm.household_todos t
    LEFT JOIN swarm.agent_principals p ON p.workspace_id = t.workspace_id AND p.principal_id = t.assignee_principal
    -- Pick one reason per to-do before the 20-to-do bound: request, after, hold, agent_removed.
    CROSS JOIN LATERAL (
     SELECT CASE
     WHEN t.offer_id IS NOT NULL AND t.offer_decider = viewer THEN 'request'
     WHEN t.gate_kind = 'after' AND EXISTS (
      SELECT 1 FROM swarm.household_todos prerequisite WHERE prerequisite.workspace_id = t.workspace_id
       AND prerequisite.todo_id = t.gate_todo_id AND prerequisite.assignee_user = viewer AND prerequisite.state IN ('open','doing')) THEN 'after'
     WHEN t.gate_kind = 'hold' AND p.owner_user_id = viewer AND p.revoked_at IS NULL THEN 'hold'
     WHEN p.owner_user_id = viewer AND p.revoked_at IS NOT NULL THEN 'agent_removed'
     END AS kind
    ) reason
    WHERE t.workspace_id = workspace.workspace_id AND t.state IN ('open','doing') AND reason.kind IS NOT NULL
    ORDER BY t.state_at DESC, t.todo_id, reason.kind LIMIT 20
   ) a;
  END IF;
  WITH members AS MATERIALIZED (
   SELECT m.user_id, m.role, u.display_name FROM swarm.memberships m JOIN swarm.users u USING (user_id)
   WHERE m.workspace_id = workspace.workspace_id AND m.revoked_at IS NULL
   ORDER BY (m.user_id = viewer) DESC, m.user_id LIMIT 25
  ), agents AS MATERIALIZED (
   -- Use the existing roster view: registration-only principals stay hidden.
   SELECT p.* FROM swarm_read.agent_principals p JOIN members m ON m.user_id = p.owner_user_id
   WHERE p.workspace_id = workspace.workspace_id
   ORDER BY (p.owner_user_id = viewer) DESC, p.owner_user_id, p.principal_id LIMIT 50
  ), todo_facts AS MATERIALIZED (
   SELECT t.*, CASE t.gate_kind
    WHEN 'none' THEN true WHEN 'hold' THEN false WHEN 'at' THEN t.gate_at <= read_at
    WHEN 'after' THEN EXISTS (SELECT 1 FROM swarm.household_todos predecessor
     WHERE predecessor.workspace_id = t.workspace_id AND predecessor.todo_id = t.gate_todo_id AND predecessor.state IN ('done','dropped'))
    ELSE false END AS gate_clear
   FROM swarm.household_todos t WHERE t.workspace_id = workspace.workspace_id
  ), agent_facts AS (
   SELECT p.*, connection.kind AS connection,
    CASE WHEN p.transport='hosted_mcp' AND hosted_policy.grant_id IS NOT NULL THEN
      jsonb_build_object('connection_expires_at',hosted_policy.connection_expires_at,
        'connection_expired_at',coalesce(hosted_policy.connection_expired_at,
          CASE WHEN hosted_policy.connection_expires_at<=clock_timestamp() THEN hosted_policy.connection_expires_at END))
    WHEN p.transport='local' AND local_policy.renewal_grant_id IS NOT NULL THEN
      jsonb_build_object('renewal_grant_id',local_policy.renewal_grant_id,
        'connection_expires_at',local_policy.connection_expires_at,
        'connection_expired_at',coalesce(local_policy.connection_expired_at,
          CASE WHEN local_policy.connection_expires_at<=clock_timestamp() THEN local_policy.connection_expires_at END))
        || CASE WHEN selected.selected_token_id IS NOT NULL THEN jsonb_build_object('token_id',selected.selected_token_id) ELSE '{}'::jsonb END
    WHEN p.transport='local' AND selected.selected_token_id IS NOT NULL THEN
      jsonb_build_object('renewal_grant_id',NULL,'token_id',selected.selected_token_id)
    ELSE '{}'::jsonb END AS connection_policy,
    -- Raw signals are safe here: last_activity_at exposes only a time, no content or signal id.
    greatest(presence.last_command_at,
     (SELECT max(s.created_at) FROM swarm.signals s WHERE s.workspace_id = p.workspace_id AND s.from_kind = 'agent' AND s.from_principal = p.principal_id),
     (SELECT max(greatest(b.created_at,b.acknowledged_at)) FROM swarm.hosted_mcp_check_batches b WHERE b.workspace_id = p.workspace_id AND b.principal_id = p.principal_id),
     (SELECT max(e.occurred_at) FROM swarm.household_todo_events e WHERE e.workspace_id = p.workspace_id AND e.event->>'actor_agent_principal' = p.principal_id::text),
     (SELECT to_timestamp(max((e.event->>'occurred_at_server')::numeric)/1000) FROM swarm.household_object_events e
      WHERE e.workspace_id = p.workspace_id AND e.event->>'actor_agent_principal' = p.principal_id::text)) AS last_activity_at,
    (SELECT min(d.enqueued_at) FROM swarm.signal_deliveries d JOIN swarm.signals s ON s.workspace_id = d.workspace_id AND s.id = d.signal_id
     WHERE d.workspace_id = p.workspace_id AND d.recipient_agent_principal_id = p.principal_id AND d.acked_at IS NULL AND s.until > read_at) AS messages_waiting_since,
    doing.value AS doing, working.value AS working_on,
    CASE WHEN can_read THEN jsonb_build_object(
     'working',(SELECT count(*) FROM todo_facts t WHERE t.assignee_principal = p.principal_id AND t.state = 'doing'),
     'up_next',(SELECT count(*) FROM todo_facts t WHERE t.assignee_principal = p.principal_id AND t.state = 'open' AND t.gate_clear),
     'not_yet',(SELECT count(*) FROM todo_facts t WHERE t.assignee_principal = p.principal_id AND t.state = 'open' AND NOT t.gate_clear),
     'requests',(SELECT count(*) FROM todo_facts t WHERE t.offer_principal = p.principal_id AND t.offer_id IS NOT NULL AND t.state IN ('open','doing'))) ELSE NULL END AS queue
   FROM agents p
   LEFT JOIN swarm.agent_presence presence ON presence.workspace_id = p.workspace_id AND presence.principal_id = p.principal_id
   LEFT JOIN LATERAL (
    SELECT jsonb_build_object('todo_id',t.todo_id,'title',CASE WHEN can_read THEN t.title ELSE NULL END,'since',t.state_at) value
    FROM todo_facts t WHERE t.assignee_principal = p.principal_id AND t.state = 'doing'
    ORDER BY t.state_at DESC, t.todo_id LIMIT 1
   ) doing ON true
   LEFT JOIN LATERAL (
    SELECT jsonb_build_object('signal_id',s.id,'at',s.created_at,'until',s.until) value
    FROM swarm_read.signals s WHERE s.workspace_id = p.workspace_id AND s.from_kind = 'agent' AND s."from" = p.principal_id
     AND s.kind = 'working-on' AND s.until > read_at ORDER BY s.created_at DESC, s.id LIMIT 1
   ) working ON true
   LEFT JOIN LATERAL swarm_read.local_connection_selection(p.workspace_id,p.principal_id,p.owner_user_id)
    selected ON p.transport='local'
   LEFT JOIN swarm.renewal_grants local_policy
    ON local_policy.renewal_grant_id=selected.selected_renewal_grant_id
   -- principal_id is UNIQUE on seats: policy and status share this same grant.
   LEFT JOIN LATERAL (
    SELECT g.*,seat.revoked_at AS seat_revoked_at,binding.revoked_at AS binding_revoked_at
    FROM swarm.hosted_mcp_seats seat
    JOIN swarm.hosted_mcp_grant_workspaces binding ON binding.grant_id=seat.grant_id
      AND binding.workspace_id=seat.workspace_id AND binding.owner_user_id=seat.owner_user_id
    JOIN swarm.hosted_mcp_grants g ON g.grant_id=binding.grant_id AND g.owner_user_id=binding.owner_user_id
    WHERE p.transport='hosted_mcp' AND seat.workspace_id=p.workspace_id
      AND seat.principal_id=p.principal_id AND seat.owner_user_id=p.owner_user_id
   ) hosted_policy ON true
   CROSS JOIN LATERAL (
    SELECT CASE
     WHEN p.revoked_at IS NOT NULL THEN 'removed'
     WHEN p.transport = 'hosted_mcp' THEN CASE
      WHEN hosted_policy.seat_revoked_at IS NULL AND hosted_policy.binding_revoked_at IS NULL
       AND hosted_policy.revoked_at IS NULL AND hosted_policy.state='active'
       AND hosted_policy.connection_expired_at IS NULL
       AND (hosted_policy.connection_expires_at IS NULL OR hosted_policy.connection_expires_at>clock_timestamp())
      THEN 'live' ELSE 'connection_off' END
     WHEN selected.is_live THEN 'live'
     WHEN local_policy.connection_expired_at IS NOT NULL OR local_policy.connection_expires_at<=clock_timestamp() THEN 'key_ended'
     WHEN local_policy.revoked_at IS NULL AND local_policy.suspension_active
      AND local_policy.connection_expired_at IS NULL
      AND (local_policy.connection_expires_at IS NULL OR local_policy.connection_expires_at>clock_timestamp()) THEN 'paused'
     WHEN local_policy.revoked_at IS NOT NULL THEN 'key_off'
     WHEN EXISTS (SELECT 1 FROM swarm.agent_tokens token WHERE token.principal_id = p.principal_id AND token.revoked_at IS NULL)
      THEN 'key_ended' ELSE 'key_off' END AS kind
   ) connection
  ), rows AS (
   SELECT m.*, coalesce((SELECT jsonb_agg(jsonb_build_object('principal_id',a.principal_id,'name',a.name,
    'status',jsonb_build_object('work',CASE WHEN a.connection <> 'live' THEN 'disconnected'
     WHEN (a.doing IS NOT NULL OR a.working_on IS NOT NULL) AND a.last_activity_at >= read_at - interval '30 minutes' THEN 'working' ELSE 'idle' END,
     'facts',jsonb_build_object('transport',a.transport,'turn_only',a.turn_only,'connection',a.connection,
      'last_activity_at',a.last_activity_at,'messages_waiting_since',a.messages_waiting_since,'doing',a.doing,'working_on',a.working_on) || a.connection_policy),
    'queue',a.queue) ORDER BY a.principal_id) FROM agent_facts a WHERE a.owner_user_id = m.user_id),'[]'::jsonb) AS agents
   FROM members m
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('user_id',r.user_id,'display_name',r.display_name,'role',r.role,
   'is_viewer',r.user_id = viewer,'agents',r.agents) ORDER BY (r.user_id = viewer) DESC,r.user_id),'[]'::jsonb) INTO people FROM rows r;
  result := result || jsonb_build_array(jsonb_build_object('workspace_id',workspace.workspace_id,'name',workspace.name,'role',workspace.role,
   'last_seen_at',last_seen,'new_messages',new_messages,'content',content,'people',people,
   'needs_you',jsonb_build_object('asks',asks,'assigned',assigned,'waiting',waiting)));
 END LOOP;
 RETURN jsonb_build_object('viewer_user_id',viewer,'generated_at',read_at,'workspaces',result);
END;
$$;

DROP TRIGGER IF EXISTS hosted_mcp_seats_seed_grant_agent ON swarm.hosted_mcp_seats;
DROP FUNCTION IF EXISTS swarm.ensure_hosted_grant_agent();
DROP INDEX swarm.hosted_mcp_seats_agent_live;
ALTER TABLE swarm.hosted_mcp_seats DROP CONSTRAINT hosted_mcp_seats_grant_id_principal_id_owner_user_id_fkey;
ALTER TABLE swarm.hosted_mcp_seats DROP CONSTRAINT hosted_mcp_seats_principal_id_workspace_id_owner_user_id_fkey;
ALTER TABLE swarm.hosted_mcp_seats ADD UNIQUE(principal_id);
ALTER TABLE swarm.hosted_mcp_seats ADD FOREIGN KEY(grant_id,workspace_id,owner_user_id) REFERENCES swarm.hosted_mcp_grant_workspaces(grant_id,workspace_id,owner_user_id);
ALTER TABLE swarm.hosted_mcp_seats ADD FOREIGN KEY(principal_id,workspace_id,owner_user_id) REFERENCES swarm.agent_principals(principal_id,workspace_id,owner_user_id);

DO $ddl$ DECLARE c record; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='swarm.household_hosted_content_restrictions'::regclass
 AND contype='f' AND confrelid IN ('swarm.hosted_mcp_grant_agents'::regclass,'swarm.agent_workspace_memberships'::regclass) LOOP
 EXECUTE format('ALTER TABLE swarm.household_hosted_content_restrictions DROP CONSTRAINT %I',c.conname);
 END LOOP;
END $ddl$;
ALTER TABLE swarm.household_hosted_content_restrictions ADD FOREIGN KEY(grant_id,workspace_id,owner_user_id) REFERENCES swarm.hosted_mcp_grant_workspaces(grant_id,workspace_id,owner_user_id);
ALTER TABLE swarm.household_hosted_content_restrictions ADD FOREIGN KEY(principal_id,workspace_id,owner_user_id) REFERENCES swarm.agent_principals(principal_id,workspace_id,owner_user_id);
DROP FUNCTION swarm.revoke_hosted_seat_membership(uuid,uuid,uuid);
DROP FUNCTION swarm.remove_hosted_agents_for_member(uuid,uuid,uuid);
DROP FUNCTION swarm.change_hosted_agent_membership(uuid,uuid,uuid,boolean);
DROP FUNCTION swarm.hosted_agent_membership_allowed(uuid,uuid,uuid,boolean);
DROP FUNCTION swarm.bind_hosted_agent(uuid,uuid);
DROP FUNCTION swarm.hosted_grant_workspace_ids(uuid);
DROP FUNCTION swarm.hosted_binding_eligible(uuid,uuid,uuid);
DROP TABLE swarm.hosted_mcp_agent_workspace_adds;
DROP TABLE swarm.hosted_mcp_grant_agents;
