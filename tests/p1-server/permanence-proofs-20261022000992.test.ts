/** 20261022000992 savepoint-safe signal creation guard: release proofs and the reserve that restores the xmin guards. CI/Docker only. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { dbAssert, refuses, repoSql, runSql } from '../support/admin-schema-db.js';

const VERSION = '20261022000992';
const GUARD = `${VERSION}_signal_savepoint_creation_guard.sql`;
const MIGRATION = `supabase/migrations/${GUARD}`;
const PROOFS = `deploy/release-proofs/permanence/${VERSION}`;
const RESERVE = `supabase/permanence-reserve/${VERSION}`;
const STAMP = 'swarm.stamp_signal_creation_xact()';
/** The two guards 00992 replaces, with the migration whose body the reserve restores. */
const GUARDS = [
  { signature: 'swarm.require_new_signal_for_recipient()', previous: '20260905000010_signal_recipients.sql' },
  { signature: 'swarm.require_new_signal_for_attachment()', previous: '20260901000010_signal_attachments.sql' },
];
const COLUMNS = "'creation_xact_id','creation_system_identifier'";
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

const acl = (column: string) => `(SELECT array_agg(x::text ORDER BY x::text) FROM unnest(${column}) x)`;
// The definition is deparsed from the snapshot's signature only: as a join clause the planner would
// evaluate pg_get_functiondef over every pg_proc row, and it errors on aggregates.
const routinesIdentical = (count: number, withBody: boolean, label: string) =>
  dbAssert(`SELECT count(*)=${count} FROM before_stamp b JOIN pg_proc p ON p.oid=to_regprocedure(b.signature)
 WHERE ${withBody ? 'pg_get_functiondef(to_regprocedure(b.signature))=b.definition AND ' : ''}p.proowner=b.proowner AND p.prosecdef=b.prosecdef
  AND p.proconfig IS NOT DISTINCT FROM b.proconfig AND ${acl('p.proacl')} IS NOT DISTINCT FROM b.acl`, label);

test('permanence release proofs for 20261022000992 are the same bytes in the reserve and the release packet', () => {
  for (const kind of ['catalog', 'functional', 'rollback', 'rollback-catalog']) {
    assert.equal(repoSql(`${RESERVE}-${kind}.sql`), repoSql(`${PROOFS}-${kind}.sql`), kind);
  }
});

test('creation guard proofs hold, the reserve restores the xmin guards and drops the stamps while keeping every signal, and roll forward re-stamps', () => {
  const owner = randomUUID(), ws = randomUUID();
  const [plain, savepoint, refused, legacy, fresh] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()] as const;
  const signal = (id: string) => `INSERT INTO swarm.signals(id,workspace_id,from_principal,from_kind,to_user_id,kind,body,until)
  VALUES('${id}','${ws}','${owner}','user','${owner}','note','permanence proof',clock_timestamp()+interval '1 hour')`;
  const recipient = (id: string, position = 0) =>
    `INSERT INTO swarm.signal_recipients(signal_id,workspace_id,recipient_user_id,position) VALUES('${id}','${ws}','${owner}',${position})`;
  /** A PL/pgSQL exception block is a savepoint: rows written inside it carry a child xid as xmin. */
  const inSavepoint = (statements: string, label: string) => `DO $savepoint$ BEGIN BEGIN ${statements};
  EXCEPTION WHEN SQLSTATE '55000' THEN RAISE EXCEPTION '${label}'; END; END $savepoint$;`;
  const stamped = (id: string, label: string) => dbAssert(`SELECT creation_xact_id=pg_current_xact_id()
 AND creation_system_identifier=(SELECT system_identifier FROM pg_control_system()) FROM swarm.signals WHERE id='${id}'`, label);
  const fixture = `
INSERT INTO auth.users(id,aud,role,email) VALUES('${owner}','authenticated','authenticated','${owner}@example.test');
INSERT INTO swarm.users(user_id,display_name) VALUES('${owner}','Signal owner');
INSERT INTO swarm.workspaces(workspace_id,name,created_by) VALUES('${ws}','Stamps','${owner}');
INSERT INTO swarm.memberships(workspace_id,user_id,role) VALUES('${ws}','${owner}','owner');`;

  runSql(`${fixture}
CREATE TEMP TABLE before_stamp AS
  SELECT p.oid::regprocedure::text AS signature, pg_get_functiondef(p.oid) AS definition, p.proowner, p.prosecdef, p.proconfig, ${acl('p.proacl')} AS acl
  FROM pg_proc p WHERE p.oid IN ('${STAMP}'::regprocedure,${GUARDS.map(guard => `'${guard.signature}'::regprocedure`).join(',')});
CREATE TEMP TABLE before_trigger AS
  SELECT pg_get_triggerdef(t.oid) AS definition, t.tgenabled FROM pg_trigger t
  WHERE t.tgrelid='swarm.signals'::regclass AND t.tgname='signals_stamp_creation_xact' AND NOT t.tgisinternal;
CREATE TEMP TABLE before_columns AS
  SELECT a.attname::text AS name, a.atttypid, a.attnotnull, a.atthasdef, col_description(a.attrelid,a.attnum) AS comment
  FROM pg_attribute a WHERE a.attrelid='swarm.signals'::regclass AND a.attname IN (${COLUMNS}) AND NOT a.attisdropped;
${dbAssert('SELECT count(*)=3 FROM before_stamp', 'stamp function and both guards recorded')}
${dbAssert('SELECT count(*)=1 FROM before_trigger', 'stamp trigger recorded')}
${dbAssert('SELECT count(*)=2 FROM before_columns', 'both stamp columns recorded')}
${[STAMP, ...GUARDS.map(guard => guard.signature)].map(signature =>
    dbAssert(`SELECT md5(prosrc)='${bodyMd5(GUARD, nameOf(signature))}' FROM pg_proc WHERE oid='${signature}'::regprocedure`, `${signature} carries the 00992 body`)).join('\n')}
-- data: a top-level signal is stamped, and a savepoint-created signal still admits its recipient (the gap 00992 closes)
${signal(plain)};
${stamped(plain, 'a new signal carries the top-level xid and this cluster identifier')}
${inSavepoint(`${signal(savepoint)}; ${recipient(savepoint)}`, 'savepoint-created signal refused its recipient after 20261022000992')}
${dbAssert(`SELECT count(*)=1 FROM swarm.signal_recipients WHERE signal_id='${savepoint}'`, 'savepoint recipient admitted')}
${proof('catalog', true)}
${repoSql(`${PROOFS}-functional.sql`)}
-- rollback reserve
${repoSql(`${PROOFS}-rollback.sql`)}
${proof('rollback-catalog', true)}
${proof('catalog', false)}
${GUARDS.map(guard => dbAssert(`SELECT md5(prosrc)='${bodyMd5(guard.previous, nameOf(guard.signature))}' FROM pg_proc WHERE oid='${guard.signature}'::regprocedure`,
    `${guard.signature} restored to its ${guard.previous.slice(0, 14)} body`)).join('\n')}
${routinesIdentical(2, false, 'guard owners, search_path and grants survive the rollback')}
${dbAssert(`SELECT to_regprocedure('${STAMP}') IS NULL`, 'stamp function dropped')}
${dbAssert(`SELECT count(*)=0 FROM pg_trigger WHERE tgrelid='swarm.signals'::regclass AND tgname='signals_stamp_creation_xact'`, 'stamp trigger dropped')}
${dbAssert(`SELECT count(*)=0 FROM pg_attribute WHERE attrelid='swarm.signals'::regclass AND attname IN (${COLUMNS}) AND NOT attisdropped`, 'stamp columns dropped')}
${dbAssert(`SELECT count(*)=2 FROM swarm.signals WHERE id IN ('${plain}','${savepoint}')`, 'signal rows kept')}
${dbAssert(`SELECT count(*)=1 FROM swarm.signal_recipients WHERE signal_id='${savepoint}'`, 'recipient row kept')}
-- The xmin guard is back: a savepoint-created signal refuses its recipient, a top-level one admits it.
${refuses(`${signal(refused)}; ${recipient(refused)}`, '55000')}
${signal(legacy)};
${recipient(legacy)};
-- roll forward
${repoSql(MIGRATION)}
${routinesIdentical(3, true, 'stamp function and guards identical after roll forward')}
${dbAssert(`SELECT count(*)=1 FROM before_trigger b JOIN pg_trigger t ON t.tgrelid='swarm.signals'::regclass AND t.tgname='signals_stamp_creation_xact'
 WHERE pg_get_triggerdef(t.oid)=b.definition AND t.tgenabled=b.tgenabled`, 'stamp trigger identical after roll forward')}
${dbAssert(`SELECT count(*)=2 FROM before_columns b JOIN pg_attribute a ON a.attrelid='swarm.signals'::regclass AND a.attname=b.name AND NOT a.attisdropped
 WHERE a.atttypid=b.atttypid AND a.attnotnull=b.attnotnull AND a.atthasdef=b.atthasdef AND col_description(a.attrelid,a.attnum)=b.comment`,
    'stamp columns identical after roll forward')}
${dbAssert(`SELECT count(*)=3 FROM swarm.signals WHERE id IN ('${plain}','${savepoint}','${legacy}') AND creation_xact_id IS NULL AND creation_system_identifier IS NULL`,
    'rows from before roll forward carry no stamp')}
${refuses(recipient(legacy, 1), '55000')}
${signal(fresh)};
${stamped(fresh, 'a signal created after roll forward is stamped again')}
${proof('catalog', true)}
`);
});
