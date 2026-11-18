-- Read-only counts for 20261118000004, run after applying: what the backfill filed, and the history it
-- left unmapped (a member that does not resolve, more than nine, or a reply under an unmapped root).
-- The legacy read rule keeps serving unmapped messages exactly as today; step 6 cannot remove the legacy
-- arms while any remain.
SELECT
  (SELECT count(*) FROM swarm.signals) AS messages,
  (SELECT count(*) FROM swarm.conversation_signals) AS filed,
  (SELECT count(*) FROM swarm.signals s
    WHERE NOT EXISTS (SELECT 1 FROM swarm.conversation_signals cs WHERE cs.signal_id = s.id)) AS unmapped,
  (SELECT count(*) FROM swarm.signals s WHERE s.thread_root_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM swarm.conversation_signals cs WHERE cs.signal_id = s.id)) AS unmapped_replies,
  (SELECT jsonb_object_agg(kind, n) FROM (SELECT c.kind, count(*) AS n FROM swarm.conversation_signals cs
    JOIN swarm.conversations c ON c.conversation_id = cs.conversation_id GROUP BY c.kind) k) AS filed_by_kind,
  (SELECT jsonb_object_agg(audience, n) FROM (SELECT audience, count(*) AS n FROM swarm.conversation_signals
    GROUP BY audience) a) AS filed_by_audience,
  (SELECT jsonb_object_agg(kind, n) FROM (SELECT kind, count(*) AS n FROM swarm.conversations GROUP BY kind) c)
    AS conversations_by_kind,
  (SELECT count(*) FROM swarm.workspaces w WHERE NOT EXISTS (SELECT 1 FROM swarm.conversations c
    WHERE c.workspace_id = w.workspace_id AND c.kind = 'general')) AS workspaces_without_general,
  (SELECT count(*) FROM swarm.conversation_members) AS members,
  (SELECT count(*) FROM swarm.conversation_reads) AS reads;
