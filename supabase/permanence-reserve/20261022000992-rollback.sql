-- Reverse of 20261022000992. Run inside one transaction as a swarm_admin member,
-- after the 20261025000001 reserve and before the 20261021000990 reserve.
-- Removes the stamp trigger and its function, restores both same-transaction
-- guards to the bodies 20260905000010 (recipients) and 20260901000010
-- (attachments) installed, which compare the parent row's xmin with the
-- top-level xid, and drops the two stamp columns. The stamps only ever bind
-- child rows inside the transaction that created the signal, so dropping them
-- loses no committed authority and no owner-chosen value; every signal,
-- recipient, attachment and delivery row stays. Rolling forward again re-adds
-- the columns as NULL on all existing rows, which the forward guard treats as
-- closed, exactly as it treated rows from before 00992. Owners and EXECUTE
-- grants of the guards are preserved by CREATE OR REPLACE.
DROP TRIGGER signals_stamp_creation_xact ON swarm.signals;
DROP FUNCTION swarm.stamp_signal_creation_xact();

-- swarm.require_new_signal_for_recipient(): 20260905000010 body.
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
      AND signal.xmin::text::bigint =
        (pg_current_xact_id()::text::bigint & 4294967295)
  ) THEN
    RAISE EXCEPTION 'signal recipients can be inserted only with a new signal'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

-- swarm.require_new_signal_for_attachment(): 20260901000010 body.
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
      AND signal.xmin::text::bigint =
        (pg_current_xact_id()::text::bigint & 4294967295)
  ) THEN
    RAISE EXCEPTION 'signal attachments can be inserted only with a new signal'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE swarm.signals
  DROP COLUMN creation_xact_id,
  DROP COLUMN creation_system_identifier;
