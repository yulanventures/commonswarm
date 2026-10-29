/** Removal helper: one digest guard, then content and pending invitations, never membership. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  revokeRemovedMemberHousehold,
} from '../supabase/functions/command/household-member-removal.ts';

const workspace = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const user = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const actor = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const digest = 'ab'.repeat(32);

function recording(rows: { invitation_id: string }[] = []) {
  const queries: string[] = [];
  const tx = (strings: TemplateStringsArray) => {
    queries.push(strings.join(' '));
    return Promise.resolve(rows);
  };
  return { tx: tx as never, queries };
}

test('a removal without an actor writes nothing', async () => {
  const { tx, queries } = recording();
  await assert.rejects(
    () => revokeRemovedMemberHousehold(tx, workspace, user, new Date(0), null, 'cmd-1', digest),
    (error: unknown) => error instanceof Error && error.message === 'MemberRemoved actor is missing',
  );
  assert.deepEqual(queries, []);
});

test('a malformed removal digest writes nothing', async () => {
  const { tx, queries } = recording();
  await assert.rejects(
    () => revokeRemovedMemberHousehold(tx, workspace, user, new Date(0), actor, 'cmd-1', 'ABC'.repeat(20) + 'abcd'),
    (error: unknown) => error instanceof Error && error.message === 'household removal digest is malformed',
  );
  assert.deepEqual(queries, []);
});
