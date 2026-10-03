-- Dropping the ledgers removes their INSERT-only command grants.
DROP TABLE IF EXISTS swarm.household_object_audit;
DROP TABLE IF EXISTS swarm.household_object_events;
DROP TABLE IF EXISTS swarm.household_object_streams;
