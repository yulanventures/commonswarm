import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test } from "node:test";

const runner = resolve(process.cwd(), "scripts/run-test-list.mjs");

function withDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "run-test-list-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function run(dir: string, ...args: string[]) {
  // an inherited NODE_TEST_CONTEXT would make the inner node --test behave as a child reporter
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [runner, ...args], { cwd: dir, encoding: "utf8", env });
}

test("run-test-list refuses a missing file and names it", () => {
  withDir((dir) => {
    writeFileSync(join(dir, "a.test.mjs"), "");
    writeFileSync(join(dir, "list.txt"), "a.test.mjs\nnope.test.mjs\n");
    const result = run(dir, "list.txt", "--list-only");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /missing file: nope\.test\.mjs/);
    assert.doesNotMatch(result.stderr, /missing file: a\.test\.mjs/);
  });
});

test("run-test-list refuses a duplicate entry", () => {
  withDir((dir) => {
    writeFileSync(join(dir, "a.test.mjs"), "");
    writeFileSync(join(dir, "list.txt"), "a.test.mjs\na.test.mjs\n");
    const result = run(dir, "list.txt", "--list-only");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /duplicate entry: a\.test\.mjs/);
  });
});

test("run-test-list keeps list order, expands a glob in place and drops repeats", () => {
  withDir((dir) => {
    mkdirSync(join(dir, "sub"));
    for (const f of ["z.test.mjs", "a.test.mjs", "sub/b.test.mjs", "sub/c.test.mjs"]) writeFileSync(join(dir, f), "");
    writeFileSync(join(dir, "list.txt"), "z.test.mjs\nsub/c.test.mjs\nsub/*.test.mjs\na.test.mjs\n");
    const result = run(dir, "list.txt", "--list-only");
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "z.test.mjs\nsub/c.test.mjs\nsub/b.test.mjs\na.test.mjs\n");
  });
});

test("run-test-list skips comments and expands globs in --list-only", () => {
  withDir((dir) => {
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "a.test.mjs"), "");
    writeFileSync(join(dir, "sub", "b.test.mjs"), "");
    writeFileSync(join(dir, "list.txt"), "# note\n\na.test.mjs\nsub/*.test.mjs\n");
    const result = run(dir, "list.txt", "--list-only");
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "a.test.mjs\nsub/b.test.mjs\n");
  });
});

test("run-test-list passes flags through to node --test and propagates failure", () => {
  withDir((dir) => {
    writeFileSync(
      join(dir, "a.test.mjs"),
      'import { test } from "node:test";\ntest("good", () => {});\ntest("bad", () => { throw new Error("boom"); });\n',
    );
    writeFileSync(join(dir, "list.txt"), "a.test.mjs\n");
    // without a flag the failing test fails the run; --test-name-pattern reaches node --test and skips it
    assert.notEqual(run(dir, "list.txt").status, 0);
    assert.equal(run(dir, "list.txt", "--test-name-pattern=good").status, 0);
  });
});

// --- Run-temp ownership matrix -------------------------------------------------
// The runner owns one private TMPDIR root per run. These cases execute the real
// runner CLI against deliberately leaking fixtures under an independently owned
// parent and judge only the filesystem left behind, so deleting the runner's
// cleanup turns them red on the leaked paths. Killing and interrupting cases get
// their own invocations because they terminate the runner's child by design.
// Authoring answers: (1) contract — a completed run leaves none of its owned
// temp tree on pass, failure, runner SIGINT/SIGTERM/SIGHUP, child SIGKILL with a
// still-writing orphan, a synchronous spawn failure, or the real caller's
// TERM-then-2s-KILL escalation against the runner's group while the child tree
// ignores TERM; a replaced run root is refused, never deleted; an unrelated
// canary survives and failure stays nonzero. (2) regressions — skipped finally
// cleanup, signal paths bypassing teardown, delete-before-reap/quiescence,
// orphan recreation after child death, a spawn throw bypassing the outer
// finally, teardown outliving the caller's 2 s grace (fixtures ack allocation
// and their pid before any kill). (3) gap — the cases above never inspected
// leftovers; the box helper covers a different in-process owner. (4) seams —
// none in the runner: real CLI, list/-- interfaces, child env object,
// subprocess fixtures; one fixture uses a private node --import preload only
// as real process input (an env value too large to exec). The caller escalation
// case stops only its verified owned node --test main before forwarding TERM.
// Limits, stated not guaranteed away: runner SIGKILL itself runs no JS cleanup
// (an outer owner covers it), a process that setsids out of the owned group
// escapes group teardown, and a test body still running when its own t.after
// fires (listener-control hook timeout) is a parked follow-up, not covered here.

interface Sandbox {
  work: string;
  parent: string;
  canary: string;
}

async function withSandbox(fn: (sandbox: Sandbox) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "run-test-list-"));
  try {
    const work = join(dir, "work");
    const parent = join(dir, "parent");
    const canary = join(parent, "canary");
    mkdirSync(work);
    mkdirSync(canary, { recursive: true });
    writeFileSync(join(canary, "keep.txt"), "keep\n");
    await fn({ work, parent, canary });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface RunnerResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface RunnerOptions {
  extraEnv?: Record<string, string>;
  // Node flags placed before the runner script (a real --import preload input).
  nodeFlags?: string[];
  // Puts the runner in its own process group, as the gate caller does, so a
  // test can reproduce that caller's group TERM -> 2 s -> group KILL policy.
  detached?: boolean;
}

function startRunner(
  sandbox: Sandbox,
  args: string[],
  options: RunnerOptions = {},
): { child: ChildProcess; done: Promise<RunnerResult> } {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  env.TMPDIR = sandbox.parent;
  env.RTL_CANARY = sandbox.canary;
  Object.assign(env, options.extraEnv ?? {});
  const child = spawn(process.execPath, [...(options.nodeFlags ?? []), runner, ...args], {
    cwd: sandbox.work,
    env,
    detached: options.detached ?? false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const done = new Promise<RunnerResult>((resolveDone) => {
    child.once("close", (status, signal) => resolveDone({ status, signal, stdout, stderr }));
  });
  return { child, done };
}

async function waitForAck(path: string): Promise<string> {
  for (let attempt = 0; attempt < 800; attempt++) {
    if (existsSync(path)) {
      const value = readFileSync(path, "utf8").trim();
      if (value !== "") return value;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`fixture never acknowledged its allocation: ${path}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

// Unconditional teardown for a surviving fixture process a mutated runner failed
// to stop. Only literal pids/groups these fixtures acked or this file spawned
// are ever signalled; ESRCH (already gone) is the expected outcome.
function killOwnedPid(pid: number | undefined): void {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

function killOwnedGroup(pgid: number | undefined): void {
  if (pgid === undefined || !Number.isInteger(pgid) || pgid <= 0) return;
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

async function assertPidDead(pid: number, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    // A killed orphan whose new parent has not reaped it stays in the process
    // table as a zombie and keeps kill(pid, 0) succeeding, on Linux especially.
    // A zombie runs no code, so it counts as dead here. Only the fixture's own
    // acked pid is ever inspected this way.
    if (process.platform === "linux") {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        if (stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z")) return;
      } catch {
        return; // Vanished between the probe and the read.
      }
    }
    await sleep(25);
  }
  assert.fail(`${label} (pid ${pid}) is still alive`);
}

function leakingFixture(ackName: string, fail: boolean): string {
  return [
    'import { test } from "node:test";',
    'import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";',
    'import { tmpdir } from "node:os";',
    'import { join } from "node:path";',
    'test("leaks on purpose", () => {',
    '  const dir = mkdtempSync(join(tmpdir(), "owned-leak-"));',
    '  writeFileSync(join(dir, "data.txt"), "x");',
    '  symlinkSync(process.env.RTL_CANARY, join(dir, "canary-link"), "dir");',
    `  writeFileSync(join(process.cwd(), "${ackName}"), dir);`,
    ...(fail ? ['  throw new Error("deliberate failure");'] : []),
    "});",
    "",
  ].join("\n");
}

function assertCleaned(sandbox: Sandbox, allocated: string): void {
  // The fixture really allocated under the runner-owned root inside our parent.
  assert.equal(dirname(dirname(allocated)), realpathSync(sandbox.parent));
  assert.ok(basename(dirname(allocated)).startsWith("cswarm-test-run-"));
  assert.equal(existsSync(allocated), false, `owned temp dir leaked: ${allocated}`);
  // Only the unrelated canary remains, and the fixture's symlink to it was
  // removed as an entry, never followed.
  assert.deepEqual(readdirSync(sandbox.parent).sort(), ["canary"]);
  assert.equal(readFileSync(join(sandbox.canary, "keep.txt"), "utf8"), "keep\n");
}

test("runner removes its whole run root after leaking pass and fail fixtures in one run", { timeout: 60_000 }, async () => {
  await withSandbox(async (sandbox) => {
    writeFileSync(join(sandbox.work, "pass.test.mjs"), leakingFixture("ack-pass.txt", false));
    writeFileSync(join(sandbox.work, "fail.test.mjs"), leakingFixture("ack-fail.txt", true));
    writeFileSync(
      join(sandbox.work, "clean.test.mjs"),
      'import { test } from "node:test";\ntest("clean", () => {});\n',
    );
    writeFileSync(join(sandbox.work, "list.txt"), "pass.test.mjs\nfail.test.mjs\nclean.test.mjs\n");
    const result = await startRunner(sandbox, ["list.txt"]).done;
    assert.notEqual(result.status, 0, "the failing fixture must keep the run nonzero");
    assertCleaned(sandbox, await waitForAck(join(sandbox.work, "ack-pass.txt")));
    assertCleaned(sandbox, await waitForAck(join(sandbox.work, "ack-fail.txt")));
  });
});

test("runner in -- node-args mode owns the run root too", { timeout: 60_000 }, async () => {
  await withSandbox(async (sandbox) => {
    writeFileSync(join(sandbox.work, "only.test.mjs"), leakingFixture("ack.txt", false));
    const result = await startRunner(sandbox, ["--", "--test-name-pattern=leaks", "only.test.mjs"]).done;
    assert.equal(result.status, 0, result.stderr);
    assertCleaned(sandbox, await waitForAck(join(sandbox.work, "ack.txt")));
  });
});

test("runner --list-only runs nothing and creates no run root", { timeout: 60_000 }, async () => {
  await withSandbox(async (sandbox) => {
    writeFileSync(join(sandbox.work, "a.test.mjs"), "");
    writeFileSync(join(sandbox.work, "list.txt"), "a.test.mjs\n");
    const result = await startRunner(sandbox, ["list.txt", "--list-only"]).done;
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "a.test.mjs\n");
    assert.deepEqual(readdirSync(sandbox.parent).sort(), ["canary"]);
  });
});

const POSIX_ONLY = { skip: process.platform === "win32" };

test("surviving runner stops a still-writing orphan after its node --test child is SIGKILLed", { timeout: 60_000, ...POSIX_ONLY }, async () => {
  await withSandbox(async (sandbox) => {
    // The orphan stays in the runner-owned process group (no setsid of its own)
    // and keeps recreating its allocated directory after the direct child dies.
    // Only the runner's post-close group kill plus quiescence-before-delete can
    // end that; without them the directory reappears after any removal and the
    // heartbeat below keeps growing, so this case goes red on the leftover.
    writeFileSync(
      join(sandbox.work, "orphan.mjs"),
      [
        'import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";',
        'import { join } from "node:path";',
        "const [dir, heartbeat] = process.argv.slice(2);",
        "const tick = () => {",
        "  mkdirSync(dir, { recursive: true });",
        '  writeFileSync(join(dir, "orphan.txt"), "x");',
        '  appendFileSync(heartbeat, "x");',
        "};",
        "tick();",
        "setInterval(tick, 25);",
        "// A deliberate orphan must never outlive the test file itself.",
        "setTimeout(() => process.exit(0), 15_000);",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(sandbox.work, "killed.test.mjs"),
      [
        'import assert from "node:assert/strict";',
        'import { test } from "node:test";',
        'import { spawn } from "node:child_process";',
        'import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";',
        'import { tmpdir } from "node:os";',
        'import { join } from "node:path";',
        'test("acks an orphan that keeps writing, then its test-runner parent dies", async () => {',
        '  const dir = mkdtempSync(join(tmpdir(), "owned-leak-"));',
        '  const orphan = spawn(process.execPath, [join(process.cwd(), "orphan.mjs"), dir, join(process.cwd(), "heartbeat.txt")], { stdio: "ignore" });',
        '  writeFileSync(join(process.cwd(), "ack.txt"), `${dir}\\n${orphan.pid}`);',
        '  const heartbeat = join(process.cwd(), "heartbeat.txt");',
        '  const hasHeartbeat = () => existsSync(heartbeat) && readFileSync(heartbeat, "utf8").length > 0;',
        '  // Do not let runner teardown race the orphan\'s first write.',
        '  for (let attempt = 0; attempt < 200 && !hasHeartbeat(); attempt++) {',
        '    await new Promise((resolveWait) => setTimeout(resolveWait, 25));',
        '  }',
        '  assert.ok(hasHeartbeat(), "orphan did not write its first heartbeat within 5s");',
        '  writeFileSync(join(process.cwd(), "heartbeat-ready.txt"), "ready");',
        '  process.kill(process.ppid, "SIGKILL");',
        "});",
        "",
      ].join("\n"),
    );
    writeFileSync(join(sandbox.work, "list.txt"), "killed.test.mjs\n");
    let orphanPid: number | undefined;
    try {
      const ackPromise = waitForAck(join(sandbox.work, "ack.txt"));
      const result = await startRunner(sandbox, ["list.txt"]).done;
      const ackLines = (await ackPromise).split("\n");
      const allocated = ackLines[0] ?? "";
      orphanPid = Number(ackLines[1]);
      assert.notEqual(allocated, "", "fixture must ack its allocation");
      assert.ok(Number.isInteger(orphanPid) && orphanPid > 0, "fixture must ack its orphan pid");
      assert.notEqual(result.status, 0, "a killed child must keep the run nonzero");
      assert.ok(existsSync(join(sandbox.work, "heartbeat-ready.txt")), "fixture must confirm the first heartbeat before SIGKILL");
      await assertPidDead(orphanPid, "orphan survived runner teardown");
      const heartbeat = join(sandbox.work, "heartbeat.txt");
      const beaten = readFileSync(heartbeat, "utf8").length;
      assert.ok(beaten > 0, "the orphan never wrote, so this case proves nothing");
      // Give a surviving orphan every chance to recreate the tree after the
      // runner finished; a stopped one cannot.
      await sleep(600);
      assert.equal(readFileSync(heartbeat, "utf8").length, beaten, "orphan kept writing after the runner finished");
      assertCleaned(sandbox, allocated);
    } finally {
      // If the runner's group kill is ever removed, the orphan above fails the
      // assertions — and is still stopped here, by its own acked literal pid.
      killOwnedPid(orphanPid);
    }
  });
});

function hangingFixture(): string {
  return [
    'import { test } from "node:test";',
    'import { mkdtempSync, writeFileSync } from "node:fs";',
    'import { tmpdir } from "node:os";',
    'import { join } from "node:path";',
    'test("acks allocation, then hangs", async () => {',
    '  const dir = mkdtempSync(join(tmpdir(), "owned-leak-"));',
    '  writeFileSync(join(process.cwd(), "ack.txt"), dir);',
    "  setTimeout(() => process.exit(0), 20_000);",
    "  await new Promise(() => {});",
    "});",
    "",
  ].join("\n");
}

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  test(`runner cleans up and stays interrupted on ${signal}`, { timeout: 60_000, ...POSIX_ONLY }, async () => {
    await withSandbox(async (sandbox) => {
      writeFileSync(join(sandbox.work, "hang.test.mjs"), hangingFixture());
      writeFileSync(join(sandbox.work, "list.txt"), "hang.test.mjs\n");
      const { child, done } = startRunner(sandbox, ["list.txt"]);
      const allocated = await waitForAck(join(sandbox.work, "ack.txt"));
      child.kill(signal);
      const result = await done;
      assert.ok(
        result.signal === signal || (result.status !== 0 && result.status !== null),
        `interruption must not look like success: status=${result.status} signal=${result.signal}`,
      );
      assertCleaned(sandbox, allocated);
    });
  });
}

test("runner finishes teardown inside the caller's TERM-then-2s-KILL escalation", { timeout: 60_000, ...POSIX_ONLY }, async () => {
  await withSandbox(async (sandbox) => {
    // Reproduces scripts/run-gates.sh: the runner runs in its own gate group;
    // an outside watcher TERMs that group and KILLs it 2 s later. The KILL can
    // reach the runner but not the detached child group the runner created, so
    // the runner must stop a TERM-ignoring tree and remove its root inside 2 s.
    // SIGSTOP prevents the main from running Node's builtin TERM handler.
    // Verify the exact parent/group chain before stopping only that pid, then
    // require a positive stopped-state witness before starting the caller clock.
    // The live worker resumes its captured parent at its existing 15 s cap, so
    // a lost controller cannot leave an indefinitely stopped main behind.
    writeFileSync(
      join(sandbox.work, "stubborn.test.mjs"),
      [
        'import { test } from "node:test";',
        'import { mkdtempSync, writeFileSync } from "node:fs";',
        'import { tmpdir } from "node:os";',
        'import { join } from "node:path";',
        'const mainPid = process.ppid;',
        'process.on("SIGTERM", () => {});',
        'setTimeout(() => {',
        '  try { process.kill(mainPid, "SIGCONT"); } catch {}',
        '  process.exit(0);',
        '}, 15_000);',
        'test("acks allocation and pids, ignores TERM, then hangs", async () => {',
        '  const dir = mkdtempSync(join(tmpdir(), "owned-leak-"));',
        '  writeFileSync(join(process.cwd(), "ack.txt"), `${dir}\\n${process.pid}\\n${mainPid}`);',
        "  await new Promise(() => {});",
        "});",
        "",
      ].join("\n"),
    );
    writeFileSync(join(sandbox.work, "list.txt"), "stubborn.test.mjs\n");
    const { child, done } = startRunner(sandbox, ["list.txt"], {
      detached: true,
    });
    let fixturePid: number | undefined;
    let mainPid: number | undefined;
    let callerKilled = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    try {
      const ackLines = (await waitForAck(join(sandbox.work, "ack.txt"))).split("\n");
      const allocated = ackLines[0] ?? "";
      const ackFixturePid = Number(ackLines[1]);
      // The fixture ack's third line is its ppid: the literal node --test main
      // pid, which is also the pgid of the group the runner created for it
      // (the runner spawns that main detached). Owned identity only.
      const ackMainPid = Number(ackLines[2]);
      assert.notEqual(allocated, "", "fixture must ack its allocation");
      const gatePgid = child.pid;
      assert.ok(gatePgid !== undefined && gatePgid > 1, "runner must have a pid to signal its gate group");
      for (const pid of [ackMainPid, ackFixturePid]) {
        assert.ok(Number.isSafeInteger(pid) && pid > 1, "fixture must ack positive owned pids");
        assert.ok(![process.pid, process.ppid, gatePgid].includes(pid), "fixture must not identify the controller or runner");
      }
      assert.notEqual(ackMainPid, ackFixturePid, "main and fixture pids must differ");
      // macOS and Linux ps: only these known pids, identity/status columns only.
      // A missing, refused, timed-out or malformed probe fails before SIGSTOP.
      const inspect = (pid: number) => {
        const probe = spawnSync("ps", ["-p", String(pid), "-o", "pid=,ppid=,pgid=,state="], {
          encoding: "utf8", timeout: 500,
        });
        assert.ifError(probe.error);
        assert.equal(probe.status, 0, `owned pid ${pid} status probe failed`);
        const rows = probe.stdout.trim().split(/\r?\n/);
        assert.equal(rows.length, 1, "status probe must return exactly the requested pid");
        const parts = rows[0].trim().split(/\s+/);
        assert.equal(parts.length, 4, "status probe must contain only pid/ppid/pgid/state");
        assert.equal(Number(parts[0]), pid, "status probe returned the wrong pid");
        assert.ok(parts.slice(0, 3).every((part) => /^[1-9][0-9]*$/.test(part)), "invalid process identity");
        assert.match(parts[3], /^[A-Za-z][A-Za-z0-9+<>=-]*$/, "invalid process state");
        return { ppid: Number(parts[1]), pgid: Number(parts[2]), state: parts[3] };
      };
      const controller = inspect(process.pid);
      const gate = inspect(gatePgid);
      const main = inspect(ackMainPid);
      const fixture = inspect(ackFixturePid);
      assert.equal(gate.ppid, process.pid, "runner must be this controller's direct child");
      assert.equal(gate.pgid, gatePgid, "runner must lead its detached gate group");
      assert.equal(main.ppid, gatePgid, "acked main must be the runner's direct child");
      assert.equal(main.pgid, ackMainPid, "acked main must lead the runner's detached child group");
      assert.notEqual(main.pgid, controller.pgid, "main must not be in the controller's group");
      assert.equal(fixture.ppid, ackMainPid, "fixture must belong to the acked main");
      assert.equal(fixture.pgid, ackMainPid, "fixture must belong to the exact owned child group");
      assert.doesNotMatch(main.state, /^[TZ]/i, "main must be live before SIGSTOP");
      assert.doesNotMatch(fixture.state, /^[TZ]/i, "fixture must stay live to enforce its cap");
      // Cleanup identities become usable only after the ownership checks pass.
      mainPid = ackMainPid;
      fixturePid = ackFixturePid;
      process.kill(mainPid, "SIGSTOP");
      const stopDeadline = Date.now() + 2_000;
      while (true) {
        const stopped = inspect(mainPid);
        assert.equal(stopped.ppid, gatePgid, "stopped main changed parent");
        assert.equal(stopped.pgid, mainPid, "stopped main changed group");
        if (/^T/i.test(stopped.state)) break;
        assert.ok(Date.now() < stopDeadline, "owned main never acknowledged stopped state");
        await sleep(25);
      }
      // The watcher stands outside the gate group, exactly as in run-gates.sh.
      process.kill(-gatePgid, "SIGTERM");
      escalation = setTimeout(() => {
        callerKilled = true;
        killOwnedGroup(gatePgid);
      }, 2_000);
      const result = await done;
      assert.equal(callerKilled, false, "runner teardown outlived the caller's 2 s grace and had to be KILLed");
      assert.ok(
        result.signal === "SIGTERM" || (result.status !== 0 && result.status !== null),
        `interruption must not look like success: status=${result.status} signal=${result.signal}`,
      );
      await assertPidDead(mainPid, "SIGSTOPped node --test main survived runner teardown");
      await assertPidDead(fixturePid, "TERM-ignoring fixture survived runner teardown");
      assertCleaned(sandbox, allocated);
    } finally {
      if (escalation) clearTimeout(escalation);
      // Owned survivors only: the gate group this test created, the acked
      // node --test main pid and its group (its tree lives in a different
      // group than the gate group, so it survives a caller-killed runner —
      // the 5 s-grace mutant — unless stopped here), and the fixture pid.
      killOwnedGroup(child.pid);
      killOwnedGroup(mainPid);
      killOwnedPid(mainPid);
      killOwnedPid(fixturePid);
    }
  });
});

test("runner cleans up when spawning its child throws synchronously (E2BIG)", { timeout: 60_000, ...POSIX_ONLY }, async () => {
  await withSandbox(async (sandbox) => {
    // A private preload, imported only by the runner process, inflates one
    // synthetic env value after the runner has exec'd, so the outer spawn stays
    // small while the runner's own spawn of node --test hits the real exec
    // limit. On Linux and macOS libuv reports that as a synchronous E2BIG throw
    // from spawn(), not an 'error' event; the outer finally must still remove
    // the run root. No env contents are printed or asserted on.
    writeFileSync(
      join(sandbox.work, "inflate-env.mjs"),
      'process.env.RTL_SYNTHETIC_BIG = "x".repeat(4 * 1024 * 1024);\n',
    );
    writeFileSync(
      join(sandbox.work, "never-runs.test.mjs"),
      'import { test } from "node:test";\ntest("never reached", () => {});\n',
    );
    writeFileSync(join(sandbox.work, "list.txt"), "never-runs.test.mjs\n");
    const result = await startRunner(sandbox, ["list.txt"], {
      nodeFlags: ["--import", join(sandbox.work, "inflate-env.mjs")],
    }).done;
    assert.ok(result.status !== 0 && result.status !== null, "a spawn failure must stay nonzero");
    // The owned parent was inspected from outside the runner: no leaked
    // cswarm-test-run-* root, and the unrelated canary is intact.
    assert.deepEqual(readdirSync(sandbox.parent).sort(), ["canary"]);
    assert.equal(readFileSync(join(sandbox.canary, "keep.txt"), "utf8"), "keep\n");
  });
});

function rootSwapFixture(mode: "symlink" | "directory"): string {
  return [
    'import { test } from "node:test";',
    'import { mkdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";',
    'import { tmpdir } from "node:os";',
    'import { dirname, join } from "node:path";',
    'test("replaces its own run root before finishing", () => {',
    "  const root = tmpdir();",
    '  writeFileSync(join(process.cwd(), "ack.txt"), root);',
    '  renameSync(root, join(dirname(root), "moved-root"));',
    ...(mode === "symlink"
      ? ['  symlinkSync(process.env.RTL_CANARY, root, "dir");']
      : [
          "  mkdirSync(root);",
          '  writeFileSync(join(root, "fixture-canary.txt"), "fixture\\n");',
        ]),
    "});",
    "",
  ].join("\n");
}

for (const mode of ["symlink", "directory"] as const) {
  test(`runner refuses to delete a run root replaced by a ${mode}`, { timeout: 60_000, ...POSIX_ONLY }, async () => {
    await withSandbox(async (sandbox) => {
      writeFileSync(join(sandbox.work, "swap.test.mjs"), rootSwapFixture(mode));
      writeFileSync(join(sandbox.work, "list.txt"), "swap.test.mjs\n");
      const result = await startRunner(sandbox, ["list.txt"]).done;
      const root = await waitForAck(join(sandbox.work, "ack.txt"));
      assert.equal(dirname(root), realpathSync(sandbox.parent));
      // The fixture itself passed, so the nonzero can only be the guard refusal.
      assert.ok(result.status !== 0 && result.status !== null, "guard refusal must make the run nonzero");
      assert.match(result.stderr, /cleanup failed/);
      // The replacement and the renamed original are both retained, untouched.
      if (mode === "symlink") {
        assert.ok(lstatSync(root).isSymbolicLink(), "replacement symlink must be retained");
        assert.equal(readlinkSync(root), sandbox.canary);
      } else {
        assert.ok(lstatSync(root).isDirectory(), "replacement directory must be retained");
        assert.equal(readFileSync(join(root, "fixture-canary.txt"), "utf8"), "fixture\n");
      }
      assert.ok(lstatSync(join(sandbox.parent, "moved-root")).isDirectory(), "renamed original must be retained");
      assert.equal(readFileSync(join(sandbox.canary, "keep.txt"), "utf8"), "keep\n");
    });
  });
}
