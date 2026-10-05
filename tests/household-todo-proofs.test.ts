import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import * as todos from '../src/protocol/household-todos.js';
import * as policy from '../src/protocol/household-todo-policy.js';
import * as accessPolicy from '../src/protocol/household-object-policy.js';
import { createHouseholdTodoStore } from '../supabase/functions/command/household-todos.js';
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
function readFixture(rows: Row[], comments: Row[] = []) {
  const tx = (async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const sql = parts.join('?');
    if (sql.includes('SELECT stream_id,last_seq')) return [{ stream_id: id(4), last_seq: 0 }];
    if (sql.includes('SELECT * FROM swarm.household_todos')) return rows;
    if (sql.includes('SELECT principal_id,accepts_from')) return [];
    if (sql.includes('SELECT * FROM swarm.household_comments')) {
      const offset = Number(values.at(-2)), limit = Number(values.at(-1));
      return comments.slice(offset, offset + limit);
    }
    if (sql.includes('SELECT p.*')) return [{ owner_user_id: user, revoked_at: null, member_live: true, transport: 'hosted_mcp', hosted_live: true, turn_only: true }];
    if (sql.includes('SELECT greatest(')) return [{ last_activity_at: at, messages_waiting_since: null }];
    if (sql.includes('SELECT id,created_at,until')) return [];
    if (sql.includes('SELECT bool_or(')) return [{ can_read: true, can_write: true }];
    throw new Error(`Unexpected read query: ${sql}`);
  }) as unknown as Parameters<ReturnType<typeof createHouseholdTodoStore>['read']>[0];
  const store = createHouseholdTodoStore({ core: { ...todos, ...policy, ...accessPolicy },
    access: async () => ({ now: Date.parse(at), facts: { workspace_id: workspace, archived_at: null, boundary: { kind: 'shared' },
      actor: { user_id: user, principal_id: null, run_id: null }, credential: { kind: 'human' },
      member: { user_id: user, workspace_id: workspace, revoked_at: null, content_role: 'editor', content_consent_id: id(5) } } }),
    notice: async () => { throw new Error('A read must not post a notice'); } });
  return async (query: Parameters<typeof store.read>[3]) => {
    const result = await store.read(tx, workspace, { user_id: user, principal_id: null, run_id: null, connection: null }, query);
    assert.ok(measuredBytes(result) <= 28 * 1024, `response used ${measuredBytes(result)} bytes`);
    return result;
  };
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

test('read summaries page all 200 records within the transport budget and preserve AM14 section order', async () => {
  for (const title of ['界'.repeat(200), '"'.repeat(200), '\\'.repeat(200)]) {
    const rows = Array.from({ length: 200 }, (_, n) => row(n, title)), read = readFixture(rows);
    const seen: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const result = await read({ kind: 'todo_list', scope: 'all', offset, limit: 50 }) as { todos: Row[]; next_offset: number | null };
      assert.ok(result.todos.length > 0 && result.todos.length <= 50);
      assert.ok(result.todos.every(todo => !Object.hasOwn(todo, 'notes')));
      if (result.next_offset !== null) assert.ok(result.next_offset > offset);
      seen.push(...result.todos.map(todo => String(todo.todo_id))); offset = result.next_offset;
    }
    assert.deepEqual(seen.sort(), rows.map(todo => String(todo.todo_id)).sort());
    const first = await read({ kind: 'todo_queue', principal_id: principal }) as Row & { next_offset: Record<string, number | null> };
    assert.ok(first.next_offset.working !== null);
    assert.deepEqual(first.next_offset, { working: (first.working as Row[]).length, up_next: 0, not_yet: 0, requests: 0 });
    for (const [section, total] of [['working', 80], ['up_next', 80], ['not_yet', 30], ['requests', 10]] as const) {
      const seen: string[] = []; let cursor: number | null = 0;
      while (cursor !== null) {
        const result = await read({ kind: 'todo_queue', principal_id: principal, section, offset: cursor, limit: 50 }) as Row & { next_offset: Record<string, number | null> };
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
      assert.ok(result.comments.length > 0 && result.comments.length < 20);
      assert.ok(result.comments.every(comment => comment.body === body));
      if (result.next_offset !== null) assert.ok(result.next_offset > offset);
      seen.push(...result.comments.map(comment => String(comment.comment_id))); offset = result.next_offset;
    }
    assert.deepEqual(seen, comments.map(comment => comment.comment_id));
    const result = await read({ kind: 'todo_read', todo_id: id(100) }) as { todo: Row; comments: Row[]; next_comment_offset: number | null };
    assert.equal(result.todo.notes, unit.repeat(4000));
    assert.equal(result.next_comment_offset, result.comments.length);
  }
});
