/** Real migrated authority functions; no synthetic schema or credentials. */
import { test } from 'node:test';
import { runSql,repoSql,dbAssert,refuses } from '../support/admin-schema-db.js';
import {releaseCatalogQuery} from '../support/release-catalog-query.js';
const proofRoot='deploy/release-proofs/agents/20261028000002';
const catalogProof=(rollback=false)=>dbAssert(releaseCatalogQuery(repoSql(`${proofRoot}-${rollback?'rollback-catalog':'catalog'}.sql`),rollback?'rollback_ok':'catalog_ok').trim().replace(/;$/,''),'local agent migration catalog');

test('local account credential survives sibling membership, origin loss and dormant restoration; tenancy and revocation stay fenced',()=>{
  runSql(repoSql('deploy/release-proofs/agents/20261028000003-rollback.sql')+catalogProof()+repoSql(`${proofRoot}-functional.sql`)+repoSql('tests/fixtures/account-agents-before.sql')+repoSql('tests/fixtures/local-agent-workspaces.sql')+refuses(repoSql(`${proofRoot}-rollback.sql`),'55000'));
});

test('local agent migration reserve restores prior authority and safely reapplies',()=>{
 runSql(repoSql('deploy/release-proofs/agents/20261028000003-rollback.sql')+catalogProof()+repoSql(`${proofRoot}-rollback.sql`)+catalogProof(true)
  +repoSql('supabase/migrations/20261028000002_local_agent_workspaces.sql')+catalogProof());
});

import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {adminEdgeDatabase} from '../support/admin-edge-database.js';
// @ts-expect-error TS5097: CI exercises the shared Deno authority adapter directly.
import {planLocalOperation,lockLocalAuthPlan,loadAgentCredential,recheckLocalCredential,LocalCredentialDenied} from '../../supabase/functions/_shared/agent-auth.ts';
const A='12000000-0000-4000-8000-000000000001',B='12000000-0000-4000-8000-000000000002';
const P='22000000-0000-4000-8000-000000000001',U='02000000-0000-4000-8000-000000000001';
const hash=Buffer.from('55'.repeat(32),'hex');

test('command/activity shared auth gates use target membership; origin loss and silent renewal retain the same bearer',async()=>{
 const local=JSON.parse(execFileSync('supabase',['status','-o','json'],{encoding:'utf8',stdio:['ignore','pipe','ignore']})) as {DB_URL:string};
 const isolated=await adminEdgeDatabase(local.DB_URL);
 try {
  await isolated.db.unsafe(repoSql('tests/fixtures/account-agents-before.sql')+repoSql('tests/fixtures/local-agent-workspaces.sql').split('DO $test$')[0]);
  const operation=async(workspace:string,connectionOnly=false)=>isolated.db.begin(async tx=>{
   await tx`SET LOCAL ROLE swarm_command`;
   const plan=await planLocalOperation(tx,{hash,workspace,connectionOnly});assert.ok(plan);
   await lockLocalAuthPlan(tx,plan);
   const agent=await loadAgentCredential(tx,hash,plan,connectionOnly);assert.ok(agent);
   assert.equal(agent.principal_id,P);assert.equal(agent.principal_workspace_id,connectionOnly?A:workspace);
   assert.ok(await recheckLocalCredential(tx,hash,plan,connectionOnly));
  });
  const membership=async(add:boolean)=>isolated.db.begin(async tx=>{
   await tx`SET LOCAL ROLE swarm_command`;
   const plan=await planLocalOperation(tx,{workspace:B,actor:U,target:{principals:[P],tokens:[]},memberMutation:true,workspaceMode:'update'});assert.ok(plan);
   await lockLocalAuthPlan(tx,plan);
   const [result]=await tx`SELECT swarm.change_local_agent_membership(${B}::uuid,${P}::uuid,${U}::uuid,${add}) AS ok`;
   assert.equal(result?.ok,true);
  });
  await operation(A);
  await assert.rejects(()=>operation(B),LocalCredentialDenied);
  await membership(true);
  await operation(A);await operation(B);
  await membership(false);
  await assert.rejects(()=>operation(B),LocalCredentialDenied);
  await operation(A);
  await membership(true);
  await isolated.db`UPDATE swarm.workspaces SET archived_at=clock_timestamp() WHERE workspace_id=${A}::uuid`;
  await isolated.db`UPDATE swarm.memberships SET revoked_at=clock_timestamp() WHERE workspace_id=${A}::uuid AND user_id=${U}::uuid`;
  await operation(B);await assert.rejects(()=>operation(A),LocalCredentialDenied);
  await isolated.db`UPDATE swarm.agent_tokens SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=${hash}`;
  await operation(A,true);
  await isolated.db`INSERT INTO swarm.revocation_tombstones(kind,target_id) VALUES('family','82000000-0000-4000-8000-000000000001')`;
  await assert.rejects(()=>operation(A,true),LocalCredentialDenied);
 } finally {await isolated.close();}
});
