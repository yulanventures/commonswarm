SELECT to_regclass('swarm.household_object_streams') IS NULL AND to_regclass('swarm.household_object_events') IS NULL AND to_regclass('swarm.household_object_audit') IS NULL AS rollback_ok
\gset
