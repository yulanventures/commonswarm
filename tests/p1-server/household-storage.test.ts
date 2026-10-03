/** H2 adapter/Storage/PostgreSQL cases; test:p1-server's existing glob owns
 * these. They deliberately bypass HTTP dispatch, which belongs to lane 4.
 * No fixtures carry customer data, production targets, or fixed host paths.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { createClient } from '@supabase/supabase-js';
import postgres from 'postgres';
import * as objects from '../../src/protocol/household-objects.js';
import * as policy from '../../src/protocol/household-object-policy.js';
import * as transfers from '../../supabase/functions/command/household-transfers.js';
import { createHouseholdObjectStore, type HouseholdIdentity, type HouseholdProposal } from '../../supabase/functions/command/household-objects.js';
import type { HouseholdObjectCommand } from '../../src/protocol/household-objects.js';
import type { HouseholdContent, HouseholdObjectState, HouseholdRevisionRef } from '../../src/protocol/household-object-events.js';

let sql: postgres.Sql;
let storage: transfers.HouseholdStorage;
let allowed: (name: string, type: string) => boolean;
let owner: string, other: string;
const core = { ...objects, ...policy };
let local: { API_URL: string; DB_URL: string; SERVICE_ROLE_KEY: string };

before(async () => {
  local = JSON.parse(execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  for (const target of [local.API_URL, local.DB_URL]) assert.ok(['127.0.0.1','localhost','[::1]'].includes(new URL(target).hostname), 'local stack only');
  sql = postgres(local.DB_URL, { prepare: false });
  const auth = createClient(local.API_URL, local.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const users = [];
  for (const label of ['H2 owner','H2 other']) {
    const response = await auth.auth.admin.createUser({ email: `h2-${randomUUID()}@example.test`, password: randomBytes(32).toString('base64url'), email_confirm: true });
    assert.ok(!response.error && response.data.user, 'synthetic user creation failed');
    users.push(response.data.user.id);
    await sql`INSERT INTO swarm.users(user_id,display_name) VALUES (${response.data.user.id}::uuid,${label})`;
  }
  [owner, other] = users as [string,string];
  // Runtime import follows the real existing allowlist, without pulling the
  // Deno-only generated protocol declarations into the Node test type graph.
  const existing = await import(new URL('../../supabase/functions/command/file-artifacts.ts', import.meta.url).href);
  allowed = existing.fileContentAllowed;
  storage = transfers.createHouseholdTransferStorage({ storageBaseUrl: `${local.API_URL}/storage/v1`, bucket: existing.FILE_BUCKET, serviceCredential: local.SERVICE_ROLE_KEY });
});
after(async () => { await sql?.end(); });

const human = (id = owner): HouseholdIdentity => ({ user_id: id, principal_id: null, run_id: null, connection: null });
const proposal = (markdown: string): HouseholdProposal => ({ content: { kind: 'doc', markdown } });
const newDoc = (objectId: string, title = 'Synthetic doc'): HouseholdObjectCommand => ({ kind: 'create_household_object', object_id: objectId, title, content: proposal('base').content });
const patch = (objectId: string, base: HouseholdRevisionRef, after: string): HouseholdObjectCommand => ({ kind: 'update_household_object', object_id: objectId, base, patch: { kind: 'doc', splices: [{ start: 0, before: 'base', after }] } });
function store(override: Partial<Parameters<typeof createHouseholdObjectStore>[0]> = {}) {
  return createHouseholdObjectStore({ core, transfers, storage, fileContentAllowed: allowed,
    recheckCredential: async (_tx, identity) => [owner, other].includes(identity.user_id), ...override });
}
async function fixture(purpose: 'personal' | 'shared' = 'shared') {
  const workspace = randomUUID();
  await sql`INSERT INTO swarm.workspaces(workspace_id,name,created_by) VALUES (${workspace}::uuid,'H2 synthetic',${owner}::uuid)`;
  await sql`INSERT INTO swarm.memberships(workspace_id,user_id,role) VALUES (${workspace}::uuid,${owner}::uuid,'owner'),(${workspace}::uuid,${other}::uuid,'member')`;
  await sql`INSERT INTO swarm.household_workspace_boundaries(workspace_id,purpose,owner_user_id) VALUES (${workspace}::uuid,${purpose},${purpose === 'personal' ? owner : null}::uuid)`;
  for (const user of [owner, other]) await sql`INSERT INTO swarm.household_member_content_roles(workspace_id,user_id,content_role,content_consent_id,confirmed_at)
    VALUES (${workspace}::uuid,${user}::uuid,'editor',${randomUUID()}::uuid,clock_timestamp())`;
  return workspace;
}
async function write(workspace: string, command: HouseholdObjectCommand, proposed: HouseholdProposal | null,
  requestId = randomUUID(), identity = human(), adapter = store()) {
  return await sql.begin(async tx => { await tx`SET LOCAL ROLE swarm_command`; return await adapter.write(tx, workspace, identity, requestId, command, proposed); });
}
async function read(workspace: string, identity: HouseholdIdentity, query: Parameters<ReturnType<typeof store>['read']>[3], adapter = store()) {
  return await sql.begin(async tx => { await tx`SET LOCAL ROLE swarm_command`; return await adapter.read(tx, workspace, identity, query); });
}
async function bytes(workspace: string, identity: HouseholdIdentity, query: Parameters<ReturnType<typeof store>['readBytes']>[3], adapter = store()) {
  return await sql.begin(async tx => { await tx`SET LOCAL ROLE swarm_command`; return await adapter.readBytes(tx, workspace, identity, query); });
}
function committed(result: Awaited<ReturnType<typeof write>>): HouseholdRevisionRef {
  assert.equal(result.outcome.status, 'committed');
  if (result.outcome.status !== 'committed') throw new Error('expected committed revision');
  return result.outcome.revision;
}

// The pure suite already owns patch semantics. Here the extra risk is locking,
// real storage, durable retry/counters and drafts inaccessible to another member.
test('same-base writers serialize, retain losing bytes privately, and recover exact retries without new revisions or counters', async () => {
  const workspace = await fixture(), object = randomUUID();
  const base = committed(await write(workspace, newDoc(object), proposal('base')));
  const requests = [randomUUID(), randomUUID()];
  const commands = [patch(object, base, 'first'), patch(object, base, 'second')];
  const results = await Promise.all(commands.map((command, i) => write(workspace, command, proposal(i ? 'second' : 'first'), requests[i], i ? human(other) : human())));
  assert.deepEqual(results.map(r => r.outcome.status).sort(), ['committed','conflict']);
  const winnerIndex = results.findIndex(r => r.outcome.status === 'committed');
  const loserIndex = 1 - winnerIndex, loser = results[loserIndex]!.outcome;
  assert.equal(loser.status, 'conflict');
  if (loser.status !== 'conflict') throw new Error('expected preserved draft');
  const losingIdentity = loserIndex ? human(other) : human();
  const draft = await bytes(workspace, losingIdentity, { kind: 'draft_read', draft_id: loser.draft_id });
  assert.ok('bytes' in draft);
  if ('bytes' in draft) assert.deepEqual(transfers.decodeHouseholdContent(draft.bytes, 'doc'), proposal(loserIndex ? 'second' : 'first').content);
  const refused = await bytes(workspace, loserIndex ? human() : human(other), { kind: 'draft_read', draft_id: loser.draft_id });
  assert.deepEqual(refused, { status: 'refused', reason: 'draft_access_refused' });
  const [before] = await sql`SELECT count FROM swarm.rate_buckets WHERE bucket_key=${`file:create:ws:${workspace}`} AND window_start=date_trunc('hour',statement_timestamp())`;
  assert.deepEqual((await write(workspace, commands[loserIndex]!, proposal(loserIndex ? 'second' : 'first'), requests[loserIndex], losingIdentity)).outcome, loser);
  assert.equal((await write(workspace, commands[loserIndex]!, proposal('changed request'), requests[loserIndex], losingIdentity)).outcome.status, 'refused');
  const [afterRetry] = await sql`SELECT count FROM swarm.rate_buckets WHERE bucket_key=${`file:create:ws:${workspace}`} AND window_start=date_trunc('hour',statement_timestamp())`;
  assert.equal(afterRetry!.count, before!.count);
  const history = await read(workspace, human(), { kind: 'object_history', object_id: object, offset: 0, limit: 100 });
  assert.ok(history.status === 'ok' && history.kind === 'object_history');
  if (history.status === 'ok' && history.kind === 'object_history') assert.equal(history.revisions.length, 2);
  const [projection] = await sql`SELECT projection FROM swarm.household_object_streams WHERE workspace_id=${workspace}::uuid`;
  const events = await sql`SELECT event FROM swarm.household_object_events WHERE workspace_id=${workspace}::uuid ORDER BY seq`;
  const persisted = projection!.projection as HouseholdObjectState;
  assert.deepEqual(objects.reduceHouseholdObjectStream(events.map(r => r.event) as Parameters<typeof objects.reduceHouseholdObjectStream>[0], objects.emptyHouseholdObjectState(workspace, persisted.stream_id)), persisted);
});

test('reader, missing consent, foreign workspace, personal boundary and revoked membership refuse metadata, writes and bytes with authorized controls', async () => {
  const workspace = await fixture(), object = randomUUID();
  committed(await write(workspace, newDoc(object), proposal('base')));
  await sql`UPDATE swarm.household_member_content_roles SET content_role='reader' WHERE workspace_id=${workspace}::uuid AND user_id=${other}::uuid`;
  assert.ok('bytes' in await bytes(workspace, human(other), { kind: 'object_read', object_id: object }));
  const readerRefusal = (await write(workspace, newDoc(randomUUID()), proposal('base'), randomUUID(), human(other))).outcome;
  assert.ok(readerRefusal.status === 'refused' && readerRefusal.reason === 'content_read_only');
  await sql`UPDATE swarm.household_member_content_roles SET revoked_at=clock_timestamp() WHERE workspace_id=${workspace}::uuid AND user_id=${other}::uuid`;
  for (const query of [{ kind: 'object_list', offset: 0, limit: 10 }, { kind: 'object_history', object_id: object, offset: 0, limit: 10 }] as const) {
    assert.equal((await read(workspace, human(other), query)).status, 'refused');
  }
  assert.equal((await bytes(workspace, human(other), { kind: 'object_read', object_id: object })).status, 'refused');
  assert.ok('bytes' in await bytes(workspace, human(), { kind: 'object_read', object_id: object }));
  const personal = await fixture('personal');
  assert.equal((await read(personal, human(other), { kind: 'object_list', offset: 0, limit: 10 })).status, 'refused');
  assert.equal((await read(workspace, human(), { kind: 'object_read', object_id: randomUUID() })).status, 'refused');
  const foreign = await fixture();
  committed(await write(foreign, newDoc(object), proposal('base')));
  await sql`UPDATE swarm.memberships SET revoked_at=clock_timestamp() WHERE workspace_id=${foreign}::uuid AND user_id=${owner}::uuid`;
  assert.equal((await read(foreign, human(), { kind: 'object_read', object_id: object })).status, 'refused');
  assert.ok('bytes' in await bytes(workspace, human(), { kind: 'object_read', object_id: object }));
});

test('file reservations recheck base at commit, verify actual stored digest, and keep conflicts quota-counted', async () => {
  const workspace = await fixture(), object = randomUUID();
  const metadata: HouseholdContent = { kind: 'file', name: 'synthetic.txt', media_type: 'text/plain' };
  const first = committed(await write(workspace, { kind: 'create_household_object', object_id: object, title: 'Synthetic file', content: metadata }, { content: metadata, file_bytes: new TextEncoder().encode('base') }));
  const [old] = await sql`SELECT sha256 FROM swarm.household_object_artifacts WHERE workspace_id=${workspace}::uuid AND revision_token=${first.token}`;
  const reserve = (reservation: string): HouseholdObjectCommand => ({ kind: 'reserve_household_upload', object_id: object, reservation_id: reservation, expires_at: Date.now() + 600000,
    change: { kind: 'update', base: first, patch: { kind: 'file', before_sha256: String(old!.sha256), replacement: metadata } } });
  const reservations = [randomUUID(),randomUUID()];
  for (const reservation of reservations) assert.equal((await write(workspace, reserve(reservation), { content: metadata, file_bytes: new TextEncoder().encode('next') })).outcome.status, 'pending');
  await sql`UPDATE swarm.file_versions SET created_at=clock_timestamp()-interval '4 hours' WHERE workspace_id=${workspace}::uuid AND state='pending'`;
  await sql`SELECT swarm.purge_file_artifacts()`;
  const surviving = await sql`SELECT state FROM swarm.file_versions WHERE workspace_id=${workspace}::uuid AND state='pending'`;
  assert.equal(surviving.length,2);
  committed(await write(workspace, { kind: 'commit_household_upload', reservation_id: reservations[0]!, operation: 'update' }, null));
  const conflict = await write(workspace, { kind: 'commit_household_upload', reservation_id: reservations[1]!, operation: 'update' }, null);
  assert.equal(conflict.outcome.status, 'conflict');
  const [projection] = await sql`SELECT projection FROM swarm.household_object_streams WHERE workspace_id=${workspace}::uuid`;
  assert.deepEqual(objects.householdObjectUsage(projection!.projection as HouseholdObjectState), { object_count: 1, storage_bytes: 12 });
  // Corrupt a pending object's bytes with privileged local Storage API only.
  // Same size, different digest: size-only commit would incorrectly pass.
  const corruptObject = randomUUID(), corruptReservation = randomUUID();
  await write(workspace, { kind: 'reserve_household_upload', object_id: corruptObject, reservation_id: corruptReservation, expires_at: Date.now()+600000,
    change: { kind: 'create', title: 'Corrupt fixture', content: metadata } }, { content: metadata, file_bytes: new TextEncoder().encode('good') });
  const [artifact] = await sql`SELECT storage_path FROM swarm.household_object_artifacts WHERE workspace_id=${workspace}::uuid AND reservation_id=${corruptReservation}`;
  const client = createClient(local.API_URL, local.SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const changed = await client.storage.from('swarm-files').upload(String(artifact!.storage_path), new TextEncoder().encode('evil'), { upsert: true, contentType: 'application/octet-stream' });
  assert.ok(!changed.error, 'local corruption fixture failed');
  await assert.rejects(write(workspace, { kind: 'commit_household_upload', reservation_id: corruptReservation, operation: 'create' }, null), (error: unknown) => error instanceof transfers.HouseholdTransferError && error.code === 'bytes_mismatch');
  const [stillPending] = await sql`SELECT state FROM swarm.household_object_artifacts WHERE workspace_id=${workspace}::uuid AND reservation_id=${corruptReservation}`;
  assert.equal(stillPending!.state, 'reserved');
  assert.equal((await write(workspace, { kind: 'release_household_upload', reservation_id: corruptReservation, operation: 'create' }, null)).outcome.status, 'released');
});

test('agent operation ceilings and parent hosted-grant withdrawal fence reads, history, writes, retry and bytes', async () => {
  const workspace = await fixture(), object = randomUUID(), principal = randomUUID(), grant = randomUUID(), connection = randomUUID();
  committed(await write(workspace, newDoc(object), proposal('base')));
  await sql`INSERT INTO swarm.agent_principals(principal_id,workspace_id,owner_user_id,name,transport,turn_only) VALUES (${principal}::uuid,${workspace}::uuid,${owner}::uuid,'H2 hosted','hosted_mcp',true)`;
  const manifest = randomBytes(32);
  await sql`INSERT INTO swarm.hosted_mcp_grants(grant_id,provider_grant_id,owner_user_id,home_workspace_id,client_id,resource,selected_workspace_ids,manifest_digest,interaction_ref,state,created_at,activated_at)
    VALUES (${grant}::uuid,${`h2-${grant}`},${owner}::uuid,${workspace}::uuid,'h2-synthetic','https://mcp.commonswarm.com/mcp',${sql.array([workspace])}::uuid[],${manifest},'synthetic-consent','active',clock_timestamp(),clock_timestamp())`;
  await sql`INSERT INTO swarm.hosted_mcp_grant_workspaces(grant_id,workspace_id,owner_user_id,manifest_digest,consent_receipt_id,consented_at)
    VALUES (${grant}::uuid,${workspace}::uuid,${owner}::uuid,${manifest},${randomUUID()}::uuid,clock_timestamp())`;
  await sql`INSERT INTO swarm.hosted_mcp_seats(seat_id,grant_id,workspace_id,owner_user_id,principal_id,name,created_at)
    VALUES (${randomUUID()}::uuid,${grant}::uuid,${workspace}::uuid,${owner}::uuid,${principal}::uuid,'H2 synthetic seat',clock_timestamp())`;
  await sql`INSERT INTO swarm.household_content_connections(connection_id,grant_id,workspace_id,principal_id,owner_user_id,purpose,operations,consent_receipt_id,expires_at,hosted_grant_id)
    VALUES (${connection}::uuid,${grant}::uuid,${workspace}::uuid,${principal}::uuid,${owner}::uuid,'shared',ARRAY['read'],${randomUUID()}::uuid,clock_timestamp()+interval '1 hour',${grant}::uuid)`;
  const identity: HouseholdIdentity = { user_id: owner, principal_id: principal, run_id: null, connection: { connection_id: connection, grant_id: grant } };
  assert.ok('bytes' in await bytes(workspace, identity, { kind: 'object_read', object_id: object }));
  assert.equal((await write(workspace, newDoc(randomUUID()), proposal('base'),randomUUID(),identity)).outcome.status,'refused');
  await sql`UPDATE swarm.household_content_connections SET operations=ARRAY['read','create','update'] WHERE connection_id=${connection}::uuid`;
  const request = randomUUID(), newObject = randomUUID(), command = newDoc(newObject);
  committed(await write(workspace,command,proposal('base'),request,identity));
  const wrongWorkspace = await fixture();
  assert.equal((await read(wrongWorkspace,identity,{ kind: 'object_list',offset:0,limit:10 })).status,'refused');
  await sql`UPDATE swarm.hosted_mcp_grants SET state='revoked',revoked_at=clock_timestamp() WHERE grant_id=${grant}::uuid`;
  assert.equal((await write(workspace,command,proposal('base'),request,identity)).outcome.status,'refused');
  assert.equal((await read(workspace,identity,{kind:'object_history',object_id:object,offset:0,limit:10})).status,'refused');
  assert.equal((await bytes(workspace,identity,{kind:'object_read',object_id:object})).status,'refused');
  assert.ok('bytes' in await bytes(workspace,human(other),{kind:'object_read',object_id:object}));
});

test('quota and name reservations serialize with legacy storage and retained expired declarations', async () => {
  const workspace = await fixture(), legacyFile = randomUUID();
  const encodedSize = transfers.householdContentBytes(proposal('base').content).byteLength;
  await sql`INSERT INTO swarm.files(file_id,workspace_id,name,created_by_kind,created_by) VALUES (${legacyFile}::uuid,${workspace}::uuid,'quota.txt','user',${owner}::uuid)`;
  await sql`INSERT INTO swarm.file_versions(version_id,file_id,workspace_id,version_n,state,size_bytes,content_type,storage_path,uploaded_by_kind,uploaded_by,created_at)
    VALUES (${randomUUID()}::uuid,${legacyFile}::uuid,${workspace}::uuid,1,'pending',${policy.HOUSEHOLD_STORAGE_BYTE_LIMIT - encodedSize},'text/plain',${`${workspace}/${legacyFile}/1`},'user',${owner}::uuid,clock_timestamp()-interval '4 hours')`;
  const results = await Promise.all([randomUUID(),randomUUID()].map(id => write(workspace, newDoc(id), proposal('base'))));
  assert.deepEqual(results.map(r => r.outcome.status).sort(), ['committed','refused']);
  const refused = results.find(r => r.outcome.status === 'refused')!;
  assert.ok(refused.outcome.status === 'refused' && refused.outcome.reason === 'storage_quota_reached');
  const nameWorkspace = await fixture();
  const sameObject = randomUUID();
  const pending = await Promise.all([randomUUID(),randomUUID()].map(id => write(nameWorkspace,
    { kind: 'reserve_household_upload', object_id: sameObject, reservation_id: id, expires_at: Date.now()+600000, change: { kind: 'create', title: 'Name', content: proposal('base').content } }, proposal('base'))));
  assert.deepEqual(pending.map(r => r.outcome.status).sort(), ['pending','refused']);
});

test('the five-hundred-name cap includes tombstones and serializes distinct creates', async () => {
  const workspace = await fixture();
  await sql`INSERT INTO swarm.files(file_id,workspace_id,name,created_by_kind,created_by,tombstoned_at)
    SELECT gen_random_uuid(),${workspace}::uuid,'held-'||n||'.txt','user',${owner}::uuid,clock_timestamp()
    FROM generate_series(1,499) AS n`;
  const results = await Promise.all([randomUUID(),randomUUID()].map(id => write(workspace,newDoc(id),proposal('base'))));
  assert.deepEqual(results.map(r=>r.outcome.status).sort(),['committed','refused']);
  assert.ok(results.some(r=>r.outcome.status==='refused' && r.outcome.reason==='object_quota_reached'));
  const [count] = await sql`SELECT count(*) AS n FROM swarm.files WHERE workspace_id=${workspace}::uuid AND purged_at IS NULL`;
  assert.equal(Number(count!.n),500);
});

test('durable shared write ceilings refuse new revisions while exact retry and reservation release remain available', async () => {
  const workspace=await fixture(),object=randomUUID(),reservation=randomUUID(),request=randomUUID();
  const command: HouseholdObjectCommand={kind:'reserve_household_upload',object_id:object,reservation_id:reservation,expires_at:Date.now()+600000,
    change:{kind:'create',title:'Rate recovery',content:proposal('base').content}};
  const pending=await write(workspace,command,proposal('base'),request);
  assert.equal(pending.outcome.status,'pending');
  await sql`UPDATE swarm.rate_buckets SET count=${policy.HOUSEHOLD_WORKSPACE_WRITE_HOURLY_LIMIT} WHERE bucket_key=${`file:create:ws:${workspace}`} AND window_start=date_trunc('hour',statement_timestamp())`;
  await sql`UPDATE swarm.rate_buckets SET count=${policy.HOUSEHOLD_IDENTITY_WRITE_HOURLY_LIMIT} WHERE bucket_key=${`file:create:user:${owner}`} AND window_start=date_trunc('hour',statement_timestamp())`;
  const denied=(await write(workspace,newDoc(randomUUID()),proposal('base'))).outcome;
  assert.ok(denied.status==='refused' && denied.reason==='object_write_rate_limited');
  assert.deepEqual((await write(workspace,command,proposal('base'),request)).outcome,pending.outcome);
  assert.equal((await write(workspace,{kind:'release_household_upload',reservation_id:reservation,operation:'create'},null)).outcome.status,'released');
  // Restore the synthetic identity's shared counter for subsequent cases.
  await sql`UPDATE swarm.rate_buckets SET count=0 WHERE bucket_key=${`file:create:user:${owner}`} AND window_start=date_trunc('hour',statement_timestamp())`;
});

test('rolling history keeps retired bytes readable and protected from the legacy purge job', async () => {
  const workspace = await fixture(), object = randomUUID();
  const first = committed(await write(workspace, newDoc(object), proposal('base')));
  let base = first;
  for (let i = 0; i < policy.HOUSEHOLD_LIVE_REVISION_LIMIT; i++) base = committed(await write(workspace, patch(object, base, 'base'), proposal('base')));
  await sql`SELECT swarm.purge_file_artifacts()`;
  const history = await read(workspace, human(other), { kind: 'object_history', object_id: object, offset: 0, limit: 100 });
  assert.ok(history.status === 'ok' && history.kind === 'object_history');
  if (history.status === 'ok' && history.kind === 'object_history') {
    assert.equal(history.revisions.length, 21);
    assert.equal(history.revisions.filter(r => r.live).length, 20);
    assert.equal(history.revisions[0]!.live, false);
  }
  const retained = await bytes(workspace, human(other), { kind: 'object_read', object_id: object, revision: first });
  assert.ok('bytes' in retained);
  if ('bytes' in retained) assert.deepEqual(transfers.decodeHouseholdContent(retained.bytes, 'doc'), proposal('base').content);
});

test('storage failure and credential withdrawal during I/O produce no committed rows or event', async () => {
  const workspace = await fixture();
  const failed = store({ storage: { ...storage, putImmutable: async () => { throw new transfers.HouseholdTransferError('storage_unavailable'); } } });
  await assert.rejects(write(workspace, newDoc(randomUUID()), proposal('base'), randomUUID(), human(), failed), transfers.HouseholdTransferError);
  const [before] = await sql`SELECT count(*) AS n FROM swarm.household_object_events WHERE workspace_id=${workspace}::uuid`;
  assert.equal(Number(before!.n), 0);
  const object = randomUUID();
  committed(await write(workspace, newDoc(object), proposal('base')));
  // A PUT that reached Storage followed by transaction rollback leaves an
  // orphan. A fresh version key must let the very next update commit.
  const afterPutFailure = store({ storage: { ...storage, putImmutable: async (path, value) => {
    await storage.putImmutable(path,value); throw new transfers.HouseholdTransferError('storage_unavailable');
  } } });
  const original = await read(workspace,human(),{kind:'object_read',object_id:object});
  assert.ok(original.status==='ok' && original.kind==='object_read');
  if (original.status!=='ok' || original.kind!=='object_read') throw new Error('expected base');
  await assert.rejects(write(workspace,patch(object,original.revision.revision,'failed'),proposal('failed'),randomUUID(),human(),afterPutFailure),transfers.HouseholdTransferError);
  committed(await write(workspace,patch(object,original.revision.revision,'recovered'),proposal('recovered')));
  let valid = true;
  const withdrawn = store({ recheckCredential: async () => valid, storage: { ...storage, read: async (path, limit) => { const result = await storage.read(path, limit); valid = false; return result; } } });
  const refused = await bytes(workspace, human(), { kind: 'object_read', object_id: object }, withdrawn);
  assert.deepEqual(refused, { status: 'refused', reason: 'workspace_access_refused' });
  assert.ok('bytes' in await bytes(workspace, human(), { kind: 'object_read', object_id: object }));
});

test('terminal artifact facts and private reducer events reject mutation at the database boundary', async () => {
  const workspace=await fixture(),object=randomUUID();
  const revision=committed(await write(workspace,newDoc(object),proposal('base')));
  await assert.rejects(sql`UPDATE swarm.household_object_artifacts SET sha256=${'0'.repeat(64)} WHERE workspace_id=${workspace}::uuid AND revision_token=${revision.token}`,
    (error: unknown)=>error instanceof postgres.PostgresError && error.code==='55000');
  await assert.rejects(sql`DELETE FROM swarm.household_object_events WHERE workspace_id=${workspace}::uuid`,
    (error: unknown)=>error instanceof postgres.PostgresError && error.code==='55000');
  assert.ok('bytes' in await bytes(workspace,human(other),{kind:'object_read',object_id:object}));
});

const ids = ['20261004000001','20261004000002','20261004000003','20261004000004'] as const;
const proofDir = fileURLToPath(new URL('../../deploy/release-proofs/household-storage/', import.meta.url));
function proof(id: string, suffix: string) { return readFileSync(`${proofDir}/${id}-${suffix}.sql`, 'utf8'); }
function requireProof(variable: 'catalog_ok' | 'rollback_ok', expected: boolean) {
  return `SELECT :'${variable}' = '${expected ? 't' : 'f'}' AS proof_passed\n\\gset\n\\if :proof_passed\n\\else\nDO $$ BEGIN RAISE EXCEPTION 'household catalog proof failed'; END $$;\n\\endif\n`;
}
test('catalogs detect privilege drift and reverse rollbacks restore the pre-lane catalog inside one rolled-back transaction', () => {
  const containers = execFileSync('docker', ['ps','--format','{{.Names}}'], { encoding: 'utf8' }).trim().split('\n').filter(name => /^supabase_db_/.test(name));
  assert.equal(containers.length, 1, 'one local database required');
  let script = 'BEGIN;\n';
  for (const id of ids) script += proof(id,'catalog') + requireProof('catalog_ok',true);
  script += 'GRANT UPDATE ON swarm.household_object_events TO swarm_command;\n' + proof(ids[1],'catalog') + requireProof('catalog_ok',false);
  script += 'REVOKE UPDATE ON swarm.household_object_events FROM swarm_command;\n' + proof(ids[1],'catalog') + requireProof('catalog_ok',true);
  // Command reads use the projection; widening either append-only ledger to SELECT must fail the proof.
  for (const ledger of ['household_object_events','household_object_audit']) {
    script += `GRANT SELECT ON swarm.${ledger} TO swarm_command;\n` + proof(ids[1],'catalog') + requireProof('catalog_ok',false);
    script += `REVOKE SELECT ON swarm.${ledger} FROM swarm_command;\n` + proof(ids[1],'catalog') + requireProof('catalog_ok',true);
  }
  for (const id of [...ids].reverse()) script += proof(id,'rollback') + proof(id,'rollback-catalog') + requireProof('rollback_ok',true) + proof(id,'catalog') + requireProof('catalog_ok',false);
  script += 'ROLLBACK;\n';
  execFileSync('docker', ['exec','-i',containers[0]!, 'psql','-X','-q','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1'], { input: script, stdio: ['pipe','pipe','pipe'] });
});
