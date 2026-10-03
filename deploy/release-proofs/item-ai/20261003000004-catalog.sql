-- Independent checksum catalog; no evidence rows are seeded.
SELECT COALESCE((
  EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('commonswarm_ops.guard_migration_checksums()')
    AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.prosecdef=false AND p.prorettype='trigger'::regtype AND NOT p.proretset AND p.provolatile='v'
    AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)='e51e29b34a77085ba77b4b843ad557df'
    AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      WHERE a.grantee<>p.proowner AND (a.privilege_type<>'EXECUTE' OR a.is_grantable OR NOT EXISTS(
        SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND false)))
    AND (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)=0)
  -- Reader ownership stays with the applying ledger-capable migration role.
  -- No ownership or GRANT OPTION on the ledger is required or conferred.
  AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('commonswarm_ops.migration_ledger_versions()')
    AND p.prosecdef AND p.provolatile='s' AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='sql')
    AND p.prorettype='text'::regtype AND p.proretset AND p.pronargs=0
    AND p.proargnames=ARRAY['version']::text[] AND p.proargmodes=ARRAY['t']::"char"[]
    AND p.proallargtypes=ARRAY['text'::regtype]::oid[]
    AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)='8ab4ccbfda27e2c295a79ee201cebef6'
    AND pg_has_role(p.proowner,'swarm_admin'::regrole,'USAGE')
    AND has_schema_privilege(p.proowner,'supabase_migrations','USAGE')
    AND has_table_privilege(p.proowner,'supabase_migrations.schema_migrations','SELECT')
    AND has_function_privilege('swarm_admin',p.oid,'EXECUTE')
    AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      WHERE a.grantee<>p.proowner AND (a.grantee<>'swarm_admin'::regrole OR a.privilege_type<>'EXECUTE' OR a.is_grantable))
    AND (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)
      =CASE WHEN p.proowner='swarm_admin'::regrole THEN 0 ELSE 1 END)
  AND to_regprocedure('commonswarm_ops.migration_checksum_failures(jsonb)') IS NULL
  AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('commonswarm_ops.migration_checksum_failures()')
    AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.prosecdef=true AND p.prorettype='record'::regtype AND p.proretset AND p.provolatile='s'
    AND p.pronargs=0 AND p.proargnames=ARRAY['version','required_sha256','recorded_sha256','reason']::text[]
    AND p.proargmodes=ARRAY['t','t','t','t']::"char"[]
    AND p.proallargtypes=ARRAY['text'::regtype,'text'::regtype,'text'::regtype,'text'::regtype]::oid[]
    AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)='d12b90c84d3fe4b6e57ca47babbffdd8'
    AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      WHERE a.grantee<>p.proowner AND (a.privilege_type<>'EXECUTE' OR a.is_grantable OR NOT EXISTS(
        SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY['commonswarm_oauth_runtime','swarm_command']::text[]))))
    AND (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)=2)
  AND EXISTS(SELECT 1 FROM pg_namespace n WHERE nspname='commonswarm_ops' AND nspowner='swarm_admin'::regrole
    AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a WHERE a.grantee<>n.nspowner
      AND (a.is_grantable OR a.privilege_type<>'USAGE' OR a.grantee NOT IN
        ('commonswarm_admin_release'::regrole,'commonswarm_oauth_runtime'::regrole,'swarm_command'::regrole))))
  AND EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=to_regclass('commonswarm_ops.migration_checksums')
    AND c.relkind='r' AND c.relowner='swarm_admin'::regrole AND c.relrowsecurity AND NOT c.relforcerowsecurity
    AND (SELECT array_agg(a.attname::text ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped)
      =ARRAY['version','sha256','applied_at','source','released_sha']::text[]
    AND (SELECT array_agg(format_type(a.atttypid,a.atttypmod) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped)
      =ARRAY['text','text','timestamp with time zone','text','text']::text[]
    AND NOT EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped AND NOT a.attnotnull)
    AND (SELECT count(*) FROM pg_constraint WHERE conrelid=c.oid AND contype='p' AND convalidated AND conkey=ARRAY[1]::smallint[])=1
    AND (SELECT count(*) FROM pg_constraint WHERE conrelid=c.oid AND contype='c' AND convalidated)=3
    AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=c.oid AND contype='c' AND regexp_replace(pg_get_expr(conbin,conrelid),'[[:space:]()]','','g')=$$sha256~'^[0-9a-f]{64}$'::text$$)
    AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=c.oid AND contype='c' AND regexp_replace(pg_get_expr(conbin,conrelid),'[[:space:]()]','','g')=$$released_sha~'^[0-9a-f]{40}$'::text$$)
    AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=c.oid AND contype='c' AND regexp_replace(pg_get_expr(conbin,conrelid),'[[:space:]()]','','g')=$$source=ANYARRAY['release'::text,'backfill'::text]$$)
    AND NOT EXISTS(SELECT 1 FROM pg_index WHERE indrelid=c.oid AND (NOT indisvalid OR NOT indisready))
    AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner AND
      (a.is_grantable OR NOT ((a.grantee='commonswarm_admin_release'::regrole AND a.privilege_type='INSERT')
        OR (a.grantee IN ('commonswarm_oauth_runtime'::regrole,'swarm_command'::regrole) AND a.privilege_type='SELECT'))))
    AND (SELECT count(*) FROM aclexplode(c.relacl) a WHERE a.grantee<>c.relowner)=3)
  AND EXISTS(SELECT 1 FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid=d.adrelid AND a.attnum=d.adnum
    WHERE d.adrelid=to_regclass('commonswarm_ops.migration_checksums') AND a.attname='applied_at' AND pg_get_expr(d.adbin,d.adrelid)='now()')
  AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_ops.migration_checksums')
    AND tgname='migration_checksums_append_only' AND tgenabled='O' AND tgtype=27 AND NOT tgisinternal
    AND tgfoid=to_regprocedure('commonswarm_ops.guard_migration_checksums()'))
  AND (SELECT count(*) FROM pg_policy WHERE polrelid=to_regclass('commonswarm_ops.migration_checksums'))=2
  AND EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=to_regclass('commonswarm_ops.migration_checksums') AND polname='checksum_release_insert'
    AND polcmd='a' AND polroles=ARRAY['commonswarm_admin_release'::regrole]::oid[] AND pg_get_expr(polwithcheck,polrelid)='true')
  AND EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=to_regclass('commonswarm_ops.migration_checksums') AND polname='checksum_runtime_read'
    AND polcmd='r' AND (SELECT array_agg(x ORDER BY x) FROM unnest(polroles) x)
      =(SELECT array_agg(x::oid ORDER BY x::oid) FROM unnest(ARRAY['commonswarm_oauth_runtime'::regrole,'swarm_command'::regrole]) x)
    AND pg_get_expr(polqual,polrelid)='true')
  AND has_schema_privilege('commonswarm_oauth_runtime','commonswarm_ops','USAGE') AND NOT has_schema_privilege('commonswarm_oauth_runtime','commonswarm_ops','CREATE')
  AND has_schema_privilege('swarm_command','commonswarm_ops','USAGE') AND NOT has_schema_privilege('swarm_command','commonswarm_ops','CREATE')
  AND has_schema_privilege('commonswarm_admin_release','commonswarm_ops','USAGE') AND NOT has_schema_privilege('commonswarm_admin_release','commonswarm_ops','CREATE')
),false) AS catalog_ok
\gset
