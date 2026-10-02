-- Complete inverse for 20261001000001_admin_delegation.sql.
-- Destructive reserve only; never run by a test without a rollback transaction.
DROP TABLE IF EXISTS swarm.admin_security_audit;
DROP TABLE IF EXISTS swarm.admin_rate_buckets;
DROP TABLE IF EXISTS swarm.admin_command_results;
DROP TABLE IF EXISTS swarm.admin_events;
DROP TABLE IF EXISTS swarm.admin_credentials;
DROP TABLE IF EXISTS swarm.admin_consents;
DROP TABLE IF EXISTS swarm.admin_grants;
DROP TABLE IF EXISTS swarm.admin_accounts;
