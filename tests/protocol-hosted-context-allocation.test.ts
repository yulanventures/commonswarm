import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decideHostedContextAllocation as decide, hostedContextClaimValid, hostedContextLive, hostedSuffixName,
  hostedContextClocks, type HostedContextClaim, type HostedContextAllocationFacts, type HostedAllocationSeat } from '../src/protocol/hosted-context.js';

const seat: HostedAllocationSeat = { seat_id: 'seat-id', principal_id: 'principal', grant_id: 'grant', owner_user_id: 'owner',
  client_id: 'registered-client', name: 'Marketing', display_name: 'Marketing', disambiguator: null,
  lifetime: 'durable', live: true, hosted: true, predecessor_unavailable: false };
const facts = (patch: Partial<HostedContextAllocationFacts> = {}): HostedContextAllocationFacts => ({
  now: 1000, grant_id: 'grant', owner_user_id: 'owner', client_id: 'registered-client', authorized: true,
  allocation_enabled: true, parent_valid: true, default_name: 'Agent', exact_seats: [],
  names: [{ name: 'Marketing', reserved: false }, { name: 'Marketing-AAAA', reserved: false }],
  active_grant: 0, active_workspace: 0, owner_day: 0, workspace_day: 0, durable_seats: 0, durable_principals: 0,
  retry_after_seconds: 60, succession_contexts: [], ...patch,
});
test('runtime claim validation refuses nonstring values without reading allocation facts', () => {
  for (const [key, value, route] of [
    ['intent', 'new', {}], ['name', 'Marketing', {}],
    ['seat', 'seat_abcdefghijklmnopqrstuv', { intent: 'continue' }],
    ['lifetime', 'ephemeral', {}], ['kind', 'chat', {}],
    ['parent_context', '00000000-0000-4000-8000-000000000001', {}],
  ] as const) {
    assert.equal(hostedContextClaimValid({ ...route, [key]: value } as HostedContextClaim), true, `${key}: same-route control`);
    for (const malformed of [[value], 123, { value }, null]) {
      const command = { ...route, [key]: malformed } as unknown as HostedContextClaim;
      const untouchedFacts = new Proxy(facts(), { get() { throw new Error('validation read allocation facts'); } });
      assert.deepEqual(decide(command, untouchedFacts), {
        ok: false, error: 'invalid_request', message: 'The identity request is invalid. Correct the arguments and try again.', can_start_new: false,
      }, `${key}: ${JSON.stringify(malformed)}`);
    }
  }
  assert.throws(() => hostedSuffixName('Agent', ['AAAA'] as unknown as string), /invalid hosted suffix candidate/u);
  assert.equal(hostedSuffixName('Agent', 'AAAA'), 'Agent-AAAA');
});
test('fresh default is an ephemeral suffixed identity, including a live same-grant name', () => {
  for (const reserved of [false, true]) {
    const result = decide({ name: 'Marketing' }, facts({ exact_seats: [seat], names: [
      { name: 'Marketing', reserved }, { name: 'Marketing-AAAA', reserved: false }] }));
    assert.equal(result.ok, true); if (!result.ok) return;
    assert.equal(result.name, 'Marketing-AAAA'); assert.equal(result.seat, undefined);
    assert.equal(result.lifetime, 'ephemeral'); assert.equal(result.outcome, 'created');
    assert.equal(result.assurance, 'portable'); assert.equal(result.adjustment_reason, reserved ? 'collision' : 'ephemeral_address');
  }
});
test('explicit durable creation reclaims only a free exact address, otherwise uses a fresh suffix', () => {
  const free = decide({ name: 'Marketing', lifetime: 'durable' }, facts());
  assert.equal(free.ok, true); if (free.ok) { assert.equal(free.name, 'Marketing'); assert.equal(free.name_adjusted, false); }
  const reserved = decide({ name: 'Marketing', lifetime: 'durable' }, facts({ names: [
    { name: 'Marketing', reserved: true }, { name: 'Marketing-AAAA', reserved: false }] }));
  assert.equal(reserved.ok, true); if (reserved.ok) { assert.equal(reserved.name, 'Marketing-AAAA'); assert.equal(reserved.adjustment_reason, 'collision'); }
});
test('Q1 explicit name continuation allocates a fresh portable context on the same durable identity', () => {
  const result = decide({ intent: 'continue', name: 'Marketing' }, facts({ exact_seats: [seat] }));
  assert.equal(result.ok, true); if (!result.ok) return;
  assert.equal(result.seat?.principal_id, 'principal'); assert.equal(result.outcome, 'continued');
  assert.equal(result.grant_succession, false); assert.equal(result.clocks.created_at, 1000);
  assert.equal(result.name_adjusted, false);
  for (const changed of [{ hosted: false }, { live: false }, { lifetime: 'ephemeral' as const }, { grant_id: 'competing-live-grant' },
    { owner_user_id: 'foreign-owner' }, { client_id: 'different-registration' }]) {
    const denied = decide({ intent: 'continue', name: 'Marketing' }, facts({ exact_seats: [{ ...seat, ...changed }] }));
    assert.equal(denied.ok, false); if (!denied.ok) assert.equal(denied.error, 'identity_resume_unavailable');
  }
});
test('Q3 requires proven predecessor unavailability, same owner and exact registration; handles cannot trigger it', () => {
  const predecessor = { ...seat, grant_id: 'predecessor', predecessor_unavailable: true };
  const success = decide({ intent: 'continue', name: 'Marketing' }, facts({ exact_seats: [predecessor] }));
  assert.equal(success.ok, true); if (success.ok) { assert.equal(success.grant_succession, true);
    assert.equal(success.predecessor_grant_id, 'predecessor'); assert.equal(success.successor_grant_id, 'grant'); }
  for (const changed of [{ predecessor_unavailable: false }, { owner_user_id: 'other' }, { client_id: 'same-brand-different-client' },
    { live: false }, { hosted: false }]) {
    const denied = decide({ intent: 'continue', name: 'Marketing' }, facts({ exact_seats: [{ ...predecessor, ...changed }] }));
    assert.equal(denied.ok, false); if (!denied.ok) assert.equal(denied.error, 'identity_resume_unavailable');
  }
  const supplied = decide({ intent: 'continue', seat: 'seat_abcdefghijklmnopqrstuv', name: 'Marketing' }, facts({ exact_seats: [predecessor] }));
  assert.equal(supplied.ok, false);
  assert.equal(decide({ intent: 'continue', name: 'Marketing' }, facts({ exact_seats: [predecessor, { ...seat, seat_id: 'second' }] })).ok, false);
});
for (const [key, ceiling] of [['active_grant', 25], ['active_workspace', 100], ['owner_day', 100], ['workspace_day', 500]] as const) {
  test(`${key} includes durable continuation and refuses a new allocation at ${ceiling}`, () => {
    for (const command of [{ name: 'Marketing' }, { name: 'Marketing', intent: 'continue' as const }]) {
      assert.equal(decide(command, facts({ [key]: ceiling - 1, exact_seats: [seat] })).ok, true);
      const denied = decide(command, facts({ [key]: ceiling, exact_seats: [seat] }));
      assert.equal(denied.ok, false); if (!denied.ok) { assert.equal(denied.error, 'session_capacity_reached'); assert.equal(denied.retry_after_seconds, 60); }
    }
  });
}
test('10 durable seats and 50 durable principals exclude ephemeral creation; same-seat continuation consumes neither', () => {
  const full = facts({ durable_seats: 10, durable_principals: 50, exact_seats: [seat] });
  assert.equal(decide({ name: 'Marketing' }, full).ok, true);
  assert.equal(decide({ name: 'Marketing', intent: 'continue' }, full).ok, true);
  const seats = decide({ name: 'Marketing', lifetime: 'durable' }, full);
  assert.equal(seats.ok, false); if (!seats.ok) assert.equal(seats.error, 'hosted_seat_limit_reached');
  assert.equal(decide({ name: 'Marketing', lifetime: 'durable' }, facts({ durable_principals: 49, durable_seats: 9 })).ok, true);
  const principals = decide({ name: 'Marketing', lifetime: 'durable' }, facts({ durable_principals: 50 }));
  assert.equal(principals.ok, false); if (!principals.ok) assert.equal(principals.error, 'principal_limit_reached');
});
test('missing or disabled allocation and current authorization fail closed; parent reference is same-grant', () => {
  assert.equal(decide({ name: 'Marketing' }, facts()).ok, true);
  for (const changed of [{ allocation_enabled: false }, { authorized: false }]) assert.equal(decide({ name: 'Marketing' }, facts(changed)).ok, false);
  assert.equal(decide({ name: 'Marketing', parent_context: '00000000-0000-4000-8000-000000000001' }, facts({ parent_valid: false })).ok, false);
});
test('at most five exact suffix candidates; a sixth cannot bypass the bound', () => {
  const names = [{ name: 'Marketing', reserved: true }, ...['AAAA','AAAB','AAAC','AAAD','AAAE'].map(s => ({ name: `Marketing-${s}`, reserved: true }))];
  const refused = decide({ name: 'Marketing' }, facts({ names: [...names, { name: 'Marketing-AAAF', reserved: false }] }));
  assert.equal(refused.ok, false); if (!refused.ok) assert.equal(refused.error, 'name_allocation_busy');
  names[5].reserved = false;
  assert.equal(decide({ name: 'Marketing' }, facts({ names })).ok, true);
  const base = '😀'.repeat(80), exact = hostedSuffixName(base, '7K2P');
  const long = decide({ name: base }, facts({ names: [{ name: base, reserved: false }, { name: exact, reserved: false }] }));
  assert.equal(long.ok, true); if (long.ok) assert.equal(long.display_name, base, 'display label preserves the validated base');
  assert.equal(Array.from(exact).length, 80); assert.equal(exact.endsWith('-7K2P'), true);
});
test('all four creation clocks and unswept expiry honor exact deadlines; legacy null deadlines stay live', () => {
  for (const [kind, idle, absolute] of [['chat',86400000,2592000000],['task',43200000,604800000],['scheduled',1800000,86400000],['subagent',900000,14400000]] as const) {
    const clock = hostedContextClocks(kind, 1000);
    assert.equal(clock.last_business_at, 1000); assert.equal(clock.idle_expires_at, 1000 + idle); assert.equal(clock.absolute_expires_at, 1000 + absolute);
    assert.equal(hostedContextLive({ ...clock, closed_at: null }, clock.idle_expires_at - 1), true);
    assert.equal(hostedContextLive({ ...clock, closed_at: null }, clock.idle_expires_at), false);
    assert.equal(hostedContextLive({ ...clock, closed_at: 1001 }, 1002), false);
  }
  assert.equal(hostedContextLive({ closed_at: null, idle_expires_at: null, absolute_expires_at: null }, 999999999999), true);
});
test('closed claim record combinations reject malformed claims without allocations', () => {
  for (const c of [{ lifetime: 'durable' as const }, { seat: 'seat_abcdefghijklmnopqrstuv' }, { intent: 'continue' as const },
    { intent: 'continue' as const, name: 'Marketing', lifetime: 'durable' as const },
    { intent: 'continue' as const, seat: 'seat_abcdefghijklmnopqrstuv', kind: 'chat' as const }]) assert.equal(hostedContextClaimValid(c), false);
  assert.equal(hostedContextClaimValid({ intent: 'continue', seat: 'seat_abcdefghijklmnopqrstuv', name: 'Marketing' }), true);
  assert.equal(hostedContextClaimValid({}), true);
});

test('succession counts inherited live contexts before rebind for both active caps', () => {
  const predecessor = { ...seat, grant_id: 'predecessor', predecessor_unavailable: true };
  const current = facts({ exact_seats: [predecessor], succession_contexts: [{ seat_id: seat.seat_id, active: 2, workspace_excluded: 2 }] });
  const command = { intent: 'continue' as const, name: 'Marketing' };
  assert.equal(decide(command, { ...current, active_grant: 22 }).ok, true, '22 + 2 inherited + new = 25');
  assert.equal(decide(command, { ...current, active_grant: 23 }).ok, false, '23 + 2 inherited cannot allocate another');
  assert.equal(decide(command, { ...current, active_workspace: 97 }).ok, true, '97 + 2 newly active + new = 100');
  assert.equal(decide(command, { ...current, active_workspace: 98 }).ok, false);
  assert.equal(decide(command, { ...current, active_grant: 24, succession_contexts: [] }).ok, true, 'expired/closed contexts excluded by locked SQL facts');
});
