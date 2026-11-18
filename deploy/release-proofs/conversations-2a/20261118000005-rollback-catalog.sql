-- Read-only rollback catalog verification for 20261118000005: every function and trigger it added is gone;
-- step 1's filer and commit trigger function, the reaction push and the workspace topic's emitter (with its
-- trigger) are back with their original bodies and owners.
SELECT NOT EXISTS(SELECT 1 FROM unnest(ARRAY['swarm.conversation_member_join(uuid,uuid,text,uuid)','swarm.conversation_member_leave(uuid,text,uuid)','swarm.conversation_target(uuid,text,uuid,uuid)','swarm.conversation_departed_name(uuid)','swarm.conversation_member_key(uuid[],uuid[])','swarm.conversation_next_generation(uuid,text,uuid)','swarm.conversation_live_members(uuid)','swarm.conversation_open(uuid,text,uuid,uuid[],uuid[],boolean)','swarm.conversation_join(uuid,text,uuid,uuid)','swarm.conversation_leave(uuid,text,uuid,uuid)','swarm.conversation_invite(uuid,text,uuid,uuid,uuid[],uuid[])','swarm.conversation_remove(uuid,text,uuid,uuid,text,uuid)','swarm.conversation_mark_read(uuid,text,uuid,uuid,uuid)','swarm.conversation_set_notify(uuid,text,uuid,uuid,text,boolean,integer)','swarm.conversation_post_route(uuid,text,uuid,uuid,uuid[],uuid[])','swarm.conversation_prefile(uuid,uuid,uuid)','swarm.conversation_group_departed(uuid,text,uuid,uuid[],uuid[])','swarm.conversation_check_route(uuid,uuid,uuid)','swarm.signal_frame_readers(uuid,uuid)','swarm.conversation_visible(uuid,text,uuid,uuid)','swarm.conversation_private_member_lock()','swarm.send_signal_frames(uuid,uuid)','swarm.conversation_lock_workspace(uuid)','swarm.conversation_person_upkeep()','swarm.conversation_agent_upkeep()','swarm.conversation_creator_joins()','swarm.conversation_reads_follow()','swarm.conversation_preferences_follow()']) f(sig) WHERE to_regprocedure(f.sig) IS NOT NULL)
 AND NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN (VALUES
   ('swarm.memberships','memberships_conversation_upkeep'),
   ('swarm.agent_workspace_memberships','agent_workspace_memberships_apply_conversations'),
   ('swarm.agent_principals','agent_principals_apply_conversations'),
   ('swarm.channels','channels_sync_creator_member'),
   ('swarm.human_channel_reads','human_channel_reads_follow_conversation'),
   ('swarm.agent_channel_reads','agent_channel_reads_follow_conversation'),
   ('swarm.channel_preferences','channel_preferences_follow_conversation'),
   ('swarm.channel_members','channel_members_lock_conversation')
  ) e(rel,name) ON t.tgrelid=to_regclass(e.rel) AND t.tgname=e.name WHERE NOT t.tgisinternal)
 AND (SELECT count(*)=4 AND bool_and(p.proowner=e.owner::regrole AND p.prosecdef AND md5(p.prosrc)=e.digest)
  FROM (VALUES
   ('swarm.file_conversation_signal(uuid,uuid)','0c110a11b77e30fd80bbe4a799d7fb7d','swarm_admin'),
   ('swarm.file_signal_conversation_at_commit()','3159a89424d1560a542452625b37be96','swarm_admin'),
   ('swarm.push_signal_reaction()','bf8e5b98d21d2421a610b50cabc26655','postgres'),
   ('swarm.wake_workspace_signal()','54688e6b14e4709e65647a057f6cde9e','postgres')
  ) e(signature,digest,owner) JOIN pg_proc p ON p.oid=to_regprocedure(e.signature))
 AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='swarm.signals'::regclass AND tgname='signals_wake_workspace'
   AND tgfoid=to_regprocedure('swarm.wake_workspace_signal()') AND tgenabled='O' AND NOT tgisinternal)
 AND (SELECT count(*)=3 FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgenabled='O' AND t.tginitdeferred
   AND t.tgfoid=to_regprocedure('swarm.file_signal_conversation_at_commit()'))
 AS rollback_ok
\gset
