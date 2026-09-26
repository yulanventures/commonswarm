import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

// scripts/run-gates.sh is the one wrapper every local gate run goes through (2026-09-26 ruling after the home
// deletion). These controls pin what protects the real home: the script never reads $HOME, it runs each gate
// under a temporary HOME it created under /tmp, it refuses an unknown mode, and no gate finds docker through PATH
// (any docker CLI call starts OrbStack on this host; HezLead ruling, 2026-09-26). A test that runs a docker binary by
// absolute path is not covered; none does today.
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
    writeFileSync(join(worktree, "site", "src", "plain.test.mjs"), harmless);
    writeFileSync(join(worktree, "y.observer.test.mjs"), harmless);
    mkdirSync(join(worktree, "tests"));
    symlinkSync(join(worktree, "site", "src", "plain.test.mjs"), join(worktree, "tests", "alias.test.mjs"));
    for (const file of ["site/src/plain.test.mjs", "y.observer.test.mjs", "tests/alias.test.mjs"]) {
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

// p1-cli mode runs only under HezLead's terms (2026-09-26). The controls point the OrbStack probe at a harmless dummy
// process; the wrapper honors that override only for names with the control prefix.
const pressureLevel = spawnSync("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"], { encoding: "utf8" }).stdout?.trim() ?? "";
const p1CliSkip = process.platform !== "darwin" ? "macOS memory-pressure probe only"
  : pressureLevel !== "1" ? `memory pressure level is ${pressureLevel || "unknown"}, and p1-cli mode would refuse` : false;

function fakeP1CliWorktree(scratch: string, command: string): string {
  const worktree = join(scratch, "wt");
  mkdirSync(join(worktree, "site"), { recursive: true });
  writeFileSync(join(worktree, "package.json"), JSON.stringify({ name: "fake", private: true, scripts: { "test:p1-cli": command } }));
  return worktree;
}

function startDummy(name: string) {
  return spawn("bash", ["-c", `exec -a ${name} sleep 60`], { stdio: "ignore" });
}

test("p1-cli mode kills the suite and fails the moment OrbStack appears", { skip: p1CliSkip, timeout: 60_000 }, async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "run-gates-control-"));
  const name = `run-gates-control-orb-${randomBytes(6).toString("hex")}`;
  let dummy: ReturnType<typeof startDummy> | undefined;
  let wrapperProcess: ReturnType<typeof spawn> | undefined;
  try {
    const worktree = fakeP1CliWorktree(scratch, "sleep 40");
    const log = join(scratch, "gate.log");
    const started = Date.now();
    const wrapper = spawn("bash", [script, worktree, log, "HEAD", "p1-cli"], { env: { ...wrapperEnv, RUN_GATES_ORB_PATTERN: name }, stdio: "ignore" });
    wrapperProcess = wrapper;
    const exited = new Promise<number | null>(done => wrapper.on("close", code => done(code)));
    await new Promise(done => setTimeout(done, 2_000));
    dummy = startDummy(name);
    const code = await exited;
    // Pressure is read again by the wrapper; if it rose above 1 since this file loaded, the wrapper refuses (3)
    // before the suite starts, which is its own term working, not a watchdog result.
    if (code === 3 && /^refuse: memory pressure level/m.test(readFileSync(log, "utf8"))) {
      t.skip("memory pressure rose above level 1 after this file loaded; the wrapper refused to start");
      return;
    }
    assert.equal(code, 1);
    assert.ok(Date.now() - started < 30_000, "the suite was stopped, not run to its end");
    const body = readFileSync(log, "utf8");
    assert.match(body, /^memory pressure level 1; OrbStack off; no other run of this wrapper$/m);
    assert.match(body, /^STOPPED: OrbStack appeared during the gate; the gate was killed$/m);
  } finally {
    dummy?.kill("SIGKILL");
    if (wrapperProcess && wrapperProcess.exitCode === null) wrapperProcess.kill("SIGTERM");
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("p1-cli mode refuses to start while OrbStack runs", { skip: p1CliSkip, timeout: 30_000 }, async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "run-gates-control-"));
  const name = `run-gates-control-orb-${randomBytes(6).toString("hex")}`;
  const dummy = startDummy(name);
  try {
    await new Promise(done => setTimeout(done, 500));
    const worktree = fakeP1CliWorktree(scratch, "echo SHOULD-NOT-RUN");
    const log = join(scratch, "gate.log");
    const result = spawnSync("bash", [script, worktree, log, "HEAD", "p1-cli"], { encoding: "utf8", timeout: 25_000, env: { ...wrapperEnv, RUN_GATES_ORB_PATTERN: name } });
    assert.equal(result.status, 3, result.stdout + result.stderr);
    const body = readFileSync(log, "utf8");
    if (/^refuse: memory pressure level/m.test(body)) {
      t.skip("memory pressure rose above level 1 after this file loaded; the wrapper refused before the OrbStack check");
      return;
    }
    assert.match(body, /refuse: OrbStack is running/);
    assert.doesNotMatch(body, /EXIT|SHOULD-NOT-RUN/);
  } finally {
    dummy.kill("SIGKILL");
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("the OrbStack probe always checks the real helper and accepts only a control-prefixed extra name", () => {
  const source = readFileSync(script, "utf8");
  assert.match(source, /case "\$\{RUN_GATES_ORB_PATTERN:-\}" in run-gates-control-orb-\*\) extra_orb=\$RUN_GATES_ORB_PATTERN ;; \*\) extra_orb= ;; esac/);
  // The real probe is unconditional and reads each process's executable path (argv[0]) alone.
  assert.match(source, /orb_running\(\) \{\n  if ps -Ao comm= 2>\/dev\/null \| grep -q '\/OrbStack\\\.app\/' \|\| \{/);
  assert.match(source, /kern\.memorystatus_vm_pressure_level/);
});

// "Another run" excludes this run's own ancestry: a wrapper started inside another wrapper's run (as these controls
// are, inside a p1-cli suite) is part of that run, and so are the outer run's other subshells, such as its watchdog.
// A separate wrapper run, which descends from no wrapper in this run's ancestry, still blocks p1-cli mode.
function wrapperLikeScript(scratch: string, name: string, body: string): string {
  const path = join(scratch, `${name}.sh`);
  writeFileSync(path, body, { mode: 0o755 });
  return path;
}

test("a p1-cli run inside another wrapper's run is not blocked by that run's own subshells", { skip: p1CliSkip, timeout: 60_000 }, async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "run-gates-control-"));
  try {
    const worktree = fakeP1CliWorktree(scratch, "true");
    const log = join(scratch, "gate.log");
    // The outer script's command line matches the wrapper pattern; its "( sleep; true ) &" subshell keeps that same
    // command line, like the real outer wrapper's OrbStack watchdog.
    const outer = wrapperLikeScript(scratch, `run-gates-control-outer-${randomBytes(4).toString("hex")}`, [
      "#!/bin/bash",
      "( sleep 20; true ) &",
      `bash "$1" "$2" "$3" HEAD p1-cli`,
      "rc=$?; kill %1 2>/dev/null; exit $rc",
      "",
    ].join("\n"));
    const result = spawnSync("bash", [outer, script, worktree, log], { encoding: "utf8", timeout: 50_000, env: wrapperEnv });
    const body = readFileSync(log, "utf8");
    if (result.status === 3 && /^refuse: memory pressure level/m.test(body)) {
      t.skip("memory pressure rose above level 1 after this file loaded; the wrapper refused to start");
      return;
    }
    assert.equal(result.status, 0, body + result.stderr);
    assert.doesNotMatch(body, /another run of this wrapper is active/);
    assert.match(body, /^EXIT 0 :: npm run test:p1-cli$/m);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("a separate wrapper run still blocks p1-cli mode", { skip: p1CliSkip, timeout: 60_000 }, async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "run-gates-control-"));
  const name = `run-gates-control-other-${randomBytes(4).toString("hex")}`;
  try {
    const other = wrapperLikeScript(scratch, name, "#!/bin/bash\nsleep 30\n");
    // Detached through an intermediate shell that exits at once: the dummy is re-parented and descends from no
    // wrapper in this run's ancestry, like a wrapper run started from another terminal.
    spawnSync("bash", ["-c", `bash "${other}" arg >/dev/null 2>&1 & disown`], { stdio: "ignore", timeout: 5_000 });
    await new Promise(done => setTimeout(done, 500));
    const worktree = fakeP1CliWorktree(scratch, "echo SHOULD-NOT-RUN");
    const log = join(scratch, "gate.log");
    const result = spawnSync("bash", [script, worktree, log, "HEAD", "p1-cli"], { encoding: "utf8", timeout: 30_000, env: wrapperEnv });
    const body = readFileSync(log, "utf8");
    if (/^refuse: memory pressure level/m.test(body)) {
      t.skip("memory pressure rose above level 1 after this file loaded; the wrapper refused before this check");
      return;
    }
    assert.equal(result.status, 3, body + result.stderr);
    assert.match(body, /^refuse: another run of this wrapper is active:/m);
    assert.match(body, new RegExp(name));
    assert.doesNotMatch(body, /EXIT|SHOULD-NOT-RUN/);
  } finally {
    spawnSync("pkill", ["-f", name], { stdio: "ignore" });
    rmSync(scratch, { recursive: true, force: true });
  }
});

// The OrbStack probe matches an executable inside an OrbStack.app bundle, not text in a command line.
test("a command line that only mentions OrbStack does not stop a p1-cli run", { skip: p1CliSkip, timeout: 60_000 }, async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "run-gates-control-"));
  try {
    // The fake suite's own command line contains the helper's name, as another probe's `pgrep -f` would.
    const worktree = fakeP1CliWorktree(scratch, "bash -c 'sleep 4; : OrbStack Helper decoy'");
    const log = join(scratch, "gate.log");
    const result = spawnSync("bash", [script, worktree, log, "HEAD", "p1-cli"], { encoding: "utf8", timeout: 50_000, env: wrapperEnv });
    const body = readFileSync(log, "utf8");
    if (result.status === 3 && /^refuse: memory pressure level/m.test(body)) {
      t.skip("memory pressure rose above level 1 after this file loaded; the wrapper refused to start");
      return;
    }
    assert.equal(result.status, 0, body + result.stderr);
    assert.doesNotMatch(body, /^STOPPED/m);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("an executable inside an OrbStack.app bundle stops a p1-cli run", { skip: p1CliSkip, timeout: 60_000 }, async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "run-gates-control-"));
  let dummy: ReturnType<typeof spawn> | undefined;
  try {
    const worktree = fakeP1CliWorktree(scratch, "sleep 40");
    const log = join(scratch, "gate.log");
    // A space in the install path must still match (an app under "~/My Apps/" is a valid install).
    const fakeApp = join(scratch, "My Apps", "OrbStack.app", "Contents", "MacOS", "run-gates-control-dummy");
    const wrapper = spawn("bash", [script, worktree, log, "HEAD", "p1-cli"], { env: wrapperEnv, stdio: "ignore" });
    const exited = new Promise<number | null>(done => wrapper.on("close", code => done(code)));
    await new Promise(done => setTimeout(done, 2_000));
    dummy = spawn("bash", ["-c", `exec -a "${fakeApp}" sleep 30`], { stdio: "ignore" });
    const code = await exited;
    const body = readFileSync(log, "utf8");
    if (code === 3 && /^refuse: memory pressure level/m.test(body)) {
      t.skip("memory pressure rose above level 1 after this file loaded; the wrapper refused to start");
      return;
    }
    assert.equal(code, 1, body);
    assert.match(body, /^STOPPED: OrbStack appeared during the gate; the gate was killed$/m);
  } finally {
    dummy?.kill("SIGKILL");
    rmSync(scratch, { recursive: true, force: true });
  }
});
