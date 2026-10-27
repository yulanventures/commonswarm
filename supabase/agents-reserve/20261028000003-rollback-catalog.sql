SELECT (SELECT count(*)=12 AND bool_and(p.proowner='swarm_admin'::regrole AND p.prosecdef=e.definer AND md5(p.prosrc)=e.digest) FROM (VALUES ('swarm.resolve_hosted_grant_authorization(uuid,uuid,uuid,text)','1ea544115d61eb99d749b1b30b306b84',true),
('swarm.resolve_hosted_seat_command_authorization(uuid,text,text)','9a40ec0f733fbea335397b3c3ba85c3d',true),
('swarm.resolve_hosted_seat_read_authorization(uuid,text,text)','1ecdf1467d0bf05ad242a73e48e9362e',true),
('commonswarm_oauth.resolve_hosted_grant_status(text)','72cadd77edf6edf6569be767c3249d5a',true),
('commonswarm_oauth.lock_hosted_family(text,uuid,text,text)','cbb6c97a0d3d5014834857534a312465',true),
('commonswarm_oauth.lock_hosted_client_streams(text)','8fad9227ff62b4c94c120f9f8dfe68ac',true),
('swarm.resolve_hosted_mcp_connection_context(uuid,text,text,uuid,text)','329829df70b019d11d11e0425436cd41',true),
('swarm.discover_local_target_ids(uuid,uuid,uuid[],uuid[],boolean,uuid,boolean)','5e778d72876636ed12344036d59c277d',true),
('swarm.local_agent_membership_allowed(uuid,uuid,uuid,boolean)','7afec249f924a82cc5363a996e4e00e8',true),
('swarm.change_local_agent_membership(uuid,uuid,uuid,boolean)','47398b96660e4c3f86fefa8ac3d97e61',true),
('swarm.audit_household_hosted_restriction()','1753bfd1db60cf912fbf4e3df7c32422',false),
('swarm_read.home_overview()','c80946b70abc6c66edcd3a36e4518fcb',true)) e(signature,digest,definer) JOIN pg_proc p ON p.oid=to_regprocedure(e.signature))
 AND to_regclass('swarm.hosted_mcp_grant_agents') IS NULL AND to_regclass('swarm.hosted_mcp_agent_workspace_adds') IS NULL AS rollback_ok
\gset
