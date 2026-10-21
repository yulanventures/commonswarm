/** CI only: real PostgreSQL ACLs and triggers, with rollback-only fixtures. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { writeFileSync } from 'node:fs';
import postgres from 'postgres';
import { runSql, repoSql, dbAssert, refuses, emptyApplicationSchema, localClusterAdminUrl } from '../support/admin-schema-db.js';
import { releaseCatalogQuery } from '../support/release-catalog-query.js';
import { householdAccessRefusal, type HouseholdAccessFacts } from '../../src/protocol/household-object-policy.js';

const proofRoot = 'deploy/release-proofs/household-approval/20261004000015';
const migration = () => repoSql('supabase/migrations/20261004000015_household_approval_until_withdrawn.sql');
function hostedFixture(workspace: string, owner: string) {
  const principal = randomUUID(), connection = randomUUID(), grant = randomUUID();
  // Migration 20261004000010 allows one live hosted seat per name in a workspace, so each
  // fixture seat (one per member in the personal-boundary case) gets its own name.
  const name = `Synthetic agent ${principal.slice(0, 8)}`;
  const handle = `seat_${principal.replaceAll("-", "").slice(0, 22)}`;
  const setup = `
    INSERT INTO swarm.agent_principals(principal_id,workspace_id,owner_user_id,name,transport,turn_only)
      VALUES ('${principal}','${workspace}','${owner}','${name}','hosted_mcp',true);
    INSERT INTO swarm.hosted_mcp_grants(grant_id,provider_grant_id,owner_user_id,home_workspace_id,client_id,resource,
      selected_workspace_ids,manifest_digest,interaction_ref,state,created_at,activated_at)
      VALUES ('${grant}','synthetic-${grant}','${owner}','${workspace}','synthetic-client','https://mcp.commonswarm.com/mcp',
        ARRAY['${workspace}']::uuid[],decode(repeat('a',64),'hex'),'synthetic-consent','active',clock_timestamp(),clock_timestamp());
    INSERT INTO swarm.hosted_mcp_grant_workspaces(grant_id,workspace_id,owner_user_id,manifest_digest,consent_receipt_id,consented_at)
      VALUES ('${grant}','${workspace}','${owner}',decode(repeat('a',64),'hex'),'${randomUUID()}',clock_timestamp());
    INSERT INTO swarm.hosted_mcp_seats(seat_id,grant_id,workspace_id,owner_user_id,principal_id,name,created_at)
      VALUES ('${connection}','${grant}','${workspace}','${owner}','${principal}','${name}',clock_timestamp());
    INSERT INTO swarm.hosted_mcp_seat_handles(handle,seat_id,grant_id,workspace_id,principal_id,created_at)
      VALUES ('${handle}','${connection}','${grant}','${workspace}','${principal}',clock_timestamp());
  `;
  return { principal, connection, grant, name, handle, setup };
}
function fixture() {
  const owner = randomUUID(), other = randomUUID(), workspace = randomUUID(), consent = randomUUID();
  const hosted = hostedFixture(workspace, owner);
  const { principal, connection, grant, name, handle } = hosted;
  const setup = `
    INSERT INTO auth.users(id,aud,role,email) VALUES ('${owner}','authenticated','authenticated','${owner}@example.test'),
      ('${other}','authenticated','authenticated','${other}@example.test');
    INSERT INTO swarm.users(user_id,display_name) VALUES ('${owner}','Synthetic owner'),('${other}','Synthetic other');
    INSERT INTO swarm.workspaces(workspace_id,name,created_by) VALUES ('${workspace}','Synthetic household','${owner}');
    INSERT INTO swarm.memberships(workspace_id,user_id,role) VALUES ('${workspace}','${owner}','owner'),('${workspace}','${other}','member');
    INSERT INTO swarm.streams(stream_id,workspace_id,kind) VALUES ('${randomUUID()}','${workspace}','workspace');
    INSERT INTO swarm.household_workspace_boundaries(workspace_id,purpose) VALUES ('${workspace}','shared');
    INSERT INTO swarm.household_member_content_roles(workspace_id,user_id,content_role,content_consent_id,confirmed_at)
      VALUES ('${workspace}','${owner}','editor','${consent}','2026-10-04T00:00:00Z'),
        ('${workspace}','${other}','reader','${randomUUID()}','2026-10-04T00:00:00Z');
    ${hosted.setup}
  `;
  const insert = (operations = "ARRAY['read','update']", receipt = consent, id = connection, expiry = 'NULL') =>
    `INSERT INTO swarm.household_content_connections(connection_id,grant_id,workspace_id,principal_id,owner_user_id,purpose,operations,consent_receipt_id,expires_at,hosted_grant_id)
      VALUES ('${id}','${grant}','${workspace}','${principal}','${owner}','shared',${operations},'${receipt}',${expiry},'${grant}')`;
  const where = `workspace_id='${workspace}' AND connection_id='${connection}'`;
  const context = (kind: string, actor = owner) => `SELECT set_config('cswarm.household_actor','${actor}',true),
    set_config('cswarm.household_request','proof-${kind}',true),set_config('cswarm.household_digest',repeat('a',64),true),
    set_config('cswarm.household_command','${kind}',true);`;
  return { owner, other, workspace, principal, consent, connection, grant, name, handle, setup, insert, where, context };
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
test('real command adapters approve without role rewrite, list exact active approvals, replay, recheck and withdraw after reconfirmation and grant revocation', async t => {
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
      // Compare complete persisted rows so a refusal cannot silently insert,
      // update, delete, audit or consume an idempotency key.
      const writes = async (sql: typeof tx) => ({
        restrictions: await sql`SELECT to_jsonb(r)::text AS row FROM swarm.household_hosted_content_restrictions r
          WHERE workspace_id=${f.workspace}::uuid ORDER BY grant_id`,
        connections: await sql`SELECT to_jsonb(c)::text AS row FROM swarm.household_content_connections c
          WHERE workspace_id=${f.workspace}::uuid ORDER BY connection_id,grant_id,principal_id`,
        audits: await sql`SELECT to_jsonb(a)::text AS row FROM swarm.household_object_audit a
          WHERE workspace_id=${f.workspace}::uuid ORDER BY audit_id`,
        keys: await sql`SELECT to_jsonb(k)::text AS row FROM swarm.idempotency_keys k
          WHERE workspace_id=${f.workspace}::uuid ORDER BY principal_kind,principal_id,command_id`,
      });
      const refusalWithoutWrites = async (sql: typeof tx, identity: typeof actor, command: Record<string, unknown>, reason: string) => {
        const beforeWrites = await writes(sql), refusedId = randomUUID();
        await sql`SET LOCAL ROLE swarm_command`;
        const result = await api.executeHouseholdSurface(sql, f.workspace, identity, refusedId, command, yes);
        assert.equal(result.status, 'refused'); assert.equal(result.reason, reason);
        assert.equal(result.code, reason); assert.ok(Array.isArray(result.missing));
        assert.ok(Object.hasOwn(result, 'scope')); assert.ok(Object.hasOwn(result, 'remedy_url'));
        assert.ok(Object.hasOwn(result, 'mcp_tool')); assert.ok(Object.hasOwn(result, 'cli_command'));
        await sql`RESET ROLE`;
        assert.deepEqual(await writes(sql), beforeWrites, `${reason} leaves connections, audits and keys unchanged`);
        const [key] = await sql`SELECT count(*)::int AS count FROM swarm.idempotency_keys WHERE command_id=${refusedId}`;
        assert.equal(key!.count, 0, `${reason} does not consume the request id`);
      };
      const approveControl = async (sql: typeof tx) => {
        await sql`SET LOCAL ROLE swarm_command`;
        assert.deepEqual(await api.executeHouseholdSurface(sql, f.workspace, actor, randomUUID(), input, yes),
          { status: 'committed', operations: ['read', 'update'], expires_at: null });
        await sql`RESET ROLE`;
        const [approval] = await sql`SELECT revoked_at,expires_at,operations FROM swarm.household_content_connections
          WHERE workspace_id=${f.workspace}::uuid AND connection_id=${f.connection}::uuid
            AND grant_id=${f.grant}::uuid AND principal_id=${f.principal}::uuid`;
        assert.deepEqual(approval, { revoked_at: null, expires_at: null, operations: ['read', 'update'] });
      };
      await t.test('approve without a workspace boundary refuses owner_confirmation_required without writes; confirmed boundary approves', async () => {
        await assert.rejects(tx.savepoint(async sql => {
          await sql`DELETE FROM swarm.household_workspace_boundaries WHERE workspace_id=${f.workspace}::uuid`;
          await refusalWithoutWrites(sql, actor, input, 'owner_confirmation_required');
          await sql`INSERT INTO swarm.household_workspace_boundaries(workspace_id,purpose) VALUES (${f.workspace}::uuid,'shared')`;
          await approveControl(sql);
          throw new RollbackProof();
        }), RollbackProof);
      });
      await t.test('personal workspace refuses another member with workspace_boundary_mismatch without writes; its owner approves', async () => {
        await assert.rejects(tx.savepoint(async sql => {
          const otherHosted = hostedFixture(f.workspace, f.other);
          await sql.unsafe(otherHosted.setup);
          await sql`UPDATE swarm.household_workspace_boundaries SET purpose='personal',owner_user_id=${f.owner}::uuid
            WHERE workspace_id=${f.workspace}::uuid`;
          const otherInput = { kind: 'household_approve_connection', connection: { kind: 'hosted',
            connection_id: otherHosted.connection, grant_id: otherHosted.grant, principal_id: otherHosted.principal, operations: ['read'] } };
          await refusalWithoutWrites(sql, { ...actor, user_id: f.other }, otherInput, 'workspace_boundary_mismatch');
          await approveControl(sql);
          const [approval] = await sql`SELECT purpose,owner_user_id FROM swarm.household_content_connections WHERE connection_id=${f.connection}::uuid`;
          assert.deepEqual(approval, { purpose: 'personal', owner_user_id: f.owner });
          throw new RollbackProof();
        }), RollbackProof);
      });
      for (const state of ['missing', 'revoked'] as const) {
        await t.test(`approve with ${state} content role refuses content_consent_required without writes; live consent approves`, async () => {
          await assert.rejects(tx.savepoint(async sql => {
            if (state === 'missing') {
              await sql`DELETE FROM swarm.household_member_content_roles WHERE workspace_id=${f.workspace}::uuid AND user_id=${f.owner}::uuid`;
            } else {
              await sql`UPDATE swarm.household_member_content_roles SET revoked_at=clock_timestamp()
                WHERE workspace_id=${f.workspace}::uuid AND user_id=${f.owner}::uuid`;
            }
            await refusalWithoutWrites(sql, actor, input, 'content_consent_required');
            if (state === 'missing') {
              await sql`INSERT INTO swarm.household_member_content_roles(workspace_id,user_id,content_role,content_consent_id,confirmed_at)
                VALUES (${f.workspace}::uuid,${f.owner}::uuid,'editor',${f.consent}::uuid,'2026-10-04T00:00:00Z')`;
            } else {
              await sql`UPDATE swarm.household_member_content_roles SET revoked_at=NULL
                WHERE workspace_id=${f.workspace}::uuid AND user_id=${f.owner}::uuid`;
            }
            await approveControl(sql);
            throw new RollbackProof();
          }), RollbackProof);
        });
      }
      const snapshot = async () => (await tx`SELECT to_jsonb(r)::text AS row FROM swarm.household_member_content_roles r WHERE workspace_id=${f.workspace}::uuid ORDER BY user_id`).map(r => r.row);
      const before = await snapshot();
      await tx`SET LOCAL ROLE swarm_command`;
      const approved = await api.executeHouseholdSurface(tx, f.workspace, actor, request, input, yes);
      assert.deepEqual(approved, { status: 'committed', operations: ['read', 'update'], expires_at: null });
      await tx`RESET ROLE`;
      assert.deepEqual(await snapshot(), before);
      const [audit] = await tx`SELECT count(*)::int AS count, min(command_kind) AS kind FROM swarm.household_object_audit WHERE workspace_id=${f.workspace}::uuid AND reason_code='household_content_connections'`;
      assert.deepEqual(audit, { count: 1, kind: 'household_approve_connection' });
      const [row] = await tx`SELECT expires_at, consent_receipt_id FROM swarm.household_content_connections WHERE connection_id=${f.connection}::uuid`;
      assert.deepEqual(row, { expires_at: null, consent_receipt_id: f.consent });
      await tx`SET LOCAL ROLE swarm_command`;
      assert.deepEqual(await api.approveHouseholdConnection(tx, f.workspace, actor, request, input, yes), approved);
      assert.deepEqual(await api.approveHouseholdConnection(tx, f.workspace, actor, request,
        { ...input, connection: { ...connection, operations: ['read'] } }, yes), { status: 'refused', reason: 'request_id_reused' });
      const listed = await api.executeHouseholdSurface(tx, f.workspace, actor, randomUUID(), { kind: 'household_connections' }, yes);
      assert.deepEqual(listed, { status: 'ok', connections: [{ kind: 'hosted', connection_id: f.connection, grant_id: f.grant, principal_id: f.principal,
        name: f.name, approval: { operations: ['read', 'update'], expires_at: null },
        effective_access: { source: 'explicit', operations: ['read', 'update'], restricted: true,
          restrictions: [{ operations: ['read', 'update'], origin: 'human_allow', principal_id: f.principal }] } }] });
      const withdrawInput = { kind: 'household_withdraw_connection', principal_id: f.principal };
      await tx`RESET ROLE`;
      await t.test('withdraw another member\'s agent refuses connection_access_refused without writes and preserves their active approval', async () => {
        await refusalWithoutWrites(tx, { ...actor, user_id: f.other }, withdrawInput, 'connection_access_refused');
        const [active] = await tx`SELECT revoked_at,expires_at,operations FROM swarm.household_content_connections
          WHERE workspace_id=${f.workspace}::uuid AND connection_id=${f.connection}::uuid
            AND grant_id=${f.grant}::uuid AND principal_id=${f.principal}::uuid`;
        assert.deepEqual(active, { revoked_at: null, expires_at: null, operations: ['read', 'update'] });
      });
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
      const [reapprovedAudit] = await tx`SELECT count(*)::int AS count FROM swarm.household_object_audit WHERE workspace_id=${f.workspace}::uuid AND command_kind='household_approve_connection' AND reason_code='household_content_connections'`;
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
      const [withdrawAudit] = await tx`SELECT count(*)::int AS count FROM swarm.household_object_audit WHERE workspace_id=${f.workspace}::uuid AND command_kind='household_withdraw_connection' AND reason_code='household_content_connections'`;
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
      await t.test('rollback ends NULL-expiry approvals without deleting rows or changing audits and restores NOT NULL', async () => {
        const connections = () => tx`SELECT (to_jsonb(c)-'expires_at')::text AS retained, expires_at,
          expires_at <= clock_timestamp() AS ended
          FROM swarm.household_content_connections c ORDER BY workspace_id,connection_id,grant_id,principal_id`;
        const audits = () => tx`SELECT to_jsonb(a)::text AS row FROM swarm.household_object_audit a ORDER BY audit_id`;
        const beforeConnections = await connections(), beforeAudit = await audits();
        const [active] = await tx`SELECT expires_at,revoked_at FROM swarm.household_content_connections
          WHERE connection_id=${f.connection}::uuid AND grant_id=${f.grant}::uuid AND principal_id=${f.principal}::uuid`;
        assert.deepEqual(active, { expires_at: null, revoked_at: null }, 'an active until-withdrawn approval exists before rollback');
        assert.equal(access.credential.kind, 'agent');
        if (access.credential.kind !== 'agent') assert.fail('agent facts required');
        const liveAccess: HouseholdAccessFacts = { ...access, credential: { kind: 'agent',
          connection: { ...access.credential.connection, revoked_at: null } } };
        const [clock] = await tx`SELECT (extract(epoch FROM clock_timestamp())*1000)::float8 AS now`;
        assert.equal(householdAccessRefusal(liveAccess, f.workspace, 'read', clock!.now), null);
        await tx.unsafe(repoSql(`${proofRoot}-rollback.sql`));
        const [inverse] = await tx.unsafe(releaseCatalogQuery(repoSql(`${proofRoot}-rollback-catalog.sql`), 'rollback_ok'));
        assert.equal(inverse!.rollback_ok, true);
        const afterConnections = await connections();
        assert.deepEqual(afterConnections.map(r => r.retained), beforeConnections.map(r => r.retained),
          'every connection row and every column except expiry survives unchanged');
        for (const [index, beforeRow] of beforeConnections.entries()) {
          const expiry = afterConnections[index]!.expires_at;
          if (beforeRow.expires_at === null) {
            assert.ok(expiry !== null);
            assert.equal(afterConnections[index]!.ended, true,
              'NULL approval is now expired according to the database clock');
          } else assert.deepEqual(expiry, beforeRow.expires_at, 'existing finite expiries stay unchanged');
        }
        const [ended] = await tx`SELECT expires_at, (extract(epoch FROM clock_timestamp())*1000)::float8 AS now
          FROM swarm.household_content_connections
          WHERE connection_id=${f.connection}::uuid AND grant_id=${f.grant}::uuid AND principal_id=${f.principal}::uuid`;
        const endedAccess: HouseholdAccessFacts = { ...liveAccess, credential: { kind: 'agent',
          connection: { ...access.credential.connection, revoked_at: null, expires_at: new Date(ended!.expires_at as string).getTime() } } };
        assert.equal(householdAccessRefusal(endedAccess, f.workspace, 'read', ended!.now), 'connection_access_refused');
        await tx`SET LOCAL ROLE swarm_command`;
        assert.deepEqual(await api.approveHouseholdConnection(tx, f.workspace, actor, request, input, yes), approved,
          'the earlier approve request id returns the stored success with expires_at null');
        await tx`RESET ROLE`;
        assert.deepEqual(await connections(), afterConnections, 'replay leaves every ended approval unchanged');
        assert.equal(householdAccessRefusal(endedAccess, f.workspace, 'read', ended!.now), 'connection_access_refused',
          'replay does not restore access');
        assert.deepEqual(await audits(), beforeAudit, 'all audit rows survive byte-for-byte');
        const [column] = await tx`SELECT attnotnull, col_description(attrelid,attnum) AS comment FROM pg_attribute
          WHERE attrelid='swarm.household_content_connections'::regclass AND attname='expires_at' AND NOT attisdropped`;
        assert.deepEqual(column, { attnotnull: true, comment: null });
      });
      throw new RollbackProof();
    }), RollbackProof);
  } finally { await db.end(); }
});

// D1 owns permission transaction behavior here. SQL privilege regressions must
// fail through the actual handler; neither authority nor notice delivery is mocked.
const d1Harness = String.raw`
import assert from 'node:assert/strict';
const input = JSON.parse(await new Response(Deno.stdin.readable).text());
const api = await import(input.commandModule);
const auth = await import(input.authModule);
const { HOUSEHOLD_LOCAL_SEAT } = await import(input.protocolModule);
// Expose the actual executor and its external SQL pools in this test module
// only. All imports, capability checks, command/read dispatch and MCP rendering
// remain production code; the pools share the real rollback-only fixture below.
const mcpSource = (await Deno.readTextFile(new URL(input.mcpModule)))
 .replace(/(from\s+|import\()(["'])(\.[^"']+)\2/g,
  (_,prefix,quote,specifier)=>prefix+quote+new URL(specifier,input.mcpModule).href+quote)
 .replace('async function executeTool(', 'export async function executeTool(')
 + '\nexport { authDb, statusDb, createMcpProtocolHandler };';
const mcp = await import('data:application/typescript,'+encodeURIComponent(mcpSource));
const poolBegins = [mcp.authDb.begin, mcp.statusDb.begin];
const originalBegin = api.db.begin.bind(api.db);
class RollbackProof extends Error {}
try {
 await assert.rejects(originalBegin(async tx => {
  await tx.unsafe(input.schema); await tx.unsafe(input.setup);
  let active = tx;
  const q = (sql, args=[]) => active.unsafe(sql,args);
  const reset = async () => { await q('RESET ROLE'); };
  await q("DO $edge$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='commonswarm_edge') THEN CREATE ROLE commonswarm_edge LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS; END IF; END $edge$; GRANT swarm_command,swarm_read,swarm_capability TO commonswarm_edge;");
  const settings=['search_path','lock_timeout','statement_timeout','row_security','request.jwt.claims','cswarm.household_actor','cswarm.household_principal','cswarm.household_request','cswarm.household_digest','cswarm.household_command'];
  const prior = await Promise.all(settings.map(async name => (await q('SELECT current_setting($1,true) AS value',[name]))[0].value));
  const restore = async () => { await reset(); for(let i=0;i<settings.length;i++) await q('SELECT set_config($1,$2,true)',[settings[i],prior[i]??'']); };
  // A real SQL savepoint supplies the handler's transaction rejection boundary
  // inside this rollback-only fixture. Inspect effects BEFORE fixture cleanup.
  api.db.begin = async (...args) => {
   const outer = active;
   try { return await outer.savepoint(async nested => { active=nested; return await args.at(-1)(nested); }); }
   finally { active=outer; await restore(); }
  };
  // Independent MCP pools use real savepoints and preserve the calling SQL
  // role across the nested provider-status transaction, as separate pools do.
  const poolBegin=async(...args)=>{
   const outer=active,role=(await q("SELECT current_setting('role') AS value"))[0].value;
   const values=await Promise.all(settings.map(async name=>(await q('SELECT current_setting($1,true) AS value',[name]))[0].value));
   try{return await outer.savepoint(async nested=>{active=nested;return await args.at(-1)(nested);});}
   finally{active=outer;await q('SELECT set_config($1,$2,true)',['role',role]);for(let i=0;i<settings.length;i++)await q('SELECT set_config($1,$2,true)',[settings[i],values[i]??'']);}
  };
  mcp.authDb.begin = poolBegin; mcp.statusDb.begin = poolBegin;
  const f=input.f;
  const hostedCaller=caller=>caller==='hosted'||caller==='mcp';
  const mcpHandler=mcp.createMcpProtocolHandler({
   issuer:'https://mcp.commonswarm.com',resource:'https://mcp.commonswarm.com/mcp',publicEnabled:true,allowedOrigins:new Set(),
   limits:{maxBodyBytes:128*1024,maxResponseBytes:64*1024,requestTimeoutMs:25_000,maxConcurrentRequests:4},
   verifyToken:async()=>({providerGrantId:'synthetic-'+f.grant,subject:f.owner,expiresAt:1_900_000_000}),executeTool:mcp.executeTool,
  });
  const token='swm_agt_'+'D'.repeat(43);
  const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token)));
  await q("INSERT INTO swarm.agent_principals(principal_id,workspace_id,owner_user_id,name,transport,turn_only) VALUES($1,$2,$3,'Synthetic D1 local','local',false)",[f.local,f.workspace,f.owner]);
  await q("INSERT INTO swarm.devices(device_id,user_id,label) VALUES($1,$2,'Synthetic D1 device')",[f.device,f.owner]);
  await q('INSERT INTO swarm.agent_runs(run_id,principal_id,device_id) VALUES($1,$2,$3)',[f.run,f.local,f.device]);
  await q("INSERT INTO swarm.agent_tokens(token_id,principal_id,run_id,scopes,token_hash,expires_at,lineage_id) VALUES($1,$2,$3,'[]',$4,clock_timestamp()+interval '1 hour',$5)",[f.token,f.local,f.run,digest,f.lineage]);
  await q("INSERT INTO swarm.config(key,value) VALUES('min_client_version','\"0.1.0\"') ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  const sibling=crypto.randomUUID(),siblingSeat=crypto.randomUUID();
  await q("INSERT INTO swarm.agent_principals(principal_id,workspace_id,owner_user_id,name,transport,turn_only) VALUES($1,$2,$3,'Synthetic same-grant sibling','hosted_mcp',true)",[sibling,f.workspace,f.owner]);
  await q("INSERT INTO swarm.hosted_mcp_seats(seat_id,grant_id,workspace_id,owner_user_id,principal_id,name,created_at) VALUES($1,$2,$3,$4,$5,'Synthetic same-grant sibling',clock_timestamp())",[siblingSeat,f.grant,f.workspace,f.owner,sibling]);
  const oauthBefore=await q("SELECT to_jsonb(m)::text AS row FROM pg_auth_members m WHERE roleid='commonswarm_oauth_runtime'::regrole AND member='commonswarm_edge'::regrole ORDER BY grantor");
  const capabilityFor = async(tool)=>{
   await q('SET LOCAL SESSION AUTHORIZATION commonswarm_edge'); await q('SET LOCAL ROLE swarm_command');
   try { return await auth.authenticateHostedSeatCapability(active,{grantId:f.grant,providerGrantId:'synthetic-'+f.grant,handle:f.handle,tool,providerStatus:async provider=>{
    await q('SET LOCAL ROLE swarm_read');try{return {active:(await q('SELECT commonswarm_oauth.provider_family_active($1) AS active',[provider]))[0].active};}finally{await q('SET LOCAL ROLE swarm_command');}
   }},'command'); } finally { await reset(); await q('RESET SESSION AUTHORIZATION'); }
  };
  const cap=await capabilityFor('list_permissions_confirm');
  assert.ok(cap,'real hosted capability positive control');
  const invoke=async (caller,action,id=crypto.randomUUID(),workspace=f.workspace,command,capability=cap)=>{
   const args={seat:hostedCaller(caller)?f.handle:HOUSEHOLD_LOCAL_SEAT,request_id:id,confirmation:{kind:'owner_chat',confirmed:true},action};
   const envelope={command_id:id,client_version:'0.1.83',workspace_id:workspace,stream:{kind:'workspace'},command:command??{kind:'household_tool',tool:hostedCaller(caller)?'list_permissions_confirm':'object_permissions_confirm',arguments:args}};
   await q('SET LOCAL SESSION AUTHORIZATION commonswarm_edge');
   try {
    if(caller==='mcp'){
     const response=await mcpHandler(new Request('https://mcp.commonswarm.com/mcp',{method:'POST',
      headers:{authorization:'Bearer synthetic-d1','content-type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:'d1',method:'tools/call',params:{name:envelope.command.tool,arguments:envelope.command.arguments}})}));
     assert.equal(response.status,200,'MCP transport remains successful');
     const rpc=await response.json();assert.equal(rpc.error,undefined,'MCP must return tool content');
     const output=JSON.parse(rpc.result.content[0].text);
     assert.notEqual(output.reason,'hosted_seat_forbidden','D1 refusal must survive executeTool');
     assert.equal(rpc.result.isError,undefined,'D1 refusal remains structured content');
     assert.equal(rpc.result._meta,undefined,'D1 refusal must not request reconnect');
     assert.notEqual(output.error,'hosted_seat_forbidden');
     if(output.status==='refused')assert.equal(typeof output.next_action,'string','MCP retains the recovery step');
     return {status:response.status,body:output};
    }
    if(caller==='hosted')return await api.handleHostedCommand(envelope,capability);
    if(caller==='human')return await api.handleHostedManagementCommand(envelope,{userId:f.owner,email:null,displayName:'Synthetic owner',identityVerified:true,interactiveAuthAtSeconds:null});
    const response=await api.handleRequest(new Request('http://localhost/command',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(envelope)}));
    return {status:response.status,body:await response.json()};
   } finally {await reset();await q('RESET SESSION AUTHORIZATION');}
  };
  const count=async(table)=>Number((await q('SELECT count(*)::int AS n FROM swarm.'+table+' WHERE workspace_id=$1',[f.workspace]))[0].n);
  const snapshot=async()=>{
   const result={};for(const table of ['memberships','hosted_mcp_seats','household_workspace_boundaries','household_member_content_roles','household_content_connections','household_owner_permission_receipts','household_object_audit','signals','signal_deliveries'])
    result[table]=await q('SELECT to_jsonb(r)::text AS row FROM swarm.'+table+' r WHERE workspace_id=$1 ORDER BY to_jsonb(r)::text',[f.workspace]);return result;
  };
  const setup={kind:'setup',purpose:'shared',content_role:'editor'};
  for(const caller of ['human','local','hosted','mcp']){
   await q('DELETE FROM swarm.household_content_connections WHERE workspace_id=$1',[f.workspace]);
   await q('DELETE FROM swarm.household_member_content_roles WHERE workspace_id=$1',[f.workspace]);
   await q('DELETE FROM swarm.household_workspace_boundaries WHERE workspace_id=$1',[f.workspace]);
   const id=crypto.randomUUID(),before=await count('signals');
   const result=await invoke(caller,setup,id);assert.equal(result.status,200,caller+' setup HTTP');assert.equal(result.body.status,'committed',caller+' setup');
   const principal=caller==='human'?null:caller==='local'?f.local:f.principal;
   const rows=await q('SELECT actor_user,actor_principal,command_kind FROM swarm.household_object_audit WHERE workspace_id=$1 AND command_id=$2',[f.workspace,id]);
   assert.equal(rows.length,2);for(const row of rows){assert.equal(row.actor_user,f.owner);assert.equal(row.actor_principal,principal);assert.equal(row.command_kind,'household_owner_permissions');}
   const delivery=await q('SELECT recipient_user_id FROM swarm.signal_deliveries WHERE signal_id=$1',[result.body.notice.signal_id]);
   assert.ok(delivery.some(row=>row.recipient_user_id===f.owner),'owner notice delivery persists');
   const frozen=await snapshot();const replay=await invoke(caller,setup,id);assert.equal(replay.body.replayed,true);assert.deepEqual(await snapshot(),frozen);assert.equal(await count('signals'),before+1);
   const reused=await invoke(caller,{...setup,content_role:'reader'},id);assert.equal(reused.status,hostedCaller(caller)?200:409);assert.equal(reused.body.status,'refused');assert.equal(reused.body.reason,'request_id_reused');assert.equal(reused.body.code,'request_id_reused');assert.equal(reused.body.mcp_tool,null);assert.equal(reused.body.cli_command,null);assert.deepEqual(await snapshot(),frozen);
  }
  const allow={kind:'allow_connection',connection:{kind:'hosted',connection_id:f.target.connection,grant_id:f.target.grant,principal_id:f.target.principal,operations:['read','update']}};
  for(const caller of ['human','local','hosted']){
   const result=await invoke(caller,allow);assert.equal(result.status,200,caller+' Allow');assert.equal(result.body.status,'committed');
   assert.deepEqual((await q('SELECT operations FROM swarm.household_content_connections WHERE connection_id=$1',[f.target.connection]))[0].operations,['read','update']);
  }
  // Every negative changes one live fact in a rollback savepoint. A valid Allow
  // runs after restoration, so a broad unrelated denial cannot satisfy the test.
  const negative=async(label,mutate,action=allow,reason,caller='hosted',workspace=f.workspace)=>{
   const before=await snapshot();
   await assert.rejects(tx.savepoint(async nested=>{active=nested;await mutate();const result=await invoke(caller,action,crypto.randomUUID(),workspace);assert.ok(result.status>=400||(caller==='hosted'&&result.status===200&&result.body.status==='refused'),label);assert.notEqual(result.body.status,'committed',label);if(reason)assert.equal(result.body.reason,reason,label);throw new RollbackProof();}),RollbackProof);
   active=tx;await restore();assert.deepEqual(await snapshot(),before,label+' rolls back');assert.equal((await invoke('hosted',allow)).body.status,'committed',label+' restored positive');
  };
  await negative('downgraded owner',()=>q("UPDATE swarm.memberships SET role='admin' WHERE workspace_id=$1 AND user_id=$2",[f.workspace,f.owner]),allow,'owner_confirmation_required');
  await negative('self',async()=>{}, {...allow,connection:{...allow.connection,connection_id:f.connection,grant_id:f.grant,principal_id:f.principal}},'self_permission_change_refused');
  await negative('shared source grant',async()=>{}, {...allow,connection:{...allow.connection,connection_id:siblingSeat,grant_id:f.grant,principal_id:sibling}},'self_permission_change_refused');
  await negative('revoked local source',()=>q('UPDATE swarm.agent_tokens SET revoked_at=clock_timestamp() WHERE token_id=$1',[f.token]),allow,undefined,'local');
  await negative('foreign tuple',async()=>{}, {...allow,connection:{...allow.connection,grant_id:crypto.randomUUID()}},'connection_access_refused');
  await negative('reader ceiling',()=>q("UPDATE swarm.household_member_content_roles SET content_role='reader' WHERE workspace_id=$1 AND user_id=$2",[f.workspace,f.owner]),allow,'content_read_only');
  await negative('revoked target',()=>q('UPDATE swarm.hosted_mcp_seats SET revoked_at=clock_timestamp() WHERE seat_id=$1',[f.target.connection]),allow,'connection_access_refused');
  await negative('revoked target handle',()=>q('UPDATE swarm.hosted_mcp_seat_handles SET revoked_at=clock_timestamp() WHERE seat_id=$1',[f.target.connection]),allow,'connection_access_refused');
  await negative('revoked provider family',()=>q('INSERT INTO commonswarm_oauth.refresh_family_tombstones(grant_id,revoked_at) VALUES($1,clock_timestamp())',['synthetic-'+f.target.grant]),allow,'connection_access_refused');
  await negative('revoked source',()=>q('UPDATE swarm.hosted_mcp_seats SET revoked_at=clock_timestamp() WHERE seat_id=$1',[f.connection]));
  await negative('restricted source',()=>q("INSERT INTO swarm.household_hosted_content_restrictions(grant_id,workspace_id,owner_user_id,principal_id,operations,origin) VALUES($1,$2,$3,$4,ARRAY['read'],'human_allow')",[f.grant,f.workspace,f.owner,f.principal]),allow,'caller_content_restricted');
  // Human/local D1 HTTP uses 409; hosted D1 preserves structured 200 tool
  // content through executeTool. Legacy tools and human drafts retain 200.
  const draftCap=await capabilityFor('list_draft_read'),legacyCap=await capabilityFor('list_list');
  for(const caller of ['human','local','hosted','mcp']){
   const command={kind:'household_tool',tool:hostedCaller(caller)?'list_draft_read':'object_draft_read',
    arguments:{seat:hostedCaller(caller)?f.handle:HOUSEHOLD_LOCAL_SEAT,draft_id:'missing-private-draft'}};
   const denied=await invoke(caller,null,crypto.randomUUID(),f.workspace,command,draftCap);
   assert.equal(denied.status,hostedCaller(caller)?200:409);assert.equal(denied.body.status,'refused');
   assert.equal(denied.body.reason,'draft_access_refused');
   assert.equal(denied.body.mcp_tool,null);assert.equal(denied.body.cli_command,null);
  }
  const humanDraft=await invoke('human',null,crypto.randomUUID(),f.workspace,{kind:'household_draft',draft_id:'missing-private-draft'});
  assert.equal(humanDraft.status,200);assert.equal(humanDraft.body.status,'refused');
  for(const caller of ['local','hosted']){
   const legacy=await invoke(caller,null,crypto.randomUUID(),f.workspace,{kind:'household_tool',
    tool:caller==='hosted'?'list_list':'object_list',arguments:{seat:hostedCaller(caller)?f.handle:HOUSEHOLD_LOCAL_SEAT}},legacyCap);
   assert.equal(legacy.status,200);assert.equal(legacy.body.status,'ok');
  }
  const assertAborted=(result,reason,caller='hosted')=>{
   assert.equal(result.status,hostedCaller(caller)?200:409);assert.equal(result.body.status,'refused');assert.equal(result.body.committed,false);
   assert.equal(result.body.reason,reason);assert.equal(result.body.code,reason);
   assert.deepEqual(result.body.scope,{});assert.equal(result.body.remedy_url,null);
   assert.equal(result.body.mcp_tool,null);assert.equal(result.body.cli_command,null);
   for(const key of ['notice','request_id','replayed','action','signal_id'])assert.equal(key in result.body,false,key+' cannot imply success');
  };
  // A real port refusal occurs after permission/audit writes. Inspect the
  // handler's rollback immediately, before rolling back fixture rate limits.
  for(const caller of ['local','hosted','mcp']){
   const before=await snapshot();
   await assert.rejects(tx.savepoint(async nested=>{
    active=nested;const bucket=hostedCaller(caller)?'hosted_seat:'+f.connection:'agent:'+f.token;
    await q("INSERT INTO swarm.rate_buckets(bucket_key,window_start,count) VALUES($1,date_trunc('hour',statement_timestamp()),10000) ON CONFLICT(bucket_key,window_start) DO UPDATE SET count=excluded.count",['signal:credential:'+bucket]);
    assertAborted(await invoke(caller,{...allow,connection:{...allow.connection,operations:['read']}}),'owner_notice_unavailable',caller);
    assert.deepEqual(await snapshot(),before,'failed notice rolled back before response');
    throw new RollbackProof();
   }),RollbackProof);active=tx;await restore();
   assert.equal((await invoke(caller,allow)).body.status,'committed','restored notice positive');
  }
  // Database-trigger fault injection leaves real permission, audit, signal and
  // delivery writes in flight before the final live authority check rejects.
  // No production hook, fake notice implementation or extra role grant is used.
  for(const [label,mutation,reason] of [
   ['source',"UPDATE swarm.hosted_mcp_seats SET revoked_at=clock_timestamp() WHERE seat_id='"+f.connection+"'",'credential_revoked'],
   ['target',"UPDATE swarm.hosted_mcp_seats SET revoked_at=clock_timestamp() WHERE seat_id='"+f.target.connection+"'",'connection_access_refused'],
   ['owner',"UPDATE swarm.memberships SET role='admin' WHERE workspace_id='"+f.workspace+"' AND user_id='"+f.owner+"'",'owner_confirmation_required']
  ]){
   const before=await snapshot();
   await assert.rejects(tx.savepoint(async nested=>{
    active=nested;
    await q("CREATE FUNCTION pg_temp.d1_delivery_fence() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$ BEGIN IF NEW.recipient_user_id='"+f.owner+"'::uuid THEN "+mutation+"; END IF; RETURN NEW; END $f$; CREATE TRIGGER d1_delivery_fence AFTER INSERT ON swarm.signal_deliveries FOR EACH ROW EXECUTE FUNCTION pg_temp.d1_delivery_fence()");
    assertAborted(await invoke('hosted',{...allow,connection:{...allow.connection,operations:['read']}}),reason);
    assert.deepEqual(await snapshot(),before,label+' rollback includes actual notice and delivery before response');
    throw new RollbackProof();
   }),RollbackProof);active=tx;await restore();
   assert.equal((await invoke('hosted',allow)).body.status,'committed',label+' restored positive');
  }
  // An unknown exception must stay a failure, even after permission writes.
  // It cannot become a success or a known-abort refusal.
  const beforeUnknown=await snapshot();
  await assert.rejects(tx.savepoint(async nested=>{
   active=nested;
   await q("CREATE FUNCTION pg_temp.d1_unknown_failure() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 'synthetic-private-db-details'; END $f$; CREATE TRIGGER d1_unknown_failure AFTER INSERT ON swarm.signal_deliveries FOR EACH ROW EXECUTE FUNCTION pg_temp.d1_unknown_failure()");
   await assert.rejects(invoke('hosted',{...allow,connection:{...allow.connection,operations:['read']}}),error=>error.code==='P0001');
   assert.deepEqual(await snapshot(),beforeUnknown,'unknown failure also rolls back before escaping');
   throw new RollbackProof();
  }),RollbackProof);active=tx;await restore();
  assert.equal((await invoke('hosted',allow)).body.status,'committed','unknown failure restored positive');
  assert.deepEqual(await q("SELECT to_jsonb(m)::text AS row FROM pg_auth_members m WHERE roleid='commonswarm_oauth_runtime'::regrole AND member='commonswarm_edge'::regrole ORDER BY grantor"),oauthBefore);
  throw new RollbackProof();
 }),RollbackProof);
 console.log('D1_ROLE_NOTICE_RESULT:ok');
} finally {api.db.begin=originalBegin;[mcp.authDb.begin,mcp.statusDb.begin]=poolBegins;await Promise.all([api.db.end(),mcp.authDb.end(),mcp.statusDb.end()]);}
`;

test('D1 real edge session and MCP executeTool preserve draft/replay/notice refusals and roll back failed delivery', {timeout:120_000}, () => {
 const local=JSON.parse(execFileSync('supabase',['status','-o','json'],{encoding:'utf8',stdio:['ignore','pipe','ignore']})) as {DB_URL:string;API_URL:string;SERVICE_ROLE_KEY:string};
 assert.ok(['127.0.0.1','localhost','[::1]'].includes(new URL(local.API_URL).hostname));
 const f={...fixture(),local:randomUUID(),device:randomUUID(),run:randomUUID(),token:randomUUID(),lineage:randomUUID(),target:null as ReturnType<typeof hostedFixture>|null};
 f.target=hostedFixture(f.workspace,f.owner);
 const result=spawnSync('deno',['eval','--no-lock','--config','supabase/functions/command/deno.json',d1Harness],{
  cwd:process.cwd(),encoding:'utf8',input:JSON.stringify({f,setup:f.setup+f.target.setup,schema:emptyApplicationSchema(),
   commandModule:new URL('../../supabase/functions/command/index.ts',import.meta.url).href,
   mcpModule:new URL('../../supabase/functions/mcp/index.ts',import.meta.url).href,
   authModule:new URL('../../supabase/functions/_shared/hosted-seat-auth.ts',import.meta.url).href,
   protocolModule:new URL('../../supabase/functions/_shared/protocol.js',import.meta.url).href}),
  env:{PATH:process.env.PATH??'',...(process.env.DENO_DIR?{DENO_DIR:process.env.DENO_DIR}:{}),SWARM_ENV:'test',SWARM_DATABASE_URL:localClusterAdminUrl(local.DB_URL),SUPABASE_URL:local.API_URL,SUPABASE_ANON_KEY:'synthetic-anon',SUPABASE_SERVICE_ROLE_KEY:local.SERVICE_ROLE_KEY},timeout:110_000,maxBuffer:1024*1024});
 writeFileSync('.maker-evidence/d1-role-notice.stderr.log',result.stderr??'',{mode:0o600});
 assert.equal(result.status,0,'D1 real-role/notice harness must complete; inspect private CI stderr on failure');
 assert.match(result.stdout,/D1_ROLE_NOTICE_RESULT:ok/);
});
