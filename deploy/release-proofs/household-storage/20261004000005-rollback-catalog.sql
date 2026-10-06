-- After migration 05 rollback, verify its removal and the retained lane-2 lock grants.
SELECT coalesce((
SELECT
 has_table_privilege('swarm_command',to_regclass('swarm.household_workspace_boundaries'),'INSERT')=false
 AND NOT has_table_privilege('swarm_command',to_regclass('swarm.household_workspace_boundaries'),'DELETE')
 AND NOT has_table_privilege('swarm_command',to_regclass('swarm.household_workspace_boundaries'),'UPDATE')
 AND (SELECT count(*) FROM pg_trigger WHERE tgrelid=to_regclass('swarm.household_workspace_boundaries') AND tgname='household_permission_audit' AND NOT tgisinternal)=0
 AND NOT has_table_privilege('anon',to_regclass('swarm.household_workspace_boundaries'),'SELECT,INSERT,UPDATE,DELETE')
 AND NOT has_table_privilege('authenticated',to_regclass('swarm.household_workspace_boundaries'),'SELECT,INSERT,UPDATE,DELETE')
 AND NOT has_table_privilege('swarm_read',to_regclass('swarm.household_workspace_boundaries'),'SELECT,INSERT,UPDATE,DELETE')
 AND has_table_privilege('swarm_command',to_regclass('swarm.household_member_content_roles'),'INSERT')=false
 AND NOT has_table_privilege('swarm_command',to_regclass('swarm.household_member_content_roles'),'DELETE')
 AND NOT has_table_privilege('swarm_command',to_regclass('swarm.household_member_content_roles'),'UPDATE')
 AND coalesce((SELECT has_column_privilege('swarm_command',attrelid,attnum,'UPDATE') FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_member_content_roles') AND attname='content_role' AND attnum>0 AND NOT attisdropped),false)=false
 AND coalesce((SELECT has_column_privilege('swarm_command',attrelid,attnum,'UPDATE') FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_member_content_roles') AND attname='content_consent_id' AND attnum>0 AND NOT attisdropped),false)=false
 AND coalesce((SELECT has_column_privilege('swarm_command',attrelid,attnum,'UPDATE') FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_member_content_roles') AND attname='confirmed_at' AND attnum>0 AND NOT attisdropped),false)=false
 AND coalesce((SELECT has_column_privilege('swarm_command',attrelid,attnum,'UPDATE') FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_member_content_roles') AND attname='revoked_at' AND attnum>0 AND NOT attisdropped),false)=false
 AND (SELECT count(*) FROM pg_trigger WHERE tgrelid=to_regclass('swarm.household_member_content_roles') AND tgname='household_permission_audit' AND NOT tgisinternal)=0
 AND NOT has_table_privilege('anon',to_regclass('swarm.household_member_content_roles'),'SELECT,INSERT,UPDATE,DELETE')
 AND NOT has_table_privilege('authenticated',to_regclass('swarm.household_member_content_roles'),'SELECT,INSERT,UPDATE,DELETE')
 AND NOT has_table_privilege('swarm_read',to_regclass('swarm.household_member_content_roles'),'SELECT,INSERT,UPDATE,DELETE')
 AND has_table_privilege('swarm_command',to_regclass('swarm.household_content_connections'),'INSERT')=false
 AND NOT has_table_privilege('swarm_command',to_regclass('swarm.household_content_connections'),'DELETE')
 AND NOT has_table_privilege('swarm_command',to_regclass('swarm.household_content_connections'),'UPDATE')
 AND coalesce((SELECT has_column_privilege('swarm_command',attrelid,attnum,'UPDATE') FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_content_connections') AND attname='operations' AND attnum>0 AND NOT attisdropped),false)=false
 AND coalesce((SELECT has_column_privilege('swarm_command',attrelid,attnum,'UPDATE') FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_content_connections') AND attname='consent_receipt_id' AND attnum>0 AND NOT attisdropped),false)=false
 AND coalesce((SELECT has_column_privilege('swarm_command',attrelid,attnum,'UPDATE') FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_content_connections') AND attname='expires_at' AND attnum>0 AND NOT attisdropped),false)=false
 AND coalesce((SELECT has_column_privilege('swarm_command',attrelid,attnum,'UPDATE') FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_content_connections') AND attname='revoked_at' AND attnum>0 AND NOT attisdropped),false)=false
 AND (SELECT count(*) FROM pg_trigger WHERE tgrelid=to_regclass('swarm.household_content_connections') AND tgname='household_permission_audit' AND NOT tgisinternal)=0
 AND NOT has_table_privilege('anon',to_regclass('swarm.household_content_connections'),'SELECT,INSERT,UPDATE,DELETE')
 AND NOT has_table_privilege('authenticated',to_regclass('swarm.household_content_connections'),'SELECT,INSERT,UPDATE,DELETE')
 AND NOT has_table_privilege('swarm_read',to_regclass('swarm.household_content_connections'),'SELECT,INSERT,UPDATE,DELETE')
 AND has_table_privilege('swarm_command',to_regclass('swarm.household_workspace_boundaries'),'SELECT')
 AND (SELECT bool_and(has_column_privilege('swarm_command',attrelid,attnum,'UPDATE')=(attname='workspace_id')) FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_workspace_boundaries') AND attnum>0 AND NOT attisdropped)
 AND has_table_privilege('swarm_command',to_regclass('swarm.household_member_content_roles'),'SELECT')
 AND (SELECT bool_and(has_column_privilege('swarm_command',attrelid,attnum,'UPDATE')=(attname='workspace_id')) FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_member_content_roles') AND attnum>0 AND NOT attisdropped)
 AND has_table_privilege('swarm_command',to_regclass('swarm.household_content_connections'),'SELECT')
 AND (SELECT bool_and(has_column_privilege('swarm_command',attrelid,attnum,'UPDATE')=(attname='connection_id')) FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_content_connections') AND attnum>0 AND NOT attisdropped)
 AND to_regprocedure('swarm.audit_household_permission()') IS NULL
),false) AS rollback_ok
\gset
