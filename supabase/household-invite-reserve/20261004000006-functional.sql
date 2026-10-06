-- Read-only recipient delivery. Never display invitation or account details.
DO $proof$
DECLARE
 original_role text := current_user;
 person uuid;
 expected jsonb;
 delivered jsonb;
 empty_count bigint;
BEGIN
 PERFORM set_config('request.jwt.claims','{}',true);
 EXECUTE 'SET LOCAL ROLE swarm_read';
 SELECT count(*) INTO empty_count FROM swarm_read.human_invitations();
 EXECUTE format('SET LOCAL ROLE %I',original_role);
 IF empty_count<>0 THEN RAISE EXCEPTION 'invitations require a recipient'; END IF;
 FOR person IN SELECT user_id FROM swarm.users LOOP
  -- The private-table oracle runs only with the original privileged role.
  -- Include ordering, the bound and all delivery fields, not just validity of
  -- rows returned: an empty function must fail when a pending invite exists.
  SELECT coalesce(jsonb_agg(row_value ORDER BY created_at DESC,invitation_id),'[]'::jsonb)
   INTO expected FROM (
    SELECT i.created_at,i.invitation_id,jsonb_build_object(
     'invitation_id',i.invitation_id,'workspace_id',i.workspace_id,
     'workspace_name',w.name,'inviter_display_name',u.display_name,
     'expires_at',i.expires_at) AS row_value
    FROM swarm.admin_routine_invitations i
    JOIN swarm.workspaces w USING(workspace_id)
    JOIN swarm.users u ON u.user_id=i.owner_user_id
    JOIN swarm.admin_grants g ON g.grant_id=i.parent_admin_grant_id
    JOIN swarm.memberships m ON m.workspace_id=i.workspace_id AND m.user_id=i.owner_user_id
    JOIN swarm.household_workspace_boundaries b ON b.workspace_id=i.workspace_id
    WHERE i.recipient_user_id=person AND i.invitation_kind='member'
     AND i.projection->>'role'='member' AND i.accepted_at IS NULL AND i.revoked_at IS NULL
     AND i.expires_at>statement_timestamp() AND b.purpose='shared'
     AND g.state='active' AND g.expires_at>statement_timestamp() AND g.refresh_deadline>statement_timestamp()
     AND g.scope_names @> ARRAY['invites:create']::text[]
     AND g.target_rules->'recipient_user_ids' ? person::text
     AND NOT i.workspace_id=ANY(g.withdrawn_workspace_ids)
     AND (i.workspace_id=ANY(g.workspace_ids)
      OR (g.workspace_selector='owned_and_selected' AND m.role='owner')
      OR EXISTS(SELECT 1 FROM swarm.admin_created_workspaces c
       WHERE c.workspace_id=i.workspace_id AND c.grant_id=g.grant_id
        AND c.scope_names @> ARRAY['invites:create']::text[]
        AND g.created_workspace_policy->'scope_names' ? 'invites:create'))
     AND m.revoked_at IS NULL AND m.role IN ('owner','admin') AND w.archived_at IS NULL
    ORDER BY i.created_at DESC,i.invitation_id LIMIT 100
   ) eligible;
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',person,'role','authenticated')::text,true);
  -- Under swarm_read, call only the recipient function. Carry its result in
  -- memory across the role restoration; never join private tables as swarm_read.
  EXECUTE 'SET LOCAL ROLE swarm_read';
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'invitation_id',invitation_id,'workspace_id',workspace_id,
    'workspace_name',workspace_name,'inviter_display_name',inviter_display_name,
    'expires_at',expires_at) ORDER BY ordinal),'[]'::jsonb)
   INTO delivered FROM swarm_read.human_invitations() WITH ORDINALITY AS inbox(
    invitation_id,workspace_id,workspace_name,inviter_display_name,expires_at,ordinal);
  EXECUTE format('SET LOCAL ROLE %I',original_role);
  IF delivered IS DISTINCT FROM expected THEN
   RAISE EXCEPTION 'invitation recipient delivery mismatch' USING ERRCODE='ZP006';
  END IF;
 END LOOP;
END
$proof$;
SELECT '20261004000006 functional proof passed' AS result;
