-- Read-only invariant proof: a new table, so no grants exist yet, and none is active twice per agent.
DO $proof$ BEGIN
 IF (SELECT count(*) FROM swarm.seat_admin_grants) <> 0 THEN
   RAISE EXCEPTION 'seat admin grants exist before the feature shipped' USING ERRCODE='55000'; END IF;
 IF EXISTS(SELECT principal_id FROM swarm.seat_admin_grants WHERE state='active' GROUP BY principal_id HAVING count(*)>1) THEN
   RAISE EXCEPTION 'two active seat admin grants for one agent' USING ERRCODE='55000'; END IF;
END $proof$;
