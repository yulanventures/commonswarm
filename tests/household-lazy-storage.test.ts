/** Dispatch regression: locked synthetic facts and a controlled HTTP storage port
 * exercise real authorization and blob verification; no live data or credentials. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { executeHouseholdSurface } from '../supabase/functions/command/household-integration.js';
import { HouseholdTransferError } from '../supabase/functions/command/household-transfers.js';
import { emptyHouseholdObjectState } from '../src/protocol/household-objects.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const workspace = id(1), user = id(2), principal = id(3), at = '2026-10-05T12:00:00.000Z';
const connection = { connection_id: id(4), grant_id: id(5) };
const identity = { user_id: user, principal_id: principal, run_id: null, connection };
const content = { kind: 'list', items: [{ item_id: 'milk', text: 'Milk', checked: false, order: 0 }] };
const bytes = Buffer.from('{"items":[{"checked":false,"item_id":"milk","order":0,"text":"Milk"}],"kind":"list"}');
const revision = { revision: { workspace_id: workspace, object_id: 'shopping', token: 'revision_0001' },
  parent: null, title: 'Shopping', kind: 'list' as const, file_metadata: null,
  blob: { storage_key: 'household/shopping/version1', size_bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') },
  author: { user_id: user, principal_id: principal, run_id: null, ...connection },
  occurred_at_server: Date.parse(at), command_id: 'create_shopping' };
const projection = { ...emptyHouseholdObjectState(workspace, id(6)),
  objects: { shopping: { object_id: 'shopping', kind: 'list', history: [revision] } } };

/** SQL supplies facts only. Production dispatch decides consent, scope and reads. */
function fixture() {
  const tx = (async (parts: TemplateStringsArray) => {
    const query = parts.join('?');
    if (query.includes('SELECT archived_at FROM swarm.workspaces')) return [{ archived_at: null }];
    if (query.includes('SELECT purpose, owner_user_id')) return [{ purpose: 'shared', owner_user_id: user }];
    if (query.includes('SELECT revoked_at FROM swarm.memberships')) return [{ revoked_at: null }];
    if (query.includes('SELECT * FROM swarm.household_member_content_roles')) return [{ revoked_at: null, content_role: 'editor', content_consent_id: id(7) }];
    if (query.includes('SELECT revoked_at FROM swarm.agent_principals')) return [{ revoked_at: null }];
    if (query.includes('SELECT * FROM swarm.household_content_connections')) return [{ ...connection,
      hosted_grant_id: connection.grant_id, operations: ['read'], purpose: 'shared', revoked_at: null, expires_at: null }];
    if (query.includes('SELECT state, revoked_at FROM swarm.hosted_mcp_grants')) return [{ state: 'active', revoked_at: null }];
    if (query.includes('SELECT revoked_at FROM swarm.hosted_mcp_grant_workspaces')
      || query.includes('SELECT revoked_at FROM swarm.hosted_mcp_seats')) return [{ revoked_at: null }];
    if (query.includes('SELECT clock_timestamp() AS now')) return [{ now: at }];
    if (query.includes('SELECT projection FROM swarm.household_object_streams')) return [{ projection }];
    if (query.includes('SELECT stream_id,last_seq')) return [{ stream_id: id(8), last_seq: -1 }];
    if (query.includes('SELECT * FROM swarm.household_todos')
      || query.includes('SELECT principal_id,accepts_from')) return [];
    throw new Error(`Unexpected database query: ${query}`);
  }) as unknown as Parameters<typeof executeHouseholdSurface>[0];
  return (tool: string, args: Record<string, unknown>, live = true) => executeHouseholdSurface(tx, workspace,
    identity, 'read_request_001', { kind: 'household_tool', tool,
      arguments: { seat: 'seat_0000000000000000000000', ...args } }, async () => live);
}

test('authorized dispatch leaves storage untouched until a blob read and retains revocation checks', async (t) => {
  const settings: Record<string, string | undefined> = {};
  const requested: string[] = [];
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'Deno');
  Object.defineProperty(globalThis, 'Deno', { configurable: true,
    value: { env: { get: (name: string) => { requested.push(name); return settings[name]; } } } });
  t.after(() => { if (prior) Object.defineProperty(globalThis, 'Deno', prior); else Reflect.deleteProperty(globalThis, 'Deno'); });
  const http = t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    assert.equal(url, 'https://storage.invalid/storage/v1/object/authenticated/swarm-files/household/shopping/version1');
    assert.equal(options.redirect, 'error');
    assert.equal(new Headers(options.headers).get('authorization'), 'Bearer synthetic-storage-key');
    return new Response(bytes);
  });
  const dispatch = fixture();
  const todos = await dispatch('todo_list', { scope: 'all' });
  assert.equal(todos.status, 'ok');
  assert.deepEqual(todos.todos, []);
  assert.equal((await dispatch('object_list', { offset: 0, limit: 10 })).status, 'ok');
  assert.deepEqual(requested, [], 'to-dos and metadata must not resolve storage configuration');
  assert.deepEqual(await dispatch('object_read', { object_id: 'shopping' }, false),
    { status: 'refused', reason: 'workspace_access_refused' });
  assert.deepEqual(requested, [], 'revoked access must fail before storage setup');
  for (const missing of [{}, { SUPABASE_URL: 'https://storage.invalid' }, { SUPABASE_SERVICE_ROLE_KEY: 'synthetic-storage-key' }]) {
    settings.SUPABASE_URL = missing.SUPABASE_URL;
    settings.SUPABASE_SERVICE_ROLE_KEY = missing.SUPABASE_SERVICE_ROLE_KEY;
    await assert.rejects(dispatch('object_read', { object_id: 'shopping' }),
      (error: unknown) => error instanceof HouseholdTransferError && error.code === 'storage_unavailable');
  }
  assert.equal(http.mock.callCount(), 0, 'missing configuration must fail closed before HTTP');
  settings.SUPABASE_URL = 'https://storage.invalid';
  settings.SUPABASE_SERVICE_ROLE_KEY = 'synthetic-storage-key';
  const read = await dispatch('object_read', { object_id: 'shopping' });
  assert.equal(read.status, 'ok');
  assert.deepEqual(read.content, content);
  assert.deepEqual((read.revision as { revision: unknown }).revision, revision.revision);
  assert.equal(http.mock.callCount(), 1);
  assert.deepEqual(await dispatch('object_read', { object_id: 'shopping' }, false),
    { status: 'refused', reason: 'workspace_access_refused' });
  assert.equal(http.mock.callCount(), 1, 'revocation must prevent another byte request');
});
