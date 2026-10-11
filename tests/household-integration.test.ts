/** Exercise hosted list argument admission and the separate attachment parser.
 * Synthetic payloads must not admit docs, files or model-supplied transfers. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hostedHouseholdRelease } from './support/hosted-household-release.js';
// @ts-expect-error TS5097: edge source is exercised through tsx.
import { parseHouseholdAttachment, HouseholdAttachmentError } from '../supabase/functions/command/household-attachments.ts';

test('hosted list admission accepts list creation and refuses docs, files and model-supplied transfers', async () => {
  const { HOSTED_TOOL_TABLE, validateHostedToolArguments, HostedToolInputError } = await hostedHouseholdRelease(true);
  const args = { seat: 'seat_' + 'a'.repeat(22), request_id: 'request_001', object_id: 'notes',
    title: 'Notes', content: { kind: 'list', items: [] } };
  assert.deepEqual(validateHostedToolArguments('list_create', args), args);
  assert.throws(() => validateHostedToolArguments('list_create', { ...args, url: 'https://example.test/file' }), HostedToolInputError);
  for (const content of [{ kind: 'doc', markdown: 'Synthetic notes' }, { kind: 'file', name: 'x.txt', media_type: 'text/plain' }])
    assert.throws(() => validateHostedToolArguments('list_create', { ...args, content }), HostedToolInputError);
  const tool = HOSTED_TOOL_TABLE.find(row => row.name === 'list_create')!;
  assert.equal(tool.annotations.readOnlyHint, false);
  assert.equal(HOSTED_TOOL_TABLE.find(row => row.name === 'list_history')!.annotations.readOnlyHint, true);
});

test('protected attachment parser carries bytes separately and refuses foreign metadata and extra parts', async () => {
  const form = () => {
    const result = new FormData();
    result.set('command', JSON.stringify({ workspace_id: 'workspace', command: { kind: 'household_tool', tool: 'file_upload_begin' } }));
    result.set('attachment', new Blob(['synthetic bytes']), 'synthetic.txt');
    return result;
  };
  const parsed = await parseHouseholdAttachment(new Request('https://example.test/command', { method: 'POST', body: form() }));
  assert.equal(new TextDecoder().decode(parsed.attachment), 'synthetic bytes');
  assert.equal((parsed.body.command as any).tool, 'file_upload_begin');
  const extra = form(); extra.set('url', 'https://example.test/untrusted');
  await assert.rejects(parseHouseholdAttachment(new Request('https://example.test/command', { method: 'POST', body: extra })), HouseholdAttachmentError);
  const foreign = form(); foreign.set('command', JSON.stringify({ command: { kind: 'post_signal' } }));
  await assert.rejects(parseHouseholdAttachment(new Request('https://example.test/command', { method: 'POST', body: foreign })), HouseholdAttachmentError);
});
