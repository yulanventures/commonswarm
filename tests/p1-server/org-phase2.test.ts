/** Real organization DDL, command-role writers and workspace-only visibility. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoSql, runSql, refuses } from '../support/admin-schema-db.js';
import { releaseCatalogQuery } from '../support/release-catalog-query.js';
import { adminEdgeDatabase } from '../support/admin-edge-database.js';
import { offlineHostedData, offlineHostedDatabase, runOfflineHostedCommands } from '../support/hosted-agent-offline.js';
const root='deploy/release-proofs/org/20261027000002';
const migration=()=>repoSql('supabase/migrations/20261027000002_organizations_phase2.sql');
const proof=(suffix:string,alias:'catalog_ok'|'rollback_ok')=>`DO $check$ BEGIN IF NOT (${releaseCatalogQuery(repoSql(`${root}-${suffix}.sql`),alias).trim().replace(/;$/,'')})
 THEN RAISE EXCEPTION 'organization phase 2 ${suffix}'; END IF; END $check$;`;
test('organization roles survive siblings; create admission and moves preserve workspace authority',()=>{
  runSql(repoSql('deploy/release-proofs/agents/20261028000003-rollback.sql')
    + repoSql('deploy/release-proofs/agents/20261028000002-rollback.sql')
    + repoSql('deploy/release-proofs/agents/20261028000001-rollback.sql')
    +repoSql(`${root}-rollback.sql`)
    +repoSql('deploy/release-proofs/org/20261027000001-rollback.sql')
    +repoSql('tests/fixtures/org-phase1-before.sql')
    +repoSql('supabase/migrations/20261027000001_organizations_phase1.sql')
    +migration()+proof('catalog','catalog_ok')
    +repoSql(`${root}-rollback.sql`)+proof('rollback-catalog','rollback_ok')
    +migration()+repoSql('tests/fixtures/org-phase2-after.sql')
    +repoSql(`${root}-functional.sql`)+proof('catalog','catalog_ok')
    +refuses(repoSql(`${root}-rollback.sql`),'55000'));
});

const retryRoot='deploy/release-proofs/org/20261028000004';
const retryMigration='supabase/migrations/20261028000004_workspace_org_trigger_idempotent.sql';
const retryCatalog=(rollback=false)=>`DO $check$ BEGIN IF NOT (${releaseCatalogQuery(
  repoSql(`${retryRoot}-${rollback?'rollback-catalog':'catalog'}.sql`),rollback?'rollback_ok':'catalog_ok'
).trim().replace(/;$/,'')}) THEN RAISE EXCEPTION 'workspace org retry catalog'; END IF; END $check$;`;

test('legacy workspace INSERT retry preserves the workspace, organization and founding membership',async()=>{
  for(const suffix of ['catalog','functional','rollback','rollback-catalog']) {
    const name=`20261028000004-${suffix}.sql`;
    assert.deepEqual(readFileSync(`supabase/org-reserve/${name}`),readFileSync(`deploy/release-proofs/org/${name}`));
  }
  const duplicate=`INSERT INTO swarm.workspaces(workspace_id,name,created_by,org_id)
    VALUES('14000000-0000-4000-8000-000000000001','Retry name','04000000-0000-4000-8000-000000000001',NULL)
    ON CONFLICT(workspace_id) DO NOTHING;`;
  const sql=retryCatalog()+`
    INSERT INTO auth.users(id,email) VALUES('04000000-0000-4000-8000-000000000001','org-retry@example.test');
    INSERT INTO swarm.users(user_id,display_name) VALUES('04000000-0000-4000-8000-000000000001','Retry owner');
    SET LOCAL ROLE swarm_command;
    INSERT INTO swarm.workspaces(workspace_id,name,created_by)
      VALUES('14000000-0000-4000-8000-000000000001','Original name','04000000-0000-4000-8000-000000000001');
    RESET ROLE;
    DO $check$ BEGIN
      IF NOT EXISTS(SELECT 1 FROM swarm.organizations WHERE id='14000000-0000-4000-8000-000000000001' AND generated)
      OR NOT EXISTS(SELECT 1 FROM swarm.org_memberships WHERE org_id='14000000-0000-4000-8000-000000000001'
        AND principal_id='04000000-0000-4000-8000-000000000001' AND role='owner' AND revoked_at IS NULL)
      THEN RAISE EXCEPTION 'fresh legacy workspace lost founding org owner'; END IF;
    END $check$;
    UPDATE swarm.organizations SET display_name='Edited organization' WHERE id='14000000-0000-4000-8000-000000000001';
    UPDATE swarm.org_memberships SET role='admin',revoked_at=clock_timestamp()
      WHERE org_id='14000000-0000-4000-8000-000000000001';
    CREATE TEMP TABLE retry_workspaces_before AS TABLE swarm.workspaces;
    CREATE TEMP TABLE retry_orgs_before AS TABLE swarm.organizations;
    CREATE TEMP TABLE retry_members_before AS TABLE swarm.org_memberships;
  `+repoSql(`${retryRoot}-rollback.sql`)+retryCatalog(true)
    +`SET LOCAL ROLE swarm_command;`+refuses(duplicate,'23505')+`RESET ROLE;`
    +repoSql(retryMigration)+retryCatalog()+`SET LOCAL ROLE swarm_command;`+duplicate+duplicate+`RESET ROLE;
    DO $check$ BEGIN
      IF EXISTS((TABLE swarm.workspaces EXCEPT TABLE retry_workspaces_before) UNION ALL (TABLE retry_workspaces_before EXCEPT TABLE swarm.workspaces))
      OR EXISTS((TABLE swarm.organizations EXCEPT TABLE retry_orgs_before) UNION ALL (TABLE retry_orgs_before EXCEPT TABLE swarm.organizations))
      OR EXISTS((TABLE swarm.org_memberships EXCEPT TABLE retry_members_before) UNION ALL (TABLE retry_members_before EXCEPT TABLE swarm.org_memberships))
      THEN RAISE EXCEPTION 'legacy workspace retry changed durable rows'; END IF;
    END $check$;
  `+repoSql(`${retryRoot}-functional.sql`);
  if(!offlineHostedData) return runSql(sql);
  const isolated=await offlineHostedDatabase();
  try {await isolated.db.begin(tx=>tx.unsafe(sql));} finally {await isolated.close();}
});

test('create_workspace retries with the same workspace id and omitted org_id return the original result',async()=>{
  const local=offlineHostedData?null:JSON.parse(execFileSync('supabase',['status','-o','json'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}));
  const isolated=offlineHostedData?await offlineHostedDatabase():await adminEdgeDatabase(local.DB_URL);
  const directory=mkdtempSync(join(tmpdir(),'org-retry-commands-'));
  try {
    const harness=join(directory,'commands.ts');
    writeFileSync(harness,`
import assert from 'node:assert/strict';
const getEnv=Deno.env.get;
Deno.env.get=(key)=>key==='SWARM_SELF_SERVE'?'1':getEnv.call(Deno.env,key);
const {db,handleHostedManagementCommand}=await import(${JSON.stringify(new URL('../../supabase/functions/command/index.ts',import.meta.url).href)});
const user=crypto.randomUUID(),workspace=crypto.randomUUID();
const human={userId:user,email:null,displayName:'Retry owner',identityVerified:true,interactiveAuthAtSeconds:Math.floor(Date.now()/1000)};
try {
  await db.unsafe("INSERT INTO swarm.config(key,value) VALUES('min_client_version','\\\"0.1.0\\\"') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value");
  await db\x60INSERT INTO auth.users(id,email) VALUES(\x24{user}::uuid,\x24{user+'@example.test'})\x60;
  const input={command_id:crypto.randomUUID(),client_version:'0.1.83',command:{kind:'create_workspace',workspace_id:workspace,name:'Legacy workspace'}};
  const first=await handleHostedManagementCommand(input,human);
  assert.equal(first.status,200,JSON.stringify(first.body));
  assert.equal(first.body.status,'accepted');
  assert.equal(first.body.workspace_id,workspace);
  assert.equal(first.body.org_id,workspace);
  assert.ok(first.body.stream_id);
  const snapshot=()=>db\x60SELECT (SELECT jsonb_agg(w) FROM swarm.workspaces w) AS workspaces,
    (SELECT jsonb_agg(o) FROM swarm.organizations o) AS organizations,
    (SELECT jsonb_agg(m ORDER BY org_id,principal_kind,principal_id) FROM swarm.org_memberships m) AS org_memberships,
    (SELECT jsonb_agg(m ORDER BY workspace_id,user_id) FROM swarm.memberships m) AS memberships,
    (SELECT jsonb_agg(s ORDER BY stream_id) FROM swarm.streams s) AS streams\x60;
  const before=await snapshot();
  for(const command_id of [input.command_id,crypto.randomUUID()]) {
    const retry=await handleHostedManagementCommand({...input,command_id},human);
    assert.equal(retry.status,200,JSON.stringify(retry.body));
    assert.deepEqual(retry.body,first.body);
    assert.deepEqual(await snapshot(),before);
  }
  console.log('WORKSPACE_ORG_RETRY_PASS');
} finally {await db.end();}
`);
    if(offlineHostedData) return await runOfflineHostedCommands(harness,isolated.db,directory);
    assert.ok('url' in isolated && typeof isolated.url==='string');
    const result=spawnSync('deno',['run','--no-lock','--config','supabase/functions/command/deno.json','--allow-env','--allow-net','--allow-read',harness],{
      encoding:'utf8',timeout:90000,env:{...process.env,SWARM_ENV:'test',SWARM_SELF_SERVE:'1',SWARM_DATABASE_URL:isolated.url,
        SUPABASE_DB_URL:isolated.url,SUPABASE_URL:local.API_URL,SUPABASE_ANON_KEY:local.ANON_KEY},
    });
    assert.equal(result.status,0,`workspace retry command harness failed: ${result.stderr}`);
    assert.match(result.stdout,/WORKSPACE_ORG_RETRY_PASS/);
  } finally {
    try {await isolated.close();} finally {execFileSync('rm',['-r',directory]);}
  }
});
