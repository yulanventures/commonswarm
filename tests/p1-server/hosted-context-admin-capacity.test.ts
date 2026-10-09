/** Real admin adapter, with the production lock-cycle races explicitly deferred. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, realpathSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createClient } from '@supabase/supabase-js';
import { adminEdgeDatabase } from '../support/admin-edge-database.js';
import { repoSql } from '../support/admin-schema-db.js';

const sourceUrl=new URL('../support/admin-routine-server-harness.mjs',import.meta.url);
// Reuse the established consent/OAuth/HTTP fixture read-only. The task limits
// edits to this test; its temporary harness supplies only the capacity scenario.
const setup=readFileSync(sourceUrl,'utf8').split('  if (scenario === "workspace") {')[0]!
  .replace(/(["'])(\.\.?\/[^"']+)\1/gu, (_all,quote,path)=>quote+new URL(path,sourceUrl).href+quote);
const scenario=`
  const first=await call({kind:'admin_create_seat',name:'Admin last durable',model:null,transport:'local'});
  check(first.status===200,'49 durable plus ephemeral admits authorized admin seat');
  const [count]=await db\x60SELECT count(*)::int AS n FROM swarm.agent_principals WHERE workspace_id=\x24{config.workspace}::uuid AND revoked_at IS NULL AND identity_lifetime='durable'\x60;
  check(count.n===50,'committed admin durable count is 50');
  const denied=await call({kind:'admin_create_seat',name:'Admin over capacity',model:null,transport:'local'});
  check(denied.status===403&&denied.body.error==='seat_limit_reached','50 durable refuses same-route admin allocation');
  const [unchanged]=await db\x60SELECT count(*)::int AS n FROM swarm.agent_principals WHERE workspace_id=\x24{config.workspace}::uuid AND revoked_at IS NULL AND identity_lifetime='durable'\x60;
  check(unchanged.n===50,'refusal does not write principal');
  console.log('SID_ADMIN_CAPACITY_OK');
} catch(error) {console.log('SID_ADMIN_CAPACITY_FAILED '+stage);Deno.exitCode=1;} finally {await db.end();}
`;

test('admin_create_seat counts 49 durable plus ephemeral, then refuses 50 durable', {timeout:180000},async()=>{
  const local=JSON.parse(execFileSync('supabase',['status','-o','json'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}));
  for(const target of [local.API_URL,local.DB_URL])assert.ok(['127.0.0.1','localhost','[::1]'].includes(new URL(target).hostname));
  const directory=mkdtempSync(join(process.platform==='darwin'?'/private/tmp':tmpdir(),'anvil-secret.'));chmodSync(directory,0o700);
  const isolated=await adminEdgeDatabase(local.DB_URL);
  const auth=createClient(local.API_URL,local.SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  const users:string[]=[];
  try{
    local.DB_URL=isolated.url;let jwt='';
    for(let i=0;i<2;i++){
      const email=`sid-admin-${randomUUID()}@example.test`,password=randomBytes(32).toString('base64url');
      const created=await auth.auth.admin.createUser({email,password,email_confirm:true});assert.ifError(created.error);assert.ok(created.data.user);
      users.push(created.data.user.id);
      if(i===0){const signed=await auth.auth.signInWithPassword({email,password});assert.ifError(signed.error);assert.ok(signed.data.session);jwt=signed.data.session.access_token;}
      await isolated.db`INSERT INTO auth.users(id,aud,role,email) VALUES(${created.data.user.id}::uuid,'authenticated','authenticated',${email})`;
      await isolated.db`INSERT INTO swarm.users(user_id,display_name) VALUES(${created.data.user.id}::uuid,'SID admin fixture')`;
    }
    const [context]=await isolated.db`SELECT to_regclass('swarm.hosted_agent_contexts') IS NOT NULL AS present`;
    if(!context!.present)await isolated.db.unsafe(repoSql('supabase/migrations/20261006000003_hosted_agent_contexts.sql'));
    const owner=users[0]!,workspace=randomUUID();
    await isolated.db`INSERT INTO swarm.workspaces(workspace_id,name,created_by) VALUES(${workspace}::uuid,'SID capacity',${owner}::uuid)`;
    await isolated.db`INSERT INTO swarm.memberships(workspace_id,user_id,role) VALUES(${workspace}::uuid,${owner}::uuid,'owner')`;
    await isolated.db`INSERT INTO swarm.streams(stream_id,workspace_id,kind) VALUES(${randomUUID()}::uuid,${workspace}::uuid,'workspace')`;
    for(let i=0;i<49;i++)await isolated.db`INSERT INTO swarm.agent_principals(principal_id,workspace_id,owner_user_id,name) VALUES(${randomUUID()}::uuid,${workspace}::uuid,${owner}::uuid,${`durable-${i}`})`;
    await isolated.db`INSERT INTO swarm.agent_principals(principal_id,workspace_id,owner_user_id,name,identity_lifetime,transport,turn_only) VALUES(${randomUUID()}::uuid,${workspace}::uuid,${owner}::uuid,'Ephemeral fixture','ephemeral','hosted_mcp',true)`;
    await isolated.db`INSERT INTO swarm.config(key,value) VALUES('min_client_version','"0.1.0"') ON CONFLICT(key) DO UPDATE SET value=excluded.value`;
    const configPath=join(directory,'config.json'),harnessPath=join(directory,'capacity.mjs');
    writeFileSync(configPath,JSON.stringify({local,owner,workspace,recipient:users[1],jwt}),{mode:0o600});
    writeFileSync(harnessPath,setup+scenario,{mode:0o600});
    const run=spawnSync('deno',['run','--no-lock','--config','supabase/functions/command/deno.json','--allow-read','--allow-env','--allow-net',harnessPath,configPath,'sid-capacity'],{encoding:'utf8',timeout:150000});
    assert.equal(run.status,0,'admin fixture failed; raw credential-bearing output withheld');assert.ok(run.stdout.includes('SID_ADMIN_CAPACITY_OK'));
  }finally{
    for(const user of users)await auth.auth.admin.deleteUser(user);
    await isolated.close();
    const root=realpathSync(process.platform==='darwin'?'/private/tmp':tmpdir());
    const owned=(path:string)=>path===directory&&path!==''&&path!=='/'&&path!==homedir()
      &&dirname(path)===root&&/^anvil-secret\.[A-Za-z0-9]+$/u.test(basename(path));
    for(const refused of ['', '/', homedir(), root, join(root,'unowned')])assert.equal(owned(refused),false,'cleanup refusal control');
    const resolved=realpathSync(directory);assert.equal(owned(resolved),true,'only the exact task-created directory is deletable');
    try{execFileSync('rm',['-r',resolved],{stdio:['ignore','pipe','pipe']});}
    catch(error){
      const refusal=typeof error==='object'&&error!==null&&'stderr' in error
        ? String(error.stderr).trim().split(/\r?\n/u)[0] : 'rm exited without a diagnostic';
      throw new Error(`BLOCKED by rm guard: "${refusal}". To resolve: inspect ${resolved} and the guard log.`);
    }

  }
});
for(const route of ['hosted durable issuance','local issuance']){
  test(`admin last-slot race against ${route}`,{skip:'deferred to C1 build B (required gate)'},()=>{});
}
