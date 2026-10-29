/** Production hosted to-do executor. The bundle reads SWARM_MCP_TODOS_LISTS_ENABLED="1".
 * Seat binding, capability, credential recheck and notices stay production code; ports are synthetic.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { TOOL_FAILURE_MESSAGE } from '../supabase/functions/mcp/tool-errors.js';
import { hostedHouseholdRelease } from './support/hosted-household-release.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const wa = id(1), wb = id(2), owner = id(3), self = id(4), other = id(5), conn = id(6), grant = id(7);
const at = '2026-10-05T12:00:00.000Z';
const seatA = 'seat_ABCDEFGHIJKLMNOPQRSTUV', seatB = 'seat_ZYXWVUTSRQPONMLKJIHGFE', foreign = 'seat_0000000000000000000001';
const seats: Record<string, { workspace: string; principal: string }> = { [seatA]: { workspace: wa, principal: self }, [seatB]: { workspace: wb, principal: id(9) } };
type Row = Record<string, unknown>;
interface Box {
  flags: { grant: boolean; member: boolean; connection: boolean; consent: string | null; bind: Set<string>; provider: boolean; live: boolean; authBudget: number };
  todos: Map<string, Row[]>; comments: Row[]; receipts: Map<string, { digest: string; outcome: unknown }>;
  streams: Map<string, { stream_id: string; last_seq: number }>; authCount: number; surface: number; signals: number; lastSignal: string | null;
}
const fresh = (): Box => ({ flags: { grant: false, member: false, connection: false, consent: id(8), bind: new Set([wa, wb]), provider: true, live: true, authBudget: Infinity },
  todos: new Map(), comments: [], receipts: new Map(), streams: new Map(), authCount: 0, surface: 0, signals: 0, lastSignal: null });
let box = fresh();
const wsOf = (values: unknown[]) => values.find((value): value is string => value === wa || value === wb);
const measured = (value: unknown) => Buffer.byteLength(JSON.stringify(JSON.stringify(value)), 'utf8');
function answer(sql: string, values: unknown[]): Row[] {
  const flags = box.flags, ws = wsOf(values);
  if (sql.startsWith('LOCK TABLE swarm.household_content_connections IN ACCESS SHARE MODE')) return [];
  if (sql.includes('FROM pg_catalog.pg_policy')) return [{ present: false }];
  // Hosted seats have no local bearer or renewal family.
  if (sql.includes('FROM swarm.discover_local_target_ids(')) return [];
  if (sql.includes('SELECT t.renewal_grant_id,t.lineage_id,t.run_id')) return [];
  if (sql.includes('SELECT s.owner_user_id,s.seat_id AS connection_id')) return ws ? [{ owner_user_id: owner,
    connection_id: conn, grant_id: grant, handle: ws === wa ? seatA : seatB, provider_grant_id: 'synthetic-grant' }] : [];
  if (sql.includes("current_setting('role')")) return [{ value: 'swarm_read' }];
  if (sql.includes('SELECT EXISTS(SELECT 1 FROM swarm.resolve_hosted_seat_read_authorization')) return [{ live: flags.provider && !flags.grant && !flags.member && !!ws && flags.bind.has(ws) }];
  // Match catalog/restriction/legacy queries before their nested seat references.
  if (sql.includes('FROM swarm.household_hosted_content_restrictions r')) return [];
  if (sql.includes('SELECT seat_id,grant_id,owner_user_id FROM swarm.hosted_mcp_seats')) return [{ seat_id: conn, grant_id: grant, owner_user_id: owner }];
  if (sql.includes('SELECT c.*,') && sql.includes('FROM swarm.household_content_connections c')) return [{
    workspace_id: ws, owner_user_id: owner, principal_id: self, connection_id: conn, grant_id: grant, hosted_grant_id: grant, renewal_grant_id: null,
    operations: ['read', 'create', 'update'], purpose: 'shared', revoked_at: flags.connection ? at : null, expires_at: null, closed_replaced: false }];
  if (sql.includes('SELECT p.*')) return [self, other, id(9)].includes(String(values.at(-1))) ? [{ owner_user_id: owner, revoked_at: null, member_live: true, transport: 'hosted_mcp', hosted_live: true, turn_only: true }] : [];
  if (sql.includes('SELECT greatest(')) return [{ last_activity_at: at, messages_waiting_since: null }];
  if (sql.includes('id,created_at,until')) return [];
  if (sql.includes('FROM swarm.agent_principals p JOIN swarm.agent_workspace_memberships am')) return [self, other, id(9)].map(principal_id => ({ principal_id, workspace_id: ws, owner_user_id: owner, revoked_at: null }));
  if (sql.includes('role FROM swarm.memberships')) return [{ user_id: owner, workspace_id: ws, revoked_at: flags.member ? at : null, role: 'owner' }];
  if (sql.includes('archived_at FROM swarm.workspaces')) { box.surface += 1; return [{ archived_at: null }]; }
  if (sql.includes('purpose, owner_user_id')) return [{ purpose: 'shared', owner_user_id: owner }];
  if (sql.includes('revoked_at FROM swarm.memberships')) return [{ role: 'owner', revoked_at: flags.member ? at : null }];
  if (sql.includes('household_member_content_roles')) return [{ revoked_at: null, content_role: 'editor', content_consent_id: flags.consent }];
  if (sql.includes('revoked_at FROM swarm.agent_principals')) return [{ revoked_at: null }];
  if (sql.includes('household_content_connections')) return [{ connection_id: conn, grant_id: grant, hosted_grant_id: grant, renewal_grant_id: null, operations: ['read', 'create', 'update'], purpose: 'shared', revoked_at: flags.connection ? at : null, expires_at: null }];
  if (sql.includes('FROM swarm.hosted_mcp_grants')) return [{ state: flags.grant ? 'revoked' : 'active', revoked_at: flags.grant ? at : null, connection_expires_at: null, connection_expired_at: null }];
  if (sql.includes('SELECT swarm.hosted_binding_eligible')) return [{live:!!ws && flags.bind.has(ws)}];
  if (sql.includes('hosted_mcp_seats')) return [{ revoked_at: null }];
  if (sql.includes('AS now')) return [{ now: at }];
  if (sql.includes('INSERT INTO swarm.household_todo_streams')) {
    if (ws && !box.streams.has(ws)) box.streams.set(ws, { stream_id: String(values[1]), last_seq: -1 });
    return [];
  }
  if (sql.includes('SELECT stream_id,last_seq')) return ws && box.streams.has(ws) ? [box.streams.get(ws)!] : [];
  if (sql.includes('UPDATE swarm.household_todo_streams')) { const row = ws ? box.streams.get(ws) : undefined; if (row) row.last_seq = Number(values[0]); return []; }
  if (sql.includes('SELECT * FROM swarm.household_todos')) return [...(ws ? box.todos.get(ws) ?? [] : [])].sort((a, b) => String(a.todo_id).localeCompare(String(b.todo_id)));
  if (sql.includes('accepts_from')) return [];
  if (sql.includes('SELECT request_digest,outcome')) { const hit = box.receipts.get(`${values[0]}|${values[1]}|${values[2]}`); return hit ? [{ request_digest: hit.digest, outcome: hit.outcome }] : []; }
  if (sql.includes('household_object_streams')) return [];
  if (sql.includes('rate_buckets')) return [{ count: 1, resets_at: new Date(at) }];
  if (sql.includes('INSERT INTO swarm.household_todos')) {
    const record = (values.find(value => value && typeof value === 'object' && 'record' in (value as Row)) as { record: Row }).record;
    const list = box.todos.get(String(record.workspace_id)) ?? [];
    const index = list.findIndex(row => row.todo_id === record.todo_id);
    if (index < 0) list.push({ ...record }); else list[index] = { ...record };
    box.todos.set(String(record.workspace_id), list);
    return [];
  }
  if (sql.includes('INSERT INTO swarm.household_comments')) {
    box.comments.push({ comment_id: values[1], target_kind: values[2], target_id: values[3], author_user: values[4], author_principal: values[5], body: values[6], mentions: values[7], created_at: values[10] });
    return [];
  }
  if (sql.includes('SELECT * FROM swarm.household_comments')) {
    const offset = Number(values.at(-2)), limit = Number(values.at(-1));
    return box.comments.filter(row => row.target_id === values[2]).slice(offset, offset + limit);
  }
  if (sql.includes('INSERT INTO swarm.household_todo_receipts')) { box.receipts.set(`${values[0]}|${values[1]}|${values[2]}`, { digest: String(values[3]), outcome: values[4] }); return []; }
  if (sql.includes('INSERT INTO') || sql.includes('set_config') || sql.includes('audit_log')) return [];
  throw new Error(`unexpected sql: ${sql.slice(0, 240)}`);
}

function query(sql: string, values: unknown[]): Row[] {
  if (sql.startsWith('LOCK TABLE swarm.household_content_connections IN ACCESS SHARE MODE')
    || sql.includes('SELECT s.owner_user_id,s.seat_id AS connection_id')
    || sql.includes('SELECT EXISTS(SELECT 1 FROM swarm.resolve_hosted_seat_read_authorization')) return answer(sql, values);
  if (!/^\s*(select|insert|update|delete|with)\b/i.test(sql)) return [{ fragment: true }];
  const flags = box.flags, handle = String(sql.includes('hosted_mcp_seat_handles') ? values.at(-1) : values[1]), seat = seats[handle];
  // Queue facts contain nested tombstone lookups; return the principal row first.
  if (sql.includes('SELECT p.*')) return answer(sql, values);
  if (sql.includes('provider_family_active')) return [{ active: flags.provider }];
  if (sql.includes('hosted_mcp_seat_handles')) return seat ? [{ grant_id: grant, owner_user_id: owner, workspace_id: seat.workspace, handle }] : [];
  if (sql.includes('resolve_hosted_seat_')) { box.authCount += 1; if (box.authCount > flags.authBudget) return [];
    return seat ? [{ grant_id: grant, provider_grant_id: 'synthetic-grant', seat_id: conn, handle, workspace_id: seat.workspace, stream_id: id(10), owner_user_id: owner, principal_id: seat.principal, name: 'Synthetic' }] : []; }
  if (sql.includes('min_client_version')) return [{ value: '0.1.0' }];
  if (sql.includes('SELECT m.role, m.revoked_at')) return [{ role: 'owner', revoked_at: null }];
  if (sql.includes('FROM swarm.streams') && /kind\s*=\s*'workspace'/.test(sql)) return [{ stream_id: id(10) }];
  if (sql.includes('revocation_tombstones')) return [];
  if (sql.includes('SELECT user_id') && sql.includes('FROM swarm.memberships') && sql.includes('revoked_at IS NULL')) return flags.live ? [{ user_id: owner }] : [];
  if (sql.includes('FROM swarm.agent_principals AS p') && sql.includes('JOIN swarm.memberships')) return flags.live ? [{ principal_id: other }] : [];
  if (sql.includes('INSERT INTO swarm.signals')) { box.signals += 1; box.lastSignal = id(40 + box.signals);
    return [{ inserted: true, refusal_code: null, id: box.lastSignal, workspace_id: wsOf(values) ?? wa, from_principal: self, from_kind: 'agent', to_user_id: owner, to_agent_principal_id: null, in_reply_to: null, reply_status: null, about: 'todo', kind: 'ask', body: 'notice', until: new Date(at), created_at: new Date(at), channel_id: null, thread_root_id: null, broadcast_to_channel: false, chain_hop: null }]; }
  return answer(sql, values);
}
(globalThis as typeof globalThis & { __h3Query?: typeof query }).__h3Query = query;

const limits = { maxBodyBytes: 128 * 1024, maxResponseBytes: 64 * 1024, requestTimeoutMs: 25_000, maxConcurrentRequests: 4 };
function handlerFor(create: (options: object) => (request: Request) => Promise<Response>, executeTool: (call: { name: string }) => Promise<unknown>) {
  return create({ issuer: 'https://mcp.example.test', resource: 'https://mcp.example.test/mcp', publicEnabled: true, allowedOrigins: new Set(), limits,
    verifyToken: async () => ({ providerGrantId: 'synthetic-grant', subject: owner, expiresAt: 1_900_000_000 }), executeTool });
}
async function call(handler: (request: Request) => Promise<Response>, name: string, args: Row, status = 200): Promise<Row> {
  const response = await handler(new Request('https://mcp.example.test/mcp', { method: 'POST', headers: { authorization: 'Bearer synthetic-token', 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'h3', method: 'tools/call', params: { name, arguments: args } }) }));
  assert.equal(response.status, status, name);
  const payload = await response.json() as { error?: { message: string }; result?: { isError?: boolean; content: { text: string }[] } };
  if (status !== 200) return payload as Row;
  const body = JSON.parse(payload.result!.content[0]!.text) as Row; return payload.result!.isError ? { ...body, isError: true } : body;
}
const seed = (n: number, title: string): Row => ({ workspace_id: wa, todo_id: id(1000 + n), version: 1, title, notes: '', state: 'open', due_on: null,
  created_by_user: owner, created_by_principal: self, created_at: at, assignee_user: null, assignee_principal: null, assigned_by_user: null, assigned_by_principal: null, assigned_at: null,
  offer_id: null, gate_kind: 'none', gate_note: null, gate_todo_id: null, gate_at: null, gate_set_by: null, queue_rank: null, state_by_user: owner, state_by_principal: self, state_at: at, comment_count: 0 });
const message = async (handler: (request: Request) => Promise<Response>, name: string, args: Row) =>
  (await call(handler, name, args, 400) as { error: { message: string } }).error.message;
const todo = (body: Row) => body.value as Row, notices = (body: Row) => body.notices as Row[];

async function productionEntry() {
  const dir = fileURLToPath(new URL('../supabase/functions/mcp/', import.meta.url));
  const source = `import * as commandApi from "../command/index.ts";\nimport * as readApi from "../read/index.ts";\n${readFileSync(`${dir}index.ts`, 'utf8')}`
    .replace('const command = await import("../command/index.ts");', 'const command = commandApi;')
    .replace('const read = await import("../read/index.ts");', 'const read = readApi;')
    .replace('async function executeTool(', 'export async function executeTool(') + '\nexport { createMcpProtocolHandler };\n';
  if (source.includes('await import("../command') || source.includes('await import("../read')) throw new Error('mcp entry still loads command or read dynamically');
  const bundled = await build({
    stdin: { contents: source, resolveDir: dir, loader: 'ts', sourcefile: 'index.ts' },
    bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022', logLevel: 'silent',
    banner: { js: `const settings=${JSON.stringify({ SWARM_ENV: 'test', SWARM_DATABASE_URL: 'postgres://127.0.0.1:1/unused', SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_ANON_KEY: 'inert-test-value', SUPABASE_SERVICE_ROLE_KEY: 'inert-test-value', SWARM_MCP_TODOS_LISTS_ENABLED: '1', SWARM_MCP_PUBLIC_ENABLED: '1' })};
      Object.defineProperty(globalThis,'Deno',{value:{env:{get:name=>settings[name]},serve:()=>undefined},configurable:true});` },
    plugins: [{ name: 'inert', setup(builder) {
      builder.onResolve({ filter: /^npm:/ }, args => ({ path: args.path, namespace: 'inert' }));
      builder.onLoad({ filter: /.*/, namespace: 'inert' }, args => ({ loader: 'js', contents: args.path.startsWith('npm:postgres')
        ? 'export default function postgres(){const sql=(first,...rest)=>Array.isArray(first)&&Object.hasOwn(first,"raw")?globalThis.__h3Query(first.join("?"),rest):{record:first};sql.begin=async(...a)=>a.at(-1)(sql);sql.savepoint=async f=>f(sql);sql.json=v=>v;sql.unsafe=async(q,v)=>globalThis.__h3Query(String(q),v??[]);return sql;}'
        : args.path.startsWith('npm:@supabase/supabase-js') ? 'export function createClient(){return{auth:{async getUser(){return{data:{user:null},error:{message:"inert"}}},async getClaims(){return{data:null,error:{message:"inert"}}}}}}'
        : `throw new Error(${JSON.stringify(`unexpected ${args.path}`)})` }));
    } }],
  });
  return await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0]!.text).toString('base64')}`) as {
    createMcpProtocolHandler: (options: object) => (request: Request) => Promise<Response>; executeTool: (call: { name: string }) => Promise<Row>;
  };
}

test('hosted to-do tools through the MCP handler', async (t) => {
  await t.test('switch off refuses one to-do tool as unknown', async () => {
    const called: string[] = [];
    const off = handlerFor((await hostedHouseholdRelease(false)).createMcpProtocolHandler, async ({ name }) => { called.push(name); return { ok: true }; });
    assert.deepEqual(await call(off, 'todo_list', { seat: seatA, scope: 'open' }, 400), await call(off, 'unknown_tool', {}, 400));
    assert.deepEqual(await call(off, 'whoami', { seat: seatA }), { ok: true });
    assert.deepEqual(called, ['whoami']);
  });
  const entry = await productionEntry();
  const seen: string[] = [];
  const on = handlerFor(entry.createMcpProtocolHandler, async (callOptions) => { seen.push(callOptions.name); box.authCount = 0; return entry.executeTool(callOptions); });
  const list = () => call(on, 'todo_list', { seat: seatA, scope: 'open' });
  await t.test('seat binding, capability and credential recheck', async () => {
    box = fresh(); seen.length = 0;
    assert.equal(await message(on, 'todo_list', { scope: 'open' }), 'invalid_arguments');
    assert.equal(await message(on, 'todo_list', { seat: seatA, scope: 'open', workspace_id: wa }), 'invalid_arguments');
    assert.deepEqual(seen, []);
    const before = box.surface, denied = await call(on, 'todo_list', { seat: foreign, scope: 'open' });
    assert.equal(denied.isError, true); assert.equal(denied.error, 'hosted_seat_forbidden'); assert.notEqual(denied.message, TOOL_FAILURE_MESSAGE);
    assert.equal(box.surface, before); assert.equal((await list()).status, 'ok'); assert.ok(box.surface > before);
    const bound = box.surface; box.flags.provider = false;
    assert.equal((await call(on, 'todo_list', { seat: seatA, scope: 'open' })).error, 'hosted_seat_forbidden');
    assert.equal(box.surface, bound);
    box.flags.provider = true; assert.equal((await list()).status, 'ok');
    box.flags.authBudget = 2; assert.equal((await list()).reason, 'workspace_access_refused');
    box.flags.authBudget = Infinity; assert.equal((await list()).status, 'ok');
  });
  await t.test('grant, member and content-approval revocation each refuse', async () => {
    box = fresh();
    for (const flag of ['grant', 'member', 'connection'] as const) {
      assert.equal((await list()).status, 'ok', flag);
      box.flags[flag] = true;
      assert.equal((await list()).reason, flag === 'connection' ? 'connection_access_refused' : 'workspace_access_refused', flag);
      box.flags[flag] = false;
    }
    assert.equal((await list()).status, 'ok');
  });
  await t.test('another workspace cannot read this seat’s to-do', async () => {
    box = fresh();
    const created = todo(await call(on, 'todo_create', { seat: seatA, request_id: 'req-cross-01', title: 'Home' }));
    assert.equal((await call(on, 'todo_read', { seat: seatB, todo_id: created.todo_id })).reason, 'todo_not_found');
    assert.equal((await call(on, 'todo_read', { seat: seatA, todo_id: created.todo_id }) as { todo: Row }).todo.todo_id, created.todo_id);
  });
  await t.test('same request replays and a stale version conflicts', async () => {
    box = fresh();
    const first = todo(await call(on, 'todo_create', { seat: seatA, request_id: 'req-replay-1', title: 'Once' }));
    const again = await call(on, 'todo_create', { seat: seatA, request_id: 'req-replay-1', title: 'Once' });
    assert.equal(again.replayed, true); assert.equal(todo(again).todo_id, first.todo_id);
    assert.equal((await call(on, 'todo_create', { seat: seatA, request_id: 'req-replay-1', title: 'Twice' })).reason, 'request_id_reused');
    const second = todo(await call(on, 'todo_create', { seat: seatA, request_id: 'req-replay-2', title: 'Twice' }));
    assert.notEqual(second.todo_id, first.todo_id);
    const stale = await call(on, 'todo_update', { seat: seatA, request_id: 'req-conflict1', todo_id: first.todo_id, base_version: 9, title: 'Stale' });
    assert.equal(stale.status, 'conflict'); assert.equal((stale.current as Row).version, 1);
    assert.equal(todo(await call(on, 'todo_update', { seat: seatA, request_id: 'req-conflict2', todo_id: first.todo_id, base_version: 1, title: 'Fresh' })).version, 2);
  });
  await t.test('assignment requests never start a model', async () => {
    box = fresh(); let models = 0;
    t.mock.method(globalThis, 'fetch', () => { models += 1; throw new Error('no model'); });
    const created = todo(await call(on, 'todo_create', { seat: seatA, request_id: 'req-offer-01', title: 'Ask' }));
    box.flags.live = false;
    const quiet = await call(on, 'todo_assign', { seat: seatA, request_id: 'req-offer-02', todo_id: created.todo_id, base_version: created.version, to: { kind: 'agent', id: other }, start: 'now' });
    assert.equal(notices(quiet)[0]?.status, 'not_sent'); assert.equal(notices(quiet)[0]?.reason, 'recipient_not_live'); assert.equal(box.signals, 0);
    box.flags.live = true;
    const offered = await call(on, 'todo_assign', { seat: seatA, request_id: 'req-offer-03', todo_id: created.todo_id, base_version: todo(quiet).version, to: { kind: 'agent', id: other }, start: 'now' });
    assert.equal(todo(offered).state, 'open'); assert.ok(todo(offered).offer); assert.equal(notices(offered)[0]?.status, 'sent');
    assert.equal(notices(offered)[0]?.signal_id, box.lastSignal); assert.equal(box.signals, 1);
    const replayed = await call(on, 'todo_assign', { seat: seatA, request_id: 'req-offer-03', todo_id: created.todo_id, base_version: todo(quiet).version, to: { kind: 'agent', id: other }, start: 'now' });
    assert.equal(replayed.replayed, true); assert.equal(box.signals, 1);
    const queued = todo(await call(on, 'todo_assign', { seat: seatA, request_id: 'req-offer-04', todo_id: created.todo_id, base_version: todo(offered).version, to: { kind: 'agent', id: self }, start: 'queue' }));
    assert.equal(queued.state, 'open'); assert.equal(queued.offer, null); assert.deepEqual(queued.assignee, { kind: 'agent', id: self });
    assert.equal(todo(await call(on, 'todo_start', { seat: seatA, request_id: 'req-offer-05', todo_id: created.todo_id })).state, 'doing');
    assert.equal(models, 0);
  });
  await t.test('escaped pages stay within 28 KiB and publish next_offset', async () => {
    box = fresh(); box.todos.set(wa, [seed(1, 'short')]);
    const small = await list();
    assert.equal(small.next_offset, null); assert.ok(measured(small) <= 28 * 1024);
    box.todos.set(wa, Array.from({ length: 200 }, (_, n) => seed(n, '"\\'.repeat(70).slice(0, 200))));
    const page = await call(on, 'todo_list', { seat: seatA, scope: 'all' }), rows = page.todos as Row[];
    assert.equal(page.next_offset, rows.length); assert.ok(rows.length > 0 && rows.length < 200); assert.ok(measured(page) <= 28 * 1024);
    const follow = await call(on, 'todo_list', { seat: seatA, scope: 'all', offset: page.next_offset });
    const ids = (body: Row) => (body.todos as Row[]).map(row => String(row.todo_id)), first = ids(page), second = ids(follow);
    assert.equal(second[0], id(1000 + first.length)); assert.equal(first.some(todoId => second.includes(todoId)), false);
  });
  await t.test('missing content consent refuses, then a later call is allowed', async () => {
    box = fresh(); box.flags.consent = null;
    const denied = await list();
    assert.equal(denied.status, 'refused'); assert.equal(denied.reason, 'content_consent_required');
    box.flags.consent = id(8); assert.equal((await list()).status, 'ok');
  });
});
