import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { StreamIntegrityError, UnknownEventTypeError } from '../src/protocol/reducer.js';
import {
  decideHouseholdObject, emptyHouseholdObjectState, householdObjectUsage,
  readHouseholdObjects, reduceHouseholdObject, reduceHouseholdObjectStream,
  type DecideHouseholdObjectContext, type HouseholdObjectCommand, type HouseholdVerifiedContent,
} from '../src/protocol/household-objects.js';
import type { HouseholdAccessFacts } from '../src/protocol/household-object-policy.js';
import type {
  HouseholdContent, HouseholdObjectEvent, HouseholdObjectState, HouseholdPatch,
  HouseholdRevisionRef,
} from '../src/protocol/household-object-events.js';

// Expectations below are literal household contracts, not values obtained by
// invoking another production helper. The adapter fixture only supplies bytes,
// authenticated identities and locked counters; it never implements decisions.
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const token = (n: number): string => `revision_${String(n).padStart(24, '0')}`;
const ref = (n: number, objectId = 'shopping', workspaceId = 'household'): HouseholdRevisionRef =>
  ({ workspace_id: workspaceId, object_id: objectId, token: token(n) });
const milk: HouseholdContent = { kind: 'list', items: [
  { item_id: 'milk', text: 'Milk', checked: false, order: 0 },
] };
const checkedMilk: HouseholdContent = { kind: 'list', items: [
  { item_id: 'milk', text: 'Milk', checked: true, order: 0 },
] };
const checkMilk: HouseholdPatch = { kind: 'list', operations: [
  { kind: 'set', item_id: 'milk', before_text: 'Milk', before_checked: false, text: 'Milk', checked: true },
] };

function access(user = 'alex', workspace = 'household'): HouseholdAccessFacts {
  return { workspace_id: workspace, archived_at: null, boundary: { kind: 'shared' },
    actor: { user_id: user, principal_id: null, run_id: null }, credential: { kind: 'human' },
    member: { user_id: user, workspace_id: workspace, revoked_at: null, content_role: 'editor', content_consent_id: `consent-${user}` } };
}

function agent(user = 'alex', workspace = 'household'): HouseholdAccessFacts {
  return { ...access(user, workspace), actor: { user_id: user, principal_id: `agent-${user}`, run_id: 'run-1' },
    credential: { kind: 'agent', connection: { owner_user_id: user, workspace_id: workspace,
      principal_id: `agent-${user}`, connection_id: `connection-${user}`, grant_id: `grant-${user}`,
      revoked_at: null, expires_at: 10000, operations: ['read', 'create', 'update'], purpose: 'shared' } } };
}

function artifact(content: HouseholdContent, objectId: string, base: HouseholdRevisionRef | null = null,
  label = 'bytes'): HouseholdVerifiedContent {
  const bytes = JSON.stringify(content);
  return { workspace_id: 'household', object_id: objectId, revision: base,
    blob: { storage_key: `household/${objectId}/${label}`, size_bytes: Buffer.byteLength(bytes), sha256: sha(bytes) }, content };
}

function context(state: HouseholdObjectState, command: HouseholdObjectCommand, prepared: HouseholdVerifiedContent | null,
  overrides: Partial<DecideHouseholdObjectContext> = {}): DecideHouseholdObjectContext {
  const n = state.last_seq + 2;
  return { access: access(), now: 100, command_id: `command-${n}`, request_digest: sha(JSON.stringify(command)),
    seq: state.last_seq + 1, event_id: `event-${n}`, revision_token: token(n), draft_id: `draft-${n}`,
    other_storage_bytes: 0, other_object_count: 0, identity_write_attempts: 0, workspace_write_attempts: 0,
    contents: [], prepared, ...overrides };
}

function createList(): { state: HouseholdObjectState; events: HouseholdObjectEvent[]; content: HouseholdVerifiedContent } {
  const command: HouseholdObjectCommand = { kind: 'create_household_object', object_id: 'shopping', title: 'Shopping', content: milk };
  const initial = emptyHouseholdObjectState('household', 'stream');
  const content = artifact(milk, 'shopping');
  const decision = decideHouseholdObject(command, initial, context(initial, command, content));
  assert.deepEqual(decision.outcome, { status: 'committed', object_id: 'shopping', revision: ref(1) });
  return { state: reduceHouseholdObjectStream(decision.events, initial), events: [...decision.events], content: { ...content, revision: ref(1) } };
}

function updateCommand(base = ref(1), patch = checkMilk): HouseholdObjectCommand {
  return { kind: 'update_household_object', object_id: 'shopping', base, patch };
}

// Independent golden event: replay is tested without using the decision maker
// to generate its input. It protects the wire schema and provenance contract.
const golden: HouseholdObjectEvent = {
  workspace_id: 'household', stream_id: 'stream', seq: 0, event_id: 'golden-event', command_id: 'golden-command',
  schema_version: 1, actor_user: 'alex', actor_agent_principal: null, actor_run: null,
  occurred_at_server: 100, type: 'HouseholdObjectCreated', payload: {
    revision: { revision: ref(1), parent: null, title: 'Shopping', kind: 'list', file_metadata: null,
      blob: { storage_key: 'household/shopping/golden', size_bytes: 87, sha256: 'a'.repeat(64) },
      author: { user_id: 'alex', principal_id: null, run_id: null, connection_id: null, grant_id: null },
      occurred_at_server: 100, command_id: 'golden-command' }, reservation_id: null,
    receipt: { principal: 'alex', command_id: 'golden-command', request_digest: 'b'.repeat(64),
      outcome: { status: 'committed', object_id: 'shopping', revision: ref(1) } },
  },
};

test('golden replay preserves immutable bytes and exact human provenance', () => {
  const initial = emptyHouseholdObjectState('household', 'stream');
  const before = structuredClone(golden);
  const state = reduceHouseholdObjectStream([golden], initial);
  assert.deepEqual(state.objects.shopping, { object_id: 'shopping', kind: 'list', history: [{
    revision: ref(1), parent: null, title: 'Shopping', kind: 'list', file_metadata: null,
    blob: { storage_key: 'household/shopping/golden', size_bytes: 87, sha256: 'a'.repeat(64) },
    author: { user_id: 'alex', principal_id: null, run_id: null, connection_id: null, grant_id: null },
    occurred_at_server: 100, command_id: 'golden-command',
  }] });
  assert.deepEqual(initial.objects, {});
  assert.deepEqual(golden, before);
  assert.deepEqual(householdObjectUsage(state), { object_count: 1, storage_bytes: 87 });
  // Mutating a caller's returned read view cannot corrupt retained history.
  const read = readHouseholdObjects({ kind: 'object_read', object_id: 'shopping' }, state, access('blair'), 100);
  assert.equal(read.status, 'ok');
  if (read.status === 'ok' && read.kind === 'object_read') read.revision.title = 'changed';
  assert.equal(state.objects.shopping!.history[0]!.title, 'Shopping');
});

test('list patches keep stable IDs, checked state and deterministic order', () => {
  const { state, content } = createList();
  const patch: HouseholdPatch = { kind: 'list', operations: [
    ...(checkMilk.kind === 'list' ? checkMilk.operations : []),
    { kind: 'add', item_id: 'bread', text: 'Bread', checked: false, after_item_id: 'milk' },
    { kind: 'move', item_id: 'bread', before_order: 1, after_item_id: null },
    { kind: 'add', item_id: 'temporary', text: 'Delete me', checked: false, after_item_id: 'milk' },
    { kind: 'remove', item_id: 'temporary', before_text: 'Delete me', before_checked: false },
  ] };
  const proposed: HouseholdContent = { kind: 'list', items: [
    { item_id: 'bread', text: 'Bread', checked: false, order: 0 },
    { item_id: 'milk', text: 'Milk', checked: true, order: 1 },
  ] };
  const command = updateCommand(ref(1), patch);
  const snapshot = structuredClone(state);
  const decision = decideHouseholdObject(command, state, context(state, command, artifact(proposed, 'shopping', ref(1), 'v2'),
    { access: agent('blair'), contents: [content] }));
  assert.deepEqual(decision.outcome, { status: 'committed', object_id: 'shopping', revision: ref(2) });
  const next = reduceHouseholdObjectStream(decision.events, state);
  assert.deepEqual(state, snapshot);
  assert.equal(next.objects.shopping!.history.length, 2);
  assert.deepEqual(next.objects.shopping!.history[1]!.author,
    { user_id: 'blair', principal_id: 'agent-blair', run_id: 'run-1', connection_id: 'connection-blair', grant_id: 'grant-blair' });
  assert.deepEqual(next.objects.shopping!.history[1]!.parent, ref(1));
});

test('a stale write preserves a private draft, current history and merge references', () => {
  const { state, content } = createList();
  const command = updateCommand();
  const prepared = artifact(checkedMilk, 'shopping', ref(1), 'checked');
  const accepted = decideHouseholdObject(command, state, context(state, command, prepared, { contents: [content] }));
  assert.equal(accepted.outcome.status, 'committed', 'positive control');
  const current = reduceHouseholdObjectStream(accepted.events, state);
  const stale = decideHouseholdObject(command, current, context(current, command, prepared,
    { access: agent('blair'), contents: [content], draft_id: 'losing-draft' }));
  assert.deepEqual(stale.outcome, { status: 'conflict', object_id: 'shopping', current: ref(2), draft_id: 'losing-draft' });
  const conflicted = reduceHouseholdObjectStream(stale.events, current);
  assert.equal(conflicted.objects.shopping!.history.length, 2);
  assert.equal(conflicted.objects.shopping!.history[1]!.blob.storage_key, 'household/shopping/checked');
  assert.deepEqual(conflicted.drafts['losing-draft']!.base, ref(1));
  assert.deepEqual(conflicted.drafts['losing-draft']!.current, ref(2));
  assert.equal(conflicted.drafts['losing-draft']!.proposed.storage_key, 'household/shopping/checked');
  assert.equal(readHouseholdObjects({ kind: 'draft_read', draft_id: 'losing-draft' }, conflicted, agent('blair'), 100).status, 'ok');
  assert.equal(readHouseholdObjects({ kind: 'draft_read', draft_id: 'losing-draft' }, conflicted, access('blair'), 100).status, 'ok');
  assert.deepEqual(readHouseholdObjects({ kind: 'draft_read', draft_id: 'losing-draft' }, conflicted, access('alex'), 100),
    { status: 'refused', reason: 'draft_access_refused' });
  assert.deepEqual(householdObjectUsage(conflicted), { object_count: 1, storage_bytes: content.blob.size_bytes + 2 * prepared.blob.size_bytes });
});

test('upload reservation checks the base and commit catches a later writer', () => {
  const { state, content } = createList();
  const prepared = artifact(checkedMilk, 'shopping', ref(1), 'upload');
  const reserve: HouseholdObjectCommand = { kind: 'reserve_household_upload', object_id: 'shopping', reservation_id: 'upload',
    expires_at: 200, change: { kind: 'update', base: ref(1), patch: checkMilk } };
  const pending = decideHouseholdObject(reserve, state, context(state, reserve, prepared, { contents: [content] }));
  assert.deepEqual(pending.outcome, { status: 'pending', object_id: 'shopping', reservation_id: 'upload' });
  const reserved = reduceHouseholdObjectStream(pending.events, state);
  assert.equal(reserved.objects.shopping!.history.length, 1, 'pending is not committed');
  const commit: HouseholdObjectCommand = { kind: 'commit_household_upload', reservation_id: 'upload', operation: 'update' };
  const validCommit = decideHouseholdObject(commit, reserved, context(reserved, commit, prepared));
  assert.equal(validCommit.outcome.status, 'committed', 'positive control: same base');
  const competingCommand = updateCommand();
  const other = decideHouseholdObject(competingCommand, reserved, context(reserved, competingCommand, prepared,
    { access: access('blair'), contents: [content] }));
  const advanced = reduceHouseholdObjectStream(other.events, reserved);
  const stale = decideHouseholdObject(commit, advanced, context(advanced, commit, prepared));
  assert.equal(stale.outcome.status, 'conflict');
  const next = reduceHouseholdObjectStream(stale.events, advanced);
  assert.equal(next.objects.shopping!.history.length, 2);
  assert.deepEqual(next.reservations, {});
  assert.equal(Object.keys(next.drafts).length, 1);
  assert.deepEqual(householdObjectUsage(next), { object_count: 1, storage_bytes: content.blob.size_bytes + 2 * prepared.blob.size_bytes });
  const staleBegin = decideHouseholdObject(reserve, advanced, context(advanced, reserve, prepared,
    { access: access('blair'), contents: [content], command_id: 'new-reservation' }));
  assert.equal(staleBegin.outcome.status, 'conflict', 'reservation also refuses an old base');
});

test('opaque revisions bind both object and workspace; patch before values are checked', () => {
  const { state, content } = createList();
  const prepared = artifact(checkedMilk, 'shopping', ref(1));
  const valid = updateCommand();
  assert.equal(decideHouseholdObject(valid, state, context(state, valid, prepared, { contents: [content] })).outcome.status, 'committed');
  for (const base of [ref(1, 'another'), ref(1, 'shopping', 'personal'), { ...ref(1), token: '1' }, ref(99)]) {
    const command = updateCommand(base);
    assert.deepEqual(decideHouseholdObject(command, state, context(state, command, prepared, { contents: [content] })).outcome,
      { status: 'refused', reason: 'revision_not_found' });
  }
  const wrongBefore: HouseholdPatch = { kind: 'list', operations: [
    { kind: 'set', item_id: 'milk', before_text: 'old copy', before_checked: false, text: 'Milk', checked: true },
  ] };
  const command = updateCommand(ref(1), wrongBefore);
  assert.deepEqual(decideHouseholdObject(command, state, context(state, command, prepared, { contents: [content] })).outcome,
    { status: 'refused', reason: 'patch_base_mismatch' });
});

test('membership and per-person boundaries refuse every read model before disclosure', () => {
  const { state, content } = createList();
  const queries = [
    { kind: 'object_list', offset: 0, limit: 10 },
    { kind: 'object_read', object_id: 'shopping' },
    { kind: 'object_history', object_id: 'shopping', offset: 0, limit: 10 },
  ] as const;
  for (const query of queries) {
    assert.equal(readHouseholdObjects(query, state, access('blair'), 100).status, 'ok', 'shared-member positive control');
    for (const denied of [{ ...access('blair'), member: null }, access('blair', 'personal-blair'),
      { ...access('blair'), member: { ...access('blair').member!, revoked_at: 99 } }]) {
      assert.deepEqual(readHouseholdObjects(query, state, denied, 100), { status: 'refused', reason: 'workspace_access_refused' });
    }
    const privateAlex = { ...access('alex'), boundary: { kind: 'personal' as const, owner_user_id: 'alex' } };
    assert.equal(readHouseholdObjects(query, state, privateAlex, 100).status, 'ok', 'owner personal-read control');
    assert.deepEqual(readHouseholdObjects(query, state, { ...access('blair'), boundary: privateAlex.boundary }, 100),
      { status: 'refused', reason: 'workspace_access_refused' }, 'even a membership row cannot imply private access');
  }
  const command = updateCommand();
  assert.equal(decideHouseholdObject(command, state, context(state, command, artifact(checkedMilk, 'shopping', ref(1)),
    { access: access('blair'), contents: [content] })).outcome.status, 'committed', 'member write positive control');
  const deniedWrite = decideHouseholdObject(command, state, context(state, command, artifact(checkedMilk, 'shopping', ref(1)),
    { access: { ...access('blair'), member: null }, contents: [content] }));
  assert.deepEqual(deniedWrite.outcome, { status: 'refused', reason: 'workspace_access_refused' });
  assert.deepEqual(deniedWrite.events, [], 'authorization failure is not a household domain event');
});

test('agents inherit their human ceiling and exact consented connection operations', () => {
  const { state, content } = createList();
  const command = updateCommand();
  const prepared = artifact(checkedMilk, 'shopping', ref(1));
  const reader = { ...access('blair'), member: { ...access('blair').member!, content_role: 'reader' as const } };
  assert.equal(readHouseholdObjects({ kind: 'object_read', object_id: 'shopping' }, state, reader, 100).status, 'ok');
  assert.deepEqual(decideHouseholdObject(command, state, context(state, command, prepared, { access: reader, contents: [content] })).outcome,
    { status: 'refused', reason: 'content_read_only' });
  const readerAgent = { ...agent('blair'), member: reader.member };
  assert.deepEqual(decideHouseholdObject(command, state, context(state, command, prepared, { access: readerAgent, contents: [content] })).outcome,
    { status: 'refused', reason: 'content_read_only' });
  const authorized = agent('blair');
  assert.equal(decideHouseholdObject(command, state, context(state, command, prepared, { access: authorized, contents: [content] })).outcome.status, 'committed');
  assert.equal(authorized.credential.kind, 'agent');
  if (authorized.credential.kind !== 'agent') return;
  authorized.credential.connection.expires_at = null;
  assert.equal(decideHouseholdObject(command, state, context(state, command, prepared, { access: authorized, contents: [content] })).outcome.status, 'committed');
  for (const connection of [
    { ...authorized.credential.connection, revoked_at: 99 },
    { ...authorized.credential.connection, expires_at: NaN },
    { ...authorized.credential.connection, expires_at: Infinity },
    { ...authorized.credential.connection, expires_at: 99 },
    { ...authorized.credential.connection, expires_at: 100 },
    { ...authorized.credential.connection, workspace_id: 'personal-blair' },
    { ...authorized.credential.connection, owner_user_id: 'alex' },
    { ...authorized.credential.connection, operations: ['read'] as const },
    { ...authorized.credential.connection, purpose: 'personal' as const },
  ]) {
    assert.deepEqual(decideHouseholdObject(command, state, context(state, command, prepared,
      { access: { ...authorized, credential: { kind: 'agent', connection } }, contents: [content] })).outcome,
    { status: 'refused', reason: 'connection_access_refused' });
  }
  const noConsent = { ...access(), member: { ...access().member!, content_consent_id: null } };
  assert.deepEqual(readHouseholdObjects({ kind: 'object_read', object_id: 'shopping' }, state, noConsent, 100),
    { status: 'refused', reason: 'content_consent_required' });
});

test('separate personal workspaces require their owner and a separately bound private connection', () => {
  const privateRef = ref(1, 'shopping', 'personal-alex');
  const privateEvent: HouseholdObjectEvent = { ...golden, workspace_id: 'personal-alex', stream_id: 'private-stream',
    payload: { ...golden.payload,
      revision: { ...golden.payload.revision, revision: privateRef,
        blob: { ...golden.payload.revision.blob, storage_key: 'personal-alex/private' } },
      receipt: { ...golden.payload.receipt, outcome: { status: 'committed', object_id: 'shopping', revision: privateRef } },
    } };
  const personal = reduceHouseholdObjectStream([privateEvent], emptyHouseholdObjectState('personal-alex', 'private-stream'));
  const alex = { ...access('alex', 'personal-alex'), boundary: { kind: 'personal' as const, owner_user_id: 'alex' } };
  const privateAgent = { ...agent('alex', 'personal-alex'), boundary: alex.boundary };
  if (privateAgent.credential.kind !== 'agent') throw new Error('fixture');
  privateAgent.credential.connection.purpose = 'personal';
  for (const query of [
    { kind: 'object_list', offset: 0, limit: 10 },
    { kind: 'object_read', object_id: 'shopping', revision: privateRef },
    { kind: 'object_history', object_id: 'shopping', offset: 0, limit: 10 },
  ] as const) {
    assert.equal(readHouseholdObjects(query, personal, alex, 100).status, 'ok');
    assert.equal(readHouseholdObjects(query, personal, privateAgent, 100).status, 'ok');
    assert.deepEqual(readHouseholdObjects(query, personal, agent('alex'), 100),
      { status: 'refused', reason: 'workspace_access_refused' }, 'even the owner cannot reuse a shared connection');
    assert.deepEqual(readHouseholdObjects(query, personal, { ...access('blair', 'personal-alex'), boundary: alex.boundary }, 100),
      { status: 'refused', reason: 'workspace_access_refused' }, 'a second human and their administration imply no private rights');
  }
});

test('request-digest retries recover one recorded outcome and cannot bypass revocation', () => {
  const { state, content } = createList();
  const command = updateCommand();
  const prepared = artifact(checkedMilk, 'shopping', ref(1));
  const ctx = context(state, command, prepared, { contents: [content] });
  const accepted = decideHouseholdObject(command, state, ctx);
  assert.equal(accepted.outcome.status, 'committed');
  const next = reduceHouseholdObjectStream(accepted.events, state);
  const retry = decideHouseholdObject(command, next, { ...ctx, seq: next.last_seq + 1, prepared: null, contents: [] });
  assert.deepEqual(retry, { outcome: { status: 'committed', object_id: 'shopping', revision: ref(2) }, events: [], replayed: true });
  const changed = decideHouseholdObject(command, next, { ...ctx, seq: next.last_seq + 1, request_digest: sha('changed patch') });
  assert.deepEqual(changed.outcome, { status: 'refused', reason: 'request_id_reused' });
  const revoked = decideHouseholdObject(command, next, { ...ctx, seq: next.last_seq + 1,
    access: { ...access(), member: { ...access().member!, revoked_at: 99 } } });
  assert.deepEqual(revoked.outcome, { status: 'refused', reason: 'workspace_access_refused' });
  assert.equal(next.objects.shopping!.history.length, 2);
});

test('retired revisions remain readable and count against quota after 21 commits', () => {
  const created = createList();
  let state = created.state;
  let baseContent = created.content;
  const events = [...created.events];
  let expectedBytes = baseContent.blob.size_bytes;
  for (let n = 2; n <= 21; n++) {
    const value = n % 2 === 0;
    const command = updateCommand(ref(n - 1), { kind: 'list', operations: [
      { kind: 'set', item_id: 'milk', before_text: 'Milk', before_checked: !value, text: 'Milk', checked: value },
    ] });
    const proposed: HouseholdContent = { kind: 'list', items: [{ item_id: 'milk', text: 'Milk', order: 0, checked: value }] };
    const prepared = artifact(proposed, 'shopping', ref(n - 1), `v${n}`);
    const decision = decideHouseholdObject(command, state, context(state, command, prepared, { contents: [baseContent] }));
    assert.equal(decision.outcome.status, 'committed');
    events.push(...decision.events);
    state = reduceHouseholdObjectStream(decision.events, state);
    baseContent = { ...prepared, revision: ref(n) };
    expectedBytes += prepared.blob.size_bytes;
  }
  assert.equal(state.objects.shopping!.history.length, 21);
  const history = readHouseholdObjects({ kind: 'object_history', object_id: 'shopping', offset: 0, limit: 21 }, state, access('blair'), 100);
  assert.equal(history.status, 'ok');
  if (history.status !== 'ok' || history.kind !== 'object_history') return;
  assert.equal(history.revisions.filter((revision) => revision.live).length, 20);
  assert.equal(history.revisions[0]!.live, false);
  assert.deepEqual(history.revisions[20]!.parent, ref(20));
  const old = readHouseholdObjects({ kind: 'object_read', object_id: 'shopping', revision: ref(1) }, state, access('blair'), 100);
  assert.equal(old.status, 'ok');
  if (old.status === 'ok' && old.kind === 'object_read') assert.equal(old.revision.blob.storage_key, 'household/shopping/bytes');
  assert.equal(householdObjectUsage(state).storage_bytes, expectedBytes);
  const replay = reduceHouseholdObjectStream(events, emptyHouseholdObjectState('household', 'stream'));
  assert.deepEqual(replay.objects.shopping!.history.map((revision) => revision.revision.token), Array.from({ length: 21 }, (_, i) => token(i + 1)));
  assert.equal(householdObjectUsage(replay).storage_bytes, expectedBytes);
});

test('proposed quota and attempt ceilings use inclusive boundaries without deleting history', () => {
  const { state, content } = createList();
  const command = updateCommand();
  const prepared = artifact(checkedMilk, 'shopping', ref(1));
  const exactRoom = 1073741824 - content.blob.size_bytes - prepared.blob.size_bytes;
  const allowed = context(state, command, prepared, { contents: [content], other_storage_bytes: exactRoom,
    identity_write_attempts: 599, workspace_write_attempts: 1999 });
  assert.equal(decideHouseholdObject(command, state, allowed).outcome.status, 'committed', 'exact 1 GiB positive control');
  for (const [overrides, reason] of [
    [{ other_storage_bytes: exactRoom + 1 }, 'storage_quota_reached'],
    [{ identity_write_attempts: 600 }, 'object_write_rate_limited'],
    [{ workspace_write_attempts: 2000 }, 'object_write_rate_limited'],
    [{ other_storage_bytes: -1 }, 'quota_facts_invalid'],
  ] as const) assert.deepEqual(decideHouseholdObject(command, state, { ...allowed, ...overrides }).outcome, { status: 'refused', reason });
  const newCommand: HouseholdObjectCommand = { kind: 'create_household_object', object_id: 'doc', title: 'Notes', content: { kind: 'doc', markdown: 'hello' } };
  const newPrepared = artifact({ kind: 'doc', markdown: 'hello' }, 'doc');
  assert.equal(decideHouseholdObject(newCommand, state, context(state, newCommand, newPrepared, { other_object_count: 498 })).outcome.status, 'committed');
  assert.deepEqual(decideHouseholdObject(newCommand, state, context(state, newCommand, newPrepared, { other_object_count: 499 })).outcome,
    { status: 'refused', reason: 'object_quota_reached' });
  assert.equal(state.objects.shopping!.history.length, 1);
});

test('doc splices update exact base text; large doc bytes stay outside event bodies', () => {
  const initial = emptyHouseholdObjectState('household', 'stream');
  const doc: HouseholdContent = { kind: 'doc', markdown: 'Hello world' };
  const create: HouseholdObjectCommand = { kind: 'create_household_object', object_id: 'doc', title: 'Notes', content: doc };
  const prepared = artifact(doc, 'doc');
  const first = decideHouseholdObject(create, initial, context(initial, create, prepared));
  assert.equal(first.outcome.status, 'committed');
  const state = reduceHouseholdObjectStream(first.events, initial);
  const edit: HouseholdObjectCommand = { kind: 'update_household_object', object_id: 'doc', base: ref(1, 'doc'),
    patch: { kind: 'doc', splices: [{ start: 6, before: 'world', after: 'household' }] } };
  const edited = artifact({ kind: 'doc', markdown: 'Hello household' }, 'doc', ref(1, 'doc'), 'v2');
  const facts = { contents: [{ ...prepared, revision: ref(1, 'doc') }] };
  assert.equal(decideHouseholdObject(edit, state, context(state, edit, edited, facts)).outcome.status, 'committed');
  const wrong: HouseholdObjectCommand = { ...edit, patch: { kind: 'doc', splices: [{ start: 6, before: 'yesterday', after: 'household' }] } };
  assert.deepEqual(decideHouseholdObject(wrong, state, context(state, wrong, edited, facts)).outcome,
    { status: 'refused', reason: 'patch_base_mismatch' });
  const large = artifact({ kind: 'doc', markdown: 'x'.repeat(100000) }, 'large-doc');
  const largeCreate: HouseholdObjectCommand = { kind: 'create_household_object', object_id: 'large-doc', title: 'Large', content: large.content };
  const decision = decideHouseholdObject(largeCreate, state, context(state, largeCreate, large));
  assert.equal(decision.outcome.status, 'committed');
  assert.ok(Buffer.byteLength(JSON.stringify(decision.events)) < 65536);
  assert.equal(JSON.stringify(decision.events).includes('x'.repeat(100)), false);
});

test('file reservation admits create-only grants, checks verified artifacts and rechecks revocation at commit', () => {
  const initial = emptyHouseholdObjectState('household', 'stream');
  const file: HouseholdContent = { kind: 'file', name: 'receipt.txt', media_type: 'text/plain' };
  const prepared = artifact(file, 'receipt');
  prepared.blob.size_bytes = 26214400; // Adapter-verified 25 MiB file, exact proposed boundary.
  const reserve: HouseholdObjectCommand = { kind: 'reserve_household_upload', object_id: 'receipt', reservation_id: 'file-upload', expires_at: 200,
    change: { kind: 'create', title: 'Receipt', content: file } };
  const identity = agent();
  if (identity.credential.kind !== 'agent') throw new Error('fixture');
  identity.credential.connection.operations = ['create'];
  const pending = decideHouseholdObject(reserve, initial, context(initial, reserve, prepared, { access: identity }));
  assert.equal(pending.outcome.status, 'pending');
  const state = reduceHouseholdObjectStream(pending.events, initial);
  const commit: HouseholdObjectCommand = { kind: 'commit_household_upload', reservation_id: 'file-upload', operation: 'create' };
  const committed = decideHouseholdObject(commit, state, context(state, commit, prepared, { access: identity }));
  assert.equal(committed.outcome.status, 'committed');
  const complete = reduceHouseholdObjectStream(committed.events, state);
  assert.equal(complete.objects.receipt!.history[0]!.blob.size_bytes, 26214400);
  assert.deepEqual(complete.objects.receipt!.history[0]!.file_metadata, { kind: 'file', name: 'receipt.txt', media_type: 'text/plain' });
  assert.deepEqual(complete.reservations, {});
  const revoked = structuredClone(identity);
  if (revoked.credential.kind !== 'agent') throw new Error('fixture');
  revoked.credential.connection.revoked_at = 99;
  assert.deepEqual(decideHouseholdObject(commit, state, context(state, commit, prepared, { access: revoked })).outcome,
    { status: 'refused', reason: 'connection_access_refused' });
  assert.deepEqual(decideHouseholdObject(commit, state, context(state, commit, { ...prepared, blob: { ...prepared.blob, sha256: 'f'.repeat(64) } },
    { access: identity })).outcome, { status: 'refused', reason: 'verified_content_required' });
  const tooLarge = { ...prepared, blob: { ...prepared.blob, size_bytes: 26214401 } };
  assert.deepEqual(decideHouseholdObject(reserve, initial, context(initial, reserve, tooLarge, { access: identity })).outcome,
    { status: 'refused', reason: 'verified_content_required' });
});

test('expiration does not silently free reserved bytes; an explicit release does', () => {
  const { state, content } = createList();
  const prepared = artifact(checkedMilk, 'shopping', ref(1));
  const reserve: HouseholdObjectCommand = { kind: 'reserve_household_upload', object_id: 'shopping', reservation_id: 'upload', expires_at: 200,
    change: { kind: 'update', base: ref(1), patch: checkMilk } };
  const pending = decideHouseholdObject(reserve, state, context(state, reserve, prepared, { contents: [content] }));
  const reserved = reduceHouseholdObjectStream(pending.events, state);
  const commit: HouseholdObjectCommand = { kind: 'commit_household_upload', reservation_id: 'upload', operation: 'update' };
  assert.equal(decideHouseholdObject(commit, reserved, context(reserved, commit, prepared, { now: 199 })).outcome.status, 'committed');
  assert.deepEqual(decideHouseholdObject(commit, reserved, context(reserved, commit, prepared, { now: 200 })).outcome,
    { status: 'refused', reason: 'upload_expired' });
  assert.equal(householdObjectUsage(reserved).storage_bytes, content.blob.size_bytes + prepared.blob.size_bytes);
  const release: HouseholdObjectCommand = { kind: 'release_household_upload', reservation_id: 'upload', operation: 'update' };
  const released = decideHouseholdObject(release, reserved, context(reserved, release, null, { now: 200 }));
  assert.deepEqual(released.outcome, { status: 'released', reservation_id: 'upload' });
  const next = reduceHouseholdObjectStream(released.events, reserved);
  assert.deepEqual(next.reservations, {});
  assert.equal(householdObjectUsage(next).storage_bytes, content.blob.size_bytes);
});

test('file replacement checks its exact byte digest, preserves metadata and retains old versions', () => {
  const initial = emptyHouseholdObjectState('household', 'stream');
  const file: HouseholdContent = { kind: 'file', name: 'notes.txt', media_type: 'text/plain' };
  const firstBlob = artifact(file, 'file', null, 'original');
  const create: HouseholdObjectCommand = { kind: 'create_household_object', object_id: 'file', title: 'Notes', content: file };
  const created = decideHouseholdObject(create, initial, context(initial, create, firstBlob));
  assert.equal(created.outcome.status, 'committed');
  const state = reduceHouseholdObjectStream(created.events, initial);
  const replacement: HouseholdContent = { kind: 'file', name: 'notes.md', media_type: 'text/markdown' };
  const prepared = artifact(replacement, 'file', ref(1, 'file'), 'replacement');
  const update: HouseholdObjectCommand = { kind: 'update_household_object', object_id: 'file', base: ref(1, 'file'),
    patch: { kind: 'file', before_sha256: firstBlob.blob.sha256, replacement } };
  const verifiedBase = { ...firstBlob, revision: ref(1, 'file') };
  const accepted = decideHouseholdObject(update, state, context(state, update, prepared, { contents: [verifiedBase] }));
  assert.equal(accepted.outcome.status, 'committed');
  const next = reduceHouseholdObjectStream(accepted.events, state);
  assert.deepEqual(next.objects.file!.history.map(revision => revision.file_metadata), [
    { kind: 'file', name: 'notes.txt', media_type: 'text/plain' },
    { kind: 'file', name: 'notes.md', media_type: 'text/markdown' },
  ]);
  assert.deepEqual(next.objects.file!.history.map(revision => revision.blob.storage_key), ['household/file/original', 'household/file/replacement']);
  const badDigest: HouseholdObjectCommand = { ...update, patch: { kind: 'file', before_sha256: '0'.repeat(64), replacement } };
  assert.deepEqual(decideHouseholdObject(badDigest, state, context(state, badDigest, prepared, { contents: [verifiedBase] })).outcome,
    { status: 'refused', reason: 'patch_base_mismatch' });
  const conflict = decideHouseholdObject(update, next, context(next, update, prepared, { access: access('blair'), contents: [verifiedBase] }));
  assert.equal(conflict.outcome.status, 'conflict');
});

test('replay halts on corrupt bindings, unknown types, schemas and duplicate sequences', () => {
  const initial = emptyHouseholdObjectState('household', 'stream');
  assert.equal(reduceHouseholdObject(initial, golden).objects.shopping!.history.length, 1, 'positive control');
  for (const bad of [
    { ...golden, schema_version: 999 }, { ...golden, workspace_id: 'personal-alex' },
    { ...golden, stream_id: 'foreign-stream' },
    { ...golden, payload: { ...golden.payload, revision: { ...golden.payload.revision, parent: ref(99) } } },
    { ...golden, payload: { ...golden.payload, revision: { ...golden.payload.revision, revision: ref(1, 'shopping', 'personal-alex') } } },
  ]) assert.throws(() => reduceHouseholdObject(initial, bad as HouseholdObjectEvent), StreamIntegrityError);
  assert.throws(() => reduceHouseholdObject(initial, { ...golden, type: 'UnknownHouseholdEvent' } as unknown as HouseholdObjectEvent), UnknownEventTypeError);
  assert.throws(() => reduceHouseholdObjectStream([golden, golden], initial), StreamIntegrityError);
});
