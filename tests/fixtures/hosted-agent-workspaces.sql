-- Execute after the real grandfather and slice-4b migrations, not synthetic DDL.
DO $test$ DECLARE
 a uuid='13000000-0000-4000-8000-000000000001'; b uuid='13000000-0000-4000-8000-000000000002'; c uuid='13000000-0000-4000-8000-000000000003';
 p uuid='23000000-0000-4000-8000-000000000001'; u uuid='03000000-0000-4000-8000-000000000001'; peer uuid='03000000-0000-4000-8000-000000000002'; g uuid='33000000-0000-4000-8000-000000000001';
 original jsonb; receipt uuid;
BEGIN
 SELECT to_jsonb(gw) INTO original FROM swarm.hosted_mcp_grant_workspaces gw WHERE grant_id=g;
 IF (SELECT count(*) FROM swarm.hosted_mcp_grant_agents WHERE grant_id=g)<>2
 OR NOT EXISTS(SELECT 1 FROM swarm.hosted_mcp_grant_agents WHERE grant_id=g AND principal_id='23000000-0000-4000-8000-000000000002' AND revoked_at IS NOT NULL)
 THEN RAISE EXCEPTION 'backfill merged identities or revived a revoked agent'; END IF;
 IF NOT EXISTS(SELECT 1 FROM swarm.permanence_grandfather_journal WHERE row_key->>'hosted_grant_id'=g::text AND restored_at IS NULL)
 THEN RAISE EXCEPTION 'fixture did not exercise actual grandfathering'; END IF;
 IF NOT EXISTS(SELECT 1 FROM swarm.resolve_hosted_seat_read_authorization(g,'seat_'||repeat('a',24),'whoami') WHERE principal_id=p)
 THEN RAISE EXCEPTION 'old seat/handle lost'; END IF;
 IF swarm.hosted_binding_eligible(g,b,p) OR EXISTS(SELECT 1 FROM swarm.resolve_hosted_grant_authorization(g,u,b,'claim_hosted_seat'))
 THEN RAISE EXCEPTION 'absent membership admitted'; END IF;
 -- A membership row alone must not imply this connection's approval.
 INSERT INTO swarm.agent_workspace_memberships(principal_id,workspace_id,owner_user_id,added_by) VALUES(p,b,u,u);
 IF swarm.hosted_binding_eligible(g,b,p) THEN RAISE EXCEPTION 'missing human receipt admitted'; END IF;
 DELETE FROM swarm.agent_workspace_memberships WHERE principal_id=p AND workspace_id=b;
 IF swarm.change_local_agent_membership(b,p,peer,true) OR swarm.change_local_agent_membership(c,p,u,true)
 THEN RAISE EXCEPTION 'unauthorized peer or wrong org admitted'; END IF;
 UPDATE swarm.memberships SET revoked_at=clock_timestamp() WHERE workspace_id=b AND user_id=u;
 UPDATE swarm.memberships SET role='admin' WHERE workspace_id=b AND user_id=peer;
 IF swarm.change_local_agent_membership(b,p,peer,true) THEN RAISE EXCEPTION 'owner absent admitted'; END IF;
 UPDATE swarm.memberships SET revoked_at=NULL WHERE workspace_id=b AND user_id=u;
 IF NOT swarm.change_local_agent_membership(b,p,u,true) THEN RAISE EXCEPTION 'human add failed'; END IF;
 SELECT receipt_id INTO receipt FROM swarm.hosted_mcp_agent_workspace_adds WHERE grant_id=g AND workspace_id=b AND revoked_at IS NULL;
 IF NOT swarm.hosted_binding_eligible(g,b,p) OR receipt IS NULL THEN RAISE EXCEPTION 'explicit receipt did not grant authority'; END IF;
 IF original IS DISTINCT FROM (SELECT to_jsonb(gw) FROM swarm.hosted_mcp_grant_workspaces gw WHERE grant_id=g)
 OR (SELECT selected_workspace_ids FROM swarm.hosted_mcp_grants WHERE grant_id=g)<>ARRAY[a]
 THEN RAISE EXCEPTION 'original consent changed'; END IF;
 IF NOT (SELECT active FROM commonswarm_oauth.lock_hosted_family('hosted-workspace-family',u,'hosted-workspace-fixture','https://mcp.commonswarm.com/mcp'))
 THEN RAISE EXCEPTION 'refresh after add failed'; END IF;
 -- Member removal before any seat exists withdraws explicit authority permanently.
 PERFORM swarm.remove_hosted_agents_for_member(b,u,peer);
 UPDATE swarm.memberships SET revoked_at=clock_timestamp() WHERE workspace_id=b AND user_id=u;
 UPDATE swarm.memberships SET revoked_at=NULL WHERE workspace_id=b AND user_id=u;
 IF swarm.hosted_binding_eligible(g,b,p) OR NOT EXISTS(SELECT 1 FROM swarm.hosted_mcp_agent_workspace_adds WHERE receipt_id=receipt AND revoked_at IS NOT NULL)
 THEN RAISE EXCEPTION 'rejoin resurrected pre-claim approval'; END IF;
 IF NOT swarm.change_local_agent_membership(b,p,u,true) THEN RAISE EXCEPTION 'explicit reapproval failed'; END IF;
 INSERT INTO swarm.hosted_mcp_seats(seat_id,grant_id,workspace_id,owner_user_id,principal_id,name,created_at)
 VALUES('53000000-0000-4000-8000-000000000003',g,b,u,p,'Reusable hosted',clock_timestamp());
 INSERT INTO swarm.hosted_mcp_seat_handles(handle,seat_id,grant_id,workspace_id,principal_id,created_at)
 VALUES('seat_'||repeat('b',24),'53000000-0000-4000-8000-000000000003',g,b,p,clock_timestamp());
 IF NOT EXISTS(SELECT 1 FROM swarm.resolve_hosted_seat_read_authorization(g,'seat_'||repeat('b',24),'whoami') WHERE principal_id=p AND workspace_id=b)
 OR NOT EXISTS(SELECT 1 FROM swarm.resolve_hosted_seat_command_authorization(g,'seat_'||repeat('b',24),'note') WHERE principal_id=p AND workspace_id=b)
 THEN RAISE EXCEPTION 'same principal sibling read/write denied'; END IF;
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',u,'role','authenticated','agent_principal_id',p)::text,true);
 IF jsonb_array_length(swarm.resolve_hosted_mcp_connection_context(g,'hosted-workspace-family','whoami',b,'seat_'||repeat('b',24))->'connection'->'reachable_workspaces')<>2
 THEN RAISE EXCEPTION 'whoami did not discover sibling'; END IF;
 -- Owner absence denies current read/write even before the removal projection.
 UPDATE swarm.memberships SET revoked_at=clock_timestamp() WHERE workspace_id=b AND user_id=u;
 IF EXISTS(SELECT 1 FROM swarm.resolve_hosted_seat_read_authorization(g,'seat_'||repeat('b',24),'whoami'))
 OR EXISTS(SELECT 1 FROM swarm.resolve_hosted_seat_command_authorization(g,'seat_'||repeat('b',24),'note')) THEN RAISE EXCEPTION 'owner absence admitted'; END IF;
 PERFORM swarm.remove_hosted_agents_for_member(b,u,peer);
 UPDATE swarm.memberships SET revoked_at=NULL WHERE workspace_id=b AND user_id=u;
 IF EXISTS(SELECT 1 FROM swarm.resolve_hosted_seat_read_authorization(g,'seat_'||repeat('b',24),'whoami'))
 OR swarm.hosted_binding_eligible(g,b,p) THEN RAISE EXCEPTION 'post-claim removal resurrected'; END IF;
 IF NOT EXISTS(SELECT 1 FROM swarm.resolve_hosted_seat_command_authorization(g,'seat_'||repeat('a',24),'note')) THEN RAISE EXCEPTION 'B removal broke A'; END IF;
 -- Last workspace removal is dormant. Refresh continues, every old handle denies.
 PERFORM swarm.change_local_agent_membership(a,p,u,false);
 IF NOT commonswarm_oauth.provider_family_active('hosted-workspace-family')
 OR EXISTS(SELECT 1 FROM swarm.resolve_hosted_seat_read_authorization(g,'seat_'||repeat('a',24),'whoami'))
 OR EXISTS(SELECT 1 FROM swarm.resolve_hosted_grant_authorization(g,u,a,'claim_hosted_seat'))
 THEN RAISE EXCEPTION 'dormancy retired family or retained tool authority'; END IF;
 IF NOT swarm.change_local_agent_membership(b,p,u,true) THEN RAISE EXCEPTION 'dormant re-add failed'; END IF;
 IF NOT swarm.hosted_binding_eligible(g,b,p) THEN RAISE EXCEPTION 'dormant re-add authority missing'; END IF;
 IF EXISTS(SELECT 1 FROM swarm.resolve_hosted_seat_read_authorization(g,'seat_'||repeat('b',24),'whoami')) THEN RAISE EXCEPTION 'old handle revived by re-add'; END IF;
 INSERT INTO swarm.hosted_mcp_seats(seat_id,grant_id,workspace_id,owner_user_id,principal_id,name,created_at)
 VALUES('53000000-0000-4000-8000-000000000004',g,b,u,p,'Reusable hosted',clock_timestamp());
 INSERT INTO swarm.hosted_mcp_seat_handles(handle,seat_id,grant_id,workspace_id,principal_id,created_at)
 VALUES('seat_'||repeat('c',24),'53000000-0000-4000-8000-000000000004',g,b,p,clock_timestamp());
 IF NOT EXISTS(SELECT 1 FROM swarm.resolve_hosted_seat_read_authorization(g,'seat_'||repeat('c',24),'whoami') WHERE principal_id=p) THEN RAISE EXCEPTION 'fresh seat after explicit re-add denied'; END IF;
 -- A revoked grant-agent binding is an independent terminal fence, with a live family.
 BEGIN
  UPDATE swarm.hosted_mcp_grant_agents SET revoked_at=clock_timestamp() WHERE grant_id=g AND principal_id=p;
  IF NOT commonswarm_oauth.provider_family_active('hosted-workspace-family') OR swarm.change_local_agent_membership(a,p,u,true)
  OR EXISTS(SELECT 1 FROM swarm.resolve_hosted_seat_read_authorization(g,'seat_'||repeat('c',24),'whoami'))
  THEN RAISE EXCEPTION 'revoked grant-agent binding admitted'; END IF;
  RAISE EXCEPTION 'restore negative-control fixture' USING ERRCODE='ZX001';
 EXCEPTION WHEN SQLSTATE 'ZX001' THEN NULL;
 END;
 INSERT INTO commonswarm_oauth.refresh_family_tombstones(grant_id,revoked_at) VALUES('hosted-workspace-family',clock_timestamp());
 IF swarm.change_local_agent_membership(a,p,u,true) OR commonswarm_oauth.provider_family_active('hosted-workspace-family')
 OR EXISTS(SELECT 1 FROM swarm.resolve_hosted_seat_command_authorization(g,'seat_'||repeat('c',24),'note')) THEN RAISE EXCEPTION 'revoked family resurrected'; END IF;
END $test$;
