import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error TS5097: edge source is exercised through tsx.
import { HOSTED_TOOL_TABLE, validateHostedToolArguments, HostedToolInputError } from '../supabase/functions/mcp/tools.ts';
// @ts-expect-error TS5097: edge source is exercised through tsx.
import { parseHouseholdAttachment, HouseholdAttachmentError } from '../supabase/functions/command/household-attachments.ts';

test('hosted content admission accepts valid patches and rejects model-supplied transfers before execution', () => {
  const args = { seat: 'seat_' + 'a'.repeat(22), request_id: 'request_001', object_id: 'notes',
    title: 'Notes', content: { kind: 'doc', markdown: 'Synthetic notes' } };
  assert.deepEqual(validateHostedToolArguments('object_create', args), args);
  assert.throws(() => validateHostedToolArguments('object_create', { ...args, url: 'https://example.test/file' }), HostedToolInputError);
  assert.throws(() => validateHostedToolArguments('object_create', { ...args, content: { kind: 'file', name: 'x.txt', media_type: 'text/plain' } }), HostedToolInputError);
  const tool = HOSTED_TOOL_TABLE.find(row => row.name === 'object_create')!;
  assert.equal(tool.annotations.readOnlyHint, false);
  assert.equal(HOSTED_TOOL_TABLE.find(row => row.name === 'file_upload_begin')!.annotations.readOnlyHint, false);
  assert.equal(HOSTED_TOOL_TABLE.find(row => row.name === 'object_history')!.annotations.readOnlyHint, true);
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
