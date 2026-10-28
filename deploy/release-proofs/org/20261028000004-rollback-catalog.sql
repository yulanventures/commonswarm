SELECT coalesce((SELECT prosecdef AND proowner='swarm_admin'::regrole AND proconfig=ARRAY['search_path=pg_catalog']
 AND md5(prosrc)='aa7469ba80a2c8ac3872ba1903127ad7'
 AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(proacl,acldefault('f',proowner))) a
   WHERE a.privilege_type='EXECUTE' AND a.grantee<>proowner)
 FROM pg_proc WHERE oid=to_regprocedure('swarm.ensure_workspace_org()')),false)
 AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('swarm.workspaces')
   AND tgfoid=to_regprocedure('swarm.ensure_workspace_org()') AND tgenabled='O' AND tgtype=7)
 AS rollback_ok
\gset
