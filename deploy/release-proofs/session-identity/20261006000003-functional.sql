-- Source-built reserve-stage storage/provider proof, synthetic rows only.
-- Command allocation/replay/quota/race proof is hosted-context-allocation.test.ts;
-- SQL cannot invoke the Deno transactional command path. No ledger/apply receipt.
BEGIN;
INSERT INTO auth.users(id,aud,role,email) VALUES
 ('01000000-0000-4000-8000-000000000001','authenticated','authenticated','sid-reserve@example.test');
INSERT INTO swarm.users(user_id,display_name) VALUES ('01000000-0000-4000-8000-000000000001','Synthetic SID owner');
INSERT INTO swarm.workspaces(workspace_id,name,created_by) VALUES
 ('01000000-0000-4000-8000-000000000002','Synthetic SID workspace','01000000-0000-4000-8000-000000000001');
INSERT INTO swarm.memberships(workspace_id,user_id,role) VALUES
 ('01000000-0000-4000-8000-000000000002','01000000-0000-4000-8000-000000000001','owner');
INSERT INTO swarm.streams(stream_id,workspace_id,kind) VALUES
 ('01000000-0000-4000-8000-000000000003','01000000-0000-4000-8000-000000000002','workspace');
INSERT INTO swarm.hosted_mcp_grants(grant_id,provider_grant_id,owner_user_id,home_workspace_id,client_id,resource,selected_workspace_ids,manifest_digest,interaction_ref,state,created_at,activated_at)
VALUES ('01000000-0000-4000-8000-000000000004','sid-synthetic-provider','01000000-0000-4000-8000-000000000001',
 '01000000-0000-4000-8000-000000000002','sid-synthetic-client','https://mcp.commonswarm.com/mcp',
 ARRAY['01000000-0000-4000-8000-000000000002']::uuid[],decode(repeat('00',32),'hex'),'synthetic-proof','active',statement_timestamp(),statement_timestamp());
INSERT INTO swarm.hosted_mcp_grant_workspaces(grant_id,workspace_id,owner_user_id,manifest_digest,consent_receipt_id,consented_at)
VALUES('01000000-0000-4000-8000-000000000004','01000000-0000-4000-8000-000000000002','01000000-0000-4000-8000-000000000001',
 decode(repeat('00',32),'hex'),'01000000-0000-4000-8000-000000000005',statement_timestamp());
DO $proof$
DECLARE unavailable boolean;
BEGIN
 SELECT predecessor_unavailable INTO unavailable FROM swarm.hosted_predecessor_status('01000000-0000-4000-8000-000000000004');
 IF unavailable IS DISTINCT FROM false THEN RAISE EXCEPTION 'absent provider Grant does not prove expiry'; END IF;
END
$proof$;
INSERT INTO commonswarm_oauth.provider_artifacts(model,artifact_id_hash,payload,expires_at,created_at,updated_at)
VALUES('Grant',rtrim(translate(encode(sha256(convert_to('sid-synthetic-provider','UTF8')),'base64'),'+/','-_'),'='),
 '{"accountId":"01000000-0000-4000-8000-000000000001","clientId":"sid-synthetic-client"}',
 statement_timestamp()+interval '1 day',statement_timestamp(),statement_timestamp());
DO $proof$
BEGIN
 IF (SELECT predecessor_unavailable FROM swarm.hosted_predecessor_status('01000000-0000-4000-8000-000000000004')) IS DISTINCT FROM false
 THEN RAISE EXCEPTION 'live provider Grant cannot succeed'; END IF;
END
$proof$;
UPDATE commonswarm_oauth.provider_artifacts SET expires_at=statement_timestamp()-interval '1 second'
 WHERE model='Grant' AND payload->>'clientId'='sid-synthetic-client';
DO $proof$
BEGIN
 IF (SELECT predecessor_unavailable FROM swarm.hosted_predecessor_status('01000000-0000-4000-8000-000000000004')) IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'persisted expired provider Grant must prove expiry'; END IF;
END
$proof$;
UPDATE commonswarm_oauth.provider_artifacts SET payload=jsonb_set(payload,'{clientId}','"different-client"') WHERE model='Grant' AND payload->>'clientId'='sid-synthetic-client';
DO $proof$
BEGIN
 IF (SELECT predecessor_unavailable FROM swarm.hosted_predecessor_status('01000000-0000-4000-8000-000000000004')) IS DISTINCT FROM false
 THEN RAISE EXCEPTION 'wrong registered client cannot prove predecessor expiry'; END IF;
END
$proof$;
INSERT INTO commonswarm_oauth.refresh_family_tombstones(grant_id,revoked_at) VALUES('sid-synthetic-provider',statement_timestamp());
DO $proof$
BEGIN
 IF (SELECT predecessor_unavailable FROM swarm.hosted_predecessor_status('01000000-0000-4000-8000-000000000004')) IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'durable provider revocation proves unavailability'; END IF;
END
$proof$;
INSERT INTO swarm.agent_principals(principal_id,workspace_id,owner_user_id,name,transport,turn_only)
VALUES('01000000-0000-4000-8000-000000000006','01000000-0000-4000-8000-000000000002','01000000-0000-4000-8000-000000000001','Synthetic durable','hosted_mcp',true);
INSERT INTO swarm.hosted_mcp_seats(seat_id,grant_id,workspace_id,owner_user_id,principal_id,name,created_at)
VALUES('01000000-0000-4000-8000-000000000007','01000000-0000-4000-8000-000000000004','01000000-0000-4000-8000-000000000002','01000000-0000-4000-8000-000000000001','01000000-0000-4000-8000-000000000006','Synthetic durable',statement_timestamp());
SET LOCAL ROLE swarm_command;
INSERT INTO swarm.hosted_agent_contexts(context_id,handle,seat_id,kind,created_at,last_business_at,idle_expires_at,absolute_expires_at,origin)
VALUES('01000000-0000-4000-8000-000000000008','seat_abcdefghijklmnopqrstuv','01000000-0000-4000-8000-000000000007','chat',statement_timestamp(),statement_timestamp(),statement_timestamp()+interval '1 day',statement_timestamp()+interval '30 days','new');
DO $proof$
BEGIN
 IF (SELECT count(*) FROM swarm.hosted_agent_contexts)<>1 THEN RAISE EXCEPTION 'command role positive context control'; END IF;
 BEGIN
  INSERT INTO swarm.hosted_agent_contexts(context_id,handle,seat_id,kind,created_at,last_business_at,idle_expires_at,absolute_expires_at,origin)
  VALUES('01000000-0000-4000-8000-000000000009','seat_ABCDEFGHIJKLMNOPQRSTUV','01000000-0000-4000-8000-000000000007','chat',statement_timestamp(),statement_timestamp(),statement_timestamp()-interval '1 second',statement_timestamp()+interval '1 day','new');
  RAISE EXCEPTION 'invalid clock admitted' USING ERRCODE='ZX001';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  DELETE FROM swarm.hosted_agent_contexts; RAISE EXCEPTION 'command DELETE admitted' USING ERRCODE='ZX001';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END
$proof$;
RESET ROLE;
SET LOCAL ROLE authenticated;
DO $proof$
BEGIN
 BEGIN
  PERFORM 1 FROM swarm.hosted_agent_contexts; RAISE EXCEPTION 'authenticated context read admitted' USING ERRCODE='ZX001';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN
  PERFORM * FROM swarm.hosted_predecessor_status('01000000-0000-4000-8000-000000000004'); RAISE EXCEPTION 'authenticated predecessor read admitted' USING ERRCODE='ZX001';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END
$proof$;
RESET ROLE;
SET LOCAL ROLE swarm_read;
DO $proof$
BEGIN
 BEGIN
  PERFORM 1 FROM swarm.hosted_agent_contexts; RAISE EXCEPTION 'direct read-role context access admitted' USING ERRCODE='ZX001';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END
$proof$;
RESET ROLE;
ROLLBACK;
