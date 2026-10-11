-- Error-safe catalog proof: no casts to missing objects. Exact privilege,
-- column, policy, constraint-count and view contract inventories.
WITH expected(name,columns,checks,fks) AS (VALUES
 ('agent_avatars',ARRAY['principal_id','workspace_id','object_prefix','content_type','byte_size','width','height','sha256','source','generation','person_locked','source_ref','set_by_user_id','set_by_principal_id','set_at']::text[],3,4),
 ('agent_avatar_jobs',ARRAY['job_id','principal_id','workspace_id','generation','quarantine_key','source','requested_by_user_id','requested_by_principal_id','state','refusal_code','created_at','declared_at','completed_at']::text[],7,4),
 ('agent_model_provenance',ARRAY['principal_id','workspace_id','model_set_by','set_by_user_id','set_at']::text[],2,3)), tables AS (
 SELECT c.oid IS NOT NULL AND c.relkind='r' AND c.relowner=(SELECT oid FROM pg_roles WHERE rolname='swarm_admin') AND c.relrowsecurity
 AND (SELECT array_agg(attname::text ORDER BY attnum)=e.columns FROM pg_attribute WHERE attrelid=c.oid AND attnum>0 AND NOT attisdropped)
 AND (SELECT count(*)=1 AND bool_and(polroles=ARRAY[(SELECT oid FROM pg_roles WHERE rolname='swarm_command')]
   AND polcmd='*' AND pg_get_expr(polqual,polrelid)='true' AND pg_get_expr(polwithcheck,polrelid)='true') FROM pg_policy WHERE polrelid=c.oid)
 AND (SELECT count(*)=e.checks FROM pg_constraint WHERE conrelid=c.oid AND contype='c' AND convalidated)
 AND (SELECT count(*)=e.fks FROM pg_constraint WHERE conrelid=c.oid AND contype='f' AND convalidated)
 AND (SELECT count(*)=1 FROM pg_constraint WHERE conrelid=c.oid AND contype='p' AND convalidated)
 AND (SELECT array_agg(privilege_type ORDER BY privilege_type)=ARRAY['INSERT','SELECT','UPDATE']::text[]
  FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) WHERE grantee=(SELECT oid FROM pg_roles WHERE rolname='swarm_command'))
 AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
  WHERE a.grantee NOT IN(c.relowner,(SELECT oid FROM pg_roles WHERE rolname='swarm_command')) OR a.is_grantable)
 AND NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=c.oid AND attnum>0 AND attacl IS NOT NULL) AS ok
 FROM expected e LEFT JOIN pg_class c ON c.oid=to_regclass('swarm.'||e.name)
), view_check AS (
 SELECT c.oid IS NOT NULL AND c.relkind='v' AND c.relowner=(SELECT oid FROM pg_roles WHERE rolname='swarm_admin')
 AND 'security_barrier=true'=ANY(c.reloptions)
 AND (SELECT array_agg(attname::text ORDER BY attnum)=ARRAY['principal_id','avatar_version','avatar_source','model_set_by','verified_family','app_host']::text[]
   FROM pg_attribute WHERE attrelid=c.oid AND attnum>0 AND NOT attisdropped)
 AND position('swarm.is_member(p.workspace_id, auth.uid())' IN pg_get_viewdef(c.oid))>0
 AND position('NULL::text AS verified_family' IN pg_get_viewdef(c.oid))>0
 AND position('NULL::text AS app_host' IN pg_get_viewdef(c.oid))>0
 AND (SELECT count(*)=2 AND bool_and(privilege_type='SELECT' AND NOT is_grantable)
   FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) WHERE grantee<>c.relowner)
 AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner)))
   WHERE grantee NOT IN(c.relowner,(SELECT oid FROM pg_roles WHERE rolname='authenticated'),(SELECT oid FROM pg_roles WHERE rolname='swarm_read')))
 AS ok FROM pg_class c WHERE c.oid=to_regclass('swarm_read.agent_identity_marks')
)
SELECT (SELECT count(*)=3 AND coalesce(bool_and(ok),false) FROM tables)
 AND (SELECT count(*)=1 AND coalesce(bool_and(ok),false) FROM view_check) AS catalog_ok
\gset
