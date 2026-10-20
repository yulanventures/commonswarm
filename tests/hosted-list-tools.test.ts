/** Real hosted executor, capability rechecks and household storage with synthetic
 * SQL/HTTP ports. Production result handling owns paging and approval guidance. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { householdRefusalNextStep } from '../src/protocol/household-next-steps.js';

type Row = Record<string, any>;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const wa = id(1), wb = id(2), owner = id(3), principal = id(4), grant = id(5), connection = id(6);
const seatA = 'seat_ABCDEFGHIJKLMNOPQRSTUV', seatB = 'seat_ZYXWVUTSRQPONMLKJIHGFE', at = '2026-10-05T12:00:00.000Z';
const seats: Row = { [seatA]: wa, [seatB]: wb };
const projections = new Map<string, Row>(), bindings = new Map<string, string>(), artifacts = new Map<string, string>(), blobs = new Map<string, Uint8Array>();
let denied = '', provider = true;

/** Facts and persisted rows only: production code authorizes, decides and reduces. */
function query(sql: string, values: any[]): Row[] {
  const ws = values.find(value => value === wa || value === wb);
  if (sql.startsWith('LOCK TABLE swarm.household_content_connections IN ACCESS SHARE MODE')) return [];
  if (sql.includes('FROM pg_catalog.pg_policy')) return [{ present: false }];
  // Match catalog/restriction/legacy queries before their nested seat references.
  if (sql.includes('FROM swarm.household_hosted_content_restrictions r')) return [];
  if (sql.includes('SELECT seat_id,grant_id,owner_user_id FROM swarm.hosted_mcp_seats')) return [{ seat_id: connection, grant_id: grant, owner_user_id: owner }];
  if (sql.includes('SELECT c.*,') && sql.includes('FROM swarm.household_content_connections c')) return [{
    workspace_id: ws, owner_user_id: owner, principal_id: principal, connection_id: connection, grant_id: grant, hosted_grant_id: grant,
    operations: ['read', 'create', 'update'], purpose: 'shared', revoked_at: denied === 'connection_access_refused' ? at : null, expires_at: null, closed_replaced: false }];
  if (sql.includes('provider_family_active')) return [{ active: provider }];
  if (sql.includes('hosted_mcp_seat_handles')) {
    const handle = values.at(-1); return seats[handle] ? [{ grant_id: grant, owner_user_id: owner, workspace_id: seats[handle], handle }] : [];
  }
  if (sql.includes('resolve_hosted_seat_')) return seats[values[1]] ? [{ grant_id: grant, provider_grant_id: 'synthetic-grant', seat_id: connection,
    handle: values[1], workspace_id: seats[values[1]], stream_id: id(7), owner_user_id: owner, principal_id: principal, name: 'Synthetic' }] : [];
  if (sql.includes('min_client_version')) return [{ value: '0.1.0' }];
  if (sql.includes('SELECT m.role, m.revoked_at')) return [{ role: 'owner', revoked_at: null }];
  if (sql.includes('FROM swarm.streams') && sql.includes("kind = 'workspace'")) return [{ stream_id: id(7) }];
  if (sql.includes('revocation_tombstones')) return [];
  if (sql.includes('archived_at FROM swarm.workspaces')) return [{ archived_at: null }];
  if (sql.includes('purpose, owner_user_id')) return [{ purpose: 'shared', owner_user_id: owner }];
  if (sql.includes('revoked_at FROM swarm.memberships')) return [{ role: 'owner', revoked_at: null }];
  if (sql.includes('revoked_at FROM swarm.agent_principals')) return [{ revoked_at: null }];
  if (sql.includes('household_member_content_roles')) return [{ revoked_at: denied === 'workspace_access_refused' ? at : null,
    content_role: 'editor', content_consent_id: denied === 'content_consent_required' ? null : id(8) }];
  if (sql.includes('household_content_connections')) return [{ connection_id: connection, grant_id: grant, hosted_grant_id: grant,
    operations: ['read', 'create', 'update'], purpose: 'shared', revoked_at: denied === 'connection_access_refused' ? at : null, expires_at: null }];
  if (sql.includes('FROM swarm.hosted_mcp_grants')) return [{ state: 'active', revoked_at: null }];
  if (sql.includes('hosted_mcp_grant_workspaces') || sql.includes('hosted_mcp_seats')) return [{ revoked_at: null }];
  if (sql.includes('AS now')) return [{ now: at }];
  if (sql.includes('SELECT projection')) return projections.has(ws) ? [{ projection: projections.get(ws) }] : [];
  if (sql.includes('INSERT INTO swarm.household_object_streams')) { projections.set(ws, values[2]); return [{ projection: values[2] }]; }
  if (sql.includes('UPDATE swarm.household_object_streams')) { projections.set(ws, values[1]); return []; }
  if (sql.includes('SELECT file_id FROM swarm.household_object_bindings')) {
    const file_id = bindings.get(`${ws}/${values[1]}`); return file_id ? [{ file_id }] : [];
  }
  if (sql.includes('INSERT INTO swarm.household_object_bindings')) bindings.set(`${ws}/${values[1]}`, values[2]);
  if (sql.includes('SELECT coalesce(max(version_n)')) return [{ n: 0 }];
  if (sql.includes('SELECT') && sql.includes('AS bytes')) return [{ bytes: '0', names: '0' }];
  if (sql.includes('INSERT INTO swarm.household_object_artifacts')) artifacts.set(`${ws}/${values[1]}/${values[8]}`, values[4]);
  if (sql.includes('SELECT storage_path FROM swarm.household_object_artifacts')) {
    const storage_path = artifacts.get(`${ws}/${values[1]}/${values[2]}`); return storage_path ? [{ storage_path }] : [];
  }
  if (sql.includes('rate_buckets')) return [{ count: 1 }];
  if (sql.includes('SELECT stream_id,last_seq') || sql.includes('SELECT * FROM swarm.household_todos') || sql.includes('accepts_from')) return [];
  if (/^\s*(INSERT|UPDATE)/i.test(sql) || sql.includes('set_config')) return [];
  throw new Error(`Unexpected SQL: ${sql.slice(0, 180)}`);
}

/** Bundle the actual host and its command/read modules; replace external ports,
 * exposing the executor only in this test bundle, as in the hosted to-do proof. */
async function productionEntry() {
  const dir = fileURLToPath(new URL('../supabase/functions/mcp/', import.meta.url));
  const source = `import * as commandApi from '../command/index.ts';\nimport * as readApi from '../read/index.ts';\n${readFileSync(`${dir}index.ts`, 'utf8')}`
    .replace('const command = await import("../command/index.ts");', 'const command = commandApi;')
    .replace('const read = await import("../read/index.ts");', 'const read = readApi;')
    .replace('async function executeTool(', 'export async function executeTool(') + '\nexport { createMcpProtocolHandler };';
  const settings = { SWARM_ENV: 'test', SWARM_DATABASE_URL: 'postgres://127.0.0.1:1/unused', SUPABASE_URL: 'https://storage.invalid',
    SUPABASE_ANON_KEY: 'synthetic', SUPABASE_SERVICE_ROLE_KEY: 'synthetic', SWARM_MCP_TODOS_LISTS_ENABLED: '1' };
  const bundled = await build({ stdin: { contents: source, resolveDir: dir, loader: 'ts' }, bundle: true, write: false,
    platform: 'node', format: 'esm', target: 'es2022', logLevel: 'silent',
    banner: { js: `const settings=${JSON.stringify(settings)};Object.defineProperty(globalThis,'Deno',{value:{env:{get:n=>settings[n]}},configurable:true});` },
    plugins: [{ name: 'synthetic-ports', setup(builder) {
      builder.onResolve({ filter: /^npm:/ }, args => ({ path: args.path, namespace: 'synthetic' }));
      builder.onLoad({ filter: /.*/, namespace: 'synthetic' }, args => ({ loader: 'js', contents: args.path.startsWith('npm:postgres')
        ? 'export default function(){const sql=(p,...v)=>Array.isArray(p)&&Object.hasOwn(p,"raw")?globalThis.__h4Query(p.join("?"),v):{record:p};sql.begin=async(...a)=>a.at(-1)(sql);sql.json=v=>v;sql.unsafe=(q,v)=>globalThis.__h4Query(q,v??[]);return sql;}'
        : args.path.startsWith('npm:@supabase/supabase-js') ? 'export function createClient(){return{auth:{}}}' : 'throw new Error("Unexpected dependency");' }));
    } }],
  });
  return await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0]!.text).toString('base64')}`);
}

test('hosted list tools use production capabilities, storage and bounded results', async t => {
  const globals = globalThis as typeof globalThis & { __h4Query?: typeof query };
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'Deno'); globals.__h4Query = query;
  t.after(() => { delete globals.__h4Query; if (prior) Object.defineProperty(globalThis, 'Deno', prior); else Reflect.deleteProperty(globalThis, 'Deno'); });
  t.mock.method(globalThis, 'fetch', async (url: string, options?: RequestInit) => {
    assert.ok(url.startsWith('https://storage.invalid/storage/v1/object/')); assert.equal(options?.redirect, 'error');
    const path = url.split('/').slice(-3).join('/');
    if (options?.method === 'POST') { assert.equal(blobs.has(path), false); blobs.set(path, options.body as Uint8Array); return new Response('{}'); }
    return blobs.has(path) ? new Response(new Uint8Array(blobs.get(path)!)) : new Response(null, { status: 404 });
  });
  const entry = await productionEntry();
  const limits = { maxBodyBytes: 128 * 1024, maxResponseBytes: 64 * 1024, requestTimeoutMs: 25_000, maxConcurrentRequests: 4 };
  const handler = (maxResponseBytes = limits.maxResponseBytes) => entry.createMcpProtocolHandler({ issuer: 'https://mcp.example.test', resource: 'https://mcp.example.test/mcp',
    publicEnabled: true, allowedOrigins: new Set(), limits: { ...limits, maxResponseBytes },
    verifyToken: async () => ({ providerGrantId: 'synthetic-grant', subject: owner, expiresAt: 1_900_000_000 }), executeTool: entry.executeTool });
  const on = handler();
  let request = 0;
  const rpc = (name: string, args: Row = {}, run = on, status = 200) => run(new Request('https://mcp.example.test/mcp', {
    method: 'POST', headers: { authorization: 'Bearer synthetic', 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'h4', method: 'tools/call', params: { name, arguments: { seat: seatA,
      ...(['list_list', 'list_history'].includes(name) ? { offset: 0, limit: 50 } : name === 'todo_list' ? { scope: 'all' } : {}), ...args } } }),
  })).then(async (response: Response) => { assert.equal(response.status, status, name); const raw = await response.text();
    if (status === 200) assert.ok(Buffer.byteLength(raw) <= 64 * 1024); return JSON.parse(raw); });
  const call = async (name: string, args: Row = {}) => JSON.parse((await rpc(name, args)).result.content[0].text) as Row;
  const create = (object_id: string, text = 'Milk') => call('list_create', { request_id: `h4-create-${++request}`, object_id, title: object_id,
    content: { kind: 'list', items: [{ item_id: 'milk', text, order: 0, checked: false }] } });
  await t.test('create, read, list, update, history, same-id replay and stale-base conflict', async () => {
    const args = { request_id: 'h4-replay-001', object_id: 'shopping', title: 'Shopping', content: { kind: 'list', items: [] } };
    const first = await call('list_create', args); assert.equal(first.status, 'committed');
    const replay = await call('list_create', args); assert.equal(replay.replayed, true); assert.deepEqual(replay.revision, first.revision);
    assert.equal((await call('list_create', { ...args, title: 'Changed' })).reason, 'request_id_reused');
    const read = await call('list_read', { object_id: 'shopping' }); assert.deepEqual(read.content, args.content);
    const patch = { kind: 'list', operations: [{ kind: 'add', item_id: 'milk', text: 'Milk', checked: false, after_item_id: null }] };
    const update = { request_id: 'h4-update-001', object_id: 'shopping', base: first.revision, patch };
    const second = await call('list_update', update); assert.equal(second.status, 'committed'); assert.notDeepEqual(second.revision, first.revision);
    assert.equal((await call('list_update', update)).replayed, true);
    const stale = await call('list_update', { ...update, request_id: 'h4-stale-001' });
    assert.equal(stale.status, 'conflict'); assert.deepEqual(stale.current, second.revision); assert.ok(projections.get(wa)!.drafts[stale.draft_id]);
    assert.deepEqual((await call('list_read', { object_id: 'shopping', revision: first.revision })).content, args.content);
    assert.equal((await call('list_read', { object_id: 'shopping' })).content.items[0].text, 'Milk');
    const history = await call('list_history', { object_id: 'shopping', offset: 0, limit: 1 });
    assert.equal(history.revisions.length, 1); assert.equal(history.next_offset, 1);
    assert.equal((await call('list_history', { object_id: 'shopping', offset: 1, limit: 1 })).next_offset, null);
    assert.equal((await call('list_list')).objects.length, 1);
    assert.equal((await call('list_update', { request_id: 'h4-remove-001', object_id: 'shopping', base: second.revision,
      patch: { kind: 'list', operations: [{ kind: 'remove', item_id: 'milk', before_text: 'Milk', before_checked: false }] } })).status, 'committed');
    assert.deepEqual((await call('list_read', { object_id: 'shopping' })).content.items, []);
  });
  await t.test('bound workspace and list kind refuse foreign, doc and file IDs beside controls', async () => {
    assert.equal((await call('list_read', { seat: seatB, object_id: 'shopping' })).reason, 'object_not_found');
    assert.equal((await call('list_list', { seat: seatB })).objects.length, 0);
    assert.equal((await call('list_read', { object_id: 'shopping' })).status, 'ok');
    for (const kind of ['doc', 'file']) {
      assert.equal((await create(kind)).status, 'committed');
      const object = projections.get(wa)!.objects[kind]; object.kind = kind; object.history[0].kind = kind;
      const revision = object.history[0], bytes = Buffer.from('{"kind":"doc","markdown":"Notes"}');
      if (kind === 'doc') { blobs.set(revision.blob.storage_key, bytes); revision.blob.size_bytes = bytes.length; revision.blob.sha256 = createHash('sha256').update(bytes).digest('hex'); }
      else revision.file_metadata = { kind: 'file', name: 'notes.txt', media_type: 'text/plain' };
      for (const name of ['list_read', 'list_history']) assert.equal((await call(name, { object_id: kind })).reason, 'object_type_mismatch');
      assert.equal((await call('list_update', { request_id: `h4-${kind}-update`, object_id: kind, base: object.history[0].revision,
        patch: { kind: 'list', operations: [] } })).status, 'refused');
    }
    assert.deepEqual((await call('list_list')).objects.map((row: Row) => row.object_id), ['shopping']);
    assert.equal((await call('list_create', { seat: seatB, request_id: 'h4-workspace-b', object_id: 'elsewhere', title: 'Other', content: { kind: 'list', items: [] } })).status, 'committed');
    assert.equal((await call('list_read', { object_id: 'elsewhere' })).reason, 'object_not_found');
    assert.equal((await call('list_read', { seat: seatB, object_id: 'elsewhere' })).status, 'ok');
    provider = false; assert.equal((await call('list_list')).error, 'hosted_seat_forbidden'); provider = true;
    assert.equal((await call('list_list')).status, 'ok');
  });
  await t.test('second pages shrink with absolute offsets for discovery and history', async () => {
    const base = projections.get(wa)!.objects.shopping.history[0];
    for (let n = 0; n < 12; n++) {
      const object_id = `page-${String(n).padStart(2, '0')}`;
      projections.get(wa)!.objects[object_id] = { object_id, kind: 'list', history: [{ ...base, title: '"\\'.repeat(1500), revision: { ...base.revision, object_id } }] };
    }
    const page = await call('list_list', { offset: 3, limit: 10 });
    assert.ok(page.objects.length > 0 && page.objects.length < 10); assert.equal(page.next_offset, 3 + page.objects.length);
    const follow = await call('list_list', { offset: page.next_offset, limit: 10 });
    assert.equal(follow.objects[0].object_id, `page-${String(page.next_offset).padStart(2, '0')}`);
    projections.get(wa)!.objects.shopping.history = Array.from({ length: 12 }, (_, n) => ({ ...base,
      title: '"\\'.repeat(1500), revision: { ...base.revision, token: `page_revision_${n}` } }));
    const history = await call('list_history', { object_id: 'shopping', offset: 3, limit: 9 });
    assert.ok(history.revisions.length > 0 && history.revisions.length < 9); assert.equal(history.next_offset, 3 + history.revisions.length);
    const next = await call('list_history', { object_id: 'shopping', offset: history.next_offset, limit: 1 });
    assert.notEqual(next.revisions[0].revision.token, history.revisions.at(-1).revision.token);
  });
  await t.test('oversized lists refuse intact and the final escaped host envelope refuses overflow', async () => {
    assert.equal((await create('large', 'x'.repeat(40000))).status, 'committed');
    const oversized = await call('list_read', { object_id: 'large' });
    assert.equal(oversized.status, 'refused'); assert.equal(oversized.reason, 'list_response_too_large'); assert.equal('content' in oversized, false);
    assert.equal((await create('small')).status, 'committed'); assert.equal((await call('list_read', { object_id: 'small' })).content.items.length, 1);
    const capped = handler(1024); await rpc('list_read', { object_id: 'small' }, capped);
    const refused = await rpc('list_list', { offset: 3, limit: 10 }, capped, 500); assert.equal(refused.error.message, 'Response exceeds limit');
    assert.equal((await call('list_list', { offset: 3, limit: 10 })).status, 'ok');
  });
  await t.test('not-yet-allowed guidance is added through production for to-dos and lists', async () => {
    for (const name of ['todo_list', 'list_list']) for (const reason of ['content_consent_required', 'connection_access_refused', 'workspace_access_refused']) {
      denied = ''; assert.equal((await call(name)).status, 'ok'); denied = reason;
      const refusal = await call(name); assert.equal(refusal.status, 'refused'); assert.equal(refusal.reason, reason);
      assert.equal(refusal.next_action, householdRefusalNextStep(reason)); assert.match(String(refusal.next_action), /People & agents → this agent → Lists & docs → Allow…/);
      denied = ''; assert.equal((await call(name)).status, 'ok');
    }
  });
});
