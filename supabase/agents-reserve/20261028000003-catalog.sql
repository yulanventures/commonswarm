-- Function bodies, ownership, RLS and the private write boundary.
SELECT (SELECT count(*)=19 AND bool_and(p.proowner='swarm_admin'::regrole AND p.prosecdef=e.definer AND md5(p.prosrc)=e.digest) FROM (VALUES ('swarm.hosted_binding_eligible(uuid,uuid,uuid)','1ebd647629c268fa78fcd86a84b03963',true),
('swarm.hosted_grant_workspace_ids(uuid)','9a421b8b330b74f068530e64b48e742a',true),
('swarm.bind_hosted_agent(uuid,uuid)','59fd00c93ccce4c39ee02ab14010b6e4',true),
('swarm.resolve_hosted_grant_authorization(uuid,uuid,uuid,text)','c4a551d82219f2b6b699f8cc60dd353a',true),
('swarm.resolve_hosted_seat_command_authorization(uuid,text,text)','a09bca79185b8b10e36af6ac441d7734',true),
('swarm.resolve_hosted_seat_read_authorization(uuid,text,text)','dd32250225787af07a1c5b45ed3bfacb',true),
('commonswarm_oauth.resolve_hosted_grant_status(text)','2efe14454c5813c9ba6c84b776cc7b81',true),
('commonswarm_oauth.lock_hosted_family(text,uuid,text,text)','6b35d57789a17d16e41e387286dbffe8',true),
('commonswarm_oauth.lock_hosted_client_streams(text)','a692d420c9baa34f8b9e52510b7bae2e',true),
('swarm.resolve_hosted_mcp_connection_context(uuid,text,text,uuid,text)','59918597f61e08d35201a773637c77eb',true),
('swarm.discover_local_target_ids(uuid,uuid,uuid[],uuid[],boolean,uuid,boolean)','4fe15154549ee9510941390858c9fada',true),
('swarm.hosted_agent_membership_allowed(uuid,uuid,uuid,boolean)','70c2ea31096d62220a4c8d3e0cfa77c3',true),
('swarm.change_hosted_agent_membership(uuid,uuid,uuid,boolean)','fff7c811a9aa59df2dfff1580b3ad49f',true),
('swarm.local_agent_membership_allowed(uuid,uuid,uuid,boolean)','e5c1d3ecab220b2024e4ba3959751226',true),
('swarm.change_local_agent_membership(uuid,uuid,uuid,boolean)','69379e48ffd0d53d0827d70a03b812b3',true),
('swarm.remove_hosted_agents_for_member(uuid,uuid,uuid)','f02a046668e12ce0d0b09b6dd7e7f091',true),
('swarm.audit_household_hosted_restriction()','0d032e2ffc3607489faffb8d4c308bf9',false),
('swarm_read.home_overview()','3d691ae8841664982f0eb535c6086e24',true),
('swarm.revoke_hosted_seat_membership(uuid,uuid,uuid)','193e68c8e0dbb06d9da99f1d1584d815',true)) e(signature,digest,definer) JOIN pg_proc p ON p.oid=to_regprocedure(e.signature))
 AND (SELECT count(*)=2 AND bool_and(c.relowner='swarm_admin'::regrole AND c.relrowsecurity
   AND NOT has_table_privilege('authenticated',c.oid,'SELECT') AND NOT has_table_privilege('anon',c.oid,'SELECT')
   AND NOT has_table_privilege('swarm_read',c.oid,'SELECT')) FROM pg_class c
   WHERE c.oid IN(to_regclass('swarm.hosted_mcp_grant_agents'),to_regclass('swarm.hosted_mcp_agent_workspace_adds')))
 AND NOT has_table_privilege('swarm_command','swarm.hosted_mcp_agent_workspace_adds','INSERT')
 AND NOT has_function_privilege('authenticated','swarm.change_hosted_agent_membership(uuid,uuid,uuid,boolean)','EXECUTE')
 AND NOT has_function_privilege('swarm_read','swarm.change_hosted_agent_membership(uuid,uuid,uuid,boolean)','EXECUTE')
 AND EXISTS(SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('swarm.hosted_mcp_seats_agent_live') AND indisunique)
 AS catalog_ok
\gset
