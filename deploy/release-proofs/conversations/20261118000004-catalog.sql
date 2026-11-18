-- Read-only catalog and body verification for 20261118000004 (conversations, step 1: schema, filing, backfill; inert).
SELECT (SELECT count(*)=12 AND bool_and(p.proowner='swarm_admin'::regrole AND p.prosecdef=e.definer
   AND p.proconfig=ARRAY['search_path=pg_catalog'] AND md5(p.prosrc)=e.digest
   AND p.proacl IS NOT NULL AND NOT EXISTS(SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee<>p.proowner))
 FROM (VALUES
  ('swarm.conversation_identity_guard()','1401ceb7a09e951b3481148311a10c93',false),
  ('swarm.conversation_member_guard()','51f88bd59982be8a40135a3a068a5f01',true),
  ('swarm.conversation_signal_guard()','dc4077f580aadee53438c8f506e82ea5',true),
  ('swarm.conversation_general(uuid)','579e5b502c496c93eb6ce2796f11e3d3',true),
  ('swarm.conversation_for_channel(uuid,uuid)','8dcb7a05d17875131479ef5f584458be',true),
  ('swarm.conversation_for_members(uuid,text,uuid,uuid[],uuid[],boolean,timestamptz)','6dc8e99a1a0b94fd3bf9d3e3f896cf77',true),
  ('swarm.conversation_placement(uuid,uuid,boolean)','8076976b324b7d892294f6ccc9ca8030',true),
  ('swarm.file_conversation_signal(uuid,uuid)','0c110a11b77e30fd80bbe4a799d7fb7d',true),
  ('swarm.file_signal_conversation_at_commit()','3159a89424d1560a542452625b37be96',true),
  ('swarm.create_workspace_general()','f802577ca48071e623ed8d82a45079f5',true),
  ('swarm.sync_channel_conversation()','639234d3c3e4586f8a7dfbe6b1227a03',true),
  ('swarm.conversations_backfill()','05776ee76fcf6657e5a6a20d18181d23',true)
 ) e(signature,digest,definer) JOIN pg_proc p ON p.oid=to_regprocedure(e.signature))
 AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['swarm.conversation_identity_guard()','swarm.conversation_member_guard()','swarm.conversation_signal_guard()','swarm.conversation_general(uuid)','swarm.conversation_for_channel(uuid,uuid)','swarm.conversation_for_members(uuid,text,uuid,uuid[],uuid[],boolean,timestamptz)','swarm.conversation_placement(uuid,uuid,boolean)','swarm.file_conversation_signal(uuid,uuid)','swarm.file_signal_conversation_at_commit()','swarm.create_workspace_general()','swarm.sync_channel_conversation()','swarm.conversations_backfill()']) f(sig)
  CROSS JOIN unnest(ARRAY['anon','authenticated','swarm_read','swarm_command']) r(role)
  WHERE has_function_privilege(r.role,f.sig,'EXECUTE'))
 AND (SELECT count(*)=4 AND bool_and(c.relowner='swarm_admin'::regrole AND c.relrowsecurity AND NOT c.relforcerowsecurity
   AND NOT EXISTS(SELECT 1 FROM pg_policy pol WHERE pol.polrelid=c.oid)
   AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner))
  FROM pg_class c WHERE c.oid IN (to_regclass('swarm.conversations'),to_regclass('swarm.conversation_members'),
   to_regclass('swarm.conversation_signals'),to_regclass('swarm.conversation_reads')))
 AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['swarm.conversations','swarm.conversation_members','swarm.conversation_signals','swarm.conversation_reads']) t(name)
  CROSS JOIN unnest(ARRAY['anon','authenticated','swarm_read','swarm_command']) r(role)
  CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p(priv)
  WHERE has_table_privilege(r.role,t.name,p.priv))
 AND (SELECT count(*)=9 FROM pg_trigger t JOIN (VALUES
   ('swarm.conversations','conversations_identity_fixed','swarm.conversation_identity_guard()',false),
   ('swarm.conversation_members','conversation_members_not_private','swarm.conversation_member_guard()',false),
   ('swarm.conversation_signals','conversation_signals_append_only','swarm.prevent_append_only_mutation()',false),
   ('swarm.conversation_signals','conversation_signals_guard','swarm.conversation_signal_guard()',false),
   ('swarm.conversation_signals','conversation_signals_settle','swarm.file_signal_conversation_at_commit()',true),
   ('swarm.signals','signals_settle_conversation','swarm.file_signal_conversation_at_commit()',true),
   ('swarm.signal_recipients','signal_recipients_settle_conversation','swarm.file_signal_conversation_at_commit()',true),
   ('swarm.workspaces','workspaces_create_general','swarm.create_workspace_general()',false),
   ('swarm.channels','channels_sync_conversation','swarm.sync_channel_conversation()',false)
  ) e(rel,name,fn,deferred) ON t.tgrelid=to_regclass(e.rel) AND t.tgname=e.name AND t.tgfoid=to_regprocedure(e.fn)
  WHERE NOT t.tgisinternal AND t.tgenabled='O' AND t.tgdeferrable=e.deferred AND t.tginitdeferred=e.deferred
   AND (t.tgtype & 1)=1 AND (e.deferred = (t.tgconstraint <> 0)))
 AND (SELECT count(*)=2 FROM pg_constraint WHERE conrelid='swarm.conversation_signals'::regclass AND contype='f'
   AND confrelid IN ('swarm.signals'::regclass,'swarm.conversations'::regclass) AND array_length(conkey,1)=2)
 AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='swarm.conversations'::regclass AND contype='f'
   AND confrelid='swarm.channels'::regclass AND array_length(conkey,1)=2)
 AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='swarm.conversations'::regclass AND contype='u'
   AND conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='swarm.conversations'::regclass AND attname='workspace_id'),
     (SELECT attnum FROM pg_attribute WHERE attrelid='swarm.conversations'::regclass AND attname='member_key'),
     (SELECT attnum FROM pg_attribute WHERE attrelid='swarm.conversations'::regclass AND attname='generation')]::int2[])
 AND EXISTS(SELECT 1 FROM pg_index i WHERE i.indexrelid=to_regclass('swarm.conversations_one_general') AND i.indisunique)
 AND to_regclass('swarm.conversation_signals_page') IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='swarm.signals'::regclass AND attname='conversation_id' AND NOT attisdropped)
 AS catalog_ok
\gset
