-- Existing seats before slice 4b, including a revoked identity. No name merging.
INSERT INTO auth.users(id,aud,role,email) VALUES
 ('03000000-0000-4000-8000-000000000001','authenticated','authenticated','hosted-owner@example.test'),
 ('03000000-0000-4000-8000-000000000002','authenticated','authenticated','hosted-peer@example.test');
INSERT INTO swarm.users(user_id,display_name) VALUES
 ('03000000-0000-4000-8000-000000000001','Hosted owner'),('03000000-0000-4000-8000-000000000002','Hosted peer');
INSERT INTO swarm.workspaces(workspace_id,name,created_by) VALUES
 ('13000000-0000-4000-8000-000000000001','Hosted A','03000000-0000-4000-8000-000000000001'),
 ('13000000-0000-4000-8000-000000000003','Other organization','03000000-0000-4000-8000-000000000001');
INSERT INTO swarm.workspaces(workspace_id,name,created_by,org_id) SELECT
 '13000000-0000-4000-8000-000000000002','Hosted B',created_by,org_id FROM swarm.workspaces WHERE workspace_id='13000000-0000-4000-8000-000000000001';
INSERT INTO swarm.memberships(workspace_id,user_id,role) VALUES
 ('13000000-0000-4000-8000-000000000001','03000000-0000-4000-8000-000000000001','owner'),
 ('13000000-0000-4000-8000-000000000002','03000000-0000-4000-8000-000000000001','owner'),
 ('13000000-0000-4000-8000-000000000003','03000000-0000-4000-8000-000000000001','owner'),
 ('13000000-0000-4000-8000-000000000002','03000000-0000-4000-8000-000000000002','member');
INSERT INTO swarm.streams(stream_id,workspace_id,kind) SELECT workspace_id,workspace_id,'workspace' FROM swarm.workspaces WHERE workspace_id::text LIKE '13000000-%';
INSERT INTO swarm.agent_principals(principal_id,workspace_id,owner_user_id,name,transport,turn_only,revoked_at) VALUES
 ('23000000-0000-4000-8000-000000000001','13000000-0000-4000-8000-000000000001','03000000-0000-4000-8000-000000000001','Reusable hosted','hosted_mcp',true,NULL),
 ('23000000-0000-4000-8000-000000000002','13000000-0000-4000-8000-000000000001','03000000-0000-4000-8000-000000000001','Old hosted','hosted_mcp',true,'2026-10-01');
INSERT INTO commonswarm_oauth.registered_clients(client_id,metadata,registered_at,expires_at)
 VALUES('hosted-workspace-fixture','{}',clock_timestamp(),NULL);
INSERT INTO swarm.hosted_mcp_grants(grant_id,provider_grant_id,owner_user_id,home_workspace_id,client_id,resource,selected_workspace_ids,manifest_digest,interaction_ref,state,created_at,activated_at)
 VALUES('33000000-0000-4000-8000-000000000001','hosted-workspace-family','03000000-0000-4000-8000-000000000001','13000000-0000-4000-8000-000000000001','hosted-workspace-fixture','https://mcp.commonswarm.com/mcp',ARRAY['13000000-0000-4000-8000-000000000001']::uuid[],decode(repeat('a4',32),'hex'),'hosted-workspace-interaction','active',clock_timestamp(),clock_timestamp());
INSERT INTO swarm.hosted_mcp_grant_workspaces(grant_id,workspace_id,owner_user_id,manifest_digest,consent_receipt_id,consented_at)
 VALUES('33000000-0000-4000-8000-000000000001','13000000-0000-4000-8000-000000000001','03000000-0000-4000-8000-000000000001',decode(repeat('a4',32),'hex'),'43000000-0000-4000-8000-000000000001','2026-10-01');
INSERT INTO swarm.hosted_mcp_seats(seat_id,grant_id,workspace_id,owner_user_id,principal_id,name,created_at,revoked_at)
 VALUES('53000000-0000-4000-8000-000000000001','33000000-0000-4000-8000-000000000001','13000000-0000-4000-8000-000000000001','03000000-0000-4000-8000-000000000001','23000000-0000-4000-8000-000000000001','Reusable hosted','2026-10-01',NULL),
 ('53000000-0000-4000-8000-000000000002','33000000-0000-4000-8000-000000000001','13000000-0000-4000-8000-000000000001','03000000-0000-4000-8000-000000000001','23000000-0000-4000-8000-000000000002','Old hosted','2026-10-01','2026-10-01');
INSERT INTO swarm.hosted_mcp_seat_handles(handle,seat_id,grant_id,workspace_id,principal_id,created_at,revoked_at)
 SELECT 'seat_'||repeat(CASE WHEN revoked_at IS NULL THEN 'a' ELSE 'x' END,24),seat_id,grant_id,workspace_id,principal_id,created_at,revoked_at FROM swarm.hosted_mcp_seats WHERE grant_id='33000000-0000-4000-8000-000000000001';
