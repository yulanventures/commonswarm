/** H2 adapter/Storage/PostgreSQL cases; test:p1-server's existing glob owns
 * these. Most bypass HTTP dispatch; the legacy FILE regression owns its HTTP redirect.
 * No fixtures carry customer data, production targets, or fixed host paths.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localClusterAdminUrl, runSql } from '../support/admin-schema-db.js';
import { adminEdgeDatabase } from '../support/admin-edge-database.js';
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
let local: { API_URL: string; ANON_KEY: string; DB_URL: string; SERVICE_ROLE_KEY: string };

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
const newDoc = (objectId: string, title = 'Synthetic doc'): Extract<HouseholdObjectCommand, { kind: 'create_household_object' }> => ({ kind: 'create_household_object', object_id: objectId, title, content: proposal('base').content });
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
    VALUES (${connection}::uuid,${grant}::uuid,${workspace}::uuid,${owner}::uuid,${principal}::uuid,'H2 synthetic seat',clock_timestamp())`;
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
  // Undo 05000001 before 015. The live function body is the removal migration,
  // so the 015 catalog is false until that body is restored.
  const removalProof = (suffix: string) => readFileSync(new URL(`../../deploy/release-proofs/household-member-removal/20261005000001-${suffix}.sql`, import.meta.url), 'utf8');
  // Undo 015 before 06 and 05 to restore the exact pre-lane catalogs.
  const approvalProof = (suffix: string) => readFileSync(new URL(`../../deploy/release-proofs/household-approval/20261004000015-${suffix}.sql`, import.meta.url), 'utf8');
  // Remove the dependent 06 delivery function before undoing the 05 overlay.
  const inviteProof = (suffix: string) => readFileSync(new URL(`../../deploy/release-proofs/household-invites/20261004000006-${suffix}.sql`, import.meta.url), 'utf8');
  // Migration 05 intentionally widens the lane-2 confirmation tables. Undo its
  // overlay first to test the original exact catalogs; this entire drill rolls back.
  // Project away the later permanent-connection overlay only inside this rolled-back historical drill.
  const agentRollback = (version: string) => readFileSync(new URL(`../../deploy/release-proofs/agents/${version}-rollback.sql`, import.meta.url), 'utf8');
  let script = agentRollback('20261028000003') + '\n' + agentRollback('20261028000002') + '\n' + agentRollback('20261028000001') + '\nALTER TABLE swarm.household_content_connections DROP COLUMN IF EXISTS renewal_grant_id;\n' + removalProof('catalog') + requireProof('catalog_ok',true)
    + removalProof('rollback') + removalProof('rollback-catalog') + requireProof('rollback_ok',true)
    + approvalProof('catalog') + requireProof('catalog_ok',true)
    + approvalProof('rollback') + approvalProof('rollback-catalog') + requireProof('rollback_ok',true)
    + inviteProof('catalog') + requireProof('catalog_ok',true)
    + inviteProof('rollback') + inviteProof('rollback-catalog') + requireProof('rollback_ok',true)
    + proof('20261004000005','catalog') + requireProof('catalog_ok',true)
    + proof('20261004000005','rollback') + proof('20261004000005','rollback-catalog') + requireProof('rollback_ok',true);
  for (const id of ids) script += proof(id,'catalog') + requireProof('catalog_ok',true);
  // Permission tables are read/locked only in lane 2. Each widening and loss of
  // the required key-column lock grant must independently fail the release proof.
  for (const [table,key,nonkey] of [
    ['household_workspace_boundaries','workspace_id','purpose'],
    ['household_member_content_roles','workspace_id','content_role'],
    ['household_content_connections','connection_id','purpose'],
  ]) {
    for (const mutation of [
      `GRANT INSERT ON swarm.${table} TO swarm_command;`,
      `GRANT INSERT (${key}) ON swarm.${table} TO swarm_command;`,
      `GRANT UPDATE ON swarm.${table} TO swarm_command;`,
      `GRANT UPDATE (${nonkey}) ON swarm.${table} TO swarm_command;`,
      `GRANT UPDATE (${key}) ON swarm.${table} TO swarm_command WITH GRANT OPTION;`,
      `REVOKE UPDATE (${key}) ON swarm.${table} FROM swarm_command;`,
    ]) {
      script += 'SAVEPOINT permission_mutation;\n' + mutation + '\n' + proof(ids[0],'catalog') + requireProof('catalog_ok',false);
      script += 'ROLLBACK TO SAVEPOINT permission_mutation;\n' + proof(ids[0],'catalog') + requireProof('catalog_ok',true);
    }
  }
  script += 'GRANT UPDATE ON swarm.household_object_events TO swarm_command;\n' + proof(ids[1],'catalog') + requireProof('catalog_ok',false);
  script += 'REVOKE UPDATE ON swarm.household_object_events FROM swarm_command;\n' + proof(ids[1],'catalog') + requireProof('catalog_ok',true);
  // Command reads use the projection; widening either append-only ledger to SELECT must fail the proof.
  for (const ledger of ['household_object_events','household_object_audit']) {
    script += `GRANT SELECT ON swarm.${ledger} TO swarm_command;\n` + proof(ids[1],'catalog') + requireProof('catalog_ok',false);
    script += `REVOKE SELECT ON swarm.${ledger} FROM swarm_command;\n` + proof(ids[1],'catalog') + requireProof('catalog_ok',true);
  }
  for (const id of [...ids].reverse()) script += proof(id,'rollback') + proof(id,'rollback-catalog') + requireProof('rollback_ok',true) + proof(id,'catalog') + requireProof('catalog_ok',false);
  runSql(script);
});

// The FILE caller's adapter catch and local-token handover are not reached by
// the existing todo HTTP/MCP coverage. No auth, transaction or storage shim.
async function legacyFileHttp(policyCases = false) {
  const workspace = await fixture(), object = randomUUID(), principal = randomUUID(), device = randomUUID();
  const run = randomUUID(), tokenId = randomUUID(), predecessor = randomUUID(), lineage = randomUUID(), renewalGrant = randomUUID();
  const token = `swm_agt_${randomBytes(32).toString('base64url')}`;
  await sql`INSERT INTO swarm.streams(stream_id,workspace_id,kind) VALUES (${randomUUID()}::uuid,${workspace}::uuid,'workspace')`;
  committed(await write(workspace, { ...newDoc(object), content: proposal('Legacy HTTP control').content }, proposal('Legacy HTTP control')));
  const [binding] = await sql`SELECT file_id FROM swarm.household_object_bindings WHERE workspace_id=${workspace}::uuid AND object_id=${object}`;
  assert.ok(binding);
  await sql.begin(async tx => {
    await tx`INSERT INTO swarm.devices(device_id,user_id,label) VALUES (${device}::uuid,${owner}::uuid,'Legacy HTTP test')`;
    await tx`INSERT INTO swarm.agent_principals(principal_id,workspace_id,owner_user_id,name)
      VALUES (${principal}::uuid,${workspace}::uuid,${owner}::uuid,'Legacy HTTP agent')`;
    await tx`INSERT INTO swarm.agent_runs(run_id,principal_id,device_id) VALUES (${run}::uuid,${principal}::uuid,${device}::uuid)`;
    // Both bearers belong to the same live, device-bound canonical renewal grant.
    await tx`INSERT INTO swarm.renewal_grants(renewal_grant_id,workspace_id,principal_id,run_id,kind,max_successors,successors_used,horizon_expires_at,bound_device_id,created_by)
      VALUES (${renewalGrant}::uuid,${workspace}::uuid,${principal}::uuid,${run}::uuid,'standing',NULL,0,NULL,${device}::uuid,${owner}::uuid)`;
    await tx`INSERT INTO swarm.agent_tokens(token_id,principal_id,run_id,scopes,token_hash,expires_at,lineage_id,first_used_at,renewal_grant_id)
      VALUES (${predecessor}::uuid,${principal}::uuid,${run}::uuid,'["post_signal"]',${randomBytes(32)},clock_timestamp()+interval '1 hour',${lineage}::uuid,NULL,${renewalGrant}::uuid)`;
    // A predecessor starts pending, then takes the supported write-once first-use transition.
    await tx`UPDATE swarm.agent_tokens SET first_used_at=statement_timestamp()
      WHERE token_id=${predecessor}::uuid AND first_used_at IS NULL`;
    await tx`INSERT INTO swarm.agent_tokens(token_id,principal_id,run_id,scopes,token_hash,expires_at,lineage_id,predecessor_token_id,renewal_grant_id)
      VALUES (${tokenId}::uuid,${principal}::uuid,${run}::uuid,'["post_signal"]',${createHash('sha256').update(token).digest()},
        clock_timestamp()+interval '1 hour',${lineage}::uuid,${predecessor}::uuid,${renewalGrant}::uuid)`;
    await tx`INSERT INTO swarm.household_content_connections(connection_id,grant_id,workspace_id,principal_id,owner_user_id,purpose,operations,consent_receipt_id,expires_at)
      SELECT ${tokenId}::uuid,${run}::uuid,${workspace}::uuid,${principal}::uuid,${owner}::uuid,'shared',ARRAY['read'],content_consent_id,
        clock_timestamp()+interval '1 hour' FROM swarm.household_member_content_roles WHERE workspace_id=${workspace}::uuid AND user_id=${owner}::uuid`;
  });
  const scenarios: Record<string,{tokenId:string;token:string;family:string;approvalFamily:string}> = {
    unlinked:{tokenId,token,family:renewalGrant,approvalFamily:renewalGrant},
  };
  if (policyCases) {
    // Every case owns a live run/token/family. Never rebind a linked approval,
    // restore a terminal family, or let a previous denial mask the next policy.
    for (const policy of ['null','future','elapsed','terminal','revoked','mismatch']) {
      const caseRun=randomUUID(),family=randomUUID(),caseToken=randomUUID();
      const secret=`swm_agt_${randomBytes(32).toString('base64url')}`;
      await sql.begin(async tx=>{
        await tx`INSERT INTO swarm.agent_runs(run_id,principal_id,device_id)
          VALUES (${caseRun}::uuid,${principal}::uuid,${device}::uuid)`;
        // A finite technical renewal window remains an independent NULL-policy positive.
        await tx`INSERT INTO swarm.renewal_grants(renewal_grant_id,workspace_id,principal_id,run_id,created_by,horizon_expires_at,max_successors)
          VALUES (${family}::uuid,${workspace}::uuid,${principal}::uuid,${caseRun}::uuid,${owner}::uuid,clock_timestamp()+interval '30 days',800)`;
        await tx`INSERT INTO swarm.agent_tokens(token_id,principal_id,run_id,scopes,token_hash,expires_at,lineage_id,renewal_grant_id)
          VALUES (${caseToken}::uuid,${principal}::uuid,${caseRun}::uuid,'["post_signal"]',${createHash('sha256').update(secret).digest()},
            clock_timestamp()+interval '1 hour',${randomUUID()}::uuid,${family}::uuid)`;
        await tx`INSERT INTO swarm.household_content_connections(connection_id,grant_id,workspace_id,principal_id,owner_user_id,
          purpose,operations,consent_receipt_id,expires_at,renewal_grant_id)
          SELECT ${caseToken}::uuid,${caseRun}::uuid,${workspace}::uuid,${principal}::uuid,${owner}::uuid,
            'shared',ARRAY['read'],content_consent_id,NULL,${policy==='mismatch'?null:family}::uuid
          FROM swarm.household_member_content_roles WHERE workspace_id=${workspace}::uuid AND user_id=${owner}::uuid`;
      });
      // The mismatch links once from NULL to a real foreign-run family during
      // historical setup below. All ordinary positives bind the exact real family.
      scenarios[policy]={tokenId:caseToken,token:secret,family,approvalFamily:policy==='mismatch'?renewalGrant:family};
    }
  }
  const release = postgres(localClusterAdminUrl(local.DB_URL), { prepare: false, max: 1 });
  const edgeUrl = new URL(local.DB_URL);
  edgeUrl.username = 'commonswarm_edge'; edgeUrl.password = randomBytes(32).toString('hex');
  const directory = mkdtempSync(join(tmpdir(), 'cswarm-legacy-file-http-'));
  const harnessPath = join(directory, 'harness.ts');
  const commandUrl = new URL('../../supabase/functions/command/index.ts', import.meta.url);
  const harness = `
const input = JSON.parse(await new Response(Deno.stdin.readable).text());
const { db, handleRequest } = await import(${JSON.stringify(commandUrl.href)});
const { default: postgres } = await import("postgres");
const fixture = postgres(input.adminUrl, { prepare: false, max: 1 });
const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, handleRequest);
let bearer=input.token;
const request = () => fetch("http://127.0.0.1:" + server.addr.port + "/functions/v1/command", {
  method: "POST", headers: { authorization: "Bearer " + bearer, "content-type": "application/json" },
  body: JSON.stringify(input.policyCases ? {...input.body,command_id:crypto.randomUUID()} : input.body),
}).then(async response => ({ status: response.status, body: await response.json(),
  retryAfter: response.headers.get("retry-after"), challenge: response.headers.get("www-authenticate") }));
async function snapshot() {
  const result = [];
  for (const table of ["workspaces","memberships","household_workspace_boundaries","household_member_content_roles",
    "agent_principals","household_content_connections","household_hosted_content_restrictions",
    "household_object_streams","household_object_events","household_object_artifacts","household_object_audit",
    "household_object_bindings","household_todo_streams","household_todo_events","household_todos",
    "idempotency_keys","streams","events","files","file_versions","signals","signal_deliveries","agent_presence","audit_log"]) {
    result.push([table, ...await fixture.unsafe("SELECT count(*)::int AS n, md5(coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text)::text,'[]')) AS digest FROM swarm." + table + " r WHERE workspace_id=$1::uuid", [input.workspace])]);
  }
  for (const table of ["agent_tokens","agent_runs"]) {
    result.push([table, ...await fixture.unsafe("SELECT count(*)::int AS n, md5(coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text)::text,'[]')) AS digest FROM swarm." + table + " r WHERE principal_id=$1::uuid", [input.principal])]);
  }
  return result;
}
try {
  const [identity] = await db.unsafe("SELECT session_user AS login, NOT rolsuper AND NOT rolbypassrls AS safe FROM pg_roles WHERE rolname=current_user");
  const role = await db.begin(async tx => { await tx.unsafe("SET LOCAL ROLE swarm_command"); return (await tx.unsafe("SELECT current_user AS role"))[0].role; });
  let oauthDenied = false;
  try { await db.begin(async tx => { await tx.unsafe("SET LOCAL ROLE commonswarm_oauth_runtime"); }); }
  catch (error) { if (error.code !== "42501") throw error; oauthDenied = true; }
  if (input.policyCases) {
    const cases = [];
    for (const policy of ['unlinked','null','future','elapsed','terminal','revoked','mismatch']) {
      const scenario=input.scenarios[policy];bearer=scenario.token;
      const positive=await request();
      if (policy==='mismatch') {
        // Revised R02 storage mismatch ruling, COMMONSWARM-RELEASE-CONFLICT-
        // RULINGS-20261027.md: this unreachable mismatch tests the Storage
        // loader behind the binding guard, only in the disposable owned clone.
        // First prove the installed guard refuses that exact write, then restore
        // its exact definition, function and enabled state before HTTP/Storage.
        await fixture.begin(async tx=>{
          const [database]=await tx.unsafe("SELECT current_database() AS name");
          if(!/^admin_edge_[a-f0-9]{32}$/.test(database.name)) throw new Error('historical setup requires owned clone');
          const [guard]=await tx.unsafe("SELECT pg_get_triggerdef(oid) AS ddl,tgfoid,tgenabled FROM pg_trigger WHERE tgrelid='swarm.household_content_connections'::regclass AND tgname='aa_household_local_family_binding' AND NOT tgisinternal");
          if(guard?.tgenabled!=='O') throw new Error('current family guard missing');
          const assignMismatch=sp=>sp.unsafe("UPDATE swarm.household_content_connections SET renewal_grant_id=$2::uuid,expires_at=NULL WHERE connection_id=$1::uuid AND renewal_grant_id IS NULL RETURNING connection_id",[scenario.tokenId,scenario.approvalFamily]);
          let bindingRefused=false;
          try {await tx.savepoint(async sp=>{await assignMismatch(sp);});}
          catch(error) {if(error.code!=='23514' || error.message!=='LOCAL_APPROVAL_BINDING_REFUSED') throw error;bindingRefused=true;}
          if(!bindingRefused) throw new Error('installed family guard admitted foreign-run binding');
          await tx.unsafe('DROP TRIGGER aa_household_local_family_binding ON swarm.household_content_connections');
          const updated=await assignMismatch(tx);
          if(updated.length!==1) throw new Error('historical NULL linkage required');
          await tx.unsafe(guard.ddl);
          const [restored]=await tx.unsafe("SELECT pg_get_triggerdef(oid) AS ddl,tgfoid,tgenabled FROM pg_trigger WHERE tgrelid='swarm.household_content_connections'::regclass AND tgname='aa_household_local_family_binding' AND NOT tgisinternal");
          if(restored?.ddl!==guard.ddl || restored.tgfoid!==guard.tgfoid || restored.tgenabled!==guard.tgenabled) throw new Error('family guard not restored');
          let refused=false;
          try {await tx.savepoint(async sp=>{await sp.unsafe("UPDATE swarm.household_content_connections SET renewal_grant_id=$2::uuid WHERE connection_id=$1::uuid",[scenario.tokenId,scenario.family]);});}
          catch(error) {if(error.code!=='23514' || error.message!=='LOCAL_APPROVAL_FAMILY_IMMUTABLE') throw error;refused=true;}
          if(!refused) throw new Error('restored immutable-family guard admitted rebind');
          const [mismatch]=await tx.unsafe("SELECT c.grant_id<>g.run_id AND t.renewal_grant_id<>c.renewal_grant_id AND t.run_id=c.grant_id AS mismatched FROM swarm.household_content_connections c JOIN swarm.agent_tokens t ON t.token_id=c.connection_id JOIN swarm.renewal_grants g ON g.renewal_grant_id=c.renewal_grant_id WHERE c.connection_id=$1::uuid",[scenario.tokenId]);
          if(!mismatch.mismatched) throw new Error('historical foreign-run family mismatch missing');
        });
      } else if(policy!=='unlinked') {
        // The approval already bound the matching eligible family. Only now
        // choose the date, terminal stamp or attributed revocation under test.
        await fixture.unsafe("UPDATE swarm.renewal_grants SET connection_expires_at=CASE WHEN $2='future' THEN clock_timestamp()+interval '1 hour' WHEN $2='elapsed' THEN clock_timestamp()-interval '1 second' ELSE NULL END, connection_expired_at=CASE WHEN $2='terminal' THEN clock_timestamp() ELSE NULL END, revoked_at=CASE WHEN $2='revoked' THEN clock_timestamp() ELSE NULL END, revoked_by=CASE WHEN $2='revoked' THEN $3::uuid ELSE NULL END WHERE renewal_grant_id=$1::uuid", [scenario.family,policy,input.owner]);
      }
      cases.push({ policy, positive, result: await request() });
    }
    console.log("LEGACY_HTTP_RESULT:" + JSON.stringify({ identity, role, oauthDenied, cases }));
  } else {
  const before = await snapshot();
  const gated = [await request(), await request()];
  const after = await snapshot();
  await fixture.unsafe("DROP POLICY hosted_owner_content_rollback_gate ON swarm.household_content_connections");
  const recovered = await request();
  console.log("LEGACY_HTTP_RESULT:" + JSON.stringify({ identity, role, oauthDenied, before, after, gated, recovered }));
  }
} finally {
  await server.shutdown();
  await db.end();
  await fixture.end();
}
`;
  try {
    await release.unsafe(`DO $edge$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='commonswarm_edge') THEN
      CREATE ROLE commonswarm_edge LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
      END IF; END $edge$; GRANT swarm_command,swarm_read,swarm_capability TO commonswarm_edge;`);
    await release.unsafe(`ALTER ROLE commonswarm_edge PASSWORD '${edgeUrl.password}'`);
    if (!policyCases) await release.unsafe(readFileSync(new URL('../../deploy/release-proofs/hosted-owner-content/20261019000006-rollback.sql', import.meta.url), 'utf8'));
    const [pending] = await sql`SELECT first_used_at FROM swarm.agent_tokens WHERE token_id=${tokenId}::uuid`;
    assert.equal(pending!.first_used_at, null);
    const [absent] = await sql`SELECT count(*)::int AS n FROM swarm.agent_presence WHERE workspace_id=${workspace}::uuid`;
    assert.equal(absent!.n, 0);
    writeFileSync(harnessPath, harness, { mode: 0o600 });
    const child = spawnSync('deno', ['run','--no-lock','--config','supabase/functions/command/deno.json',
      '--allow-env','--allow-net','--allow-read',harnessPath], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 90_000,
      env: { PATH: process.env.PATH ?? '', ...(process.env.DENO_DIR ? { DENO_DIR: process.env.DENO_DIR } : {}),
        SWARM_ENV: 'test', SWARM_HOUSEHOLD_LEGACY_FILE_REDIRECT: '1',
        SWARM_DATABASE_URL: edgeUrl.href, SUPABASE_DB_URL: edgeUrl.href, SUPABASE_URL: local.API_URL,
        SUPABASE_ANON_KEY: local.ANON_KEY,
        SUPABASE_SERVICE_ROLE_KEY: local.SERVICE_ROLE_KEY },
      input: JSON.stringify({ adminUrl: localClusterAdminUrl(local.DB_URL), workspace, principal, owner, token, policyCases, scenarios, tokenId,
        body: { command_id: randomUUID(), client_version: '0.1.0', client_build: '0.1.0', workspace_id: workspace,
          stream: { kind: 'workspace' }, command: { kind: 'file_download_url', file_id: String(binding!.file_id), version_n: null } } }),
    });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr);
    const line = child.stdout.split('\n').find(value => value.startsWith('LEGACY_HTTP_RESULT:'));
    assert.ok(line, 'real HTTP harness returned its evidence');
    const result = JSON.parse(line.slice('LEGACY_HTTP_RESULT:'.length));
    assert.deepEqual(result.identity, { login: 'commonswarm_edge', safe: true });
    assert.equal(result.role, 'swarm_command');
    assert.equal(result.oauthDenied, true);
    if (policyCases) {
      assert.equal(result.cases.length,7);
      for (const {policy: name,positive,result: response} of result.cases) {
        assert.equal(positive.status,200,name+' starts live');
        assert.equal(positive.body.status,'ok',name+' starts authorized');
        assert.deepEqual(positive.body.content,proposal('Legacy HTTP control').content,name+' live control returns genuine Storage content');
        if (['unlinked','null','future'].includes(name)) {
          assert.equal(response.status,200,name);
          assert.equal(response.body.status,'ok',name);
          assert.deepEqual(response.body.content,proposal('Legacy HTTP control').content,name);
        } else {
          assert.ok(response.status!==200 || response.body.status==='refused',name);
          assert.equal(response.body.content,undefined,name+' releases no Storage bytes');
        }
      }
      return;
    }
    const retry = { error: 'household_content_service_updating',
      message: 'Household content service is updating. Retry after one second with the same request_id.',
      retryable: true, retry_after_seconds: 1 };
    assert.equal(result.gated.length, 2);
    for (const refusal of result.gated) assert.deepEqual(refusal, { status: 503, body: retry, retryAfter: '1', challenge: null });
    assert.deepEqual(result.after, result.before, '503 rolls back content, authority, receipts, audit, presence and first-use handover');
    assert.equal(result.recovered.status, 200);
    assert.equal(result.recovered.retryAfter, null);
    assert.equal(result.recovered.challenge, null);
    assert.equal(result.recovered.body.status, 'ok');
    assert.equal(result.recovered.body.kind, 'read');
    assert.deepEqual(result.recovered.body.content, proposal('Legacy HTTP control').content);
    const [adopted] = await sql`SELECT first_used_at IS NOT NULL AS used FROM swarm.agent_tokens WHERE token_id=${tokenId}::uuid`;
    const [ended] = await sql`SELECT expires_at<=clock_timestamp() AS ended FROM swarm.agent_tokens WHERE token_id=${predecessor}::uuid`;
    const [present] = await sql`SELECT count(*)::int AS n FROM swarm.agent_presence WHERE workspace_id=${workspace}::uuid AND principal_id=${principal}::uuid`;
    assert.equal(adopted!.used, true, 'successful retry alone adopts successor');
    assert.equal(ended!.ended, true, 'successful retry alone ends predecessor');
    assert.equal(present!.n, 1, 'successful retry alone records presence');
  } finally {
    await release.unsafe('DROP POLICY IF EXISTS hosted_owner_content_rollback_gate ON swarm.household_content_connections');
    await release.unsafe('ALTER ROLE commonswarm_edge PASSWORD NULL');
    await release.end();
    rmSync(directory, { recursive: true, force: true });
  }
}

test('legacy FILE HTTP redirect rolls back gated requests and resumes in the same process after DROP', { timeout: 180_000 }, () => legacyFileHttp());
// Real token auth remains live: only linked family policy changes, with legacy
// and finite technical-window NULL-policy positives in the same invocation.
test('local FILE HTTP applies linked renewal policy before returning genuine Storage content', { timeout: 180_000 }, async () => {
  const shared={sql,local};
  const isolated=await adminEdgeDatabase(local.DB_URL);
  try {
    const [configuration]=await shared.sql`SELECT value FROM swarm.config WHERE key='min_client_version'`;
    assert.ok(configuration,'shared fixture has the minimum client version');
    sql=isolated.db;local={...local,DB_URL:isolated.url};
    await sql`INSERT INTO swarm.config(key,value) VALUES('min_client_version',${sql.json(configuration.value)})`;
    for(const user of [owner,other]) {
      await sql`INSERT INTO auth.users(id,aud,role) VALUES(${user}::uuid,'authenticated','authenticated')`;
      await sql`INSERT INTO swarm.users(user_id,display_name) VALUES(${user}::uuid,'Storage policy fixture')`;
    }
    await legacyFileHttp(true);
  } finally {sql=shared.sql;local=shared.local;await isolated.close();}
});
