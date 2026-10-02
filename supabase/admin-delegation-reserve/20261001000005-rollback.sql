-- Apply before the lane-C rollback, which removes event attribution columns.
DROP VIEW IF EXISTS swarm.admin_routine_workspace_events;
