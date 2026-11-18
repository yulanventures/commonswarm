-- Read-only rollback catalog verification for 20261118000003: the earlier read bodies are in place; the ended-grants
-- read, the guard, the helper and ended_by_user_id are gone; the forward-only trigger stays.
SELECT to_regprocedure('swarm.seat_admin_grants_end_guard()') IS NULL
 AND to_regprocedure('swarm.agent_seat_admin_self_ended(bytea,uuid)') IS NULL
 AND to_regprocedure('swarm.seat_admin_grant_end_actor(uuid,uuid)') IS NULL
 AND NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='swarm.seat_admin_grants'::regclass AND attname='ended_by_user_id' AND NOT attisdropped)
 AND NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='swarm.seat_admin_grants'::regclass AND conname='seat_admin_grants_ended_by_check')
 AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='swarm.seat_admin_grants'::regclass AND tgname='seat_admin_grants_owner_or_expiry_end')
 AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='swarm.seat_admin_grants'::regclass AND tgname='seat_admin_grants_forward_only'
   AND NOT tgisinternal AND tgenabled='O')
 AND (SELECT count(*)=2 AND bool_and(p.proowner='swarm_admin'::regrole AND p.prosecdef AND p.provolatile=e.volatility::"char"
   AND p.proconfig=ARRAY['search_path=pg_catalog'] AND md5(p.prosrc)=e.digest)
  FROM (VALUES
   ('swarm.agent_seat_admin_self(bytea,uuid)','v','10f48cae6f710f79d2c18bbc92fe1a87'),
   ('swarm_read.my_seat_admin_grants()','s','bbbd7c16cd482fdabb194e673bd72c3f')
  ) e(signature,volatility,digest) JOIN pg_proc p ON p.oid=to_regprocedure(e.signature))
 AND has_function_privilege('swarm_read','swarm.agent_seat_admin_self(bytea,uuid)','EXECUTE')
 AND NOT has_function_privilege('authenticated','swarm.agent_seat_admin_self(bytea,uuid)','EXECUTE')
 AND has_function_privilege('authenticated','swarm_read.my_seat_admin_grants()','EXECUTE')
 AND NOT has_function_privilege('anon','swarm_read.my_seat_admin_grants()','EXECUTE')
 AND has_column_privilege('swarm_command','swarm.seat_admin_grants','state','UPDATE')
 AS rollback_ok
\gset
