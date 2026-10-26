-- Read-only functional check after 20261019000003: the three resolvers, the
-- status function and the family lock exist with the migration's bodies, and
-- an unknown grant, seat or family resolves to nothing. The family lock returns
-- before any row lock when the family is unknown, so this stays read-only.
DO $proof$ BEGIN
  IF to_regprocedure('swarm.resolve_hosted_grant_authorization(uuid,uuid,uuid,text)') IS NULL
    OR to_regprocedure('swarm.resolve_hosted_seat_command_authorization(uuid,text,text)') IS NULL
    OR to_regprocedure('swarm.resolve_hosted_seat_read_authorization(uuid,text,text)') IS NULL
    OR to_regprocedure('commonswarm_oauth.resolve_hosted_grant_status(text)') IS NULL
    OR to_regprocedure('commonswarm_oauth.lock_hosted_family(text,uuid,text,text)') IS NULL THEN
    RAISE EXCEPTION 'connection policy enforcement functions are absent';
  END IF;
  IF (SELECT count(*) FROM pg_proc p WHERE p.oid IN (
      to_regprocedure('swarm.resolve_hosted_grant_authorization(uuid,uuid,uuid,text)'),
      to_regprocedure('swarm.resolve_hosted_seat_command_authorization(uuid,text,text)'),
      to_regprocedure('swarm.resolve_hosted_seat_read_authorization(uuid,text,text)'),
      to_regprocedure('commonswarm_oauth.resolve_hosted_grant_status(text)'),
      to_regprocedure('commonswarm_oauth.lock_hosted_family(text,uuid,text,text)'))
      AND md5(p.prosrc) IN ('1ea544115d61eb99d749b1b30b306b84','9a40ec0f733fbea335397b3c3ba85c3d',
        '1ecdf1467d0bf05ad242a73e48e9362e','72cadd77edf6edf6569be767c3249d5a','cbb6c97a0d3d5014834857534a312465'))<>5 THEN
    RAISE EXCEPTION 'connection policy enforcement bodies differ from the migration';
  END IF;
  IF EXISTS (SELECT 1 FROM swarm.resolve_hosted_grant_authorization(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'claim_hosted_seat'))
    OR EXISTS (SELECT 1 FROM swarm.resolve_hosted_seat_command_authorization(gen_random_uuid(),'seat_proof','ask'))
    OR EXISTS (SELECT 1 FROM swarm.resolve_hosted_seat_read_authorization(gen_random_uuid(),'seat_proof','whoami'))
    OR EXISTS (SELECT 1 FROM commonswarm_oauth.resolve_hosted_grant_status('proof-'||gen_random_uuid()::text))
    OR EXISTS (SELECT 1 FROM commonswarm_oauth.lock_hosted_family('proof-'||gen_random_uuid()::text,gen_random_uuid(),
      'proof-client','https://mcp.commonswarm.com/mcp')) THEN
    RAISE EXCEPTION 'an unknown hosted grant, seat or family resolved';
  END IF;
END $proof$;
