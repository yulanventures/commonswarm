import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AGENT_AVATAR_PUBLIC_COMMANDS } from '../src/protocol/index.js';
// @ts-expect-error TS5097: this service-free test imports the Deno source directly.
import { createMcpProtocolHandler } from '../supabase/functions/mcp/protocol.ts';
// @ts-expect-error TS5097: this service-free test imports the Deno source directly.
import { MCP_ISSUER, MCP_RESOURCE } from '../supabase/functions/mcp/auth.ts';

test('every avatar command and worker completion is refused as an MCP tool before execution', async t => {
  t.mock.method(console,'error',()=>undefined);
  const executions: string[] = [];
  const serve = createMcpProtocolHandler({issuer:MCP_ISSUER,resource:MCP_RESOURCE,publicEnabled:true,
    allowedOrigins:new Set(['https://claude.ai']),
    limits:{maxBodyBytes:4096,maxResponseBytes:64*1024,requestTimeoutMs:2000,maxConcurrentRequests:2},
    verifyToken:async()=>({providerGrantId:'fixture',subject:'11111111-1111-4111-8111-111111111111',expiresAt:1900000000}),
    executeTool:async({name})=>{ executions.push(name);return {ok:true}; },
  });
  const call = (name: string) => serve(new Request('https://mcp.commonswarm.com/mcp',{method:'POST',
    headers:{authorization:'Bearer test.jwt.value','content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:{seat:'seat_ABCDEFGHIJKLMNOPQRSTUV'}}}) }));
  assert.equal((await call('whoami')).status,200,'authenticated positive control');
  assert.deepEqual(executions,['whoami']);
  const unknown = await call('not_a_tool');const expected = await unknown.json();assert.equal(unknown.status,400);
  for (const name of [...AGENT_AVATAR_PUBLIC_COMMANDS,'complete_agent_avatar_job']) {
    const response=await call(name);assert.equal(response.status,400,name);assert.deepEqual(await response.json(),expected,name);
  }
  assert.deepEqual(executions,['whoami'],'avatar names never reach execution');
});
