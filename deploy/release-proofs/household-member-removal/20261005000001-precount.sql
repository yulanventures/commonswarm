-- READ ONLY. One row: memberships with affected rows, not affected-row totals.
-- Dynamic SELECT avoids parsing absent relations; CASE does not execute it when
-- tables are absent. query_to_xml executes only the fixed read queries below.
SELECT
 CASE WHEN to_regclass('swarm.memberships') IS NOT NULL AND to_regclass('swarm.household_member_content_roles') IS NOT NULL
 THEN (xpath('/row/n/text()',query_to_xml($count$
SELECT count(*) AS n FROM swarm.memberships m
 WHERE m.revoked_at IS NOT NULL AND EXISTS (
  SELECT 1 FROM swarm.household_member_content_roles r
  WHERE r.workspace_id=m.workspace_id AND r.user_id=m.user_id AND r.revoked_at IS NULL)
$count$,false,true,'')))[1]::text::bigint
 ELSE 0::bigint END AS revoked_memberships_with_content_roles,
 CASE WHEN to_regclass('swarm.memberships') IS NOT NULL AND to_regclass('swarm.household_content_connections') IS NOT NULL
 THEN (xpath('/row/n/text()',query_to_xml($count$
SELECT count(*) AS n FROM swarm.memberships m
 WHERE m.revoked_at IS NOT NULL AND EXISTS (
  SELECT 1 FROM swarm.household_content_connections c
  WHERE c.workspace_id=m.workspace_id AND c.owner_user_id=m.user_id AND c.revoked_at IS NULL)
$count$,false,true,'')))[1]::text::bigint
 ELSE 0::bigint END AS revoked_memberships_with_content_connections,
 CASE WHEN to_regclass('swarm.memberships') IS NOT NULL AND to_regclass('swarm.invitations') IS NOT NULL AND to_regclass('swarm.users') IS NOT NULL
 THEN (xpath('/row/n/text()',query_to_xml($count$
SELECT count(*) AS n FROM swarm.memberships m
 JOIN swarm.users u ON u.user_id=m.user_id
 WHERE m.revoked_at IS NOT NULL AND EXISTS (
  SELECT 1 FROM swarm.invitations i
  WHERE i.workspace_id=m.workspace_id AND i.email IS NOT NULL AND lower(i.email)=lower(u.email)
   AND i.created_at<=m.revoked_at AND i.consumed_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>statement_timestamp())
$count$,false,true,'')))[1]::text::bigint
 ELSE 0::bigint END AS revoked_memberships_with_pending_link_invitations,
 CASE WHEN to_regclass('swarm.memberships') IS NOT NULL AND to_regclass('swarm.admin_routine_invitations') IS NOT NULL
 THEN (xpath('/row/n/text()',query_to_xml($count$
SELECT count(*) AS n FROM swarm.memberships m
 WHERE m.revoked_at IS NOT NULL AND EXISTS (
  SELECT 1 FROM swarm.admin_routine_invitations i
  WHERE i.workspace_id=m.workspace_id AND i.recipient_user_id=m.user_id
   AND i.created_at<=m.revoked_at AND i.accepted_at IS NULL AND i.revoked_at IS NULL)
$count$,false,true,'')))[1]::text::bigint
 ELSE 0::bigint END AS revoked_memberships_with_unaccepted_delegated_invitations;
