-- Section 5: read-only execution, including the empty-household production case.
-- Role and claims changes are transaction-local; output contains no user data.
DO $proof$
DECLARE
 original_role text := current_user;
 t record;
 r text;
 baseline bigint;
 observed bigint;
BEGIN
 FOR t IN SELECT * FROM (VALUES
   ('household_member_content_roles',true),
   ('household_content_connections',true)) AS expected(name, command_read) LOOP
  IF to_regclass('swarm.' || t.name) IS NULL THEN
   RAISE EXCEPTION 'required household relation missing';
  END IF;
  EXECUTE format('SELECT count(*) FROM swarm.%I', t.name) INTO baseline;
  FOREACH r IN ARRAY ARRAY['swarm_command','swarm_read','anon','authenticated'] LOOP
   -- Check effective table access too: schema denial alone is not evidence
   -- of the private-table contract.
   IF coalesce(has_table_privilege(r,to_regclass('swarm.' || t.name),'SELECT'),false)
      IS DISTINCT FROM (r='swarm_command' AND t.command_read) THEN
    RAISE EXCEPTION 'household read access mismatch';
   END IF;
   EXECUTE format('SET LOCAL ROLE %I',r);
   IF r='swarm_command' AND t.command_read THEN
    EXECUTE format('SELECT count(*) FROM swarm.%I',t.name) INTO observed;
    IF observed IS DISTINCT FROM baseline THEN
     RAISE EXCEPTION 'household command read filtered rows';
    END IF;
   ELSE
    BEGIN
     EXECUTE format('SELECT count(*) FROM swarm.%I',t.name) INTO observed;
     RAISE EXCEPTION 'private household read admitted';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
   END IF;
   EXECUTE format('SET LOCAL ROLE %I',original_role);
  END LOOP;
 END LOOP;
END
$proof$;
DO $repair$
BEGIN
 IF EXISTS (SELECT 1 FROM swarm.household_member_content_roles r
  JOIN swarm.memberships m USING(workspace_id,user_id)
  WHERE m.revoked_at IS NOT NULL AND r.revoked_at IS NULL)
 OR EXISTS (SELECT 1 FROM swarm.household_content_connections c
  JOIN swarm.memberships m ON m.workspace_id=c.workspace_id AND m.user_id=c.owner_user_id
  WHERE m.revoked_at IS NOT NULL AND c.revoked_at IS NULL)
 OR EXISTS (SELECT 1 FROM swarm.admin_routine_invitations i
  JOIN swarm.memberships m ON m.workspace_id=i.workspace_id AND m.user_id=i.recipient_user_id
  WHERE m.revoked_at IS NOT NULL AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.created_at<=m.revoked_at)
 OR EXISTS (SELECT 1 FROM swarm.invitations i
  JOIN swarm.users u ON lower(i.email)=lower(u.email)
  JOIN swarm.memberships m ON m.workspace_id=i.workspace_id AND m.user_id=u.user_id
  WHERE m.revoked_at IS NOT NULL AND i.consumed_at IS NULL AND i.revoked_at IS NULL
   AND i.created_at<=m.revoked_at AND i.expires_at>statement_timestamp()) THEN
  RAISE EXCEPTION 'member removal repair left live access';
 END IF;
END
$repair$;
SELECT '20261005000001 functional proof passed' AS result;
