-- Section 5 read-only functional check: the two guarded relations can be read.
DO $proof$ BEGIN
  IF to_regclass('swarm.h0_poll_locks') IS NULL OR to_regclass('swarm.h0_poll_batches') IS NULL
    OR to_regclass('swarm.h0_poll_batches_one_active') IS NULL THEN
    RAISE EXCEPTION 'H0 poll base objects are absent';
  END IF;
  PERFORM count(*) FROM swarm.h0_poll_locks;
  PERFORM count(*) FROM swarm.h0_poll_batches;
END $proof$;
