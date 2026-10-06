/** Content-gated household activity. Read committed revisions from the reducer
 * projection: the raw object event ledger also contains private merge drafts. */
import type postgres from 'postgres';
import * as core from '../_shared/protocol.js';
import type { HouseholdIdentity } from './household-objects.ts';
import type { HouseholdTodoAccess } from './household-todos.ts';

type Sql = postgres.TransactionSql<Record<string, unknown>>;
export async function readHouseholdActivity(tx: Sql, workspaceId: string, identity: HouseholdIdentity,
  query: { since: string; limit: number }, access: HouseholdTodoAccess): Promise<Record<string, unknown>> {
  const checked = await access(tx, workspaceId, identity);
  const denied = checked ? core.householdAccessRefusal(checked.facts, workspaceId, 'read', checked.now) : 'workspace_access_refused';
  if (denied) return { status: 'refused', reason: denied };
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(query.since)
    || !Number.isFinite(Date.parse(query.since)) || !Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100)
    return { status: 'refused', reason: 'invalid_arguments' };
  const rows = await tx`
    WITH activity AS (
      SELECT e.occurred_at AS at, 'todo:' || e.event_id::text || ':' || target_id.id AS key,
        jsonb_build_object('user_id',e.event->>'actor_user','principal_id',e.event->'actor_agent_principal') AS actor,
        CASE e.event->>'type'
          WHEN 'TodoCreated' THEN 'created' WHEN 'TodoDetailsChanged' THEN 'updated'
          WHEN 'TodoAssigned' THEN 'assigned' WHEN 'TodoOffered' THEN 'requested'
          WHEN 'TodoOfferAnswered' THEN CASE e.event->'payload'->>'answer' WHEN 'accept' THEN 'accepted' WHEN 'decline' THEN 'declined' ELSE 'updated' END
          WHEN 'TodoStateChanged' THEN CASE e.event->'payload'->'todo'->>'state' WHEN 'doing' THEN 'started' WHEN 'done' THEN 'done' WHEN 'dropped' THEN 'dropped' ELSE 'reopened' END
          WHEN 'TodoCommented' THEN 'commented' ELSE 'updated' END AS event,
        coalesce(e.event->'payload'->'todo'->>'title', t.title, o.value->'history'->-1->>'title') AS title,
        CASE WHEN e.event->>'type'='TodoCommented' THEN jsonb_build_object('kind',e.event->'payload'->'comment'->'target'->>'kind','id',e.event->'payload'->'comment'->'target'->>'id')
          ELSE jsonb_build_object('kind','todo','id',target_id.id) END AS object
      FROM swarm.household_todo_events e
      CROSS JOIN LATERAL (
        SELECT e.event->'payload'->'todo'->>'todo_id' AS id WHERE e.event->'payload'->'todo'->>'todo_id' IS NOT NULL
        UNION ALL SELECT e.event->'payload'->>'todo_id' WHERE e.event->>'type'='TodoStartAsked'
        UNION ALL SELECT jsonb_array_elements_text(e.event->'payload'->'todo_ids') WHERE e.event->>'type'='TodoQueueOrdered'
        UNION ALL SELECT e.event->'payload'->'comment'->'target'->>'id'
          WHERE e.event->>'type'='TodoCommented' AND e.event->'payload'->'todo'->>'todo_id' IS NULL
      ) target_id
      LEFT JOIN swarm.household_todos t ON t.workspace_id=e.workspace_id AND t.todo_id::text=target_id.id
        AND (e.event->>'type'<>'TodoCommented' OR e.event->'payload'->'comment'->'target'->>'kind'='todo')
      LEFT JOIN swarm.household_object_streams os ON os.workspace_id=e.workspace_id
      LEFT JOIN LATERAL jsonb_each(coalesce(os.projection->'objects','{}'::jsonb)) o
        ON o.key=target_id.id
          AND o.value->>'kind'=e.event->'payload'->'comment'->'target'->>'kind'
      WHERE e.workspace_id=${workspaceId}::uuid AND e.occurred_at>${query.since}::timestamptz
        AND target_id.id IS NOT NULL
      UNION ALL
      SELECT to_timestamp((r.value->>'occurred_at_server')::double precision/1000),
        'object:' || o.key || ':' || (r.value->'revision'->>'token'),
        jsonb_build_object('user_id',r.value->'author'->>'user_id','principal_id',r.value->'author'->'principal_id'),
        CASE WHEN r.value->'parent'='null'::jsonb THEN 'created' ELSE 'updated' END,
        r.value->>'title', jsonb_build_object('kind',r.value->>'kind','id',o.key)
      FROM swarm.household_object_streams os
      CROSS JOIN LATERAL jsonb_each(coalesce(os.projection->'objects','{}'::jsonb)) o
      CROSS JOIN LATERAL jsonb_array_elements(coalesce(o.value->'history','[]'::jsonb)) r
      WHERE os.workspace_id=${workspaceId}::uuid
        AND (r.value->>'occurred_at_server')::double precision>extract(epoch FROM ${query.since}::timestamptz)*1000
    ) SELECT * FROM activity ORDER BY at DESC,key DESC LIMIT ${query.limit}
  `;
  const rechecked = await access(tx, workspaceId, identity);
  const changed = rechecked ? core.householdAccessRefusal(rechecked.facts, workspaceId, 'read', rechecked.now) : 'workspace_access_refused';
  if (changed) return { status: 'refused', reason: changed };
  return { status: 'ok', activity: rows.map(row => ({ ...row, at: new Date(row.at as string).toISOString() })) };
}
