/** Production-shaped edge login: SET LOCAL ROLE commonswarm_oauth_runtime. Docker/server suite only. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import postgres from 'postgres';
import { dbAssert, localClusterAdminUrl, repoSql, runSql } from '../support/admin-schema-db.js';

test('edge-oauth-runtime-set-grant / edge-membership idempotency drift-refusal: catalog accepts exact f/f/t and refuses drift', () => {
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
REVOKE commonswarm_oauth_runtime FROM commonswarm_edge;
GRANT commonswarm_oauth_runtime TO commonswarm_edge WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
${repoSql('deploy/release-proofs/item-ai/edge-oauth-runtime-catalog.sql')}
SELECT :'catalog_ok'::boolean=true AS idempotent_ok
\\gset
\\if :idempotent_ok
\\else
DO $fail$ BEGIN RAISE EXCEPTION 'exact re-grant remains catalog-true'; END $fail$;
\\endif
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
  const extracted = /cat >"\$PROOF_DIR\/edge-oauth-runtime-revoke\.sql" <<'SQL'\n([\s\S]*?)\nSQL\n/.exec(
    repoSql('docs/evidence/2026-10-03-admin-issuance-release/RELEASE.md'),
  )?.[1];
  assert.ok(extracted, 'revoke SQL heredoc markers');
  assert.match(extracted, /^BEGIN;/);
  assert.match(extracted, /COMMIT;$/);
  // runSql already opens a rolled-back transaction; the extracted COMMIT would persist it.
  const revokeBody = extracted.replace(/^BEGIN;/, '').replace(/\nCOMMIT;$/, '');
  const grantor = `c1revokeg${randomUUID().replaceAll('-', '')}`;
  runSql(`
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
${dbAssert(`(SELECT array_agg(grantor.rolname::text ORDER BY grantor.rolname)
  FROM pg_auth_members m JOIN pg_roles grantor ON grantor.oid=m.grantor
  WHERE m.roleid='commonswarm_oauth_runtime'::regrole AND m.member='commonswarm_edge'::regrole)
  = (SELECT array_agg(n ORDER BY n) FROM unnest(ARRAY['${grantor}', current_user]::text[]) n)`,
  'output lists both grantor names')}
${revokeBody}
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
`);
});
