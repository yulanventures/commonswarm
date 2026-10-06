/** CI only: member removal revokes content in the database and a rejoin restores none of it. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import postgres from 'postgres';
import { runSql, repoSql, dbAssert, refuses, localClusterAdminUrl } from '../support/admin-schema-db.js';
import { pendingLinkInvitationIds, revokeRemovedMemberHousehold } from '../../supabase/functions/command/household-member-removal.ts';
import { humanInvitationTransaction } from '../../supabase/functions/command/household-invitations.ts';
import { provisionHouseholdPermissions } from '../../supabase/functions/command/household-permissions.ts';
import { HOUSEHOLD_JOIN_CONSENT_VERSION } from '../../src/protocol/household-invitations.js';

const proof = 'deploy/release-proofs/household-member-removal/20261005000001';

function psqlProof(suffix: 'catalog' | 'rollback-catalog') {
  const alias = suffix === 'catalog' ? 'catalog_ok' : 'rollback_ok';
  return repoSql(`${proof}-${suffix}.sql`) + `
    SELECT :'${alias}'::boolean AS proof_pass \\gset
    \\if :proof_pass
    \\else
      DO $$ BEGIN RAISE EXCEPTION 'member removal ${suffix} failed'; END $$;
    \\endif
  `;
}

test('member removal trigger allows one content stamp and refuses a second write, a column change, and a cross-workspace write', () => {
  const owner = randomUUID(), admin = randomUUID(), member = randomUUID(), outsider = randomUUID();
  const workspace = randomUUID(), other = randomUUID(), grant = randomUUID();
  const ownerPrincipal = randomUUID(), memberPrincipal = randomUUID();
  const ownerConsent = randomUUID(), adminConsent = randomUUID(), memberConsent = randomUUID(), freshConsent = randomUUID();
  const liveConnection = randomUUID(), expiredConnection = randomUUID(), ownerConnection = randomUUID();
  const pendingInvite = randomUUID(), acceptedInvite = randomUUID(), otherInvite = randomUUID();
  const digest = 'ab'.repeat(32);
  const context = (kind: string, actor: string, request: string) => `SELECT set_config('cswarm.household_actor','${actor}',true),
    set_config('cswarm.household_request','${request}',true),set_config('cswarm.household_digest','${digest}',true),
    set_config('cswarm.household_command','${kind}',true);`;
  const role = (workspaceId: string, userId: string) =>
    `workspace_id='${workspaceId}' AND user_id='${userId}'`;
  runSql(`
    ${repoSql('supabase/migrations/20261005000001_household_member_removal.sql')}
    INSERT INTO auth.users(id,aud,role,email) VALUES
      ('${owner}','authenticated','authenticated','${owner}@example.test'),
      ('${admin}','authenticated','authenticated','${admin}@example.test'),
      ('${member}','authenticated','authenticated','${member}@example.test'),
      ('${outsider}','authenticated','authenticated','${outsider}@example.test');
    INSERT INTO swarm.users(user_id,display_name) VALUES
      ('${owner}','Synthetic owner'),('${admin}','Synthetic admin'),
      ('${member}','Synthetic member'),('${outsider}','Synthetic outsider');
    INSERT INTO swarm.workspaces(workspace_id,name,created_by) VALUES
      ('${workspace}','Synthetic household','${owner}'),('${other}','Synthetic other','${outsider}');
    INSERT INTO swarm.memberships(workspace_id,user_id,role) VALUES
      ('${workspace}','${owner}','owner'),('${workspace}','${admin}','admin'),('${workspace}','${member}','member'),
      ('${other}','${outsider}','owner');
    INSERT INTO swarm.household_workspace_boundaries(workspace_id,purpose) VALUES
      ('${workspace}','shared'),('${other}','shared');
    INSERT INTO swarm.household_member_content_roles(workspace_id,user_id,content_role,content_consent_id,confirmed_at) VALUES
      ('${workspace}','${owner}','editor','${ownerConsent}','2026-10-04T00:00:00Z'),
      ('${workspace}','${admin}','editor','${adminConsent}','2026-10-04T00:00:00Z'),
      ('${workspace}','${member}','editor','${memberConsent}','2026-10-04T00:00:00Z'),
      ('${other}','${outsider}','reader','${randomUUID()}','2026-10-04T00:00:00Z');
    INSERT INTO swarm.agent_principals(principal_id,workspace_id,owner_user_id,name,transport,turn_only) VALUES
      ('${ownerPrincipal}','${workspace}','${owner}','Owner agent','local',false),
      ('${memberPrincipal}','${workspace}','${member}','Member agent','local',false);
    INSERT INTO swarm.household_content_connections(connection_id,grant_id,workspace_id,principal_id,owner_user_id,purpose,operations,consent_receipt_id,expires_at)
      VALUES
      ('${liveConnection}','${grant}','${workspace}','${memberPrincipal}','${member}','shared',ARRAY['read','update'],'${memberConsent}',NULL),
      ('${expiredConnection}','${grant}','${workspace}','${memberPrincipal}','${member}','shared',ARRAY['read'],'${memberConsent}',clock_timestamp()-interval '1 day'),
      ('${ownerConnection}','${grant}','${workspace}','${ownerPrincipal}','${owner}','shared',ARRAY['read'],'${ownerConsent}',NULL);
    INSERT INTO swarm.admin_accounts(owner_user_id,stream_id) VALUES ('${owner}','${randomUUID()}');
    INSERT INTO swarm.admin_grants(grant_id,owner_user_id,admin_identity_id,connection_id,client_id,resource,registry_version,
      workspace_ids,created_workspace_policy,target_rules,worker_scope_ceiling,role_ceiling,renewal_limits,issuance_limits,
      expires_at,refresh_deadline,state,consent_receipt_id,manifest_digest,created_at)
    VALUES ('${grant}','${owner}','${randomUUID()}','${randomUUID()}','https://client.example/${grant}','https://api.commonswarm.com/admin',2,
      '{}','{"scope_names":[]}','{}','{}','member','{}','{}',date_trunc('second',statement_timestamp())+interval '1 day',
      date_trunc('second',statement_timestamp())+interval '1 day','active','${randomUUID()}','${digest}',date_trunc('second',statement_timestamp()));
    INSERT INTO swarm.admin_routine_invitations(invitation_id,workspace_id,parent_admin_grant_id,owner_user_id,recipient_user_id,
      invitation_kind,expires_at,created_at,accepted_at,projection) VALUES
      ('${pendingInvite}','${workspace}','${grant}','${owner}','${member}','member',statement_timestamp()+interval '1 day',statement_timestamp(),NULL,'{"role":"member"}'),
      ('${acceptedInvite}','${workspace}','${grant}','${owner}','${member}','member',statement_timestamp()+interval '1 day',statement_timestamp(),statement_timestamp(),'{"role":"member"}'),
      ('${otherInvite}','${workspace}','${grant}','${owner}','${admin}','member',statement_timestamp()+interval '1 day',statement_timestamp(),NULL,'{"role":"member"}');
    SET LOCAL ROLE swarm_command;
    ${context('remove_member', owner, 'proof-remove')}
    UPDATE swarm.household_member_content_roles SET revoked_at=clock_timestamp() WHERE ${role(workspace, member)} AND revoked_at IS NULL;
    ${context('household_withdraw_connection', owner, 'proof-withdraw')}
    UPDATE swarm.household_content_connections SET revoked_at=clock_timestamp()
      WHERE connection_id='${ownerConnection}' AND revoked_at IS NULL;
    ${context('remove_member', member, 'proof-member-denied')}
    ${refuses(`UPDATE swarm.household_member_content_roles SET revoked_at=clock_timestamp() WHERE ${role(workspace, admin)}`, '42501')}
    ${context('remove_member', admin, 'proof-admin-denied')}
    ${refuses(`UPDATE swarm.household_member_content_roles SET revoked_at=clock_timestamp() WHERE ${role(workspace, owner)}`, '42501')}
    ${context('remove_member', owner, 'proof-cross')}
    ${refuses(`UPDATE swarm.household_member_content_roles SET revoked_at=clock_timestamp() WHERE ${role(other, outsider)}`, '42501')}
    ${context('remove_member', owner, 'proof-insert')}
    ${refuses(`INSERT INTO swarm.household_member_content_roles(workspace_id,user_id,content_role,content_consent_id,confirmed_at)
      VALUES ('${workspace}','${member}','reader','${randomUUID()}',clock_timestamp())`, '42501')}
    ${context('remove_member', owner, 'proof-columns')}
    ${refuses(`UPDATE swarm.household_member_content_roles SET content_role='reader',revoked_at=clock_timestamp() WHERE ${role(workspace, admin)}`, '42501')}
    ${context('remove_member', owner, 'proof-boundary')}
    ${refuses(`UPDATE swarm.household_workspace_boundaries SET purpose='shared' WHERE workspace_id='${workspace}'`, '42501')}
    ${context('remove_member', owner, 'proof-restamp')}
    ${refuses(`UPDATE swarm.household_member_content_roles SET revoked_at=clock_timestamp() WHERE ${role(workspace, member)}`, '42501')}
    ${context('remove_member', owner, 'proof-self')}
    UPDATE swarm.household_member_content_roles SET revoked_at=clock_timestamp() WHERE ${role(workspace, owner)} AND revoked_at IS NULL;
    RESET ROLE;
    ${dbAssert(`SELECT content_role='editor' AND content_consent_id='${memberConsent}' AND revoked_at IS NOT NULL
      FROM swarm.household_member_content_roles WHERE ${role(workspace, member)}`, 'removal stamps the member role and keeps its consent')}
    ${dbAssert(`SELECT revoked_at IS NOT NULL AND consent_receipt_id='${ownerConsent}' FROM swarm.household_content_connections WHERE connection_id='${ownerConnection}'`, 'withdraw still revokes the actor own connection')}
    ${dbAssert(`SELECT revoked_at IS NULL AND content_role='editor' FROM swarm.household_member_content_roles WHERE ${role(workspace, admin)}`, 'a member and a column change leave the admin role')}
    ${dbAssert(`SELECT revoked_at IS NULL FROM swarm.household_member_content_roles WHERE ${role(other, outsider)}`, 'another workspace role stays')}
    ${dbAssert(`SELECT revoked_at IS NOT NULL FROM swarm.household_member_content_roles WHERE ${role(workspace, owner)}`, 'an owner can revoke their own content while still a member')}
    ${dbAssert(`SELECT count(*)=3 AND count(*) FILTER (WHERE command_kind='remove_member')=2
      AND count(*) FILTER (WHERE command_kind='household_withdraw_connection')=1
      FROM swarm.household_object_audit WHERE workspace_id='${workspace}' AND command_id IN ('proof-remove','proof-withdraw','proof-self')`, 'one stamp and withdraw each write their own audit')}
    SET LOCAL ROLE swarm_command;
    ${context('household_permissions', member, 'proof-fresh')}
    UPDATE swarm.household_member_content_roles
      SET content_role='reader',content_consent_id='${freshConsent}',confirmed_at=clock_timestamp(),revoked_at=NULL
      WHERE ${role(workspace, member)};
    RESET ROLE;
    ${dbAssert(`SELECT content_role='reader' AND content_consent_id='${freshConsent}' AND revoked_at IS NULL
      FROM swarm.household_member_content_roles WHERE ${role(workspace, member)}`, 'fresh consent after a live rejoin clears the removal stamp')}
    ${dbAssert(`SELECT count(*)=1 AND bool_and(command_kind='household_permissions') FROM swarm.household_object_audit
      WHERE workspace_id='${workspace}' AND command_id='proof-fresh'`, 'fresh consent is its own audit')}
    ${psqlProof('catalog')}
    CREATE TEMP TABLE before_audit AS SELECT to_jsonb(a) AS row FROM swarm.household_object_audit a WHERE workspace_id='${workspace}';
    ${repoSql(`${proof}-rollback.sql`)}
    ${psqlProof('rollback-catalog')}
    ${dbAssert(`SELECT NOT EXISTS ((SELECT row FROM before_audit EXCEPT SELECT to_jsonb(a) FROM swarm.household_object_audit a WHERE workspace_id='${workspace}')
      UNION ALL (SELECT to_jsonb(a) FROM swarm.household_object_audit a WHERE workspace_id='${workspace}' EXCEPT SELECT row FROM before_audit))`, 'rollback preserves every audit row')}
    ${dbAssert(`SELECT revoked_at IS NOT NULL FROM swarm.household_member_content_roles WHERE ${role(workspace, owner)}`, 'rollback leaves the owner removal stamp')}
  `);
});

class RollbackProof extends Error {}

test('removal handlers revoke every owned connection and a later invitation restores none', { timeout: 120_000 }, async () => {
  let local: { DB_URL: string };
  try { local = JSON.parse(execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); }
  catch { throw new Error('Local Supabase is unavailable; this proof requires the authorized CI stack.'); }
  const db = postgres(localClusterAdminUrl(local.DB_URL), { prepare: false, max: 1 });
  const owner = randomUUID(), admin = randomUUID(), member = randomUUID(), joiner = randomUUID();
  const workspace = randomUUID(), grant = randomUUID(), ownerPrincipal = randomUUID(), memberPrincipal = randomUUID();
  const ownerConsent = randomUUID(), adminConsent = randomUUID(), memberConsent = randomUUID();
  const liveConnection = randomUUID(), expiredConnection = randomUUID(), frozenConnection = randomUUID(), ownerConnection = randomUUID();
  const pendingInvite = randomUUID(), acceptedInvite = randomUUID(), otherInvite = randomUUID();
  const staleInvite = randomUUID(), freshInvite = randomUUID(), consumedInvite = randomUUID(), joinerInvite = randomUUID();
  const frozen = new Date('2026-10-01T00:00:00.000Z');
  const digest = 'ab'.repeat(32);
  const memberEmail = 'member@example.test';
  const joinerEmail = 'joiner@example.test';
  const link = (mark: string) => {
    const token = `swm_inv_${mark.repeat(43)}`;
    return { token, hash: createHash('sha256').update(token).digest() };
  };
  const staleLink = link('C'), freshLink = link('D'), consumedLink = link('E'), joinerLink = link('F');
  const human = { user_id: member, email: memberEmail, verified: true as const };
  const countAudits = async (tx: postgres.TransactionSql<Record<string, unknown>>, commandId?: string) => {
    const [row] = commandId === undefined
      ? await tx<{ count: number }[]>`SELECT count(*)::int AS count FROM swarm.household_object_audit WHERE workspace_id=${workspace}::uuid`
      : await tx<{ count: number }[]>`SELECT count(*)::int AS count FROM swarm.household_object_audit WHERE workspace_id=${workspace}::uuid AND command_id=${commandId}`;
    return Number(row?.count ?? 0);
  };
  try {
    await assert.rejects(db.begin(async (tx) => {
      const [clock] = await tx<{ now: Date }[]>`SELECT date_trunc('milliseconds', clock_timestamp()) AS now`;
      const removedAt = new Date(clock!.now);
      const earlier = new Date(removedAt.getTime() - 120_000);
      const later = new Date(removedAt.getTime() + 60_000);
      const expiry = new Date(removedAt.getTime() + 86_400_000);
      await tx`INSERT INTO auth.users(id,aud,role,email) VALUES
        (${owner}::uuid,'authenticated','authenticated',${`${owner}@example.test`}),
        (${admin}::uuid,'authenticated','authenticated',${`${admin}@example.test`}),
        (${member}::uuid,'authenticated','authenticated',${memberEmail}),
        (${joiner}::uuid,'authenticated','authenticated',${joinerEmail})`;
      await tx`INSERT INTO swarm.users(user_id,display_name,email) VALUES
        (${owner}::uuid,'Synthetic owner',${`${owner}@example.test`}),
        (${admin}::uuid,'Synthetic admin',${'Admin@Example.test'}),
        (${member}::uuid,'Synthetic member',${'Member@Example.test'}),
        (${joiner}::uuid,'Synthetic joiner',${joinerEmail})`;
      await tx`INSERT INTO swarm.workspaces(workspace_id,name,created_by) VALUES (${workspace}::uuid,'Synthetic household',${owner}::uuid)`;
      await tx`INSERT INTO swarm.memberships(workspace_id,user_id,role) VALUES
        (${workspace}::uuid,${owner}::uuid,'owner'),
        (${workspace}::uuid,${admin}::uuid,'admin'),
        (${workspace}::uuid,${member}::uuid,'member')`;
      await tx`INSERT INTO swarm.streams(stream_id,workspace_id,kind) VALUES (${randomUUID()}::uuid,${workspace}::uuid,'workspace')`;
      await tx`INSERT INTO swarm.household_workspace_boundaries(workspace_id,purpose) VALUES (${workspace}::uuid,'shared')`;
      await tx`INSERT INTO swarm.household_member_content_roles(workspace_id,user_id,content_role,content_consent_id,confirmed_at) VALUES
        (${workspace}::uuid,${owner}::uuid,'editor',${ownerConsent}::uuid,'2026-10-04T00:00:00Z'),
        (${workspace}::uuid,${admin}::uuid,'editor',${adminConsent}::uuid,'2026-10-04T00:00:00Z'),
        (${workspace}::uuid,${member}::uuid,'editor',${memberConsent}::uuid,'2026-10-04T00:00:00Z')`;
      await tx`INSERT INTO swarm.agent_principals(principal_id,workspace_id,owner_user_id,name,transport,turn_only) VALUES
        (${ownerPrincipal}::uuid,${workspace}::uuid,${owner}::uuid,'Owner agent','local',false),
        (${memberPrincipal}::uuid,${workspace}::uuid,${member}::uuid,'Member agent','local',false)`;
      await tx`INSERT INTO swarm.household_content_connections(connection_id,grant_id,workspace_id,principal_id,owner_user_id,purpose,operations,consent_receipt_id,expires_at,revoked_at) VALUES
        (${liveConnection}::uuid,${grant}::uuid,${workspace}::uuid,${memberPrincipal}::uuid,${member}::uuid,'shared',ARRAY['read','update'],${memberConsent}::uuid,NULL,NULL),
        (${expiredConnection}::uuid,${grant}::uuid,${workspace}::uuid,${memberPrincipal}::uuid,${member}::uuid,'shared',ARRAY['read'],${memberConsent}::uuid,clock_timestamp()-interval '1 day',NULL),
        (${frozenConnection}::uuid,${grant}::uuid,${workspace}::uuid,${memberPrincipal}::uuid,${member}::uuid,'shared',ARRAY['read'],${memberConsent}::uuid,NULL,${frozen}),
        (${ownerConnection}::uuid,${grant}::uuid,${workspace}::uuid,${ownerPrincipal}::uuid,${owner}::uuid,'shared',ARRAY['read'],${ownerConsent}::uuid,NULL,NULL)`;
      await tx.unsafe(`
        INSERT INTO swarm.admin_accounts(owner_user_id,stream_id) VALUES ('${owner}','${randomUUID()}');
        INSERT INTO swarm.admin_grants(grant_id,owner_user_id,admin_identity_id,connection_id,client_id,resource,registry_version,
          workspace_ids,created_workspace_policy,target_rules,worker_scope_ceiling,role_ceiling,renewal_limits,issuance_limits,
          expires_at,refresh_deadline,state,consent_receipt_id,manifest_digest,created_at)
        VALUES ('${grant}','${owner}','${randomUUID()}','${randomUUID()}','https://client.example/${grant}','https://api.commonswarm.com/admin',2,
          '{}','{"scope_names":[]}','{}','{}','member','{}','{}',date_trunc('second',statement_timestamp())+interval '1 day',
          date_trunc('second',statement_timestamp())+interval '1 day','active','${randomUUID()}','${digest}',date_trunc('second',statement_timestamp()));
        INSERT INTO swarm.admin_routine_invitations(invitation_id,workspace_id,parent_admin_grant_id,owner_user_id,recipient_user_id,
          invitation_kind,expires_at,created_at,accepted_at,projection) VALUES
          ('${pendingInvite}','${workspace}','${grant}','${owner}','${member}','member',statement_timestamp()+interval '1 day',statement_timestamp(),NULL,'{"role":"member"}'),
          ('${acceptedInvite}','${workspace}','${grant}','${owner}','${member}','member',statement_timestamp()+interval '1 day',statement_timestamp(),statement_timestamp(),'{"role":"member"}'),
          ('${otherInvite}','${workspace}','${grant}','${owner}','${admin}','member',statement_timestamp()+interval '1 day',statement_timestamp(),NULL,'{"role":"member"}');
      `);
      await tx`INSERT INTO swarm.invitations(invitation_id,workspace_id,email,role,token_hash,expires_at,created_by,created_at) VALUES
        (${staleInvite}::uuid,${workspace}::uuid,${memberEmail},'member',${staleLink.hash},${expiry},${owner}::uuid,${earlier}),
        (${consumedInvite}::uuid,${workspace}::uuid,${memberEmail},'member',${consumedLink.hash},${expiry},${owner}::uuid,${earlier})`;
      await tx`UPDATE swarm.invitations SET consumed_at=${earlier},consumed_by=${member}::uuid WHERE invitation_id=${consumedInvite}::uuid`;
      await tx`INSERT INTO swarm.invitations(invitation_id,workspace_id,email,role,token_hash,expires_at,created_by,created_at) VALUES
        (${randomUUID()}::uuid,${workspace}::uuid,${'admin@example.test'},'member',${link('G').hash},${expiry},${owner}::uuid,${earlier})`;
      await tx.unsafe('SET LOCAL ROLE swarm_command');
      await revokeRemovedMemberHousehold(tx, workspace, member, removedAt, owner, 'hf-remove', digest);
      assert.deepEqual(await pendingLinkInvitationIds(tx, workspace, member), [staleInvite]);
      await tx.unsafe('RESET ROLE');
      const [membership] = await tx<{ revoked_at: Date | null }[]>`SELECT revoked_at FROM swarm.memberships WHERE workspace_id=${workspace}::uuid AND user_id=${member}::uuid`;
      assert.equal(membership?.revoked_at, null);
      const [memberRole] = await tx<{ content_role: string; content_consent_id: string; revoked_at: Date | null }[]>`SELECT content_role, content_consent_id, revoked_at FROM swarm.household_member_content_roles WHERE workspace_id=${workspace}::uuid AND user_id=${member}::uuid`;
      assert.equal(memberRole?.content_role, 'editor');
      assert.equal(memberRole?.content_consent_id, memberConsent);
      assert.ok(memberRole?.revoked_at !== null);
      const connections = await tx<{ connection_id: string; revoked_at: Date | null; consent_receipt_id: string }[]>`SELECT connection_id, revoked_at, consent_receipt_id FROM swarm.household_content_connections WHERE workspace_id=${workspace}::uuid`;
      const connection = (id: string) => connections.find((row) => row.connection_id === id);
      assert.ok(connection(liveConnection)?.revoked_at !== null);
      assert.ok(connection(expiredConnection)?.revoked_at !== null);
      assert.equal(connection(liveConnection)?.consent_receipt_id, memberConsent);
      assert.equal(connection(expiredConnection)?.consent_receipt_id, memberConsent);
      assert.equal(new Date(connection(frozenConnection)!.revoked_at!).getTime(), frozen.getTime());
      assert.equal(connection(ownerConnection)?.revoked_at, null);
      const routines = await tx<{ invitation_id: string; revoked_at: Date | null; accepted_at: Date | null }[]>`SELECT invitation_id, revoked_at, accepted_at FROM swarm.admin_routine_invitations WHERE workspace_id=${workspace}::uuid`;
      const routine = (id: string) => routines.find((row) => row.invitation_id === id);
      assert.ok(routine(pendingInvite)?.revoked_at !== null && routine(pendingInvite)?.accepted_at === null);
      assert.equal(routine(acceptedInvite)?.revoked_at, null);
      assert.equal(routine(otherInvite)?.revoked_at, null);
      assert.equal(await countAudits(tx), 3);
      assert.equal(await countAudits(tx, 'hf-remove'), 3);
      await tx`UPDATE swarm.memberships SET revoked_at=${removedAt} WHERE workspace_id=${workspace}::uuid AND user_id=${member}::uuid`;
      await tx.unsafe('SET LOCAL ROLE swarm_command');
      const stale = await humanInvitationTransaction(tx, 'hf-stale', {
        kind: 'household_invitation', action: 'accept', invitation: { source: 'link', token: staleLink.token },
        consent_version: HOUSEHOLD_JOIN_CONSENT_VERSION, preview_digest: digest, content_role: 'reader',
      }, human);
      await tx.unsafe('RESET ROLE');
      assert.equal(stale.status, 403, JSON.stringify(stale.body));
      assert.equal((stale.body as { reason?: string }).reason, 'invitation_predates_removal');
      const [staleRow] = await tx<{ consumed_at: Date | null }[]>`SELECT consumed_at FROM swarm.invitations WHERE invitation_id=${staleInvite}::uuid`;
      assert.equal(staleRow?.consumed_at, null);
      const [stillRevoked] = await tx<{ revoked_at: Date | null; content_consent_id: string }[]>`SELECT revoked_at, content_consent_id FROM swarm.household_member_content_roles WHERE workspace_id=${workspace}::uuid AND user_id=${member}::uuid`;
      assert.ok(stillRevoked?.revoked_at !== null);
      assert.equal(stillRevoked?.content_consent_id, memberConsent);
      assert.equal(await countAudits(tx, 'hf-stale'), 0);
      await tx`INSERT INTO swarm.invitations(invitation_id,workspace_id,email,role,token_hash,expires_at,created_by,created_at) VALUES
        (${freshInvite}::uuid,${workspace}::uuid,${memberEmail},'member',${freshLink.hash},${expiry},${owner}::uuid,${later})`;
      await tx.unsafe('SET LOCAL ROLE swarm_command');
      const preview = await humanInvitationTransaction(tx, 'hf-fresh-preview', {
        kind: 'household_invitation', action: 'preview', invitation: { source: 'link', token: freshLink.token },
      }, human);
      assert.equal(preview.status, 200, JSON.stringify(preview.body));
      const fresh = await humanInvitationTransaction(tx, 'hf-fresh-accept', {
        kind: 'household_invitation', action: 'accept', invitation: { source: 'link', token: freshLink.token },
        consent_version: HOUSEHOLD_JOIN_CONSENT_VERSION,
        preview_digest: (preview.body as { preview_digest: string }).preview_digest,
        content_role: 'reader',
      }, human);
      await tx.unsafe('RESET ROLE');
      assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
      assert.equal((fresh.body as { status?: string; content_role: string | null }).status, 'joined');
      assert.equal((fresh.body as { content_role: string | null }).content_role, null);
      const [rejoined] = await tx<{ revoked_at: Date | null }[]>`SELECT revoked_at FROM swarm.memberships WHERE workspace_id=${workspace}::uuid AND user_id=${member}::uuid`;
      assert.equal(rejoined?.revoked_at, null);
      const [roleAfterJoin] = await tx<{ content_role: string; content_consent_id: string; revoked_at: Date | null }[]>`SELECT content_role, content_consent_id, revoked_at FROM swarm.household_member_content_roles WHERE workspace_id=${workspace}::uuid AND user_id=${member}::uuid`;
      assert.equal(roleAfterJoin?.content_role, 'editor');
      assert.equal(roleAfterJoin?.content_consent_id, memberConsent);
      assert.ok(roleAfterJoin?.revoked_at !== null);
      const [liveAfter] = await tx<{ revoked_at: Date | null }[]>`SELECT revoked_at FROM swarm.household_content_connections WHERE connection_id=${liveConnection}::uuid`;
      const [expiredAfter] = await tx<{ revoked_at: Date | null }[]>`SELECT revoked_at FROM swarm.household_content_connections WHERE connection_id=${expiredConnection}::uuid`;
      assert.ok(liveAfter?.revoked_at !== null && expiredAfter?.revoked_at !== null);
      assert.equal(await countAudits(tx), 3);
      assert.equal(await countAudits(tx, 'hf-fresh-accept'), 0);
      await tx.unsafe('SET LOCAL ROLE swarm_command');
      const provisioned = await provisionHouseholdPermissions(tx, workspace, {
        user_id: member, principal_id: null, run_id: null, connection: null,
      }, 'hf-fresh-consent', { kind: 'household_permissions', purpose: 'shared', content_role: 'reader' }, async () => true);
      await tx.unsafe('RESET ROLE');
      assert.equal(provisioned.status, 'committed', JSON.stringify(provisioned));
      const [freshRole] = await tx<{ content_role: string; content_consent_id: string; revoked_at: Date | null }[]>`SELECT content_role, content_consent_id, revoked_at FROM swarm.household_member_content_roles WHERE workspace_id=${workspace}::uuid AND user_id=${member}::uuid`;
      assert.equal(freshRole?.content_role, 'reader');
      assert.equal(freshRole?.revoked_at, null);
      assert.notEqual(freshRole?.content_consent_id, memberConsent);
      const [consentAudit] = await tx<{ count: number; permissions: number }[]>`SELECT count(*)::int AS count, count(*) FILTER (WHERE command_kind='household_permissions')::int AS permissions FROM swarm.household_object_audit WHERE workspace_id=${workspace}::uuid AND command_id='hf-fresh-consent'`;
      assert.ok(Number(consentAudit?.count) >= 1);
      assert.equal(Number(consentAudit?.count), Number(consentAudit?.permissions));
      const [connectionsStay] = await tx<{ revoked_at: Date | null }[]>`SELECT revoked_at FROM swarm.household_content_connections WHERE connection_id=${liveConnection}::uuid`;
      assert.ok(connectionsStay?.revoked_at !== null);
      await tx`INSERT INTO swarm.invitations(invitation_id,workspace_id,email,role,token_hash,expires_at,created_by,created_at) VALUES
        (${joinerInvite}::uuid,${workspace}::uuid,${joinerEmail},'member',${joinerLink.hash},${expiry},${owner}::uuid,${later})`;
      await tx.unsafe('SET LOCAL ROLE swarm_command');
      const joinerPreview = await humanInvitationTransaction(tx, 'hf-new-preview', {
        kind: 'household_invitation', action: 'preview', invitation: { source: 'link', token: joinerLink.token },
      }, { user_id: joiner, email: joinerEmail, verified: true });
      assert.equal(joinerPreview.status, 200, JSON.stringify(joinerPreview.body));
      const joined = await humanInvitationTransaction(tx, 'hf-new-accept', {
        kind: 'household_invitation', action: 'accept', invitation: { source: 'link', token: joinerLink.token },
        consent_version: HOUSEHOLD_JOIN_CONSENT_VERSION,
        preview_digest: (joinerPreview.body as { preview_digest: string }).preview_digest,
        content_role: 'reader',
      }, { user_id: joiner, email: joinerEmail, verified: true });
      await tx.unsafe('RESET ROLE');
      assert.equal(joined.status, 200, JSON.stringify(joined.body));
      assert.equal((joined.body as { content_role: string | null }).content_role, 'reader');
      const [joinerRole] = await tx<{ content_role: string; revoked_at: Date | null }[]>`SELECT content_role, revoked_at FROM swarm.household_member_content_roles WHERE workspace_id=${workspace}::uuid AND user_id=${joiner}::uuid`;
      assert.equal(joinerRole?.content_role, 'reader');
      assert.equal(joinerRole?.revoked_at, null);
      const [joinerAudit] = await tx<{ count: number; permissions: number }[]>`SELECT count(*)::int AS count, count(*) FILTER (WHERE command_kind='household_permissions')::int AS permissions FROM swarm.household_object_audit WHERE workspace_id=${workspace}::uuid AND command_id='hf-new-accept'`;
      assert.ok(Number(joinerAudit?.count) >= 1);
      assert.equal(Number(joinerAudit?.count), Number(joinerAudit?.permissions));
      throw new RollbackProof();
    }), RollbackProof);
  } finally {
    await db.end();
  }
});
