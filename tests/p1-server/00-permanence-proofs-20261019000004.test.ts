/** 20261019000004 hosted client stream lock: its proofs and its rollback reserve. CI/Docker only. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { dbAssert, refuses, repoSql, runSql } from '../support/admin-schema-db.js';
import { sqlPhase } from '../support/admin-schema-process.js';

const MIGRATION = 'supabase/migrations/20261019000004_hosted_client_stream_lock.sql';
const PROOFS = 'deploy/release-proofs/permanence/20261019000004';
const RESERVE = 'supabase/permanence-reserve/20261019000004';
const LOCK = 'commonswarm_oauth.lock_hosted_client_streams(text)';
const FAMILY_LOCK = 'commonswarm_oauth.lock_hosted_family(text,uuid,text,text)';

/** Exact prosrc of the lock as the migration installs it: the text between its dollar quotes. */
function migrationBody(): string {
  const match = repoSql(MIGRATION).match(/CREATE FUNCTION commonswarm_oauth\.lock_hosted_client_streams\([\s\S]*?AS \$function\$([\s\S]*?)\$function\$;/);
  assert.ok(match, 'lock defined in the migration');
  return match[1]!;
}
const md5 = (text: string) => createHash('md5').update(text).digest('hex');

function proof(kind: 'catalog' | 'rollback-catalog', expect: boolean): string {
  const alias = kind === 'catalog' ? 'catalog_ok' : 'rollback_ok';
  return repoSql(`${PROOFS}-${kind}.sql`)
    + `\nSELECT :'${alias}'::boolean=${expect} AS proof_pass\n\\gset\n\\if :proof_pass\n\\else\n`
    + `DO $fail$ BEGIN RAISE EXCEPTION '${kind} expected ${expect}'; END $fail$;\n\\endif\n`;
}

test('20261019000004 proofs are the same bytes in the reserve and the release packet', () => {
  for (const kind of ['catalog', 'functional', 'rollback', 'rollback-catalog']) {
    assert.equal(repoSql(`${RESERVE}-${kind}.sql`), repoSql(`${PROOFS}-${kind}.sql`), kind);
  }
});

test('20261019000004 proofs pin the reviewed body and the rollback only drops the lock', () => {
  const pin = `'${md5(migrationBody())}'`;
  assert.ok(repoSql(`${PROOFS}-catalog.sql`).includes(pin), 'migration body pinned in the catalog proof');
  assert.ok(repoSql(`${PROOFS}-functional.sql`).includes(pin), 'migration body pinned in the functional proof');
  const rollback = repoSql(`${PROOFS}-rollback.sql`);
  assert.match(rollback, /DROP FUNCTION IF EXISTS commonswarm_oauth\.lock_hosted_client_streams\(text\);\n$/);
  assert.equal(rollback.split('\n').filter(line => line !== '' && !line.startsWith('-- ')).length, 1, 'one statement only');
});

test('20261019000004 serializes a client, its rollback removes only the lock and the migration re-applies identically', () => {
  const owner = randomUUID(), ws = randomUUID(), streamlessWs = randomUUID(), stream = randomUUID();
  const lockedGrant = randomUUID(), streamlessGrant = randomUUID();
  const client = `client-${randomUUID()}`, streamlessClient = `client-${randomUUID()}`;
  const digest = "decode(repeat('07',32),'hex')";
  const hostedGrant = (grant: string, workspace: string, clientId: string) =>
    `('${grant}','provider-${grant}','${owner}','${workspace}','${clientId}','https://mcp.commonswarm.com/mcp',ARRAY['${workspace}']::uuid[],${digest},'interaction-${grant}','active',statement_timestamp(),statement_timestamp())`;
  const binding = (grant: string, clientId: string) =>
    `('provider-${grant}','https://mcp.commonswarm.com/mcp','hosted_mcp','${owner}','${clientId}','${grant}','${grant}')`;
  const fixture = `
${repoSql('deploy/release-proofs/agents/20261028000003-rollback.sql')}
INSERT INTO auth.users(id,aud,role,email) VALUES('${owner}','authenticated','authenticated','${owner}@example.test');
INSERT INTO swarm.users(user_id,display_name) VALUES('${owner}','Stream lock owner');
INSERT INTO swarm.workspaces(workspace_id,name,created_by) VALUES('${ws}','Locked','${owner}'),('${streamlessWs}','Streamless','${owner}');
INSERT INTO swarm.memberships(workspace_id,user_id,role) VALUES('${ws}','${owner}','owner'),('${streamlessWs}','${owner}','owner');
INSERT INTO swarm.streams(stream_id,workspace_id,kind) VALUES('${stream}','${ws}','workspace');
-- one client bound to a workspace with its stream, one bound to a workspace without
INSERT INTO swarm.hosted_mcp_grants(grant_id,provider_grant_id,owner_user_id,home_workspace_id,client_id,resource,selected_workspace_ids,manifest_digest,interaction_ref,state,created_at,activated_at)
  VALUES ${hostedGrant(lockedGrant, ws, client)}, ${hostedGrant(streamlessGrant, streamlessWs, streamlessClient)};
INSERT INTO commonswarm_oauth.provider_grant_resources(provider_grant_id,resource,grant_class,owner_user_id,client_id,connection_id,hosted_grant_id)
  VALUES ${binding(lockedGrant, client)}, ${binding(streamlessGrant, streamlessClient)};
INSERT INTO commonswarm_oauth.registered_clients(client_id,metadata,expires_at)
  VALUES('${client}','{}'::jsonb,statement_timestamp()+interval '7 days'),('${streamlessClient}','{}'::jsonb,NULL);
CREATE TEMP TABLE stream_lock_before AS
SELECT pg_get_functiondef(p.oid) AS definition, p.proowner, p.proacl::text AS acl FROM pg_proc p WHERE p.oid=to_regprocedure('${LOCK}');
`;
  const locked = (clientId: string) => `SELECT count(*) FROM commonswarm_oauth.lock_hosted_client_streams('${clientId}')`;

  runSql(`${sqlPhase('stream-lock-fixture', fixture)}
${sqlPhase('stream-lock-forward', `
${dbAssert('SELECT count(*)=1 FROM stream_lock_before', 'stream lock present before rollback')}
${dbAssert(`SELECT count(*)=1 AND bool_and(provider_grant_id='provider-${lockedGrant}' AND owner_user_id='${owner}' AND client_id='${client}' AND resource='https://mcp.commonswarm.com/mcp') FROM commonswarm_oauth.lock_hosted_client_streams('${client}')`, 'client lock returns its binding')}
${dbAssert(`(${locked(`client-none-${randomUUID()}`)})=0`, 'unknown client locks nothing')}
${refuses(`PERFORM commonswarm_oauth.lock_hosted_client_streams('${streamlessClient}')`, '40001')}
${proof('catalog', true)}
${repoSql(`${PROOFS}-functional.sql`)}
${proof('rollback-catalog', false)}`)}
${sqlPhase('stream-lock-rollback', `
${repoSql(`${PROOFS}-rollback.sql`)}
${dbAssert(`to_regprocedure('${LOCK}') IS NULL`, 'stream lock dropped')}
${dbAssert(`to_regprocedure('${FAMILY_LOCK}') IS NOT NULL`, 'family lock of 20261019000003 kept')}
${dbAssert(`SELECT count(*)=2 FROM commonswarm_oauth.registered_clients WHERE client_id IN ('${client}','${streamlessClient}')`, 'registrations kept')}
${dbAssert(`SELECT count(*)=2 FROM commonswarm_oauth.provider_grant_resources WHERE hosted_grant_id IN ('${lockedGrant}','${streamlessGrant}')`, 'bindings kept')}
${proof('rollback-catalog', true)}
${proof('catalog', false)}`)}
${sqlPhase('stream-lock-reapply', `
${repoSql(MIGRATION)}
${dbAssert(`SELECT count(*)=1 FROM stream_lock_before b CROSS JOIN LATERAL (SELECT p.proowner, p.proacl::text AS acl, pg_get_functiondef(p.oid) AS definition FROM pg_proc p WHERE p.oid=to_regprocedure('${LOCK}') OFFSET 0) now WHERE now.definition=b.definition AND now.proowner=b.proowner AND now.acl=b.acl`, 'migration re-applied identically')}
${dbAssert(`(${locked(client)})=1`, 'client lock works again')}
${proof('catalog', true)}
${proof('rollback-catalog', false)}`)}
`);
});
