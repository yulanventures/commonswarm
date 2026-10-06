-- Apply after the 20261005000001 rollback; verify the migration 015 function body returned.
SELECT coalesce((
SELECT
 has_table_privilege('swarm_command',to_regclass('swarm.household_workspace_boundaries'),'INSERT')=true
 AND NOT has_table_privilege('swarm_command',to_regclass('swarm.household_workspace_boundaries'),'DELETE')
 AND NOT has_table_privilege('swarm_command',to_regclass('swarm.household_workspace_boundaries'),'UPDATE')
 AND (SELECT count(*) FROM pg_trigger WHERE tgrelid=to_regclass('swarm.household_workspace_boundaries') AND tgname='household_permission_audit' AND NOT tgisinternal)=1
 AND NOT has_table_privilege('anon',to_regclass('swarm.household_workspace_boundaries'),'SELECT,INSERT,UPDATE,DELETE')
 AND NOT has_table_privilege('authenticated',to_regclass('swarm.household_workspace_boundaries'),'SELECT,INSERT,UPDATE,DELETE')
 AND NOT has_table_privilege('swarm_read',to_regclass('swarm.household_workspace_boundaries'),'SELECT,INSERT,UPDATE,DELETE')
 AND has_table_privilege('swarm_command',to_regclass('swarm.household_member_content_roles'),'INSERT')=true
 AND NOT has_table_privilege('swarm_command',to_regclass('swarm.household_member_content_roles'),'DELETE')
 AND NOT has_table_privilege('swarm_command',to_regclass('swarm.household_member_content_roles'),'UPDATE')
 AND coalesce((SELECT has_column_privilege('swarm_command',attrelid,attnum,'UPDATE') FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_member_content_roles') AND attname='content_role' AND attnum>0 AND NOT attisdropped),false)=true
 AND coalesce((SELECT has_column_privilege('swarm_command',attrelid,attnum,'UPDATE') FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_member_content_roles') AND attname='content_consent_id' AND attnum>0 AND NOT attisdropped),false)=true
 AND coalesce((SELECT has_column_privilege('swarm_command',attrelid,attnum,'UPDATE') FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_member_content_roles') AND attname='confirmed_at' AND attnum>0 AND NOT attisdropped),false)=true
 AND coalesce((SELECT has_column_privilege('swarm_command',attrelid,attnum,'UPDATE') FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_member_content_roles') AND attname='revoked_at' AND attnum>0 AND NOT attisdropped),false)=true
 AND (SELECT count(*) FROM pg_trigger WHERE tgrelid=to_regclass('swarm.household_member_content_roles') AND tgname='household_permission_audit' AND NOT tgisinternal)=1
 AND NOT has_table_privilege('anon',to_regclass('swarm.household_member_content_roles'),'SELECT,INSERT,UPDATE,DELETE')
 AND NOT has_table_privilege('authenticated',to_regclass('swarm.household_member_content_roles'),'SELECT,INSERT,UPDATE,DELETE')
 AND NOT has_table_privilege('swarm_read',to_regclass('swarm.household_member_content_roles'),'SELECT,INSERT,UPDATE,DELETE')
 AND has_table_privilege('swarm_command',to_regclass('swarm.household_content_connections'),'INSERT')=true
 AND NOT has_table_privilege('swarm_command',to_regclass('swarm.household_content_connections'),'DELETE')
 AND NOT has_table_privilege('swarm_command',to_regclass('swarm.household_content_connections'),'UPDATE')
 AND coalesce((SELECT has_column_privilege('swarm_command',attrelid,attnum,'UPDATE') FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_content_connections') AND attname='operations' AND attnum>0 AND NOT attisdropped),false)=true
 AND coalesce((SELECT has_column_privilege('swarm_command',attrelid,attnum,'UPDATE') FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_content_connections') AND attname='consent_receipt_id' AND attnum>0 AND NOT attisdropped),false)=true
 AND coalesce((SELECT has_column_privilege('swarm_command',attrelid,attnum,'UPDATE') FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_content_connections') AND attname='expires_at' AND attnum>0 AND NOT attisdropped),false)=true
 AND coalesce((SELECT has_column_privilege('swarm_command',attrelid,attnum,'UPDATE') FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_content_connections') AND attname='revoked_at' AND attnum>0 AND NOT attisdropped),false)=true
 AND (SELECT count(*) FROM pg_trigger WHERE tgrelid=to_regclass('swarm.household_content_connections') AND tgname='household_permission_audit' AND NOT tgisinternal)=1
 AND NOT has_table_privilege('anon',to_regclass('swarm.household_content_connections'),'SELECT,INSERT,UPDATE,DELETE')
 AND NOT has_table_privilege('authenticated',to_regclass('swarm.household_content_connections'),'SELECT,INSERT,UPDATE,DELETE')
 AND NOT has_table_privilege('swarm_read',to_regclass('swarm.household_content_connections'),'SELECT,INSERT,UPDATE,DELETE')
 AND to_regprocedure('swarm.audit_household_permission()') IS NOT NULL
 AND (SELECT count(*)=1 AND bool_and(tgenabled='O' AND tgfoid=to_regprocedure('swarm.audit_household_permission()')) FROM pg_trigger WHERE tgrelid=to_regclass('swarm.household_workspace_boundaries') AND tgname='household_permission_audit' AND NOT tgisinternal)
 AND (SELECT bool_and(has_column_privilege('swarm_command',attrelid,attnum,'UPDATE')=(attname=ANY(ARRAY['workspace_id']::text[]))) FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_workspace_boundaries') AND attnum>0 AND NOT attisdropped)
 AND (SELECT relowner=(SELECT oid FROM pg_roles WHERE rolname='swarm_admin') AND relrowsecurity FROM pg_class WHERE oid=to_regclass('swarm.household_workspace_boundaries'))
 AND (SELECT count(*)=1 AND bool_and(tgenabled='O' AND tgfoid=to_regprocedure('swarm.audit_household_permission()')) FROM pg_trigger WHERE tgrelid=to_regclass('swarm.household_member_content_roles') AND tgname='household_permission_audit' AND NOT tgisinternal)
 AND (SELECT bool_and(has_column_privilege('swarm_command',attrelid,attnum,'UPDATE')=(attname=ANY(ARRAY['workspace_id','content_role','content_consent_id','confirmed_at','revoked_at']::text[]))) FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_member_content_roles') AND attnum>0 AND NOT attisdropped)
 AND (SELECT relowner=(SELECT oid FROM pg_roles WHERE rolname='swarm_admin') AND relrowsecurity FROM pg_class WHERE oid=to_regclass('swarm.household_member_content_roles'))
 AND (SELECT count(*)=1 AND bool_and(tgenabled='O' AND tgfoid=to_regprocedure('swarm.audit_household_permission()')) FROM pg_trigger WHERE tgrelid=to_regclass('swarm.household_content_connections') AND tgname='household_permission_audit' AND NOT tgisinternal)
 AND (SELECT bool_and(has_column_privilege('swarm_command',attrelid,attnum,'UPDATE')=(attname=ANY(ARRAY['connection_id','operations','consent_receipt_id','expires_at','revoked_at']::text[]))) FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_content_connections') AND attnum>0 AND NOT attisdropped)
 AND (SELECT relowner=(SELECT oid FROM pg_roles WHERE rolname='swarm_admin') AND relrowsecurity FROM pg_class WHERE oid=to_regclass('swarm.household_content_connections'))
 AND (SELECT proowner=(SELECT oid FROM pg_roles WHERE rolname='swarm_admin') AND NOT prosecdef AND proconfig=ARRAY['search_path=pg_catalog'] AND md5(prosrc)='003c4cdeebd97eb37f75860de7e6ebc4' FROM pg_proc WHERE oid=to_regprocedure('swarm.audit_household_permission()'))
 AND NOT has_function_privilege('anon',to_regprocedure('swarm.audit_household_permission()'),'EXECUTE')
 AND NOT has_function_privilege('authenticated',to_regprocedure('swarm.audit_household_permission()'),'EXECUTE')
 AND NOT has_function_privilege('swarm_read',to_regprocedure('swarm.audit_household_permission()'),'EXECUTE')
 AND NOT has_function_privilege('swarm_command',to_regprocedure('swarm.audit_household_permission()'),'EXECUTE')
 AND NOT EXISTS (SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a WHERE p.oid=to_regprocedure('swarm.audit_household_permission()') AND a.grantee=0)
 AND (SELECT NOT attnotnull FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_content_connections') AND attname='expires_at' AND NOT attisdropped)
 AND (SELECT prosrc LIKE '%household_permissions%' AND prosrc LIKE '%household_approve_connection%' AND prosrc LIKE '%household_withdraw_connection%' AND position('remove_member' in prosrc)=0
      FROM pg_proc WHERE oid=to_regprocedure('swarm.audit_household_permission()'))
 -- No new table/column grantees, grant options, or table-level command privileges.
 AND NOT EXISTS (SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
   WHERE c.oid IN (to_regclass('swarm.household_workspace_boundaries'),to_regclass('swarm.household_member_content_roles'),to_regclass('swarm.household_content_connections'))
    AND (a.grantee NOT IN (c.relowner,(SELECT oid FROM pg_roles WHERE rolname='swarm_command')) OR a.is_grantable
     OR (a.grantee=(SELECT oid FROM pg_roles WHERE rolname='swarm_command') AND a.privilege_type NOT IN ('SELECT','INSERT'))))
 AND NOT EXISTS (SELECT 1 FROM pg_attribute att JOIN pg_class c ON c.oid=att.attrelid CROSS JOIN LATERAL aclexplode(att.attacl) a
   WHERE c.oid IN (to_regclass('swarm.household_workspace_boundaries'),to_regclass('swarm.household_member_content_roles'),to_regclass('swarm.household_content_connections'))
    AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='swarm_command') OR a.is_grantable OR a.privilege_type<>'UPDATE'))

),false) AS rollback_ok
\gset
