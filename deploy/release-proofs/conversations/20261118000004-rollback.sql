-- Rollback for 20261118000004 (conversations, step 1): drop the triggers it put on existing tables, then
-- every object it created. The migration changed no existing row, so nothing else needs restoring:
-- messages read as before, through swarm_read.signals. HezOps takes a verified full database backup
-- before the release applies the migration.
SET search_path = swarm, pg_catalog, public;
DROP TRIGGER IF EXISTS signals_settle_conversation ON swarm.signals;
DROP TRIGGER IF EXISTS signal_recipients_settle_conversation ON swarm.signal_recipients;
DROP TRIGGER IF EXISTS workspaces_create_general ON swarm.workspaces;
DROP TRIGGER IF EXISTS channels_sync_conversation ON swarm.channels;
DROP FUNCTION IF EXISTS swarm.conversations_backfill();
DROP FUNCTION IF EXISTS swarm.sync_channel_conversation();
DROP FUNCTION IF EXISTS swarm.create_workspace_general();
DROP TABLE IF EXISTS swarm.conversation_reads;
DROP TABLE IF EXISTS swarm.conversation_signals;
DROP TABLE IF EXISTS swarm.conversation_members;
DROP TABLE IF EXISTS swarm.conversations;
DROP FUNCTION IF EXISTS swarm.file_signal_conversation_at_commit();
DROP FUNCTION IF EXISTS swarm.file_conversation_signal(uuid, uuid);
DROP FUNCTION IF EXISTS swarm.conversation_placement(uuid, uuid, boolean);
DROP FUNCTION IF EXISTS swarm.conversation_for_members(uuid, text, uuid, uuid[], uuid[], boolean, timestamptz);
DROP FUNCTION IF EXISTS swarm.conversation_for_channel(uuid, uuid);
DROP FUNCTION IF EXISTS swarm.conversation_general(uuid);
DROP FUNCTION IF EXISTS swarm.conversation_signal_guard();
DROP FUNCTION IF EXISTS swarm.conversation_member_guard();
DROP FUNCTION IF EXISTS swarm.conversation_identity_guard();
RESET search_path;
