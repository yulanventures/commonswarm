import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import * as todos from '../src/protocol/household-todos.js';
import * as policy from '../src/protocol/household-todo-policy.js';
import * as accessPolicy from '../src/protocol/household-object-policy.js';
import { readHouseholdActivity } from '../supabase/functions/command/household-activity.js';
import { createHouseholdTodoStore } from '../supabase/functions/command/household-todos.js';
import { executeHouseholdSurface } from '../supabase/functions/command/household-integration.js';
const reserve = new URL('../supabase/household-todo-reserve/', import.meta.url);
const release = new URL('../deploy/release-proofs/household-todo/', import.meta.url);
test('to-do reserve and release contain all three exact SQL proofs', () => {
  const names = ['20261006000001-catalog.sql', '20261006000001-rollback-catalog.sql', '20261006000001-rollback.sql'];
  assert.deepEqual(readdirSync(reserve).filter(n => n.endsWith('.sql')).sort(), names);
  assert.deepEqual(readdirSync(release).filter(n => n.endsWith('.sql')).sort(), names);
  for (const name of names) assert.deepEqual(readFileSync(new URL(name, reserve)), readFileSync(new URL(name, release)), name);
});

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const workspace = id(1), user = id(2), principal = id(3), at = '2026-10-05T12:00:00.000Z';
type Row = Record<string, unknown>;
const measuredBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(JSON.stringify(value)), 'utf8');

// Static database records only: this port implements neither paging nor the
// response budget. The real adapter owns both. SQL/ACLs stay in the CI suite.
function readFixture(rows: Row[], comments: Row[] = [], agent: Row = {}, approval: Row = {}) {
  const tx = (async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const sql = parts.join('?');
    if (sql.includes('SELECT archived_at FROM swarm.workspaces')) return [{ archived_at: null }];
    if (sql.includes('SELECT purpose, owner_user_id')) return [{ purpose: 'shared', owner_user_id: user }];
    if (sql.includes('SELECT revoked_at FROM swarm.memberships')) return [{ revoked_at: null }];
    if (sql.includes('SELECT * FROM swarm.household_member_content_roles')) return [{ revoked_at: null, content_role: 'editor', content_consent_id: id(5) }];
    if (sql.includes('SELECT clock_timestamp() AS now')) return [{ now: at }];
    if (sql.includes('SELECT stream_id,last_seq')) return [{ stream_id: id(4), last_seq: 0 }];
    if (sql.includes('SELECT * FROM swarm.household_todos')) return rows;
    if (sql.includes('SELECT principal_id,accepts_from')) return [];
    if (sql.includes('SELECT * FROM swarm.household_comments')) {
      const offset = Number(values.at(-2)), limit = Number(values.at(-1));
      return comments.slice(offset, offset + limit);
    }
    if (sql.includes('SELECT p.*')) return [{ owner_user_id: user, revoked_at: null, member_live: true, transport: 'hosted_mcp', hosted_live: true, turn_only: true, ...agent }];
    if (sql.includes('SELECT greatest(')) return [{ last_activity_at: at, messages_waiting_since: null }];
    if (sql.includes('SELECT id,created_at,until')) return [];
    if (sql.includes('SELECT bool_or(')) return [{ can_read: true, can_write: true, ...approval }];
    throw new Error(`Unexpected read query: ${sql}`);
  }) as unknown as Parameters<ReturnType<typeof createHouseholdTodoStore>['read']>[0];
  const store = createHouseholdTodoStore({ core: { ...todos, ...policy, ...accessPolicy },
    access: async () => ({ now: Date.parse(at), facts: { workspace_id: workspace, archived_at: null, boundary: { kind: 'shared' },
      actor: { user_id: user, principal_id: null, run_id: null }, credential: { kind: 'human' },
      member: { user_id: user, workspace_id: workspace, revoked_at: null, content_role: 'editor', content_consent_id: id(5) } } }),
    notice: async () => { throw new Error('A read must not post a notice'); } });
  const read = async (query: Parameters<typeof store.read>[3]) => {
    return store.read(tx, workspace, { user_id: user, principal_id: null, run_id: null, connection: null }, query);
  };
  return Object.assign(read, { surface: (tool: string, args: Row) => executeHouseholdSurface(tx, workspace,
    { user_id: user, principal_id: null, run_id: null, connection: null }, 'read_request_001',
    { kind: 'household_tool', tool, arguments: { seat: 'seat_0000000000000000000000', ...args } }, async () => true) });
}
function row(n: number, title: string): Row {
  return { workspace_id: workspace, todo_id: id(100 + n), version: 1, title, notes: 'Details stay out of summaries', state: n < 80 ? 'doing' : 'open',
    due_on: null, created_by_user: user, created_by_principal: null, created_at: at,
    assignee_user: null, assignee_principal: n < 190 ? principal : null, assigned_by_user: user, assigned_by_principal: null, assigned_at: at,
    offer_id: n >= 190 ? id(1000 + n) : null, offer_user: null, offer_principal: principal, offer_decider: user, offer_start: 'queue',
    offer_gate: { kind: 'hold', note: 'Offer notes stay private in summaries' }, offer_by_user: user, offer_by_principal: null, offered_at: at,
    gate_kind: n >= 160 && n < 190 ? 'hold' : 'none', gate_note: 'Gate notes stay out of summaries', gate_todo_id: null, gate_at: null, gate_set_by: user,
    queue_rank: n < 190 ? n + 1 : null, state_by_user: user, state_by_principal: null, state_at: at, comment_count: 0 };
}

test('command reads keep transport status separate from queue work status and preserve refusals', async (t) => {
  // Synthetic runtime configuration only; no credentials or Storage requests.
  const deno = Object.getOwnPropertyDescriptor(globalThis, 'Deno');
  Object.defineProperty(globalThis, 'Deno', { configurable: true, value: { env: { get: (name: string) =>
    name === 'SUPABASE_URL' ? 'https://storage.invalid' : name === 'SUPABASE_SERVICE_ROLE_KEY' ? 'synthetic-test-only' : undefined } } });
  t.after(() => { if (deno) Object.defineProperty(globalThis, 'Deno', deno); else Reflect.deleteProperty(globalThis, 'Deno'); });
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('Reads must not use Storage or HTTP'); });
  const read = readFixture([row(0, 'Working item'), row(80, 'Next item')]);
  const body = await read.surface('todo_queue', { principal_id: principal });
  assert.equal(body.status, 'ok');
  const queue = body.queue as Row & { status: { work: string; facts: Row } };
  assert.equal(queue.workspace_id, workspace);
  assert.equal(queue.principal_id, principal);
  assert.equal(queue.owner_user_id, user);
  assert.equal(queue.status.work, 'working');
  assert.deepEqual(queue.status.facts.doing, { todo_id: id(100), title: 'Working item', since: at });
  assert.deepEqual((queue.up_next as Row[]).map(todo => todo.todo_id), [id(180)]);
  assert.deepEqual(queue.next_offset, { working: null, up_next: null, not_yet: null, requests: null });
  assert.equal(body.up_next, undefined, 'the line is carried inside the queue envelope');
  assert.deepEqual(await read.surface('todo_queue', {}), { status: 'refused', reason: 'principal_required' });
  assert.equal((await read.surface('todo_list', { scope: 'all' })).status, 'ok');
  assert.deepEqual(await read.surface('todo_read', { todo_id: id(999) }), { status: 'refused', reason: 'todo_not_found' });
  for (const title of ['界'.repeat(200), '"'.repeat(200), '\\'.repeat(200)]) {
    const page = await readFixture(Array.from({ length: 200 }, (_, n) => row(n, title)))
      .surface('todo_queue', { principal_id: principal });
    assert.equal(page.status, 'ok');
    assert.ok(measuredBytes(page) <= 28 * 1024, 'budget includes transport status and nested queue');
    const pagedQueue = page.queue as Row & { next_offset: { working: number | null } };
    assert.ok(pagedQueue.next_offset.working !== null, 'worst-case records truncate the queue page');
    assert.equal(pagedQueue.next_offset.working, (pagedQueue.working as Row[]).length);
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test('a human queue needs an explicit principal; valid queue summaries omit notes and carry one clear flag', async () => {
  const read = readFixture([row(160, 'Held work'), row(190, 'Requested work')]);
  assert.deepEqual(await read({ kind: 'todo_queue' }), { status: 'refused', reason: 'principal_required' });
  const queue = await read({ kind: 'todo_queue', principal_id: principal }) as Row;
  assert.equal(queue.principal_id, principal);
  const held = (queue.not_yet as Row[])[0]!, offered = (queue.requests as Row[])[0]!;
  assert.deepEqual(held.gate, { kind: 'hold', clear: false });
  assert.deepEqual((offered.offer as Row).gate, { kind: 'hold' });
  for (const query of [{ kind: 'todo_list', scope: 'all' }, { kind: 'todo_queue', principal_id: principal }] as const) {
    const result = await read(query) as Row;
    const summaries = query.kind === 'todo_list' ? result.todos as Row[] : [...result.not_yet as Row[], ...result.requests as Row[]];
    assert.equal(summaries.length, 2);
    for (const summary of summaries) {
      assert.equal(Object.hasOwn(summary, 'notes'), false);
      assert.equal(Object.hasOwn(summary, 'gate_note'), false);
      assert.equal(Object.hasOwn(summary, 'gate_clear'), false);
      assert.equal(Object.hasOwn(summary.gate as Row, 'note'), false);
      if (summary.offer) assert.equal(Object.hasOwn((summary.offer as Row).gate as Row, 'note'), false);
    }
  }
  const detail = await read({ kind: 'todo_read', todo_id: id(260) }) as { todo: Row };
  assert.deepEqual(detail.todo.gate, { kind: 'hold', note: 'Gate notes stay out of summaries' });
  const offeredDetail = await read({ kind: 'todo_read', todo_id: id(290) }) as { todo: Row };
  assert.deepEqual((offeredDetail.todo.offer as Row).gate, { kind: 'hold', note: 'Offer notes stay private in summaries' });
});

test('Doing titles follow viewer access; hosted disconnection keeps its own vocabulary', async () => {
  for (const [agent, approval, connection, contentAccess, work] of [
    [{}, {}, 'live', 'read_write', 'working'],
    [{}, { can_read: false, can_write: false }, 'live', 'none', 'working'],
    [{ hosted_live: false }, {}, 'connection_off', 'none', 'disconnected'],
    [{ revoked_at: at }, {}, 'removed', 'none', 'disconnected'],
    [{ transport: 'local', token_live: true }, {}, 'live', 'read_write', 'working'],
    [{ transport: 'local', key_off: true }, {}, 'key_off', 'none', 'disconnected'],
    [{ transport: 'local', key_off: true, token_live: true }, {}, 'live', 'read_write', 'working'],
    [{ transport: 'local', renewal_live: true }, {}, 'live', 'read_write', 'working'],
    [{ transport: 'local', paused: true }, {}, 'paused', 'none', 'disconnected'],
    [{ transport: 'local' }, {}, 'key_ended', 'none', 'disconnected'],
  ] as const) {
    const queue = await readFixture([row(0, 'Viewer can read this')], [], agent, approval)({ kind: 'todo_queue', principal_id: principal }) as Row & { status: { work: string; facts: Row } };
    assert.equal(queue.status.facts.connection, connection);
    assert.equal(queue.status.work, work);
    assert.equal(queue.content_access, contentAccess);
    assert.deepEqual(queue.status.facts.doing, { todo_id: id(100), title: 'Viewer can read this', since: at });
  }
});

test('read summaries page all 200 records within the transport budget and preserve AM14 section order', async () => {
  for (const title of ['界'.repeat(200), '"'.repeat(200), '\\'.repeat(200)]) {
    const rows = Array.from({ length: 200 }, (_, n) => row(n, title)), read = readFixture(rows);
    const seen: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const result = await read({ kind: 'todo_list', scope: 'all', offset, limit: 50 }) as { todos: Row[]; next_offset: number | null };
      assert.ok(measuredBytes(result) <= 28 * 1024);
      assert.ok(result.todos.length > 0 && result.todos.length <= 50);
      assert.ok(result.todos.every(todo => !Object.hasOwn(todo, 'notes')));
      if (result.next_offset !== null) assert.ok(result.next_offset > offset);
      seen.push(...result.todos.map(todo => String(todo.todo_id))); offset = result.next_offset;
    }
    assert.deepEqual(seen.sort(), rows.map(todo => String(todo.todo_id)).sort());
    const first = await read({ kind: 'todo_queue', principal_id: principal }) as Row & { next_offset: Record<string, number | null> };
    assert.ok(measuredBytes(first) <= 28 * 1024);
    assert.ok(first.next_offset.working !== null);
    assert.deepEqual(first.next_offset, { working: (first.working as Row[]).length, up_next: 0, not_yet: 0, requests: 0 });
    for (const [section, total] of [['working', 80], ['up_next', 80], ['not_yet', 30], ['requests', 10]] as const) {
      const seen: string[] = []; let cursor: number | null = 0;
      while (cursor !== null) {
        const result = await read({ kind: 'todo_queue', principal_id: principal, section, offset: cursor, limit: 50 }) as Row & { next_offset: Record<string, number | null> };
        assert.ok(measuredBytes(result) <= 28 * 1024);
        const page = result[section] as Row[];
        assert.ok(page.length > 0 && page.length <= 50);
        assert.ok(page.every(todo => !Object.hasOwn(todo, 'notes')));
        seen.push(...page.map(todo => String(todo.todo_id)));
        const next = result.next_offset[section]!;
        if (next !== null) assert.ok(next > cursor);
        cursor = next;
      }
      assert.equal(seen.length, total); assert.equal(new Set(seen).size, total);
    }
  }
});

test('maximum control-free details and comments fit; comment paging truncates and always advances', async () => {
  for (const unit of ['"', '\\', '\n', '😀']) {
    const body = unit === '\n' ? `x${unit.repeat(3999)}` : unit.repeat(4000);
    const comments = Array.from({ length: 20 }, (_, n) => ({ workspace_id: workspace, comment_id: id(2000 + n), target_kind: 'todo', target_id: id(100),
      author_user: user, author_principal: null, body, mentions: [], created_at: at }));
    const read = readFixture([{ ...row(0, 'Maximum details'), notes: unit.repeat(4000) }], comments);
    const seen: string[] = []; let offset: number | null = 0;
    while (offset !== null) {
      const result = await read({ kind: 'comment_list', target: { kind: 'todo', id: id(100) }, offset, limit: 20 }) as { comments: Row[]; next_offset: number | null };
      assert.ok(measuredBytes(result) <= 28 * 1024);
      assert.ok(result.comments.length > 0 && result.comments.length < 20);
      assert.ok(result.comments.every(comment => comment.body === body));
      if (result.next_offset !== null) assert.ok(result.next_offset > offset);
      seen.push(...result.comments.map(comment => String(comment.comment_id))); offset = result.next_offset;
    }
    assert.deepEqual(seen, comments.map(comment => comment.comment_id));
    const result = await read({ kind: 'todo_read', todo_id: id(100) }) as { todo: Row; comments: Row[]; next_comment_offset: number | null };
    assert.ok(measuredBytes(result) <= 28 * 1024);
    assert.equal(result.todo.notes, unit.repeat(4000));
    assert.equal(result.next_comment_offset, result.comments.length);
  }
});

test('AM16 reserves detail space and comment-only pages advance from a nonzero offset', async () => {
  const comments = Array.from({ length: 20 }, (_, n) => ({ workspace_id: workspace, comment_id: id(2000 + n), target_kind: 'todo', target_id: id(100),
    author_user: user, author_principal: null, body: '"'.repeat(4000), mentions: [], created_at: at }));
  const read = readFixture([{ ...row(0, 'Maximum details'), notes: '"'.repeat(4000) }], comments);
  const detail = await read({ kind: 'todo_read', todo_id: id(100), comment_offset: 7 }) as { todo: Row; comments: Row[]; next_comment_offset: number };
  assert.ok(measuredBytes(detail) <= 28 * 1024);
  assert.equal(detail.todo.title, 'Maximum details');
  assert.equal(detail.todo.notes, '"'.repeat(4000));
  assert.deepEqual(detail.comments, []);
  assert.equal(detail.next_comment_offset, 7);
  const page = await read({ kind: 'comment_list', target: { kind: 'todo', id: id(100) }, offset: 7 }) as { comments: Row[]; next_offset: number };
  assert.ok(measuredBytes(page) <= 28 * 1024);
  assert.equal(page.comments.length, 1);
  assert.equal(page.comments[0]!.comment_id, '00000000-0000-4000-8000-000000002007');
  assert.equal(page.next_offset, 8);
  const complete = await read({ kind: 'todo_read', todo_id: id(100), comment_offset: 20 }) as { comments: Row[]; next_comment_offset: number | null };
  assert.deepEqual(complete.comments, []);
  assert.equal(complete.next_comment_offset, null);
});

test('AM16 retains the first unexpectedly oversized stored row rather than returning a stuck cursor', async () => {
  // Deliberately beyond the writer's bounds: this is the progress fallback,
  // not a claim that these records can be created through the command path.
  for (const title of ['Normal title', '"'.repeat(8000)]) {
    const read = readFixture([row(0, title), row(1, title)]);
    const result = await read({ kind: 'todo_list', scope: 'all', limit: 1 }) as { todos: Row[]; next_offset: number };
    assert.equal(result.todos.length, 1);
    assert.equal(result.todos[0]!.todo_id, '00000000-0000-4000-8000-000000000100');
    assert.equal(result.next_offset, 1);
  }
  for (const body of ['Normal comment', '"'.repeat(8000)]) {
    const comments = Array.from({ length: 2 }, (_, n) => ({ comment_id: id(2000 + n), target_kind: 'todo', target_id: id(100),
      author_user: user, author_principal: null, body, mentions: [], created_at: at }));
    const read = readFixture([], comments);
    const result = await read({ kind: 'comment_list', target: { kind: 'todo', id: id(100) }, limit: 1 }) as { comments: Row[]; next_offset: number };
    assert.equal(result.comments.length, 1);
    assert.equal(result.comments[0]!.comment_id, '00000000-0000-4000-8000-000000002000');
    assert.equal(result.next_offset, 1);
  }
});

test('catalog ACL proof ignores system and dropped columns while rejecting live column grants', () => {
  // Independent least-privilege contract. The CI database proof also grants a
  // live column, observes refusal, drops it, and observes acceptance again.
  const catalog = readFileSync(new URL('20261006000001-catalog.sql', reserve), 'utf8');
  assert.match(catalog, /FROM pg_attribute WHERE attrelid=c\.oid AND attnum > 0 AND NOT attisdropped AND attacl IS NOT NULL/);
});

test('activity reads check consent before querying and again before exposing titles', async () => {
  const facts: accessPolicy.HouseholdAccessFacts = { workspace_id: workspace, archived_at: null, boundary: { kind: 'shared' },
    actor: { user_id: user, principal_id: null, run_id: null }, credential: { kind: 'human' },
    member: { user_id: user, workspace_id: workspace, revoked_at: null, content_role: 'editor', content_consent_id: id(5) } };
  const identity = { user_id: user, principal_id: null, run_id: null, connection: null };
  const item = { at: new Date(at), key: 'todo:event', actor: { user_id: user, principal_id: null },
    event: 'created', title: '<img src=x>', object: { kind: 'todo', id: id(100) } };
  let queries = 0, checks = 0;
  const tx = (async () => { queries++; return [item]; }) as unknown as Parameters<typeof readHouseholdActivity>[0];
  const access = async () => { checks++; return { facts: structuredClone(facts), now: Date.parse(at) }; };
  const query = { since: '2026-10-01T00:00:00Z', limit: 100 };
  assert.deepEqual(await readHouseholdActivity(tx, workspace, identity, query, access),
    { status: 'ok', activity: [{ ...item, at }] });
  assert.equal(queries, 1); assert.equal(checks, 2);
  facts.member!.content_consent_id = null;
  assert.deepEqual(await readHouseholdActivity(tx, workspace, identity, query, access),
    { status: 'refused', reason: 'content_consent_required' });
  assert.equal(queries, 1, 'refusal happens before the query');
  facts.member!.content_consent_id = id(5);
  let rechecks = 0;
  const changed = async () => { const checked = await access(); if (++rechecks === 2) checked.facts.member!.content_consent_id = null; return checked; };
  assert.deepEqual(await readHouseholdActivity(tx, workspace, identity, query, changed),
    { status: 'refused', reason: 'content_consent_required' });
  assert.equal(queries, 2, 'the recheck hides an otherwise readable result');
  for (const invalid of [{ ...query, limit: 101 }, { ...query, since: 'bad-time' }, { ...query, limit: 0 }])
    assert.deepEqual(await readHouseholdActivity(tx, workspace, identity, invalid, access), { status: 'refused', reason: 'invalid_arguments' });
  assert.equal(queries, 2, 'invalid paging and dates do not reach SQL');
});
