/** Config-read regression at the real command boundary, with migrated role ACLs. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { adminEdgeDatabase } from '../support/admin-edge-database.js';

const commandUrl = new URL('../../supabase/functions/command/index.ts', import.meta.url).href;
const authUrl = new URL('../../supabase/functions/_shared/hosted-seat-auth.ts', import.meta.url).href;
const harness = `
const config=JSON.parse(await new Response(Deno.stdin.readable).text());
Deno.env.set('SWARM_ENV','test');Deno.env.set('SWARM_DATABASE_URL',config.commandDbUrl);
Deno.env.set('SUPABASE_URL',config.apiUrl);Deno.env.set('SUPABASE_ANON_KEY',config.anonKey);
const {db,handleHostedCommand}=await import(${JSON.stringify(commandUrl)});
const {authenticateHostedGrantCapability}=await import(${JSON.stringify(authUrl)});
let step='role';
const check=(condition,label)=>{if(!condition)throw new Error(label);};
try {
  // Startup session_authorization restricts every pool connection, including
  // reconnects. Both the session and effective user must be the migrated role.
  const [role]=await db\x60SELECT current_user AS effective,session_user AS session,
    rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user\x60;
  check(role.effective==='swarm_command'&&role.session==='swarm_command'
    &&!role.rolsuper&&!role.rolbypassrls,'non-superuser command session');
  const [acl]=await db\x60SELECT has_table_privilege(current_user,'swarm.config','SELECT') AS read,
    has_table_privilege(current_user,'swarm.config','UPDATE') AS update,
    has_table_privilege(current_user,'swarm.config','DELETE') AS remove,
    has_table_privilege(current_user,'swarm.config','TRUNCATE') AS truncate\x60;
  check(acl.read&&!acl.update&&!acl.remove&&!acl.truncate,'migrated config grants are read-only');
  const [keys]=await db\x60SELECT hashtext('hosted-context-allocation')<>hashtext('principal-ceiling')
    AND hashtext('hosted-context-allocation')<>hashtext('deployment') AS distinct\x60;
  check(keys.distinct,'global gate differs from variable-namespace ceiling/admission locks');
  step='old-read';
  let denied=false;
  try {
    await db.begin(tx=>tx\x60SELECT value FROM swarm.config
      WHERE key='hosted_context_allocation_enabled' FOR SHARE\x60);
  } catch(error) {if(error.code!=='42501')throw error;denied=true;}
  check(denied,'old locking read must fail with 42501');
  step='plain-read';
  const [gate]=await db\x60SELECT value FROM swarm.config WHERE key='hosted_context_allocation_enabled'\x60;
  check(gate?.value===true,'plain read reaches the enabled fixture gate');
  step='authorize';
  const capability=await db.begin(tx=>authenticateHostedGrantCapability(tx,{
    grantId:config.grant,ownerUserId:config.owner,providerGrantId:config.provider,
    workspaceId:config.workspace,tool:'claim_hosted_seat',providerStatus:async()=>({active:true})}));
  check(capability!==null,'real grant authorization');
  step='claim';
  const result=await handleHostedCommand({command_id:crypto.randomUUID(),client_version:'0.1.80',
    workspace_id:config.workspace,stream:{kind:'workspace'},
    command:{kind:'claim_hosted_seat',name:'Grants regression',lifetime:'durable'}},capability);
  check(result.status===200&&result.body.status==='accepted'&&result.body.outcome==='created','real hosted claim succeeds');
  step='committed-principal';
  // A fresh transaction observes the principal, seat, context and stream event
  // after the command returned, rather than reading uncommitted fixture writes.
  await db.begin(async tx=>{
    const [committed]=await tx\x60SELECT p.principal_id,p.workspace_id,p.owner_user_id,p.name,
      p.transport,p.turn_only,p.identity_lifetime,c.context_id,hs.seat_id
      FROM swarm.agent_principals p JOIN swarm.hosted_mcp_seats hs USING(principal_id)
      JOIN swarm.hosted_agent_contexts c USING(seat_id)
      WHERE p.principal_id=\x24{result.body.principal_id}::uuid\x60;
    check(committed?.workspace_id===config.workspace&&committed.owner_user_id===config.owner
      &&committed.name==='Grants regression'&&committed.transport==='hosted_mcp'
      &&committed.turn_only&&committed.identity_lifetime==='durable'
      &&committed.seat_id===result.body.seat_id&&committed.context_id===result.body.context_id,'committed hosted principal');
    const [event]=await tx\x60SELECT count(*)::int AS n FROM swarm.events
      WHERE workspace_id=\x24{config.workspace}::uuid AND event_id=ANY(\x24{result.body.event_ids}::uuid[])\x60;
    check(result.body.event_ids.length>0&&event.n===result.body.event_ids.length,'committed claim event');
  });
  console.log('SID_PRODUCTION_GRANTS_OK');
} catch(error) {
  // Raw SQL/driver diagnostics may include credentials or fixture parameters.
  const code=typeof error?.code==='string'&&/^[A-Z0-9]{5}$/.test(error.code)?error.code:null;
  console.log('SID_PRODUCTION_GRANTS_FAILED '+JSON.stringify({step,code}));Deno.exitCode=1;
} finally {await db.end();}
`;

test('hosted claim commits under exact migrated swarm_command grants; old config row lock fails', { timeout: 120000 }, async () => {
  const local = JSON.parse(execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }));
  for (const target of [local.API_URL, local.DB_URL]) assert.ok(['127.0.0.1','localhost','[::1]'].includes(new URL(target).hostname));
  const directory = mkdtempSync(join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'anvil-secret.'));
  chmodSync(directory, 0o700);
  let isolated: Awaited<ReturnType<typeof adminEdgeDatabase>> | undefined;
  try {
    // Copy the migrated schema and its ACLs. No role/table/function grants are
    // added by this test; privileged setup only seeds the isolated fixture.
    isolated = await adminEdgeDatabase(local.DB_URL);
    const owner=randomUUID(),workspace=randomUUID(),grant=randomUUID(),provider=`grants-${randomUUID()}`;
    await isolated.db.begin(async tx=>{
      await tx`INSERT INTO auth.users(id,aud,role,email) VALUES(${owner}::uuid,'authenticated','authenticated',${`${owner}@example.test`})`;
      await tx`INSERT INTO swarm.users(user_id,display_name) VALUES(${owner}::uuid,'Grants fixture')`;
      await tx`INSERT INTO swarm.workspaces(workspace_id,name,created_by) VALUES(${workspace}::uuid,'Grants fixture',${owner}::uuid)`;
      await tx`INSERT INTO swarm.memberships(workspace_id,user_id,role) VALUES(${workspace}::uuid,${owner}::uuid,'owner')`;
      await tx`INSERT INTO swarm.streams(stream_id,workspace_id,kind) VALUES(${randomUUID()}::uuid,${workspace}::uuid,'workspace')`;
      await tx`INSERT INTO swarm.hosted_mcp_grants(grant_id,provider_grant_id,owner_user_id,home_workspace_id,client_id,resource,selected_workspace_ids,manifest_digest,interaction_ref,state,created_at,activated_at)
        VALUES(${grant}::uuid,${provider},${owner}::uuid,${workspace}::uuid,'grants-client','https://mcp.commonswarm.com/mcp',${[workspace]}::uuid[],${new Uint8Array(32)},'fixture','active',statement_timestamp(),statement_timestamp())`;
      await tx`INSERT INTO swarm.hosted_mcp_grant_workspaces(grant_id,workspace_id,owner_user_id,manifest_digest,consent_receipt_id,consented_at)
        VALUES(${grant}::uuid,${workspace}::uuid,${owner}::uuid,${new Uint8Array(32)},${randomUUID()}::uuid,statement_timestamp())`;
      await tx`SELECT pg_advisory_xact_lock(1936142700,hashtext('hosted-context-allocation'))`;
      await tx`INSERT INTO swarm.config(key,value) VALUES('hosted_context_allocation_enabled','true'::jsonb)`;
    });
    const restricted = new URL(isolated.url);
    // Keep swarm_command's login settings and migrated grants intact. The local
    // administrator authenticates, then startup drops session authorization
    // before the harness executes any query; no superuser session runs claims.
    restricted.searchParams.set('options','-c session_authorization=swarm_command');
    const path=join(directory,'production-grants.mjs');writeFileSync(path,harness,{mode:0o600});
    const run=spawnSync('deno',['run','--no-lock','--config','supabase/functions/command/deno.json','--allow-read','--allow-env','--allow-net',path],
      {encoding:'utf8',timeout:90000,input:JSON.stringify({commandDbUrl:restricted.toString(),apiUrl:local.API_URL,anonKey:local.ANON_KEY,owner,workspace,grant,provider})});
    const receipt=run.stdout.split(/\r?\n/u).find(line=>/^SID_PRODUCTION_GRANTS_(?:OK|FAILED \{"step":"[a-z-]+","code":(?:null|"[A-Z0-9]{5}")\})$/u.test(line));
    assert.equal(run.status,0,receipt??'grants harness failed; raw credential-bearing output withheld');
    assert.equal(receipt,'SID_PRODUCTION_GRANTS_OK');
  } finally {
    try {await isolated?.close();} finally {
      const root=realpathSync(process.platform==='darwin'?'/private/tmp':tmpdir());
      const owned=(path:string)=>path===directory&&path!==''&&path!=='/'&&path!==homedir()
        &&dirname(path)===root&&/^anvil-secret\.[A-Za-z0-9]+$/u.test(basename(path));
      for(const refused of ['', '/', homedir(), root, join(root,'unowned')])assert.equal(owned(refused),false,'cleanup refusal control');
      const resolved=realpathSync(directory);assert.equal(owned(resolved),true);
      try {execFileSync('rm',['-r',resolved],{stdio:['ignore','pipe','pipe']});}
      catch(error) {
        const refusal=typeof error==='object'&&error!==null&&'stderr' in error
          ? String(error.stderr).trim().split(/\r?\n/u)[0] : 'rm exited without a diagnostic';
        throw new Error(`BLOCKED by rm guard: "${refusal}". To resolve: inspect ${resolved} and the guard log.`);
      }
    }
  }
});
