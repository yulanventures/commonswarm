-- Apply after migration 015; verify unchanged grants and approval/withdrawal trigger body.
SELECT
 has_table_privilege('swarm_command','swarm.household_workspace_boundaries','INSERT')=true
 AND NOT has_table_privilege('swarm_command','swarm.household_workspace_boundaries','DELETE')
 AND NOT has_table_privilege('swarm_command','swarm.household_workspace_boundaries','UPDATE')
 AND (SELECT count(*) FROM pg_trigger WHERE tgrelid='swarm.household_workspace_boundaries'::regclass AND tgname='household_permission_audit' AND NOT tgisinternal)=1
 AND NOT has_table_privilege('anon','swarm.household_workspace_boundaries','SELECT,INSERT,UPDATE,DELETE')
 AND NOT has_table_privilege('authenticated','swarm.household_workspace_boundaries','SELECT,INSERT,UPDATE,DELETE')
 AND NOT has_table_privilege('swarm_read','swarm.household_workspace_boundaries','SELECT,INSERT,UPDATE,DELETE')
 AND has_table_privilege('swarm_command','swarm.household_member_content_roles','INSERT')=true
 AND NOT has_table_privilege('swarm_command','swarm.household_member_content_roles','DELETE')
 AND NOT has_table_privilege('swarm_command','swarm.household_member_content_roles','UPDATE')
 AND has_column_privilege('swarm_command','swarm.household_member_content_roles','content_role','UPDATE')=true
 AND has_column_privilege('swarm_command','swarm.household_member_content_roles','content_consent_id','UPDATE')=true
 AND has_column_privilege('swarm_command','swarm.household_member_content_roles','confirmed_at','UPDATE')=true
 AND has_column_privilege('swarm_command','swarm.household_member_content_roles','revoked_at','UPDATE')=true
 AND (SELECT count(*) FROM pg_trigger WHERE tgrelid='swarm.household_member_content_roles'::regclass AND tgname='household_permission_audit' AND NOT tgisinternal)=1
 AND NOT has_table_privilege('anon','swarm.household_member_content_roles','SELECT,INSERT,UPDATE,DELETE')
 AND NOT has_table_privilege('authenticated','swarm.household_member_content_roles','SELECT,INSERT,UPDATE,DELETE')
 AND NOT has_table_privilege('swarm_read','swarm.household_member_content_roles','SELECT,INSERT,UPDATE,DELETE')
 AND has_table_privilege('swarm_command','swarm.household_content_connections','INSERT')=true
 AND NOT has_table_privilege('swarm_command','swarm.household_content_connections','DELETE')
 AND NOT has_table_privilege('swarm_command','swarm.household_content_connections','UPDATE')
 AND has_column_privilege('swarm_command','swarm.household_content_connections','operations','UPDATE')=true
 AND has_column_privilege('swarm_command','swarm.household_content_connections','consent_receipt_id','UPDATE')=true
 AND has_column_privilege('swarm_command','swarm.household_content_connections','expires_at','UPDATE')=true
 AND has_column_privilege('swarm_command','swarm.household_content_connections','revoked_at','UPDATE')=true
 AND (SELECT count(*) FROM pg_trigger WHERE tgrelid='swarm.household_content_connections'::regclass AND tgname='household_permission_audit' AND NOT tgisinternal)=1
 AND NOT has_table_privilege('anon','swarm.household_content_connections','SELECT,INSERT,UPDATE,DELETE')
 AND NOT has_table_privilege('authenticated','swarm.household_content_connections','SELECT,INSERT,UPDATE,DELETE')
 AND NOT has_table_privilege('swarm_read','swarm.household_content_connections','SELECT,INSERT,UPDATE,DELETE')
 AND to_regprocedure('swarm.audit_household_permission()') IS NOT NULL
 AND (SELECT count(*)=1 AND bool_and(tgenabled='O' AND tgfoid='swarm.audit_household_permission()'::regprocedure) FROM pg_trigger WHERE tgrelid='swarm.household_workspace_boundaries'::regclass AND tgname='household_permission_audit' AND NOT tgisinternal)
 AND (SELECT bool_and(has_column_privilege('swarm_command',attrelid,attnum,'UPDATE')=(attname=ANY(ARRAY['workspace_id']::text[]))) FROM pg_attribute WHERE attrelid='swarm.household_workspace_boundaries'::regclass AND attnum>0 AND NOT attisdropped)
 AND (SELECT relowner=(SELECT oid FROM pg_roles WHERE rolname='swarm_admin') AND relrowsecurity FROM pg_class WHERE oid='swarm.household_workspace_boundaries'::regclass)
 AND (SELECT count(*)=1 AND bool_and(tgenabled='O' AND tgfoid='swarm.audit_household_permission()'::regprocedure) FROM pg_trigger WHERE tgrelid='swarm.household_member_content_roles'::regclass AND tgname='household_permission_audit' AND NOT tgisinternal)
 AND (SELECT bool_and(has_column_privilege('swarm_command',attrelid,attnum,'UPDATE')=(attname=ANY(ARRAY['workspace_id','content_role','content_consent_id','confirmed_at','revoked_at']::text[]))) FROM pg_attribute WHERE attrelid='swarm.household_member_content_roles'::regclass AND attnum>0 AND NOT attisdropped)
 AND (SELECT relowner=(SELECT oid FROM pg_roles WHERE rolname='swarm_admin') AND relrowsecurity FROM pg_class WHERE oid='swarm.household_member_content_roles'::regclass)
 AND (SELECT count(*)=1 AND bool_and(tgenabled='O' AND tgfoid='swarm.audit_household_permission()'::regprocedure) FROM pg_trigger WHERE tgrelid='swarm.household_content_connections'::regclass AND tgname='household_permission_audit' AND NOT tgisinternal)
 AND (SELECT bool_and(has_column_privilege('swarm_command',attrelid,attnum,'UPDATE')=(attname=ANY(ARRAY['connection_id','operations','consent_receipt_id','expires_at','revoked_at']::text[]))) FROM pg_attribute WHERE attrelid='swarm.household_content_connections'::regclass AND attnum>0 AND NOT attisdropped)
 AND (SELECT relowner=(SELECT oid FROM pg_roles WHERE rolname='swarm_admin') AND relrowsecurity FROM pg_class WHERE oid='swarm.household_content_connections'::regclass)
 AND (SELECT proowner=(SELECT oid FROM pg_roles WHERE rolname='swarm_admin') AND NOT prosecdef AND proconfig=ARRAY['search_path=pg_catalog'] AND md5(prosrc)='003c4cdeebd97eb37f75860de7e6ebc4' FROM pg_proc WHERE oid='swarm.audit_household_permission()'::regprocedure)
 AND NOT has_function_privilege('anon','swarm.audit_household_permission()','EXECUTE')
 AND NOT has_function_privilege('authenticated','swarm.audit_household_permission()','EXECUTE')
 AND NOT has_function_privilege('swarm_read','swarm.audit_household_permission()','EXECUTE')
 AND NOT has_function_privilege('swarm_command','swarm.audit_household_permission()','EXECUTE')
 AND NOT EXISTS (SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a WHERE p.oid='swarm.audit_household_permission()'::regprocedure AND a.grantee=0)
 AND (SELECT NOT attnotnull FROM pg_attribute WHERE attrelid='swarm.household_content_connections'::regclass AND attname='expires_at' AND NOT attisdropped)
 AND (SELECT prosrc LIKE '%household_permissions%' AND prosrc LIKE '%household_approve_connection%' AND prosrc LIKE '%household_withdraw_connection%'
      FROM pg_proc WHERE oid='swarm.audit_household_permission()'::regprocedure)
 -- No new table/column grantees, grant options, or table-level command privileges.
 AND NOT EXISTS (SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
   WHERE c.oid IN ('swarm.household_workspace_boundaries'::regclass,'swarm.household_member_content_roles'::regclass,'swarm.household_content_connections'::regclass)
    AND (a.grantee NOT IN (c.relowner,(SELECT oid FROM pg_roles WHERE rolname='swarm_command')) OR a.is_grantable
     OR (a.grantee=(SELECT oid FROM pg_roles WHERE rolname='swarm_command') AND a.privilege_type NOT IN ('SELECT','INSERT'))))
 AND NOT EXISTS (SELECT 1 FROM pg_attribute att JOIN pg_class c ON c.oid=att.attrelid CROSS JOIN LATERAL aclexplode(att.attacl) a
   WHERE c.oid IN ('swarm.household_workspace_boundaries'::regclass,'swarm.household_member_content_roles'::regclass,'swarm.household_content_connections'::regclass)
    AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='swarm_command') OR a.is_grantable OR a.privilege_type<>'UPDATE'))
 AS catalog_ok
\gset
