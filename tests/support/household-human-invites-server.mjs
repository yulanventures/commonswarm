/** Local cloned schema only. No production hosts, vendor calls or credential output. */
import postgres from 'npm:postgres@3.4.9';
import assert from 'node:assert/strict';
import * as core from '../../supabase/functions/_shared/protocol.js';
import {humanInvitationTransaction} from '../../supabase/functions/command/household-invitations.ts';
import {prepareAdminRoutine,applyAdminRoutine} from '../../supabase/functions/command/admin-routine.ts';
const input=JSON.parse(await Deno.readTextFile(Deno.args[0]));
assert.ok(['localhost','127.0.0.1','[::1]'].includes(new URL(input.db_url).hostname));
const db=postgres(input.db_url,{max:2,prepare:false});
const id=()=>crypto.randomUUID(),owner=id(),recipient=id(),other=id(),workspace=id(),privateSpace=id(),stream=id(),grantId=id();
const now=Date.now()-60000,session='synthetic-owner-session';
let state=core.emptyAdminAccount(),accountSeq=0;
const manifest={admin_identity_id:id(),connection_id:id(),client_id:'https://synthetic-client.example.test',resource:core.ADMIN_RESOURCE,mode:'granular',registry_version:core.ADMIN_REGISTRY_VERSION,
  scope_names:['admin:read','invites:create'],capability_names:core.adminAvailableCapabilities(['admin:read','invites:create']),availability_digest:core.adminAvailabilityDigest(core.ADMIN_REGISTRY_VERSION),workspace_selector:'selected',workspace_ids:[workspace],created_workspace_policy:{scope_names:[]},
  target_rules:{seat_ids:[],own_seats:false,grant_created_seats:false,recipient_user_ids:[recipient,other],recipient_connection_ids:[],transports:[]},worker_scope_ceiling:[],role_ceiling:'member',
  renewal_limits:{...core.ADMIN_RENEWAL_CEILINGS,grant_kinds:[],principal_ids:[]},issuance_limits:{...core.ADMIN_ISSUANCE_CEILINGS},expires_at:now+86400000,refresh_deadline:now+86400000};
const hex=async v=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(v))),b=>b.toString(16).padStart(2,'0')).join('');
const digest=await hex(core.canonicalAdminJson(manifest)),receipt=id();
const ctx={now,owner_user_id:owner,actor:{kind:'human',user_id:owner,session_binding:session},command_id:id(),stream_id:id(),request_digest:'a'.repeat(64),nextSeq:()=>++accountSeq,nextEventId:id,current_workspace_rights:true,withdrawing_workspace_owner:false,target_workspace_owned_by_grantor:false,presenting_refresh_generation:null,presenting_refresh_lineage_id:null};
const runCore=command=>{ctx.command_id=id();const d=core.decideAdminAuthority(command,state,ctx);assert.ok(d.ok);state=d.events.reduce(core.reduceAdminAuthority,state);for(const consent of Object.values(state.consents))consent.session_binding=session;return d.events;};
const seedEvents=[...runCore({kind:'prepare_admin_consent',consent:{consent_receipt_id:receipt,owner_user_id:owner,session_binding:session,manifest,manifest_digest:digest,full_account_selected:false,expires_at:now+300000,consumed_at:null}}),...runCore({kind:'grant_admin_delegation',grant_id:grantId,consent_receipt_id:receipt,replaces_grant_id:null})];
const worker={user_id:recipient,email:'recipient@example.test',verified:true};
const ref=invitation_id=>({source:'delegated',invitation_id});
const command=(invitation,action='preview',extra={})=>({kind:'household_invitation',action,invitation,...extra});
const call=async(c,who=worker,request=id())=>await db.begin(async tx=>{await tx`SET LOCAL ROLE swarm_command`;return await humanInvitationTransaction(tx,request,c,who);});
let phase='seed';
try {
  await db.begin(async tx=>{
    for(const [user,name,email] of [[owner,'Synthetic inviter','owner@example.test'],[recipient,'Synthetic recipient','recipient@example.test'],[other,'Other human','other@example.test']]){
      await tx`INSERT INTO auth.users(id,aud,role,email) VALUES(${user}::uuid,'authenticated','authenticated',${email})`;
      await tx`INSERT INTO swarm.users(user_id,display_name,email) VALUES(${user}::uuid,${name},${email})`;
    }
    await tx`INSERT INTO swarm.workspaces(workspace_id,name,created_by) VALUES(${workspace}::uuid,'Synthetic household',${owner}::uuid),(${privateSpace}::uuid,'Excluded personal',${owner}::uuid)`;
    await tx`INSERT INTO swarm.memberships(workspace_id,user_id,role) VALUES(${workspace}::uuid,${owner}::uuid,'owner'),(${privateSpace}::uuid,${owner}::uuid,'owner')`;
    await tx`INSERT INTO swarm.streams(workspace_id,stream_id,kind) VALUES(${workspace}::uuid,${stream}::uuid,'workspace')`;
    await tx`INSERT INTO swarm.household_workspace_boundaries(workspace_id,purpose) VALUES(${workspace}::uuid,'shared')`;
    await tx`INSERT INTO swarm.admin_accounts(owner_user_id,stream_id,seq,projection) VALUES(${owner}::uuid,${ctx.stream_id}::uuid,${accountSeq},${tx.json(state)})`;
    for(const e of seedEvents)await tx`INSERT INTO swarm.admin_events(owner_user_id,seq,event_id,command_id,event) VALUES(${owner}::uuid,${e.seq},${e.event_id}::uuid,${e.command_id},${tx.json(e)})`;
    const g=state.grants[grantId];
    await tx`INSERT INTO swarm.admin_grants(grant_id,owner_user_id,admin_identity_id,connection_id,client_id,resource,mode,registry_version,scope_names,workspace_selector,workspace_ids,created_workspace_policy,target_rules,worker_scope_ceiling,role_ceiling,renewal_limits,issuance_limits,expires_at,refresh_deadline,state,consent_receipt_id,manifest_digest,created_at)
      VALUES(${grantId}::uuid,${owner}::uuid,${g.admin_identity_id}::uuid,${g.connection_id}::uuid,${g.client_id},${g.resource},${g.mode},${g.registry_version},${g.scope_names},${g.workspace_selector},${g.workspace_ids}::uuid[],${tx.json(g.created_workspace_policy)},${tx.json(g.target_rules)},${g.worker_scope_ceiling},${g.role_ceiling},${tx.json(g.renewal_limits)},${tx.json(g.issuance_limits)},${new Date(g.expires_at)},${new Date(g.refresh_deadline)},'active',${receipt}::uuid,${g.manifest_digest},${new Date(g.created_at)})`;
  });
  // Real routine issue decisions and adapter produce the records consumed below.
  const issue=async()=>await db.begin(async tx=>{
    await tx`SET LOCAL ROLE swarm_command`;
    const [account]=await tx`SELECT projection,seq FROM swarm.admin_accounts WHERE owner_user_id=${owner}::uuid FOR UPDATE`;
    let seq=Number(account.seq);const routineCtx={...ctx,command_id:id(),actor:{kind:'delegated_admin',grant_id:grantId,admin_identity_id:manifest.admin_identity_id,connection_id:manifest.connection_id,resource:core.ADMIN_RESOURCE,scope_names:manifest.scope_names,access_expires_at:Date.now()+300000},nextSeq:()=>++seq};
    const c={kind:'admin_invite_member',grant_id:grantId,workspace_id:workspace,recipient_user_id:recipient,role:'member',ttl_seconds:3600};
    const facts=await prepareAdminRoutine(tx,c,account.projection,routineCtx,null),decision=core.decideAdminRoutine(c,account.projection,facts);assert.ok(decision.ok);
    await applyAdminRoutine(tx,c,facts,decision);
    const next=decision.events.reduce(core.reduceAdminAuthority,account.projection);
    for(const event of decision.events)await tx`INSERT INTO swarm.admin_events(owner_user_id,seq,event_id,command_id,event) VALUES(${owner}::uuid,${event.seq},${event.event_id}::uuid,${event.command_id},${tx.json(event)})`;
    await tx`UPDATE swarm.admin_accounts SET seq=${seq},projection=${tx.json(next)} WHERE owner_user_id=${owner}::uuid`;
    return decision.events.find(e=>e.type==='AdminMemberInvited').payload.invitation_id;
  });
  phase='issue';
  const valid=await issue(),expired=await issue(),revoked=await issue(),parent=await issue();
  const inbox=async user=>await db.begin(async tx=>{await tx`SET LOCAL ROLE swarm_read`;await tx`SELECT set_config('request.jwt.claims',${JSON.stringify({sub:user,role:'authenticated'})},true)`;return await tx`SELECT * FROM swarm_read.human_invitations()`;});
  phase='recipient-inbox';
  assert.equal((await inbox(recipient)).length,4);assert.equal((await inbox(other)).length,0);assert.equal((await inbox(owner)).length,0);
  phase='negative-invitations';
  await db`UPDATE swarm.admin_routine_invitations SET expires_at=clock_timestamp()-interval '1 second' WHERE invitation_id=${expired}::uuid`;
  await db`UPDATE swarm.admin_routine_invitations SET revoked_at=clock_timestamp() WHERE invitation_id=${revoked}::uuid`;
  assert.equal((await call(command(ref(valid)),{...worker,user_id:other})).status,403);
  assert.equal((await call(command(ref(valid)),null)).status,403);
  assert.equal((await call(command(ref(expired)))).status,403);assert.equal((await call(command(ref(revoked)))).status,403);
  phase='preview';
  const preview=await call(command(ref(valid)));assert.equal(preview.status,200);assert.equal(preview.body.status,'preview');
  const accept=command(ref(valid),'accept',{consent_version:preview.body.consent_version,preview_digest:preview.body.preview_digest,content_role:'reader'}),request=id();
  phase='rollback';
  // Inject a real transaction failure after all join writes, not a fake adapter.
  try {await db.begin(async tx=>{await tx`SET LOCAL ROLE swarm_command`;const result=await humanInvitationTransaction(tx,request,accept,worker);assert.equal(result.status,200);throw new Error('owned rollback control');});}catch(e){assert.equal(e.message,'owned rollback control');}
  assert.equal((await db`SELECT count(*)::int AS n FROM swarm.memberships WHERE workspace_id=${workspace}::uuid AND user_id=${recipient}::uuid`)[0].n,0);
  phase='concurrent-consumption';
  const outcomes=await Promise.all([call(accept,worker,request),call(accept,worker,request)]);assert.ok(outcomes.every(r=>r.status===200));
  assert.equal((await db`SELECT count(*)::int AS n FROM swarm.memberships WHERE workspace_id=${workspace}::uuid AND user_id=${recipient}::uuid`)[0].n,1);
  assert.equal((await db`SELECT count(*)::int AS n FROM swarm.events WHERE workspace_id=${workspace}::uuid AND type='MemberJoined'`)[0].n,1);
  assert.equal((await db`SELECT count(*)::int AS n FROM swarm.agent_principals WHERE owner_user_id=${recipient}::uuid`)[0].n,0);
  assert.equal((await db`SELECT content_role FROM swarm.household_member_content_roles WHERE workspace_id=${workspace}::uuid AND user_id=${recipient}::uuid`)[0].content_role,'reader');
  assert.equal((await call({...accept,content_role:'editor'},worker,request)).status,409);
  phase='revoked-access';
  await db`UPDATE swarm.memberships SET revoked_at=clock_timestamp() WHERE workspace_id=${workspace}::uuid AND user_id=${recipient}::uuid`;
  assert.equal((await call(accept,worker,request)).status,403);
  await db`UPDATE swarm.admin_grants SET state='revoked',revoked_at=clock_timestamp(),reason_code='test_revoke' WHERE grant_id=${grantId}::uuid`;
  assert.equal((await call(command(ref(parent)))).status,403);
  assert.equal((await inbox(recipient)).length,0);
  assert.equal((await db`SELECT count(*)::int AS n FROM swarm.memberships WHERE workspace_id=${privateSpace}::uuid AND user_id=${recipient}::uuid`)[0].n,0);
  // Ordinary link has a separate human email binding and the same independent consent.
  phase='link-consent';
  const token='swm_inv_'+Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>String.fromCharCode(b)).join('');
  const safeToken='swm_inv_'+btoa(token.slice(8)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
  const tokenHash=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(safeToken))),linkId=id();
  await db`INSERT INTO swarm.invitations(invitation_id,workspace_id,email,role,token_hash,created_by,created_at,expires_at) VALUES(${linkId}::uuid,${workspace}::uuid,'recipient@example.test','member',${tokenHash},${owner}::uuid,clock_timestamp(),clock_timestamp()+interval '1 day')`;
  const link={source:'link',token:safeToken};
  assert.equal((await call(command(link),{...worker,email:'wrong@example.test'})).status,403);
  const lp=await call(command(link));assert.equal(lp.status,200);
  const lc=command(link,'accept',{consent_version:lp.body.consent_version,preview_digest:lp.body.preview_digest,content_role:'editor'});
  const lr=await call(lc);assert.equal(lr.status,200);
  const [consumed]=await db`SELECT consumed_by,consumed_at FROM swarm.invitations WHERE invitation_id=${linkId}::uuid`;
  assert.equal(consumed.consumed_by,recipient);assert.ok(consumed.consumed_at);
  phase='credential-free-receipt';
  const serialized=JSON.stringify(await db`SELECT response FROM swarm.idempotency_keys WHERE principal_id=${recipient}`);
  assert.ok(!serialized.includes(safeToken));assert.ok(!serialized.includes('swm_agt_'));
  console.log('HOUSEHOLD_HUMAN_INVITES_SERVER_OK');
} catch(error) {
  // Fixed phases, SQLSTATE and numeric assertion values only. Never driver text,
  // SQL, parameters, credentials or a raw stack.
  const code=typeof error?.code==='string' && /^(?:[A-Z0-9]{5}|ERR_ASSERTION)$/.test(error.code) ? error.code : 'unknown';
  const numbers=Object.fromEntries(['expected','actual'].filter(k=>typeof error?.[k]==='number' && Number.isFinite(error[k])).map(k=>[k,error[k]]));
  console.error('HOUSEHOLD_HUMAN_INVITES_SERVER_FAILED '+JSON.stringify({phase,code,...numbers}));Deno.exitCode=1;
}
finally {await db.end();}
