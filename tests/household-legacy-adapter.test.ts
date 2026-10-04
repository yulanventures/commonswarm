import assert from 'node:assert/strict';
import * as brainNamespace from '../src/cloud/brain.js';
import * as transfers from '../supabase/functions/command/household-transfers.js';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createLegacyHouseholdAdapter, type LegacyHouseholdOperations, type LegacyHouseholdRequest } from '../supabase/functions/command/household-legacy-adapter.js';
import { householdAccessRefusal, type HouseholdAccessFacts } from '../src/protocol/household-object-policy.js';
import { decideHouseholdObject, emptyHouseholdObjectState, readHouseholdObjects, reduceHouseholdObjectStream,
  type HouseholdVerifiedContent } from '../src/protocol/household-objects.js';
import type { HouseholdContent, HouseholdObjectState } from '../src/protocol/household-object-events.js';
import type { HouseholdIdentity } from '../supabase/functions/command/household-objects.js';

// Only transaction/attachment infrastructure is simulated. Every content
// decision, refusal, revision and replay goes through the landed pure core.
// These tests own legacy translation risk; they do not claim SQL/HTTP parity.
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const identity: HouseholdIdentity = { user_id: 'alex', principal_id: 'agent-alex', run_id: 'run-1',
  connection: { connection_id: 'connection-alex', grant_id: 'grant-alex' } };
const author = { user_id: 'alex', principal_id: 'agent-alex', run_id: 'run-1', connection_id: 'connection-alex', grant_id: 'grant-alex' };
const facts = (): HouseholdAccessFacts => ({ workspace_id: 'household', archived_at: null, boundary: { kind: 'shared' },
  actor: { user_id: 'alex', principal_id: 'agent-alex', run_id: 'run-1' },
  member: { user_id: 'alex', workspace_id: 'household', revoked_at: null, content_role: 'editor', content_consent_id: 'consent-alex' },
  credential: { kind: 'agent', connection: { workspace_id: 'household', principal_id: 'agent-alex', owner_user_id: 'alex',
    connection_id: 'connection-alex', grant_id: 'grant-alex', operations: ['read', 'create', 'update'], purpose: 'shared', revoked_at: null, expires_at: 10000 } } });
type Receipt = NonNullable<Awaited<ReturnType<LegacyHouseholdOperations<FixtureTx>['receipt']>>>;
interface FixtureTx { state: HouseholdObjectState; receipts: Map<string, Receipt>;
  sourceDigests: Map<string, string>; artifacts: Map<string, { content: HouseholdContent; bytes: Uint8Array }>; audits: string[] }

function fixture() {
  let committed: FixtureTx = { state: emptyHouseholdObjectState('household', 'stream'), receipts: new Map(), sourceDigests: new Map(), artifacts: new Map(), audits: [] };
  let access = facts(), failure: 'none' | 'rollback' | 'lost_ack' = 'none';
  let foreignBinding = false, expireDuringWrite = false;
  const key = (workspace: string, id: HouseholdIdentity, requestId: string) => JSON.stringify([workspace, id.principal_id ?? id.user_id, requestId]);
  const ops: LegacyHouseholdOperations<FixtureTx> = {
    brain: brainNamespace, transfers, uploadLifetimeMs: 1000,
    async transaction(work) {
      const tx = structuredClone(committed);
      const result = await work(tx);
      if (failure === 'rollback') throw new Error('connection lost before commit');
      committed = tx;
      if (failure === 'lost_ack') throw new Error('commit acknowledgement lost');
      return result;
    },
    async authenticate() { return { access: structuredClone(access), now: 100 }; },
    accessRefusal: householdAccessRefusal,
    async receipt(tx, workspace, id, requestId) { return tx.receipts.get(key(workspace, id, requestId)) ?? null; },
    async record(tx, workspace, id, requestId, digest, operation, result) {
      assert.equal(tx.receipts.has(key(workspace, id, requestId)), false);
      tx.receipts.set(key(workspace, id, requestId), { digest, operation, result: structuredClone(result) });
    },
    async audit(tx, _workspace, _id, _requestId, _digest, status) { tx.audits.push(status); },
    async registerUpload(tx, _workspace, _id, _fileId, versionId, _objectId, sourceSha256) { tx.sourceDigests.set(versionId, sourceSha256); },
    async resolve(tx, workspace, _id, selector) {
      const objectId = 'file_id' in selector ? selector.file_id : selector.name;
      const object = tx.state.objects[objectId];
      const reservations = Object.values(tx.state.reservations).filter((r) => r.object_id === objectId);
      if (!object && reservations.length === 0) return null;
      return { workspace_id: foreignBinding ? 'personal-blair' : workspace, file_id: objectId, object_id: objectId,
        name: object?.history[0]?.title ?? reservations[0]!.title,
        versions: (object?.history ?? []).map((metadata, index) => ({ version_n: index + 1,
          metadata, content: tx.artifacts.get(metadata.blob.storage_key)!.content })),
        pending: reservations.map((r) => ({ version_id: r.reservation_id, operation: r.base ? 'update' as const : 'create' as const, source_sha256: tx.sourceDigests.get(r.reservation_id)! })) };
    },
    async write(tx, workspace, _id, requestId, command, proposal) {
      const base = command.kind === 'update_household_object' ? command.base
        : command.kind === 'reserve_household_upload' && command.change.kind === 'update' ? command.change.base : null;
      let prepared: HouseholdVerifiedContent | null = null;
      if (proposal && 'object_id' in command) {
        const bytes = proposal.content.kind === 'file' ? proposal.file_bytes! : new TextEncoder().encode(JSON.stringify(proposal.content));
        const path = `${workspace}/${command.object_id}/artifact-${tx.state.last_seq + 1}`;
        tx.artifacts.set(path, { content: structuredClone(proposal.content), bytes: new Uint8Array(bytes) });
        prepared = { workspace_id: workspace, object_id: command.object_id, revision: base, content: proposal.content,
          blob: { storage_key: path, size_bytes: bytes.byteLength, sha256: hash(bytes) } };
      } else if (command.kind === 'commit_household_upload') {
        const reservation = tx.state.reservations[command.reservation_id];
        if (reservation) prepared = { workspace_id: workspace, object_id: reservation.object_id, revision: reservation.base,
          content: tx.artifacts.get(reservation.proposed.storage_key)!.content, blob: reservation.proposed };
      }
      const historical = base && tx.state.objects[base.object_id]?.history.find((r) => r.revision.token === base.token);
      const contents: HouseholdVerifiedContent[] = historical ? [{ workspace_id: workspace, object_id: base!.object_id,
        revision: historical.revision, blob: historical.blob, content: tx.artifacts.get(historical.blob.storage_key)!.content }] : [];
      const n = tx.state.last_seq + 2;
      const decision = decideHouseholdObject(command, tx.state, { access, now: 100, command_id: requestId,
        request_digest: hash(JSON.stringify({ command, proposal })), seq: tx.state.last_seq + 1, event_id: `event-${n}`,
        revision_token: `revision_${String(n).padStart(24, '0')}`, draft_id: `draft-${n}`, other_storage_bytes: 0,
        other_object_count: 0, identity_write_attempts: 0, workspace_write_attempts: 0, contents, prepared });
      tx.state = reduceHouseholdObjectStream(decision.events, tx.state);
      if (expireDuringWrite && access.credential.kind === 'agent') access.credential.connection.revoked_at = 101;
      return decision;
    },
    async read(tx, _workspace, _id, query) { return readHouseholdObjects(query, tx.state, access, 100); },
    async readBytes(tx, _workspace, _id, query) {
      const result = readHouseholdObjects(query, tx.state, access, 100);
      if (result.status === 'refused') return result;
      if (result.kind !== 'object_read') throw new Error('unexpected fixture query');
      return { status: 'ok', metadata: result, bytes: tx.artifacts.get(result.revision.blob.storage_key)!.bytes };
    },
  };
  return { adapter: createLegacyHouseholdAdapter(ops), state: () => committed.state, audits: () => committed.audits,
    role(role: 'reader' | 'editor') { access.member!.content_role = role; },
    operations(operations: ('read' | 'create' | 'update')[]) { if (access.credential.kind === 'agent') access.credential.connection.operations = operations; },
    revoke() { if (access.credential.kind === 'agent') access.credential.connection.revoked_at = 101; },
    fail(value: typeof failure) { failure = value; }, foreign() { foreignBinding = true; }, expireDuringWrite() { expireDuringWrite = true; } };
}
const brain = (request_id: string, markdown: string, if_version: number | null = 0): LegacyHouseholdRequest =>
  ({ workspace_id: 'household', request_id, command: { kind: 'brain_put', topic: 'shopping', markdown, if_version } });
const upload = (request_id: string, version_id = 'upload-1', if_version: number | null = 0): LegacyHouseholdRequest =>
  ({ workspace_id: 'household', request_id, command: { kind: 'file_version_create', file_id: 'notes', version_id,
    name: 'notes.txt', declared_size_bytes: 3, content_type: 'text/plain', if_version } });
const commit = (request_id: string, version_id = 'upload-1', sha256: string | null = hash('abc')): LegacyHouseholdRequest =>
  ({ workspace_id: 'household', request_id, command: { kind: 'file_version_commit', file_id: 'notes', version_id, sha256 } });
const bytes = new TextEncoder().encode('abc');

test('brain translation commits through real core with immutable human/agent attribution and original request ID', async () => {
  const f = fixture();
  const result = await f.adapter(brain('brain-create', 'Milk'), identity);
  assert.equal(result.status, 'committed');
  assert.deepEqual(f.state().objects['brain--shopping.md']!.history[0]!.author, author);
  assert.equal(f.state().objects['brain--shopping.md']!.history[0]!.command_id, 'brain-create');
  assert.equal(f.state().objects['brain--shopping.md']!.kind, 'doc');
  const read = await f.adapter({ workspace_id: 'household', request_id: 'read', command: { kind: 'brain_get', topic: 'shopping', version_n: 1 } }, identity);
  assert.equal(read.status, 'ok');
  if (read.status === 'ok' && read.kind === 'read') {
    assert.deepEqual(read.content, { kind: 'doc', markdown: 'Milk' });
    assert.deepEqual(read.author, author);
    assert.equal('storage_key' in read, false);
    assert.equal('download_url' in read, false);
  }
});

test('legacy retry recovers one durable result despite changed current bindings; changed payload or attachment fails', async () => {
  const f = fixture(), request = brain('once', 'Milk');
  const first = await f.adapter(request, identity);
  assert.equal((await f.adapter(brain('next', 'Bread', 1), identity)).status, 'committed');
  const retry = await f.adapter(request, identity);
  assert.deepEqual(retry, { ...first, replayed: true });
  assert.equal(f.state().objects['brain--shopping.md']!.history.length, 2);
  assert.deepEqual(await f.adapter(brain('once', 'Changed'), identity), { status: 'refused', reason: 'request_id_reused', request_id: 'once', replayed: false });
  assert.equal((await f.adapter(upload('reserve'), identity, bytes)).status, 'pending');
  const seq = f.state().last_seq;
  assert.equal((await f.adapter(upload('reserve'), identity, new TextEncoder().encode('xyz'))).status, 'refused');
  assert.equal(f.state().last_seq, seq);
});

test('stale legacy integer and opaque bases preserve exact losing drafts; missing base cannot clobber', async () => {
  const f = fixture();
  await f.adapter(brain('v1', 'Milk'), identity);
  const base = f.state().objects['brain--shopping.md']!.history[0]!.revision;
  await f.adapter(brain('v2', 'Bread', 1), identity);
  assert.equal((await f.adapter(brain('blind', 'Overwrite', null), identity)).status, 'refused');
  for (const request of [brain('stale-integer', 'Eggs', 1), { ...brain('stale-opaque', 'Tea', null), base_revision: base }]) {
    const conflict = await f.adapter(request, identity);
    assert.equal(conflict.status, 'conflict');
    if (conflict.status === 'conflict') {
      const draft = f.state().drafts[conflict.draft_id]!;
      assert.deepEqual(draft.base, base);
      assert.deepEqual(draft.owner, author);
      assert.equal(draft.command_id, request.request_id);
      assert.equal(draft.proposed.sha256, hash(JSON.stringify({ kind: 'doc', markdown: request.command.kind === 'brain_put' ? request.command.markdown : '' })));
      assert.equal(conflict.current.token, f.state().objects['brain--shopping.md']!.history[1]!.revision.token);
    }
  }
  assert.equal(f.state().objects['brain--shopping.md']!.history.length, 2);
});

test('protected upload begins pending, verifies size/digest, commits once and preserves file attribution', async () => {
  const f = fixture();
  assert.equal((await f.adapter(upload('missing'), identity)).status, 'refused');
  assert.equal((await f.adapter(upload('bad-size'), identity, new Uint8Array(2))).status, 'refused');
  assert.equal((await f.adapter(upload('begin'), identity, bytes)).status, 'pending');
  assert.equal(Object.keys(f.state().objects).length, 0);
  assert.equal((await f.adapter(commit('bad-digest', 'upload-1', 'a'.repeat(64)), identity)).status, 'refused');
  const committed = await f.adapter(commit('commit'), identity);
  assert.equal(committed.status, 'committed');
  assert.deepEqual(await f.adapter(commit('commit'), identity), { ...committed, replayed: true });
  assert.deepEqual(f.state().objects.notes!.history[0]!.author, author);
  assert.equal(f.state().objects.notes!.history[0]!.blob.sha256, hash('abc'));
  assert.equal(f.state().objects.notes!.history.length, 1);
});

test('reservation commit checks stale bases again and retains proposed bytes', async () => {
  const f = fixture();
  await f.adapter(upload('begin'), identity, bytes);
  await f.adapter(commit('commit'), identity);
  await f.adapter(upload('begin-a', 'upload-a', 1), identity, bytes);
  await f.adapter(upload('begin-b', 'upload-b', 1), identity, bytes);
  assert.equal((await f.adapter(commit('commit-a', 'upload-a'), identity)).status, 'committed');
  const conflict = await f.adapter(commit('commit-b', 'upload-b'), identity);
  assert.equal(conflict.status, 'conflict');
  if (conflict.status === 'conflict') assert.equal(f.state().drafts[conflict.draft_id]!.proposed.sha256, hash('abc'));
  assert.equal(f.state().objects.notes!.history.length, 2);
});

test('reserved brain filename preserves the legacy raw digest while the core commits a canonical doc', async () => {
  const f = fixture();
  const request = upload('brain-file-begin');
  assert.equal(request.command.kind, 'file_version_create');
  if (request.command.kind === 'file_version_create') request.command.name = 'brain--shopping.md';
  assert.equal((await f.adapter(request, identity, bytes)).status, 'pending');
  assert.equal((await f.adapter(commit('brain-file-commit'), identity)).status, 'committed');
  assert.equal(f.state().objects.notes!.kind, 'doc');
  assert.equal(f.state().objects.notes!.history[0]!.blob.sha256, hash('{"kind":"doc","markdown":"abc"}'));
  const read = await f.adapter({ workspace_id: 'household', request_id: 'brain-file-read',
    command: { kind: 'file_download_url', file_id: 'notes', version_n: 1 } }, identity);
  assert.equal(read.status, 'ok');
  if (read.status === 'ok' && read.kind === 'read') {
    assert.deepEqual(read.content, { kind: 'doc', markdown: 'abc' });
    assert.equal(new TextDecoder().decode(read.attachment), 'abc');
  }
});

test('reader, foreign workspace/binding, forged actor and revoked retry refusals accompany valid controls', async () => {
  const f = fixture();
  assert.equal((await f.adapter(brain('valid', 'Milk'), identity)).status, 'committed');
  f.role('reader');
  const denied = await f.adapter(brain('reader-write', 'Bread', 1), identity);
  assert.equal(denied.status, 'refused');
  if (denied.status === 'refused') assert.equal(denied.reason, 'content_read_only');
  const read: LegacyHouseholdRequest = { workspace_id: 'household', request_id: 'read', command: { kind: 'brain_get', topic: 'shopping', version_n: null } };
  assert.equal((await f.adapter(read, identity)).status, 'ok');
  assert.equal((await f.adapter({ ...read, workspace_id: 'personal-blair' }, identity)).status, 'refused');
  assert.equal((await f.adapter(read, { ...identity, user_id: 'blair' })).status, 'refused');
  f.role('editor'); f.foreign();
  assert.equal((await f.adapter(read, identity)).status, 'refused');
  f.revoke();
  assert.equal((await f.adapter(brain('valid', 'Milk'), identity)).status, 'refused');
  assert.equal(f.state().objects['brain--shopping.md']!.history.length, 1);
});

test('update-only connection ceiling works without create rights and cannot recover a create receipt', async () => {
  const f = fixture();
  await f.adapter(brain('create', 'Milk'), identity);
  f.operations(['update']);
  const update = brain('update', 'Bread', 1);
  assert.equal((await f.adapter(update, identity)).status, 'committed');
  assert.equal((await f.adapter(update, identity)).status, 'committed');
  assert.equal((await f.adapter(brain('create', 'Milk'), identity)).status, 'refused');
  const creator = fixture(); creator.operations(['create']);
  assert.equal((await creator.adapter(upload('create-only-begin'), identity, bytes)).status, 'pending');
  const done = await creator.adapter(commit('create-only-commit'), identity);
  assert.equal(done.status, 'committed');
  assert.deepEqual(await creator.adapter(commit('create-only-commit'), identity), { ...done, replayed: true });
  assert.equal((await creator.adapter({ workspace_id: 'household', request_id: 'read-denied',
    command: { kind: 'file_download_url', file_id: 'notes', version_n: null } }, identity)).status, 'refused');
});

test('transaction failure is unknown; rollback and lost commit acknowledgement recover safely on exact retry', async () => {
  for (const mode of ['rollback', 'lost_ack'] as const) {
    const f = fixture(), request = brain('uncertain', 'Milk');
    f.fail(mode);
    assert.deepEqual(await f.adapter(request, identity), { status: 'unknown', request_id: 'uncertain', reason: 'transaction_outcome_unknown' });
    assert.equal(f.state().objects['brain--shopping.md']?.history.length ?? 0, mode === 'rollback' ? 0 : 1);
    f.fail('none');
    assert.equal((await f.adapter(request, identity)).status, 'committed');
    assert.equal(f.state().objects['brain--shopping.md']!.history.length, 1);
  }
  const f = fixture(); f.expireDuringWrite();
  assert.equal((await f.adapter(brain('revoked-in-flight', 'Milk'), identity)).status, 'unknown');
  assert.deepEqual(f.state().objects, {});
});

test('history keeps opaque revision/provenance and unsupported legacy deletion never claims success', async () => {
  const f = fixture();
  await f.adapter(brain('create', 'Milk'), identity);
  await f.adapter(brain('edit', 'Bread', 1), identity);
  const history = await f.adapter({ workspace_id: 'household', request_id: 'history', command: { kind: 'brain_history', topic: 'shopping', offset: 0, limit: 1 } }, identity);
  assert.equal(history.status, 'ok');
  if (history.status === 'ok' && history.kind === 'history') {
    assert.equal(history.next_offset, 1);
    assert.equal(history.revisions[0]!.command_id, 'create');
    assert.deepEqual(history.revisions[0]!.author, author);
    assert.equal('blob' in history.revisions[0]!, false);
  }
  const result = await f.adapter({ workspace_id: 'household', request_id: 'delete', command: { kind: 'file_tombstone', file_id: 'brain--shopping.md' } }, identity);
  assert.equal(result.status, 'refused');
  assert.equal(f.state().objects['brain--shopping.md']!.history.length, 2);
});
