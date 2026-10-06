-- Exact owned relation set, column order, constraints, RLS and least privilege.
-- Missing objects yield catalog_ok=f, rather than a regclass cast failure.
SELECT coalesce((
WITH expected(name,columns,lock_column,fks,checks,uniques) AS (VALUES
('household_workspace_boundaries',ARRAY['workspace_id','purpose','owner_user_id']::text[],'workspace_id',2,2,0),
('household_member_content_roles',ARRAY['workspace_id','user_id','content_role','content_consent_id','confirmed_at','revoked_at']::text[],'workspace_id',1,1,0),
('household_content_connections',ARRAY['connection_id','grant_id','workspace_id','principal_id','owner_user_id','purpose','operations','consent_receipt_id','expires_at','revoked_at','hosted_grant_id']::text[],'connection_id',3,3,0)
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
 AND has_table_privilege('swarm_command',oid,'SELECT') AND NOT has_table_privilege('swarm_command',oid,'INSERT')
 AND NOT has_table_privilege('swarm_command',oid,'UPDATE')
 AND NOT EXISTS (SELECT 1 FROM (VALUES ('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) p(privilege) WHERE has_table_privilege('swarm_command',oid,p.privilege))
 AND NOT EXISTS (SELECT 1 FROM (VALUES ('swarm_read'),('anon'),('authenticated')) r(name)
   CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) p(privilege)
   WHERE has_table_privilege(r.name,oid,p.privilege))
 AND NOT EXISTS (SELECT 1 FROM aclexplode(coalesce((SELECT relacl FROM pg_class WHERE oid=t.oid),acldefault('r',relowner))) a WHERE a.grantee=0)
 -- FOR SHARE accepts one column's UPDATE. Pin exactly that nongrantable ACL,
 -- and reject column-level INSERT/UPDATE widening as well as table grants.
 AND (SELECT count(*) FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) acl
   WHERE a.attrelid=t.oid AND a.attnum>0 AND NOT a.attisdropped)=1
 AND EXISTS (SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) acl
   WHERE a.attrelid=t.oid AND a.attname=lock_column AND NOT a.attisdropped
   AND acl.grantee=(SELECT oid FROM pg_roles WHERE rolname='swarm_command')
   AND acl.privilege_type='UPDATE' AND NOT acl.is_grantable)
 AND NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=t.oid AND a.attnum>0 AND NOT a.attisdropped
   AND has_column_privilege('swarm_command',t.oid,a.attnum,'UPDATE')<>(a.attname=lock_column))
 ) FROM actual t),false)
 AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_workspace_boundaries') AND attname='workspace_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=true)
 AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_workspace_boundaries') AND attname='purpose' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
 AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_workspace_boundaries') AND attname='owner_user_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=false)
 AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_member_content_roles') AND attname='workspace_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=true)
 AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_member_content_roles') AND attname='user_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=true)
 AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_member_content_roles') AND attname='content_role' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
 AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_member_content_roles') AND attname='content_consent_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=true)
 AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_member_content_roles') AND attname='confirmed_at' AND NOT attisdropped AND atttypid='timestamptz'::regtype AND attnotnull=true)
 AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_member_content_roles') AND attname='revoked_at' AND NOT attisdropped AND atttypid='timestamptz'::regtype AND attnotnull=false)
 AND EXISTS (SELECT 1 FROM pg_constraint c WHERE conrelid=to_regclass('swarm.household_member_content_roles') AND contype='f' AND confrelid=to_regclass('swarm.memberships') AND convalidated
 AND (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(n,ord) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.n)=ARRAY['workspace_id','user_id']::text[]
 AND (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.confkey) WITH ORDINALITY k(n,ord) JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.n)=ARRAY['workspace_id','user_id']::text[])
 AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_content_connections') AND attname='connection_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=true)
 AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_content_connections') AND attname='grant_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=true)
 AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_content_connections') AND attname='workspace_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=true)
 AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_content_connections') AND attname='principal_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=true)
 AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_content_connections') AND attname='owner_user_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=true)
 AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_content_connections') AND attname='purpose' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
 AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_content_connections') AND attname='operations' AND NOT attisdropped AND atttypid='text[]'::regtype AND attnotnull=true)
 AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_content_connections') AND attname='consent_receipt_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=true)
 AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_content_connections') AND attname='expires_at' AND NOT attisdropped AND atttypid='timestamptz'::regtype AND attnotnull=true)
 AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_content_connections') AND attname='revoked_at' AND NOT attisdropped AND atttypid='timestamptz'::regtype AND attnotnull=false)
 AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_content_connections') AND attname='hosted_grant_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=false)
 AND EXISTS (SELECT 1 FROM pg_constraint c WHERE conrelid=to_regclass('swarm.household_content_connections') AND contype='f' AND confrelid=to_regclass('swarm.agent_principals') AND convalidated
 AND (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(n,ord) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.n)=ARRAY['principal_id','workspace_id','owner_user_id']::text[]
 AND (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.confkey) WITH ORDINALITY k(n,ord) JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.n)=ARRAY['principal_id','workspace_id','owner_user_id']::text[])
 AND EXISTS (SELECT 1 FROM pg_constraint c WHERE conrelid=to_regclass('swarm.household_content_connections') AND contype='f' AND confrelid=to_regclass('swarm.household_member_content_roles') AND convalidated
 AND (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(n,ord) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.n)=ARRAY['workspace_id','owner_user_id']::text[]
 AND (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.confkey) WITH ORDINALITY k(n,ord) JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.n)=ARRAY['workspace_id','user_id']::text[])

),false) AS catalog_ok
\gset
