import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

// scripts/run-gates.sh is the one wrapper every local gate run goes through (2026-09-26 ruling after the home
// deletion). These controls pin what protects the real home: the script never reads $HOME, it runs each gate
// under a temporary HOME it created under /tmp, it refuses an unknown mode, and no gate can reach docker (any
// docker CLI call starts OrbStack on this host; HezLead ruling, 2026-09-26).
const script = resolve("scripts/run-gates.sh");
// This file itself runs under node:test, and a nested `node --test` that inherits NODE_TEST_CONTEXT skips its
// files and exits 0. The probes below must really run, so the wrapper is spawned without it.
const { NODE_TEST_CONTEXT: _inherited, ...wrapperEnv } = process.env;

test("the gate wrapper never reads the caller's HOME and only injects its own", () => {
  const source = readFileSync(script, "utf8");
  assert.equal((source.match(/\$HOME\b/g) ?? []).length, 0, "the wrapper must not read $HOME");
  assert.equal((source.match(/\bexport HOME=|^HOME=/gm) ?? []).length, 0, "HOME is never assigned");
  assert.match(source, /env -u FORCE_COLOR HOME="\$T" PATH="\$shims:\$PATH" perl -e 'setpgrp\(0,0\); exec @ARGV' bash -c/, "each gate runs under env HOME=$T in its own process group");
  assert.match(source, /mktemp -d \/tmp\/lane-home\.XXXXXX/, "the temp home comes from mktemp under /tmp");
  assert.match(source, /rm -rf -- "\$T"/, "only $T is deleted");
  assert.doesNotMatch(source, /"npm --prefix site (run )?test"/, "no site test on this host: it starts a browser per case");
});

test("cli-file mode runs a test under a /tmp home and leaves the real home alone", { timeout: 120_000 }, () => {
  const scratch = mkdtempSync(join(tmpdir(), "run-gates-control-"));
  try {
    const probe = join(scratch, "probe.test.mjs");
    writeFileSync(probe, [
      'import test from "node:test"; import assert from "node:assert/strict"; import { homedir } from "node:os";',
      'test("home is the injected one", () => { assert.match(homedir(), /^\\/(private\\/)?tmp\\/lane-home\\./); });',
      "",
    ].join("\n"));
    const log = join(scratch, "gate.log");
    const result = spawnSync("bash", [script, resolve("."), log, "HEAD", "cli-file", probe], { encoding: "utf8", timeout: 110_000, env: wrapperEnv });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const body = readFileSync(log, "utf8");
    assert.match(body, /^home=\/(private\/)?tmp\/lane-home\./m);
    assert.match(body, /EXIT 0 :: npx tsx --test/);
    assert.match(body, /^ℹ pass 1$/m, "the probe really ran");
    assert.doesNotMatch(body, new RegExp(homedir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/\\.cswarm"));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("an unknown mode is refused with exit 3 and runs nothing", () => {
  const scratch = mkdtempSync(join(tmpdir(), "run-gates-control-"));
  try {
    const result = spawnSync("bash", [script, resolve("."), join(scratch, "gate.log"), "HEAD", "bogus"], { encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, 3);
    assert.doesNotMatch(readFileSync(join(scratch, "gate.log"), "utf8"), /EXIT/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("a gate that calls docker gets the blocking stand-in, and the call is listed as NOT RUN", { timeout: 120_000 }, () => {
  const scratch = mkdtempSync(join(tmpdir(), "run-gates-control-"));
  try {
    const probe = join(scratch, "probe.test.mjs");
    writeFileSync(probe, [
      'import test from "node:test"; import assert from "node:assert/strict"; import { spawnSync } from "node:child_process";',
      'test("docker resolves to the stand-in and fails", () => {',
      '  const found = spawnSync("bash", ["-c", "command -v docker"], { encoding: "utf8" }).stdout.trim();',
      '  assert.match(found, /^\\/(private\\/)?tmp\\/lane-home\\.[^/]+\\/\\.gate-bin\\/docker$/);',
      '  const docker = spawnSync("docker", ["version", "--format", "probe"], { encoding: "utf8" });',
      '  assert.equal(docker.status, 1);',
      '  assert.match(docker.stderr, /blocked on this host/);',
      '});',
      'test("a docker-guarded probe skips", (t) => {',
      '  if (spawnSync("docker", ["version"], { encoding: "utf8" }).status !== 0) { t.skip("Docker is absent"); return; }',
      '  assert.fail("the stand-in let docker version succeed");',
      '});',
      "",
    ].join("\n"));
    const log = join(scratch, "gate.log");
    const result = spawnSync("bash", [script, resolve("."), log, "HEAD", "cli-file", probe], { encoding: "utf8", timeout: 110_000, env: wrapperEnv });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const body = readFileSync(log, "utf8");
    assert.match(body, /EXIT 0 :: npx tsx --test/);
    assert.match(body, /^ℹ pass 1$/m, "the probe really ran");
    assert.match(body, /^ℹ skipped 1$/m);
    assert.match(body, /^NOT RUN on this host \(docker blocked\): 2 blocked calls/m);
    assert.match(body, /^  blocked: docker version --format probe$/m);
    assert.match(body, /^  skipped: ﹣ a docker-guarded probe skips # Docker is absent$/m);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("a docker in an ancestor node_modules/.bin is refused before any gate runs", () => {
  const scratch = mkdtempSync(join(tmpdir(), "run-gates-control-"));
  try {
    const worktree = join(scratch, "a", "wt");
    mkdirSync(join(worktree, "site"), { recursive: true });
    mkdirSync(join(scratch, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(scratch, "node_modules", ".bin", "docker"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
    const log = join(scratch, "gate.log");
    const result = spawnSync("bash", [script, worktree, log, "HEAD", "cli-file", "unused.test.mjs"], { encoding: "utf8", timeout: 30_000, env: wrapperEnv });
    assert.equal(result.status, 3, result.stdout + result.stderr);
    assert.match(result.stderr, /node_modules\/\.bin\/docker would shadow the blocking stand-in/);
    assert.equal(existsSync(log), false, "no gate ran");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("cli-file refuses a site test and an observer test, before running anything", () => {
  // Harmless stand-ins: if the refusal broke, these would run as plain passing tests; no browser could start.
  const scratch = mkdtempSync(join(tmpdir(), "run-gates-control-"));
  try {
    const worktree = join(scratch, "wt");
    mkdirSync(join(worktree, "site", "src"), { recursive: true });
    const harmless = 'import test from "node:test"; test("harmless", () => {});\n';
    writeFileSync(join(worktree, "site", "src", "x.observer.test.mjs"), harmless);
    writeFileSync(join(worktree, "y.observer.test.mjs"), harmless);
    for (const file of ["site/src/x.observer.test.mjs", "y.observer.test.mjs"]) {
      const log = join(scratch, "gate.log");
      const result = spawnSync("bash", [script, worktree, log, "HEAD", "cli-file", file], { encoding: "utf8", timeout: 30_000, env: wrapperEnv });
      assert.equal(result.status, 3, file + "\n" + result.stdout + result.stderr);
      const body = readFileSync(log, "utf8");
      assert.match(body, /refuse: .* is a site or browser test/);
      assert.doesNotMatch(body, /EXIT/);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("a relative worktree path ends the ancestor walk and runs the gate", { timeout: 120_000 }, () => {
  const scratch = mkdtempSync(join(tmpdir(), "run-gates-control-"));
  try {
    const probe = join(scratch, "probe.test.mjs");
    writeFileSync(probe, 'import test from "node:test"; test("ran", () => {});\n');
    const log = join(scratch, "gate.log");
    const result = spawnSync("bash", [script, ".", log, "HEAD", "cli-file", probe], { encoding: "utf8", timeout: 110_000, env: wrapperEnv, cwd: resolve(".") });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(readFileSync(log, "utf8"), /^ℹ pass 1$/m);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("server mode is refused with exit 3 and starts no stack", () => {
  const scratch = mkdtempSync(join(tmpdir(), "run-gates-control-"));
  try {
    const result = spawnSync("bash", [script, resolve("."), join(scratch, "gate.log"), "HEAD", "server"], { encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, 3);
    const body = readFileSync(join(scratch, "gate.log"), "utf8");
    assert.match(body, /refuse: no docker on this host/);
    assert.doesNotMatch(body, /EXIT|supabase start/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
