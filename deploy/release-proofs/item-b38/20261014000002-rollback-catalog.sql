-- Read-only proof of the pre-finish schema. Session binding and the HM
-- interactions/session parents must remain intact at this rollback step.
-- RELEASE-TO-BOX.md:2214-2221: verify the reserve before committing it.
\ir 20261014000001-catalog.sql
SELECT
  to_regclass('commonswarm_oauth.finish_records') IS NULL
  AND to_regclass('commonswarm_oauth.finish_records_pkey') IS NULL
  AND to_regtype('commonswarm_oauth.finish_records') IS NULL
  AND :'catalog_ok'::boolean
  AND to_regclass('commonswarm_oauth.interactions') IS NOT NULL
  AND to_regclass('commonswarm_oauth.browser_sessions') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM pg_constraint AS c JOIN pg_namespace AS n ON n.oid = c.connamespace
    WHERE n.nspname = 'commonswarm_oauth' AND c.conname IN (
      'finish_records_pkey', 'finish_records_interaction_uid_fkey', 'finish_records_session_hash_fkey',
      'finish_records_validated_request_check', 'finish_records_display_model_check',
      'finish_records_provider_result_check', 'finish_records_state_check',
      'finish_records_resume_response_check', 'finish_records_check', 'finish_records_check1'
    ))
  AND NOT EXISTS (SELECT 1 FROM pg_policy AS p JOIN pg_class AS c ON c.oid = p.polrelid
    JOIN pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'commonswarm_oauth' AND p.polname = 'oauth_runtime_finish')
  AND NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261014000002')
  AS rollback_ok
\gset
