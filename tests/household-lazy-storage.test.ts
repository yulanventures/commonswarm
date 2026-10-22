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
    if (query.startsWith('LOCK TABLE swarm.household_content_connections IN ACCESS SHARE MODE')) return [];
    if (query.includes('FROM pg_catalog.pg_policy')) return [{ present: false }];
    if (query.includes('SELECT role, revoked_at FROM swarm.memberships')) return [{ role: 'owner', revoked_at: null }];
    if (query.includes('SELECT seat_id,grant_id,owner_user_id FROM swarm.hosted_mcp_seats')) return [{
      seat_id: connection.connection_id, grant_id: connection.grant_id, owner_user_id: user }];
    if (query.includes('FROM swarm.household_hosted_content_restrictions r')) return [];
    // The existing manual approval is a read-only ceiling on this hosted seat.
    if (query.includes('SELECT c.*,') && query.includes('FROM swarm.household_content_connections c')) return [{
      ...connection, workspace_id: workspace, principal_id: principal, owner_user_id: user, hosted_grant_id: connection.grant_id,
      operations: ['read'], purpose: 'shared', revoked_at: null, expires_at: null, closed_replaced: false }];
    if (query.includes('SELECT archived_at FROM swarm.workspaces')) return [{ archived_at: null }];
    if (query.includes('SELECT purpose, owner_user_id')) return [{ purpose: 'shared', owner_user_id: user }];
    if (query.includes('SELECT revoked_at FROM swarm.memberships')) return [{ revoked_at: null }];
    if (query.includes('SELECT * FROM swarm.household_member_content_roles')) return [{ revoked_at: null, content_role: 'editor', content_consent_id: id(7) }];
    if (query.includes('SELECT revoked_at FROM swarm.agent_principals')) return [{ revoked_at: null }];
    if (query.includes('SELECT t.renewal_grant_id,t.lineage_id,t.run_id')) return [];
    if (query.includes('SELECT c.* FROM swarm.household_content_connections c') || query.includes('SELECT * FROM swarm.household_content_connections')) return [{ ...connection,
      hosted_grant_id: connection.grant_id, operations: ['read'], purpose: 'shared', revoked_at: null, expires_at: null }];
    if (query.includes('SELECT state,revoked_at,connection_expires_at,connection_expired_at FROM swarm.hosted_mcp_grants')) return [{ state: 'active', revoked_at: null, connection_expires_at: null, connection_expired_at: null }];
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

// This dispatch boundary owns connection-summary projection. SQL returns raw
// facts; the real content resolver computes effective operations and policy.
test('connection summaries preserve family consent across bearer replacement and separate canonical policy', async () => {
  const family = id(20), original = id(21), current = id(22), run = id(23), receipt = id(7);
  const cases: { name: string; deadline: string | null; expired: string | null;
    bearerExpired: boolean; revoked: boolean; expected: string[]; principalRevoked?: boolean;
    familyRevoked?: boolean; sourceTamper?: boolean; receiptTamper?: boolean; purposeTamper?: boolean }[] = [
    { name: 'rotated permanent', deadline: null, expired: null, bearerExpired: false, revoked: false, expected: ['read'] },
    { name: 'technical bearer elapsed', deadline: null, expired: null, bearerExpired: true, revoked: false, expected: [] },
    { name: 'future owner policy', deadline: '2026-12-01T00:00:00.000Z', expired: null, bearerExpired: false, revoked: false, expected: ['read'] },
    { name: 'terminal policy', deadline: null, expired: at, bearerExpired: false, revoked: false, expected: [] },
    { name: 'withdrawal', deadline: null, expired: null, bearerExpired: false, revoked: true, expected: [] },
    { name: 'revoked principal', deadline: null, expired: null, bearerExpired: false, revoked: false, principalRevoked: true, expected: [] },
    { name: 'revoked family', deadline: null, expired: null, bearerExpired: false, revoked: false, familyRevoked: true, expected: [] },
    { name: 'source tamper', deadline: null, expired: null, bearerExpired: false, revoked: false, sourceTamper: true, expected: [] },
    { name: 'receipt tamper', deadline: null, expired: null, bearerExpired: false, revoked: false, receiptTamper: true, expected: [] },
    { name: 'purpose tamper', deadline: null, expired: null, bearerExpired: false, revoked: false, purposeTamper: true, expected: [] },
  ];
  for (const c of cases) {
    const approval = { connection_id: original, grant_id: run, principal_id: principal, workspace_id: workspace,
      owner_user_id: user, lineage_id: id(24), renewal_grant_id: family, hosted_grant_id: c.sourceTamper ? run : null, consent_receipt_id: c.receiptTamper ? id(99) : receipt,
      operations: ['read'], expires_at: null, revoked_at: c.revoked ? at : null, purpose: c.purposeTamper ? 'personal' : 'shared' };
    const policy = { renewal_grant_id: family, revoked_at: c.familyRevoked ? at : null, local_content_approval_token_id: original,
      connection_expires_at: c.deadline, connection_expired_at: c.expired };
    const tx = (async (parts: TemplateStringsArray) => {
      const q = parts.join('?');
      if (q.includes("'hosted' AS kind")) return [];
      if (q.includes("'local' AS kind")) return [{ kind: 'local', connection_id: current, grant_id: run,
        principal_id: principal, lineage_id: id(24), name: 'Synthetic local', ...policy }];
      if (q.includes('SELECT connection_id, grant_id, principal_id, operations, expires_at') || q.includes('SELECT c.connection_id,c.grant_id')) return c.revoked ? [] : [approval];
      if (q.startsWith('LOCK TABLE')) return [];
      if (q.includes('FROM pg_catalog.pg_policy')) return [{ present: false }];
      if (q.includes('SELECT archived_at')) return [{ archived_at: null }];
      if (q.includes('SELECT purpose, owner_user_id')) return [{ purpose: 'shared', owner_user_id: user }];
      if (q.includes('SELECT role, revoked_at')) return [{ role: 'owner', revoked_at: null }];
      if (q.includes('household_member_content_roles')) return [{ content_role: 'editor', content_consent_id: receipt, revoked_at: null }];
      if (q.includes('SELECT revoked_at FROM swarm.agent_principals')) return c.principalRevoked ? [] : [{ revoked_at: null }];
      if (q.includes('SELECT t.renewal_grant_id,t.lineage_id,t.run_id')) return c.bearerExpired ? [] : [{ renewal_grant_id: family, lineage_id: id(24), run_id: run }];
      if (q.includes('FROM swarm.renewal_grants')) return [policy];
      if (q.includes('SELECT c.*')) return [approval];
      if (q.includes('SELECT seat_id,grant_id,owner_user_id')) return [];
      if (q.includes('clock_timestamp() AS now')) return [{ now: at }];
      throw new Error(`Unexpected summary query: ${q}`);
    }) as unknown as Parameters<typeof executeHouseholdSurface>[0];
    const result = await executeHouseholdSurface(tx, workspace,
      { user_id: user, principal_id: null, run_id: null, connection: null }, 'summary_request',
      { kind: 'household_connections' }, async () => true);
    assert.equal(result.status, 'ok', c.name);
    const row = (result.connections as any[])[0];
    assert.equal(row.renewal_grant_id, family, c.name);
    assert.equal(row.connection_expires_at, c.deadline, c.name);
    assert.equal(row.connection_expired_at, c.expired, c.name);
    assert.deepEqual(row.approval, c.revoked ? null : { operations: ['read'], expires_at: null }, c.name);
    assert.deepEqual(row.effective_access.operations, c.expected, c.name);
  }
});
