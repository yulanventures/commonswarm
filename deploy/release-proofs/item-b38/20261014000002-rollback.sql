-- RESERVE ONLY. Complete inverse of 20261014000002_oauth_finish.sql.
-- Use verbatim after dependent OAuth code has been rolled back.
-- Dependency: item-hm/20260928000003-rollback.sql:41 drops interactions.
-- Its DROP TABLE fails while finish_records references interactions. Run this
-- file before 20261014000001-rollback.sql and before that item-hm reserve.
-- RELEASE-TO-BOX.md:2214-2221 governs the explicit reviewed rollback decision;
-- :1567 supplies ON_ERROR_STOP. Catalog verification precedes commit.
\set ON_ERROR_STOP 1
\if :{?release_proof_outer_transaction}
SAVEPOINT release_proof_outer_transaction_guard;
\else
BEGIN;
\endif
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

\ir 20261014000002-catalog.sql
\if :catalog_ok
\else
DO $fail$ BEGIN RAISE EXCEPTION 'B38 finish rollback requires the complete forward catalog'; END $fail$;
\endif

DROP POLICY oauth_runtime_finish ON commonswarm_oauth.finish_records;
-- DROP removes this table's grants, seven checks, PK/index, two foreign keys
-- and their internal triggers. RESTRICT (the default) refuses any new user.
DROP TABLE commonswarm_oauth.finish_records;

DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261014000002';

\ir 20261014000002-rollback-catalog.sql
\if :rollback_ok
  \if :{?release_proof_outer_transaction}
    RELEASE SAVEPOINT release_proof_outer_transaction_guard;
  \else
    COMMIT;
  \endif
\else
  ROLLBACK;
  DO $fail$ BEGIN RAISE EXCEPTION 'B38 finish rollback catalog proof FAILED'; END $fail$;
\endif
