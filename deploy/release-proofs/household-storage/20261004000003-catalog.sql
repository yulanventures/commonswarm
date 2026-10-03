-- Exact owned relation set, column order, constraints, RLS and least privilege.
-- Missing objects yield catalog_ok=f, rather than a regclass cast failure.
WITH expected(name,columns,can_update,fks,checks,uniques) AS (VALUES
('household_object_bindings',ARRAY['workspace_id','object_id','file_id']::text[],false,2,1,2),
('household_object_artifacts',ARRAY['workspace_id','object_id','version_id','file_id','storage_path','size_bytes','sha256','state','revision_token','reservation_id','draft_id']::text[],true,2,4,2)
), actual AS (
 SELECT e.*,c.oid,c.relowner,c.relkind,c.relrowsecurity,c.relforcerowsecurity
 FROM expected e LEFT JOIN pg_class c ON c.oid=to_regclass('swarm.'||e.name)
)
SELECT coalesce((SELECT count(*)=2 AND bool_and(
 oid IS NOT NULL AND relkind='r' AND pg_get_userbyid(relowner)='swarm_admin'
 AND relrowsecurity AND NOT relforcerowsecurity
 AND (SELECT array_agg(a.attname::text ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=t.oid AND a.attnum>0 AND NOT a.attisdropped)=columns
 AND (SELECT count(*) FROM pg_constraint WHERE conrelid=t.oid AND contype='p')=1
 AND (SELECT count(*) FROM pg_constraint WHERE conrelid=t.oid AND contype='f')=fks
 AND (SELECT count(*) FROM pg_constraint WHERE conrelid=t.oid AND contype='c')=checks
 AND (SELECT count(*) FROM pg_constraint WHERE conrelid=t.oid AND contype='u')=uniques
 AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=t.oid AND NOT convalidated)
 AND NOT EXISTS (SELECT 1 FROM pg_index WHERE indrelid=t.oid AND (NOT indisvalid OR NOT indisready))
 AND (SELECT count(*) FROM pg_policy WHERE polrelid=t.oid)=1
 AND EXISTS (SELECT 1 FROM pg_policy WHERE polrelid=t.oid AND polname='swarm_command_all' AND polpermissive AND polcmd='*'
   AND polroles=ARRAY[(SELECT oid FROM pg_roles WHERE rolname='swarm_command')]
   AND pg_get_expr(polqual,polrelid)='true' AND pg_get_expr(polwithcheck,polrelid)='true')
 AND has_table_privilege('swarm_command',oid,'SELECT') AND has_table_privilege('swarm_command',oid,'INSERT')
 AND has_table_privilege('swarm_command',oid,'UPDATE')=can_update
 AND NOT EXISTS (SELECT 1 FROM (VALUES ('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) p(privilege) WHERE has_table_privilege('swarm_command',oid,p.privilege))
 AND NOT EXISTS (SELECT 1 FROM (VALUES ('swarm_read'),('anon'),('authenticated')) r(name)
   CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) p(privilege)
   WHERE has_table_privilege(r.name,oid,p.privilege))
 AND NOT EXISTS (SELECT 1 FROM aclexplode(coalesce((SELECT relacl FROM pg_class WHERE oid=t.oid),acldefault('r',relowner))) a WHERE a.grantee=0)
 AND NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=t.oid AND attnum>0 AND NOT attisdropped AND attacl IS NOT NULL)
 ) FROM actual t),false)
 AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.files') AND attname='household_managed' AND atttypid='boolean'::regtype AND attnotnull AND NOT attisdropped)
 AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('swarm.file_versions') AND conname='household_version_tenant' AND contype='u' AND convalidated)
 AND EXISTS (SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('swarm.household_object_artifacts_reservation') AND indisvalid AND indisready)
 AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_object_bindings') AND attname='workspace_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=true)
 AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_object_bindings') AND attname='object_id' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
 AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_object_bindings') AND attname='file_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=true)
 AND EXISTS (SELECT 1 FROM pg_constraint c WHERE conrelid=to_regclass('swarm.household_object_bindings') AND contype='f' AND confrelid=to_regclass('swarm.files') AND convalidated
 AND (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(n,ord) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.n)=ARRAY['file_id','workspace_id']::text[]
 AND (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.confkey) WITH ORDINALITY k(n,ord) JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.n)=ARRAY['file_id','workspace_id']::text[])
 AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_object_artifacts') AND attname='workspace_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=true)
 AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_object_artifacts') AND attname='object_id' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
 AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_object_artifacts') AND attname='version_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=true)
 AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_object_artifacts') AND attname='file_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=true)
 AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_object_artifacts') AND attname='storage_path' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
 AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_object_artifacts') AND attname='size_bytes' AND NOT attisdropped AND atttypid='bigint'::regtype AND attnotnull=true)
 AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_object_artifacts') AND attname='sha256' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
 AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_object_artifacts') AND attname='state' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
 AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_object_artifacts') AND attname='revision_token' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=false)
 AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_object_artifacts') AND attname='reservation_id' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=false)
 AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_object_artifacts') AND attname='draft_id' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=false)
 AND EXISTS (SELECT 1 FROM pg_constraint c WHERE conrelid=to_regclass('swarm.household_object_artifacts') AND contype='f' AND confrelid=to_regclass('swarm.household_object_bindings') AND convalidated
 AND (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(n,ord) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.n)=ARRAY['workspace_id','object_id','file_id']::text[]
 AND (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.confkey) WITH ORDINALITY k(n,ord) JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.n)=ARRAY['workspace_id','object_id','file_id']::text[])
 AND EXISTS (SELECT 1 FROM pg_constraint c WHERE conrelid=to_regclass('swarm.household_object_artifacts') AND contype='f' AND confrelid=to_regclass('swarm.file_versions') AND convalidated
 AND (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(n,ord) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.n)=ARRAY['version_id','file_id','workspace_id']::text[]
 AND (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.confkey) WITH ORDINALITY k(n,ord) JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.n)=ARRAY['version_id','file_id','workspace_id']::text[])
 AND coalesce((SELECT pg_get_userbyid(proowner)='swarm_admin' AND NOT prosecdef AND proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(prosrc)='c871426b2bc2294a345f117f4504d6ae'
 AND NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(proacl,acldefault('f',proowner))) a WHERE a.grantee=0)
 AND NOT EXISTS (SELECT 1 FROM (VALUES ('swarm_command'),('swarm_read'),('anon'),('authenticated')) r(name) WHERE has_function_privilege(r.name,p.oid,'EXECUTE'))
 FROM pg_proc p WHERE oid=to_regprocedure('swarm.guard_household_artifact_settlement()')),false)
 AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('swarm.household_object_artifacts') AND tgname='household_artifact_settlement' AND NOT tgisinternal AND tgenabled='O' AND tgtype=27 AND tgfoid=to_regprocedure('swarm.guard_household_artifact_settlement()'))
 AS catalog_ok
\gset
