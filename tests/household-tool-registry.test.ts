import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  HOUSEHOLD_CONTENT_CONSENT, HOUSEHOLD_TOOLS, householdToolInvocation,
  householdToolOperation, HouseholdToolInputError, validateHouseholdToolArguments, validateHouseholdHumanCommand,
  type HouseholdToolName,
} from '../src/protocol/household-tool-registry.js';
import {
  decideHouseholdObject, emptyHouseholdObjectState, readHouseholdObjects, reduceHouseholdObjectStream,
  type DecideHouseholdObjectContext, type HouseholdObjectCommand, type HouseholdVerifiedContent,
} from '../src/protocol/household-objects.js';
import { householdAccessRefusal, type HouseholdAccessFacts } from '../src/protocol/household-object-policy.js';
import type { HouseholdContent, HouseholdObjectState, HouseholdRevisionRef } from '../src/protocol/household-object-events.js';

const seat = `seat_${'a'.repeat(22)}`;
const workspace = 'household';
const ref = (object_id: string, n = 1): HouseholdRevisionRef => ({ workspace_id: workspace, object_id, token: `revision_${String(n).padStart(24, '0')}` });
const file: HouseholdContent = { kind: 'file', name: 'notes.txt', media_type: 'text/plain' };
const list: HouseholdContent = { kind: 'list', items: [{ item_id: 'milk', text: 'Milk', checked: false, order: 0 }] };
const checked: HouseholdContent = { kind: 'list', items: [{ item_id: 'milk', text: 'Milk', checked: true, order: 0 }] };
const patch = { kind: 'list', operations: [{ kind: 'set', item_id: 'milk', before_text: 'Milk', before_checked: false, text: 'Milk', checked: true }] };
const host = { workspace_id: workspace, upload: { reservation_id: 'upload-1', expires_at: 1000 } };
const request = { seat, request_id: 'request_1' };

// Independent spec examples: expectations below do not come from registry rows.
const examples: Record<HouseholdToolName, Record<string, unknown>> = {
  object_list: { seat, offset: 0, limit: 10 },
  object_read: { seat, object_id: 'shopping', revision: ref('shopping') },
  object_history: { seat, object_id: 'shopping', offset: 0, limit: 10 },
  object_create: { ...request, object_id: 'wiki', title: 'Household notes', content: { kind: 'doc', markdown: '# Notes' } },
  object_update: { ...request, object_id: 'shopping', base: ref('shopping'), patch },
  file_read: { seat, object_id: 'file', revision: ref('file', 2) },
  file_upload_begin: { ...request, object_id: 'new-file', change: { kind: 'create', title: 'Attachment', content: file } },
  file_upload_commit: { ...request, reservation_id: 'upload-1', operation: 'create' },
  todo_list: { seat, scope: 'open', offset: 0, limit: 50 },
  todo_read: { seat, todo_id: '00000000-0000-4000-8000-000000000001', comment_offset: 0 },
  todo_queue: { seat, section: 'up_next', offset: 0, limit: 50 },
  comment_list: { seat, target: { kind: 'doc', id: 'recipes' }, offset: 0, limit: 20 },
  todo_create: { ...request, title: 'Buy bread', notes: 'Plain text', due_on: null },
  todo_comment: { ...request, target: { kind: 'doc', id: 'recipes' }, body: 'Try this', mentions: [] },
  todo_update: { ...request, todo_id: '00000000-0000-4000-8000-000000000001', base_version: 1, notes: 'Updated' },
  todo_assign: { ...request, todo_id: '00000000-0000-4000-8000-000000000001', base_version: 1, to: null },
  todo_start: { ...request },
  todo_set_state: { ...request, todo_id: '00000000-0000-4000-8000-000000000001', base_version: 1, state: 'done' },
};
const contracts = [
  ['object_list', 'object_list', 'read', true],
  ['object_read', 'object_read', 'read', true],
  ['object_history', 'object_history', 'read', true],
  ['object_create', 'create_household_object', 'create', false],
  ['object_update', 'update_household_object', 'update', false],
  ['file_read', 'object_read', 'read', true],
  ['file_upload_begin', 'reserve_household_upload', 'create', false],
  ['file_upload_commit', 'commit_household_upload', 'create', false],
] as const;

test('all eighteen tool contracts validate and map to lane 1 with spec hints and rights', () => {
  assert.equal(HOUSEHOLD_TOOLS.length, 18);
  assert.equal(new Set(HOUSEHOLD_TOOLS.map((tool) => tool.name)).size, 18);
  for (const [name, kind, permission, readOnlyHint] of contracts) {
    assert.deepEqual(validateHouseholdToolArguments(name, examples[name]), examples[name]);
    const invocation = householdToolInvocation(name, examples[name], host);
    assert.equal(('query' in invocation ? invocation.query : invocation.command).kind, kind);
    assert.equal(invocation.operation, permission);
    assert.equal(invocation.workspace_id, workspace);
    assert.equal(invocation.seat, seat);
    assert.equal(invocation.request_id, readOnlyHint ? undefined : 'request_1');
    assert.deepEqual(HOUSEHOLD_TOOLS.find((tool) => tool.name === name)!.annotations, {
      title: HOUSEHOLD_TOOLS.find((tool) => tool.name === name)!.title,
      readOnlyHint, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    });
  }
  assert.deepEqual(householdToolInvocation('object_read', { seat, object_id: 'shopping' }, host).objectTypes, ['list', 'doc']);
  assert.deepEqual(householdToolInvocation('file_read', examples.file_read, host).objectTypes, ['file']);
});

function refused(name: string, value: unknown, code = 'invalid_arguments'): void {
  assert.throws(() => validateHouseholdToolArguments(name, value), (error: unknown) =>
    error instanceof HouseholdToolInputError && error.code === code);
}

test('malformed input and authority/transport injection are refused with valid controls', () => {
  for (const [name] of contracts) {
    validateHouseholdToolArguments(name, examples[name]);
    for (const value of [null, [], 'arguments', 1, true]) refused(name, value);
    const { seat: _seat, ...missingSeat } = examples[name];
    refused(name, missingSeat);
    refused(name, { ...examples[name], seat: 'other-agent' });
    for (const key of ['workspace_id', 'grant_id', 'principal_id', 'storage_key', 'url', 'path', 'file_bytes', 'sha256', 'size_bytes']) {
      refused(name, { ...examples[name], [key]: 'attacker-supplied' });
    }
  }
  refused('unknown_secret_value', {}, 'unknown_tool');
  for (const name of ['object_create', 'object_update', 'file_upload_begin', 'file_upload_commit'] as const) {
    const { request_id: _request, ...missingRequest } = examples[name];
    refused(name, missingRequest);
    for (const request_id of ['', 'short', 'a'.repeat(73), 'bad request', null]) refused(name, { ...examples[name], request_id });
    validateHouseholdToolArguments(name, { ...examples[name], request_id: 'a'.repeat(72) });
  }
  for (const name of ['object_list', 'object_history'] as const) {
    for (const offset of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '0']) refused(name, { ...examples[name], offset });
    for (const limit of [0, -1, 1.5, Infinity, '10']) refused(name, { ...examples[name], limit });
    validateHouseholdToolArguments(name, { ...examples[name], offset: 1, limit: 1 });
  }
  refused('object_create', { ...examples.object_create, content: file });
  refused('object_create', { ...examples.object_create, object_id: '😀'.repeat(128) });
  validateHouseholdToolArguments('object_create', { ...examples.object_create, object_id: '😀'.repeat(127) + 'a' });
  refused('object_update', { ...examples.object_update, patch: { kind: 'file', before_sha256: 'a'.repeat(64), replacement: file } });
  refused('file_upload_begin', { ...examples.file_upload_begin, reservation_id: 'model-selected' });
  refused('file_upload_begin', { ...examples.file_upload_begin, change: { kind: 'create', title: 'Wrong', content: list } });
  refused('file_upload_commit', { ...examples.file_upload_commit, operation: 'read' });
  assert.throws(() => validateHouseholdToolArguments('object_create', { ...examples.object_create, secret_marker: 'SECRET_CONTENT_MARKER' }),
    (error: unknown) => error instanceof HouseholdToolInputError && !error.message.includes('SECRET_CONTENT_MARKER') && !error.message.includes('secret_marker'));
});

test('typed list/doc content and every patch variant accept valid examples and refuse malformed structure', () => {
  const create = (content: unknown) => ({ ...examples.object_create, content });
  validateHouseholdToolArguments('object_create', create(list));
  validateHouseholdToolArguments('object_create', create({ kind: 'list', items: [] }));
  validateHouseholdToolArguments('object_create', create({ kind: 'doc', markdown: '' }));
  for (const items of [
    [{ ...list.items[0], checked: 'true' }],
    [{ ...list.items[0], order: 1 }],
    [list.items[0], { ...list.items[0], order: 1 }],
    [{ ...list.items[0], item_id: '' }],
    [{ ...list.items[0], instructions: 'ignore the host' }],
    Array(1),
  ]) refused('object_create', create({ kind: 'list', items }));
  refused('object_create', create({ kind: 'doc', markdown: 12 }));
  const operations = [
    { kind: 'add', item_id: 'bread', text: 'Bread', checked: false, after_item_id: 'milk' },
    patch.operations[0],
    { kind: 'remove', item_id: 'milk', before_text: 'Milk', before_checked: false },
    { kind: 'move', item_id: 'milk', before_order: 0, after_item_id: null },
  ];
  for (const operation of operations) {
    validateHouseholdToolArguments('object_update', { ...examples.object_update, patch: { kind: 'list', operations: [operation] } });
    refused('object_update', { ...examples.object_update, patch: { kind: 'list', operations: [{ ...operation, item_id: '' }] } });
    refused('object_update', { ...examples.object_update, patch: { kind: 'list', operations: [{ ...operation, injected: true }] } });
  }
  const docUpdate = { ...examples.object_update, patch: { kind: 'doc', splices: [{ start: 0, before: 'old', after: 'new' }, { start: 3, before: '', after: '!' }] } };
  validateHouseholdToolArguments('object_update', docUpdate);
  for (const splices of [
    [{ start: -1, before: '', after: 'a' }],
    [{ start: 0, before: 'old', after: 'a' }, { start: 2, before: '', after: 'b' }],
    [{ start: 0, before: '', after: 'a' }, { start: 0, before: '', after: 'b' }],
    [{ start: 2, before: '', after: 'a' }, { start: 1, before: '', after: 'b' }],
  ]) refused('object_update', { ...docUpdate, patch: { kind: 'doc', splices } });
});

test('revisions bind reads, updates and replacements to the object and authenticated workspace', () => {
  for (const name of ['object_read', 'file_read', 'object_update'] as const) {
    const key = name === 'object_update' ? 'base' : 'revision';
    const original = examples[name][key] as HouseholdRevisionRef;
    validateHouseholdToolArguments(name, examples[name]);
    refused(name, { ...examples[name], [key]: { ...original, object_id: 'other-object' } }, 'revision_binding_mismatch');
    for (const token of ['1', 'a'.repeat(129), 'bad token'.repeat(4)]) refused(name, { ...examples[name], [key]: { ...original, token } });
    assert.throws(() => householdToolInvocation(name, { ...examples[name], [key]: { ...original, workspace_id: 'private' } }, host),
      (error: unknown) => error instanceof HouseholdToolInputError && error.code === 'revision_binding_mismatch');
  }
  const replacement = { ...request, object_id: 'file', change: { kind: 'update', base: ref('file', 2),
    patch: { kind: 'file', before_sha256: 'a'.repeat(64), replacement: file }, title: { before: 'File', after: 'Renamed' } } };
  assert.equal(householdToolOperation('file_upload_begin', replacement), 'update');
  assert.equal(householdToolOperation('file_upload_commit', { ...examples.file_upload_commit, operation: 'update' }), 'update');
  const begin = householdToolInvocation('file_upload_begin', replacement, host);
  assert.deepEqual('command' in begin && begin.command, { kind: 'reserve_household_upload', object_id: 'file', ...host.upload, change: replacement.change });
  refused('file_upload_begin', { ...replacement, change: { ...replacement.change, base: ref('other') } }, 'revision_binding_mismatch');
  assert.throws(() => householdToolInvocation('file_upload_begin', replacement, { workspace_id: 'private', upload: host.upload }), HouseholdToolInputError);
  assert.throws(() => householdToolInvocation('file_upload_begin', examples.file_upload_begin, { workspace_id: workspace }), HouseholdToolInputError);
});

function access(): HouseholdAccessFacts {
  return { workspace_id: workspace, archived_at: null, boundary: { kind: 'shared' },
    actor: { user_id: 'alex', principal_id: null, run_id: null }, credential: { kind: 'human' },
    member: { user_id: 'alex', workspace_id: workspace, revoked_at: null, content_role: 'editor', content_consent_id: 'confirmed' } };
}
function artifact(object_id: string, content: HouseholdContent, revision: HouseholdRevisionRef | null = null): HouseholdVerifiedContent {
  const bytes = content.kind === 'file' ? 'Synthetic file bytes' : JSON.stringify(content);
  return { workspace_id: workspace, object_id, revision, content,
    blob: { storage_key: `${workspace}/${object_id}/artifact`, size_bytes: Buffer.byteLength(bytes), sha256: createHash('sha256').update(bytes).digest('hex') } };
}
function context(state: HouseholdObjectState, command: HouseholdObjectCommand, prepared: HouseholdVerifiedContent | null,
  contents: readonly HouseholdVerifiedContent[] = []): DecideHouseholdObjectContext {
  return { access: access(), now: 100, command_id: `request_${state.last_seq + 2}`, request_digest: createHash('sha256').update(JSON.stringify(command)).digest('hex'),
    seq: state.last_seq + 1, event_id: `event-${state.last_seq + 2}`, revision_token: ref('', state.last_seq + 2).token, draft_id: `draft-${state.last_seq + 2}`,
    other_storage_bytes: 0, other_object_count: 0, identity_write_attempts: 0, workspace_write_attempts: 0, contents, prepared };
}

test('mapped calls execute the real core: reads preserve state; begin reserves; commit creates one revision', () => {
  let state = emptyHouseholdObjectState(workspace, 'stream');
  const baseList = artifact('shopping', list);
  const baseFile = artifact('file', file);
  // Independent seed commands avoid using the registry to arrange its own inputs.
  for (const prepared of [baseList, baseFile]) {
    const command: HouseholdObjectCommand = { kind: 'create_household_object', object_id: prepared.object_id, title: 'Seed', content: prepared.content };
    const result = decideHouseholdObject(command, state, context(state, command, prepared));
    assert.equal(result.outcome.status, 'committed');
    state = reduceHouseholdObjectStream(result.events, state);
  }
  const proposals: Partial<Record<HouseholdToolName, HouseholdVerifiedContent>> = {
    object_create: artifact('wiki', { kind: 'doc', markdown: '# Notes' }),
    object_update: artifact('shopping', checked, ref('shopping')),
    file_upload_begin: artifact('new-file', file), file_upload_commit: artifact('new-file', file),
  };
  for (const [name, , operation, readOnlyHint] of contracts) {
    const call = householdToolInvocation(name, readOnlyHint ? examples[name]
      : { ...examples[name], request_id: `request_${name}` }, host);
    const before = structuredClone(state);
    assert.equal(householdAccessRefusal(access(), workspace, call.operation, 100), null);
    const reader = access(); reader.member!.content_role = 'reader';
    assert.equal(householdAccessRefusal(reader, workspace, call.operation, 100), operation === 'read' ? null : 'content_read_only');
    if ('query' in call) {
      assert.ok(call.query.kind === 'object_list' || call.query.kind === 'object_read' || call.query.kind === 'object_history');
      const result = readHouseholdObjects(call.query, state, access(), 100);
      assert.equal(result.status, 'ok');
      if (result.status === 'ok' && result.kind === 'object_read') assert.ok(call.objectTypes.includes(result.revision.kind));
      assert.deepEqual(state, before);
      assert.equal(readOnlyHint, true);
    } else {
      assert.ok(call.command.kind === 'create_household_object' || call.command.kind === 'update_household_object' || call.command.kind === 'reserve_household_upload' || call.command.kind === 'commit_household_upload');
      const ctx = context(state, call.command, proposals[name]!, [{ ...baseList, revision: ref('shopping') }]);
      ctx.command_id = call.request_id!;
      const denied = decideHouseholdObject(call.command, state, { ...ctx, access: reader });
      assert.equal(denied.outcome.status, 'refused');
      assert.deepEqual(denied.events, []);
      const result = decideHouseholdObject(call.command, state, ctx);
      assert.equal(result.outcome.status, name === 'file_upload_begin' ? 'pending' : 'committed');
      assert.equal(result.events.length, 1);
      assert.equal(readOnlyHint, false);
      state = reduceHouseholdObjectStream(result.events, state);
      assert.notDeepEqual(state, before);
      if (name === 'file_upload_begin') {
        assert.equal(state.objects['new-file'], undefined);
        assert.equal(state.reservations['upload-1']!.object_id, 'new-file');
      }
      const retry = decideHouseholdObject(call.command, state, { ...ctx, seq: state.last_seq + 1 });
      assert.equal(retry.replayed, true);
      assert.deepEqual(retry.outcome, result.outcome);
      assert.deepEqual(retry.events, []);
    }
  }
  assert.equal(state.objects['new-file']!.history.length, 1);
  assert.equal(state.reservations['upload-1'], undefined);
  assert.equal(state.objects.shopping!.history.length, 2);
});

test('consent groups only the matching content tools and explains workspace audience and retained history', () => {
  const expected = {
    read: ['object_list', 'object_read', 'object_history', 'file_read', 'todo_list', 'todo_read', 'todo_queue', 'comment_list'],
    create: ['object_create', 'file_upload_begin', 'file_upload_commit', 'todo_create', 'todo_comment'],
    update: ['object_update', 'file_upload_begin', 'file_upload_commit', 'todo_update', 'todo_assign', 'todo_start', 'todo_set_state'],
  };
  assert.equal(HOUSEHOLD_CONTENT_CONSENT.length, 3);
  for (const consent of HOUSEHOLD_CONTENT_CONSENT) {
    assert.deepEqual(consent.tools.map((tool) => tool.name), expected[consent.operation]);
    assert.match(consent.description, /approved workspace/);
    assert.match(consent.description, /Members with access to Lists & docs can read committed content and history/);
    if (consent.operation !== 'read') {
      assert.match(consent.description, /confirmed editor role/);
      assert.match(consent.description, /pending until commit/);
    }
  }
});

test('replacement upload uses update permission at both boundaries and commits against the exact file base', () => {
  let state = emptyHouseholdObjectState(workspace, 'stream');
  const original = artifact('file', file);
  const seed: HouseholdObjectCommand = { kind: 'create_household_object', object_id: 'file', title: 'File', content: file };
  const seeded = decideHouseholdObject(seed, state, context(state, seed, original));
  assert.equal(seeded.outcome.status, 'committed');
  state = reduceHouseholdObjectStream(seeded.events, state);
  const base = ref('file');
  const replacement: HouseholdContent = { kind: 'file', name: 'renamed.txt', media_type: 'text/plain' };
  const prepared = artifact('file', replacement, base);
  prepared.blob.storage_key += '-replacement';
  const begin = householdToolInvocation('file_upload_begin', { ...request, object_id: 'file', change: {
    kind: 'update', base, patch: { kind: 'file', before_sha256: original.blob.sha256, replacement },
  } }, host);
  const commit = householdToolInvocation('file_upload_commit', { ...examples.file_upload_commit, request_id: 'request_commit', operation: 'update' }, host);
  const agent: HouseholdAccessFacts = { ...access(), actor: { user_id: 'alex', principal_id: 'agent-alex', run_id: 'run-1' },
    credential: { kind: 'agent', connection: { principal_id: 'agent-alex', owner_user_id: 'alex', workspace_id: workspace,
      connection_id: 'connection-1', grant_id: 'grant-1', revoked_at: null, expires_at: 1000, purpose: 'shared', operations: ['update'] } } };
  for (const [call, status] of [[begin, 'pending'], [commit, 'committed']] as const) {
    assert.ok('command' in call);
    assert.ok(call.command.kind === 'reserve_household_upload' || call.command.kind === 'commit_household_upload');
    assert.equal(call.operation, 'update');
    assert.equal(householdAccessRefusal(agent, workspace, call.operation, 100), null);
    const ctx = { ...context(state, call.command, prepared, [{ ...original, revision: base }]), command_id: call.request_id!, access: agent };
    const createOnly = structuredClone(agent);
    assert.equal(createOnly.credential.kind, 'agent');
    if (createOnly.credential.kind === 'agent') createOnly.credential.connection.operations = ['create'];
    assert.equal(householdAccessRefusal(createOnly, workspace, call.operation, 100), 'connection_access_refused');
    assert.deepEqual(decideHouseholdObject(call.command, state, { ...ctx, access: createOnly }).outcome,
      { status: 'refused', reason: 'connection_access_refused' });
    if (call.command.kind === 'commit_household_upload') {
      assert.deepEqual(decideHouseholdObject({ ...call.command, operation: 'create' }, state,
        { ...ctx, access: createOnly }).outcome, { status: 'refused', reason: 'reservation_access_refused' });
    }
    const result = decideHouseholdObject(call.command, state, ctx);
    assert.equal(result.outcome.status, status);
    state = reduceHouseholdObjectStream(result.events, state);
  }
  assert.equal(state.objects.file!.history.length, 2);
  assert.deepEqual(state.objects.file!.history[1]!.parent, base);
  assert.deepEqual(state.objects.file!.history[1]!.file_metadata, replacement);
});

// SERVER-PLAN C adds ten sibling tools: their independent examples exercise the
// advertised schema and mapping, without treating a to-do as a blob revision.
test('to-do tools map paged reads and versioned writes with content permissions', () => {
  const expected = [
    ['todo_list', 'read'], ['todo_read', 'read'], ['todo_queue', 'read'], ['comment_list', 'read'],
    ['todo_create', 'create'], ['todo_comment', 'create'], ['todo_update', 'update'],
    ['todo_assign', 'update'], ['todo_start', 'update'], ['todo_set_state', 'update'],
  ] as const;
  for (const [name, operation] of expected) {
    const invocation = householdToolInvocation(name, examples[name], host);
    const { seat: _seat, request_id: _request, ...fields } = examples[name];
    assert.deepEqual('query' in invocation ? invocation.query : invocation.command, { kind: name, ...fields });
    assert.deepEqual(invocation.objectTypes, ['todo']);
    assert.equal(invocation.operation, operation);
    assert.equal(invocation.request_id, operation === 'read' ? undefined : 'request_1');
    assert.match(HOUSEHOLD_TOOLS.find(row => row.name === name)!.description, /untrusted data/);
    refused(name, { ...examples[name], workspace_id: 'other' });
    if (operation !== 'read') { const { request_id: _id, ...missing } = examples[name]; refused(name, missing); }
  }
  for (const name of ['todo_list', 'todo_queue', 'comment_list'] as const) {
    validateHouseholdToolArguments(name, examples[name]);
    refused(name, { ...examples[name], limit: name === 'comment_list' ? 21 : 51 });
    refused(name, { ...examples[name], offset: -1 });
  }
  validateHouseholdToolArguments('todo_queue', { seat, principal_id: '00000000-0000-4000-8000-000000000001' });
  refused('todo_read', { ...examples.todo_read, comment_offset: -1 });
  refused('todo_comment', { ...examples.todo_comment, mentions: Array.from({ length: 9 }, () => ({ kind: 'user', id: '00000000-0000-4000-8000-000000000001' })) });
  assert.match(HOUSEHOLD_TOOLS.find(row => row.name === 'todo_start')!.description, /without locking anything/);
  for (const row of HOUSEHOLD_CONTENT_CONSENT) assert.match(row.description, /to-dos/);
});

test('human-only HTTP schemas refuse extra identity fields and invalid action or paging input', () => {
  const todo_id = '00000000-0000-4000-8000-000000000001';
  const valid = [
    { kind: 'household_todo_answer', todo_id, offer_id: todo_id, answer: 'accept' },
    { kind: 'household_todo_steer', todo_id, base_version: 1, action: { kind: 'move', after_todo_id: null } },
    { kind: 'household_agent_work_policy', principal_id: todo_id, accepts_from: 'owner' },
    { kind: 'household_activity', since: '2026-10-05T00:00:00Z', limit: 100 },
  ];
  for (const command of valid) {
    assert.deepEqual(validateHouseholdHumanCommand(command), command);
    assert.throws(() => validateHouseholdHumanCommand({ ...command, actor_user: todo_id }), HouseholdToolInputError);
  }
  for (const invalid of [
    { ...valid[1], action: { kind: 'move' } }, { ...valid[1], action: { kind: 'unknown' } },
    { ...valid[2], accepts_from: 'all' }, { ...valid[3], limit: 101 },
    { ...valid[0], answer: 'replaced' }, { kind: 'todo_start' },
  ]) assert.throws(() => validateHouseholdHumanCommand(invalid), HouseholdToolInputError);
});
