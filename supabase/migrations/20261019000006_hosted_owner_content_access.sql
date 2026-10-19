-- A rollback compatibility gate is removed ONLY by the reviewed operator
-- roll-forward packet, after the new source is active. Never rewind a ledger.
-- No backfill: old approvals do not establish why a person or system restricted
-- access. Runtime conservatively retains their ceilings until explicit reallow.
-- Rows retain exact canonical human/system targets. Runtime intersects every
-- target in the grant/workspace partition, so changing seat/name cannot escape.
CREATE TABLE IF NOT EXISTS swarm.household_hosted_content_restrictions (
 grant_id uuid NOT NULL,
 workspace_id uuid NOT NULL,
 owner_user_id uuid NOT NULL,
 principal_id uuid NOT NULL,
 operations text[] NOT NULL CHECK (cardinality(operations) BETWEEN 0 AND 3
   AND operations <@ ARRAY['read','create','update']::text[]),
 origin text NOT NULL CHECK (origin IN ('human_allow','human_withdraw','system_invalidation')),
 changed_by uuid NOT NULL DEFAULT nullif(current_setting('cswarm.household_actor',true),'')::uuid,
 changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(grant_id,workspace_id,principal_id),
 FOREIGN KEY(grant_id,workspace_id,owner_user_id)
   REFERENCES swarm.hosted_mcp_grant_workspaces(grant_id,workspace_id,owner_user_id),
 FOREIGN KEY(principal_id,workspace_id,owner_user_id)
   REFERENCES swarm.agent_principals(principal_id,workspace_id,owner_user_id),
 CHECK ((origin='human_allow' AND 'read'=ANY(operations))
   OR (origin<>'human_allow' AND cardinality(operations)=0))
);
ALTER TABLE swarm.household_hosted_content_restrictions OWNER TO swarm_admin;
ALTER TABLE swarm.household_hosted_content_restrictions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS swarm_command_all ON swarm.household_hosted_content_restrictions;
CREATE POLICY swarm_command_all ON swarm.household_hosted_content_restrictions
 FOR ALL TO swarm_command USING(true) WITH CHECK(true);
REVOKE ALL ON swarm.household_hosted_content_restrictions FROM PUBLIC,anon,authenticated,swarm_read,swarm_command;
GRANT SELECT,INSERT ON swarm.household_hosted_content_restrictions TO swarm_command;
GRANT UPDATE(operations,origin) ON swarm.household_hosted_content_restrictions TO swarm_command;

CREATE OR REPLACE FUNCTION swarm.audit_household_hosted_restriction() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE actor uuid; command_kind text; request_id text; digest text;
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
 NEW.changed_by := actor;
 NEW.changed_at := clock_timestamp();
 INSERT INTO swarm.household_object_audit(audit_id,workspace_id,command_id,actor_user,actor_principal,occurred_at,command_kind,request_digest,outcome,reason_code)
 VALUES(gen_random_uuid(),NEW.workspace_id,request_id,actor,NULL,NEW.changed_at,command_kind,digest,'committed',NEW.origin);
 RETURN NEW;
END $$;
ALTER FUNCTION swarm.audit_household_hosted_restriction() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.audit_household_hosted_restriction() FROM PUBLIC,anon,authenticated,swarm_read,swarm_command;
CREATE OR REPLACE TRIGGER household_hosted_restriction_audit BEFORE INSERT OR UPDATE
 ON swarm.household_hosted_content_restrictions FOR EACH ROW EXECUTE FUNCTION swarm.audit_household_hosted_restriction();
