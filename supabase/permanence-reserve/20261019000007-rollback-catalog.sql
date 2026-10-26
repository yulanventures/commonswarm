-- After the 20261019000007 rollback reserve: the pointer column, the five
-- discovery functions, both guard functions with their triggers and the column
-- UPDATE grant are gone; the six replaced functions carry their previous bodies
-- again (20260904000001, 20260925000002 and 20261001000004 texts) with their own
-- search_path settings, definer modes and grantee sets; and the two swarm_read
-- readers are back to the 19-column STABLE shape with their comments, while the
-- two pre-existing triggers on the replaced trigger functions stay bound.
-- Error-safe: objects resolve through to_regclass and to_regprocedure.
WITH expected(name,oid,secdef,volatility,config,body,grantees) AS (VALUES
 ('read_context',to_regprocedure('swarm.agent_delivery_read_context(bytea,uuid)'),true,'v','search_path=swarm, pg_catalog','f98683cd84e7096d574e8fb19532b097',ARRAY['swarm_admin','swarm_read']),
 ('successor_fence',to_regprocedure('swarm.agent_tokens_successor_fence()'),false,'v','search_path=pg_catalog','5f1454a676423a8c96ff1afbfea788a9',ARRAY['swarm_admin']),
 ('record_use',to_regprocedure('swarm.record_renewal_grant_use(uuid,uuid,text)'),true,'v','search_path=swarm, pg_catalog','2b6cb7cab75148ab3555fb69a485e86b',ARRAY['swarm_admin','swarm_command','swarm_read']),
 ('prepare',to_regprocedure('swarm.prepare_renewal_grant(uuid,uuid)'),false,'v','search_path=pg_catalog','520b44faf2659b65c3ac8595a5d26734',ARRAY['swarm_admin','swarm_command']),
 ('resume',to_regprocedure('swarm.resume_renewal_grant(uuid,uuid,uuid)'),true,'v','search_path=swarm, pg_catalog','768934a5724db16b800856bc48612fc5',ARRAY['swarm_admin','swarm_command']),
 ('roster',to_regprocedure('swarm_read.renewal_grant_roster(uuid)'),true,'s','search_path=swarm, pg_catalog','dbdf6ea01d5167be91c382899e97d282',ARRAY['authenticated','swarm_admin','swarm_read']),
 ('for_token',to_regprocedure('swarm_read.renewal_grant_for_token(uuid,uuid)'),true,'s','search_path=swarm, pg_catalog','04747d29c02be63d3b16de134b07c9c0',ARRAY['swarm_admin','swarm_read']),
 ('spend_or_revoke',to_regprocedure('swarm.renewal_grants_spend_or_revoke_only()'),false,'v','search_path=pg_catalog','746f6d2dd801d4666854f3c33f2bd191',ARRAY['swarm_admin'])
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
SELECT (SELECT count(*)=8 FROM verified)
 AND NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.renewal_grants')
   AND attname='local_content_approval_token_id' AND NOT attisdropped)
 AND to_regprocedure('swarm.discover_local_credential_ids(bytea)') IS NULL
 AND to_regprocedure('swarm.discover_local_target_ids(uuid,uuid,uuid[],uuid[],boolean,uuid,boolean)') IS NULL
 AND to_regprocedure('swarm.discover_local_target_ids(uuid,uuid,uuid[],uuid[],boolean,uuid)') IS NULL
 AND to_regprocedure('swarm.discover_local_target_ids(uuid,uuid,uuid[],uuid[],boolean)') IS NULL
 AND to_regprocedure('swarm.discover_local_join_ids(bytea,uuid)') IS NULL
 AND to_regprocedure('swarm.household_local_family_binding_guard()') IS NULL
 AND to_regprocedure('swarm.local_content_approval_pointer_guard()') IS NULL
 AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE NOT tgisinternal
   AND tgname IN ('aa_household_local_family_binding','aa_local_content_approval_pointer'))
 AND NOT EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) x
   WHERE a.attrelid=to_regclass('swarm.household_content_connections') AND a.attname='renewal_grant_id'
   AND NOT a.attisdropped AND x.grantee='swarm_command'::regrole AND x.privilege_type='UPDATE')
 AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('swarm_read.renewal_grant_roster(uuid)')
   AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql')
   AND pg_get_function_result(p.oid) LIKE 'TABLE(renewal_grant_id uuid, %, token_revoked_at timestamp with time zone)'
   AND obj_description(p.oid,'pg_proc')='One current grant row per live principal for a verified live workspace member. suspended_at reports CURRENT suspension: a resumed grant reads NULL. Includes token ids and timestamps, never token hashes or bearer secrets.')
 AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('swarm_read.renewal_grant_for_token(uuid,uuid)')
   AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='sql')
   AND pg_get_function_result(p.oid) LIKE 'TABLE(renewal_grant_id uuid, %, token_revoked_at timestamp with time zone)'
   AND obj_description(p.oid,'pg_proc')='The current renewal grant for one already-authenticated agent token. suspended_at reports CURRENT suspension: a resumed grant reads NULL. Never returns another principal or workspace.')
 AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('swarm.renewal_grants')
   AND tgname='renewal_grants_spend_or_revoke_only' AND NOT tgisinternal AND tgenabled='O'
   AND tgfoid=to_regprocedure('swarm.renewal_grants_spend_or_revoke_only()'))
 AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('swarm.agent_tokens')
   AND tgname='agent_tokens_successor_fence' AND NOT tgisinternal AND tgenabled='O'
   AND tgfoid=to_regprocedure('swarm.agent_tokens_successor_fence()'))
 AS rollback_ok
\gset
