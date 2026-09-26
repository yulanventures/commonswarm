import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { spawn, execFileSync } from "node:child_process";
import { arrivalHostId } from "../../src/cloud/arrival-watch.js";
import { FileLockTimeoutError, HOST_ID_LOCK_INCOMPLETE_GRACE_MS, pidStartMs, readSecureJsonFile, withFileLock } from "../../src/cloud/storage.js";

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
      assert.match(error.message, /If its owner is gone, remove .* and retry/);
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

test("gate creation publishes only a complete owner and survives an injected crash", { timeout: 3_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-gate-atomic-"));
  const lock = join(root, "host-id-rotation.lock");
  const gate = `${lock}.reclaim`;
  try {
    await writeFile(lock, JSON.stringify({ pid: 999_999_999, host: hostname(), createdAt: Date.now(), startTime: Date.now() }), { mode: 0o600 });
    await assert.rejects(withFileLock(root, "host-id-rotation", async () => undefined, {
      stalePolicy: "host-id", timeoutMs: 500, onBeforeGatePublish: async () => {
        await assert.rejects(stat(gate), { code: "ENOENT" });
        throw new Error("injected crash");
      },
    }), /injected crash/);
    await assert.rejects(stat(gate), { code: "ENOENT" });
    assert.equal((await readdir(root)).filter(name => name.includes(".reclaim.")).length, 0);
    await withFileLock(root, "host-id-rotation", async () => undefined, { stalePolicy: "host-id", timeoutMs: 500 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("empty, partial, and foreign reclaim gates recover after two-second grace", { timeout: 4_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-gate-grace-"));
  const lock = join(root, "host-id-rotation.lock");
  const gate = `${lock}.reclaim`;
  try {
    for (const owner of [null, "{partial", JSON.stringify({ pid: process.pid, host: "foreign-host", startTime: Date.now(), ownerId: "foreign" })]) {
      await writeFile(lock, JSON.stringify({ pid: 999_999_999, host: hostname(), createdAt: Date.now(), startTime: Date.now() }), { mode: 0o600 });
      await mkdir(gate, { mode: 0o700 });
      if (owner !== null) await writeFile(join(gate, "owner.json"), owner, { mode: 0o600 });
      await assert.rejects(withFileLock(root, "host-id-rotation", async () => undefined,
        { stalePolicy: "host-id", timeoutMs: 80 }), FileLockTimeoutError);
      const old = new Date(Date.now() - HOST_ID_LOCK_INCOMPLETE_GRACE_MS - 100);
      await utimes(gate, old, old);
      await withFileLock(root, "host-id-rotation", async () => undefined, { stalePolicy: "host-id", timeoutMs: 600 });
      await assert.rejects(stat(gate), { code: "ENOENT" });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("reclaim checks the moved owner and preserves a replacement gate", { timeout: 3_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-gate-race-"));
  const lock = join(root, "host-id-rotation.lock");
  const gate = `${lock}.reclaim`;
  const fresh = JSON.stringify({ pid: process.pid, host: hostname(), startTime: pidStartMs(process.pid), ownerId: "fresh" });
  try {
    await writeFile(lock, JSON.stringify({ pid: 999_999_999, host: hostname(), createdAt: Date.now(), startTime: Date.now() }), { mode: 0o600 });
    await mkdir(gate, { mode: 0o700 });
    await writeFile(join(gate, "owner.json"), "{old", { mode: 0o600 });
    const old = new Date(Date.now() - HOST_ID_LOCK_INCOMPLETE_GRACE_MS - 100);
    await utimes(gate, old, old);
    await assert.rejects(withFileLock(root, "host-id-rotation", async () => undefined, {
      stalePolicy: "host-id", timeoutMs: 500, onBeforeGateStaleMove: async () => {
        await rename(gate, `${gate}.prior`);
        await mkdir(gate, { mode: 0o700 });
        await writeFile(join(gate, "owner.json"), fresh, { mode: 0o600 });
      },
    }), /gate owner changed/);
    assert.equal(await readFile(join(gate, "owner.json"), "utf8"), fresh);
  } finally { await rm(root, { recursive: true, force: true }); }
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
    }), /gate owner changed before release/);
    assert.equal(await readFile(join(gate, "owner.json"), "utf8"), fresh);
  } finally { await rm(root, { recursive: true, force: true }); }
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
        await writeFile(destination, await readFile(source), { mode: 0o600 });
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
