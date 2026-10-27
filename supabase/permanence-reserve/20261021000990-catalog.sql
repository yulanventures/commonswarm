-- Apply after 20261021000990. t only when all eleven routines the fence replaced
-- carry the 00990 bodies with their unchanged owner, volatility, definer flag,
-- search_path and EXECUTE grants, and the three fence triggers are enabled and
-- bound to their guard functions. Error-safe before the migration: routines
-- resolve through to_regprocedure and bodies are compared as md5(prosrc).
WITH routine(oid, secdef, grantees, body) AS (VALUES
 (to_regprocedure('swarm.prepare_renewal_grant(uuid,uuid)'), false, ARRAY['swarm_admin','swarm_command']::text[], 'ff749f55ee6f7e04e534d63bc3eb8b5b'),
 (to_regprocedure('swarm.discover_local_credential_ids(bytea)'), true, ARRAY['swarm_admin','swarm_command']::text[], 'fd1e0a129f81d0e23124ec64eee5536c'),
 (to_regprocedure('swarm.agent_delivery_read_context(bytea,uuid)'), true, ARRAY['swarm_admin','swarm_read']::text[], '4be113796d500c513c096339a2985863'),
 (to_regprocedure('swarm.agent_tokens_successor_fence()'), false, ARRAY['swarm_admin']::text[], '597b7c24135adbf5556b6ad864b43c54'),
 (to_regprocedure('swarm.record_renewal_grant_use(uuid,uuid,text)'), true, ARRAY['swarm_admin','swarm_command','swarm_read']::text[], 'ba51115518cf2d6f07e2bf9ea7918aac'),
 (to_regprocedure('swarm.household_local_family_binding_guard()'), true, ARRAY['swarm_admin']::text[], 'fdd490ddbc7f6263eb3b9cebe5a27e46'),
 (to_regprocedure('swarm.local_content_approval_pointer_guard()'), true, ARRAY['swarm_admin']::text[], '0ae2a488b5e8e39150c2e504c06a4b70'),
 (to_regprocedure('swarm_read.local_connection_selection(uuid,uuid,uuid)'), false, ARRAY['swarm_admin']::text[], 'fa625471855684699e9dc4e8e2c23d68'),
 (to_regprocedure('swarm_read.home_overview()'), true, ARRAY['authenticated','swarm_admin']::text[], 'c80946b70abc6c66edcd3a36e4518fcb'),
 (to_regprocedure('swarm_read.renewal_grant_roster(uuid)'), true, ARRAY['authenticated','swarm_admin','swarm_read']::text[], 'b953c61a5e0bc3565703510fdcc93c5f'),
 (to_regprocedure('swarm_read.renewal_grant_for_token(uuid,uuid)'), true, ARRAY['swarm_admin','swarm_read']::text[], '674e0419bd0c86a723ad507f1855fd83')
)
SELECT coalesce((SELECT count(*)=11 AND bool_and(coalesce(
   p.proowner='swarm_admin'::regrole AND p.prosecdef=r.secdef AND p.provolatile='v'
   AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)=r.body
   AND (SELECT coalesce(array_agg(x.grantee::regrole::text ORDER BY x.grantee::regrole::text COLLATE "C"),ARRAY[]::text[])
     FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x)=r.grantees
   AND NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x
     WHERE x.privilege_type<>'EXECUTE' OR x.is_grantable),false))
  FROM routine r JOIN pg_proc p ON p.oid=r.oid),false)
 AND coalesce((SELECT count(*)=3 AND bool_and(t.tgenabled='O') FROM pg_trigger t WHERE NOT t.tgisinternal AND (
   (t.tgrelid=to_regclass('swarm.agent_tokens') AND t.tgname='agent_tokens_successor_fence'
     AND t.tgfoid=to_regprocedure('swarm.agent_tokens_successor_fence()'))
   OR (t.tgrelid=to_regclass('swarm.household_content_connections') AND t.tgname='aa_household_local_family_binding'
     AND t.tgfoid=to_regprocedure('swarm.household_local_family_binding_guard()'))
   OR (t.tgrelid=to_regclass('swarm.renewal_grants') AND t.tgname='aa_local_content_approval_pointer'
     AND t.tgfoid=to_regprocedure('swarm.local_content_approval_pointer_guard()')))),false)
 AS catalog_ok
\gset
