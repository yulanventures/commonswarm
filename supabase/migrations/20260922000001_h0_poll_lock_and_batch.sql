-- H0 poll lock and batch record.
-- Spec: docs/design/2026-09-15-H0-LINK-JOIN.md section 6, on spec/h0-link-join.
--
-- The poll lock replaces an in-process overlap flag. Its expiry is set by the
-- h0 function to wait plus cleanup plus one extra second, which is strictly
-- longer than the maximum wait (50 seconds) plus cleanup. The row also keeps
-- the seat's listener_instance_id, which does not change when the lock moves.
--
-- The batch record stores lease ids for one poll response. One ACTIVE batch
-- per seat is a partial unique index, which is the schema constraint Postgres
-- can express for "unique where status = active". An expired batch is closed.
-- Its rows are not re-leased from the stored ids.

CREATE TABLE swarm.h0_poll_locks (
  workspace_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  holder uuid NOT NULL,
  listener_instance_id uuid NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, principal_id),
  FOREIGN KEY (principal_id, workspace_id)
    REFERENCES swarm.agent_principals (principal_id, workspace_id),
  CHECK (expires_at >= acquired_at)
);

COMMENT ON TABLE swarm.h0_poll_locks IS
  'One poll lock per H0 seat. A second poll is refused while expires_at is in the future.';
COMMENT ON COLUMN swarm.h0_poll_locks.holder IS
  'The poll request that holds the lock. A later poll takes the row only after expires_at.';
COMMENT ON COLUMN swarm.h0_poll_locks.listener_instance_id IS
  'Stable per seat. Poll returns it and ack sends it back. It does not change when the holder changes.';
COMMENT ON COLUMN swarm.h0_poll_locks.expires_at IS
  'Strictly later than the poll wait plus cleanup. The writer adds one extra second beyond that sum.';

ALTER TABLE swarm.h0_poll_locks OWNER TO swarm_admin;
ALTER TABLE swarm.h0_poll_locks ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION swarm.h0_poll_locks_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'SWARM_H0_POLL_LOCK_IMMUTABLE'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.principal_id IS DISTINCT FROM OLD.principal_id
    OR NEW.listener_instance_id IS DISTINCT FROM OLD.listener_instance_id
  THEN
    RAISE EXCEPTION 'SWARM_H0_POLL_LOCK_IMMUTABLE'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END
$$;

ALTER FUNCTION swarm.h0_poll_locks_guard() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.h0_poll_locks_guard()
  FROM PUBLIC, anon, authenticated;

CREATE TRIGGER h0_poll_locks_guard
  BEFORE UPDATE OR DELETE ON swarm.h0_poll_locks
  FOR EACH ROW EXECUTE FUNCTION swarm.h0_poll_locks_guard();

REVOKE ALL ON TABLE swarm.h0_poll_locks
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON swarm.h0_poll_locks TO swarm_command;

CREATE POLICY swarm_command_all ON swarm.h0_poll_locks
  AS PERMISSIVE FOR ALL TO swarm_command
  USING (true) WITH CHECK (true);

CREATE TABLE swarm.h0_poll_batches (
  workspace_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  lease_ids uuid[] NOT NULL,
  status text NOT NULL,
  expires_at timestamptz NOT NULL,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (workspace_id, principal_id, batch_id),
  FOREIGN KEY (principal_id, workspace_id)
    REFERENCES swarm.agent_principals (principal_id, workspace_id),
  CHECK (status IN ('active', 'closed')),
  CHECK (cardinality(lease_ids) BETWEEN 1 AND 10),
  CHECK (
    (status = 'active' AND closed_at IS NULL)
    OR (status = 'closed' AND closed_at IS NOT NULL)
  )
);

-- The UNIQUE ACTIVE constraint. Postgres has no partial UNIQUE table
-- constraint, so the unique index is the schema rule: one active batch
-- per (workspace_id, principal_id).
CREATE UNIQUE INDEX h0_poll_batches_one_active
  ON swarm.h0_poll_batches (workspace_id, principal_id)
  WHERE status = 'active';

COMMENT ON TABLE swarm.h0_poll_batches IS
  'Transport batch for one H0 poll. ackBatch closes the row and advances no delivery state.';
COMMENT ON COLUMN swarm.h0_poll_batches.lease_ids IS
  'Lease ids returned in that poll, oldest first. An expired batch is closed; these ids are not re-leased.';
COMMENT ON INDEX swarm.h0_poll_batches_one_active IS
  'UNIQUE ACTIVE constraint on (workspace_id, principal_id).';

ALTER TABLE swarm.h0_poll_batches OWNER TO swarm_admin;
ALTER TABLE swarm.h0_poll_batches ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION swarm.h0_poll_batches_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
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

CREATE TRIGGER h0_poll_batches_guard
  BEFORE UPDATE OR DELETE ON swarm.h0_poll_batches
  FOR EACH ROW EXECUTE FUNCTION swarm.h0_poll_batches_guard();

REVOKE ALL ON TABLE swarm.h0_poll_batches
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON swarm.h0_poll_batches TO swarm_command;

CREATE POLICY swarm_command_all ON swarm.h0_poll_batches
  AS PERMISSIVE FOR ALL TO swarm_command
  USING (true) WITH CHECK (true);
