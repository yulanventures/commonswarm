-- Guarded rollback for 20261109000001: drop the seat admin schema. It refuses while any grant row
-- exists, because those rows are the owner's admin history; end the feature with its switch instead.
SET search_path = swarm, pg_catalog, public;
DO $guard$ BEGIN
 IF EXISTS(SELECT 1 FROM swarm.seat_admin_grants) THEN
   RAISE EXCEPTION 'seat admin grants exist; rollback refused' USING ERRCODE='55000'; END IF;
END $guard$;
DROP FUNCTION swarm_read.my_seat_admin_grants();
DROP TABLE swarm.seat_admin_grants;
DROP FUNCTION swarm.seat_admin_grants_forward_only();
DROP FUNCTION swarm.seat_admin_text_set(text[]);
DROP FUNCTION swarm.seat_admin_uuid_set(uuid[]);
RESET search_path;
