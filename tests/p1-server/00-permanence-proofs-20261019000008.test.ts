/** 20261019000008 local auth inactive parent closure: release proofs and rollback reserve. CI/Docker only. */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { dbAssert, refuses, repoSql, runSql } from '../support/admin-schema-db.js';

const VERSION = '20261019000008';
const MIGRATION = `supabase/migrations/${VERSION}_local_auth_inactive_parent_closure.sql`;
const PROOFS = `deploy/release-proofs/permanence/${VERSION}`;
const RESERVE = `supabase/permanence-reserve/${VERSION}`;
const MIGRATIONS = new URL('../../supabase/migrations/', import.meta.url);

const CASCADE = 'swarm.renewal_grants_revoke_cascade()';
const RESIDUAL = 'swarm.revoke_local_residual_tokens(uuid,uuid,text,uuid)';
const RESTORED = [{ signature: CASCADE, name: 'swarm.renewal_grants_revoke_cascade', previous: '20260728000002_worker_token_renewal.sql' }];
const ALL = [CASCADE, RESIDUAL];

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

const cascadeTrigger = `EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='swarm.renewal_grants'::regclass AND tgname='renewal_grants_revoke_cascade' AND NOT tgisinternal AND tgenabled='O' AND tgfoid='${CASCADE}'::regprocedure)`;

test('00008 release proofs are the same bytes in the reserve and the release packet', () => {
  for (const kind of ['catalog', 'functional', 'rollback', 'rollback-catalog']) {
    assert.equal(repoSql(`${RESERVE}-${kind}.sql`), repoSql(`${PROOFS}-${kind}.sql`), kind);
  }
});

test('00008 reserve restores the cascade from its last definer before 00008', () => {
  for (const entry of RESTORED) assert.equal(previousDefiner(entry.name), entry.previous, entry.name);
});

test('00008 catalog, functional and rollback proofs hold, the reserve restores the previous cascade and the migration reapplies', () => {
  // The clone already carries the 00008 bodies; roll back newer migrations that replace them first.
  runSql(`
${repoSql('deploy/release-proofs/agents/20261028000003-rollback.sql')}
${repoSql('deploy/release-proofs/agents/20261028000002-rollback.sql')}
${snapshot('installed', ALL)}
${dbAssert(`${cascadeTrigger} AND (SELECT prosecdef FROM pg_proc WHERE oid='${CASCADE}'::regprocedure)`, 'cascade is bound and runs as definer before rollback')}
${proof('catalog', true)}
${proof('rollback-catalog', false)}
${repoSql(`${PROOFS}-functional.sql`)}
${refuses(`PERFORM ${RESIDUAL.replace('(uuid,uuid,text,uuid)', '(NULL,NULL,NULL,NULL)')}`, '22023')}
-- rollback reserve
${repoSql(`${PROOFS}-rollback.sql`)}
${dbAssert(`to_regprocedure('${RESIDUAL}') IS NULL`, 'residual revoke API dropped')}
${dbAssert(`${cascadeTrigger} AND NOT (SELECT prosecdef FROM pg_proc WHERE oid='${CASCADE}'::regprocedure)`, 'cascade still bound and back to invoker rights')}
${proof('rollback-catalog', true)}
${proof('catalog', false)}
-- The restored body is byte-exact: replacing it with the previous definer's
-- own statement changes nothing.
${snapshot('restored', RESTORED.map(entry => entry.signature))}
${RESTORED.map(entry => definition(entry.previous, entry.name)).join('\n')}
${unchanged('restored', RESTORED.map(entry => entry.signature), 'restored cascade equals its previous definer')}
-- roll forward again
${repoSql(MIGRATION)}
${unchanged('installed', ALL, 'reapplied 00008 matches the original installation')}
${proof('catalog', true)}
${proof('rollback-catalog', false)}
`);
});
