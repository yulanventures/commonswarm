-- S2 runtime envelope. Call once per client transaction, before ANY family
-- lock or provider artifact lock. Binding insertion also takes the DCR row
-- first, in a separate transaction (never while holding workspace streams).
-- Commands holding one workspace stream must not enter this function.
CREATE FUNCTION commonswarm_oauth.lock_hosted_client_streams(p_client_id text)
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
ALTER FUNCTION commonswarm_oauth.lock_hosted_client_streams(text) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION commonswarm_oauth.lock_hosted_client_streams(text)
  FROM PUBLIC,anon,authenticated,swarm_read,swarm_command;
GRANT EXECUTE ON FUNCTION commonswarm_oauth.lock_hosted_client_streams(text)
  TO commonswarm_oauth_runtime;
