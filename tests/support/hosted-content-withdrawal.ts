/** Shared real-database regression: CI postgres.js and offline PG17 single-user. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
// @ts-expect-error TS5097: exercise the production transaction adapter.
import { provisionHouseholdPermissions, approveHouseholdConnection, withdrawHouseholdConnection } from '../../supabase/functions/command/household-permissions.ts';
// @ts-expect-error TS5097: exercise the production content gate.
import { loadHouseholdContentAccess } from '../../supabase/functions/command/household-content-access.ts';
import { householdAccessRefusal } from '../../src/protocol/household-object-policy.js';

type Sql = postgres.TransactionSql<Record<string, unknown>>;
const A='13000000-0000-4000-8000-000000000001', B='13000000-0000-4000-8000-000000000002';
const D='13000000-0000-4000-8000-000000000004', P='23000000-0000-4000-8000-000000000001';
const U='03000000-0000-4000-8000-000000000001', G='33000000-0000-4000-8000-000000000001';
const localP='23000000-0000-4000-8000-000000000004';
const human={user_id:U,principal_id:null,run_id:null,connection:null};
const yes=async()=>true;

/** Caller installs hosted-agent-workspaces-before.sql and the real migration. */
export async function proveHostedContentWithdrawal(tx: Sql) {
  const asCommand=async<T>(fn:()=>Promise<T>)=>{
    await tx`SET LOCAL ROLE swarm_command`;
    try {return await fn();} finally {await tx`RESET ROLE`;}
  };
  await tx`INSERT INTO swarm.workspaces(workspace_id,name,created_by,org_id)
    SELECT ${D}::uuid,'Hosted D',created_by,org_id FROM swarm.workspaces WHERE workspace_id=${A}::uuid`;
  await tx`INSERT INTO swarm.memberships(workspace_id,user_id,role) VALUES(${D}::uuid,${U}::uuid,'owner')`;
  await tx`INSERT INTO swarm.streams(stream_id,workspace_id,kind) VALUES(${D}::uuid,${D}::uuid,'workspace')`;
  await tx`INSERT INTO swarm.agent_workspace_memberships(principal_id,workspace_id,owner_user_id,added_by)
    VALUES(${P}::uuid,${D}::uuid,${U}::uuid,${U}::uuid)`;
  assert.deepEqual(await asCommand(()=>withdrawHouseholdConnection(tx,D,human,randomUUID(),
    {kind:'household_withdraw_connection',principal_id:P},yes)),{status:'refused',reason:'connection_access_refused'},
    'membership without a human-add receipt or original binding is not hosted connection history');
  await tx`DELETE FROM swarm.agent_workspace_memberships WHERE workspace_id=${D}::uuid AND principal_id=${P}::uuid`;
  for (const workspace of [B,D]) {
    const [added]=await tx`SELECT swarm.change_local_agent_membership(${workspace}::uuid,${P}::uuid,${U}::uuid,true) AS ok`;
    assert.equal(added!.ok,true,'real human add creates target membership and receipt');
    await tx`INSERT INTO swarm.hosted_mcp_seats(seat_id,grant_id,workspace_id,owner_user_id,principal_id,name,created_at)
      VALUES(${randomUUID()}::uuid,${G}::uuid,${workspace}::uuid,${U}::uuid,${P}::uuid,'Reusable hosted',clock_timestamp())`;
  }
  const seats=await tx`SELECT workspace_id,seat_id FROM swarm.hosted_mcp_seats WHERE principal_id=${P}::uuid ORDER BY workspace_id`;
  const seatFor=(workspace:string)=>String(seats.find(s=>s.workspace_id===workspace)!.seat_id);
  const connection=(workspace:string)=>({kind:'hosted',connection_id:seatFor(workspace),grant_id:G,principal_id:P,operations:['read']});
  for (const workspace of [A,B,D]) {
    const result=await asCommand(()=>provisionHouseholdPermissions(tx,workspace,human,randomUUID(),
      {kind:'household_permissions',purpose:'shared',content_role:'editor',connection:connection(workspace)},yes));
    assert.equal(result.status,'committed','human approves the exact hosted connection');
  }
  const canRead=async(workspace:string)=>asCommand(async()=>{
    const access=await loadHouseholdContentAccess(tx,workspace,{user_id:U,principal_id:P,run_id:null,
      connection:{connection_id:seatFor(workspace),grant_id:G}});
    return access!==null && householdAccessRefusal(access.facts,workspace,'read',access.now)===null;
  });
  const snapshot=async(workspaces:string[])=>{
    const approvals=await tx`SELECT to_jsonb(c)::text AS row FROM swarm.household_content_connections c
      WHERE workspace_id=ANY(${workspaces}::uuid[]) ORDER BY workspace_id,connection_id,grant_id,principal_id`;
    const restrictions=await tx`SELECT to_jsonb(r)::text AS row FROM swarm.household_hosted_content_restrictions r
      WHERE workspace_id=ANY(${workspaces}::uuid[]) ORDER BY workspace_id,grant_id,principal_id`;
    return {approvals:[...approvals],restrictions:[...restrictions]};
  };
  const withdraw=(workspace:string,principal=P)=>asCommand(()=>withdrawHouseholdConnection(tx,workspace,human,randomUUID(),
    {kind:'household_withdraw_connection',principal_id:principal},yes));
  const approve=(workspace:string)=>asCommand(()=>approveHouseholdConnection(tx,workspace,human,randomUUID(),
    {kind:'household_approve_connection',connection:connection(workspace)},yes));

  for (const workspace of [A,B,D]) assert.equal(await canRead(workspace),true);
  const beforeWrongOwner=await snapshot([A,B,D]);
  assert.deepEqual(await asCommand(()=>withdrawHouseholdConnection(tx,B,
    {...human,user_id:'03000000-0000-4000-8000-000000000002'},randomUUID(),
    {kind:'household_withdraw_connection',principal_id:P},yes)),{status:'refused',reason:'connection_access_refused'});
  assert.deepEqual(await snapshot([A,B,D]),beforeWrongOwner,'another member cannot withdraw the owner connection');
  const untouched=await snapshot([A,D]);
  assert.deepEqual(await withdraw(B),{status:'committed',withdrawn:1},'sibling withdrawal succeeds');
  assert.equal(await canRead(B),false,'sibling content access is revoked');
  assert.equal(await canRead(A),true,'origin content access survives');
  assert.equal(await canRead(D),true,'other sibling content access survives');
  assert.deepEqual(await snapshot([A,D]),untouched,'origin and other sibling grants stay byte-identical');
  const [restriction]=await tx`SELECT operations,origin FROM swarm.household_hosted_content_restrictions
    WHERE workspace_id=${B}::uuid AND principal_id=${P}::uuid AND grant_id=${G}::uuid`;
  assert.deepEqual(restriction,{operations:[],origin:'human_withdraw'});

  const siblings=await snapshot([B,D]);
  assert.deepEqual(await withdraw(A),{status:'committed',withdrawn:1},'origin withdrawal still works');
  assert.equal(await canRead(A),false);
  assert.deepEqual(await snapshot([B,D]),siblings);

  assert.equal((await approve(B)).status,'committed');
  assert.equal((await approve(A)).status,'committed');
  assert.equal(await canRead(B),true);
  // A terminal connection and revoked target history must never block withdrawal.
  await tx`UPDATE swarm.hosted_mcp_grants SET state='revoked',revoked_at=clock_timestamp() WHERE grant_id=${G}::uuid`;
  await tx`UPDATE swarm.hosted_mcp_seats SET revoked_at=clock_timestamp() WHERE workspace_id=${B}::uuid AND principal_id=${P}::uuid`;
  await tx`UPDATE swarm.agent_workspace_memberships SET revoked_at=clock_timestamp() WHERE workspace_id=${B}::uuid AND principal_id=${P}::uuid`;
  await tx`UPDATE swarm.hosted_mcp_agent_workspace_adds SET revoked_at=clock_timestamp() WHERE workspace_id=${B}::uuid AND principal_id=${P}::uuid`;
  const inactiveUntouched=await snapshot([A,D]);
  assert.deepEqual(await withdraw(B),{status:'committed',withdrawn:1},'inactive sibling withdrawal uses history');
  assert.deepEqual(await snapshot([A,D]),inactiveUntouched);
  const [inactive]=await tx`SELECT revoked_at IS NOT NULL AS withdrawn FROM swarm.household_content_connections
    WHERE workspace_id=${B}::uuid AND principal_id=${P}::uuid`;
  assert.equal(inactive!.withdrawn,true);
  await tx`UPDATE swarm.hosted_mcp_grant_workspaces SET revoked_at=clock_timestamp() WHERE grant_id=${G}::uuid AND workspace_id=${A}::uuid`;
  await tx`UPDATE swarm.hosted_mcp_grant_agents SET revoked_at=clock_timestamp() WHERE grant_id=${G}::uuid AND principal_id=${P}::uuid`;
  await tx`UPDATE swarm.agent_principals SET revoked_at=clock_timestamp() WHERE principal_id=${P}::uuid`;
  await tx`UPDATE swarm.agent_workspace_memberships SET revoked_at=clock_timestamp() WHERE workspace_id=${A}::uuid AND principal_id=${P}::uuid`;
  const afterInactiveSibling=await snapshot([B,D]);
  assert.deepEqual(await withdraw(A),{status:'committed',withdrawn:1},'inactive origin withdrawal uses the original binding history');
  assert.deepEqual(await snapshot([B,D]),afterInactiveSibling);

  // Local legacy approvals use the same withdrawal path without any hosted history.
  await tx`INSERT INTO swarm.agent_principals(principal_id,workspace_id,owner_user_id,name,transport,turn_only)
    VALUES(${localP}::uuid,${A}::uuid,${U}::uuid,'Local withdrawal','local',false)`;
  const token=randomUUID(),run=randomUUID(),device=randomUUID();
  await tx`INSERT INTO swarm.devices(device_id,user_id,label) VALUES(${device}::uuid,${U}::uuid,'Local withdrawal device')`;
  await tx`INSERT INTO swarm.agent_runs(run_id,principal_id,device_id) VALUES(${run}::uuid,${localP}::uuid,${device}::uuid)`;
  await tx`INSERT INTO swarm.agent_tokens(token_id,principal_id,run_id,scopes,token_hash,expires_at,lineage_id)
    VALUES(${token}::uuid,${localP}::uuid,${run}::uuid,'["post_signal"]'::jsonb,
      decode(${'66'.repeat(32)},'hex'),clock_timestamp()+interval '1 hour',${randomUUID()}::uuid)`;
  await tx`INSERT INTO swarm.household_content_connections(connection_id,grant_id,workspace_id,principal_id,owner_user_id,purpose,operations,consent_receipt_id)
    SELECT ${token}::uuid,${run}::uuid,${A}::uuid,${localP}::uuid,${U}::uuid,'shared',ARRAY['read'],content_consent_id
    FROM swarm.household_member_content_roles WHERE workspace_id=${A}::uuid AND user_id=${U}::uuid`;
  const hostedBefore=await snapshot([B,D]);
  const localCanRead=()=>asCommand(async()=>{
    const access=await loadHouseholdContentAccess(tx,A,{user_id:U,principal_id:localP,run_id:run,
      connection:{connection_id:token,grant_id:run}});
    return access!==null && householdAccessRefusal(access.facts,A,'read',access.now)===null;
  });
  assert.equal(await localCanRead(),true,'local legacy credential starts with content access');
  assert.deepEqual(await withdraw(A,localP),{status:'committed',withdrawn:1},'local withdrawal remains supported');
  assert.equal(await localCanRead(),false,'local content access is revoked');
  const [local]=await tx`SELECT revoked_at IS NOT NULL AS withdrawn FROM swarm.household_content_connections WHERE connection_id=${token}::uuid`;
  assert.equal(local!.withdrawn,true);
  const [localRestriction]=await tx`SELECT count(*)::int AS count FROM swarm.household_hosted_content_restrictions WHERE principal_id=${localP}::uuid`;
  assert.equal(localRestriction!.count,0,'local withdrawal creates no hosted restrictions');
  assert.deepEqual(await snapshot([B,D]),hostedBefore);
}
