/** Definition tools on the local MCP (semantic layer C2b): sent under their own
 * name and arguments, decoded through closed projections, and cited by provenance. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { HouseholdObjectClient } from '../src/cloud/household-objects.js';
import { householdWireRequest } from '../src/cloud/household-http.js';
import { createHouseholdMcpTools } from '../src/mcp/household-tools.js';
import { HOUSEHOLD_LOCAL_SEAT, type HouseholdToolInvocation } from '../src/protocol/household-tool-registry.js';

const workspace = '11111111-1111-4111-8111-111111111111', seat = HOUSEHOLD_LOCAL_SEAT;
const ref = (object_id: string, n: number) => ({ workspace_id: workspace, object_id, token: `revision_${String(n).padStart(24, '0')}` });
const author = { user_id: 'alex', principal_id: null, run_id: null, connection_id: null, grant_id: null };
const certified = { revision: ref('spend', 1), term: 'Monthly spend', meaning: 'Card spend per month.', source: 'Statements',
  certified_by: 'alex', certified_at: 7 };
const read = { status: 'ok', object_id: 'spend', proposal_pending: true, certified,
  current: { revision: ref('spend', 2), term: 'Monthly spend', meaning: 'Card and cash spend per month.', source: 'Statements',
    author, occurred_at_server: 9 } };
const search = { status: 'ok', next_offset: 1, definitions: [
  { object_id: 'spend', term: 'Monthly spend', revision: ref('spend', 2), certification: { revision: ref('spend', 1), certified_by: 'alex', certified_at: 7 } }] };

function host(responses: Record<string, unknown>) {
  const sent: ReturnType<typeof householdWireRequest>[] = [];
  const client = new HouseholdObjectClient({ execute: async (invocation: HouseholdToolInvocation) => {
    const wire = householdWireRequest(invocation);
    sent.push(wire);
    return structuredClone(responses[wire.tool]);
  } }, workspace);
  return { tools: createHouseholdMcpTools(client), sent };
}
const output = async (tools: ReturnType<typeof host>['tools'], name: string, args: Record<string, unknown>) => {
  const result = await tools.call(name, { seat, ...args });
  return { isError: result.isError, body: JSON.parse(result.content[0]!.text) };
};

test('definition reads travel under their own name and arguments', async () => {
  const { tools, sent } = host({ definitions_search: search, definition_read: read });
  await output(tools, 'definitions_search', { query: 'spend', limit: 1 });
  await output(tools, 'definition_read', { object_id: 'spend' });
  assert.deepEqual(sent, [
    { tool: 'definitions_search', arguments: { seat, query: 'spend', limit: 1 } },
    { tool: 'definition_read', arguments: { seat, object_id: 'spend' } },
  ]);
});

test('definition_read decodes a closed projection and cites the certified revision', async () => {
  const { tools } = host({ definition_read: { ...read, extra: 'dropped', current: { ...read.current, secret: 'dropped' } } });
  const { isError, body } = await output(tools, 'definition_read', { object_id: 'spend' });
  assert.equal(isError, false);
  assert.deepEqual(body.current, { term: 'Monthly spend', meaning: 'Card and cash spend per month.', source: 'Statements',
    revision: ref('spend', 2), author: { user_id: 'alex', principal_id: null }, occurred_at_server: 9 });
  assert.deepEqual(body.certified, certified);
  assert.equal(body.proposal_pending, true);
  assert.equal('extra' in body, false);
  assert.deepEqual(body.provenance, { sources: [{ kind: 'definition', id: 'spend', title: 'Monthly spend', revision: ref('spend', 1).token }],
    query: { tool: 'definition_read', object_id: 'spend' }, row_count: 1, truncated: false });
});

test('definitions_search decodes terms with certification and pages through provenance', async () => {
  const { tools } = host({ definitions_search: search });
  const { body } = await output(tools, 'definitions_search', { query: 'spend', limit: 1 });
  assert.deepEqual(body.definitions, search.definitions);
  assert.deepEqual(body.provenance, { sources: [{ kind: 'definition', id: 'spend', title: 'Monthly spend', revision: ref('spend', 2).token }],
    query: { tool: 'definitions_search', query: 'spend', limit: 1 }, row_count: 1, truncated: true });
});

test('malformed or foreign definition responses are unknown, never passed through', async () => {
  for (const bad of [{ ...read, certified: { ...certified, revision: { ...certified.revision, workspace_id: 'other' } } },
    { ...read, current: { ...read.current, term: '' } }, { ...search, definitions: [{ object_id: 'spend', term: 'x' }] }]) {
    const { tools } = host({ definition_read: bad, definitions_search: bad });
    const name = 'definitions' in bad ? 'definitions_search' : 'definition_read';
    const { body } = await output(tools, name, name === 'definition_read' ? { object_id: 'spend' } : {});
    assert.deepEqual([body.status, body.reason], ['unknown', 'invalid_response']);
  }
});

test('proposals are ordinary committed writes; certify is not a tool', async () => {
  const { tools, sent } = host({ definition_create: { status: 'committed', object_id: 'due', revision: ref('due', 3) } });
  const { body } = await output(tools, 'definition_create', { request_id: 'request_001', object_id: 'due', term: 'Due date',
    meaning: 'When a bill must be paid.', source: '' });
  assert.deepEqual([body.status, body.object_id], ['committed', 'due']);
  assert.equal(sent[0]!.tool, 'definition_create');
  assert.ok(!tools.tools.some(tool => /certif/i.test(tool.name)));
});

test('check_answerable decodes closed and marks provenance truncated past the shown terms', async () => {
  const answer = { status: 'ok', answerable: true, matched_count: 6, reason: null, proposed: [{ object_id: 'due', term: 'Due date' }],
    terms: [{ object_id: 'spend', term: 'Monthly spend', revision: ref('spend', 1), meaning: 'Card spend per month.', source: 'Statements', extra: 'x' }] };
  const { tools, sent } = host({ check_answerable: answer });
  const { body } = await output(tools, 'check_answerable', { question: 'monthly spend?' });
  assert.deepEqual(sent[0], { tool: 'check_answerable', arguments: { seat, question: 'monthly spend?' } });
  assert.deepEqual(body.terms, [{ object_id: 'spend', revision: ref('spend', 1), term: 'Monthly spend', meaning: 'Card spend per month.', source: 'Statements' }]);
  assert.deepEqual(body.provenance, { sources: [{ kind: 'definition', id: 'spend', title: 'Monthly spend', revision: ref('spend', 1).token }],
    query: { tool: 'check_answerable', question: 'monthly spend?' }, row_count: 1, truncated: true });
  for (const bad of [{ ...answer, answerable: false }, { ...answer, reason: 'no_certified_term' }, { ...answer, matched_count: 0 }]) {
    const { tools: other } = host({ check_answerable: bad });
    assert.equal((await output(other, 'check_answerable', { question: 'x' })).body.status, 'unknown');
  }
});
