DO $check$ BEGIN
 IF (SELECT count(*) FROM swarm.agent_workspace_memberships)<>3
 OR NOT EXISTS (SELECT 1 FROM swarm.agent_workspace_memberships
   WHERE principal_id='22000000-0000-4000-8000-000000000002' AND revoked_at='2026-10-01T00:00:00Z')
 THEN RAISE EXCEPTION 'backfill must preserve live/revoked principals and exclude registrars'; END IF;
END $check$;

-- Real database roles exercise the existing legacy INSERT/UPDATE privileges, not a helper call.
SET LOCAL ROLE swarm_command;
INSERT INTO swarm.agent_principals(principal_id,workspace_id,owner_user_id,name,transport,turn_only) VALUES
 ('22000000-0000-4000-8000-000000000005','12000000-0000-4000-8000-000000000001','02000000-0000-4000-8000-000000000001','New local','local',false),
 ('22000000-0000-4000-8000-000000000006','12000000-0000-4000-8000-000000000001','02000000-0000-4000-8000-000000000001','New hosted','hosted_mcp',true),
 ('22000000-0000-4000-8000-000000000007','12000000-0000-4000-8000-000000000001','02000000-0000-4000-8000-000000000001','New registrar','local',false);
UPDATE swarm.agent_principals SET revoked_at='2026-10-02T00:00:00Z'
 WHERE principal_id='22000000-0000-4000-8000-000000000005';
INSERT INTO swarm.agent_runs(run_id,principal_id,device_id) VALUES
 ('42000000-0000-4000-8000-000000000002','22000000-0000-4000-8000-000000000007','32000000-0000-4000-8000-000000000001');
INSERT INTO swarm.agent_join_credentials(id,workspace_id,owner_user_id,registrar_principal_id,registrar_run_id,
 credential_hash,locator,seat_cap,expires_at,mint_command_id) VALUES
 ('52000000-0000-4000-8000-000000000002','12000000-0000-4000-8000-000000000001','02000000-0000-4000-8000-000000000001',
 '22000000-0000-4000-8000-000000000007','42000000-0000-4000-8000-000000000002',
 decode(repeat('43',32),'hex'),'accountAgentsFixture02',1,statement_timestamp()+interval '1 hour','accountAgentsFixture02');
UPDATE swarm.agent_principals SET revoked_at='2026-10-02T00:00:00Z'
 WHERE principal_id='22000000-0000-4000-8000-000000000007';
RESET ROLE;
DO $check$ BEGIN
 IF (SELECT count(*) FROM swarm.agent_workspace_memberships)<>5
 OR NOT EXISTS (SELECT 1 FROM swarm.agent_workspace_memberships
   WHERE principal_id='22000000-0000-4000-8000-000000000005' AND revoked_at='2026-10-02T00:00:00Z')
 THEN RAISE EXCEPTION 'legacy local/hosted/revocation/registrar writes must stay synchronized'; END IF;
 BEGIN
   UPDATE swarm.agent_workspace_memberships SET owner_user_id='02000000-0000-4000-8000-000000000002'
   WHERE principal_id='22000000-0000-4000-8000-000000000001';
   RAISE EXCEPTION 'foreign owner admitted';
 EXCEPTION WHEN foreign_key_violation THEN NULL; END;
 BEGIN
   INSERT INTO swarm.agent_workspace_memberships SELECT * FROM swarm.agent_workspace_memberships LIMIT 1;
   RAISE EXCEPTION 'duplicate membership admitted';
 EXCEPTION WHEN unique_violation THEN NULL; END;
END $check$;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"02000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
SELECT set_config('request.jwt.claim.sub','02000000-0000-4000-8000-000000000001',true);
DO $check$ BEGIN
 IF (SELECT count(*) FROM swarm_read.account_agents)<>4
 OR EXISTS (SELECT 1 FROM swarm_read.account_agents WHERE name IN ('Other agent','Registrar','New registrar'))
 OR NOT EXISTS (SELECT 1 FROM swarm_read.account_agents WHERE name='Local agent' AND model='GPT'
   AND transport='local' AND workspaces->0->>'workspace_name'='Agents workspace'
   AND workspaces->0->>'org_id'='12000000-0000-4000-8000-000000000001')
 THEN RAISE EXCEPTION 'account directory must expose only owned identities with memberships'; END IF;
 BEGIN
   PERFORM * FROM swarm.agent_workspace_memberships;
   RAISE EXCEPTION 'raw table exposed';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $check$;
SELECT set_config('request.jwt.claims','{"sub":"02000000-0000-4000-8000-000000000002","role":"authenticated"}',true);
SELECT set_config('request.jwt.claim.sub','02000000-0000-4000-8000-000000000002',true);
DO $check$ BEGIN
 IF (SELECT count(*) FROM swarm_read.account_agents)<>1 OR NOT EXISTS (
   SELECT 1 FROM swarm_read.account_agents WHERE name='Other agent')
 THEN RAISE EXCEPTION 'workspace peers must not see each others account agents'; END IF;
END $check$;
RESET ROLE;
UPDATE swarm.memberships SET revoked_at=statement_timestamp() WHERE user_id='02000000-0000-4000-8000-000000000002';
SET LOCAL ROLE authenticated;
DO $check$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM swarm_read.account_agents WHERE name='Other agent' AND workspaces='[]'::jsonb)
 THEN RAISE EXCEPTION 'owned agent remains discoverable without leaking inaccessible workspace names'; END IF;
END $check$;
SELECT set_config('request.jwt.claims','{}',true);
SELECT set_config('request.jwt.claim.sub','',true);
DO $check$ BEGIN
 IF EXISTS (SELECT 1 FROM swarm_read.account_agents) THEN RAISE EXCEPTION 'missing owner JWT exposed agents'; END IF;
END $check$;
RESET ROLE;
SET LOCAL ROLE anon;
DO $check$ BEGIN
 BEGIN
   PERFORM * FROM swarm_read.account_agents;
   RAISE EXCEPTION 'anonymous directory exposed';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $check$;
RESET ROLE;
