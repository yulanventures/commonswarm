import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  SeatLockError,
  acquireSeatLock,
  seatLockKey,
  type SeatLockHandle,
  type SeatLockIdentity,
} from "../src/engine/seat-lock.js";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const MODULE_URL = pathToFileURL(join(REPO_ROOT, "src/engine/seat-lock.ts")).href;

const SEAT_A: SeatLockIdentity = {
  deployment: "https://api.commonswarm.com",
  workspaceId: "11111111-1111-4111-8111-111111111111",
  principalId: "22222222-2222-4222-8222-222222222222",
};

const SEAT_B: SeatLockIdentity = {
  deployment: "https://api.commonswarm.com",
  workspaceId: "11111111-1111-4111-8111-111111111111",
  principalId: "33333333-3333-4333-8333-333333333333",
};

const HELPER_SOURCE = `
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createInterface } from "node:readline";

const config = JSON.parse(process.argv[2]);
const emit = (payload) => process.stdout.write(JSON.stringify(payload) + "\\n");

if (config.mode === "survivor") {
  const server = createServer();
  server.listen(0, "127.0.0.1", () => {
    const addr = server.address();
    emit({ event: "survivor_ready", pid: process.pid, port: addr.port });
  });
} else {
  const { acquireSeatLock } = await import(${JSON.stringify(MODULE_URL)});
  let handle = null;
  try {
    handle = await acquireSeatLock({
      root: config.root,
      deployment: config.deployment,
      workspaceId: config.workspaceId,
      principalId: config.principalId,
    });
    emit({ event: "acquired", key: handle.key });
  } catch (err) {
    emit({
      event: "error",
      code: err && typeof err === "object" && "code" in err ? err.code : null,
      message: err instanceof Error ? err.message : String(err),
    });
    process.exit(0);
  }

  if (config.mode === "try") {
    handle.release();
    process.exit(0);
  }

  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (line === "ping") {
      emit({ event: "pong" });
      return;
    }
    if (line === "spawn-child") {
      const child = spawn(
        process.execPath,
        [process.argv[1], JSON.stringify({ mode: "survivor" })],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      const childRl = createInterface({ input: child.stdout });
      childRl.once("line", (childLine) => {
        childRl.close();
        child.stdout.destroy();
        process.stdout.write(childLine + "\\n");
      });
      return;
    }
    if (line === "release") {
      handle.release();
      emit({ event: "released" });
      return;
    }
    if (line === "exit") {
      handle.release();
      rl.close();
      process.exit(0);
    }
  });
  rl.on("close", () => {
    handle.release();
    process.exit(0);
  });
}
`;

interface HelperEvent {
  readonly event: string;
  readonly key?: string;
  readonly code?: string | null;
  readonly message?: string;
  readonly pid?: number;
  readonly port?: number;
}

class HelperProcess {
  readonly child: ChildProcess;
  private readonly queue: HelperEvent[] = [];
  private readonly waiters: Array<{
    resolve: (ev: HelperEvent) => void;
    reject: (err: Error) => void;
  }> = [];
  private readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private stderr = "";
  private closed = false;

  constructor(helperPath: string, config: Record<string, unknown>) {
    this.child = spawn(
      process.execPath,
      ["--import", "tsx", helperPath, JSON.stringify(config)],
      { cwd: REPO_ROOT, stdio: ["pipe", "pipe", "pipe"] },
    );
    this.child.stderr!.setEncoding("utf8");
    this.child.stderr!.on("data", (chunk: string) => {
      this.stderr += chunk;
    });
    const rl = createInterface({ input: this.child.stdout! });
    rl.on("line", (line) => {
      const parsed = JSON.parse(line) as HelperEvent;
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(parsed);
      else this.queue.push(parsed);
    });
    this.exited = once(this.child, "exit").then(([code, signal]) => {
      this.closed = true;
      rl.close();
      while (this.waiters.length > 0) {
        this.waiters.shift()!.reject(
          new Error(`helper exited early (code=${code}, signal=${signal}): ${this.stderr}`),
        );
      }
      return { code: code as number | null, signal: signal as NodeJS.Signals | null };
    });
  }

  get hasBufferedEvent(): boolean {
    return this.queue.length > 0;
  }

  nextEvent(): Promise<HelperEvent> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    if (this.closed) return Promise.reject(new Error(`helper already exited: ${this.stderr}`));
    return new Promise((resolvePromise, reject) => {
      this.waiters.push({ resolve: resolvePromise, reject });
    });
  }

  send(command: string): void {
    this.child.stdin!.write(`${command}\n`);
  }

  kill(signal: NodeJS.Signals): void {
    this.child.kill(signal);
  }

  waitExit(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    return this.exited;
  }

  async terminate(): Promise<void> {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      try {
        this.child.kill("SIGCONT");
      } catch {
        // ignore if already gone
      }
      try {
        this.child.kill("SIGKILL");
      } catch {
        // ignore if already gone
      }
    }
    await this.exited;
  }
}

async function withWorkspace(
  fn: (ctx: {
    readonly workDir: string;
    readonly root: string;
    readonly helperPath: string;
    readonly startHelper: (config: Record<string, unknown>) => HelperProcess;
  }) => Promise<void>,
): Promise<void> {
  const workDir = await mkdtemp(join(tmpdir(), "seat-lock-test-"));
  const root = join(workDir, "state");
  const helperPath = join(workDir, "engine-seat-lock-helper.mjs");
  await writeFile(helperPath, HELPER_SOURCE, { mode: 0o600 });
  const spawned: HelperProcess[] = [];
  const startHelper = (config: Record<string, unknown>): HelperProcess => {
    const proc = new HelperProcess(helperPath, config);
    spawned.push(proc);
    return proc;
  };
  try {
    await fn({ workDir, root, helperPath, startHelper });
  } finally {
    await Promise.all(spawned.map((proc) => proc.terminate()));
    await rm(workDir, { recursive: true, force: true });
  }
}

async function tryAcquireInChild(
  startHelper: (config: Record<string, unknown>) => HelperProcess,
  root: string,
  seat: SeatLockIdentity,
): Promise<HelperEvent> {
  const probe = startHelper({ mode: "try", root, ...seat });
  const ev = await probe.nextEvent();
  await probe.waitExit();
  return ev;
}

test("1. a second process is refused with seat_locked while the first holds the lock", async () => {
  await withWorkspace(async ({ root, startHelper }) => {
    const holder = startHelper({ mode: "hold", root, ...SEAT_A });
    const first = await holder.nextEvent();
    assert.equal(first.event, "acquired");

    const contender = await tryAcquireInChild(startHelper, root, SEAT_A);
    assert.equal(contender.event, "error");
    assert.equal(contender.code, "seat_locked");
  });
});

test("2. lock remains held across SIGSTOP and holder resumes normally on SIGCONT", async () => {
  await withWorkspace(async ({ root, startHelper }) => {
    const holder = startHelper({ mode: "hold", root, ...SEAT_A });
    assert.equal((await holder.nextEvent()).event, "acquired");

    holder.kill("SIGSTOP");
    holder.send("ping");

    const whileStopped = await tryAcquireInChild(startHelper, root, SEAT_A);
    assert.equal(whileStopped.event, "error");
    assert.equal(whileStopped.code, "seat_locked");
    assert.equal(holder.hasBufferedEvent, false, "stopped holder must not have answered ping");

    holder.kill("SIGCONT");
    assert.equal((await holder.nextEvent()).event, "pong");

    const afterResume = await tryAcquireInChild(startHelper, root, SEAT_A);
    assert.equal(afterResume.event, "error");
    assert.equal(afterResume.code, "seat_locked");
  });
});

test("3. after the holder is killed with SIGKILL, a new process acquires the lock", async () => {
  await withWorkspace(async ({ root, startHelper }) => {
    const holder = startHelper({ mode: "hold", root, ...SEAT_A });
    assert.equal((await holder.nextEvent()).event, "acquired");

    holder.kill("SIGKILL");
    const exit = await holder.waitExit();
    assert.equal(exit.signal, "SIGKILL");

    const next = await tryAcquireInChild(startHelper, root, SEAT_A);
    assert.equal(next.event, "acquired");
    assert.equal(next.key, seatLockKey(SEAT_A));
  });
});

test("4. a surviving child spawned by the holder does not keep the lock after SIGKILL", async () => {
  await withWorkspace(async ({ root, startHelper }) => {
    const holder = startHelper({ mode: "hold", root, ...SEAT_A });
    assert.equal((await holder.nextEvent()).event, "acquired");

    let survivorPid: number | null = null;
    let watchSocket: Socket | null = null;
    try {
      holder.send("spawn-child");
      const childEv = await holder.nextEvent();
      assert.equal(childEv.event, "survivor_ready");
      assert.equal(typeof childEv.pid, "number");
      assert.equal(typeof childEv.port, "number");
      survivorPid = childEv.pid!;

      watchSocket = createConnection({ host: "127.0.0.1", port: childEv.port! });
      await once(watchSocket, "connect");
      const socketClosed = once(watchSocket, "close");

      holder.kill("SIGKILL");
      assert.equal((await holder.waitExit()).signal, "SIGKILL");

      // Survivor is still alive after holder died.
      assert.doesNotThrow(() => process.kill(survivorPid!, 0));
      assert.equal(watchSocket.destroyed, false);

      const next = await tryAcquireInChild(startHelper, root, SEAT_A);
      assert.equal(next.event, "acquired");

      process.kill(survivorPid, "SIGKILL");
      survivorPid = null;
      await socketClosed;
    } finally {
      if (survivorPid !== null) {
        try {
          process.kill(survivorPid, "SIGKILL");
        } catch {
          // already gone
        }
        if (watchSocket && !watchSocket.destroyed) {
          await once(watchSocket, "close");
        }
      }
      watchSocket?.destroy();
    }
  });
});

test("5. canonical identity ignores case, trailing slash, and profile paths; different seat does not contend", async () => {
  const variant: SeatLockIdentity = {
    deployment: "HTTPS://API.COMMONSWARM.COM/",
    workspaceId: SEAT_A.workspaceId.toUpperCase(),
    principalId: SEAT_A.principalId.toUpperCase(),
  };
  assert.equal(seatLockKey(SEAT_A), seatLockKey(variant));
  assert.notEqual(seatLockKey(SEAT_A), seatLockKey(SEAT_B));

  await withWorkspace(async ({ root, startHelper }) => {
    const holder = startHelper({ mode: "hold", root, ...SEAT_A });
    assert.equal((await holder.nextEvent()).event, "acquired");

    const sameSeatDifferentCasing = await tryAcquireInChild(startHelper, root, variant);
    assert.equal(sameSeatDifferentCasing.event, "error");
    assert.equal(sameSeatDifferentCasing.code, "seat_locked");

    const otherSeat = await tryAcquireInChild(startHelper, root, SEAT_B);
    assert.equal(otherSeat.event, "acquired");
    assert.equal(otherSeat.key, seatLockKey(SEAT_B));
  });
});

test("6. release() leaves the 0600 file in place, is idempotent, and allows reacquisition", async () => {
  await withWorkspace(async ({ root, startHelper }) => {
    const first = await acquireSeatLock({ root, ...SEAT_A });
    const lockPath = join(root, "locks", `${first.key}.lock`);

    try {
      await assert.rejects(
        () => acquireSeatLock({ root, ...SEAT_A }),
        (err: unknown) => err instanceof SeatLockError && err.code === "seat_locked",
      );
      const whileHeld = await tryAcquireInChild(startHelper, root, SEAT_A);
      assert.equal(whileHeld.event, "error");
      assert.equal(whileHeld.code, "seat_locked");
    } finally {
      first.release();
      first.release();
    }

    const st = await lstat(lockPath);
    assert.equal(st.isFile(), true);
    assert.equal(st.mode & 0o777, 0o600);

    const second = await acquireSeatLock({ root, ...SEAT_A });
    second.release();

    const third = await tryAcquireInChild(startHelper, root, SEAT_A);
    assert.equal(third.event, "acquired");
    assert.equal((await lstat(lockPath)).mode & 0o777, 0o600);
  });
});

test("7. symlinked lock file and group-accessible locks folder are refused without leaking paths", async () => {
  await withWorkspace(async ({ workDir, root }) => {
    const locksDir = join(root, "locks");
    await mkdir(locksDir, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
    await chmod(locksDir, 0o700);

    const decoy = join(workDir, "decoy.lock");
    await writeFile(decoy, "", { mode: 0o600 });
    const key = seatLockKey(SEAT_A);
    const lockPath = join(locksDir, `${key}.lock`);
    await symlink(decoy, lockPath);

    await assert.rejects(
      () => acquireSeatLock({ root, ...SEAT_A }),
      (err: unknown) => {
        assert.ok(err instanceof SeatLockError);
        assert.equal(err.code, "seat_lock_unsafe");
        assert.equal(err.message.includes(root), false);
        assert.equal(err.message.includes(key), false);
        assert.equal(err.message.includes("/"), false);
        return true;
      },
    );

    const groupRoot = join(workDir, "group-root");
    const groupLocks = join(groupRoot, "locks");
    await mkdir(groupLocks, { recursive: true, mode: 0o700 });
    await chmod(groupRoot, 0o700);
    await chmod(groupLocks, 0o750);

    await assert.rejects(
      () => acquireSeatLock({ root: groupRoot, ...SEAT_A }),
      (err: unknown) => {
        assert.ok(err instanceof SeatLockError);
        assert.equal(err.code, "seat_lock_unsafe");
        assert.equal(err.message.includes(groupRoot), false);
        assert.equal(err.message.includes("/"), false);
        return true;
      },
    );
  });
});

test("8. invalid workspace id, seat id, or relative root is refused before creating anything", async () => {
  await withWorkspace(async ({ workDir }) => {
    const badWorkspaceRoot = join(workDir, "bad-workspace");
    await assert.rejects(
      () => acquireSeatLock({ root: badWorkspaceRoot, ...SEAT_A, workspaceId: "not-a-uuid" }),
      (err: unknown) => err instanceof SeatLockError && err.code === "seat_lock_unsafe",
    );
    await assert.rejects(() => lstat(badWorkspaceRoot), { code: "ENOENT" });

    const badSeatRoot = join(workDir, "bad-seat");
    await assert.rejects(
      () => acquireSeatLock({ root: badSeatRoot, ...SEAT_A, principalId: "../escape" }),
      (err: unknown) => err instanceof SeatLockError && err.code === "seat_lock_unsafe",
    );
    await assert.rejects(() => lstat(badSeatRoot), { code: "ENOENT" });

    const relativeRoot = "relative-seat-lock-should-not-exist";
    await assert.rejects(
      () => acquireSeatLock({ root: relativeRoot, ...SEAT_A }),
      (err: unknown) => err instanceof SeatLockError && err.code === "seat_lock_unsafe",
    );
    await assert.rejects(() => lstat(resolve(relativeRoot)), { code: "ENOENT" });
  });
});

test("9. two overlapping same-process acquires allow only one and keep the kernel lock against another process", async () => {
  await withWorkspace(async ({ root, startHelper }) => {
    const p1 = acquireSeatLock({ root, ...SEAT_A });
    const p2 = acquireSeatLock({ root, ...SEAT_A });
    const results = await Promise.allSettled([p1, p2]);
    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<SeatLockHandle> => r.status === "fulfilled",
    );
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");

    try {
      assert.equal(fulfilled.length, 1);
      assert.equal(rejected.length, 1);
      assert.ok(rejected[0]!.reason instanceof SeatLockError);
      assert.equal(rejected[0]!.reason.code, "seat_locked");

      const whileHeld = await tryAcquireInChild(startHelper, root, SEAT_A);
      assert.equal(whileHeld.event, "error");
      assert.equal(whileHeld.code, "seat_locked");
    } finally {
      for (const r of fulfilled) {
        r.value.release();
      }
    }

    const afterRelease = await tryAcquireInChild(startHelper, root, SEAT_A);
    assert.equal(afterRelease.event, "acquired");
    assert.equal(afterRelease.key, seatLockKey(SEAT_A));
  });
});

test("10. a WAL-mode SQLite lock file is refused with seat_lock_unavailable and left in WAL mode", async () => {
  await withWorkspace(async ({ root }) => {
    const locksDir = join(root, "locks");
    await mkdir(locksDir, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
    await chmod(locksDir, 0o700);

    const lockPath = join(locksDir, `${seatLockKey(SEAT_A)}.lock`);
    const setupDb = new DatabaseSync(lockPath);
    try {
      setupDb.exec("CREATE TABLE t (id INTEGER PRIMARY KEY); PRAGMA journal_mode=WAL;");
    } finally {
      setupDb.close();
    }
    await chmod(lockPath, 0o600);

    await assert.rejects(
      () => acquireSeatLock({ root, ...SEAT_A }),
      (err: unknown) => err instanceof SeatLockError && err.code === "seat_lock_unavailable",
    );

    await assert.rejects(
      () => acquireSeatLock({ root, ...SEAT_A }),
      (err: unknown) => err instanceof SeatLockError && err.code === "seat_lock_unavailable",
    );

    const verifyDb = new DatabaseSync(lockPath, { timeout: 0 });
    try {
      const row = verifyDb.prepare("PRAGMA journal_mode").get() as { journal_mode?: unknown } | undefined;
      assert.equal(typeof row?.journal_mode, "string");
      assert.equal((row!.journal_mode as string).toLowerCase(), "wal");
    } finally {
      verifyDb.close();
    }
  });
});
