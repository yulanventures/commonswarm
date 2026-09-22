-- Deployment-wide admission for H0 polls that are waiting.
--
-- swarm.h0_poll_locks.waiting marks the holder that is waiting for messages.
-- A row counts while waiting is true and expires_at is in the future, in
-- every workspace. The h0 function takes pg_advisory_xact_lock on
-- ('h0-wait-admission', 'deployment') and then sets waiting in that same
-- transaction, so two workers cannot both pass the count.
--
-- Release sets waiting to false and expires_at to now. A row whose release
-- never runs stops counting when expires_at passes. The guard trigger does
-- not freeze this column.

ALTER TABLE swarm.h0_poll_locks
  ADD COLUMN waiting boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN swarm.h0_poll_locks.waiting IS
  'True while this poll holds a deployment-wide waiting slot. Counted only while expires_at is in the future.';

CREATE INDEX h0_poll_locks_waiting
  ON swarm.h0_poll_locks (expires_at)
  WHERE waiting;
