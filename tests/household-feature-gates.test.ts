import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { build } from 'esbuild';
import { hostedHouseholdRelease } from './support/hosted-household-release.js';
import { HOUSEHOLD_TOOL_REGISTRY } from '../src/protocol/household-tool-registry.js';

const owner = '11111111-1111-4111-8111-111111111111';
const workspace = '22222222-2222-4222-8222-222222222222';
const stream = '33333333-3333-4333-8333-333333333333';
const file = '44444444-4444-4444-8444-444444444444';
const fileCommand = { kind: 'file_download_url', file_id: file };
const legacyCommand = { kind: 'household_legacy', command: fileCommand };
const redirectGate = 'SWARM_HOUSEHOLD_LEGACY_FILE_REDIRECT';
const legacyGate = 'SWARM_HOUSEHOLD_LEGACY_COMMAND';
const transportGate = 'SWARM_HOUSEHOLD_HOSTED_FILE_TRANSPORT';

/** Exercise the real HTTP dispatch with inert auth/database transports and an
 * adapter-entry spy. This proves reachability, not legacy/storage parity. */
async function commandEntry(flags: Record<string, string | undefined> = {}, boundary = true) {
  const bundled = await build({
    entryPoints: ['supabase/functions/command/index.ts'], bundle: true, write: false,
    platform: 'node', format: 'esm', target: 'es2022', logLevel: 'silent',
    banner: { js: `
      const legacyCalls = [], queries = [];
      const settings = { SWARM_ENV: 'test', SWARM_DATABASE_URL: 'postgres://127.0.0.1:1/unused',
        SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_ANON_KEY: 'inert-test-value',
        SUPABASE_SERVICE_ROLE_KEY: 'inert-test-value', ...${JSON.stringify(flags)} };
      const Deno = { env: { get: name => settings[name] }, serve: () => { throw new Error('unexpected server'); } };
      const priorDeno = Object.getOwnPropertyDescriptor(globalThis, 'Deno');
      Object.defineProperty(globalThis, 'Deno', { value: Deno, configurable: true });` },
    footer: { js: `
      if (priorDeno) Object.defineProperty(globalThis, 'Deno', priorDeno); else Reflect.deleteProperty(globalThis, 'Deno');
      export { legacyCalls, queries }; // ${randomUUID()}` },
    plugins: [{ name: 'inert-household-boundaries', setup(builder) {
      builder.onResolve({ filter: /^npm:/ }, args => ({ path: args.path, namespace: 'inert-edge' }));
      builder.onLoad({ filter: /.*/, namespace: 'inert-edge' }, args => {
        if (args.path === 'npm:postgres@3.4.9') return { contents: `
          export default function postgres() {
            const sql = async (strings, ...values) => {
              const query = strings.join('?'); queries.push(query);
              if (query.includes('INSERT INTO swarm.users')) return [{ user_id: '${owner}', email: null }];
              if (query.includes('SELECT m.role, m.revoked_at')) return [{ role: 'owner', revoked_at: null }];
              if (query.includes('SELECT stream_id') && query.includes('FROM swarm.streams')) return [{ stream_id: '${stream}' }];
              if (query.includes('FROM swarm.config')) return [{ value: '0.1.0' }];
              if (query.includes('FROM swarm.household_workspace_boundaries')) return ${boundary ? "[{ purpose: 'shared' }]" : '[]'};
              return [];
            };
            sql.begin = async (...args) => args.at(-1)(sql);
            sql.json = value => value;
            return sql;
          }`, loader: 'js' };
        if (args.path === 'npm:@supabase/supabase-js@2.110.8') return { contents: `
          export function createClient() { return { auth: {
            async getUser() { return { data: { user: { id: '${owner}' } }, error: null }; },
            async getClaims() { return { data: { claims: {} }, error: null }; }
          } }; }`, loader: 'js' };
        throw new Error('unexpected edge dependency');
      });
      builder.onLoad({ filter: /\/household-legacy-integration\.ts$/ }, () => ({
        contents: `export async function executeHouseholdLegacy(_tx, request) {
          legacyCalls.push(request); return { status: 'adapter_reached' };
        }`, loader: 'js',
      }));
    } }],
  });
  return await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0]!.text).toString('base64')}`) as {
    handleRequest(request: Request): Promise<Response>;
    legacyCalls: unknown[];
    queries: string[];
  };
}

async function callCommand(entry: Awaited<ReturnType<typeof commandEntry>>, command: object, extra: object = {}) {
  const response = await entry.handleRequest(new Request('https://example.test/functions/v1/command', {
    method: 'POST', headers: { authorization: 'Bearer synthetic-human', 'content-type': 'application/json' },
    body: JSON.stringify({ command_id: 'gate-test-request', client_version: '0.1.80',
      workspace_id: workspace, stream: { kind: 'workspace' }, command, ...extra }),
  }));
  return { status: response.status, body: await response.json() };
}

test('a boundary cannot enable the legacy file redirect; only its exact server opt-in can', async () => {
  for (const flags of [{}, { [redirectGate]: '0' }, { [redirectGate]: 'true' }, { [legacyGate]: '1' }]) {
    const entry = await commandEntry(flags);
    const result = await callCommand(entry, { ...fileCommand, [redirectGate]: '1' });
    assert.equal(result.status, 400, 'client gate input is not an accepted file field');
    const ordinary = await callCommand(entry, fileCommand, { [redirectGate]: '1' });
    assert.equal(ordinary.status, 404, 'valid files retain the ordinary file route');
    assert.equal(entry.legacyCalls.length, 0, 'boundary and client flags never call the adapter');
    assert.ok(entry.queries.some(query => query.includes('FROM swarm.files')), 'negative probe reaches the file handler');
  }
  const enabled = await commandEntry({ [redirectGate]: '1' });
  assert.deepEqual(await callCommand(enabled, fileCommand), { status: 200, body: { status: 'adapter_reached' } });
  assert.equal(enabled.legacyCalls.length, 1);
  const unmanaged = await commandEntry({ [redirectGate]: '1' }, false);
  assert.equal((await callCommand(unmanaged, fileCommand)).status, 404);
  assert.equal(unmanaged.legacyCalls.length, 0, 'opt-in still requires a household boundary');
});

test('household_legacy is unreachable with its gate off even in a managed workspace', async () => {
  for (const flags of [{}, { [legacyGate]: '0' }, { [legacyGate]: 'true' }, { [redirectGate]: '1' }]) {
    const entry = await commandEntry(flags);
    assert.deepEqual(await callCommand(entry, legacyCommand, { [legacyGate]: '1' }),
      { status: 403, body: { error: 'household_legacy_disabled' } });
    assert.equal(entry.legacyCalls.length, 0);
  }
  const enabled = await commandEntry({ [legacyGate]: '1' });
  assert.deepEqual(await callCommand(enabled, legacyCommand), { status: 200, body: { status: 'adapter_reached' } });
  assert.equal(enabled.legacyCalls.length, 1);
  const unmanaged = await commandEntry({ [legacyGate]: '1' }, false);
  assert.deepEqual(await callCommand(unmanaged, legacyCommand),
    { status: 200, body: { status: 'refused', reason: 'workspace_not_managed' } });
  assert.equal(unmanaged.legacyCalls.length, 0);
});

async function hostedProtocol(flags: Record<string, string | undefined> = {}, enabled = false) {
  const entry = await hostedHouseholdRelease(enabled, flags);
  const calls: string[] = [];
  const serve = entry.createMcpProtocolHandler({
    issuer: 'https://mcp.example.test', resource: 'https://mcp.example.test/mcp', publicEnabled: true,
    allowedOrigins: new Set(),
    limits: { maxBodyBytes: 4096, maxResponseBytes: 65536, requestTimeoutMs: 2000, maxConcurrentRequests: 2 },
    verifyToken: async () => ({ providerGrantId: 'synthetic-grant', subject: owner, expiresAt: 1_900_000_000 }),
    executeTool: async ({ name }: { name: string }) => { calls.push(name); return { reached: name }; },
  });
  const rpc = async (method: string, params?: object, expectedStatus = 200) => {
    const response = await serve(new Request('https://mcp.example.test/mcp', {
      method: 'POST', headers: { authorization: 'Bearer synthetic-token', 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }));
    assert.equal(response.status, expectedStatus);
    return await response.json();
  };
  return { rpc, calls };
}

test('the source release switch hides all household tools even with every runtime gate on; enabling it restores 24 tools', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const core = ['claim_seat', 'whoami', 'close_session', 'check', 'ask', 'note', 'reply', 'working_on', 'members'];
  const { rpc, calls } = await hostedProtocol({ [transportGate]: '1', [legacyGate]: '1', [redirectGate]: '1' });
  assert.deepEqual((await rpc('tools/list')).result.tools.map((tool: { name: string }) => tool.name), core);
  const unknown = await rpc('tools/call', { name: 'unknown_tool', arguments: {} }, 400);
  for (const { name } of HOUSEHOLD_TOOL_REGISTRY) {
    assert.deepEqual(await rpc('tools/call', { name, arguments: {} }, 400), unknown, name);
  }
  assert.deepEqual(calls, [], 'runtime gates cannot admit household reads or handlers');
  assert.ok((await rpc('tools/call', { name: 'whoami', arguments: { seat: 'seat_' + 'a'.repeat(22) } })).result);
  assert.deepEqual(calls, ['whoami']);

  const enabled = await hostedProtocol({}, true);
  const restored = (await enabled.rpc('tools/list')).result.tools.map((tool: { name: string }) => tool.name);
  assert.equal(restored.length, 24);
  assert.deepEqual(restored, [...core,
    'object_list', 'object_read', 'object_history', 'object_create', 'object_update',
    'todo_list', 'todo_read', 'todo_queue', 'comment_list', 'todo_create', 'todo_comment',
    'todo_update', 'todo_assign', 'todo_start', 'todo_set_state',
  ]);
  assert.ok((await enabled.rpc('tools/call', { name: 'object_list', arguments: { seat: 'seat_' + 'a'.repeat(22), offset: 0, limit: 10 } })).result);
  assert.deepEqual(enabled.calls, ['object_list'], 'enabled control restores admission as well as discovery');
});

test('future household release keeps file tools hidden until their transport gate is explicitly on', async () => {
  const seat = 'seat_' + 'a'.repeat(22);
  const examples = {
    file_read: { seat, object_id: 'attachment' },
    file_upload_begin: { seat, request_id: 'request_001', object_id: 'attachment', change: {
      kind: 'create', title: 'Attachment', content: { kind: 'file', name: 'synthetic.txt', media_type: 'text/plain' },
    } },
    file_upload_commit: { seat, request_id: 'request_001', reservation_id: 'upload_001', operation: 'create' },
  };
  for (const flags of [{}, { [transportGate]: '0' }, { [transportGate]: 'true' }, { [legacyGate]: '1', [redirectGate]: '1' }]) {
    const { rpc, calls } = await hostedProtocol(flags, true);
    const listed = (await rpc('tools/list')).result.tools.map((tool: { name: string }) => tool.name);
    for (const [name, args] of Object.entries(examples)) {
      assert.ok(!listed.includes(name), `${name} must not be advertised`);
      const result = await rpc('tools/call', { name, arguments: args }, 400);
      assert.equal(result.error.code, -32602, `${name} must fail admission`);
    }
    assert.deepEqual(calls, []);
    const control = await rpc('tools/call', { name: 'object_list', arguments: { seat, offset: 0, limit: 10 } });
    assert.ok(control.result);
    assert.deepEqual(calls, ['object_list'], 'same handler still admits completed tools');
  }
  const { rpc, calls } = await hostedProtocol({ [transportGate]: '1' }, true);
  const listed = (await rpc('tools/list')).result.tools.map((tool: { name: string }) => tool.name);
  for (const [name, args] of Object.entries(examples)) {
    assert.ok(listed.includes(name));
    assert.ok((await rpc('tools/call', { name, arguments: args })).result);
  }
  assert.deepEqual(calls, Object.keys(examples), 'only an explicit server opt-in reaches the executor');
});
