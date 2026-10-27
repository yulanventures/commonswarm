/** Migrated hosted authority, with real legacy/grandfathered rows and command entrypoints. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runSql,repoSql,dbAssert,refuses} from '../support/admin-schema-db.js';
import {releaseCatalogQuery} from '../support/release-catalog-query.js';
import {adminEdgeDatabase} from '../support/admin-edge-database.js';
const root='deploy/release-proofs/agents/20261028000003';
const migration='supabase/migrations/20261028000003_hosted_agent_workspaces.sql';
const catalog=(rollback=false)=>dbAssert(releaseCatalogQuery(repoSql(`${root}-${rollback?'rollback-catalog':'catalog'}.sql`),rollback?'rollback_ok':'catalog_ok').trim().replace(/;$/,''),'hosted agents catalog');
const legacy=()=>repoSql('tests/fixtures/hosted-agent-workspaces-before.sql')+repoSql('supabase/migrations/20261025000001_permanence_grandfather.sql');

test('hosted migration backfills exact identities, preserves grandfathered consent/handles, fences removal and keeps dormant families',()=>{
 runSql(catalog()+repoSql(`${root}-rollback.sql`)+catalog(true)+legacy()+repoSql(migration)+catalog()
  +repoSql('tests/fixtures/hosted-agent-workspaces.sql')+repoSql(`${root}-functional.sql`)+refuses(repoSql(`${root}-rollback.sql`),'55000'));
});

test('hosted migration rollback/reapply preserves the prior authority catalog and reserve bytes',()=>{
 for(const suffix of ['catalog','functional','rollback','rollback-catalog']) {
  const name=`20261028000003-${suffix}.sql`;
  assert.deepEqual(readFileSync(`supabase/agents-reserve/${name}`),readFileSync(`deploy/release-proofs/agents/${name}`));
 }
 runSql(catalog()+repoSql(`${root}-rollback.sql`)+catalog(true)+repoSql(migration)+catalog());
});

const A='13000000-0000-4000-8000-000000000001',B='13000000-0000-4000-8000-000000000002';
const P='23000000-0000-4000-8000-000000000001',U='03000000-0000-4000-8000-000000000001',G='33000000-0000-4000-8000-000000000001';

test('real hosted commands add without OAuth, claim the same agent, replay safely and preserve sibling/dormant connections',async()=>{
 const local=JSON.parse(execFileSync('supabase',['status','-o','json'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}));
 const isolated=await adminEdgeDatabase(local.DB_URL);
 const dir=mkdtempSync(join(tmpdir(),'hosted-agent-commands-'));
 try {
  await isolated.db.unsafe(repoSql(`${root}-rollback.sql`)+legacy()+repoSql(migration));
  await isolated.db`INSERT INTO swarm.config(key,value) VALUES('min_client_version','"0.1.0"') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`;
  const commandUrl=new URL('../../supabase/functions/command/index.ts',import.meta.url).href;
  const authUrl=new URL('../../supabase/functions/_shared/hosted-seat-auth.ts',import.meta.url).href;
  const harness=join(dir,'commands.ts');
  writeFileSync(harness,`
import assert from 'node:assert/strict';
const {db,handleHostedCommand,handleHostedManagementCommand}=await import(${JSON.stringify(commandUrl)});
const {authenticateHostedGrantCapability,authenticateHostedSeatCapability}=await import(${JSON.stringify(authUrl)});
const A=${JSON.stringify(A)},B=${JSON.stringify(B)},P=${JSON.stringify(P)},U=${JSON.stringify(U)},G=${JSON.stringify(G)};
const human={userId:U,email:null,displayName:'Hosted owner',identityVerified:true,interactiveAuthAtSeconds:null};
const manage=(workspace,add)=>handleHostedManagementCommand({command_id:crypto.randomUUID(),client_version:'0.1.83',workspace_id:workspace,stream:{kind:'workspace'},command:{kind:add?'add_agent_to_workspace':'remove_agent_from_workspace',principal_id:P}},human);
async function claim(workspace,id=crypto.randomUUID()) {
 const cap=await db.begin(tx=>authenticateHostedGrantCapability(tx,{grantId:G,ownerUserId:U,providerGrantId:'hosted-workspace-family',workspaceId:workspace,tool:'claim_hosted_seat',providerStatus:async()=>({active:true})}));
 return cap ? handleHostedCommand({command_id:id,client_version:'0.1.83',workspace_id:workspace,stream:{kind:'workspace'},command:{kind:'claim_hosted_seat',agent_id:P}},cap) : {status:403};
}
try {
 assert.equal((await claim(B)).status,403);
 assert.equal((await manage(B,true)).status,200);
 // Discover and revoke a human-added binding before it has a seat.
 await db\x60UPDATE swarm.memberships SET role='owner' WHERE workspace_id=\x24{B}::uuid AND user_id='03000000-0000-4000-8000-000000000002'\x60;
 const removal=await handleHostedManagementCommand({command_id:crypto.randomUUID(),client_version:'0.1.83',workspace_id:B,stream:{kind:'workspace'},command:{kind:'remove_member',user_id:U}}, {...human,userId:'03000000-0000-4000-8000-000000000002'});
 assert.equal(removal.status,200);
 await db\x60UPDATE swarm.memberships SET revoked_at=NULL WHERE workspace_id=\x24{B}::uuid AND user_id=\x24{U}::uuid\x60;
 assert.equal((await claim(B)).status,403);
 assert.equal((await manage(B,true)).status,200);
 const id=crypto.randomUUID(),first=await claim(B,id);assert.equal(first.status,200);assert.equal(first.body.principal_id,P);
 assert.notEqual(first.body.handle,'seat_'+'a'.repeat(24));
 assert.equal(first.body.context.connection.reachable_workspaces.length,2);
 const replay=await claim(B,id);assert.equal(replay.status,200);assert.equal(replay.body.handle,first.body.handle);
 const noteCapability=await db.begin(tx=>authenticateHostedSeatCapability(tx,{grantId:G,providerGrantId:'hosted-workspace-family',handle:first.body.handle,tool:'note',providerStatus:async()=>({active:true})},'command'));assert.ok(noteCapability);
 const post=()=>handleHostedCommand({command_id:crypto.randomUUID(),client_version:'0.1.83',workspace_id:B,stream:{kind:'workspace'},command:{kind:'post_signal',signal_kind:'note',body:'Hosted sibling proof',to_user_id:null,to_agent_principal_id:null,in_reply_to:null,about:null}},noteCapability);
 assert.equal((await post()).status,200);
 assert.equal((await manage(B,false)).status,200);assert.equal((await claim(B,id)).status,403);assert.equal((await post()).status,403);
 const [a]=await db\x60SELECT * FROM swarm.resolve_hosted_seat_read_authorization(\x24{G}::uuid,\x24{'seat_'+'a'.repeat(24)},'whoami')\x60;assert.equal(a.principal_id,P);
 assert.equal((await manage(A,false)).status,200);
 const [family]=await db\x60SELECT active FROM commonswarm_oauth.resolve_hosted_grant_status('hosted-workspace-family')\x60;assert.equal(family.active,true);
 assert.equal((await manage(B,true)).status,200);
 const restored=await claim(B);assert.equal(restored.status,200);assert.equal(restored.body.principal_id,P);assert.notEqual(restored.body.handle,first.body.handle);
 const [old]=await db\x60SELECT * FROM swarm.resolve_hosted_seat_read_authorization(\x24{G}::uuid,\x24{first.body.handle},'whoami')\x60;assert.equal(old,undefined);
 console.log('HOSTED_AGENT_COMMANDS_PASS');
} finally {await db.end();}
`);
  const result=spawnSync('deno',['run','--no-lock','--config','supabase/functions/command/deno.json','--allow-env','--allow-net','--allow-read',harness],{
   encoding:'utf8',timeout:90000,env:{...process.env,SWARM_ENV:'test',SWARM_MCP_PUBLIC_ENABLED:'1',SWARM_DATABASE_URL:isolated.url,
    SUPABASE_DB_URL:isolated.url,SUPABASE_URL:local.API_URL,SUPABASE_ANON_KEY:local.ANON_KEY},
  });
  assert.equal(result.status,0,`hosted command harness failed: ${result.stderr}`);
  assert.match(result.stdout,/HOSTED_AGENT_COMMANDS_PASS/);
 } finally {await isolated.close();rmSync(dir,{recursive:true,force:true});}
});
