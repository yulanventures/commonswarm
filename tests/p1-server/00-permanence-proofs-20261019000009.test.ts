/** 20261019000009 hosted snapshot null compat: release proofs and rollback reserve. CI/Docker only. */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { dbAssert, repoSql, runSql } from '../support/admin-schema-db.js';

const VERSION = '20261019000009';
const MIGRATION = `supabase/migrations/${VERSION}_hosted_snapshot_null_compat.sql`;
const PROOFS = `deploy/release-proofs/permanence/${VERSION}`;
const RESERVE = `supabase/permanence-reserve/${VERSION}`;
const MIGRATIONS = new URL('../../supabase/migrations/', import.meta.url);

const AUDIT = 'swarm.audit_household_hosted_restriction()';
const RESTORED = [{ signature: AUDIT, name: 'swarm.audit_household_hosted_restriction', previous: '20261019000006_hosted_owner_content_access.sql' }];

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

const auditTrigger = `EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='swarm.household_hosted_content_restrictions'::regclass AND tgname='household_hosted_restriction_audit' AND NOT tgisinternal AND tgenabled='O' AND tgfoid='${AUDIT}'::regprocedure)`;
const tolerant = `(SELECT prosrc LIKE '%renewal_grant_id%' FROM pg_proc WHERE oid='${AUDIT}'::regprocedure)`;

test('00009 release proofs are the same bytes in the reserve and the release packet', () => {
  for (const kind of ['catalog', 'functional', 'rollback', 'rollback-catalog']) {
    assert.equal(repoSql(`${RESERVE}-${kind}.sql`), repoSql(`${PROOFS}-${kind}.sql`), kind);
  }
});

test('00009 reserve restores the audit trigger function from its last definer before 00009', () => {
  for (const entry of RESTORED) assert.equal(previousDefiner(entry.name), entry.previous, entry.name);
});

test('00009 catalog, functional and rollback proofs hold, the reserve restores the 00006 body and the migration reapplies', () => {
  // The clone already carries the 00009 body; no later migration replaces it.
  runSql(`
${snapshot('installed', [AUDIT])}
${dbAssert(`${auditTrigger} AND ${tolerant}`, 'tolerant audit body bound before rollback')}
${proof('catalog', true)}
${proof('rollback-catalog', false)}
${repoSql(`${PROOFS}-functional.sql`)}
-- rollback reserve
${repoSql(`${PROOFS}-rollback.sql`)}
${dbAssert(`${auditTrigger} AND NOT ${tolerant}`, 'strict 00006 audit body bound after rollback')}
${proof('rollback-catalog', true)}
${proof('catalog', false)}
-- The restored body is byte-exact: replacing it with the previous definer's
-- own statement changes nothing.
${snapshot('restored', [AUDIT])}
${RESTORED.map(entry => definition(entry.previous, entry.name)).join('\n')}
${unchanged('restored', [AUDIT], 'restored audit body equals its 00006 definer')}
-- roll forward again
${repoSql(MIGRATION)}
${unchanged('installed', [AUDIT], 'reapplied 00009 matches the original installation')}
${proof('catalog', true)}
${proof('rollback-catalog', false)}
`);
});
