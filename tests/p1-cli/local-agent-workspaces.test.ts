import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Arguments} from '../../src/cli.js';
import {writeSecureJsonFile} from '../../src/cloud/storage.js';
import {cachedAgentMessage,checkAgentMessages} from '../../src/cloud/agent-check.js';
import {agentWorkspaceStatePath,readAgentProfile} from '../../src/cloud/agent-profile.js';
import {STDIO_MCP_TOOLS,stdioWorkspaceArguments,validateMcpArguments} from '../../src/mcp/tools.js';
import {validateHouseholdToolArguments} from '../../src/protocol/household-tool-registry.js';
import {AGENT_CREDENTIAL_MESSAGE_D088} from '../../src/cloud/agent-credential-input.js';
const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const P='cccccccc-cccc-4ccc-8ccc-cccccccccccc',U='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const M='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

test('profile expansion accepts a per-call workspace, retains credential/home and leaves the saved profile intact',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'s4a-profile-')),path=join(dir,'profile.json'),credential=join(dir,'credential.json');
 try {
  await writeSecureJsonFile(path,JSON.stringify({version:1,url:'https://example.test',anon_key:'public-test',workspace_id:A,principal_id:P,credential_file:credential}));
  await writeSecureJsonFile(credential,JSON.stringify({message:AGENT_CREDENTIAL_MESSAGE_D088,status:'accepted',principal_id:P,token_id:M,run_id:U,agent_token:`swm_agt_${'X'.repeat(43)}`,expires_at:'2099-01-01T00:00:00Z'}));
  const original=await readFile(path,'utf8');
  for(const workspace of [undefined,B]) {
   const args=new Arguments(['whoami','--profile',path,...(workspace?['--workspace-id',workspace]:[])]);
   await args.expandAgentProfile('expand','drop');
   assert.equal(args.optional('workspace-id'),workspace??A);assert.equal(args.optional('agent-token-file'),credential);
   assert.equal(args.expandedProfileHomeWorkspace,A);
  }
  assert.equal(await readFile(path,'utf8'),original);
  const bad=new Arguments(['whoami','--profile',path,'--workspace-id','../../escape']);
  await assert.rejects(()=>bad.expandAgentProfile('expand','drop'),{code:'workspace_id_invalid'});
 } finally {execFileSync('rm',['-rf',dir]);}
});

test('stdio validates workspace selectors before signal and Lists argument validation',()=>{
 for(const invalid of ['',null,7,[],{},'../escape']) assert.throws(()=>stdioWorkspaceArguments({workspace_id:invalid}));
 const selected=stdioWorkspaceArguments({workspace_id:B.toUpperCase()});
 assert.equal(selected.workspaceId,B);
 assert.deepEqual(validateMcpArguments('members',selected.arguments),{});
 const lists=stdioWorkspaceArguments({workspace_id:B,seat:'seat_0000000000000000000000'});
 assert.doesNotThrow(()=>validateHouseholdToolArguments('todo_queue',lists.arguments));
 assert.ok(STDIO_MCP_TOOLS.find(tool=>tool.name==='todo_queue')?.inputSchema.properties.workspace_id);
 assert.deepEqual(stdioWorkspaceArguments({}),{arguments:{}});
});

test('checks and cached messages are isolated by workspace while sharing the same credential',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'s4a-check-')),path=join(dir,'profile.json'),credential=join(dir,'credential.json');
 const previous=process.env.SWARM_AGENT_STATE_DIR;process.env.SWARM_AGENT_STATE_DIR=join(dir,'renewal');
 try {
  await writeSecureJsonFile(path,JSON.stringify({version:1,url:'https://example.test',anon_key:'public-test',workspace_id:A,principal_id:P,credential_file:credential}));
  await writeSecureJsonFile(credential,JSON.stringify({message:AGENT_CREDENTIAL_MESSAGE_D088,status:'accepted',principal_id:P,token_id:M,run_id:U,agent_token:`swm_agt_${'X'.repeat(43)}`,expires_at:'2099-01-01T00:00:00Z'}));
  const fetched:{workspace_id:string;resource?:string;after_id?:string}[]=[];
  const fetcher=(async(_url:unknown,init?:RequestInit)=>{
   const body=JSON.parse(String(init?.body));fetched.push(body);
   const response=body.resource==='members'?{members:[{user_id:U,display_name:'Owner'}],agents:[{principal_id:P,name:'Agent',owner_user_id:U}],identity:{credential_valid:true,principal_id:P,workspace_id:body.workspace_id,owner_user_id:U}}:
    body.resource==='signals'?{signals:body.after_id?[]:[{id:M,workspace_id:body.workspace_id,from:U,from_kind:'user',to:null,to_agent:P,in_reply_to:null,about:null,kind:'note',body:body.workspace_id,created_at:'2026-10-01T00:00:00Z',until:'2099-01-01T00:00:00Z'}],capabilities:{cursor_after:1,sender_owner_relation:1}}:{status:'accepted',ok:true,event_ids:[]};
   return new Response(JSON.stringify(response),{status:200});
  }) as typeof fetch;
  for(const workspaceId of [A,B,A]) await checkAgentMessages({profilePath:path,workspaceId,fetcher,present:async()=>{}});
  assert.deepEqual(fetched.filter(row=>row.resource==='signals').map(row=>[row.workspace_id,row.after_id??null]),[[A,null],[B,null],[A,M]]);
  assert.equal((await cachedAgentMessage(path,M,undefined,B)).body,B);
  assert.equal((await cachedAgentMessage(path,M)).body,A);
  assert.equal((await readAgentProfile(path)).workspace_id,A);
  assert.notEqual(agentWorkspaceStatePath(path,A,A),agentWorkspaceStatePath(path,A,B));
 } finally {if(previous===undefined)delete process.env.SWARM_AGENT_STATE_DIR;else process.env.SWARM_AGENT_STATE_DIR=previous;execFileSync('rm',['-rf',dir]);}
});
