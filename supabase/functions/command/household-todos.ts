/** Transaction-scoped to-do adapter. Callers MUST use db.begin: events,
 * projections, receipts, audit and the optional notice commit together.
 * Access is the existing household store's credential recheck, never model input.
 * Lock order: workspace/access rows, stream, projection rows.
 */
import type postgres from 'postgres';
import type { HouseholdIdentity } from './household-objects.ts';
import type { HouseholdAccessFacts } from '../_shared/household-object-policy.d.ts';
import type { HouseholdTodoState, Todo, TodoCommand, TodoComment, TodoGate, Party, TodoNotice, TodoOutcome } from '../_shared/household-todos.d.ts';
import type { AgentWorkFacts } from '../_shared/household-todo-policy.d.ts';

type Sql = postgres.TransactionSql<Record<string, unknown>>;
type Core = Pick<typeof import('../_shared/household-todos.d.ts'), 'decideTodo' | 'reduceTodoEvents' | 'emptyHouseholdTodoState' | 'evaluateGate'>
  & Pick<typeof import('../_shared/household-object-policy.d.ts'), 'householdAccessRefusal'>
  & Pick<typeof import('../_shared/household-todo-policy.d.ts'), 'agentWorkState' | 'TODO_IDENTITY_WRITE_HOURLY_LIMIT' | 'TODO_WORKSPACE_WRITE_HOURLY_LIMIT'>;
export type HouseholdTodoAccess = (tx: Sql, workspaceId: string, identity: HouseholdIdentity) => Promise<{ facts: HouseholdAccessFacts; now: number } | null>;
export type HouseholdTodoNoticeReceipt = { to: readonly Party[]; status: 'sent'; signal_id: string }
  | { to: readonly Party[]; status: 'not_sent'; reason: 'signal_rate_limited' | 'recipient_not_live' };
export type HouseholdTodoNoticePort = (tx: Sql, workspaceId: string, identity: HouseholdIdentity, notice: TodoNotice) => Promise<HouseholdTodoNoticeReceipt>;
export type HouseholdTodoQuery =
  | { kind: 'todo_list'; scope: 'open' | 'all'; assignee?: Party; offset?: number; limit?: number }
  | { kind: 'todo_read'; todo_id: string; comment_offset?: number }
  | { kind: 'comment_list'; target: TodoComment['target']; offset?: number; limit?: number }
  | { kind: 'todo_queue'; principal_id?: string; section?: 'working' | 'up_next' | 'not_yet' | 'requests'; offset?: number; limit?: number };
export class HouseholdTodoAccessChanged extends Error {
  constructor() { super('Household access changed during the command.'); this.name = 'HouseholdTodoAccessChanged'; }
}
const json = (tx: Sql, value: unknown) => tx.json(value as postgres.JSONValue);
const iso = (value: unknown): string => new Date(value as string).toISOString();
const nullableIso = (value: unknown): string | null => value == null ? null : iso(value);
const stamp = (value: unknown): number | null => value == null ? null : Date.parse(iso(value));
const actor = (user: unknown, principal: unknown) => ({ user_id: String(user), principal_id: principal == null ? null : String(principal) });
const party = (user: unknown, principal: unknown): Party | null => principal != null ? { kind: 'agent', id: String(principal) } : user != null ? { kind: 'user', id: String(user) } : null;
const pageBytes = (page: unknown) => new TextEncoder().encode(JSON.stringify(JSON.stringify(page))).length;
const PAGE_BUDGET = 28 * 1024;
const bounded = (value: number | undefined, fallback: number, cap: number) => value === undefined ? fallback : Number.isSafeInteger(value) && value >= 0 ? Math.min(value, cap) : 0;
const gateFromRow = (row: Record<string, unknown>): TodoGate => row.gate_kind === 'hold' ? { kind: 'hold', note: row.gate_note as string | null }
  : row.gate_kind === 'after' ? { kind: 'after', todo_id: String(row.gate_todo_id) }
    : row.gate_kind === 'at' ? { kind: 'at', at: iso(row.gate_at) } : { kind: 'none' };
function todoFromRow(r: Record<string, unknown>): Todo {
  return { workspace_id: String(r.workspace_id), todo_id: String(r.todo_id), version: Number(r.version), title: String(r.title), notes: String(r.notes),
    state: r.state as Todo['state'], due_on: r.due_on == null ? null : r.due_on instanceof Date ? iso(r.due_on).slice(0, 10) : String(r.due_on).slice(0, 10),
    created_by: actor(r.created_by_user, r.created_by_principal), created_at: iso(r.created_at), assignee: party(r.assignee_user, r.assignee_principal),
    assigned_by: r.assigned_by_user == null ? null : actor(r.assigned_by_user, r.assigned_by_principal), assigned_at: nullableIso(r.assigned_at),
    offer: r.offer_id == null ? null : { offer_id: String(r.offer_id), to: party(r.offer_user, r.offer_principal)!, decider_user_id: String(r.offer_decider),
      start: r.offer_start as 'queue' | 'now', gate: r.offer_gate as TodoGate, by: actor(r.offer_by_user, r.offer_by_principal), at: iso(r.offered_at) },
    gate: gateFromRow(r), gate_set_by: r.gate_set_by as string | null, queue_rank: r.queue_rank == null ? null : Number(r.queue_rank),
    state_by: actor(r.state_by_user, r.state_by_principal), state_at: iso(r.state_at), comment_count: Number(r.comment_count) };
}
const commentFromRow = (r: Record<string, unknown>): TodoComment => ({ comment_id: String(r.comment_id),
  target: { kind: r.target_kind, id: String(r.target_id) } as TodoComment['target'], author: actor(r.author_user, r.author_principal),
  body: String(r.body), mentions: r.mentions as Party[], created_at: iso(r.created_at) });
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
async function digestOf(command: TodoCommand): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(command)))), b => b.toString(16).padStart(2, '0')).join('');
}

export function createHouseholdTodoStore({ core, access, notice }: { core: Core; access: HouseholdTodoAccess; notice: HouseholdTodoNoticePort }) {
  async function authorize(tx: Sql, workspaceId: string, identity: HouseholdIdentity, op: 'read' | 'create' | 'update') {
    const checked = await access(tx, workspaceId, identity);
    const denied = checked ? core.householdAccessRefusal(checked.facts, workspaceId, op, checked.now) : 'workspace_access_refused';
    return { checked, denied };
  }
  async function state(tx: Sql, workspaceId: string, create: boolean): Promise<HouseholdTodoState> {
    if (create) await tx`INSERT INTO swarm.household_todo_streams(workspace_id,stream_id,last_seq) VALUES (${workspaceId}::uuid,${crypto.randomUUID()}::uuid,-1) ON CONFLICT(workspace_id) DO NOTHING`;
    const [stream] = await tx`SELECT stream_id,last_seq FROM swarm.household_todo_streams WHERE workspace_id=${workspaceId}::uuid FOR UPDATE`;
    const current = core.emptyHouseholdTodoState(workspaceId, stream ? String(stream.stream_id) : crypto.randomUUID());
    current.last_seq = stream ? Number(stream.last_seq) : -1;
    const rows = await tx`SELECT * FROM swarm.household_todos WHERE workspace_id=${workspaceId}::uuid ORDER BY todo_id FOR UPDATE`;
    current.todos = Object.fromEntries(rows.map(r => { const todo = todoFromRow(r); return [todo.todo_id, todo]; }));
    const policies = await tx`SELECT principal_id,accepts_from,set_by_user,set_at FROM swarm.household_agent_work_policies WHERE workspace_id=${workspaceId}::uuid`;
    current.policies = Object.fromEntries(policies.map(r => [String(r.principal_id), { principal_id: String(r.principal_id), accepts_from: r.accepts_from as 'owner' | 'anyone', set_by_user: String(r.set_by_user), set_at: iso(r.set_at) }]));
    return current;
  }
  async function audit(tx: Sql, workspaceId: string, identity: HouseholdIdentity, request: string, command: TodoCommand, digest: string, outcome: TodoOutcome, replayed = false) {
    await tx`INSERT INTO swarm.household_object_audit(audit_id,workspace_id,command_id,actor_user,actor_principal,occurred_at,command_kind,request_digest,outcome,reason_code)
      SELECT ${crypto.randomUUID()}::uuid,${workspaceId}::uuid,${request},${identity.user_id}::uuid,${identity.principal_id}::uuid,clock_timestamp(),${command.kind},${digest},${replayed ? 'replay' : outcome.status},${outcome.status === 'refused' ? outcome.reason : null}
      FROM swarm.workspaces WHERE workspace_id=${workspaceId}::uuid`;
  }
  async function rate(tx: Sql, key: string, limit: number) {
    const [row] = await tx`INSERT INTO swarm.rate_buckets(bucket_key,window_start,count) VALUES (${key},date_trunc('hour',statement_timestamp()),1)
      ON CONFLICT(bucket_key,window_start) DO UPDATE SET count=LEAST(swarm.rate_buckets.count+1,${limit + 1}) RETURNING count`;
    return Number(row!.count) - 1;
  }
  async function saveTodo(tx: Sql, todo: Todo, lastSeq: number) {
    const gate = todo.gate, offer = todo.offer;
    const record = { workspace_id: todo.workspace_id, todo_id: todo.todo_id, version: todo.version, title: todo.title, notes: todo.notes, state: todo.state, due_on: todo.due_on,
      created_by_user: todo.created_by.user_id, created_by_principal: todo.created_by.principal_id, created_at: todo.created_at,
      assignee_user: todo.assignee?.kind === 'user' ? todo.assignee.id : null, assignee_principal: todo.assignee?.kind === 'agent' ? todo.assignee.id : null,
      assigned_by_user: todo.assigned_by?.user_id ?? null, assigned_by_principal: todo.assigned_by?.principal_id ?? null, assigned_at: todo.assigned_at,
      offer_id: offer?.offer_id ?? null, offer_user: offer?.to.kind === 'user' ? offer.to.id : null, offer_principal: offer?.to.kind === 'agent' ? offer.to.id : null,
      offer_decider: offer?.decider_user_id ?? null, offer_start: offer?.start ?? null, offer_gate: offer ? json(tx, offer.gate) : null,
      offer_by_user: offer?.by.user_id ?? null, offer_by_principal: offer?.by.principal_id ?? null, offered_at: offer?.at ?? null,
      gate_kind: gate.kind, gate_note: gate.kind === 'hold' ? gate.note : null, gate_todo_id: gate.kind === 'after' ? gate.todo_id : null,
      gate_at: gate.kind === 'at' ? gate.at : null, gate_set_by: todo.gate_set_by, queue_rank: todo.queue_rank,
      state_by_user: todo.state_by.user_id, state_by_principal: todo.state_by.principal_id, state_at: todo.state_at, comment_count: todo.comment_count, last_seq: lastSeq };
    await tx`INSERT INTO swarm.household_todos ${tx(record)} ON CONFLICT(workspace_id,todo_id) DO UPDATE SET ${tx(record, ...Object.keys(record).filter(k => k !== 'workspace_id' && k !== 'todo_id') as (keyof typeof record)[])}`;
  }
  async function write(tx: Sql, workspaceId: string, identity: HouseholdIdentity, requestId: string, command: TodoCommand) {
    const op = command.kind === 'todo_create' || command.kind === 'todo_comment' ? 'create' : 'update';
    const digest = await digestOf(command);
    const { checked, denied } = await authorize(tx, workspaceId, identity, op);
    if (denied) {
      const outcome = { status: 'refused' as const, reason: denied };
      await audit(tx, workspaceId, identity, requestId, command, digest, outcome);
      return { outcome, events: [], notices: [], replayed: false };
    }
    const current = await state(tx, workspaceId, true);
    const principal = identity.principal_id ?? identity.user_id;
    const [previous] = await tx`SELECT request_digest,outcome FROM swarm.household_todo_receipts WHERE workspace_id=${workspaceId}::uuid AND principal=${principal}::uuid AND command_id=${requestId}`;
    if (previous) {
      const replayed = previous.request_digest === digest;
      const stored = previous.outcome as { outcome: TodoOutcome; notices: HouseholdTodoNoticeReceipt[] };
      const outcome = replayed ? stored.outcome : { status: 'refused' as const, reason: 'request_id_reused' as const };
      await audit(tx, workspaceId, identity, requestId, command, digest, outcome, replayed);
      return { outcome, events: [], notices: replayed ? stored.notices : [], replayed };
    }
    const members = await tx`SELECT user_id,workspace_id,revoked_at,role FROM swarm.memberships WHERE workspace_id=${workspaceId}::uuid FOR SHARE`;
    const agents = await tx`SELECT principal_id,workspace_id,owner_user_id,revoked_at FROM swarm.agent_principals WHERE workspace_id=${workspaceId}::uuid FOR SHARE`;
    const [objects] = await tx`SELECT projection FROM swarm.household_object_streams WHERE workspace_id=${workspaceId}::uuid`;
    const projection = objects?.projection as { objects?: Record<string, { object_id: string; kind: 'list' | 'doc' | 'file' }> } | undefined;
    const identityAttempts = await rate(tx, `todo:${identity.principal_id ? 'agent' : 'user'}:${principal.toLowerCase()}`, core.TODO_IDENTITY_WRITE_HOURLY_LIMIT);
    const workspaceAttempts = await rate(tx, `todo:ws:${workspaceId.toLowerCase()}`, core.TODO_WORKSPACE_WRITE_HOURLY_LIMIT);
    const decision = core.decideTodo(current, command, { access: checked!.facts, now: checked!.now, command_id: requestId, request_digest: digest,
      seq: current.last_seq + 1, event_ids: Array.from({ length: 16 }, () => crypto.randomUUID()), todo_id: crypto.randomUUID(), offer_id: crypto.randomUUID(), comment_id: crypto.randomUUID(),
      members: members.map(r => ({ user_id: String(r.user_id), workspace_id: String(r.workspace_id), revoked_at: stamp(r.revoked_at), role: r.role as 'owner' | 'admin' | 'member' })),
      agents: agents.map(r => ({ principal_id: String(r.principal_id), workspace_id: String(r.workspace_id), owner_user_id: String(r.owner_user_id), revoked_at: stamp(r.revoked_at) })),
      objects: Object.values(projection?.objects ?? {}).map(o => ({ kind: o.kind, id: o.object_id })), identity_write_attempts: identityAttempts, workspace_write_attempts: workspaceAttempts });
    if (decision.notices.length > 1) throw new RangeError('A to-do command may post at most one notice.');
    const next = core.reduceTodoEvents(current, decision.events);
    for (const event of decision.events) await tx`INSERT INTO swarm.household_todo_events(workspace_id,seq,event_id,occurred_at,event)
      VALUES (${workspaceId}::uuid,${event.seq},${event.event_id}::uuid,${new Date(event.occurred_at_server)},${json(tx, event)})`;
    for (const todo of Object.values(next.todos)) if (JSON.stringify(todo) !== JSON.stringify(current.todos[todo.todo_id])) await saveTodo(tx, todo, next.last_seq);
    const notices: HouseholdTodoNoticeReceipt[] = [];
    for (const intent of decision.notices) notices.push(await notice(tx, workspaceId, identity, intent));
    for (const comment of Object.values(next.comments)) await tx`INSERT INTO swarm.household_comments(workspace_id,comment_id,target_kind,target_id,author_user,author_principal,body,mentions,notice_signal_id,seq,created_at)
      VALUES (${workspaceId}::uuid,${comment.comment_id}::uuid,${comment.target.kind},${comment.target.id},${comment.author.user_id}::uuid,${comment.author.principal_id}::uuid,
      ${comment.body},${json(tx, comment.mentions)},${notices[0]?.status === 'sent' ? notices[0].signal_id : null}::uuid,${next.last_seq},${comment.created_at})`;
    for (const policy of Object.values(next.policies)) if (JSON.stringify(policy) !== JSON.stringify(current.policies[policy.principal_id])) await tx`INSERT INTO swarm.household_agent_work_policies(workspace_id,principal_id,accepts_from,set_by_user,set_at)
      VALUES (${workspaceId}::uuid,${policy.principal_id}::uuid,${policy.accepts_from},${policy.set_by_user}::uuid,${policy.set_at})
      ON CONFLICT(workspace_id,principal_id) DO UPDATE SET accepts_from=EXCLUDED.accepts_from,set_by_user=EXCLUDED.set_by_user,set_at=EXCLUDED.set_at`;
    if (decision.events.length) await tx`UPDATE swarm.household_todo_streams SET last_seq=${next.last_seq} WHERE workspace_id=${workspaceId}::uuid`;
    if ((await authorize(tx, workspaceId, identity, op)).denied) throw new HouseholdTodoAccessChanged();
    if (decision.receipt) await tx`INSERT INTO swarm.household_todo_receipts(workspace_id,principal,command_id,request_digest,outcome,created_at)
      VALUES (${workspaceId}::uuid,${principal}::uuid,${requestId},${digest},${json(tx, { outcome: decision.outcome, notices })},clock_timestamp())`;
    await audit(tx, workspaceId, identity, requestId, command, digest, decision.outcome);
    return { ...decision, notices };
  }
  function view(todo: Todo, current: HouseholdTodoState, now: number) {
    const upNext = Object.values(current.todos).filter(t => t.state === 'open' && t.assignee?.kind === 'agent' && t.assignee.id === todo.assignee?.id && t.queue_rank !== null && core.evaluateGate(t.gate, current.todos, now))
      .sort((a, b) => a.queue_rank! - b.queue_rank! || a.todo_id.localeCompare(b.todo_id));
    const { queue_rank: _rank, gate_set_by: _setter, ...fields } = todo;
    return { ...fields, gate_clear: core.evaluateGate(todo.gate, current.todos, now), queue_position: upNext.findIndex(t => t.todo_id === todo.todo_id) + 1 || null };
  }
  function summary(todo: Todo, current: HouseholdTodoState, now: number) {
    const v = view(todo, current, now);
    return { todo_id: v.todo_id, version: v.version, title: v.title, state: v.state, due_on: v.due_on, assignee: v.assignee,
      offer: v.offer ? { offer_id: v.offer.offer_id, to: v.offer.to, decider_user_id: v.offer.decider_user_id, start: v.offer.start, gate: { kind: v.offer.gate.kind }, by: v.offer.by, at: v.offer.at } : null,
      gate: { kind: v.gate.kind, clear: v.gate_clear }, queue_position: v.queue_position, comment_count: v.comment_count, state_at: v.state_at };
  }
  function page<T>(rows: T[], offset: number, limit: number, items: T[], make: (next: number | null) => unknown, minimumRows = 1) {
    let cursor = offset;
    while (cursor < rows.length && items.length < limit) {
      items.push(rows[cursor]!);
      if (pageBytes({ status: 'ok', ...make(cursor + 1 < rows.length ? cursor + 1 : null) as Record<string, unknown> }) > PAGE_BUDGET) {
        // AM16 bounds valid singleton rows. Retain the first row even if an
        // unexpected stored value exceeds that bound, so paging still advances.
        if (items.length > minimumRows) items.pop();
        else cursor++;
        break;
      }
      cursor++;
    }
    return cursor < rows.length ? cursor : null;
  }
  async function comments(tx: Sql, workspaceId: string, target: TodoComment['target'], offset: number, limit: number) {
    const rows = await tx`SELECT * FROM swarm.household_comments WHERE workspace_id=${workspaceId}::uuid AND target_kind=${target.kind} AND target_id=${target.id}
      ORDER BY seq,comment_id OFFSET ${offset} LIMIT ${limit + 1}`;
    return rows.map(commentFromRow);
  }
  async function queueFacts(tx: Sql, workspaceId: string, principalId: string, current: HouseholdTodoState, now: number) {
    const [agent] = await tx`SELECT p.*,
      EXISTS (SELECT 1 FROM swarm.memberships m WHERE m.workspace_id=p.workspace_id AND m.user_id=p.owner_user_id AND m.revoked_at IS NULL) AS member_live,
      EXISTS (SELECT 1 FROM swarm.hosted_mcp_seats s JOIN swarm.hosted_mcp_grants g USING(grant_id)
        JOIN swarm.hosted_mcp_grant_workspaces b ON b.grant_id=g.grant_id AND b.workspace_id=s.workspace_id
        WHERE s.workspace_id=p.workspace_id AND s.principal_id=p.principal_id AND s.revoked_at IS NULL AND g.state='active' AND g.revoked_at IS NULL AND b.revoked_at IS NULL) AS hosted_live,
      EXISTS (SELECT 1 FROM swarm.agent_tokens t JOIN swarm.agent_runs r USING(run_id) JOIN swarm.devices d USING(device_id)
        WHERE t.principal_id=p.principal_id AND t.revoked_at IS NULL AND t.expires_at>${new Date(now)} AND NOT t.surrender_only AND r.ended_at IS NULL AND d.revoked_at IS NULL) AS token_live,
      EXISTS (SELECT 1 FROM swarm.renewal_grants g JOIN swarm.agent_runs r USING(run_id) JOIN swarm.devices d USING(device_id)
        WHERE g.principal_id=p.principal_id AND g.revoked_at IS NULL AND (g.horizon_expires_at IS NULL OR g.horizon_expires_at>${new Date(now)}) AND NOT g.suspension_active AND r.ended_at IS NULL AND d.revoked_at IS NULL) AS renewal_live,
      coalesce((SELECT g.revoked_at IS NOT NULL FROM swarm.renewal_grants g WHERE g.principal_id=p.principal_id ORDER BY g.created_at DESC,g.renewal_grant_id LIMIT 1),
        (SELECT t.revoked_at IS NOT NULL FROM swarm.agent_tokens t WHERE t.principal_id=p.principal_id ORDER BY t.issued_at DESC,t.token_id LIMIT 1),false) AS key_off,
      EXISTS (SELECT 1 FROM swarm.renewal_grants g WHERE g.principal_id=p.principal_id AND g.revoked_at IS NULL AND g.suspension_active) AS paused
      FROM swarm.agent_principals p WHERE p.workspace_id=${workspaceId}::uuid AND p.principal_id=${principalId}::uuid`;
    if (!agent) return null;
    const [activity] = await tx`SELECT greatest(
      (SELECT max(last_command_at) FROM swarm.agent_presence WHERE workspace_id=${workspaceId}::uuid AND principal_id=${principalId}::uuid),
      (SELECT max(created_at) FROM swarm.signals WHERE workspace_id=${workspaceId}::uuid AND from_kind='agent' AND from_principal=${principalId}::uuid),
      (SELECT greatest(max(created_at),max(acknowledged_at)) FROM swarm.hosted_mcp_check_batches WHERE workspace_id=${workspaceId}::uuid AND principal_id=${principalId}::uuid),
      (SELECT max(occurred_at) FROM swarm.household_todo_events WHERE workspace_id=${workspaceId}::uuid AND event->>'actor_agent_principal'=${principalId}),
      (SELECT to_timestamp(max((revision->>'occurred_at_server')::double precision)/1000) FROM swarm.household_object_streams s CROSS JOIN LATERAL jsonb_each(s.projection->'objects') o CROSS JOIN LATERAL jsonb_array_elements(o.value->'history') revision WHERE s.workspace_id=${workspaceId}::uuid AND revision->'author'->>'principal_id'=${principalId})
      ) AS last_activity_at,
      (SELECT min(enqueued_at) FROM swarm.signal_deliveries WHERE workspace_id=${workspaceId}::uuid AND recipient_agent_principal_id=${principalId}::uuid AND acked_at IS NULL) AS messages_waiting_since`;
    const [claim] = await tx`SELECT id,created_at,until FROM swarm.signals WHERE workspace_id=${workspaceId}::uuid AND from_principal=${principalId}::uuid AND from_kind='agent' AND kind='working-on' AND until>${new Date(now)} ORDER BY created_at DESC,id LIMIT 1`;
    const [approval] = await tx`SELECT bool_or('read'=ANY(c.operations)) AS can_read, bool_or(r.content_role='editor' AND 'read'=ANY(c.operations) AND ('create'=ANY(c.operations) OR 'update'=ANY(c.operations))) AS can_write
      FROM swarm.household_content_connections c JOIN swarm.household_member_content_roles r ON r.workspace_id=c.workspace_id AND r.user_id=c.owner_user_id
      WHERE c.workspace_id=${workspaceId}::uuid AND c.principal_id=${principalId}::uuid AND c.revoked_at IS NULL AND (c.expires_at IS NULL OR c.expires_at>${new Date(now)})
      AND r.revoked_at IS NULL AND r.content_consent_id IS NOT NULL AND r.content_role IN ('reader','editor')
      AND (c.hosted_grant_id IS NULL OR EXISTS (SELECT 1 FROM swarm.hosted_mcp_grants g JOIN swarm.hosted_mcp_grant_workspaces b USING(grant_id)
        JOIN swarm.hosted_mcp_seats s ON s.grant_id=g.grant_id AND s.workspace_id=b.workspace_id
        WHERE g.grant_id=c.hosted_grant_id AND g.state='active' AND g.revoked_at IS NULL AND b.workspace_id=c.workspace_id AND b.revoked_at IS NULL
        AND s.principal_id=c.principal_id AND s.revoked_at IS NULL))`;
    const doing = Object.values(current.todos).filter(t => t.state === 'doing' && t.assignee?.kind === 'agent' && t.assignee.id === principalId).sort((a,b) => a.state_at.localeCompare(b.state_at))[0];
    const live = agent.revoked_at === null && agent.member_live && (agent.transport === 'hosted_mcp' ? agent.hosted_live : agent.token_live || agent.renewal_live);
    const facts: AgentWorkFacts = { transport: agent.transport as 'local' | 'hosted_mcp', turn_only: Boolean(agent.turn_only),
      connection: live ? 'live' : agent.revoked_at !== null || !agent.member_live ? 'removed' : agent.transport === 'hosted_mcp' ? 'connection_off' : agent.key_off ? 'key_off' : agent.paused ? 'paused' : 'key_ended',
      last_activity_at: nullableIso(activity!.last_activity_at), messages_waiting_since: nullableIso(activity!.messages_waiting_since),
      doing: doing ? { todo_id: doing.todo_id, title: doing.title, since: doing.state_at } : null,
      working_on: claim ? { signal_id: String(claim.id), at: iso(claim.created_at), until: iso(claim.until) } : null };
    const work = facts.connection === 'connection_off' ? 'disconnected' : core.agentWorkState({ ...facts, connection: facts.connection }, now);
    return { owner_user_id: String(agent.owner_user_id), status: { work, facts },
      content_access: !live || !approval?.can_read ? 'none' : approval.can_write ? 'read_write' : 'read' };
  }
  async function read(tx: Sql, workspaceId: string, identity: HouseholdIdentity, query: HouseholdTodoQuery) {
    const initial = await authorize(tx, workspaceId, identity, 'read');
    if (initial.denied) return { status: 'refused' as const, reason: initial.denied };
    const current = await state(tx, workspaceId, false);
    const latest = await authorize(tx, workspaceId, identity, 'read');
    if (latest.denied) return { status: 'refused' as const, reason: latest.denied };
    const now = latest.checked!.now, offset = bounded('offset' in query ? query.offset : undefined, 0, Number.MAX_SAFE_INTEGER);
    const limit = Math.max(1, bounded('limit' in query ? query.limit : undefined, query.kind === 'comment_list' ? 20 : 50, query.kind === 'comment_list' ? 20 : 50));
    let result: unknown;
    if (query.kind === 'todo_list') {
      const rows = Object.values(current.todos).filter(t => (query.scope === 'all' || t.state === 'open' || t.state === 'doing') && (!query.assignee || t.assignee?.kind === query.assignee.kind && t.assignee.id === query.assignee.id))
        .sort((a,b) => b.created_at.localeCompare(a.created_at) || a.todo_id.localeCompare(b.todo_id)).map(t => summary(t, current, now));
      const todos: typeof rows = [];
      const next = page(rows, offset, limit, todos, next_offset => ({ todos, next_offset }));
      result = { todos, next_offset: next };
    } else if (query.kind === 'todo_read' || query.kind === 'comment_list') {
      const todo = query.kind === 'todo_read' ? current.todos[query.todo_id] : null;
      if (query.kind === 'todo_read' && !todo) return { status: 'refused' as const, reason: 'todo_not_found' as const };
      const commentOffset = query.kind === 'todo_read' ? bounded(query.comment_offset, 0, Number.MAX_SAFE_INTEGER) : offset;
      const target = query.kind === 'todo_read' ? { kind: 'todo' as const, id: query.todo_id } : query.target;
      const rows = await comments(tx, workspaceId, target, commentOffset, query.kind === 'todo_read' ? 20 : limit);
      const loaded: TodoComment[] = [];
      const detail = todo ? view(todo, current, now) : null;
      const next = page(rows, 0, query.kind === 'todo_read' ? 20 : limit, loaded, n => detail
        ? { todo: detail, comments: loaded, next_comment_offset: n === null ? null : commentOffset + n }
        : { comments: loaded, next_offset: n === null ? null : commentOffset + n }, detail ? 0 : 1);
      result = detail ? { todo: detail, comments: loaded, next_comment_offset: next === null ? null : commentOffset + next }
        : { comments: loaded, next_offset: next === null ? null : commentOffset + next };
    } else {
      const principal = query.principal_id ?? identity.principal_id;
      if (!principal) return { status: 'refused' as const, reason: 'principal_required' as const };
      const facts = await queueFacts(tx, workspaceId, principal, current, now);
      if (!facts) return { status: 'refused' as const, reason: 'assignee_not_member' as const };
      const all = Object.values(current.todos).filter(t => t.state === 'open' || t.state === 'doing').sort((a,b) => (a.queue_rank ?? Number.MAX_SAFE_INTEGER) - (b.queue_rank ?? Number.MAX_SAFE_INTEGER) || a.todo_id.localeCompare(b.todo_id));
      const assigned = all.filter(t => t.assignee?.kind === 'agent' && t.assignee.id === principal);
      const sections = {
        working: assigned.filter(t => t.state === 'doing'),
        up_next: assigned.filter(t => t.state === 'open' && t.queue_rank !== null && core.evaluateGate(t.gate, current.todos, now)),
        not_yet: assigned.filter(t => t.state === 'open' && !core.evaluateGate(t.gate, current.todos, now)),
        requests: all.filter(t => t.offer?.to.kind === 'agent' && t.offer.to.id === principal),
      };
      type Section = keyof typeof sections;
      const sectionNames: Section[] = ['working', 'up_next', 'not_yet', 'requests'];
      const loaded = { working: [] as ReturnType<typeof summary>[], up_next: [] as ReturnType<typeof summary>[], not_yet: [] as ReturnType<typeof summary>[], requests: [] as ReturnType<typeof summary>[] };
      const next_offset: Record<Section, number | null> = { working: null, up_next: null, not_yet: null, requests: null };
      const metadata = { workspace_id: workspaceId, principal_id: principal, ...facts, accepts_from: current.policies[principal]?.accepts_from ?? 'owner', read_at: new Date(now).toISOString() };
      let cut = false;
      for (const section of sectionNames) {
        if (query.section && query.section !== section || cut) { next_offset[section] = 0; continue; }
        const minimumRows = sectionNames.some(name => loaded[name].length > 0) ? 0 : 1;
        next_offset[section] = page(sections[section].map(t => summary(t, current, now)), query.section ? offset : 0, limit, loaded[section], n => ({ queue: { ...metadata, ...loaded, next_offset: { ...next_offset, [section]: n } } }), minimumRows);
        if (next_offset[section] !== null) cut = true;
      }
      result = { ...metadata, ...loaded, next_offset };
    }
    if ((await authorize(tx, workspaceId, identity, 'read')).denied) return { status: 'refused' as const, reason: 'workspace_access_refused' as const };
    return result;
  }
  return { write, read, state };
}
