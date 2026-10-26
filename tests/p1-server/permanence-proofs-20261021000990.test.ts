/** 20261021000990 suspension fence: release proofs and the reserve that restores the 00007 and 00010 bodies. CI/Docker only. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { dbAssert, repoSql, runSql } from '../support/admin-schema-db.js';

const VERSION = '20261021000990';
const FENCE = `${VERSION}_local_suspension_fence.sql`;
const MIGRATION = `supabase/migrations/${FENCE}`;
const PROOFS = `deploy/release-proofs/permanence/${VERSION}`;
const RESERVE = `supabase/permanence-reserve/${VERSION}`;
const LOCK_ORDER = '20261019000007_local_auth_lock_order.sql';
const READ_MODELS = '20261019000010_local_permanence_read_models.sql';

/** Every routine the fence replaces, with the branch migration whose body the reserve restores. */
const ROUTINES = [
  { signature: 'swarm.prepare_renewal_grant(uuid,uuid)', previous: LOCK_ORDER },
  { signature: 'swarm.discover_local_credential_ids(bytea)', previous: LOCK_ORDER },
  { signature: 'swarm.agent_delivery_read_context(bytea,uuid)', previous: LOCK_ORDER },
  { signature: 'swarm.agent_tokens_successor_fence()', previous: LOCK_ORDER },
  { signature: 'swarm.record_renewal_grant_use(uuid,uuid,text)', previous: LOCK_ORDER },
  { signature: 'swarm.household_local_family_binding_guard()', previous: LOCK_ORDER },
  { signature: 'swarm.local_content_approval_pointer_guard()', previous: LOCK_ORDER },
  { signature: 'swarm_read.local_connection_selection(uuid,uuid,uuid)', previous: READ_MODELS },
  { signature: 'swarm_read.home_overview()', previous: READ_MODELS },
  { signature: 'swarm_read.renewal_grant_roster(uuid)', previous: READ_MODELS },
  { signature: 'swarm_read.renewal_grant_for_token(uuid,uuid)', previous: LOCK_ORDER },
];
const nameOf = (signature: string) => signature.slice(0, signature.indexOf('('));

function proof(kind: 'catalog' | 'rollback-catalog', expect: boolean): string {
  const alias = kind === 'catalog' ? 'catalog_ok' : 'rollback_ok';
  return repoSql(`${PROOFS}-${kind}.sql`)
    + `\nSELECT :'${alias}'::boolean=${expect} AS proof_pass\n\\gset\n\\if :proof_pass\n\\else\n`
    + `DO $fail$ BEGIN RAISE EXCEPTION '${kind} expected ${expect}'; END $fail$;\n\\endif\n`;
}

/** md5 of the dollar-quoted body of the single definition of `name` in a migration file; equal to md5(prosrc) once installed. */
function bodyMd5(file: string, name: string): string {
  const text = repoSql(`supabase/migrations/${file}`);
  const heads = [...text.matchAll(new RegExp(`^CREATE (?:OR REPLACE )?FUNCTION ${name.replaceAll('.', '\\.')}\\(`, 'gm'))];
  assert.equal(heads.length, 1, `${name} is defined once in ${file}`);
  const opening = /\bAS\s+(\$[A-Za-z_]*\$)/.exec(text.slice(heads[0]!.index!));
  assert.ok(opening, `${name} has a dollar-quoted body in ${file}`);
  const start = heads[0]!.index! + opening.index + opening[0].length, end = text.indexOf(opening[1]!, start);
  assert.ok(end > start && text[end + opening[1]!.length] === ';', `${name} body closes in ${file}`);
  return createHash('md5').update(text.slice(start, end)).digest('hex');
}

/** The release runner applies each migration, its ledger row and its catalog proof in one
 * transaction; a migration that opened or committed its own would break that. */
function migrationStatements(): string {
  const text = repoSql(MIGRATION);
  assert.equal(text.match(/^(BEGIN|COMMIT|ROLLBACK|START TRANSACTION);$/gm), null, 'the migration opens no transaction of its own');
  return text;
}

const bodies = (file: (routine: typeof ROUTINES[number]) => string, label: string) => ROUTINES.map(routine =>
  dbAssert(`SELECT md5(prosrc)='${bodyMd5(file(routine), nameOf(routine.signature))}' FROM pg_proc WHERE oid='${routine.signature}'::regprocedure`,
    `${routine.signature} ${label}`)).join('\n');
// The definition is deparsed from the snapshot's oid only: as a join clause the planner would
// evaluate pg_get_functiondef over every pg_proc row, and it errors on aggregates.
const identity = (withBody: boolean, label: string) => dbAssert(`SELECT count(*)=11 FROM before_fence b JOIN pg_proc p ON p.oid=b.routine_oid
 WHERE ${withBody ? 'pg_get_functiondef(b.routine_oid)=b.definition AND ' : ''}p.proowner=b.proowner AND p.prosecdef=b.prosecdef
  AND p.proconfig IS NOT DISTINCT FROM b.proconfig
  AND (SELECT array_agg(x::text ORDER BY x::text) FROM unnest(p.proacl) x) IS NOT DISTINCT FROM b.acl`, label);

test('permanence release proofs for 20261021000990 are the same bytes in the reserve and the release packet', () => {
  for (const kind of ['catalog', 'functional', 'rollback', 'rollback-catalog']) {
    assert.equal(repoSql(`${RESERVE}-${kind}.sql`), repoSql(`${PROOFS}-${kind}.sql`), kind);
  }
});

test('suspension fence proofs hold, the reserve restores the 00007 and 00010 bodies exactly, and roll forward re-arms the fence', () => {
  const owner = randomUUID(), ws = randomUUID(), device = randomUUID(), principal = randomUUID(), run = randomUUID(), family = randomUUID();
  const fixture = `
INSERT INTO auth.users(id,aud,role,email) VALUES('${owner}','authenticated','authenticated','${owner}@example.test');
INSERT INTO swarm.users(user_id,display_name) VALUES('${owner}','Fence owner');
INSERT INTO swarm.workspaces(workspace_id,name,created_by) VALUES('${ws}','Fence','${owner}');
INSERT INTO swarm.memberships(workspace_id,user_id,role) VALUES('${ws}','${owner}','owner');
INSERT INTO swarm.devices(device_id,user_id,label) VALUES('${device}','${owner}','Mac mini');
INSERT INTO swarm.agent_principals(principal_id,workspace_id,owner_user_id,name) VALUES('${principal}','${ws}','${owner}','Paused agent');
INSERT INTO swarm.agent_runs(run_id,principal_id,device_id) VALUES('${run}','${principal}','${device}');
-- A standing family whose idle suspension was never resumed, so suspension_active is true.
INSERT INTO swarm.renewal_grants(renewal_grant_id,workspace_id,principal_id,run_id,kind,max_successors,successors_used,horizon_expires_at,bound_device_id,created_by,suspended_at)
  VALUES('${family}','${ws}','${principal}','${run}','standing',NULL,0,NULL,NULL,'${owner}',statement_timestamp());
CREATE TEMP TABLE before_suspension AS
  SELECT renewal_grant_id,suspended_at,resumed_at,resume_count FROM swarm.renewal_grants WHERE renewal_grant_id='${family}';
${dbAssert(`SELECT suspension_active FROM swarm.renewal_grants WHERE renewal_grant_id='${family}'`, 'fixture family is suspended')}`;
  const prepare = `SELECT swarm.prepare_renewal_grant('${family}','${device}')`;
  const untouched = dbAssert(`SELECT g.suspended_at=b.suspended_at AND g.resumed_at IS NOT DISTINCT FROM b.resumed_at
 AND g.resume_count=b.resume_count AND g.revoked_at IS NULL
 FROM swarm.renewal_grants g JOIN before_suspension b USING(renewal_grant_id)`, 'suspended_at and resumed_at untouched');

  runSql(`${fixture}
CREATE TEMP TABLE before_fence AS
  SELECT p.oid AS routine_oid, pg_get_functiondef(p.oid) AS definition, p.proowner, p.prosecdef, p.proconfig,
    (SELECT array_agg(x::text ORDER BY x::text) FROM unnest(p.proacl) x) AS acl
  FROM pg_proc p WHERE p.oid IN (${ROUTINES.map(routine => `'${routine.signature}'::regprocedure`).join(',')});
${dbAssert('SELECT count(*)=11 FROM before_fence', 'all eleven fenced routines recorded')}
${bodies(() => FENCE, 'carries the 00990 body')}
${dbAssert(`(${prepare})='renewal_grant_suspended'`, 'fence refuses a suspended standing family')}
${proof('catalog', true)}
${repoSql(`${PROOFS}-functional.sql`)}
-- rollback reserve
${repoSql(`${PROOFS}-rollback.sql`)}
${proof('rollback-catalog', true)}
${proof('catalog', false)}
${bodies(routine => routine.previous, 'restored to its previous body')}
${identity(false, 'owners, definer flags, search_path and grants survive the rollback')}
${dbAssert(`(${prepare}) IS NULL`, '00007 body lets a suspended standing family prepare')}
${untouched}
-- roll forward
${migrationStatements()}
${identity(true, 'all eleven routines identical after roll forward')}
${dbAssert(`(${prepare})='renewal_grant_suspended'`, 'fence refuses the suspended standing family again')}
${untouched}
${proof('catalog', true)}
`);
});
