/** CI only: real PostgreSQL ACLs and triggers, with rollback-only fixtures. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import postgres from 'postgres';
import { runSql, repoSql, dbAssert, refuses, emptyApplicationSchema, localClusterAdminUrl } from '../support/admin-schema-db.js';
import { releaseCatalogQuery } from '../support/release-catalog-query.js';
import { householdAccessRefusal, type HouseholdAccessFacts } from '../../src/protocol/household-object-policy.js';

const proofRoot = 'deploy/release-proofs/household-approval/20261004000015';
const migration = () => repoSql('supabase/migrations/20261004000015_household_approval_until_withdrawn.sql');
function fixture() {
  const owner = randomUUID(), other = randomUUID(), workspace = randomUUID(), principal = randomUUID();
  const consent = randomUUID(), connection = randomUUID(), grant = randomUUID();
  const setup = `
    INSERT INTO auth.users(id,aud,role,email) VALUES ('${owner}','authenticated','authenticated','${owner}@example.test'),
      ('${other}','authenticated','authenticated','${other}@example.test');
    INSERT INTO swarm.users(user_id,display_name) VALUES ('${owner}','Synthetic owner'),('${other}','Synthetic other');
    INSERT INTO swarm.workspaces(workspace_id,name,created_by) VALUES ('${workspace}','Synthetic household','${owner}');
    INSERT INTO swarm.memberships(workspace_id,user_id,role) VALUES ('${workspace}','${owner}','owner'),('${workspace}','${other}','member');
    INSERT INTO swarm.streams(stream_id,workspace_id,kind) VALUES ('${randomUUID()}','${workspace}','workspace');
    INSERT INTO swarm.agent_principals(principal_id,workspace_id,owner_user_id,name,transport,turn_only)
      VALUES ('${principal}','${workspace}','${owner}','Synthetic agent','hosted_mcp',true);
    INSERT INTO swarm.household_workspace_boundaries(workspace_id,purpose) VALUES ('${workspace}','shared');
    INSERT INTO swarm.household_member_content_roles(workspace_id,user_id,content_role,content_consent_id,confirmed_at)
      VALUES ('${workspace}','${owner}','editor','${consent}','2026-10-04T00:00:00Z'),
        ('${workspace}','${other}','reader','${randomUUID()}','2026-10-04T00:00:00Z');
    INSERT INTO swarm.hosted_mcp_grants(grant_id,provider_grant_id,owner_user_id,home_workspace_id,client_id,resource,
      selected_workspace_ids,manifest_digest,interaction_ref,state,created_at,activated_at)
      VALUES ('${grant}','synthetic-${grant}','${owner}','${workspace}','synthetic-client','https://mcp.commonswarm.com/mcp',
        ARRAY['${workspace}']::uuid[],decode(repeat('a',64),'hex'),'synthetic-consent','active',clock_timestamp(),clock_timestamp());
    INSERT INTO swarm.hosted_mcp_grant_workspaces(grant_id,workspace_id,owner_user_id,manifest_digest,consent_receipt_id,consented_at)
      VALUES ('${grant}','${workspace}','${owner}',decode(repeat('a',64),'hex'),'${randomUUID()}',clock_timestamp());
    INSERT INTO swarm.hosted_mcp_seats(seat_id,grant_id,workspace_id,owner_user_id,principal_id,name,created_at)
      VALUES ('${connection}','${grant}','${workspace}','${owner}','${principal}','Synthetic agent',clock_timestamp());
  `;
  const insert = (operations = "ARRAY['read','update']", receipt = consent, id = connection, expiry = 'NULL') =>
    `INSERT INTO swarm.household_content_connections(connection_id,grant_id,workspace_id,principal_id,owner_user_id,purpose,operations,consent_receipt_id,expires_at,hosted_grant_id)
      VALUES ('${id}','${grant}','${workspace}','${principal}','${owner}','shared',${operations},'${receipt}',${expiry},'${grant}')`;
  const where = `workspace_id='${workspace}' AND connection_id='${connection}'`;
  const context = (kind: string, actor = owner) => `SELECT set_config('cswarm.household_actor','${actor}',true),
    set_config('cswarm.household_request','proof-${kind}',true),set_config('cswarm.household_digest',repeat('a',64),true),
    set_config('cswarm.household_command','${kind}',true);`;
  return { owner, other, workspace, principal, consent, connection, grant, setup, insert, where, context };
}
function psqlProof(suffix: 'catalog' | 'rollback-catalog') {
  const alias = suffix === 'catalog' ? 'catalog_ok' : 'rollback_ok';
  return repoSql(`${proofRoot}-${suffix}.sql`) + `
    SELECT :'${alias}'::boolean AS proof_pass \\gset
    \\if :proof_pass
    \\else
      DO $$ BEGIN RAISE EXCEPTION 'approval ${suffix} failed'; END $$;
    \\endif
  `;
}

test('approval trigger preserves human consent; reader ceiling, owner-only withdrawal, mutation refusals and rollback preserve audits', () => {
  const f = fixture(), newer = randomUUID();
  runSql(`
    ${migration()}
    ${f.setup}
    CREATE TEMP TABLE before_rights AS SELECT to_jsonb(r) AS row FROM swarm.household_member_content_roles r WHERE workspace_id='${f.workspace}';
    SET LOCAL ROLE swarm_command;
    ${f.context('household_approve_connection')}
    ${f.insert()};
    ${refuses(`INSERT INTO swarm.household_workspace_boundaries(workspace_id,purpose) VALUES ('${f.workspace}','shared')`, '42501')}
    ${refuses(`UPDATE swarm.household_workspace_boundaries SET workspace_id=workspace_id WHERE workspace_id='${f.workspace}'`, '42501')}
    ${refuses(`UPDATE swarm.household_member_content_roles SET content_role='reader' WHERE workspace_id='${f.workspace}' AND user_id='${f.owner}'`, '42501')}
    RESET ROLE;
    ${dbAssert(`SELECT expires_at IS NULL FROM swarm.household_content_connections WHERE ${f.where}`, 'approval lasts until withdrawn')}
    ${dbAssert(`SELECT NOT EXISTS ((SELECT row FROM before_rights EXCEPT SELECT to_jsonb(r) FROM swarm.household_member_content_roles r WHERE workspace_id='${f.workspace}')
      UNION ALL (SELECT to_jsonb(r) FROM swarm.household_member_content_roles r WHERE workspace_id='${f.workspace}' EXCEPT SELECT row FROM before_rights))`, 'approval leaves every human role byte unchanged')}
    ${dbAssert(`SELECT count(*)=1 AND bool_and(command_kind='household_approve_connection') FROM swarm.household_object_audit WHERE workspace_id='${f.workspace}'`, 'one approve audit')}
    UPDATE swarm.household_member_content_roles SET content_role='reader' WHERE workspace_id='${f.workspace}' AND user_id='${f.owner}';
    SET LOCAL ROLE swarm_command;
    ${refuses(f.insert("ARRAY['read','create']", f.consent, randomUUID()), '42501')}
    ${refuses(f.insert("ARRAY['read','update']", f.consent, randomUUID()), '42501')}
    ${f.insert("ARRAY['read']", f.consent, randomUUID())};
    ${f.context('household_withdraw_connection', f.other)}
    ${refuses(`UPDATE swarm.household_content_connections SET revoked_at=clock_timestamp() WHERE ${f.where}`, '42501')}
    RESET ROLE;
    -- Reconfirmation changes the receipt. Withdrawal must not require the old receipt to match.
    UPDATE swarm.household_member_content_roles SET content_consent_id='${newer}',confirmed_at=clock_timestamp()
      WHERE workspace_id='${f.workspace}' AND user_id='${f.owner}';
    UPDATE swarm.hosted_mcp_seats SET revoked_at=clock_timestamp() WHERE seat_id='${f.connection}';
    SET LOCAL ROLE swarm_command;
    ${f.context('household_withdraw_connection')}
    ${refuses(f.insert("ARRAY['read']", newer, randomUUID()), '42501')}
    ${refuses(`UPDATE swarm.household_workspace_boundaries SET workspace_id=workspace_id WHERE workspace_id='${f.workspace}'`, '42501')}
    ${refuses(`UPDATE swarm.household_member_content_roles SET content_role='editor' WHERE workspace_id='${f.workspace}' AND user_id='${f.owner}'`, '42501')}
    ${refuses(`UPDATE swarm.household_content_connections SET operations=ARRAY['read'],revoked_at=clock_timestamp() WHERE ${f.where}`, '42501')}
    ${refuses(`UPDATE swarm.household_content_connections SET expires_at=clock_timestamp(),revoked_at=clock_timestamp() WHERE ${f.where}`, '42501')}
    ${refuses(`UPDATE swarm.household_content_connections SET consent_receipt_id='${newer}',revoked_at=clock_timestamp() WHERE ${f.where}`, '42501')}
    ${refuses(`UPDATE swarm.household_content_connections SET connection_id='${randomUUID()}',revoked_at=clock_timestamp() WHERE ${f.where}`, '42501')}
    ${refuses(`UPDATE swarm.household_content_connections SET revoked_at=NULL WHERE ${f.where}`, '42501')}
    ${f.context('unknown_command')}
    ${refuses(`UPDATE swarm.household_content_connections SET revoked_at=clock_timestamp() WHERE ${f.where}`, '42501')}
    ${f.context('household_withdraw_connection')}
    UPDATE swarm.household_content_connections SET revoked_at=clock_timestamp() WHERE ${f.where};
    ${refuses(`UPDATE swarm.household_content_connections SET revoked_at=clock_timestamp() WHERE ${f.where}`, '42501')}
    RESET ROLE;
    ${dbAssert(`SELECT revoked_at IS NOT NULL AND consent_receipt_id='${f.consent}' FROM swarm.household_content_connections WHERE ${f.where}`, 'withdraw changes only revoked_at after role reconfirmation')}
    ${dbAssert(`SELECT count(*)=1 FROM swarm.household_object_audit WHERE workspace_id='${f.workspace}' AND command_kind='household_withdraw_connection'`, 'withdraw has its own audit')}
    ${psqlProof('catalog')}
    CREATE TEMP TABLE before_audit AS SELECT to_jsonb(a) AS row FROM swarm.household_object_audit a WHERE workspace_id='${f.workspace}';
    ${repoSql(`${proofRoot}-rollback.sql`)}
    ${psqlProof('rollback-catalog')}
    ${dbAssert(`SELECT NOT EXISTS ((SELECT row FROM before_audit EXCEPT SELECT to_jsonb(a) FROM swarm.household_object_audit a WHERE workspace_id='${f.workspace}')
      UNION ALL (SELECT to_jsonb(a) FROM swarm.household_object_audit a WHERE workspace_id='${f.workspace}' EXCEPT SELECT row FROM before_audit))`, 'rollback preserves all audit bytes')}
    ${dbAssert(`SELECT content_consent_id='${newer}' FROM swarm.household_member_content_roles WHERE workspace_id='${f.workspace}' AND user_id='${f.owner}'`, 'rollback preserves reconfirmed consent')}
  `);
});

class RollbackProof extends Error {}
test('real command adapters approve without role rewrite, list exact active approvals, replay, recheck and withdraw after reconfirmation and grant revocation', async () => {
  let local: { DB_URL: string };
  try { local = JSON.parse(execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); }
  catch { throw new Error('Local Supabase is unavailable; this proof requires the authorized CI stack.'); }
  const db = postgres(localClusterAdminUrl(local.DB_URL), { prepare: false, max: 1 });
  // Lists use no Storage I/O. Give the edge's factory synthetic, module-local
  // configuration instead of reading credentials or altering the process env.
  const bundled = await build({ stdin: { contents: `
    export * from './supabase/functions/command/household-permissions.ts';
    export { executeHouseholdSurface } from './supabase/functions/command/household-integration.ts';
  `, resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'esm',
    banner: { js: `const Deno={env:{get:(name)=>name==='SUPABASE_URL'?'https://storage.example.test':name==='SUPABASE_SERVICE_ROLE_KEY'?'synthetic-fixture':undefined}};` } });
  const api = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles![0]!.text).toString('base64')}`);
  const f = fixture(), actor = { user_id: f.owner, principal_id: null, run_id: null, connection: null };
  const connection = { kind: 'hosted', connection_id: f.connection, grant_id: f.grant, principal_id: f.principal, operations: ['read', 'update'] };
  const input = { kind: 'household_approve_connection', connection }, request = randomUUID(), yes = async () => true;
  try {
    await assert.rejects(db.begin(async tx => {
      await tx.unsafe(emptyApplicationSchema());
      await tx.unsafe(migration());
      await tx.unsafe(f.setup);
      const snapshot = async () => (await tx`SELECT to_jsonb(r)::text AS row FROM swarm.household_member_content_roles r WHERE workspace_id=${f.workspace}::uuid ORDER BY user_id`).map(r => r.row);
      const before = await snapshot();
      await tx`SET LOCAL ROLE swarm_command`;
      const approved = await api.executeHouseholdSurface(tx, f.workspace, actor, request, input, yes);
      assert.deepEqual(approved, { status: 'committed', operations: ['read', 'update'], expires_at: null });
      await tx`RESET ROLE`;
      assert.deepEqual(await snapshot(), before);
      const [audit] = await tx`SELECT count(*)::int AS count, min(command_kind) AS kind FROM swarm.household_object_audit WHERE workspace_id=${f.workspace}::uuid`;
      assert.deepEqual(audit, { count: 1, kind: 'household_approve_connection' });
      const [row] = await tx`SELECT expires_at, consent_receipt_id FROM swarm.household_content_connections WHERE connection_id=${f.connection}::uuid`;
      assert.deepEqual(row, { expires_at: null, consent_receipt_id: f.consent });
      await tx`SET LOCAL ROLE swarm_command`;
      assert.deepEqual(await api.approveHouseholdConnection(tx, f.workspace, actor, request, input, yes), approved);
      assert.deepEqual(await api.approveHouseholdConnection(tx, f.workspace, actor, request,
        { ...input, connection: { ...connection, operations: ['read'] } }, yes), { status: 'refused', reason: 'request_id_reused' });
      const listed = await api.executeHouseholdSurface(tx, f.workspace, actor, randomUUID(), { kind: 'household_connections' }, yes);
      assert.deepEqual(listed, { status: 'ok', connections: [{ kind: 'hosted', connection_id: f.connection, grant_id: f.grant, principal_id: f.principal,
        name: 'Synthetic agent', approval: { operations: ['read', 'update'], expires_at: null } }] });
      const withdrawInput = { kind: 'household_withdraw_connection', principal_id: f.principal };
      assert.deepEqual(await api.withdrawHouseholdConnection(tx, f.workspace, { ...actor, user_id: f.other }, randomUUID(), withdrawInput, yes),
        { status: 'refused', reason: 'connection_access_refused' });
      await tx`RESET ROLE`;
      // Active approvals sharing only part of the tuple must never attach to
      // this seat. These retained historical rows also exercise bulk withdrawal.
      const decoyPrincipal = randomUUID();
      await tx`INSERT INTO swarm.agent_principals(principal_id,workspace_id,owner_user_id,name)
        VALUES (${decoyPrincipal}::uuid,${f.workspace}::uuid,${f.owner}::uuid,'Synthetic unmatched principal')`;
      const decoys = [
        { connection_id: f.connection, grant_id: randomUUID(), principal_id: f.principal },
        { connection_id: randomUUID(), grant_id: f.grant, principal_id: f.principal },
        { connection_id: f.connection, grant_id: f.grant, principal_id: decoyPrincipal },
      ];
      for (const decoy of decoys) await tx`INSERT INTO swarm.household_content_connections(connection_id,grant_id,workspace_id,principal_id,owner_user_id,purpose,operations,consent_receipt_id,expires_at)
        VALUES (${decoy.connection_id}::uuid,${decoy.grant_id}::uuid,${f.workspace}::uuid,${decoy.principal_id}::uuid,
          ${f.owner}::uuid,'shared',ARRAY['read'],${f.consent}::uuid,clock_timestamp()+interval '1 hour')`;
      await tx`UPDATE swarm.household_content_connections SET expires_at=clock_timestamp()-interval '1 second' WHERE connection_id=${f.connection}::uuid AND grant_id=${f.grant}::uuid AND principal_id=${f.principal}::uuid`;
      await tx`SET LOCAL ROLE swarm_command`;
      const expired = await api.executeHouseholdSurface(tx, f.workspace, actor, randomUUID(), { kind: 'household_connections' }, yes);
      assert.equal(expired.connections[0].approval, null);
      await tx`RESET ROLE`;
      await tx`UPDATE swarm.household_content_connections SET expires_at=NULL,revoked_at=clock_timestamp() WHERE connection_id=${f.connection}::uuid AND grant_id=${f.grant}::uuid AND principal_id=${f.principal}::uuid`;
      await tx`SET LOCAL ROLE swarm_command`;
      const revoked = await api.executeHouseholdSurface(tx, f.workspace, actor, randomUUID(), { kind: 'household_connections' }, yes);
      assert.equal(revoked.connections[0].approval, null);
      await tx`RESET ROLE`;
      await tx`UPDATE swarm.household_content_connections SET revoked_at=NULL WHERE connection_id=${f.connection}::uuid AND grant_id=${f.grant}::uuid AND principal_id=${f.principal}::uuid`;
      await tx`UPDATE swarm.household_content_connections SET expires_at=clock_timestamp()-interval '1 second' WHERE connection_id=${f.connection}::uuid AND grant_id=${decoys[0]!.grant_id}::uuid`;
      await tx`UPDATE swarm.household_member_content_roles SET content_role='reader' WHERE workspace_id=${f.workspace}::uuid AND user_id=${f.owner}::uuid`;
      await tx`SET LOCAL ROLE swarm_command`;
      for (const operations of [['read', 'create'], ['read', 'update']])
        assert.deepEqual(await api.approveHouseholdConnection(tx, f.workspace, actor, randomUUID(), { ...input, connection: { ...connection, operations } }, yes),
          { status: 'refused', reason: 'invalid_connection_consent' });
      const readInput = { ...input, connection: { ...connection, operations: ['read'] } };
      assert.deepEqual(await api.approveHouseholdConnection(tx, f.workspace, actor, randomUUID(), readInput, yes),
        { status: 'committed', operations: ['read'], expires_at: null });
      await tx`RESET ROLE`;
      const [reapprovedAudit] = await tx`SELECT count(*)::int AS count FROM swarm.household_object_audit WHERE workspace_id=${f.workspace}::uuid AND command_kind='household_approve_connection'`;
      assert.equal(reapprovedAudit!.count, 2, 'each approval and reapproval appends exactly one audit');
      await tx`SET LOCAL ROLE swarm_command`;
      // Each write path must reach the final credential check, then roll back
      // both its state and audit on failure. Counters prove the refusal reached it.
      await tx`RESET ROLE`;
      const beforeRecheck = await tx`SELECT to_jsonb(a)::text AS row FROM swarm.household_object_audit a WHERE workspace_id=${f.workspace}::uuid ORDER BY audit_id`;
      const beforeConnection = await tx`SELECT to_jsonb(c)::text AS row FROM swarm.household_content_connections c WHERE workspace_id=${f.workspace}::uuid ORDER BY connection_id,grant_id,principal_id`;
      const beforeRecheckRoles = await snapshot();
      const failedIds: string[] = [];
      await tx`SET LOCAL ROLE swarm_command`;
      for (const [fn, command] of [
        [api.approveHouseholdConnection, readInput], [api.withdrawHouseholdConnection, withdrawInput],
        [api.provisionHouseholdPermissions, { kind: 'household_permissions', purpose: 'shared', content_role: 'reader', connection: readInput.connection }],
      ] as const) {
        let calls = 0;
        const failedId = randomUUID(); failedIds.push(failedId);
        await assert.rejects(tx.savepoint(async nested => {
          await fn(nested, f.workspace, actor, failedId, command, async () => ++calls === 1);
        }));
        assert.equal(calls, 2);
      }
      await tx`RESET ROLE`;
      assert.deepEqual(await tx`SELECT to_jsonb(a)::text AS row FROM swarm.household_object_audit a WHERE workspace_id=${f.workspace}::uuid ORDER BY audit_id`, beforeRecheck);
      assert.deepEqual(await tx`SELECT to_jsonb(c)::text AS row FROM swarm.household_content_connections c WHERE workspace_id=${f.workspace}::uuid ORDER BY connection_id,grant_id,principal_id`, beforeConnection);
      assert.deepEqual(await snapshot(), beforeRecheckRoles);
      const [failedKeys] = await tx`SELECT count(*)::int AS count FROM swarm.idempotency_keys WHERE command_id=ANY(${failedIds}::text[])`;
      assert.equal(failedKeys!.count, 0);
      const newer = randomUUID();
      await tx`UPDATE swarm.household_member_content_roles SET content_consent_id=${newer}::uuid,confirmed_at=clock_timestamp() WHERE workspace_id=${f.workspace}::uuid AND user_id=${f.owner}::uuid`;
      await tx`UPDATE swarm.hosted_mcp_grants SET state='revoked',revoked_at=clock_timestamp() WHERE grant_id=${f.grant}::uuid`;
      await tx`UPDATE swarm.hosted_mcp_seats SET revoked_at=clock_timestamp() WHERE seat_id=${f.connection}::uuid`;
      const changedRoles = await snapshot();
      await tx`SET LOCAL ROLE swarm_command`;
      const withdrawalId = randomUUID();
      assert.deepEqual(await api.executeHouseholdSurface(tx, f.workspace, actor, withdrawalId, withdrawInput, yes), { status: 'committed', withdrawn: 2 });
      assert.deepEqual(await api.withdrawHouseholdConnection(tx, f.workspace, actor, withdrawalId, withdrawInput, yes), { status: 'committed', withdrawn: 2 });
      assert.deepEqual(await api.withdrawHouseholdConnection(tx, f.workspace, actor, randomUUID(), withdrawInput, yes), { status: 'committed', withdrawn: 0 });
      assert.deepEqual(await api.approveHouseholdConnection(tx, f.workspace, actor, randomUUID(), readInput, yes), { status: 'refused', reason: 'connection_access_refused' });
      await tx`RESET ROLE`;
      assert.deepEqual(await snapshot(), changedRoles);
      const [withdrawn] = await tx`SELECT revoked_at, expires_at, operations FROM swarm.household_content_connections WHERE connection_id=${f.connection}::uuid AND grant_id=${f.grant}::uuid AND principal_id=${f.principal}::uuid`;
      assert.ok(withdrawn!.revoked_at !== null);
      const access: HouseholdAccessFacts = { workspace_id: f.workspace, archived_at: null, boundary: { kind: 'shared' },
        actor: { user_id: f.owner, principal_id: f.principal, run_id: null },
        member: { user_id: f.owner, workspace_id: f.workspace, revoked_at: null, content_role: 'reader', content_consent_id: newer },
        credential: { kind: 'agent', connection: { connection_id: f.connection, grant_id: f.grant, principal_id: f.principal, workspace_id: f.workspace, owner_user_id: f.owner, purpose: 'shared',
          operations: ['read'], expires_at: null, revoked_at: new Date(withdrawn!.revoked_at as string).getTime() } } };
      assert.equal(householdAccessRefusal(access, f.workspace, 'read', Date.now()), 'connection_access_refused');
      const [withdrawAudit] = await tx`SELECT count(*)::int AS count FROM swarm.household_object_audit WHERE workspace_id=${f.workspace}::uuid AND command_kind='household_withdraw_connection'`;
      assert.equal(withdrawAudit!.count, 2, 'one withdraw audit per active connection');
      const [expiredRemains] = await tx`SELECT revoked_at FROM swarm.household_content_connections
        WHERE connection_id=${f.connection}::uuid AND grant_id=${decoys[0]!.grant_id}::uuid`;
      assert.equal(expiredRemains!.revoked_at, null, 'withdrawal skips expired approvals');
      // Provision remains a separate explicit role confirmation and also writes NULL for hosted.
      await tx`UPDATE swarm.hosted_mcp_grants SET state='active',revoked_at=NULL WHERE grant_id=${f.grant}::uuid`;
      await tx`UPDATE swarm.hosted_mcp_seats SET revoked_at=NULL WHERE seat_id=${f.connection}::uuid`;
      await tx`SET LOCAL ROLE swarm_command`;
      const provisionId = randomUUID(), provisionInput = { kind: 'household_permissions', purpose: 'shared', content_role: 'editor', connection };
      const provision = await api.provisionHouseholdPermissions(tx, f.workspace, actor, provisionId, provisionInput, yes);
      assert.equal(provision.status, 'committed'); assert.equal(provision.expires_at, null); assert.equal(provision.connection_confirmed, true);
      assert.deepEqual(await api.provisionHouseholdPermissions(tx, f.workspace, actor, provisionId, provisionInput, yes), provision);
      await tx`RESET ROLE`;
      const localPrincipal = randomUUID(), device = randomUUID(), run = randomUUID(), token = randomUUID();
      const tokenExpiry = new Date(Date.now() + 3600_000);
      await tx`INSERT INTO swarm.agent_principals(principal_id,workspace_id,owner_user_id,name)
        VALUES (${localPrincipal}::uuid,${f.workspace}::uuid,${f.owner}::uuid,'Synthetic local')`;
      await tx`INSERT INTO swarm.devices(device_id,user_id,label) VALUES (${device}::uuid,${f.owner}::uuid,'Synthetic device')`;
      await tx`INSERT INTO swarm.agent_runs(run_id,principal_id,device_id) VALUES (${run}::uuid,${localPrincipal}::uuid,${device}::uuid)`;
      await tx`INSERT INTO swarm.agent_tokens(token_id,principal_id,run_id,scopes,token_hash,expires_at,lineage_id)
        VALUES (${token}::uuid,${localPrincipal}::uuid,${run}::uuid,'[]',decode(repeat('b',64),'hex'),${tokenExpiry},${randomUUID()}::uuid)`;
      const localInput = { kind: 'household_approve_connection', connection: { kind: 'local', connection_id: token,
        grant_id: run, principal_id: localPrincipal, operations: ['read'] } };
      await tx`SET LOCAL ROLE swarm_command`;
      assert.deepEqual(await api.approveHouseholdConnection(tx, f.workspace, actor, randomUUID(), localInput, yes),
        { status: 'committed', operations: ['read'], expires_at: tokenExpiry.toISOString() });
      const localListing = await api.executeHouseholdSurface(tx, f.workspace, actor, randomUUID(), { kind: 'household_connections' }, yes);
      assert.deepEqual(localListing.connections.find((c: { principal_id: string }) => c.principal_id === localPrincipal)?.approval,
        { operations: ['read'], expires_at: tokenExpiry.toISOString() });
      await tx`RESET ROLE`;
      await tx`INSERT INTO swarm.revocation_tombstones(kind,target_id) VALUES ('device',${device}::uuid)`;
      await tx`SET LOCAL ROLE swarm_command`;
      assert.deepEqual(await api.approveHouseholdConnection(tx, f.workspace, actor, randomUUID(), localInput, yes),
        { status: 'refused', reason: 'connection_access_refused' });
      await tx`RESET ROLE`;
      const [forward] = await tx.unsafe(releaseCatalogQuery(repoSql(`${proofRoot}-catalog.sql`), 'catalog_ok'));
      assert.equal(forward!.catalog_ok, true);
      const beforeRollback = await tx`SELECT to_jsonb(a)::text AS row FROM swarm.household_object_audit a WHERE workspace_id=${f.workspace}::uuid ORDER BY audit_id`;
      await tx.unsafe(repoSql(`${proofRoot}-rollback.sql`));
      const [inverse] = await tx.unsafe(releaseCatalogQuery(repoSql(`${proofRoot}-rollback-catalog.sql`), 'rollback_ok'));
      assert.equal(inverse!.rollback_ok, true);
      assert.deepEqual(await tx`SELECT to_jsonb(a)::text AS row FROM swarm.household_object_audit a WHERE workspace_id=${f.workspace}::uuid ORDER BY audit_id`, beforeRollback);
      throw new RollbackProof();
    }), RollbackProof);
  } finally { await db.end(); }
});
