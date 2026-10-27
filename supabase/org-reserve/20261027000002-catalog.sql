SELECT coalesce((SELECT prosecdef AND proowner='swarm_admin'::regrole AND proconfig=ARRAY['search_path=pg_catalog']
 AND md5(prosrc)='aa7469ba80a2c8ac3872ba1903127ad7'
 AND NOT has_function_privilege('anon',oid,'EXECUTE') AND NOT has_function_privilege('authenticated',oid,'EXECUTE')
 AND NOT has_function_privilege('swarm_read',oid,'EXECUTE') AND NOT has_function_privilege('swarm_command',oid,'EXECUTE')
 FROM pg_proc WHERE oid=to_regprocedure('swarm.ensure_workspace_org()')),false)
 AND coalesce((SELECT prosecdef AND proowner='swarm_admin'::regrole AND proconfig=ARRAY['search_path=pg_catalog']
 AND md5(prosrc)='a300aab1bd496603262c68cc29a142de'
 AND NOT has_function_privilege('anon',oid,'EXECUTE') AND NOT has_function_privilege('authenticated',oid,'EXECUTE')
 AND NOT has_function_privilege('swarm_read',oid,'EXECUTE') AND NOT has_function_privilege('swarm_command',oid,'EXECUTE')
 FROM pg_proc WHERE oid=to_regprocedure('swarm.sync_membership_to_org()')),false)
 AND coalesce((SELECT prosecdef AND proowner='swarm_admin'::regrole AND proconfig=ARRAY['search_path=pg_catalog']
 AND md5(prosrc)='3b40b82f97acc4b9687e2d1d9004f2d3'
 AND NOT has_function_privilege('anon',oid,'EXECUTE') AND NOT has_function_privilege('authenticated',oid,'EXECUTE')
 AND NOT has_function_privilege('swarm_read',oid,'EXECUTE') AND has_function_privilege('swarm_command',oid,'EXECUTE')
 FROM pg_proc WHERE oid=to_regprocedure('swarm.org_allows_workspace_create(uuid,uuid)')),false)
 AND coalesce((SELECT prosecdef AND proowner='swarm_admin'::regrole AND proconfig=ARRAY['search_path=pg_catalog']
 AND md5(prosrc)='4b0e076a71da7d6ed5763f4d93adc881'
 AND NOT has_function_privilege('anon',oid,'EXECUTE') AND NOT has_function_privilege('authenticated',oid,'EXECUTE')
 AND NOT has_function_privilege('swarm_read',oid,'EXECUTE') AND has_function_privilege('swarm_command',oid,'EXECUTE')
 FROM pg_proc WHERE oid=to_regprocedure('swarm.move_workspace_to_org(uuid,uuid,uuid,uuid)')),false)
 AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.organizations') AND attname='generated'
   AND atttypid='boolean'::regtype AND attnotnull AND NOT attisdropped)
 AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('swarm.memberships') AND tgname='memberships_sync_org'
   AND tgenabled='O' AND tgfoid=to_regprocedure('swarm.sync_membership_to_org()'))
 AND coalesce((SELECT relowner='swarm_admin'::regrole AND reloptions @> ARRAY['security_barrier=true']
   AND md5(regexp_replace(pg_get_viewdef(oid),'(swarm[.]|auth[.])','','g'))='99e856f8d8eb75a1b66e93cf96c711e2'
   AND has_table_privilege('authenticated',oid,'SELECT') AND has_table_privilege('swarm_read',oid,'SELECT')
   AND NOT has_table_privilege('anon',oid,'SELECT') FROM pg_class WHERE oid=to_regclass('swarm_read.organizations')),false)
 AND coalesce((SELECT md5(regexp_replace(pg_get_viewdef(oid),'(swarm[.]|auth[.])','','g'))='99e97d4fcb0010d27acbac30455c177b'
   FROM pg_class WHERE oid=to_regclass('swarm_read.workspaces')),false)
 AND NOT has_table_privilege('authenticated','swarm.org_memberships','SELECT')
 AND NOT has_table_privilege('swarm_command','swarm.org_memberships','SELECT') AS catalog_ok
\gset
