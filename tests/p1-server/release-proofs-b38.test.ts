/** B38 migrations replayed as supabase_admin, with non-superuser forward proofs. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const proofDirectory = fileURLToPath(new URL(
  "../../deploy/release-proofs/item-b38/", import.meta.url,
));
const migrations = [
  "20261014000001_oauth_session_binding.sql",
  "20261014000002_oauth_finish.sql",
] as const;

function databaseContainer(): string {
  const containers = execFileSync("docker", ["ps", "--format", "{{.Names}}"], {
    encoding: "utf8",
  }).trim().split("\n").filter((name) => /^supabase_db_/.test(name));
  assert.equal(containers.length, 1, `expected one local Supabase database, found ${containers.length}`);
  return containers[0]!;
}

function requireTrue(variable: string, label: string): string {
  return `
\\if :{?${variable}}
SELECT :'${variable}' = 't' AS proof_is_t
\\gset
\\if :proof_is_t
\\else
DO $assert$ BEGIN RAISE EXCEPTION '${label} did not return t'; END $assert$;
\\endif
\\else
DO $assert$ BEGIN RAISE EXCEPTION '${label} returned no result'; END $assert$;
\\endif
`;
}

function replayPrefix(directory: string): string {
  return `\\set release_proof_outer_transaction 1
BEGIN;
-- The local reset has both migrations installed. The box release principal
-- reverses them inside this transaction before replaying as supabase_admin.
\\ir 20261014000002-rollback.sql
\\ir 20261014000001-rollback.sql
DO $identity$
BEGIN
  IF current_user <> 'supabase_admin'
    OR NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)
    OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres'
      AND NOT rolsuper AND rolcreaterole) THEN
    RAISE EXCEPTION 'B38 replay requires supabase_admin and a non-superuser postgres proof role';
  END IF;
END
$identity$;
-- Match the creator's ADMIN-only runtime membership, including reset paths
-- where an earlier migration was applied by the superuser instead.
GRANT commonswarm_oauth_runtime TO postgres WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
CREATE TEMP TABLE b38_runtime_memberships_before ON COMMIT DROP AS
  SELECT * FROM pg_auth_members
  WHERE roleid = (SELECT oid FROM pg_roles WHERE rolname = 'commonswarm_oauth_runtime');
-- Apply as the same supabase_admin principal used by CI and the box.
\\i ${directory}/${migrations[0]}
INSERT INTO supabase_migrations.schema_migrations (version) VALUES ('20261014000001');
-- Both proof identities must be non-superuser: a superuser session can SET ROLE
-- without membership and would hide the regression in the functional proofs.
SET LOCAL SESSION AUTHORIZATION postgres;
DO $proof_role$
BEGIN
  IF current_user <> 'postgres' OR session_user <> 'postgres'
    OR (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'B38 forward proofs must use a non-superuser session';
  END IF;
END
$proof_role$;
\\ir 20261014000001-catalog.sql
${requireTrue("catalog_ok", "session catalog after supabase_admin apply")}
\\ir 20261014000001-functional.sql
${requireTrue("functional_ok", "session functional proof")}
RESET SESSION AUTHORIZATION;
\\i ${directory}/${migrations[1]}
INSERT INTO supabase_migrations.schema_migrations (version) VALUES ('20261014000002');
SET LOCAL SESSION AUTHORIZATION postgres;
\\ir 20261014000002-catalog.sql
${requireTrue("catalog_ok", "finish catalog after supabase_admin apply")}
\\ir 20261014000002-functional.sql
${requireTrue("functional_ok", "finish functional proof")}
RESET SESSION AUTHORIZATION;
DO $membership$
BEGIN
  IF EXISTS (
    (SELECT * FROM pg_auth_members
      WHERE roleid = (SELECT oid FROM pg_roles WHERE rolname = 'commonswarm_oauth_runtime')
      EXCEPT SELECT * FROM b38_runtime_memberships_before)
    UNION ALL
    (SELECT * FROM b38_runtime_memberships_before EXCEPT
      SELECT * FROM pg_auth_members
      WHERE roleid = (SELECT oid FROM pg_roles WHERE rolname = 'commonswarm_oauth_runtime'))
  ) THEN
    RAISE EXCEPTION 'B38 functional proofs left a runtime membership behind';
  END IF;
END
$membership$;
`;
}

test("B38 supabase_admin apply, all eight proofs and wrong-order rollback refusal", {
  timeout: 120_000,
}, () => {
  const container = databaseContainer();
  const localRoot = realpathSync(tmpdir());
  const localDirectory = mkdtempSync(join(localRoot, "cswarm-release-proofs-b38-"));
  const remoteDirectory = `/tmp/cswarm-release-proofs-b38-${randomUUID()}`;
  const copyToContainer = (path: string): void => {
    execFileSync("docker", ["cp", path, `${container}:${remoteDirectory}/`]);
  };
  const writeAndCopy = (name: string, source: string): string => {
    const path = join(localDirectory, name);
    writeFileSync(path, source, { mode: 0o600 });
    copyToContainer(path);
    return `${remoteDirectory}/${name}`;
  };
  const runPsql = (file: string) => spawnSync("docker", [
    // Pin the same CI search_path as G3; function source hashes are independent
    // of qualification. Replay/rollback use the box's supabase_admin role.
    "exec", "-e", 'PGOPTIONS=-c search_path=\\"$user\\",public', container,
    "psql", "-X", "-Atq", "-U", "supabase_admin", "-d", "postgres",
    "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", "--file", file,
  ], { encoding: "utf8", timeout: 45_000 });
  const successfulPsql = (file: string): string => {
    const result = runPsql(file);
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };

  try {
    execFileSync("docker", ["exec", container, "mkdir", "-p", remoteDirectory]);
    copyToContainer(`${proofDirectory}/.`);
    for (const migration of migrations) {
      copyToContainer(fileURLToPath(new URL(`../../supabase/migrations/${migration}`, import.meta.url)));
    }
    const prefix = replayPrefix(remoteDirectory);
    const wrongOrder = writeAndCopy("wrong-order.sql", `${prefix}
\\ir 20261014000001-rollback.sql
ROLLBACK;
`);
    const refused = runPsql(wrongOrder);
    assert.ifError(refused.error);
    assert.equal(refused.status, 3, refused.stderr);
    assert.match(refused.stderr,
      /P0001: run 20261014000002-rollback\.sql before the session rollback/u,
      "wrong-order refusal must reach the dependency guard after positive apply/proof controls");

    const ordered = writeAndCopy("ordered.sql", `${prefix}
\\ir 20261014000002-rollback.sql
\\ir 20261014000002-rollback-catalog.sql
${requireTrue("rollback_ok", "finish rollback catalog")}
\\ir 20261014000001-rollback.sql
\\ir 20261014000001-rollback-catalog.sql
${requireTrue("rollback_ok", "session rollback catalog")}
ROLLBACK;
\\echo b38-rollback-ok
`);
    assert.equal(successfulPsql(ordered), "t\nt\nb38-rollback-ok");

    const restored = writeAndCopy("restored.sql", `
\\ir 20261014000001-catalog.sql
${requireTrue("catalog_ok", "session catalog after outer rollback")}
\\ir 20261014000002-catalog.sql
${requireTrue("catalog_ok", "finish catalog after outer rollback")}
SELECT count(*) = 2 AS ledger_ok FROM supabase_migrations.schema_migrations
WHERE version IN ('20261014000001', '20261014000002')
\\gset
${requireTrue("ledger_ok", "restored migration ledger")}
\\echo b38-restored-ok
`);
    assert.equal(successfulPsql(restored), "b38-restored-ok");
  } finally {
    // Delete only these newly created temporary roots. Use the installed host
    // rm guard for host cleanup; never bypass it with rmSync or find -delete.
    assert.match(remoteDirectory, /^\/tmp\/cswarm-release-proofs-b38-[0-9a-f-]{36}$/u);
    execFileSync("docker", ["exec", container, "rm", "-r", "--", remoteDirectory]);
    assert.equal(realpathSync(localDirectory), localDirectory);
    assert.equal(dirname(localDirectory), localRoot);
    assert.match(basename(localDirectory), /^cswarm-release-proofs-b38-[^/]+$/u);
    execFileSync("rm", ["-r", "--", localDirectory]);
  }
});
