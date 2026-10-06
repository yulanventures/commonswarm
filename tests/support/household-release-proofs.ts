import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

// The release assignment's ordered set. One inventory for both proof consumers.
const groups = [
  ['household-storage', 'household-storage', ['20261004000001', '20261004000002', '20261004000003', '20261004000004', '20261004000005']],
  ['household-invites', 'household-invite', ['20261004000006']],
  ['hosted-name-reclaim', 'hosted-name-reclaim', ['20261004000010']],
  ['household-approval', 'household-approval', ['20261004000015']],
  ['household-member-removal', 'household-member-removal', ['20261005000001']],
  ['household-todo', 'household-todo', ['20261006000001']],
  ['home-overview', 'home-overview', ['20261006000002']],
] as const;
export const releaseProofs = groups.flatMap(([folder, reserve, versions]) => versions.map(version => ({
  version, release: `deploy/release-proofs/${folder}/${version}`, reserve: `supabase/${reserve}-reserve/${version}`,
})));
export function proofSql(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
}
export function migrationSql(version: string): string {
  const names = readdirSync(new URL('../../supabase/migrations/', import.meta.url)).filter(name => name.startsWith(`${version}_`) && name.endsWith('.sql'));
  assert.equal(names.length, 1, `resolve exactly one migration for ${version}`);
  return proofSql(`supabase/migrations/${names[0]}`);
}

// Lexical safety guard, not a SQL parser. Inspect dollar bodies and SQL literals
// too: a DO block must not conceal dynamic writes from the read-only contract.
function withoutComments(sql: string): string {
  return sql.replace(/'(?:''|[^'])*'|\/\*[\s\S]*?\*\/|--[^\n]*/g, match =>
    match.startsWith("'") ? match : ' '.repeat(match.length));
}
export function catalogProblems(sql: string): string[] {
  const clean = withoutComments(sql);
  const problems: string[] = [];
  if ((clean.match(/\bAS\s+catalog_ok\b/gi) ?? []).length !== 1 || !/\\gset\s*$/.test(clean)
    || !/\bAS\s+catalog_ok\s*;?\s*\\gset\s*$/i.test(clean)) problems.push('catalog Boolean/gset shape');
  // Stronger than accepting CASE-protected casts: all object resolution in
  // these artifacts uses nullable OIDs, so none needs a throwing text lookup.
  const objectLiteral = "'(?:(?:swarm|swarm_read|supabase[a-z0-9_]*)\\.[^']*|swarm|swarm_read|supabase|supabase_migrations)'";
  const objectType = '(?:pg_catalog\\.)?reg(?:class|procedure|proc|type)\\b';
  const directCast = new RegExp(`${objectLiteral}\\s*::\\s*${objectType}`, 'i');
  const castCall = new RegExp(`\\bCAST\\s*\\(\\s*${objectLiteral}\\s+AS\\s+${objectType}`, 'i');
  if (directCast.test(clean) || castCall.test(clean)) problems.push('throwing object cast');
  const privilege = new RegExp(`has_(?:table|function|column|schema|type|sequence)_privilege\\s*\\(\\s*(?:[^,()]+,\\s*${objectLiteral}|${objectLiteral}\\s*,\\s*')`, 'i');
  if (privilege.test(clean)) problems.push('throwing privilege lookup');
  return problems;
}
export function functionalProblems(sql: string): string[] {
  const clean = withoutComments(sql);
  const forbidden = /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|DROP|GRANT|REVOKE|COPY)\b/i;
  const literals = [...clean.matchAll(/'(?:''|[^'])*'/g)].map(match => match[0].slice(1, -1).replaceAll("''", "'"));
  const executable = clean.replace(/'(?:''|[^'])*'/g, ' literal ');
  const problems: string[] = [];
  if (forbidden.test(executable)) problems.push('write statement');
  if (literals.some(literal => /^\s*(?:INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|DROP|GRANT|REVOKE|COPY)\b\s+\S/i.test(literal))) problems.push('dynamic write statement');
  if (/set_config\s*\([^;]*,\s*false\s*\)/i.test(clean)) problems.push('session configuration escapes transaction');
  return problems;
}
