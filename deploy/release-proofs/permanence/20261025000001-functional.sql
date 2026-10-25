-- Read-only functional check after 20261025000001: the journal is readable and
-- the completion predicate holds. Raises when any object is missing.
DO $proof$ BEGIN
  IF to_regclass('swarm.permanence_grandfather_journal') IS NULL
    OR to_regprocedure('swarm.permanence_grandfather_complete()') IS NULL
    OR to_regprocedure('swarm.permanence_grandfather_restored()') IS NULL THEN
    RAISE EXCEPTION 'permanence grandfather objects are absent';
  END IF;
  PERFORM count(*) FROM swarm.permanence_grandfather_journal;
  IF NOT swarm.permanence_grandfather_complete() THEN
    RAISE EXCEPTION 'permanence grandfather left eligible rows unprocessed';
  END IF;
END $proof$;
