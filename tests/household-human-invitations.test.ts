import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decideHumanInvite, parseHumanInviteCommand, HOUSEHOLD_JOIN_CONSENT_VERSION, type HumanInviteFacts, type HumanInviteCommand } from '../src/protocol/household-invitations.js';
import { reduceAdminRoutine, emptyAdminRoutine } from '../src/protocol/admin-routine.js';
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
