-- Lane 5: authenticated, recipient-bound in-app delivery of existing member invites.
-- Does not mint credentials, enroll agents, or extend the admin OAuth scopes.
-- The read endpoint supplies verified claims. Parse sub directly, as the existing
-- human recovery reader does; swarm_admin has no USAGE on the auth schema.
CREATE FUNCTION swarm_read.human_invitations() RETURNS TABLE(
 invitation_id uuid, workspace_id uuid, workspace_name text, inviter_display_name text,
 expires_at timestamptz
) LANGUAGE sql SECURITY DEFINER STABLE SET search_path=pg_catalog AS $$
 SELECT i.invitation_id,i.workspace_id,w.name,u.display_name,i.expires_at
 FROM swarm.admin_routine_invitations i
 JOIN swarm.workspaces w USING(workspace_id)
 JOIN swarm.users u ON u.user_id=i.owner_user_id
 JOIN swarm.admin_grants g ON g.grant_id=i.parent_admin_grant_id
 JOIN swarm.memberships m ON m.workspace_id=i.workspace_id AND m.user_id=i.owner_user_id
 JOIN swarm.household_workspace_boundaries b ON b.workspace_id=i.workspace_id AND b.purpose='shared'
 WHERE i.recipient_user_id=NULLIF(NULLIF(current_setting('request.jwt.claims',true),'')::jsonb->>'sub','')::uuid AND i.invitation_kind='member' AND i.projection->>'role'='member'
 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>statement_timestamp()
 AND g.state='active' AND g.expires_at>statement_timestamp() AND g.refresh_deadline>statement_timestamp()
 AND g.scope_names @> ARRAY['invites:create']::text[] AND g.target_rules->'recipient_user_ids' ? i.recipient_user_id::text
 AND NOT i.workspace_id=ANY(g.withdrawn_workspace_ids)
 AND (i.workspace_id=ANY(g.workspace_ids) OR (g.workspace_selector='owned_and_selected' AND m.role='owner')
   OR EXISTS(SELECT 1 FROM swarm.admin_created_workspaces c WHERE c.workspace_id=i.workspace_id AND c.grant_id=g.grant_id
      AND c.scope_names @> ARRAY['invites:create']::text[] AND g.created_workspace_policy->'scope_names' ? 'invites:create'))
 AND m.revoked_at IS NULL AND m.role IN ('owner','admin') AND w.archived_at IS NULL
 ORDER BY i.created_at DESC,i.invitation_id LIMIT 100
$$;
ALTER FUNCTION swarm_read.human_invitations() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm_read.human_invitations() FROM PUBLIC,anon,authenticated,swarm_command,swarm_read;
GRANT EXECUTE ON FUNCTION swarm_read.human_invitations() TO swarm_read;
COMMENT ON COLUMN swarm.invitations.email IS 'Recipient address binds the verified human invitation review path. Unconfigured legacy capability acceptance retains its historical behavior.';
-- Reserve rollback is copied verbatim to the reserve and release-proof directories.
-- -- Keep consumed invites, memberships, consent, events and audit. Remove only delivery admission.
-- DROP FUNCTION IF EXISTS swarm_read.human_invitations();
-- COMMENT ON COLUMN swarm.invitations.email IS 'Bookkeeping and invite-page rendering only; never an authorization input.';
