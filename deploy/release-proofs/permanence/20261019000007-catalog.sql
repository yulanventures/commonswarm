-- Apply after 20261019000007. t only when the local lock-order release is
-- complete: the nullable uuid pointer column on swarm.renewal_grants; the five
-- discovery functions and the two guard functions with their exact bodies; both
-- BEFORE INSERT OR UPDATE row guard triggers bound and enabled; swarm_command's
-- column UPDATE on household_content_connections.renewal_grant_id; the six
-- replaced function bodies; and the two swarm_read readers recreated VOLATILE
-- with the connection policy columns and their comments. Every function is
-- measured for owner swarm_admin, definer mode, VOLATILE, search_path=pg_catalog,
-- md5(prosrc) of the migration text and an exact EXECUTE grantee set, and the
-- two pre-existing triggers on the replaced trigger functions stay bound.
-- Error-safe before the migration: objects resolve through to_regclass and
-- to_regprocedure; an absent or older function drops out of the verified set.
WITH expected(name,oid,secdef,volatility,config,body,grantees) AS (VALUES
 ('credential_ids',to_regprocedure('swarm.discover_local_credential_ids(bytea)'),true,'v','search_path=pg_catalog','466fd809a729a574db2c3ddfc71062cb',ARRAY['swarm_admin','swarm_command']),
 ('target_ids_7',to_regprocedure('swarm.discover_local_target_ids(uuid,uuid,uuid[],uuid[],boolean,uuid,boolean)'),true,'v','search_path=pg_catalog','fffc6b3b04db60f408b5230d24dbe847',ARRAY['swarm_admin','swarm_command']),
 ('target_ids_6',to_regprocedure('swarm.discover_local_target_ids(uuid,uuid,uuid[],uuid[],boolean,uuid)'),true,'v','search_path=pg_catalog','23c53c2fa88a7a352c4e9f233bb72f5f',ARRAY['swarm_admin','swarm_command']),
 ('target_ids_5',to_regprocedure('swarm.discover_local_target_ids(uuid,uuid,uuid[],uuid[],boolean)'),true,'v','search_path=pg_catalog','21ba96997d9b6eddee8826861e087349',ARRAY['swarm_admin','swarm_command']),
 ('join_ids',to_regprocedure('swarm.discover_local_join_ids(bytea,uuid)'),true,'v','search_path=pg_catalog','2951a95b06e40246c08ef1c106d4afcd',ARRAY['swarm_admin','swarm_command']),
 ('family_guard',to_regprocedure('swarm.household_local_family_binding_guard()'),true,'v','search_path=pg_catalog','166492c0ccc5ee07f36ddb661356f285',ARRAY['swarm_admin']),
 ('pointer_guard',to_regprocedure('swarm.local_content_approval_pointer_guard()'),true,'v','search_path=pg_catalog','61ba37bca90cd5921616ba080f2286c4',ARRAY['swarm_admin']),
 ('read_context',to_regprocedure('swarm.agent_delivery_read_context(bytea,uuid)'),true,'v','search_path=pg_catalog','48a75ba038bc56ea8b497c5a65535dbc',ARRAY['swarm_admin','swarm_read']),
 ('successor_fence',to_regprocedure('swarm.agent_tokens_successor_fence()'),false,'v','search_path=pg_catalog','20653242a07ce692b551c2e079050dc4',ARRAY['swarm_admin']),
 ('record_use',to_regprocedure('swarm.record_renewal_grant_use(uuid,uuid,text)'),true,'v','search_path=pg_catalog','e4f603213fc2dfe1d6e7b209d5b7eb46',ARRAY['swarm_admin','swarm_command','swarm_read']),
 ('prepare',to_regprocedure('swarm.prepare_renewal_grant(uuid,uuid)'),false,'v','search_path=pg_catalog','fd59e4b9a36b6925b8eaf3ed5909dab4',ARRAY['swarm_admin','swarm_command']),
 ('resume',to_regprocedure('swarm.resume_renewal_grant(uuid,uuid,uuid)'),true,'v','search_path=pg_catalog','5cb2dc539a15eccfe0530b55ee8a98ad',ARRAY['swarm_admin','swarm_command']),
 ('roster',to_regprocedure('swarm_read.renewal_grant_roster(uuid)'),true,'v','search_path=pg_catalog','e764508c50f69d08098d1cf2879d1db4',ARRAY['authenticated','swarm_admin','swarm_read']),
 ('for_token',to_regprocedure('swarm_read.renewal_grant_for_token(uuid,uuid)'),true,'v','search_path=pg_catalog','400264c8775bb9d0bd6ae46831821eba',ARRAY['swarm_admin','swarm_read']),
 ('spend_or_revoke',to_regprocedure('swarm.renewal_grants_spend_or_revoke_only()'),false,'v','search_path=pg_catalog','f0cec633dfb66de22d2b041239673a5d',ARRAY['swarm_admin'])
), verified AS (
 SELECT e.name FROM expected e JOIN pg_proc p ON p.oid=e.oid
 WHERE p.proowner='swarm_admin'::regrole AND p.prosecdef=e.secdef AND p.provolatile::text=e.volatility
   AND p.proconfig=ARRAY[e.config]::text[] AND md5(p.prosrc)=e.body
   AND (SELECT coalesce(array_agg(x.grantee::regrole::text ORDER BY x.grantee::regrole::text),ARRAY[]::text[])
     FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x WHERE x.grantee<>0)
     =(SELECT array_agg(g ORDER BY g) FROM unnest(e.grantees) g)
   AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x
     WHERE x.grantee=0 OR x.privilege_type<>'EXECUTE' OR x.is_grantable)
)
SELECT (SELECT count(*)=15 FROM verified)
 AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.renewal_grants')
   AND attname='local_content_approval_token_id' AND atttypid='uuid'::regtype AND NOT attnotnull AND NOT attisdropped)
 AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('swarm.household_content_connections')
   AND tgname='aa_household_local_family_binding' AND NOT tgisinternal AND tgenabled='O' AND tgtype=23
   AND tgfoid=to_regprocedure('swarm.household_local_family_binding_guard()'))
 AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('swarm.renewal_grants')
   AND tgname='aa_local_content_approval_pointer' AND NOT tgisinternal AND tgenabled='O' AND tgtype=23
   AND tgfoid=to_regprocedure('swarm.local_content_approval_pointer_guard()'))
 AND EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) x
   WHERE a.attrelid=to_regclass('swarm.household_content_connections') AND a.attname='renewal_grant_id'
   AND NOT a.attisdropped AND x.grantee='swarm_command'::regrole AND x.privilege_type='UPDATE')
 AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('swarm_read.renewal_grant_roster(uuid)')
   AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql')
   AND pg_get_function_result(p.oid) LIKE 'TABLE(renewal_grant_id uuid, %, token_revoked_at timestamp with time zone, connection_expires_at timestamp with time zone, connection_expired_at timestamp with time zone)'
   AND obj_description(p.oid,'pg_proc')='One current grant row per live principal for a verified live workspace member. suspended_at reports CURRENT suspension: a resumed grant reads NULL. Includes token ids and timestamps, never token hashes or bearer secrets.')
 AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('swarm_read.renewal_grant_for_token(uuid,uuid)')
   AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='sql')
   AND pg_get_function_result(p.oid) LIKE 'TABLE(renewal_grant_id uuid, %, token_revoked_at timestamp with time zone, connection_expires_at timestamp with time zone, connection_expired_at timestamp with time zone)'
   AND obj_description(p.oid,'pg_proc')='The current renewal grant for one already-authenticated agent token. suspended_at reports CURRENT suspension: a resumed grant reads NULL. Never returns another principal or workspace.')
 AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('swarm.renewal_grants')
   AND tgname='renewal_grants_spend_or_revoke_only' AND NOT tgisinternal AND tgenabled='O'
   AND tgfoid=to_regprocedure('swarm.renewal_grants_spend_or_revoke_only()'))
 AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('swarm.agent_tokens')
   AND tgname='agent_tokens_successor_fence' AND NOT tgisinternal AND tgenabled='O'
   AND tgfoid=to_regprocedure('swarm.agent_tokens_successor_fence()'))
 AS catalog_ok
\gset
