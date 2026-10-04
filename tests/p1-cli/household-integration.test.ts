import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { HouseholdObjectClient } from '../../src/cloud/household-objects.js';
import { createHouseholdHttpTransport, LOCAL_HOUSEHOLD_SEAT } from '../../src/cloud/household-http.js';
import { HOUSEHOLD_TOOL_REGISTRY } from '../../src/protocol/household-tool-registry.js';

test('local household HTTP dispatch preserves exact request IDs and binds reads and writes to the profile workspace', async () => {
  const requests: { url: string; body: any; auth: string | undefined }[] = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({ url: request.url!, body, auth: request.headers.authorization });
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(body.resource ? { status: 'ok', kind: 'object_list', objects: [], next_offset: null }
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
    assert.deepEqual(requests.map(row => row.url), ['/functions/v1/command', '/functions/v1/read', '/functions/v1/read']);
    assert.equal(requests[0]!.body.command_id, 'retry_0001');
    assert.equal(requests[0]!.body.command.arguments.request_id, 'retry_0001');
    assert.ok(requests.every(row => row.body.workspace_id === 'workspace-one'));
    assert.deepEqual(requests.map(row => row.auth), ['Bearer synthetic-token-1', 'Bearer synthetic-token-2', 'Bearer synthetic-token-3']);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test('CLI publishes every registry operation with the reviewed input-file route', () => {
  const help = execFileSync(process.execPath, ['dist/cli.js', 'object', '--help'], { encoding: 'utf8' });
  for (const row of HOUSEHOLD_TOOL_REGISTRY) assert.ok(help.includes(`cswarm object ${row.name} --input-file <path>`));
});
