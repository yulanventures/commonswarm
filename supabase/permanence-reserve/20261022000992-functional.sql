-- Read-only functional check after 20261022000992: the stamp columns, the stamp
-- trigger and both same-transaction guards exist, every signal carries both
-- stamps or neither, and the guarded child tables can be read. Raises when any
-- object is missing or the stamp invariant is broken.
DO $proof$ BEGIN
  IF to_regprocedure('swarm.stamp_signal_creation_xact()') IS NULL
    OR to_regprocedure('swarm.require_new_signal_for_recipient()') IS NULL
    OR to_regprocedure('swarm.require_new_signal_for_attachment()') IS NULL
    OR (SELECT count(*) FROM pg_attribute WHERE attrelid=to_regclass('swarm.signals')
        AND attname IN ('creation_xact_id','creation_system_identifier') AND NOT attisdropped)<>2
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('swarm.signals')
        AND tgname='signals_stamp_creation_xact' AND NOT tgisinternal AND tgenabled='O') THEN
    RAISE EXCEPTION 'signal creation stamp objects are absent';
  END IF;
  -- The trigger writes both stamps together; rows from before the migration carry neither.
  IF EXISTS (SELECT 1 FROM swarm.signals WHERE (creation_xact_id IS NULL)<>(creation_system_identifier IS NULL)) THEN
    RAISE EXCEPTION 'signal creation stamps are inconsistent';
  END IF;
  PERFORM count(*) FROM swarm.signal_recipients;
  PERFORM count(*) FROM swarm.signal_attachments;
END $proof$;
