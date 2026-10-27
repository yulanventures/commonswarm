-- Read-only and safe before the migration; check real definitions and effective ACLs.
SELECT coalesce((SELECT count(*)=2 AND bool_and(relowner='swarm_admin'::regrole AND relrowsecurity
 AND NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
 AND NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid=c.oid))
 FROM pg_class c WHERE oid IN (to_regclass('swarm.organizations'),to_regclass('swarm.org_memberships'))),false)
 AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.workspaces') AND attname='org_id'
   AND attnotnull AND NOT attisdropped AND atttypid='uuid'::regtype)
 AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('swarm.workspaces')
   AND conname='workspaces_org_id_fkey' AND confrelid=to_regclass('swarm.organizations') AND convalidated)
 AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('swarm.workspaces') AND tgname='workspaces_ensure_org'
   AND tgenabled='O' AND tgtype=7 AND tgfoid=to_regprocedure('swarm.ensure_workspace_org()'))
 AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('swarm.memberships') AND tgname='memberships_sync_org'
   AND tgenabled='O' AND tgtype=29 AND tgfoid=to_regprocedure('swarm.sync_membership_to_org()'))
 AND coalesce((SELECT prosecdef AND proowner='swarm_admin'::regrole
 AND proconfig=ARRAY['search_path=pg_catalog'] AND md5(prosrc)='6b1916b81b153429ff80ed4185f25bac'
 AND NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(proacl,acldefault('f',proowner))) a WHERE a.grantee<>proowner)
 FROM pg_proc WHERE oid=to_regprocedure('swarm.ensure_workspace_org()')),false)
 AND coalesce((SELECT prosecdef AND proowner='swarm_admin'::regrole
 AND proconfig=ARRAY['search_path=pg_catalog'] AND md5(prosrc)='9c970d08d1b1ca22362a5b7f0ad46ec0'
 AND NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(proacl,acldefault('f',proowner))) a WHERE a.grantee<>proowner)
 FROM pg_proc WHERE oid=to_regprocedure('swarm.sync_membership_to_org()')),false)
 AND coalesce((SELECT relowner='swarm_admin'::regrole AND reloptions @> ARRAY['security_barrier=true']
 AND md5(regexp_replace(pg_get_viewdef(oid), '(swarm[.]|auth[.])', '', 'g'))='99e97d4fcb0010d27acbac30455c177b'
 AND has_table_privilege('authenticated',oid,'SELECT') AND has_table_privilege('swarm_read',oid,'SELECT')
 AND NOT has_table_privilege('anon',oid,'SELECT')
 FROM pg_class WHERE oid=to_regclass('swarm_read.workspaces')),false)
 AND CASE WHEN to_regclass('swarm.organizations') IS NOT NULL AND to_regclass('swarm.org_memberships') IS NOT NULL
 AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.workspaces') AND attname='org_id' AND NOT attisdropped)
 THEN ((xpath('/row/data_ok/text()',query_to_xml($proof$SELECT
 (SELECT count(*) FROM swarm.organizations) = (SELECT count(*) FROM swarm.workspaces)
 AND NOT EXISTS (SELECT 1 FROM swarm.workspaces w LEFT JOIN swarm.organizations o ON o.id=w.org_id
   WHERE w.org_id IS DISTINCT FROM w.workspace_id OR o.id IS NULL)
 AND NOT EXISTS (
   (SELECT w.org_id, 'user'::text, m.user_id, m.role, m.invited_by, m.joined_at, m.revoked_at
     FROM swarm.memberships m JOIN swarm.workspaces w USING(workspace_id)
    EXCEPT SELECT org_id, principal_kind, principal_id, role, invited_by, created_at, revoked_at FROM swarm.org_memberships)
   UNION ALL
   (SELECT org_id, principal_kind, principal_id, role, invited_by, created_at, revoked_at FROM swarm.org_memberships
    EXCEPT SELECT w.org_id, 'user'::text, m.user_id, m.role, m.invited_by, m.joined_at, m.revoked_at
     FROM swarm.memberships m JOIN swarm.workspaces w USING(workspace_id))) AS data_ok$proof$,false,true,'')))[1]::text)::boolean
 ELSE false END AS catalog_ok
\gset
