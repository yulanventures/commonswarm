-- Read-only catalog proof for migration 20260925000002. Returns one Boolean.
-- Exact prosrc digests distinguish these installed bodies from the older
-- statement_timestamp() assignments. The migration text is the digest source.
SELECT
  COALESCE((
    SELECT md5(p.prosrc) = 'ad14bdf0f3934d6b05bc5ef261e49a20'
      AND p.prosecdef
      AND pg_get_userbyid(p.proowner) = 'swarm_admin'
      AND p.proconfig @> ARRAY['search_path=swarm, pg_catalog']
      AND has_function_privilege('swarm_command', p.oid, 'EXECUTE')
      AND has_function_privilege('swarm_read', p.oid, 'EXECUTE')
      AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
      AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
    FROM pg_proc AS p
    WHERE p.oid = to_regprocedure('swarm.record_renewal_grant_use(uuid,uuid,text)')
  ), false)
  AND COALESCE((
    SELECT md5(p.prosrc) = '8df3387da81f79881a9508d0d0ba6b2d'
      AND pg_get_userbyid(p.proowner) = 'swarm_admin'
    FROM pg_proc AS p
    WHERE p.oid = to_regprocedure('swarm.agent_tokens_successor_fence()')
  ), false)
  AND COALESCE((
    SELECT t.tgenabled = 'O'
      AND p.prosrc LIKE '%SWARM_RENEWAL_LAST_USE_REWOUND%'
    FROM pg_trigger AS t
    JOIN pg_proc AS p ON p.oid = t.tgfoid
    WHERE t.tgrelid = to_regclass('swarm.renewal_grants')
      AND p.proname = 'renewal_grants_spend_or_revoke_only'
      AND NOT t.tgisinternal
  ), false) AS catalog_ok;
