/** CI only. Signed synthetic JWT -> real MCP index -> provider/capability
 * authorization -> real command/read and household adapters. No hosted I/O. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { adminEdgeDatabase } from '../support/admin-edge-database.js';
import { HOSTED_CONTEXT_FAILURE_PREFIX, parseHostedContextDiagnostic, rebuildHostedContextDiagnostic } from '../support/hosted-context-diagnostic.js';

const moduleUrl = (path: string) => new URL(`../../supabase/functions/${path}`, import.meta.url).href;
const harness = `
import assert from 'node:assert/strict';
import {classifyHostedContextFailure,rebuildHostedContextDiagnostic} from ${JSON.stringify(new URL('../support/hosted-context-diagnostic.ts', import.meta.url).href)};
let step='input',api,HostedToolFailure,PostgresError,lastFailure=null,httpStatus=null;
const classify=error=>classifyHostedContextFailure(error,{HostedToolFailure,PostgresError});
try {
try {
const input=JSON.parse(await new Response(Deno.stdin.readable).text());
Deno.env.set('SWARM_ENV','test'); Deno.env.set('SWARM_DATABASE_URL',input.database);
Deno.env.set('SUPABASE_URL',input.apiUrl);Deno.env.set('SUPABASE_ANON_KEY',input.anonKey);
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY','synthetic-storage-fixture');
step='command-import';
({PostgresError}= (await import('npm:postgres@3.4.9')).default);
api=await import(${JSON.stringify(moduleUrl('command/index.ts'))});
step='output-import';
const output=await import(${JSON.stringify(moduleUrl('mcp/tool-errors.ts'))});
HostedToolFailure=output.HostedToolFailure;
const readApi=await import(${JSON.stringify(moduleUrl('read/index.ts'))});
const auth=await import(${JSON.stringify(moduleUrl('_shared/hosted-seat-auth.ts'))});
const {HOUSEHOLD_TOOL_REGISTRY}=await import(${JSON.stringify(moduleUrl('_shared/protocol.js'))});
step='protocol-setup';
Deno.env.set('SWARM_MCP_PUBLIC_ENABLED','1');
const key=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
const jwk={...await crypto.subtle.exportKey('jwk',key.publicKey),kid:'fixture-key',alg:'ES256',use:'sig'};
const base64=value=>btoa(String.fromCharCode(...value)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
const encode=value=>base64(new TextEncoder().encode(JSON.stringify(value)));
const now=Math.floor(Date.now()/1000);
async function tokenFor(owner,grant){
const unsigned=encode({alg:'ES256',kid:'fixture-key'})+'.'+encode({iss:'https://mcp.commonswarm.com',
 aud:'https://mcp.commonswarm.com/mcp',sub:owner,grant_id:'provider-'+grant,scope:'mcp',iat:now,exp:now+300});
const signature=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key.privateKey,new TextEncoder().encode(unsigned));
return unsigned+'.'+base64(new Uint8Array(signature));}
const token=await tokenFor(input.owner,input.grant);
// Synthetic storage I/O retains only bytes actually written by the real
// household adapter. Its reads still pass the adapter's size/digest checks.
const blobs=new Map();
const storagePrefix=(input.apiUrl.endsWith('/')?input.apiUrl.slice(0,-1):input.apiUrl)+'/storage/v1/object/';
const {FILE_BUCKET}=await import(${JSON.stringify(moduleUrl('command/file-artifacts.ts'))});
globalThis.fetch=async (target,options)=>{
 const url=String(target);
 if(url==='https://mcp.commonswarm.com/jwks')return new Response(JSON.stringify({keys:[jwk]}),{headers:{'content-type':'application/json'}});
 (step='storage-01',assert.ok(url.startsWith(storagePrefix),'only synthetic JWKS and fixture storage I/O are allowed'));
 const headers=new Headers(options?.headers);
 (step='storage-02',assert.equal(headers.get('authorization'),'Bearer synthetic-storage-fixture'));
 (step='storage-03',assert.equal(headers.get('apikey'),'synthetic-storage-fixture'));
 const reading=(options?.method??'GET')==='GET';(step='storage-04',assert.ok(reading||options?.method==='POST'));
 const suffix=url.slice(storagePrefix.length);const path=suffix.startsWith('authenticated/')?suffix.slice('authenticated/'.length):suffix;
 (step='storage-05',assert.ok(path.startsWith(FILE_BUCKET+'/')));(step='storage-06',assert.equal(path.split('/').length,4));
 if(reading)return blobs.has(path)?new Response(blobs.get(path)):new Response(null,{status:404});
 (step='storage-07',assert.equal(headers.get('x-upsert'),'false'));(step='storage-08',assert.equal(blobs.has(path),false));
 (step='storage-09',assert.ok(options.body instanceof Uint8Array));blobs.set(path,new Uint8Array(options.body));return new Response(null,{status:200});
};
const {handleRequest:serve}=await import(${JSON.stringify(moduleUrl('mcp/index.ts'))});
async function tool(name,args,bearer=token){lastFailure=null;httpStatus=null;
 const response=await serve(new Request('https://mcp.commonswarm.com/mcp',{method:'POST',
 headers:{authorization:'Bearer '+bearer,'content-type':'application/json'},
 body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})}));
 httpStatus??=response.status;
 const rpc=await response.json();return {status:response.status,rpc,value:rpc.result?JSON.parse(rpc.result.content[0].text):null};}
async function household(name,args){lastFailure=null;httpStatus=null;
 const row=HOUSEHOLD_TOOL_REGISTRY.find(row=>row.name===name);(step='household-01',assert.ok(row));
 const use=row.effect==='read'?'read':'command';
 try{
  const capability=await api.db.begin(async tx=>{
   await tx.unsafe("SELECT set_config('role',$1,true)",[use==='read'?'swarm_read':'swarm_command']);
   return auth.authenticateHostedSeatCapability(tx,{grantId:input.grant,providerGrantId:'provider-'+input.grant,
    handle:args.seat,tool:name,providerStatus:async providerGrantId=>{
     const [status]=await api.db.unsafe('SELECT commonswarm_oauth.provider_family_active($1) AS active',[providerGrantId]);
     return {active:status.active};
    }},use);
  });
  if(capability===null)throw new HostedToolFailure('identity_resume_unavailable');
  const result=use==='read'?await readApi.handleHostedRead({resource:'household',workspace_id:input.workspace,tool:name,arguments:args},capability)
   :await api.handleHostedCommand({command_id:args.request_id,client_version:'0.1.80',workspace_id:input.workspace,
    stream:{kind:'workspace'},command:{kind:'household_tool',tool:name,arguments:args}},capability);
  httpStatus=result.status;return {isError:false,value:output.readOutput(result)};
 }catch(error){if(!(error instanceof HostedToolFailure))throw error;return {isError:true,value:output.hostedToolError(error,name)};}
}
async function assertBound(identity,owner=input.owner,grant=input.grant){
 const selected=await tool('whoami',{seat:identity.seat},owner===input.owner?token:await tokenFor(owner,grant));
 (step='bound-01',assert.equal(selected.status,200));(step='bound-02',assert.equal(selected.rpc.result.isError,false));
 (step='bound-03',assert.equal(selected.value.context_status,'active'));(step='bound-04',assert.equal(selected.value.transport,'hosted'));(step='bound-05',assert.equal(selected.value.turn_only,true));
 for(const field of ['context_id','seat_id','principal_id','grant_id','workspace_id','workspace','handle','seat','name','display_name','disambiguator','lifetime','kind','assurance'])(step='bound-06',assert.deepEqual(selected.value[field],identity[field],field));
 const [bound]=await api.db.unsafe('SELECT c.context_id,c.handle,c.closed_at,s.seat_id,s.principal_id,s.grant_id,s.owner_user_id,s.workspace_id,p.owner_user_id AS principal_owner FROM swarm.hosted_agent_contexts c JOIN swarm.hosted_mcp_seats s USING(seat_id) JOIN swarm.agent_principals p USING(principal_id) WHERE c.context_id=$1',[identity.context_id]);
 (step='bound-07',assert.ok(bound));(step='bound-08',assert.equal(bound.closed_at,null));(step='bound-09',assert.equal(bound.owner_user_id,owner));(step='bound-10',assert.equal(bound.principal_owner,owner));
 for(const field of ['context_id','handle','seat_id','principal_id','grant_id','workspace_id'])(step='bound-11',assert.equal(bound[field],identity[field],field));
}
 const call=args=>tool('claim_seat',args);
 const discovery=await tool('whoami',{});
 (step='discovery-01',assert.equal(discovery.status,200));(step='discovery-02',assert.equal(discovery.rpc.result.isError,false));
 (step='discovery-03',assert.equal(discovery.value.context_status,'unselected'));(step='discovery-04',assert.equal(discovery.value.home_workspace_id,input.home));
 (step='discovery-05',assert.equal(discovery.value.owner.user_id,input.owner));(step='discovery-06',assert.equal(discovery.value.app.client_id,'synthetic-app'));
 (step='discovery-07',assert.equal(discovery.value.suggested_name,'Agent'));(step='discovery-08',assert.equal(discovery.value.next_action,'claim_seat'));
 (step='discovery-09',assert.deepEqual(discovery.value.workspaces.map(row=>row.id).sort(),[input.home,input.workspace].sort()));
 for(const field of ['seat','handle','principal_id','members','provider_grant_id'])(step='discovery-10',assert.equal(Object.hasOwn(discovery.value,field),false));
 (step='discovery-11',assert.equal((await api.db.unsafe('SELECT count(*)::int AS n FROM swarm.hosted_agent_contexts'))[0].n,0));
 // Case: first-message. Keep diagnostic steps in the shared allowlist.
 step='first-claim';
 const firstMessage=await call({request_id:'server_first_message_1'});
 (step='first-message-01',assert.equal(firstMessage.status,200));(step='first-message-02',assert.equal(firstMessage.rpc.result.isError,false));
 (step='first-message-03',assert.equal(firstMessage.value.workspace_id,input.home));(step='first-message-04',assert.equal(firstMessage.value.workspace.name,'Synthetic home'));
 (step='first-message-05',assert.equal(firstMessage.value.outcome,'created'));(step='first-message-06',assert.equal(firstMessage.value.original_outcome,'created'));
 (step='first-message-07',assert.equal(firstMessage.value.lifetime,'ephemeral'));(step='first-message-08',assert.equal(firstMessage.value.kind,'chat'));(step='first-message-09',assert.equal(firstMessage.value.assurance,'portable'));
 (step='first-message-10',assert.equal(firstMessage.value.display_name,'Agent'));(step='first-message-11',assert.match(firstMessage.value.disambiguator,/^[A-Z2-7]{4}$/u));
 (step='first-message-12',assert.equal(firstMessage.value.name,'Agent-'+firstMessage.value.disambiguator));
 (step='first-message-13',assert.equal(firstMessage.value.name_adjusted,true));(step='first-message-14',assert.equal(firstMessage.value.adjustment_reason,'ephemeral_address'));
 await assertBound(firstMessage.value);
 step='first-claim';
 const request={request_id:'server_claim_context_1',name:'Marketing',lifetime:'durable',kind:'scheduled',workspace_id:input.workspace};
 const first=await call(request);(step='durable-new-01',assert.equal(first.status,200));(step='durable-new-02',assert.equal(first.rpc.result.isError,false));
 (step='durable-new-03',assert.equal(first.value.name,'Marketing'));(step='durable-new-04',assert.equal(first.value.display_name,'Marketing'));
 (step='durable-new-05',assert.equal(first.value.kind,'scheduled'));(step='durable-new-06',assert.equal(first.value.lifetime,'durable'));
 (step='durable-new-07',assert.equal(first.value.assurance,'portable'));(step='durable-new-08',assert.equal(first.value.seat,first.value.handle));
 (step='durable-new-09',assert.equal(first.value.outcome,'created'));(step='durable-new-10',assert.equal(first.value.original_outcome,'created'));
 (step='durable-new-11',assert.equal(first.value.name_adjusted,false));(step='durable-new-12',assert.equal(first.value.adjustment_reason,null));(step='durable-new-13',assert.equal(first.value.disambiguator,null));
 (step='durable-new-14',assert.notEqual(first.value.context_id,firstMessage.value.context_id));(step='durable-new-15',assert.notEqual(first.value.principal_id,firstMessage.value.principal_id));
 for(const field of ['context_id','principal_id','seat_id','created_at','last_business_at','idle_expires_at','absolute_expires_at'])(step='durable-new-16',assert.ok(first.value[field],field));
 for(const field of ['ok','status','event_ids'])(step='durable-new-17',assert.equal(Object.hasOwn(first.value,field),false));
 step='replay';
 const replay=await call(request);(step='replay-01',assert.equal(replay.value.outcome,'replayed'));(step='replay-02',assert.equal(replay.value.context_id,first.value.context_id));
 const selected=await tool('whoami',{seat:first.value.seat});(step='replay-03',assert.equal(selected.rpc.result.isError,false));
 for(const field of ['grant_id','workspace_id','workspace','seat_id','principal_id','context_id','seat','handle','name',
 'display_name','disambiguator','assurance','lifetime','kind','created_at','last_business_at','idle_expires_at','absolute_expires_at']){
  (step='replay-04',assert.deepEqual(selected.value[field],first.value[field],field));
 }
 (step='replay-05',assert.equal(selected.value.context_status,'active'));(step='replay-06',assert.equal(selected.value.transport,'hosted'));(step='replay-07',assert.equal(selected.value.turn_only,true));
 (step='replay-08',assert.equal(Object.hasOwn(selected.value,'client_id'),false));(step='replay-09',assert.equal(Object.hasOwn(selected.value,'owner_user_id'),false));
 // Case: durable-continuation. Keep diagnostic steps in the shared allowlist.
 step='continue';
 const continued=await call({request_id:'server_continue_context_1',intent:'continue',name:'Marketing',kind:'task',workspace_id:input.workspace});
 (step='continue-01',assert.equal(continued.rpc.result.isError,false));(step='continue-02',assert.equal(continued.value.principal_id,first.value.principal_id));
 (step='continue-03',assert.notEqual(continued.value.context_id,first.value.context_id));(step='continue-04',assert.equal(continued.value.kind,'task'));
 (step='continue-05',assert.notEqual(continued.value.seat,first.value.seat));(step='continue-06',assert.equal(continued.value.seat_id,first.value.seat_id));
 (step='continue-07',assert.equal(continued.value.outcome,'continued'));(step='continue-08',assert.equal(continued.value.original_outcome,'continued'));(step='continue-09',assert.equal(continued.value.lifetime,'durable'));
 (step='continue-10',assert.equal(continued.value.name,'Marketing'));(step='continue-11',assert.equal(continued.value.name_adjusted,false));(step='continue-12',assert.equal(continued.value.adjustment_reason,null));
 await assertBound(continued.value);
 const retained=await call({request_id:'server_handle_context_1',intent:'continue',seat:first.value.seat});
 (step='continue-13',assert.equal(retained.rpc.result.isError,false));(step='continue-14',assert.equal(retained.value.workspace_id,input.workspace));
 (step='continue-15',assert.equal(retained.value.context_id,first.value.context_id,'handle never falls back to a different home'));
 const mismatch=await call({request_id:'server_handle_mismatch_1',intent:'continue',seat:first.value.seat,workspace_id:input.home});
 (step='continue-16',assert.equal(mismatch.rpc.result.isError,true));(step='continue-17',assert.equal(mismatch.value.error,'workspace_mismatch'));
 // Case: ephemeral-durable-collision. Keep diagnostic steps in the shared allowlist.
 step='separate-claim';
 const separate=await call({request_id:'server_new_context_2',name:'Marketing',workspace_id:input.workspace});
 (step='collision-01',assert.equal(separate.rpc.result.isError,false));(step='collision-02',assert.equal(separate.value.display_name,'Marketing'));
 (step='collision-03',assert.equal(separate.value.adjustment_reason,'collision'));(step='collision-04',assert.notEqual(separate.value.principal_id,first.value.principal_id));
 (step='collision-05',assert.equal(separate.value.outcome,'created'));(step='collision-06',assert.equal(separate.value.original_outcome,'created'));(step='collision-07',assert.equal(separate.value.lifetime,'ephemeral'));
 (step='collision-08',assert.equal(separate.value.name_adjusted,true));(step='collision-09',assert.match(separate.value.disambiguator,/^[A-Z2-7]{4}$/u));
 (step='collision-10',assert.equal(separate.value.name,'Marketing-'+separate.value.disambiguator));
 (step='collision-11',assert.notEqual(separate.value.seat_id,first.value.seat_id));(step='collision-12',assert.notEqual(separate.value.context_id,first.value.context_id));
 await assertBound(separate.value);await assertBound(first.value);
 const separateDurable=await call({request_id:'server_durable_collision_1',name:'Marketing',lifetime:'durable',workspace_id:input.workspace});
 (step='collision-13',assert.equal(separateDurable.rpc.result.isError,false));(step='collision-14',assert.equal(separateDurable.value.outcome,'created'));(step='collision-15',assert.equal(separateDurable.value.original_outcome,'created'));
 (step='collision-16',assert.equal(separateDurable.value.lifetime,'durable'));(step='collision-17',assert.equal(separateDurable.value.display_name,'Marketing'));
 (step='collision-18',assert.equal(separateDurable.value.name_adjusted,true));(step='collision-19',assert.equal(separateDurable.value.adjustment_reason,'collision'));
 (step='collision-20',assert.match(separateDurable.value.disambiguator,/^[A-Z2-7]{4}$/u));(step='collision-21',assert.equal(separateDurable.value.name,'Marketing-'+separateDurable.value.disambiguator));
 for(const existing of [first.value,separate.value])for(const field of ['principal_id','seat_id','context_id','seat','name'])(step='collision-22',assert.notEqual(separateDurable.value[field],existing[field],field));
 await assertBound(separateDurable.value);await assertBound(first.value);
 step='committed-context';lastFailure=null;httpStatus=null;
 const contexts=await api.db.unsafe('SELECT kind,handle FROM swarm.hosted_agent_contexts WHERE context_id=$1::uuid',[first.value.context_id]);
 (step='persisted-01',assert.equal(contexts.length,1));(step='persisted-02',assert.equal(contexts[0].kind,'scheduled'));(step='persisted-03',assert.equal(contexts[0].handle,first.value.handle));
 step='malformed';
 const invalid=await call({...request,seat:first.value.handle});(step='malformed-01',assert.equal(invalid.status,400));(step='malformed-02',assert.equal(invalid.rpc.error.code,-32602));
 step='conflict';
 const conflict=await call({...request,name:'Different'});(step='conflict-01',assert.equal(conflict.rpc.result.isError,true));(step='conflict-02',assert.equal(conflict.value.error,'command_id_conflict'));
 step='committed-context';
 const objectId=crypto.randomUUID();
 await api.db.unsafe("INSERT INTO swarm.household_content_connections(connection_id,grant_id,workspace_id,principal_id,owner_user_id,purpose,operations,consent_receipt_id,expires_at,hosted_grant_id) VALUES($1,$2,$3,$4,$5,'shared',ARRAY['read','create','update'],$6,NULL,$2)",
  [first.value.seat_id,input.grant,input.workspace,first.value.principal_id,input.owner,input.consent]);
 const createArgs={seat:first.value.seat,request_id:'server_household_create_1',object_id:objectId,title:'Synthetic retained doc',content:{kind:'doc',markdown:'synthetic shared content'}};
 // Case: public-household-refusal. Keep diagnostic steps in the shared allowlist.
 step='malformed';
 for(const [name,args] of [['object_create',createArgs],['object_read',{seat:first.value.seat,object_id:objectId}]]){
  const refused=await tool(name,args);(step='public-household-01',assert.equal(refused.status,400));(step='public-household-02',assert.equal(refused.rpc.error.code,-32602));(step='public-household-03',assert.equal(Object.hasOwn(refused.rpc,'result'),false));
 }
 // Case: prepared-household. Keep diagnostic steps in the shared allowlist.
 step='committed-context';
 const created=await household('object_create',createArgs);(step='prepared-household-01',assert.equal(created.isError,false));(step='prepared-household-02',assert.equal(created.value.status,'committed'));
 (step='prepared-household-03',assert.equal(created.value.revision.workspace_id,input.workspace));(step='prepared-household-04',assert.equal(created.value.revision.object_id,objectId));(step='prepared-household-05',assert.ok(created.value.revision.token));
 const readArgs={seat:first.value.seat,object_id:objectId};
 function assertRetained(result){(step='prepared-household-06',assert.equal(result.isError,false));(step='prepared-household-07',assert.equal(result.value.status,'ok'));(step='prepared-household-08',assert.equal(result.value.kind,'object_read'));
  (step='prepared-household-09',assert.equal(result.value.revision.revision.object_id,objectId));(step='prepared-household-10',assert.deepEqual(result.value.revision.revision,created.value.revision));
  (step='prepared-household-11',assert.equal(result.value.revision.title,'Synthetic retained doc'));(step='prepared-household-12',assert.deepEqual(result.value.content,{kind:'doc',markdown:'synthetic shared content'}));}
 assertRetained(await household('object_read',readArgs));
 const unknownRead=await household('object_read',{...readArgs,seat:'seat_ZZZZZZZZZZZZZZZZZZZZZZ'});
 (step='prepared-household-13',assert.equal(unknownRead.isError,true));(step='prepared-household-14',assert.equal(unknownRead.value.error,'identity_resume_unavailable'));(step='prepared-household-15',assert.equal(unknownRead.value.can_start_new,false));
 const note=await tool('note',{seat:first.value.seat,request_id:'server_attributed_note_1',body:'Synthetic shared note'});
 (step='prepared-household-16',assert.equal(note.rpc.result.isError,false));(step='prepared-household-17',assert.ok(note.value.signal_id));
 const audit=await api.db.unsafe("SELECT context_id,context_details FROM swarm.audit_log WHERE context_id=$1 AND context_details->>'command_id'=$2",
  [first.value.context_id,'server_attributed_note_1']);
 (step='prepared-household-18',assert.ok(audit.length>0));(step='prepared-household-19',assert.equal(audit[0].context_details.principal_id,first.value.principal_id));
 (step='prepared-household-20',assert.equal(audit[0].context_details.workspace_id,input.workspace));(step='prepared-household-21',assert.equal(audit[0].context_details.client_id,'synthetic-app'));
 (step='prepared-household-22',assert.equal(JSON.stringify(audit).includes(first.value.handle),false));
 const contentAudit=await api.db.unsafe("SELECT context_id,context_details FROM swarm.audit_log WHERE context_id=$1 AND context_details->>'command_id'=$2",[first.value.context_id,createArgs.request_id]);
 (step='prepared-household-23',assert.ok(contentAudit.length>0));(step='prepared-household-24',assert.equal(contentAudit[0].context_details.principal_id,first.value.principal_id));
 (step='prepared-household-25',assert.equal(contentAudit[0].context_details.workspace_id,input.workspace));(step='prepared-household-26',assert.equal(contentAudit[0].context_details.client_id,'synthetic-app'));
 const rows=await api.db.begin(async tx=>{
  await tx.unsafe("SELECT set_config('role','swarm_read',true),set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:input.owner,role:'authenticated'})]);
  return await tx.unsafe('SELECT principal_id,name,display_name,disambiguator,identity_lifetime,app,context_activity FROM swarm_read.agent_principals WHERE workspace_id=$1::uuid AND revoked_at IS NULL',[input.workspace]);
 });
 (step='prepared-household-27',assert.equal(rows.length,3));const durable=rows.find(row=>row.principal_id===first.value.principal_id);
 (step='prepared-household-28',assert.equal(durable.display_name,'Marketing'));(step='prepared-household-29',assert.equal(durable.identity_lifetime,'durable'));
 (step='prepared-household-30',assert.equal(durable.app.client_id,'synthetic-app'));(step='prepared-household-31',assert.equal(durable.app.display_name,'Agent'));
 (step='prepared-household-32',assert.equal(durable.context_activity.active_contexts,2));(step='prepared-household-33',assert.ok(durable.context_activity.last_business_at));
 const ephemeral=rows.find(row=>row.principal_id===separate.value.principal_id);
 (step='prepared-household-34',assert.equal(ephemeral.disambiguator,separate.value.disambiguator));(step='prepared-household-35',assert.equal(ephemeral.identity_lifetime,'ephemeral'));
 // Case: cannot-resume. Keep diagnostic steps in the shared allowlist.
 step='continue';
 const foreign=await tool('claim_seat',{request_id:'server_foreign_context_1',name:'Other owner agent',lifetime:'durable',workspace_id:input.workspace},await tokenFor(input.foreignOwner,input.foreignGrant));
 (step='cannot-resume-01',assert.equal(foreign.rpc.result.isError,false));(step='cannot-resume-02',assert.equal(foreign.value.outcome,'created'));await assertBound(foreign.value,input.foreignOwner,input.foreignGrant);
 const beforeRefusal=(await api.db.unsafe('SELECT count(*)::int AS n FROM swarm.hosted_agent_contexts'))[0].n;
 // DESIGN 4.3 permits new after identity-only refusal under a valid grant,
 // including a foreign handle. No binding is disclosed or replacement allocated.
 for(const [args,canStartNew] of [
  [{name:foreign.value.name},true],
  [{name:separate.value.name},true],
  [{seat:foreign.value.seat},true],
 ]){
  const refused=await call({request_id:crypto.randomUUID(),intent:'continue',workspace_id:input.workspace,...args});
  (step='cannot-resume-03',assert.equal(refused.status,200));(step='cannot-resume-04',assert.equal(refused.rpc.result.isError,true));
  (step='cannot-resume-05',assert.equal(refused.value.error,'identity_resume_unavailable'));(step='cannot-resume-06',assert.equal(refused.value.can_start_new,canStartNew));
  for(const field of ['context_id','seat','handle','principal_id'])(step='cannot-resume-07',assert.equal(Object.hasOwn(refused.value,field),false));
 }
 const foreignSelected=await tool('whoami',{seat:foreign.value.seat});
 (step='cannot-resume-08',assert.equal(foreignSelected.rpc.result.isError,true));(step='cannot-resume-09',assert.equal(foreignSelected.value.error,'identity_resume_unavailable'));(step='cannot-resume-10',assert.equal(foreignSelected.value.can_start_new,false));
 (step='cannot-resume-11',assert.equal((await api.db.unsafe('SELECT count(*)::int AS n FROM swarm.hosted_agent_contexts'))[0].n,beforeRefusal));
 await assertBound(first.value);await assertBound(continued.value);await assertBound(foreign.value,input.foreignOwner,input.foreignGrant);
 await api.db.unsafe('UPDATE swarm.workspaces SET archived_at=statement_timestamp() WHERE workspace_id=$1',[input.home]);
 const noHome=await call({request_id:'server_missing_home_1'});(step='cannot-resume-12',assert.equal(noHome.rpc.result.isError,true));(step='cannot-resume-13',assert.equal(noHome.value.error,'workspace_unavailable'));
 const noHomeDiscovery=await tool('whoami',{});(step='cannot-resume-14',assert.equal(noHomeDiscovery.rpc.result.isError,false));(step='cannot-resume-15',assert.equal(noHomeDiscovery.value.home_workspace_id,null));
 const noHomeContinue=await call({request_id:'server_no_home_continue_1',intent:'continue',seat:first.value.seat});
 (step='expiry-01',assert.equal(noHomeContinue.rpc.result.isError,false));(step='expiry-02',assert.equal(noHomeContinue.value.context_id,first.value.context_id));
 await api.db.begin(async tx=>{
  await tx.unsafe('ALTER TABLE swarm.hosted_agent_contexts DISABLE TRIGGER hosted_context_guard');
  // Shift the actual issued clocks together; retain each kind's idle and
  // absolute intervals so the real close guard sees a valid expired record.
  await tx.unsafe("UPDATE swarm.hosted_agent_contexts SET created_at=created_at-interval '3 days',last_business_at=last_business_at-interval '3 days',idle_expires_at=idle_expires_at-interval '3 days',absolute_expires_at=absolute_expires_at-interval '3 days' WHERE context_id=ANY($1::uuid[])",[ [first.value.context_id,separate.value.context_id] ]);
  await tx.unsafe('ALTER TABLE swarm.hosted_agent_contexts ENABLE TRIGGER hosted_context_guard');
 });
 const expiry={error:'context_expired',message:'This chat identity expired. Start a new identity to continue; shared work is still here.',can_start_new:true};
 for(const [name,args] of [['whoami',{seat:first.value.seat}],['claim_seat',{request_id:'server_expired_handle_1',intent:'continue',seat:first.value.seat}]]){
  const result=await tool(name,args);(step='expiry-03',assert.equal(result.status,200));(step='expiry-04',assert.equal(result.rpc.result.isError,true));(step='expiry-05',assert.deepEqual(result.value,expiry));
 }
 for(const [name,args] of [['object_read',readArgs],['object_create',{...createArgs,request_id:'server_expired_write_1',object_id:crypto.randomUUID()}]]){
  const result=await household(name,args);(step='expiry-06',assert.equal(result.isError,true));(step='expiry-07',assert.deepEqual(result.value,expiry));
 }
 // Case: new-after-expiry. Keep diagnostic steps in the shared allowlist.
 step='separate-claim';
 const beforeNew=(await api.db.unsafe('SELECT count(*)::int AS n FROM swarm.hosted_agent_contexts'))[0].n;
 const fresh=await call({request_id:'server_new_after_expiry_1',name:'Marketing',workspace_id:input.workspace});
 (step='new-after-expiry-01',assert.equal(fresh.rpc.result.isError,false));(step='new-after-expiry-02',assert.equal(fresh.value.outcome,'created'));(step='new-after-expiry-03',assert.equal(fresh.value.original_outcome,'created'));
 (step='new-after-expiry-04',assert.equal(fresh.value.lifetime,'ephemeral'));(step='new-after-expiry-05',assert.equal(fresh.value.kind,'chat'));(step='new-after-expiry-06',assert.equal(fresh.value.display_name,'Marketing'));
 (step='new-after-expiry-07',assert.equal(fresh.value.name_adjusted,true));(step='new-after-expiry-08',assert.equal(fresh.value.adjustment_reason,'collision'));
 (step='new-after-expiry-09',assert.match(fresh.value.disambiguator,/^[A-Z2-7]{4}$/u));(step='new-after-expiry-10',assert.equal(fresh.value.name,'Marketing-'+fresh.value.disambiguator));
 for(const existing of [first.value,continued.value,separate.value,separateDurable.value,foreign.value,firstMessage.value])for(const field of ['context_id','seat','seat_id','principal_id'])(step='new-after-expiry-11',assert.notEqual(fresh.value[field],existing[field],field));
 (step='new-after-expiry-12',assert.equal((await api.db.unsafe('SELECT count(*)::int AS n FROM swarm.hosted_agent_contexts'))[0].n,beforeNew+1));
 await assertBound(fresh.value);
 (step='new-after-expiry-13',assert.ok(Date.parse(fresh.value.idle_expires_at)>Date.now()));(step='new-after-expiry-14',assert.ok(Date.parse(fresh.value.absolute_expires_at)>Date.now()));
 for(const old of [first.value,separate.value]){
  const expired=await tool('whoami',{seat:old.seat});(step='new-after-expiry-15',assert.equal(expired.rpc.result.isError,true));(step='new-after-expiry-16',assert.deepEqual(expired.value,expiry));
 }
 // Case: expiry-close. Keep diagnostic steps in the shared allowlist.
 step='committed-context';
 const closeArgs={seat:first.value.seat,request_id:'server_expired_close_1'};
 const closed=await tool('close_session',closeArgs);(step='expiry-close-01',assert.equal(closed.rpc.result.isError,false));
 (step='expiry-close-02',assert.equal(closed.value.outcome,'closed'));(step='expiry-close-03',assert.equal(closed.value.context_id,first.value.context_id));(step='expiry-close-04',assert.equal(closed.value.principal_state,'retained'));(step='expiry-close-05',assert.ok(closed.value.closed_at));
 const closeReplay=await tool('close_session',closeArgs);(step='expiry-close-06',assert.equal(closeReplay.rpc.result.isError,false));(step='expiry-close-07',assert.equal(closeReplay.value.outcome,'replayed'));(step='expiry-close-08',assert.equal(closeReplay.value.closed_at,closed.value.closed_at));
 const closeAgain=await tool('close_session',{...closeArgs,request_id:'server_expired_close_2'});(step='expiry-close-09',assert.equal(closeAgain.rpc.result.isError,false));(step='expiry-close-10',assert.equal(closeAgain.value.outcome,'closed'));(step='expiry-close-11',assert.equal(closeAgain.value.closed_at,closed.value.closed_at));
 const closedRead=await tool('whoami',{seat:first.value.seat});(step='expiry-close-12',assert.equal(closedRead.rpc.result.isError,true));(step='expiry-close-13',assert.equal(closedRead.value.error,'context_closed'));
 const sibling=await tool('whoami',{seat:continued.value.seat});(step='expiry-close-14',assert.equal(sibling.rpc.result.isError,false));
 assertRetained(await household('object_read',{...readArgs,seat:continued.value.seat}));
 const closedContent=await household('object_read',readArgs);(step='expiry-close-15',assert.equal(closedContent.isError,true));(step='expiry-close-16',assert.equal(closedContent.value.error,'context_closed'));
 await assertBound(continued.value);await assertBound(fresh.value);
 const retired=await tool('close_session',{seat:separate.value.seat,request_id:'server_ephemeral_close_1'});
 (step='expiry-close-17',assert.equal(retired.rpc.result.isError,false));(step='expiry-close-18',assert.equal(retired.value.principal_state,'retired'));
 const retiredAgain=await tool('close_session',{seat:separate.value.seat,request_id:'server_ephemeral_close_2'});
 (step='expiry-close-19',assert.equal(retiredAgain.rpc.result.isError,false));(step='expiry-close-20',assert.equal(retiredAgain.value.closed_at,retired.value.closed_at));
 const retiredRead=await tool('whoami',{seat:separate.value.seat});(step='expiry-close-21',assert.equal(retiredRead.rpc.result.isError,true));(step='expiry-close-22',assert.equal(retiredRead.value.error,'context_closed'));
 step='revoked';
 await api.db.unsafe('INSERT INTO commonswarm_oauth.refresh_family_tombstones(grant_id,revoked_at) VALUES($1,statement_timestamp())',['provider-'+input.grant]);
 const denied=await call({request_id:'server_denied_context_1'});(step='revoked-01',assert.equal(denied.rpc.result.isError,true));(step='revoked-02',assert.equal(denied.value.can_start_new,false));
 const deniedDiscovery=await tool('whoami',{});(step='revoked-03',assert.equal(deniedDiscovery.rpc.result.isError,true));(step='revoked-04',assert.equal(deniedDiscovery.value.error,'identity_resume_unavailable'));
 const deniedClose=await tool('close_session',{seat:continued.value.seat,request_id:'server_denied_close_1'});
 (step='revoked-05',assert.equal(deniedClose.rpc.result.isError,true));(step='revoked-06',assert.equal(deniedClose.value.error,'identity_resume_unavailable'));(step='revoked-07',assert.equal(deniedClose.value.can_start_new,false));
 const siblingState=await api.db.unsafe('SELECT closed_at FROM swarm.hosted_agent_contexts WHERE context_id=$1',[continued.value.context_id]);(step='revoked-08',assert.equal(siblingState[0].closed_at,null));
 step='committed-count';lastFailure=null;httpStatus=null;
 const count=await api.db.unsafe('SELECT count(*)::int AS n FROM swarm.hosted_agent_contexts');(step='count-01',assert.equal(count[0].n,7));
 step='cleanup';
} finally {if(api)await api.db.end();}
 console.log('SID_MCP_CLAIM_OK '+JSON.stringify({allocations:7,malformed_refused:true,revoked_refused:true,replay_preserved:true,index_lifecycle:true,expiry_close:true,public_household_refused:true,retained_content:true,typed_identity_cases:5}));
 Deno.exit(0);
} catch(error){
 // The protocol turns executor exceptions into tool results. Preserve only
 // classified metadata at that boundary for a later assertion failure.
 const failure=lastFailure??classify(error);
 const http_status=Number.isInteger(httpStatus)&&httpStatus>=100&&httpStatus<=599?httpStatus:null;
 console.log(rebuildHostedContextDiagnostic({step,...failure,http_status}));Deno.exit(1);
}
`;

test('real MCP index preserves discovery, identity, household lifecycle and expiry-aware own close', { timeout: 180000 }, async () => {
  const local = JSON.parse(execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  for (const target of [local.DB_URL, local.API_URL]) assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(target).hostname));
  const isolated = await adminEdgeDatabase(local.DB_URL);
  const root = realpathSync(process.platform === 'darwin' ? '/private/tmp' : tmpdir());
  const directory = mkdtempSync(join(root, 'anvil-secret.')); chmodSync(directory, 0o700);
  try {
    const owner = randomUUID(), workspace = randomUUID(), home = randomUUID(), grant = randomUUID(), consent = randomUUID();
    const foreignOwner = randomUUID(), foreignGrant = randomUUID();
    await isolated.db`INSERT INTO auth.users(id,aud,role,email) VALUES(${owner}::uuid,'authenticated','authenticated',${owner+'@example.test'})`;
    await isolated.db`INSERT INTO swarm.users(user_id,display_name) VALUES(${owner}::uuid,'Synthetic owner')`;
    await isolated.db`INSERT INTO swarm.workspaces(workspace_id,name,created_by) VALUES(${workspace}::uuid,'Synthetic workspace',${owner}::uuid)`;
    await isolated.db`INSERT INTO swarm.memberships(workspace_id,user_id,role) VALUES(${workspace}::uuid,${owner}::uuid,'owner')`;
    await isolated.db`INSERT INTO swarm.streams(stream_id,workspace_id,kind) VALUES(${randomUUID()}::uuid,${workspace}::uuid,'workspace')`;
    await isolated.db`INSERT INTO swarm.workspaces(workspace_id,name,created_by) VALUES(${home}::uuid,'Synthetic home',${owner}::uuid)`;
    await isolated.db`INSERT INTO swarm.memberships(workspace_id,user_id,role) VALUES(${home}::uuid,${owner}::uuid,'owner')`;
    await isolated.db`INSERT INTO swarm.streams(stream_id,workspace_id,kind) VALUES(${randomUUID()}::uuid,${home}::uuid,'workspace')`;
    await isolated.db`INSERT INTO swarm.household_workspace_boundaries(workspace_id,purpose) VALUES(${workspace}::uuid,'shared')`;
    await isolated.db`INSERT INTO swarm.household_member_content_roles(workspace_id,user_id,content_role,content_consent_id,confirmed_at)
      VALUES(${workspace}::uuid,${owner}::uuid,'editor',${consent}::uuid,statement_timestamp())`;
    await isolated.db`INSERT INTO swarm.config(key,value) VALUES('min_client_version','"0.1.0"'),('hosted_context_allocation_enabled','true') ON CONFLICT(key) DO UPDATE SET value=excluded.value`;
    await isolated.db`INSERT INTO swarm.hosted_mcp_grants(grant_id,provider_grant_id,owner_user_id,home_workspace_id,client_id,resource,selected_workspace_ids,manifest_digest,interaction_ref,state,created_at,activated_at)
      VALUES(${grant}::uuid,${'provider-'+grant},${owner}::uuid,${home}::uuid,'synthetic-app','https://mcp.commonswarm.com/mcp',${[workspace,home]}::uuid[],${new Uint8Array(32)},'fixture','active',statement_timestamp(),statement_timestamp())`;
    await isolated.db`INSERT INTO swarm.hosted_mcp_grant_workspaces(grant_id,workspace_id,owner_user_id,manifest_digest,consent_receipt_id,consented_at)
      VALUES(${grant}::uuid,${workspace}::uuid,${owner}::uuid,${new Uint8Array(32)},${randomUUID()}::uuid,statement_timestamp())`;
    await isolated.db`INSERT INTO swarm.hosted_mcp_grant_workspaces(grant_id,workspace_id,owner_user_id,manifest_digest,consent_receipt_id,consented_at)
      VALUES(${grant}::uuid,${home}::uuid,${owner}::uuid,${new Uint8Array(32)},${randomUUID()}::uuid,statement_timestamp())`;
    await isolated.db`INSERT INTO auth.users(id,aud,role,email) VALUES(${foreignOwner}::uuid,'authenticated','authenticated',${foreignOwner+'@example.test'})`;
    await isolated.db`INSERT INTO swarm.users(user_id,display_name) VALUES(${foreignOwner}::uuid,'Synthetic other owner')`;
    await isolated.db`INSERT INTO swarm.memberships(workspace_id,user_id,role) VALUES(${workspace}::uuid,${foreignOwner}::uuid,'member')`;
    await isolated.db`INSERT INTO swarm.hosted_mcp_grants(grant_id,provider_grant_id,owner_user_id,home_workspace_id,client_id,resource,selected_workspace_ids,manifest_digest,interaction_ref,state,created_at,activated_at)
      VALUES(${foreignGrant}::uuid,${'provider-'+foreignGrant},${foreignOwner}::uuid,${workspace}::uuid,'synthetic-app','https://mcp.commonswarm.com/mcp',${[workspace]}::uuid[],${new Uint8Array(32)},'fixture','active',statement_timestamp(),statement_timestamp())`;
    await isolated.db`INSERT INTO swarm.hosted_mcp_grant_workspaces(grant_id,workspace_id,owner_user_id,manifest_digest,consent_receipt_id,consented_at)
      VALUES(${foreignGrant}::uuid,${workspace}::uuid,${foreignOwner}::uuid,${new Uint8Array(32)},${randomUUID()}::uuid,statement_timestamp())`;
    const path = join(directory, 'harness.mjs'); writeFileSync(path, harness, { mode: 0o600 });
    const run = spawnSync('deno', ['run', '--no-lock', '--config', 'supabase/functions/command/deno.json', '--allow-read', '--allow-env', '--allow-net', path],
      { encoding: 'utf8', timeout: 150000, input: JSON.stringify({ database: isolated.url, apiUrl: local.API_URL, anonKey: local.ANON_KEY, owner, workspace, home, grant, consent, foreignOwner, foreignGrant }) });
    const lines = (run.stdout ?? '').split(/\r?\n/u);
    if (run.status !== 0) {
      // Parse, allowlist and rebuild; never forward a child's stdout line.
      const diagnostic = lines.find(line => line.startsWith(HOSTED_CONTEXT_FAILURE_PREFIX));
      assert.fail(diagnostic === undefined ? rebuildHostedContextDiagnostic({ step: 'child-startup',
        error_code: run.error && 'code' in run.error && run.error.code === 'ETIMEDOUT' ? 'ETIMEDOUT' : 'ChildProcessFailure', sqlstate: null, http_status: null })
        : parseHostedContextDiagnostic(diagnostic));
    }
    const receipt = 'SID_MCP_CLAIM_OK '+JSON.stringify({ allocations: 7, malformed_refused: true, revoked_refused: true, replay_preserved: true, index_lifecycle: true, expiry_close: true, public_household_refused: true, retained_content: true, typed_identity_cases: 5 });
    assert.ok(lines.includes(receipt), 'real command fixture emitted a sanitized receipt'); console.log(receipt);
  } finally {
    await isolated.close();
    const owned = (path: string) => path === directory && dirname(path) === root && path !== homedir() && path !== '/' && path !== '';
    for (const path of ['', '/', homedir(), root, join(root, 'unowned')]) assert.equal(owned(path), false);
    const resolved = realpathSync(directory); assert.equal(owned(resolved), true);
    execFileSync('rm', ['-r', resolved], { stdio: ['ignore', 'pipe', 'pipe'] });
  }
});
