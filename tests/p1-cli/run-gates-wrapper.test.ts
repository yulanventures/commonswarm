import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
      "",
    ].join("\n"));
    const log = join(scratch, "gate.log");
    const result = spawnSync("bash", [script, resolve("."), log, "HEAD", "cli-file", probe], { encoding: "utf8", timeout: 110_000, env: wrapperEnv });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const body = readFileSync(log, "utf8");
    assert.match(body, /EXIT 0 :: npx tsx --test/);
    assert.match(body, /^ℹ pass 1$/m, "the probe really ran");
    assert.match(body, /^NOT RUN on this host \(docker blocked\): 1 blocked calls/m);
    assert.match(body, /^  blocked: docker version --format probe$/m);
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
