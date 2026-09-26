-- RESERVE ONLY. Roll back the edge and clients before removing reply_status.
\set ON_ERROR_STOP 1
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Restore the exact receipt wrapper from 20260925000001.
CREATE OR REPLACE FUNCTION swarm_read.signal_delivery_receipts(
  p_workspace_id uuid, p_signal_id uuid, p_agent_token_hash bytea DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = swarm, pg_catalog AS $$
DECLARE
  v_result jsonb;
  v_receipts jsonb;
BEGIN
  v_result := swarm_read.signal_delivery_receipts_without_wake_path(
    p_workspace_id, p_signal_id, p_agent_token_hash);
  IF v_result IS NULL OR v_result ->> 'addressed' <> 'true' THEN RETURN v_result; END IF;
  SELECT COALESCE(jsonb_agg(
    CASE WHEN receipt.value ? 'recipient_agent_principal_id' THEN
      receipt.value || jsonb_build_object('wake_path_observing', EXISTS (
        SELECT 1 FROM swarm.wake_path_eligible_deliveries AS d
        WHERE d.workspace_id = p_workspace_id AND d.signal_id = p_signal_id
          AND d.principal_id = (receipt.value ->> 'recipient_agent_principal_id')::uuid
      ))
    ELSE receipt.value END ORDER BY receipt.ordinality), '[]'::jsonb)
  INTO v_receipts FROM jsonb_array_elements(v_result -> 'receipts')
    WITH ORDINALITY AS receipt(value, ordinality);
  RETURN jsonb_set(v_result, '{receipts}', v_receipts, false);
END;
$$;
ALTER FUNCTION swarm_read.signal_delivery_receipts(uuid, uuid, bytea) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm_read.signal_delivery_receipts(uuid, uuid, bytea) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION swarm_read.signal_delivery_receipts(uuid, uuid, bytea)
  TO authenticated, swarm_read;

-- A view cannot lose a projected column through CREATE OR REPLACE, so rebuild
-- it from its live definition after removing only the last explicit column.
DO $$
DECLARE
  live_def text := pg_get_viewdef('swarm_read.signals'::regclass, true);
  previous_def text;
BEGIN
  previous_def := regexp_replace(
    live_def,
    ',\s*s\.reply_status(\s+FROM\s+(?:swarm\.)?signals\s)',
    '\1'
  );
  IF previous_def = live_def THEN
    RAISE EXCEPTION 'could not remove reply_status from swarm_read.signals';
  END IF;
  previous_def := rtrim(previous_def, E' ;\n\t');
  DROP VIEW swarm_read.signals;
  EXECUTE 'CREATE VIEW swarm_read.signals WITH (security_barrier = true) AS ' || previous_def;
END;
$$;
ALTER VIEW swarm_read.signals OWNER TO swarm_admin;
GRANT SELECT ON swarm_read.signals TO authenticated, swarm_read;
REVOKE ALL ON swarm_read.signals FROM anon;

ALTER TABLE swarm.signals DROP COLUMN reply_status;
DELETE FROM supabase_migrations.schema_migrations
WHERE version = '20260927000001';

\i /proof/20260927000001-rollback-catalog.sql
\if :rollback_ok
  COMMIT;
\else
  ROLLBACK;
  DO $$ BEGIN RAISE EXCEPTION 'reply-status rollback catalog proof FAILED; transaction rolled back'; END $$;
\endif
