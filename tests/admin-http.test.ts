import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cryptoFixture } from './support/admin-oauth-crypto.js';
import { adminManifest } from './support/admin-fixture.js';
// @ts-expect-error TS5097 real shared HTTP entry
import { createAdminHttpHandler } from '../supabase/functions/_shared/admin-http.ts';
import type { AdminAdmission, AdminAuditKind, AdminSecurityReason, AdminInput } from '../supabase/functions/_shared/admin-oauth-auth.ts';

test('admin MCP routes init/list/read/action into authenticated transactions and lists only effective capabilities', async () => {
  const f = await cryptoFixture({ admit: async () => 'accepted', registerNonce: async () => true });
  const token = await f.token(), manifest = adminManifest(Date.now());
  const calls: Array<{ input: AdminInput; kind: AdminAuditKind }> = [];
  const handler = createAdminHttpHandler({ verifier: f.verifier,
    transact: async (input: AdminInput, admission: AdminAdmission, kind: AdminAuditKind) => {
      assert.equal(admission.token.admin_grant_id, f.claims.admin_grant_id);
      calls.push({input,kind}); return { status: 200, body: { grant: manifest } };
    }, securityFailure: async () => { assert.fail('authenticated protocol reached anonymous audit'); },
  }, 'admin_mcp');
  const invoke = async (method: string, params?: unknown) => handler(await f.request(token, 'admin_mcp', { jsonrpc:'2.0', id:1, method, ...(params ? {params} : {}) }));
  assert.equal((await invoke('initialize')).status, 200);
  const list = await (await invoke('tools/list')).json();
  assert.deepEqual(list.result.tools.map((t: {name:string}) => t.name), ['admin_read_metadata']);
  assert.equal((await invoke('tools/call', {name:'admin_read_metadata', arguments:{command_id:'fixed-retry',command:{kind:'admin_read_metadata',grant_id:f.claims.admin_grant_id,resource_kind:'grant',workspace_id:null}}})).status,200);
  assert.equal((await invoke('tools/call', {name:'admin_create_workspace',arguments:{command_id:'fixed-action',command:{kind:'admin_create_workspace',grant_id:f.claims.admin_grant_id,workspace_id:crypto.randomUUID(),name:'Test'}}})).status,200);
  assert.deepEqual(calls.map(c => c.kind), ['init','list','read','action']);
  assert.equal(calls[0]!.input.command && (calls[0]!.input.command as {grant_id:string}).grant_id, f.claims.admin_grant_id);
  assert.equal(calls[2]!.input.command_id, 'fixed-retry');
});

test('admin HTTP nonce response and anonymous audit never trust claimed victims or call authority on authentication failure', async () => {
  const f = await cryptoFixture({admit: async () => 'nonce_required', registerNonce: async () => true}), token = await f.token();
  const reasons: AdminSecurityReason[] = [];
  const handler = createAdminHttpHandler({verifier:f.verifier, transact:async()=>{assert.fail('invalid proof reached authority');}, securityFailure:async reason=>{reasons.push(reason);}},'admin_command');
  const challenge = await handler(await f.request(token, 'admin_command', {owner_user_id:'victim',grant_id:'victim'}));
  assert.equal(challenge.status,401); assert.equal(challenge.headers.get('www-authenticate'),'DPoP error="use_dpop_nonce"');
  assert.match(challenge.headers.get('dpop-nonce')!,/^[A-Za-z0-9_-]{43}$/);
  assert.equal(challenge.headers.get('access-control-expose-headers'),'DPoP-Nonce');
  assert.deepEqual(reasons,['nonce_required']);
  assert.equal((await handler(await f.request(token,'admin_command',{}, {},'Bearer'))).status,401);
  assert.deepEqual(reasons,['nonce_required','invalid_token']);
});

test('admin HTTP refuses unreviewed path aliases and malformed MCP calls have an audited authority refusal', async () => {
  const f=await cryptoFixture({admit:async()=> 'accepted',registerNonce:async()=>true}), token=await f.token();
  const calls: AdminInput[]=[]; const failures: AdminSecurityReason[]=[];
  const handler=createAdminHttpHandler({verifier:f.verifier,transact:async input=>{calls.push(input);return {status:400,body:{error:'invalid_request'}};},securityFailure:async reason=>{failures.push(reason);}},'admin_mcp');
  const req=await f.request(token,'admin_mcp',{method:'tools/call',params:{name:'admin_read_metadata',arguments:{command_id:'attempt',command:{kind:'admin_read_metadata'}}}});
  const response=await handler(req);
  assert.equal(response.status,400); assert.equal(calls[0]!.command,null);
  const alias=new Request('https://api.commonswarm.com/alias',{method:'POST',headers:req.headers,body:'{}'});
  assert.equal((await handler(alias)).status,401); assert.equal(calls.length,1); assert.deepEqual(failures,['invalid_token']);
});

test('authenticated cancellation still reaches the failure audit adapter and oversized output is bounded', async () => {
  const f=await cryptoFixture({admit:async()=> 'accepted',registerNonce:async()=>true}), token=await f.token();
  const calls: Array<{aborted:boolean}> = [];
  const handler=createAdminHttpHandler({verifier:f.verifier,transact:async (_input,_admission,_kind,signal)=>{
    calls.push({aborted:signal.aborted});return {status:503,body:{error:'failed'}};
  },securityFailure:async()=>assert.fail('verified cancellation was anonymously audited')},'admin_command');
  const raw=await f.request(token), abort=new AbortController();abort.abort();
  const cancelled=new Request(raw,{signal:abort.signal});
  assert.equal((await handler(cancelled)).status,503);
  assert.deepEqual(calls,[{aborted:true}]);
  const bounded=createAdminHttpHandler({verifier:f.verifier,transact:async()=>({status:200,body:{data:'x'.repeat(128*1024)}}),securityFailure:async()=>{}},'admin_command');
  const large=await bounded(await f.request(token));
  assert.equal(large.status,503);assert.deepEqual(await large.json(),{error:'response_too_large'});
});
