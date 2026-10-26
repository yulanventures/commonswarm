/** 20261025000001 grandfather migration, its proofs and its rollback reserve. CI/Docker only. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { refuses, repoSql, runSql } from '../support/admin-schema-db.js';
import { sqlPhase } from '../support/admin-schema-process.js';

const MIGRATION = 'supabase/migrations/20261025000001_permanence_grandfather.sql';
const PROOFS = 'deploy/release-proofs/permanence/20261025000001';
const RESERVE = 'supabase/permanence-reserve/20261025000001';


// One SQLSTATE per assertion: the SQL child sanitizer withholds message text but
// keeps the five-character state, so a CI failure still names its assertion.
const LABELS: string[] = [];
function check(expression: string, label: string): string {
  const index = LABELS.push(label);
  const state = `ZG${String(index).padStart(3, '0')}`;
  return `DO $assert$ BEGIN IF NOT coalesce((${expression}),false) THEN RAISE EXCEPTION '${label}' USING ERRCODE='${state}'; END IF; END $assert$;`;
}

function proof(kind: 'catalog' | 'rollback-catalog', expect: boolean): string {
  const alias = kind === 'catalog' ? 'catalog_ok' : 'rollback_ok';
  return repoSql(`${PROOFS}-${kind}.sql`)
    + `\nSELECT :'${alias}'::boolean=${expect} AS proof_pass\n\\gset\n\\if :proof_pass\n\\else\n`
    + `DO $fail$ BEGIN RAISE EXCEPTION '${kind} expected ${expect}' USING ERRCODE='ZP${kind === 'catalog' ? '001' : '002'}'; END $fail$;\n\\endif\n`;
}

test('permanence release proofs are the same bytes in the reserve and the release packet', () => {
  for (const kind of ['catalog', 'functional', 'rollback', 'rollback-catalog']) {
    assert.equal(repoSql(`${RESERVE}-${kind}.sql`), repoSql(`${PROOFS}-${kind}.sql`), kind);
  }
});

test('grandfather converts live time-boxed families, binds hosted families and live approvals, journals everything and rolls back exactly', () => {
  const owner = randomUUID(), hostedOwner = randomUUID(), ws = randomUUID(), hws = randomUUID();
  const stream = randomUUID(), device = randomUUID(), consent = randomUUID();
  type Family = { principal: string; run: string; grant: string; token: string; lineage: string; task: string };
  const family = (): Family => ({ principal: randomUUID(), run: randomUUID(), grant: randomUUID(),
    token: randomUUID(), lineage: randomUUID(), task: randomUUID() });
  // future: converts. past: dead, untouched. orphan: future horizon, no mint event -> skipped.
  // standing: a web Allow family whose approved token already rotated.
  const future = family(), past = family(), orphan = family(), standing = family();
  const rotated = randomUUID(); // live successor of standing.token
  const hostedBound = randomUUID(), hostedUnbound = randomUUID();
  // token_hash is a 32-byte digest; the fixture never needs the plaintext.
  const hash = (n: number) => `decode('${'0'.repeat(60)}${String(n).padStart(4, '0')}','hex')`;

  const familySql = (f: Family, kind: 'timeboxed' | 'standing', horizon: string, seq: number, event: boolean) => `
INSERT INTO swarm.agent_principals(principal_id,workspace_id,owner_user_id,name)
  VALUES('${f.principal}','${ws}','${owner}','Agent ${seq}');
INSERT INTO swarm.agent_runs(run_id,principal_id,device_id) VALUES('${f.run}','${f.principal}','${device}');
INSERT INTO swarm.renewal_grants(renewal_grant_id,workspace_id,principal_id,run_id,kind,max_successors,successors_used,horizon_expires_at,bound_device_id,created_by)
  VALUES('${f.grant}','${ws}','${f.principal}','${f.run}','${kind}',${kind === 'timeboxed' ? '100' : 'NULL'},0,${kind === 'timeboxed' ? horizon : 'NULL'},NULL,'${owner}');
INSERT INTO swarm.agent_tokens(token_id,principal_id,run_id,task_id,epoch,scopes,token_hash,expires_at,lineage_id,renewal_grant_id)
  VALUES('${f.token}','${f.principal}','${f.run}','${f.task}',1,'["post_signal"]'::jsonb,${hash(seq)},clock_timestamp()+interval '1 hour','${f.lineage}','${f.grant}');
${event ? `INSERT INTO swarm.events(workspace_id,stream_id,seq,event_id,command_id,type,schema_version,actor_user,payload)
  VALUES('${ws}','${stream}',${seq},'${randomUUID()}','${randomUUID()}','AgentTokenMinted',1,'${owner}','{"token_id":"${f.token}"}'::jsonb);` : ''}`;

  const fixture = `
INSERT INTO auth.users(id,aud,role,email) VALUES('${owner}','authenticated','authenticated','${owner}@example.test'),
  ('${hostedOwner}','authenticated','authenticated','${hostedOwner}@example.test');
INSERT INTO swarm.users(user_id,display_name) VALUES('${owner}','Grandfather owner'),('${hostedOwner}','Hosted owner');
INSERT INTO swarm.workspaces(workspace_id,name,created_by) VALUES('${ws}','Grandfather','${owner}'),('${hws}','Hosted','${hostedOwner}');
INSERT INTO swarm.memberships(workspace_id,user_id,role) VALUES('${ws}','${owner}','owner'),('${hws}','${hostedOwner}','owner');
INSERT INTO swarm.streams(stream_id,workspace_id,kind) VALUES('${stream}','${ws}','workspace');
INSERT INTO swarm.devices(device_id,user_id,label) VALUES('${device}','${owner}','Mac mini');
${familySql(future, 'timeboxed', "clock_timestamp()+interval '19 days'", 1, true)}
${familySql(orphan, 'timeboxed', "clock_timestamp()+interval '19 days'", 3, false)}
${familySql(standing, 'standing', 'NULL', 4, true)}
-- A family whose horizon already passed cannot be inserted through the server
-- clock (created_at is pinned to now and the horizon must follow it); the
-- fixture pins its own history with the clock trigger off for one statement.
ALTER TABLE swarm.renewal_grants DISABLE TRIGGER renewal_grants_server_clock;
INSERT INTO swarm.agent_principals(principal_id,workspace_id,owner_user_id,name) VALUES('${past.principal}','${ws}','${owner}','Agent 2');
INSERT INTO swarm.agent_runs(run_id,principal_id,device_id) VALUES('${past.run}','${past.principal}','${device}');
INSERT INTO swarm.renewal_grants(renewal_grant_id,workspace_id,principal_id,run_id,kind,max_successors,successors_used,horizon_expires_at,bound_device_id,created_by,created_at)
  VALUES('${past.grant}','${ws}','${past.principal}','${past.run}','timeboxed',100,0,clock_timestamp()-interval '1 day',NULL,'${owner}',clock_timestamp()-interval '10 days');
ALTER TABLE swarm.renewal_grants ENABLE TRIGGER renewal_grants_server_clock;
INSERT INTO swarm.agent_tokens(token_id,principal_id,run_id,task_id,epoch,scopes,token_hash,expires_at,lineage_id,renewal_grant_id)
  VALUES('${past.token}','${past.principal}','${past.run}','${past.task}',1,'["post_signal"]'::jsonb,${hash(2)},clock_timestamp()+interval '1 hour','${past.lineage}','${past.grant}');
INSERT INTO swarm.events(workspace_id,stream_id,seq,event_id,command_id,type,schema_version,actor_user,payload)
  VALUES('${ws}','${stream}',2,'${randomUUID()}','${randomUUID()}','AgentTokenMinted',1,'${owner}','{"token_id":"${past.token}"}'::jsonb);
-- Rotate the standing family the way the server does: the root is used, a
-- successor of the same epoch, task, lineage and family is issued, then the
-- root's expiry is brought to now.
UPDATE swarm.agent_tokens SET first_used_at=clock_timestamp() WHERE token_id='${standing.token}';
INSERT INTO swarm.agent_tokens(token_id,principal_id,run_id,task_id,epoch,scopes,token_hash,expires_at,lineage_id,renewal_grant_id,predecessor_token_id)
  VALUES('${rotated}','${standing.principal}','${standing.run}','${standing.task}',1,'["post_signal"]'::jsonb,${hash(5)},clock_timestamp()+interval '1 hour','${standing.lineage}','${standing.grant}','${standing.token}');
UPDATE swarm.agent_tokens SET expires_at=clock_timestamp() WHERE token_id='${standing.token}';
INSERT INTO swarm.household_workspace_boundaries(workspace_id,purpose) VALUES('${ws}','shared');
INSERT INTO swarm.household_member_content_roles(workspace_id,user_id,content_role,content_consent_id,confirmed_at)
  VALUES('${ws}','${owner}','editor','${consent}',clock_timestamp());
-- live approval on a live token; live approval on a rotated token; an approval that already lapsed
INSERT INTO swarm.household_content_connections(connection_id,grant_id,workspace_id,principal_id,owner_user_id,purpose,operations,consent_receipt_id,expires_at)
  VALUES('${future.token}','${future.run}','${ws}','${future.principal}','${owner}','shared',ARRAY['read','create'],'${consent}',clock_timestamp()+interval '6 days'),
        ('${standing.token}','${standing.run}','${ws}','${standing.principal}','${owner}','shared',ARRAY['read'],'${consent}',clock_timestamp()+interval '6 days'),
        ('${orphan.token}','${orphan.run}','${ws}','${orphan.principal}','${owner}','shared',ARRAY['read'],'${consent}',clock_timestamp()-interval '1 day');
INSERT INTO swarm.hosted_mcp_grants(grant_id,provider_grant_id,owner_user_id,home_workspace_id,client_id,resource,selected_workspace_ids,manifest_digest,interaction_ref,state,created_at,activated_at)
  VALUES('${hostedBound}','provider-${hostedBound}','${hostedOwner}','${hws}','test-client','https://mcp.commonswarm.com/mcp',ARRAY['${hws}']::uuid[],decode(repeat('07',32),'hex'),'interaction-${hostedBound}','active',statement_timestamp(),statement_timestamp()),
        ('${hostedUnbound}','provider-${hostedUnbound}','${hostedOwner}','${hws}','test-client','https://mcp.commonswarm.com/mcp',ARRAY['${hws}']::uuid[],decode(repeat('07',32),'hex'),'interaction-${hostedUnbound}','active',statement_timestamp(),statement_timestamp());
INSERT INTO commonswarm_oauth.provider_grant_resources(provider_grant_id,resource,grant_class,owner_user_id,client_id,connection_id,hosted_grant_id)
  VALUES('provider-${hostedBound}','https://mcp.commonswarm.com/mcp','hosted_mcp','${hostedOwner}','test-client','${hostedBound}','${hostedBound}');
${check(`SELECT expires_at<=clock_timestamp() AND first_used_at IS NOT NULL FROM swarm.agent_tokens WHERE token_id='${standing.token}'`, 'fixture: the approved root is expired and used')}
`;

  const grantRow = (grant: string) => `SELECT kind,max_successors,horizon_expires_at FROM swarm.renewal_grants WHERE renewal_grant_id='${grant}'`;
  const journal = (relation: string, action: string, keyField: string, key: string) =>
    `SELECT count(*) FROM swarm.permanence_grandfather_journal WHERE relation='${relation}' AND action='${action}' AND row_key->>'${keyField}'='${key}'`;

  runSql(`${sqlPhase('fixture', fixture)}
CREATE TEMP TABLE before_horizon AS SELECT renewal_grant_id,horizon_expires_at FROM swarm.renewal_grants;
CREATE TEMP TABLE before_approvals AS SELECT connection_id,grant_id,workspace_id,principal_id,expires_at FROM swarm.household_content_connections;
${sqlPhase('catalog-before', proof('catalog', false))}
${sqlPhase('migration', repoSql(MIGRATION))}
${sqlPhase('assert-families', '')}
-- Diagnostic first: if the family is not standing, raise the journal's verdict and
-- fixed refusal code for it (never row data) so a sanitized CI log still explains why.
DO $diag$ DECLARE verdict text; BEGIN
  IF NOT EXISTS (SELECT 1 FROM swarm.renewal_grants WHERE renewal_grant_id='${future.grant}' AND kind='standing') THEN
    SELECT coalesce(string_agg(action || '/' || coalesce(previous->>'refusal','-'), ';'), 'no journal entry') INTO verdict
      FROM swarm.permanence_grandfather_journal WHERE row_key->>'renewal_grant_id'='${future.grant}';
    RAISE EXCEPTION 'future family not converted: %', verdict USING ERRCODE='ZD001';
  END IF;
END $diag$;
${check(`SELECT kind='standing' AND max_successors IS NULL AND horizon_expires_at IS NULL FROM (${grantRow(future.grant)}) g`, 'future horizon converted to standing')}
${check(`SELECT kind='timeboxed' AND max_successors=100 AND horizon_expires_at<clock_timestamp() FROM (${grantRow(past.grant)}) g`, 'past horizon untouched')}
${check(`SELECT kind='timeboxed' AND max_successors=100 AND horizon_expires_at>clock_timestamp() FROM (${grantRow(orphan.grant)}) g`, 'family without mint provenance untouched')}
${check(`SELECT kind='standing' FROM (${grantRow(standing.grant)}) g`, 'standing family untouched')}
${check(`(${journal('swarm.renewal_grants', 'converted', 'renewal_grant_id', future.grant)})=1`, 'conversion journaled')}
${check(`(${journal('swarm.renewal_grants', 'skipped-provenance', 'renewal_grant_id', orphan.grant)})=1`, 'provenance skip journaled')}
${check(`(SELECT count(*) FROM swarm.permanence_grandfather_journal WHERE relation='swarm.renewal_grants')=2`, 'dead family has no journal entry')}
${sqlPhase('assert-hosted', '')}
${check(`SELECT count(*)=1 FROM commonswarm_oauth.provider_grant_resources WHERE hosted_grant_id='${hostedUnbound}' AND provider_grant_id='provider-${hostedUnbound}' AND connection_id='${hostedUnbound}' AND grant_class='hosted_mcp' AND owner_user_id='${hostedOwner}' AND client_id='test-client'`, 'unbound hosted family gets the backfill-shaped binding')}
${check(`SELECT count(*)=1 FROM commonswarm_oauth.provider_grant_resources WHERE hosted_grant_id='${hostedBound}'`, 'bound hosted family keeps its single binding')}
${check(`(${journal('commonswarm_oauth.provider_grant_resources', 'inserted', 'hosted_grant_id', hostedUnbound)})=1 AND (SELECT count(*) FROM swarm.permanence_grandfather_journal WHERE relation='commonswarm_oauth.provider_grant_resources')=1`, 'exactly one binding journaled')}
${sqlPhase('assert-approvals', '')}
${check(`SELECT expires_at IS NULL AND renewal_grant_id='${future.grant}' FROM swarm.household_content_connections WHERE connection_id='${future.token}'`, 'live approval bound to its family without expiry')}
${check(`SELECT expires_at IS NULL AND renewal_grant_id='${standing.grant}' FROM swarm.household_content_connections WHERE connection_id='${rotated}' AND grant_id='${standing.run}'`, 'rotated approval re-keyed to the live token and bound')}
${check(`SELECT count(*)=0 FROM swarm.household_content_connections WHERE connection_id='${standing.token}'`, 'expired bearer no longer keys the approval')}
${check(`SELECT expires_at<clock_timestamp() AND renewal_grant_id IS NULL FROM swarm.household_content_connections WHERE connection_id='${orphan.token}'`, 'lapsed approval untouched')}
${check(`SELECT count(*)=1 FROM swarm.permanence_grandfather_journal WHERE relation='swarm.household_content_connections' AND action='bound' AND row_key->>'connection_id'='${rotated}' AND previous->>'connection_id'='${standing.token}'`, 're-key journaled with the original key')}
${check(`(SELECT count(*) FROM swarm.permanence_grandfather_journal WHERE relation='swarm.household_content_connections')=2`, 'lapsed approval has no journal entry')}
${sqlPhase('journal-guard', '')}
${refuses(`UPDATE swarm.permanence_grandfather_journal SET previous='{}'::jsonb`, '55000')}
${refuses(`DELETE FROM swarm.permanence_grandfather_journal`, '55000')}
${refuses(`UPDATE swarm.permanence_grandfather_journal SET restored_at=clock_timestamp(),action='bound' WHERE action='converted'`, '55000')}
${check('SELECT swarm.permanence_grandfather_complete()', 'completion predicate holds')}
${check('SELECT NOT swarm.permanence_grandfather_restored()', 'nothing is restored yet')}
${sqlPhase('proofs-after-migration', proof('catalog', true) + proof('rollback-catalog', false) + repoSql(`${PROOFS}-functional.sql`))}
${sqlPhase('second-application', repoSql(MIGRATION))}
${check(`SELECT count(*)=5 FROM swarm.permanence_grandfather_journal`, 'second application adds no journal entries')}
${sqlPhase('rollback', repoSql(`${PROOFS}-rollback.sql`))}
${sqlPhase('assert-rollback', '')}
${check(`SELECT g.kind='timeboxed' AND g.max_successors=100 AND g.horizon_expires_at=b.horizon_expires_at FROM swarm.renewal_grants g JOIN before_horizon b USING(renewal_grant_id) WHERE g.renewal_grant_id='${future.grant}'`, 'conversion restored exactly')}
${check(`SELECT count(*)=3 FROM swarm.household_content_connections c JOIN before_approvals b USING(connection_id,grant_id,workspace_id,principal_id) WHERE c.expires_at IS NOT DISTINCT FROM b.expires_at AND c.renewal_grant_id IS NULL`, 'every approval row restored to its original key and expiry')}
${check(`SELECT count(*)=0 FROM swarm.household_content_connections WHERE connection_id='${rotated}'`, 're-keyed row is gone after restore')}
${check(`SELECT count(*)=1 FROM commonswarm_oauth.provider_grant_resources WHERE hosted_grant_id='${hostedUnbound}'`, 'binding rows stay after rollback')}
${check(`SELECT count(*)=0 FROM swarm.permanence_grandfather_journal WHERE action IN ('converted','bound') AND restored_at IS NULL`, 'restorable entries stamped')}
${check(`SELECT bool_and(tgenabled='O') FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('renewal_grants_spend_or_revoke_only','aa_household_local_family_binding')`, 'guard triggers enabled again')}
${sqlPhase('proofs-after-rollback', proof('rollback-catalog', true) + proof('catalog', false))}
${sqlPhase('restored-missing-row', '')}
DELETE FROM swarm.household_content_connections WHERE connection_id='${future.token}';
${check('SELECT NOT swarm.permanence_grandfather_restored()', 'missing restored row fails the proof')}
`);
});

test('grandfather proofs are error-safe before the migration and both hold on an empty database', () => {
  runSql(`
-- The schema clone already carries this migration's DDL; remove it to prove
-- the catalog scripts resolve absent objects without erroring.
DROP FUNCTION swarm.permanence_grandfather_complete();
DROP FUNCTION swarm.permanence_grandfather_restored();
DROP TABLE swarm.permanence_grandfather_journal;
DROP FUNCTION swarm.permanence_grandfather_journal_guard();
${proof('catalog', false)}
${proof('rollback-catalog', false)}
${repoSql(MIGRATION)}
${check('SELECT count(*)=0 FROM swarm.permanence_grandfather_journal', 'nothing to grandfather on an empty database')}
${proof('catalog', true)}
${proof('rollback-catalog', true)}
${repoSql(`${PROOFS}-functional.sql`)}
`);
});
