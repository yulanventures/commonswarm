/** Phase-3 SQL/catalog and real edge proofs. CI only; uses the isolated-stack harness. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { adminEdgeDatabase } from '../support/admin-edge-database.js';
import { repoSql, runSql } from '../support/admin-schema-db.js';
const proof='deploy/release-proofs/session-identity/20261006000004-';
function catalog(path:string,expected:boolean) {
  return repoSql(path)+`\nSELECT :'catalog_ok'::boolean=${expected} AS lifecycle_proof\n\\gset\n\\if :lifecycle_proof\n\\else\nDO $fail$ BEGIN RAISE EXCEPTION 'phase-3 catalog mismatch'; END $fail$;\n\\endif\n`;
}
test('source-built prerequisite, full migration, function-fence perturbation and exact reserve',()=>{
  const up=repoSql('supabase/migrations/20261006000004_hosted_context_lifecycle.sql');
  const reserve=repoSql(proof+'rollback.sql');
  const inverse=repoSql(proof+'preimage.sql');
  const marker='-- Canonical data-free reserve begins. Decode bare "--" as empty; otherwise strip exactly "-- ".\n';
  const embedded=up.split(marker)[1]!.split('-- Canonical data-free reserve ends.')[0]!;
  assert.equal(embedded.split('\n').slice(0,-1).map(line=>{
    if(line==='--')return '';
    assert.ok(line.startsWith('-- '));
    return line.slice(3);
  }).join('\n')+'\n',reserve);
  assert.ok(reserve.endsWith(inverse),'separately hashed preimage is expanded verbatim');
  // The CI source stack is already at phase 3. Rehearse its inverse before the
  // prerequisite proof; no customer rows are copied by emptyApplicationSchema.
  const helper=up.slice(up.indexOf('CREATE OR REPLACE FUNCTION swarm.resolve_hosted_context'),up.indexOf('CREATE OR REPLACE FUNCTION swarm.resolve_hosted_seat_command_authorization'));
  runSql(`INSERT INTO swarm.config(key,value) VALUES('hosted_context_allocation_enabled','false');\n${reserve}\n${catalog(proof+'before-catalog.sql',true)}\n${up}\n${catalog(proof+'catalog.sql',true)}\n${helper.replace("g.state='active'","g.state='pending'")}\n${catalog(proof+'catalog.sql',false)}\n${helper}\n${catalog(proof+'catalog.sql',true)}\n${repoSql(proof+'functional.sql')}\n${reserve}\n${catalog(proof+'rollback-catalog.sql',true)}\n${catalog(proof+'catalog.sql',false)}`);
});
const commandUrl=new URL('../../supabase/functions/command/index.ts',import.meta.url).href;
const readUrl=new URL('../../supabase/functions/read/index.ts',import.meta.url).href;
const authUrl=new URL('../../supabase/functions/_shared/hosted-seat-auth.ts',import.meta.url).href;
const harness=String.raw`
const config=JSON.parse(await new Response(Deno.stdin.readable).text());
Deno.env.set('SWARM_ENV','test');Deno.env.set('SWARM_DATABASE_URL',config.local.DB_URL);
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY',config.local.SERVICE_ROLE_KEY);
Deno.env.set('SUPABASE_URL',config.local.API_URL);Deno.env.set('SUPABASE_ANON_KEY',config.local.ANON_KEY);
const {db,handleHostedCommand,handleHostedManagementCommand}=await import(COMMAND_URL);
const {handleHostedRead}=await import(READ_URL);
const {authenticateHostedGrantCapability,authenticateHostedSeatCapability}=await import(AUTH_URL);
const core=await import(new URL('../_shared/protocol.js',COMMAND_URL).href);
const id=()=>crypto.randomUUID();const ms=value=>new Date(value).getTime();let assertions=0;
const check=(value,label)=>{assertions++;if(!value)throw new Error(label);};
const sql=(text,parameters=[])=>db.unsafe(text,parameters);
const owner=config.owner,workspace=id(),stream=id();
async function grant(client='lifecycle-registered-client'){
 const g=id();await sql("INSERT INTO swarm.hosted_mcp_grants(grant_id,provider_grant_id,owner_user_id,home_workspace_id,client_id,resource,selected_workspace_ids,manifest_digest,interaction_ref,state,created_at,activated_at) VALUES($1,'provider-'||$1,$2,$3,$4,'https://mcp.commonswarm.com/mcp',ARRAY[$3::uuid],decode(repeat('00',32),'hex'),'fixture','active',statement_timestamp(),statement_timestamp())",[g,owner,workspace,client]);
 await sql("INSERT INTO swarm.hosted_mcp_grant_workspaces(grant_id,workspace_id,owner_user_id,manifest_digest,consent_receipt_id,consented_at) VALUES($1,$2,$3,decode(repeat('00',32),'hex'),$4,statement_timestamp())",[g,workspace,owner,id()]);return g;
}
async function claim(g,args={},request=id()){
 const cap=await db.begin(tx=>authenticateHostedGrantCapability(tx,{grantId:g,ownerUserId:owner,providerGrantId:'provider-'+g,workspaceId:workspace,tool:'claim_hosted_seat',providerStatus:async()=>({active:true})}));
 check(cap!==null,'claim positive authorization');return handleHostedCommand({command_id:request,client_version:'0.1.80',workspace_id:workspace,stream:{kind:'workspace'},command:{kind:'claim_hosted_seat',...args}},cap);
}
async function cap(g,handle,tool,use='command',active=true){return db.begin(tx=>authenticateHostedSeatCapability(tx,{grantId:g,providerGrantId:'provider-'+g,handle,tool,providerStatus:async()=>({active})},use));}
const envelope=(command,request=id())=>({command_id:request,client_version:'0.1.80',workspace_id:workspace,stream:{kind:'workspace'},command});
async function close(g,handle,request=id()){const c=await cap(g,handle,'close_session');check(c!==null,'close positive authority');return handleHostedCommand(envelope({kind:'close_hosted_session',seat:handle},request),c);}
async function inspect(g,handle){const c=await cap(g,handle,'whoami','read');if(!c)return {body:{error:'identity_resume_unavailable'}};return handleHostedRead({resource:'whoami',workspace_id:workspace},c);}
async function poll(g,handle,ack){const c=await cap(g,handle,'check');check(c!==null,'check positive authority');return handleHostedCommand(envelope({kind:ack?'ack_hosted_mcp_check_batch':'open_hosted_mcp_check_batch',seat:handle,...(ack?{ack}:{})}),c);}
try{
 await sql("INSERT INTO swarm.workspaces(workspace_id,name,created_by) VALUES($1,'Lifecycle fixture',$2)",[workspace,owner]);
 await sql("INSERT INTO swarm.memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')",[workspace,owner]);
 await sql("INSERT INTO swarm.streams(stream_id,workspace_id,kind) VALUES($1,$2,'workspace')",[stream,workspace]);
 await sql("INSERT INTO swarm.config(key,value) VALUES('hosted_context_allocation_enabled','true'),('min_client_version','\"0.1.0\"') ON CONFLICT(key) DO UPDATE SET value=excluded.value");
 const g=await grant(),a=(await claim(g,{name:'Shared durable',lifetime:'durable'})).body;
 const b=(await claim(g,{intent:'continue',name:'Shared durable'})).body;
 check(a.context_id!==b.context_id&&a.principal_id===b.principal_id,'fresh contexts share durable principal');
 const before=await inspect(g,a.handle);check(before.status===200&&before.body.context_id===a.context_id,'selected identity complete');
 const polling=await poll(g,a.handle);check(polling.status===200,'no-ACK poll accepted');
 check((await inspect(g,a.handle)).body.last_business_at===before.body.last_business_at,'inspection and poll do not renew');
 // Business mutation is real; replay renews neither activity nor events.
 const noteCap=await cap(g,a.handle,'note'),noteRequest=id();
 const note=envelope({kind:'post_signal',signal_kind:'note',body:'Synthetic retained work',to_user_id:null,to_agent_principal_id:null,in_reply_to:null,about:null},noteRequest);
 const posted=await handleHostedCommand(note,noteCap);check(posted.status===200&&posted.body.status==='accepted','real business mutation positive control');
 const afterNote=await inspect(g,a.handle);check(afterNote.body.last_business_at>=before.body.last_business_at,'accepted mutation activity');
 check((await handleHostedCommand(note,noteCap)).body.replayed===true,'mutation exact replay');
 check((await inspect(g,a.handle)).body.last_business_at===afterNote.body.last_business_at,'replay never renews');
 // A and B receive the same directed signal but own distinct batches.
 const askCap=await cap(g,b.handle,'ask');
 const asked=await handleHostedCommand(envelope({kind:'post_signal',signal_kind:'ask',body:'Synthetic directed signal',to_user_id:null,to_agent_principal_id:a.principal_id,in_reply_to:null,about:null}),askCap);
 check(asked.status===200&&asked.body.status==='accepted','directed message committed');
 const pa=await poll(g,a.handle),pb=await poll(g,b.handle);
 check(pa.body.batch_id&&pb.body.batch_id&&pa.body.batch_id!==pb.body.batch_id,'one batch per context on shared inbox');
 check((await poll(g,b.handle,pa.body.batch_id)).body.error==='hosted_check_batch_forbidden','B cannot ACK A');
 check((await poll(g,b.handle,pb.body.batch_id)).status===200,'same-route B ACK positive control');
 const afterAck=await inspect(g,b.handle);await poll(g,b.handle,pb.body.batch_id);
 check((await inspect(g,b.handle)).body.last_business_at===afterAck.body.last_business_at,'repeated ACK never renews');
 const nextAsk=await handleHostedCommand(envelope({kind:'post_signal',signal_kind:'ask',body:'Synthetic next batch',to_user_id:null,to_agent_principal_id:b.principal_id,in_reply_to:null,about:null}),askCap);
 check(nextAsk.status===200,'next shared signal positive control');
 const liveB=await poll(g,b.handle);check(liveB.body.batch_id,'B has an open batch before A close');
 const closeId=id(),closed=await close(g,a.handle,closeId);check(closed.body.principal_state==='retained','durable retained');
 const retry=await close(g,a.handle,closeId),again=await close(g,a.handle);
 check(retry.body.outcome==='replayed'&&again.body.outcome==='closed'&&again.body.closed_at===closed.body.closed_at,'close exact and distinct retries preserve time');
 check((await inspect(g,a.handle)).body.error==='context_closed','A terminal');check((await inspect(g,b.handle)).status===200,'B survives A close');check((await poll(g,b.handle)).body.batch_id===liveB.body.batch_id,'B open batch survives A close');
 const [rows]=await sql("SELECT (SELECT count(*) FROM swarm.signals WHERE workspace_id=$1) AS committed,(SELECT count(*) FROM swarm.hosted_mcp_check_batches WHERE context_id=$2 AND cancelled_at IS NOT NULL) AS cancelled",[workspace,a.context_id]);
 check(Number(rows.committed)>=2&&Number(rows.cancelled)===1,'committed shared work and A cancellation retained');
 // Stopped sweep cannot prolong access. Create already-expired fixtures directly
 // with real clocks; the production handler remains free of shortened test TTLs.
 const expired=(await claim(g)).body;
 await sql("ALTER TABLE swarm.hosted_agent_contexts DISABLE TRIGGER hosted_context_guard");
 await sql("UPDATE swarm.hosted_agent_contexts SET created_at=statement_timestamp()-interval '3 days',last_business_at=statement_timestamp()-interval '3 days',idle_expires_at=statement_timestamp()-interval '2 days',absolute_expires_at=statement_timestamp()+interval '27 days' WHERE context_id=$1",[expired.context_id]);
 await sql("ALTER TABLE swarm.hosted_agent_contexts ENABLE TRIGGER hosted_context_guard");
 check((await inspect(g,expired.handle)).body.error==='context_expired','deadline enforced before sweep');
 await sql('SELECT swarm.expire_hosted_agent_contexts(100)');
 check((await inspect(g,expired.handle)).body.error==='context_expired','swept own context still returns expiry');
 check((await close(g,expired.handle)).body.principal_state==='retired','close authorized after expiry');

 // Real household handler proofs: caller namespaces, all recorded outcomes,
 // original-context replay fences, activity and content-free context audits.
 await sql("INSERT INTO swarm.household_workspace_boundaries(workspace_id,purpose) VALUES($1,'shared')",[workspace]);
 await sql("INSERT INTO swarm.household_member_content_roles(workspace_id,user_id,content_role,content_consent_id,confirmed_at) VALUES($1,$2,'editor',$3,clock_timestamp())",[workspace,owner,id()]);
 async function householdContext(name){
  const qa=(await claim(g,{name,lifetime:'durable'})).body,qb=(await claim(g,{intent:'continue',name})).body;
  await sql("INSERT INTO swarm.household_content_connections(connection_id,grant_id,workspace_id,principal_id,owner_user_id,purpose,operations,consent_receipt_id,hosted_grant_id) VALUES($1,$2,$3,$4,$5,'shared',ARRAY['read','create','update'],$6,$2)",[qa.seat_id,g,workspace,qa.principal_id,owner,id()]);
  return [qa,qb];
 }
 async function household(context,tool,args,request=id()){
  const capability=await cap(g,context.handle,tool);check(capability!==null,'household same-route authority positive control');
  return handleHostedCommand(envelope({kind:'household_tool',tool,arguments:{seat:context.handle,request_id:request,...args}},request),capability);
 }
 async function signal(context,request){
  const capability=await cap(g,context.handle,'note');return handleHostedCommand(envelope({kind:'post_signal',signal_kind:'note',body:'Synthetic receipt collision',to_user_id:null,to_agent_principal_id:null,in_reply_to:null,about:null},request),capability);
 }
 const [qa,qb]=await householdContext('Household namespace fixture');
 for(const [request,order] of [['abcdefgh','household-first'],['ijklmnop','signal-first']]){
  const object=id(),args={object_id:object,title:'Synthetic receipt',content:{kind:'doc',markdown:'base'}};
  const calls=order==='household-first'?[()=>household(qa,'object_create',args,request),()=>signal(qa,'ctx_'+request)]
    :[()=>signal(qa,'ctx_'+request),()=>household(qa,'object_create',args,request)];
  for(const call of calls){
   const before=(await inspect(g,qa.handle)).body.last_business_at;await new Promise(resolve=>setTimeout(resolve,10));
   const result=await call();check(result.status===200&&['committed','accepted'].includes(result.body.status),'independent household and signal receipts in '+order);
   check(ms((await inspect(g,qa.handle)).body.last_business_at)>ms(before),'each fresh call renews in '+order);
  }
  check((await household(qa,'object_create',args,request)).body.replayed===true,'household exact positive replay');
  check((await signal(qa,'ctx_'+request)).body.replayed===true,'signal exact positive replay');
 }
 for(const terminal of ['closed','expired']){
  const [origin,other]=await householdContext('Household replay '+terminal),object=id();
  const createArgs={object_id:object,title:'Synthetic retained doc',content:{kind:'doc',markdown:'base'}};
  const created=await household(origin,'object_create',createArgs);check(created.body.status==='committed','household create positive control');
  const base=created.body.revision;
  const patch=after=>({object_id:object,base,patch:{kind:'doc',splices:[{start:0,before:'base',after}]}});
  check((await household(other,'object_update',patch('winner'))).body.status==='committed','same-base update positive control');
  const conflictId=id(),refusalId=id();
  const conflict=await household(origin,'object_update',patch('loser'),conflictId);
  const refused=await household(origin,'object_create',createArgs,refusalId);
  check(conflict.body.status==='conflict'&&conflict.body.draft_id,'stale revision keeps a draft');
  check(refused.body.status==='refused'&&refused.body.reason==='object_already_exists','recorded household refusal positive control');
  for(const [response,request,tool] of [[conflict,conflictId,'object_update'],[refused,refusalId,'object_create']]){
   const [audit]=await sql('SELECT outcome,reason,context_id,context_details FROM swarm.audit_log WHERE context_id=$1 AND command_kind=$2 AND context_details->>\'command_id\'=$3 ORDER BY occurred_at DESC LIMIT 1',[origin.context_id,tool,request]);
   check(audit&&audit.outcome===core.HOSTED_CONTEXT_AUDIT_MAPPING[response.body.status]&&audit.reason===(response.body.reason??null),'owning handler audit outcome and reason');
   const expected={context_id:origin.context_id,grant_id:g,client_id:'lifecycle-registered-client',owner_user_id:owner,workspace_id:workspace,principal_id:origin.principal_id,assurance:'portable',lifetime:'durable',kind:'chat',command_id:request};
   check(Object.entries(expected).every(([key,value])=>audit.context_details[key]===value),'audit full context attribution');
   const encoded=JSON.stringify(audit);check(!encoded.includes(origin.handle)&&!encoded.includes('Synthetic retained doc')&&!encoded.includes('loser'),'audit contains no handles or content');
  }
  const activeBefore=(await inspect(g,other.handle)).body.last_business_at;
  check((await household(other,'object_update',patch('loser'),conflictId)).body.replayed===true,'active-origin conflict replay positive control');
  check((await household(other,'object_create',createArgs,refusalId)).body.replayed===true,'active-origin refusal replay positive control');
  check((await inspect(g,other.handle)).body.last_business_at===activeBefore,'recorded outcomes do not renew replaying B');
  if(terminal==='closed')await close(g,origin.handle);
  else{
   await sql('ALTER TABLE swarm.hosted_agent_contexts DISABLE TRIGGER hosted_context_guard');
   await sql("UPDATE swarm.hosted_agent_contexts SET created_at=statement_timestamp()-interval '3 days',last_business_at=statement_timestamp()-interval '3 days',idle_expires_at=statement_timestamp()-interval '2 days',absolute_expires_at=statement_timestamp()+interval '27 days' WHERE context_id=$1",[origin.context_id]);
   await sql('ALTER TABLE swarm.hosted_agent_contexts ENABLE TRIGGER hosted_context_guard');
  }
  for(const [tool,args,request] of [['object_update',patch('loser'),conflictId],['object_create',createArgs,refusalId]]){
   const replay=await household(other,tool,args,request);check(replay.status===403&&replay.body.error==='context_'+terminal,'terminal origin fence through live B: '+terminal);
  }
  check((await inspect(g,other.handle)).status===200,'B remains active after fenced replays');
  const [retained]=await sql('SELECT projection FROM swarm.household_object_streams WHERE workspace_id=$1',[workspace]);
  check(retained.projection.objects[object].history.length===2&&retained.projection.drafts[conflict.body.draft_id],'retained history and losing draft survive origin termination');
  const [artifact]=await sql("SELECT state FROM swarm.household_object_artifacts WHERE workspace_id=$1 AND draft_id=$2",[workspace,conflict.body.draft_id]);
  check(artifact?.state==='draft','losing draft artifact retained');
 }
 // Human revocation and sweep share the event projection path. Fold actual
 // stored events with both protocol reducers and compare terminal projections.
 async function expireFixture(target){
  await sql('ALTER TABLE swarm.hosted_agent_contexts DISABLE TRIGGER hosted_context_guard');
  await sql("UPDATE swarm.hosted_agent_contexts SET created_at=statement_timestamp()-interval '3 days',last_business_at=statement_timestamp()-interval '3 days',idle_expires_at=statement_timestamp()-interval '2 days',absolute_expires_at=statement_timestamp()+interval '27 days' WHERE context_id=$1",[target.context_id]);
  await sql('ALTER TABLE swarm.hosted_agent_contexts ENABLE TRIGGER hosted_context_guard');
 }
 const human={userId:owner,email:null,displayName:'Synthetic owner',identityVerified:true,interactiveAuthAtSeconds:null};
 async function revoke(target){return handleHostedManagementCommand(envelope({kind:'revoke_hosted_mcp_seat',grant_id:g,seat_id:target.seat_id}),human);}
 async function assertFold(target){
  const events=await sql('SELECT * FROM swarm.events WHERE stream_id=$1 ORDER BY seq',[stream]);
  let hosted=null,ws=core.reduceWorkspace(null,{type:'WorkspaceCreated',schema_version:1,seq:0,payload:{workspace_id:workspace,name:'Lifecycle fixture',created_by:owner,created_at:0}});
  for(const row of events){
   const event={...row,seq:Number(row.seq),actor:{user:row.actor_user,agent_principal:row.actor_agent_principal,run:row.actor_run},occurred_at_server:ms(row.occurred_at_server)};
   if(['HostedMcpSeatClaimed','HostedMcpSeatRevoked'].includes(row.type))hosted=core.reduceHostedAuthority(hosted,event);
   if(core.WORKSPACE_EVENT_TYPES.includes(row.type))ws=core.reduceWorkspace(ws,event);
  }
  const [stored]=await sql('SELECT s.revoked_at AS seat_revoked,p.revoked_at AS principal_revoked FROM swarm.hosted_mcp_seats s JOIN swarm.agent_principals p USING(principal_id) WHERE s.seat_id=$1',[target.seat_id]);
  check(ms(stored.seat_revoked)===hosted.seats[target.seat_id].revoked_at,'stored seat equals folded seat');
  check(ms(stored.principal_revoked)===hosted.principals[target.principal_id].revoked_at&&ms(stored.principal_revoked)===hosted.seats[target.seat_id].principal_revoked_at&&ms(stored.principal_revoked)===ws.principals[target.principal_id].revoked_at,'stored principal equals both folded projections');
  const handles=await sql('SELECT revoked_at FROM swarm.hosted_mcp_seat_handles WHERE seat_id=$1',[target.seat_id]);
  check(handles.every(row=>ms(row.revoked_at)===hosted.seats[target.seat_id].handle_revoked_at),'stored legacy handles equal folded handle retirement');
  return stored;
 }
 const revoked=(await claim(g)).body;
 await sql('INSERT INTO swarm.hosted_mcp_seat_handles(handle,seat_id,grant_id,workspace_id,principal_id) VALUES($1,$2,$3,$4,$5)', ['seat_'+id().replaceAll('-',''),revoked.seat_id,g,workspace,revoked.principal_id]);
 check((await revoke(revoked)).status===200,'human revocation positive control');
 const beforeRevoked=await assertFold(revoked);await expireFixture(revoked);await sql('SELECT swarm.expire_hosted_agent_contexts(100)');
 const afterRevoked=await assertFold(revoked);check(ms(afterRevoked.principal_revoked)===ms(beforeRevoked.principal_revoked)&&ms(afterRevoked.seat_revoked)===ms(beforeRevoked.seat_revoked),'revoke then sweep never restamps');
 const principalOnly=(await claim(g)).body;
 const principalRevoke=await handleHostedManagementCommand(envelope({kind:'revoke_agent_principal',principal_id:principalOnly.principal_id}),human);
 check(principalRevoke.status===200,'human principal revocation positive control');
 const [principalBefore]=await sql('SELECT revoked_at FROM swarm.agent_principals WHERE principal_id=$1',[principalOnly.principal_id]);
 await expireFixture(principalOnly);await sql('SELECT swarm.expire_hosted_agent_contexts(100)');
 const principalAfter=await assertFold(principalOnly);
 check(ms(principalAfter.principal_revoked)===ms(principalBefore.revoked_at),'principal revocation before sweep never restamps');
 const principalThenSeat=(await claim(g)).body;
 await sql('INSERT INTO swarm.hosted_mcp_seat_handles(handle,seat_id,grant_id,workspace_id,principal_id) VALUES($1,$2,$3,$4,$5)', ['seat_'+id().replaceAll('-',''),principalThenSeat.seat_id,g,workspace,principalThenSeat.principal_id]);
 check((await handleHostedManagementCommand(envelope({kind:'revoke_agent_principal',principal_id:principalThenSeat.principal_id}),human)).status===200,'principal revocation before seat revocation positive control');
 const [terminalT1]=await sql('SELECT revoked_at FROM swarm.agent_principals WHERE principal_id=$1',[principalThenSeat.principal_id]);
 await new Promise(resolve=>setTimeout(resolve,10));
 check((await revoke(principalThenSeat)).status===200,'seat revocation after principal revocation positive control');
 const beforeSweep=await assertFold(principalThenSeat);
 check(ms(beforeSweep.principal_revoked)===ms(terminalT1.revoked_at)&&ms(beforeSweep.seat_revoked)>ms(terminalT1.revoked_at),'before sweep both folds preserve distinct T1 principal and T2 seat terminals');
 await expireFixture(principalThenSeat);await sql('SELECT swarm.expire_hosted_agent_contexts(100)');
 const afterSweep=await assertFold(principalThenSeat);
 check(ms(afterSweep.principal_revoked)===ms(beforeSweep.principal_revoked)&&ms(afterSweep.seat_revoked)===ms(beforeSweep.seat_revoked),'principal then seat revocation then sweep never restamps either terminal');
 const retirementRace=(await claim(g)).body;
 await sql('INSERT INTO swarm.hosted_mcp_seat_handles(handle,seat_id,grant_id,workspace_id,principal_id) VALUES($1,$2,$3,$4,$5)', ['seat_'+id().replaceAll('-',''),retirementRace.seat_id,g,workspace,retirementRace.principal_id]);
 await expireFixture(retirementRace);
 const retirementOutcomes=await Promise.all([revoke(retirementRace),sql('SELECT swarm.expire_hosted_agent_contexts(100)')]);
 check(retirementOutcomes[0].status===200,'human revoke and expiry serialize');await assertFold(retirementRace);

 // Legacy rows preserve historical grant and cursor provenance through succession.
 await sql("INSERT INTO swarm.hosted_mcp_seat_handles(handle,seat_id,grant_id,workspace_id,principal_id,created_at) VALUES($1,$2,$3,$4,$5,statement_timestamp())",['seat_'+id().replaceAll('-',''),b.seat_id,g,workspace,b.principal_id]);
 const successor1=await grant(),successor2=await grant();
 await sql("UPDATE swarm.hosted_mcp_grants SET state='revoked',revoked_at=statement_timestamp() WHERE grant_id=$1",[g]);
 const races=await Promise.all([claim(successor1,{intent:'continue',name:'Shared durable'}),claim(successor2,{intent:'continue',name:'Shared durable'})]);
 check(races.filter(r=>r.status===200).length===1&&races.filter(r=>r.body.error==='identity_resume_unavailable').length===1,'two successors have exactly one winner');
 const winner=races[0].status===200?successor1:successor2;
 check(await cap(g,b.handle,'note')===null,'old grant loses authority');
 check((await inspect(winner,a.handle)).body.error==='context_closed','succession never revives closed A');
 check((await poll(winner,b.handle,liveB.body.batch_id)).status===200,'successor ACK uses context, preserving historical grant');
 const [history]=await sql("SELECT (SELECT grant_id FROM swarm.hosted_mcp_seat_handles WHERE seat_id=$1) AS legacy,(SELECT grant_id FROM swarm.hosted_mcp_check_cursors WHERE seat_id=$1) AS cursor,(SELECT grant_id FROM swarm.hosted_mcp_seats WHERE seat_id=$1) AS current",[b.seat_id]);
 check(history.legacy===g&&history.cursor===g&&history.current===winner,'historical issuance preserved, current seat rebound');
 // Each race admits only work ordered before close. B remains active afterward.
 const fresh=(await claim(winner)).body,c=await cap(winner,fresh.handle,'note');
 const race=await Promise.all([close(winner,fresh.handle),handleHostedCommand(envelope({kind:'post_signal',signal_kind:'note',body:'Synthetic race',to_user_id:null,to_agent_principal_id:null,in_reply_to:null,about:null}),c)]);
 check(race[0].status===200&&(race[1].status===200||race[1].body.error==='context_closed'),'close vs mutation is serial');
 for(const route of ['read','ack']){
  const target=(await claim(winner)).body;
  const targetCap=await cap(winner,target.handle,route==='read'?'whoami':'check',route==='read'?'read':'command');
  let request;
  if(route==='ack'){
   const sender=await cap(winner,b.handle,'ask');
   const sent=await handleHostedCommand(envelope({kind:'post_signal',signal_kind:'ask',body:'Synthetic ACK race',to_user_id:null,to_agent_principal_id:target.principal_id,in_reply_to:null,about:null}),sender);check(sent.status===200,'ACK race signal positive control');
   const batch=await poll(winner,target.handle);check(batch.body.batch_id,'ACK race batch positive control');
   request=()=>handleHostedCommand(envelope({kind:'ack_hosted_mcp_check_batch',seat:target.handle,ack:batch.body.batch_id}),targetCap);
  }else request=()=>handleHostedRead({resource:'whoami',workspace_id:workspace},targetCap);
  const outcomes=await Promise.all([close(winner,target.handle),request()]);
  check(outcomes[0].status===200&&(outcomes[1].status===200||outcomes[1].body.error==='context_closed'),'close vs '+route+' serialized');
  check((await inspect(winner,target.handle)).body.error==='context_closed','race context stays closed');
 }
 check((await inspect(winner,b.handle)).status===200,'durable B still authorized');
 check(await cap(winner,b.handle,'note','command',false)===null,'provider revocation negative control');
 console.log('SID_LIFECYCLE_OK '+JSON.stringify({assertions}));
}catch(_error){console.log('SID_LIFECYCLE_FAILED '+JSON.stringify({assertions}));Deno.exitCode=1;}finally{await db.end();}
`;
test('real hosted lifecycle: clocks, ACK ownership, shared work, close and succession races',{timeout:240_000},async()=>{
 const local=JSON.parse(execFileSync('supabase',['status','-o','json'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}));
 for(const target of [local.API_URL,local.DB_URL])assert.ok(['127.0.0.1','localhost','[::1]'].includes(new URL(target).hostname));
 const isolated=await adminEdgeDatabase(local.DB_URL);
 const directory=mkdtempSync(join(process.platform==='darwin'?'/private/tmp':tmpdir(),'anvil-secret.'));chmodSync(directory,0o700);
 const owner=randomUUID();
 try{
  await isolated.db`INSERT INTO auth.users(id,aud,role,email) VALUES(${owner}::uuid,'authenticated','authenticated',${owner+'@example.test'})`;
  await isolated.db`INSERT INTO swarm.users(user_id,display_name) VALUES(${owner}::uuid,'Lifecycle fixture')`;
  const source=harness.replaceAll('COMMAND_URL',JSON.stringify(commandUrl)).replace('READ_URL',JSON.stringify(readUrl)).replace('AUTH_URL',JSON.stringify(authUrl));
  const path=join(directory,'harness.mjs');writeFileSync(path,source,{mode:0o600});
  const run=spawnSync('deno',['run','--no-lock','--config','supabase/functions/command/deno.json','--allow-read','--allow-env','--allow-net',path],{encoding:'utf8',timeout:210_000,input:JSON.stringify({owner,local:{...local,DB_URL:isolated.url}})});
  assert.equal(run.status,0,'lifecycle fixture failed; credential-bearing output withheld');
  const receipt=run.stdout.split(/\r?\n/u).find(line=>line.startsWith('SID_LIFECYCLE_OK '));assert.ok(receipt);console.log(receipt);
 }finally{await isolated.close();}
 // Contains no credentials: configuration was supplied only through stdin.
 // Retain the task-owned script directory for CI diagnostics; no deletion bypass.
});
