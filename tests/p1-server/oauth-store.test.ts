/** HM lane-6 OAuth-store migration proofs. Runs only in the manual `server` suite. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import postgres from "postgres";

const migrationUrl = new URL(
  "../../supabase/migrations/20260928000003_hm_oauth_store.sql",
  import.meta.url,
);
const catalogUrl = new URL(
  "../../deploy/release-proofs/item-hm/20260928000003-catalog.sql",
  import.meta.url,
);
const rollbackUrl = new URL(
  "../../deploy/release-proofs/item-hm/20260928000003-rollback.sql",
  import.meta.url,
);

const migrationRole = "hm6_oauth_migration_test";
const rollbackSentinel = "ROLLBACK_HM6_OAUTH_PROOF_DRILL";

interface LocalEnvironment {
  DB_URL: string;
}

let sql: postgres.Sql;

before(() => {
  const status = JSON.parse(execFileSync("supabase", ["status", "-o", "json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  })) as Partial<LocalEnvironment>;
  assert.ok(status.DB_URL);
  const target = new URL(status.DB_URL);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(target.hostname));
  sql = postgres(status.DB_URL, { prepare: false, max: 1 });
});

after(async () => {
  await sql.end();
});

function catalogQuery(source: string): string {
  const laneTwoProbe = /SELECT to_regclass\('swarm\.hosted_mcp_grants'\) IS NOT NULL\s+AS lane_2_authority_present\s+\\gset/u;
  const withoutProbe = source.replace(laneTwoProbe, "");
  assert.notEqual(withoutProbe, source, "catalog lane-2 guard was not found");
  return withoutProbe
    .replaceAll(
      ":'lane_2_authority_present'::boolean",
      "(to_regclass('swarm.hosted_mcp_grants') IS NOT NULL)",
    )
    .replace(/\\gset\s*$/u, "");
}

function rollbackBody(source: string): string {
  const start = source.indexOf("DO $runtime_role_state$");
  const end = source.indexOf("\\ir 20260928000003-rollback-catalog.sql");
  assert.ok(start >= 0 && end > start, "rollback SQL body markers were not found");
  return source.slice(start, end);
}

async function creatorMembership(
  tx: postgres.TransactionSql<Record<string, unknown>>,
  creator: string,
): Promise<{ count: number; safe: boolean }> {
  const [row] = await tx<{ count: number; safe: boolean }[]>`
    SELECT
      count(*)::int AS count,
      COALESCE(bool_and(
        membership.admin_option
        AND NOT membership.inherit_option
        AND NOT membership.set_option
      ), false) AS safe
    FROM pg_auth_members AS membership
    JOIN pg_roles AS parent ON parent.oid = membership.roleid
    JOIN pg_roles AS member ON member.oid = membership.member
    WHERE parent.rolname = 'commonswarm_oauth_runtime'
      AND member.rolname = ${creator}
  `;
  assert.ok(row);
  return row;
}

test("OAuth catalog is structural and passes a production-path non-superuser apply", async () => {
  const [migration, catalog, rollback] = await Promise.all([
    readFile(migrationUrl, "utf8"),
    readFile(catalogUrl, "utf8"),
    readFile(rollbackUrl, "utf8"),
  ]);
  assert.doesNotMatch(
    catalog,
    /pg_get_(?:function|view)def|\bprosrc\b|information_schema\.columns/u,
    "catalog proofs must use role-independent structural catalogs",
  );
  const proof = catalogQuery(catalog);
  const inverse = rollbackBody(rollback);

  await sql.begin(async (tx) => {
    const [installed] = await tx.unsafe<{ catalog_ok: boolean }[]>(proof);
    assert.equal(installed?.catalog_ok, true, "positive control: reset applied HM6");

    await tx.unsafe(inverse);
    const [roleCollision] = await tx<{ present: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${migrationRole}) AS present
    `;
    assert.equal(roleCollision?.present, false, "reserved test migration role already exists");

    await tx.unsafe(`
      CREATE ROLE ${migrationRole}
        LOGIN NOSUPERUSER CREATEDB CREATEROLE INHERIT REPLICATION BYPASSRLS;
      GRANT swarm_admin TO ${migrationRole} WITH INHERIT TRUE, SET TRUE;
      GRANT swarm_read TO ${migrationRole} WITH INHERIT TRUE, SET TRUE;
      GRANT ${migrationRole} TO SESSION_USER WITH SET TRUE, INHERIT FALSE;
      DO $database_grants$
      BEGIN
        EXECUTE format(
          'GRANT CONNECT, CREATE ON DATABASE %I TO ${migrationRole} WITH GRANT OPTION',
          current_database()
        );
      END
      $database_grants$;
      SET LOCAL ROLE ${migrationRole};
      SET LOCAL search_path = "$user", public, auth, extensions;
      SET LOCAL createrole_self_grant = 'set,inherit';
    `);
    const [identity] = await tx<{
      current_role: string;
      non_super: boolean;
      role_shape: boolean;
    }[]>`
      SELECT
        current_user::text AS current_role,
        NOT rolsuper AS non_super,
        rolcanlogin AND rolinherit AND rolcreatedb AND rolcreaterole
          AND rolreplication AND rolbypassrls AS role_shape
      FROM pg_roles WHERE rolname = current_user
    `;
    assert.deepEqual(identity, {
      current_role: migrationRole,
      non_super: true,
      role_shape: true,
    });

    const [beforeApply] = await tx.unsafe<{ catalog_ok: boolean }[]>(proof);
    assert.equal(
      beforeApply?.catalog_ok,
      false,
      "pre-migration catalog returns false without an error under production conditions",
    );

    await tx.unsafe(migration);
    const [afterApply] = await tx.unsafe<{ catalog_ok: boolean }[]>(proof);
    assert.equal(
      afterApply?.catalog_ok,
      true,
      "non-superuser migration and production search_path satisfy the catalog",
    );
    assert.deepEqual(
      await creatorMembership(tx, migrationRole),
      { count: 1, safe: true },
      "PostgreSQL 17 creator membership stays admin-only",
    );

    await tx.unsafe("RESET ROLE");
    await tx.unsafe(inverse);
    const [{ current_role: superuser }] = await tx<{ current_role: string }[]>`
      SELECT current_user::text AS current_role
    `;
    await tx.unsafe(migration);
    assert.deepEqual(
      await creatorMembership(tx, superuser),
      { count: 0, safe: false },
      "superuser apply does not add an unnecessary creator membership",
    );
    const [superuserProof] = await tx.unsafe<{ catalog_ok: boolean }[]>(proof);
    assert.equal(superuserProof?.catalog_ok, true, "superuser control still satisfies catalog");

    throw new Error(rollbackSentinel);
  }).catch((error) => {
    if (!(error instanceof Error) || error.message !== rollbackSentinel) throw error;
  });
});
