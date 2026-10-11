/** CI-only real DDL, history, privileges and reserve rollback. No bucket needed. */
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { runSql, repoSql, dbAssert, refuses } from '../support/admin-schema-db.js';
const proof = 'deploy/release-proofs/agent-avatars/20261015000001';
const owner = randomUUID(), member = randomUUID(), foreign = randomUUID(), workspace = randomUUID(), other = randomUUID(), stream = randomUUID();
const person = randomUUID(), agent = randomUUID(), unattributed = randomUUID(), creationOnly = randomUUID(), noModel = randomUUID();
const stamp = '2026-10-10T01:00:00Z';
const checkProof = (suffix: string, key: string) => repoSql(`${proof}-${suffix}.sql`)
  + `\nSELECT :'${key}'::boolean AS verified\n\\gset\n\\if :verified\n\\else\nDO $$ BEGIN RAISE EXCEPTION 'avatar ${suffix} proof failed'; END $$;\n\\endif\n`;

test('avatar migration partitions backfill history, gates member view, denies client writes, and rolls back verbatim without identity drift', {timeout:120_000}, () => {
  // emptyApplicationSchema copies the real migrated schema; remove only this
  // phase before reseeding its history. The exact reserve SQL is exercised twice.
  runSql(`
${repoSql(`${proof}-rollback.sql`)}
CREATE TEMP TABLE old_identity AS SELECT
 (SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute WHERE attrelid='swarm.agent_principals'::regclass AND attnum>0 AND NOT attisdropped) AS principal_columns,
 (SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute WHERE attrelid='swarm.hosted_mcp_seats'::regclass AND attnum>0 AND NOT attisdropped) AS seat_columns,
 pg_get_viewdef('swarm_read.agent_principals'::regclass) AS definition;
INSERT INTO auth.users(id,aud,role,email) VALUES('${owner}','authenticated','authenticated','${owner}@example.test'),
 ('${member}','authenticated','authenticated','${member}@example.test'),('${foreign}','authenticated','authenticated','${foreign}@example.test');
INSERT INTO swarm.users(user_id,display_name) VALUES('${owner}','Owner'),('${member}','Member'),('${foreign}','Outside');
INSERT INTO swarm.workspaces(workspace_id,name,created_by) VALUES('${workspace}','Avatar fixture','${owner}'),('${other}','Other fixture','${foreign}');
INSERT INTO swarm.memberships(workspace_id,user_id,role) VALUES('${workspace}','${owner}','owner'),('${workspace}','${member}','member'),('${other}','${foreign}','owner');
INSERT INTO swarm.streams(stream_id,workspace_id,kind) VALUES('${stream}','${workspace}','workspace');
INSERT INTO swarm.agent_principals(principal_id,workspace_id,owner_user_id,name,model,created_at) VALUES
 ('${person}','${workspace}','${owner}','Person model','P','${stamp}'),
 ('${agent}','${workspace}','${owner}','Agent model','A','${stamp}'),
 ('${unattributed}','${workspace}','${owner}','Unattributed','U','${stamp}'),
 ('${creationOnly}','${workspace}','${owner}','Creation only','C','${stamp}'),
 ('${noModel}','${workspace}','${owner}','No model',NULL,'${stamp}');
-- Latest unattributed event must not borrow attribution from an earlier person.
INSERT INTO swarm.events(workspace_id,stream_id,seq,event_id,command_id,type,schema_version,actor_user,actor_agent_principal,occurred_at_server,payload) VALUES
 ('${workspace}','${stream}',1,'${randomUUID()}','fixture-1','AgentModelDeclared',1,'${owner}',NULL,'${stamp}','{"principal_id":"${person}","model":"P","declared_at":1}'),
 ('${workspace}','${stream}',2,'${randomUUID()}','fixture-2','AgentModelDeclared',1,'${owner}','${agent}','${stamp}','{"principal_id":"${agent}","model":"A","declared_at":1}'),
 ('${workspace}','${stream}',3,'${randomUUID()}','fixture-3','AgentModelDeclared',1,'${owner}',NULL,'${stamp}','{"principal_id":"${unattributed}","model":"old","declared_at":1}'),
 ('${workspace}','${stream}',4,'${randomUUID()}','fixture-4','AgentModelDeclared',1,NULL,NULL,'${stamp}','{"principal_id":"${unattributed}","model":"U","declared_at":1}');
${repoSql(`${proof}-backfill-counts.sql`)}
${repoSql('supabase/migrations/20261015000001_agent_avatars.sql')}
${checkProof('catalog','catalog_ok')}
${checkProof('functional','functional_ok')}
${dbAssert(`(SELECT count(*)=4 FROM swarm.agent_model_provenance)`,'backfill total')}
${dbAssert(`(SELECT model_set_by='person' AND set_by_user_id='${owner}'::uuid FROM swarm.agent_model_provenance WHERE principal_id='${person}')`,'person branch')}
${dbAssert(`(SELECT model_set_by='agent' AND set_by_user_id IS NULL FROM swarm.agent_model_provenance WHERE principal_id='${agent}')`,'agent branch includes human owner')}
${dbAssert(`(SELECT count(*)=2 FROM swarm.agent_model_provenance WHERE model_set_by='unknown')`,'unknown latest and absent event')}
-- Positive command-role write, tenant-pinning negative and RLS privileges.
SET LOCAL ROLE swarm_command;
INSERT INTO swarm.agent_avatars(principal_id,workspace_id) VALUES('${person}','${workspace}');
${refuses(`INSERT INTO swarm.agent_avatars(principal_id,workspace_id) VALUES('${agent}','${other}')`,'23503')}
${refuses(`UPDATE swarm.agent_avatars SET source='uploaded_by_person' WHERE principal_id='${person}'`,'23514')}
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','${member}',true),set_config('request.jwt.claims','{"role":"authenticated","sub":"${member}"}',true);
${dbAssert(`(SELECT count(*)=5 FROM swarm_read.agent_identity_marks)`,'member view positive control')}
${dbAssert(`(SELECT count(*)=5 FROM swarm_read.agent_identity_marks WHERE app_host IS NULL AND verified_family IS NULL)`,'phase six fields null')}
${refuses(`SELECT * FROM swarm.agent_avatars`,'42501')}
${refuses(`INSERT INTO swarm.agent_model_provenance(principal_id,workspace_id,model_set_by,set_at) VALUES('${noModel}','${workspace}','unknown',now())`,'42501')}
${refuses(`UPDATE swarm.agent_avatar_jobs SET state='done'`,'42501')}
SELECT set_config('request.jwt.claim.sub','${foreign}',true),set_config('request.jwt.claims','{"role":"authenticated","sub":"${foreign}"}',true);
${dbAssert(`(SELECT count(*)=0 FROM swarm_read.agent_identity_marks)`,'nonmember view negative')}
RESET ROLE;
UPDATE swarm.memberships SET revoked_at=now() WHERE workspace_id='${workspace}' AND user_id='${member}';
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','${member}',true),set_config('request.jwt.claims','{"role":"authenticated","sub":"${member}"}',true);
${dbAssert(`(SELECT count(*)=0 FROM swarm_read.agent_identity_marks)`,'removed member gate')}
RESET ROLE;
${repoSql(`${proof}-rollback.sql`)}
${checkProof('rollback-catalog','rollback_ok')}
${dbAssert(`(SELECT principal_columns=(SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute WHERE attrelid='swarm.agent_principals'::regclass AND attnum>0 AND NOT attisdropped)
 AND seat_columns=(SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute WHERE attrelid='swarm.hosted_mcp_seats'::regclass AND attnum>0 AND NOT attisdropped)
 AND definition=pg_get_viewdef('swarm_read.agent_principals'::regclass) FROM old_identity)`,'identity tables and view unchanged')}
`);
});

test.todo('identity v1 agreement: after rebasing onto 3c415572 and approved directory reviews, compare member-visible app.client_id with agreed app_host extraction; no whoami change');
