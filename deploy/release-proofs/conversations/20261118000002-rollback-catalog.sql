-- Read-only rollback catalog verification for 20261118000002: every conversation object is gone; signals are untouched.
SELECT to_regclass('swarm.conversations') IS NULL
 AND to_regclass('swarm.conversation_members') IS NULL
 AND to_regclass('swarm.conversation_signals') IS NULL
 AND to_regprocedure('swarm.conversation_signal_guard()') IS NULL
 AND to_regprocedure('swarm.conversation_for_members(uuid,text,uuid,uuid[],uuid[])') IS NULL
 AND to_regprocedure('swarm.file_direct_messages()') IS NULL
 AND to_regprocedure('swarm.prevent_append_only_mutation()') IS NOT NULL
 AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='swarm.signals'::regclass AND tgname='signals_append_only' AND tgenabled='O')
 AS rollback_ok
\gset
