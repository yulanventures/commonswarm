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
let roles={current_user:null,session_user:null};
const check=(condition,label)=>{if(!condition)throw new Error(label);};
async function observeRole(tx){
  const [role]=await tx\x60SELECT current_user,session_user,rolsuper,rolbypassrls
    FROM pg_roles WHERE rolname=current_user\x60;
  roles={current_user:role.current_user,session_user:role.session_user};
  check(role.current_user==='swarm_command'&&!role.rolsuper&&!role.rolbypassrls,
    'non-superuser command transaction');
}
async function commandTransaction(callback){
  return await db.begin(async tx=>{
    // Match setTransaction in command/index.ts; session_user remains the
    // authenticated pool user while current_user supplies command privileges.
    await tx\x60SELECT set_config('role','swarm_command',true),
      set_config('search_path','swarm, pg_catalog',true),set_config('lock_timeout','5s',true)\x60;
    await observeRole(tx);
    return await callback(tx);
  });
}
try {
  const [session]=await db\x60SELECT current_user,session_user\x60;
  roles={current_user:session.current_user,session_user:session.session_user};
  await commandTransaction(async tx=>{
    const [acl]=await tx\x60SELECT has_table_privilege(current_user,'swarm.config','SELECT') AS read,
      has_table_privilege(current_user,'swarm.config','UPDATE') AS update,
      has_table_privilege(current_user,'swarm.config','DELETE') AS remove,
      has_table_privilege(current_user,'swarm.config','TRUNCATE') AS truncate\x60;
    check(acl.read&&!acl.update&&!acl.remove&&!acl.truncate,'migrated config grants are read-only');
    const [keys]=await tx\x60SELECT hashtext('hosted-context-allocation')<>hashtext('principal-ceiling')
      AND hashtext('hosted-context-allocation')<>hashtext('deployment') AS distinct\x60;
    check(keys.distinct,'global gate differs from variable-namespace ceiling/admission locks');
  });
  step='old-read';
  let denied=false;
  try {
    await commandTransaction(tx=>tx\x60SELECT value FROM swarm.config
      WHERE key='hosted_context_allocation_enabled' FOR SHARE\x60);
  } catch(error) {if(error.code!=='42501')throw error;denied=true;}
  check(denied,'old locking read must fail with 42501');
  step='plain-read';
  const [gate]=await commandTransaction(tx=>tx\x60SELECT value FROM swarm.config WHERE key='hosted_context_allocation_enabled'\x60);
  check(gate?.value===true,'plain read reaches the enabled fixture gate');
  step='authorize';
  const capability=await commandTransaction(tx=>authenticateHostedGrantCapability(tx,{
    grantId:config.grant,ownerUserId:config.owner,providerGrantId:config.provider,
    workspaceId:config.workspace,tool:'claim_hosted_seat',providerStatus:async()=>({active:true})}));
  check(capability!==null,'real grant authorization');
  step='claim';
  // Observe the real command transaction before commit. This observer never
  // selects a role: the production callback must run setTransaction itself.
  const begin=db.begin.bind(db);
  let observedClaims=0;
  db.begin=(...args)=>{
    const callback=args.pop();
    return begin(...args,async tx=>{
      try {
        const value=await callback(tx);
        await observeRole(tx);observedClaims++;
        return value;
      } catch(error) {
        // An aborted SQL transaction cannot answer another query. Preserve its
        // SQLSTATE and the last observed role instead of masking it with 25P02.
        try {await observeRole(tx);} catch {}
        throw error;
      }
    });
  };
  let result;
  try {
    result=await handleHostedCommand({command_id:crypto.randomUUID(),client_version:'0.1.80',
      workspace_id:config.workspace,stream:{kind:'workspace'},
      command:{kind:'claim_hosted_seat',name:'Grants regression',lifetime:'durable'}},capability);
  } finally {db.begin=begin;}
  check(observedClaims>0,'real command transaction role was observed');
  check(result.status===200&&result.body.status==='accepted'&&result.body.outcome==='created','real hosted claim succeeds');
  // Return only public identifiers for the fixture connection's committed read.
  console.log('SID_PRODUCTION_GRANTS_RESULT '+JSON.stringify({principal_id:result.body.principal_id,
    seat_id:result.body.seat_id,context_id:result.body.context_id,event_ids:result.body.event_ids}));
  console.log('SID_PRODUCTION_GRANTS_OK');
} catch(error) {
  // Raw SQL/driver diagnostics may include credentials or fixture parameters.
  const code=typeof error?.code==='string'&&/^[A-Z0-9]{5}$/.test(error.code)?error.code:null;
  console.log('SID_PRODUCTION_GRANTS_FAILED '+JSON.stringify({step,code,...roles}));Deno.exitCode=1;
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
    // added by this test; the privileged connection seeds and verifies the fixture.
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
    const path=join(directory,'production-grants.mjs');writeFileSync(path,harness,{mode:0o600});
    const run=spawnSync('deno',['run','--no-lock','--config','supabase/functions/command/deno.json','--allow-read','--allow-env','--allow-net',path],
      {encoding:'utf8',timeout:90000,input:JSON.stringify({commandDbUrl:isolated.url,apiUrl:local.API_URL,anonKey:local.ANON_KEY,owner,workspace,grant,provider})});
    const receipt=run.stdout.split(/\r?\n/u).find(line=>/^SID_PRODUCTION_GRANTS_(?:OK|FAILED \{"step":"[a-z-]+","code":(?:null|"[A-Z0-9]{5}"),"current_user":(?:null|"[a-zA-Z0-9_]+"),"session_user":(?:null|"[a-zA-Z0-9_]+")\})$/u.test(line));
    assert.equal(run.status,0,receipt??'grants harness failed; raw credential-bearing output withheld');
    assert.equal(receipt,'SID_PRODUCTION_GRANTS_OK');
    let step='committed-result';
    let roles: { current_user: string | null; session_user: string | null }={current_user:null,session_user:null};
    try {
      const resultLine=run.stdout.split(/\r?\n/u).find(line=>line.startsWith('SID_PRODUCTION_GRANTS_RESULT '));
      let result: { principal_id: string; seat_id: string; context_id: string; event_ids: string[] } | undefined;
      try {result=JSON.parse(resultLine?.slice('SID_PRODUCTION_GRANTS_RESULT '.length)??'');} catch {}
      const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
      assert.ok(result&&uuid.test(result.principal_id)&&uuid.test(result.seat_id)&&uuid.test(result.context_id)
        &&Array.isArray(result.event_ids)&&result.event_ids.every(id=>typeof id==='string'&&uuid.test(id)),
        'grants harness must return valid committed identifiers; raw output withheld');
      step='committed-role';
      // Read after the real command returned, using the same privileged
      // connection as setup: swarm_command can append events, but cannot read them.
      await isolated.db.begin(async tx=>{
        const [role]=await tx<{ current_user: string; session_user: string }[]>`SELECT current_user,session_user`;
        roles={current_user:role!.current_user,session_user:role!.session_user};
        step='committed-principal';
        const [committed]=await tx`SELECT p.principal_id,p.workspace_id,p.owner_user_id,p.name,
          p.transport,p.turn_only,p.identity_lifetime,c.context_id,hs.seat_id
          FROM swarm.agent_principals p JOIN swarm.hosted_mcp_seats hs USING(principal_id)
          JOIN swarm.hosted_agent_contexts c USING(seat_id)
          WHERE p.principal_id=${result.principal_id}::uuid`;
        assert.ok(committed?.workspace_id===workspace&&committed.owner_user_id===owner
          &&committed.name==='Grants regression'&&committed.transport==='hosted_mcp'
          &&committed.turn_only&&committed.identity_lifetime==='durable'
          &&committed.seat_id===result.seat_id&&committed.context_id===result.context_id,'committed hosted principal');
        step='committed-event';
        const [event]=await tx`SELECT count(*)::int AS n FROM swarm.events
          WHERE workspace_id=${workspace}::uuid AND event_id=ANY(${result.event_ids}::uuid[])`;
        assert.ok(result.event_ids.length>0&&event!.n===result.event_ids.length,'committed claim event');
      });
    } catch(error) {
      const rawCode=typeof error==='object'&&error!==null&&'code' in error?error.code:null;
      const code=typeof rawCode==='string'&&/^[A-Z0-9]{5}$/u.test(rawCode)?rawCode:null;
      assert.fail('SID_PRODUCTION_GRANTS_FAILED '+JSON.stringify({step,code,...roles}));
    }
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
