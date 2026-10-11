-- One row; branches partition the non-null-model principals present at apply.
-- Run immediately before the migration; retain with the matching post-apply query.
WITH latest AS (
 SELECT p.principal_id,p.workspace_id,e.actor_user,e.actor_agent_principal
 FROM swarm.agent_principals p LEFT JOIN LATERAL (
  SELECT ev.actor_user,ev.actor_agent_principal FROM swarm.events ev
  JOIN swarm.streams s ON s.stream_id=ev.stream_id AND s.kind='workspace'
  WHERE ev.workspace_id=p.workspace_id AND ev.type='AgentModelDeclared'
   AND ev.payload->>'principal_id'=p.principal_id::text
  ORDER BY ev.seq DESC,ev.occurred_at_server DESC,ev.event_id DESC LIMIT 1
 ) e ON true WHERE p.model IS NOT NULL
)
SELECT count(*) AS model_rows,
 count(*) FILTER(WHERE actor_agent_principal IS NOT NULL) AS agent_rows,
 count(*) FILTER(WHERE actor_agent_principal IS NULL AND actor_user IS NOT NULL) AS person_rows,
 count(*) FILTER(WHERE actor_agent_principal IS NULL AND actor_user IS NULL) AS unknown_rows
FROM latest;
