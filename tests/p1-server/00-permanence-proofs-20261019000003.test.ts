/** 20261019000003 connection policy enforcement: its proofs and its rollback reserve. CI/Docker only. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { dbAssert, repoSql, runSql } from '../support/admin-schema-db.js';
import { sqlPhase } from '../support/admin-schema-process.js';

const MIGRATION = 'supabase/migrations/20261019000003_connection_policy_enforcement.sql';
const PROOFS = 'deploy/release-proofs/permanence/20261019000003';
const RESERVE = 'supabase/permanence-reserve/20261019000003';
const HM = 'supabase/migrations/20260928000002_hm_hosted_authority.sql';
const STATUS = 'supabase/migrations/20261019000001_hosted_consent_family_status.sql';
// Every function the migration replaces, with the migration file that defined it last.
const REPLACED = [
  { signature: 'swarm.resolve_hosted_grant_authorization(uuid,uuid,uuid,text)', name: 'swarm.resolve_hosted_grant_authorization', tag: 'fn', previous: HM },
  { signature: 'swarm.resolve_hosted_seat_command_authorization(uuid,text,text)', name: 'swarm.resolve_hosted_seat_command_authorization', tag: 'fn', previous: HM },
  { signature: 'swarm.resolve_hosted_seat_read_authorization(uuid,text,text)', name: 'swarm.resolve_hosted_seat_read_authorization', tag: 'fn', previous: HM },
  { signature: 'commonswarm_oauth.resolve_hosted_grant_status(text)', name: 'commonswarm_oauth.resolve_hosted_grant_status', tag: 'function', previous: STATUS },
] as const;
const LOCK = { signature: 'commonswarm_oauth.lock_hosted_family(text,uuid,text,text)', name: 'commonswarm_oauth.lock_hosted_family', tag: 'function' } as const;

/** Exact prosrc of a function as a migration file installs it: the text between its dollar quotes. */
function body(file: string, name: string, tag: string): string {
  const escaped = name.replace(/[.()]/g, m => `\\${m}`);
  const match = repoSql(file).match(new RegExp(`CREATE (?:OR REPLACE )?FUNCTION ${escaped}\\([\\s\\S]*?AS \\$${tag}\\$([\\s\\S]*?)\\$${tag}\\$;`));
  assert.ok(match, `${name} defined in ${file}`);
  return match[1]!;
}
const md5 = (text: string) => createHash('md5').update(text).digest('hex');

function proof(kind: 'catalog' | 'rollback-catalog', expect: boolean): string {
  const alias = kind === 'catalog' ? 'catalog_ok' : 'rollback_ok';
  return repoSql(`${PROOFS}-${kind}.sql`)
    + `\nSELECT :'${alias}'::boolean=${expect} AS proof_pass\n\\gset\n\\if :proof_pass\n\\else\n`
    + `DO $fail$ BEGIN RAISE EXCEPTION '${kind} expected ${expect}'; END $fail$;\n\\endif\n`;
}

test('20261019000003 proofs are the same bytes in the reserve and the release packet', () => {
  for (const kind of ['catalog', 'functional', 'rollback', 'rollback-catalog']) {
    assert.equal(repoSql(`${RESERVE}-${kind}.sql`), repoSql(`${PROOFS}-${kind}.sql`), kind);
  }
});

test('20261019000003 proofs pin the reviewed bodies and the rollback restores the previous definers verbatim', () => {
  const catalog = repoSql(`${PROOFS}-catalog.sql`), functional = repoSql(`${PROOFS}-functional.sql`);
  const rollback = repoSql(`${PROOFS}-rollback.sql`), rollbackCatalog = repoSql(`${PROOFS}-rollback-catalog.sql`);
  for (const f of [...REPLACED, LOCK]) {
    const pin = `'${md5(body(MIGRATION, f.name, f.tag))}'`;
    assert.ok(catalog.includes(pin), `${f.name} migration body pinned in the catalog proof`);
    assert.ok(functional.includes(pin), `${f.name} migration body pinned in the functional proof`);
  }
  for (const f of REPLACED) {
    const previous = body(f.previous, f.name, f.tag);
    assert.ok(rollbackCatalog.includes(`'${md5(previous)}'`), `${f.name} previous body pinned in the rollback catalog`);
    assert.equal(body(`${PROOFS}-rollback.sql`, f.name, f.tag), previous, `${f.name} restored verbatim`);
    assert.notEqual(previous, body(MIGRATION, f.name, f.tag), `${f.name} positive control: the migration changed the body`);
  }
  assert.match(rollback, /DROP FUNCTION IF EXISTS commonswarm_oauth\.lock_hosted_family\(text, uuid, text, text\);\n$/);
  assert.doesNotMatch(rollback, /\bCASCADE\b|\bTRUNCATE\b|\bDELETE FROM\b|\bDROP TABLE\b/);
});

test('20261019000003 enforces the connection fence, its rollback restores the previous resolvers and the migration re-applies identically', () => {
  const owner = randomUUID(), ws = randomUUID(), stream = randomUUID(), liveGrant = randomUUID(), fencedGrant = randomUUID();
  const client = `client-${randomUUID()}`, digest = "decode(repeat('07',32),'hex')";
  const hostedGrant = (grant: string, expired: string) =>
    `('${grant}','provider-${grant}','${owner}','${ws}','${client}','https://mcp.commonswarm.com/mcp',ARRAY['${ws}']::uuid[],${digest},'interaction-${grant}','active',statement_timestamp(),statement_timestamp(),${expired})`;
  const fixture = `
${repoSql('deploy/release-proofs/agents/20261028000003-rollback.sql')}
INSERT INTO auth.users(id,aud,role,email) VALUES('${owner}','authenticated','authenticated','${owner}@example.test');
INSERT INTO swarm.users(user_id,display_name) VALUES('${owner}','Enforcement owner');
INSERT INTO swarm.workspaces(workspace_id,name,created_by) VALUES('${ws}','Enforcement','${owner}');
INSERT INTO swarm.memberships(workspace_id,user_id,role) VALUES('${ws}','${owner}','owner');
INSERT INTO swarm.streams(stream_id,workspace_id,kind) VALUES('${stream}','${ws}','workspace');
-- a live hosted family and one whose connection already ended
INSERT INTO swarm.hosted_mcp_grants(grant_id,provider_grant_id,owner_user_id,home_workspace_id,client_id,resource,selected_workspace_ids,manifest_digest,interaction_ref,state,created_at,activated_at,connection_expired_at)
  VALUES ${hostedGrant(liveGrant, 'NULL')}, ${hostedGrant(fencedGrant, "statement_timestamp()-interval '1 hour'")};
INSERT INTO swarm.hosted_mcp_grant_workspaces(grant_id,workspace_id,owner_user_id,manifest_digest,consent_receipt_id,consented_at)
  VALUES('${liveGrant}','${ws}','${owner}',${digest},'${randomUUID()}',statement_timestamp()),
        ('${fencedGrant}','${ws}','${owner}',${digest},'${randomUUID()}',statement_timestamp());
INSERT INTO commonswarm_oauth.provider_grant_resources(provider_grant_id,resource,grant_class,owner_user_id,client_id,connection_id,hosted_grant_id)
  VALUES('provider-${liveGrant}','https://mcp.commonswarm.com/mcp','hosted_mcp','${owner}','${client}','${liveGrant}','${liveGrant}');
CREATE TEMP TABLE enforcement_before AS
SELECT p.oid::regprocedure::text AS signature, pg_get_functiondef(p.oid) AS definition, p.proowner, p.proacl::text AS acl
FROM pg_proc p WHERE p.oid IN (${[...REPLACED, LOCK].map(f => `to_regprocedure('${f.signature}')`).join(',')});
`;
  const authorized = (grant: string) => `SELECT count(*) FROM swarm.resolve_hosted_grant_authorization('${grant}','${owner}','${ws}','claim_hosted_seat')`;
  const status = (grant: string) => `SELECT active FROM commonswarm_oauth.resolve_hosted_grant_status('provider-${grant}')`;
  const lock = (provider: string) => `commonswarm_oauth.lock_hosted_family('${provider}','${owner}','${client}','https://mcp.commonswarm.com/mcp')`;
  const previousBodies = REPLACED.map(f => `('${f.signature}','${md5(body(f.previous, f.name, f.tag))}')`).join(',');

  runSql(`${sqlPhase('enforcement-fixture', fixture)}
${sqlPhase('enforcement-forward', `
${dbAssert('SELECT count(*)=5 FROM enforcement_before', 'all five functions present before rollback')}
${dbAssert(`(${authorized(liveGrant)})=1`, 'live grant authorized under enforcement')}
${dbAssert(`(${authorized(fencedGrant)})=0`, 'fenced grant refused under enforcement')}
${dbAssert(`(${status(liveGrant)})`, 'live family active under enforcement')}
${dbAssert(`NOT (${status(fencedGrant)})`, 'fenced family inactive under enforcement')}
${dbAssert(`SELECT count(*)=1 AND bool_and(state='active' AND active AND connection_expires_at IS NULL AND connection_expired_at IS NULL) FROM ${lock(`provider-${liveGrant}`)}`, 'family lock returns the live family')}
${dbAssert(`SELECT count(*)=0 FROM ${lock(`provider-${randomUUID()}`)}`, 'family lock ignores an unknown family')}
${proof('catalog', true)}
${repoSql(`${PROOFS}-functional.sql`)}
${proof('rollback-catalog', false)}`)}
${sqlPhase('enforcement-rollback', `
${repoSql(`${PROOFS}-rollback.sql`)}
${dbAssert(`to_regprocedure('${LOCK.signature}') IS NULL`, 'family lock dropped')}
${dbAssert(`SELECT count(*)=4 FROM (VALUES ${previousBodies}) e(signature,body) JOIN pg_proc p ON p.oid=to_regprocedure(e.signature) WHERE md5(p.prosrc)=e.body`, 'previous bodies restored verbatim')}
${dbAssert(`SELECT count(*)=4 FROM enforcement_before b JOIN pg_proc p ON p.oid=to_regprocedure(b.signature) WHERE p.proowner=b.proowner AND p.proacl::text=b.acl AND p.prosecdef`, 'owner and grantees kept')}
${dbAssert(`(${authorized(fencedGrant)})=1`, 'previous resolver ignores the fence')}
${dbAssert(`(${status(fencedGrant)})`, 'previous status ignores the fence')}
${proof('rollback-catalog', true)}
${proof('catalog', false)}`)}
${sqlPhase('enforcement-reapply', `
${repoSql(MIGRATION)}
${dbAssert(`SELECT count(*)=5 FROM enforcement_before b CROSS JOIN LATERAL (SELECT p.proowner, p.proacl::text AS acl, pg_get_functiondef(p.oid) AS definition FROM pg_proc p WHERE p.oid=to_regprocedure(b.signature) OFFSET 0) now WHERE now.definition=b.definition AND now.proowner=b.proowner AND now.acl=b.acl`, 'migration re-applied identically')}
${dbAssert(`(${authorized(fencedGrant)})=0`, 'fence enforced again')}
${dbAssert(`NOT (${status(fencedGrant)})`, 'fenced family inactive again')}
${proof('catalog', true)}
${proof('rollback-catalog', false)}`)}
`);
});
