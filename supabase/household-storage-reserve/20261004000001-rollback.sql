-- Dropping these tables removes SELECT and the single-key-column UPDATE lock grants.
DROP TABLE IF EXISTS swarm.household_content_connections;
DROP TABLE IF EXISTS swarm.household_member_content_roles;
DROP TABLE IF EXISTS swarm.household_workspace_boundaries;
