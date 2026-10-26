-- After the 20261022000992 rollback reserve: the stamp trigger, its function and
-- both stamp columns are gone from swarm.signals, and both same-transaction
-- guards carry their previous bodies (20260905000010 for recipients,
-- 20260901000010 for attachments) with unchanged owner, search_path and
-- owner-only EXECUTE while their triggers stay enabled. Error-safe: objects
-- resolve through to_regprocedure/to_regclass; bodies compare as md5(prosrc).
WITH routine(oid, config, body) AS (VALUES
 (to_regprocedure('swarm.require_new_signal_for_recipient()'), ARRAY['search_path=swarm, pg_catalog']::text[], '8f9c7f463a221fbe9f9c75a0462c59c6'),
 (to_regprocedure('swarm.require_new_signal_for_attachment()'), ARRAY['search_path=swarm, pg_catalog']::text[], 'cd4912d3bd60fd36e9db53d7ce341a8e')
)
SELECT to_regclass('swarm.signals') IS NOT NULL
 AND to_regprocedure('swarm.stamp_signal_creation_xact()') IS NULL
 AND NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.signals')
   AND attname IN ('creation_xact_id','creation_system_identifier') AND NOT attisdropped)
 AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('swarm.signals') AND tgname='signals_stamp_creation_xact')
 AND coalesce((SELECT count(*)=2 AND bool_and(coalesce(
   p.proowner='swarm_admin'::regrole AND NOT p.prosecdef AND p.provolatile='v' AND p.prorettype='trigger'::regtype
   AND p.proconfig=r.config AND md5(p.prosrc)=r.body
   AND NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x
     WHERE x.grantee<>p.proowner OR x.privilege_type<>'EXECUTE' OR x.is_grantable),false))
  FROM routine r JOIN pg_proc p ON p.oid=r.oid),false)
 AND coalesce((SELECT count(*)=2 AND bool_and(t.tgenabled='O' AND t.tgtype=7) FROM pg_trigger t WHERE NOT t.tgisinternal AND (
   (t.tgrelid=to_regclass('swarm.signal_recipients') AND t.tgname='signal_recipients_same_transaction'
     AND t.tgfoid=to_regprocedure('swarm.require_new_signal_for_recipient()'))
   OR (t.tgrelid=to_regclass('swarm.signal_attachments') AND t.tgname='signal_attachments_same_transaction'
     AND t.tgfoid=to_regprocedure('swarm.require_new_signal_for_attachment()')))),false)
 AS rollback_ok
\gset
