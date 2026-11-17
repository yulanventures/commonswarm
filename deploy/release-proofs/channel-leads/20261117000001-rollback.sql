-- Rollback for 20261117000001: restore the 20261113000003 swarm_read.channels and drop the channel-lead objects.
-- CREATE OR REPLACE VIEW cannot drop a column, so the view is recreated with its owner and grants.
SET search_path = swarm, pg_catalog, public;
DROP VIEW swarm_read.channels;
CREATE VIEW swarm_read.channels
WITH (security_barrier = true)
AS
  SELECT
    c.channel_id,
    c.workspace_id,
    c.slug,
    c.purpose,
    c.created_by_principal,
    c.created_by_kind,
    c.created_at,
    c.archived_at,
    c.sort_rank,
    c.visibility
  FROM swarm.channels AS c
  WHERE swarm.is_member(c.workspace_id, auth.uid())
    AND swarm.claims_can_access_channel(c.workspace_id, c.channel_id);
ALTER VIEW swarm_read.channels OWNER TO swarm_admin;
GRANT SELECT ON swarm_read.channels TO authenticated, swarm_read;
REVOKE ALL ON swarm_read.channels FROM PUBLIC, anon;
DROP TRIGGER IF EXISTS agent_principals_reset_channel_lead ON swarm.agent_principals;
DROP TRIGGER IF EXISTS agent_workspace_memberships_reset_channel_lead ON swarm.agent_workspace_memberships;
DROP TRIGGER IF EXISTS memberships_reset_channel_lead ON swarm.memberships;
DROP TRIGGER IF EXISTS channel_members_reset_channel_lead ON swarm.channel_members;
DROP FUNCTION IF EXISTS swarm.reset_channel_lead_on_principal_revoke();
DROP FUNCTION IF EXISTS swarm.reset_channel_lead_on_agent_exit();
DROP FUNCTION IF EXISTS swarm.reset_channel_lead_on_owner_exit();
DROP FUNCTION IF EXISTS swarm.reset_channel_lead_on_member_removal();
DROP FUNCTION IF EXISTS swarm.channel_effective_live_lead(uuid, uuid);
ALTER TABLE swarm.channels
  DROP CONSTRAINT IF EXISTS channels_lead_agent_named_check,
  DROP COLUMN IF EXISTS lead_agent_principal_id,
  DROP COLUMN IF EXISTS lead_mode;
RESET search_path;
