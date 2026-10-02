import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import * as core from '../../src/protocol/index.js';
import * as bundle from '../../supabase/functions/_shared/protocol.js';
import { adminCoreFixture } from '../support/admin-fixture.js';
import type { AdminActor, AdminClientApproval } from '../../src/protocol/admin-authority.js';
import { approvalCatalog, approvalDiagnostic, approvalFailureDetail } from '../support/admin-db-diagnostic.js';

const command = { kind: 'approve_admin_client' as const, client_id: 'https://client.example/metadata', verification_version: 1 };

test('admin-owner-approval-scoped: DB failure diagnostics retain the step and catalog metadata but withhold row data and credentials', () => {
  const catalog = approvalCatalog('CREATE TABLE commonswarm_oauth.admin_verified_clients (client_id text);\nCREATE UNIQUE INDEX admin_client_active_version ON commonswarm_oauth.admin_verified_clients (client_id);');
  const detail = (stdout: string) => approvalFailureDetail(stdout, catalog);
  const diagnostic = (step: Parameters<typeof approvalDiagnostic>[0], error: unknown) => approvalDiagnostic(step, error, catalog);
  const raw = { code: '23505', constraint_name: 'admin_client_active_version', table_name: 'admin_verified_clients',
    message: 'duplicate row containing private values', detail: 'private row data', query: 'private SQL',
    parameters: ['swm_agt_private'], connection: 'postgresql://user:password@host/db' };
  assert.deepEqual(JSON.parse(detail(diagnostic('fixture-prepare', raw))), {
    step: 'fixture-prepare', sqlstate: '23505', constraint: 'admin_client_active_version', table: 'admin_verified_clients',
  });
  const wrapped = new assert.AssertionError({ message: 'private assertion detail', actual: raw });
  assert.deepEqual(JSON.parse(detail(diagnostic('withdrawal-rollback', wrapped))), {
    step: 'withdrawal-rollback', sqlstate: '23505', constraint: 'admin_client_active_version', table: 'admin_verified_clients',
  });
  for (const value of ['swm_agt_private', 'postgresql://user:password@host/db', 'private_value', 'admin_verified_clients\nprivate']) {
    assert.deepEqual(JSON.parse(detail(diagnostic('owner-approval', {
      ...raw, code: value, constraint_name: value, table_name: value,
    }))), { step: 'owner-approval', sqlstate: null, constraint: null, table: null });
  }
  const partial = 'ADMIN_OWNER_APPROVAL_DIAGNOSTIC {"step":"private value"}\nraw private error';
  assert.equal(detail(partial), 'step=initialize; safe diagnostic unavailable');
  assert.equal(detail('ADMIN_OWNER_APPROVAL_DIAGNOSTIC null'), 'step=initialize; safe diagnostic unavailable');
  assert.equal(detail('ADMIN_OWNER_APPROVAL_DIAGNOSTIC {'), 'step=initialize; safe diagnostic unavailable');
  assert.deepEqual(JSON.parse(detail(diagnostic('withdrawal-rollback', new Error('private failure')))), {
    step: 'withdrawal-rollback', sqlstate: null, constraint: null, table: null,
  });
});

test('admin-owner-approval-scoped: public account commands refuse agent tokens before human authentication or database access', () => {
  // Nonsecret placeholders satisfy import-time configuration only. No service,
  // database credentials, network permission or HOME override is required.
  const script = `
import assert from 'node:assert/strict';
Deno.env.set('SWARM_ENV','test');
Deno.env.set('SWARM_DATABASE_URL','postgresql://localhost:1/test');
Deno.env.set('SUPABASE_URL','http://127.0.0.1:1');
Deno.env.set('SUPABASE_ANON_KEY','nonsecret-test-placeholder');
Deno.env.set('SWARM_COMMAND_ALLOWED_ORIGINS','https://commonswarm.com');
globalThis.fetch = async () => { throw new Error('unexpected human authentication'); };
const { handleRequest, db } = await import(${JSON.stringify(new URL('../../supabase/functions/command/index.ts', import.meta.url).href)});
try {
 for (const command of ${JSON.stringify([command, { ...command, kind: 'withdraw_admin_client_approval', reason_code: 'owner_withdrew' }])}) {
  const body = {command_id:crypto.randomUUID(),stream:{kind:'account'},resource:'https://api.commonswarm.com/admin',command};
  const request = token => new Request('http://127.0.0.1/command',{method:'POST',headers:{
   Authorization:'Bearer '+token,'Content-Type':'application/json',Origin:'https://commonswarm.com'},body:JSON.stringify(body)});
  assert.equal((await handleRequest(request('swm_agt_bad'))).status,401);
  const refusal = await handleRequest(request('swm_agt_'+'a'.repeat(43)));
  assert.equal(refusal.status,403);
  assert.deepEqual(await refusal.json(),{error:'credential_kind_forbidden'});
 }
} finally { await db.end(); }
console.log('ADMIN_APPROVAL_AGENT_BOUNDARY_OK');
`;
  const run = spawnSync('deno', ['run', '--no-lock', '--config', 'supabase/functions/command/deno.json', '--allow-env', '-'],
    { input: script, encoding: 'utf8', timeout: 30000 });
  assert.equal(run.status, 0, 'service-free agent boundary harness failed');
  assert.match(run.stdout, /ADMIN_APPROVAL_AGENT_BOUNDARY_OK/u);
});

test('admin-owner-approval-scoped: strict wire rejects owner/facts injection, malformed versions and oversized clients', () => {
  for (const api of [core, bundle]) {
    assert.deepEqual(api.parseAdminClientApprovalCommand(command), command);
    const withdrawal = { ...command, kind: 'withdraw_admin_client_approval', reason_code: 'owner_withdrew' };
    assert.deepEqual(api.parseAdminClientApprovalCommand(withdrawal), withdrawal);
    for (const invalid of [
      { ...command, owner_user_id: randomUUID() }, { ...command, active: true },
      ...[0, -1, 1.5, '1', 2147483648].map(verification_version => ({ ...command, verification_version })),
      { ...command, client_id: '' }, { ...command, client_id: 'é'.repeat(1025) },
      { ...withdrawal, reason_code: 'not a reason' },
    ]) assert.equal(api.parseAdminClientApprovalCommand(invalid), null);
  }
});

test('admin-owner-approval-scoped: only the human account owner writes approval; exact active verification is required', () => {
  const f = adminCoreFixture();
  const policy = { client_id: command.client_id, verification_version: 1, verification_active: true,
    approval: null, linked_grant_ids: [] };
  const actors: AdminActor[] = [
    { kind: 'worker' }, { kind: 'hosted_seat' }, { kind: 'system' },
    { kind: 'human', user_id: randomUUID(), session_binding: f.session },
    { kind: 'credential_runtime', connection_id: f.manifest.connection_id, client_id: command.client_id, resource: core.ADMIN_RESOURCE },
    { kind: 'delegated_admin', admin_identity_id: f.manifest.admin_identity_id, grant_id: f.grantId,
      connection_id: f.manifest.connection_id, scope_names: ['admin:read'], resource: core.ADMIN_RESOURCE, access_expires_at: f.now + 300000 },
  ];
  for (const api of [core, bundle]) {
    for (const actor of actors) for (const input of [command, { ...command, kind: 'withdraw_admin_client_approval' as const, reason_code: 'owner_withdrew' }]) {
      const denied = api.decideAdminAuthority(input, f.state(), { ...f.ctx, actor, client_policy: policy, withdrawing_workspace_owner: true });
      assert.equal(denied.ok, false, actor.kind);
      assert.deepEqual(denied.events.map(e => e.type), ['AdminActionRecorded']);
      assert.equal(denied.events[0]!.payload.outcome, 'refused');
    }
    for (const client_policy of [undefined, { ...policy, verification_active: false }, { ...policy, verification_version: 2 }, { ...policy, client_id: 'other' }]) {
      assert.equal(api.decideAdminAuthority(command, f.state(), { ...f.ctx, client_policy }).ok, false);
    }
    const accepted = api.decideAdminAuthority(command, f.state(), { ...f.ctx, client_policy: policy });
    assert.equal(accepted.ok, true);
    assert.deepEqual(accepted.events.map(e => e.type), ['AdminClientApproved', 'AdminActionRecorded']);
    const state = accepted.events.reduce(api.reduceAdminAuthority, f.state());
    const approval = Object.values(state.client_approvals!)[0]!;
    assert.equal(approval.owner_user_id, f.owner);
    assert.equal(approval.approval_event_id, accepted.events[0]!.event_id);
    assert.equal(approval.approval_command_id, f.ctx.command_id);
    assert.equal(api.decideAdminAuthority(command, state, { ...f.ctx, client_policy: { ...policy, approval } }).events.length, 1);
    const bob: AdminClientApproval = { ...approval, owner_user_id: randomUUID() };
    assert.equal(api.decideAdminAuthority(command, state, { ...f.ctx, client_policy: { ...policy, approval: bob } }).ok, false);
    assert.equal(api.decideAdminAuthority(command, state, { ...f.ctx, client_policy: { ...policy, approval: { ...approval, verification_version: 2 } } }).ok, false);
  }
});

test('admin-owner-approval-scoped: withdrawal revokes only exact linked grants, lineages and pending connections; withdrawn approvals cannot resurrect', () => {
  const f = adminCoreFixture();
  assert.equal(f.run({ kind: 'grant_admin_delegation', grant_id: f.grantId, consent_receipt_id: f.receipt, replaces_grant_id: null }).ok, true);
  const cmd = { ...command, client_id: f.manifest.client_id };
  const policy = { client_id: cmd.client_id, verification_version: 1, verification_active: true, approval: null, linked_grant_ids: [f.grantId] };
  const approved = core.decideAdminAuthority(cmd, f.state(), { ...f.ctx, client_policy: policy });
  let state = approved.events.reduce(core.reduceAdminAuthority, f.state());
  const approval = Object.values(state.client_approvals!)[0]!;
  const other = randomUUID(), lineage = randomUUID(), attempt = randomUUID();
  state = { ...state, grants: { ...state.grants, [other]: { ...state.grants[f.grantId]!, grant_id: other } },
    lineages: { [lineage]: { credential_lineage_id: lineage, grant_id: f.grantId, generation: 0, scope_names: ['admin:read'],
      access_expires_at: f.now + 300000, refresh_deadline: f.manifest.refresh_deadline, state: 'active', delivery_state: 'awaiting_delivery' } },
    connections: { [attempt]: { attempt_id: attempt, parent_admin_grant_id: f.grantId, workspace_id: randomUUID(),
      intended_owner_user_id: f.owner, intended_agent_id: randomUUID(), recipient_connection_id: f.manifest.connection_id,
      requested_name: 'Pending', transport: 'local', ttl_seconds: 3600, capability_set: [], state: 'awaiting_authorization',
      created_at: f.now, expires_at: f.now + 3600000, cancelled_at: null, reason_code: null } } };
  const withdrawal = { ...cmd, kind: 'withdraw_admin_client_approval' as const, reason_code: 'owner_withdrew' };
  for (const api of [core, bundle]) {
    const ctx = { ...f.ctx, client_policy: { ...policy, verification_active: false, approval } };
    const decision = api.decideAdminAuthority(withdrawal, state, ctx);
    assert.equal(decision.ok, true, 'recovery survives verification withdrawal');
    const next = decision.events.reduce(api.reduceAdminAuthority, state);
    assert.equal(next.grants[f.grantId]!.state, 'revoked');
    assert.equal(next.grants[other]!.state, 'active');
    assert.equal(next.lineages[lineage]!.state, 'revoked');
    assert.equal(next.connections![attempt]!.state, 'cancelled');
    const withdrawn = Object.values(next.client_approvals!)[0]!;
    assert.equal(withdrawn.withdrawal_event_id, decision.events[0]!.event_id);
    const retryCtx = { ...ctx, client_policy: { ...ctx.client_policy, verification_active: true, approval: withdrawn } };
    assert.equal(api.decideAdminAuthority(withdrawal, next, retryCtx).events.length, 1);
    assert.equal(api.decideAdminAuthority(cmd, next, retryCtx).reason, 'client_approval_withdrawn');
  }
});
