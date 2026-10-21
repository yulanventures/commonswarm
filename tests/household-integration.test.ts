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
  const human = await readHouseholdDraft(null as any, 'w', identity, 'd', store as any, undefined, false);
  assert.equal(human.status, 'ok');
  assert.equal((human as any).proposed.markdown, proposal, 'human recovery retains the full large proposal');
  reads = 0;
  assert.deepEqual(await readHouseholdDraft(null as any, 'w', identity, '', store as any), { status: 'refused', reason: 'invalid_request' });
  assert.equal(reads, 0);
});

// @ts-expect-error TS5097: exercise the production transaction owner through tsx.
import { confirmOwnerHouseholdPermissions, HouseholdOwnerPermissionAborted } from '../supabase/functions/command/household-owner-permissions.ts';
// @ts-expect-error TS5097: exercise the production refusal boundary through tsx.
import { executeHouseholdSurface } from '../supabase/functions/command/household-integration.ts';
import { HouseholdObjectClient } from '../src/cloud/household-objects.js';
import { createHouseholdHttpTransport } from '../src/cloud/household-http.js';
import { HOUSEHOLD_LOCAL_SEAT, validateHouseholdToolArguments } from '../src/protocol/household-tool-registry.js';
const ownerId = '10000000-0000-4000-8000-000000000001';
const sourceId = '10000000-0000-4000-8000-000000000002';
const sourceGrant = '10000000-0000-4000-8000-000000000003';
const sourceConnection = '10000000-0000-4000-8000-000000000004';
const targetId = '10000000-0000-4000-8000-000000000005';
const targetGrant = '10000000-0000-4000-8000-000000000006';
const targetConnection = '10000000-0000-4000-8000-000000000007';
const workspaceId = '10000000-0000-4000-8000-000000000008';
const setupInput = () => ({ seat: HOUSEHOLD_LOCAL_SEAT, request_id: 'owner_test_01',
  confirmation: { kind: 'owner_chat', confirmed: true }, action: { kind: 'setup', purpose: 'shared', content_role: 'reader' } });
const allowInput = () => ({ ...setupInput(), action: { kind: 'allow_connection', connection: { kind: 'hosted',
  connection_id: targetConnection, grant_id: targetGrant, principal_id: targetId, operations: ['read'] } } });
function permissionFixture(overrides: Record<string, any> = {}) {
  const f: Record<string, any> = { role: 'owner', principal: true, credential: true, sent: true, boundary: null, rights: null,
    restrictions: [], approvals: [], prior: null, notices: [], writes: [], ...overrides };
  const actor = { user_id: ownerId, principal_id: sourceId as string | null, run_id: null as string | null,
    connection: { connection_id: sourceConnection, grant_id: sourceGrant } as {connection_id:string;grant_id:string} | null };
  const tx: any = async (parts: TemplateStringsArray, ...values: any[]) => {
    const sql = parts.join('?').replace(/\s+/g, ' ');
    if (/^(INSERT|UPDATE)/.test(sql)) { f.writes.push({ sql, values }); return []; }
    if (sql.includes('pg_catalog.pg_policy')) return [{ present: false }];
    if (sql.includes('FROM swarm.workspaces')) return [{ archived_at: null }];
    if (sql.includes('FROM swarm.memberships')) return [{ role: f.role, revoked_at: null }];
    if (sql.includes('FROM swarm.agent_principals')) return f.principal ? [{ revoked_at: null }] : [];
    if (sql.includes("current_setting('role')")) return [{ value: 'swarm_command' }];
    if (sql.includes('AS live')) return [{ live: f.targetLive !== false }];
    if (sql.includes('SELECT seat_id,grant_id,owner_user_id FROM swarm.hosted_mcp_seats')) return actor.run_id === null ? [{ seat_id: sourceConnection, grant_id: sourceGrant, owner_user_id: ownerId }] : [];
    if (sql.includes('FROM swarm.hosted_mcp_grants')) return [{ state: 'active', revoked_at: null }];
    if (sql.includes('FROM swarm.hosted_mcp_grant_workspaces')) return [{ revoked_at: null }];
    if (sql.includes('SELECT revoked_at FROM swarm.hosted_mcp_seats')) return [{ revoked_at: null }];
    if (sql.includes('FROM swarm.hosted_mcp_seats s')) return f.principal ? [{ seat_id: sourceConnection, handle: 'synthetic-handle', provider_grant_id: 'synthetic-provider' }] : [];
    if (sql.includes('FROM swarm.agent_tokens')) return [{ expires_at: '2099-01-01T00:00:00Z' }];
    if (sql.includes('FROM swarm.household_owner_permission_receipts')) return f.prior ? [f.prior] : [];
    if (sql.includes('FROM swarm.household_workspace_boundaries')) return f.boundary ? [f.boundary] : [];
    if (sql.includes('FROM swarm.household_member_content_roles')) return f.rights ? [f.rights] : [];
    if (sql.includes('FROM swarm.household_hosted_content_restrictions')) return f.restrictions;
    if (sql.includes('FROM swarm.household_content_connections')) return f.approvals;
    if (sql.includes('clock_timestamp() AS now')) return [{ now: '2026-10-21T00:00:00Z' }];
    if (sql.startsWith('LOCK ') || sql.includes('set_config(')) return [];
    throw new Error('Unimplemented synthetic SQL boundary');
  };
  tx.json = (value: any) => value;
  const notice = async (_tx: any, workspace: string, identity: any, value: any) => {
    f.notices.push({ workspace, identity, value });
    if (f.revokeOnNotice) f.credential = false;
    if (f.targetRevokeOnNotice) f.targetLive = false;
    return f.sent ? { status: 'sent', signal_id: 'signal_owner_01', to: value.to }
      : { status: 'not_sent', reason: 'signal_rate_limited', to: value.to };
  };
  return { f, actor, tx, notice, run: (input: any = setupInput()) => confirmOwnerHouseholdPermissions(tx, workspaceId, actor,
    input.request_id, input, async () => f.credential, notice as any) };
}

test('owner confirmation setup supports human, hosted and local verified sources and posts an attributed notice', async () => {
  for (const transport of ['human','hosted','local']) {
    const { f, actor, run } = permissionFixture();
    if (transport === 'human') { actor.principal_id = null; actor.connection = null; }
    if (transport === 'local') actor.run_id = sourceGrant;
    assert.equal((await run()).status, 'committed');
    assert.equal(f.notices.length, 1);
    assert.deepEqual(f.notices[0].value.to, [{ kind: 'user', id: ownerId }]);
    assert.equal(f.notices[0].identity.principal_id, actor.principal_id);
    assert.equal(f.writes.filter((w: any) => w.sql.includes('household_content_connections')).length, 0);
    assert.equal(f.writes.filter((w: any) => w.sql.includes('household_owner_permission_receipts')).length, 1);
  }
});

test('owner confirmation refuses dead credentials, downgraded membership, foreign principal and existing caller ceilings', async () => {
  for (const [fixture, reason] of [
    [{ credential: false }, 'credential_revoked'], [{ role: 'admin' }, 'owner_confirmation_required'],
    [{ principal: false }, 'connection_access_refused'],
    [{ restrictions: [{ operations: [] }] }, 'caller_content_restricted'],
    [{ approvals: [{ operations: [], revoked_at: null, expires_at: null }] }, 'caller_content_restricted'],
    [{ rights: { content_role: 'reader', revoked_at: '2026-10-20' } }, 'content_read_only'],
  ] as const) {
    const { f, run } = permissionFixture(fixture);
    assert.equal((await run()).reason, reason);
    assert.equal(f.notices.length, 0); assert.equal(f.writes.length, 0);
  }
});

test('owner confirmation rejects self principal and source shared-grant approval before writes', async () => {
  for (const target of [{ principal_id: sourceId }, { grant_id: sourceGrant }, { connection_id: sourceConnection }]) {
    const { f, run } = permissionFixture({ boundary: { purpose: 'shared' }, rights: { content_role: 'editor', revoked_at: null } });
    const input = allowInput(); Object.assign(input.action.connection, target);
    assert.equal((await run(input)).reason, 'self_permission_change_refused');
    assert.equal(f.notices.length, 0); assert.equal(f.writes.length, 0);
  }
});

test('owner confirmation requires sent notice and final credential recheck', async () => {
  for (const options of [{ sent: false }, { revokeOnNotice: true }]) {
    const denied = permissionFixture(options);
    await assert.rejects(denied.run(), HouseholdOwnerPermissionAborted);
    assert.equal(denied.f.writes.some((w: any) => w.sql.includes('household_owner_permission_receipts')), false);
  }
});

test('owner confirmation receipt replay is source-digest-bound and does not send another notice', async () => {
  const { f, actor, run } = permissionFixture();
  const first = await run();
  const receipt = f.writes.find((w: any) => w.sql.includes('household_owner_permission_receipts'));
  f.prior = { request_digest: receipt.values[5], response: first };
  assert.equal((await run()).replayed, true);
  assert.equal(f.notices.length, 1);
  const changed = setupInput(); changed.action.content_role = 'editor';
  assert.equal((await run(changed)).reason, 'request_id_reused');
  actor.connection!.connection_id = targetConnection;
  assert.equal((await run()).reason, 'request_id_reused');
  assert.equal(f.notices.length, 1);
});

test('permission CLI/MCP client emits the real command and decodes only a sent owner receipt', async () => {
  let wire: any;
  const committed = { status: 'committed', request_id: 'owner_test_01', action: 'setup',
    notice: { status: 'sent', signal_id: 'signal_owner_01', secret: 'must not copy' }, replayed: false };
  let reply: any = committed;
  const client = new HouseholdObjectClient(createHouseholdHttpTransport({ target: { url: 'https://example.test', anonKey: 'synthetic' } as any,
    authenticate: async () => ({ credential: 'synthetic', fetcher: (async (_url: any, init: any) => {
      wire = JSON.parse(init.body);
      return new Response(JSON.stringify(reply));
    }) as any }) }), workspaceId);
  assert.deepEqual(await client.prepare('object_permissions_confirm', setupInput()).send(), { status: 'committed',
    request_id: 'owner_test_01', action: 'setup', notice: { status: 'sent', signal_id: 'signal_owner_01' }, replayed: false });
  assert.equal(wire.command.tool, 'object_permissions_confirm');
  assert.equal(wire.command.arguments.confirmation.confirmed, true);
  for (const malformed of [{ notice: { status: 'not_sent' } }, { notice: { status: 'sent' } },
    { action: 'allow_connection' }, { request_id: 'other_request_01' }, { replayed: 'false' }]) {
    reply = { ...committed, ...malformed };
    const result = await client.prepare('object_permissions_confirm', setupInput()).send();
    assert.equal(result.status, 'unknown');
    assert.equal((result as any).reason, 'invalid_response');
  }
  for (const bad of [{ ...setupInput(), confirmation: { kind: 'owner_chat', confirmed: false } },
    { ...setupInput(), owner_user_id: ownerId }, { ...setupInput(), audit_context: { message_ref: 'x'.repeat(129) } }])
    assert.throws(() => validateHouseholdToolArguments('object_permissions_confirm', bad));
});


test('owner human may allow another live owned connection; target death and reader ceilings refuse it', async () => {
  for (const state of [{}, { targetLive: false }, { rights: { content_role: 'reader', revoked_at: null } }]) {
    const { f, actor, run } = permissionFixture({ boundary: { purpose: 'shared' },
      rights: { content_role: 'editor', content_consent_id: ownerId, revoked_at: null }, ...state });
    actor.principal_id = null; actor.connection = null;
    const input = allowInput(); input.action.connection.operations = ['read','update'];
    const result = await run(input);
    assert.equal(result.status, Object.keys(state).length ? 'refused' : 'committed');
    assert.equal(f.notices.length, Object.keys(state).length ? 0 : 1);
  }
});


test('eligible owner agents may approve another connection within their existing content ceiling', async () => {
  for (const transport of ['hosted', 'local']) {
    const { f, actor, run } = permissionFixture({ boundary: { purpose: 'shared' },
      rights: { content_role: 'reader', content_consent_id: ownerId, revoked_at: null },
      approvals: transport === 'local' ? [{ connection_id: sourceConnection, grant_id: sourceGrant,
        principal_id: sourceId, owner_user_id: ownerId, workspace_id: workspaceId, purpose: 'shared',
        hosted_grant_id: null, operations: ['read'], expires_at: null, revoked_at: null,
        consent_receipt_id: ownerId }] : [] });
    if (transport === 'local') actor.run_id = sourceGrant;
    const result = await run(allowInput());
    assert.equal(result.status, 'committed', transport);
    assert.equal(f.notices.length, 1);
    assert.equal(f.writes.filter((w: any) => w.sql.includes('household_content_connections')).length, 1);
    assert.equal(f.writes.some((w: any) => w.sql.includes('household_hosted_content_restrictions')), false);
  }
});


test('owner confirmation aborts if the target stops being live during notice delivery', async () => {
  const { f, actor, run } = permissionFixture({ boundary: { purpose: 'shared' },
    rights: { content_role: 'reader', content_consent_id: ownerId, revoked_at: null }, targetRevokeOnNotice: true });
  actor.principal_id = null; actor.connection = null;
  await assert.rejects(run(allowInput()), HouseholdOwnerPermissionAborted);
  assert.equal(f.notices.length, 1);
  assert.equal(f.writes.some((w: any) => w.sql.includes('household_owner_permission_receipts')), false);
});


test('private draft admission never advertises a permission repair, beside a real consent remedy control', async () => {
  const { actor, tx, notice } = permissionFixture({ boundary: { purpose: 'shared' }, rights: null });
  actor.principal_id = null; actor.connection = null;
  const invoke = (tool: string, input: Record<string, unknown>) => executeHouseholdSurface(tx, workspaceId, actor,
    'draft_private_01', { kind: 'household_tool', tool, arguments: { seat: HOUSEHOLD_LOCAL_SEAT, ...input } },
    async () => true, undefined, notice as any);
  const ordinary = await invoke('object_list', { offset: 0, limit: 1 });
  assert.equal(ordinary.reason, 'content_consent_required');
  assert.equal(ordinary.mcp_tool, 'object_permissions_confirm');
  for (const tool of ['object_draft_read', 'list_draft_read']) {
    const denied = await invoke(tool, { draft_id: 'unknown_private_draft' });
    assert.equal(denied.reason, 'draft_access_refused');
    assert.equal(denied.mcp_tool, null); assert.equal(denied.cli_command, null); assert.equal(denied.remedy_url, null);
    assert.equal('object_id' in denied, false);
  }
});
