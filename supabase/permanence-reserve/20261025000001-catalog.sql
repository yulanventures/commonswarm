-- Apply after 20261025000001. t only when the journal, its append-only guard and
-- both proof functions exist with owner-only access, and the migration left no
-- eligible family, hosted grant or approval unprocessed. Error-safe before the
-- migration: every object is resolved through to_regclass/to_regprocedure and
-- the data check runs dynamically only once the function exists.
SELECT to_regclass('swarm.permanence_grandfather_journal') IS NOT NULL
 AND coalesce((SELECT relowner='swarm_admin'::regrole AND relrowsecurity FROM pg_class
   WHERE oid=to_regclass('swarm.permanence_grandfather_journal')),false)
 AND (SELECT count(*)=1 FROM pg_trigger WHERE tgrelid=to_regclass('swarm.permanence_grandfather_journal')
   AND tgname='permanence_grandfather_journal_guard' AND NOT tgisinternal AND tgenabled='O')
 AND NOT EXISTS(SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) x
   WHERE c.oid=to_regclass('swarm.permanence_grandfather_journal') AND x.grantee<>'swarm_admin'::regrole)
 AND to_regprocedure('swarm.permanence_grandfather_complete()') IS NOT NULL
 AND to_regprocedure('swarm.permanence_grandfather_restored()') IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x
   WHERE p.oid IN (to_regprocedure('swarm.permanence_grandfather_complete()'),to_regprocedure('swarm.permanence_grandfather_restored()'))
     AND (p.proowner<>'swarm_admin'::regrole OR x.grantee<>'swarm_admin'::regrole))
 AND CASE WHEN to_regprocedure('swarm.permanence_grandfather_complete()') IS NULL THEN false
   ELSE (xpath('/row/ok/text()',query_to_xml('SELECT swarm.permanence_grandfather_complete() AS ok',false,true,'')))[1]::text='true' END
 AS catalog_ok
\gset
