-- Apply after 20261019000008. t only when the grant revocation cascade carries
-- the exact 00008 body as a swarm_admin owned SECURITY DEFINER with search_path
-- pinned to pg_catalog and EXECUTE for the owner only, its AFTER UPDATE trigger
-- on swarm.renewal_grants is still bound and enabled, and the trusted residual
-- revoke API exists with the same identity plus EXECUTE for swarm_command.
-- Error-safe before the migration: objects resolve through to_regclass and
-- to_regprocedure; an absent function drops out of the verified set and the
-- count yields f, never an error.
WITH expected(name,oid,body,grantees) AS (VALUES
 ('cascade',to_regprocedure('swarm.renewal_grants_revoke_cascade()'),'11d5b26200271d5bbc77a807e568d3fd',ARRAY['swarm_admin']),
 ('residual',to_regprocedure('swarm.revoke_local_residual_tokens(uuid,uuid,text,uuid)'),'67c3203bcbee9568cb74ee3701ff04ac',ARRAY['swarm_admin','swarm_command'])
), verified AS (
 SELECT e.name FROM expected e JOIN pg_proc p ON p.oid=e.oid
 WHERE p.proowner='swarm_admin'::regrole AND p.prosecdef AND p.provolatile='v'
   AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)=e.body
   AND (SELECT coalesce(array_agg(x.grantee::regrole::text ORDER BY x.grantee::regrole::text),ARRAY[]::text[])
     FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x WHERE x.grantee<>0)
     =(SELECT array_agg(g ORDER BY g) FROM unnest(e.grantees) g)
   AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x
     WHERE x.grantee=0 OR x.privilege_type<>'EXECUTE' OR x.is_grantable)
)
SELECT (SELECT count(*)=2 FROM verified)
 AND EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('swarm.revoke_local_residual_tokens(uuid,uuid,text,uuid)')
   AND prorettype='void'::regtype)
 AND EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('swarm.renewal_grants_revoke_cascade()')
   AND prorettype='trigger'::regtype)
 AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('swarm.renewal_grants')
   AND tgname='renewal_grants_revoke_cascade' AND NOT tgisinternal AND tgenabled='O'
   AND tgfoid=to_regprocedure('swarm.renewal_grants_revoke_cascade()'))
 AS catalog_ok
\gset
