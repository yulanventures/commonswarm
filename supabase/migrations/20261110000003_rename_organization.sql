-- Organization display-name rename (seat admin 2d): an explicitly registered, audited command. Name only: never
-- the slug, id, archive state, memberships or workspaces. The caller passes the authorizing person: an organization
-- owner, or the grantor of a seat admin agent's organization grant (the edge decides that grant under lock).
-- Returns NULL when the organization is missing or archived, the person is not a live owner, or the name is invalid.
CREATE FUNCTION swarm.rename_organization(p_org uuid, p_owner uuid, p_name text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
 prior text;
BEGIN
 -- The workspace-name rule: 1..80 characters, no surrounding spaces, no control characters.
 IF p_name IS NULL OR p_name = '' OR char_length(p_name) > 80 OR p_name <> btrim(p_name, E' \t\n\r')
   OR p_name ~ '[[:cntrl:]]' THEN
  RETURN NULL;
 END IF;
 SELECT o.display_name INTO prior FROM swarm.organizations o WHERE o.id = p_org AND o.archived_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF NOT EXISTS (SELECT 1 FROM swarm.org_memberships m WHERE m.org_id = p_org AND m.principal_kind = 'user'
   AND m.principal_id = p_owner AND m.role = 'owner' AND m.revoked_at IS NULL) THEN
  RETURN NULL;
 END IF;
 UPDATE swarm.organizations SET display_name = p_name, updated_at = clock_timestamp() WHERE id = p_org;
 RETURN jsonb_build_object('org_id', p_org, 'previous_display_name', prior, 'display_name', p_name);
END;
$$;
ALTER FUNCTION swarm.rename_organization(uuid, uuid, text) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.rename_organization(uuid, uuid, text) FROM PUBLIC, anon, authenticated, swarm_read;
GRANT EXECUTE ON FUNCTION swarm.rename_organization(uuid, uuid, text) TO swarm_command;
