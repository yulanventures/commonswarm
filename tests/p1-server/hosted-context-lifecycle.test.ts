/** Phase-3 SQL/catalog and real edge proofs. CI only; uses the isolated-stack harness. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { adminEdgeDatabase } from '../support/admin-edge-database.js';
import { dbAssert, repoSql, runSql } from '../support/admin-schema-db.js';
import { sqlPhase } from '../support/admin-schema-process.js';
const proof='deploy/release-proofs/session-identity/20261006000004-';
function fixtureAssert(expression:string,label:string) {
  return sqlPhase(label,dbAssert(expression,label));
}
function catalog(path:string,expected:boolean,label:string) {
  const alias=path.endsWith('before-catalog.sql')?'before_ok':path.endsWith('rollback-catalog.sql')?'rollback_ok':'catalog_ok';
  return sqlPhase(label,repoSql(path)+`\nSELECT :'${alias}'::boolean=${expected} AS lifecycle_proof\n\\gset\n\\if :lifecycle_proof\n\\else\nDO $fail$ BEGIN RAISE EXCEPTION '${label}'; END $fail$;\n\\endif\n`);
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
  runSql(`INSERT INTO swarm.config(key,value) VALUES('hosted_context_allocation_enabled','false');\n${reserve}\n${catalog(proof+'before-catalog.sql',true,'sid7-catalog-01')}\n${up}\n${catalog(proof+'catalog.sql',true,'sid7-catalog-02')}\n${helper.replace("g.state='active'","g.state='pending'")}\n${catalog(proof+'catalog.sql',false,'sid7-catalog-03')}\n${helper}\n${catalog(proof+'catalog.sql',true,'sid7-catalog-04')}\n${repoSql(proof+'functional.sql')}\n${reserve}\n${catalog(proof+'rollback-catalog.sql',true,'sid7-catalog-05')}\n${catalog(proof+'catalog.sql',false,'sid7-catalog-06')}`);
});
// The owning rollback boundary must work after the real migration backfill.
// Each refusal first runs and unwinds a successful rollback in the same fixture.
function reserveFixture() {
  const owner=randomUUID(),workspace=randomUUID(),stream=randomUUID(),grant=randomUUID();
  const principals=[randomUUID(),randomUUID(),randomUUID()],seats=[randomUUID(),randomUUID(),randomUUID()];
  const seat=seats[0]!;
  const handles=[randomUUID(),randomUUID(),randomUUID()].map(id=>'seat_'+id.replaceAll('-',''));
  const setup=`
INSERT INTO auth.users(id,aud,role,email) VALUES('${owner}','authenticated','authenticated','${owner}@example.test');
INSERT INTO swarm.users(user_id,display_name) VALUES('${owner}','Reserve fixture');
INSERT INTO swarm.workspaces(workspace_id,name,created_by) VALUES('${workspace}','Reserve fixture','${owner}');
INSERT INTO swarm.memberships(workspace_id,user_id,role) VALUES('${workspace}','${owner}','owner');
INSERT INTO swarm.streams(stream_id,workspace_id,kind) VALUES('${stream}','${workspace}','workspace');
INSERT INTO swarm.hosted_mcp_grants(grant_id,provider_grant_id,owner_user_id,home_workspace_id,client_id,resource,selected_workspace_ids,manifest_digest,interaction_ref,state,created_at,activated_at)
  VALUES('${grant}','reserve-${grant}','${owner}','${workspace}','reserve-client','https://mcp.commonswarm.com/mcp',ARRAY['${workspace}']::uuid[],decode(repeat('a',64),'hex'),'reserve-fixture','active',statement_timestamp(),statement_timestamp());
INSERT INTO swarm.hosted_mcp_grant_workspaces(grant_id,workspace_id,owner_user_id,manifest_digest,consent_receipt_id,consented_at)
  VALUES('${grant}','${workspace}','${owner}',decode(repeat('a',64),'hex'),'${randomUUID()}',statement_timestamp());
INSERT INTO swarm.agent_principals(principal_id,workspace_id,owner_user_id,name,transport,turn_only)
  VALUES ${principals.map((principal,i)=>`('${principal}','${workspace}','${owner}','Reserve agent ${i}','hosted_mcp',true)`).join(',')};
INSERT INTO swarm.hosted_mcp_seats(seat_id,grant_id,workspace_id,owner_user_id,principal_id,name,created_at)
  VALUES ${seats.map((id,i)=>`('${id}','${grant}','${workspace}','${owner}','${principals[i]}','Reserve agent ${i}',statement_timestamp())`).join(',')};
INSERT INTO swarm.hosted_mcp_seat_handles(handle,seat_id,grant_id,workspace_id,principal_id,created_at,revoked_at)
  VALUES ${handles.map((handle,i)=>`('${handle}','${seats[i]}','${grant}','${workspace}','${principals[i]}',statement_timestamp(),${i===2?'statement_timestamp()':'NULL'})`).join(',')};
CREATE TEMP TABLE reserve_original_handles AS SELECT * FROM swarm.hosted_mcp_seat_handles;
`;
  const preserved=fixtureAssert(`NOT EXISTS ((SELECT * FROM reserve_original_handles EXCEPT SELECT * FROM swarm.hosted_mcp_seat_handles)
    UNION ALL (SELECT * FROM swarm.hosted_mcp_seat_handles EXCEPT SELECT * FROM reserve_original_handles))`,'sid7-handle-ledger');
  const oldAccess=handles.map((handle,i)=>fixtureAssert(`
    (SELECT count(*) FROM swarm.resolve_hosted_seat_command_authorization('${grant}','${handle}','note'))=${i===2?0:1}
    AND (SELECT count(*) FROM swarm.resolve_hosted_seat_read_authorization('${grant}','${handle}','whoami'))=${i===2?0:1}
    AND (SELECT count(*) FROM swarm.resolve_hosted_mcp_check_authorization('${grant}','${handle}'))=${i===2?0:1}`,
    `sid7-handle-access-${i}`)).join('\n');
  return {grant,workspace,stream,seat,handles,setup,preserved,oldAccess};
}
for(const scenario of ['backfill','closed-live','non-legacy','parent','receipt','household-outcome','denial-audit'] as const) {
  test(`reserve rollback after legacy backfill: ${scenario}`,()=>{
    const f=reserveFixture(),reserve=repoSql(proof+'rollback.sql');
    const up=repoSql('supabase/migrations/20261006000004_hosted_context_lifecycle.sql');
    const context=`(SELECT context_id FROM swarm.hosted_agent_contexts WHERE handle='${f.handles[0]}')`;
    const mutations={
      'closed-live':`SELECT swarm.close_hosted_agent_context(${context},'closed');`,
      'non-legacy':`INSERT INTO swarm.hosted_agent_contexts(context_id,handle,seat_id,kind,created_at,last_business_at,idle_expires_at,absolute_expires_at,origin)
        VALUES('${randomUUID()}','seat_${randomUUID().replaceAll('-','')}','${f.seat}','chat',statement_timestamp(),statement_timestamp(),statement_timestamp()+interval '1 day',statement_timestamp()+interval '30 days','new');`,
      parent:`ALTER TABLE swarm.hosted_agent_contexts DISABLE TRIGGER hosted_context_guard;
        UPDATE swarm.hosted_agent_contexts SET parent_context=${context} WHERE handle='${f.handles[1]}';
        ALTER TABLE swarm.hosted_agent_contexts ENABLE TRIGGER hosted_context_guard;`,
      receipt:`INSERT INTO swarm.idempotency_keys(principal_kind,principal_id,command_id,workspace_id,stream_id,request_hash,response,context_id)
        VALUES('hosted_grant','${f.grant}','reserve_receipt','${f.workspace}','${f.stream}',repeat('0',64),'{}',${context});`,
      'household-outcome':`INSERT INTO swarm.idempotency_keys(principal_kind,principal_id,command_id,workspace_id,stream_id,request_hash,response)
        VALUES('hosted_grant','${f.grant}','reserve_household','${f.workspace}','${f.stream}',repeat('0',64),jsonb_build_object('value',jsonb_build_object('context_id',${context})));`,
      'denial-audit':`SELECT swarm.audit_hosted_authorization_denial('${f.grant}','reserve-${f.grant}','note');`,
    };
    const reason=scenario==='closed-live'?'hosted context access would reopen'
      :scenario==='non-legacy'||scenario==='parent'?'hosted context identity':'hosted context history';
    const denial=scenario==='backfill'?'':`
${mutations[scenario]}
CREATE TEMP TABLE reserve_candidate_contexts AS SELECT * FROM swarm.hosted_agent_contexts;
DO $deny$ BEGIN BEGIN
  EXECUTE $rollback$${reserve}$rollback$;
  RAISE EXCEPTION 'sid7-occupied-reserve-admitted' USING ERRCODE='ZX001';
EXCEPTION WHEN SQLSTATE '55000' THEN
  IF SQLERRM<>'reserve rollback refused: ${reason}' THEN
    RAISE EXCEPTION 'sid7-reserve-refusal-reason' USING ERRCODE='ZX002';
  END IF;
END; END $deny$;
${catalog(proof+'catalog.sql',true,'sid7-catalog-07')}
${f.preserved}
${fixtureAssert(`NOT EXISTS ((SELECT * FROM reserve_candidate_contexts EXCEPT SELECT * FROM swarm.hosted_agent_contexts)
  UNION ALL (SELECT * FROM swarm.hosted_agent_contexts EXCEPT SELECT * FROM reserve_candidate_contexts))`,'sid7-refused-contexts')}
`;
    runSql(`INSERT INTO swarm.config(key,value) VALUES('hosted_context_allocation_enabled','false');
${reserve}
${f.setup}
${catalog(proof+'before-catalog.sql',true,'sid7-catalog-08')}
${f.oldAccess}
${up}
${fixtureAssert('SELECT count(*)=3 FROM swarm.hosted_agent_contexts','sid7-backfill-count')}
UPDATE swarm.hosted_agent_contexts SET last_business_at=clock_timestamp();
${fixtureAssert('SELECT bool_and(last_business_at>created_at) FROM swarm.hosted_agent_contexts','sid7-activity')}
${catalog(proof+'catalog.sql',true,'sid7-catalog-09')}
SAVEPOINT derived_positive;
${reserve}
${catalog(proof+'rollback-catalog.sql',true,'sid7-catalog-10')}
${catalog(proof+'catalog.sql',false,'sid7-catalog-11')}
${fixtureAssert('NOT EXISTS(SELECT 1 FROM swarm.hosted_agent_contexts)','sid7-derived-contexts')}
${f.preserved}
${f.oldAccess}
ROLLBACK TO SAVEPOINT derived_positive;
${denial}`);
  });
}
const commandUrl=new URL('../../supabase/functions/command/index.ts',import.meta.url).href;
const readUrl=new URL('../../supabase/functions/read/index.ts',import.meta.url).href;
const authUrl=new URL('../../supabase/functions/_shared/hosted-seat-auth.ts',import.meta.url).href;
// Finite checkpoint IDs identify assertion/query sites; no SQL, values or raw errors leave the child.
const lifecycleCheckpointCounts = {check:70,sql:38};
const lifecycleCheckpoints = new Set(['sid7-setup', ...Object.entries(lifecycleCheckpointCounts)
  .flatMap(([kind,count])=>Array.from({length:count},(_,i)=>'sid7-'+kind+'-'+String(i+1).padStart(3,'0')))]);
const lifecycleSqlstates = new Set(['23502','23503','23505','23514','42501','55000','SC001','SC002',
  '40P01','40001','57014','42P01','42703','42704','42883','42601','25P02','P0001','08006','53300']);
function lifecycleFailureReceipt(path:string):string {
  if(!existsSync(path))return 'receipt-missing';
  try {
    const text=readFileSync(path,'utf8');
    if(text.length>256)return 'receipt-invalid';
    const receipt:unknown=JSON.parse(text);
    if(typeof receipt!=='object'||receipt===null)return 'receipt-invalid';
    const data=receipt as Record<string,unknown>;
    if(Object.keys(data).sort().join(',')!=='checkpoint,sqlstate'
      ||typeof data.checkpoint!=='string'||!lifecycleCheckpoints.has(data.checkpoint)
      ||!(data.sqlstate===null||(typeof data.sqlstate==='string'&&lifecycleSqlstates.has(data.sqlstate))))return 'receipt-invalid';
    return 'checkpoint='+data.checkpoint+' sqlstate='+(data.sqlstate??'none');
  }catch{return 'receipt-invalid';}
}
const harness=String.raw`
const config=JSON.parse(await new Response(Deno.stdin.readable).text());
Deno.env.set('SWARM_ENV','test');Deno.env.set('SWARM_DATABASE_URL',config.local.DB_URL);
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY',config.local.SERVICE_ROLE_KEY);
Deno.env.set('SUPABASE_URL',config.local.API_URL);Deno.env.set('SUPABASE_ANON_KEY',config.local.ANON_KEY);
const {db,handleHostedCommand,handleHostedManagementCommand}=await import(COMMAND_URL);
const {handleHostedRead}=await import(READ_URL);
const {authenticateHostedGrantCapability,authenticateHostedSeatCapability}=await import(AUTH_URL);
const core=await import(new URL('../_shared/protocol.js',COMMAND_URL).href);
const id=()=>crypto.randomUUID();const ms=value=>new Date(value).getTime();let assertions=0,lastCheckpoint='sid7-setup',failedCheckpoint=null;
const check=(value,label,checkpoint)=>{assertions++;lastCheckpoint=checkpoint;if(!value)throw new Error(checkpoint);};
const sql=async(text,parameters,checkpoint)=>{
 lastCheckpoint=checkpoint;
 try{return await db.unsafe(text,parameters);}catch(error){failedCheckpoint=checkpoint;throw error;}
};
const owner=config.owner,workspace=id(),stream=id();
async function grant(client='lifecycle-registered-client'){
 const g=id();await sql("INSERT INTO swarm.hosted_mcp_grants(grant_id,provider_grant_id,owner_user_id,home_workspace_id,client_id,resource,selected_workspace_ids,manifest_digest,interaction_ref,state,created_at,activated_at) VALUES($1::uuid,'provider-'||$1::text,$2::uuid,$3::uuid,$4,'https://mcp.commonswarm.com/mcp',ARRAY[$3::uuid],decode(repeat('00',32),'hex'),'fixture','active',statement_timestamp(),statement_timestamp())",[g,owner,workspace,client], "sid7-sql-001");
 await sql("INSERT INTO swarm.hosted_mcp_grant_workspaces(grant_id,workspace_id,owner_user_id,manifest_digest,consent_receipt_id,consented_at) VALUES($1::uuid,$2::uuid,$3::uuid,decode(repeat('00',32),'hex'),$4::uuid,statement_timestamp())",[g,workspace,owner,id()], "sid7-sql-002");return g;
}
async function claim(g,args={},request=id()){
 const cap=await db.begin(tx=>authenticateHostedGrantCapability(tx,{grantId:g,ownerUserId:owner,providerGrantId:'provider-'+g,workspaceId:workspace,tool:'claim_hosted_seat',providerStatus:async()=>({active:true})}));
 check(cap!==null,'claim positive authorization', "sid7-check-001");return handleHostedCommand({command_id:request,client_version:'0.1.80',workspace_id:workspace,stream:{kind:'workspace'},command:{kind:'claim_hosted_seat',...args}},cap);
}
async function cap(g,handle,tool,use='command',active=true){return db.begin(tx=>authenticateHostedSeatCapability(tx,{grantId:g,providerGrantId:'provider-'+g,handle,tool,providerStatus:async()=>({active})},use));}
const envelope=(command,request=id())=>({command_id:request,client_version:'0.1.80',workspace_id:workspace,stream:{kind:'workspace'},command});
async function close(g,handle,request=id()){const c=await cap(g,handle,'close_session');check(c!==null,'close positive authority', "sid7-check-002");return handleHostedCommand(envelope({kind:'close_hosted_session',seat:handle},request),c);}
async function inspect(g,handle){const c=await cap(g,handle,'whoami','read');if(!c)return {body:{error:'identity_resume_unavailable'}};return handleHostedRead({resource:'whoami',workspace_id:workspace},c);}
async function poll(g,handle,ack){const c=await cap(g,handle,'check');check(c!==null,'check positive authority', "sid7-check-003");return handleHostedCommand(envelope({kind:ack?'ack_hosted_mcp_check_batch':'open_hosted_mcp_check_batch',seat:handle,...(ack?{ack}:{})}),c);}
try{
 await sql("INSERT INTO swarm.workspaces(workspace_id,name,created_by) VALUES($1,'Lifecycle fixture',$2)",[workspace,owner], "sid7-sql-003");
 await sql("INSERT INTO swarm.memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')",[workspace,owner], "sid7-sql-004");
 await sql("INSERT INTO swarm.streams(stream_id,workspace_id,kind) VALUES($1,$2,'workspace')",[stream,workspace], "sid7-sql-005");
 await sql("INSERT INTO swarm.config(key,value) VALUES('hosted_context_allocation_enabled','true'),('min_client_version','\"0.1.0\"') ON CONFLICT(key) DO UPDATE SET value=excluded.value",[], "sid7-sql-006");
 const g=await grant(),a=(await claim(g,{name:'Shared durable',lifetime:'durable'})).body;
 const b=(await claim(g,{intent:'continue',name:'Shared durable'})).body;
 check(a.context_id!==b.context_id&&a.principal_id===b.principal_id,'fresh contexts share durable principal', "sid7-check-004");
 const before=await inspect(g,a.handle);check(before.status===200&&before.body.context_id===a.context_id,'selected identity complete', "sid7-check-005");
 const polling=await poll(g,a.handle);check(polling.status===200,'no-ACK poll accepted', "sid7-check-006");
 check((await inspect(g,a.handle)).body.last_business_at===before.body.last_business_at,'inspection and poll do not renew', "sid7-check-007");
 // Business mutation is real; replay renews neither activity nor events.
 const noteCap=await cap(g,a.handle,'note'),noteRequest=id();
 const note=envelope({kind:'post_signal',signal_kind:'note',body:'Synthetic retained work',to_user_id:null,to_agent_principal_id:null,in_reply_to:null,about:null},noteRequest);
 const posted=await handleHostedCommand(note,noteCap);check(posted.status===200&&posted.body.status==='accepted','real business mutation positive control', "sid7-check-008");
 const afterNote=await inspect(g,a.handle);check(afterNote.body.last_business_at>=before.body.last_business_at,'accepted mutation activity', "sid7-check-009");
 check((await handleHostedCommand(note,noteCap)).body.replayed===true,'mutation exact replay', "sid7-check-010");
 check((await inspect(g,a.handle)).body.last_business_at===afterNote.body.last_business_at,'replay never renews', "sid7-check-011");
 // A and B receive the same directed signal but own distinct batches.
 const askCap=await cap(g,b.handle,'ask');
 const asked=await handleHostedCommand(envelope({kind:'post_signal',signal_kind:'ask',body:'Synthetic directed signal',to_user_id:null,to_agent_principal_id:a.principal_id,in_reply_to:null,about:null}),askCap);
 check(asked.status===200&&asked.body.status==='accepted','directed message committed', "sid7-check-012");
 const pa=await poll(g,a.handle),pb=await poll(g,b.handle);
 check(pa.body.batch_id&&pb.body.batch_id&&pa.body.batch_id!==pb.body.batch_id,'one batch per context on shared inbox', "sid7-check-013");
 check((await poll(g,b.handle,pa.body.batch_id)).body.error==='hosted_check_batch_forbidden','B cannot ACK A', "sid7-check-014");
 check((await poll(g,b.handle,pb.body.batch_id)).status===200,'same-route B ACK positive control', "sid7-check-015");
 const afterAck=await inspect(g,b.handle);await poll(g,b.handle,pb.body.batch_id);
 check((await inspect(g,b.handle)).body.last_business_at===afterAck.body.last_business_at,'repeated ACK never renews', "sid7-check-016");
 const nextAsk=await handleHostedCommand(envelope({kind:'post_signal',signal_kind:'ask',body:'Synthetic next batch',to_user_id:null,to_agent_principal_id:b.principal_id,in_reply_to:null,about:null}),askCap);
 check(nextAsk.status===200,'next shared signal positive control', "sid7-check-017");
 const liveB=await poll(g,b.handle);check(liveB.body.batch_id,'B has an open batch before A close', "sid7-check-018");
 const closeId=id(),closed=await close(g,a.handle,closeId);check(closed.body.principal_state==='retained','durable retained', "sid7-check-019");
 const retry=await close(g,a.handle,closeId),again=await close(g,a.handle);
 check(retry.body.outcome==='replayed'&&again.body.outcome==='closed'&&again.body.closed_at===closed.body.closed_at,'close exact and distinct retries preserve time', "sid7-check-020");
 check((await inspect(g,a.handle)).body.error==='context_closed','A terminal', "sid7-check-021");check((await inspect(g,b.handle)).status===200,'B survives A close', "sid7-check-022");check((await poll(g,b.handle)).body.batch_id===liveB.body.batch_id,'B open batch survives A close', "sid7-check-023");
 const [rows]=await sql("SELECT (SELECT count(*) FROM swarm.signals WHERE workspace_id=$1) AS committed,(SELECT count(*) FROM swarm.hosted_mcp_check_batches WHERE context_id=$2 AND cancelled_at IS NOT NULL) AS cancelled",[workspace,a.context_id], "sid7-sql-007");
 check(Number(rows.committed)>=2&&Number(rows.cancelled)===1,'committed shared work and A cancellation retained', "sid7-check-024");
 // Stopped sweep cannot prolong access. Create already-expired fixtures directly
 // with real clocks; the production handler remains free of shortened test TTLs.
 const expired=(await claim(g)).body;
 await sql("ALTER TABLE swarm.hosted_agent_contexts DISABLE TRIGGER hosted_context_guard",[], "sid7-sql-008");
 await sql("UPDATE swarm.hosted_agent_contexts SET created_at=statement_timestamp()-interval '3 days',last_business_at=statement_timestamp()-interval '3 days',idle_expires_at=statement_timestamp()-interval '2 days',absolute_expires_at=statement_timestamp()+interval '27 days' WHERE context_id=$1",[expired.context_id], "sid7-sql-009");
 await sql("ALTER TABLE swarm.hosted_agent_contexts ENABLE TRIGGER hosted_context_guard",[], "sid7-sql-010");
 check((await inspect(g,expired.handle)).body.error==='context_expired','deadline enforced before sweep', "sid7-check-025");
 await sql('SELECT swarm.expire_hosted_agent_contexts(100)',[], "sid7-sql-011");
 check((await inspect(g,expired.handle)).body.error==='context_expired','swept own context still returns expiry', "sid7-check-026");
 check((await close(g,expired.handle)).body.principal_state==='retired','close authorized after expiry', "sid7-check-027");

 // Real household handler proofs: caller namespaces, all recorded outcomes,
 // original-context replay fences, activity and content-free context audits.
 await sql("INSERT INTO swarm.household_workspace_boundaries(workspace_id,purpose) VALUES($1,'shared')",[workspace], "sid7-sql-012");
 await sql("INSERT INTO swarm.household_member_content_roles(workspace_id,user_id,content_role,content_consent_id,confirmed_at) VALUES($1,$2,'editor',$3,clock_timestamp())",[workspace,owner,id()], "sid7-sql-013");
 async function householdContext(name){
  const qa=(await claim(g,{name,lifetime:'durable'})).body,qb=(await claim(g,{intent:'continue',name})).body;
  await sql("INSERT INTO swarm.household_content_connections(connection_id,grant_id,workspace_id,principal_id,owner_user_id,purpose,operations,consent_receipt_id,hosted_grant_id) VALUES($1,$2,$3,$4,$5,'shared',ARRAY['read','create','update'],$6,$2)",[qa.seat_id,g,workspace,qa.principal_id,owner,id()], "sid7-sql-014");
  return [qa,qb];
 }
 async function household(context,tool,args,request=id()){
  const capability=await cap(g,context.handle,tool);check(capability!==null,'household same-route authority positive control', "sid7-check-028");
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
   const result=await call();check(result.status===200&&['committed','accepted'].includes(result.body.status),'independent household and signal receipts in '+order, "sid7-check-029");
   check(ms((await inspect(g,qa.handle)).body.last_business_at)>ms(before),'each fresh call renews in '+order, "sid7-check-030");
  }
  check((await household(qa,'object_create',args,request)).body.replayed===true,'household exact positive replay', "sid7-check-031");
  check((await signal(qa,'ctx_'+request)).body.replayed===true,'signal exact positive replay', "sid7-check-032");
 }
 for(const terminal of ['closed','expired']){
  const [origin,other]=await householdContext('Household replay '+terminal),object=id();
  const createArgs={object_id:object,title:'Synthetic retained doc',content:{kind:'doc',markdown:'base'}};
  const created=await household(origin,'object_create',createArgs);check(created.body.status==='committed','household create positive control', "sid7-check-033");
  const base=created.body.revision;
  const patch=after=>({object_id:object,base,patch:{kind:'doc',splices:[{start:0,before:'base',after}]}});
  check((await household(other,'object_update',patch('winner'))).body.status==='committed','same-base update positive control', "sid7-check-034");
  const conflictId=id(),refusalId=id();
  const conflict=await household(origin,'object_update',patch('loser'),conflictId);
  const refused=await household(origin,'object_create',createArgs,refusalId);
  check(conflict.body.status==='conflict'&&conflict.body.draft_id,'stale revision keeps a draft', "sid7-check-035");
  check(refused.body.status==='refused'&&refused.body.reason==='object_already_exists','recorded household refusal positive control', "sid7-check-036");
  for(const [response,request,tool] of [[conflict,conflictId,'object_update'],[refused,refusalId,'object_create']]){
   const [audit]=await sql('SELECT outcome,reason,context_id,context_details FROM swarm.audit_log WHERE context_id=$1 AND command_kind=$2 AND context_details->>\'command_id\'=$3 ORDER BY occurred_at DESC LIMIT 1',[origin.context_id,tool,request], "sid7-sql-015");
   check(audit&&audit.outcome===core.HOSTED_CONTEXT_AUDIT_MAPPING[response.body.status]&&audit.reason===(response.body.reason??null),'owning handler audit outcome and reason', "sid7-check-037");
   const expected={context_id:origin.context_id,grant_id:g,client_id:'lifecycle-registered-client',owner_user_id:owner,workspace_id:workspace,principal_id:origin.principal_id,assurance:'portable',lifetime:'durable',kind:'chat',command_id:request};
   check(Object.entries(expected).every(([key,value])=>audit.context_details[key]===value),'audit full context attribution', "sid7-check-038");
   const encoded=JSON.stringify(audit);check(!encoded.includes(origin.handle)&&!encoded.includes('Synthetic retained doc')&&!encoded.includes('loser'),'audit contains no handles or content', "sid7-check-039");
  }
  const activeBefore=(await inspect(g,other.handle)).body.last_business_at;
  check((await household(other,'object_update',patch('loser'),conflictId)).body.replayed===true,'active-origin conflict replay positive control', "sid7-check-040");
  check((await household(other,'object_create',createArgs,refusalId)).body.replayed===true,'active-origin refusal replay positive control', "sid7-check-041");
  check((await inspect(g,other.handle)).body.last_business_at===activeBefore,'recorded outcomes do not renew replaying B', "sid7-check-042");
  if(terminal==='closed')await close(g,origin.handle);
  else{
   await sql('ALTER TABLE swarm.hosted_agent_contexts DISABLE TRIGGER hosted_context_guard',[], "sid7-sql-016");
   await sql("UPDATE swarm.hosted_agent_contexts SET created_at=statement_timestamp()-interval '3 days',last_business_at=statement_timestamp()-interval '3 days',idle_expires_at=statement_timestamp()-interval '2 days',absolute_expires_at=statement_timestamp()+interval '27 days' WHERE context_id=$1",[origin.context_id], "sid7-sql-017");
   await sql('ALTER TABLE swarm.hosted_agent_contexts ENABLE TRIGGER hosted_context_guard',[], "sid7-sql-018");
  }
  for(const [tool,args,request] of [['object_update',patch('loser'),conflictId],['object_create',createArgs,refusalId]]){
   const replay=await household(other,tool,args,request);check(replay.status===403&&replay.body.error==='context_'+terminal,'terminal origin fence through live B: '+terminal, "sid7-check-043");
  }
  check((await inspect(g,other.handle)).status===200,'B remains active after fenced replays', "sid7-check-044");
  const [retained]=await sql('SELECT projection FROM swarm.household_object_streams WHERE workspace_id=$1',[workspace], "sid7-sql-019");
  check(retained.projection.objects[object].history.length===2&&retained.projection.drafts[conflict.body.draft_id],'retained history and losing draft survive origin termination', "sid7-check-045");
  const [artifact]=await sql("SELECT state FROM swarm.household_object_artifacts WHERE workspace_id=$1 AND draft_id=$2",[workspace,conflict.body.draft_id], "sid7-sql-020");
  check(artifact?.state==='draft','losing draft artifact retained', "sid7-check-046");
 }
 // Human revocation and sweep share the event projection path. Fold actual
 // stored events with both protocol reducers and compare terminal projections.
 async function expireFixture(target){
  await sql('ALTER TABLE swarm.hosted_agent_contexts DISABLE TRIGGER hosted_context_guard',[], "sid7-sql-021");
  await sql("UPDATE swarm.hosted_agent_contexts SET created_at=statement_timestamp()-interval '3 days',last_business_at=statement_timestamp()-interval '3 days',idle_expires_at=statement_timestamp()-interval '2 days',absolute_expires_at=statement_timestamp()+interval '27 days' WHERE context_id=$1",[target.context_id], "sid7-sql-022");
  await sql('ALTER TABLE swarm.hosted_agent_contexts ENABLE TRIGGER hosted_context_guard',[], "sid7-sql-023");
 }
 const human={userId:owner,email:null,displayName:'Synthetic owner',identityVerified:true,interactiveAuthAtSeconds:null};
 async function revoke(target){return handleHostedManagementCommand(envelope({kind:'revoke_hosted_mcp_seat',grant_id:g,seat_id:target.seat_id}),human);}
 async function assertFold(target){
  const events=await sql('SELECT * FROM swarm.events WHERE stream_id=$1 ORDER BY seq',[stream], "sid7-sql-024");
  let hosted=null,ws=core.reduceWorkspace(null,{type:'WorkspaceCreated',schema_version:1,seq:0,payload:{workspace_id:workspace,name:'Lifecycle fixture',created_by:owner,created_at:0}});
  for(const row of events){
   const event={...row,seq:Number(row.seq),actor:{user:row.actor_user,agent_principal:row.actor_agent_principal,run:row.actor_run},occurred_at_server:ms(row.occurred_at_server)};
   if(['HostedMcpSeatClaimed','HostedMcpSeatRevoked'].includes(row.type))hosted=core.reduceHostedAuthority(hosted,event);
   if(core.WORKSPACE_EVENT_TYPES.includes(row.type))ws=core.reduceWorkspace(ws,event);
  }
  const [stored]=await sql('SELECT s.revoked_at AS seat_revoked,p.revoked_at AS principal_revoked FROM swarm.hosted_mcp_seats s JOIN swarm.agent_principals p USING(principal_id) WHERE s.seat_id=$1',[target.seat_id], "sid7-sql-025");
  check(ms(stored.seat_revoked)===hosted.seats[target.seat_id].revoked_at,'stored seat equals folded seat', "sid7-check-047");
  check(ms(stored.principal_revoked)===hosted.principals[target.principal_id].revoked_at&&ms(stored.principal_revoked)===hosted.seats[target.seat_id].principal_revoked_at&&ms(stored.principal_revoked)===ws.principals[target.principal_id].revoked_at,'stored principal equals both folded projections', "sid7-check-048");
  const handles=await sql('SELECT revoked_at FROM swarm.hosted_mcp_seat_handles WHERE seat_id=$1',[target.seat_id], "sid7-sql-026");
  check(handles.every(row=>ms(row.revoked_at)===hosted.seats[target.seat_id].handle_revoked_at),'stored legacy handles equal folded handle retirement', "sid7-check-049");
  return stored;
 }
 const revoked=(await claim(g)).body;
 await sql('INSERT INTO swarm.hosted_mcp_seat_handles(handle,seat_id,grant_id,workspace_id,principal_id,created_at) VALUES($1,$2,$3,$4,$5,statement_timestamp())', ['seat_'+id().replaceAll('-',''),revoked.seat_id,g,workspace,revoked.principal_id], "sid7-sql-027");
 check((await revoke(revoked)).status===200,'human revocation positive control', "sid7-check-050");
 const beforeRevoked=await assertFold(revoked);await expireFixture(revoked);await sql('SELECT swarm.expire_hosted_agent_contexts(100)',[], "sid7-sql-028");
 const afterRevoked=await assertFold(revoked);check(ms(afterRevoked.principal_revoked)===ms(beforeRevoked.principal_revoked)&&ms(afterRevoked.seat_revoked)===ms(beforeRevoked.seat_revoked),'revoke then sweep never restamps', "sid7-check-051");
 const principalOnly=(await claim(g)).body;
 const principalRevoke=await handleHostedManagementCommand(envelope({kind:'revoke_agent_principal',principal_id:principalOnly.principal_id}),human);
 check(principalRevoke.status===200,'human principal revocation positive control', "sid7-check-052");
 const [principalBefore]=await sql('SELECT revoked_at FROM swarm.agent_principals WHERE principal_id=$1',[principalOnly.principal_id], "sid7-sql-029");
 await expireFixture(principalOnly);await sql('SELECT swarm.expire_hosted_agent_contexts(100)',[], "sid7-sql-030");
 const principalAfter=await assertFold(principalOnly);
 check(ms(principalAfter.principal_revoked)===ms(principalBefore.revoked_at),'principal revocation before sweep never restamps', "sid7-check-053");
 const principalThenSeat=(await claim(g)).body;
 await sql('INSERT INTO swarm.hosted_mcp_seat_handles(handle,seat_id,grant_id,workspace_id,principal_id,created_at) VALUES($1,$2,$3,$4,$5,statement_timestamp())', ['seat_'+id().replaceAll('-',''),principalThenSeat.seat_id,g,workspace,principalThenSeat.principal_id], "sid7-sql-031");
 check((await handleHostedManagementCommand(envelope({kind:'revoke_agent_principal',principal_id:principalThenSeat.principal_id}),human)).status===200,'principal revocation before seat revocation positive control', "sid7-check-054");
 const [terminalT1]=await sql('SELECT revoked_at FROM swarm.agent_principals WHERE principal_id=$1',[principalThenSeat.principal_id], "sid7-sql-032");
 await new Promise(resolve=>setTimeout(resolve,10));
 check((await revoke(principalThenSeat)).status===200,'seat revocation after principal revocation positive control', "sid7-check-055");
 const beforeSweep=await assertFold(principalThenSeat);
 check(ms(beforeSweep.principal_revoked)===ms(terminalT1.revoked_at)&&ms(beforeSweep.seat_revoked)>ms(terminalT1.revoked_at),'before sweep both folds preserve distinct T1 principal and T2 seat terminals', "sid7-check-056");
 await expireFixture(principalThenSeat);await sql('SELECT swarm.expire_hosted_agent_contexts(100)',[], "sid7-sql-033");
 const afterSweep=await assertFold(principalThenSeat);
 check(ms(afterSweep.principal_revoked)===ms(beforeSweep.principal_revoked)&&ms(afterSweep.seat_revoked)===ms(beforeSweep.seat_revoked),'principal then seat revocation then sweep never restamps either terminal', "sid7-check-057");
 const retirementRace=(await claim(g)).body;
 await sql('INSERT INTO swarm.hosted_mcp_seat_handles(handle,seat_id,grant_id,workspace_id,principal_id,created_at) VALUES($1,$2,$3,$4,$5,statement_timestamp())', ['seat_'+id().replaceAll('-',''),retirementRace.seat_id,g,workspace,retirementRace.principal_id], "sid7-sql-034");
 await expireFixture(retirementRace);
 const retirementOutcomes=await Promise.all([revoke(retirementRace),sql('SELECT swarm.expire_hosted_agent_contexts(100)',[], "sid7-sql-035")]);
 check(retirementOutcomes[0].status===200,'human revoke and expiry serialize', "sid7-check-058");await assertFold(retirementRace);

 // Legacy rows preserve historical grant and cursor provenance through succession.
 await sql("INSERT INTO swarm.hosted_mcp_seat_handles(handle,seat_id,grant_id,workspace_id,principal_id,created_at) VALUES($1,$2,$3,$4,$5,statement_timestamp())",['seat_'+id().replaceAll('-',''),b.seat_id,g,workspace,b.principal_id], "sid7-sql-036");
 const successor1=await grant(),successor2=await grant();
 await sql("UPDATE swarm.hosted_mcp_grants SET state='revoked',revoked_at=statement_timestamp() WHERE grant_id=$1",[g], "sid7-sql-037");
 const races=await Promise.all([claim(successor1,{intent:'continue',name:'Shared durable'}),claim(successor2,{intent:'continue',name:'Shared durable'})]);
 check(races.filter(r=>r.status===200).length===1&&races.filter(r=>r.body.error==='identity_resume_unavailable').length===1,'two successors have exactly one winner', "sid7-check-059");
 const winner=races[0].status===200?successor1:successor2;
 check(await cap(g,b.handle,'note')===null,'old grant loses authority', "sid7-check-060");
 check((await inspect(winner,a.handle)).body.error==='context_closed','succession never revives closed A', "sid7-check-061");
 check((await poll(winner,b.handle,liveB.body.batch_id)).status===200,'successor ACK uses context, preserving historical grant', "sid7-check-062");
 const [history]=await sql("SELECT (SELECT grant_id FROM swarm.hosted_mcp_seat_handles WHERE seat_id=$1) AS legacy,(SELECT grant_id FROM swarm.hosted_mcp_check_cursors WHERE seat_id=$1) AS cursor,(SELECT grant_id FROM swarm.hosted_mcp_seats WHERE seat_id=$1) AS current",[b.seat_id], "sid7-sql-038");
 check(history.legacy===g&&history.cursor===g&&history.current===winner,'historical issuance preserved, current seat rebound', "sid7-check-063");
 // Each race admits only work ordered before close. B remains active afterward.
 const fresh=(await claim(winner)).body,c=await cap(winner,fresh.handle,'note');
 const race=await Promise.all([close(winner,fresh.handle),handleHostedCommand(envelope({kind:'post_signal',signal_kind:'note',body:'Synthetic race',to_user_id:null,to_agent_principal_id:null,in_reply_to:null,about:null}),c)]);
 check(race[0].status===200&&(race[1].status===200||race[1].body.error==='context_closed'),'close vs mutation is serial', "sid7-check-064");
 for(const route of ['read','ack']){
  const target=(await claim(winner)).body;
  const targetCap=await cap(winner,target.handle,route==='read'?'whoami':'check',route==='read'?'read':'command');
  let request;
  if(route==='ack'){
   const sender=await cap(winner,b.handle,'ask');
   const sent=await handleHostedCommand(envelope({kind:'post_signal',signal_kind:'ask',body:'Synthetic ACK race',to_user_id:null,to_agent_principal_id:target.principal_id,in_reply_to:null,about:null}),sender);check(sent.status===200,'ACK race signal positive control', "sid7-check-065");
   const batch=await poll(winner,target.handle);check(batch.body.batch_id,'ACK race batch positive control', "sid7-check-066");
   request=()=>handleHostedCommand(envelope({kind:'ack_hosted_mcp_check_batch',seat:target.handle,ack:batch.body.batch_id}),targetCap);
  }else request=()=>handleHostedRead({resource:'whoami',workspace_id:workspace},targetCap);
  const outcomes=await Promise.all([close(winner,target.handle),request()]);
  check(outcomes[0].status===200&&(outcomes[1].status===200||outcomes[1].body.error==='context_closed'),'close vs '+route+' serialized', "sid7-check-067");
  check((await inspect(winner,target.handle)).body.error==='context_closed','race context stays closed', "sid7-check-068");
 }
 check((await inspect(winner,b.handle)).status===200,'durable B still authorized', "sid7-check-069");
 check(await cap(winner,b.handle,'note','command',false)===null,'provider revocation negative control', "sid7-check-070");
 console.log('SID_LIFECYCLE_OK '+JSON.stringify({assertions}));
}catch(error){
 const checkpoint=failedCheckpoint??lastCheckpoint;
 const sqlstate=config.sqlstates.includes(error?.code)?error.code:null;
 await Deno.writeTextFile(config.receiptPath,JSON.stringify({checkpoint,sqlstate}));
 Deno.exitCode=1;
}finally{await db.end();}
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
  const receiptPath=join(directory,'failure.json');
  const run=spawnSync('deno',['run','--no-lock','--config','supabase/functions/command/deno.json','--allow-read','--allow-env','--allow-net','--allow-write='+receiptPath,path],{encoding:'utf8',timeout:210_000,input:JSON.stringify({owner,receiptPath,sqlstates:[...lifecycleSqlstates],local:{...local,DB_URL:isolated.url}})});
  assert.equal(run.status,0,'lifecycle fixture failed; '+lifecycleFailureReceipt(receiptPath)+'; credential-bearing output withheld');
  const receipt=run.stdout.split(/\r?\n/u).find(line=>line.startsWith('SID_LIFECYCLE_OK '));assert.ok(receipt);console.log(receipt);
 }finally{await isolated.close();}
 // Contains no credentials: configuration was supplied only through stdin.
 // Retain the task-owned script directory for CI diagnostics; no deletion bypass.
});
