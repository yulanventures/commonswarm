-- Apply before the lane-C rollback, which removes event attribution columns.
DROP FUNCTION IF EXISTS swarm.admin_routine_workspace_history(uuid, uuid, uuid);
