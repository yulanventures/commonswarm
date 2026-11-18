-- Read-only catalog and body verification for 20261118000002 (conversations, step 1 of real direct messages).
SELECT (SELECT count(*)=3 AND bool_and(p.proowner='swarm_admin'::regrole AND p.prosecdef AND p.proconfig=ARRAY['search_path=pg_catalog'] AND md5(p.prosrc)=e.digest)
 FROM (VALUES
  ('swarm.conversation_signal_guard()','8244c37161390531dc874a3f16ba66e0'),
  ('swarm.conversation_for_members(uuid,text,uuid,uuid[],uuid[])','aaf60fb9e3715c41afad7090e59386ab'),
  ('swarm.file_direct_messages()','bf2c1af7095e6ded6cc9e1a985f338ee')
 ) e(signature,digest) JOIN pg_proc p ON p.oid=to_regprocedure(e.signature))
 AND (SELECT count(*)=3 AND bool_and(c.relowner='swarm_admin'::regrole AND c.relrowsecurity AND NOT c.relforcerowsecurity)
  FROM pg_class c WHERE c.oid IN (to_regclass('swarm.conversations'),to_regclass('swarm.conversation_members'),to_regclass('swarm.conversation_signals')))
 AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['swarm.conversations','swarm.conversation_members','swarm.conversation_signals']) t(name)
  CROSS JOIN unnest(ARRAY['anon','authenticated','swarm_read','swarm_command']) r(role)
  CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p(priv)
  WHERE has_table_privilege(r.role,t.name,p.priv))
 AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['swarm.conversation_for_members(uuid,text,uuid,uuid[],uuid[])','swarm.file_direct_messages()']) f(sig)
  CROSS JOIN unnest(ARRAY['anon','authenticated','swarm_read','swarm_command']) r(role)
  WHERE has_function_privilege(r.role,f.sig,'EXECUTE'))
 AND (SELECT count(*)=2 FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='O' AND (tgrelid,tgname,tgfoid) IN (
   ('swarm.conversation_signals'::regclass,'conversation_signals_append_only',to_regprocedure('swarm.prevent_append_only_mutation()')),
   ('swarm.conversation_signals'::regclass,'conversation_signals_guard',to_regprocedure('swarm.conversation_signal_guard()'))))
 AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='swarm.conversation_signals'::regclass AND contype='f' AND confrelid='swarm.signals'::regclass)
 AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='swarm.conversations'::regclass AND contype='u'
   AND conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='swarm.conversations'::regclass AND attname='workspace_id'),
     (SELECT attnum FROM pg_attribute WHERE attrelid='swarm.conversations'::regclass AND attname='member_key')]::int2[])
 AND to_regclass('swarm.conversation_signals_page') IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='swarm.signals'::regclass AND attname='conversation_id' AND NOT attisdropped)
 AS catalog_ok
\gset
