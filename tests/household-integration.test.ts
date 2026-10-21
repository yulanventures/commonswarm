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

// @ts-expect-error TS5097: edge recovery assembly is exercised through tsx.
import { readHouseholdDraft } from '../supabase/functions/command/household-draft.ts';
test('recovery assembles proposal and recorded revisions without storage metadata and refuses oversized content', async () => {
  const bytes = (markdown: string) => new TextEncoder().encode(JSON.stringify({ kind: 'doc', markdown }));
  const ref = (token: string) => ({ workspace_id: 'w', object_id: 'o', token });
  const revision = (token: string) => ({ revision: ref(token), parent: null, title: token, kind: 'doc', file_metadata: null,
    blob: { storage_key: 'private-storage-path', size_bytes: 1, sha256: 'a'.repeat(64) },
    author: { user_id: 'u', principal_id: null, run_id: null }, occurred_at_server: 1, command_id: 'c' });
  let proposal = 'proposal';
  let reads = 0;
  const store = { readBytes: async (_tx: unknown, _workspace: string, _identity: unknown, query: any) => {
    reads++;
    if (query.kind === 'draft_read') return { bytes: bytes(proposal), metadata: { kind: 'draft_read', draft: {
      object_id: 'o', draft_id: 'd', kind: 'doc', owner: { user_id: 'u' }, base: ref('base'), current: ref('recorded-current') } } };
    return { bytes: bytes(query.revision.token), metadata: { kind: 'object_read', revision: revision(query.revision.token), live: false } };
  } };
  const identity = { user_id: 'u', principal_id: null, run_id: null, connection: null };
  const result = await readHouseholdDraft(null as any, 'w', identity, 'd', store as any);
  assert.equal(result.status, 'ok');
  assert.equal((result as any).base.content.markdown, 'base');
  assert.equal((result as any).current.content.markdown, 'recorded-current');
  assert.equal((result as any).proposed.markdown, 'proposal');
  assert.equal(JSON.stringify(result).includes('private-storage-path'), false);
  proposal = 'x'.repeat(40 * 1024);
  assert.deepEqual(await readHouseholdDraft(null as any, 'w', identity, 'd', store as any),
    { status: 'refused', reason: 'draft_response_too_large' });
  reads = 0;
  assert.deepEqual(await readHouseholdDraft(null as any, 'w', identity, '', store as any), { status: 'refused', reason: 'invalid_request' });
  assert.equal(reads, 0);
});
