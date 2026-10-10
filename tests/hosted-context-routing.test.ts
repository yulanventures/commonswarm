/** Preparation boundary: real MCP validation, claim dispatch, capability and output adapter.
 * Lifecycle dispatch awaits phase 3; these fixtures do not supply a shipped adapter. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error TS5097: Deno source through tsx.
import { executeClaimSeat } from '../supabase/functions/mcp/claim-seat.ts';
// @ts-expect-error TS5097: Deno source through tsx.
import { createMcpProtocolHandler } from '../supabase/functions/mcp/protocol.ts';
// @ts-expect-error TS5097: Deno source through tsx.
import { commandOutput } from '../supabase/functions/mcp/tool-errors.ts';
// @ts-expect-error TS5097: Deno source through tsx.
import { revalidateHostedGrantCommand } from '../supabase/functions/_shared/hosted-seat-auth.ts';

const owner = '11111111-1111-4111-8111-111111111111';
const workspace = '22222222-2222-4222-8222-222222222222';
const grant = '33333333-3333-4333-8333-333333333333';
const context = '44444444-4444-4444-8444-444444444444';
const handle = 'seat_ABCDEFGHIJKLMNOPQRSTUV';
const identity = {
  grant_id: grant, workspace_id: workspace, workspace: { id: workspace, name: 'Synthetic workspace' },
  seat_id: '55555555-5555-4555-8555-555555555555', principal_id: '66666666-6666-4666-8666-666666666666',
  context_id: context, seat: handle, handle, name: 'Marketing', display_name: 'Marketing', disambiguator: null,
  assurance: 'portable', lifetime: 'durable', kind: 'subagent', created_at: '2026-10-10T12:00:00Z',
  last_business_at: '2026-10-10T12:00:00Z', idle_expires_at: '2026-10-10T12:15:00Z',
  absolute_expires_at: '2026-10-10T16:00:00Z', outcome: 'created', original_outcome: 'created',
  name_adjusted: false, adjustment_reason: null,
};
function fixture() {
  type Dependencies = Parameters<typeof executeClaimSeat>[1];
  type Sql = Parameters<Parameters<Dependencies['withAuthTransaction']>[0]>[0];
  const commands: Record<string, unknown>[] = [];
  let providerActive = true;
  let home: string | null = workspace;
  let homeUsable = true;
  const contextWorkspace = '88888888-8888-4888-8888-888888888888';
  let response = { status: 200, body: { ...identity, status: 'committed', ok: true } as Record<string, unknown> };
  const tx = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join('?');
    if (query.includes('swarm.resolve_hosted_discovery')) {
      return [{ data: { provider_grant_id: 'synthetic-provider' } }];
    }
    if (query.includes('FROM swarm.hosted_agent_contexts')) {
      return values[0] === handle && values[1] === grant && values[2] === owner
        ? [{ workspace_id: contextWorkspace }] : [];
    }
    if (strings.join('?').includes('FROM swarm.hosted_mcp_grants')) {
      return values[0] === 'synthetic-provider' && values[1] === owner
        ? [{ grant_id: grant, owner_user_id: owner, home_workspace_id: home }] : [];
    }
    return values[0] === grant && values[1] === owner &&
      (values[2] === contextWorkspace || (values[2] === workspace && homeUsable)) ? [{
      grant_id: grant, owner_user_id: owner, provider_grant_id: 'synthetic-provider', workspace_id: values[2],
      stream_id: '77777777-7777-4777-8777-777777777777', manifest_digest: 'a'.repeat(64),
    }] : [];
  }) as unknown as Sql;
  const serve = createMcpProtocolHandler({
    issuer: 'https://auth.commonswarm.com', resource: 'https://mcp.commonswarm.com/mcp', publicEnabled: true,
    allowedOrigins: new Set(), limits: { maxBodyBytes: 4096, maxResponseBytes: 65536, requestTimeoutMs: 2000, maxConcurrentRequests: 2 },
    verifyToken: async () => ({ subject: owner, providerGrantId: 'synthetic-provider', expiresAt: 1900000000 }),
    executeTool: async call => commandOutput(await executeClaimSeat(call, {
      withAuthTransaction: async run => run(tx), providerStatus: async () => ({ active: providerActive }),
      handleCommand: async (input, capability) => {
        assert.ok(await revalidateHostedGrantCommand(tx, capability), 'real command capability is current');
        commands.push(input as Record<string, unknown>); return response;
      },
    })),
  });
  return { commands, contextWorkspace, home: (value: string | null, usable = true) => { home = value; homeUsable = usable; },
    revoke: () => { providerActive = false; }, respond: (value: typeof response) => { response = value; },
    call: async (args: Record<string, unknown>) => {
      const reply = await serve(new Request('https://mcp.commonswarm.com/mcp', { method: 'POST',
        headers: { authorization: 'Bearer synthetic.jwt.value', 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'claim_seat', arguments: args } }),
      }));
      return { status: reply.status, rpc: await reply.json() };
    },
  };
}

test('claim dispatch forwards context fields, translates kind and preserves the full identity', async () => {
  const f = fixture();
  const args = { request_id: 'claim_route_123', name: 'Marketing', lifetime: 'durable', kind: 'subagent', parent_context: context };
  const positive = await f.call(args);
  assert.equal(positive.status, 200); assert.equal(positive.rpc.result.isError, false);
  assert.deepEqual(JSON.parse(positive.rpc.result.content[0].text), identity);
  assert.deepEqual(f.commands[0], { command_id: args.request_id, client_version: '0.1.80', workspace_id: workspace,
    stream: { kind: 'workspace' }, command: { kind: 'claim_hosted_seat', intent: 'new', name: 'Marketing', lifetime: 'durable', context_kind: 'subagent', parent_context: context } });
  const malformed = await f.call({ ...args, seat: handle });
  assert.equal(malformed.status, 400); assert.equal(malformed.rpc.error.code, -32602);
  assert.equal(f.commands.length, 1, 'malformed new cannot reach the command path');
  f.revoke();
  const denied = await f.call(args);
  assert.equal(denied.rpc.result.isError, true);
  assert.equal(JSON.parse(denied.rpc.result.content[0].text).can_start_new, false);
  assert.equal(f.commands.length, 1, 'revoked authorization cannot dispatch');
});

test('explicit continue is forwarded without lifetime promotion or an invented new allocation', async () => {
  const f = fixture();
  await f.call({ request_id: 'continue_route_1', intent: 'continue', name: 'Marketing', kind: 'task' });
  assert.deepEqual(f.commands[0].command, { kind: 'claim_hosted_seat', intent: 'continue', name: 'Marketing', context_kind: 'task' });
  await f.call({ request_id: 'continue_route_2', intent: 'continue', seat: handle, name: 'Marketing', workspace_id: f.contextWorkspace });
  assert.deepEqual(f.commands[1].command, { kind: 'claim_hosted_seat', intent: 'continue', seat: handle, name: 'Marketing' });
  const refused = await f.call({ request_id: 'continue_route_3', intent: 'continue', seat: handle, lifetime: 'durable' });
  assert.equal(refused.status, 400); assert.equal(f.commands.length, 2);
});

test('handle continuation uses its context workspace, refuses mismatch and never falls back to home', async () => {
  const f = fixture();
  f.home(null);
  const args = { request_id: 'handle_workspace_1', intent: 'continue', seat: handle };
  assert.equal((await f.call(args)).rpc.result.isError, false);
  assert.equal(f.commands[0].workspace_id, f.contextWorkspace);
  const mismatch = (await f.call({ ...args, workspace_id: workspace })).rpc.result;
  assert.equal(mismatch.isError, true);
  assert.equal(JSON.parse(mismatch.content[0].text).error, 'workspace_mismatch');
  const unknown = (await f.call({ ...args, seat: 'seat_ZZZZZZZZZZZZZZZZZZZZZZ' })).rpc.result;
  assert.equal(unknown.isError, true);
  assert.equal(JSON.parse(unknown.content[0].text).error, 'identity_resume_unavailable');
  assert.equal(f.commands.length, 1);
  f.revoke();
  const denied = (await f.call({ ...args, workspace_id: workspace })).rpc.result;
  assert.equal(JSON.parse(denied.content[0].text).can_start_new, false);
  assert.equal(f.commands.length, 1, 'invalid grant cannot disclose a workspace mismatch');
});

test('missing or unusable home refuses allocation while explicit authorized workspace remains available', async () => {
  for (const home of [null, workspace]) {
    const f = fixture();
    f.home(home, false);
    const refused = (await f.call({ request_id: 'no_home_context_1' })).rpc.result;
    assert.equal(refused.isError, true);
    assert.equal(JSON.parse(refused.content[0].text).error, 'workspace_unavailable');
    assert.equal(f.commands.length, 0);
    const positive = (await f.call({ request_id: 'explicit_workspace_1', workspace_id: f.contextWorkspace })).rpc.result;
    assert.equal(positive.isError, false);
    assert.equal(f.commands[0].workspace_id, f.contextWorkspace);
    f.revoke();
    const denied = (await f.call({ request_id: 'no_home_revoked_1' })).rpc.result;
    assert.equal(JSON.parse(denied.content[0].text).error, 'hosted_grant_forbidden');
    assert.equal(JSON.parse(denied.content[0].text).can_start_new, false);
    assert.equal(f.commands.length, 1);
  }
});

test('allocation capacity and expiry failures keep recovery metadata and never retry under a new identity', async () => {
  const f = fixture();
  assert.equal((await f.call({ request_id: 'failure_control_1' })).rpc.result.isError, false);
  for (const body of [
    { error: 'session_capacity_reached', can_start_new: false, retry_after_seconds: 30 },
    { error: 'context_expired', can_start_new: true },
  ]) {
    f.respond({ status: 403, body });
    const before = f.commands.length;
    const result = (await f.call({ request_id: 'failure_request_1' })).rpc.result;
    assert.equal(result.isError, true);
    const output = JSON.parse(result.content[0].text);
    assert.equal(output.error, body.error); assert.equal(output.can_start_new, body.can_start_new);
    if (body.retry_after_seconds) assert.equal(output.retry_after_seconds, 30);
    else assert.equal(output.message, 'This chat identity expired. Start a new identity to continue; shared work is still here.');
    assert.equal(f.commands.length, before + 1, 'exactly one dispatch per call');
  }
});
