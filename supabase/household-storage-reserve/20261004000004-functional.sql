-- Read-only legacy metadata fence. Test real identities, or an absent identity
-- when there are no users. Return only a constant success label.
DO $proof$
DECLARE
 original_role text := current_user;
 person uuid;
 expected uuid[];
 observed uuid[];
BEGIN
 FOR person IN SELECT user_id FROM swarm.users
  UNION SELECT '00000000-0000-0000-0000-000000000000'::uuid LOOP
  SELECT coalesce(array_agg(f.file_id ORDER BY f.file_id),'{}'::uuid[]) INTO expected
   FROM swarm.files f JOIN swarm.memberships m USING(workspace_id)
   JOIN swarm.workspaces w USING(workspace_id)
   WHERE m.user_id=person AND m.revoked_at IS NULL AND w.archived_at IS NULL
    AND f.purged_at IS NULL AND NOT f.household_managed;
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',person,'role','authenticated')::text,true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT coalesce(array_agg(file_id ORDER BY file_id),'{}'::uuid[]) INTO observed FROM swarm_read.files;
  EXECUTE format('SET LOCAL ROLE %I',original_role);
  IF observed IS DISTINCT FROM expected THEN
   RAISE EXCEPTION 'legacy file view exposed managed or inaccessible metadata, or hid legacy files';
  END IF;
 END LOOP;
 -- The purge function writes durable state, so it cannot be run in this proof.
 -- Its body is pinned by the separate catalog proof; do not pretend a read
 -- proves purge execution.
END
$proof$;
SELECT '20261004000004 functional proof passed' AS result;
