/** G3 release proofs against the fully migrated local PostgreSQL stack. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const VERSIONS = ["20260927000001", "20260927000002", "20260927000003"] as const;
const PROOF_DIRECTORIES = [
  fileURLToPath(new URL("../../deploy/release-proofs/item-g3c/", import.meta.url)),
  fileURLToPath(new URL("../../deploy/release-proofs/item-g3d/", import.meta.url)),
  fileURLToPath(new URL("../../deploy/release-proofs/item-t3/", import.meta.url)),
];

function databaseContainer(): string {
  const containers = execFileSync("docker", ["ps", "--format", "{{.Names}}"], {
    encoding: "utf8",
  }).trim().split("\n").filter((name) => /^supabase_db_/.test(name));
  assert.equal(containers.length, 1, `expected one local Supabase database, found ${containers.length}`);
  return containers[0]!;
}

function catalogWrapper(proofDirectory: string, version: string): string {
  return `\\i ${proofDirectory}/${version}-catalog.sql
\\if :{?catalog_ok}
SELECT :'catalog_ok' = 't' AS catalog_is_t, :'catalog_ok' = 'f' AS catalog_is_f
\\gset
\\if :catalog_is_t
  \\echo t
\\else
  \\if :catalog_is_f
    \\echo f
  \\else
    \\echo invalid
  \\endif
\\endif
\\else
  \\echo invalid
\\endif
`;
}

function rollbackWrapper(proofDirectory: string): string {
  const checks = [...VERSIONS].reverse().map((version) => `
\\ir ${version}-rollback.sql
\\ir ${version}-rollback-catalog.sql
SELECT :'rollback_ok' = 't' AS rollback_is_t
\\gset
\\if :rollback_is_t
\\else
DO $assert$ BEGIN RAISE EXCEPTION '${version} rollback catalog did not return t'; END $assert$;
\\endif
\\ir ${version}-catalog.sql
SELECT :'catalog_ok' = 'f' AS catalog_is_f
\\gset
\\if :catalog_is_f
\\else
DO $assert$ BEGIN RAISE EXCEPTION '${version} catalog did not return f after rollback'; END $assert$;
\\endif
\\echo ${version}-rollback-ok
`).join("");

  return `\\set release_proof_outer_transaction 1
BEGIN;
${checks}
ROLLBACK;
`;
}

test("G3 catalogs and reverse rollbacks execute through psql without changing the database", {
  timeout: 60_000,
}, () => {
  const container = databaseContainer();
  const localDirectory = mkdtempSync(join(tmpdir(), "cswarm-release-proofs-g3-"));
  const remoteDirectory = `/tmp/cswarm-release-proofs-g3-${randomUUID()}`;

  const copyToContainer = (localPath: string): void => {
    execFileSync("docker", ["cp", localPath, `${container}:${remoteDirectory}/`]);
  };
  const writeAndCopy = (name: string, contents: string): string => {
    const localPath = join(localDirectory, name);
    writeFileSync(localPath, contents, { mode: 0o600 });
    copyToContainer(localPath);
    return `${remoteDirectory}/${name}`;
  };
  const runPsql = (remoteFile: string): string => {
    const result = spawnSync("docker", [
      "exec", container,
      "psql", "-X", "-Atq", "-U", "postgres", "-d", "postgres",
      "-v", "ON_ERROR_STOP=1", "--file", remoteFile,
    ], { encoding: "utf8", timeout: 30_000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };

  execFileSync("docker", ["exec", container, "mkdir", "-p", remoteDirectory]);
  try {
    for (const directory of PROOF_DIRECTORIES) {
      copyToContainer(`${directory}/.`);
    }

    for (const version of VERSIONS) {
      const wrapper = writeAndCopy(
        `${version}-catalog-wrapper.sql`,
        catalogWrapper(remoteDirectory, version),
      );
      assert.equal(runPsql(wrapper), "t", `${version} catalog on migrated database`);
    }

    const rollback = writeAndCopy(
      "rollback-wrapper.sql",
      rollbackWrapper(remoteDirectory),
    );
    assert.deepEqual(runPsql(rollback).split("\n"), [
      "20260927000003-rollback-ok",
      "20260927000002-rollback-ok",
      "20260927000001-rollback-ok",
    ]);

    for (const version of VERSIONS) {
      assert.equal(
        runPsql(`${remoteDirectory}/${version}-catalog-wrapper.sql`),
        "t",
        `${version} catalog after the test transaction rolled back`,
      );
    }
  } finally {
    spawnSync("docker", ["exec", container, "find", remoteDirectory, "-type", "f", "-delete"]);
    spawnSync("docker", ["exec", container, "rmdir", remoteDirectory]);
    rmSync(localDirectory, { recursive: true, force: true });
  }
});
