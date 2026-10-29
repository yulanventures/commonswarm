/**
 * Pure controls for the human-visible arrival monitor.
 *
 * ★ Named by `npm test`; it needs no network or database.
 */
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readlink, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SignalRecord } from "../../src/cloud/command-client.js";
import {
  acquireArrivalWatchLock,
  acquireArrivalWatchSeatLocks,
  arrivalHostId,
  arrivalHostIdFileState,
  arrivalWatchLockPath,
  legacyArrivalWatchLockPath,
  arrivalNotification,
  ArrivalWatchAlreadyRunningError,
  releaseArrivalWatchLock,
  releaseArrivalWatchSeatLocks,
  runArrivalWatch,
  type ArrivalCursorStore,
} from "../../src/cloud/arrival-watch.js";
import { cloudTarget } from "../../src/cloud/config.js";
import { cleanupDeadOwnerTemps } from "../../src/cloud/storage.js";
import {
  type AgentSignalPage,
  type SignalCursor,
} from "../../src/cloud/signals.js";

const WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SENDER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TARGET = { url: "https://api.example.test", anonKey: "public-anon-key" };
const CLOUD = cloudTarget(TARGET.url, TARGET.anonKey);

test("arrival host id is stable and private in the state directory", { timeout: 2000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-host-id-"));
  try {
    const lockPath = arrivalWatchLockPath(CLOUD, WORKSPACE, AGENT, root);
    const first = await arrivalHostId(lockPath);
    const second = await arrivalHostId(lockPath);
    assert.equal(first, second);
    assert.deepEqual(new Set(await Promise.all(Array.from({ length: 8 }, () => arrivalHostId(lockPath)))), new Set([first]));
    const info = await stat(join(root, "host-id"));
    assert.equal(info.mode & 0o777, 0o600);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("one seat lock spans profile ids in the same state root", { timeout: 2000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-seat-lock-"));
  const other = { ...CLOUD, profileId: "other-profile" };
  const first = arrivalWatchLockPath(CLOUD, WORKSPACE, AGENT, root);
  const second = arrivalWatchLockPath(other, WORKSPACE, AGENT, root);
  try {
    assert.equal(first, second);
    await acquireArrivalWatchLock(first);
    await assert.rejects(acquireArrivalWatchLock(second), ArrivalWatchAlreadyRunningError);
  } finally {
    await releaseArrivalWatchLock(first);
    await rm(root, { recursive: true, force: true });
  }
});

test("new watcher also holds the previous release's profile lock", { timeout: 2000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-upgrade-lock-"));
  const oldPath = legacyArrivalWatchLockPath(CLOUD, WORKSPACE, AGENT, root);
  try {
    assert.equal(oldPath, join(root, `${CLOUD.profileId}-${WORKSPACE}-${AGENT}.lock`));
    await acquireArrivalWatchLock(oldPath);
    await assert.rejects(
      acquireArrivalWatchSeatLocks(CLOUD, WORKSPACE, AGENT, process.pid, undefined, root),
      ArrivalWatchAlreadyRunningError,
    );
    await releaseArrivalWatchLock(oldPath);
    const locks = await acquireArrivalWatchSeatLocks(CLOUD, WORKSPACE, AGENT, process.pid, undefined, root);
    try {
      await assert.rejects(acquireArrivalWatchLock(oldPath), ArrivalWatchAlreadyRunningError);
    } finally { await releaseArrivalWatchSeatLocks(locks); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("copied host id rotates on machine mismatch and survives unreadable machine id", { timeout: 2000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-host-copy-"));
  try {
    const path = arrivalWatchLockPath(CLOUD, WORKSPACE, AGENT, root);
    const first = await arrivalHostId(path, "a".repeat(64));
    assert.equal(await arrivalHostId(path, null), first);
    const second = await arrivalHostId(path, "b".repeat(64));
    assert.notEqual(second, first);
    assert.equal(await arrivalHostId(path, "b".repeat(64)), second);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("host id gains a newly readable machine hash without changing identity", { timeout: 2000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-host-adopt-"));
  try {
    const lock = arrivalWatchLockPath(CLOUD, WORKSPACE, AGENT, root);
    assert.equal(await arrivalHostIdFileState(lock), "missing");
    const first = await arrivalHostId(lock, null);
    assert.equal(await arrivalHostIdFileState(lock), "present");
    assert.equal(await arrivalHostId(lock, "a".repeat(64)), first);
    assert.deepEqual(JSON.parse(await readFile(join(root, "host-id"), "utf8")), {
      host_id: first, machine_hash: "a".repeat(64),
    });
    assert.notEqual(await arrivalHostId(lock, "b".repeat(64)), first);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("bad host id content or mode is replaced with one path-specific notice", { timeout: 2000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-host-repair-"));
  const path = join(root, "host-id");
  const lock = arrivalWatchLockPath(CLOUD, WORKSPACE, AGENT, root);
  const originalWrite = process.stderr.write;
  let notices = "";
  process.stderr.write = ((chunk: string) => { notices += chunk; return true; }) as typeof process.stderr.write;
  try {
    await writeFile(path, "garbage", { mode: 0o600 });
    const repaired = await arrivalHostId(lock, "a".repeat(64));
    assert.match(repaired, /^[0-9a-f-]{36}$/);
    assert.equal(notices.match(/replacing invalid or copied host id/g)?.length, 1);
    assert.match(notices, /host-id/);
    notices = "";
    await chmod(path, 0o644);
    assert.notEqual(await arrivalHostId(lock, "a".repeat(64)), repaired);
    assert.equal(notices.match(/replacing invalid or copied host id/g)?.length, 1);
    assert.match(notices, /host-id/);
  } finally {
    process.stderr.write = originalWrite;
    await rm(root, { recursive: true, force: true });
  }
});

function row(id: string, body: string, createdAt: string): SignalRecord {
  return {
    id,
    workspace_id: WORKSPACE,
    from: SENDER,
    from_kind: "agent",
    to: null,
    to_agent: AGENT,
    in_reply_to: null,
    about: null,
    kind: "ask",
    body,
    until: "2030-01-01T00:00:00.000Z",
    created_at: createdAt,
    sender_owner_relation: "same_owner",
  };
}

function page(
  rows: SignalRecord[],
  extra: { wake?: AgentSignalPage["wake"] } = {},
): AgentSignalPage {
  const last = rows.at(-1);
  return {
    signals: rows,
    capabilities: {
      senderOwnerRelation: true,
      cursorAfter: true,
      deliveryClaim: true,
      deliveryAck: true,
    },
    legacyCursorFallback: false,
    rawCount: rows.length,
    nextCursor: last
      ? { created_at: last.created_at, id: last.id }
      : null,
    malformedRows: 0,
    pendingDeliveryCount: 1,
    ...(extra.wake === undefined ? {} : { wake: extra.wake }),
  };
}

function memoryStore(initial: SignalCursor | null | undefined): {
  store: ArrivalCursorStore;
  value(): SignalCursor | null | undefined;
} {
  let cursor = initial;
  return {
    store: {
      location: "memory://arrival-cursor",
      async read() {
        return cursor;
      },
      async write(value) {
        cursor = value;
      },
    },
    value: () => cursor,
  };
}

/* A monitor line becomes a chat notification, so anything in it is read by a
 * human on a phone. The anon key is a JWT: repeating it per message made the
 * line unreadable and taught agents to paste credentials into commands. It is
 * public-by-design, so this is noise and habit rather than a secret leak — but
 * the hook never included it and neither should this. */
test("an arrival notification never carries the anon key or the url", () => {
  const notification = arrivalNotification(
    row("11111111-1111-4111-8111-111111111111", "hello", "2026-08-28T10:00:00.000Z"),
    WORKSPACE,
    TARGET,
  );
  const rendered = JSON.stringify(notification);
  assert.equal(rendered.includes(TARGET.anonKey), false);
  assert.equal(rendered.includes(TARGET.url), false);
});

/* The notify line is a preview by design (one terminal line), but its --json form
 * was the only copy an automated reader got, and it carried only the snippet. A
 * surface that is a reader's only copy carries the whole body; a surface that
 * shortens one names where the rest is. */

/* The boundary is the constant, not a typed number: at exactly ARRIVAL_SNIPPET_MAX
 * nothing is cut and no phrase appears; one more character and both the ellipsis
 * and the phrase appear. If the phrase were built from a typed 180 this pair
 * would fail as soon as the constant moved. */

/* The Codex arm on 727f4c44 failed the lane on this: the phrase named a bare
 * `cswarm inbox`, which cannot show the addressed reader anything. An agent
 * identity comes only from its credential flags and then requires a workspace
 * (`cswarm inbox --notify` itself refuses to run without --workspace-id, and the
 * CLI's agent path throws "agent credentials require --workspace-id"). So the
 * command must carry the same route the sibling reply command carries. */

/* Whitespace collapses before the cap applies, so a body over the cap in raw
 * characters that fits on one line after collapse is not a cut and gets no phrase.
 * The phrase reports a cut, not a raw length. */

test("restart neither replays an emitted row nor skips a row received while down", async () => {
  const old = row(
    "33333333-3333-4333-8333-333333333333",
    "old backlog",
    "2026-08-28T10:02:00.000Z",
  );
  const first = row(
    "44444444-4444-4444-8444-444444444444",
    "first live arrival",
    "2026-08-28T10:03:00.000Z",
  );
  const duringDowntime = row(
    "55555555-5555-4555-8555-555555555555",
    "arrived while down",
    "2026-08-28T10:04:00.000Z",
  );
  const memory = memoryStore(undefined);
  const firstAbort = new AbortController();
  const firstEmitted: string[] = [];
  let firstRead = 0;

  await runArrivalWatch({
    workspaceId: WORKSPACE,
    principalId: AGENT,
    store: memory.store,
    signal: firstAbort.signal,
    sleep: async () => {},
    readPage: async ({ baseline, after }) => {
      firstRead += 1;
      if (baseline) {
        assert.equal(after, null);
        return page([old]);
      }
      assert.deepEqual(after, { created_at: old.created_at, id: old.id });
      return page([first]);
    },
    emit: async (signal) => {
      firstEmitted.push(signal.id);
      firstAbort.abort();
    },
  });
  assert.equal(firstRead, 2);
  assert.deepEqual(firstEmitted, [first.id], "the first-run backlog must not replay");
  assert.deepEqual(memory.value(), { created_at: first.created_at, id: first.id });

  const restartAbort = new AbortController();
  const restartEmitted: string[] = [];
  await runArrivalWatch({
    workspaceId: WORKSPACE,
    principalId: AGENT,
    store: memory.store,
    signal: restartAbort.signal,
    sleep: async () => {},
    readPage: async ({ baseline, after }) => {
      assert.equal(baseline, false);
      assert.deepEqual(after, { created_at: first.created_at, id: first.id });
      return page([duringDowntime]);
    },
    emit: async (signal) => {
      restartEmitted.push(signal.id);
      restartAbort.abort();
    },
  });
  assert.deepEqual(restartEmitted, [duringDowntime.id]);
});

test("emitting a notification does not acknowledge, dequeue, or mutate delivery receipts", async () => {
  const receipt = {
    state: "pending",
    delivered_at: null,
    acked_at: null,
    ack_outcome: null,
  };
  const before = structuredClone(receipt);
  const cursor = {
    created_at: "2026-08-28T10:05:00.000Z",
    id: "66666666-6666-4666-8666-666666666666",
  };
  const signal = row(
    "77777777-7777-4777-8777-777777777777",
    "read only",
    "2026-08-28T10:06:00.000Z",
  );
  const abort = new AbortController();
  let readCalls = 0;
  await runArrivalWatch({
    workspaceId: WORKSPACE,
    principalId: AGENT,
    store: memoryStore(cursor).store,
    signal: abort.signal,
    sleep: async () => {},
    readPage: async () => {
      readCalls += 1;
      return page([signal]);
    },
    emit: async () => abort.abort(),
  });
  assert.equal(readCalls, 1);
  assert.deepEqual(receipt, before);
});

test("a message naming this agent at position 1 is emitted, and one naming other agents still stops the watch", async () => {
  /* THE THROW THIS CLOSES, and it was live before this lane. L2 (merge 060ff67)
   * made the read edge return a signal to EVERY agent the sender named, while
   * `to_agent` still holds only the first. The guard here asked the scalar
   * question and THREW on a correct page, taking `cswarm inbox --notify` down
   * for a message the sender had addressed to this agent.
   *
   * The guard is not softened. It now asks whether the recipient set names this
   * principal, which is the question it always meant. */
  const otherAgent = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const secondSeat: SignalRecord = {
    ...row(
      "66666666-6666-4666-8666-666666666666",
      "both of you",
      "2026-08-28T10:05:00.000Z",
    ),
    to_agent: otherAgent,
    recipients: [
      { kind: "agent", id: otherAgent, position: 0 },
      { kind: "agent", id: AGENT, position: 1 },
    ],
  };
  const abort = new AbortController();
  const emitted: string[] = [];
  await runArrivalWatch({
    workspaceId: WORKSPACE,
    principalId: AGENT,
    store: memoryStore({
      created_at: "2026-08-28T10:04:00.000Z",
      id: "55555555-5555-4555-8555-555555555555",
    }).store,
    signal: abort.signal,
    sleep: async () => {},
    readPage: async () => page([secondSeat]),
    emit: async (signal) => {
      emitted.push(signal.id);
      abort.abort();
    },
  });
  assert.deepEqual(emitted, [secondSeat.id]);

  /* CONTROL: the SAME field, the same page shape, and the only difference is
   * that the set does not name this principal. The watch must still refuse it,
   * or the guard has been deleted rather than corrected. */
  const notMine: SignalRecord = {
    ...secondSeat,
    id: "77777777-7777-4777-8777-777777777777",
    recipients: [
      { kind: "agent", id: otherAgent, position: 0 },
      { kind: "agent", id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", position: 1 },
    ],
  };
  const refusedAbort = new AbortController();
  let refusedEmits = 0;
  const refused = await runArrivalWatch({
    workspaceId: WORKSPACE,
    principalId: AGENT,
    store: memoryStore({
      created_at: "2026-08-28T10:04:00.000Z",
      id: "55555555-5555-4555-8555-555555555555",
    }).store,
    signal: refusedAbort.signal,
    sleep: async () => {},
    readPage: async () => page([notMine]),
    emit: async () => {
      refusedEmits += 1;
      refusedAbort.abort();
    },
  });
  assert.equal(refused.reason, "error");
  assert.match(
    refused.error?.message ?? "",
    /directed to another workspace or agent/,
  );
  assert.equal(refusedEmits, 0, "and nothing was handed to the session");

  /* CONTROL: a page with NO recipients field at all still passes on the scalar
   * column, so an edge that never reports a set keeps working. */
  const scalarAbort = new AbortController();
  const scalarEmitted: string[] = [];
  await runArrivalWatch({
    workspaceId: WORKSPACE,
    principalId: AGENT,
    store: memoryStore({
      created_at: "2026-08-28T10:04:00.000Z",
      id: "55555555-5555-4555-8555-555555555555",
    }).store,
    signal: scalarAbort.signal,
    sleep: async () => {},
    readPage: async () =>
      page([
        row(
          "88888888-8888-4888-8888-888888888888",
          "old edge, scalar only",
          "2026-08-28T10:06:00.000Z",
        ),
      ]),
    emit: async (signal) => {
      scalarEmitted.push(signal.id);
      scalarAbort.abort();
    },
  });
  assert.equal(scalarEmitted.length, 1);
});

test("a stale arrival watch lock is stolen when the other pid is gone", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-notify-stale-"));
  const lockPath = join(root, "watch.lock");
  await writeFile(lockPath, `${JSON.stringify({ version: 1, pid: 999999 })}\n`, {
    mode: 0o600,
  });
  assert.equal(await acquireArrivalWatchLock(lockPath, process.pid), true);
  const raw = await readFile(lockPath, "utf8");
  assert.match(raw, new RegExp(`"pid":${process.pid}`));
  await releaseArrivalWatchLock(lockPath, process.pid);
  await rm(root, { recursive: true, force: true });
});

test("two stale seat or legacy takeovers leave one watcher", { timeout: 8_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-watch-takeover-"));
  try {
    for (const path of [arrivalWatchLockPath(CLOUD, WORKSPACE, AGENT, root),
      legacyArrivalWatchLockPath(CLOUD, WORKSPACE, AGENT, root)]) {
      await writeFile(path, `${JSON.stringify({ version: 1, pid: 999_999_999 })}\n`, { mode: 0o600 });
      let entered!: () => void;
      let release!: () => void;
      const atMove = new Promise<void>(resolve => { entered = resolve; });
      const blocked = new Promise<void>(resolve => { release = resolve; });
      const first = acquireArrivalWatchLock(path, process.pid, undefined,
        { onBeforeStaleMove: async () => { entered(); await blocked; } });
      try {
        await atMove;
        let secondEntered = false;
        const second = acquireArrivalWatchLock(path, process.pid, undefined,
          { onBeforeStaleMove: async () => { secondEntered = true; } });
        await new Promise(resolve => setTimeout(resolve, 60));
        assert.equal(secondEntered, false, "the second takeover must wait for the first publication");
        release();
        assert.equal(await first, true);
        await assert.rejects(second, ArrivalWatchAlreadyRunningError);
        assert.equal(JSON.parse(await readFile(path, "utf8")).pid, process.pid);
      } finally {
        release();
        await first.catch(() => undefined);
        await releaseArrivalWatchLock(path);
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a changed owner survives the stale watcher's moved-record check", { timeout: 3_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-watch-moved-"));
  const path = join(root, "watch.lock");
  const replacement = `${JSON.stringify({ version: 1, pid: process.pid })}\n`;
  try {
    await writeFile(path, `${JSON.stringify({ version: 1, pid: 999_999_999 })}\n`);
    await assert.rejects(acquireArrivalWatchLock(path, process.pid, undefined, {
      onBeforeStaleMove: async () => {
        await writeFile(`${path}.new`, replacement);
        await rename(`${path}.new`, path);
      },
    }), ArrivalWatchAlreadyRunningError);
    assert.equal(await readFile(path, "utf8"), replacement);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a future-dated incomplete watcher lock obeys one deadline", { timeout: 7_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-watch-future-"));
  const path = join(root, "watch.lock");
  try {
    await writeFile(path, "{partial");
    const future = new Date(Date.now() + 60_000);
    await utimes(path, future, future);
    const start = Date.now();
    await assert.rejects(acquireArrivalWatchLock(path), (error: Error) => {
      assert.match(error.message, /timed out waiting for the watch lock.*The lock was retained/);
      assert.doesNotMatch(error.message, /rm --/, "never advises removing an unverified lock");
      return true;
    });
    assert.ok(Date.now() - start < 6_000);
    assert.equal(await readFile(path, "utf8"), "{partial", "the retained lock is left untouched");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("seat and legacy live owners survive an aged record", { timeout: 4_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-watch-aged-live-"));
  const clock = Date.now;
  try {
    for (const path of [arrivalWatchLockPath(CLOUD, WORKSPACE, AGENT, root),
      legacyArrivalWatchLockPath(CLOUD, WORKSPACE, AGENT, root)]) {
      await acquireArrivalWatchLock(path);
      const before = await readFile(path, "utf8");
      Date.now = () => clock() + 61_000;
      await assert.rejects(acquireArrivalWatchLock(path), ArrivalWatchAlreadyRunningError);
      Date.now = clock;
      assert.equal(await readFile(path, "utf8"), before);
      await releaseArrivalWatchLock(path);
    }
  } finally { Date.now = clock; await rm(root, { recursive: true, force: true }); }
});

test("dead symlink owner is taken over without deleting its target before the move", { timeout: 4_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-watch-symlink-"));
  const path = join(root, "watch.lock");
  let child: ReturnType<typeof spawn> | null = null;
  try {
    child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
      `import { acquireArrivalWatchLock } from './src/cloud/arrival-watch.ts';
       await acquireArrivalWatchLock(process.argv[1], process.pid, undefined, {
         publishLink: async () => { throw Object.assign(new Error('unsupported'), { code: 'EPERM' }); },
       });
       process.stdout.write('ready\\n'); await new Promise(() => {});`, path],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    await new Promise<void>((resolve, reject) => {
      child!.stdout!.once("data", () => resolve());
      child!.once("error", reject);
      child!.once("close", code => reject(new Error(`publisher exited: ${code}`)));
    });
    assert.equal((await readdir(root)).filter(name => name.endsWith(".tmp")).length, 1);
    const target = await readlink(path);
    child.kill("SIGKILL");
    await new Promise<void>(resolve => child!.once("close", () => resolve()));
    await cleanupDeadOwnerTemps(root, "watch.lock");
    assert.match(await readFile(target, "utf8"), /"owner_id"/);
    assert.equal(await acquireArrivalWatchLock(path), true);
    assert.equal((await readdir(root)).filter(name => name.endsWith(".tmp")).length, 0);
    await releaseArrivalWatchLock(path);
  } finally {
    if (child?.exitCode === null && child?.signalCode === null) {
      child.kill("SIGKILL");
      await new Promise<void>(resolve => child!.once("close", () => resolve()));
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("a killed watcher publisher's private temp is removed on the next start", { timeout: 8_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-watch-temp-"));
  const path = join(root, "watch.lock");
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    `import { acquireArrivalWatchLock } from './src/cloud/arrival-watch.ts';
     await acquireArrivalWatchLock(process.argv[1], process.pid, undefined,
       { onBeforePublish: async () => { process.stdout.write('ready\\n'); await new Promise(() => {}); } });`,
    path], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout!.once("data", () => resolve());
      child.once("error", reject);
      child.once("close", code => reject(new Error(`publisher exited early: ${code}`)));
    });
    assert.equal((await readdir(root)).filter(name => /^watch\.lock\.\d+\.[0-9a-f]+\.tmp$/.test(name)).length, 1);
    child.kill("SIGKILL");
    await new Promise<void>(resolve => child.once("close", () => resolve()));
    await acquireArrivalWatchLock(path);
    assert.equal((await readdir(root)).filter(name => /^watch\.lock\.\d+\.[0-9a-f]+\.tmp$/.test(name)).length, 0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await new Promise<void>(resolve => child.once("close", () => resolve()));
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("seat and legacy watcher locks publish a complete owner before either contender can acquire", { timeout: 5_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-watch-atomic-"));
  try {
    for (const path of [arrivalWatchLockPath(CLOUD, WORKSPACE, AGENT, root),
      legacyArrivalWatchLockPath(CLOUD, WORKSPACE, AGENT, root)]) {
      let entered!: () => void;
      let release!: () => void;
      const publishing = new Promise<void>(resolve => { entered = resolve; });
      const blocked = new Promise<void>(resolve => { release = resolve; });
      const first = acquireArrivalWatchLock(path, process.pid, undefined, { onBeforePublish: async () => {
        entered();
        await blocked;
      } });
      try {
        await publishing;
        await assert.rejects(stat(path), { code: "ENOENT" }, "a slow writer must not expose an empty lock");
        const second = acquireArrivalWatchLock(path);
        release();
        const outcomes = await Promise.allSettled([first, second]);
        assert.equal(outcomes.filter(result => result.status === "fulfilled").length, 1);
        assert.equal(outcomes.filter(result => result.status === "rejected" &&
          result.reason instanceof ArrivalWatchAlreadyRunningError).length, 1);
        assert.equal(JSON.parse(await readFile(path, "utf8")).pid, process.pid);
      } finally {
        release();
        await first.catch(() => undefined);
        await releaseArrivalWatchLock(path);
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
