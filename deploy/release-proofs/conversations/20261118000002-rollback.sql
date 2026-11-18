-- Rollback for 20261118000002: drop the conversation objects. No existing row was changed by the
-- migration, so nothing else needs restoring; messages read as addressed messages, as before.
-- HezOps takes a verified full database backup before the release applies the migration.
SET search_path = swarm, pg_catalog, public;
DROP FUNCTION IF EXISTS swarm.file_direct_messages();
DROP FUNCTION IF EXISTS swarm.conversation_for_members(uuid, text, uuid, uuid[], uuid[]);
DROP TABLE IF EXISTS swarm.conversation_signals;
DROP FUNCTION IF EXISTS swarm.conversation_signal_guard();
DROP TABLE IF EXISTS swarm.conversation_members;
DROP TABLE IF EXISTS swarm.conversations;
RESET search_path;
