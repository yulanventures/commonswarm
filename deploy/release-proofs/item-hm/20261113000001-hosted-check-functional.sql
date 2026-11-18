-- Functional proof of the hosted check batches as they stand since 20261113000001_signal_mentions.sql:
-- 20260928000004-functional.sql with one change. A batch row may be a message that mentions the seat's
-- agent, because swarm.hosted_mcp_check_visible_signals and the batch guard admit the mention arm since
-- 20261113000001. The 20260928000004 proof predates mentions and stays byte-for-byte as released and
-- hashed in its evidence; the HM37 harness checks the current state with this one.
WITH batch_ids AS (
  SELECT b.batch_id, b.workspace_id, b.principal_id, b.signal_ids,
         b.terminal_created_at, b.terminal_signal_id,
         u.signal_id, u.ordinality
  FROM swarm.hosted_mcp_check_batches AS b
  CROSS JOIN LATERAL unnest(b.signal_ids) WITH ORDINALITY AS u(signal_id, ordinality)
), batch_signal_facts AS (
  SELECT ids.*, s.workspace_id AS signal_workspace_id,
         date_trunc('milliseconds', s.created_at) AS signal_created_at,
         s.to_agent_principal_id,
         EXISTS (
           SELECT 1 FROM swarm.signal_recipients AS r
           WHERE r.workspace_id = s.workspace_id
             AND r.signal_id = s.id
             AND r.recipient_agent_principal_id = ids.principal_id
         ) AS named_recipient,
         EXISTS (
           SELECT 1 FROM swarm.signal_mentions AS m
           WHERE m.workspace_id = s.workspace_id
             AND m.signal_id = s.id
             AND m.mentioned_agent_principal_id = ids.principal_id
         ) AS named_mention
  FROM batch_ids AS ids
  LEFT JOIN swarm.signals AS s ON s.id = ids.signal_id
), visible_function_smoke AS (
  -- The empty id set is data-independent but still parses and executes the
  -- explicit return contract against the authorized visibility view.
  SELECT count(*) = 0 AS ok
  FROM swarm.hosted_mcp_check_visible_signals(
    '00000000-0000-0000-0000-000000000000'::uuid,
    '00000000-0000-0000-0000-000000000000'::uuid,
    ARRAY[]::uuid[]
  )
)
SELECT
  COALESCE((SELECT ok FROM visible_function_smoke), false)
  AND NOT EXISTS (
    SELECT 1 FROM swarm.hosted_mcp_check_batches
    WHERE acknowledged_at IS NULL
    GROUP BY seat_id HAVING count(*) > 1
  )
  AND NOT EXISTS (
    SELECT 1 FROM swarm.hosted_mcp_check_cursors AS c
    LEFT JOIN swarm.hosted_mcp_seats AS s
      ON (s.seat_id, s.grant_id, s.workspace_id, s.principal_id) =
         (c.seat_id, c.grant_id, c.workspace_id, c.principal_id)
    WHERE s.seat_id IS NULL
       OR (c.cursor_created_at IS NULL) <> (c.cursor_signal_id IS NULL)
       OR c.cursor_created_at IS DISTINCT FROM
          date_trunc('milliseconds', c.cursor_created_at)
  )
  AND NOT EXISTS (
    SELECT 1 FROM swarm.hosted_mcp_check_batches AS b
    LEFT JOIN swarm.hosted_mcp_check_cursors AS c
      ON (c.seat_id, c.grant_id, c.workspace_id, c.principal_id) =
         (b.seat_id, b.grant_id, b.workspace_id, b.principal_id)
    WHERE c.seat_id IS NULL
       OR cardinality(b.signal_ids) NOT BETWEEN 1 AND 50
       OR b.terminal_signal_id <> b.signal_ids[cardinality(b.signal_ids)]
       OR b.terminal_created_at IS DISTINCT FROM
          date_trunc('milliseconds', b.terminal_created_at)
  )
  AND NOT EXISTS (
    SELECT 1 FROM batch_signal_facts
    WHERE signal_workspace_id IS NULL
       OR signal_workspace_id <> workspace_id
       OR (to_agent_principal_id IS DISTINCT FROM principal_id AND NOT named_recipient AND NOT named_mention)
  )
  AND NOT EXISTS (
    SELECT 1 FROM batch_signal_facts
    WHERE ordinality = cardinality(signal_ids)
      AND (signal_id <> terminal_signal_id
        OR signal_created_at <> terminal_created_at)
  )
  AND NOT EXISTS (
    SELECT 1
    FROM swarm.hosted_mcp_check_cursors AS c
    WHERE c.cursor_created_at IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM swarm.hosted_mcp_check_batches AS b
        WHERE b.seat_id = c.seat_id
          AND b.grant_id = c.grant_id
          AND b.workspace_id = c.workspace_id
          AND b.acknowledged_at IS NOT NULL
          AND (b.terminal_created_at, b.terminal_signal_id) =
              (c.cursor_created_at, c.cursor_signal_id)
      )
  )
  AS functional_ok
\gset
\if :functional_ok
\echo t
\else
DO $$ BEGIN RAISE EXCEPTION 'HM hosted check functional proof FAILED'; END $$;
\endif
