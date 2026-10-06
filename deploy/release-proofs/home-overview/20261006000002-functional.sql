-- Read-only human overview. No household rows are required. Compare counts
-- with base rows; do not use the helper under test as the access oracle.
DO $proof$
DECLARE
 original_role text := current_user;
 person uuid;
 value jsonb;
 section jsonb;
 allowed boolean;
 expected_ids uuid[];
 observed_ids uuid[];
 expected_open bigint;
 expected_assigned uuid[];
 observed_assigned uuid[];
BEGIN
 FOREACH value IN ARRAY ARRAY['{}'::jsonb,
  '{"role":"authenticated","sub":"malformed"}'::jsonb,
  '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000000","agent_principal_id":null}'::jsonb] LOOP
  PERFORM set_config('request.jwt.claims',value::text,true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  value := swarm_read.home_overview();
  EXECUTE format('SET LOCAL ROLE %I',original_role);
  IF value IS NOT NULL THEN RAISE EXCEPTION 'overview admitted a non-human identity'; END IF;
 END LOOP;
 FOR person IN SELECT user_id FROM swarm.users
  UNION SELECT '00000000-0000-0000-0000-000000000000'::uuid LOOP
  SELECT coalesce(array_agg(workspace_id ORDER BY created_at,workspace_id),'{}'::uuid[])
   INTO expected_ids FROM (SELECT w.workspace_id,w.created_at
    FROM swarm.workspaces w JOIN swarm.memberships m USING(workspace_id)
    WHERE m.user_id=person AND m.revoked_at IS NULL AND w.archived_at IS NULL
    ORDER BY w.created_at,w.workspace_id LIMIT 50) visible;
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',person,'role','authenticated')::text,true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  value := swarm_read.home_overview();
  EXECUTE format('SET LOCAL ROLE %I',original_role);
  IF value IS NULL OR jsonb_typeof(value->'workspaces') IS DISTINCT FROM 'array'
   OR jsonb_typeof(value->'generated_at') IS DISTINCT FROM 'string' THEN
   RAISE EXCEPTION 'overview shape failed';
  END IF;
  SELECT coalesce(array_agg((w->>'workspace_id')::uuid ORDER BY ordinal),'{}'::uuid[])
   INTO observed_ids FROM jsonb_array_elements(value->'workspaces') WITH ORDINALITY AS entries(w,ordinal);
  IF observed_ids IS DISTINCT FROM expected_ids THEN RAISE EXCEPTION 'overview workspace filter or order failed'; END IF;
  FOR section IN SELECT w FROM jsonb_array_elements(value->'workspaces') w LOOP
   SELECT EXISTS (SELECT 1 FROM swarm.household_workspace_boundaries b
    JOIN swarm.household_member_content_roles r USING(workspace_id)
    WHERE b.workspace_id=(section->>'workspace_id')::uuid AND r.user_id=person
     AND (b.purpose='shared' OR b.owner_user_id=person)
     AND r.revoked_at IS NULL AND r.content_consent_id IS NOT NULL AND r.content_role IN ('reader','editor')) INTO allowed;
   IF swarm.household_human_can_read((section->>'workspace_id')::uuid,person) IS DISTINCT FROM allowed THEN
    RAISE EXCEPTION 'overview consent helper failed';
   END IF;
   IF NOT allowed THEN
    IF section->'content' IS DISTINCT FROM 'null'::jsonb
     OR section->'needs_you'->'assigned' IS DISTINCT FROM '[]'::jsonb
     OR section->'needs_you'->'waiting' IS DISTINCT FROM '[]'::jsonb THEN
     RAISE EXCEPTION 'overview exposed household content without consent';
    END IF;
   ELSE
    SELECT count(*) INTO expected_open FROM swarm.household_todos
     WHERE workspace_id=(section->>'workspace_id')::uuid AND state IN ('open','doing');
    IF (section->'content'->>'open_todos')::bigint IS DISTINCT FROM expected_open THEN
     RAISE EXCEPTION 'overview open to-do count failed';
    END IF;
    SELECT coalesce(array_agg(todo_id ORDER BY state_at DESC,todo_id),'{}'::uuid[]) INTO expected_assigned
     FROM (SELECT todo_id,state_at FROM swarm.household_todos
      WHERE workspace_id=(section->>'workspace_id')::uuid AND assignee_user=person AND state IN ('open','doing')
      ORDER BY state_at DESC,todo_id LIMIT 20) assigned;
    SELECT coalesce(array_agg((t->>'todo_id')::uuid ORDER BY ordinal),'{}'::uuid[]) INTO observed_assigned
     FROM jsonb_array_elements(section->'needs_you'->'assigned') WITH ORDINALITY AS entries(t,ordinal);
    IF observed_assigned IS DISTINCT FROM expected_assigned THEN RAISE EXCEPTION 'overview assigned to-dos failed'; END IF;
   END IF;
  END LOOP;
 END LOOP;
END
$proof$;
SELECT '20261006000002 functional proof passed' AS result;
