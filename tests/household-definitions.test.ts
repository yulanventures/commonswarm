/** Workspace definitions (semantic layer C2a): a definition kind hidden from the
 * object tools, unique terms, and certification that only a person can give. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { HOSTED_TODO_LIST_TOOLS, HOUSEHOLD_TOOLS, householdToolInvocation, validateHouseholdHumanCommand,
  validateHouseholdToolArguments } from '../src/protocol/household-tool-registry.js';
import { emptyHouseholdObjectState, decideHouseholdObject, reduceHouseholdObjectStream, readHouseholdObjects,
  validDefinition, type HouseholdObjectCommand, type HouseholdVerifiedContent } from '../src/protocol/household-objects.js';
import type { HouseholdContent, HouseholdObjectEvent, HouseholdObjectState } from '../src/protocol/household-object-events.js';
import type { HouseholdAccessFacts } from '../src/protocol/household-object-policy.js';

const seat = `seat_${'a'.repeat(22)}`, workspace = 'household', host = { workspace_id: workspace };
const member = { user_id: 'alex', workspace_id: workspace, revoked_at: null, content_role: 'editor' as const, content_consent_id: 'yes' };
const human: HouseholdAccessFacts = { workspace_id: workspace, archived_at: null, boundary: { kind: 'shared' },
  actor: { user_id: 'alex', principal_id: null, run_id: null }, credential: { kind: 'human' }, member };
const agent: HouseholdAccessFacts = { ...human, actor: { user_id: 'alex', principal_id: 'bot', run_id: 'run' },
  credential: { kind: 'agent', connection: { principal_id: 'bot', owner_user_id: 'alex', workspace_id: workspace, connection_id: 'conn',
    grant_id: 'grant', revoked_at: null, expires_at: null, operations: ['read', 'create', 'update'], purpose: 'shared' } } };

function artifact(object_id: string, content: HouseholdContent, revision: HouseholdVerifiedContent['revision'] = null): HouseholdVerifiedContent {
  const bytes = JSON.stringify(content);
  return { workspace_id: workspace, object_id, revision, content,
    blob: { storage_key: `${workspace}/${object_id}/${bytes.length}`, size_bytes: Buffer.byteLength(bytes), sha256: createHash('sha256').update(bytes).digest('hex') } };
}
function decide(state: HouseholdObjectState, command: HouseholdObjectCommand, prepared: HouseholdVerifiedContent | null,
  contents: HouseholdVerifiedContent[] = [], access = human) {
  const n = state.last_seq + 2;
  return decideHouseholdObject(command, state, { access, now: 100 + n, command_id: `request_${n}`, seq: n - 1,
    request_digest: createHash('sha256').update(JSON.stringify(command)).digest('hex'), event_id: `event_${n}`,
    revision_token: `revision_${String(n).padStart(24, '0')}`, draft_id: `draft_${n}`, prepared, contents,
    other_storage_bytes: 0, other_object_count: 0, identity_write_attempts: 0, workspace_write_attempts: 0 });
}
const fields = (term: string, meaning = 'Sum of card spend in a calendar month.', source = 'Card statements') => ({ term, meaning, source });
const definition = (term: string, meaning?: string) => ({ kind: 'definition' as const, ...fields(term, meaning) });
function create(state: HouseholdObjectState, id: string, term: string, access = human) {
  const call = householdToolInvocation('definition_create', { seat, request_id: 'request_1', object_id: id, ...fields(term) }, host);
  assert.ok('command' in call);
  return decide(state, call.command as HouseholdObjectCommand, artifact(id, definition(term)), [], access);
}
function seed() {
  let state = emptyHouseholdObjectState(workspace, 'stream');
  const list: HouseholdContent = { kind: 'list', items: [] };
  const made = decide(state, { kind: 'create_household_object', object_id: 'groceries', title: 'Groceries', content: list }, artifact('groceries', list));
  state = reduceHouseholdObjectStream(made.events, state);
  const result = create(state, 'spend', 'Monthly spend');
  assert.equal(result.outcome.status, 'committed');
  return reduceHouseholdObjectStream(result.events, state);
}
const certify = (state: HouseholdObjectState, access = human, revision = state.objects.spend!.history.at(-1)!.revision) =>
  decide(state, { kind: 'certify_household_definition', object_id: 'spend', revision }, null, [], access);

test('object tools never return or open a definition; the definition filter does', () => {
  const state = seed();
  for (const filter of [undefined, 'list' as const]) {
    const listed = readHouseholdObjects({ kind: 'object_list', offset: 0, limit: 10, ...(filter ? { kind_filter: filter } : {}) }, state, human, 200);
    assert.ok(listed.status === 'ok' && listed.kind === 'object_list');
    assert.deepEqual(listed.objects.map(o => o.object_id), ['groceries']);
  }
  for (const query of [{ kind: 'object_read' as const, object_id: 'spend' }, { kind: 'object_history' as const, object_id: 'spend', offset: 0, limit: 5 }])
    assert.deepEqual(readHouseholdObjects(query, state, human, 200), { status: 'refused', reason: 'object_type_mismatch' });
  const definitions = readHouseholdObjects({ kind: 'object_list', offset: 0, limit: 10, kind_filter: 'definition' }, state, human, 200);
  assert.ok(definitions.status === 'ok' && definitions.kind === 'object_list');
  assert.deepEqual(definitions.objects.map(o => [o.object_id, o.title, o.certification]), [['spend', 'Monthly spend', null]]);
  assert.equal(readHouseholdObjects({ kind: 'object_read', object_id: 'spend', kind_filter: 'definition' }, state, human, 200).status, 'ok');
});

test('terms are unique ignoring case, match the title, and must be one trimmed line', () => {
  const state = seed();
  assert.deepEqual(create(state, 'spend-2', 'MONTHLY SPEND').outcome, { status: 'refused', reason: 'definition_term_taken' });
  const mismatch = decide(state, { kind: 'create_household_object', object_id: 'x', title: 'Other', content: definition('Due date') }, artifact('x', definition('Due date')));
  assert.deepEqual(mismatch.outcome, { status: 'refused', reason: 'definition_term_mismatch' });
  assert.equal(validDefinition(fields('Due date')), true);
  for (const bad of [fields(' padded'), fields('two\nlines'), fields('ok', '   '), fields('x'.repeat(81)), fields('ok', 'm', 's'.repeat(2001))])
    assert.equal(validDefinition(bad), false);
  assert.throws(() => validateHouseholdToolArguments('definition_create', { seat, request_id: 'request_1', object_id: 'x', ...fields('t'.repeat(81)) }));
});

test('only a person certifies, only the current revision, and edits wait for recertification', () => {
  let state = seed();
  const asAgent = certify(state, agent);
  assert.deepEqual(asAgent.outcome, { status: 'refused', reason: 'human_confirmation_required' });
  assert.equal(asAgent.events.length, 0);
  const first = state.objects.spend!.history[0]!.revision;
  const certified = certify(state);
  assert.deepEqual(certified.outcome, { status: 'committed', object_id: 'spend', revision: first });
  state = reduceHouseholdObjectStream(certified.events, state);
  assert.deepEqual(state.objects.spend!.certification, { revision: first, certified_by: 'alex', certified_at: certified.events[0]!.occurred_at_server });

  // An agent proposes a correction; certification stays on the first revision.
  const update = householdToolInvocation('definition_update', { seat, request_id: 'request_2', object_id: 'spend', base: first,
    before: fields('Monthly spend'), after: fields('Monthly spending', 'Card and cash spend in a calendar month.') }, host);
  assert.ok('command' in update);
  const proposed = definition('Monthly spending', 'Card and cash spend in a calendar month.');
  const edited = decide(state, update.command as HouseholdObjectCommand, artifact('spend', proposed, first),
    [artifact('spend', definition('Monthly spend'), first)], agent);
  assert.equal(edited.outcome.status, 'committed');
  state = reduceHouseholdObjectStream(edited.events, state);
  assert.equal(state.objects.spend!.history.at(-1)!.title, 'Monthly spending');
  assert.deepEqual(state.objects.spend!.certification!.revision, first);
  const listed = readHouseholdObjects({ kind: 'object_list', offset: 0, limit: 10, kind_filter: 'definition' }, state, human, 300);
  assert.ok(listed.status === 'ok' && listed.kind === 'object_list');
  assert.deepEqual(listed.objects[0]!.certification!.revision, first);

  assert.deepEqual(certify(state, human, first).outcome, { status: 'refused', reason: 'definition_not_current' });
  const again = certify(state);
  assert.equal(again.outcome.status, 'committed');
  state = reduceHouseholdObjectStream(again.events, state);
  assert.deepEqual(state.objects.spend!.certification!.revision, state.objects.spend!.history.at(-1)!.revision);
});

test('certify refuses other kinds and readers; replay rejects a certification by an agent', () => {
  const state = seed();
  const groceries = state.objects.groceries!.history[0]!.revision;
  assert.deepEqual(decide(state, { kind: 'certify_household_definition', object_id: 'groceries', revision: groceries }, null).outcome,
    { status: 'refused', reason: 'object_type_mismatch' });
  const reader = { ...human, member: { ...member, content_role: 'reader' as const } };
  assert.deepEqual(certify(state, reader).outcome, { status: 'refused', reason: 'content_read_only' });
  const event = certify(state).events[0]!;
  const forged = { ...event, actor_agent_principal: 'bot', actor_run: 'run',
    payload: { ...event.payload, receipt: { ...event.payload.receipt, principal: 'bot' } } } as HouseholdObjectEvent;
  assert.throws(() => reduceHouseholdObjectStream([forged], state), /invalid certification/);
});

test('the certify surface command is closed and binds its revision; catalogs are unchanged', () => {
  const revision = { workspace_id: workspace, object_id: 'spend', token: 'revision_000000000000000000000001' };
  assert.deepEqual(validateHouseholdHumanCommand({ kind: 'household_definition_certify', object_id: 'spend', revision }),
    { kind: 'household_definition_certify', object_id: 'spend', revision });
  assert.throws(() => validateHouseholdHumanCommand({ kind: 'household_definition_certify', object_id: 'other', revision }));
  assert.throws(() => validateHouseholdHumanCommand({ kind: 'household_definition_certify', object_id: 'spend', revision, extra: 1 }));
  const names = [...HOUSEHOLD_TOOLS, ...HOSTED_TODO_LIST_TOOLS].map(tool => tool.name);
  for (const name of ['definitions_search', 'definition_read', 'definition_create', 'definition_update']) assert.ok(!names.includes(name));
});
