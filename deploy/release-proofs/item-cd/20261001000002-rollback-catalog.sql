-- Pre-migration catalog after reverse rollback for 20261001000002.
-- Safe OID lookups: missing objects yield false, not a regclass cast error.
SELECT
  COALESCE((
    to_regclass('swarm.admin_created_workspaces') IS NULL
    AND to_regclass('swarm.admin_routine_invitations') IS NULL
    AND NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.events') AND attnum>0 AND NOT attisdropped AND attname::text=ANY(ARRAY['admin_identity_id','grant_id','grant_manifest_digest']::text[]))
    AND NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.agent_principals') AND attnum>0 AND NOT attisdropped AND attname::text=ANY(ARRAY['parent_admin_grant_id']::text[]))
    AND NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.agent_tokens') AND attnum>0 AND NOT attisdropped AND attname::text=ANY(ARRAY['parent_admin_grant_id','recipient_connection_id']::text[]))
    AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('swarm.events') AND conname='delegated_event_actor')
    AND NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid=to_regclass('swarm.agent_tokens') AND polname='admin_parent_select')
    AND to_regprocedure('swarm.admin_child_live(uuid,uuid)') IS NULL
    AND to_regprocedure('swarm.admin_child_scopes_live(uuid,jsonb)') IS NULL
    AND to_regprocedure('swarm.admin_token_ancestry()') IS NULL
    AND to_regprocedure('swarm.admin_principal_ancestry()') IS NULL
    AND to_regprocedure('swarm.admin_end_pending_invitations()') IS NULL
    AND to_regclass('swarm.admin_accounts') IS NOT NULL
    AND to_regprocedure('swarm.agent_delivery_read_context(bytea,uuid)') IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('swarm.agent_tokens') AND tgname='aa_admin_token_ancestry')
    AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('swarm.agent_principals') AND tgname='admin_principal_ancestry')
    AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('swarm.admin_grants') AND tgname='admin_end_pending_invitations')
    AND (SELECT md5(prosrc)='7bdac2f2c2473a7229c893c7ab9ce008' FROM pg_proc WHERE oid=to_regprocedure('swarm.agent_delivery_read_context(bytea,uuid)'))
  ), false) AS rollback_ok
\gset
