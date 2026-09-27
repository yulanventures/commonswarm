-- RESERVE ONLY. Roll back the edge and clients before removing reply_status.
\set ON_ERROR_STOP 1
\if :{?release_proof_outer_transaction}
SAVEPOINT release_proof_outer_transaction_guard;
\else
BEGIN;
\endif
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

-- Restore the authored definition that was live immediately before 20260927000001.
-- Dropping is required because CREATE OR REPLACE cannot remove a projected column.
DROP VIEW swarm_read.signals;
CREATE VIEW swarm_read.signals
WITH (security_barrier = true)
AS
  SELECT
    s.id,
    s.workspace_id,
    s.from_principal AS "from",
    s.from_kind,
    s.to_user_id AS "to",
    s.about,
    s.kind,
    s.body,
    s.until,
    s.created_at,
    s.to_agent_principal_id AS to_agent,
    s.in_reply_to,
    COALESCE(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'file_id', attachment.file_id,
            'version_n', attachment.version_n,
            'name', file.name,
            'content_type', version.content_type,
            'size_bytes', version.size_bytes::double precision
          ) ORDER BY attachment.position
        )
        FROM swarm.signal_attachments AS attachment
        JOIN swarm.files AS file
          ON file.file_id = attachment.file_id
         AND file.workspace_id = attachment.workspace_id
        JOIN swarm.file_versions AS version
          ON version.file_id = attachment.file_id
         AND version.workspace_id = attachment.workspace_id
         AND version.version_n = attachment.version_n
        WHERE attachment.signal_id = s.id
          AND attachment.workspace_id = s.workspace_id
      ),
      '[]'::jsonb
    ) AS attachments,
    s.channel_id,
    s.thread_root_id,
    s.broadcast_to_channel,
    COALESCE(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'kind', CASE WHEN recipient.recipient_user_id IS NOT NULL THEN 'user' ELSE 'agent' END,
            'id', COALESCE(recipient.recipient_user_id, recipient.recipient_agent_principal_id),
            'position', recipient.position
          ) ORDER BY recipient.position
        )
        FROM swarm.signal_recipients AS recipient
        WHERE recipient.signal_id = s.id
          AND recipient.workspace_id = s.workspace_id
      ),
      CASE
        WHEN s.to_user_id IS NOT NULL THEN jsonb_build_array(jsonb_build_object('kind', 'user', 'id', s.to_user_id, 'position', 0))
        WHEN s.to_agent_principal_id IS NOT NULL THEN jsonb_build_array(jsonb_build_object('kind', 'agent', 'id', s.to_agent_principal_id, 'position', 0))
        ELSE '[]'::jsonb
      END
    ) AS recipients
  FROM swarm.signals AS s
  WHERE (
    swarm.is_member(s.workspace_id, auth.uid())
    AND (
      (s.to_user_id IS NULL AND s.to_agent_principal_id IS NULL)
      OR s.to_user_id = auth.uid()
      OR EXISTS (
        SELECT 1
        FROM swarm.agent_principals AS principal
        WHERE principal.principal_id = s.to_agent_principal_id
          AND principal.workspace_id = s.workspace_id
          AND principal.owner_user_id = auth.uid()
      )
    )
  )
  OR (
    swarm.is_member(s.workspace_id, auth.uid())
    AND EXISTS (
      SELECT 1
      FROM swarm.signal_recipients AS addressee
      WHERE addressee.signal_id = s.id
        AND addressee.workspace_id = s.workspace_id
        AND (
          addressee.recipient_user_id = auth.uid()
          OR EXISTS (
            SELECT 1
            FROM swarm.agent_principals AS owned
            WHERE owned.principal_id = addressee.recipient_agent_principal_id
              AND owned.workspace_id = addressee.workspace_id
              AND owned.owner_user_id = auth.uid()
          )
        )
    )
  );
ALTER VIEW swarm_read.signals OWNER TO swarm_admin;
GRANT SELECT ON swarm_read.signals TO authenticated, swarm_read;
REVOKE ALL ON swarm_read.signals FROM anon;

ALTER TABLE swarm.signals
  DROP CONSTRAINT signals_reply_status_valid,
  DROP COLUMN reply_status;
DELETE FROM supabase_migrations.schema_migrations
WHERE version = '20260927000001';

\ir 20260927000001-rollback-catalog.sql
\if :rollback_ok
  \if :{?release_proof_outer_transaction}
    RELEASE SAVEPOINT release_proof_outer_transaction_guard;
  \else
    COMMIT;
  \endif
\else
  ROLLBACK;
  DO $$ BEGIN RAISE EXCEPTION 'reply-status rollback catalog proof FAILED; transaction rolled back'; END $$;
\endif
