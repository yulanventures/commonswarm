-- Quiet agents (roster R1c): an agent whose push route went quiet while messages addressed to
-- it are waiting. Read-only; run inside BEGIN READ ONLY by the HezOps alert timer, which
-- dedupes per agent and delivers through the existing access-lost queue.
--
-- Thresholds match what the app shows (src/cloud/agent-presence.ts):
--   * a push route (watcher, channel, listener) is live while renewed within 3 minutes
--     (WAKE_LEASE_STALE_MS); after that the app shows it as stale;
--   * a delivery is waiting while unacknowledged; one queued over 3 minutes means someone
--     is waiting on an agent that is not picking up.
-- Only routes that were live in the last 24 hours count, so long-retired agents (which the
-- app shows as inactive) do not alert again. Hosted agents are turn-only and have no push
-- route, so they never appear. Output carries names and counts only, never message text.
SELECT
  p.principal_id,
  p.name AS agent,
  p.owner_user_id,
  w.workspace_id,
  w.name AS workspace,
  presence.route_at AS last_route_at,
  count(*)::integer AS waiting,
  min(d.enqueued_at) AS oldest_waiting_at
FROM (
  SELECT workspace_id, principal_id,
         GREATEST(watcher_at, channel_at, listener_at) AS route_at
  FROM swarm.agent_presence
) AS presence
JOIN swarm.agent_principals AS p
  ON p.principal_id = presence.principal_id AND p.workspace_id = presence.workspace_id
JOIN swarm.workspaces AS w ON w.workspace_id = presence.workspace_id
JOIN swarm.signal_deliveries AS d
  ON d.recipient_agent_principal_id = p.principal_id
 AND d.workspace_id = p.workspace_id
 AND d.acked_at IS NULL
 AND d.enqueued_at < statement_timestamp() - interval '3 minutes'
WHERE presence.route_at IS NOT NULL
  AND presence.route_at < statement_timestamp() - interval '3 minutes'
  AND presence.route_at > statement_timestamp() - interval '24 hours'
  AND p.revoked_at IS NULL
  AND p.transport <> 'hosted_mcp'
  AND w.archived_at IS NULL
GROUP BY p.principal_id, p.name, p.owner_user_id, w.workspace_id, w.name, presence.route_at
ORDER BY oldest_waiting_at, p.principal_id;
