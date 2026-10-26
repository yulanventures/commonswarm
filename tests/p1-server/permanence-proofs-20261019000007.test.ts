/** 20261019000007 local auth lock order: release proofs and rollback reserve. CI/Docker only. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { dbAssert, refuses, repoSql, runSql } from '../support/admin-schema-db.js';

const VERSION = '20261019000007';
const MIGRATION = `supabase/migrations/${VERSION}_local_auth_lock_order.sql`;
const PROOFS = `deploy/release-proofs/permanence/${VERSION}`;
const RESERVE = `supabase/permanence-reserve/${VERSION}`;
const MIGRATIONS = new URL('../../supabase/migrations/', import.meta.url);

/** Objects 00007 creates and the reserve drops. */
const CREATED = [
  'swarm.discover_local_credential_ids(bytea)',
  'swarm.discover_local_target_ids(uuid,uuid,uuid[],uuid[],boolean,uuid,boolean)',
  'swarm.discover_local_target_ids(uuid,uuid,uuid[],uuid[],boolean,uuid)',
  'swarm.discover_local_target_ids(uuid,uuid,uuid[],uuid[],boolean)',
  'swarm.discover_local_join_ids(bytea,uuid)',
  'swarm.household_local_family_binding_guard()',
  'swarm.local_content_approval_pointer_guard()',
];
/** Functions 00007 replaces and the reserve restores from the named previous definer. */
const RESTORED = [
  { signature: 'swarm.renewal_grants_spend_or_revoke_only()', name: 'swarm.renewal_grants_spend_or_revoke_only', previous: '20260904000001_standing_grant_resume.sql' },
  { signature: 'swarm_read.renewal_grant_for_token(uuid,uuid)', name: 'swarm_read.renewal_grant_for_token', previous: '20260904000001_standing_grant_resume.sql' },
  { signature: 'swarm_read.renewal_grant_roster(uuid)', name: 'swarm_read.renewal_grant_roster', previous: '20260904000001_standing_grant_resume.sql' },
  { signature: 'swarm.resume_renewal_grant(uuid,uuid,uuid)', name: 'swarm.resume_renewal_grant', previous: '20260904000001_standing_grant_resume.sql' },
  { signature: 'swarm.prepare_renewal_grant(uuid,uuid)', name: 'swarm.prepare_renewal_grant', previous: '20260904000001_standing_grant_resume.sql' },
  { signature: 'swarm.record_renewal_grant_use(uuid,uuid,text)', name: 'swarm.record_renewal_grant_use', previous: '20260925000002_renewal_last_use_monotonic.sql' },
  { signature: 'swarm.agent_tokens_successor_fence()', name: 'swarm.agent_tokens_successor_fence', previous: '20260925000002_renewal_last_use_monotonic.sql' },
  { signature: 'swarm.agent_delivery_read_context(bytea,uuid)', name: 'swarm.agent_delivery_read_context', previous: '20261001000004_admin_worker_read_fence.sql' },
];
const ALL = [...CREATED, ...RESTORED.map(entry => entry.signature)];

function proof(kind: 'catalog' | 'rollback-catalog', expect: boolean): string {
  const alias = kind === 'catalog' ? 'catalog_ok' : 'rollback_ok';
  return repoSql(`${PROOFS}-${kind}.sql`)
    + `\nSELECT :'${alias}'::boolean=${expect} AS proof_pass\n\\gset\n\\if :proof_pass\n\\else\n`
    + `DO $fail$ BEGIN RAISE EXCEPTION '${kind} expected ${expect}'; END $fail$;\n\\endif\n`;
}

function definerPattern(name: string, flags: string): RegExp {
  return new RegExp(`^CREATE (?:OR REPLACE )?FUNCTION ${name.replaceAll('.', '\\.')}\\(`, flags);
}

/** The exact CREATE [OR REPLACE] FUNCTION statement for one function in one migration file. */
function definition(file: string, name: string): string {
  const text = repoSql(`supabase/migrations/${file}`);
  const heads = [...text.matchAll(definerPattern(name, 'gm'))];
  assert.equal(heads.length, 1, `${name} is defined once in ${file}`);
  const start = heads[0]!.index!;
  const opening = /\bAS\s+(\$[A-Za-z_]*\$)/.exec(text.slice(start));
  assert.ok(opening, `${name} has a dollar-quoted body in ${file}`);
  const bodyStart = start + opening.index + opening[0].length;
  const end = text.indexOf(opening[1]!, bodyStart);
  assert.ok(end > bodyStart, `${name} body closes in ${file}`);
  return `${text.slice(start, end + opening[1]!.length)};`;
}

/** The last migration before VERSION, in filename order, that defines the function. */
function previousDefiner(name: string): string {
  const pattern = definerPattern(name, 'm');
  const files = readdirSync(MIGRATIONS).filter(file => file.endsWith('.sql') && file < VERSION).sort();
  const definers = files.filter(file => pattern.test(readFileSync(new URL(file, MIGRATIONS), 'utf8')));
  assert.ok(definers.length > 0, `${name} has a definer before ${VERSION}`);
  return definers.at(-1)!;
}

/** Body, owner, definer mode, volatility, config, ACL and comment of each function. */
function identities(signatures: string[]): string {
  return `SELECT p.oid::regprocedure::text AS fn, md5(pg_get_functiondef(p.oid)) AS def, p.proowner::regrole::text AS owner_role,
    p.prosecdef, p.provolatile::text AS volatility, coalesce(array_to_string(p.proconfig,'|'),'') AS config,
    (SELECT coalesce(string_agg(x.grantee::regrole::text||'='||x.privilege_type,',' ORDER BY x.grantee::regrole::text,x.privilege_type),'')
      FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x) AS acl,
    coalesce(obj_description(p.oid,'pg_proc'),'') AS note
  FROM pg_proc p WHERE p.oid IN (${signatures.map(signature => `to_regprocedure('${signature}')`).join(',')})`;
}
const snapshot = (table: string, signatures: string[]) => `CREATE TEMP TABLE ${table} AS ${identities(signatures)};\n`
  + dbAssert(`(SELECT count(*) FROM ${table})=${signatures.length}`, `${table}: every function present`);
const unchanged = (table: string, signatures: string[], label: string) => dbAssert(
  `(SELECT count(*) FROM ${table} s JOIN (${identities(signatures)}) n USING (fn,def,owner_role,prosecdef,volatility,config,acl,note))=${signatures.length}`, label);

const column = `EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='swarm.renewal_grants'::regclass AND attname='local_content_approval_token_id' AND NOT attisdropped)`;
const guardTriggers = `(SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('aa_household_local_family_binding','aa_local_content_approval_pointer'))`;
const columnGrant = `EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) x WHERE a.attrelid='swarm.household_content_connections'::regclass AND a.attname='renewal_grant_id' AND x.grantee='swarm_command'::regrole AND x.privilege_type='UPDATE')`;
const createdCount = `(SELECT count(*) FROM pg_proc WHERE oid IN (${CREATED.map(signature => `to_regprocedure('${signature}')`).join(',')}))`;

test('00007 release proofs are the same bytes in the reserve and the release packet', () => {
  for (const kind of ['catalog', 'functional', 'rollback', 'rollback-catalog']) {
    assert.equal(repoSql(`${RESERVE}-${kind}.sql`), repoSql(`${PROOFS}-${kind}.sql`), kind);
  }
});

test('00007 reserve restores each function from its last definer before 00007', () => {
  for (const entry of RESTORED) assert.equal(previousDefiner(entry.name), entry.previous, entry.name);
});

test('00007 catalog, functional and rollback proofs hold, the reserve restores the previous bodies and the migration reapplies', () => {
  const owner = randomUUID(), ws = randomUUID(), device = randomUUID(), principal = randomUUID(), run = randomUUID();
  const grant = randomUUID(), token = randomUUID(), task = randomUUID(), lineage = randomUUID(), consent = randomUUID();
  // token_hash is a 32-byte digest; the fixture never needs the plaintext.
  const hash = randomBytes(32).toString('hex');
  const fixture = `
INSERT INTO auth.users(id,aud,role,email) VALUES('${owner}','authenticated','authenticated','${owner}@example.test');
INSERT INTO swarm.users(user_id,display_name) VALUES('${owner}','Lock order owner');
INSERT INTO swarm.workspaces(workspace_id,name,created_by) VALUES('${ws}','Lock order','${owner}');
INSERT INTO swarm.memberships(workspace_id,user_id,role) VALUES('${ws}','${owner}','owner');
INSERT INTO swarm.devices(device_id,user_id,label) VALUES('${device}','${owner}','Mac mini');
INSERT INTO swarm.agent_principals(principal_id,workspace_id,owner_user_id,name) VALUES('${principal}','${ws}','${owner}','Agent');
INSERT INTO swarm.agent_runs(run_id,principal_id,device_id) VALUES('${run}','${principal}','${device}');
INSERT INTO swarm.renewal_grants(renewal_grant_id,workspace_id,principal_id,run_id,kind,max_successors,successors_used,horizon_expires_at,bound_device_id,created_by)
  VALUES('${grant}','${ws}','${principal}','${run}','standing',NULL,0,NULL,NULL,'${owner}');
INSERT INTO swarm.agent_tokens(token_id,principal_id,run_id,task_id,epoch,scopes,token_hash,expires_at,lineage_id,renewal_grant_id)
  VALUES('${token}','${principal}','${run}','${task}',1,'["post_signal"]'::jsonb,decode('${hash}','hex'),clock_timestamp()+interval '1 hour','${lineage}','${grant}');
INSERT INTO swarm.household_workspace_boundaries(workspace_id,purpose) VALUES('${ws}','shared');
INSERT INTO swarm.household_member_content_roles(workspace_id,user_id,content_role,content_consent_id,confirmed_at)
  VALUES('${ws}','${owner}','editor','${consent}',clock_timestamp());
INSERT INTO swarm.household_content_connections(connection_id,grant_id,workspace_id,principal_id,owner_user_id,purpose,operations,consent_receipt_id,expires_at)
  VALUES('${token}','${run}','${ws}','${principal}','${owner}','shared',ARRAY['read'],'${consent}',clock_timestamp()+interval '6 days');
-- Bind the approval to its family (the 00007 family binding guard admits it),
-- then record the owner's Allow pointer under household command context (the
-- 00007 pointer guard admits it). Clearing the pointer again is refused.
UPDATE swarm.household_content_connections SET renewal_grant_id='${grant}',expires_at=NULL WHERE connection_id='${token}' AND grant_id='${run}';
SELECT set_config('cswarm.household_actor','${owner}',true),set_config('cswarm.household_command','household_permissions',true),
  set_config('cswarm.household_request','${randomUUID()}',true),set_config('cswarm.household_digest','${'a'.repeat(64)}',true);
UPDATE swarm.renewal_grants SET local_content_approval_token_id='${token}' WHERE renewal_grant_id='${grant}';
${dbAssert(`SELECT local_content_approval_token_id='${token}' FROM swarm.renewal_grants WHERE renewal_grant_id='${grant}'`, 'owner Allow pointer recorded')}
${refuses(`UPDATE swarm.renewal_grants SET local_content_approval_token_id=NULL WHERE renewal_grant_id='${grant}'`, '23514')}
`;

  runSql(`
-- The clone carries the 20261019000010 and 20261021000990 bodies on top of 00007,
-- so the 00007 catalog cannot be true on it. Bring the touched objects to the
-- exact post-00007 state first: the reserve removes every later body together
-- with the 00007 objects (so it must apply cleanly over them), then the
-- migration text reinstalls 00007 exactly.
${repoSql(`${PROOFS}-rollback.sql`)}
${proof('catalog', false)}
${proof('rollback-catalog', true)}
${repoSql(MIGRATION)}
${fixture}
${snapshot('installed', ALL)}
${dbAssert(`${column} AND ${guardTriggers}=2 AND ${columnGrant} AND ${createdCount}=${CREATED.length}`, 'column, guard triggers, column grant and created functions present')}
${proof('catalog', true)}
${repoSql(`${PROOFS}-functional.sql`)}
-- rollback reserve
${repoSql(`${PROOFS}-rollback.sql`)}
${dbAssert(`NOT ${column} AND ${guardTriggers}=0 AND NOT ${columnGrant} AND ${createdCount}=0`, 'column, guard triggers, column grant and created functions gone')}
${dbAssert(`SELECT count(*)=1 FROM swarm.renewal_grants WHERE renewal_grant_id='${grant}' AND kind='standing' AND revoked_at IS NULL`, 'family row survives the rollback')}
${dbAssert(`SELECT renewal_grant_id='${grant}' AND expires_at IS NULL AND revoked_at IS NULL FROM swarm.household_content_connections WHERE connection_id='${token}' AND grant_id='${run}'`, 'approval keeps its family binding')}
${dbAssert(`SELECT count(*)=1 FROM swarm.agent_tokens WHERE token_id='${token}' AND revoked_at IS NULL`, 'token row survives the rollback')}
${proof('rollback-catalog', true)}
${proof('catalog', false)}
-- The restored bodies are byte-exact: replacing each with its previous definer's
-- own statement changes nothing.
${snapshot('restored', RESTORED.map(entry => entry.signature))}
${RESTORED.map(entry => definition(entry.previous, entry.name)).join('\n')}
${unchanged('restored', RESTORED.map(entry => entry.signature), 'restored bodies equal their previous definers')}
-- roll forward again
${repoSql(MIGRATION)}
${unchanged('installed', ALL, 'reapplied 00007 matches the original installation')}
${dbAssert(`SELECT local_content_approval_token_id IS NULL FROM swarm.renewal_grants WHERE renewal_grant_id='${grant}'`, 'the owner Allow pointer is lost by design and must be chosen again')}
${proof('catalog', true)}
${proof('rollback-catalog', false)}
`);
});
