-- Section 5 catalog_ok contract. Checks only the waiting-column migration.
SELECT (
  EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid=to_regclass('swarm.h0_poll_locks') AND a.attname='waiting'
      AND a.atttypid='boolean'::regtype AND a.attnotnull
      AND pg_get_expr(d.adbin,d.adrelid,true)='false')
  AND EXISTS (SELECT 1 FROM pg_index i WHERE i.indexrelid=to_regclass('swarm.h0_poll_locks_waiting')
    AND i.indrelid=to_regclass('swarm.h0_poll_locks') AND i.indisvalid AND i.indisready
    AND NOT i.indisunique AND pg_get_indexdef(i.indexrelid)=
      'CREATE INDEX h0_poll_locks_waiting ON swarm.h0_poll_locks USING btree (expires_at) WHERE waiting')
) AS catalog_ok
\gset
