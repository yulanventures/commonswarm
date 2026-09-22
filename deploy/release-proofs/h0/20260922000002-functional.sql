-- Section 5 read-only functional check: the wait predicate is queryable.
DO $proof$ DECLARE n bigint; BEGIN
  SELECT count(*) INTO n FROM swarm.h0_poll_locks
  WHERE waiting AND expires_at > statement_timestamp();
  IF n < 0 THEN RAISE EXCEPTION 'invalid waiting count'; END IF;
END $proof$;
