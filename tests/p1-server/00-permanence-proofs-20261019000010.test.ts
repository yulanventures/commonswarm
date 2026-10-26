/** 20261019000010 local permanence read models: release proofs and the reserve that restores 20261006000002, 20261019000007 and 20260928000002. CI/Docker only. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { dbAssert, repoSql, runSql } from '../support/admin-schema-db.js';

const VERSION = '20261019000010';
const READ_MODELS = `${VERSION}_local_permanence_read_models.sql`;
const MIGRATION = `supabase/migrations/${READ_MODELS}`;
const PROOFS = `deploy/release-proofs/permanence/${VERSION}`;
const RESERVE = `supabase/permanence-reserve/${VERSION}`;
/** Production rolls 20261021000990 back before 00010; that reserve puts the 00010 read-model bodies back. */
const FENCE_ROLLBACK = 'deploy/release-proofs/permanence/20261021000990-rollback.sql';
const HOME_OVERVIEW = '20261006000002_home_overview.sql';
const LOCK_ORDER = '20261019000007_local_auth_lock_order.sql';
const HOSTED_AUTHORITY = '20260928000002_hm_hosted_authority.sql';
const VIEW = 'swarm_read.hosted_mcp_connections';
const ROUTINES = ['swarm_read.local_connection_selection(uuid,uuid,uuid)', 'swarm_read.home_overview()', 'swarm_read.renewal_grant_roster(uuid)'];
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

/** The single CREATE VIEW statement for `name` in a migration file. */
function viewStatement(file: string, name: string): string {
  const text = repoSql(`supabase/migrations/${file}`);
  const heads = [...text.matchAll(new RegExp(`^CREATE (?:OR REPLACE )?VIEW ${name.replaceAll('.', '\\.')}\\b`, 'gm'))];
  assert.equal(heads.length, 1, `${name} is defined once in ${file}`);
  const start = heads[0]!.index!, end = text.indexOf(';', start);
  assert.ok(end > start, `${name} view statement closes in ${file}`);
  return text.slice(start, end + 1);
}

const acl = (column: string) => `(SELECT array_agg(x::text ORDER BY x::text) FROM unnest(${column}) x)`;
const columns = 'SELECT array_agg(a.attname::text ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped';
// The definition is deparsed from the snapshot's signature only: as a join clause the planner would
// evaluate pg_get_functiondef over every pg_proc row, and it errors on aggregates.
const routinesIdentical = (count: number, withBody: boolean, label: string) =>
  dbAssert(`SELECT count(*)=${count} FROM before_read_models b JOIN pg_proc p ON p.oid=to_regprocedure(b.signature)
 WHERE ${withBody ? 'pg_get_functiondef(to_regprocedure(b.signature))=b.definition AND ' : ''}p.proowner=b.proowner AND p.prosecdef=b.prosecdef
  AND p.proconfig IS NOT DISTINCT FROM b.proconfig AND ${acl('p.proacl')} IS NOT DISTINCT FROM b.acl`, label);

test('permanence release proofs for 20261019000010 are the same bytes in the reserve and the release packet', () => {
  for (const kind of ['catalog', 'functional', 'rollback', 'rollback-catalog']) {
    assert.equal(repoSql(`${RESERVE}-${kind}.sql`), repoSql(`${PROOFS}-${kind}.sql`), kind);
  }
});

test('read model proofs hold, the reserve restores the previous projections and the nine-column view exactly, and roll forward restores 00010', () => {
  runSql(`
-- The clone carries the 20261021000990 bodies of the three read models, so 00010 is not the installed state yet.
${proof('catalog', false)}
${repoSql(FENCE_ROLLBACK)}
CREATE TEMP TABLE before_read_models AS
  SELECT p.oid::regprocedure::text AS signature, pg_get_functiondef(p.oid) AS definition, p.proowner, p.prosecdef, p.proconfig,
    ${acl('p.proacl')} AS acl
  FROM pg_proc p WHERE p.oid IN (${ROUTINES.map(signature => `'${signature}'::regprocedure`).join(',')});
CREATE TEMP TABLE before_view AS
  SELECT pg_get_viewdef(c.oid) AS definition, c.relowner, c.reloptions, ${acl('c.relacl')} AS acl, (${columns}) AS columns
  FROM pg_class c WHERE c.oid='${VIEW}'::regclass;
${dbAssert('SELECT count(*)=3 FROM before_read_models', 'three read model routines recorded')}
${dbAssert('SELECT count(*)=1 AND bool_and(cardinality(columns)=11) FROM before_view', 'the eleven-column view recorded')}
${ROUTINES.map(signature => dbAssert(`SELECT md5(prosrc)='${bodyMd5(READ_MODELS, nameOf(signature))}' FROM pg_proc WHERE oid='${signature}'::regprocedure`,
    `${signature} carries the 00010 body`)).join('\n')}
${proof('catalog', true)}
${repoSql(`${PROOFS}-functional.sql`)}
-- rollback reserve
${repoSql(`${PROOFS}-rollback.sql`)}
${proof('rollback-catalog', true)}
${proof('catalog', false)}
${dbAssert(`SELECT to_regprocedure('swarm_read.local_connection_selection(uuid,uuid,uuid)') IS NULL`, 'selection helper dropped')}
${dbAssert(`SELECT md5(prosrc)='${bodyMd5(HOME_OVERVIEW, 'swarm_read.home_overview')}' FROM pg_proc WHERE oid='swarm_read.home_overview()'::regprocedure`,
    'home_overview restored to its 20261006000002 body')}
${dbAssert(`SELECT md5(prosrc)='${bodyMd5(LOCK_ORDER, 'swarm_read.renewal_grant_roster')}' FROM pg_proc WHERE oid='swarm_read.renewal_grant_roster(uuid)'::regprocedure`,
    'roster restored to its 20261019000007 body')}
${routinesIdentical(2, false, 'owners, definer flags, search_path and grants survive the rollback')}
-- The 20260928000002 body under a scratch name, only to compare deparsed definitions.
${viewStatement(HOSTED_AUTHORITY, VIEW).replace(VIEW, `${VIEW}_v1_expected`)}
${dbAssert(`SELECT pg_get_viewdef('${VIEW}'::regclass)=pg_get_viewdef('${VIEW}_v1_expected'::regclass)`, 'view restored to the 20260928000002 body')}
DROP VIEW ${VIEW}_v1_expected;
${dbAssert(`SELECT c.relowner=b.relowner AND c.reloptions=b.reloptions AND ${acl('c.relacl')}=b.acl
 AND (${columns})=b.columns[1:9] AND b.columns[10:11]=ARRAY['connection_expires_at','connection_expired_at']
 FROM pg_class c, before_view b WHERE c.oid='${VIEW}'::regclass`, 'view owner, options, grants and its nine original columns restored')}
-- roll forward
${repoSql(MIGRATION)}
${routinesIdentical(3, true, 'read model routines identical after roll forward')}
${dbAssert(`SELECT pg_get_viewdef(c.oid)=b.definition AND c.relowner=b.relowner AND c.reloptions=b.reloptions AND ${acl('c.relacl')}=b.acl
 AND (${columns})=b.columns FROM pg_class c, before_view b WHERE c.oid='${VIEW}'::regclass`, 'view identical after roll forward')}
${proof('catalog', true)}
`);
});
