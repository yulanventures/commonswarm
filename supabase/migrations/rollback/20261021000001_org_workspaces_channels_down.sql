-- Fail-Closed Rollback for 20261021000001_org_workspaces_channels.sql & 20261021000002_org_workspaces_channels_functions.sql
-- Refuses to drop privacy columns or tables if any visibility='private' channel exists,
-- preventing accidental widening of private room history or file attachments to workspace-wide visibility.

BEGIN;

LOCK TABLE swarm.channels IN ACCESS EXCLUSIVE MODE;

DO $org_workspaces_channels_rollback_guard$
BEGIN
  IF to_regclass('swarm.file_channel_bindings') IS NOT NULL THEN
    EXECUTE 'LOCK TABLE swarm.file_channel_bindings IN ACCESS EXCLUSIVE MODE';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute AS a
    JOIN pg_catalog.pg_class AS c ON c.oid = a.attrelid
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'swarm'
      AND c.relname = 'channels'
      AND a.attname = 'visibility'
      AND NOT a.attisdropped
  ) THEN
    IF EXISTS (SELECT 1 FROM swarm.channels WHERE visibility = 'private') THEN
      RAISE EXCEPTION 'ROLLBACK_REFUSED_PRIVATE_CHANNELS_EXIST: cannot drop private channel schema while visibility=private rows exist'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  IF to_regclass('swarm.file_channel_bindings') IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM swarm.file_channel_bindings AS fb
      JOIN swarm.channels AS c ON c.channel_id = fb.channel_id
      WHERE c.visibility = 'private'
    ) THEN
      RAISE EXCEPTION 'ROLLBACK_REFUSED_PRIVATE_FILE_BINDINGS_EXIST: cannot drop file_channel_bindings while private channel bindings exist'
        USING ERRCODE = '55000';
    END IF;
  END IF;
END
$org_workspaces_channels_rollback_guard$;

DROP TRIGGER IF EXISTS file_channel_bindings_private_guard ON swarm.file_channel_bindings;
DROP TRIGGER IF EXISTS signals_private_channel_guard ON swarm.signals;
DROP TRIGGER IF EXISTS channel_memberships_write_guard ON swarm.channel_memberships;
DROP TRIGGER IF EXISTS channels_visibility_transition_guard ON swarm.channels;
DROP TRIGGER IF EXISTS renewal_grants_sync_identity ON swarm.renewal_grants;
DROP TRIGGER IF EXISTS hosted_mcp_seats_sync_identity ON swarm.hosted_mcp_seats;
DROP TRIGGER IF EXISTS agent_principals_sync_identity ON swarm.agent_principals;
DROP TRIGGER IF EXISTS agent_principals_ensure_identity ON swarm.agent_principals;
DROP TRIGGER IF EXISTS memberships_sync_org_grants ON swarm.memberships;
DROP TRIGGER IF EXISTS workspaces_ensure_org_and_slug ON swarm.workspaces;

DROP FUNCTION IF EXISTS swarm.guard_channel_visibility_transition();
DROP FUNCTION IF EXISTS swarm.private_channels_enabled();
DROP FUNCTION IF EXISTS swarm.org_move_workspace(uuid, uuid, uuid, text);
DROP FUNCTION IF EXISTS swarm.can_read_channel_bound_file(uuid, uuid, text, uuid, uuid, uuid);
DROP FUNCTION IF EXISTS swarm.can_read_channel(uuid, text, uuid, uuid, uuid);
DROP FUNCTION IF EXISTS swarm.can_read_workspace(uuid, text, uuid, uuid, uuid);
DROP FUNCTION IF EXISTS swarm.can_read_org(uuid, text, uuid, uuid, uuid);
DROP FUNCTION IF EXISTS swarm.has_live_ws_grant(uuid, text, uuid);
DROP FUNCTION IF EXISTS swarm.live_org_role(uuid, text, uuid);
DROP FUNCTION IF EXISTS swarm.sync_standing_grant_to_agent_identity();
DROP FUNCTION IF EXISTS swarm.ensure_agent_principal_identity();
DROP FUNCTION IF EXISTS swarm.sync_legacy_membership_to_org_grants();
DROP FUNCTION IF EXISTS swarm.ensure_workspace_org_and_slug();

DROP TABLE IF EXISTS swarm.org_approval_requests;
DROP TABLE IF EXISTS swarm.file_channel_bindings;
DROP TABLE IF EXISTS swarm.channel_memberships;
DROP TABLE IF EXISTS swarm.connection_org_policies;
DROP TABLE IF EXISTS swarm.workspace_principal_grants;
DROP TABLE IF EXISTS swarm.org_invites;
DROP TABLE IF EXISTS swarm.org_memberships;

ALTER TABLE swarm.channels
  DROP CONSTRAINT IF EXISTS channels_private_join_policy_check,
  DROP COLUMN IF EXISTS topic,
  DROP COLUMN IF EXISTS join_policy,
  DROP COLUMN IF EXISTS visibility;

DROP INDEX IF EXISTS swarm.workspaces_org_slug_lower_key;
ALTER TABLE swarm.workspaces
  DROP COLUMN IF EXISTS slug,
  DROP COLUMN IF EXISTS org_id;

DROP INDEX IF EXISTS swarm.agent_principals_workspace_identity_key;
ALTER TABLE swarm.agent_principals
  DROP CONSTRAINT IF EXISTS agent_principals_workspace_identity_key,
  DROP COLUMN IF EXISTS agent_identity_id;

DROP TABLE IF EXISTS swarm.organizations;
DROP TABLE IF EXISTS swarm.agent_identities;

COMMIT;
