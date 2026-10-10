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
 assert.ok(url.startsWith(storagePrefix),'only synthetic JWKS and fixture storage I/O are allowed');
 const headers=new Headers(options?.headers);
 assert.equal(headers.get('authorization'),'Bearer synthetic-storage-fixture');
 assert.equal(headers.get('apikey'),'synthetic-storage-fixture');
 const reading=(options?.method??'GET')==='GET';assert.ok(reading||options?.method==='POST');
 const suffix=url.slice(storagePrefix.length);const path=suffix.startsWith('authenticated/')?suffix.slice('authenticated/'.length):suffix;
 assert.ok(path.startsWith(FILE_BUCKET+'/'));assert.equal(path.split('/').length,4);
 if(reading)return blobs.has(path)?new Response(blobs.get(path)):new Response(null,{status:404});
 assert.equal(headers.get('x-upsert'),'false');assert.equal(blobs.has(path),false);
 assert.ok(options.body instanceof Uint8Array);blobs.set(path,new Uint8Array(options.body));return new Response(null,{status:200});
};
const {handleRequest:serve}=await import(${JSON.stringify(moduleUrl('mcp/index.ts'))});
async function tool(name,args,bearer=token){lastFailure=null;httpStatus=null;
 const response=await serve(new Request('https://mcp.commonswarm.com/mcp',{method:'POST',
 headers:{authorization:'Bearer '+bearer,'content-type':'application/json'},
 body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})}));
 httpStatus??=response.status;
 const rpc=await response.json();return {status:response.status,rpc,value:rpc.result?JSON.parse(rpc.result.content[0].text):null};}
async function household(name,args){lastFailure=null;httpStatus=null;
 const row=HOUSEHOLD_TOOL_REGISTRY.find(row=>row.name===name);assert.ok(row);
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
 assert.equal(selected.status,200);assert.equal(selected.rpc.result.isError,false);
 assert.equal(selected.value.context_status,'active');assert.equal(selected.value.transport,'hosted');assert.equal(selected.value.turn_only,true);
 for(const field of ['context_id','seat_id','principal_id','grant_id','workspace_id','workspace','handle','seat','name','display_name','disambiguator','lifetime','kind','assurance'])assert.deepEqual(selected.value[field],identity[field],field);
 const [bound]=await api.db.unsafe('SELECT c.context_id,c.handle,c.closed_at,s.seat_id,s.principal_id,s.grant_id,s.owner_user_id,s.workspace_id,p.owner_user_id AS principal_owner FROM swarm.hosted_agent_contexts c JOIN swarm.hosted_mcp_seats s USING(seat_id) JOIN swarm.agent_principals p USING(principal_id) WHERE c.context_id=$1',[identity.context_id]);
 assert.ok(bound);assert.equal(bound.closed_at,null);assert.equal(bound.owner_user_id,owner);assert.equal(bound.principal_owner,owner);
 for(const field of ['context_id','handle','seat_id','principal_id','grant_id','workspace_id'])assert.equal(bound[field],identity[field],field);
}
 const call=args=>tool('claim_seat',args);
 const discovery=await tool('whoami',{});
 assert.equal(discovery.status,200);assert.equal(discovery.rpc.result.isError,false);
 assert.equal(discovery.value.context_status,'unselected');assert.equal(discovery.value.home_workspace_id,input.home);
 assert.equal(discovery.value.owner.user_id,input.owner);assert.equal(discovery.value.app.client_id,'synthetic-app');
 assert.equal(discovery.value.suggested_name,'Agent');assert.equal(discovery.value.next_action,'claim_seat');
 assert.deepEqual(discovery.value.workspaces.map(row=>row.id).sort(),[input.home,input.workspace].sort());
 for(const field of ['seat','handle','principal_id','members','provider_grant_id'])assert.equal(Object.hasOwn(discovery.value,field),false);
 assert.equal((await api.db.unsafe('SELECT count(*)::int AS n FROM swarm.hosted_agent_contexts'))[0].n,0);
 // Case: first-message. Keep diagnostic steps in the shared allowlist.
 step='first-claim';
 const firstMessage=await call({request_id:'server_first_message_1'});
 assert.equal(firstMessage.status,200);assert.equal(firstMessage.rpc.result.isError,false);
 assert.equal(firstMessage.value.workspace_id,input.home);assert.equal(firstMessage.value.workspace.name,'Synthetic home');
 assert.equal(firstMessage.value.outcome,'created');assert.equal(firstMessage.value.original_outcome,'created');
 assert.equal(firstMessage.value.lifetime,'ephemeral');assert.equal(firstMessage.value.kind,'chat');assert.equal(firstMessage.value.assurance,'portable');
 assert.equal(firstMessage.value.display_name,'Agent');assert.match(firstMessage.value.disambiguator,/^[A-Z2-7]{4}$/u);
 assert.equal(firstMessage.value.name,'Agent-'+firstMessage.value.disambiguator);
 assert.equal(firstMessage.value.name_adjusted,true);assert.equal(firstMessage.value.adjustment_reason,'ephemeral_address');
 await assertBound(firstMessage.value);
 step='first-claim';
 const request={request_id:'server_claim_context_1',name:'Marketing',lifetime:'durable',kind:'scheduled',workspace_id:input.workspace};
 const first=await call(request);assert.equal(first.status,200);assert.equal(first.rpc.result.isError,false);
 assert.equal(first.value.name,'Marketing');assert.equal(first.value.display_name,'Marketing');
 assert.equal(first.value.kind,'scheduled');assert.equal(first.value.lifetime,'durable');
 assert.equal(first.value.assurance,'portable');assert.equal(first.value.seat,first.value.handle);
 assert.equal(first.value.outcome,'created');assert.equal(first.value.original_outcome,'created');
 assert.equal(first.value.name_adjusted,false);assert.equal(first.value.adjustment_reason,null);assert.equal(first.value.disambiguator,null);
 assert.notEqual(first.value.context_id,firstMessage.value.context_id);assert.notEqual(first.value.principal_id,firstMessage.value.principal_id);
 for(const field of ['context_id','principal_id','seat_id','created_at','last_business_at','idle_expires_at','absolute_expires_at'])assert.ok(first.value[field],field);
 for(const field of ['ok','status','event_ids'])assert.equal(Object.hasOwn(first.value,field),false);
 step='replay';
 const replay=await call(request);assert.equal(replay.value.outcome,'replayed');assert.equal(replay.value.context_id,first.value.context_id);
 const selected=await tool('whoami',{seat:first.value.seat});assert.equal(selected.rpc.result.isError,false);
 for(const field of ['grant_id','workspace_id','workspace','seat_id','principal_id','context_id','seat','handle','name',
 'display_name','disambiguator','assurance','lifetime','kind','created_at','last_business_at','idle_expires_at','absolute_expires_at']){
  assert.deepEqual(selected.value[field],first.value[field],field);
 }
 assert.equal(selected.value.context_status,'active');assert.equal(selected.value.transport,'hosted');assert.equal(selected.value.turn_only,true);
 assert.equal(Object.hasOwn(selected.value,'client_id'),false);assert.equal(Object.hasOwn(selected.value,'owner_user_id'),false);
 // Case: durable-continuation. Keep diagnostic steps in the shared allowlist.
 step='continue';
 const continued=await call({request_id:'server_continue_context_1',intent:'continue',name:'Marketing',kind:'task',workspace_id:input.workspace});
 assert.equal(continued.rpc.result.isError,false);assert.equal(continued.value.principal_id,first.value.principal_id);
 assert.notEqual(continued.value.context_id,first.value.context_id);assert.equal(continued.value.kind,'task');
 assert.notEqual(continued.value.seat,first.value.seat);assert.equal(continued.value.seat_id,first.value.seat_id);
 assert.equal(continued.value.outcome,'continued');assert.equal(continued.value.original_outcome,'continued');assert.equal(continued.value.lifetime,'durable');
 assert.equal(continued.value.name,'Marketing');assert.equal(continued.value.name_adjusted,false);assert.equal(continued.value.adjustment_reason,null);
 await assertBound(continued.value);
 const retained=await call({request_id:'server_handle_context_1',intent:'continue',seat:first.value.seat});
 assert.equal(retained.rpc.result.isError,false);assert.equal(retained.value.workspace_id,input.workspace);
 assert.equal(retained.value.context_id,first.value.context_id,'handle never falls back to a different home');
 const mismatch=await call({request_id:'server_handle_mismatch_1',intent:'continue',seat:first.value.seat,workspace_id:input.home});
 assert.equal(mismatch.rpc.result.isError,true);assert.equal(mismatch.value.error,'workspace_mismatch');
 // Case: ephemeral-durable-collision. Keep diagnostic steps in the shared allowlist.
 step='separate-claim';
 const separate=await call({request_id:'server_new_context_2',name:'Marketing',workspace_id:input.workspace});
 assert.equal(separate.rpc.result.isError,false);assert.equal(separate.value.display_name,'Marketing');
 assert.equal(separate.value.adjustment_reason,'collision');assert.notEqual(separate.value.principal_id,first.value.principal_id);
 assert.equal(separate.value.outcome,'created');assert.equal(separate.value.original_outcome,'created');assert.equal(separate.value.lifetime,'ephemeral');
 assert.equal(separate.value.name_adjusted,true);assert.match(separate.value.disambiguator,/^[A-Z2-7]{4}$/u);
 assert.equal(separate.value.name,'Marketing-'+separate.value.disambiguator);
 assert.notEqual(separate.value.seat_id,first.value.seat_id);assert.notEqual(separate.value.context_id,first.value.context_id);
 await assertBound(separate.value);await assertBound(first.value);
 const separateDurable=await call({request_id:'server_durable_collision_1',name:'Marketing',lifetime:'durable',workspace_id:input.workspace});
 assert.equal(separateDurable.rpc.result.isError,false);assert.equal(separateDurable.value.outcome,'created');assert.equal(separateDurable.value.original_outcome,'created');
 assert.equal(separateDurable.value.lifetime,'durable');assert.equal(separateDurable.value.display_name,'Marketing');
 assert.equal(separateDurable.value.name_adjusted,true);assert.equal(separateDurable.value.adjustment_reason,'collision');
 assert.match(separateDurable.value.disambiguator,/^[A-Z2-7]{4}$/u);assert.equal(separateDurable.value.name,'Marketing-'+separateDurable.value.disambiguator);
 for(const existing of [first.value,separate.value])for(const field of ['principal_id','seat_id','context_id','seat','name'])assert.notEqual(separateDurable.value[field],existing[field],field);
 await assertBound(separateDurable.value);await assertBound(first.value);
 step='committed-context';lastFailure=null;httpStatus=null;
 const contexts=await api.db.unsafe('SELECT kind,handle FROM swarm.hosted_agent_contexts WHERE context_id=$1::uuid',[first.value.context_id]);
 assert.equal(contexts.length,1);assert.equal(contexts[0].kind,'scheduled');assert.equal(contexts[0].handle,first.value.handle);
 step='malformed';
 const invalid=await call({...request,seat:first.value.handle});assert.equal(invalid.status,400);assert.equal(invalid.rpc.error.code,-32602);
 step='conflict';
 const conflict=await call({...request,name:'Different'});assert.equal(conflict.rpc.result.isError,true);assert.equal(conflict.value.error,'command_id_conflict');
 step='committed-context';
 const objectId=crypto.randomUUID();
 await api.db.unsafe("INSERT INTO swarm.household_content_connections(connection_id,grant_id,workspace_id,principal_id,owner_user_id,purpose,operations,consent_receipt_id,expires_at,hosted_grant_id) VALUES($1,$2,$3,$4,$5,'shared',ARRAY['read','create','update'],$6,NULL,$2)",
  [first.value.seat_id,input.grant,input.workspace,first.value.principal_id,input.owner,input.consent]);
 const createArgs={seat:first.value.seat,request_id:'server_household_create_1',object_id:objectId,title:'Synthetic retained doc',content:{kind:'doc',markdown:'synthetic shared content'}};
 // Case: public-household-refusal. Keep diagnostic steps in the shared allowlist.
 step='malformed';
 for(const [name,args] of [['object_create',createArgs],['object_read',{seat:first.value.seat,object_id:objectId}]]){
  const refused=await tool(name,args);assert.equal(refused.status,400);assert.equal(refused.rpc.error.code,-32602);assert.equal(Object.hasOwn(refused.rpc,'result'),false);
 }
 // Case: prepared-household. Keep diagnostic steps in the shared allowlist.
 step='committed-context';
 const created=await household('object_create',createArgs);assert.equal(created.isError,false);assert.equal(created.value.status,'committed');
 assert.equal(created.value.revision.workspace_id,input.workspace);assert.equal(created.value.revision.object_id,objectId);assert.ok(created.value.revision.token);
 const readArgs={seat:first.value.seat,object_id:objectId};
 function assertRetained(result){assert.equal(result.isError,false);assert.equal(result.value.status,'ok');assert.equal(result.value.kind,'object_read');
  assert.equal(result.value.revision.revision.object_id,objectId);assert.deepEqual(result.value.revision.revision,created.value.revision);
  assert.equal(result.value.revision.title,'Synthetic retained doc');assert.deepEqual(result.value.content,{kind:'doc',markdown:'synthetic shared content'});}
 assertRetained(await household('object_read',readArgs));
 const unknownRead=await household('object_read',{...readArgs,seat:'seat_ZZZZZZZZZZZZZZZZZZZZZZ'});
 assert.equal(unknownRead.isError,true);assert.equal(unknownRead.value.error,'identity_resume_unavailable');assert.equal(unknownRead.value.can_start_new,false);
 const note=await tool('note',{seat:first.value.seat,request_id:'server_attributed_note_1',body:'Synthetic shared note'});
 assert.equal(note.rpc.result.isError,false);assert.ok(note.value.signal_id);
 const audit=await api.db.unsafe("SELECT context_id,context_details FROM swarm.audit_log WHERE context_id=$1 AND context_details->>'command_id'=$2",
  [first.value.context_id,'server_attributed_note_1']);
 assert.ok(audit.length>0);assert.equal(audit[0].context_details.principal_id,first.value.principal_id);
 assert.equal(audit[0].context_details.workspace_id,input.workspace);assert.equal(audit[0].context_details.client_id,'synthetic-app');
 assert.equal(JSON.stringify(audit).includes(first.value.handle),false);
 const contentAudit=await api.db.unsafe("SELECT context_id,context_details FROM swarm.audit_log WHERE context_id=$1 AND context_details->>'command_id'=$2",[first.value.context_id,createArgs.request_id]);
 assert.ok(contentAudit.length>0);assert.equal(contentAudit[0].context_details.principal_id,first.value.principal_id);
 assert.equal(contentAudit[0].context_details.workspace_id,input.workspace);assert.equal(contentAudit[0].context_details.client_id,'synthetic-app');
 const rows=await api.db.begin(async tx=>{
  await tx.unsafe("SELECT set_config('role','swarm_read',true),set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:input.owner,role:'authenticated'})]);
  return await tx.unsafe('SELECT principal_id,name,display_name,disambiguator,identity_lifetime,app,context_activity FROM swarm_read.agent_principals WHERE workspace_id=$1::uuid AND revoked_at IS NULL',[input.workspace]);
 });
 assert.equal(rows.length,3);const durable=rows.find(row=>row.principal_id===first.value.principal_id);
 assert.equal(durable.display_name,'Marketing');assert.equal(durable.identity_lifetime,'durable');
 assert.equal(durable.app.client_id,'synthetic-app');assert.equal(durable.app.display_name,'Agent');
 assert.equal(durable.context_activity.active_contexts,2);assert.ok(durable.context_activity.last_business_at);
 const ephemeral=rows.find(row=>row.principal_id===separate.value.principal_id);
 assert.equal(ephemeral.disambiguator,separate.value.disambiguator);assert.equal(ephemeral.identity_lifetime,'ephemeral');
 // Case: cannot-resume. Keep diagnostic steps in the shared allowlist.
 step='continue';
 const foreign=await tool('claim_seat',{request_id:'server_foreign_context_1',name:'Other owner agent',lifetime:'durable',workspace_id:input.workspace},await tokenFor(input.foreignOwner,input.foreignGrant));
 assert.equal(foreign.rpc.result.isError,false);assert.equal(foreign.value.outcome,'created');await assertBound(foreign.value,input.foreignOwner,input.foreignGrant);
 const beforeRefusal=(await api.db.unsafe('SELECT count(*)::int AS n FROM swarm.hosted_agent_contexts'))[0].n;
 // Name-only refusal can offer new; a foreign handle gives no binding
 // disclosure. Neither may fall back to a different identity or allocate one.
 for(const [args,canStartNew] of [
  [{name:foreign.value.name},true],
  [{name:separate.value.name},true],
  [{seat:foreign.value.seat},false],
 ]){
  const refused=await call({request_id:crypto.randomUUID(),intent:'continue',workspace_id:input.workspace,...args});
  assert.equal(refused.status,200);assert.equal(refused.rpc.result.isError,true);
  assert.equal(refused.value.error,'identity_resume_unavailable');assert.equal(refused.value.can_start_new,canStartNew);
  for(const field of ['context_id','seat','handle','principal_id'])assert.equal(Object.hasOwn(refused.value,field),false);
 }
 const foreignSelected=await tool('whoami',{seat:foreign.value.seat});
 assert.equal(foreignSelected.rpc.result.isError,true);assert.equal(foreignSelected.value.error,'identity_resume_unavailable');assert.equal(foreignSelected.value.can_start_new,false);
 assert.equal((await api.db.unsafe('SELECT count(*)::int AS n FROM swarm.hosted_agent_contexts'))[0].n,beforeRefusal);
 await assertBound(first.value);await assertBound(continued.value);await assertBound(foreign.value,input.foreignOwner,input.foreignGrant);
 await api.db.unsafe('UPDATE swarm.workspaces SET archived_at=statement_timestamp() WHERE workspace_id=$1',[input.home]);
 const noHome=await call({request_id:'server_missing_home_1'});assert.equal(noHome.rpc.result.isError,true);assert.equal(noHome.value.error,'workspace_unavailable');
 const noHomeDiscovery=await tool('whoami',{});assert.equal(noHomeDiscovery.rpc.result.isError,false);assert.equal(noHomeDiscovery.value.home_workspace_id,null);
 const noHomeContinue=await call({request_id:'server_no_home_continue_1',intent:'continue',seat:first.value.seat});
 assert.equal(noHomeContinue.rpc.result.isError,false);assert.equal(noHomeContinue.value.context_id,first.value.context_id);
 await api.db.begin(async tx=>{
  await tx.unsafe('ALTER TABLE swarm.hosted_agent_contexts DISABLE TRIGGER hosted_context_guard');
  // Shift the actual issued clocks together; retain each kind's idle and
  // absolute intervals so the real close guard sees a valid expired record.
  await tx.unsafe("UPDATE swarm.hosted_agent_contexts SET created_at=created_at-interval '3 days',last_business_at=last_business_at-interval '3 days',idle_expires_at=idle_expires_at-interval '3 days',absolute_expires_at=absolute_expires_at-interval '3 days' WHERE context_id=ANY($1::uuid[])",[ [first.value.context_id,separate.value.context_id] ]);
  await tx.unsafe('ALTER TABLE swarm.hosted_agent_contexts ENABLE TRIGGER hosted_context_guard');
 });
 const expiry={error:'context_expired',message:'This chat identity expired. Start a new identity to continue; shared work is still here.',can_start_new:true};
 for(const [name,args] of [['whoami',{seat:first.value.seat}],['claim_seat',{request_id:'server_expired_handle_1',intent:'continue',seat:first.value.seat}]]){
  const result=await tool(name,args);assert.equal(result.status,200);assert.equal(result.rpc.result.isError,true);assert.deepEqual(result.value,expiry);
 }
 for(const [name,args] of [['object_read',readArgs],['object_create',{...createArgs,request_id:'server_expired_write_1',object_id:crypto.randomUUID()}]]){
  const result=await household(name,args);assert.equal(result.isError,true);assert.deepEqual(result.value,expiry);
 }
 // Case: new-after-expiry. Keep diagnostic steps in the shared allowlist.
 step='separate-claim';
 const beforeNew=(await api.db.unsafe('SELECT count(*)::int AS n FROM swarm.hosted_agent_contexts'))[0].n;
 const fresh=await call({request_id:'server_new_after_expiry_1',name:'Marketing',workspace_id:input.workspace});
 assert.equal(fresh.rpc.result.isError,false);assert.equal(fresh.value.outcome,'created');assert.equal(fresh.value.original_outcome,'created');
 assert.equal(fresh.value.lifetime,'ephemeral');assert.equal(fresh.value.kind,'chat');assert.equal(fresh.value.display_name,'Marketing');
 assert.equal(fresh.value.name_adjusted,true);assert.equal(fresh.value.adjustment_reason,'collision');
 assert.match(fresh.value.disambiguator,/^[A-Z2-7]{4}$/u);assert.equal(fresh.value.name,'Marketing-'+fresh.value.disambiguator);
 for(const existing of [first.value,continued.value,separate.value,separateDurable.value,foreign.value,firstMessage.value])for(const field of ['context_id','seat','seat_id','principal_id'])assert.notEqual(fresh.value[field],existing[field],field);
 assert.equal((await api.db.unsafe('SELECT count(*)::int AS n FROM swarm.hosted_agent_contexts'))[0].n,beforeNew+1);
 await assertBound(fresh.value);
 assert.ok(Date.parse(fresh.value.idle_expires_at)>Date.now());assert.ok(Date.parse(fresh.value.absolute_expires_at)>Date.now());
 for(const old of [first.value,separate.value]){
  const expired=await tool('whoami',{seat:old.seat});assert.equal(expired.rpc.result.isError,true);assert.deepEqual(expired.value,expiry);
 }
 // Case: expiry-close. Keep diagnostic steps in the shared allowlist.
 step='committed-context';
 const closeArgs={seat:first.value.seat,request_id:'server_expired_close_1'};
 const closed=await tool('close_session',closeArgs);assert.equal(closed.rpc.result.isError,false);
 assert.equal(closed.value.outcome,'closed');assert.equal(closed.value.context_id,first.value.context_id);assert.equal(closed.value.principal_state,'retained');assert.ok(closed.value.closed_at);
 const closeReplay=await tool('close_session',closeArgs);assert.equal(closeReplay.rpc.result.isError,false);assert.equal(closeReplay.value.outcome,'replayed');assert.equal(closeReplay.value.closed_at,closed.value.closed_at);
 const closeAgain=await tool('close_session',{...closeArgs,request_id:'server_expired_close_2'});assert.equal(closeAgain.rpc.result.isError,false);assert.equal(closeAgain.value.outcome,'closed');assert.equal(closeAgain.value.closed_at,closed.value.closed_at);
 const closedRead=await tool('whoami',{seat:first.value.seat});assert.equal(closedRead.rpc.result.isError,true);assert.equal(closedRead.value.error,'context_closed');
 const sibling=await tool('whoami',{seat:continued.value.seat});assert.equal(sibling.rpc.result.isError,false);
 assertRetained(await household('object_read',{...readArgs,seat:continued.value.seat}));
 const closedContent=await household('object_read',readArgs);assert.equal(closedContent.isError,true);assert.equal(closedContent.value.error,'context_closed');
 await assertBound(continued.value);await assertBound(fresh.value);
 const retired=await tool('close_session',{seat:separate.value.seat,request_id:'server_ephemeral_close_1'});
 assert.equal(retired.rpc.result.isError,false);assert.equal(retired.value.principal_state,'retired');
 const retiredAgain=await tool('close_session',{seat:separate.value.seat,request_id:'server_ephemeral_close_2'});
 assert.equal(retiredAgain.rpc.result.isError,false);assert.equal(retiredAgain.value.closed_at,retired.value.closed_at);
 const retiredRead=await tool('whoami',{seat:separate.value.seat});assert.equal(retiredRead.rpc.result.isError,true);assert.equal(retiredRead.value.error,'context_closed');
 step='revoked';
 await api.db.unsafe('INSERT INTO commonswarm_oauth.refresh_family_tombstones(grant_id,revoked_at) VALUES($1,statement_timestamp())',['provider-'+input.grant]);
 const denied=await call({request_id:'server_denied_context_1'});assert.equal(denied.rpc.result.isError,true);assert.equal(denied.value.can_start_new,false);
 const deniedDiscovery=await tool('whoami',{});assert.equal(deniedDiscovery.rpc.result.isError,true);assert.equal(deniedDiscovery.value.error,'identity_resume_unavailable');
 const deniedClose=await tool('close_session',{seat:continued.value.seat,request_id:'server_denied_close_1'});
 assert.equal(deniedClose.rpc.result.isError,true);assert.equal(deniedClose.value.error,'identity_resume_unavailable');assert.equal(deniedClose.value.can_start_new,false);
 const siblingState=await api.db.unsafe('SELECT closed_at FROM swarm.hosted_agent_contexts WHERE context_id=$1',[continued.value.context_id]);assert.equal(siblingState[0].closed_at,null);
 step='committed-count';lastFailure=null;httpStatus=null;
 const count=await api.db.unsafe('SELECT count(*)::int AS n FROM swarm.hosted_agent_contexts');assert.equal(count[0].n,7);
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
