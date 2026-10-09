/** Phase-1 transaction/accounting proofs. Run only in the authorized server CI gate. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createClient } from '@supabase/supabase-js';
import type postgres from 'postgres';
import { adminEdgeDatabase } from '../support/admin-edge-database.js';
import { repoSql } from '../support/admin-schema-db.js';
import { releaseCatalogQuery } from '../support/release-catalog-query.js';

const commandUrl = new URL('../../supabase/functions/command/index.ts', import.meta.url).href;
const authUrl = new URL('../../supabase/functions/_shared/hosted-seat-auth.ts', import.meta.url).href;

async function relocateIncomingSeatFk(tx: postgres.TransactionSql) {
  const [fk]=await tx`SELECT conname FROM pg_constraint WHERE conrelid='swarm.hosted_mcp_check_batches'::regclass AND confrelid='swarm.hosted_mcp_seats'::regclass`;
  assert.ok(fk);
  await tx`ALTER TABLE swarm.hosted_mcp_check_batches DROP CONSTRAINT ${tx(fk!.conname as string)}`;
  // Keep the total and every FK definition unchanged, but put two on handles
  // and none on batches. A count plus one-way definition check misses this.
  await tx.unsafe(`ALTER TABLE swarm.hosted_mcp_seat_handles ADD CONSTRAINT sid_relocated_hosted_seat_fk
    FOREIGN KEY (seat_id,grant_id,workspace_id,principal_id)
    REFERENCES swarm.hosted_mcp_seats(seat_id,grant_id,workspace_id,principal_id)`);
}
const harness = `
const config=JSON.parse(await new Response(Deno.stdin.readable).text());
Deno.env.set('SWARM_ENV','test');Deno.env.set('SWARM_DATABASE_URL',config.local.DB_URL);
Deno.env.set('SUPABASE_URL',config.local.API_URL);Deno.env.set('SUPABASE_ANON_KEY',config.local.ANON_KEY);
const {db,handleHostedCommand,handleRequest}=await import(${JSON.stringify(commandUrl)});
const {authenticateHostedGrantCapability}=await import(${JSON.stringify(authUrl)});
const id=()=>crypto.randomUUID();
let assertions=0;const check=(condition,label)=>{assertions++;if(!condition)throw new Error(label);};
const owner=config.owner, other=config.other, client='sid-exact-registered-client';
async function space(){const w=id();await db\x60INSERT INTO swarm.workspaces(workspace_id,name,created_by) VALUES(\x24{w}::uuid,'SID fixture',\x24{owner}::uuid)\x60;
await db\x60INSERT INTO swarm.memberships(workspace_id,user_id,role) VALUES(\x24{w}::uuid,\x24{owner}::uuid,'owner'),(\x24{w}::uuid,\x24{other}::uuid,'member')\x60;
await db\x60INSERT INTO swarm.streams(stream_id,workspace_id,kind) VALUES(\x24{id()}::uuid,\x24{w}::uuid,'workspace')\x60;return w;}
async function grant(workspaces,who=owner,registered=client){const g=id();
await db\x60INSERT INTO swarm.hosted_mcp_grants(grant_id,provider_grant_id,owner_user_id,home_workspace_id,client_id,resource,selected_workspace_ids,manifest_digest,interaction_ref,state,created_at,activated_at)
VALUES(\x24{g}::uuid,\x24{'provider-'+g},\x24{who}::uuid,\x24{workspaces[0]}::uuid,\x24{registered},'https://mcp.commonswarm.com/mcp',\x24{workspaces}::uuid[],\x24{new Uint8Array(32)},'fixture','active',statement_timestamp(),statement_timestamp())\x60;
for(const w of workspaces)await db\x60INSERT INTO swarm.hosted_mcp_grant_workspaces(grant_id,workspace_id,owner_user_id,manifest_digest,consent_receipt_id,consented_at)
VALUES(\x24{g}::uuid,\x24{w}::uuid,\x24{who}::uuid,\x24{new Uint8Array(32)},\x24{id()}::uuid,statement_timestamp())\x60;return g;}
async function claim(g,w,args={},request=id(),who=owner){const cap=await db.begin(tx=>authenticateHostedGrantCapability(tx,{grantId:g,ownerUserId:who,providerGrantId:'provider-'+g,workspaceId:w,tool:'claim_hosted_seat',providerStatus:async()=>({active:true})}));
check(cap!==null,'claim authorization positive control');return await handleHostedCommand({command_id:request,client_version:'0.1.80',workspace_id:w,stream:{kind:'workspace'},command:{kind:'claim_hosted_seat',...args}},cap);}
async function local(w,name){const r=await handleRequest(new Request('http://127.0.0.1/functions/v1/command',{method:'POST',headers:{authorization:'Bearer '+config.jwt,'content-type':'application/json'},body:JSON.stringify({command_id:id(),client_version:'0.1.80',workspace_id:w,stream:{kind:'workspace'},command:{kind:'create_agent_principal',name}})}));return {status:r.status,body:await r.json()};}
async function durable(w,n){for(let i=0;i<n;i++)await db\x60INSERT INTO swarm.agent_principals(principal_id,workspace_id,owner_user_id,name) VALUES(\x24{id()}::uuid,\x24{w}::uuid,\x24{owner}::uuid,\x24{'local-'+i})\x60;}
async function count(w){return (await db\x60SELECT count(*)::int AS n FROM swarm.agent_principals WHERE workspace_id=\x24{w}::uuid AND revoked_at IS NULL AND identity_lifetime='durable'\x60)[0].n;}
try {
const w=await space(),g=await grant([w]);
check((await claim(g,w)).body.error==='identity_allocation_disabled','false gate refuses new');
await db\x60UPDATE swarm.config SET value='{}'::jsonb WHERE key='hosted_context_allocation_enabled'\x60;
check((await claim(g,w)).body.error==='identity_allocation_disabled','malformed gate refuses new');
await db\x60DELETE FROM swarm.config WHERE key='hosted_context_allocation_enabled'\x60;
check((await claim(g,w)).body.error==='identity_allocation_disabled','missing gate refuses new');
await db\x60INSERT INTO swarm.config(key,value) VALUES('hosted_context_allocation_enabled','true')\x60;
const [a,b]=await Promise.all([claim(g,w),claim(g,w)]);
check(a.status===200&&b.status===200,'default allocations accepted');
check(a.body.principal_id!==b.body.principal_id&&a.body.context_id!==b.body.context_id&&a.body.handle!==b.body.handle,'default-new cannot reuse');
check(a.body.lifetime==='ephemeral'&&a.body.name.startsWith('Agent-')&&a.body.assurance==='portable','server allocation defaults');
check((await db\x60SELECT bool_and(n=1) AS valid FROM (SELECT count(*) AS n FROM swarm.hosted_agent_contexts c JOIN swarm.hosted_mcp_seats hs USING(seat_id) JOIN swarm.agent_principals p USING(principal_id) WHERE p.identity_lifetime='ephemeral' GROUP BY p.principal_id) counts\x60)[0].valid,'concurrent ephemeral allocations each have one context');
check((await claim(g,w,{intent:'continue',name:a.body.name})).body.error==='identity_resume_unavailable','ephemeral exact-name continuation never allocates a second context');
// Exercise the internal entry, bypassing MCP parsing. A rejected runtime record
// must return before db.begin, not merely roll back after a SQL cast fails.
const validationCap=await db.begin(tx=>authenticateHostedGrantCapability(tx,{grantId:g,ownerUserId:owner,providerGrantId:'provider-'+g,workspaceId:w,tool:'claim_hosted_seat',providerStatus:async()=>({active:true})}));
for(const [field,value,route] of [
 ['intent','new',{}],['name','Validation control',{}],['seat',a.body.handle,{intent:'continue'}],
 ['lifetime','ephemeral',{}],['context_kind','task',{}],['parent_context',a.body.context_id,{}],
 ['command_id',id(),{}],['workspace_id',w,{}]
]){
 const envelope=()=>({command_id:id(),client_version:'0.1.80',workspace_id:w,stream:{kind:'workspace'},command:{kind:'claim_hosted_seat',...route}});
 const set=(body,v)=>{if(field==='command_id'||field==='workspace_id')body[field]=v;else body.command[field]=v;return body;};
 check((await handleHostedCommand(set(envelope(),value),validationCap)).status===200,'valid internal '+field+' same-route control');
 const begin=db.begin;let databaseCalls=0;
 try{
  db.begin=()=>{databaseCalls++;throw new Error('invalid input reached database');};
  for(const malformed of [[value],123,{value},null]){
   const refused=await handleHostedCommand(set(envelope(),malformed),validationCap);
   check(refused.status===400&&refused.body.error==='invalid_request','malformed internal '+field+' validation');
  }
  check(databaseCalls===0,'malformed internal '+field+' performs no database work');
 }finally{db.begin=begin;}
}
const outside=await space();
const missingConsent=await db.begin(tx=>authenticateHostedGrantCapability(tx,{grantId:g,ownerUserId:owner,providerGrantId:'provider-'+g,workspaceId:outside,tool:'claim_hosted_seat',providerStatus:async()=>({active:true})}));
check(missingConsent===null,'nonconsented workspace cannot redirect allocation');
const wrongOwner=await db.begin(tx=>authenticateHostedGrantCapability(tx,{grantId:g,ownerUserId:other,providerGrantId:'provider-'+g,workspaceId:w,tool:'claim_hosted_seat',providerStatus:async()=>({active:true})}));
check(wrongOwner===null,'subject mismatch refuses authority');
check((await claim(g,w,{parent_context:a.body.context_id})).status===200,'same-grant known parent reference control');
const unrelatedGrant=await grant([w]);
check((await claim(unrelatedGrant,w,{parent_context:a.body.context_id})).body.error==='identity_resume_unavailable','parent reference cannot cross grants');
const request=id(),args={name:'Marketing',lifetime:'durable'};
const d=await claim(g,w,args,request), replay=await claim(g,w,args,request),conflict=await claim(g,w,{...args,name:'changed'},request);
check(d.status===200&&replay.body.outcome==='replayed'&&d.body.context_id===replay.body.context_id,'exact replay same context');
check(conflict.status===409&&conflict.body.error==='command_id_conflict','changed payload conflicts');
const resumed=await claim(g,w,{name:'Marketing',intent:'continue'});
check(resumed.status===200&&resumed.body.principal_id===d.body.principal_id&&resumed.body.context_id!==d.body.context_id&&resumed.body.handle!==d.body.handle,'Q1 fresh context on durable seat');
const newNamed=await claim(g,w,{name:'Marketing',lifetime:'durable'});
check(newNamed.status===200&&newNamed.body.principal_id!==d.body.principal_id&&newNamed.body.adjustment_reason==='collision','new name collision stays fresh');
const foreign=await grant([w],other),foreignDenied=await claim(foreign,w,{name:'Marketing',intent:'continue'},id(),other);
check(foreignDenied.body.error==='identity_resume_unavailable','foreign continuation refuses');
check((await local(w,'Local reserved')).status===200,'local same-route positive control');
check((await claim(g,w,{name:'Local reserved',intent:'continue'})).body.error==='identity_resume_unavailable','local cannot be adopted');
const foreignPrincipal=id();await db\x60INSERT INTO swarm.agent_principals(principal_id,workspace_id,owner_user_id,name,revoked_at) VALUES(\x24{foreignPrincipal}::uuid,\x24{w}::uuid,\x24{other}::uuid,'Foreign reserved',statement_timestamp())\x60;
check((await claim(g,w,{name:'Foreign reserved',lifetime:'durable'})).body.adjustment_reason==='collision','foreign revoked name stays reserved');
const before=d.body.last_business_at;
await db\x60UPDATE swarm.hosted_agent_contexts SET last_business_at=statement_timestamp()-interval '3 days',created_at=statement_timestamp()-interval '3 days',idle_expires_at=statement_timestamp()-interval '2 days' WHERE context_id=\x24{d.body.context_id}::uuid\x60;
check((await claim(g,w,args,request)).body.error==='context_expired','expired replay cannot resurrect');
check((await claim(g,w,{intent:'continue',seat:d.body.handle})).body.error==='context_expired','expired handle cannot select replacement');
for(const kind of ['chat','task','scheduled','subagent']){const r=await claim(g,w,{context_kind:kind});check(r.status===200&&r.body.kind===kind,'kind clock allocation');}
// Same-owner succession needs a persisted expired provider Grant, not a missing row.
const old=await grant([w]),successor=await grant([w]),legacy=await claim(old,w,{name:'Successor',lifetime:'durable'});
check((await claim(successor,w,{intent:'continue',name:'Successor'})).body.error==='identity_resume_unavailable','absent predecessor artifact is not expiry');
await db\x60INSERT INTO commonswarm_oauth.provider_artifacts(model,artifact_id_hash,payload,expires_at,created_at,updated_at)
VALUES('Grant',rtrim(translate(encode(sha256(convert_to(\x24{'provider-'+old},'UTF8')),'base64'),'+/','-_'),'='),\x24{db.json({accountId:owner,clientId:client})},statement_timestamp()-interval '1 second',statement_timestamp(),statement_timestamp())\x60;
for(let i=0;i<24;i++)check((await claim(successor,w)).status===200,'successor grant below-cap control');
check((await claim(successor,w,{intent:'continue',name:'Successor'})).body.error==='session_capacity_reached','succession cannot exceed 25 by inheriting predecessor contexts');
await db\x60UPDATE swarm.hosted_agent_contexts SET created_at=statement_timestamp()-interval '3 days',last_business_at=statement_timestamp()-interval '3 days',idle_expires_at=statement_timestamp()-interval '2 days' WHERE context_id=\x24{legacy.body.context_id}::uuid\x60;
const succession=await claim(successor,w,{intent:'continue',name:'Successor'});
check(succession.status===200&&succession.body.principal_id===legacy.body.principal_id,'proven expired Q3 successor');
check((await db\x60SELECT count(*)::int AS n FROM swarm.hosted_agent_contexts c JOIN swarm.hosted_mcp_seats hs USING(seat_id) WHERE hs.grant_id=\x24{successor}::uuid AND c.closed_at IS NULL AND c.idle_expires_at>statement_timestamp() AND c.absolute_expires_at>statement_timestamp()\x60)[0].n===25,'committed successor active count stays 25');
check((await db\x60SELECT idle_expires_at<statement_timestamp() AS expired FROM swarm.hosted_agent_contexts WHERE context_id=\x24{legacy.body.context_id}::uuid\x60)[0].expired,'succession preserves old expired context');
check((await db\x60SELECT grant_id FROM swarm.hosted_mcp_seats WHERE seat_id=\x24{legacy.body.seat_id}::uuid\x60)[0].grant_id===successor,'atomic seat rebind');
check((await db\x60SELECT count(*)::int AS n FROM swarm.audit_log WHERE reason='hosted_grant_succession' AND detail::jsonb->>'grant_succession'='true'\x60)[0].n===1,'succession audit');
// Last durable slot: hosted and local share the same ceiling locks.
for(let iteration=0;iteration<3;iteration++){const rw=await space(),rg=await grant([rw]);await durable(rw,49);
check((await claim(rg,rw)).status===200,'ephemeral accepted at durable boundary');
const race=await Promise.all([claim(rg,rw,{name:'Hosted last',lifetime:'durable'}),local(rw,'Local last')]);
check(race.filter(r=>r.status===200).length===1,'exactly one last-slot winner');
check(race.some(r=>r.body.error==='principal_limit_reached'),'last-slot loser existing ceiling error');
check(await count(rw)===50,'committed durable count is 50');
check((await claim(rg,rw,{name:'Over cap',lifetime:'durable'})).body.error==='principal_limit_reached','50 durable refuses');}
// Name race: both intents remain separate and every exact public address is unique.
const nw=await space(),ng=await grant([nw]);const names=await Promise.all([claim(ng,nw,{name:'Race',lifetime:'durable'}),local(nw,'Race')]);
check(names.some(r=>r.status===200),'name race positive control');
check((await db\x60SELECT count(*)::int AS n FROM (SELECT name FROM swarm.agent_principals WHERE workspace_id=\x24{nw}::uuid AND revoked_at IS NULL GROUP BY name HAVING count(*)>1) duplicates\x60)[0].n===0,'local/hosted exact names cannot collide');
// Active grant cap and unswept expired exclusion, including durable continuation.
const cw=await space(),cg=await grant([cw]);const durableSeat=await claim(cg,cw,{name:'Capacity',lifetime:'durable'});
for(let i=1;i<25;i++)check((await claim(cg,cw)).status===200,'active grant below-cap control');
check((await claim(cg,cw,{name:'Capacity',intent:'continue'})).body.error==='session_capacity_reached','continuation consumes active capacity');
await db\x60UPDATE swarm.hosted_agent_contexts SET created_at=statement_timestamp()-interval '3 days',last_business_at=statement_timestamp()-interval '3 days',idle_expires_at=statement_timestamp()-interval '2 days' WHERE context_id=\x24{durableSeat.body.context_id}::uuid\x60;
check((await claim(cg,cw)).status===200,'unswept expiry releases active capacity');
// Durable hosted ceiling retains 10 while ephemeral seats remain excluded.
const dw=await space(),dg=await grant([dw]);
for(let i=0;i<10;i++)check((await claim(dg,dw,{name:'Durable '+i,lifetime:'durable'})).status===200,'durable below-cap control');
check((await claim(dg,dw,{name:'Durable 11',lifetime:'durable'})).body.error==='hosted_seat_limit_reached','ten durable seats enforced');
check((await claim(dg,dw)).status===200,'ephemeral outside durable seat ceiling');
// Workspace budgets span owners/grants. A second owner has spare grant/owner
// capacity, so each refusal reaches the workspace fence rather than another cap.
const bw=await space(),bg=await grant([bw]),visitor=await grant([bw],other),bs=id(),bp=id();
await db\x60INSERT INTO swarm.agent_principals(principal_id,workspace_id,owner_user_id,name,transport,turn_only) VALUES(\x24{bp}::uuid,\x24{bw}::uuid,\x24{owner}::uuid,'Workspace source','hosted_mcp',true)\x60;
await db\x60INSERT INTO swarm.hosted_mcp_seats(seat_id,grant_id,workspace_id,owner_user_id,principal_id,name,created_at) VALUES(\x24{bs}::uuid,\x24{bg}::uuid,\x24{bw}::uuid,\x24{owner}::uuid,\x24{bp}::uuid,'Workspace source',statement_timestamp())\x60;
check((await claim(visitor,bw,{},id(),other)).status===200,'workspace positive control with authorized spare grant');
for(let i=0;i<99;i++)await db\x60INSERT INTO swarm.hosted_agent_contexts(context_id,handle,seat_id,kind,created_at,last_business_at,idle_expires_at,absolute_expires_at,origin)
VALUES(\x24{id()}::uuid,\x24{'seat_'+id().replaceAll('-','')},\x24{bs}::uuid,'chat',statement_timestamp(),statement_timestamp(),statement_timestamp()+interval '24 hours',statement_timestamp()+interval '30 days','continue')\x60;
check((await claim(visitor,bw,{},id(),other)).body.error==='session_capacity_reached','100 active workspace contexts across grants');
await db\x60UPDATE swarm.hosted_agent_contexts SET created_at=statement_timestamp()-interval '2 hours',last_business_at=statement_timestamp()-interval '2 hours',idle_expires_at=statement_timestamp()-interval '1 hour' WHERE seat_id=\x24{bs}::uuid\x60;
check((await claim(visitor,bw,{},id(),other)).status===200,'unswept workspace expiry releases active slots');
for(let i=101;i<499;i++)await db\x60INSERT INTO swarm.hosted_agent_contexts(context_id,handle,seat_id,kind,created_at,last_business_at,idle_expires_at,absolute_expires_at,origin)
VALUES(\x24{id()}::uuid,\x24{'seat_'+id().replaceAll('-','')},\x24{bs}::uuid,'scheduled',statement_timestamp()-interval '2 hours',statement_timestamp()-interval '2 hours',statement_timestamp()-interval '1 hour',statement_timestamp()+interval '1 hour','continue')\x60;
const visitor2=await grant([bw],other),workspaceRace=await Promise.all([claim(visitor,bw,{},id(),other),claim(visitor2,bw,{},id(),other)]);
check(workspaceRace.filter(r=>r.status===200).length===1&&workspaceRace.some(r=>r.body.error==='session_capacity_reached'),'workspace last allocation serialized across grants');
check((await db\x60SELECT count(*)::int AS n FROM swarm.hosted_agent_contexts c JOIN swarm.hosted_mcp_seats hs USING(seat_id) WHERE hs.workspace_id=\x24{bw}::uuid AND c.created_at>statement_timestamp()-interval '24 hours'\x60)[0].n===500,'committed workspace rolling budget is 500');
// Exclude the workspace-only synthetic budget rows from the owner's later
// last-slot fixture without deleting retained rows.
await db\x60UPDATE swarm.hosted_agent_contexts SET created_at=statement_timestamp()-interval '3 days' WHERE seat_id=\x24{bs}::uuid\x60;
// Owner rolling budget spans grants AND workspaces. Seed expired synthetic
// contexts so only creation accounting, not active capacity, reaches its fence.
const ow1=await space(),ow2=await space(),og1=await grant([ow1]),og2=await grant([ow2]);
const os=await claim(og1,ow1,{name:'Budget',lifetime:'durable'});
const [used]=await db\x60SELECT count(*)::int AS n FROM swarm.hosted_agent_contexts c JOIN swarm.hosted_mcp_seats hs USING(seat_id) WHERE hs.owner_user_id=\x24{owner}::uuid AND c.origin<>'legacy' AND c.created_at>statement_timestamp()-interval '24 hours'\x60;
for(let i=used.n;i<99;i++)await db\x60INSERT INTO swarm.hosted_agent_contexts(context_id,handle,seat_id,kind,created_at,last_business_at,idle_expires_at,absolute_expires_at,origin)
VALUES(\x24{id()}::uuid,\x24{'seat_'+id().replaceAll('-','')},\x24{os.body.seat_id}::uuid,'scheduled',statement_timestamp()-interval '2 hours',statement_timestamp()-interval '2 hours',statement_timestamp()-interval '1 hour',statement_timestamp()+interval '1 hour','continue')\x60;
const budgetRace=await Promise.all([claim(og1,ow1),claim(og2,ow2)]);
check(budgetRace.filter(r=>r.status===200).length===1&&budgetRace.some(r=>r.body.error==='session_capacity_reached'),'owner last allocation serialized across grants/workspaces');
const [ownerCount]=await db\x60SELECT count(*)::int AS n FROM swarm.hosted_agent_contexts c JOIN swarm.hosted_mcp_seats hs USING(seat_id) WHERE hs.owner_user_id=\x24{owner}::uuid AND c.origin<>'legacy' AND c.created_at>statement_timestamp()-interval '24 hours'\x60;
check(ownerCount.n===100,'committed owner rolling budget is 100');
console.log('SID_ALLOCATION_OK '+JSON.stringify({assertions}));
} catch(_error){console.log('SID_ALLOCATION_FAILED '+JSON.stringify({assertions}));Deno.exitCode=1;}finally{await db.end();}
`;

test('hosted allocation, replay, Q1/Q3 and hosted/local last-slot races commit correct counts', { timeout: 240000 }, async () => {
  const local = JSON.parse(execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }));
  for (const target of [local.API_URL, local.DB_URL]) assert.ok(['127.0.0.1','localhost','[::1]'].includes(new URL(target).hostname));
  const directory = mkdtempSync(join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'anvil-secret.'));
  chmodSync(directory, 0o700);
  const isolated = await adminEdgeDatabase(local.DB_URL);
  const auth = createClient(local.API_URL,local.SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  const users: string[] = [];
  try {
    local.DB_URL=isolated.url;
    let jwt='';
    for (let i=0;i<2;i++) {
      const email=`sid-${randomUUID()}@example.test`,password=randomBytes(32).toString('base64url');
      const created=await auth.auth.admin.createUser({email,password,email_confirm:true});assert.ifError(created.error);assert.ok(created.data.user);
      users.push(created.data.user.id);
      if(i===0){const signed=await auth.auth.signInWithPassword({email,password});assert.ifError(signed.error);assert.ok(signed.data.session);jwt=signed.data.session.access_token;}
      await isolated.db`INSERT INTO auth.users(id,aud,role,email) VALUES(${created.data.user.id}::uuid,'authenticated','authenticated',${email})`;
      await isolated.db`INSERT INTO swarm.users(user_id,display_name) VALUES(${created.data.user.id}::uuid,'SID fixture')`;
    }
    const [context]=await isolated.db`SELECT to_regclass('swarm.hosted_agent_contexts') IS NOT NULL AS present`;
    if(!context!.present) await isolated.db.unsafe(repoSql('supabase/migrations/20261006000003_hosted_agent_contexts.sql'));
    else await isolated.db`INSERT INTO swarm.config(key,value) VALUES('hosted_context_allocation_enabled','false')`;
    await isolated.db`INSERT INTO swarm.config(key,value) VALUES('min_client_version','"0.1.0"') ON CONFLICT(key) DO UPDATE SET value=excluded.value`;
    const catalogQuery=releaseCatalogQuery(repoSql('deploy/release-proofs/session-identity/20261006000003-catalog.sql'),'catalog_ok');
    const [catalog]=await isolated.db.unsafe(catalogQuery);
    assert.equal(catalog!.catalog_ok,true,'exact source-built reserve catalog');
    // Baseline column/FK inventory and complete privilege sets: every mutation
    // runs inside a rolled-back transaction, then checks the restored catalog.
    for(const [label,mutation] of [
      ['parent column', 'ALTER TABLE swarm.agent_principals DROP COLUMN parent_admin_grant_id'],
      ['parent FK', 'ALTER TABLE swarm.agent_principals DROP CONSTRAINT agent_principals_parent_admin_grant_id_fkey'],
      ['required seat UPDATE', 'REVOKE UPDATE ON swarm.hosted_mcp_seats FROM swarm_command'],
      ['extra seat DELETE', 'GRANT DELETE ON swarm.hosted_mcp_seats TO swarm_command'],
      ['required principal INSERT', 'REVOKE INSERT ON swarm.agent_principals FROM swarm_command'],
      ['required context SELECT', 'REVOKE SELECT ON swarm.hosted_agent_contexts FROM swarm_command'],
      ['context grant option', 'GRANT UPDATE ON swarm.hosted_agent_contexts TO swarm_command WITH GRANT OPTION'],
      ['required predecessor EXECUTE', 'REVOKE EXECUTE ON FUNCTION swarm.hosted_predecessor_status(uuid) FROM swarm_command'],
      ['predecessor grant option', 'GRANT EXECUTE ON FUNCTION swarm.hosted_predecessor_status(uuid) TO swarm_command WITH GRANT OPTION'],
      ['misplaced incoming FK with unchanged count', ''],
    ]) {
      const rollback=new Error('catalog fixture rollback');
      await isolated.db.begin(async tx=>{
        if(label==='misplaced incoming FK with unchanged count') await relocateIncomingSeatFk(tx);
        else await tx.unsafe(mutation);
        const [wrong]=await tx.unsafe(catalogQuery);
        assert.equal(wrong!.catalog_ok,false,`${label}: immutable proof refuses drift`);
        throw rollback;
      }).catch(error=>{if(error!==rollback)throw error;});
      const [restored]=await isolated.db.unsafe(catalogQuery);
      assert.equal(restored!.catalog_ok,true,`${label}: source restoration passes`);
    }
    // Perturb the exact expiry fence in the stored function definition; the
    // unchanged catalog must refuse it, then accept the restored source body.
    const up=repoSql('supabase/migrations/20261006000003_hosted_agent_contexts.sql');
    const helper=up.slice(up.indexOf('CREATE FUNCTION swarm.hosted_predecessor_status'),up.indexOf('-- Canonical data-free reserve begins.'))
      .replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION');
    await isolated.db.unsafe(helper.replace('a.expires_at <= statement_timestamp()','a.expires_at >= statement_timestamp()'));
    const [wrong]=await isolated.db.unsafe(releaseCatalogQuery(repoSql('deploy/release-proofs/session-identity/20261006000003-catalog.sql'),'catalog_ok'));
    assert.equal(wrong!.catalog_ok,false,'immutable catalog rejects expiry-fence drift');
    await isolated.db.unsafe(helper);
    const [restored]=await isolated.db.unsafe(releaseCatalogQuery(repoSql('deploy/release-proofs/session-identity/20261006000003-catalog.sql'),'catalog_ok'));
    assert.equal(restored!.catalog_ok,true,'restored helper positive control');
    await isolated.db.unsafe(repoSql('deploy/release-proofs/session-identity/20261006000003-functional.sql'));
    await isolated.db.unsafe(repoSql('deploy/release-proofs/session-identity/20261006000003-rollback.sql'));
    const [inverse]=await isolated.db.unsafe(releaseCatalogQuery(repoSql('deploy/release-proofs/session-identity/20261006000003-rollback-catalog.sql'),'rollback_ok'));
    assert.equal(inverse!.rollback_ok,true,'data-free reserve restores prerequisite stage');
    const inverseQuery=releaseCatalogQuery(repoSql('deploy/release-proofs/session-identity/20261006000003-rollback-catalog.sql'),'rollback_ok');
    const inverseDrill=new Error('rollback catalog fixture rollback');
    await isolated.db.begin(async tx=>{
      await relocateIncomingSeatFk(tx);
      const [wrong]=await tx.unsafe(inverseQuery);
      assert.equal(wrong!.rollback_ok,false,'inverse rejects misplaced FK despite unchanged total');
      throw inverseDrill;
    }).catch(error=>{if(error!==inverseDrill)throw error;});
    const [inverseRestored]=await isolated.db.unsafe(inverseQuery);
    assert.equal(inverseRestored!.rollback_ok,true,'inverse restoration passes');
    const [absent]=await isolated.db.unsafe(releaseCatalogQuery(repoSql('deploy/release-proofs/session-identity/20261006000003-catalog.sql'),'catalog_ok'));
    assert.equal(absent!.catalog_ok,false,'absent table/helper is an error-safe false');
    await isolated.db.unsafe(up);
    const path=join(directory,'harness.mjs');writeFileSync(path,harness,{mode:0o600});
    const run=spawnSync('deno',['run','--no-lock','--config','supabase/functions/command/deno.json','--allow-read','--allow-env','--allow-net',path],
      {encoding:'utf8',timeout:210000,input:JSON.stringify({local,owner:users[0],other:users[1],jwt})});
    const receipt=run.stdout.split(/\r?\n/u).find(line=>line.startsWith('SID_ALLOCATION_OK '));
    assert.equal(run.status,0,'allocation fixture failed; raw credential-bearing output withheld');assert.ok(receipt);console.log(receipt);
    let refused=false;
    await isolated.db.begin(async tx=>{
      try{await tx.savepoint(scope=>scope.unsafe(repoSql('deploy/release-proofs/session-identity/20261006000003-rollback.sql')));}
      catch(error){if(typeof error==='object'&&error!==null&&'code' in error&&error.code==='55000')refused=true;else throw error;}
    });
    assert.equal(refused,true,'occupied reserve inverse refuses without deleting history');
    await isolated.db.unsafe(repoSql('deploy/release-proofs/session-identity/20261006000003-allocation-rollback.sql'));
    const [gate]=await isolated.db`SELECT value FROM swarm.config WHERE key='hosted_context_allocation_enabled'`;
    assert.equal(gate!.value,false,'live rollback only stops allocation');

  } finally {
    for(const user of users) await auth.auth.admin.deleteUser(user);
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
