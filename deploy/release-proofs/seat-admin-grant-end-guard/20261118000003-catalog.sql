-- Read-only catalog and body verification for 20261118000003 (seat admin grant end guard).
SELECT (SELECT count(*)=5 AND bool_and(p.proowner='swarm_admin'::regrole AND p.prosecdef=e.definer AND p.provolatile=e.volatility::"char"
   AND p.proconfig=ARRAY['search_path=pg_catalog'] AND md5(p.prosrc)=e.digest)
 FROM (VALUES
  ('swarm.seat_admin_grants_end_guard()',true,'v','0464bcf9480d721f98b78bdc93d19435'),
  ('swarm.seat_admin_grant_end_actor(uuid,uuid)',false,'s','ede802ab44d0574a1d243a6cb25a6209'),
  ('swarm.agent_seat_admin_self_ended(bytea,uuid)',true,'v','5b08e1d3a15594fe633086c8647b5f20'),
  ('swarm.agent_seat_admin_self(bytea,uuid)',true,'v','10f48cae6f710f79d2c18bbc92fe1a87'),
  ('swarm_read.my_seat_admin_grants()',true,'s','e68687e0c2b440c1f109dff87231271d')
 ) e(signature,definer,volatility,digest) JOIN pg_proc p ON p.oid=to_regprocedure(e.signature))
 AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='swarm.seat_admin_grants'::regclass AND attname='ended_by_user_id'
   AND NOT attisdropped AND atttypid='uuid'::regtype AND NOT attnotnull)
 AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='swarm.seat_admin_grants'::regclass AND conname='seat_admin_grants_ended_by_check' AND contype='c')
 AND (SELECT count(*)=2 FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='O' AND (tgrelid,tgname,tgfoid) IN (
   ('swarm.seat_admin_grants'::regclass,'seat_admin_grants_forward_only',to_regprocedure('swarm.seat_admin_grants_forward_only()')),
   ('swarm.seat_admin_grants'::regclass,'seat_admin_grants_owner_or_expiry_end',to_regprocedure('swarm.seat_admin_grants_end_guard()'))))
 AND has_column_privilege('swarm_command','swarm.seat_admin_grants','ended_by_user_id','UPDATE')
 AND NOT has_column_privilege('swarm_command','swarm.seat_admin_grants','owner_user_id','UPDATE')
 AND NOT has_function_privilege('swarm_command','swarm.seat_admin_grants_end_guard()','EXECUTE')
 AND NOT has_function_privilege('authenticated','swarm.seat_admin_grants_end_guard()','EXECUTE')
 AND NOT has_function_privilege('swarm_command','swarm.seat_admin_grant_end_actor(uuid,uuid)','EXECUTE')
 AND NOT has_function_privilege('swarm_read','swarm.seat_admin_grant_end_actor(uuid,uuid)','EXECUTE')
 AND NOT has_function_privilege('authenticated','swarm.seat_admin_grant_end_actor(uuid,uuid)','EXECUTE')
 AND NOT has_function_privilege('anon','swarm.seat_admin_grant_end_actor(uuid,uuid)','EXECUTE')
 AND has_function_privilege('swarm_read','swarm.agent_seat_admin_self(bytea,uuid)','EXECUTE')
 AND has_function_privilege('swarm_read','swarm.agent_seat_admin_self_ended(bytea,uuid)','EXECUTE')
 AND NOT has_function_privilege('swarm_command','swarm.agent_seat_admin_self_ended(bytea,uuid)','EXECUTE')
 AND NOT has_function_privilege('authenticated','swarm.agent_seat_admin_self_ended(bytea,uuid)','EXECUTE')
 AND NOT has_function_privilege('anon','swarm.agent_seat_admin_self_ended(bytea,uuid)','EXECUTE')
 AND NOT has_function_privilege('swarm_command','swarm.agent_seat_admin_self(bytea,uuid)','EXECUTE')
 AND NOT has_function_privilege('authenticated','swarm.agent_seat_admin_self(bytea,uuid)','EXECUTE')
 AND has_function_privilege('authenticated','swarm_read.my_seat_admin_grants()','EXECUTE')
 AND NOT has_function_privilege('anon','swarm_read.my_seat_admin_grants()','EXECUTE')
 AS catalog_ok
\gset
