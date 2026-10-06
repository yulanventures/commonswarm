-- Removing a member revokes that person's Lists & docs role and connections.
-- Replace in place to preserve the existing owner, ACL and all three triggers.
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
 IF command_kind NOT IN ('household_permissions','household_approve_connection','household_withdraw_connection','remove_member') THEN
  RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='household command kind refused';
 END IF;
 SELECT m.role INTO member_role FROM swarm.memberships m JOIN swarm.workspaces w USING(workspace_id)
 WHERE m.workspace_id=NEW.workspace_id AND m.user_id=actor AND m.revoked_at IS NULL AND w.archived_at IS NULL;
 IF member_role IS NULL THEN RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='household membership required'; END IF;
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
 VALUES(gen_random_uuid(),NEW.workspace_id,request_id,actor,NULL,clock_timestamp(),command_kind,digest,'committed',TG_TABLE_NAME);
 RETURN NEW;
END;
$$;

-- One-time repair for removals made before the content revocation path existed.
-- Run as the privileged migration operator, never as swarm_command. The original
-- removing actor/request is unknown. household_object_audit.actor_user is NOT NULL
-- and denotes a human actor, so no system audit can be written without inventing
-- attribution. Preserve existing audit/history rows and consent identifiers.
-- revoked_at records the membership removal time, not this repair's execution.
-- Only invitations already created by removal time are repaired; later re-invites
-- remain pending. No InvitationRevoked events are synthesized for this SQL repair.
DO $household_member_removal_backfill$
DECLARE
 pending_at timestamptz := statement_timestamp();
BEGIN
 -- Take every workspace lock first, then memberships, then content, then invites.
 -- Each class has a total key order; no UPDATE can acquire a row out of order.
 PERFORM w.workspace_id FROM swarm.workspaces w
 WHERE EXISTS (SELECT 1 FROM swarm.memberships m
  WHERE m.workspace_id=w.workspace_id AND m.revoked_at IS NOT NULL)
 ORDER BY w.workspace_id FOR UPDATE OF w;

 PERFORM m.workspace_id, m.user_id FROM swarm.memberships m
 WHERE m.revoked_at IS NOT NULL
 ORDER BY m.workspace_id, m.user_id FOR UPDATE OF m;

 PERFORM r.workspace_id, r.user_id FROM swarm.household_member_content_roles r
 JOIN swarm.memberships m ON m.workspace_id=r.workspace_id AND m.user_id=r.user_id
 WHERE m.revoked_at IS NOT NULL AND r.revoked_at IS NULL
 ORDER BY r.workspace_id, r.user_id FOR UPDATE OF r;

 PERFORM c.connection_id FROM swarm.household_content_connections c
 JOIN swarm.memberships m ON m.workspace_id=c.workspace_id AND m.user_id=c.owner_user_id
 WHERE m.revoked_at IS NOT NULL AND c.revoked_at IS NULL
 ORDER BY c.workspace_id, c.connection_id, c.grant_id, c.principal_id FOR UPDATE OF c;

 -- The live helper revokes all unaccepted delegated invitations, even expired ones.
 PERFORM i.invitation_id FROM swarm.admin_routine_invitations i
 JOIN swarm.memberships m ON m.workspace_id=i.workspace_id AND m.user_id=i.recipient_user_id
 WHERE m.revoked_at IS NOT NULL AND i.accepted_at IS NULL AND i.revoked_at IS NULL
  AND i.created_at<=m.revoked_at
 ORDER BY i.workspace_id, i.invitation_id FOR UPDATE OF i;

 -- Link recipients use the same case-insensitive stored email match as the helper.
 -- Only still-pending links need repair; expired/consumed/revoked links stay intact.
 PERFORM i.invitation_id FROM swarm.invitations i
 JOIN swarm.users u ON i.email IS NOT NULL AND lower(i.email)=lower(u.email)
 JOIN swarm.memberships m ON m.workspace_id=i.workspace_id AND m.user_id=u.user_id
 WHERE m.revoked_at IS NOT NULL AND i.consumed_at IS NULL AND i.revoked_at IS NULL
  AND i.created_at<=m.revoked_at AND i.expires_at>pending_at
 ORDER BY i.workspace_id, i.invitation_id FOR UPDATE OF i;

 UPDATE swarm.household_member_content_roles r SET revoked_at=m.revoked_at
 FROM swarm.memberships m
 WHERE m.workspace_id=r.workspace_id AND m.user_id=r.user_id
  AND m.revoked_at IS NOT NULL AND r.revoked_at IS NULL;

 -- Deliberately includes expired connections, as does live member removal.
 UPDATE swarm.household_content_connections c SET revoked_at=m.revoked_at
 FROM swarm.memberships m
 WHERE m.workspace_id=c.workspace_id AND m.user_id=c.owner_user_id
  AND m.revoked_at IS NOT NULL AND c.revoked_at IS NULL;

 UPDATE swarm.admin_routine_invitations i SET revoked_at=m.revoked_at
 FROM swarm.memberships m
 WHERE m.workspace_id=i.workspace_id AND m.user_id=i.recipient_user_id
  AND m.revoked_at IS NOT NULL AND i.accepted_at IS NULL AND i.revoked_at IS NULL
  AND i.created_at<=m.revoked_at;

 UPDATE swarm.invitations i SET revoked_at=m.revoked_at
 FROM swarm.memberships m JOIN swarm.users u ON u.user_id=m.user_id
 WHERE m.workspace_id=i.workspace_id AND i.email IS NOT NULL AND lower(i.email)=lower(u.email)
  AND m.revoked_at IS NOT NULL AND i.consumed_at IS NULL AND i.revoked_at IS NULL
  AND i.created_at<=m.revoked_at AND i.expires_at>pending_at;
END;
$household_member_removal_backfill$;
