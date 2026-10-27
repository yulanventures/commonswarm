INSERT INTO auth.users(id,aud,role,email) VALUES
 ('00000000-0000-4000-8000-000000000001','authenticated','authenticated','org-owner@example.test'),
 ('00000000-0000-4000-8000-000000000002','authenticated','authenticated','org-member@example.test');
INSERT INTO swarm.users(user_id,display_name) VALUES
 ('00000000-0000-4000-8000-000000000001','Org owner'),
 ('00000000-0000-4000-8000-000000000002','Org member');
INSERT INTO swarm.workspaces(workspace_id,name,created_by) VALUES
 ('10000000-0000-4000-8000-000000000001','Same name','00000000-0000-4000-8000-000000000001'),
 ('10000000-0000-4000-8000-000000000002','Same name','00000000-0000-4000-8000-000000000001');
INSERT INTO swarm.memberships(workspace_id,user_id,role,revoked_at) VALUES
 ('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','owner',NULL),
 ('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','member',statement_timestamp());
