DO $check$ BEGIN
 IF (SELECT count(*) FROM swarm.organizations) <> (SELECT count(*) FROM swarm.workspaces)
 OR EXISTS(SELECT 1 FROM swarm.workspaces w LEFT JOIN swarm.organizations o ON o.id=w.workspace_id
   WHERE w.org_id IS DISTINCT FROM w.workspace_id OR o.display_name IS DISTINCT FROM w.name)
 OR (SELECT count(*) FROM swarm.org_memberships) <> (SELECT count(*) FROM swarm.memberships)
 OR NOT EXISTS(SELECT 1 FROM swarm.org_memberships WHERE principal_id='00000000-0000-4000-8000-000000000002' AND revoked_at IS NOT NULL)
 THEN RAISE EXCEPTION 'backfill must create exactly one org per workspace and preserve memberships'; END IF;
END $check$;
-- Legacy command writers need no org column or new privileges.
SET LOCAL ROLE swarm_command;
INSERT INTO swarm.workspaces(workspace_id,name,created_by) VALUES
 ('10000000-0000-4000-8000-000000000003','New workspace','00000000-0000-4000-8000-000000000001');
INSERT INTO swarm.memberships(workspace_id,user_id,role) VALUES
 ('10000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001','owner');
UPDATE swarm.memberships SET role='admin', revoked_at=statement_timestamp()
 WHERE workspace_id='10000000-0000-4000-8000-000000000003';
RESET ROLE;
DO $check$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM swarm.workspaces w JOIN swarm.organizations o ON o.id=w.org_id
 WHERE w.workspace_id='10000000-0000-4000-8000-000000000003' AND o.id=w.workspace_id AND o.display_name=w.name)
 OR NOT EXISTS(SELECT 1 FROM swarm.org_memberships WHERE org_id='10000000-0000-4000-8000-000000000003' AND role='admin' AND revoked_at IS NOT NULL)
 THEN RAISE EXCEPTION 'legacy insert/update must maintain organization'; END IF;
END $check$;
SET LOCAL ROLE swarm_command;
UPDATE swarm.memberships SET revoked_at=NULL WHERE workspace_id='10000000-0000-4000-8000-000000000003';
RESET ROLE;
DO $check$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM swarm.org_memberships WHERE org_id='10000000-0000-4000-8000-000000000003' AND revoked_at IS NULL)
 THEN RAISE EXCEPTION 'rejoining must restore org membership'; END IF;
END $check$;
-- An org owner without workspace membership cannot see that workspace.
INSERT INTO swarm.org_memberships(org_id,principal_kind,principal_id,role) VALUES
 ('10000000-0000-4000-8000-000000000002','user','00000000-0000-4000-8000-000000000001','owner');
SELECT set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
SET LOCAL ROLE authenticated;
DO $check$ BEGIN
 IF (SELECT count(*) FROM swarm_read.workspaces)<>2
 OR EXISTS(SELECT 1 FROM swarm_read.workspaces WHERE workspace_id='10000000-0000-4000-8000-000000000002')
 OR NOT EXISTS(SELECT 1 FROM swarm_read.workspaces WHERE org_id='10000000-0000-4000-8000-000000000001' AND org_display_name='Same name')
 THEN RAISE EXCEPTION 'organization read must follow workspace membership'; END IF;
 BEGIN PERFORM * FROM swarm.organizations; RAISE EXCEPTION 'raw organizations exposed';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM * FROM swarm.org_memberships; RAISE EXCEPTION 'raw memberships exposed';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $check$;
RESET ROLE;
DELETE FROM swarm.org_memberships WHERE org_id='10000000-0000-4000-8000-000000000002';
DELETE FROM swarm.memberships WHERE workspace_id='10000000-0000-4000-8000-000000000003';
DO $check$ BEGIN
 IF EXISTS(SELECT 1 FROM swarm.org_memberships WHERE org_id='10000000-0000-4000-8000-000000000003')
 THEN RAISE EXCEPTION 'legacy deletion must remove org membership'; END IF;
END $check$;
