import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decideHumanInvite, legacyHouseholdAcceptRefusal, legacyRemovalRejoinRefusal, parseHumanInviteCommand, HOUSEHOLD_JOIN_CONSENT_VERSION, type HumanInviteFacts, type HumanInviteCommand } from '../src/protocol/household-invitations.js';
import { humanInvitationTransaction } from '../supabase/functions/command/household-invitations.ts';
import { reduceAdminRoutine, emptyAdminRoutine } from '../src/protocol/admin-routine.js';
import { build } from 'esbuild';
import { createHash, randomUUID } from 'node:crypto';
import './household-member-removal.test.ts';
const LEGACY_INVITE_TOKEN = 'swm_inv_' + 'A'.repeat(43);
const LEGACY_INVITE_HASH = createHash('sha256').update(LEGACY_INVITE_TOKEN).digest('hex');
const command: HumanInviteCommand={kind:'household_invitation',action:'accept',invitation:{source:'delegated',invitation_id:'11111111-1111-4111-8111-111111111111'},consent_version:HOUSEHOLD_JOIN_CONSENT_VERSION,preview_digest:'a'.repeat(64),content_role:'reader'};
const facts:HumanInviteFacts={human:true,identity_verified:true,recipient_matches:true,invitation_kind:'member',role:'member',personal_boundary:false,inviter_can_invite:true,parent_live:true,now:100,expires_at:200,revoked_at:null,accepted_at:null,accepted_by:null,user_id:'recipient',member_live:false,preview_digest:'a'.repeat(64),membership_revoked_at:null,invitation_created_at:50};
test('only the intended signed-in human can choose shared membership after current disclosure',()=>{
  assert.deepEqual(decideHumanInvite(command,facts),{status:'join'});
  for(const changed of [{human:false},{identity_verified:false},{recipient_matches:false},{invitation_kind:'agent' as const},{role:'owner'},
    {parent_live:false},{inviter_can_invite:false},{personal_boundary:true},{expires_at:100},{revoked_at:99}]){
    assert.equal(decideHumanInvite(command,{...facts,...changed}).status,'refused',JSON.stringify(changed));
  }
  assert.deepEqual(decideHumanInvite(command,{...facts,preview_digest:'b'.repeat(64)}),{status:'refused',reason:'review_changed'});
  assert.equal(parseHumanInviteCommand({...command,intended_owner_user_id:'other'}),null);
  assert.equal(parseHumanInviteCommand({...command,consent_version:'agent-says-yes'}),null);
  assert.equal(parseHumanInviteCommand({...command,invitation:{source:'delegated',invitation_id:command.invitation.source==='delegated'?command.invitation.invitation_id:'',token:'fake'}}),null);
});
test('consumed invitation retries do not revive removed members or borrow a different recipient identity',()=>{
  const joined={...facts,accepted_at:101,accepted_by:'recipient',member_live:true,parent_live:false,expires_at:50};
  assert.deepEqual(decideHumanInvite(command,joined),{status:'already_joined'});
  assert.equal(decideHumanInvite(command,{...joined,member_live:false}).status,'refused');
  assert.equal(decideHumanInvite(command,{...joined,user_id:'another',recipient_matches:false}).status,'refused');
});
test('legacy acceptance compares the verified email only when a household boundary exists',()=>{
  assert.equal(legacyHouseholdAcceptRefusal(false,'person@example.test','other@example.test'),null);
  assert.equal(legacyHouseholdAcceptRefusal(true,'person@example.test','person@example.test'),'recipient_consent_required');
  assert.equal(legacyHouseholdAcceptRefusal(true,'person@example.test','other@example.test'),'invitation_recipient_mismatch');
  assert.equal(legacyHouseholdAcceptRefusal(true,null,'person@example.test'),'invitation_recipient_mismatch');
  assert.equal(legacyHouseholdAcceptRefusal(true,'person@example.test',null),'invitation_recipient_mismatch');
  assert.equal(legacyRemovalRejoinRefusal(null,10),null);
  assert.equal(legacyRemovalRejoinRefusal(20,10),'invitation_predates_removal');
  assert.equal(legacyRemovalRejoinRefusal(20,20),'invitation_predates_removal');
  assert.equal(legacyRemovalRejoinRefusal(20,Number.NaN),'invitation_predates_removal');
  assert.equal(legacyRemovalRejoinRefusal(20,21),null);
});
test('an invitation issued before removal cannot rejoin, and a later invitation can join without restoring old content',()=>{
  assert.deepEqual(decideHumanInvite(command,{...facts,membership_revoked_at:80,invitation_created_at:80}),{status:'refused',reason:'invitation_predates_removal'});
  assert.deepEqual(decideHumanInvite(command,{...facts,membership_revoked_at:80,invitation_created_at:Number.NaN}),{status:'refused',reason:'invitation_predates_removal'});
  assert.deepEqual(decideHumanInvite(command,{...facts,membership_revoked_at:80,invitation_created_at:81,member_live:false}),{status:'join'});
  assert.equal(decideHumanInvite(command,{...facts,membership_revoked_at:null,invitation_created_at:1}).status,'join');
});
test('delegated account replay retains one consumed invitation and never refunds issuance',()=>{
  const created=reduceAdminRoutine(emptyAdminRoutine(),{type:'AdminMemberInvited',grant_id:'grant',occurred_at_server:100,payload:{invitation_id:'invite',workspace_id:'shared',recipient_user_id:'recipient',recipient_ref:'recipient',intended_owner_user_id:'recipient',recipient_connection_id:null,invitation_kind:'member',role:'member',transport:null,seat_limit:null,worker_scope_ceiling:[],worker_policy:null,expires_at:200,parent_admin_grant_id:'grant',delivery_state:'awaiting_authorization'}});
  const accepted={type:'AdminMemberInvitationAccepted' as const,grant_id:'grant',occurred_at_server:150,payload:{invitation_id:'invite',recipient_user_id:'recipient',accepted_at:150}};
  const next=reduceAdminRoutine(created,accepted);
  assert.equal(next.invitations.invite!.accepted_at,150);assert.equal(next.spend.grant!.invitations,1);
  assert.throws(()=>reduceAdminRoutine(next,accepted));
  assert.throws(()=>reduceAdminRoutine(created,{...accepted,payload:{...accepted.payload,recipient_user_id:'other'}}));
});

test('migration 06 carries the exact reserve inverse and release copies while preserving existing authority data',async()=>{
  const {readFile}=await import('node:fs/promises');
  const read=(path:string)=>readFile(new URL('../'+path,import.meta.url),'utf8');
  const migration=await read('supabase/migrations/20261004000006_household_human_invitations.sql');
  const inverse=await read('supabase/household-invite-reserve/20261004000006-rollback.sql');
  const marked=migration.split('-- Reserve rollback is copied verbatim to the reserve and release-proof directories.\n')[1];
  assert.ok(marked);assert.equal(marked.split('\n').filter(Boolean).map(line=>line.slice(3)).join('\n')+'\n',inverse);
  for(const suffix of ['rollback','catalog','rollback-catalog'])assert.equal(await read(`supabase/household-invite-reserve/20261004000006-${suffix}.sql`),await read(`deploy/release-proofs/household-invites/20261004000006-${suffix}.sql`));
  assert.doesNotMatch(inverse,/\b(?:DELETE|TRUNCATE|UPDATE)\b/);
});

/** Real HTTP handlers with inert GoTrue/Postgres transports. These tests own
 * admission behavior; the server suite owns actual JWT and database proofs. */
async function invitationEntry(surface: 'read' | 'command') {
  const bundled = await build({
    entryPoints: [`supabase/functions/${surface}/index.ts`], bundle: true, write: false,
    platform: 'node', format: 'esm', target: 'es2022', logLevel: 'silent',
    banner: { js: `
      const queries = [], userId = '11111111-1111-4111-8111-111111111111';
      let boundary = 'shared', archived = false, routeAvailable = true;
      let boundaryReads = 0, boundaryRace = false, liveLegacyInvite = false;
      let legacyInviteEmail = 'recipient@example.test', inviteCreatedOffsetMs = -60000;
      let membershipRevokedOffsetMs = null;
      const settings = { SWARM_ENV: 'test', SWARM_DATABASE_URL: 'postgres://127.0.0.1:1/unused',
        SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_ANON_KEY: 'inert-test-value' };
      const Deno = { env: { get: name => settings[name] }, serve: () => { throw new Error('unexpected server'); } };
      const priorDeno = Object.getOwnPropertyDescriptor(globalThis, 'Deno');
      Object.defineProperty(globalThis, 'Deno', { value: Deno, configurable: true });` },
    footer: { js: `
      if (priorDeno) Object.defineProperty(globalThis, 'Deno', priorDeno); else Reflect.deleteProperty(globalThis, 'Deno');
      export { queries }; export function setBoundary(value) { boundary = value; }
      export function setArchived(value) { archived = value; }
      export function setRouteAvailable(value) { routeAvailable = value; }
      export function setBoundaryRace(value) { boundaryRace = value; boundaryReads = 0; }
      export function setLiveLegacyInvite(value) { liveLegacyInvite = value; }
      export function setLegacyInviteEmail(value) { legacyInviteEmail = value; }
      export function setInviteCreatedOffsetMs(value) { inviteCreatedOffsetMs = value; }
      export function setMembershipRevokedOffsetMs(value) { membershipRevokedOffsetMs = value; }
      // ${randomUUID()}` },
    plugins: [{ name: 'inert-invitation-transports', setup(builder) {
      builder.onResolve({ filter: /^npm:/ }, args => ({ path: args.path, namespace: 'inert-edge' }));
      builder.onLoad({ filter: /.*/, namespace: 'inert-edge' }, args => {
        if (args.path === 'npm:@supabase/supabase-js@2.110.8') return { loader: 'js', contents: `
          export function createClient() { return { auth: {
            async getUser(token) { return { error: null, data: { user: {
              id: userId, email: 'recipient@example.test',
              ...(token === 'confirmed' ? { email_confirmed_at: '2026-10-01T00:00:00Z' } :
                token === 'null-confirmation' ? { email_confirmed_at: null } : {})
            } } }; },
            async getClaims() { return { error: null, data: { claims: {} } }; }
          } }; }` };
        if (args.path === 'npm:postgres@3.4.9') return { loader: 'js', contents: `
          export default function postgres() {
            const sql = async (strings, ...values) => {
              const query = strings.join('?'); queries.push({ query, values });
              if (query.includes('INSERT INTO swarm.users')) return [{ user_id: userId, email: 'recipient@example.test' }];
              if (query.includes('swarm_read.human_invitations()')) return [{ invitation_id: 'inbox-invite', workspace_name: 'Synthetic shared' }];
              if (query.includes('FROM swarm.config')) return [{ value: '0.1.0' }];
              if (query.includes('INSERT INTO swarm.rate_buckets')) return [{ count: 1, resets_at: new Date(Date.now() + 3600000) }];
              if (query.includes('created_by AS inviter')) return [{ invitation_id: userId, workspace_id: userId, inviter: userId }];
              if (query.includes('FROM swarm.invitations AS i') && query.includes('JOIN swarm.workspaces AS w'))
                return !archived && routeAvailable ? [{ workspace_id: userId, stream_id: userId,
                  role: membershipRevokedOffsetMs === null ? null : 'member',
                  revoked_at: membershipRevokedOffsetMs === null ? null : new Date(Date.now() + membershipRevokedOffsetMs) }] : [];
              if (query.includes('FROM swarm.workspaces')) return [{ name: 'Synthetic shared', archived_at: archived ? new Date() : null }];
              if (query.includes('FROM swarm.streams')) return [{ stream_id: userId, head_seq: 0 }];
              if (query.includes('consumed_at AS accepted_at')) return [{ role: 'member', email: 'recipient@example.test',
                expires_at: new Date(Date.now() + 3600000), revoked_at: null, accepted_at: null, accepted_by: null,
                created_at: new Date(Date.now() - 1000) }];
              if (query.includes('SELECT role,revoked_at FROM swarm.memberships')) return [{ role: 'owner', revoked_at: null }];
              if (liveLegacyInvite && query.includes('invited_by, joined_at, revoked_at')) return [{
                user_id: '22222222-2222-4222-8222-222222222222', role: 'owner', invited_by: null,
                joined_at: new Date(Date.now() - 1000), revoked_at: null }];
              if (query.includes('SELECT i.email, i.created_at')) return [{
                email: legacyInviteEmail, created_at: new Date(Date.now() + inviteCreatedOffsetMs) }];
              if (query.includes('SELECT m.revoked_at') && query.includes('FROM swarm.memberships AS m')) {
                return membershipRevokedOffsetMs === null ? [] : [{ revoked_at: new Date(Date.now() + membershipRevokedOffsetMs) }];
              }
              if (liveLegacyInvite && query.includes('invitation_id, email, role, token_hash')) return [{
                invitation_id: userId, email: 'recipient@example.test', role: 'member',
                token_hash: '${LEGACY_INVITE_HASH}', expires_at: new Date(Date.now() + 3600000),
                created_by: userId, created_at: new Date(Date.now() - 1000),
                consumed_at: null, consumed_by: null, revoked_at: null }];
              if (query.includes('swarm.household_workspace_boundaries')) {
                if (boundaryRace) { boundaryReads += 1; if (boundaryReads === 1) return []; }
                return boundary ? [{ purpose: boundary }] : [];
              }
              if (query.includes('floor(extract(epoch FROM clock_timestamp())')) return [{ now: Date.now() }];
              if (query.includes('floor(extract(epoch FROM statement_timestamp())')) return [{ now_ms: Date.now() }];
              if (query.includes('UPDATE swarm.invitations') && query.includes('consumed_by') && query.includes('RETURNING invitation_id'))
                return [{ invitation_id: userId }];
              if (query.includes('INSERT INTO swarm.idempotency_keys')) return [{ command_id: 'recorded' }];
              return [];
            };
            sql.begin = async (...args) => args.at(-1)(sql); sql.json = value => value;
            return sql;
          }` };
        throw new Error('unexpected edge dependency');
      });
    } }],
  });
  return await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0]!.text).toString('base64')}`) as {
    handleRequest(request: Request): Promise<Response>;
    queries: Array<{ query: string; values: unknown[] }>;
    setBoundary(value: string | null): void;
    setArchived(value: boolean): void;
    setRouteAvailable(value: boolean): void;
    setBoundaryRace(value: boolean): void;
    setLiveLegacyInvite(value: boolean): void;
    setLegacyInviteEmail(value: string | null): void;
    setInviteCreatedOffsetMs(value: number): void;
    setMembershipRevokedOffsetMs(value: number | null): void;
  };
}
async function invitationHttp(entry: Awaited<ReturnType<typeof invitationEntry>>, body: object, token = 'confirmed') {
  const response = await entry.handleRequest(new Request('https://example.test/functions/v1/invitation', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  }));
  return { status: response.status, body: await response.json() };
}
test('invitation inbox refuses unconfirmed humans before metadata access and admits a confirmed recipient', async () => {
  const entry = await invitationEntry('read');
  assert.deepEqual(await invitationHttp(entry, { resource: 'human_invitations' }),
    { status: 200, body: { invitations: [{ invitation_id: 'inbox-invite', workspace_name: 'Synthetic shared' }] } });
  assert.ok(entry.queries.some(row => row.query.includes('swarm_read.human_invitations()')));
  entry.queries.length = 0;
  for (const token of ['missing-confirmation', 'null-confirmation']) {
    assert.deepEqual(await invitationHttp(entry, { resource: 'human_invitations' }, token),
      { status: 403, body: { error: 'human_sign_in_required' } });
    assert.equal(entry.queries.length, 0, 'no recipient metadata transaction before identity verification');
  }
});
test('household legacy acceptance requires recipient review for shared, personal and unconfirmed boundaries', async () => {
  const entry = await invitationEntry('command');
  const token = 'swm_inv_' + 'A'.repeat(43);
  const control = await invitationHttp(entry, { command_id: 'review-invite', client_version: '0.1.80',
    command: { kind: 'household_invitation', action: 'preview', invitation: { source: 'link', token } } });
  assert.equal(control.status, 200); assert.equal(control.body.status, 'preview');
  assert.equal(control.body.workspace_name, 'Synthetic shared');
  for (const boundary of ['shared', 'personal', 'unconfirmed']) {
    entry.setBoundary(boundary); entry.queries.length = 0;
    assert.deepEqual(await invitationHttp(entry, { command_id: 'legacy-invite', client_version: '0.1.80',
      command: { kind: 'accept_invitation', token } }), { status: 403, body: {
        error: 'recipient_consent_required', message: 'Open the invitation in /invite and review it as yourself.',
      } }, `boundary present: ${boundary}`);
    assert.ok(entry.queries.some(row => row.query.includes('INSERT INTO swarm.audit_log') && row.values.includes('recipient_consent_required')));
    assert.ok(!entry.queries.some(row => /INSERT INTO swarm.memberships|UPDATE swarm.invitations/.test(row.query)));
  }
  entry.setBoundary(null); entry.queries.length = 0;
  assert.deepEqual(await invitationHttp(entry, { command_id: 'unconfirmed-review', client_version: '0.1.80',
    command: { kind: 'household_invitation', action: 'preview', invitation: { source: 'link', token } } }),
    { status: 403, body: { status: 'refused', reason: 'invitation_unavailable' } });
  assert.ok(!entry.queries.some(row => /INSERT INTO swarm.memberships|UPDATE swarm.invitations/.test(row.query)),
    'household review cannot enroll a recipient without a confirmed Shared boundary');
});

test('legacy invitation routing refuses archived and unknown workspaces before consent; generic connect flows reach normal validation', async () => {
  const entry = await invitationEntry('command');
  const token = 'swm_inv_' + 'A'.repeat(43);
  const body = { command_id: 'legacy-routing', client_version: '0.1.80', command: { kind: 'accept_invitation', token } };
  // Positive control: the real legacy handler reaches the household consent gate.
  assert.equal((await invitationHttp(entry, body)).body.error, 'recipient_consent_required');
  for (const boundary of ['shared', 'personal', 'unconfirmed', null]) {
    entry.setBoundary(boundary); entry.setArchived(true); entry.queries.length = 0;
    assert.deepEqual(await invitationHttp(entry, body), { status: 403, body: { error: 'forbidden' } });
    assert.ok(!entry.queries.some(row => row.query.includes('swarm.household_workspace_boundaries')),
      'archived routing refuses before any consent query');
    assert.ok(!entry.queries.some(row => /INSERT INTO swarm.memberships|UPDATE swarm.invitations/.test(row.query)));
  }
  entry.setArchived(false); entry.setRouteAvailable(false); entry.queries.length = 0;
  assert.deepEqual(await invitationHttp(entry, body), { status: 403, body: { error: 'forbidden' } });
  assert.ok(!entry.queries.some(row => row.values.includes('recipient_consent_required')));
  entry.setRouteAvailable(true); entry.setBoundary(null); entry.queries.length = 0;
  // A live generic invitation must get as far as ordinary version validation.
  // Actual acceptance/concurrent consumption belongs to unchanged command.test.ts.
  assert.deepEqual(await invitationHttp(entry, { ...body, client_version: 'invalid' }),
    { status: 400, body: { error: 'invalid_request' } });
  assert.ok(entry.queries.some(row => row.query.includes('INSERT INTO swarm.audit_log') && row.values.includes('invalid client_version')));
  assert.ok(!entry.queries.some(row => row.values.includes('recipient_consent_required')));
});

test('a household boundary refuses a different verified email and keeps a matching email on the review path', async () => {
  const entry = await invitationEntry('command');
  const body = { command_id: 'legacy-email', client_version: '0.1.80', command: { kind: 'accept_invitation', token: LEGACY_INVITE_TOKEN } };
  entry.setLegacyInviteEmail('other@example.test');
  assert.deepEqual(await invitationHttp(entry, body), { status: 403, body: {
    error: 'invitation_recipient_mismatch',
    message: 'This invitation is for a different verified email. Nothing was changed.',
  } });
  assert.ok(!entry.queries.some(row => /INSERT INTO swarm.memberships|UPDATE swarm.invitations/.test(row.query)));
  entry.setLegacyInviteEmail('recipient@example.test');
  entry.queries.length = 0;
  assert.equal((await invitationHttp(entry, body)).body.error, 'recipient_consent_required');
});

test('the locked household boundary check refuses before consumption, and an ordinary invitation is consumed', async () => {
  const entry = await invitationEntry('command');
  const body = { command_id: 'legacy-race', client_version: '0.1.80', command: { kind: 'accept_invitation', token: LEGACY_INVITE_TOKEN } };
  entry.setBoundary('shared');
  entry.setBoundaryRace(true);
  entry.setLiveLegacyInvite(true);
  const raced = await invitationHttp(entry, body);
  assert.equal(raced.body.error, 'recipient_consent_required');
  const workspaceLock = entry.queries.findIndex(row => row.query.includes('FROM swarm.workspaces') && row.query.includes('FOR NO KEY UPDATE'));
  const streamLock = entry.queries.findIndex(row => row.query.includes('FROM swarm.streams') && row.query.includes('FOR UPDATE'));
  assert.ok(workspaceLock !== -1 && streamLock !== -1 && workspaceLock < streamLock);
  assert.ok(!entry.queries.some(row => row.query.includes('UPDATE swarm.invitations') && row.query.includes('consumed_at')));

  entry.setBoundary(null);
  entry.setBoundaryRace(false);
  entry.setMembershipRevokedOffsetMs(-1000);
  entry.setInviteCreatedOffsetMs(-5000);
  entry.queries.length = 0;
  const removedEarly = await invitationHttp(entry, body);
  assert.equal(removedEarly.status, 403);
  assert.equal(removedEarly.body.error, 'forbidden');
  assert.ok(!entry.queries.some(row => /INSERT INTO swarm.memberships|UPDATE swarm.invitations/.test(row.query)));
  assert.ok(entry.queries.some(row => row.query.includes('INSERT INTO swarm.audit_log') && row.values.includes('revocation') && row.values.includes('forbidden')));

  entry.setInviteCreatedOffsetMs(5000);
  entry.queries.length = 0;
  const rejoined = await invitationHttp(entry, { ...body, command_id: 'legacy-rejoin' });
  assert.equal(rejoined.status, 403);
  assert.equal(rejoined.body.error, 'forbidden');
  assert.ok(!entry.queries.some(row => row.query.includes('INSERT INTO swarm.memberships')));
  assert.ok(!entry.queries.some(row => row.query.includes('UPDATE swarm.invitations') && row.query.includes('consumed_at')));
  assert.ok(entry.queries.some(row => row.query.includes('INSERT INTO swarm.audit_log') && row.values.includes('revocation') && row.values.includes('forbidden')));

  entry.setMembershipRevokedOffsetMs(null);
  entry.queries.length = 0;
  const consumed = await invitationHttp(entry, body);
  assert.equal(consumed.status, 200);
  assert.equal(consumed.body.ok, true);
  assert.ok(entry.queries.some(row => row.query.includes('UPDATE swarm.invitations') && row.query.includes('consumed_at')));
  assert.ok(entry.queries.some(row => row.query.includes('INSERT INTO swarm.memberships')));
  assert.equal(entry.queries.some(row => row.query.includes('household_member_content_roles')), false);
  assert.equal(entry.queries.some(row => row.query.includes('household_content_connections')), false);
});

test('member removal proofs match their release copies and the rollback does not rewrite stored rows', async () => {
  const { readFile } = await import('node:fs/promises');
  const read = (path: string) => readFile(new URL('../' + path, import.meta.url), 'utf8');
  for (const suffix of ['rollback', 'catalog', 'rollback-catalog']) {
    assert.equal(
      await read(`supabase/household-member-removal-reserve/20261005000001-${suffix}.sql`),
      await read(`deploy/release-proofs/household-member-removal/20261005000001-${suffix}.sql`),
    );
  }
  const rollback = await read('supabase/household-member-removal-reserve/20261005000001-rollback.sql');
  assert.match(rollback, /CREATE OR REPLACE FUNCTION swarm\.audit_household_permission/);
  assert.doesNotMatch(rollback, /\b(?:DELETE|TRUNCATE)\b/);
  assert.doesNotMatch(rollback, /\bUPDATE\s+swarm\./);
  const restored = await read('deploy/release-proofs/household-member-removal/20261005000001-rollback-catalog.sql');
  assert.match(restored, /003c4cdeebd97eb37f75860de7e6ebc4/);
  assert.match(restored, /position\('remove_member' in prosrc\)=0/);
});

const joinWorkspace = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const joinHuman = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const joinInviter = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const joinInvite = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const joinStream = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const joinNow = 1_700_000_000_000;
const joinEmail = 'person@example.test';

test('a removed content role is not written again, and a first confirmation still is', async () => {
  const token = 'swm_inv_' + 'C'.repeat(43);
  const human = { user_id: joinHuman, email: joinEmail, verified: true as const };
  const invite = (createdAt: number) => ({
    invitation_id: joinInvite,
    workspace_id: joinWorkspace,
    inviter: joinInviter,
    role: 'member',
    email: joinEmail,
    expires_at: new Date(joinNow + 60_000),
    revoked_at: null,
    accepted_at: null,
    accepted_by: null,
    created_at: new Date(createdAt),
  });
  const run = async (membership: 'absent' | 'revoked', role: { content_role: string; revoked_at: Date | null } | null, createdAt: number) => {
    const contentWrites: string[] = [];
    let stored: { content_role?: string | null } | null = null;
    const tx = (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join(' ');
      const reply = (rows: unknown[]) => Promise.resolve(rows);
      if (query.includes('created_by AS inviter')) return reply([invite(createdAt)]);
      if (query.includes('FROM swarm.workspaces')) return reply([{ name: 'Shared home', archived_at: null }]);
      if (query.includes('SELECT stream_id,head_seq')) return reply([{ stream_id: joinStream, head_seq: 0 }]);
      if (query.includes('consumed_at AS accepted_at')) return reply([invite(createdAt)]);
      if (query.includes('SELECT revoked_at FROM swarm.memberships')) {
        return reply(membership === 'revoked' ? [{ revoked_at: new Date(joinNow - 120_000) }] : []);
      }
      if (query.includes('SELECT role,revoked_at FROM swarm.memberships')) return reply([{ role: 'owner', revoked_at: null }]);
      if (query.includes('household_workspace_boundaries')) return reply([{ purpose: 'shared' }]);
      if (query.includes('display_name')) return reply([{ display_name: 'Owner', role: 'owner' }]);
      if (query.includes('floor(extract')) return reply([{ now: joinNow }]);
      if (query.includes('SELECT request_hash')) return reply([]);
      if (query.includes('content_role, revoked_at') && query.includes('FOR UPDATE')) return reply(role ? [role] : []);
      if (query.includes('SELECT content_role FROM') && query.includes('revoked_at IS NULL')) {
        return reply(role && role.revoked_at === null ? [{ content_role: role.content_role }] : []);
      }
      if (query.includes('INSERT INTO swarm.memberships') || query.includes('UPDATE swarm.invitations') || query.includes('INSERT INTO swarm.events') || query.includes('UPDATE swarm.streams') || query.includes('set_config') || query.includes('UPDATE swarm.household_content_connections')) return reply([]);
      if (query.includes('INSERT INTO swarm.household_member_content_roles')) {
        contentWrites.push('insert');
        return reply([{ content_role: values.find((value) => value === 'reader' || value === 'editor') }]);
      }
      if (query.includes('UPDATE swarm.household_member_content_roles')) {
        contentWrites.push('update');
        return reply(role && role.revoked_at === null ? [{ content_role: 'reader' }] : []);
      }
      if (query.includes('INSERT INTO swarm.idempotency_keys')) {
        stored = values.find((value) => value !== null && typeof value === 'object' && 'content_role' in value) as { content_role?: string | null } ?? null;
        return reply([]);
      }
      return Promise.reject(new Error(`unexpected join query: ${query.slice(0, 180)}`));
    };
    (tx as { json?: (value: unknown) => unknown }).json = (value) => value;
    const preview = await humanInvitationTransaction(tx as never, 'hf-preview', {
      kind: 'household_invitation', action: 'preview', invitation: { source: 'link', token },
    }, human);
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    const digest = (preview.body as { preview_digest?: string }).preview_digest;
    assert.match(digest ?? '', /^[0-9a-f]{64}$/);
    const accepted = await humanInvitationTransaction(tx as never, 'hf-accept', {
      kind: 'household_invitation', action: 'accept', invitation: { source: 'link', token },
      consent_version: HOUSEHOLD_JOIN_CONSENT_VERSION, preview_digest: digest, content_role: 'reader',
    }, human);
    return { accepted, contentWrites, stored };
  };

  const revoked = await run('revoked', { content_role: 'editor', revoked_at: new Date(joinNow - 120_000) }, joinNow - 60_000);
  assert.equal(revoked.accepted.status, 200, JSON.stringify(revoked.accepted.body));
  assert.equal((revoked.accepted.body as { content_role: string | null }).content_role, null);
  assert.match(String((revoked.accepted.body as { next_action?: string }).next_action), /fresh consent/);
  assert.match(String((revoked.accepted.body as { next_action?: string }).next_action), /stays revoked/);
  assert.equal(revoked.stored?.content_role, null);
  assert.deepEqual(revoked.contentWrites, []);

  const first = await run('absent', null, joinNow - 60_000);
  assert.equal(first.accepted.status, 200, JSON.stringify(first.accepted.body));
  assert.equal((first.accepted.body as { content_role: string | null }).content_role, 'reader');
  assert.doesNotMatch(String((first.accepted.body as { next_action?: string }).next_action), /fresh consent/);
  assert.deepEqual(first.contentWrites, ['insert']);

  const live = await run('revoked', { content_role: 'editor', revoked_at: null }, joinNow - 60_000);
  assert.equal(live.accepted.status, 200, JSON.stringify(live.accepted.body));
  assert.equal((live.accepted.body as { content_role: string | null }).content_role, 'reader');
  assert.deepEqual(live.contentWrites, ['update']);

  const staleWrites: string[] = [];
  const staleTx = (strings: TemplateStringsArray) => {
    const query = strings.join(' ');
    if (query.includes('INSERT INTO swarm.household_member_content_roles') || query.includes('UPDATE swarm.household_member_content_roles') || query.includes('INSERT INTO swarm.memberships')) staleWrites.push(query);
    if (query.includes('created_by AS inviter') || query.includes('consumed_at AS accepted_at')) {
      return Promise.resolve([invite(joinNow - 180_000)]);
    }
    if (query.includes('FROM swarm.workspaces')) return Promise.resolve([{ name: 'Shared home', archived_at: null }]);
    if (query.includes('SELECT stream_id,head_seq')) return Promise.resolve([{ stream_id: joinStream, head_seq: 0 }]);
    if (query.includes('SELECT revoked_at FROM swarm.memberships')) return Promise.resolve([{ revoked_at: new Date(joinNow - 120_000) }]);
    if (query.includes('SELECT role,revoked_at FROM swarm.memberships')) return Promise.resolve([{ role: 'owner', revoked_at: null }]);
    if (query.includes('household_workspace_boundaries')) return Promise.resolve([{ purpose: 'shared' }]);
    if (query.includes('display_name')) return Promise.resolve([{ display_name: 'Owner', role: 'owner' }]);
    if (query.includes('floor(extract')) return Promise.resolve([{ now: joinNow }]);
    if (query.includes('SELECT request_hash')) return Promise.resolve([]);
    return Promise.reject(new Error(`unexpected stale query: ${query.slice(0, 180)}`));
  };
  const stale = await humanInvitationTransaction(staleTx as never, 'hf-stale', {
    kind: 'household_invitation', action: 'accept', invitation: { source: 'link', token },
    consent_version: HOUSEHOLD_JOIN_CONSENT_VERSION, preview_digest: 'ab'.repeat(32), content_role: 'reader',
  }, human);
  assert.equal(stale.status, 403);
  assert.equal((stale.body as { reason?: string }).reason, 'invitation_predates_removal');
  assert.deepEqual(staleWrites, []);
});
