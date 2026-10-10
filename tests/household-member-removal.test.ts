/** Removal helper: one digest guard, then content and pending invitations, never membership. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  pendingLinkInvitationIds,
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

test('removal locks workspace, then membership, then content, and does not stamp membership', async () => {
  const { tx, queries } = recording();
  await revokeRemovedMemberHousehold(
    tx, workspace, user, new Date('2026-10-06T00:00:00Z'), actor, 'cmd-1', digest,
  );
  assert.equal(queries.length, 6);
  assert.match(queries[0]!, /set_config\('cswarm\.household_command', 'remove_member', true\)/);
  assert.match(queries[1]!, /FROM swarm\.workspaces/);
  assert.match(queries[1]!, /FOR NO KEY UPDATE/);
  assert.match(queries[2]!, /FROM swarm\.memberships/);
  assert.match(queries[2]!, /FOR UPDATE/);
  assert.equal(/SET revoked_at/.test(queries[2]!), false);
  assert.match(queries[3]!, /UPDATE swarm\.household_member_content_roles/);
  assert.match(queries[3]!, /revoked_at IS NULL/);
  assert.match(queries[4]!, /UPDATE swarm\.household_content_connections/);
  assert.match(queries[4]!, /owner_user_id/);
  assert.match(queries[4]!, /revoked_at IS NULL/);
  assert.equal(queries[4]!.includes('expires_at'), false);
  assert.match(queries[5]!, /UPDATE swarm\.admin_routine_invitations/);
  assert.match(queries[5]!, /accepted_at IS NULL/);
  assert.match(queries[5]!, /revoked_at IS NULL/);
  const workspaceLock = queries.findIndex((query) => /FROM swarm\.workspaces/.test(query) && /FOR NO KEY UPDATE/.test(query));
  const membershipLock = queries.findIndex((query) => /FROM swarm\.memberships/.test(query) && /FOR UPDATE/.test(query));
  const contentRole = queries.findIndex((query) => /UPDATE swarm\.household_member_content_roles/.test(query));
  const connection = queries.findIndex((query) => /UPDATE swarm\.household_content_connections/.test(query));
  assert.ok(workspaceLock !== -1 && membershipLock !== -1 && contentRole !== -1 && connection !== -1);
  assert.ok(workspaceLock < membershipLock && membershipLock < contentRole && contentRole < connection);
  assert.equal(queries.some((query) => /UPDATE swarm\.memberships/.test(query)), false);
});

test('the command path locks the workspace before the stream, and stamps membership after content revocation', async () => {
  const { readFile } = await import('node:fs/promises');
  const index = await readFile(new URL('../supabase/functions/command/index.ts', import.meta.url), 'utf8');
  const stepStart = index.indexOf('await beforeStep(8)');
  const stepEnd = index.indexOf('await afterStep(8)', stepStart);
  assert.ok(stepStart !== -1 && stepEnd > stepStart);
  const step = index.slice(stepStart, stepEnd);
  assert.match(step, /kind === "accept_invitation" \|\| kind === "remove_member"/);
  const workspaceAt = step.search(/FROM swarm\.workspaces[\s\S]*?FOR UPDATE/);
  const streamAt = step.search(/FROM swarm\.streams[\s\S]*?FOR UPDATE/);
  assert.ok(workspaceAt !== -1 && streamAt !== -1 && workspaceAt < streamAt);
  const removedStart = index.indexOf('event.type === "MemberRemoved"');
  const removedEnd = index.indexOf('event.type === "AgentPrincipalCreated"', removedStart);
  const removed = index.slice(removedStart, removedEnd);
  const helperAt = removed.indexOf('revokeRemovedMemberHousehold');
  const stampAt = removed.indexOf('UPDATE swarm.memberships');
  assert.ok(helperAt !== -1 && stampAt > helperAt);
});

test('pending link invitation lookup returns the live ids for that person', async () => {
  const { tx, queries } = recording([
    { invitation_id: 'invite-a' },
    { invitation_id: 'invite-b' },
  ]);
  assert.deepEqual(await pendingLinkInvitationIds(tx, workspace, user), ['invite-a', 'invite-b']);
  assert.match(queries[0]!, /lower\(i\.email\) = lower\(u\.email\)/);
  assert.match(queries[0]!, /consumed_at IS NULL/);
  assert.match(queries[0]!, /i\.revoked_at IS NULL/);
  assert.match(queries[0]!, /ORDER BY i\.invitation_id/);
});
