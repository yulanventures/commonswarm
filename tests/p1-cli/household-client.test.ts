import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { HouseholdObjectClient, type HouseholdTransport } from '../../src/cloud/household-objects.js';
import { createHouseholdMcpTools } from '../../src/mcp/household-tools.js';
import { MCP_RESULT_MAX_BYTES } from '../../src/mcp/tools.js';
import { HOUSEHOLD_TOOLS, HouseholdToolInputError, type HouseholdToolInvocation } from '../../src/protocol/household-tool-registry.js';
import { decideHouseholdObject, emptyHouseholdObjectState, readHouseholdObjects, reduceHouseholdObjectStream,
  type HouseholdVerifiedContent } from '../../src/protocol/household-objects.js';
import type { HouseholdAccessFacts } from '../../src/protocol/household-object-policy.js';
import type { HouseholdContent, HouseholdRevisionRef } from '../../src/protocol/household-object-events.js';

const workspace = 'household-test';
const seat = `seat_${'s'.repeat(22)}`;
const ref = (token = 'a'.repeat(22), object_id = 'shopping', workspace_id = workspace): HouseholdRevisionRef => ({ workspace_id, object_id, token });
const create = (request_id = 'create_001', object_id = 'shopping') => ({ seat, request_id, object_id,
  title: 'Shopping', content: { kind: 'doc', markdown: 'tea' } });
const update = (base: HouseholdRevisionRef, request_id = 'update_001', after = 'tea and rice') => ({ seat, request_id,
  object_id: 'shopping', base, patch: { kind: 'doc', splices: [{ start: 0, before: 'tea', after }] } });
const access: HouseholdAccessFacts = { workspace_id: workspace, archived_at: null, boundary: { kind: 'shared' },
  actor: { user_id: 'human-a', principal_id: null, run_id: null }, credential: { kind: 'human' },
  member: { user_id: 'human-a', workspace_id: workspace, revoked_at: null, content_role: 'editor', content_consent_id: 'consent-a' } };

/** In-process protocol boundary, not a database or hosted-permission proof.
 * Receipts/revisions/conflicts come from the real reducer rather than canned
 * success responses. The host supplies verified proposals as lane 2 requires.
 */
function coreHost() {
  let state = emptyHouseholdObjectState(workspace, 'household-stream');
  const contents: HouseholdVerifiedContent[] = [];
  let calls = 0;
  let lost = false;
  let currentAccess = structuredClone(access);
  const transport: HouseholdTransport = {
    async execute(invocation) {
      calls++;
      if ('query' in invocation) {
        const metadata = readHouseholdObjects(invocation.query, state, currentAccess, 100);
        if (metadata.status !== 'ok' || metadata.kind !== 'object_read') return metadata;
        const value = contents.find(item => item.revision?.token === metadata.revision.revision.token)!;
        return { status: 'ok', metadata, bytes: new TextEncoder().encode(JSON.stringify(value.content)) };
      }
      const command = invocation.command;
      const object_id = 'object_id' in command ? command.object_id : 'shopping';
      const base = command.kind === 'update_household_object' ? command.base : null;
      const proposal: HouseholdContent = command.kind === 'create_household_object' ? command.content
        : command.kind === 'update_household_object' && command.patch.kind === 'doc'
          ? { kind: 'doc', markdown: command.patch.splices[0]!.after } : { kind: 'file', name: 'test.pdf', media_type: 'application/pdf' };
      const bytes = new TextEncoder().encode(JSON.stringify(proposal));
      const blob = { storage_key: 'host/private/artifact', size_bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex') };
      const prepared = { workspace_id: workspace, object_id, revision: base, blob, content: proposal };
      const decision = decideHouseholdObject(command, state, { access: currentAccess, now: 100,
        command_id: invocation.request_id!, request_digest: createHash('sha256').update(JSON.stringify(command)).digest('hex'),
        seq: state.last_seq + 1, event_id: `event-${calls}`, revision_token: `r${String(calls).padStart(21, '0')}`,
        draft_id: `draft-${calls}`, other_storage_bytes: 0, other_object_count: 0,
        identity_write_attempts: 0, workspace_write_attempts: 0, contents, prepared });
      state = reduceHouseholdObjectStream(decision.events, state);
      if (!decision.replayed && decision.outcome.status === 'committed') contents.push({ ...prepared, revision: decision.outcome.revision });
      if (lost) {
        lost = false;
        if ('object_id' in invocation.command) invocation.command.object_id = 'transport-mutation';
        throw new Error('synthetic transfer credential must never be echoed');
      }
      return decision;
    },
  };
  return { transport, client: new HouseholdObjectClient(transport, workspace), state: () => state, calls: () => calls,
    loseNext: () => { lost = true; }, reader: () => { currentAccess = { ...currentAccess, member: { ...currentAccess.member!, content_role: 'reader' } }; },
    revoke: () => { currentAccess = { ...currentAccess, member: { ...currentAccess.member!, revoked_at: 100 } }; } };
}

test('lost committed response retries the original ID/input and recovers exactly one revision, including after restart', async () => {
  const host = coreHost();
  const args = create();
  const pending = host.client.prepare('object_create', args);
  args.content.markdown = 'caller changed draft';
  host.loseNext();
  assert.deepEqual(await pending.send(), { status: 'unknown', request_id: 'create_001', reason: 'transport_interrupted' });
  const committed = await pending.retry();
  assert.equal(committed.status, 'committed');
  assert.equal(host.calls(), 2);
  assert.equal(host.state().objects.shopping!.history.length, 1);
  await pending.retry();
  assert.equal(host.calls(), 2, 'known outcomes do not resubmit');
  const restarted = new HouseholdObjectClient(host.transport, workspace);
  assert.deepEqual(await restarted.prepare('object_create', create()).send(), committed);
  assert.equal(host.state().objects.shopping!.history.length, 1);
  const changed = create();
  changed.content.markdown = 'different request digest';
  assert.deepEqual(await restarted.prepare('object_create', changed).send(), {
    status: 'refused', request_id: 'create_001', reason: 'request_id_reused',
  });
});

test('workspace/object/exact opaque revision are bound on both request and read response', async () => {
  const host = coreHost();
  const initial = await host.client.prepare('object_create', create()).send();
  assert.equal(initial.status, 'committed');
  if (initial.status !== 'committed') return;
  for (const base of [ref(initial.revision.token, 'another-object'), ref(initial.revision.token, 'shopping', 'private-space')]) {
    assert.throws(() => host.client.prepare('object_update', update(base)), HouseholdToolInputError);
  }
  assert.equal(host.calls(), 1, 'invalid binding never reaches transport');
  const read = await host.client.prepare('object_read', { seat, object_id: 'shopping', revision: initial.revision }).send();
  assert.equal(read.status, 'ok');
  if (read.status === 'ok' && read.kind === 'object_read') {
    assert.deepEqual(read.revision.revision, initial.revision);
    assert.deepEqual(read.content, { kind: 'doc', markdown: 'tea' });
  }
  const forged = new HouseholdObjectClient({ execute: async () => ({ status: 'committed', object_id: 'shopping', revision: ref('z'.repeat(22), 'shopping', 'private-space') }) }, workspace);
  assert.equal((await forged.prepare('object_create', create()).send()).status, 'unknown');
  const forwarded: HouseholdToolInvocation[] = [];
  const client = new HouseholdObjectClient({ execute: async invocation => { forwarded.push(invocation); return { outcome: { status: 'committed', object_id: 'shopping', revision: ref('b'.repeat(22)) } }; } }, workspace);
  await client.prepare('object_update', update(initial.revision)).send();
  assert.deepEqual(forwarded[0], { workspace_id: workspace, seat, request_id: 'update_001', operation: 'update', objectTypes: ['list', 'doc'],
    command: { kind: 'update_household_object', object_id: 'shopping', base: initial.revision, patch: update(initial.revision).patch } });
});

test('stale patch preserves a draft and never retries blindly; reviewed patch uses a fresh ID', async () => {
  const host = coreHost();
  const initial = await host.client.prepare('object_create', create()).send();
  if (initial.status !== 'committed') assert.fail('initial write must commit');
  const current = await host.client.prepare('object_update', update(initial.revision, 'first_001')).send();
  if (current.status !== 'committed') assert.fail('first update must commit');
  const stale = host.client.prepare('object_update', update(initial.revision, 'stale_001', 'tea and bread'));
  const conflict = await stale.send();
  assert.equal(conflict.status, 'conflict');
  if (conflict.status !== 'conflict') return;
  assert.deepEqual(conflict.current, current.revision);
  assert.ok(host.state().drafts[conflict.draft_id]);
  const calls = host.calls();
  assert.deepEqual(await stale.retry(), conflict);
  assert.equal(host.calls(), calls);
  const reviewed = { ...update(current.revision, 'reviewed_001', 'tea and rice and bread'),
    patch: { kind: 'doc', splices: [{ start: 0, before: 'tea and rice', after: 'tea and rice and bread' }] } };
  assert.equal((await host.client.prepare('object_update', reviewed).send()).status, 'committed');
  assert.equal(host.state().objects.shopping!.history.length, 3);
});

test('registry-derived local tools pass reads, surface reader refusal, and reject malformed model arguments', async () => {
  const host = coreHost();
  const tools = createHouseholdMcpTools(host.client);
  assert.deepEqual(tools.tools, HOUSEHOLD_TOOLS);
  assert.equal(tools.tools.length, 18, 'eight object/file tools and ten to-do/comment tools');
  const created = await tools.call('object_create', create());
  assert.equal(JSON.parse(created.content[0]!.text).status, 'committed');
  host.reader();
  assert.equal(JSON.parse((await tools.call('object_list', { seat, offset: 0, limit: 2 })).content[0]!.text).status, 'ok');
  const refused = await tools.call('object_create', create('reader_001', 'reader-object'));
  assert.equal(refused.isError, true);
  assert.equal(JSON.parse(refused.content[0]!.text).reason, 'content_read_only');
  const calls = host.calls();
  for (const [name, args] of [['object_create', { ...create(), request_id: undefined }],
    ['unknown_tool', {}], ['object_read', { seat, object_id: 'shopping', url: 'https://untrusted.test' }]] as const) {
    assert.equal(JSON.parse((await tools.call(name, args)).content[0]!.text).status, 'refused');
  }
  assert.equal(host.calls(), calls);
});

test('pending upload is not committed and retry keeps host reservation facts; commit is a separate request', async () => {
  const seen: HouseholdToolInvocation[] = [];
  const client = new HouseholdObjectClient({ execute: async invocation => {
    seen.push(structuredClone(invocation));
    if (seen.length === 1) throw new Error('interrupted');
    return { outcome: 'command' in invocation && invocation.command.kind === 'reserve_household_upload'
      ? { status: 'pending', object_id: 'file-a', reservation_id: invocation.command.reservation_id, signed_url: 'SECRET_TRANSFER' }
      : { status: 'committed', object_id: 'file-a', revision: ref('f'.repeat(22), 'file-a') } };
  } }, workspace);
  const tools = createHouseholdMcpTools(client);
  const host = { upload: { reservation_id: 'reserve-a', expires_at: 1000 } };
  const request = tools.prepare('file_upload_begin', { seat, request_id: 'upload_001', object_id: 'file-a',
    change: { kind: 'create', title: 'File', content: { kind: 'file', name: 'a.pdf', media_type: 'application/pdf' } } }, host);
  host.upload.reservation_id = 'changed-host-fact';
  assert.equal((await request.send()).status, 'unknown');
  const pending = await tools.retry(request);
  assert.deepEqual(seen[0], seen[1]);
  assert.equal(JSON.parse(pending.content[0]!.text).status, 'pending');
  assert.match(pending.content[0]!.text, /no revision is committed/);
  assert.doesNotMatch(pending.content[0]!.text, /SECRET_TRANSFER/);
  assert.equal(JSON.parse((await tools.call('file_upload_commit', { seat, request_id: 'commit_001',
    reservation_id: 'reserve-a', operation: 'create' })).content[0]!.text).status, 'committed');
  assert.equal(seen[2]!.request_id, 'commit_001');
});

test('ambiguous/malformed responses never appear successful and raw credentials/errors stay outside MCP', async () => {
  const replies: unknown[] = [null, { ok: true }, { status: 'committed', object_id: 'shopping' },
    { status: 'pending', object_id: 'shopping', reservation_id: 'secret-url' },
    { status: 'committed', object_id: 'another', revision: ref() },
    { status: 'refused', reason: 'https://secret.test/?token=SECRET_TRANSFER' },
    { outcome: { status: 'committed', object_id: 'shopping', revision: ref(), credentials: 'SECRET_TRANSFER' },
      signed_url: 'SECRET_TRANSFER', events: [{ token: 'SECRET_TRANSFER' }] }];
  for (const [index, response] of replies.entries()) {
    const tools = createHouseholdMcpTools(new HouseholdObjectClient({ execute: async () => response }, workspace));
    const result = await tools.call('object_create', create());
    const output = JSON.parse(result.content[0]!.text);
    assert.equal(output.status, index < 5 ? 'unknown' : index === 5 ? 'refused' : 'committed');
    assert.equal(result.isError, index !== 6);
    assert.doesNotMatch(result.content[0]!.text, /SECRET_TRANSFER|signed_url|credentials|events/);
  }
  const thrown = createHouseholdMcpTools(new HouseholdObjectClient({ execute: async () => { throw new Error('SECRET_TRANSFER'); } }, workspace));
  const unknown = await thrown.call('object_create', create());
  assert.equal(JSON.parse(unknown.content[0]!.text).status, 'unknown');
  assert.doesNotMatch(unknown.content[0]!.text, /SECRET_TRANSFER/);
});

function readRevision(object_id = 'shopping', kind: 'doc' | 'file' = 'doc') {
  return { revision: ref('a'.repeat(22), object_id), parent: null, kind, title: 'Shared object',
    file_metadata: kind === 'file' ? { kind: 'file', name: 'test.pdf', media_type: 'application/pdf', signed_url: 'SECRET_TRANSFER' } : null,
    blob: { storage_key: 'SECRET_TRANSFER', size_bytes: 3, sha256: '1'.repeat(64), credential: 'SECRET_TRANSFER' },
    author: { user_id: 'human-a', principal_id: 'agent-a', run_id: 'run-a', credential: 'SECRET_TRANSFER' },
    occurred_at_server: 100, command_id: 'original-write' };
}

test('metadata, retained history and file reads project safe fields while preserving author and revisions', async () => {
  const tools = createHouseholdMcpTools(new HouseholdObjectClient({ execute: async invocation => {
    if (!('query' in invocation)) assert.fail('read expected');
    if (invocation.query.kind === 'object_history') return { status: 'ok', kind: 'object_history',
      revisions: [{ ...readRevision(), live: false, transfer_token: 'SECRET_TRANSFER' }], next_offset: null };
    if (invocation.query.kind === 'object_list') return { status: 'ok', kind: 'object_list', objects: [{ object_id: 'shopping',
      kind: 'doc', title: 'Shared object', revision: ref(), signed_url: 'SECRET_TRANSFER' }], next_offset: null };
    return { status: 'ok', metadata: { status: 'ok', kind: 'object_read', revision: readRevision('file-a', 'file'), live: true },
      bytes: new Uint8Array([1, 2, 3]), signed_url: 'SECRET_TRANSFER', transfer_headers: { Authorization: 'SECRET_TRANSFER' } };
  } }, workspace));
  for (const [name, args] of [['object_list', { seat, offset: 0, limit: 2 }],
    ['object_history', { seat, object_id: 'shopping', offset: 0, limit: 2 }],
    ['file_read', { seat, object_id: 'file-a' }]] as const) {
    const result = await tools.call(name, args);
    assert.equal(result.isError, false);
    assert.equal(JSON.parse(result.content[0]!.text).status, 'ok');
    assert.doesNotMatch(result.content[0]!.text, /SECRET_TRANSFER|storage_key|transfer_headers|signed_url|"bytes"/);
    if (name === 'object_history') {
      const revision = JSON.parse(result.content[0]!.text).revisions[0];
      assert.equal(revision.live, false, 'retired committed history stays readable');
      assert.deepEqual(revision.author, { user_id: 'human-a', principal_id: 'agent-a', run_id: 'run-a' });
      assert.deepEqual(revision.revision, ref());
    }
  }
});

test('exact reads reject substituted revisions, wrong object types and overfull pages with valid controls', async () => {
  const responses: unknown[] = [
    { status: 'ok', kind: 'object_read', revision: readRevision(), live: true, content: { kind: 'doc', markdown: 'tea' } },
    { status: 'ok', kind: 'object_read', revision: { ...readRevision(), revision: ref('b'.repeat(22)) }, live: true, content: { kind: 'doc', markdown: 'tea' } },
    { status: 'ok', kind: 'object_read', revision: readRevision('shopping', 'file'), live: true },
    { status: 'ok', kind: 'object_read', revision: readRevision('foreign-object'), live: true, content: { kind: 'doc', markdown: 'tea' } },
  ];
  for (const [index, response] of responses.entries()) {
    const client = new HouseholdObjectClient({ execute: async () => response }, workspace);
    assert.equal((await client.prepare('object_read', { seat, object_id: 'shopping', revision: ref() }).send()).status, index === 0 ? 'ok' : 'unknown');
  }
  for (const number of [1, 2]) {
    const objects = Array.from({ length: number }, (_, index) => ({ object_id: `object-${index}`, kind: 'doc', title: 'Doc', revision: ref('a'.repeat(22), `object-${index}`) }));
    const client = new HouseholdObjectClient({ execute: async () => ({ status: 'ok', kind: 'object_list', objects, next_offset: null }) }, workspace);
    assert.equal((await client.prepare('object_list', { seat, offset: 0, limit: 1 }).send()).status, number === 1 ? 'ok' : 'unknown');
  }
});

test('concurrent attempts share one transport request; abort remains unknown and permits an explicit identical retry', async () => {
  let calls = 0;
  let submitted: HouseholdToolInvocation | undefined;
  const client = new HouseholdObjectClient({ execute: async (invocation, { signal }) => {
    calls++;
    if (calls === 1) {
      submitted = structuredClone(invocation);
      return await new Promise((_, reject) => {
        signal!.addEventListener('abort', () => reject(new DOMException('secret error text', 'AbortError')), { once: true });
      });
    }
    assert.deepEqual(invocation, submitted);
    return { status: 'committed', object_id: 'shopping', revision: ref() };
  } }, workspace);
  const request = client.prepare('object_create', create());
  const abort = new AbortController();
  const first = request.send({ signal: abort.signal });
  const second = request.retry();
  assert.equal(calls, 1);
  abort.abort();
  assert.deepEqual(await first, await second);
  assert.equal((await first).status, 'unknown');
  assert.equal((await request.retry()).status, 'committed');
  assert.equal(calls, 2);
});

test('read retries recheck permission and oversized content is explicitly bounded without claiming a successful read', async () => {
  const host = coreHost();
  await host.client.prepare('object_create', create()).send();
  const request = host.client.prepare('object_read', { seat, object_id: 'shopping' });
  assert.equal((await request.send()).status, 'ok');
  const calls = host.calls();
  await request.retry();
  assert.equal(host.calls(), calls + 1, 'read retry returns to the authorized host');
  host.revoke();
  assert.deepEqual(await request.retry(), { status: 'refused', reason: 'workspace_access_refused' });
  const client = new HouseholdObjectClient({ execute: async () => ({ status: 'ok', kind: 'object_read', revision: readRevision(),
    live: true, content: { kind: 'doc', markdown: 'x'.repeat(MCP_RESULT_MAX_BYTES + 1) } }) }, workspace);
  const result = await createHouseholdMcpTools(client).call('object_read', { seat, object_id: 'shopping' });
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content[0]!.text).status, 'refused');
  assert.equal(JSON.parse(result.content[0]!.text).truncated, true);
  assert.ok(Buffer.byteLength(result.content[0]!.text) <= MCP_RESULT_MAX_BYTES);
});
