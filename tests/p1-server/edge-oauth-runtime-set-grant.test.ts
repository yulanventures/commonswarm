/** Production-shaped edge login: SET LOCAL ROLE commonswarm_oauth_runtime. Docker/server suite only. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import postgres from 'postgres';
import { databaseContainer, dbAssert, emptyApplicationSchema, localClusterAdminUrl, openIssuanceForTest, repoSql, runSql } from '../support/admin-schema-db.js';
import { assertSqlProcessResult } from '../support/admin-schema-process.js';

test('edge-oauth-runtime-set-grant / edge-membership: catalog accepts exact f/f/t and refuses ADMIN drift', () => {
  runSql(`
DO $edge$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='commonswarm_edge') THEN
    CREATE ROLE commonswarm_edge LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
      INHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
END $edge$;
GRANT swarm_command, swarm_read, swarm_capability TO commonswarm_edge;
${dbAssert(`SELECT NOT EXISTS(SELECT 1 FROM pg_auth_members
  WHERE roleid='commonswarm_oauth_runtime'::regrole AND member='commonswarm_edge'::regrole)`,
  'fixture edge starts without oauth-runtime membership')}
${repoSql('deploy/release-proofs/item-ai/edge-oauth-runtime-catalog.sql')}
SELECT :'catalog_ok'::boolean=false AS proof_pass
\\gset
\\if :proof_pass
\\else
DO $fail$ BEGIN RAISE EXCEPTION 'catalog should fail before the SET grant'; END $fail$;
\\endif
GRANT commonswarm_oauth_runtime TO commonswarm_edge WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
${repoSql('deploy/release-proofs/item-ai/edge-oauth-runtime-catalog.sql')}
SELECT :'catalog_ok'::boolean=true AS granted_ok
\\gset
\\if :granted_ok
\\else
DO $fail$ BEGIN RAISE EXCEPTION 'catalog should pass after the exact SET grant'; END $fail$;
\\endif
SAVEPOINT drift;
GRANT commonswarm_oauth_runtime TO commonswarm_edge WITH ADMIN TRUE, INHERIT FALSE, SET TRUE;
${repoSql('deploy/release-proofs/item-ai/edge-oauth-runtime-catalog.sql')}
SELECT :'catalog_ok'::boolean=false AS drift_ok
\\gset
\\if :drift_ok
\\else
DO $fail$ BEGIN RAISE EXCEPTION 'catalog should refuse ADMIN true drift'; END $fail$;
\\endif
ROLLBACK TO SAVEPOINT drift;
`);
});

/** Execute the release heredoc inside runSql's rollback, without its outer COMMIT. */
function extractedBody(kind: 'grant' | 'revoke'): string {
  const marker = new RegExp(`cat >"\\$PROOF_DIR/edge-oauth-runtime-${kind}\\.sql" <<'SQL'\\n([\\s\\S]*?)\\nSQL\\n`);
  const sql = marker.exec(repoSql('docs/evidence/2026-10-03-admin-issuance-release/RELEASE.md'))?.[1];
  assert.ok(sql, `${kind} SQL heredoc markers`);
  assert.match(sql, /^BEGIN;/);
  assert.match(sql, /COMMIT;$/);
  return sql.replace(/^BEGIN;/, '').replace(/\nCOMMIT;$/, '');
}

const edgeFixture = `
DO $edge$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='commonswarm_edge') THEN
    CREATE ROLE commonswarm_edge LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
      INHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
END $edge$;
`;

const exactGrant = 'GRANT commonswarm_oauth_runtime TO commonswarm_edge WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;';
const membership = `SELECT count(*)=1 AND bool_and(NOT admin_option AND NOT inherit_option AND set_option)
  FROM pg_auth_members WHERE roleid='commonswarm_oauth_runtime'::regrole AND member='commonswarm_edge'::regrole`;
const grantor = `c1grantg${randomUUID().replaceAll('-', '')}`;
const grantRefusals: Array<[string, string, string]> = [
  ['duplicate grantors', `${exactGrant}
CREATE ROLE ${grantor} NOLOGIN NOINHERIT CREATEROLE NOSUPERUSER NOBYPASSRLS;
GRANT commonswarm_oauth_runtime TO ${grantor} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
SET LOCAL ROLE ${grantor};
${exactGrant}
RESET ROLE;
${dbAssert(`SELECT count(*)=2 FROM pg_auth_members WHERE roleid='commonswarm_oauth_runtime'::regrole AND member='commonswarm_edge'::regrole`, 'two grantors before duplicate refusal')}`, 'duplicate commonswarm_edge oauth-runtime membership'],
  ...['ADMIN TRUE, INHERIT FALSE, SET TRUE', 'ADMIN FALSE, INHERIT TRUE, SET TRUE', 'ADMIN FALSE, INHERIT FALSE, SET FALSE']
    .map((options): [string, string, string] => [`options ${options}`,
      `GRANT commonswarm_oauth_runtime TO commonswarm_edge WITH ${options};`,
      'existing membership options are not ADMIN false/INHERIT false/SET true']),
  ...['SUPERUSER', 'BYPASSRLS', 'CREATEROLE', 'CREATEDB']
    .map((attribute): [string, string, string] => [attribute,
      `ALTER ROLE commonswarm_oauth_runtime ${attribute};`, 'unsafe commonswarm_oauth_runtime role attributes']),
  ['runtime membership', 'GRANT swarm_read TO commonswarm_oauth_runtime;', 'commonswarm_oauth_runtime must hold no role memberships'],
  ['open issuance', `${openIssuanceForTest}
${dbAssert('SELECT admin_issuance_enabled FROM commonswarm_oauth.admin_cutover_state WHERE singleton', 'issuance is open before grant refusal')}`, 'issuance must be closed'],
];

// Separate rollback transactions and test results keep one failing setup or refusal
// from hiding another. Each negative control follows a real successful grant.
for (const [label, setup, message] of grantRefusals) {
  test(`edge-oauth-runtime-set-grant / drift-refusal: extracted grant refuses ${label}`, () => {
    const grant = extractedBody('grant');
    runSql(`
${edgeFixture}
${dbAssert(`SELECT NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE roleid='commonswarm_oauth_runtime'::regrole AND member='commonswarm_edge'::regrole)`, 'edge starts without runtime grant')}
SAVEPOINT safe;
${grant}
${dbAssert(membership, 'positive control creates one exact f/f/t row')}
ROLLBACK TO SAVEPOINT safe;
${setup}
DO $deny$ BEGIN
  BEGIN
    ${grant}
    RAISE EXCEPTION 'negative control admitted' USING ERRCODE='ZX001';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    PERFORM set_config('schema_test.grant_refusal', SQLERRM, true);
  END;
END $deny$;
${dbAssert(`current_setting('schema_test.grant_refusal', true) = '${message}'`, 'extracted grant reached the intended refusal')}
`);
  });
}

test('edge-oauth-runtime-set-grant / idempotency: extracted exact-row retry preserves every catalog field', () => {
  const grant = extractedBody('grant');
  runSql(`
${edgeFixture}
${dbAssert(`SELECT NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE roleid='commonswarm_oauth_runtime'::regrole AND member='commonswarm_edge'::regrole)`, 'edge starts without runtime grant')}
${grant}
${dbAssert(membership, 'extracted grant creates one exact f/f/t row')}
CREATE TEMP TABLE exact_membership_before AS SELECT * FROM pg_auth_members
  WHERE roleid='commonswarm_oauth_runtime'::regrole AND member='commonswarm_edge'::regrole;
${grant}
${dbAssert(membership, 'exact-row retry leaves one f/f/t row')}
${dbAssert(`SELECT NOT EXISTS(
  (SELECT * FROM exact_membership_before EXCEPT SELECT * FROM pg_auth_members WHERE roleid='commonswarm_oauth_runtime'::regrole AND member='commonswarm_edge'::regrole)
  UNION ALL
  (SELECT * FROM pg_auth_members WHERE roleid='commonswarm_oauth_runtime'::regrole AND member='commonswarm_edge'::regrole EXCEPT SELECT * FROM exact_membership_before))`, 'exact-row retry leaves every catalog field unchanged')}
`);
});

test('edge-oauth-runtime-set-grant / edge-login-switching commit-rollback-reset: application login SET LOCAL ROLE fails without the grant and resets after COMMIT and ROLLBACK', async () => {
  const status = JSON.parse(execFileSync('supabase', ['status', '-o', 'json'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  })) as { DB_URL: string };
  assert.ok(status.DB_URL);
  const adminUrl = localClusterAdminUrl(status.DB_URL);
  const admin = postgres(adminUrl, { prepare: false, max: 1 });
  const login = `c1edge${randomUUID().replaceAll('-', '')}`;
  const password = randomUUID();
  let edge: postgres.Sql | undefined;
  try {
    await admin.unsafe(`
      CREATE ROLE ${login} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
        INHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${password}';
      GRANT swarm_command, swarm_read, swarm_capability TO ${login};
    `);
    const url = new URL(status.DB_URL);
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'local stack only');
    url.username = login;
    url.password = password;
    edge = postgres(url.toString(), { prepare: false, max: 1, onnotice: () => undefined });
    await assert.rejects(
      () => edge!.begin(async tx => {
        await tx.unsafe('SET LOCAL ROLE commonswarm_oauth_runtime');
        await tx`SELECT current_user`;
      }),
      (error: { code?: string }) => error.code === '42501',
    );
    const [without] = await edge`SELECT current_user AS u`;
    assert.equal(without?.u, login);
    await admin.unsafe(
      `GRANT commonswarm_oauth_runtime TO ${login} WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`,
    );
    await edge.begin(async tx => {
      const [before] = await tx<{ u: string }[]>`SELECT current_user AS u`;
      assert.equal(before?.u, login);
      await tx.unsafe('SET LOCAL ROLE commonswarm_oauth_runtime');
      const [during] = await tx<{ u: string }[]>`SELECT current_user AS u`;
      assert.equal(during?.u, 'commonswarm_oauth_runtime');
    });
    const [afterCommit] = await edge`SELECT current_user AS u`;
    assert.equal(afterCommit?.u, login);
    try {
      await edge.begin(async tx => {
        await tx.unsafe('SET LOCAL ROLE commonswarm_oauth_runtime');
        const [during] = await tx<{ u: string }[]>`SELECT current_user AS u`;
        assert.equal(during?.u, 'commonswarm_oauth_runtime');
        throw Object.assign(new Error('rollback-control'), { code: 'ZXROL' });
      });
    } catch (error) {
      assert.equal((error as { code?: string }).code, 'ZXROL');
    }
    const [afterRollback] = await edge`SELECT current_user AS u`;
    assert.equal(afterRollback?.u, login);
  } finally {
    if (edge) await edge.end();
    await admin.unsafe(`DROP ROLE IF EXISTS ${login}`);
    await admin.end();
  }
});

test('edge-oauth-runtime-set-grant / revoke-all-grantors: extracted SQL revokes every grantor and leaves issuer membership unchanged', () => {
  const revokeBody = extractedBody('revoke');
  const grantor = `c1revokeg${randomUUID().replaceAll('-', '')}`;
  const sql = `
DO $edge$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='commonswarm_edge') THEN
    CREATE ROLE commonswarm_edge LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
      INHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
END $edge$;
${dbAssert(`SELECT NOT EXISTS(SELECT 1 FROM pg_auth_members
  WHERE roleid='commonswarm_oauth_runtime'::regrole AND member='commonswarm_edge'::regrole)`,
  'fixture edge starts without oauth-runtime membership')}
SELECT set_config('schema_test.issuer_memberships', coalesce((
  SELECT string_agg(parent.rolname||','||grantor.rolname||','||m.admin_option||','||m.inherit_option||','||m.set_option, E'\\n'
    ORDER BY parent.rolname, grantor.rolname)
  FROM pg_auth_members m JOIN pg_roles parent ON parent.oid=m.roleid JOIN pg_roles grantor ON grantor.oid=m.grantor
  WHERE m.member='commonswarm_admin_issuer'::regrole), ''), true);
CREATE ROLE ${grantor} NOLOGIN NOINHERIT CREATEROLE NOSUPERUSER NOBYPASSRLS;
GRANT commonswarm_oauth_runtime TO ${grantor} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
GRANT commonswarm_oauth_runtime TO commonswarm_edge WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
SET LOCAL ROLE ${grantor};
GRANT commonswarm_oauth_runtime TO commonswarm_edge WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
RESET ROLE;
${dbAssert(`SELECT count(*)=2 FROM pg_auth_members
  WHERE roleid='commonswarm_oauth_runtime'::regrole AND member='commonswarm_edge'::regrole`,
  'positive control: two grantors before revoke')}
\\echo revoke-stdout-start
${revokeBody}
\\echo revoke-stdout-end
${dbAssert(`SELECT count(*)=0 FROM pg_auth_members
  WHERE roleid='commonswarm_oauth_runtime'::regrole AND member='commonswarm_edge'::regrole`,
  'zero rows after per-grantor revoke')}
${dbAssert(`current_setting('schema_test.issuer_memberships') = coalesce((
  SELECT string_agg(parent.rolname||','||grantor.rolname||','||m.admin_option||','||m.inherit_option||','||m.set_option, E'\\n'
    ORDER BY parent.rolname, grantor.rolname)
  FROM pg_auth_members m JOIN pg_roles parent ON parent.oid=m.roleid JOIN pg_roles grantor ON grantor.oid=m.grantor
  WHERE m.member='commonswarm_admin_issuer'::regrole), '')`,
  'issuer membership unchanged')}
${dbAssert(`SELECT EXISTS(SELECT 1 FROM pg_auth_members
  WHERE roleid='commonswarm_oauth_runtime'::regrole AND member='${grantor}'::regrole AND admin_option)`,
  'control grantor ADMIN membership unchanged')}
`;
  const result = spawnSync('docker', ['exec', '-i', databaseContainer(), 'psql', '-X', '-Atq',
    '-U', 'supabase_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1',
    '-v', 'VERBOSITY=verbose', '-v', 'SHOW_CONTEXT=never', '-f', '/dev/stdin'], {
    input: `BEGIN;\n${emptyApplicationSchema()}\n${sql}\nROLLBACK;\n`,
    encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024,
  });
  assertSqlProcessResult(result);
  const output = /(?:^|\n)revoke-stdout-start\n([\s\S]*?)revoke-stdout-end(?:\n|$)/.exec(result.stdout)?.[1];
  assert.ok(output, 'stdout contains the extracted revoke output');
  assert.deepEqual(output.trim().split('\n').sort(), [grantor, 'supabase_admin'].sort(),
    'revoke SQL stdout lists both grantors exactly once');
});
