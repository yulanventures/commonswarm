-- After the 20261025000001 rollback reserve: every converted or bound journal
-- entry is stamped restored and its live row carries the recorded prior values,
-- and both guard triggers are enabled again. Error-safe: objects resolve through
-- to_regclass/to_regprocedure; the data check runs dynamically.
SELECT to_regclass('swarm.permanence_grandfather_journal') IS NOT NULL
 AND (SELECT count(*)=2 AND bool_and(tgenabled='O') FROM pg_trigger WHERE NOT tgisinternal AND (
   (tgrelid=to_regclass('swarm.renewal_grants') AND tgname='renewal_grants_spend_or_revoke_only')
   OR (tgrelid=to_regclass('swarm.household_content_connections') AND tgname='aa_household_local_family_binding')))
 AND CASE WHEN to_regprocedure('swarm.permanence_grandfather_restored()') IS NULL THEN false
   ELSE (xpath('/row/ok/text()',query_to_xml('SELECT swarm.permanence_grandfather_restored() AS ok',false,true,'')))[1]::text='true' END
 AS rollback_ok
\gset
