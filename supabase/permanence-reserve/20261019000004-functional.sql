-- Read-only functional check after 20261019000004: the client stream lock
-- exists with the migration's body, owner and single grantee, and the
-- registrations it serializes are readable. The lock itself is not called:
-- its first statement is SELECT ... FOR UPDATE on registered_clients, which a
-- read-only transaction refuses; the server suite exercises the call.
DO $proof$ BEGIN
  IF to_regprocedure('commonswarm_oauth.lock_hosted_client_streams(text)') IS NULL THEN
    RAISE EXCEPTION 'hosted client stream lock is absent';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('commonswarm_oauth.lock_hosted_client_streams(text)')
      AND md5(p.prosrc)='8fad9227ff62b4c94c120f9f8dfe68ac' AND p.prosecdef AND p.proowner='swarm_admin'::regrole
      AND has_function_privilege('commonswarm_oauth_runtime',p.oid,'EXECUTE')
      AND NOT has_function_privilege('swarm_command',p.oid,'EXECUTE')
      AND NOT has_function_privilege('swarm_read',p.oid,'EXECUTE')
      AND NOT has_function_privilege('anon',p.oid,'EXECUTE')
      AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE')) THEN
    RAISE EXCEPTION 'hosted client stream lock body or authority differs from the migration';
  END IF;
  PERFORM count(*) FROM commonswarm_oauth.registered_clients;
END $proof$;
