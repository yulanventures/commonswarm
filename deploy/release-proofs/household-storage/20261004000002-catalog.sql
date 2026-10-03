-- Exact owned relation set, column order, constraints, RLS and least privilege.
-- Missing objects yield catalog_ok=f, rather than a regclass cast failure.
WITH expected(name,columns,can_select,can_update,fks,checks,uniques) AS (VALUES
('household_object_streams',ARRAY['workspace_id','stream_id','last_seq','projection']::text[],true,true,1,2,1),
('household_object_events',ARRAY['workspace_id','seq','event_id','event']::text[],false,false,1,3,1),
('household_object_audit',ARRAY['audit_id','workspace_id','command_id','actor_user','actor_principal','occurred_at','command_kind','request_digest','outcome','reason_code']::text[],false,false,1,1,0)
), actual AS (
 SELECT e.*,c.oid,c.relowner,c.relkind,c.relrowsecurity,c.relforcerowsecurity
 FROM expected e LEFT JOIN pg_class c ON c.oid=to_regclass('swarm.'||e.name)
)
SELECT coalesce((SELECT count(*)=3 AND bool_and(
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
 AND has_table_privilege('swarm_command',oid,'SELECT')=can_select AND has_table_privilege('swarm_command',oid,'INSERT')
 AND has_table_privilege('swarm_command',oid,'UPDATE')=can_update
 AND NOT EXISTS (SELECT 1 FROM (VALUES ('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) p(privilege) WHERE has_table_privilege('swarm_command',oid,p.privilege))
 AND NOT EXISTS (SELECT 1 FROM (VALUES ('swarm_read'),('anon'),('authenticated')) r(name)
   CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) p(privilege)
   WHERE has_table_privilege(r.name,oid,p.privilege))
 AND NOT EXISTS (SELECT 1 FROM aclexplode(coalesce((SELECT relacl FROM pg_class WHERE oid=t.oid),acldefault('r',relowner))) a WHERE a.grantee=0)
 AND NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=t.oid AND attnum>0 AND NOT attisdropped AND attacl IS NOT NULL)
 ) FROM actual t),false)
 AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('swarm.household_object_events') AND tgname='household_object_events_append_only' AND NOT tgisinternal AND tgenabled='O' AND tgfoid=to_regprocedure('swarm.prevent_append_only_mutation()') AND tgtype=27)
 AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('swarm.household_object_audit') AND tgname='household_object_audit_append_only' AND NOT tgisinternal AND tgenabled='O' AND tgfoid=to_regprocedure('swarm.prevent_append_only_mutation()') AND tgtype=27)
 AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_object_streams') AND attname='workspace_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=true)
 AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_object_streams') AND attname='stream_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=true)
 AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_object_streams') AND attname='last_seq' AND NOT attisdropped AND atttypid='bigint'::regtype AND attnotnull=true)
 AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_object_streams') AND attname='projection' AND NOT attisdropped AND atttypid='jsonb'::regtype AND attnotnull=true)
 AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_object_events') AND attname='workspace_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=true)
 AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_object_events') AND attname='seq' AND NOT attisdropped AND atttypid='bigint'::regtype AND attnotnull=true)
 AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_object_events') AND attname='event_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=true)
 AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_object_events') AND attname='event' AND NOT attisdropped AND atttypid='jsonb'::regtype AND attnotnull=true)
 AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_object_audit') AND attname='audit_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=true)
 AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_object_audit') AND attname='workspace_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=true)
 AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_object_audit') AND attname='command_id' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
 AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_object_audit') AND attname='actor_user' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=true)
 AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_object_audit') AND attname='actor_principal' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=false)
 AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_object_audit') AND attname='occurred_at' AND NOT attisdropped AND atttypid='timestamptz'::regtype AND attnotnull=true)
 AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_object_audit') AND attname='command_kind' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
 AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_object_audit') AND attname='request_digest' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
 AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_object_audit') AND attname='outcome' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
 AS catalog_ok
\gset
