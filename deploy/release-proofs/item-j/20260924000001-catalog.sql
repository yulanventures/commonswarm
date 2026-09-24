-- Section 5 catalog_ok contract for pending access. Read-only and one Boolean.
SELECT COALESCE((
  SELECT p.prosecdef
    AND p.provolatile = 's'
    AND pg_get_userbyid(p.proowner) = 'swarm_admin'
    AND p.proconfig = ARRAY['search_path=swarm, pg_catalog']
    -- Body digest pins the predicates as well as the function signature. Update
    -- this from the migration body only when the reviewed migration changes.
    AND md5(p.prosrc) = '03e8130f3d20e99106c3b16e58080fa5'
    AND p.proargnames[2:11] = ARRAY[
      'kind', 'principal_id', 'principal_name', 'join_credential_id',
      'owner_user_id', 'issuer_display', 'issued_at', 'expires_at',
      'seats_used', 'seat_cap'
    ]
    AND cardinality(p.proargnames) = 11
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
    AND has_function_privilege('swarm_read', p.oid, 'EXECUTE')
    AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
    AND NOT has_function_privilege('swarm_command', p.oid, 'EXECUTE')
    AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')
    AND NOT has_function_privilege('authenticator', p.oid, 'EXECUTE')
    AND NOT EXISTS (
      SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS acl
      WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
    )
  FROM pg_proc p
  WHERE p.oid = to_regprocedure('swarm_read.pending_access(uuid)')
), false) AS catalog_ok
\gset
