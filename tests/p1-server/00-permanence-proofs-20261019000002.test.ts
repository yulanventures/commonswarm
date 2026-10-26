/** 20261019000002 compat storage: its proofs and its guarded rollback reserve. CI/Docker only. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { dbAssert, refuses, repoSql, runSql } from '../support/admin-schema-db.js';
import { sqlPhase } from '../support/admin-schema-process.js';

const MIGRATION = 'supabase/migrations/20261019000002_connection_policy_compat.sql';
const PROOFS = 'deploy/release-proofs/permanence/20261019000002';
const RESERVE = 'supabase/permanence-reserve/20261019000002';
// The reserves of the two later versions in this packet, applied in reverse order first.
const LATER_RESERVES = ['20261019000004', '20261019000003'].map(v => `deploy/release-proofs/permanence/${v}-rollback.sql`);
const DEADLINE_COLUMNS = `SELECT count(*) FROM pg_attribute WHERE attrelid IN (to_regclass('swarm.hosted_mcp_grants'),to_regclass('swarm.renewal_grants'))
  AND attname IN ('connection_expires_at','connection_expired_at') AND NOT attisdropped`;
const BINDING_FK = `SELECT pg_get_constraintdef(k.oid) FROM pg_constraint k WHERE k.conrelid=to_regclass('swarm.household_content_connections')
  AND k.contype='f' AND k.confrelid=to_regclass('swarm.renewal_grants')`;

function proof(kind: 'catalog' | 'rollback-catalog', expect: boolean): string {
  const alias = kind === 'catalog' ? 'catalog_ok' : 'rollback_ok';
  return repoSql(`${PROOFS}-${kind}.sql`)
    + `\nSELECT :'${alias}'::boolean=${expect} AS proof_pass\n\\gset\n\\if :proof_pass\n\\else\n`
    + `DO $fail$ BEGIN RAISE EXCEPTION '${kind} expected ${expect}'; END $fail$;\n\\endif\n`;
}

test('20261019000002 proofs are the same bytes in the reserve and the release packet', () => {
  for (const kind of ['catalog', 'functional', 'rollback', 'rollback-catalog']) {
    assert.equal(repoSql(`${RESERVE}-${kind}.sql`), repoSql(`${PROOFS}-${kind}.sql`), kind);
  }
});

test('20261019000002 rollback refuses out of order, restores the pre-permanence storage without losing rows, and the migration re-applies', () => {
  const owner = randomUUID(), ws = randomUUID(), stream = randomUUID(), device = randomUUID();
  const principal = randomUUID(), run = randomUUID(), family = randomUUID(), consent = randomUUID(), approval = randomUUID();
  const deadlineGrant = randomUUID(), fencedGrant = randomUUID();
  const permanentClient = `client-permanent-${randomUUID()}`, finiteClient = `client-finite-${randomUUID()}`;
  const digest = "decode(repeat('07',32),'hex')";
  const hostedGrant = (grant: string, deadline: string, expired: string) =>
    `('${grant}','provider-${grant}','${owner}','${ws}','${permanentClient}','https://mcp.commonswarm.com/mcp',ARRAY['${ws}']::uuid[],${digest},'interaction-${grant}','active',statement_timestamp(),statement_timestamp(),${deadline},${expired})`;

  const fixture = `
INSERT INTO auth.users(id,aud,role,email) VALUES('${owner}','authenticated','authenticated','${owner}@example.test');
INSERT INTO swarm.users(user_id,display_name) VALUES('${owner}','Compat owner');
INSERT INTO swarm.workspaces(workspace_id,name,created_by) VALUES('${ws}','Compat','${owner}');
INSERT INTO swarm.memberships(workspace_id,user_id,role) VALUES('${ws}','${owner}','owner');
INSERT INTO swarm.streams(stream_id,workspace_id,kind) VALUES('${stream}','${ws}','workspace');
INSERT INTO swarm.devices(device_id,user_id,label) VALUES('${device}','${owner}','Mac mini');
INSERT INTO swarm.agent_principals(principal_id,workspace_id,owner_user_id,name) VALUES('${principal}','${ws}','${owner}','Compat agent');
INSERT INTO swarm.agent_runs(run_id,principal_id,device_id) VALUES('${run}','${principal}','${device}');
-- a standing family whose owner chose a connection deadline
INSERT INTO swarm.renewal_grants(renewal_grant_id,workspace_id,principal_id,run_id,kind,max_successors,successors_used,horizon_expires_at,bound_device_id,created_by,connection_expires_at)
  VALUES('${family}','${ws}','${principal}','${run}','standing',NULL,0,NULL,NULL,'${owner}',statement_timestamp()+interval '30 days');
-- one hosted grant with a live deadline, one already fenced
INSERT INTO swarm.hosted_mcp_grants(grant_id,provider_grant_id,owner_user_id,home_workspace_id,client_id,resource,selected_workspace_ids,manifest_digest,interaction_ref,state,created_at,activated_at,connection_expires_at,connection_expired_at)
  VALUES ${hostedGrant(deadlineGrant, "statement_timestamp()+interval '30 days'", 'NULL')},
         ${hostedGrant(fencedGrant, "statement_timestamp()-interval '1 day'", "statement_timestamp()-interval '1 hour'")};
-- a permanent registration and a finite one
INSERT INTO commonswarm_oauth.registered_clients(client_id,metadata,expires_at)
  VALUES('${permanentClient}','{}'::jsonb,NULL),('${finiteClient}','{}'::jsonb,statement_timestamp()+interval '7 days');
INSERT INTO swarm.household_workspace_boundaries(workspace_id,purpose) VALUES('${ws}','shared');
INSERT INTO swarm.household_member_content_roles(workspace_id,user_id,content_role,content_consent_id,confirmed_at)
  VALUES('${ws}','${owner}','editor','${consent}',clock_timestamp());
-- The 20261019000007 binding guard wants a live token behind a bound approval;
-- this drill only needs the column value, so the guard is off for the seed row.
ALTER TABLE swarm.household_content_connections DISABLE TRIGGER aa_household_local_family_binding;
INSERT INTO swarm.household_content_connections(connection_id,grant_id,workspace_id,principal_id,owner_user_id,purpose,operations,consent_receipt_id,expires_at,renewal_grant_id)
  VALUES('${approval}','${run}','${ws}','${principal}','${owner}','shared',ARRAY['read'],'${consent}',NULL,'${family}');
ALTER TABLE swarm.household_content_connections ENABLE TRIGGER aa_household_local_family_binding;
CREATE TEMP TABLE compat_before AS
SELECT pg_get_indexdef(to_regclass('swarm.hosted_mcp_grants_connection_deadline_idx')) AS hosted_idx,
       pg_get_indexdef(to_regclass('swarm.renewal_grants_connection_deadline_idx')) AS renewal_idx,
       (${BINDING_FK}) AS binding_fk,
       (SELECT r.expires_at FROM commonswarm_oauth.registered_clients r WHERE r.client_id='${finiteClient}') AS finite_expiry;
`;

  runSql(`${sqlPhase('compat-fixture', fixture)}
${sqlPhase('compat-forward', `
${dbAssert('SELECT hosted_idx IS NOT NULL AND renewal_idx IS NOT NULL AND binding_fk IS NOT NULL FROM compat_before', 'compat objects present before rollback')}
${dbAssert(`SELECT count(*)=1 FROM swarm.hosted_mcp_grants WHERE grant_id='${deadlineGrant}' AND connection_expires_at>clock_timestamp() AND connection_expired_at IS NULL`, 'deadline grant seeded')}
${dbAssert(`SELECT renewal_grant_id='${family}' AND expires_at IS NULL FROM swarm.household_content_connections WHERE connection_id='${approval}'`, 'bound approval seeded')}
${dbAssert(`SELECT expires_at IS NULL FROM commonswarm_oauth.registered_clients WHERE client_id='${permanentClient}'`, 'permanent registration seeded')}
${proof('catalog', true)}
${repoSql(`${PROOFS}-functional.sql`)}
${proof('rollback-catalog', false)}`)}
${sqlPhase('compat-refuses-out-of-order', `
-- 20261019000003 is still installed
${refuses(repoSql(`${PROOFS}-rollback.sql`), '55000')}
${dbAssert(`(${DEADLINE_COLUMNS})=4`, 'refused rollback changed nothing')}
${LATER_RESERVES.map(path => repoSql(path)).join('\n')}
-- the 20261019000010 connections view still reads the deadline columns
${refuses('ALTER TABLE swarm.hosted_mcp_grants DROP COLUMN connection_expires_at', '2BP01')}
${refuses(repoSql(`${PROOFS}-rollback.sql`), '55000')}
-- Stand-ins for the 20261019000010 and 20261019000007 reserves, which are
-- separate deliverables (that view is re-created without the appended columns;
-- that guard is dropped). Only the dependency on this version is removed here.
DROP VIEW swarm_read.hosted_mcp_connections;
${refuses(repoSql(`${PROOFS}-rollback.sql`), '55000')}
DROP TRIGGER aa_household_local_family_binding ON swarm.household_content_connections;`)}
${sqlPhase('compat-rollback', `
${repoSql(`${PROOFS}-rollback.sql`)}
${dbAssert(`(${DEADLINE_COLUMNS})=0`, 'deadline columns dropped')}
${dbAssert(`to_regclass('swarm.hosted_mcp_grants_connection_deadline_idx') IS NULL AND to_regclass('swarm.renewal_grants_connection_deadline_idx') IS NULL`, 'deadline indexes dropped')}
${dbAssert(`SELECT count(*)=0 FROM pg_attribute WHERE attrelid=to_regclass('swarm.household_content_connections') AND attname='renewal_grant_id' AND NOT attisdropped`, 'binding column dropped')}
${dbAssert(`SELECT attnotnull FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.registered_clients') AND attname='expires_at' AND NOT attisdropped`, 'registration expiry mandatory again')}
${dbAssert(`SELECT expires_at>clock_timestamp()+interval '29 days' AND expires_at<=clock_timestamp()+interval '30 days' FROM commonswarm_oauth.registered_clients WHERE client_id='${permanentClient}'`, 'permanent registration given the 30 day window')}
${dbAssert(`SELECT r.expires_at=b.finite_expiry FROM commonswarm_oauth.registered_clients r, compat_before b WHERE r.client_id='${finiteClient}'`, 'finite registration untouched')}
${dbAssert(`SELECT count(*)=2 FROM swarm.hosted_mcp_grants WHERE grant_id IN ('${deadlineGrant}','${fencedGrant}')`, 'hosted grant rows kept')}
${dbAssert(`SELECT count(*)=1 FROM swarm.renewal_grants WHERE renewal_grant_id='${family}' AND kind='standing'`, 'family row kept')}
${dbAssert(`SELECT count(*)=1 FROM swarm.household_content_connections WHERE connection_id='${approval}' AND expires_at IS NULL`, 'approval row kept')}
${proof('rollback-catalog', true)}
${proof('catalog', false)}`)}
${sqlPhase('compat-reapply', `
${repoSql(MIGRATION)}
${dbAssert(`SELECT pg_get_indexdef(to_regclass('swarm.hosted_mcp_grants_connection_deadline_idx'))=hosted_idx AND pg_get_indexdef(to_regclass('swarm.renewal_grants_connection_deadline_idx'))=renewal_idx FROM compat_before`, 'deadline indexes re-created identically')}
${dbAssert(`SELECT (${BINDING_FK})=binding_fk FROM compat_before`, 'binding foreign key re-created identically')}
${dbAssert(`SELECT count(*)=4 FROM pg_attribute WHERE attrelid IN (to_regclass('swarm.hosted_mcp_grants'),to_regclass('swarm.renewal_grants')) AND attname IN ('connection_expires_at','connection_expired_at') AND NOT attisdropped AND NOT attnotnull`, 'deadline columns back and nullable')}
${dbAssert(`SELECT NOT attnotnull FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.registered_clients') AND attname='expires_at' AND NOT attisdropped`, 'registration expiry optional again')}
${dbAssert(`SELECT connection_expires_at IS NULL AND connection_expired_at IS NULL FROM swarm.hosted_mcp_grants WHERE grant_id='${deadlineGrant}'`, 're-added columns start empty')}
${proof('catalog', true)}
${proof('rollback-catalog', false)}`)}
`);
});
