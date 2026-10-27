-- Run after the real phase-1 fixture and phase-2 migration, in a rollback unit.
-- Org owner survives workspace demotion/revocation/deletion.
UPDATE swarm.memberships SET role='member',revoked_at=clock_timestamp()
 WHERE workspace_id='10000000-0000-4000-8000-000000000001' AND user_id='00000000-0000-4000-8000-000000000001';
DO $check$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM swarm.org_memberships WHERE org_id='10000000-0000-4000-8000-000000000001'
   AND principal_id='00000000-0000-4000-8000-000000000001' AND role='owner' AND revoked_at IS NULL)
 THEN RAISE EXCEPTION 'workspace revocation demoted durable org owner'; END IF;
END $check$;
UPDATE swarm.memberships SET role='owner',revoked_at=NULL
 WHERE workspace_id='10000000-0000-4000-8000-000000000001' AND user_id='00000000-0000-4000-8000-000000000001';
-- Phase-1 generated org B has no members yet. Seed its owner as an independent org role.
INSERT INTO swarm.org_memberships(org_id,principal_kind,principal_id,role) VALUES
 ('10000000-0000-4000-8000-000000000002','user','00000000-0000-4000-8000-000000000001','owner');
-- Real command role: a member can create in an org, guests/revoked/strangers cannot.
SET LOCAL ROLE swarm_command;
DO $check$ BEGIN
 IF NOT swarm.org_allows_workspace_create('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001')
 OR swarm.org_allows_workspace_create('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002')
 THEN RAISE EXCEPTION 'org create admission'; END IF;
END $check$;
INSERT INTO swarm.workspaces(workspace_id,name,created_by,org_id) VALUES
 ('10000000-0000-4000-8000-000000000003','Sibling','00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001');
INSERT INTO swarm.memberships(workspace_id,user_id,role) VALUES
 ('10000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001','owner'),
 ('10000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000002','owner');
RESET ROLE;
DO $check$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM swarm.org_memberships WHERE org_id='10000000-0000-4000-8000-000000000001'
   AND principal_id='00000000-0000-4000-8000-000000000002' AND role='member' AND revoked_at IS NULL)
 THEN RAISE EXCEPTION 'workspace ownership promoted org role'; END IF;
END $check$;
UPDATE swarm.memberships SET revoked_at=NULL WHERE workspace_id='10000000-0000-4000-8000-000000000001'
 AND user_id='00000000-0000-4000-8000-000000000002';
DELETE FROM swarm.memberships WHERE workspace_id='10000000-0000-4000-8000-000000000003'
 AND user_id='00000000-0000-4000-8000-000000000002';
DO $check$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM swarm.org_memberships WHERE org_id='10000000-0000-4000-8000-000000000001'
   AND principal_id='00000000-0000-4000-8000-000000000002' AND role='member' AND revoked_at IS NULL)
 THEN RAISE EXCEPTION 'sibling lost org membership'; END IF;
END $check$;
-- Preserve explicit admin role on workspace role churn.
UPDATE swarm.org_memberships SET role='admin' WHERE org_id='10000000-0000-4000-8000-000000000001'
 AND principal_id='00000000-0000-4000-8000-000000000002';
UPDATE swarm.memberships SET role='member' WHERE workspace_id='10000000-0000-4000-8000-000000000001'
 AND user_id='00000000-0000-4000-8000-000000000002';
DO $check$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM swarm.org_memberships WHERE org_id='10000000-0000-4000-8000-000000000001'
   AND principal_id='00000000-0000-4000-8000-000000000002' AND role='admin')
 THEN RAISE EXCEPTION 'workspace role demoted org admin'; END IF;
END $check$;
-- Admission checks are live and do not treat org authority as workspace access.
UPDATE swarm.org_memberships SET role='guest' WHERE org_id='10000000-0000-4000-8000-000000000001'
 AND principal_id='00000000-0000-4000-8000-000000000002';
DO $check$ BEGIN
 IF swarm.org_allows_workspace_create('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002')
 THEN RAISE EXCEPTION 'guest can create'; END IF;
END $check$;
UPDATE swarm.org_memberships SET role='member' WHERE org_id='10000000-0000-4000-8000-000000000001'
 AND principal_id='00000000-0000-4000-8000-000000000002';
DO $check$ BEGIN
 IF NOT swarm.org_allows_workspace_create('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002')
 THEN RAISE EXCEPTION 'member cannot create'; END IF;
END $check$;
-- Negative move controls reach each required permission independently.
UPDATE swarm.org_memberships SET role='admin' WHERE org_id='10000000-0000-4000-8000-000000000001'
 AND principal_id='00000000-0000-4000-8000-000000000002';
INSERT INTO swarm.org_memberships(org_id,principal_kind,principal_id,role) VALUES
 ('10000000-0000-4000-8000-000000000002','user','00000000-0000-4000-8000-000000000002','admin');
DO $check$ BEGIN
 IF swarm.move_workspace_to_org('10000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000002',
   '00000000-0000-4000-8000-000000000002') IS NOT NULL THEN RAISE EXCEPTION 'non-workspace owner moved'; END IF;
END $check$;
UPDATE swarm.org_memberships SET role='member' WHERE principal_id='00000000-0000-4000-8000-000000000002';
DELETE FROM swarm.org_memberships WHERE org_id='10000000-0000-4000-8000-000000000002'
 AND principal_id='00000000-0000-4000-8000-000000000002';
UPDATE swarm.org_memberships SET role='member' WHERE org_id='10000000-0000-4000-8000-000000000002';
DO $check$ BEGIN
 IF swarm.move_workspace_to_org('10000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000002',
   '00000000-0000-4000-8000-000000000001') IS NOT NULL THEN RAISE EXCEPTION 'missing destination authority moved'; END IF;
END $check$;
UPDATE swarm.org_memberships SET role='owner' WHERE org_id='10000000-0000-4000-8000-000000000002';
UPDATE swarm.org_memberships SET revoked_at=clock_timestamp() WHERE org_id='10000000-0000-4000-8000-000000000001'
 AND principal_id='00000000-0000-4000-8000-000000000001';
DO $check$ BEGIN
 IF swarm.move_workspace_to_org('10000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000002',
   '00000000-0000-4000-8000-000000000001') IS NOT NULL THEN RAISE EXCEPTION 'revoked source authority moved'; END IF;
END $check$;
UPDATE swarm.org_memberships SET revoked_at=NULL WHERE org_id='10000000-0000-4000-8000-000000000001'
 AND principal_id='00000000-0000-4000-8000-000000000001';
UPDATE swarm.organizations SET archived_at=clock_timestamp() WHERE id='10000000-0000-4000-8000-000000000002';
DO $check$ BEGIN
 IF swarm.move_workspace_to_org('10000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000002',
   '00000000-0000-4000-8000-000000000001') IS NOT NULL THEN RAISE EXCEPTION 'archived destination admitted'; END IF;
END $check$;
UPDATE swarm.organizations SET archived_at=NULL WHERE id='10000000-0000-4000-8000-000000000002';
CREATE TEMP TABLE org2_members_before AS SELECT * FROM swarm.memberships;
CREATE TEMP TABLE org2_workspaces_before AS SELECT workspace_id,to_jsonb(w)-'org_id' AS body FROM swarm.workspaces w;
SET LOCAL ROLE swarm_command;
DO $check$ BEGIN
 IF swarm.move_workspace_to_org('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002',
   '00000000-0000-4000-8000-000000000001') IS NULL THEN RAISE EXCEPTION 'authorized move failed'; END IF;
END $check$;
RESET ROLE;
DO $check$ BEGIN
 IF EXISTS((TABLE swarm.memberships EXCEPT TABLE org2_members_before) UNION ALL (TABLE org2_members_before EXCEPT TABLE swarm.memberships))
 THEN RAISE EXCEPTION 'move changed workspace members'; END IF;
 IF EXISTS(SELECT 1 FROM org2_workspaces_before b JOIN swarm.workspaces w USING(workspace_id)
   WHERE to_jsonb(w)-'org_id' IS DISTINCT FROM b.body)
 THEN RAISE EXCEPTION 'move changed other workspace columns'; END IF;
 IF NOT EXISTS(SELECT 1 FROM swarm.workspaces WHERE workspace_id='10000000-0000-4000-8000-000000000001'
   AND org_id='10000000-0000-4000-8000-000000000002' AND name='Same name')
 OR NOT EXISTS(SELECT 1 FROM swarm.org_memberships WHERE org_id='10000000-0000-4000-8000-000000000002'
   AND principal_id='00000000-0000-4000-8000-000000000002' AND role='member')
 OR EXISTS(SELECT 1 FROM swarm.organizations WHERE id='10000000-0000-4000-8000-000000000001' AND archived_at IS NOT NULL)
 THEN RAISE EXCEPTION 'move metadata/reconciliation or prematurely archived source'; END IF;
END $check$;
SELECT swarm.move_workspace_to_org('10000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001');
DO $check$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM swarm.organizations WHERE id='10000000-0000-4000-8000-000000000001' AND archived_at IS NOT NULL)
 THEN RAISE EXCEPTION 'empty generated source not archived'; END IF;
 IF swarm.move_workspace_to_org('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002',
   '00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001') IS NULL
 THEN RAISE EXCEPTION 'archived source blocks authorized replay'; END IF;
END $check$;
-- Legacy clients still get a new org and founding owner.
INSERT INTO swarm.workspaces(workspace_id,name,created_by) VALUES
 ('10000000-0000-4000-8000-000000000004','Legacy','00000000-0000-4000-8000-000000000001');
DO $check$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM swarm.organizations WHERE id='10000000-0000-4000-8000-000000000004' AND generated)
 OR NOT EXISTS(SELECT 1 FROM swarm.org_memberships WHERE org_id='10000000-0000-4000-8000-000000000004'
   AND principal_id='00000000-0000-4000-8000-000000000001' AND role='owner')
 THEN RAISE EXCEPTION 'legacy creation lost generated org ownership'; END IF;
END $check$;
SELECT set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
SET LOCAL ROLE authenticated;
DO $check$ BEGIN
 IF EXISTS(SELECT 1 FROM swarm_read.workspaces WHERE workspace_id='10000000-0000-4000-8000-000000000002')
 THEN RAISE EXCEPTION 'org ownership granted workspace access'; END IF;
 IF EXISTS(SELECT 1 FROM swarm_read.organizations WHERE id='10000000-0000-4000-8000-000000000001')
 THEN RAISE EXCEPTION 'archived organization visible'; END IF;
 BEGIN PERFORM swarm.move_workspace_to_org('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002',
   '00000000-0000-4000-8000-000000000001'); RAISE EXCEPTION 'direct move exposed';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $check$;
RESET ROLE;

-- Organizations not generated for a workspace remain after their last move.
UPDATE swarm.organizations SET generated=false WHERE id='10000000-0000-4000-8000-000000000004';
INSERT INTO swarm.memberships(workspace_id,user_id,role) VALUES
 ('10000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000001','owner');
SELECT swarm.move_workspace_to_org('10000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001');
DO $check$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM swarm.organizations WHERE id='10000000-0000-4000-8000-000000000004' AND archived_at IS NULL)
 THEN RAISE EXCEPTION 'independent organization archived'; END IF;
END $check$;
