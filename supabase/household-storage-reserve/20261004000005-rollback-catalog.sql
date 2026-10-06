-- After migration 05 rollback, verify its removal and the retained lane-2 lock grants.
SELECT
 has_table_privilege('swarm_command','swarm.household_workspace_boundaries','INSERT')=false
 AND NOT has_table_privilege('swarm_command','swarm.household_workspace_boundaries','DELETE')
 AND NOT has_table_privilege('swarm_command','swarm.household_workspace_boundaries','UPDATE')
 AND (SELECT count(*) FROM pg_trigger WHERE tgrelid='swarm.household_workspace_boundaries'::regclass AND tgname='household_permission_audit' AND NOT tgisinternal)=0
 AND NOT has_table_privilege('anon','swarm.household_workspace_boundaries','SELECT,INSERT,UPDATE,DELETE')
 AND NOT has_table_privilege('authenticated','swarm.household_workspace_boundaries','SELECT,INSERT,UPDATE,DELETE')
 AND NOT has_table_privilege('swarm_read','swarm.household_workspace_boundaries','SELECT,INSERT,UPDATE,DELETE')
 AND has_table_privilege('swarm_command','swarm.household_member_content_roles','INSERT')=false
 AND NOT has_table_privilege('swarm_command','swarm.household_member_content_roles','DELETE')
 AND NOT has_table_privilege('swarm_command','swarm.household_member_content_roles','UPDATE')
 AND has_column_privilege('swarm_command','swarm.household_member_content_roles','content_role','UPDATE')=false
 AND has_column_privilege('swarm_command','swarm.household_member_content_roles','content_consent_id','UPDATE')=false
 AND has_column_privilege('swarm_command','swarm.household_member_content_roles','confirmed_at','UPDATE')=false
 AND has_column_privilege('swarm_command','swarm.household_member_content_roles','revoked_at','UPDATE')=false
 AND (SELECT count(*) FROM pg_trigger WHERE tgrelid='swarm.household_member_content_roles'::regclass AND tgname='household_permission_audit' AND NOT tgisinternal)=0
 AND NOT has_table_privilege('anon','swarm.household_member_content_roles','SELECT,INSERT,UPDATE,DELETE')
 AND NOT has_table_privilege('authenticated','swarm.household_member_content_roles','SELECT,INSERT,UPDATE,DELETE')
 AND NOT has_table_privilege('swarm_read','swarm.household_member_content_roles','SELECT,INSERT,UPDATE,DELETE')
 AND has_table_privilege('swarm_command','swarm.household_content_connections','INSERT')=false
 AND NOT has_table_privilege('swarm_command','swarm.household_content_connections','DELETE')
 AND NOT has_table_privilege('swarm_command','swarm.household_content_connections','UPDATE')
 AND has_column_privilege('swarm_command','swarm.household_content_connections','operations','UPDATE')=false
 AND has_column_privilege('swarm_command','swarm.household_content_connections','consent_receipt_id','UPDATE')=false
 AND has_column_privilege('swarm_command','swarm.household_content_connections','expires_at','UPDATE')=false
 AND has_column_privilege('swarm_command','swarm.household_content_connections','revoked_at','UPDATE')=false
 AND (SELECT count(*) FROM pg_trigger WHERE tgrelid='swarm.household_content_connections'::regclass AND tgname='household_permission_audit' AND NOT tgisinternal)=0
 AND NOT has_table_privilege('anon','swarm.household_content_connections','SELECT,INSERT,UPDATE,DELETE')
 AND NOT has_table_privilege('authenticated','swarm.household_content_connections','SELECT,INSERT,UPDATE,DELETE')
 AND NOT has_table_privilege('swarm_read','swarm.household_content_connections','SELECT,INSERT,UPDATE,DELETE')
 AND has_table_privilege('swarm_command','swarm.household_workspace_boundaries','SELECT')
 AND (SELECT bool_and(has_column_privilege('swarm_command',attrelid,attnum,'UPDATE')=(attname='workspace_id')) FROM pg_attribute WHERE attrelid='swarm.household_workspace_boundaries'::regclass AND attnum>0 AND NOT attisdropped)
 AND has_table_privilege('swarm_command','swarm.household_member_content_roles','SELECT')
 AND (SELECT bool_and(has_column_privilege('swarm_command',attrelid,attnum,'UPDATE')=(attname='workspace_id')) FROM pg_attribute WHERE attrelid='swarm.household_member_content_roles'::regclass AND attnum>0 AND NOT attisdropped)
 AND has_table_privilege('swarm_command','swarm.household_content_connections','SELECT')
 AND (SELECT bool_and(has_column_privilege('swarm_command',attrelid,attnum,'UPDATE')=(attname='connection_id')) FROM pg_attribute WHERE attrelid='swarm.household_content_connections'::regclass AND attnum>0 AND NOT attisdropped)
 AND to_regprocedure('swarm.audit_household_permission()') IS NULL AS rollback_ok
\gset
