import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';

// Exercise the actual edge entry points without importing Deno-only type paths
// into the root TS project. Database fixtures supply facts, never decisions.
const module = await build({ entryPoints: ['supabase/functions/command/household-permissions.ts'],
  bundle: true, write: false, format: 'esm', platform: 'node' });
const { approveHouseholdConnection: approve, withdrawHouseholdConnection: withdraw } =
  await import(`data:text/javascript;base64,${Buffer.from(module.outputFiles![0]!.text).toString('base64')}`);
const owner = randomUUID(), workspace = randomUUID(), principal = randomUUID();
const identity = { user_id: owner, principal_id: null, run_id: null, connection: null };
const connection = { kind: 'hosted', connection_id: randomUUID(), grant_id: randomUUID(), principal_id: principal, operations: ['read'] };
const yes = async () => true;
function facts(role = 'editor', localExpiry?: string) {
  const tx = Object.assign(async (sql: TemplateStringsArray) => {
    const query = sql.join('?');
    if (query.startsWith('SELECT archived_at')) return [{ archived_at: null }];
    if (query.includes('FROM swarm.memberships')) return [{ role: 'owner', revoked_at: null }];
    if (query.includes('FROM swarm.household_workspace_boundaries')) return [{ purpose: 'shared', owner_user_id: null }];
    if (query.includes('FROM swarm.household_member_content_roles')) return [{ content_role: role, content_consent_id: randomUUID(), revoked_at: null }];
    if (query.includes('FROM swarm.household_content_connections')) return [];
    if (query.includes('FROM swarm.streams')) return [{ stream_id: randomUUID() }];
    if (query.includes('FROM swarm.idempotency_keys')) return [];
    if (query.includes('FROM swarm.agent_principals')) return [{ principal_id: principal, revoked_at: null }];
    if (query.includes('FROM swarm.agent_tokens')) return localExpiry ? [{ expires_at: localExpiry }] : [];
    if (query.includes('FROM swarm.hosted_mcp_seats')) return [{ seat_id: connection.connection_id }];
    if (query.startsWith('SELECT set_config') || query.startsWith('INSERT INTO swarm.household_content_connections')
      || query.startsWith('INSERT INTO swarm.idempotency_keys') || query.startsWith('UPDATE swarm.household_content_connections')) return [];
    throw new Error('unexpected database boundary');
  }, { json: (value: unknown) => value });
  return tx;
}

test('approval validates exact command and connection keys and operations with valid controls', async () => {
  const input = { kind: 'household_approve_connection', connection };
  assert.deepEqual(await approve(facts(), workspace, identity, randomUUID(), input, yes),
    { status: 'committed', operations: ['read'], expires_at: null });
  for (const value of [{ ...input, purpose: 'shared' }, { ...input, content_role: 'editor' }, { ...input, kind: 'wrong' }])
    assert.deepEqual(await approve(facts(), workspace, identity, randomUUID(), value, yes), { status: 'refused', reason: 'invalid_request' });
  for (const value of [null, [], { ...connection, extra: true }, { ...connection, kind: 'other' },
    { ...connection, connection_id: 'bad' }, { ...connection, operations: [] },
    { ...connection, operations: ['read', 'read'] }, { ...connection, operations: ['create'] },
    { ...connection, operations: ['read', 'delete'] }])
    assert.deepEqual(await approve(facts(), workspace, identity, randomUUID(), { ...input, connection: value }, yes),
      { status: 'refused', reason: 'invalid_connection_consent' });
});

test('reader approval admits read and refuses create or update without changing the human ceiling', async () => {
  const input = { kind: 'household_approve_connection', connection };
  assert.deepEqual(await approve(facts('reader'), workspace, identity, randomUUID(), input, yes),
    { status: 'committed', operations: ['read'], expires_at: null });
  for (const operations of [['read', 'create'], ['read', 'update']])
    assert.deepEqual(await approve(facts('reader'), workspace, identity, randomUUID(),
      { ...input, connection: { ...connection, operations } }, yes), { status: 'refused', reason: 'invalid_connection_consent' });
});

test('withdraw validates its exact command keys and both commands require a checked human', async () => {
  const input = { kind: 'household_withdraw_connection', principal_id: principal };
  assert.deepEqual(await withdraw(facts(), workspace, identity, randomUUID(), input, yes), { status: 'committed', withdrawn: 0 });
  for (const value of [{ ...input, extra: true }, { kind: input.kind }, { ...input, principal_id: 'bad' }, { ...input, kind: 'wrong' }])
    assert.deepEqual(await withdraw(facts(), workspace, identity, randomUUID(), value, yes), { status: 'refused', reason: 'invalid_request' });
  for (const [fn, value] of [[approve, { kind: 'household_approve_connection', connection }], [withdraw, input]] as const) {
    for (const actor of [{ ...identity, principal_id: principal }, { ...identity, connection }])
      assert.deepEqual(await fn(facts(), workspace, actor, randomUUID(), value, yes), { status: 'refused', reason: 'human_confirmation_required' });
    assert.deepEqual(await fn(facts(), workspace, identity, randomUUID(), value, async () => false),
      { status: 'refused', reason: 'human_confirmation_required' });
  }
});


test('local approval retains the checked token expiry and refuses unavailable tokens', async () => {
  const expires = '2100-01-01T00:00:00.000Z';
  const input = { kind: 'household_approve_connection', connection: { ...connection, kind: 'local' } };
  assert.deepEqual(await approve(facts('editor', expires), workspace, identity, randomUUID(), input, yes),
    { status: 'committed', operations: ['read'], expires_at: expires });
  assert.deepEqual(await approve(facts(), workspace, identity, randomUUID(), input, yes),
    { status: 'refused', reason: 'connection_access_refused' });
});
