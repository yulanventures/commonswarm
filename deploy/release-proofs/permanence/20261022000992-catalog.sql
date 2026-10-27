-- Apply after 20261022000992. t only when swarm.signals carries the two nullable
-- stamp columns with their comments and no default, the stamp function exists
-- with the 00992 body and owner-only EXECUTE, its BEFORE INSERT row trigger is
-- enabled, and both same-transaction guards carry the 00992 bodies with their
-- unchanged owner, search_path and owner-only EXECUTE while their triggers stay
-- enabled. Error-safe before the migration: objects resolve through
-- to_regprocedure/to_regclass/pg_attribute and bodies compare as md5(prosrc).
WITH routine(oid, config, body) AS (VALUES
 (to_regprocedure('swarm.stamp_signal_creation_xact()'), ARRAY['search_path=pg_catalog']::text[], '40630279f4587cfa2666784b58e644be'),
 (to_regprocedure('swarm.require_new_signal_for_recipient()'), ARRAY['search_path=swarm, pg_catalog']::text[], '81cb0f6ac22553cac1ff5fa1166d3762'),
 (to_regprocedure('swarm.require_new_signal_for_attachment()'), ARRAY['search_path=swarm, pg_catalog']::text[], 'a3ec188e123cfc17628091685fe13f20')
), stamp(name, type, comment) AS (VALUES
 ('creation_xact_id', 'xid8'::regtype,
  'Internal server-stamped top-level xid8; valid only with the creating cluster identifier. NULL legacy rows remain closed.'),
 ('creation_system_identifier', 'int8'::regtype,
  'Internal server-stamped physical cluster identifier; logical imports retain their origin and cannot authorize creation in another cluster.')
)
SELECT coalesce((SELECT count(*)=3 AND bool_and(coalesce(
   p.proowner='swarm_admin'::regrole AND NOT p.prosecdef AND p.provolatile='v' AND p.prorettype='trigger'::regtype
   AND p.proconfig=r.config AND md5(p.prosrc)=r.body
   AND NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x
     WHERE x.grantee<>p.proowner OR x.privilege_type<>'EXECUTE' OR x.is_grantable),false))
  FROM routine r JOIN pg_proc p ON p.oid=r.oid),false)
 AND coalesce((SELECT count(*)=2 AND bool_and(coalesce(NOT a.attnotnull AND NOT a.atthasdef
   AND col_description(a.attrelid,a.attnum)=s.comment,false))
  FROM stamp s JOIN pg_attribute a ON a.attrelid=to_regclass('swarm.signals') AND a.attname=s.name
   AND a.atttypid=s.type AND a.attnum>0 AND NOT a.attisdropped),false)
 AND coalesce((SELECT count(*)=1 AND bool_and(t.tgenabled='O' AND t.tgtype=7
   AND t.tgfoid=to_regprocedure('swarm.stamp_signal_creation_xact()'))
  FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgrelid=to_regclass('swarm.signals') AND t.tgname='signals_stamp_creation_xact'),false)
 AND coalesce((SELECT count(*)=2 AND bool_and(t.tgenabled='O' AND t.tgtype=7) FROM pg_trigger t WHERE NOT t.tgisinternal AND (
   (t.tgrelid=to_regclass('swarm.signal_recipients') AND t.tgname='signal_recipients_same_transaction'
     AND t.tgfoid=to_regprocedure('swarm.require_new_signal_for_recipient()'))
   OR (t.tgrelid=to_regclass('swarm.signal_attachments') AND t.tgname='signal_attachments_same_transaction'
     AND t.tgfoid=to_regprocedure('swarm.require_new_signal_for_attachment()')))),false)
 AS catalog_ok
\gset
