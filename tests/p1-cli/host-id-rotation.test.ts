import assert from "node:assert/strict";
import { link, mkdtemp, mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { spawn, execFileSync } from "node:child_process";
import { arrivalHostId } from "../../src/cloud/arrival-watch.js";
import { FileLockTimeoutError, HOST_ID_LOCK_INCOMPLETE_GRACE_MS, fileLockTimeoutSentence, pidStartMs, readSecureJsonFile, withFileLock } from "../../src/cloud/storage.js";
import { listenerPaths, runListenerSupervisor } from "../../src/listener/index.js";

const AGED_LOCK_MS = 61_000;

test("secure JSON read rejects a 0755 parent without changing it", { timeout: 2_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-read-mode-"));
  try {
    await writeFile(join(root, "record.json"), "{}", { mode: 0o600 });
    await import("node:fs/promises").then(fs => fs.chmod(root, 0o755));
    await assert.rejects(readSecureJsonFile(join(root, "record.json"), 100), /mode 0700/);
    assert.equal((await stat(root)).mode & 0o777, 0o755);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("concurrent copied host-id rotations return the id kept in the file", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-host-id-rotation-"));
  const lockPath = join(root, "seat.lock");
  const path = join(root, "host-id");
  const machineHash = "a".repeat(64);
  try {
    await writeFile(path, `${JSON.stringify({ host_id: "11111111-1111-4111-8111-111111111111",
      machine_hash: "b".repeat(64) })}\n`, { mode: 0o600 });
    let finished = false;
    let pending!: Promise<string>;
    await withFileLock(root, "host-id-rotation", async () => {
      pending = arrivalHostId(lockPath, machineHash).then(id => { finished = true; return id; });
      await new Promise(done => setTimeout(done, 150));
      assert.equal(finished, false, "rotation must wait for the shared file lock");
    });
    const first = await pending;
    const concurrent = await Promise.all(Array.from({ length: 30 }, () => arrivalHostId(lockPath, machineHash)));
    const persisted = JSON.parse(await readFile(path, "utf8")) as { host_id: string; machine_hash: string };
    assert.equal(persisted.machine_hash, machineHash);
    assert.notEqual(persisted.host_id, "11111111-1111-4111-8111-111111111111");
    assert.deepEqual([first, ...concurrent], Array(31).fill(persisted.host_id));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("host-id rotation takes over each stale owner without a thirty-second wait", { timeout: 9_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-host-lock-stale-"));
  const lockPath = join(root, "host-id-rotation.lock");
  const cases = [
    ["dead pid", JSON.stringify({ pid: 999_999_999, host: hostname(), createdAt: Date.now(), startTime: Date.now() })],
    ["foreign host", JSON.stringify({ pid: process.pid, host: "other-host", createdAt: Date.now(), startTime: Date.now() })],
    ["empty", ""],
    ["old incomplete", JSON.stringify({ pid: process.pid, host: hostname(), createdAt: Date.now() - HOST_ID_LOCK_INCOMPLETE_GRACE_MS - 1_000 })],
  ] as const;
  try {
    for (const [name, record] of cases) {
      await writeFile(lockPath, record, { mode: 0o600 });
      if (name === "old incomplete") {
        const old = new Date(Date.now() - HOST_ID_LOCK_INCOMPLETE_GRACE_MS - 1_000);
        await utimes(lockPath, old, old);
      }
      const start = Date.now();
      const id = await arrivalHostId(join(root, "seat.lock"), "a".repeat(64));
      assert.match(id, /^[0-9a-f-]{36}$/);
      assert.ok(Date.now() - start < 3_000, `${name} held the rotation lock`);
      await rm(lockPath, { force: true });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a live host-id lock times out with its own name", { timeout: 2_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-host-lock-live-"));
  try {
    await writeFile(join(root, "host-id-rotation.lock"),
      JSON.stringify({ pid: process.pid, host: hostname(), createdAt: Date.now() }), { mode: 0o600 });
    await assert.rejects(withFileLock(root, "host-id-rotation", async () => undefined,
      { stalePolicy: "host-id", timeoutMs: 50 }), error => {
      assert.ok(error instanceof FileLockTimeoutError);
      assert.match(error.message, /host-id rotation lock/);
      assert.match(error.message, new RegExp(`owner pid ${process.pid}`));
      assert.match(error.message, new RegExp(root));
      assert.match(error.message, /If its owner is gone, remove that lock file with rm -- '.*' and retry/);
      assert.doesNotMatch(error.message, /credential refresh lock/);
      return true;
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("host-id lock publishes a complete private owner and does not rotate twice", { timeout: 8_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-host-lock-atomic-"));
  const lockPath = join(root, "host-id-rotation.lock");
  let release!: () => void;
  const blocked = new Promise<void>(done => { release = done; });
  try {
    const first = withFileLock(root, "host-id-rotation", async () => { await blocked; }, { stalePolicy: "host-id" });
    const deadline = Date.now() + 2_000;
    let raw = "";
    while (!raw && Date.now() < deadline) {
      raw = await readFile(lockPath, "utf8").catch(() => "");
      if (!raw) await new Promise(done => setTimeout(done, 10));
    }
    const owner = JSON.parse(raw) as { pid: number; host: string; startTime: number };
    assert.equal(owner.pid, process.pid);
    assert.equal(owner.host, hostname());
    assert.ok(owner.startTime > 0);
    const second = withFileLock(root, "host-id-rotation", async () => "second",
      { stalePolicy: "host-id", timeoutMs: 150 });
    await assert.rejects(second, FileLockTimeoutError);
    release();
    await first;
    assert.equal(await withFileLock(root, "host-id-rotation", async () => "next", { stalePolicy: "host-id" }), "next");
  } finally { release(); await rm(root, { recursive: true, force: true }); }
});

test("host-id lock distinguishes pid reuse, incomplete records, and EPERM", { timeout: 8_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-host-lock-probes-"));
  const path = join(root, "host-id-rotation.lock");
  const startTime = Date.now() - process.uptime() * 1_000;
  try {
    await writeFile(path, JSON.stringify({ pid: process.pid, host: hostname(), createdAt: Date.now(),
      startTime: startTime - 10_000 }), { mode: 0o600 });
    assert.equal(await withFileLock(root, "host-id-rotation", async () => "reused", { stalePolicy: "host-id", timeoutMs: 500 }), "reused");
    await writeFile(path, "{broken", { mode: 0o600 });
    await assert.rejects(withFileLock(root, "host-id-rotation", async () => "wrong",
      { stalePolicy: "host-id", timeoutMs: 70 }), FileLockTimeoutError);
    const old = new Date(Date.now() - HOST_ID_LOCK_INCOMPLETE_GRACE_MS - 100);
    await utimes(path, old, old);
    assert.equal(await withFileLock(root, "host-id-rotation", async () => "recovered",
      { stalePolicy: "host-id", timeoutMs: 500 }), "recovered");
    const probe = process.kill;
    const otherPid = 999_999_998;
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === otherPid && signal === 0) throw Object.assign(new Error("permission"), { code: "EPERM" });
      return probe(pid, signal);
    }) as typeof process.kill;
    try {
      await writeFile(path, JSON.stringify({ pid: otherPid, host: hostname(), createdAt: Date.now(),
        startTime }), { mode: 0o600 });
      await assert.rejects(withFileLock(root, "host-id-rotation", async () => "wrong",
        { stalePolicy: "host-id", timeoutMs: 70 }), FileLockTimeoutError);
    } finally { process.kill = probe; }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an uninspectable live pid stays protected past 60 seconds; a dead pid is reclaimed", { timeout: 5_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-unknown-pid-"));
  const lock = join(root, "host-id-rotation.lock");
  const gate = `${lock}.reclaim`;
  const fakePid = 999_999_997;
  let denied = true;
  const originalKill = process.kill;
  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    if (pid === fakePid && signal === 0 && denied) throw Object.assign(new Error("denied"), { code: "EPERM" });
    return originalKill(pid, signal);
  }) as typeof process.kill;
  const clock = Date.now;
  try {
    const record = (createdAt: number) => JSON.stringify({ pid: fakePid, host: hostname(),
      createdAt, startTime: createdAt, ownerId: "old" });
    await writeFile(lock, record(Date.now()), { mode: 0o600 });
    await assert.rejects(withFileLock(root, "host-id-rotation", async () => undefined,
      { stalePolicy: "host-id", timeoutMs: 70 }), FileLockTimeoutError);
    Date.now = () => clock() + AGED_LOCK_MS;
    await assert.rejects(withFileLock(root, "host-id-rotation", async () => undefined,
      { stalePolicy: "host-id", timeoutMs: 70 }), FileLockTimeoutError);
    denied = false;
    await withFileLock(root, "host-id-rotation", async () => undefined,
      { stalePolicy: "host-id", timeoutMs: 700 });
    Date.now = clock;
    denied = true;
    await writeFile(lock, record(Date.now()));
    await mkdir(gate, { mode: 0o700 });
    await writeFile(join(gate, "owner.json"), record(Date.now()));
    await assert.rejects(withFileLock(root, "host-id-rotation", async () => undefined,
      { stalePolicy: "host-id", timeoutMs: 70 }), FileLockTimeoutError);
    Date.now = () => clock() + AGED_LOCK_MS;
    await assert.rejects(withFileLock(root, "host-id-rotation", async () => undefined,
      { stalePolicy: "host-id", timeoutMs: 70 }), FileLockTimeoutError);
    denied = false;
    await withFileLock(root, "host-id-rotation", async () => undefined,
      { stalePolicy: "host-id", timeoutMs: 700 });
    await assert.rejects(stat(gate), { code: "ENOENT" });
  } finally { Date.now = clock; process.kill = originalKill; await rm(root, { recursive: true, force: true }); }
});

test("reclaim gate timeout names its directory and the directory removal step", { timeout: 2_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-gate-copy-"));
  const lock = join(root, "host-id-rotation.lock");
  const gate = `${lock}.reclaim`;
  try {
    await writeFile(lock, JSON.stringify({ pid: 999_999_999, host: hostname(),
      createdAt: Date.now(), startTime: Date.now() }));
    await mkdir(gate);
    await writeFile(join(gate, "owner.json"), JSON.stringify({ pid: process.pid, host: hostname(),
      createdAt: Date.now(), startTime: pidStartMs(process.pid), ownerId: "live" }));
    await assert.rejects(withFileLock(root, "host-id-rotation", async () => undefined,
      { stalePolicy: "host-id", timeoutMs: 70 }), error => {
      assert.ok(error instanceof FileLockTimeoutError);
      assert.match(error.message, /host-id reclaim gate directory/);
      assert.ok(error.message.includes(gate));
      assert.match(error.message, /remove that directory with rm -r -- '.*\.reclaim' and retry/);
      return true;
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("one timeout builder names each lock or gate, its path, and an ownerless removal step", { timeout: 1_000 }, () => {
  const cases = [
    ["host-id-rotation", false, /host-id rotation lock/],
    ["a".repeat(24), false, /credential refresh lock/],
    [`watch-takeover-${"b".repeat(24)}`, false, /watch-takeover-.* lock/],
    ["host-id-rotation", true, /host-id reclaim gate directory/],
    ["check", true, /check reclaim gate directory/],
    ["seat", false, /seat lock/],
  ] as const;
  for (const [name, gate, label] of cases) {
    const path = `/tmp/${name}${gate ? ".reclaim" : ".lock"}`;
    const sentence = fileLockTimeoutSentence(name, path, undefined, gate);
    assert.match(sentence, label);
    assert.ok(sentence.includes(path));
    assert.match(sentence, /No live owner was identified/);
    assert.ok(sentence.includes(`rm ${gate ? "-r " : ""}-- '${path}'`));
    if (!/^[0-9a-f]{24}$/.test(name)) assert.doesNotMatch(sentence, /credential refresh lock/);
  }
});

test("two stale-lock contenders rotate once", { timeout: 8_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-stale-race-"));
  const machineHash = "a".repeat(64);
  try {
    await writeFile(join(root, "host-id"), JSON.stringify({ host_id: "11111111-1111-4111-8111-111111111111",
      machine_hash: "b".repeat(64) }), { mode: 0o600 });
    await writeFile(join(root, "host-id-rotation.lock"), JSON.stringify({ pid: 999_999_999, host: hostname(),
      createdAt: Date.now(), startTime: Date.now() }), { mode: 0o600 });
    const results = await Promise.all([arrivalHostId(join(root, "seat.lock"), machineHash),
      arrivalHostId(join(root, "seat.lock"), machineHash)]);
    const persisted = JSON.parse(await readFile(join(root, "host-id"), "utf8")) as { host_id: string };
    assert.deepEqual(results, [persisted.host_id, persisted.host_id]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("stale reclaim preserves a second contender published after the stale decision", { timeout: 4_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-stale-publish-"));
  const lockPath = join(root, "host-id-rotation.lock");
  const fresh = JSON.stringify({ pid: process.pid, host: hostname(), createdAt: Date.now(),
    startTime: pidStartMs(process.pid), ownerId: "new-contender" });
  try {
    await writeFile(lockPath, JSON.stringify({ pid: 999_999_999, host: hostname(),
      createdAt: Date.now(), startTime: Date.now(), ownerId: "dead" }), { mode: 0o600 });
    await assert.rejects(withFileLock(root, "host-id-rotation", async () => "wrong", {
      stalePolicy: "host-id", timeoutMs: 500, onBeforeStaleMove: async () => {
        const temp = `${lockPath}.fresh`;
        await writeFile(temp, fresh, { mode: 0o600 });
        await rename(temp, lockPath);
      },
    }), /owner changed during stale takeover/);
    assert.equal(await readFile(lockPath, "utf8"), fresh);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("dead reclaim gate is recovered and a live gate obeys its deadline", { timeout: 6_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-stale-gate-"));
  const lockPath = join(root, "host-id-rotation.lock");
  const gate = `${lockPath}.reclaim`;
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    assert.ok(child.pid);
    await writeFile(lockPath, JSON.stringify({ pid: 999_999_999, host: hostname(),
      createdAt: Date.now(), startTime: Date.now(), ownerId: "dead" }), { mode: 0o600 });
    await mkdir(gate);
    const owner = { pid: child.pid, host: hostname(), startTime: Date.now(), ownerId: "gate" };
    await writeFile(join(gate, "owner.json"), JSON.stringify(owner), { mode: 0o600 });
    await assert.rejects(withFileLock(root, "host-id-rotation", async () => "wrong",
      { stalePolicy: "host-id", timeoutMs: 150 }), error => {
      assert.ok(error instanceof FileLockTimeoutError);
      assert.match(error.message, /\.reclaim/);
      assert.match(error.message, new RegExp(`owner pid ${child.pid}`));
      return true;
    });
    child.kill("SIGKILL");
    await new Promise<void>(resolve => child.once("close", () => resolve()));
    assert.equal(await withFileLock(root, "host-id-rotation", async () => "recovered",
      { stalePolicy: "host-id", timeoutMs: 1_000 }), "recovered");
    await assert.rejects(stat(gate), { code: "ENOENT" });
  } finally {
    child.kill("SIGKILL");
    if (child.exitCode === null && child.signalCode === null) await new Promise<void>(resolve => child.once("close", () => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("a killed gate publisher leaves a reclaim temp that the next owner removes", { timeout: 8_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-gate-atomic-"));
  const lock = join(root, "host-id-rotation.lock");
  const gate = `${lock}.reclaim`;
  let child: ReturnType<typeof spawn> | null = null;
  try {
    await writeFile(lock, JSON.stringify({ pid: 999_999_999, host: hostname(), createdAt: Date.now(), startTime: Date.now() }), { mode: 0o600 });
    child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
      `import { withFileLock } from './src/cloud/storage.ts';
       await withFileLock(process.argv[1], 'host-id-rotation', async () => {}, {
         stalePolicy: 'host-id', onBeforeGatePublish: async () => {
           process.stdout.write('ready\\n'); await new Promise(() => {});
         },
       });`, root], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    await new Promise<void>((resolve, reject) => {
      child!.stdout!.once("data", () => resolve());
      child!.once("error", reject);
      child!.once("close", code => reject(new Error(`gate child exited before crash probe: ${code}`)));
    });
    await assert.rejects(stat(gate), { code: "ENOENT" });
    assert.equal((await readdir(root)).filter(name => name.includes(".reclaim.") && name.endsWith(".tmp")).length, 1);
    child.kill("SIGKILL");
    await new Promise<void>(resolve => child!.once("close", () => resolve()));
    await withFileLock(root, "host-id-rotation", async () => undefined, { stalePolicy: "host-id", timeoutMs: 500 });
    assert.equal((await readdir(root)).filter(name => name.includes(".reclaim.") && name.endsWith(".tmp")).length, 0);
  } finally {
    if (child?.exitCode === null && child?.signalCode === null) {
      child.kill("SIGKILL");
      await new Promise<void>(resolve => child!.once("close", () => resolve()));
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("empty, partial, and foreign reclaim gates recover after two-second grace", { timeout: 4_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-gate-grace-"));
  const lock = join(root, "host-id-rotation.lock");
  const gate = `${lock}.reclaim`;
  const clock = Date.now;
  try {
    for (const owner of [null, "{partial", JSON.stringify({ pid: process.pid, host: "foreign-host", startTime: Date.now(), ownerId: "foreign" })]) {
      await writeFile(lock, JSON.stringify({ pid: 999_999_999, host: hostname(), createdAt: Date.now(), startTime: Date.now() }), { mode: 0o600 });
      await mkdir(gate, { mode: 0o700 });
      if (owner !== null) await writeFile(join(gate, "owner.json"), owner, { mode: 0o600 });
      await assert.rejects(withFileLock(root, "host-id-rotation", async () => undefined,
        { stalePolicy: "host-id", timeoutMs: 80 }), FileLockTimeoutError);
      Date.now = () => clock() + HOST_ID_LOCK_INCOMPLETE_GRACE_MS + 100;
      await withFileLock(root, "host-id-rotation", async () => undefined, { stalePolicy: "host-id", timeoutMs: 600 });
      Date.now = clock;
      await assert.rejects(stat(gate), { code: "ENOENT" });
    }
  } finally { Date.now = clock; await rm(root, { recursive: true, force: true }); }
});

test("three contenders inspect a live gate in place without moving it", { timeout: 3_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-three-gates-"));
  const lock = join(root, "host-id-rotation.lock");
  const gate = `${lock}.reclaim`;
  try {
    await writeFile(lock, JSON.stringify({ pid: 999_999_999, host: hostname(),
      createdAt: Date.now(), startTime: Date.now() }));
    await mkdir(gate);
    const owner = JSON.stringify({ pid: process.pid, host: hostname(),
      createdAt: Date.now(), startTime: pidStartMs(process.pid), ownerId: "live" });
    await writeFile(join(gate, "owner.json"), owner);
    const old = new Date(Date.now() - HOST_ID_LOCK_INCOMPLETE_GRACE_MS - 500);
    await utimes(gate, old, old);
    const inode = (await stat(gate)).ino;
    let entered = 0;
    const outcomes = await Promise.allSettled(Array.from({ length: 3 }, () =>
      withFileLock(root, "host-id-rotation", async () => { entered++; },
        { stalePolicy: "host-id", timeoutMs: 100 })));
    assert.equal(entered, 0);
    assert.ok(outcomes.every(result => result.status === "rejected" && result.reason instanceof FileLockTimeoutError));
    assert.equal((await stat(gate)).ino, inode);
    assert.equal(await readFile(join(gate, "owner.json"), "utf8"), owner);
    assert.equal((await readdir(root)).filter(name => name.includes(".reclaim.")).length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("released and replaced gate is not mistaken for the first inode", { timeout: 3_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-gate-replace-stat-"));
  const lock = join(root, "host-id-rotation.lock");
  const gate = `${lock}.reclaim`;
  const clock = Date.now;
  try {
    await writeFile(lock, JSON.stringify({ pid: 999_999_999, host: hostname(),
      createdAt: Date.now(), startTime: Date.now() }));
    await mkdir(gate);
    Date.now = () => clock() + HOST_ID_LOCK_INCOMPLETE_GRACE_MS + 500;
    let replaced = false;
    await assert.rejects(withFileLock(root, "host-id-rotation", async () => "wrong", {
      stalePolicy: "host-id", timeoutMs: 150, onAfterGateStat: async () => {
        if (replaced) return;
        replaced = true;
        await rm(gate, { recursive: true, force: true });
        await mkdir(gate);
        await new Promise(resolve => setTimeout(resolve, 180));
      },
    }), FileLockTimeoutError);
    assert.equal(replaced, true);
    assert.ok((await stat(gate)).isDirectory(), "the replacement gate stays at its path");
  } finally { Date.now = clock; await rm(root, { recursive: true, force: true }); }
});

test("a complete replacement gate is judged by its own id and publication time", { timeout: 3_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-complete-gate-replace-"));
  const lock = join(root, "host-id-rotation.lock");
  const gate = `${lock}.reclaim`;
  try {
    await writeFile(lock, JSON.stringify({ pid: 999_999_999, host: hostname(),
      createdAt: Date.now(), startTime: Date.now(), ownerId: "dead" }));
    await mkdir(gate);
    await writeFile(join(gate, "owner.json"), JSON.stringify({ pid: 999_999_998, host: hostname(),
      createdAt: Date.now(), startTime: Date.now(), ownerId: "first" }));
    const replacement = JSON.stringify({ pid: 999_999_997, host: hostname(),
      createdAt: Date.now(), startTime: Date.now(), ownerId: "second" });
    let replaced = false;
    await assert.rejects(withFileLock(root, "host-id-rotation", async () => "wrong", {
      stalePolicy: "host-id", timeoutMs: 150, onAfterGateStat: async () => {
        if (replaced) return;
        replaced = true;
        await rm(gate, { recursive: true, force: true });
        await mkdir(gate);
        await writeFile(join(gate, "owner.json"), replacement);
        await new Promise(resolve => setTimeout(resolve, 180));
      },
    }), FileLockTimeoutError);
    assert.equal(replaced, true);
    assert.equal(await readFile(join(gate, "owner.json"), "utf8"), replacement);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("gate owner id changes are detected even when the directory inode is unchanged", { timeout: 3_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-gate-id-replace-"));
  const lock = join(root, "host-id-rotation.lock");
  const gate = `${lock}.reclaim`;
  try {
    await writeFile(lock, JSON.stringify({ pid: 999_999_999, host: hostname(),
      createdAt: Date.now(), startTime: Date.now(), ownerId: "dead-lock" }));
    await mkdir(gate);
    const ownerPath = join(gate, "owner.json");
    await writeFile(ownerPath, JSON.stringify({ pid: 999_999_998, host: hostname(),
      startTime: Date.now(), ownerId: "first" }));
    const ino = (await stat(gate)).ino;
    const replacement = JSON.stringify({ pid: 999_999_997, host: hostname(),
      startTime: Date.now(), ownerId: "second" });
    let replaced = false;
    await assert.rejects(withFileLock(root, "host-id-rotation", async () => "wrong", {
      stalePolicy: "host-id", timeoutMs: 150, onAfterGateStat: async () => {
        if (replaced) return;
        replaced = true;
        await writeFile(ownerPath, replacement);
        await new Promise(resolve => setTimeout(resolve, 180));
      },
    }), FileLockTimeoutError);
    assert.equal(replaced, true);
    assert.equal((await stat(gate)).ino, ino);
    assert.equal(await readFile(ownerPath, "utf8"), replacement);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a gate's maximum hold starts at rename publication", { timeout: 3_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-gate-publication-"));
  const lock = join(root, "host-id-rotation.lock");
  const gate = `${lock}.reclaim`;
  const fakePid = 999_999_997;
  let atPublishedGate!: () => void;
  let release!: () => void;
  const publishedGate = new Promise<void>(resolve => { atPublishedGate = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const originalKill = process.kill;
  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    if (pid === fakePid && signal === 0) throw Object.assign(new Error("denied"), { code: "EPERM" });
    return originalKill(pid, signal);
  }) as typeof process.kill;
  try {
    await writeFile(lock, JSON.stringify({ pid: 999_999_999, host: hostname(),
      createdAt: Date.now(), startTime: Date.now() }));
    const publisher = withFileLock(root, "host-id-rotation", async () => undefined, {
      stalePolicy: "host-id", timeoutMs: 2_000,
      onBeforeGatePublish: async () => {
        const temp = (await readdir(root)).find(name => name.includes(".reclaim.") && name.endsWith(".tmp"));
        assert.ok(temp);
        const ownerPath = join(root, temp, "owner.json");
        const owner = JSON.parse(await readFile(ownerPath, "utf8"));
        await writeFile(ownerPath, JSON.stringify({ ...owner, pid: fakePid,
          createdAt: Date.now() - AGED_LOCK_MS }));
      },
      onBeforeStaleMove: async () => { atPublishedGate(); await blocked; },
    });
    await publishedGate;
    assert.ok((await stat(gate)).isDirectory());
    await assert.rejects(withFileLock(root, "host-id-rotation", async () => "wrong",
      { stalePolicy: "host-id", timeoutMs: 100 }), FileLockTimeoutError);
    assert.equal(JSON.parse(await readFile(join(gate, "owner.json"), "utf8")).pid, fakePid);
    release();
    await publisher;
  } finally { release(); process.kill = originalKill; await rm(root, { recursive: true, force: true }); }
});

test("credential lock path stays absent while its complete owner is being written", { timeout: 3_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-credential-publish-"));
  const path = join(root, "credential.lock");
  let entered!: () => void;
  let release!: () => void;
  const paused = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  try {
    const first = withFileLock(root, "credential", async () => "held",
      { onBeforePublish: async () => { entered(); await blocked; } });
    await paused;
    await assert.rejects(stat(path), { code: "ENOENT" });
    release();
    assert.equal(await first, "held");
  } finally { release(); await rm(root, { recursive: true, force: true }); }
});

test("host, credential, and takeover locks serialize two dead-owner contenders and retain an aged live owner", { timeout: 8_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-all-file-locks-"));
  const clock = Date.now;
  try {
    for (const name of ["host-id-rotation", "a".repeat(24), `watch-takeover-${"b".repeat(24)}`]) {
      const path = join(root, `${name}.lock`);
      const policy = name === "host-id-rotation" || name.startsWith("watch-takeover-")
        ? { stalePolicy: "host-id" as const } : {};
      await writeFile(path, JSON.stringify({ pid: 999_999_999, host: hostname(),
        createdAt: clock(), startTime: clock(), ownerId: "dead" }));
      let active = 0;
      let peak = 0;
      await Promise.all(Array.from({ length: 2 }, () => withFileLock(root, name, async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, 30));
        active--;
      }, { ...policy, timeoutMs: 1_500 })));
      assert.equal(peak, 1, name);
      await writeFile(path, JSON.stringify({ pid: process.pid, host: hostname(),
        createdAt: clock() - AGED_LOCK_MS,
        startTime: pidStartMs(process.pid), ownerId: "live" }));
      const original = await readFile(path, "utf8");
      Date.now = () => clock() + AGED_LOCK_MS;
      await assert.rejects(withFileLock(root, name, async () => "wrong",
        { ...policy, timeoutMs: 70 }), FileLockTimeoutError);
      Date.now = clock;
      assert.equal(await readFile(path, "utf8"), original, name);
      await rm(path);
    }
  } finally { Date.now = clock; await rm(root, { recursive: true, force: true }); }
});

test("general locks reclaim aged foreign hosts and reused pids, but keep a matching live owner", { timeout: 4_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-general-recovery-"));
  const path = join(root, "check.lock");
  const clock = Date.now;
  const startTime = pidStartMs(process.pid);
  assert.ok(startTime !== null);
  try {
    const foreign = JSON.stringify({ pid: process.pid, host: "previous-hostname",
      createdAt: clock(), startTime, ownerId: "foreign" });
    await writeFile(path, foreign);
    await assert.rejects(withFileLock(root, "check", async () => "too-early", { timeoutMs: 40 }), FileLockTimeoutError);
    assert.equal(await readFile(path, "utf8"), foreign);
    Date.now = () => clock() + AGED_LOCK_MS;
    assert.equal(await withFileLock(root, "check", async () => "reclaimed", { timeoutMs: 500 }), "reclaimed");
    Date.now = clock;

    await writeFile(path, JSON.stringify({ pid: process.pid, host: hostname(),
      createdAt: clock(), startTime: startTime - 10_000, ownerId: "reused" }));
    assert.equal(await withFileLock(root, "check", async () => "reclaimed", { timeoutMs: 500 }), "reclaimed");

    await withFileLock(root, "check", async () => {
      const owner = JSON.parse(await readFile(path, "utf8")) as { startTime?: number };
      assert.equal(owner.startTime, startTime);
    });
    const live = JSON.stringify({ pid: process.pid, host: hostname(),
      createdAt: clock(), startTime, ownerId: "live" });
    await writeFile(path, live);
    Date.now = () => clock() + AGED_LOCK_MS;
    await assert.rejects(withFileLock(root, "check", async () => "wrong", { timeoutMs: 50 }), FileLockTimeoutError);
    assert.equal(await readFile(path, "utf8"), live);
  } finally { Date.now = clock; await rm(root, { recursive: true, force: true }); }
});

test("host and takeover reclaim gates serialize dead owners and retain aged live owners", { timeout: 6_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-all-reclaim-gates-"));
  const clock = Date.now;
  try {
    for (const name of ["host-id-rotation", `watch-takeover-${"b".repeat(24)}`]) {
      const path = join(root, `${name}.lock`);
      const gate = `${path}.reclaim`;
      const dead = JSON.stringify({ pid: 999_999_999, host: hostname(),
        createdAt: clock(), startTime: clock(), ownerId: "dead" });
      await writeFile(path, dead);
      await mkdir(gate);
      await writeFile(join(gate, "owner.json"), dead);
      let active = 0;
      let peak = 0;
      await Promise.all(Array.from({ length: 2 }, () => withFileLock(root, name, async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, 25));
        active--;
      }, { stalePolicy: "host-id", timeoutMs: 1_500 })));
      assert.equal(peak, 1, name);
      await writeFile(path, dead);
      await mkdir(gate);
      const live = JSON.stringify({ pid: process.pid, host: hostname(),
        createdAt: clock() - AGED_LOCK_MS, startTime: pidStartMs(process.pid), ownerId: "live" });
      await writeFile(join(gate, "owner.json"), live);
      Date.now = () => clock() + AGED_LOCK_MS;
      await assert.rejects(withFileLock(root, name, async () => "wrong",
        { stalePolicy: "host-id", timeoutMs: 70 }), FileLockTimeoutError);
      Date.now = clock;
      assert.equal(await readFile(join(gate, "owner.json"), "utf8"), live);
      await rm(gate, { recursive: true, force: true });
      await rm(path);
    }
  } finally { Date.now = clock; await rm(root, { recursive: true, force: true }); }
});

test("a killed general-lock publisher's temp is removed on the next acquire", { timeout: 8_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-general-temp-"));
  let child: ReturnType<typeof spawn> | null = null;
  try {
    child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
      `import { withFileLock } from './src/cloud/storage.ts';
       await withFileLock(process.argv[1], 'check', async () => {}, {
         onBeforePublish: async () => { process.stdout.write('ready\\n'); await new Promise(() => {}); },
       });`, root], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    await new Promise<void>((resolve, reject) => {
      child!.stdout!.once("data", () => resolve());
      child!.once("error", reject);
      child!.once("close", code => reject(new Error(`publisher exited: ${code}`)));
    });
    assert.equal((await readdir(root)).filter(name => name.endsWith(".tmp")).length, 1);
    child.kill("SIGKILL");
    await new Promise<void>(resolve => child!.once("close", () => resolve()));
    await withFileLock(root, "check", async () => undefined, { timeoutMs: 500 });
    assert.equal((await readdir(root)).filter(name => name.endsWith(".tmp")).length, 0);
  } finally {
    if (child?.exitCode === null && child?.signalCode === null) {
      child.kill("SIGKILL");
      await new Promise<void>(resolve => child!.once("close", () => resolve()));
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("reclaim checks the moved owner and preserves a replacement gate", { timeout: 3_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-gate-race-"));
  const lock = join(root, "host-id-rotation.lock");
  const gate = `${lock}.reclaim`;
  const clock = Date.now;
  const fresh = JSON.stringify({ pid: process.pid, host: hostname(), startTime: pidStartMs(process.pid), ownerId: "fresh" });
  try {
    await writeFile(lock, JSON.stringify({ pid: 999_999_999, host: hostname(), createdAt: Date.now(), startTime: Date.now() }), { mode: 0o600 });
    await mkdir(gate, { mode: 0o700 });
    await writeFile(join(gate, "owner.json"), "{old", { mode: 0o600 });
    Date.now = () => clock() + HOST_ID_LOCK_INCOMPLETE_GRACE_MS + 100;
    await assert.rejects(withFileLock(root, "host-id-rotation", async () => undefined, {
      stalePolicy: "host-id", timeoutMs: 500, onBeforeGateStaleMove: async () => {
        await rename(gate, `${gate}.prior`);
        await mkdir(gate, { mode: 0o700 });
        await writeFile(join(gate, "owner.json"), fresh, { mode: 0o600 });
      },
    }), error => {
      assert.ok(error instanceof FileLockTimeoutError);
      assert.ok(error.message.includes(gate));
      assert.match(error.message, /remove that directory/);
      return true;
    });
    assert.equal(await readFile(join(gate, "owner.json"), "utf8"), fresh);
  } finally { Date.now = clock; await rm(root, { recursive: true, force: true }); }
});

test("gate release leaves a replacement owner untouched", { timeout: 3_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-gate-release-race-"));
  const lock = join(root, "host-id-rotation.lock");
  const gate = `${lock}.reclaim`;
  const fresh = JSON.stringify({ pid: process.pid, host: hostname(), startTime: pidStartMs(process.pid), ownerId: "replacement" });
  try {
    await writeFile(lock, JSON.stringify({ pid: 999_999_999, host: hostname(), createdAt: Date.now(), startTime: Date.now() }), { mode: 0o600 });
    await assert.rejects(withFileLock(root, "host-id-rotation", async () => undefined, {
      stalePolicy: "host-id", timeoutMs: 500, onBeforeStaleMove: async () => {
        await rename(gate, `${gate}.prior`);
        await mkdir(gate, { mode: 0o700 });
        await writeFile(join(gate, "owner.json"), fresh, { mode: 0o600 });
      },
    }), error => {
      assert.match(String(error), /gate owner changed at .* before release/);
      assert.ok(String(error).includes(gate));
      assert.match(String(error), /Retry the command/);
      return true;
    });
    assert.equal(await readFile(join(gate, "owner.json"), "utf8"), fresh);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("gate release retries a transient owner change once", { timeout: 3_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-gate-release-retry-"));
  const lock = join(root, "host-id-rotation.lock");
  const gate = `${lock}.reclaim`;
  let restoration: Promise<void> = Promise.resolve();
  try {
    await writeFile(lock, JSON.stringify({ pid: 999_999_999, host: hostname(),
      createdAt: Date.now(), startTime: Date.now() }), { mode: 0o600 });
    const result = await withFileLock(root, "host-id-rotation", async () => "acquired", {
      stalePolicy: "host-id", timeoutMs: 500, onBeforeStaleMove: async () => {
        await rename(gate, `${gate}.prior`);
        await mkdir(gate, { mode: 0o700 });
        await writeFile(join(gate, "owner.json"), JSON.stringify({ pid: process.pid,
          host: hostname(), startTime: pidStartMs(process.pid), ownerId: "temporary" }));
        restoration = new Promise<void>((resolve, reject) => setTimeout(() => {
          void (async () => {
            await rm(gate, { recursive: true, force: true });
            await rename(`${gate}.prior`, gate);
          })().then(resolve, reject);
        }, 10));
      },
    });
    await restoration;
    assert.equal(result, "acquired");
    await assert.rejects(stat(gate), { code: "ENOENT" });
  } finally { await restoration.catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test("host-id publication falls back on unsupported links and accepts retransmitted LINK", { timeout: 8_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-lock-fallback-"));
  try {
    for (const code of ["EPERM", "ENOTSUP", "ENOSYS", "EXDEV"]) {
      await withFileLock(root, "host-id-rotation", async () => {
        const path = join(root, "host-id-rotation.lock");
        assert.equal((await stat(path)).mode & 0o777, 0o600);
        assert.equal((JSON.parse(await readFile(path, "utf8")) as { pid: number }).pid, process.pid);
      }, { stalePolicy: "host-id", publishLink: async () => { throw Object.assign(new Error(code), { code }); } });
    }
    await withFileLock(root, "host-id-rotation", async () => undefined, {
      stalePolicy: "host-id", publishLink: async (source, destination) => {
        await link(source, destination);
        throw Object.assign(new Error("retransmitted LINK"), { code: "EEXIST" });
      },
    });
    assert.equal((await readdir(root)).filter(name => name.endsWith(".tmp")).length, 0);
    await writeFile(join(root, "host-id-rotation.lock.999999999.abcdef.tmp"), "abandoned", { mode: 0o600 });
    await withFileLock(root, "host-id-rotation", async () => undefined, { stalePolicy: "host-id" });
    assert.equal((await readdir(root)).filter(name => name.endsWith(".tmp")).length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

function assertPidStartMatchesSpawn(parsedStartMs: number | null, spawnTimeMs: number): void {
  assert.ok(parsedStartMs !== null && Math.abs(parsedStartMs - spawnTimeMs) < 2_000,
    "parsed PID start must be within two seconds of the child's real spawn");
}

test("PID start-time control rejects a self-consistent but wrong ps value", { timeout: 1_000 }, () => {
  const spawnTimeMs = Date.now();
  assert.doesNotThrow(() => assertPidStartMatchesSpawn(spawnTimeMs - 500, spawnTimeMs));
  assert.throws(() => assertPidStartMatchesSpawn(spawnTimeMs - 10_000, spawnTimeMs), /real spawn/);
});

test("pid-reuse probe reaches ps for another live process", { timeout: 8_000 }, async (t) => {
  const spawnTimeMs = Date.now();
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    assert.ok(child.pid);
    let raw: string;
    try {
      raw = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(child.pid)],
        { encoding: "utf8", timeout: 1_000, env: { ...process.env, LC_ALL: "C" } });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") { t.skip("sandbox denies /bin/ps"); return; }
      throw error;
    }
    assertPidStartMatchesSpawn(pidStartMs(child.pid), spawnTimeMs);
  } finally {
    child.kill("SIGKILL");
    await new Promise<void>(resolve => child.once("close", () => resolve()));
  }
});

test("supervisor records this process start as reported by real ps", { timeout: 5_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-supervisor-ps-"));
  try {
    if (process.uptime() < 2.1) await new Promise(resolve => setTimeout(resolve, 2_100));
    const status = await runListenerSupervisor({
      paths: listenerPaths({ profileId: "ps-control", workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        principalId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", stateDirectory: root }),
      profileId: "ps-control", workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      principalId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      run: async () => ({ reason: "cancelled" }),
    });
    assert.ok(status.processStartedAt !== undefined && Date.now() - status.processStartedAt > 2_000,
      "the recorded process must predate supervisor launch");
    let psStart: number;
    try {
      psStart = Date.parse(execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(process.pid)],
        { encoding: "utf8", timeout: 1_000, env: { ...process.env, LC_ALL: "C" } }).trim());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") { t.skip("sandbox denies /bin/ps"); return; }
      throw error;
    }
    assert.ok(Number.isFinite(psStart));
    assert.ok(status.processStartedAt !== undefined && Math.abs(status.processStartedAt - psStart) < 2_000,
      "the supervisor status must record the real process start, not supervisor launch");
  } finally { await rm(root, { recursive: true, force: true }); }
});
