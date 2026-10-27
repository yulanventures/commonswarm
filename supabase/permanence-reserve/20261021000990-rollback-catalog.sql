-- After the 20261021000990 rollback reserve: all eleven routines carry the
-- bodies their previous definers installed (20261019000007 for the eight
-- local-auth routines, 20261019000010 for the three read models) with unchanged
-- owner, volatility, definer flag, search_path and EXECUTE grants, and the three
-- fence triggers are still enabled and bound. Error-safe: routines resolve
-- through to_regprocedure and bodies are compared as md5(prosrc).
WITH routine(oid, secdef, grantees, body) AS (VALUES
 (to_regprocedure('swarm.prepare_renewal_grant(uuid,uuid)'), false, ARRAY['swarm_admin','swarm_command']::text[], 'fd59e4b9a36b6925b8eaf3ed5909dab4'),
 (to_regprocedure('swarm.discover_local_credential_ids(bytea)'), true, ARRAY['swarm_admin','swarm_command']::text[], '466fd809a729a574db2c3ddfc71062cb'),
 (to_regprocedure('swarm.agent_delivery_read_context(bytea,uuid)'), true, ARRAY['swarm_admin','swarm_read']::text[], '48a75ba038bc56ea8b497c5a65535dbc'),
 (to_regprocedure('swarm.agent_tokens_successor_fence()'), false, ARRAY['swarm_admin']::text[], '20653242a07ce692b551c2e079050dc4'),
 (to_regprocedure('swarm.record_renewal_grant_use(uuid,uuid,text)'), true, ARRAY['swarm_admin','swarm_command','swarm_read']::text[], 'e4f603213fc2dfe1d6e7b209d5b7eb46'),
 (to_regprocedure('swarm.household_local_family_binding_guard()'), true, ARRAY['swarm_admin']::text[], '166492c0ccc5ee07f36ddb661356f285'),
 (to_regprocedure('swarm.local_content_approval_pointer_guard()'), true, ARRAY['swarm_admin']::text[], '61ba37bca90cd5921616ba080f2286c4'),
 (to_regprocedure('swarm_read.local_connection_selection(uuid,uuid,uuid)'), false, ARRAY['swarm_admin']::text[], '160d28ccf92ef7b52c2eb3472e479af0'),
 (to_regprocedure('swarm_read.home_overview()'), true, ARRAY['authenticated','swarm_admin']::text[], '97041e1c94990f5a40006935a3163f98'),
 (to_regprocedure('swarm_read.renewal_grant_roster(uuid)'), true, ARRAY['authenticated','swarm_admin','swarm_read']::text[], '878a72454f1f2b1989a1067f0d0e2383'),
 (to_regprocedure('swarm_read.renewal_grant_for_token(uuid,uuid)'), true, ARRAY['swarm_admin','swarm_read']::text[], '400264c8775bb9d0bd6ae46831821eba')
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
 AS rollback_ok
\gset
