-- Read-only catalog and body verification for 20261117000002 (channel leads).
SELECT (SELECT count(*)=5 AND bool_and(p.proowner='swarm_admin'::regrole AND p.prosecdef AND p.proconfig=ARRAY['search_path=pg_catalog'] AND md5(p.prosrc)=e.digest)
 FROM (VALUES
  ('swarm.channel_effective_live_lead(uuid,uuid)','c1c6325eeff17d5d4dc7d61bfdf65319'),
  ('swarm.reset_channel_lead_on_principal_revoke()','035766faacad4ced4f8156657bfeed68'),
  ('swarm.reset_channel_lead_on_agent_exit()','e898b4c04f798ee5b52ea6c3a0f3bb07'),
  ('swarm.reset_channel_lead_on_owner_exit()','44138a75e25ea6ed7a611a42d8d9e8fb'),
  ('swarm.reset_channel_lead_on_member_removal()','9370edc2bac8a2ea45af000d82fe2df3')
 ) e(signature,digest) JOIN pg_proc p ON p.oid=to_regprocedure(e.signature))
 AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='swarm.channels'::regclass AND attname='lead_mode' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull)
 AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='swarm.channels'::regclass AND attname='lead_agent_principal_id' AND NOT attisdropped AND atttypid='uuid'::regtype)
 AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='swarm.channels'::regclass AND contype='f' AND confrelid='swarm.agent_principals'::regclass
   AND conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='swarm.channels'::regclass AND attname='lead_agent_principal_id')])
 AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='swarm.channels'::regclass AND conname='channels_lead_mode_check' AND contype='c')
 AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='swarm.channels'::regclass AND conname='channels_lead_agent_named_check' AND contype='c')
 AND has_function_privilege('swarm_command','swarm.channel_effective_live_lead(uuid,uuid)','EXECUTE')
 AND NOT has_function_privilege('swarm_read','swarm.channel_effective_live_lead(uuid,uuid)','EXECUTE')
 AND NOT has_function_privilege('authenticated','swarm.channel_effective_live_lead(uuid,uuid)','EXECUTE')
 AND NOT has_function_privilege('anon','swarm.channel_effective_live_lead(uuid,uuid)','EXECUTE')
 AND NOT has_function_privilege('swarm_command','swarm.reset_channel_lead_on_member_removal()','EXECUTE')
 AND (SELECT count(*)=4 FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='O' AND (tgrelid,tgname,tgfoid) IN (
   ('swarm.agent_principals'::regclass,'agent_principals_reset_channel_lead',to_regprocedure('swarm.reset_channel_lead_on_principal_revoke()')),
   ('swarm.agent_workspace_memberships'::regclass,'agent_workspace_memberships_reset_channel_lead',to_regprocedure('swarm.reset_channel_lead_on_agent_exit()')),
   ('swarm.memberships'::regclass,'memberships_reset_channel_lead',to_regprocedure('swarm.reset_channel_lead_on_owner_exit()')),
   ('swarm.channel_members'::regclass,'channel_members_reset_channel_lead',to_regprocedure('swarm.reset_channel_lead_on_member_removal()'))))
 AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='swarm_read.channels'::regclass AND attname='lead_mode' AND attnum=11 AND NOT attisdropped)
 AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='swarm_read.channels'::regclass AND attname='lead_agent_principal_id' AND attnum=12 AND NOT attisdropped)
 AND has_table_privilege('authenticated','swarm_read.channels','SELECT')
 AND NOT has_table_privilege('anon','swarm_read.channels','SELECT')
 AND (SELECT relowner='swarm_admin'::regrole AND reloptions @> ARRAY['security_barrier=true'] FROM pg_class WHERE oid='swarm_read.channels'::regclass)
 AS catalog_ok
\gset
