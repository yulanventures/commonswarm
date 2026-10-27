INSERT INTO auth.users(id,aud,role,email) VALUES
 ('02000000-0000-4000-8000-000000000001','authenticated','authenticated','agents-owner@example.test'),
 ('02000000-0000-4000-8000-000000000002','authenticated','authenticated','agents-other@example.test');
INSERT INTO swarm.users(user_id,display_name) VALUES
 ('02000000-0000-4000-8000-000000000001','Agent owner'),
 ('02000000-0000-4000-8000-000000000002','Other owner');
INSERT INTO swarm.workspaces(workspace_id,name,created_by) VALUES
 ('12000000-0000-4000-8000-000000000001','Agents workspace','02000000-0000-4000-8000-000000000001');
INSERT INTO swarm.memberships(workspace_id,user_id,role) VALUES
 ('12000000-0000-4000-8000-000000000001','02000000-0000-4000-8000-000000000001','owner'),
 ('12000000-0000-4000-8000-000000000001','02000000-0000-4000-8000-000000000002','member');
INSERT INTO swarm.agent_principals(principal_id,workspace_id,owner_user_id,name,model,transport,turn_only,revoked_at) VALUES
 ('22000000-0000-4000-8000-000000000001','12000000-0000-4000-8000-000000000001','02000000-0000-4000-8000-000000000001','Local agent','GPT','local',false,NULL),
 ('22000000-0000-4000-8000-000000000002','12000000-0000-4000-8000-000000000001','02000000-0000-4000-8000-000000000001','Removed agent',NULL,'hosted_mcp',true,'2026-10-01T00:00:00Z'),
 ('22000000-0000-4000-8000-000000000003','12000000-0000-4000-8000-000000000001','02000000-0000-4000-8000-000000000002','Other agent',NULL,'local',false,NULL),
 ('22000000-0000-4000-8000-000000000004','12000000-0000-4000-8000-000000000001','02000000-0000-4000-8000-000000000001','Registrar',NULL,'local',false,NULL);
INSERT INTO swarm.devices(device_id,user_id,label) VALUES
 ('32000000-0000-4000-8000-000000000001','02000000-0000-4000-8000-000000000001','Fixture');
INSERT INTO swarm.agent_runs(run_id,principal_id,device_id) VALUES
 ('42000000-0000-4000-8000-000000000001','22000000-0000-4000-8000-000000000004','32000000-0000-4000-8000-000000000001');
INSERT INTO swarm.agent_join_credentials(id,workspace_id,owner_user_id,registrar_principal_id,registrar_run_id,
 credential_hash,locator,seat_cap,expires_at,mint_command_id) VALUES
 ('52000000-0000-4000-8000-000000000001','12000000-0000-4000-8000-000000000001','02000000-0000-4000-8000-000000000001',
 '22000000-0000-4000-8000-000000000004','42000000-0000-4000-8000-000000000001',
 decode(repeat('42',32),'hex'),'accountAgentsFixture01',1,statement_timestamp()+interval '1 hour','accountAgentsFixture01');
