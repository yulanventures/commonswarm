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
step='command-import';
({PostgresError}= (await import('npm:postgres@3.4.9')).default);
api=await import(${JSON.stringify(moduleUrl('command/index.ts'))});
step='output-import';
const output=await import(${JSON.stringify(moduleUrl('mcp/tool-errors.ts'))});
HostedToolFailure=output.HostedToolFailure;
step='protocol-setup';
Deno.env.set('SWARM_MCP_PUBLIC_ENABLED','1');
const key=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
const jwk={...await crypto.subtle.exportKey('jwk',key.publicKey),kid:'fixture-key',alg:'ES256',use:'sig'};
const base64=value=>btoa(String.fromCharCode(...value)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
const encode=value=>base64(new TextEncoder().encode(JSON.stringify(value)));
const now=Math.floor(Date.now()/1000);
const unsigned=encode({alg:'ES256',kid:'fixture-key'})+'.'+encode({iss:'https://mcp.commonswarm.com',
 aud:'https://mcp.commonswarm.com/mcp',sub:input.owner,grant_id:'provider-'+input.grant,scope:'mcp',iat:now,exp:now+300});
const signature=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key.privateKey,new TextEncoder().encode(unsigned));
const token=unsigned+'.'+base64(new Uint8Array(signature));
globalThis.fetch=async target=>{
 assert.equal(String(target),'https://mcp.commonswarm.com/jwks','only synthetic JWKS fetch is allowed');
 return new Response(JSON.stringify({keys:[jwk]}),{headers:{'content-type':'application/json'}});
};
const {handleRequest:serve}=await import(${JSON.stringify(moduleUrl('mcp/index.ts'))});
async function tool(name,args){lastFailure=null;httpStatus=null;
 const response=await serve(new Request('https://mcp.commonswarm.com/mcp',{method:'POST',
 headers:{authorization:'Bearer '+token,'content-type':'application/json'},
 body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})}));
 httpStatus??=response.status;
 const rpc=await response.json();return {status:response.status,rpc,value:rpc.result?JSON.parse(rpc.result.content[0].text):null};}
 const call=args=>tool('claim_seat',args);
 const discovery=await tool('whoami',{});
 assert.equal(discovery.status,200);assert.equal(discovery.rpc.result.isError,false);
 assert.equal(discovery.value.context_status,'unselected');assert.equal(discovery.value.home_workspace_id,input.home);
 assert.equal(discovery.value.owner.user_id,input.owner);assert.equal(discovery.value.app.client_id,'synthetic-app');
 assert.equal(discovery.value.suggested_name,'Agent');assert.equal(discovery.value.next_action,'claim_seat');
 assert.deepEqual(discovery.value.workspaces.map(row=>row.id).sort(),[input.home,input.workspace].sort());
 for(const field of ['seat','handle','principal_id','members','provider_grant_id'])assert.equal(Object.hasOwn(discovery.value,field),false);
 assert.equal((await api.db.unsafe('SELECT count(*)::int AS n FROM swarm.hosted_agent_contexts'))[0].n,0);
 step='first-claim';
 const request={request_id:'server_claim_context_1',name:'Marketing',lifetime:'durable',kind:'scheduled',workspace_id:input.workspace};
 const first=await call(request);assert.equal(first.status,200);assert.equal(first.rpc.result.isError,false);
 assert.equal(first.value.name,'Marketing');assert.equal(first.value.display_name,'Marketing');
 assert.equal(first.value.kind,'scheduled');assert.equal(first.value.lifetime,'durable');
 assert.equal(first.value.assurance,'portable');assert.equal(first.value.seat,first.value.handle);
 assert.equal(first.value.outcome,'created');assert.equal(first.value.original_outcome,'created');
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
 step='continue';
 const continued=await call({request_id:'server_continue_context_1',intent:'continue',name:'Marketing',kind:'task',workspace_id:input.workspace});
 assert.equal(continued.rpc.result.isError,false);assert.equal(continued.value.principal_id,first.value.principal_id);
 assert.notEqual(continued.value.context_id,first.value.context_id);assert.equal(continued.value.kind,'task');
 const retained=await call({request_id:'server_handle_context_1',intent:'continue',seat:first.value.seat});
 assert.equal(retained.rpc.result.isError,false);assert.equal(retained.value.workspace_id,input.workspace);
 assert.equal(retained.value.context_id,first.value.context_id,'handle never falls back to a different home');
 const mismatch=await call({request_id:'server_handle_mismatch_1',intent:'continue',seat:first.value.seat,workspace_id:input.home});
 assert.equal(mismatch.rpc.result.isError,true);assert.equal(mismatch.value.error,'workspace_mismatch');
 step='separate-claim';
 const separate=await call({request_id:'server_new_context_2',name:'Marketing',workspace_id:input.workspace});
 assert.equal(separate.rpc.result.isError,false);assert.equal(separate.value.display_name,'Marketing');
 assert.equal(separate.value.adjustment_reason,'collision');assert.notEqual(separate.value.principal_id,first.value.principal_id);
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
 const created=await tool('object_create',createArgs);assert.equal(created.rpc.result.isError,false);assert.equal(created.value.status,'committed');
 const readArgs={seat:first.value.seat,object_id:objectId};
 const read=await tool('object_read',readArgs);assert.equal(read.rpc.result.isError,false);
 const unknownRead=await tool('object_read',{...readArgs,seat:'seat_ZZZZZZZZZZZZZZZZZZZZZZ'});
 assert.equal(unknownRead.rpc.result.isError,true);assert.equal(unknownRead.value.error,'identity_resume_unavailable');assert.equal(unknownRead.value.can_start_new,false);
 const note=await tool('note',{seat:first.value.seat,request_id:'server_attributed_note_1',body:'Synthetic shared note'});
 assert.equal(note.rpc.result.isError,false);assert.ok(note.value.signal_id);
 const audit=await api.db.unsafe("SELECT context_id,context_details FROM swarm.audit_log WHERE context_id=$1 AND context_details->>'command_id'=$2",
  [first.value.context_id,'server_attributed_note_1']);
 assert.ok(audit.length>0);assert.equal(audit[0].context_details.principal_id,first.value.principal_id);
 assert.equal(audit[0].context_details.workspace_id,input.workspace);assert.equal(audit[0].context_details.client_id,'synthetic-app');
 assert.equal(JSON.stringify(audit).includes(first.value.handle),false);
 const rows=await api.db.begin(async tx=>{
  await tx.unsafe("SELECT set_config('role','swarm_read',true),set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:input.owner,role:'authenticated'})]);
  return await tx.unsafe('SELECT principal_id,name,display_name,disambiguator,identity_lifetime,app,context_activity FROM swarm_read.agent_principals WHERE workspace_id=$1::uuid AND revoked_at IS NULL',[input.workspace]);
 });
 assert.equal(rows.length,2);const durable=rows.find(row=>row.principal_id===first.value.principal_id);
 assert.equal(durable.display_name,'Marketing');assert.equal(durable.identity_lifetime,'durable');
 assert.equal(durable.app.client_id,'synthetic-app');assert.equal(durable.app.display_name,'Agent');
 assert.equal(durable.context_activity.active_contexts,2);assert.ok(durable.context_activity.last_business_at);
 const ephemeral=rows.find(row=>row.principal_id===separate.value.principal_id);
 assert.equal(ephemeral.disambiguator,separate.value.disambiguator);assert.equal(ephemeral.identity_lifetime,'ephemeral');
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
 for(const [name,args] of [['whoami',{seat:first.value.seat}],['object_read',readArgs],['object_create',{...createArgs,request_id:'server_expired_write_1',object_id:crypto.randomUUID()}],['claim_seat',{request_id:'server_expired_handle_1',intent:'continue',seat:first.value.seat}]]){
  const result=await tool(name,args);assert.equal(result.status,200);assert.equal(result.rpc.result.isError,true);assert.deepEqual(result.value,expiry);
 }
 const closeArgs={seat:first.value.seat,request_id:'server_expired_close_1'};
 const closed=await tool('close_session',closeArgs);assert.equal(closed.rpc.result.isError,false);
 assert.equal(closed.value.outcome,'closed');assert.equal(closed.value.context_id,first.value.context_id);assert.equal(closed.value.principal_state,'retained');assert.ok(closed.value.closed_at);
 const closeReplay=await tool('close_session',closeArgs);assert.equal(closeReplay.rpc.result.isError,false);assert.equal(closeReplay.value.outcome,'replayed');assert.equal(closeReplay.value.closed_at,closed.value.closed_at);
 const closeAgain=await tool('close_session',{...closeArgs,request_id:'server_expired_close_2'});assert.equal(closeAgain.rpc.result.isError,false);assert.equal(closeAgain.value.outcome,'closed');assert.equal(closeAgain.value.closed_at,closed.value.closed_at);
 const closedRead=await tool('whoami',{seat:first.value.seat});assert.equal(closedRead.rpc.result.isError,true);assert.equal(closedRead.value.error,'context_closed');
 const sibling=await tool('whoami',{seat:continued.value.seat});assert.equal(sibling.rpc.result.isError,false);
 const shared=await tool('object_read',{...readArgs,seat:continued.value.seat});assert.equal(shared.rpc.result.isError,false,'shared work survives close');
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
 const count=await api.db.unsafe('SELECT count(*)::int AS n FROM swarm.hosted_agent_contexts');assert.equal(count[0].n,3);
 step='cleanup';
} finally {if(api)await api.db.end();}
 console.log('SID_MCP_CLAIM_OK '+JSON.stringify({allocations:3,malformed_refused:true,revoked_refused:true,replay_preserved:true,index_lifecycle:true,expiry_close:true}));
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
    const path = join(directory, 'harness.mjs'); writeFileSync(path, harness, { mode: 0o600 });
    const run = spawnSync('deno', ['run', '--no-lock', '--config', 'supabase/functions/command/deno.json', '--allow-read', '--allow-env', '--allow-net', path],
      { encoding: 'utf8', timeout: 150000, input: JSON.stringify({ database: isolated.url, apiUrl: local.API_URL, anonKey: local.ANON_KEY, owner, workspace, home, grant, consent }) });
    const lines = (run.stdout ?? '').split(/\r?\n/u);
    if (run.status !== 0) {
      // Parse, allowlist and rebuild; never forward a child's stdout line.
      const diagnostic = lines.find(line => line.startsWith(HOSTED_CONTEXT_FAILURE_PREFIX));
      assert.fail(diagnostic === undefined ? rebuildHostedContextDiagnostic({ step: 'child-startup',
        error_code: run.error && 'code' in run.error && run.error.code === 'ETIMEDOUT' ? 'ETIMEDOUT' : 'ChildProcessFailure', sqlstate: null, http_status: null })
        : parseHostedContextDiagnostic(diagnostic));
    }
    const receipt = 'SID_MCP_CLAIM_OK '+JSON.stringify({ allocations: 3, malformed_refused: true, revoked_refused: true, replay_preserved: true, index_lifecycle: true, expiry_close: true });
    assert.ok(lines.includes(receipt), 'real command fixture emitted a sanitized receipt'); console.log(receipt);
  } finally {
    await isolated.close();
    const owned = (path: string) => path === directory && dirname(path) === root && path !== homedir() && path !== '/' && path !== '';
    for (const path of ['', '/', homedir(), root, join(root, 'unowned')]) assert.equal(owned(path), false);
    const resolved = realpathSync(directory); assert.equal(owned(resolved), true);
    execFileSync('rm', ['-r', resolved], { stdio: ['ignore', 'pipe', 'pipe'] });
  }
});
