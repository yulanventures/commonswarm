-- Read-only rollback catalog verification for 20261118000004: every conversation object and trigger is gone;
-- the existing message triggers are untouched.
SELECT to_regclass('swarm.conversations') IS NULL
 AND to_regclass('swarm.conversation_members') IS NULL
 AND to_regclass('swarm.conversation_signals') IS NULL
 AND to_regclass('swarm.conversation_reads') IS NULL
 AND NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='swarm'
   AND (p.proname LIKE 'conversation%' OR p.proname IN ('file_conversation_signal','file_signal_conversation_at_commit',
     'create_workspace_general','sync_channel_conversation')))
 AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid IN ('swarm.signals'::regclass,'swarm.signal_recipients'::regclass,
   'swarm.workspaces'::regclass,'swarm.channels'::regclass) AND tgname IN ('signals_settle_conversation',
   'signal_recipients_settle_conversation','workspaces_create_general','channels_sync_conversation'))
 AND to_regprocedure('swarm.prevent_append_only_mutation()') IS NOT NULL
 AND (SELECT count(*)=4 FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='O' AND (tgrelid,tgname) IN (
   ('swarm.signals'::regclass,'signals_append_only'),('swarm.signals'::regclass,'signals_wake_workspace'),
   ('swarm.signals'::regclass,'signals_enqueue_delivery'),('swarm.signal_recipients'::regclass,'signal_recipients_first_is_the_scalar')))
 AS rollback_ok
\gset
