-- Read-only post-apply proof. Run with writes paused before the new edge begins.
-- Reconcile backfill values against independently selected latest history.
WITH expected AS (
 SELECT p.principal_id,p.workspace_id,
 CASE WHEN e.actor_agent_principal IS NOT NULL THEN 'agent' WHEN e.actor_user IS NOT NULL THEN 'person' ELSE 'unknown' END AS kind,
 CASE WHEN e.actor_agent_principal IS NULL THEN e.actor_user ELSE NULL END AS setter,
 coalesce(e.occurred_at_server,p.created_at) AS stamp
 FROM swarm.agent_principals p LEFT JOIN LATERAL (
  SELECT ev.actor_user,ev.actor_agent_principal,ev.occurred_at_server
  FROM swarm.events ev JOIN swarm.streams st ON st.stream_id=ev.stream_id AND st.kind='workspace'
  WHERE ev.workspace_id=p.workspace_id AND ev.type='AgentModelDeclared' AND ev.payload->>'principal_id'=p.principal_id::text
  ORDER BY ev.seq DESC,ev.occurred_at_server DESC,ev.event_id DESC LIMIT 1
 ) e ON true WHERE p.model IS NOT NULL
)
SELECT NOT EXISTS (
 SELECT 1 FROM expected e FULL JOIN swarm.agent_model_provenance p USING(principal_id)
 WHERE e.principal_id IS NULL OR p.principal_id IS NULL OR e.workspace_id IS DISTINCT FROM p.workspace_id
  OR e.kind IS DISTINCT FROM p.model_set_by OR e.setter IS DISTINCT FROM p.set_by_user_id OR e.stamp IS DISTINCT FROM p.set_at
) AND NOT EXISTS(SELECT 1 FROM swarm.agent_avatars)
 AND NOT EXISTS(SELECT 1 FROM swarm.agent_avatar_jobs) AS functional_ok
\gset
