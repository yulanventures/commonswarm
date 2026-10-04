import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decideHumanInvite, parseHumanInviteCommand, HOUSEHOLD_JOIN_CONSENT_VERSION, type HumanInviteFacts, type HumanInviteCommand } from '../src/protocol/household-invitations.js';
import { reduceAdminRoutine, emptyAdminRoutine } from '../src/protocol/admin-routine.js';
import { build } from 'esbuild';
import { randomUUID } from 'node:crypto';
const command: HumanInviteCommand={kind:'household_invitation',action:'accept',invitation:{source:'delegated',invitation_id:'11111111-1111-4111-8111-111111111111'},consent_version:HOUSEHOLD_JOIN_CONSENT_VERSION,preview_digest:'a'.repeat(64),content_role:'reader'};
const facts:HumanInviteFacts={human:true,identity_verified:true,recipient_matches:true,invitation_kind:'member',role:'member',personal_boundary:false,inviter_can_invite:true,parent_live:true,now:100,expires_at:200,revoked_at:null,accepted_at:null,accepted_by:null,user_id:'recipient',member_live:false,preview_digest:'a'.repeat(64)};
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
      let boundary = true;
      const settings = { SWARM_ENV: 'test', SWARM_DATABASE_URL: 'postgres://127.0.0.1:1/unused',
        SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_ANON_KEY: 'inert-test-value' };
      const Deno = { env: { get: name => settings[name] }, serve: () => { throw new Error('unexpected server'); } };
      const priorDeno = Object.getOwnPropertyDescriptor(globalThis, 'Deno');
      Object.defineProperty(globalThis, 'Deno', { value: Deno, configurable: true });` },
    footer: { js: `
      if (priorDeno) Object.defineProperty(globalThis, 'Deno', priorDeno); else Reflect.deleteProperty(globalThis, 'Deno');
      export { queries }; export function setBoundary(value) { boundary = value; }
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
              if (query.includes('FROM swarm.workspaces')) return [{ name: 'Synthetic shared', archived_at: null }];
              if (query.includes('FROM swarm.streams')) return [{ stream_id: userId, head_seq: 0 }];
              if (query.includes('consumed_at AS accepted_at')) return [{ role: 'member', email: 'recipient@example.test',
                expires_at: new Date(Date.now() + 3600000), revoked_at: null, accepted_at: null, accepted_by: null }];
              if (query.includes('SELECT role,revoked_at FROM swarm.memberships')) return [{ role: 'owner', revoked_at: null }];
              if (query.includes('swarm.household_workspace_boundaries')) return boundary ? [{ purpose: 'shared' }] : [];
              if (query.includes('floor(extract(epoch FROM clock_timestamp())')) return [{ now: Date.now() }];
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
    setBoundary(value: boolean): void;
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
test('legacy acceptance always requires recipient review, including workspaces without an overlay', async () => {
  const entry = await invitationEntry('command');
  const token = 'swm_inv_' + 'A'.repeat(43);
  const control = await invitationHttp(entry, { command_id: 'review-invite', client_version: '0.1.80',
    command: { kind: 'household_invitation', action: 'preview', invitation: { source: 'link', token } } });
  assert.equal(control.status, 200); assert.equal(control.body.status, 'preview');
  assert.equal(control.body.workspace_name, 'Synthetic shared');
  for (const boundary of [true, false]) {
    entry.setBoundary(boundary); entry.queries.length = 0;
    assert.deepEqual(await invitationHttp(entry, { command_id: 'legacy-invite', client_version: '0.1.80',
      command: { kind: 'accept_invitation', token } }), { status: 403, body: {
        error: 'recipient_consent_required', message: 'Open the invitation in /invite and review it as yourself.',
      } }, `boundary present: ${boundary}`);
    assert.ok(entry.queries.some(row => row.query.includes('INSERT INTO swarm.audit_log') && row.values.includes('recipient_consent_required')));
    assert.ok(!entry.queries.some(row => /INSERT INTO swarm.memberships|UPDATE swarm.invitations/.test(row.query)));
  }
});
