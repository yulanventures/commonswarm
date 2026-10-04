import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync,spawnSync} from 'node:child_process';
import {chmodSync,writeFileSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,basename} from 'node:path';
import {adminEdgeDatabase} from '../support/admin-edge-database.js';
import {runSql,repoSql,dbAssert,refuses} from '../support/admin-schema-db.js';
test('human invite delivery grants only recipient function execution and its exact inverse preserves existing authority rows',()=>{
  runSql(`${repoSql('deploy/release-proofs/household-invites/20261004000006-catalog.sql')}
    SELECT :'catalog_ok'::boolean AS passed \\gset
    \\if :passed
    \\else
      DO $$ BEGIN RAISE EXCEPTION 'forward catalog failed'; END $$;
    \\endif
    SET LOCAL ROLE swarm_read;
    SELECT set_config('request.jwt.claims','{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}',true);
    ${dbAssert('SELECT count(*)=0 FROM swarm_read.human_invitations()','unknown recipient sees no invitations')}
    ${refuses('SELECT * FROM swarm.admin_routine_invitations','42501')}
    RESET ROLE;
    SET LOCAL ROLE swarm_command;
    ${refuses('SELECT * FROM swarm_read.human_invitations()','42501')}
    RESET ROLE;
    ${repoSql('supabase/household-invite-reserve/20261004000006-rollback.sql')}
    ${repoSql('deploy/release-proofs/household-invites/20261004000006-rollback-catalog.sql')}
    SELECT :'rollback_ok'::boolean AS inverse_passed \\gset
    \\if :inverse_passed
    \\else
      DO $$ BEGIN RAISE EXCEPTION 'inverse catalog failed'; END $$;
    \\endif
  `);
});
test('real human join adapter serializes consumption, preserves independent consent, refuses revoked access and rolls back failed joins', {timeout:180000},async()=>{
  let local: {DB_URL:string};
  try { local=JSON.parse(execFileSync('supabase',['status','-o','json'],{encoding:'utf8',stdio:['ignore','pipe','ignore']})); }
  catch { throw new Error('Local Supabase is unavailable; this server proof requires the authorized CI stack.'); }
  assert.ok(['localhost','127.0.0.1','[::1]'].includes(new URL(local.DB_URL).hostname));
  const root=realpathSync(process.platform==='darwin'?'/private/tmp':tmpdir());
  const temp=execFileSync('mktemp',['-d',join(root,'anvil-secret.XXXXXX')],{encoding:'utf8'}).trim();chmodSync(temp,0o700);
  let isolated:Awaited<ReturnType<typeof adminEdgeDatabase>>|undefined;
  try {
    isolated=await adminEdgeDatabase(local.DB_URL);
    const path=join(temp,'local.json');writeFileSync(path,JSON.stringify({db_url:isolated.url}),{mode:0o600});
    const result=spawnSync('deno',['run','--no-lock','--config','supabase/functions/command/deno.json','--allow-read','--allow-env','--allow-net','tests/support/household-human-invites-server.mjs',path],{encoding:'utf8',timeout:150000,env:process.env});
    // Never forward raw driver errors, SQL parameters or local credential files.
    assert.equal(result.status,0,'local human enrollment harness failed');assert.match(result.stdout,/HOUSEHOLD_HUMAN_INVITES_SERVER_OK/);
  }finally{
    try{await isolated?.close();}finally{const resolved=realpathSync(temp);assert.equal(dirname(resolved),root);assert.ok(basename(resolved).startsWith('anvil-secret.'));assert.notEqual(resolved,process.env.HOME);execFileSync('rm',['-rf',resolved]);}
  }
});
