-- Read-only counts for 20261118000005 (conversations, step 2a), run after applying it.
--
-- Release order: (1) HezOps takes and verifies a full database backup; (2) apply the migration, which ends by
-- running swarm.conversations_backfill() for the last time (messages, read marks and new people since step 1)
-- and ending the memberships of anyone no longer live in their workspace; (3) run
-- 20261118000005-catalog.sql (catalog_ok) and these counts; (4) release the edge (command function) through
-- deploy/edge-runtime/EDGE-RELEASE.md. The web app needs no release: it already listens on each person's own
-- topic. The old edge keeps working between (2) and (4): it never calls the new functions, and its posts are
-- filed and announced by the triggers. Rollback is the reverse: edge first, then 20261118000005-rollback.sql.
-- Do not run swarm.conversations_backfill() again after this: its public-channel rule would enrol people who
-- join later in every public channel, where step 2a has them join #general only.
SELECT
  (SELECT count(*) FROM swarm.signals s
    WHERE NOT EXISTS (SELECT 1 FROM swarm.conversation_signals cs WHERE cs.signal_id = s.id)) AS unmapped,
  (SELECT count(*) FROM swarm.conversation_members WHERE left_at IS NULL) AS live_members,
  (SELECT count(*) FROM swarm.conversation_members WHERE left_at IS NOT NULL) AS ended_members,
  (SELECT count(*) FROM swarm.conversation_members m
    WHERE m.left_at IS NULL AND m.member_user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM swarm.memberships w
      WHERE w.workspace_id = m.workspace_id AND w.user_id = m.member_user_id AND w.revoked_at IS NULL))
    AS live_rows_of_people_not_in_the_workspace,
  (SELECT count(*) FROM swarm.memberships w JOIN swarm.conversations c ON c.workspace_id = w.workspace_id AND c.kind = 'general'
    WHERE w.revoked_at IS NULL AND NOT EXISTS (SELECT 1 FROM swarm.conversation_members m
      WHERE m.conversation_id = c.conversation_id AND m.member_user_id = w.user_id AND m.left_at IS NULL))
    AS live_people_not_in_general,
  (SELECT count(*) FROM swarm.human_channel_reads h JOIN swarm.conversations c ON c.workspace_id = h.workspace_id
      AND (CASE WHEN h.channel_id IS NULL THEN c.kind = 'general' ELSE c.conversation_id = h.channel_id END)
    JOIN swarm.memberships w ON w.workspace_id = h.workspace_id AND w.user_id = h.user_id
    WHERE NOT EXISTS (SELECT 1 FROM swarm.conversation_reads r WHERE r.conversation_id = c.conversation_id
      AND r.member_user_id = h.user_id AND r.read_through_at >= h.read_through_at)) AS person_marks_behind,
  (SELECT count(*) FROM swarm.agent_channel_reads a JOIN swarm.conversations c ON c.workspace_id = a.workspace_id
      AND (CASE WHEN a.channel_id IS NULL THEN c.kind = 'general' ELSE c.conversation_id = a.channel_id END)
    WHERE a.read_through_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM swarm.conversation_reads r
      WHERE r.conversation_id = c.conversation_id AND r.member_agent_principal_id = a.principal_id
        AND r.read_through_at >= a.read_through_at)) AS agent_marks_behind;
-- Expected: live_rows_of_people_not_in_the_workspace = 0, live_people_not_in_general = 0, person_marks_behind = 0,
-- agent_marks_behind = 0; unmapped equals step 1's count plus nothing new.
