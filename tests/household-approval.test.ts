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
const family = randomUUID(), device = randomUUID();
const now = '2099-01-01T00:00:00.000Z';
const yes = async () => true;
function facts(role = 'editor', localExpiry?: string, tokenOverrides: Record<string, unknown> = {}) {
  const restrictions = new Map<string, Record<string, unknown>>();
  const approvals: Record<string, unknown>[] = [], familySelections: unknown[][] = [];
  const consent = randomUUID();
  const binding = { token_id: connection.connection_id, predecessor_token_id: null, renewal_grant_id: family,
    principal_id: principal, run_id: connection.grant_id, device_id: device, owner_user_id: owner,
    workspace_id: workspace, lineage_id: randomUUID(), token_parent_admin_grant_id: null, principal_parent_admin_grant_id: null };
  const read = (query: string, values: unknown[]): Record<string, unknown>[] => {
    if (query.includes('FROM swarm.discover_local_target_ids')) return localExpiry ? [binding] : [];
    if (query.startsWith('SELECT clock_timestamp()')) return [{ now }];
    if (query.includes('FROM swarm.agent_execution_sessions')) return [];
    if (query.startsWith('SELECT user_id FROM swarm.users')) return [{ user_id: owner }];
    if (query.startsWith('SELECT workspace_id FROM swarm.workspaces')) return [{ workspace_id: workspace }];
    if (query.startsWith('SELECT run_id FROM swarm.agent_runs')) return [{ run_id: connection.grant_id }];
    if (query.startsWith('SELECT device_id FROM swarm.devices')) return [{ device_id: device }];
    if (query.startsWith('SELECT renewal_grant_id FROM swarm.renewal_grants')) return [{ renewal_grant_id: family }];
    if (query.startsWith('SELECT principal_id FROM swarm.agent_workspace_memberships'))
      return values[0] === workspace && values[1] === principal ? [{ principal_id: principal }] : [];
    if (query.startsWith('SELECT swarm.local_agent_workspace_live('))
      return [{ ok: values[0] === principal && values[1] === workspace }];
    if (query.startsWith('LOCK TABLE swarm.household_content_connections IN ACCESS SHARE MODE')) return [];
    if (query.includes('FROM pg_catalog.pg_policy')) return [{ present: false }];
    // No retired seats exist in this fixture, so the exact replacement set is empty.
    if (query.startsWith('SELECT coalesce(jsonb_agg(snapshot')) return [{ snapshots: [] }];
    if (query.startsWith('SELECT grant_id FROM swarm.household_hosted_content_restrictions')) {
      const row = restrictions.get(String(values[2])); return row ? [row] : [];
    }
    if (query.startsWith('INSERT INTO swarm.household_hosted_content_restrictions')) {
      restrictions.set(String(values[3]), { grant_id: values[0], workspace_id: values[1], owner_user_id: values[2],
        principal_id: values[3], operations: values[4], origin: values[5], closed_target_replacements: values[6] }); return [];
    }
    if (query.startsWith('UPDATE swarm.household_hosted_content_restrictions')) {
      const row = restrictions.get(String(values[5]));
      if (row) Object.assign(row, { operations: values[0], origin: values[1], closed_target_replacements: values[2] }); return [];
    }
    if (query.startsWith('SELECT archived_at')) return [{ archived_at: null }];
    if (query.includes('FROM swarm.memberships')) return [{ role: 'owner', revoked_at: null }];
    if (query.includes('FROM swarm.household_workspace_boundaries')) return [{ workspace_id: workspace, purpose: 'shared', owner_user_id: null }];
    if (query.includes('FROM swarm.household_member_content_roles')) return [{ content_role: role, content_consent_id: consent, revoked_at: null }];
    if (query.includes('FROM swarm.household_content_connections')) return [];
    if (query.includes('FROM swarm.streams')) return [{ stream_id: randomUUID() }];
    if (query.includes('FROM swarm.idempotency_keys')) return [];
    if (query.includes('FROM swarm.agent_principals')) return [{ principal_id: principal, revoked_at: null }];
    if (query.includes('FROM swarm.agent_tokens')) return localExpiry ? [{ token_id: connection.connection_id,
      renewal_grant_id: family, connection_expires_at: null, connection_expired_at: null,
      expires_at: localExpiry, revoked_at: null, surrender_only: false, ended_at: null,
      device_revoked_at: null, family_revoked_at: null, suspension_active: false,
      bound_device_id: device, device_id: device, ...tokenOverrides }] : [];
    if (query.includes('FROM swarm.hosted_mcp_seats')) return [{ seat_id: connection.connection_id,
      grant_id: connection.grant_id, connection_expires_at: null, connection_expired_at: null }];
    if (query.startsWith('INSERT INTO swarm.household_content_connections')) {
      const keys = ['connection_id', 'grant_id', 'workspace_id', 'principal_id', 'owner_user_id', 'purpose',
        'operations', 'consent_receipt_id', 'expires_at', 'hosted_grant_id', 'renewal_grant_id'];
      approvals.push(Object.fromEntries(keys.map((key, index) => [key, values[index]]))); return [];
    }
    if (query.startsWith('SELECT swarm.set_local_workspace_approval(')) { familySelections.push(values); return []; }
    if (query.startsWith('INSERT INTO swarm.audit_log')) return [];
    if (query.startsWith('SELECT set_config')
      || query.startsWith('INSERT INTO swarm.idempotency_keys') || query.startsWith('UPDATE swarm.household_content_connections')) return [];
    throw new Error(`unexpected database boundary: ${query}`);
  };
  const tx = (sql: TemplateStringsArray, ...values: unknown[]) => {
    const rows = read(sql.join('?').trim().replace(/\s+/g, ' '), values);
    return Object.assign(Promise.resolve(rows), { cursor: async function* () { yield rows; } });
  };
  return Object.assign(tx, { json: (value: unknown) => value, approvals, familySelections, consent,
    savepoint: async (callback: (sp: typeof tx) => Promise<unknown>) => callback(tx) });
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


test('local approval binds the checked renewal family without a technical expiry and refuses unavailable tokens', async () => {
  const expires = '2100-01-01T00:00:00.000Z';
  const input = { kind: 'household_approve_connection', connection: { ...connection, kind: 'local' } };
  const tx = facts('editor', expires);
  assert.deepEqual(await approve(tx, workspace, identity, randomUUID(), input, yes),
    { status: 'committed', operations: ['read'], expires_at: null });
  // The bearer still needs to be live at Allow. Its rotation deadline must not
  // become an approval deadline; the canonical family carries the policy.
  assert.deepEqual(tx.approvals, [{ connection_id: connection.connection_id, grant_id: connection.grant_id,
    workspace_id: workspace, principal_id: principal, owner_user_id: owner, purpose: 'shared',
    operations: ['read'], consent_receipt_id: tx.consent, expires_at: null, hosted_grant_id: null, renewal_grant_id: family }]);
  assert.deepEqual(tx.familySelections, [[family, workspace, connection.connection_id]]);
  for (const unavailable of [facts(), facts('editor', now), facts('editor', expires, { revoked_at: now })]) {
    assert.deepEqual(await approve(unavailable, workspace, identity, randomUUID(), input, yes),
      { status: 'refused', reason: 'connection_access_refused' });
    assert.deepEqual(unavailable.approvals, []);
    assert.deepEqual(unavailable.familySelections, []);
  }
});
