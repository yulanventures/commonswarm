-- Read-only rollback catalog verification for 20261109000001.
SELECT to_regclass('swarm.seat_admin_grants') IS NULL
 AND to_regprocedure('swarm_read.my_seat_admin_grants()') IS NULL
 AND to_regprocedure('swarm.seat_admin_grants_forward_only()') IS NULL
 AND to_regprocedure('swarm.seat_admin_org_owner(uuid,uuid)') IS NULL
 AND to_regprocedure('swarm.seat_admin_text_set(text[])') IS NULL
 AND to_regprocedure('swarm.seat_admin_uuid_set(uuid[])') IS NULL
 AS rollback_ok
\gset
