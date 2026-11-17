-- Read-only rollback catalog verification for 20261117000001.
SELECT NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='swarm.channels'::regclass AND attname IN ('lead_mode','lead_agent_principal_id') AND NOT attisdropped)
 AND to_regprocedure('swarm.channel_effective_live_lead(uuid,uuid)') IS NULL
 AND to_regprocedure('swarm.reset_channel_lead_on_principal_revoke()') IS NULL
 AND to_regprocedure('swarm.reset_channel_lead_on_agent_exit()') IS NULL
 AND to_regprocedure('swarm.reset_channel_lead_on_owner_exit()') IS NULL
 AND to_regprocedure('swarm.reset_channel_lead_on_member_removal()') IS NULL
 AND NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='swarm_read.channels'::regclass AND attname IN ('lead_mode','lead_agent_principal_id') AND NOT attisdropped)
 AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='swarm_read.channels'::regclass AND attname='visibility' AND attnum=10 AND NOT attisdropped)
 AND has_table_privilege('authenticated','swarm_read.channels','SELECT')
 AND has_table_privilege('swarm_read','swarm_read.channels','SELECT')
 AND NOT has_table_privilege('anon','swarm_read.channels','SELECT')
 AND (SELECT relowner='swarm_admin'::regrole AND reloptions @> ARRAY['security_barrier=true'] FROM pg_class WHERE oid='swarm_read.channels'::regclass)
 AS rollback_ok
\gset
