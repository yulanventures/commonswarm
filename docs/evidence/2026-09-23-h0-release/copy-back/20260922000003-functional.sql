-- Section 5 read-only functional check: retention has the two-day floor.
DO $proof$ BEGIN
  IF swarm.h0_poll_batch_retention_days() < 2 THEN
    RAISE EXCEPTION 'H0 retention floor is below two days';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname='swarm-purge-h0-poll-batches'
    AND active) THEN RAISE EXCEPTION 'H0 purge schedule is absent'; END IF;
END $proof$;
