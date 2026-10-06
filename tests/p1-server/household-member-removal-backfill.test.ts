/** CI only. Real DDL and invitation/store boundaries; every write rolls back. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { emptyApplicationSchema, localClusterAdminUrl, repoSql } from '../support/admin-schema-db.js';
import { humanInvitationTransaction } from '../../supabase/functions/command/household-invitations.ts';
import { createHouseholdObjectStore } from '../../supabase/functions/command/household-objects.ts';
import * as objects from '../../src/protocol/household-objects.js';
import * as policy from '../../src/protocol/household-object-policy.js';
import * as transfers from '../../supabase/functions/command/household-transfers.ts';
import { HOUSEHOLD_JOIN_CONSENT_VERSION } from '../../src/protocol/household-invitations.js';

const proof = 'deploy/release-proofs/household-member-removal/20261005000001';
const migration = repoSql('supabase/migrations/20261005000001_household_member_removal.sql');
const repair = migration.match(/DO \$household_member_removal_backfill\$[\s\S]*?\$household_member_removal_backfill\$;/)?.[0];
const precount = repoSql(`${proof}-precount.sql`);
const releaseRepair = repoSql(`${proof}-backfill.sql`);
class RollbackProof extends Error {}

test('historical and schema-to-edge removals are repaired idempotently, preserved on rollback, and cannot regain content through invitation', { timeout: 120_000 }, async () => {
  assert.ok(repair, 'migration is missing the historical removal repair');
  const local: { DB_URL: string } = JSON.parse(execFileSync('supabase', ['status', '-o', 'json'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }));
  const db = postgres(localClusterAdminUrl(local.DB_URL), { prepare: false, max: 1 });
  const owner = randomUUID(), member = randomUUID(), workspace = randomUUID(), other = randomUUID();
  const grant = randomUUID(), consent = randomUUID();
  const stamp = new Date('2026-10-04T00:00:00.000Z'), frozen = new Date('2026-10-03T00:00:00.000Z');
  const digest = 'ab'.repeat(32);
  const link = () => {
    const token = `swm_inv_${randomUUID().replaceAll('-', '')}abcdefghijk`;
    return { token, hash: createHash('sha256').update(token).digest() };
  };
  const pending = link(), fresh = link();
  const identity = { user_id: member, principal_id: null, run_id: null, connection: null };
  const human = { user_id: member, email: `${member}@example.test`, verified: true };
  const store = createHouseholdObjectStore({ core: { ...objects, ...policy }, transfers,
    storage: { putImmutable: async () => { throw new Error('unexpected storage write'); },
      read: async () => { throw new Error('unexpected storage read'); } },
    fileContentAllowed: () => false, recheckCredential: async () => true,
  });
  const counts = async (tx: postgres.TransactionSql<Record<string, unknown>>) => {
    const rows = await tx.unsafe(precount);
    assert.equal(rows.length, 1, 'release counts are one named row');
    return Object.fromEntries(Object.entries(rows[0]!).map(([key, value]) => [key, Number(value)]));
  };
  const expectedCounts = (n: number) => ({ revoked_memberships_with_content_roles: n,
    revoked_memberships_with_content_connections: n, revoked_memberships_with_pending_link_invitations: n,
    revoked_memberships_with_unaccepted_delegated_invitations: n });
  const snapshot = async (tx: postgres.TransactionSql<Record<string, unknown>>) => {
    const result: Record<string, unknown[]> = {};
    for (const table of ['memberships', 'household_member_content_roles', 'household_content_connections',
      'invitations', 'admin_routine_invitations', 'household_object_audit']) {
      result[table] = (await tx.unsafe(`SELECT to_jsonb(r)::text AS row FROM swarm.${table} r ORDER BY to_jsonb(r)::text`)).map(row => row.row);
    }
    return result;
  };
  // Independent fixture rules shared by the migration and post-edge repair proofs.
  const assertRepair = (before: Record<string, unknown[]>, after: Record<string, unknown[]>, targetWorkspace: string, repairTime: number) => {
    for (const [table, raw] of Object.entries(before)) {
      const expected = raw.map(value => {
        const row = JSON.parse(String(value));
        const target = row.workspace_id === targetWorkspace && (row.user_id === member || row.owner_user_id === member || row.recipient_user_id === member || row.email === human.email);
        const repairable = table === 'household_member_content_roles' || table === 'household_content_connections'
          || table === 'admin_routine_invitations' && row.accepted_at === null && new Date(row.created_at).getTime() <= stamp.getTime()
          || table === 'invitations' && row.consumed_at === null && new Date(row.created_at).getTime() <= stamp.getTime()
            && new Date(row.expires_at).getTime() > repairTime;
        if (target && repairable && row.revoked_at === null) row.revoked_at = stamp.toISOString();
        return row;
      });
      const normalize = (rows: unknown[]) => rows.map(row => JSON.stringify(row, (key, value) =>
        key.endsWith('_at') && typeof value === 'string' ? new Date(value).toISOString() : value)).sort();
      assert.deepEqual(normalize(after[table]!.map(value => JSON.parse(String(value)))), normalize(expected), `${table}: only removed member revocations change`);
    }
  };
  const catalog = async (tx: postgres.TransactionSql<Record<string, unknown>>, suffix: 'catalog' | 'rollback-catalog') => {
    const rows = await tx.unsafe(repoSql(`${proof}-${suffix}.sql`).replace(/\\gset\s*$/, ';'));
    assert.equal(rows[0]?.[suffix === 'catalog' ? 'catalog_ok' : 'rollback_ok'], true);
  };
  try {
    await assert.rejects(db.begin(async tx => {
      await tx.unsafe(emptyApplicationSchema());
      await tx.unsafe('ALTER SCHEMA swarm RENAME TO absent_swarm;');
      assert.deepEqual(await counts(tx), expectedCounts(0));
      await tx.unsafe('ALTER SCHEMA absent_swarm RENAME TO swarm;');
      // Demonstrate that the release query works even before household tables exist.
      await tx.unsafe('ALTER TABLE swarm.household_member_content_roles RENAME TO absent_content_roles; ALTER TABLE swarm.household_content_connections RENAME TO absent_content_connections;');
      assert.deepEqual(await counts(tx), expectedCounts(0));
      await tx.unsafe('ALTER TABLE swarm.absent_content_roles RENAME TO household_member_content_roles; ALTER TABLE swarm.absent_content_connections RENAME TO household_content_connections;');
      // Install the current trigger before fixtures; only the repair block runs after old removal.
      await tx.unsafe(migration);
      for (const user of [owner, member]) {
        await tx`INSERT INTO auth.users(id,aud,role,email) VALUES (${user}::uuid,'authenticated','authenticated',${`${user}@example.test`})`;
        await tx`INSERT INTO swarm.users(user_id,display_name,email) VALUES (${user}::uuid,'Synthetic person',${`${user}@EXAMPLE.test`})`;
      }
      for (const w of [workspace, other]) {
        await tx`INSERT INTO swarm.workspaces(workspace_id,name,created_by) VALUES (${w}::uuid,'Synthetic repair',${owner}::uuid)`;
        await tx`INSERT INTO swarm.streams(stream_id,workspace_id,kind) VALUES (${randomUUID()}::uuid,${w}::uuid,'workspace')`;
        await tx`INSERT INTO swarm.memberships(workspace_id,user_id,role) VALUES (${w}::uuid,${owner}::uuid,'owner'),(${w}::uuid,${member}::uuid,'member')`;
        await tx`INSERT INTO swarm.household_workspace_boundaries(workspace_id,purpose) VALUES (${w}::uuid,'shared')`;
        for (const user of [owner, member]) {
          await tx`INSERT INTO swarm.household_member_content_roles(workspace_id,user_id,content_role,content_consent_id,confirmed_at)
            VALUES (${w}::uuid,${user}::uuid,'editor',${consent}::uuid,${frozen})`;
          const principal = randomUUID();
          await tx`INSERT INTO swarm.agent_principals(principal_id,workspace_id,owner_user_id,name,transport,turn_only)
            VALUES (${principal}::uuid,${w}::uuid,${user}::uuid,'Synthetic agent','local',false)`;
          for (const variant of ['live', 'expired', 'revoked']) {
            await tx`INSERT INTO swarm.household_content_connections(connection_id,grant_id,workspace_id,principal_id,owner_user_id,purpose,operations,consent_receipt_id,expires_at,revoked_at)
              VALUES (${randomUUID()}::uuid,${grant}::uuid,${w}::uuid,${principal}::uuid,${user}::uuid,'shared',ARRAY['read'],${consent}::uuid,
                ${variant === 'expired' ? frozen : null},${variant === 'revoked' ? frozen : null})`;
          }
        }
        for (const user of [owner, member]) {
          for (const variant of ['pending', 'at-removal', 'reinvite', 'expired', 'consumed', 'revoked', 'unaddressed']) {
            const key = w === workspace && user === member
              ? variant === 'pending' ? pending : variant === 'reinvite' ? fresh : link() : link();
            const created = variant === 'reinvite' ? new Date(stamp.getTime()+30_000)
              : variant === 'at-removal' ? stamp : frozen;
            await tx`INSERT INTO swarm.invitations(invitation_id,workspace_id,email,role,token_hash,expires_at,created_by,created_at,consumed_at,consumed_by,revoked_at)
              VALUES (${randomUUID()}::uuid,${w}::uuid,${variant === 'unaddressed' ? null : `${user}@example.test`},'member',${key.hash},
                ${variant === 'expired' ? frozen : new Date('2099-01-01T00:00:00Z')},${owner}::uuid,${created},
                ${variant === 'consumed' ? frozen : null},${variant === 'consumed' ? user : null}::uuid,${variant === 'revoked' ? frozen : null})`;
          }
        }
      }
      await tx.unsafe(`INSERT INTO swarm.admin_accounts(owner_user_id,stream_id) VALUES ('${owner}','${randomUUID()}');
        INSERT INTO swarm.admin_grants(grant_id,owner_user_id,admin_identity_id,connection_id,client_id,resource,registry_version,
          workspace_ids,created_workspace_policy,target_rules,worker_scope_ceiling,role_ceiling,renewal_limits,issuance_limits,
          expires_at,refresh_deadline,state,consent_receipt_id,manifest_digest,created_at)
        VALUES ('${grant}','${owner}','${randomUUID()}','${randomUUID()}','https://client.example/${grant}','https://api.commonswarm.com/admin',2,
          '{}','{"scope_names":[]}','{}','{}','member','{}','{}',date_trunc('second',statement_timestamp())+interval '1 day',
          date_trunc('second',statement_timestamp())+interval '1 day','active','${randomUUID()}','${digest}',date_trunc('second',statement_timestamp()));`);
      for (const w of [workspace, other]) for (const user of [owner, member]) {
        for (const variant of ['pending', 'at-removal', 'reinvite', 'expired', 'accepted', 'revoked']) {
          await tx`INSERT INTO swarm.admin_routine_invitations(invitation_id,workspace_id,parent_admin_grant_id,owner_user_id,recipient_user_id,invitation_kind,expires_at,created_at,accepted_at,revoked_at,projection)
            VALUES (${randomUUID()}::uuid,${w}::uuid,${grant}::uuid,${owner}::uuid,${user}::uuid,'member',
              ${variant === 'expired' ? stamp : new Date('2099-01-01T00:00:00Z')},
              ${variant === 'reinvite' ? new Date(stamp.getTime()+30_000) : variant === 'at-removal' ? stamp : frozen},
              ${variant === 'accepted' ? frozen : null},${variant === 'revoked' ? frozen : null},${tx.json({ role: 'member' })})`;
        }
      }
      // OLD behavior: only membership gets a stamp; all content and invites stay live.
      await tx`UPDATE swarm.memberships SET revoked_at=${stamp} WHERE workspace_id=${workspace}::uuid AND user_id=${member}::uuid`;
      assert.deepEqual(await counts(tx), expectedCounts(1));
      // B1: a shared database may contain old-style removals during a catalog drill.
      await catalog(tx, 'catalog');
      const before = await snapshot(tx);
      const [clock] = await tx`SELECT statement_timestamp() AS now`;
      const repairTime = new Date(clock!.now).getTime();
      await tx.unsafe(repair);
      assert.deepEqual(await counts(tx), expectedCounts(0));
      const after = await snapshot(tx);
      assertRepair(before, after, workspace, repairTime);
      await tx.unsafe(repair);
      assert.deepEqual(await snapshot(tx), after, 'second repair changes no row, including audit');
      await catalog(tx, 'catalog');
      // B2/B3: both proofs work with a removed member's later pending re-invites.
      await tx.unsafe(repoSql(`${proof}-rollback.sql`));
      await catalog(tx, 'rollback-catalog');
      assert.deepEqual(await snapshot(tx), after, 'rollback keeps repaired rows and later invitations');
      await tx.unsafe(migration.slice(0, migration.indexOf('DO $household_member_removal_backfill$')));
      await catalog(tx, 'catalog');
      await tx.unsafe('SET LOCAL ROLE swarm_command');
      const denied = await humanInvitationTransaction(tx, 'repair-stale', { kind: 'household_invitation', action: 'preview', invitation: { source: 'link', token: pending.token } }, human);
      assert.equal(denied.status, 403);
      assert.equal((denied.body as { reason: string }).reason, 'invitation_predates_removal');
      const staleAccept = await humanInvitationTransaction(tx, 'repair-stale-accept', {
        kind: 'household_invitation', action: 'accept', invitation: { source: 'link', token: pending.token },
        consent_version: HOUSEHOLD_JOIN_CONSENT_VERSION, preview_digest: digest, content_role: 'reader',
      }, human);
      assert.equal(staleAccept.status, 403);
      assert.equal((staleAccept.body as { reason: string }).reason, 'invitation_predates_removal');
      assert.deepEqual(await store.read(tx, workspace, identity, { kind: 'object_list', offset: 0, limit: 10 }), { status: 'refused', reason: 'workspace_access_refused' });
      await tx.unsafe('RESET ROLE');
      assert.deepEqual(await snapshot(tx), after, 'stale invitation cannot change membership or content');
      await tx.unsafe('SET LOCAL ROLE swarm_command');
      const preview = await humanInvitationTransaction(tx, 'repair-fresh-preview', { kind: 'household_invitation', action: 'preview', invitation: { source: 'link', token: fresh.token } }, human);
      assert.equal(preview.status, 200);
      const joined = await humanInvitationTransaction(tx, 'repair-fresh-accept', {
        kind: 'household_invitation', action: 'accept', invitation: { source: 'link', token: fresh.token },
        consent_version: HOUSEHOLD_JOIN_CONSENT_VERSION, preview_digest: (preview.body as { preview_digest: string }).preview_digest, content_role: 'reader',
      }, human);
      assert.equal(joined.status, 200, JSON.stringify(joined.body));
      assert.equal((joined.body as { content_role: string | null }).content_role, null);
      assert.deepEqual(await store.read(tx, workspace, identity, { kind: 'object_list', offset: 0, limit: 10 }), { status: 'refused', reason: 'workspace_access_refused' });
      const live = await store.access(tx, other, identity);
      assert.ok(live);
      assert.equal(policy.householdAccessRefusal(live.facts, other, 'read', live.now), null, 'same person in other workspace still reads');
      await tx.unsafe('RESET ROLE');
      // R3 B1: migration repair was already run and recounted to zero. The
      // previous edge can then make the FIRST removal in another workspace,
      // which was outside the initial repair's workspace lock population.
      assert.deepEqual(await counts(tx), expectedCounts(0));
      await tx`UPDATE swarm.memberships SET revoked_at=${stamp} WHERE workspace_id=${other}::uuid AND user_id=${member}::uuid`;
      await catalog(tx, 'catalog');
      assert.deepEqual(await counts(tx), expectedCounts(1), 'post-edge recount detects the release-window removal');
      const releaseBefore = await snapshot(tx);
      const [releaseClock] = await tx`SELECT statement_timestamp() AS now`;
      // Execute the actual artifact shipped for operators after edge cutover.
      await tx.unsafe(releaseRepair);
      assert.deepEqual(await counts(tx), expectedCounts(0), 'post-edge repair closes every release count');
      const releaseAfter = await snapshot(tx);
      assertRepair(releaseBefore, releaseAfter, other, new Date(releaseClock!.now).getTime());
      await tx.unsafe(releaseRepair);
      assert.deepEqual(await snapshot(tx), releaseAfter, 'post-edge repair is also idempotent');
      await tx.unsafe('SET LOCAL ROLE swarm_command');
      assert.deepEqual(await store.read(tx, other, identity, { kind: 'object_list', offset: 0, limit: 10 }),
        { status: 'refused', reason: 'workspace_access_refused' }, 'late removal cannot read household content');
      const ownerAccess = await store.access(tx, other, { ...identity, user_id: owner });
      assert.ok(ownerAccess);
      assert.equal(policy.householdAccessRefusal(ownerAccess.facts, other, 'read', ownerAccess.now), null, 'live owner still reads');
      await tx.unsafe('RESET ROLE');
      const beforeRollback = await snapshot(tx);
      await tx.unsafe(repoSql(`${proof}-rollback.sql`));
      await catalog(tx, 'rollback-catalog');
      assert.deepEqual(await snapshot(tx), beforeRollback, 'rollback preserves all repaired data and history');
      throw new RollbackProof();
    }), RollbackProof);
  } finally { await db.end(); }
});
