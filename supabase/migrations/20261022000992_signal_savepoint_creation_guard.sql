-- Savepoint-safe creation proof for immutable signal child rows.
-- A row inserted after SAVEPOINT has a child xmin, while pg_current_xact_id()
-- names the top-level transaction. Store that full epoch-aware xid8 at INSERT.
-- NULL on pre-migration rows deliberately keeps every old signal closed.
-- Retain this additive schema on compatible code rollback: no reverse DDL while
-- users are active. No client policy, grants, receipts or public views change.
ALTER TABLE swarm.signals ADD COLUMN creation_xact_id xid8;

CREATE FUNCTION swarm.stamp_signal_creation_xact()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  -- Unconditionally replace caller input, including an explicit NULL or xid.
  NEW.creation_xact_id := pg_current_xact_id();
  RETURN NEW;
END;
$$;
ALTER FUNCTION swarm.stamp_signal_creation_xact() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.stamp_signal_creation_xact() FROM PUBLIC;

CREATE TRIGGER signals_stamp_creation_xact
  BEFORE INSERT ON swarm.signals
  FOR EACH ROW EXECUTE FUNCTION swarm.stamp_signal_creation_xact();

COMMENT ON COLUMN swarm.signals.creation_xact_id IS
  'Internal server-stamped top-level xid8; immutable with the signal, absent from public read projections. NULL legacy rows remain closed.';

-- Existing append-only triggers and INSERT-only command grants prevent re-stamps.
-- Full xid8 equality distinguishes epochs and concurrent transactions. MVCC plus
-- the immutable stamp admits only a row inserted by this top-level transaction;
-- SAVEPOINT rollback removes the row and stamp together, RELEASE retains both.

CREATE OR REPLACE FUNCTION swarm.require_new_signal_for_recipient()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = swarm, pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM swarm.signals AS signal
    WHERE signal.id = NEW.signal_id
      AND signal.workspace_id = NEW.workspace_id
      AND signal.creation_xact_id = pg_current_xact_id()
  ) THEN
    RAISE EXCEPTION 'signal recipients can be inserted only with a new signal'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION swarm.require_new_signal_for_recipient() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.require_new_signal_for_recipient() FROM PUBLIC;


CREATE OR REPLACE FUNCTION swarm.require_new_signal_for_attachment()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = swarm, pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM swarm.signals AS signal
    WHERE signal.id = NEW.signal_id
      AND signal.workspace_id = NEW.workspace_id
      AND signal.creation_xact_id = pg_current_xact_id()
  ) THEN
    RAISE EXCEPTION 'signal attachments can be inserted only with a new signal'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION swarm.require_new_signal_for_attachment() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.require_new_signal_for_attachment() FROM PUBLIC;
