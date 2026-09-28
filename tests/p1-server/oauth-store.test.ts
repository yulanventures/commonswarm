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
const migrationVersion = "20260928000003";
const migrationOwner = "supabase_admin";
const rollbackSentinel = "ROLLBACK_HM6_OAUTH_PROOF_DRILL";

interface LocalEnvironment {
  DB_URL: string;
}

let superuserSql: postgres.Sql;

before(() => {
  const status = JSON.parse(execFileSync("supabase", ["status", "-o", "json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  })) as Partial<LocalEnvironment>;
  assert.ok(status.DB_URL);
  const target = new URL(status.DB_URL);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(target.hostname));
  target.username = migrationOwner;
  superuserSql = postgres(target.toString(), { prepare: false, max: 1 });
});

after(async () => {
  await superuserSql.end();
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

async function creatorSelfGrant(
  tx: postgres.TransactionSql<Record<string, unknown>>,
): Promise<string> {
  const [row] = await tx.unsafe<{ createrole_self_grant: string }[]>(
    "SHOW createrole_self_grant",
  );
  assert.ok(row);
  return row.createrole_self_grant.replaceAll(/\s+/gu, "");
}

async function assertCatalogPasses(
  tx: postgres.TransactionSql<Record<string, unknown>>,
  proof: string,
  message: string,
): Promise<void> {
  const [result] = await tx.unsafe<{ catalog_ok: boolean }[]>(proof);
  assert.equal(result?.catalog_ok, true, message);
}

async function resetToMigrationOwner(
  tx: postgres.TransactionSql<Record<string, unknown>>,
): Promise<void> {
  await tx.unsafe("RESET ROLE");
  const [{ current_role, superuser }] = await tx<{
    current_role: string;
    superuser: boolean;
  }[]>`
    SELECT current_user::text AS current_role, rolsuper AS superuser
    FROM pg_roles
    WHERE rolname = current_user
  `;
  assert.equal(
    current_role,
    migrationOwner,
    "ledger bookkeeping must run as the stack migration owner",
  );
  assert.equal(superuser, true, "migration-owner connection must be a superuser");
}

async function recordMigrationLedger(
  tx: postgres.TransactionSql<Record<string, unknown>>,
): Promise<void> {
  await resetToMigrationOwner(tx);
  await tx`
    INSERT INTO supabase_migrations.schema_migrations (version)
    VALUES (${migrationVersion})
  `;
}

async function rollbackAsMigrationOwner(
  tx: postgres.TransactionSql<Record<string, unknown>>,
  inverse: string,
): Promise<void> {
  await resetToMigrationOwner(tx);
  await tx.unsafe(inverse);
}

async function assertMigrationDatabaseGrant(
  tx: postgres.TransactionSql<Record<string, unknown>>,
  expectedGrantor: string | undefined,
  message: string,
): Promise<void> {
  const grants = await tx<{
    grantor: string;
    privilege_type: string;
    is_grantable: boolean;
  }[]>`
    SELECT
      grantor.rolname::text AS grantor,
      privilege.privilege_type,
      privilege.is_grantable
    FROM pg_database AS db
    CROSS JOIN LATERAL aclexplode(
      COALESCE(db.datacl, acldefault('d', db.datdba))
    ) AS privilege
    JOIN pg_roles AS runtime ON runtime.oid = privilege.grantee
    JOIN pg_roles AS grantor ON grantor.oid = privilege.grantor
    WHERE db.datname = current_database()
      AND runtime.rolname = 'commonswarm_oauth_runtime'
    ORDER BY grantor.rolname, privilege.privilege_type
  `;
  assert.equal(grants.length, 1, `${message}: direct database grant count`);
  assert.equal(grants[0]?.privilege_type, "CONNECT", `${message}: privilege`);
  assert.equal(grants[0]?.is_grantable, false, `${message}: grant option`);
  if (expectedGrantor !== undefined) {
    assert.equal(grants[0]?.grantor, expectedGrantor, `${message}: grantor`);
  }

  const [dependency] = await tx<{ count: number; exact: boolean }[]>`
    SELECT
      count(*)::int AS count,
      COALESCE(bool_and(
        dependency.deptype = 'a'
        AND dependency.dbid = 0
        AND db.datname = current_database()
      ), false) AS exact
    FROM pg_shdepend AS dependency
    JOIN pg_database AS db
      ON dependency.classid = 'pg_database'::regclass
      AND db.oid = dependency.objid
    JOIN pg_roles AS runtime ON runtime.oid = dependency.refobjid
    WHERE dependency.refclassid = 'pg_authid'::regclass
      AND runtime.rolname = 'commonswarm_oauth_runtime'
  `;
  assert.deepEqual(
    dependency,
    { count: 1, exact: true },
    `${message}: database ACL has one pg_shdepend deptype=a row`,
  );
}

async function rollbackAndAssertRemoved(
  tx: postgres.TransactionSql<Record<string, unknown>>,
  inverse: string,
  message: string,
): Promise<void> {
  const [runtime] = await tx<{ oid: number }[]>`
    SELECT oid FROM pg_roles WHERE rolname = 'commonswarm_oauth_runtime'
  `;
  assert.ok(runtime, `${message}: runtime role must exist before rollback`);

  await rollbackAsMigrationOwner(tx, inverse);

  const [state] = await tx<{
    role_absent: boolean;
    shared_dependencies_absent: boolean;
    memberships_absent: boolean;
    settings_absent: boolean;
    default_acls_absent: boolean;
    ledger_absent: boolean;
  }[]>`
    SELECT
      NOT EXISTS (
        SELECT 1 FROM pg_roles
        WHERE oid = ${runtime.oid} OR rolname = 'commonswarm_oauth_runtime'
      ) AS role_absent,
      NOT EXISTS (
        SELECT 1 FROM pg_shdepend
        WHERE (refclassid = 'pg_authid'::regclass AND refobjid = ${runtime.oid})
          OR (classid = 'pg_authid'::regclass AND objid = ${runtime.oid})
      ) AS shared_dependencies_absent,
      NOT EXISTS (
        SELECT 1 FROM pg_auth_members
        WHERE roleid = ${runtime.oid}
          OR member = ${runtime.oid}
          OR grantor = ${runtime.oid}
      ) AS memberships_absent,
      NOT EXISTS (
        SELECT 1 FROM pg_db_role_setting WHERE setrole = ${runtime.oid}
      ) AS settings_absent,
      NOT EXISTS (
        SELECT 1
        FROM pg_default_acl AS defaults
        LEFT JOIN LATERAL aclexplode(defaults.defaclacl) AS privilege ON true
        WHERE defaults.defaclrole = ${runtime.oid}
          OR privilege.grantee = ${runtime.oid}
          OR privilege.grantor = ${runtime.oid}
      ) AS default_acls_absent,
      NOT EXISTS (
        SELECT 1 FROM supabase_migrations.schema_migrations
        WHERE version = ${migrationVersion}
      ) AS ledger_absent
  `;
  assert.deepEqual(state, {
    role_absent: true,
    shared_dependencies_absent: true,
    memberships_absent: true,
    settings_absent: true,
    default_acls_absent: true,
    ledger_absent: true,
  }, message);
}

test("OAuth catalog is structural and all creator apply paths are safe", async () => {
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
  assert.doesNotMatch(
    migration,
    /GRANT\s+commonswarm_oauth_runtime\s+TO\s+(?:current_user|%I)/iu,
    "the migration must not try to rewrite its automatic creator membership",
  );
  assert.match(
    migration,
    /SET LOCAL createrole_self_grant = '';\s+CREATE ROLE commonswarm_oauth_runtime/u,
    "the migration pins creator membership options immediately before CREATE ROLE",
  );
  assert.doesNotMatch(
    migration,
    /\bsupabase_migrations\b/u,
    "the migration runner, not the migration file, owns ledger bookkeeping",
  );
  const proof = catalogQuery(catalog);
  const inverse = rollbackBody(rollback);

  await superuserSql.begin(async (tx) => {
    await assertCatalogPasses(tx, proof, "positive control: reset applied HM6");

    await assertMigrationDatabaseGrant(
      tx,
      undefined,
      "reset-applied migration",
    );
    await rollbackAndAssertRemoved(
      tx,
      inverse,
      "reset-applied migration rollback removes the role and every dependency",
    );
    await tx.unsafe("RESET ROLE");
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
    `);

    await tx.unsafe(`
      SET LOCAL ROLE ${migrationRole};
      SET LOCAL search_path = "$user", public, auth, extensions;
      SET LOCAL createrole_self_grant = '';
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
    assert.equal(
      await creatorSelfGrant(tx),
      "",
      "default non-superuser path starts empty",
    );

    const [beforeApply] = await tx.unsafe<{ catalog_ok: boolean }[]>(proof);
    assert.equal(
      beforeApply?.catalog_ok,
      false,
      "pre-migration catalog returns false without an error under production conditions",
    );

    await tx.unsafe(migration);
    await recordMigrationLedger(tx);
    await tx.unsafe(`SET LOCAL ROLE ${migrationRole}`);
    await assertCatalogPasses(
      tx,
      proof,
      "default non-superuser migration and production search_path satisfy the catalog",
    );
    assert.deepEqual(
      await creatorMembership(tx, migrationRole),
      { count: 1, safe: true },
      "default non-superuser creator membership stays admin-only",
    );
    await assertMigrationDatabaseGrant(
      tx,
      migrationRole,
      "default non-superuser migration",
    );
    await rollbackAndAssertRemoved(
      tx,
      inverse,
      "default non-superuser rollback removes the role and every dependency",
    );

    await tx.unsafe(`SET LOCAL ROLE ${migrationRole}`);

    await tx.unsafe(`
      SET LOCAL createrole_self_grant = 'set,inherit';
      CREATE ROLE commonswarm_oauth_runtime
        LOGIN NOINHERIT NOCREATEDB NOCREATEROLE;
    `);
    assert.equal(
      await creatorSelfGrant(tx),
      "set,inherit",
      "negative control creates the role with unsafe self-grant options enabled",
    );
    assert.deepEqual(
      await creatorMembership(tx, migrationRole),
      { count: 1, safe: false },
      "negative control reaches the unsafe automatic creator membership",
    );
    await assert.rejects(
      tx.savepoint(async (sp) => await sp.unsafe(migration)),
      /commonswarm_oauth_runtime has unsafe membership options/u,
      "an existing unsafe role is refused rather than repaired",
    );
    assert.deepEqual(
      await creatorMembership(tx, migrationRole),
      { count: 1, safe: false },
      "the refused migration did not repair the existing membership",
    );
    await tx.unsafe("DROP ROLE commonswarm_oauth_runtime");

    await tx.unsafe("SET LOCAL createrole_self_grant = 'set,inherit'");
    assert.equal(
      await creatorSelfGrant(tx),
      "set,inherit",
      "configured non-superuser path starts with self-grants enabled",
    );
    await tx.unsafe(migration);
    await recordMigrationLedger(tx);
    await tx.unsafe(`SET LOCAL ROLE ${migrationRole}`);
    assert.equal(
      await creatorSelfGrant(tx),
      "",
      "migration pins the transaction-local creator self-grant to empty",
    );
    await assertCatalogPasses(
      tx,
      proof,
      "configured non-superuser migration satisfies the catalog",
    );
    assert.deepEqual(
      await creatorMembership(tx, migrationRole),
      { count: 1, safe: true },
      "configured non-superuser creator membership is still admin-only",
    );
    await assertMigrationDatabaseGrant(
      tx,
      migrationRole,
      "configured non-superuser migration",
    );
    await rollbackAndAssertRemoved(
      tx,
      inverse,
      "configured non-superuser rollback removes the role and every dependency",
    );

    await tx.unsafe("RESET ROLE");
    const [{ current_role: superuser }] = await tx<{ current_role: string }[]>`
      SELECT current_user::text AS current_role
    `;
    await tx.unsafe("SET LOCAL createrole_self_grant = 'set,inherit'");
    await tx.unsafe(migration);
    await recordMigrationLedger(tx);
    await tx.unsafe("RESET ROLE");
    assert.deepEqual(
      await creatorMembership(tx, superuser),
      { count: 0, safe: false },
      "superuser apply does not add an unnecessary creator membership",
    );
    await assertCatalogPasses(tx, proof, "superuser control still satisfies catalog");
    await assertMigrationDatabaseGrant(
      tx,
      undefined,
      "superuser migration",
    );

    await tx.unsafe(
      "GRANT SELECT ON TABLE swarm.users TO commonswarm_oauth_runtime",
    );
    await assert.rejects(
      tx.savepoint(async (sp) => await rollbackAsMigrationOwner(sp, inverse)),
      /OAuth rollback refuses role removal: grants or dependencies remain/u,
      "an unexpected external table grant keeps the rollback fail-closed",
    );
    await assertCatalogPasses(
      tx,
      proof,
      "the refused rollback leaves the applied migration intact",
    );
    await tx.unsafe(
      "REVOKE SELECT ON TABLE swarm.users FROM commonswarm_oauth_runtime",
    );
    await rollbackAndAssertRemoved(
      tx,
      inverse,
      "superuser rollback removes the role and every dependency",
    );

    throw new Error(rollbackSentinel);
  }).catch((error) => {
    if (!(error instanceof Error) || error.message !== rollbackSentinel) throw error;
  });
});
