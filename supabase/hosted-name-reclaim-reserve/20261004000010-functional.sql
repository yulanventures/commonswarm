-- Read-only live-name lookup, with a planner control even when no rows exist.
-- The catalog proof owns uniqueness and the exact index predicate; this proof
-- exercises the index's usable live lookup and checks current data separately.
DO $proof$
DECLARE
 plan json;
 original_seqscan text := current_setting('enable_seqscan');
 original_bitmapscan text := current_setting('enable_bitmapscan');
BEGIN
 IF EXISTS (SELECT 1 FROM swarm.hosted_mcp_seats WHERE revoked_at IS NULL
  GROUP BY workspace_id,name HAVING count(*)>1) THEN
  RAISE EXCEPTION 'duplicate live agent names';
 END IF;
 PERFORM set_config('enable_seqscan','off',true);
 PERFORM set_config('enable_bitmapscan','off',true);
 EXECUTE $query$EXPLAIN (FORMAT JSON, COSTS OFF)
  SELECT name FROM swarm.hosted_mcp_seats
  WHERE workspace_id='00000000-0000-0000-0000-000000000000'::uuid
   AND name='release-proof-absent' AND revoked_at IS NULL$query$ INTO plan;
 PERFORM set_config('enable_seqscan',original_seqscan,true);
 PERFORM set_config('enable_bitmapscan',original_bitmapscan,true);
 IF position('"Index Name": "hosted_mcp_seats_live_name"' in plan::text)=0 THEN
  RAISE EXCEPTION 'live name lookup cannot use the reclaim index';
 END IF;
END
$proof$;
SELECT '20261004000010 functional proof passed' AS result;
