import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { HouseholdObjectClient } from '../../src/cloud/household-objects.js';
import { createHouseholdHttpTransport, LOCAL_HOUSEHOLD_SEAT } from '../../src/cloud/household-http.js';
import { CLI_BUILD_VERSION } from '../../src/cloud/client-build.js';
import { CLIENT_PROTOCOL_VERSION } from '../../src/cloud/config.js';
import { HOUSEHOLD_TOOLS } from '../../src/protocol/household-tool-registry.js';
import { createHouseholdMcpTools } from '../../src/mcp/household-tools.js';

test('approval refusals tell local MCP and CLI callers where to allow the agent; other refusals keep their guidance', async () => {
  const allow = 'Ask this agent\'s owner to allow it in CommonSwarm: People & agents → this agent → Lists & docs → Allow…';
  const conditional = 'If this agent has not been allowed yet, ask its owner to allow it in CommonSwarm: People & agents → this agent → Lists & docs → Allow…';
  const dir = mkdtempSync(join(tmpdir(), 'household-refusal-'));
  const input = join(dir, 'input.json'), token = join(dir, 'agent-token');
  writeFileSync(token, `swm_agt_${'b'.repeat(43)}`, { mode: 0o600 });
  let reason = 'content_consent_required';
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(request.url, '/functions/v1/command');
    assert.equal(body.command.kind, 'household_tool');
    assert.ok(['todo_list', 'object_list'].includes(body.command.tool));
    response.end(JSON.stringify({ status: 'refused', reason }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const target = { url: `http://127.0.0.1:${address.port}`, anonKey: 'test-public-key', profileId: 'test' };
  const tools = createHouseholdMcpTools(new HouseholdObjectClient(createHouseholdHttpTransport({
    target, authenticate: async () => ({ credential: 'synthetic-token' }),
  }), '11111111-1111-4111-8111-111111111111'));
  try {
    for (const [code, next] of [['content_consent_required', allow], ['connection_access_refused', allow],
      ['workspace_access_refused', conditional], ['content_read_only', undefined], ['request_refused', undefined]] as const) {
      reason = code;
      for (const [tool, args] of [['todo_list', { scope: 'open' }], ['object_list', { offset: 0, limit: 10 }]] as const) {
        const mcp = await tools.call(tool, { seat: LOCAL_HOUSEHOLD_SEAT, ...args });
        assert.equal(mcp.isError, true);
        assert.equal(JSON.parse(mcp.content[0]!.text).next_action, next ?? 'Resolve the refusal before submitting another request.');
        writeFileSync(input, JSON.stringify(args));
        for (const flags of [[], ['--json']]) {
          const failure = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'object', tool,
            '--input-file', input, '--url', target.url, '--anon-key', target.anonKey,
            '--workspace-id', '11111111-1111-4111-8111-111111111111', '--agent-token-file', token, ...flags],
          { encoding: 'utf8' }).then(() => assert.fail('refused CLI call must exit 1'), error => error);
          assert.equal(failure.code, 1);
          assert.equal(failure.stderr, '');
          assert.deepEqual(JSON.parse(failure.stdout), { status: 'refused', reason, ...(next ? { next_action: next } : {}) });
        }
      }
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    execFileSync('rm', ['-r', dir]);
  }
});

test('local household HTTP dispatch preserves exact request IDs and binds reads and writes to the profile workspace', async () => {
  const requests: { url: string; body: any; auth: string | undefined }[] = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({ url: request.url!, body, auth: request.headers.authorization });
    response.setHeader('content-type', 'application/json');
    // Every household call posts /functions/v1/command (D9); reads are told apart by tool name.
    response.end(JSON.stringify(body.command?.tool === 'object_list' ? { status: 'ok', kind: 'object_list', objects: [], next_offset: null }
      : { status: 'committed', object_id: 'notes', revision: { workspace_id: 'workspace-one', object_id: 'notes', token: 'a'.repeat(32) } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  let opens = 0;
  try {
    const client = new HouseholdObjectClient(createHouseholdHttpTransport({
      target: { url: `http://127.0.0.1:${address.port}`, anonKey: 'test-public-key', profileId: 'test' },
      authenticate: async () => ({ credential: `synthetic-token-${++opens}` }),
    }), 'workspace-one');
    const create = client.prepare('object_create', { seat: LOCAL_HOUSEHOLD_SEAT, request_id: 'retry_0001', object_id: 'notes',
      title: 'Notes', content: { kind: 'doc', markdown: 'Untrusted notes' } });
    assert.equal((await create.send()).status, 'committed');
    assert.equal((await create.retry()).status, 'committed');
    assert.equal(requests.length, 1, 'a known commit does not issue a second HTTP mutation');
    const read = client.prepare('object_list', { seat: LOCAL_HOUSEHOLD_SEAT, offset: 0, limit: 10 });
    assert.equal((await read.send()).status, 'ok');
    assert.equal((await read.retry()).status, 'ok');
    assert.deepEqual(requests.map(row => row.url), ['/functions/v1/command', '/functions/v1/command', '/functions/v1/command']);
    assert.equal(requests[0]!.body.client_version, CLIENT_PROTOCOL_VERSION);
    assert.equal(requests[0]!.body.client_build, CLI_BUILD_VERSION);
    assert.equal(requests[0]!.body.command_id, 'retry_0001');
    assert.equal(requests[0]!.body.command.arguments.request_id, 'retry_0001');
    assert.ok(requests.every(row => row.body.workspace_id === 'workspace-one'));
    assert.deepEqual(requests.map(row => row.auth), ['Bearer synthetic-token-1', 'Bearer synthetic-token-2', 'Bearer synthetic-token-3']);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test('CLI publishes every local household operation with the reviewed input-file route', () => {
  const names = execFileSync(process.execPath, ['dist/cli.js', 'object', '--help'], { encoding: 'utf8' }).matchAll(/cswarm object (\w+) --input-file <path>/g);
  assert.deepEqual(Array.from(names, match => match[1]), HOUSEHOLD_TOOLS.map(row => row.name));
});
