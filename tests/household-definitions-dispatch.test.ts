/** Definition reads and certification through the real household dispatch, with
 * synthetic SQL facts and a controlled storage port (no live data or credentials). */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { executeHouseholdSurface } from '../supabase/functions/command/household-integration.js';
import { householdCanonical } from '../supabase/functions/command/household-transfers.js';
import { emptyHouseholdObjectState } from '../src/protocol/household-objects.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const workspace = id(1), user = id(2), principal = id(3), at = '2026-10-05T12:00:00.000Z';
const connection = { connection_id: id(4), grant_id: id(5) };
const identity = { user_id: user, principal_id: principal, run_id: null, connection };
const blobs = new Map<string, Buffer>();
const author = { user_id: user, principal_id: null, run_id: null, connection_id: null, grant_id: null };
function revision(objectId: string, token: string, fields: { term: string; meaning: string; source: string }, parent: string | null, kind = 'definition') {
  const bytes = Buffer.from(householdCanonical(kind === 'definition' ? { kind, ...fields } : { kind, items: [] }));
  const key = `household/${objectId}/${token}`;
  blobs.set(key, bytes);
  return { revision: { workspace_id: workspace, object_id: objectId, token }, title: fields.term, kind,
    parent: parent === null ? null : { workspace_id: workspace, object_id: objectId, token: parent }, file_metadata: null,
    blob: { storage_key: key, size_bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
    author, occurred_at_server: Date.parse(at), command_id: `create_${token}` };
}
const spend1 = revision('spend', 'revision_spend_1', { term: 'Monthly spend', meaning: 'Card spend per month.', source: 'Statements' }, null);
const spend2 = revision('spend', 'revision_spend_2', { term: 'Monthly spend', meaning: 'Card and cash spend per month.', source: 'Statements' }, 'revision_spend_1');
const due = revision('due', 'revision_due_1', { term: 'Due date', meaning: 'When a bill must be paid.', source: '' }, null);
const groceries = revision('groceries', 'revision_groceries_1', { term: 'Groceries', meaning: '', source: '' }, null, 'list');
const projection = { ...emptyHouseholdObjectState(workspace, id(6)), objects: {
  spend: { object_id: 'spend', kind: 'definition', history: [spend1, spend2],
    certification: { revision: spend1.revision, certified_by: user, certified_at: 7 } },
  due: { object_id: 'due', kind: 'definition', history: [due] },
  groceries: { object_id: 'groceries', kind: 'list', history: [groceries] } } };

/** SQL supplies facts only. Production dispatch decides consent, scope and reads. */
function fixture() {
  const tx = (async (parts: TemplateStringsArray) => {
    const query = parts.join('?');
    if (query.startsWith('LOCK TABLE swarm.household_content_connections IN ACCESS SHARE MODE')) return [];
    if (query.includes('FROM pg_catalog.pg_policy')) return [{ present: false }];
    if (query.includes('SELECT swarm.hosted_binding_eligible(')) return [{ live: true }];
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
  return { tx, tool: (name: string, args: Record<string, unknown>) => executeHouseholdSurface(tx, workspace,
    identity, 'read_request_001', { kind: 'household_tool', tool: name,
      arguments: { seat: 'seat_0000000000000000000000', ...args } }, async () => true) };
}


function storage(t: { after: (fn: () => void) => void; mock: { method: (...args: any[]) => unknown } }) {
  const settings: Record<string, string> = { SUPABASE_URL: 'https://storage.invalid', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-storage-key' };
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'Deno');
  Object.defineProperty(globalThis, 'Deno', { configurable: true, value: { env: { get: (name: string) => settings[name] } } });
  t.after(() => { if (prior) Object.defineProperty(globalThis, 'Deno', prior); else Reflect.deleteProperty(globalThis, 'Deno'); });
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    const key = url.replace('https://storage.invalid/storage/v1/object/authenticated/swarm-files/', '');
    const bytes = blobs.get(key);
    assert.ok(bytes, `unexpected blob ${key}`);
    return new Response(new Uint8Array(bytes));
  });
}

test('definitions_search pages terms with certification; object_list keeps hiding them', async (t) => {
  storage(t);
  const { tool } = fixture();
  assert.deepEqual(await tool('definitions_search', {}), { status: 'ok', next_offset: null, definitions: [
    { object_id: 'due', term: 'Due date', revision: due.revision, certification: null },
    { object_id: 'spend', term: 'Monthly spend', revision: spend2.revision,
      certification: { revision: spend1.revision, certified_by: user, certified_at: 7 } },
  ] });
  const page = await tool('definitions_search', { query: 'E', limit: 1 });
  assert.deepEqual([(page.definitions as { term: string }[]).map(row => row.term), page.next_offset], [['Due date'], 1]);
  assert.deepEqual(((await tool('definitions_search', { query: 'month' })).definitions as { object_id: string }[]).map(row => row.object_id), ['spend']);
  const listed = await tool('object_list', { offset: 0, limit: 10 });
  assert.deepEqual((listed.objects as { object_id: string }[]).map(row => row.object_id), ['groceries']);
});

test('definition_read returns the certified version beside a pending proposal', async (t) => {
  storage(t);
  const { tool } = fixture();
  assert.deepEqual(await tool('definition_read', { object_id: 'spend' }), { status: 'ok', object_id: 'spend',
    current: { revision: spend2.revision, term: 'Monthly spend', meaning: 'Card and cash spend per month.', source: 'Statements',
      author, occurred_at_server: Date.parse(at) },
    certified: { revision: spend1.revision, term: 'Monthly spend', meaning: 'Card spend per month.', source: 'Statements',
      certified_by: user, certified_at: 7 },
    proposal_pending: true });
  const uncertified = await tool('definition_read', { object_id: 'due' });
  assert.deepEqual([uncertified.certified, uncertified.proposal_pending], [null, true]);
  assert.deepEqual(await tool('definition_read', { object_id: 'groceries' }), { status: 'refused', reason: 'object_type_mismatch' });
  assert.deepEqual(await tool('object_read', { object_id: 'spend' }), { status: 'refused', reason: 'object_type_mismatch' });
});

test('an agent credential cannot certify, before any database read', async () => {
  const tx = (async () => { throw new Error('no database access expected'); }) as unknown as Parameters<typeof executeHouseholdSurface>[0];
  assert.deepEqual(await executeHouseholdSurface(tx, workspace, identity, 'certify_001',
    { kind: 'household_definition_certify', object_id: 'spend', revision: spend2.revision }, async () => true),
    { status: 'refused', reason: 'human_confirmation_required' });
});
