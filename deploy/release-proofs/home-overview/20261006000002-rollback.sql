-- Remove the read surface before rolling back the to-do tables. No history is removed.
DROP FUNCTION IF EXISTS swarm_read.home_overview();
DROP FUNCTION IF EXISTS swarm.household_human_can_read(uuid, uuid);
