import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decideHostedContextLifecycle, hostedContextClocks, type HostedContextState, hostedContextReceiptId, hostedContextAuditResult, HOSTED_CONTEXT_AUDIT_MAPPING } from '../src/protocol/hosted-context.js';
import { H0_REQUEST_ID_RE } from '../src/h0/verbs.js';
import { decideHostedAuthority, HOSTED_MCP_RESOURCE, reduceHostedAuthority, reduceWorkspace, type HostedAuthorityEvent, type HostedAuthorityFacts } from '../src/protocol/index.js';
const hour = 3_600_000;
const start = Date.parse('2026-10-01T00:00:00Z');
function state(kind: HostedContextState['kind'] = 'chat', lifetime: HostedContextState['lifetime'] = 'ephemeral'): HostedContextState {
  return { kind, lifetime, origin:'new', ...hostedContextClocks(kind,start), closed_at:null, close_reason:null };
}
// Independent design TTLs. Covers inclusive expiry and the two clocks separately.
for (const [kind,idle,absolute] of [['chat',24*hour,720*hour],['task',12*hour,168*hour],['scheduled',hour/2,24*hour],['subagent',hour/4,4*hour]] as const) {
  test(`${kind}: idle and absolute boundaries never depend on a sweep`,()=>{
    const original=state(kind,'durable');
    assert.equal(original.idle_expires_at,start+idle);
    assert.equal(original.absolute_expires_at,start+absolute);
    for (const clock of ['idle_expires_at','absolute_expires_at'] as const) {
      const target=start+(clock==='idle_expires_at'?idle:absolute);
      const current: HostedContextState={...original,idle_expires_at:clock==='absolute_expires_at'?target+hour:original.idle_expires_at};
      assert.equal(decideHostedContextLifecycle(current,{now:target-1,authorized:true,use:'inspect'}).ok,true);
      for (const now of [target,target+1]) {
        const denied=decideHostedContextLifecycle(current,{now,authorized:true,use:'business'});
        assert.equal(denied.ok,false);
        if(!denied.ok) assert.deepEqual(denied,{ok:false,error:'context_expired',message:'This chat identity expired. Start a new identity to continue; shared work is still here.',can_start_new:true});
      }
    }
  });
}
test('inspection, polling, refresh-only, rejection, replay and repeated ACK leave idle unchanged',()=>{
  const original=state();
  for (const facts of [
    {use:'inspect' as const},{use:'poll' as const},{use:'business' as const,replay:true},
    {use:'ack' as const,fresh_ack:false},{use:'ack' as const},
  ]) {
    const result=decideHostedContextLifecycle(original,{now:start+hour,authorized:true,...facts});
    assert.equal(result.ok,true);if(result.ok){assert.equal(result.changed,false);assert.deepEqual(result.state,original);}
  }
  const denied=decideHostedContextLifecycle(original,{now:start+hour,authorized:false,use:'business'});
  assert.equal(denied.ok,false);
  assert.deepEqual(original,state());
  for (const facts of [{use:'business' as const},{use:'ack' as const,fresh_ack:true}]) {
    const result=decideHostedContextLifecycle(original,{now:start+hour,authorized:true,...facts});
    assert.equal(result.ok,true);if(result.ok){assert.equal(result.state.last_business_at,start+hour);assert.equal(result.state.idle_expires_at,start+25*hour);assert.equal(result.state.absolute_expires_at,start+720*hour);}
  }
});
test('business near the absolute cap cannot extend it, and terminal contexts cannot revive',()=>{
  const original={...state(),idle_expires_at:start+721*hour,last_business_at:start+697*hour};
  const renewed=decideHostedContextLifecycle(original,{now:start+720*hour-1,authorized:true,use:'business'});
  assert.equal(renewed.ok,true);if(!renewed.ok)return;
  assert.equal(renewed.state.absolute_expires_at,start+720*hour);
  assert.equal(decideHostedContextLifecycle(renewed.state,{now:start+720*hour,authorized:true,use:'business'}).ok,false);
  for(const lifetime of ['ephemeral','durable'] as const){
    const closed=decideHostedContextLifecycle(state('chat',lifetime),{now:start+25*hour,authorized:true,use:'close'});
    assert.equal(closed.ok,true);if(!closed.ok)continue;
    assert.equal(closed.retire_principal,lifetime==='ephemeral');
    const retry=decideHostedContextLifecycle(closed.state,{now:start+26*hour,authorized:true,use:'close'});
    assert.equal(retry.ok,true);if(retry.ok){assert.equal(retry.changed,false);assert.equal(retry.state.closed_at,start+25*hour);}
    assert.equal(decideHostedContextLifecycle(closed.state,{now:start+26*hour,authorized:true,use:'business'}).ok,false);
    assert.equal(decideHostedContextLifecycle(closed.state,{now:start+26*hour,authorized:false,use:'close'}).ok,false);
  }
});
test('legacy contexts have no deadline, but close is terminal and expiry never closes live ones',()=>{
  const legacy={...state('chat','durable'),origin:'legacy' as const,idle_expires_at:null,absolute_expires_at:null};
  const result=decideHostedContextLifecycle(legacy,{now:start+1000*hour,authorized:true,use:'business'});
  assert.equal(result.ok,true);if(result.ok){assert.equal(result.state.idle_expires_at,null);assert.equal(result.state.absolute_expires_at,null);}
  const sweep=decideHostedContextLifecycle(legacy,{now:start+1000*hour,authorized:true,use:'expire'});
  assert.equal(sweep.ok,true);if(sweep.ok)assert.equal(sweep.changed,false);
  const expired=decideHostedContextLifecycle(state(),{now:start+24*hour,authorized:true,use:'expire'});
  assert.equal(expired.ok,true);if(expired.ok){assert.equal(expired.state.close_reason,'expired');assert.equal(expired.retire_principal,true);}
});

test('internal attribution keys cannot occupy any caller request namespace', () => {
  for (const request of ['abcdefgh', 'ctx_abcdefgh', 'A'.repeat(72)]) {
    assert.equal(H0_REQUEST_ID_RE.test(request), true);
    assert.equal(H0_REQUEST_ID_RE.test(hostedContextReceiptId(request)), false);
  }
  assert.notEqual(hostedContextReceiptId('abcdefgh'), 'ctx_abcdefgh');
});

test('audit mapping preserves household outcomes and codes while discarding untrusted text', () => {
  for (const [status, outcome] of Object.entries(HOSTED_CONTEXT_AUDIT_MAPPING)) {
    const mapped = hostedContextAuditResult({ status: 200, body: { status, reason: 'object_already_exists', content: 'private content', seat: 'seat_abcdefghijklmnopqrstuv' } });
    assert.deepEqual(mapped, { outcome, reason: 'object_already_exists' });
  }
  assert.deepEqual(hostedContextAuditResult({status: 200, body: {status:'conflict'}}), {outcome:'conflict', reason:null});
  assert.deepEqual(hostedContextAuditResult({status: 200, body: {status:'refused',reason:'object_already_exists'}}, true), {outcome:'replayed', reason:'object_already_exists'});
  for (const reason of ['seat_binding_mismatch', 'patch_base_mismatch', 'object_write_rate_limited']) {
    assert.deepEqual(hostedContextAuditResult({status:200,body:{status:'refused',reason}}),{outcome:'domain',reason});
  }
  for (const reason of ['private content', 'seat_abcdefghijklmnopqrstuv', 'token with spaces', 'x'.repeat(81)]) {
    assert.equal(hostedContextAuditResult({status:200,body:{status:'refused',reason}}).reason,null);
  }
});

test('retirement folds preserve earlier seat and principal terminals independently', () => {
  const event = (type: HostedAuthorityEvent['type'], seq: number, payload: Record<string, unknown>): HostedAuthorityEvent => ({
    type, seq, payload, schema_version:1, workspace_id:'workspace', stream_id:'stream', event_id:`event-${seq}`,
    command_id:`command-${seq}`, actor_user:'owner',actor_agent_principal:null,actor_run:null, occurred_at_server:start+seq,
  });
  const claimed = event('HostedMcpSeatClaimed',1,{seat_id:'seat',grant_id:'grant',principal_id:'principal',workspace_id:'workspace',
    owner_user_id:'owner',name:'Synthetic',handle:'seat_abcdefghijklmnopqrstuv',created_at:start,transport:'hosted_mcp',turn_only:true,identity_lifetime:'ephemeral'});
  const initial = reduceHostedAuthority(null,claimed);
  const workspace = reduceWorkspace(reduceWorkspace(null,{...claimed,type:'WorkspaceCreated',seq:0,
    payload:{workspace_id:'workspace',name:'Synthetic',created_by:'owner',created_at:start}}),claimed);
  for (const alreadyRevoked of [false,true]) {
    const before = alreadyRevoked ? reduceHostedAuthority(initial,event('HostedMcpSeatRevoked',2,{seat_id:'seat',principal_id:'principal',revoked_at:start+10})) : initial;
    const retirement=event('HostedMcpSeatRevoked',3,{seat_id:'seat',principal_id:'principal',revoked_at:start+20,principal_revoked_at:start+10});
    const folded=reduceHostedAuthority(before,retirement);
    assert.equal(folded.seats.seat!.revoked_at,start+(alreadyRevoked?10:20));
    assert.equal(folded.principals.principal!.revoked_at,start+10);
    const baseWorkspace=workspace;
    const ws=reduceWorkspace(baseWorkspace,retirement);
    assert.equal(ws.principals.principal!.revoked_at,start+10);
    const humanRevoked=reduceWorkspace(baseWorkspace,{...retirement,type:'AgentPrincipalRevoked',seq:2,payload:{principal_id:'principal',revoked_at:start+5}});
    assert.equal(reduceWorkspace(humanRevoked,retirement).principals.principal!.revoked_at,start+5);

  }
});

test('human seat retirement carries the earlier principal terminal through reconstruction and sweep', () => {
  const event = (type: HostedAuthorityEvent['type'], seq: number, payload: Record<string, unknown>): HostedAuthorityEvent => ({
    type, seq, payload, schema_version:1, workspace_id:'workspace', stream_id:'stream', event_id:`event-${seq}`,
    command_id:`command-${seq}`, actor_user:'owner',actor_agent_principal:null,actor_run:null, occurred_at_server:start+seq,
  });
  const claimed = event('HostedMcpSeatClaimed',1,{seat_id:'seat',grant_id:'grant',principal_id:'principal',workspace_id:'workspace',
    owner_user_id:'owner',name:'Synthetic',handle:'seat_abcdefghijklmnopqrstuv',created_at:start,transport:'hosted_mcp',turn_only:true,identity_lifetime:'ephemeral'});
  const initial = reduceHostedAuthority(null,claimed);
  const workspace = reduceWorkspace(reduceWorkspace(null,{...claimed,type:'WorkspaceCreated',seq:0,
    payload:{workspace_id:'workspace',name:'Synthetic',created_by:'owner',created_at:start}}),claimed);
  // The active-principal case is the same-command positive control. Hosted
  // reconstruction sees only hosted events; the workspace also sees T1.
  for (const principalRevokedAt of [null,start+10]) {
    const facts: HostedAuthorityFacts = {
      grant:{grant_id:'grant',provider_grant_id:'provider',owner_user_id:'owner',home_workspace_id:'workspace',client_id:'client',
        resource:HOSTED_MCP_RESOURCE,state:'active',manifest_digest:'ab'.repeat(32),interaction_ref:'interaction',
        selected_workspace_ids:['workspace'],consented_workspace_ids:['workspace']},
      seat:{...initial.seats.seat!,principal_revoked_at:principalRevokedAt},
      owner_is_live_member:true,workspace_archived:false,workspace_consented:true,all_required_consents:true,
      all_required_memberships:true,exact_name_principals:[],live_seat_count:1,
    };
    let seq=2;
    const decision = decideHostedAuthority({kind:'revoke_hosted_mcp_seat',grant_id:'grant',seat_id:'seat'},facts,{
      now:start+20,actor:{user:'owner',agent_principal:null,run:null},credential_kind:'human',command_id:'human-revoke',
      workspace_id:'workspace',stream_id:'stream',nextSeq:()=>++seq,nextEventId:()=>`event-${seq}`,
    });
    assert.equal(decision.ok,true);
    if(!decision.ok)return;
    assert.equal(decision.events.length,1);
    const retirement=decision.events[0]!;
    let hosted=reduceHostedAuthority(initial,retirement);
    let ws=principalRevokedAt===null?workspace:reduceWorkspace(workspace,{...claimed,type:'AgentPrincipalRevoked',seq:2,
      payload:{principal_id:'principal',revoked_at:principalRevokedAt}});
    ws=reduceWorkspace(ws,retirement);
    const expectedPrincipal=principalRevokedAt??start+20;
    const assertTerminals=()=>{
      assert.equal(hosted.seats.seat!.revoked_at,start+20);
      assert.equal(hosted.seats.seat!.handle_revoked_at,start+20);
      assert.equal(ws.principals.principal!.revoked_at,expectedPrincipal);
      assert.equal(hosted.principals.principal!.revoked_at,expectedPrincipal,'hosted reconstruction must retain the principal terminal');
      assert.equal(hosted.seats.seat!.principal_revoked_at,expectedPrincipal);
    };
    assertTerminals();
    const sweep=event('HostedMcpSeatRevoked',4,{grant_id:'grant',seat_id:'seat',principal_id:'principal',
      revoked_at:start+30,principal_revoked_at:expectedPrincipal});
    hosted=reduceHostedAuthority(hosted,sweep);
    ws=reduceWorkspace(ws,sweep);
    assertTerminals();
  }
});
