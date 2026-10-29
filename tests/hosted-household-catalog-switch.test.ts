/** Server settings admit enabled tools and refuse disabled or unknown calls before execution. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hostedHouseholdRelease } from './support/hosted-household-release.js';
import { HOSTED_TODO_LIST_TOOLS, HOUSEHOLD_TOOL_REGISTRY } from '../src/protocol/household-tool-registry.js';
test('server to-do/list switch preserves OFF bytes and admits only the registry ON catalog', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  for (const flag of [undefined, '0', 'invalid', '1']) {
    const entry = await hostedHouseholdRelease(false, { SWARM_MCP_TODOS_LISTS_ENABLED: flag, SWARM_HOUSEHOLD_HOSTED_FILE_TRANSPORT: '1' });
    const calls: string[] = [], seat = 'seat_ABCDEFGHIJKLMNOPQRSTUV';
    const serve = entry.createMcpProtocolHandler({
      issuer: 'https://mcp.example.test', resource: 'https://mcp.example.test/mcp', publicEnabled: true, allowedOrigins: new Set(),
      limits: { maxBodyBytes: 4096, maxResponseBytes: 65536, requestTimeoutMs: 2000, maxConcurrentRequests: 2 },
      verifyToken: async () => ({ providerGrantId: 'synthetic-grant', subject: '11111111-1111-4111-8111-111111111111', expiresAt: 1900000000 }),
      executeTool: async ({ name }) => { calls.push(name); return { reached: name }; },
    });
    const rpc = async (method: string, params: object = {}, status = 200) => {
      const response = await serve(new Request('https://mcp.example.test/mcp', { method: 'POST', headers: { authorization: 'Bearer synthetic-token', 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'catalog-switch', method, params }) }));
      assert.equal(response.status, status); return await response.text();
    };
    if (flag === '1') {
      for (const { name } of HOSTED_TODO_LIST_TOOLS) assert.equal(JSON.parse(await rpc('tools/call', { name, arguments: {} }, 400)).error.message, 'invalid_arguments', name);
      for (const [name, args] of [['todo_list', { scope: 'open' }], ['list_list', { offset: 0, limit: 1 }]] as const) await rpc('tools/call', { name, arguments: { seat, ...args } });
    }
    await rpc('tools/call', { name: 'whoami', arguments: { seat } });
    const refusal = await rpc('tools/call', { name: 'unknown_tool', arguments: {} }, 400);
    for (const { name } of HOUSEHOLD_TOOL_REGISTRY.filter(row => flag !== '1' || !HOSTED_TODO_LIST_TOOLS.some(tool => tool.name === row.name))) assert.equal(await rpc('tools/call', { name, arguments: {} }, 400), refusal, name);
    assert.deepEqual(calls, flag === '1' ? ['todo_list', 'list_list', 'whoami'] : ['whoami']);
  }
});
