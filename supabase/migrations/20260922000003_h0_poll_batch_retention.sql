-- Retention for closed H0 poll batches.
--
-- H0_POLL_BATCH_RETENTION_DAYS is 2. A closed batch older than that may be
-- deleted. swarm.config key h0_poll_batch_retention_days can make the age
-- longer. A lower value does not shorten it: the floor is GREATEST(2, config).
-- The same function feeds the guard and the purge, so the two cannot drift.
--
-- The guard still refuses DELETE of an active batch and of a closed batch
-- that is not yet older than the retention age. Active rows and recent closed
-- rows stay. The purge deletes only rows the guard allows.
--
-- Shape follows purge_expired_idempotency_keys: a checked batch size, a
-- zero-arg wrapper, and the existing cron style. This file adds its own
-- schedule. The box upgrade applies this file after the lock and wait files.

CREATE INDEX IF NOT EXISTS h0_poll_batches_closed_at
  ON swarm.h0_poll_batches (closed_at, workspace_id, principal_id, batch_id)
  WHERE status = 'closed';

CREATE OR REPLACE FUNCTION swarm.h0_poll_batch_retention_days()
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = swarm, pg_catalog
AS $$
DECLARE
  h0_poll_batch_retention_days_floor constant integer := 2;
  configured integer;
BEGIN
  SELECT (value #>> '{}')::integer
    INTO configured
  FROM swarm.config
  WHERE key = 'h0_poll_batch_retention_days';
  IF configured IS NULL THEN
    RETURN h0_poll_batch_retention_days_floor;
  END IF;
  RETURN GREATEST(h0_poll_batch_retention_days_floor, configured);
END;
$$;

ALTER FUNCTION swarm.h0_poll_batch_retention_days() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.h0_poll_batch_retention_days() FROM PUBLIC;

CREATE OR REPLACE FUNCTION swarm.h0_poll_batches_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'closed'
      AND OLD.closed_at IS NOT NULL
      AND OLD.closed_at < statement_timestamp()
        - make_interval(days => swarm.h0_poll_batch_retention_days())
    THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'SWARM_H0_POLL_BATCH_IMMUTABLE'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.principal_id IS DISTINCT FROM OLD.principal_id
    OR NEW.batch_id IS DISTINCT FROM OLD.batch_id
    OR NEW.lease_ids IS DISTINCT FROM OLD.lease_ids
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'SWARM_H0_POLL_BATCH_IMMUTABLE'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status = 'closed' AND (
    NEW.status IS DISTINCT FROM OLD.status
    OR NEW.closed_at IS DISTINCT FROM OLD.closed_at
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
  ) THEN
    RAISE EXCEPTION 'SWARM_H0_POLL_BATCH_IMMUTABLE'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status = 'active' AND NEW.status = 'closed' AND NEW.closed_at IS NULL THEN
    RAISE EXCEPTION 'SWARM_H0_POLL_BATCH_IMMUTABLE'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status = 'active' AND NEW.status = 'active' AND NEW.closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'SWARM_H0_POLL_BATCH_IMMUTABLE'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END
$$;

ALTER FUNCTION swarm.h0_poll_batches_guard() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.h0_poll_batches_guard()
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION swarm.purge_expired_h0_poll_batches(
  batch_size integer
)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = swarm, pg_catalog
AS $$
DECLARE
  deleted integer;
  retain_days integer;
BEGIN
  IF batch_size IS NULL OR batch_size < 1 OR batch_size > 50000 THEN
    RAISE EXCEPTION 'purge batch_size must be between 1 and 50000';
  END IF;
  retain_days := swarm.h0_poll_batch_retention_days();
  DELETE FROM swarm.h0_poll_batches
  WHERE (workspace_id, principal_id, batch_id) IN (
    SELECT workspace_id, principal_id, batch_id
    FROM swarm.h0_poll_batches
    WHERE status = 'closed'
      AND closed_at IS NOT NULL
      AND closed_at < statement_timestamp() - make_interval(days => retain_days)
    ORDER BY closed_at, workspace_id, principal_id, batch_id
    LIMIT batch_size
  );
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$;

ALTER FUNCTION swarm.purge_expired_h0_poll_batches(integer) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.purge_expired_h0_poll_batches(integer) FROM PUBLIC;

CREATE OR REPLACE FUNCTION swarm.purge_expired_h0_poll_batches()
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = swarm, pg_catalog
AS $$
DECLARE
  n integer;
  batches integer := 0;
BEGIN
  LOOP
    n := swarm.purge_expired_h0_poll_batches(5000);
    batches := batches + 1;
    EXIT WHEN n = 0 OR batches >= 200;
  END LOOP;
END;
$$;

ALTER FUNCTION swarm.purge_expired_h0_poll_batches() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.purge_expired_h0_poll_batches() FROM PUBLIC;

SELECT cron.schedule(
  'swarm-purge-h0-poll-batches',
  '29 4 * * *',
  'SELECT swarm.purge_expired_h0_poll_batches()'
);
