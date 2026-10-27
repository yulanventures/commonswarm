-- Fixture data only; the harness supplies the full migrated application schema.
INSERT INTO swarm.workspaces(workspace_id,name,created_by,org_id) SELECT
 '12000000-0000-4000-8000-000000000002','Sibling','02000000-0000-4000-8000-000000000001',org_id FROM swarm.workspaces WHERE workspace_id='12000000-0000-4000-8000-000000000001';
INSERT INTO swarm.workspaces(workspace_id,name,created_by) VALUES
 ('12000000-0000-4000-8000-000000000003','Other organization','02000000-0000-4000-8000-000000000001');
INSERT INTO swarm.memberships(workspace_id,user_id,role) VALUES
 ('12000000-0000-4000-8000-000000000002','02000000-0000-4000-8000-000000000001','owner'),
 ('12000000-0000-4000-8000-000000000002','02000000-0000-4000-8000-000000000002','member'),
 ('12000000-0000-4000-8000-000000000003','02000000-0000-4000-8000-000000000001','owner');
INSERT INTO swarm.agent_runs(run_id,principal_id,device_id) VALUES
 ('42000000-0000-4000-8000-000000000002','22000000-0000-4000-8000-000000000001','32000000-0000-4000-8000-000000000001');
INSERT INTO swarm.renewal_grants(renewal_grant_id,principal_id,run_id,workspace_id,created_by,kind,max_successors,horizon_expires_at,bound_device_id) VALUES
 ('62000000-0000-4000-8000-000000000001','22000000-0000-4000-8000-000000000001','42000000-0000-4000-8000-000000000002',
 '12000000-0000-4000-8000-000000000001','02000000-0000-4000-8000-000000000001','standing',NULL,NULL,'32000000-0000-4000-8000-000000000001');
INSERT INTO swarm.agent_tokens(token_id,principal_id,run_id,scopes,token_hash,expires_at,renewal_grant_id,lineage_id) VALUES
 ('72000000-0000-4000-8000-000000000001','22000000-0000-4000-8000-000000000001','42000000-0000-4000-8000-000000000002','["post_signal"]',
 decode(repeat('55',32),'hex'),clock_timestamp()+interval '1 hour','62000000-0000-4000-8000-000000000001','82000000-0000-4000-8000-000000000001');
DO $test$ DECLARE ctx record; BEGIN
 IF swarm.local_agent_workspace_live('22000000-0000-4000-8000-000000000001','12000000-0000-4000-8000-000000000002') THEN RAISE EXCEPTION 'absent membership admitted'; END IF;
 SELECT * INTO ctx FROM swarm.agent_delivery_read_context(decode(repeat('55',32),'hex'),'12000000-0000-4000-8000-000000000002');
 IF NOT ctx.is_revoked THEN RAISE EXCEPTION 'read without membership admitted'; END IF;
 IF swarm.change_local_agent_membership('12000000-0000-4000-8000-000000000002','22000000-0000-4000-8000-000000000001','02000000-0000-4000-8000-000000000002',true)
 THEN RAISE EXCEPTION 'plain peer add admitted'; END IF;
 IF swarm.change_local_agent_membership('12000000-0000-4000-8000-000000000003','22000000-0000-4000-8000-000000000001','02000000-0000-4000-8000-000000000001',true)
 THEN RAISE EXCEPTION 'cross organization add admitted'; END IF;
 IF swarm.change_local_agent_membership('12000000-0000-4000-8000-000000000002','22000000-0000-4000-8000-000000000002','02000000-0000-4000-8000-000000000001',true)
 THEN RAISE EXCEPTION 'hosted principal admitted'; END IF;
 IF NOT swarm.change_local_agent_membership('12000000-0000-4000-8000-000000000002','22000000-0000-4000-8000-000000000001','02000000-0000-4000-8000-000000000001',true)
 THEN RAISE EXCEPTION 'owner add failed'; END IF;
 IF NOT swarm.local_agent_workspace_live('22000000-0000-4000-8000-000000000001','12000000-0000-4000-8000-000000000002') THEN RAISE EXCEPTION 'added membership not live'; END IF;
 IF EXISTS(SELECT 1 FROM swarm.local_content_approval_workspaces WHERE workspace_id='12000000-0000-4000-8000-000000000002') THEN RAISE EXCEPTION 'approval copied to sibling'; END IF;
 SELECT * INTO ctx FROM swarm.agent_delivery_read_context(decode(repeat('55',32),'hex'),'12000000-0000-4000-8000-000000000002');
 IF ctx.is_revoked OR ctx.principal_workspace_id<>'12000000-0000-4000-8000-000000000002' THEN RAISE EXCEPTION 'unchanged credential denied in sibling'; END IF;
 IF jsonb_array_length(swarm.agent_reachable_workspaces(decode(repeat('55',32),'hex')))<>2 THEN RAISE EXCEPTION 'discovery must expose only two reachable memberships'; END IF;
END $test$;
-- Managed proof is a connection proof and seeds separately keyed target state.
UPDATE swarm.agent_principals SET managed_at=clock_timestamp() WHERE principal_id='22000000-0000-4000-8000-000000000001';
INSERT INTO swarm.agent_execution_sessions(principal_id,workspace_id,session_id,generation,key_hash,lifecycle_state,expired_at)
 VALUES('22000000-0000-4000-8000-000000000001','12000000-0000-4000-8000-000000000001','92000000-0000-4000-8000-000000000001',1,decode(repeat('77',32),'hex'),'enabled',clock_timestamp()+interval '1 hour');
DO $test$ BEGIN
 PERFORM swarm.change_local_agent_membership('12000000-0000-4000-8000-000000000002','22000000-0000-4000-8000-000000000001','02000000-0000-4000-8000-000000000001',true);
 IF swarm.activate_local_workspace_session('22000000-0000-4000-8000-000000000001','12000000-0000-4000-8000-000000000002','92000000-0000-4000-8000-000000000001',1,decode(repeat('88',32),'hex')) THEN RAISE EXCEPTION 'wrong session proof admitted'; END IF;
 IF NOT swarm.activate_local_workspace_session('22000000-0000-4000-8000-000000000001','12000000-0000-4000-8000-000000000002','92000000-0000-4000-8000-000000000001',1,decode(repeat('77',32),'hex')) THEN RAISE EXCEPTION 'connection proof failed to seed sibling'; END IF;
 PERFORM swarm.change_local_agent_membership('12000000-0000-4000-8000-000000000001','22000000-0000-4000-8000-000000000001','02000000-0000-4000-8000-000000000001',false);
 IF NOT EXISTS(SELECT 1 FROM swarm.agent_connection_sessions WHERE principal_id='22000000-0000-4000-8000-000000000001' AND key_hash IS NOT NULL)
 OR NOT EXISTS(SELECT 1 FROM swarm.agent_execution_sessions WHERE principal_id='22000000-0000-4000-8000-000000000001' AND workspace_id='12000000-0000-4000-8000-000000000002' AND key_hash IS NOT NULL)
 THEN RAISE EXCEPTION 'origin session removal broke connection or sibling'; END IF;
END $test$;
-- Technical execution-lease expiry does not expire connection-key possession.
UPDATE swarm.agent_execution_sessions SET expired_at=clock_timestamp()-interval '1 hour' WHERE principal_id='22000000-0000-4000-8000-000000000001' AND workspace_id='12000000-0000-4000-8000-000000000002';
DO $test$ BEGIN
 IF NOT swarm.activate_local_workspace_session('22000000-0000-4000-8000-000000000001','12000000-0000-4000-8000-000000000002','92000000-0000-4000-8000-000000000001',1,decode(repeat('77',32),'hex')) THEN RAISE EXCEPTION 'expired technical lease required reconnection'; END IF;
END $test$;
-- The origin can close and its owner can leave without killing credential or renewal.
UPDATE swarm.workspaces SET archived_at=clock_timestamp() WHERE workspace_id='12000000-0000-4000-8000-000000000001';
UPDATE swarm.memberships SET revoked_at=clock_timestamp() WHERE workspace_id='12000000-0000-4000-8000-000000000001' AND user_id='02000000-0000-4000-8000-000000000001';
DO $test$ DECLARE ctx record; BEGIN
 SELECT * INTO ctx FROM swarm.agent_delivery_read_context(decode(repeat('55',32),'hex'),'12000000-0000-4000-8000-000000000002');
 IF ctx.is_revoked THEN RAISE EXCEPTION 'origin loss broke sibling'; END IF;
 IF swarm.prepare_renewal_grant('62000000-0000-4000-8000-000000000001','32000000-0000-4000-8000-000000000001') IS NOT NULL THEN RAISE EXCEPTION 'origin loss broke renewal'; END IF;
 IF jsonb_array_length(swarm.agent_reachable_workspaces(decode(repeat('55',32),'hex')))<>1 THEN RAISE EXCEPTION 'discovery leaked closed origin'; END IF;
 IF NOT swarm.change_local_agent_membership('12000000-0000-4000-8000-000000000002','22000000-0000-4000-8000-000000000001','02000000-0000-4000-8000-000000000001',false) THEN RAISE EXCEPTION 'remove failed'; END IF;
 SELECT * INTO ctx FROM swarm.agent_delivery_read_context(decode(repeat('55',32),'hex'),'12000000-0000-4000-8000-000000000002');
 IF NOT ctx.is_revoked THEN RAISE EXCEPTION 'removed target read admitted'; END IF;
 IF EXISTS(SELECT 1 FROM swarm.renewal_grants WHERE revoked_at IS NOT NULL) OR EXISTS(SELECT 1 FROM swarm.agent_tokens WHERE revoked_at IS NOT NULL)
 THEN RAISE EXCEPTION 'workspace remove globally revoked connection'; END IF;
 IF swarm.agent_reachable_workspaces(decode(repeat('55',32),'hex'))<>'[]'::jsonb THEN RAISE EXCEPTION 'dormant discovery not empty'; END IF;
 IF NOT swarm.change_local_agent_membership('12000000-0000-4000-8000-000000000002','22000000-0000-4000-8000-000000000001','02000000-0000-4000-8000-000000000001',true)
 THEN RAISE EXCEPTION 'explicit restore of last membership failed'; END IF;
END $test$;
-- The successor trigger keeps lineage/device/family binding after origin loss.
INSERT INTO swarm.agent_tokens(token_id,principal_id,run_id,scopes,token_hash,expires_at,renewal_grant_id,lineage_id,predecessor_token_id) VALUES
 ('72000000-0000-4000-8000-000000000002','22000000-0000-4000-8000-000000000001','42000000-0000-4000-8000-000000000002','["post_signal"]',decode(repeat('66',32),'hex'),clock_timestamp()+interval '1 hour',
 '62000000-0000-4000-8000-000000000001','82000000-0000-4000-8000-000000000001','72000000-0000-4000-8000-000000000001');
DO $test$ BEGIN
 BEGIN
 UPDATE swarm.agent_tokens SET revoked_at=clock_timestamp() WHERE token_id='72000000-0000-4000-8000-000000000001';
 PERFORM * FROM swarm.discover_local_credential_ids(decode(repeat('55',32),'hex'));
 RAISE EXCEPTION 'global token revocation admitted';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $test$;
-- Global family withdrawal through a sibling is owner-only and remains terminal.
DO $test$ BEGIN
 BEGIN
 UPDATE swarm.renewal_grants SET revoked_at=clock_timestamp(),revoked_by='02000000-0000-4000-8000-000000000001' WHERE renewal_grant_id='62000000-0000-4000-8000-000000000001';
 PERFORM swarm.revoke_local_residual_tokens('12000000-0000-4000-8000-000000000002','02000000-0000-4000-8000-000000000002','revoke_agent_token','72000000-0000-4000-8000-000000000001');
 RAISE EXCEPTION 'non-owner globally revoked sibling connection';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN
 UPDATE swarm.renewal_grants SET revoked_at=clock_timestamp(),revoked_by='02000000-0000-4000-8000-000000000001' WHERE renewal_grant_id='62000000-0000-4000-8000-000000000001';
 PERFORM swarm.revoke_local_residual_tokens('12000000-0000-4000-8000-000000000002','02000000-0000-4000-8000-000000000001','revoke_agent_token','72000000-0000-4000-8000-000000000001');
 IF EXISTS(SELECT 1 FROM swarm.agent_tokens WHERE principal_id='22000000-0000-4000-8000-000000000001' AND revoked_at IS NULL) THEN RAISE EXCEPTION 'global owner revoke left a successor live'; END IF;
 RAISE EXCEPTION 'rollback fixture revoke' USING ERRCODE='ZX123';
 EXCEPTION WHEN SQLSTATE 'ZX123' THEN NULL; END;
END $test$;
-- Explicit execution release still fences this target until a fresh acquisition.
UPDATE swarm.agent_execution_sessions SET lifecycle_state='disabled',key_hash=NULL WHERE principal_id='22000000-0000-4000-8000-000000000001' AND workspace_id='12000000-0000-4000-8000-000000000002';
DO $test$ BEGIN
 IF swarm.activate_local_workspace_session('22000000-0000-4000-8000-000000000001','12000000-0000-4000-8000-000000000002','92000000-0000-4000-8000-000000000001',1,decode(repeat('77',32),'hex')) THEN RAISE EXCEPTION 'released target execution proof was revived'; END IF;
END $test$;
-- Target owner membership is mandatory even if the caller is target owner/admin.
UPDATE swarm.memberships SET revoked_at=clock_timestamp() WHERE workspace_id='12000000-0000-4000-8000-000000000002' AND user_id='02000000-0000-4000-8000-000000000002';
DO $test$ BEGIN
 IF swarm.change_local_agent_membership('12000000-0000-4000-8000-000000000002','22000000-0000-4000-8000-000000000003','02000000-0000-4000-8000-000000000001',true)
 THEN RAISE EXCEPTION 'admin added absent owners agent'; END IF;
END $test$;
INSERT INTO swarm.revocation_tombstones(kind,target_id) VALUES('family','82000000-0000-4000-8000-000000000001');
DO $test$ BEGIN
 BEGIN
 PERFORM * FROM swarm.discover_local_credential_ids(decode(repeat('55',32),'hex'));
 RAISE EXCEPTION 'revoked family resurrected';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $test$;
