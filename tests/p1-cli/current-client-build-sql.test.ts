import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const script = resolve(root, "scripts/current-client-build-sql.sh");
const temporaryRoots: string[] = [];

after(() => {
  for (const path of temporaryRoots) {
    assert.ok(path.startsWith(`${tmpdir()}/current-client-build-`));
    rmSync(path, { recursive: true, force: true });
  }
});

function run(cwd: string, sha?: string, env: NodeJS.ProcessEnv = process.env) {
  return spawnSync("bash", sha === undefined ? [script] : [script, sha], {
    cwd,
    env,
    encoding: "utf8",
  });
}

test("the release SHA prints exactly one current-client-build statement", () => {
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const version = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;
  const result = run(root, sha);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    `INSERT INTO swarm.config (key, value) VALUES ('current_client_build', to_jsonb('${version}'::text)) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;\n`,
  );
  assert.equal(result.stdout.trim().split("\n").length, 1);
});

test("a missing SHA is refused", () => {
  const result = run(root);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /usage:/);
});

test("a non-semver package version is refused and no database client runs", () => {
  const repo = mkdtempSync(join(tmpdir(), "current-client-build-"));
  temporaryRoots.push(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
  writeFileSync(join(repo, "package.json"), '{"version":"not-semver"}\n');
  execFileSync("git", ["add", "package.json"], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: repo });
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

  const bin = join(repo, "bin");
  const marker = join(repo, "database-client-ran");
  mkdirSync(bin);
  for (const name of ["psql", "supabase", "docker"]) {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/sh\nprintf ran >${JSON.stringify(marker)}\nexit 99\n`, { mode: 0o755 });
  }
  const result = run(repo, sha, { ...process.env, PATH: `${bin}:${process.env.PATH}` });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /not semver/);
  assert.equal(spawnSync("test", ["-e", marker]).status, 1);
});
