-- Read-only rollback catalog verification for 20261028000005.
SELECT (SELECT count(*)=2 AND bool_and(p.proowner='swarm_admin'::regrole AND p.prosecdef AND p.proconfig=ARRAY['search_path=pg_catalog'] AND md5(p.prosrc)=e.digest)
 FROM (VALUES
  ('swarm.agent_delivery_read_context(bytea,uuid)','d08e49c1b853cce45e4efc9e1e922d3f'),
  ('swarm.revoke_local_residual_tokens(uuid,uuid,text,uuid)','60c2e3aa9aa3590d700bbf0f5b788bbc')
 ) e(signature,digest) JOIN pg_proc p ON p.oid=to_regprocedure(e.signature))
 AND to_regprocedure('swarm.ensure_hosted_grant_agent()') IS NULL
 AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('swarm.hosted_mcp_seats') AND tgname='hosted_mcp_seats_seed_grant_agent')
 AS rollback_ok
\gset
