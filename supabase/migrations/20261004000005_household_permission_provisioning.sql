-- Explicit human content confirmation only. Existing memberships and grants gain no rights.
GRANT INSERT ON swarm.household_workspace_boundaries TO swarm_command;
GRANT INSERT ON swarm.household_member_content_roles TO swarm_command;
GRANT UPDATE (content_role, content_consent_id, confirmed_at, revoked_at) ON swarm.household_member_content_roles TO swarm_command;
GRANT INSERT ON swarm.household_content_connections TO swarm_command;
GRANT UPDATE (operations, consent_receipt_id, expires_at, revoked_at) ON swarm.household_content_connections TO swarm_command;

CREATE FUNCTION swarm.audit_household_permission() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog AS $$
DECLARE
 actor uuid;
 request_id text;
 digest text;
 member_role text;
BEGIN
 -- Privileged fixture/operator writes remain subject to the normal release policy.
 IF current_user <> 'swarm_command' THEN RETURN NEW; END IF;
 actor := nullif(current_setting('cswarm.household_actor',true),'')::uuid;
 request_id := nullif(current_setting('cswarm.household_request',true),'');
 digest := nullif(current_setting('cswarm.household_digest',true),'');
 IF actor IS NULL OR request_id IS NULL OR digest IS NULL OR digest !~ '^[0-9a-f]{64}$' THEN
  RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='household confirmation context required';
 END IF;
 SELECT m.role INTO member_role FROM swarm.memberships m JOIN swarm.workspaces w USING(workspace_id)
 WHERE m.workspace_id=NEW.workspace_id AND m.user_id=actor AND m.revoked_at IS NULL AND w.archived_at IS NULL;
 IF member_role IS NULL THEN RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='household membership required'; END IF;
 IF TG_TABLE_NAME='household_workspace_boundaries' THEN
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
 VALUES(gen_random_uuid(),NEW.workspace_id,request_id,actor,NULL,clock_timestamp(),'household_permissions',digest,'committed',TG_TABLE_NAME);
 RETURN NEW;
END;
$$;
ALTER FUNCTION swarm.audit_household_permission() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.audit_household_permission() FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
CREATE TRIGGER household_permission_audit BEFORE INSERT OR UPDATE ON swarm.household_workspace_boundaries
 FOR EACH ROW EXECUTE FUNCTION swarm.audit_household_permission();
CREATE TRIGGER household_permission_audit BEFORE INSERT OR UPDATE ON swarm.household_member_content_roles
 FOR EACH ROW EXECUTE FUNCTION swarm.audit_household_permission();
CREATE TRIGGER household_permission_audit BEFORE INSERT OR UPDATE ON swarm.household_content_connections
 FOR EACH ROW EXECUTE FUNCTION swarm.audit_household_permission();

-- Reserve rollback (verbatim in supabase/household-storage-reserve/ and
-- deploy/release-proofs/household-storage/; approved release procedure only):
-- -- Undo only integration grants and provisioning triggers; retain consent and audit rows.
-- DROP TRIGGER IF EXISTS household_permission_audit ON swarm.household_workspace_boundaries;
-- REVOKE INSERT ON swarm.household_workspace_boundaries FROM swarm_command;
-- DROP TRIGGER IF EXISTS household_permission_audit ON swarm.household_member_content_roles;
-- REVOKE INSERT ON swarm.household_member_content_roles FROM swarm_command;
-- REVOKE UPDATE (content_role, content_consent_id, confirmed_at, revoked_at) ON swarm.household_member_content_roles FROM swarm_command;
-- DROP TRIGGER IF EXISTS household_permission_audit ON swarm.household_content_connections;
-- REVOKE INSERT ON swarm.household_content_connections FROM swarm_command;
-- REVOKE UPDATE (operations, consent_receipt_id, expires_at, revoked_at) ON swarm.household_content_connections FROM swarm_command;
-- DROP FUNCTION IF EXISTS swarm.audit_household_permission();
