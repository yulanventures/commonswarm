-- W2b (issuer-only window) read-only database preconditions. Stable labels, no row values.
-- W2 applied all five 20261003 migrations and nothing later; its issuer rollback left the role
-- without login and without a password (pg_authid: run as the target superuser). Every row is
-- NULL-safe before W2: ledger and catalog reads only, no name casts.
WITH checks(label,ok) AS (VALUES
  ('w2b-ledger-five-20261003', COALESCE((
    (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version IN
      ('20261003000001','20261003000002','20261003000003','20261003000004','20261003000005'))=5
  ),false)),
  ('w2b-ledger-nothing-later', COALESCE((
    NOT EXISTS(SELECT 1 FROM supabase_migrations.schema_migrations WHERE version>'20261003000005')
  ),false)),
  ('w2b-issuer-role-nologin-nopassword', COALESCE((
    (SELECT NOT rolcanlogin AND rolpassword IS NULL FROM pg_catalog.pg_authid WHERE rolname='commonswarm_admin_issuer')
  ),false))
)
SELECT COALESCE(string_agg(label,',' ORDER BY label) FILTER (WHERE NOT ok),'') AS w2b_ok_failed_checks,
  COALESCE(bool_and(ok),false) AS w2b_ok_checks_ok FROM checks
\gset
\if :w2b_ok_checks_ok
\else
\warn w2b-preconditions failed checks: :w2b_ok_failed_checks
\endif
SELECT :'w2b_ok_checks_ok'::boolean AS w2b_ok
\gset
