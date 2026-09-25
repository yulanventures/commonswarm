import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { arrivalHostId } from "../../src/cloud/arrival-watch.js";
import { FileLockTimeoutError, HOST_ID_LOCK_INCOMPLETE_GRACE_MS, withFileLock } from "../../src/cloud/storage.js";

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
