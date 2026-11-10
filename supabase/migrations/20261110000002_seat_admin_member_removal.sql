-- Seat admin 2b-2: an agent removes a workspace member under its owner's grant, and every collateral row says so.
-- The edge decides the grant under lock (one covering grant, re-decided after every wait); these checks are the
-- database's own floor: a delegated agent is accepted only while it is live, owned by the authorizing owner, a
-- member of the workspace, and holding an active, unexpired seat admin grant from that owner.
--
-- * revocation_tombstones gains created_by_agent_principal: created_by stays the authorizing person, the agent is
--   recorded beside it, never in place of it.
-- * remove_hosted_agents_for_member gains a p_agent argument; the three-argument form keeps its behaviour.
-- * audit_household_permission reads cswarm.household_agent_principal (remove_member only): the owner is still the
--   checked actor, the agent acts at an Admin's level (it cannot revoke an owner) and is written to actor_principal.
-- Local agent removal (remove_local_agents_for_member) records no actor and is unchanged.

ALTER TABLE swarm.revocation_tombstones ADD COLUMN created_by_agent_principal uuid;

CREATE FUNCTION swarm.seat_admin_delegation_live(p_agent uuid, p_owner uuid, p_workspace uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM swarm.agent_principals p
   JOIN swarm.agent_workspace_memberships am ON am.principal_id = p.principal_id AND am.workspace_id = p_workspace AND am.revoked_at IS NULL
   WHERE p.principal_id = p_agent AND p.owner_user_id = p_owner AND p.revoked_at IS NULL
     AND EXISTS(SELECT 1 FROM swarm.seat_admin_grants g WHERE g.principal_id = p_agent AND g.owner_user_id = p_owner
       AND g.state = 'active' AND (g.expires_at IS NULL OR g.expires_at > clock_timestamp())))
$$;
ALTER FUNCTION swarm.seat_admin_delegation_live(uuid, uuid, uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.seat_admin_delegation_live(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, swarm_read;
GRANT EXECUTE ON FUNCTION swarm.seat_admin_delegation_live(uuid, uuid, uuid) TO swarm_command;

CREATE FUNCTION swarm.remove_hosted_agents_for_member(p_workspace uuid,p_owner uuid,p_actor uuid,p_agent uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF p_agent IS NOT NULL AND NOT swarm.seat_admin_delegation_live(p_agent,p_actor,p_workspace) THEN
  RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='delegated member removal refused';
 END IF;
 UPDATE swarm.agent_workspace_memberships am SET revoked_at=coalesce(am.revoked_at,clock_timestamp())
  WHERE am.workspace_id=p_workspace AND am.owner_user_id=p_owner
  AND EXISTS(SELECT 1 FROM swarm.agent_principals p WHERE p.principal_id=am.principal_id AND p.transport='hosted_mcp');
 UPDATE swarm.hosted_mcp_agent_workspace_adds SET revoked_at=coalesce(revoked_at,clock_timestamp())
  WHERE workspace_id=p_workspace AND owner_user_id=p_owner;
 UPDATE swarm.hosted_mcp_grant_workspaces SET revoked_at=coalesce(revoked_at,clock_timestamp())
  WHERE workspace_id=p_workspace AND owner_user_id=p_owner;
 UPDATE swarm.hosted_mcp_seats SET revoked_at=coalesce(revoked_at,clock_timestamp())
  WHERE workspace_id=p_workspace AND owner_user_id=p_owner;
 UPDATE swarm.hosted_mcp_seat_handles h SET revoked_at=coalesce(h.revoked_at,clock_timestamp())
  FROM swarm.hosted_mcp_seats s WHERE h.seat_id=s.seat_id AND s.workspace_id=p_workspace AND s.owner_user_id=p_owner;
 INSERT INTO swarm.revocation_tombstones(kind,target_id,created_by,created_by_agent_principal)
  SELECT 'hosted_seat',seat_id,p_actor,p_agent FROM swarm.hosted_mcp_seats WHERE workspace_id=p_workspace AND owner_user_id=p_owner
  ON CONFLICT DO NOTHING;
 UPDATE swarm.household_content_connections SET revoked_at=coalesce(revoked_at,clock_timestamp())
  WHERE workspace_id=p_workspace AND owner_user_id=p_owner AND hosted_grant_id IS NOT NULL;
END $$;
ALTER FUNCTION swarm.remove_hosted_agents_for_member(uuid,uuid,uuid,uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.remove_hosted_agents_for_member(uuid,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,swarm_read,swarm_command;
GRANT EXECUTE ON FUNCTION swarm.remove_hosted_agents_for_member(uuid,uuid,uuid,uuid) TO swarm_command;

-- The person-only form: unchanged behaviour, one body.
CREATE OR REPLACE FUNCTION swarm.remove_hosted_agents_for_member(p_workspace uuid,p_owner uuid,p_actor uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM swarm.remove_hosted_agents_for_member(p_workspace,p_owner,p_actor,NULL::uuid);
END $$;

-- Replace in place to preserve the existing owner, ACL and triggers.
CREATE OR REPLACE FUNCTION swarm.audit_household_permission() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog AS $$
DECLARE
 actor uuid;
 request_id text;
 digest text;
 member_role text;
 command_kind text;
 target uuid;
 target_role text;
 agent uuid;
BEGIN
 -- Privileged fixture/operator writes remain subject to the normal release policy.
 IF current_user <> 'swarm_command' THEN RETURN NEW; END IF;
 actor := nullif(current_setting('cswarm.household_actor',true),'')::uuid;
 request_id := nullif(current_setting('cswarm.household_request',true),'');
 digest := nullif(current_setting('cswarm.household_digest',true),'');
 IF actor IS NULL OR request_id IS NULL OR digest IS NULL OR digest !~ '^[0-9a-f]{64}$' THEN
  RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='household confirmation context required';
 END IF;
 command_kind := coalesce(nullif(current_setting('cswarm.household_command',true),''),'household_permissions');
 -- Seat admin (2b-2): an agent removing a member under its owner's grant. The actor stays the authorizing owner,
 -- checked as before; the agent is recorded beside it and acts at an Admin's level, never the owner's.
 agent := nullif(current_setting('cswarm.household_agent_principal',true),'')::uuid;
 IF agent IS NOT NULL AND (command_kind <> 'remove_member' OR NOT swarm.seat_admin_delegation_live(agent, actor, NEW.workspace_id)) THEN
  RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='household delegated actor refused';
 END IF;
 IF command_kind NOT IN ('household_permissions','household_approve_connection','household_withdraw_connection','remove_member') THEN
  RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='household command kind refused';
 END IF;
 SELECT m.role INTO member_role FROM swarm.memberships m JOIN swarm.workspaces w USING(workspace_id)
 WHERE m.workspace_id=NEW.workspace_id AND m.user_id=actor AND m.revoked_at IS NULL AND w.archived_at IS NULL;
 IF member_role IS NULL THEN RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='household membership required'; END IF;
 IF agent IS NOT NULL THEN
  IF member_role <> 'owner' THEN RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='household delegated actor refused'; END IF;
  member_role := 'admin';
 END IF;
 IF command_kind='remove_member' THEN
  IF TG_OP<>'UPDATE' OR TG_TABLE_NAME NOT IN ('household_member_content_roles','household_content_connections') THEN
   RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='member removal may only revoke content';
  END IF;
  IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL
   OR (to_jsonb(NEW)-'revoked_at') IS DISTINCT FROM (to_jsonb(OLD)-'revoked_at') THEN
   RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='member removal may only stamp revoked content';
  END IF;
  IF member_role NOT IN ('owner','admin') THEN
   RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='member removal requires owner or admin';
  END IF;
  IF TG_TABLE_NAME='household_member_content_roles' THEN
   target := NEW.user_id;
  ELSE
   target := NEW.owner_user_id;
  END IF;
  SELECT m.role INTO target_role FROM swarm.memberships m
   WHERE m.workspace_id=NEW.workspace_id AND m.user_id=target;
  IF target_role IS NULL THEN
   RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='member removal target is not in this workspace';
  END IF;
  IF member_role='admin' AND target_role='owner' THEN
   RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='member removal cannot revoke an owner';
  END IF;
 ELSIF command_kind='household_withdraw_connection' THEN
  IF TG_TABLE_NAME<>'household_content_connections' OR TG_OP<>'UPDATE' THEN
   RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='household withdrawal may only update connections';
  END IF;
  IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL OR NEW.owner_user_id<>actor
   OR (to_jsonb(NEW)-'revoked_at') IS DISTINCT FROM (to_jsonb(OLD)-'revoked_at') THEN
   RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='household withdrawal may only revoke owned connections';
  END IF;
 ELSIF command_kind='household_approve_connection' AND (TG_TABLE_NAME<>'household_content_connections' OR TG_OP NOT IN ('INSERT','UPDATE')) THEN
  RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='household approval may only write connections';
 ELSIF TG_TABLE_NAME='household_workspace_boundaries' THEN
  IF TG_OP<>'INSERT' OR member_role<>'owner' OR (NEW.purpose='personal' AND NEW.owner_user_id<>actor) THEN
   RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='household owner confirmation required';
  END IF;
 ELSIF TG_TABLE_NAME='household_member_content_roles' THEN
  IF NEW.user_id<>actor OR NOT EXISTS (SELECT 1 FROM swarm.household_workspace_boundaries b
   WHERE b.workspace_id=NEW.workspace_id AND (b.purpose='shared' OR b.owner_user_id=actor)) THEN
   RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='household independent confirmation required';
  END IF;
 ELSE
  IF NEW.owner_user_id<>actor OR NOT EXISTS (SELECT 1 FROM swarm.household_member_content_roles r
    JOIN swarm.household_workspace_boundaries b USING(workspace_id)
    WHERE r.workspace_id=NEW.workspace_id AND r.user_id=actor AND r.revoked_at IS NULL
     AND r.content_consent_id=NEW.consent_receipt_id AND b.purpose=NEW.purpose
     AND (b.purpose='shared' OR b.owner_user_id=actor)
     AND (r.content_role='editor' OR NEW.operations=ARRAY['read']::text[])) THEN
   RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='household connection consent required';
  END IF;
 END IF;
 INSERT INTO swarm.household_object_audit(audit_id,workspace_id,command_id,actor_user,actor_principal,occurred_at,command_kind,request_digest,outcome,reason_code)
 VALUES(gen_random_uuid(),NEW.workspace_id,request_id,actor,agent,clock_timestamp(),command_kind,digest,'committed',TG_TABLE_NAME);
 RETURN NEW;
END;
$$;
