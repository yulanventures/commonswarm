/** admin-owner-approval-scoped: real command adapter and M1–M3, Docker gate only. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import { dbAssert, emptyApplicationSchema, fixture, refuses } from '../support/admin-schema-db.js';

test('admin-owner-approval-scoped: Bob approval cannot authorize Alice; real owner commands are retryable and atomically fence only her families', { timeout: 180000 }, () => {
  // This suite is intentionally NOT RUN LOCALLY (Docker).
  const local = JSON.parse(execFileSync('supabase', ['status', '-o', 'json'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  })) as { DB_URL: string };
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(local.DB_URL).hostname));
  const secretDir = mkdtempSync(join(tmpdir(), 'admin-owner-approval-'));
  chmodSync(secretDir, 0o700);
  const f = fixture(), aliceGrant = randomUUID(), aliceConnection = randomUUID(), aliceFamily = `family-${randomUUID()}`;
  const prepare = `${f.sql}
INSERT INTO swarm.admin_grants SELECT (jsonb_populate_record(NULL::swarm.admin_grants,to_jsonb(g)||
  jsonb_build_object('grant_id','${aliceGrant}','owner_user_id','${f.foreign}','connection_id','${aliceConnection}'))).*
  FROM swarm.admin_grants g WHERE grant_id='${f.grant}';
SET LOCAL ROLE commonswarm_oauth_runtime;
INSERT INTO commonswarm_oauth.provider_grant_resources(provider_grant_id,resource,grant_class,owner_user_id,client_id,connection_id,admin_grant_id)
VALUES('${aliceFamily}','https://api.commonswarm.com/admin','delegated_admin','${f.foreign}','${f.client}','${aliceConnection}','${aliceGrant}');
RESET ROLE;
`;
  const binding = `INSERT INTO commonswarm_oauth.admin_grant_bindings SELECT
    (jsonb_populate_record(NULL::commonswarm_oauth.admin_grant_bindings,to_jsonb(b)||jsonb_build_object(
      'provider_grant_id','${aliceFamily}','admin_grant_id','${aliceGrant}','owner_user_id','${f.foreign}','connection_id','${aliceConnection}'))).*
    FROM commonswarm_oauth.admin_grant_bindings b WHERE provider_grant_id='${f.provider}'`;
  const verificationPrep = `SET LOCAL ROLE commonswarm_admin_release;
INSERT INTO commonswarm_oauth.admin_verified_clients SELECT
  (jsonb_populate_record(NULL::commonswarm_oauth.admin_verified_clients,to_jsonb(v)||jsonb_build_object('verification_version',2,'active',false))).*
  FROM commonswarm_oauth.admin_verified_clients v WHERE client_id='${f.client}' AND verification_version=1;
${refuses(`INSERT INTO commonswarm_oauth.admin_client_owner_approvals(owner_user_id,client_id,verification_version,approval_event_id,approval_command_id)
  VALUES('${f.foreign}','${f.client}',2,gen_random_uuid(),'verification-prep')`, '42501')}
RESET ROLE;
${dbAssert(`SELECT NOT EXISTS(SELECT 1 FROM commonswarm_oauth.admin_client_owner_approvals WHERE owner_user_id='${f.foreign}')`, 'verification prep never approves Alice')}
${refuses(binding, '23503')}
`;
  const harness = `
import assert from 'node:assert/strict';
import postgres from 'npm:postgres@3.4.9';
import { adminTransaction } from ${JSON.stringify(new URL('../../supabase/functions/command/admin-delegation.ts', import.meta.url).href)};
const config = JSON.parse(await Deno.readTextFile(Deno.args[0]));
const sql = postgres(config.url, { prepare: false, max: 1 });
const rollback = new Error('test transaction rollback');
try {
 await sql.begin(async tx => {
  await tx.unsafe(config.schema);
  await tx.unsafe(config.prepare + config.verificationPrep);
  // Bring fixture projections into the real adapter's durable consistency contract.
  for (const owner of [config.bob, config.alice]) {
   const grants = await tx\`SELECT * FROM swarm.admin_grants WHERE owner_user_id=\${owner}::uuid\`;
   const projection = { grants: {}, consents: {}, lineages: {}, rate_buckets: {} };
   for (const g of grants) {
    for (const key of ['created_at','expires_at','refresh_deadline','revoked_at','suspended_at']) g[key] = g[key]?.getTime() ?? null;
    projection.grants[g.grant_id] = g;
   }
   await tx\`UPDATE swarm.admin_accounts SET projection=\${tx.json(projection)},seq=CASE WHEN owner_user_id=\${config.bob}::uuid THEN 1 ELSE 0 END WHERE owner_user_id=\${owner}::uuid\`;
  }
  const human = { kind: 'human', identity: { user_id: config.alice, session_binding: 'a'.repeat(64),
    interactive_at_seconds: Math.floor(Date.now()/1000), csrf_verified: true } };
  const wire = (command, command_id=crypto.randomUUID()) => ({ command_id, stream: {kind:'account'}, resource:'https://api.commonswarm.com/admin', command });
  const approve = wire({ kind:'approve_admin_client',client_id:config.client,verification_version:1 });
  async function run(input, auth=human, scope=tx) {
   await scope.unsafe('SET LOCAL ROLE swarm_command');
   // On an SQL failure the enclosing savepoint restores the role. RESET in
   // an aborted transaction would replace the original failure with 25P02.
   const outcome = (await adminTransaction(scope,input,auth)).result;
   await scope.unsafe('RESET ROLE');
   return outcome;
  }
  const verificationBefore = await tx\`SELECT * FROM commonswarm_oauth.admin_verified_clients ORDER BY verification_version\`;
  for (const auth of [
    { kind:'system',owner_user_id:config.alice },
    { ...human,identity:{...human.identity,csrf_verified:false} },
    { ...human,identity:{...human.identity,interactive_at_seconds:0} },
  ]) assert.equal((await run(wire(approve.command),auth)).status,403);
  for (const verification_version of [2,3]) {
   const result = await run(wire({...approve.command,verification_version}));
   assert.equal(result.status,403);
   assert.equal(result.body.error,'client_verification_required');
  }
  assert.equal((await run(wire({...approve.command,owner_user_id:config.bob}))).status,400);
  assert.equal((await tx\`SELECT count(*)::int AS count FROM commonswarm_oauth.admin_client_owner_approvals WHERE owner_user_id=\${config.alice}::uuid\`)[0].count,0);
  const approvalResult = await run(approve);
  assert.equal(approvalResult.status,200);
  assert.deepEqual(approvalResult.body.events.map(event=>event.type),['AdminClientApproved','AdminActionRecorded']);
  assert.equal(approvalResult.body.events[0].actor_user,config.alice);
  assert.equal(approvalResult.body.events[1].payload.target_id,config.client);
  assert.deepEqual(await tx\`SELECT * FROM commonswarm_oauth.admin_verified_clients ORDER BY verification_version\`,verificationBefore);
  const [before] = await tx\`SELECT count(*)::int AS count FROM swarm.admin_events WHERE owner_user_id=\${config.alice}::uuid\`;
  assert.deepEqual(await run(approve),await run(approve));
  const [after] = await tx\`SELECT count(*)::int AS count FROM swarm.admin_events WHERE owner_user_id=\${config.alice}::uuid\`;
  assert.equal(after.count,before.count);
  assert.equal((await run({...approve,command:{...approve.command,verification_version:2}})).status,409);
  await tx.unsafe(config.binding);
  const [policy] = await tx\`SELECT active FROM commonswarm_oauth.resolve_admin_grant_status(\${config.aliceFamily},\${config.alice},'test-kid')\`;
  assert.equal(policy.active,true);
  const withdraw = wire({kind:'withdraw_admin_client_approval',client_id:config.client,verification_version:1,reason_code:'owner_withdrew'});
  const beforeRollback = (await tx\`SELECT seq,projection FROM swarm.admin_accounts WHERE owner_user_id=\${config.alice}::uuid\`)[0];
  // Force the real approval-trigger/fence/tombstone path to fail after domain event persistence.
  await tx.unsafe("CREATE FUNCTION commonswarm_oauth.approval_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test rollback' USING ERRCODE='ZX002'; END $$; CREATE TRIGGER approval_test_failure BEFORE INSERT ON commonswarm_oauth.refresh_family_tombstones FOR EACH ROW EXECUTE FUNCTION commonswarm_oauth.approval_test_failure()");
  await assert.rejects(tx.savepoint(scope=>run(withdraw,human,scope)), error=>error.code==='ZX002');
  assert.deepEqual((await tx\`SELECT seq,projection FROM swarm.admin_accounts WHERE owner_user_id=\${config.alice}::uuid\`)[0],beforeRollback);
  assert.equal((await tx\`SELECT withdrawn_at FROM commonswarm_oauth.admin_client_owner_approvals WHERE owner_user_id=\${config.alice}::uuid\`)[0].withdrawn_at,null);
  assert.equal((await tx\`SELECT state FROM swarm.admin_grants WHERE grant_id=\${config.aliceGrant}::uuid\`)[0].state,'active');
  assert.equal((await tx\`SELECT state FROM commonswarm_oauth.admin_grant_bindings WHERE provider_grant_id=\${config.aliceFamily}\`)[0].state,'active');
  assert.equal((await tx\`SELECT count(*)::int AS count FROM commonswarm_oauth.refresh_family_tombstones WHERE grant_id=\${config.aliceFamily}\`)[0].count,0);
  assert.equal((await tx\`SELECT count(*)::int AS count FROM swarm.admin_command_results WHERE owner_user_id=\${config.alice}::uuid AND command_id=\${withdraw.command_id}\`)[0].count,0);
  await tx.unsafe('DROP TRIGGER approval_test_failure ON commonswarm_oauth.refresh_family_tombstones; DROP FUNCTION commonswarm_oauth.approval_test_failure()');
  const result = await run(withdraw);
  assert.equal(result.status,200);
  assert.deepEqual(await run(withdraw),result);
  assert.equal((await tx\`SELECT withdrawn_at IS NOT NULL AS withdrawn FROM commonswarm_oauth.admin_client_owner_approvals WHERE owner_user_id=\${config.alice}::uuid\`)[0].withdrawn,true);
  assert.equal((await tx\`SELECT state FROM swarm.admin_grants WHERE grant_id=\${config.aliceGrant}::uuid\`)[0].state,'revoked');
  assert.equal((await tx\`SELECT state FROM commonswarm_oauth.admin_grant_bindings WHERE provider_grant_id=\${config.aliceFamily}\`)[0].state,'revoked');
  assert.equal((await tx\`SELECT count(*)::int AS count FROM commonswarm_oauth.refresh_family_tombstones WHERE grant_id=\${config.aliceFamily}\`)[0].count,1);
  const [projection] = await tx\`SELECT projection FROM swarm.admin_accounts WHERE owner_user_id=\${config.alice}::uuid\`;
  assert.equal(projection.projection.grants[config.aliceGrant].state,'revoked');
  assert.equal((await tx\`SELECT state FROM swarm.admin_grants WHERE grant_id=\${config.bobGrant}::uuid\`)[0].state,'active');
  assert.equal((await tx\`SELECT active FROM commonswarm_oauth.resolve_admin_grant_status(\${config.bobFamily},\${config.bob},'test-kid')\`)[0].active,true);
  assert.equal((await tx\`SELECT withdrawn_at FROM commonswarm_oauth.admin_client_owner_approvals WHERE owner_user_id=\${config.bob}::uuid\`)[0].withdrawn_at,null);
  assert.equal((await tx\`SELECT count(*)::int AS count FROM commonswarm_oauth.admin_oauth_audit WHERE provider_grant_id=\${config.aliceFamily} AND event_kind='revoked'\`)[0].count,1);
  assert.equal((await run(wire(approve.command))).body.error,'client_approval_withdrawn');
  assert.equal((await tx\`SELECT admin_issuance_enabled FROM commonswarm_oauth.admin_cutover_state\`)[0].admin_issuance_enabled,false);
  // Always restore the schema names and fixture data by rolling back this outer transaction.
  throw rollback;
 });
} catch (error) { if (error !== rollback) throw error; }
finally { await sql.end(); }
console.log('ADMIN_OWNER_APPROVAL_OK');
`;
  try {
    const configPath = join(secretDir, 'config.json'), harnessPath = join(secretDir, 'harness.mjs');
    writeFileSync(configPath, JSON.stringify({ url: local.DB_URL, schema: emptyApplicationSchema(), prepare, verificationPrep, binding,
      bob: f.owner, alice: f.foreign, client: f.client, bobGrant: f.grant, aliceGrant, bobFamily: f.provider, aliceFamily }), { mode: 0o600 });
    writeFileSync(harnessPath, harness, { mode: 0o600 });
    const run = spawnSync('deno', ['run', '--no-lock', '--config', 'supabase/functions/command/deno.json',
      '--allow-read', '--allow-env', '--allow-net', harnessPath, configPath], { encoding: 'utf8', timeout: 150000 });
    // Database errors may contain parameters; expose only the fixed success marker.
    assert.equal(run.status, 0, 'admin owner approval DB harness failed (details withheld)');
    assert.match(run.stdout, /ADMIN_OWNER_APPROVAL_OK/u);
  } finally {
    const resolved = realpathSync(secretDir);
    assert.equal(dirname(resolved), realpathSync(tmpdir()));
    assert.ok(basename(resolved).startsWith('admin-owner-approval-') && resolved !== process.env.HOME);
    execFileSync('rm', ['-r', resolved], { stdio: 'pipe' });
  }
});
