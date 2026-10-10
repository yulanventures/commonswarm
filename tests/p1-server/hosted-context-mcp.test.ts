/** CI only. Prepared claim route: MCP validation -> actual claim dispatcher ->
 * real capability/transaction -> commandOutput. Full lifecycle dispatch waits
 * for phase 3 and must be added in the completion worktree. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { adminEdgeDatabase } from '../support/admin-edge-database.js';

const moduleUrl = (path: string) => new URL(`../../supabase/functions/${path}`, import.meta.url).href;
const harness = `
import assert from 'node:assert/strict';
const input=JSON.parse(await new Response(Deno.stdin.readable).text());
Deno.env.set('SWARM_ENV','test'); Deno.env.set('SWARM_DATABASE_URL',input.database);
const api=await import(${JSON.stringify(moduleUrl('command/index.ts'))});
const {executeClaimSeat}=await import(${JSON.stringify(moduleUrl('mcp/claim-seat.ts'))});
const {createMcpProtocolHandler}=await import(${JSON.stringify(moduleUrl('mcp/protocol.ts'))});
const {commandOutput}=await import(${JSON.stringify(moduleUrl('mcp/tool-errors.ts'))});
let providerActive=true, dispatches=0;
const serve=createMcpProtocolHandler({issuer:'https://auth.commonswarm.com',resource:'https://mcp.commonswarm.com/mcp',
 publicEnabled:true,allowedOrigins:new Set(),limits:{maxBodyBytes:4096,maxResponseBytes:65536,requestTimeoutMs:10000,maxConcurrentRequests:2},
 verifyToken:async()=>({subject:input.owner,providerGrantId:'provider-'+input.grant,expiresAt:1900000000}),
 executeTool:async call=>commandOutput(await executeClaimSeat(call,{
  withAuthTransaction:async run=>api.db.begin(async tx=>{
   await tx.unsafe("SELECT set_config('role','swarm_command',true),set_config('search_path','swarm,pg_catalog',true)");
   return run(tx);
  }),providerStatus:async()=>({active:providerActive}),
  handleCommand:async (wire,cap)=>{dispatches++;return api.handleHostedCommand(wire,cap);}
 }))});
async function call(args){const response=await serve(new Request('https://mcp.commonswarm.com/mcp',{method:'POST',
 headers:{authorization:'Bearer synthetic.jwt.value','content-type':'application/json'},
 body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'claim_seat',arguments:args}})}));
 const rpc=await response.json();return {status:response.status,rpc,value:rpc.result?JSON.parse(rpc.result.content[0].text):null};}
try {
 const request={request_id:'server_claim_context_1',name:'Marketing',lifetime:'durable',kind:'scheduled'};
 const first=await call(request);assert.equal(first.status,200);assert.equal(first.rpc.result.isError,false);
 assert.equal(first.value.name,'Marketing');assert.equal(first.value.display_name,'Marketing');
 assert.equal(first.value.kind,'scheduled');assert.equal(first.value.lifetime,'durable');
 assert.equal(first.value.assurance,'portable');assert.equal(first.value.seat,first.value.handle);
 assert.equal(first.value.outcome,'created');assert.equal(first.value.original_outcome,'created');
 for(const field of ['context_id','principal_id','seat_id','created_at','last_business_at','idle_expires_at','absolute_expires_at'])assert.ok(first.value[field],field);
 for(const field of ['ok','status','event_ids'])assert.equal(Object.hasOwn(first.value,field),false);
 const replay=await call(request);assert.equal(replay.value.outcome,'replayed');assert.equal(replay.value.context_id,first.value.context_id);
 const continued=await call({request_id:'server_continue_context_1',intent:'continue',name:'Marketing',kind:'task'});
 assert.equal(continued.rpc.result.isError,false);assert.equal(continued.value.principal_id,first.value.principal_id);
 assert.notEqual(continued.value.context_id,first.value.context_id);assert.equal(continued.value.kind,'task');
 const separate=await call({request_id:'server_new_context_2',name:'Marketing'});
 assert.equal(separate.rpc.result.isError,false);assert.equal(separate.value.display_name,'Marketing');
 assert.equal(separate.value.adjustment_reason,'collision');assert.notEqual(separate.value.principal_id,first.value.principal_id);
 const contexts=await api.db.unsafe('SELECT kind,handle FROM swarm.hosted_agent_contexts WHERE context_id=$1::uuid',[first.value.context_id]);
 assert.equal(contexts.length,1);assert.equal(contexts[0].kind,'scheduled');assert.equal(contexts[0].handle,first.value.handle);
 const before=dispatches;
 const invalid=await call({...request,seat:first.value.handle});assert.equal(invalid.status,400);assert.equal(invalid.rpc.error.code,-32602);assert.equal(dispatches,before);
 const conflict=await call({...request,name:'Different'});assert.equal(conflict.rpc.result.isError,true);assert.equal(conflict.value.error,'command_id_conflict');
 providerActive=false;
 const denied=await call({request_id:'server_denied_context_1'});assert.equal(denied.rpc.result.isError,true);assert.equal(denied.value.can_start_new,false);
 const count=await api.db.unsafe('SELECT count(*)::int AS n FROM swarm.hosted_agent_contexts');assert.equal(count[0].n,3);
 console.log('SID_MCP_CLAIM_OK '+JSON.stringify({allocations:3,malformed_refused:true,revoked_refused:true,replay_preserved:true}));
} finally {await api.db.end();}
`;

test('MCP claim context fields, replay and denial survive real command dispatch', { timeout: 180000 }, async () => {
  const local = JSON.parse(execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(local.DB_URL).hostname));
  const isolated = await adminEdgeDatabase(local.DB_URL);
  const root = realpathSync(process.platform === 'darwin' ? '/private/tmp' : tmpdir());
  const directory = mkdtempSync(join(root, 'anvil-secret.')); chmodSync(directory, 0o700);
  try {
    const owner = randomUUID(), workspace = randomUUID(), grant = randomUUID();
    await isolated.db`INSERT INTO auth.users(id,aud,role,email) VALUES(${owner}::uuid,'authenticated','authenticated',${owner+'@example.test'})`;
    await isolated.db`INSERT INTO swarm.users(user_id,display_name) VALUES(${owner}::uuid,'Synthetic owner')`;
    await isolated.db`INSERT INTO swarm.workspaces(workspace_id,name,created_by) VALUES(${workspace}::uuid,'Synthetic workspace',${owner}::uuid)`;
    await isolated.db`INSERT INTO swarm.memberships(workspace_id,user_id,role) VALUES(${workspace}::uuid,${owner}::uuid,'owner')`;
    await isolated.db`INSERT INTO swarm.streams(stream_id,workspace_id,kind) VALUES(${randomUUID()}::uuid,${workspace}::uuid,'workspace')`;
    await isolated.db`INSERT INTO swarm.config(key,value) VALUES('min_client_version','"0.1.0"'),('hosted_context_allocation_enabled','true') ON CONFLICT(key) DO UPDATE SET value=excluded.value`;
    await isolated.db`INSERT INTO swarm.hosted_mcp_grants(grant_id,provider_grant_id,owner_user_id,home_workspace_id,client_id,resource,selected_workspace_ids,manifest_digest,interaction_ref,state,created_at,activated_at)
      VALUES(${grant}::uuid,${'provider-'+grant},${owner}::uuid,${workspace}::uuid,'synthetic-app','https://mcp.commonswarm.com/mcp',${[workspace]}::uuid[],${new Uint8Array(32)},'fixture','active',statement_timestamp(),statement_timestamp())`;
    await isolated.db`INSERT INTO swarm.hosted_mcp_grant_workspaces(grant_id,workspace_id,owner_user_id,manifest_digest,consent_receipt_id,consented_at)
      VALUES(${grant}::uuid,${workspace}::uuid,${owner}::uuid,${new Uint8Array(32)},${randomUUID()}::uuid,statement_timestamp())`;
    const path = join(directory, 'harness.mjs'); writeFileSync(path, harness, { mode: 0o600 });
    const run = spawnSync('deno', ['run', '--no-lock', '--config', 'supabase/functions/command/deno.json', '--allow-read', '--allow-env', '--allow-net', path],
      { encoding: 'utf8', timeout: 150000, input: JSON.stringify({ database: isolated.url, owner, grant }) });
    assert.equal(run.status, 0, 'MCP command fixture failed; raw output withheld');
    const receipt = run.stdout.split(/\r?\n/u).find(line => line.startsWith('SID_MCP_CLAIM_OK '));
    assert.ok(receipt, 'real command fixture emitted a sanitized receipt'); console.log(receipt);
  } finally {
    await isolated.close();
    const owned = (path: string) => path === directory && dirname(path) === root && path !== homedir() && path !== '/' && path !== '';
    for (const path of ['', '/', homedir(), root, join(root, 'unowned')]) assert.equal(owned(path), false);
    const resolved = realpathSync(directory); assert.equal(owned(resolved), true);
    execFileSync('rm', ['-r', resolved], { stdio: ['ignore', 'pipe', 'pipe'] });
  }
});
