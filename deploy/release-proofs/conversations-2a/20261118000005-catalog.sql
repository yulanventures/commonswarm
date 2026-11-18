-- Read-only catalog and body verification for 20261118000005 (conversations, step 2a: commands, conversation
-- posts, membership upkeep, per-person live updates). Every function's owner, definer flag, search_path and body;
-- the edge (swarm_command) may call exactly the ten command functions and no client role anything; the Realtime
-- sender is postgres's, callable by swarm_admin only; the new triggers; the workspace topic's emitter is gone.
SELECT (SELECT count(*)=28 AND bool_and(p.proowner=e.owner::regrole AND p.prosecdef
   AND p.proconfig=ARRAY['search_path=pg_catalog'] AND md5(p.prosrc)=e.digest AND p.proacl IS NOT NULL
   AND NOT EXISTS(SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee<>p.proowner
     AND NOT (e.grantee IS NOT NULL AND a.grantee=e.grantee::regrole AND a.privilege_type='EXECUTE'))
   AND (e.grantee IS NULL OR EXISTS(SELECT 1 FROM aclexplode(p.proacl) a
     WHERE a.grantee=e.grantee::regrole AND a.privilege_type='EXECUTE')))
 FROM (VALUES
  ('swarm.conversation_member_join(uuid,uuid,text,uuid)','6f18e7e66da61a24a88e20d61dd2d887','swarm_admin',NULL),
  ('swarm.conversation_member_leave(uuid,text,uuid)','030c208c7defdccc27f1c7ade8f2598d','swarm_admin',NULL),
  ('swarm.conversation_target(uuid,text,uuid,uuid)','5d1d8a65aef281cfee3167e6847e9657','swarm_admin',NULL),
  ('swarm.conversation_departed_name(uuid)','1d03e41bebad93d50832bc9dbe8e9574','swarm_admin',NULL),
  ('swarm.conversation_member_key(uuid[],uuid[])','d3e00bd65903cb56d17ace12569db4d2','swarm_admin',NULL),
  ('swarm.conversation_next_generation(uuid,text,uuid)','b8eefd114cb97c9bb07f3e069bbf7013','swarm_admin',NULL),
  ('swarm.conversation_live_members(uuid)','eab25de6be2a8e9dad9fe3e0828209b7','swarm_admin',NULL),
  ('swarm.conversation_open(uuid,text,uuid,uuid[],uuid[],boolean)','d17b70b07a31f355bd8719eec60833eb','swarm_admin','swarm_command'),
  ('swarm.conversation_join(uuid,text,uuid,uuid)','b97cd4bdf0a7a76c61bdd3759f8bb1f2','swarm_admin','swarm_command'),
  ('swarm.conversation_leave(uuid,text,uuid,uuid)','017350da546c8a7a7437ff3d624e8c19','swarm_admin','swarm_command'),
  ('swarm.conversation_invite(uuid,text,uuid,uuid,uuid[],uuid[])','a68823893a0cfd92218893463b49866b','swarm_admin','swarm_command'),
  ('swarm.conversation_remove(uuid,text,uuid,uuid,text,uuid)','8a3e025667b8c768c7e9e759b7477c8d','swarm_admin','swarm_command'),
  ('swarm.conversation_mark_read(uuid,text,uuid,uuid,uuid)','ab4bd18e2bbf172f1a918187f600953e','swarm_admin','swarm_command'),
  ('swarm.conversation_set_notify(uuid,text,uuid,uuid,text,boolean,integer)','e1ad6b47f2d4c34c0a7579f44cdcee15','swarm_admin','swarm_command'),
  ('swarm.conversation_post_route(uuid,text,uuid,uuid,uuid[],uuid[])','8d1d36c77acdef46be352c2b18141a46','swarm_admin','swarm_command'),
  ('swarm.conversation_prefile(uuid,uuid,uuid)','69ce250ee38007021a6268b6a726e041','swarm_admin','swarm_command'),
  ('swarm.conversation_group_departed(uuid,text,uuid,uuid[],uuid[])','7e969427560459b4229f7ed929d87ea4','swarm_admin','swarm_command'),
  ('swarm.conversation_check_route(uuid,uuid,uuid)','4d34bc77e3e0ef54228c7be3fd3d095f','swarm_admin',NULL),
  ('swarm.signal_frame_readers(uuid,uuid)','5fe7eae02cb8f00baa6b07360615951a','swarm_admin',NULL),
  ('swarm.send_signal_frames(uuid,uuid)','b31d19c2812248b4773b08629b3ef21d','postgres','swarm_admin'),
  ('swarm.conversation_lock_workspace(uuid)','4b4dee8fd30274c4e6a0c980bdacd360','swarm_admin',NULL),
  ('swarm.conversation_person_upkeep()','b0492c8c9166e6986ba6d7bc4ce3b168','swarm_admin',NULL),
  ('swarm.conversation_agent_upkeep()','94de6a575bb202bdc6951840ba04745d','swarm_admin',NULL),
  ('swarm.conversation_creator_joins()','3033897f675ad85b0f74a5ca6939acf4','swarm_admin',NULL),
  ('swarm.conversation_reads_follow()','e63b7489ebd4a1ecad71f0a3260cd29c','swarm_admin',NULL),
  ('swarm.conversation_preferences_follow()','1f2f286619531b7eb44774535ecdb8c4','swarm_admin',NULL),
  ('swarm.file_conversation_signal(uuid,uuid)','f650beca97fd09f67a91dcc33cf5a917','swarm_admin',NULL),
  ('swarm.file_signal_conversation_at_commit()','4ec98f28b6941f865cd68d5d2e69bb40','swarm_admin',NULL)
 ) e(signature,digest,owner,grantee) JOIN pg_proc p ON p.oid=to_regprocedure(e.signature))
 AND (SELECT p.proowner='postgres'::regrole AND p.prosecdef AND p.proconfig=ARRAY['search_path=pg_catalog']
   AND md5(p.prosrc)='3d713b65e190a79bbdd8bf70e391c504' FROM pg_proc p WHERE p.oid=to_regprocedure('swarm.push_signal_reaction()'))
 AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['swarm.conversation_member_join(uuid,uuid,text,uuid)','swarm.conversation_member_leave(uuid,text,uuid)','swarm.conversation_target(uuid,text,uuid,uuid)','swarm.conversation_departed_name(uuid)','swarm.conversation_member_key(uuid[],uuid[])','swarm.conversation_next_generation(uuid,text,uuid)','swarm.conversation_live_members(uuid)','swarm.conversation_open(uuid,text,uuid,uuid[],uuid[],boolean)','swarm.conversation_join(uuid,text,uuid,uuid)','swarm.conversation_leave(uuid,text,uuid,uuid)','swarm.conversation_invite(uuid,text,uuid,uuid,uuid[],uuid[])','swarm.conversation_remove(uuid,text,uuid,uuid,text,uuid)','swarm.conversation_mark_read(uuid,text,uuid,uuid,uuid)','swarm.conversation_set_notify(uuid,text,uuid,uuid,text,boolean,integer)','swarm.conversation_post_route(uuid,text,uuid,uuid,uuid[],uuid[])','swarm.conversation_prefile(uuid,uuid,uuid)','swarm.conversation_group_departed(uuid,text,uuid,uuid[],uuid[])','swarm.conversation_check_route(uuid,uuid,uuid)','swarm.signal_frame_readers(uuid,uuid)','swarm.send_signal_frames(uuid,uuid)','swarm.conversation_lock_workspace(uuid)','swarm.conversation_person_upkeep()','swarm.conversation_agent_upkeep()','swarm.conversation_creator_joins()','swarm.conversation_reads_follow()','swarm.conversation_preferences_follow()','swarm.push_signal_reaction()']) f(sig)
  CROSS JOIN unnest(ARRAY['anon','authenticated','swarm_read']) r(role) WHERE has_function_privilege(r.role,f.sig,'EXECUTE'))
 AND (SELECT count(*)=10 FROM unnest(ARRAY['swarm.conversation_member_join(uuid,uuid,text,uuid)','swarm.conversation_member_leave(uuid,text,uuid)','swarm.conversation_target(uuid,text,uuid,uuid)','swarm.conversation_departed_name(uuid)','swarm.conversation_member_key(uuid[],uuid[])','swarm.conversation_next_generation(uuid,text,uuid)','swarm.conversation_live_members(uuid)','swarm.conversation_open(uuid,text,uuid,uuid[],uuid[],boolean)','swarm.conversation_join(uuid,text,uuid,uuid)','swarm.conversation_leave(uuid,text,uuid,uuid)','swarm.conversation_invite(uuid,text,uuid,uuid,uuid[],uuid[])','swarm.conversation_remove(uuid,text,uuid,uuid,text,uuid)','swarm.conversation_mark_read(uuid,text,uuid,uuid,uuid)','swarm.conversation_set_notify(uuid,text,uuid,uuid,text,boolean,integer)','swarm.conversation_post_route(uuid,text,uuid,uuid,uuid[],uuid[])','swarm.conversation_prefile(uuid,uuid,uuid)','swarm.conversation_group_departed(uuid,text,uuid,uuid[],uuid[])','swarm.conversation_check_route(uuid,uuid,uuid)','swarm.signal_frame_readers(uuid,uuid)','swarm.send_signal_frames(uuid,uuid)','swarm.conversation_lock_workspace(uuid)','swarm.conversation_person_upkeep()','swarm.conversation_agent_upkeep()','swarm.conversation_creator_joins()','swarm.conversation_reads_follow()','swarm.conversation_preferences_follow()']) f(sig) WHERE has_function_privilege('swarm_command',f.sig,'EXECUTE'))
 AND (SELECT count(*)=7 FROM pg_trigger t JOIN (VALUES
   ('swarm.memberships','memberships_conversation_upkeep','swarm.conversation_person_upkeep()'),
   ('swarm.agent_workspace_memberships','agent_workspace_memberships_conversation_upkeep','swarm.conversation_agent_upkeep()'),
   ('swarm.agent_principals','agent_principals_conversation_upkeep','swarm.conversation_agent_upkeep()'),
   ('swarm.channels','channels_sync_creator_member','swarm.conversation_creator_joins()'),
   ('swarm.human_channel_reads','human_channel_reads_follow_conversation','swarm.conversation_reads_follow()'),
   ('swarm.agent_channel_reads','agent_channel_reads_follow_conversation','swarm.conversation_reads_follow()'),
   ('swarm.channel_preferences','channel_preferences_follow_conversation','swarm.conversation_preferences_follow()')
  ) e(rel,name,fn) ON t.tgrelid=to_regclass(e.rel) AND t.tgname=e.name AND t.tgfoid=to_regprocedure(e.fn)
  WHERE NOT t.tgisinternal AND t.tgenabled='O' AND NOT t.tgdeferrable AND (t.tgtype & 1)=1)
 AND (SELECT count(*)=3 FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgenabled='O' AND t.tginitdeferred
   AND t.tgfoid=to_regprocedure('swarm.file_signal_conversation_at_commit()'))
 AND EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid='swarm.signal_reactions'::regclass AND t.tgname='signal_reactions_push'
   AND t.tgfoid=to_regprocedure('swarm.push_signal_reaction()') AND t.tgenabled='O')
 AND to_regprocedure('swarm.wake_workspace_signal()') IS NULL
 AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='swarm.signals'::regclass AND tgname='signals_wake_workspace')
 AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['swarm.conversations','swarm.conversation_members','swarm.conversation_signals','swarm.conversation_reads']) t(name)
  CROSS JOIN unnest(ARRAY['anon','authenticated','swarm_read','swarm_command']) r(role)
  CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p(priv)
  WHERE has_table_privilege(r.role,t.name,p.priv))
 AS catalog_ok
\gset
