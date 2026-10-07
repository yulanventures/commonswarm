-- W6 SET grant: commonswarm_oauth_runtime TO commonswarm_edge. Stable labels only.
-- Exact membership options, a single row, edge's other memberships, issuer memberships.
WITH checks(label,ok) AS (VALUES
  ('edge-oauth-runtime-roles-present', COALESCE((
    EXISTS(SELECT 1 FROM pg_roles WHERE rolname='commonswarm_edge' AND rolcanlogin AND NOT rolsuper
      AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls)
    AND EXISTS(SELECT 1 FROM pg_roles WHERE rolname='commonswarm_oauth_runtime')
  ),false)),
  ('edge-oauth-runtime-membership-one-fft', COALESCE((
    (SELECT count(*) FROM pg_auth_members
      WHERE roleid='commonswarm_oauth_runtime'::regrole AND member='commonswarm_edge'::regrole)=1
    AND (SELECT NOT admin_option AND NOT inherit_option AND set_option FROM pg_auth_members
      WHERE roleid='commonswarm_oauth_runtime'::regrole AND member='commonswarm_edge'::regrole)
  ),false)),
  ('edge-other-memberships', COALESCE((
    (SELECT array_agg(parent.rolname::text ORDER BY parent.rolname) FROM pg_auth_members m
      JOIN pg_roles parent ON parent.oid=m.roleid
      WHERE m.member='commonswarm_edge'::regrole AND parent.rolname<>'commonswarm_oauth_runtime')
    =ARRAY['swarm_capability','swarm_command','swarm_read']::text[]
  ),false)),
  ('edge-membership-count', COALESCE((
    (SELECT count(*) FROM pg_auth_members WHERE member='commonswarm_edge'::regrole)=4
  ),false)),
  ('issuer-memberships-unchanged-shape', COALESCE((
    (SELECT array_agg(parent.rolname::text ORDER BY parent.rolname) FROM pg_auth_members m
      JOIN pg_roles parent ON parent.oid=m.roleid
      WHERE m.member='commonswarm_admin_issuer'::regrole AND NOT m.admin_option AND NOT m.inherit_option AND m.set_option)
    =ARRAY['commonswarm_oauth_runtime','swarm_command']::text[]
    AND (SELECT count(*) FROM pg_auth_members WHERE member='commonswarm_admin_issuer'::regrole)=2
  ),false))
)
SELECT COALESCE(string_agg(label,',' ORDER BY label) FILTER (WHERE NOT ok),'') AS catalog_ok_failed_checks,
  COALESCE(bool_and(ok),false) AS catalog_ok_checks_ok FROM checks
\gset
\if :catalog_ok_checks_ok
\else
\warn edge-oauth-runtime-catalog failed checks: :catalog_ok_failed_checks
\endif
SELECT :'catalog_ok_checks_ok'::boolean AS catalog_ok
\gset
