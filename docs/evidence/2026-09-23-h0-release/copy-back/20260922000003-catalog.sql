-- Section 5 catalog_ok contract. Checks the retention migration only.
SELECT (
  EXISTS (SELECT 1 FROM pg_index i WHERE i.indexrelid=to_regclass('swarm.h0_poll_batches_closed_at')
    AND i.indrelid=to_regclass('swarm.h0_poll_batches') AND i.indisvalid AND i.indisready
    AND pg_get_indexdef(i.indexrelid)=
      'CREATE INDEX h0_poll_batches_closed_at ON swarm.h0_poll_batches USING btree (closed_at, workspace_id, principal_id, batch_id) WHERE (status = ''closed''::text)')
  AND EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('swarm.h0_poll_batches_guard()')
    AND pg_get_userbyid(p.proowner)='swarm_admin' AND NOT p.prosecdef
    AND p.proconfig=ARRAY['search_path=pg_catalog']
    AND p.proacl::text='{swarm_admin=X/swarm_admin}'
    AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')='1130f232a81557fdc12b8a78f12246ef0b26be7894d6d8bb02f21b53dc556a67')
  AND (SELECT count(*) FROM (VALUES
    ('swarm.h0_poll_batch_retention_days()','dfa6c6beee913799a85e4c73ba61f27be100cda85a5aac6c5dfd452e16d65349'),
    ('swarm.purge_expired_h0_poll_batches(integer)','3cde2f3afedc55186a59384e805ca4498c7619ee65d4fca105aeb3081ce6ecb4'),
    ('swarm.purge_expired_h0_poll_batches()','0f963ce284042223db12d0996973daeb67ec04aef76f2a58b3179bbf39851982')
  ) AS expected(signature,body_sha) JOIN pg_proc p ON p.oid=to_regprocedure(expected.signature)
    WHERE pg_get_userbyid(p.proowner)='swarm_admin' AND p.prosecdef
      AND p.proconfig=ARRAY['search_path=swarm, pg_catalog']
      AND p.proacl::text='{swarm_admin=X/swarm_admin}'
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=expected.body_sha)=3
  AND (SELECT count(*) FROM cron.job WHERE jobname='swarm-purge-h0-poll-batches'
    AND schedule='29 4 * * *' AND command='SELECT swarm.purge_expired_h0_poll_batches()'
    AND database=current_database() AND username=current_user AND active)=1
) AS catalog_ok
\gset
