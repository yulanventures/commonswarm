import { homedir, platform } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { basename, dirname, join } from "node:path";
import { link, lstat, open, readFile, rename, unlink } from "node:fs/promises";
import type { SignalRecord } from "./command-client.js";
import type { CloudTarget } from "./config.js";
import { printedCommand, WAKE_LEASE_RENEW_MS } from "./wake-lease-constants.js";
import { WakeLeaseTransientError } from "./wake-lease.js";
import {
  followHttpDetails,
  isRetryableFollowError,
  nextFollowBackoffMs,
  publicReplyThreadRoot,
  signalReachesAgent,
  SIGNAL_FOLLOW_PAGE_LIMIT,
  type AgentSignalPage,
  type SignalCursor,
} from "./signals.js";
import {
  deleteSecureJsonFile,
  ensureSecureStateDirectory,
  cleanupDeadOwnerTemps,
  FileLockTimeoutError,
  fileLockTimeoutSentence,
  HOST_ID_LOCK_INCOMPLETE_GRACE_MS,
  publishCompleteOwnerFile,
  readSecureJsonFile,
  removeObservedOwnerFile,
  withFileLock,
  writeSecureJsonFile,
} from "./storage.js";
import {
  ARRIVAL_WATCH_POLL_MS as IDLE_ARRIVAL_WATCH_POLL_MS,
  IDLE_POLL_MAX_MS,
  nextIdlePollMs,
} from "./idle-poll.js";
import {
  LISTENER_RECONCILE_POLL_MS,
  LISTENER_WAKE_MODE_PUSH,
  type WakeHandle,
} from "../listener/wake.js";
import type { StdoutConsumerAdapter } from "../stdout-consumer.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CURSOR_MAX_BYTES = 4 * 1024;
/** Readable notification line: the body collapsed to one line, at most this long. */
export const ARRIVAL_SNIPPET_MAX = 180;
const WATCH_LOCK_MAX_BYTES = 512;

/** A remote-friendly cadence for a long-lived, human-visible arrival monitor. */
export const ARRIVAL_WATCH_POLL_MS = IDLE_ARRIVAL_WATCH_POLL_MS;
/** Continuous read failure time before a human-visible monitor warning. */
export const ARRIVAL_RETRY_NOTICE_THRESHOLD_MS = 60_000;
/** sysexits EX_IOERR: stdout's pipe reader is gone, so the monitor must stop. */
export const EXIT_NOTIFY_ORPHANED = 74;
export const NOTIFY_FLAG = "notify";
export const NOTIFY_RESTART_COMMAND = `cswarm inbox --${NOTIFY_FLAG}`;
export const NOTIFY_SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 } as const;

export interface NotifyRestartOptions {
  /** Original parsed option tokens, before profile expansion; never credential contents. */
  arguments?: readonly string[];
  agentTokenFile?: string;
  agentTokenStdin?: boolean;
  workspaceId?: string;
  url?: string;
  anonKey?: string;
}

function shellArg(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value)
    ? value : `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function notifyRestartCommand(options: NotifyRestartOptions): string {
  const parts = [NOTIFY_RESTART_COMMAND];
  if (options.arguments !== undefined) return [...parts, ...options.arguments.map(shellArg)].join(" ");
  if (options.agentTokenFile !== undefined) parts.push("--agent-token-file", shellArg(options.agentTokenFile));
  if (options.agentTokenStdin) parts.push("--agent-token-stdin");
  if (options.workspaceId !== undefined) parts.push("--workspace-id", shellArg(options.workspaceId));
  if (options.url !== undefined) parts.push("--url", shellArg(options.url));
  if (options.anonKey !== undefined) parts.push("--anon-key", shellArg(options.anonKey));
  return parts.join(" ");
}

/** The origin of stdin is unknown, so no command can be offered for that form. */
export function notifyRefusalRestartCommand(options: NotifyRestartOptions): string | null {
  return options.agentTokenStdin || options.arguments?.includes("--agent-token-stdin")
    ? null : notifyRestartCommand(options);
}

export function notifySignalStopSentence(signal: keyof typeof NOTIFY_SIGNAL_EXIT_CODES,
  options: NotifyRestartOptions, holder: "released" | "last-known" | "watcher" | "h0_poll" | "unclaimed" | "claim-unknown" | "session-refused" = "unclaimed",
  sessionRefusal?: string): string {
  if (holder === "session-refused") {
    return `inbox --notify stopped because of ${signal} after a session refusal: ${sessionRefusal ?? "inspect this seat's resume output for a verified live context on this host"}`;
  }
  const state = { released: "this watcher's lease was released; nothing is watching this inbox now",
    "last-known": "this watcher held the lease at its last renewal; another surface may have taken over since",
    watcher: "another watcher holds this inbox now", h0_poll: "H0 poll holds this inbox now",
    unclaimed: "this watcher had not claimed the inbox lease",
    "claim-unknown": "this watcher's claim result is unknown; check this seat's wake lease before starting another watcher; any lease it took expires within 3 minutes" }[holder];
  const prose = `inbox --notify stopped because of ${signal} and ${state}; start it again under the session's Monitor`;
  return options.agentTokenStdin || options.arguments?.includes("--agent-token-stdin")
    ? `${prose} the same way it was started, with the agent token on stdin.`
    : printedCommand(`${prose}.`, notifyRestartCommand(options));
}

/** Stable typed failure for a notify monitor whose stdout reader has closed. */
export class NotifyStdoutClosedError extends Error {
  readonly name = "NotifyStdoutClosedError";
  readonly code = "notify_stdout_closed";

  constructor() {
    super(
      "[notify_stdout_closed] inbox --notify lost its stdout reader and stopped before advancing its cursor. Start one fresh watcher under a live Monitor.",
    );
  }
}

export type ArrivalRetryNotice =
  | {
    code: "arrival_read_persisting";
    continuousFailureMs: number;
    nextRetryMs: number;
  }
  | {
    code: "arrival_read_recovered";
    continuousFailureMs: number;
  };

export interface ArrivalRetryNoticePolicy {
  failure(nowMs: number, nextRetryMs: number): ArrivalRetryNotice | null;
  recovery(nowMs: number): ArrivalRetryNotice | null;
}

/** Collapse one retry episode to at most one failure line and one recovery line. */
export function createArrivalRetryNoticePolicy(
  thresholdMs = ARRIVAL_RETRY_NOTICE_THRESHOLD_MS,
): ArrivalRetryNoticePolicy {
  let firstFailureAt: number | null = null;
  let failureEmitted = false;
  return {
    failure(nowMs, nextRetryMs) {
      if (firstFailureAt === null) firstFailureAt = nowMs;
      const continuousFailureMs = Math.max(0, nowMs - firstFailureAt);
      if (failureEmitted || continuousFailureMs < thresholdMs) return null;
      failureEmitted = true;
      return {
        code: "arrival_read_persisting",
        continuousFailureMs,
        nextRetryMs,
      };
    },
    recovery(nowMs) {
      if (firstFailureAt === null) return null;
      const continuousFailureMs = Math.max(0, nowMs - firstFailureAt);
      const notice: ArrivalRetryNotice | null = failureEmitted
        ? { code: "arrival_read_recovered", continuousFailureMs }
        : null;
      firstFailureAt = null;
      failureEmitted = false;
      return notice;
    },
  };
}

/** Stable, one-line operator copy for a retry episode transition. */
export function formatArrivalRetryNotice(notice: ArrivalRetryNotice): string {
  const seconds = Math.max(1, Math.floor(notice.continuousFailureMs / 1_000));
  if (notice.code === "arrival_read_persisting") {
    return `[arrival_read_persisting] Arrival reads have failed continuously for ${seconds}s. ` +
      "Durable delivery is unaffected; only this monitor view is delayed. " +
      `Next check: automatic retry in ${notice.nextRetryMs}ms.`;
  }
  return `[arrival_read_recovered] Arrival reads recovered after ${seconds}s. ` +
    "This monitor is current again; durable delivery was unaffected.";
}

interface StoredArrivalCursor {
  version: 1;
  workspace_id: string;
  principal_id: string;
  cursor: SignalCursor | null;
}

export interface ArrivalCursorStore {
  readonly location: string;
  read(): Promise<SignalCursor | null | undefined>;
  write(cursor: SignalCursor | null): Promise<void>;
}

export interface ArrivalWatchPageRequest {
  /** Null only after an empty first-run baseline. */
  after: SignalCursor | null;
  /** Independent bounded progression cursor for open_system_alerts reconciliation. */
  alertAfter: SignalCursor | null;
  /** First run reads the newest row only and emits none of the existing backlog. */
  baseline: boolean;
  limit: number;
}

export interface ArrivalWatchStop {
  reason: "cancelled" | "error";
  error?: Error;
}

export interface ArrivalNotification {
  type: "arrival";
  workspace_id: string;
  signal_id: string;
  sender: string;
  sender_kind: SignalRecord["from_kind"];
  kind: SignalRecord["kind"];
  /** The one-line preview the readable line shows; never the only copy. */
  snippet: string;
  /** The whole body as posted, so `--json` readers need no second command. */
  body: string;
  attachment_count: number;
  reply_command: string;
}

function stateRoot(): string {
  return process.env.XDG_STATE_HOME
    ? join(process.env.XDG_STATE_HOME, "cswarm", "arrival-cursors")
    : join(homedir(), ".cswarm", "arrival-cursors");
}

/** One durable high-water mark per deployment, workspace, and agent identity. */
export function arrivalCursorPath(
  target: CloudTarget,
  workspaceId: string,
  principalId: string,
  root = stateRoot(),
): string {
  return join(
    root,
    `${target.profileId}-${workspaceId.toLowerCase()}-${principalId.toLowerCase()}.json`,
  );
}

/** Lock beside the cursor so one host cannot run two watchers for one agent. */
export function arrivalWatchLockPath(
  target: CloudTarget,
  workspaceId: string,
  principalId: string,
  root = stateRoot(),
): string {
  void target;
  return join(root, `${workspaceId.toLowerCase()}-${principalId.toLowerCase()}.lock`);
}

/** Earlier releases used the profile-specific cursor stem for the watcher lock. */
export function legacyArrivalWatchLockPath(
  target: CloudTarget,
  workspaceId: string,
  principalId: string,
  root = stateRoot(),
): string {
  return arrivalCursorPath(target, workspaceId, principalId, root).replace(/\.json$/u, ".lock");
}

const runFile = promisify(execFile);
/** A hash only: the raw machine identifier is never stored in the state root. */
export async function arrivalMachineHash(): Promise<string | null> {
  try {
    let machineId: string | null = null;
    if (platform() === "linux") machineId = (await readFile("/etc/machine-id", "utf8")).trim();
    if (platform() === "darwin") {
      const { stdout } = await runFile("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { timeout: 2000 });
      machineId = /"IOPlatformUUID"\s*=\s*"([0-9a-f-]+)"/i.exec(stdout)?.[1] ?? null;
    }
    return machineId ? createHash("sha256").update(machineId).digest("hex") : null;
  } catch { return null; }
}

export async function arrivalHostIdFileState(lockPath: string): Promise<"present" | "missing" | "unreadable"> {
  try {
    await readFile(join(dirname(lockPath), "host-id"), "utf8");
    return "present";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
  }
}

export async function arrivalHostId(lockPath: string, machineHash?: string | null): Promise<string> {
  machineHash = machineHash === undefined ? await arrivalMachineHash() : machineHash;
  const path = join(dirname(lockPath), "host-id");
  await ensureSecureStateDirectory(dirname(path));
  return await withFileLock(dirname(path), "host-id-rotation", async () => {
  let noticed = false;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let exists = false;
    let valid: { host_id: string; machine_hash: string | null } | null = null;
    try {
      const info = await lstat(path);
      exists = true;
      if (info.isFile() && (info.mode & 0o077) === 0 && info.size <= 256) {
        const data: unknown = JSON.parse(await readFile(path, "utf8"));
        if (data && typeof data === "object" && !Array.isArray(data)) {
          const row = data as Record<string, unknown>;
          if (typeof row.host_id === "string" && UUID_RE.test(row.host_id) &&
              (row.machine_hash === null ||
                typeof row.machine_hash === "string" && /^[0-9a-f]{64}$/.test(row.machine_hash))) {
            valid = { host_id: row.host_id.toLowerCase(), machine_hash: row.machine_hash as string | null };
          }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    if (valid && (machineHash === null || valid.machine_hash === machineHash)) return valid.host_id;
    if (valid && valid.machine_hash === null && machineHash !== null) {
      const temporary = join(dirname(path), `.host-id-${randomUUID()}.tmp`);
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({ host_id: valid.host_id, machine_hash: machineHash })}\n`, "utf8");
      } finally { await handle.close(); }
      try {
        await rename(temporary, path);
      } finally { await unlink(temporary).catch(() => undefined); }
      return valid.host_id;
    }
    if (exists) {
      if (!noticed) {
        process.stderr.write(`cswarm: replacing invalid or copied host id at ${path}.\n`);
        noticed = true;
      }
      await unlink(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    const temporary = join(dirname(path), `.host-id-${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    const hostId = randomUUID();
    try {
      await handle.writeFile(`${JSON.stringify({ host_id: hostId, machine_hash: machineHash })}\n`, "utf8");
    } finally { await handle.close(); }
    try {
      await link(temporary, path);
      return hostId;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally { await unlink(temporary); }
  }
  throw new Error(`could not create host id at ${path}`);
  }, { stalePolicy: "host-id" });
}

export function arrivalWatchAlreadyRunningSentence(pid: number): string {
  return `inbox --notify is already running for this agent as pid ${pid}; a new start replaces it, so nothing needs to be stopped.`;
}

export class ArrivalWatchAlreadyRunningError extends Error {
  readonly code = "notify_already_running";
  readonly pid: number;
  constructor(pid: number) {
    super(arrivalWatchAlreadyRunningSentence(pid));
    this.name = "ArrivalWatchAlreadyRunningError";
    this.pid = pid;
  }
}

function pidIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function parseWatchLock(raw: string): { pid: number; watcherId: string | null } | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.version !== 1 || !Number.isSafeInteger(row.pid) || (row.pid as number) <= 0) {
    return null;
  }
  return { pid: row.pid as number,
    watcherId: typeof row.watcher_id === "string" && UUID_RE.test(row.watcher_id)
      ? row.watcher_id.toLowerCase() : null };
}

export async function acquireArrivalWatchLock(
  path: string,
  pid: number = process.pid,
  watcherId?: string,
  options: { publishLink?: typeof link; onBeforePublish?: () => Promise<void>;
    onBeforeStaleMove?: () => Promise<void> } = {},
): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error("arrival watch lock pid must be a positive integer");
  }
  await ensureSecureStateDirectory(dirname(path));
  const deadline = Date.now() + 5_000;
  const payload = `${JSON.stringify({ version: 1, pid, owner_id: randomUUID(),
    ...(watcherId ? { watcher_id: watcherId } : {}) })}\n`;
  const gateName = `watch-takeover-${createHash("sha256").update(path).digest("hex").slice(0, 24)}`;
  return await withFileLock(dirname(path), gateName, async () => {
    await cleanupDeadOwnerTemps(dirname(path), basename(path));
    let replacedDeadPredecessor = false;
    while (Date.now() < deadline) {
      try {
        await publishCompleteOwnerFile(path, payload, options);
        return replacedDeadPredecessor;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      let existing: { pid: number; watcherId: string | null } | null = null;
      let observedRaw: string | null = null;
      try {
        const raw = await readFile(path, "utf8");
        observedRaw = raw;
        if (Buffer.byteLength(raw, "utf8") <= WATCH_LOCK_MAX_BYTES) {
          existing = parseWatchLock(raw);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (!await lstat(path).catch(() => null)) {
          await delay(25);
          continue;
        }
      }
      if (existing !== null && pidIsAlive(existing.pid)) {
        throw new ArrivalWatchAlreadyRunningError(existing.pid);
      }
      if (existing === null) {
        const info = await lstat(path).catch(() => null);
        if (info === null) continue;
        if (Date.now() - info.mtimeMs < HOST_ID_LOCK_INCOMPLETE_GRACE_MS) {
          await delay(Math.min(25, Math.max(0, deadline - Date.now())));
          continue;
        }
      }
      await options.onBeforeStaleMove?.();
      if (!await removeObservedOwnerFile(path, observedRaw)) continue;
      await cleanupDeadOwnerTemps(dirname(path), basename(path));
      if (existing !== null) replacedDeadPredecessor = true;
    }
    throw new Error(fileLockTimeoutSentence(basename(path, ".lock"), path));
  }, { stalePolicy: "host-id", timeoutMs: Math.max(0, deadline - Date.now()) });
}

/** Hold both lock names while old and new watcher binaries may overlap. */
export async function acquireArrivalWatchSeatLocks(
  target: CloudTarget,
  workspaceId: string,
  principalId: string,
  pid: number = process.pid,
  watcherId?: string,
  root = stateRoot(),
): Promise<{ lockPath: string; legacyLockPath: string }> {
  const lockPath = arrivalWatchLockPath(target, workspaceId, principalId, root);
  const legacyLockPath = legacyArrivalWatchLockPath(target, workspaceId, principalId, root);
  await acquireArrivalWatchLock(legacyLockPath, pid, watcherId);
  try {
    await acquireArrivalWatchLock(lockPath, pid, watcherId);
  } catch (error) {
    await releaseArrivalWatchLock(legacyLockPath, pid);
    throw error;
  }
  return { lockPath, legacyLockPath };
}

export async function releaseArrivalWatchSeatLocks(
  paths: { lockPath: string; legacyLockPath: string },
  pid: number = process.pid,
): Promise<void> {
  await releaseArrivalWatchLock(paths.lockPath, pid);
  await releaseArrivalWatchLock(paths.legacyLockPath, pid);
}

/**
 * How long a new watcher waits for the one it replaced to let go of the seat's locks. The replaced
 * watcher stops when its next renewal is refused, so the bound covers one full renewal period, the
 * 15-second renewal request, the same-host check that follows it and the watcher's teardown.
 */
export const NOTIFY_TAKEOVER_TIMEOUT_MS = WAKE_LEASE_RENEW_MS + 45_000;
const NOTIFY_TAKEOVER_POLL_MS = 250;
const TAKEOVER_RECORD_MAX_BYTES = 1024;

/** Said by a watcher that a newer start on this host replaced. It exits 0: nothing needs doing. */
export function notifyReplacedSentence(pid: number): string {
  return `[notify_replaced] inbox --notify was replaced by a newer watcher on this host (pid ${pid}) and stopped; nothing else is needed.`;
}

/** The replaced watcher's process did not stop. Name that exact pid; never suggest a pattern. */
export class ArrivalWatchReplaceTimeoutError extends Error {
  readonly code = "notify_replace_timeout";
  constructor(readonly pid: number, waitedMs: number) {
    super(`[notify_replace_timeout] inbox --notify for this agent was replaced, but pid ${pid} did not stop within ${Math.round(waitedMs / 1000)} seconds and still holds this seat's watch lock. This start released its lease and stopped. Confirm that pid ${pid} is a cswarm inbox --notify process, stop only that pid, then start it again.`);
    this.name = "ArrivalWatchReplaceTimeoutError";
  }
}

/** Another start for the same seat held the start gate past the whole takeover bound. */
export class ArrivalWatchStartBusyError extends Error {
  readonly code = "notify_start_busy";
  constructor(pid: number | undefined) {
    super(`[notify_start_busy] another inbox --notify for this agent is still starting${pid === undefined ? "" : ` as pid ${pid}`}; let it finish, then start it again.`);
    this.name = "ArrivalWatchStartBusyError";
  }
}

/** Beside the seat lock: which local watcher a start replaced, and by which watcher. */
export function arrivalWatchTakeoverPath(lockPath: string): string {
  return lockPath.replace(/\.lock$/u, ".takeover.json");
}

export interface ArrivalWatchTakeoverRecord {
  replaced_watcher_id: string;
  replaced_pid: number;
  watcher_id: string;
  pid: number;
}

export async function readArrivalWatchTakeover(lockPath: string): Promise<ArrivalWatchTakeoverRecord | null> {
  try {
    const raw = await readSecureJsonFile(arrivalWatchTakeoverPath(lockPath), TAKEOVER_RECORD_MAX_BYTES);
    if (raw === null) return null;
    const row = JSON.parse(raw) as Record<string, unknown>;
    if (row.version !== 1 || typeof row.replaced_watcher_id !== "string" || !UUID_RE.test(row.replaced_watcher_id) ||
        typeof row.watcher_id !== "string" || !UUID_RE.test(row.watcher_id) ||
        !Number.isSafeInteger(row.replaced_pid) || !Number.isSafeInteger(row.pid)) return null;
    return { replaced_watcher_id: row.replaced_watcher_id.toLowerCase(), replaced_pid: row.replaced_pid as number,
      watcher_id: row.watcher_id.toLowerCase(), pid: row.pid as number };
  } catch {
    return null;
  }
}

async function readWatchLockOwner(path: string): Promise<{ pid: number; watcherId: string | null } | null> {
  try {
    const raw = await readFile(path, "utf8");
    return Buffer.byteLength(raw, "utf8") <= WATCH_LOCK_MAX_BYTES ? parseWatchLock(raw) : null;
  } catch {
    return null;
  }
}

/**
 * One start at a time per seat on this host, held from before the watch locks until the caller's
 * first lease claim returns. A single file lock waits at most 30 seconds, and a start that replaces
 * a watcher can hold the gate for the whole takeover bound, so this waits in rounds.
 */
export async function holdArrivalWatchStartGate(
  lockPath: string,
  signal: AbortSignal,
  timeoutMs = NOTIFY_TAKEOVER_TIMEOUT_MS + 30_000,
): Promise<() => Promise<void>> {
  const gateName = `notify-start-${createHash("sha256").update(lockPath).digest("hex").slice(0, 24)}`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let release = () => {};
    let held = () => {};
    const acquired = new Promise<void>(resolvePromise => { held = resolvePromise; });
    const holding = withFileLock(dirname(lockPath), gateName, async () => {
      held();
      await new Promise<void>(resolvePromise => { release = resolvePromise; });
    }, { signal, timeoutMs: Math.max(0, Math.min(30_000, deadline - Date.now())) });
    try {
      await Promise.race([acquired, holding]);
      return async () => { release(); await holding; };
    } catch (error) {
      if (!(error instanceof FileLockTimeoutError) || error.gate) throw error;
      if (Date.now() >= deadline) throw new ArrivalWatchStartBusyError(error.ownerPid);
    }
  }
}

/**
 * Take the seat's watch locks. When a live watcher on this host holds them, replace it without a
 * signal: claim the wake lease (the server lets a same-host claim supersede), then wait for that
 * watcher to see its renewal refused and let go. Call this under holdArrivalWatchStartGate.
 */
export async function acquireArrivalWatchSeatLocksReplacing(options: {
  target: CloudTarget;
  workspaceId: string;
  principalId: string;
  watcherId: string;
  /** One claim attempt; returns the generation, or throws the claim's refusal or transport error. */
  claim(): Promise<number>;
  /** Give back a claimed lease when the replaced watcher never let go. */
  release(generation: number): Promise<void>;
  replacing?(pid: number): void;
  signal: AbortSignal;
  pid?: number;
  root?: string;
  timeoutMs?: number;
}): Promise<{ lockPath: string; legacyLockPath: string }> {
  const pid = options.pid ?? process.pid;
  const acquire = () => acquireArrivalWatchSeatLocks(options.target, options.workspaceId,
    options.principalId, pid, options.watcherId, options.root);
  let holderPid: number;
  try {
    return await acquire();
  } catch (error) {
    if (!(error instanceof ArrivalWatchAlreadyRunningError)) throw error;
    holderPid = error.pid;
  }
  const lockPath = arrivalWatchLockPath(options.target, options.workspaceId, options.principalId, options.root);
  const legacyLockPath = legacyArrivalWatchLockPath(options.target, options.workspaceId, options.principalId, options.root);
  const holder = [await readWatchLockOwner(lockPath), await readWatchLockOwner(legacyLockPath)]
    .find(owner => owner !== null && owner.pid === holderPid && owner.watcherId !== null);
  const recordPath = arrivalWatchTakeoverPath(lockPath);
  if (holder?.watcherId) {
    await writeSecureJsonFile(recordPath, `${JSON.stringify({ version: 1,
      replaced_watcher_id: holder.watcherId, replaced_pid: holderPid,
      watcher_id: options.watcherId.toLowerCase(), pid })}\n`);
  }
  const timeoutMs = options.timeoutMs ?? NOTIFY_TAKEOVER_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let generation: number | null = null;
  let failures = 0;
  let claimError: unknown = null;
  const giveUp = async (error: unknown): Promise<never> => {
    if (generation !== null) await options.release(generation).catch(() => undefined);
    await deleteSecureJsonFile(recordPath).catch(() => undefined);
    throw error;
  };
  for (;;) {
    if (options.signal.aborted) return await giveUp(options.signal.reason);
    if (generation === null) {
      try {
        generation = await options.claim();
        options.replacing?.(holderPid);
      } catch (error) {
        if (!(error instanceof WakeLeaseTransientError) || options.signal.aborted) return await giveUp(error);
        failures += 1;
        claimError = error;
      }
    }
    if (generation !== null) {
      try {
        const locks = await acquire();
        await deleteSecureJsonFile(recordPath).catch(() => undefined);
        return locks;
      } catch (error) {
        if (!(error instanceof ArrivalWatchAlreadyRunningError)) return await giveUp(error);
        holderPid = error.pid;
      }
    }
    if (Date.now() >= deadline) {
      return await giveUp(generation === null ? claimError : new ArrivalWatchReplaceTimeoutError(holderPid, timeoutMs));
    }
    await delay(Math.min(generation === null ? 1000 * 2 ** Math.min(failures, 4) : NOTIFY_TAKEOVER_POLL_MS,
      Math.max(0, deadline - Date.now())), undefined, { signal: options.signal }).catch(() => undefined);
  }
}

export async function arrivalWatchLockIdentity(path: string): Promise<string | null> {
  try {
    const raw = await readFile(path, "utf8");
    if (Buffer.byteLength(raw, "utf8") > WATCH_LOCK_MAX_BYTES) return null;
    const lock = parseWatchLock(raw);
    return lock !== null && pidIsAlive(lock.pid) ? lock.watcherId : null;
  } catch {
    return null;
  }
}

export async function releaseArrivalWatchLock(
  path: string,
  pid: number = process.pid,
): Promise<void> {
  try {
    const raw = await readFile(path, "utf8");
    const existing = parseWatchLock(raw);
    if (existing === null || existing.pid !== pid) return;
    await removeObservedOwnerFile(path, raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

export async function arrivalWatchLockHeld(path: string): Promise<boolean> {
  try {
    const raw = await readFile(path, "utf8");
    if (Buffer.byteLength(raw, "utf8") > WATCH_LOCK_MAX_BYTES) return false;
    const existing = parseWatchLock(raw);
    return existing !== null && pidIsAlive(existing.pid);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function parseCursor(
  raw: string,
  workspaceId: string,
  principalId: string,
): SignalCursor | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("stored arrival cursor is malformed");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("stored arrival cursor is malformed");
  }
  const row = value as Record<string, unknown>;
  const cursor = row.cursor;
  if (
    row.version !== 1 ||
    row.workspace_id !== workspaceId.toLowerCase() ||
    row.principal_id !== principalId.toLowerCase() ||
    !(
      cursor === null ||
      (
        typeof cursor === "object" &&
        !Array.isArray(cursor) &&
        typeof (cursor as Record<string, unknown>).created_at === "string" &&
        Number.isFinite(Date.parse((cursor as Record<string, unknown>).created_at as string)) &&
        typeof (cursor as Record<string, unknown>).id === "string" &&
        UUID_RE.test((cursor as Record<string, unknown>).id as string)
      )
    )
  ) {
    throw new Error("stored arrival cursor is malformed");
  }
  if (cursor === null) return null;
  return {
    created_at: (cursor as Record<string, string>).created_at,
    id: (cursor as Record<string, string>).id.toLowerCase(),
  };
}

/** Secure atomic cursor storage; it contains ids and timestamps, never a credential. */
export function fileArrivalCursorStore(options: {
  target: CloudTarget;
  workspaceId: string;
  principalId: string;
  stateDirectory?: string;
}): ArrivalCursorStore {
  const workspaceId = options.workspaceId.toLowerCase();
  const principalId = options.principalId.toLowerCase();
  if (!UUID_RE.test(workspaceId) || !UUID_RE.test(principalId)) {
    throw new Error("arrival cursor identity must use workspace and principal UUIDs");
  }
  const location = arrivalCursorPath(
    options.target,
    workspaceId,
    principalId,
    options.stateDirectory,
  );
  return {
    location,
    async read() {
      const raw = await readSecureJsonFile(location, CURSOR_MAX_BYTES);
      return raw === null ? undefined : parseCursor(raw, workspaceId, principalId);
    },
    async write(cursor) {
      const record: StoredArrivalCursor = {
        version: 1,
        workspace_id: workspaceId,
        principal_id: principalId,
        cursor,
      };
      await writeSecureJsonFile(location, JSON.stringify(record));
    },
  };
}

export function arrivalSnippetWasCut(body: string): boolean {
  return arrivalOneLine(body).length > ARRIVAL_SNIPPET_MAX;
}

/* The command that shows the whole body when the readable line could not. Built
 * the way arrivalReplyCommand is: the reader is an agent, an agent identity comes
 * only from its credential flags and then REQUIRES a workspace, so a bare
 * `cswarm inbox` cannot show this reader anything (measured by CSwarmDevLead on
 * 0.1.60: the bare form asks a person to log in; with only the credential it
 * refuses to infer a target). The url and anon key are omitted for the reason
 * recorded on arrivalReplyCommand. */
export function arrivalFullTextCommand(workspaceId: string): string {
  return `cswarm inbox --workspace-id ${workspaceId}`;
}

export function arrivalSnippetSuffix(
  notification: Pick<ArrivalNotification, "snippet" | "body" | "workspace_id">,
): string {
  if (!arrivalSnippetWasCut(notification.body)) return "";
  const shown = notification.snippet.length.toLocaleString("en-US");
  const total = notification.body.length.toLocaleString("en-US");
  return ` (${shown} of ${total} chars; full text: ${arrivalFullTextCommand(notification.workspace_id)})`;
}

export function arrivalSnippet(body: string): string {
  const oneLine = arrivalOneLine(body);
  if (oneLine.length <= ARRIVAL_SNIPPET_MAX) return oneLine;
  return `${oneLine.slice(0, ARRIVAL_SNIPPET_MAX - 1).trimEnd()}…`;
}

function arrivalOneLine(body: string): string {
  const oneLine = body
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return oneLine;
}

/* Matches the hook's reply hint deliberately. The url and anon key come from the
 * agent's saved target, so repeating them here only bloated every notification —
 * the anon key is a JWT, and a monitor line carrying it is unreadable on a phone
 * and teaches an agent to paste credentials into commands. Found by dogfooding
 * this feature within minutes of shipping it. */
export function arrivalReplyCommand(
  signalId: string,
  workspaceId: string,
  /** The thread a message the workspace or channel reads is answered in (publicReplyThreadRoot). */
  threadRootId: string | null = null,
): string {
  return threadRootId === null
    ? `cswarm reply ${signalId} "<answer>" --workspace-id ${workspaceId}`
    : `cswarm reply ${threadRootId} "<answer>" --thread --workspace-id ${workspaceId}`;
}

export function arrivalNotification(
  signal: SignalRecord,
  workspaceId: string,
  target: Pick<CloudTarget, "url" | "anonKey">,
): ArrivalNotification {
  return {
    type: "arrival",
    workspace_id: workspaceId,
    signal_id: signal.id,
    sender: signal.from,
    sender_kind: signal.from_kind,
    kind: signal.kind,
    snippet: arrivalSnippet(signal.body),
    body: signal.body,
    attachment_count: signal.attachments?.length ?? 0,
    // A system alert resolves via cswarm alert resolve; a reaction answers in its parent thread.
    reply_command: signal.system_alert !== undefined
      ? `cswarm alert resolve ${signal.system_alert.alert_id} "<note>" --workspace-id ${workspaceId}`
      : signal.reaction !== undefined
      ? arrivalReplyCommand(signal.reaction.signal_id, workspaceId, signal.reaction.signal_id)
      : arrivalReplyCommand(signal.id, workspaceId, publicReplyThreadRoot(signal)),
  };
}

export function formatArrivalNotification(
  notification: ArrivalNotification,
): string {
  const attachmentCopy = notification.attachment_count === 0
    ? ""
    : ` — ${notification.attachment_count} attachment${notification.attachment_count === 1 ? "" : "s"}`;
  return `CommonSwarm from ${notification.sender_kind} ${notification.sender}: ${notification.snippet}${arrivalSnippetSuffix(notification)}${attachmentCopy} — reply: ${notification.reply_command}`;
}

function notifyWriteError(error: Error): Error {
  return (error as NodeJS.ErrnoException).code === "EPIPE"
    ? new NotifyStdoutClosedError()
    : error;
}

export async function writeArrivalMonitorLine(
  line: string,
  stream: NodeJS.WriteStream = process.stdout,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error | null) => {
      if (settled) return;
      settled = true;
      if (error) {
        /* Node can call the write callback with EPIPE and emit the same stream
         * error on the next tick. Keep this one-shot listener through that
         * emission so the typed stop does not become an unhandled exception. */
        setImmediate(() => stream.off("error", onError));
        reject(notifyWriteError(error));
      } else {
        stream.off("error", onError);
        resolve();
      }
    };
    const onError = (error: Error) => finish(error);
    stream.once("error", onError);
    try {
      stream.write(`${line}\n`, (error) => finish(error));
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function cursorOf(signal: SignalRecord): SignalCursor {
  return { created_at: signal.created_at, id: signal.id };
}

function assertCursorPage(page: AgentSignalPage): void {
  if (!page.capabilities.cursorAfter || page.legacyCursorFallback) {
    throw new Error(
      "arrival watch needs a read service with durable cursor support",
    );
  }
}

export async function runArrivalWatch(options: {
  workspaceId: string;
  principalId: string;
  store: ArrivalCursorStore;
  readPage(request: ArrivalWatchPageRequest): Promise<AgentSignalPage>;
  emit(signal: SignalRecord): Promise<void>;
  afterEmitBatch?: (signals: readonly SignalRecord[]) => Promise<void> | void;
  onReady?: () => Promise<void> | void;
  onRetry?: (error: Error, delayMs: number) => void;
  onRecovery?: () => void;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  pollMs?: number;
  random?: () => number;
  now?: () => number;
  wake?: WakeHandle;
  reconcileMs?: number;
  stdoutConsumer?: StdoutConsumerAdapter;
  stdoutCheckIntervalMs?: number;
  /** Optional bounded page limit override (defaults to SIGNAL_FOLLOW_PAGE_LIMIT). */
  pageLimit?: number;
}): Promise<ArrivalWatchStop> {
  const pollMs = options.pollMs ?? ARRIVAL_WATCH_POLL_MS;
  const pageLimit = options.pageLimit ?? SIGNAL_FOLLOW_PAGE_LIMIT;
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const reconcileMs = options.reconcileMs ?? LISTENER_RECONCILE_POLL_MS;
  const wake = options.wake;
  let emptyIdleStreak = 0;
  let cursor = await options.store.read();
  let baseline = cursor === undefined;
  let attempt = 0;
  let reconcileDueAt = now();
  let pendingKind: "wake" | "other" = "other";
  const checkIntervalMs = options.stdoutCheckIntervalMs ?? IDLE_POLL_MAX_MS;
  if (!Number.isFinite(checkIntervalMs) || checkIntervalMs <= 0 || checkIntervalMs > IDLE_POLL_MAX_MS) {
    throw new RangeError("stdout check interval must be within the idle poll cap");
  }
  let nextStdoutCheckAt = now();
  let ready = false;
  // Tracks (alert_id -> routed_at/created_at) already emitted so open-route reconciliation delivers
  // alerts whose route committed behind the signal cursor without duplicating emitted routes.
  // Reconciles across independent bounded pages (alertAfter) and prunes only after a complete sweep.
  const seenAlertRoutes = new Map<string, string>();
  const sweepSeenAlertIds = new Set<string>();
  let alertAfter: SignalCursor | null = null;
  let alertCyclePages = 0;
  const MAX_ALERT_PAGES_PER_CYCLE = 50;
  const cancelled = () => options.signal?.aborted === true;

  const inspectStdout = async (): Promise<void> => {
    if (!options.stdoutConsumer || cancelled() || now() < nextStdoutCheckAt) return;
    // Advance before awaiting: one watch never starts a second inspector child.
    nextStdoutCheckAt = now() + checkIntervalMs;
    let state: Awaited<ReturnType<StdoutConsumerAdapter["inspect"]>>;
    try {
      state = await options.stdoutConsumer.inspect(process.pid, options.signal);
    } catch {
      state = "cannot_determine";
    }
    if (!cancelled() && state === "orphaned") throw new NotifyStdoutClosedError();
  };

  const wait = async (ms: number): Promise<void> => {
    if (options.sleep) {
      await options.sleep(ms);
      return;
    }
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (timer !== undefined) clearTimeout(timer);
        options.signal?.removeEventListener("abort", finish);
        resolve();
      };
      if (cancelled() || ms <= 0) {
        resolve();
        return;
      }
      options.signal?.addEventListener("abort", finish, { once: true });
      timer = setTimeout(finish, ms);
    });
  };

  const waitWithStdoutChecks = async (intervalMs: number): Promise<void> => {
    if (!options.stdoutConsumer) {
      await wait(intervalMs);
      return;
    }
    const until = now() + intervalMs;
    while (!cancelled()) {
      await inspectStdout();
      const remaining = until - now();
      if (remaining <= 0) return;
      await wait(Math.min(remaining, Math.max(1, nextStdoutCheckAt - now())));
    }
  };

  const idleWait = async (hadDelivery: boolean): Promise<void> => {
    if (hadDelivery) emptyIdleStreak = 0;
    const intervalMs = nextIdlePollMs(pollMs, emptyIdleStreak, IDLE_POLL_MAX_MS);
    if (!hadDelivery) emptyIdleStreak += 1;
    await waitWithStdoutChecks(intervalMs);
  };

  const pushMode = (): boolean =>
    wake !== undefined &&
    wake.hasTopic &&
    wake.snapshot(now()).mode === LISTENER_WAKE_MODE_PUSH;

  const waitCapMs = (): number => {
    if (pushMode()) return reconcileMs;
    return nextIdlePollMs(pollMs, emptyIdleStreak, IDLE_POLL_MAX_MS);
  };

  const applyWakeHint = (page: AgentSignalPage): void => {
    const topic = page.wake?.topic;
    if (topic === undefined || wake === undefined) return;
    try {
      wake.setTopic(topic);
    } catch {
    }
  };

  const waitForTrigger = async (hadDelivery: boolean): Promise<void> => {
    if (hadDelivery) emptyIdleStreak = 0;
    if (wake === undefined || !wake.hasTopic) {
      pendingKind = "other";
      await idleWait(hadDelivery);
      return;
    }
    const cap = waitCapMs();
    const until = Math.min(reconcileDueAt, now() + cap);
    let reason: Awaited<ReturnType<WakeHandle["next"]>>;
    if (!options.stdoutConsumer) {
      reason = await wake.next({ until, ...(options.signal ? { signal: options.signal } : {}) });
    } else {
      while (true) {
        await inspectStdout();
        if (cancelled()) return;
        reason = await wake.next({
          until: Math.min(until, nextStdoutCheckAt),
          ...(options.signal ? { signal: options.signal } : {}),
        });
        if (cancelled() || reason !== "deadline" || now() >= until) break;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    if (cancelled()) return;
    if (reason === "wake" && pushMode()) {
      const coalesceMs = wake.coalescingRemainingMs(now());
      if (coalesceMs > 0) await wait(coalesceMs);
      pendingKind = pushMode() ? "wake" : "other";
      return;
    }
    pendingKind = "other";
    if (
      !hadDelivery &&
      reason === "deadline" &&
      !pushMode()
    ) {
      emptyIdleStreak += 1;
    }
  };

  const noteCycle = (): void => {
    if (pendingKind === "wake") {
      wake?.noteClaim(now());
      return;
    }
    reconcileDueAt = now() + reconcileMs;
    wake?.noteReconcile(now());
  };

  while (!cancelled()) {
    try {
      const page = await options.readPage({
        after: cursor ?? null,
        alertAfter: baseline ? null : alertAfter,
        baseline,
        limit: baseline ? 1 : pageLimit,
      });
      assertCursorPage(page);
      applyWakeHint(page);
      if (page.signals.some((row) =>
        row.workspace_id !== options.workspaceId ||
        !(
          signalReachesAgent(row, options.principalId) ||
          (row.to === null && row.to_agent === null)
        )
      ) || (page.openSystemAlerts ?? []).some((row) =>
        row.workspace_id !== options.workspaceId ||
        !signalReachesAgent(row, options.principalId)
      )) {
        throw new Error(
          "arrival read returned a message directed to another workspace or agent",
        );
      }
      if (attempt > 0) options.onRecovery?.();
      attempt = 0;

      if (baseline) {
        if (page.rawCount > 0 && page.nextCursor === null) {
          throw new Error("arrival baseline returned no safe terminal cursor");
        }
        cursor = page.nextCursor;
        await options.store.write(cursor);
        baseline = false;
        if (!ready) {
          ready = true;
          await options.onReady?.();
          // onReady may post the notify canary. Read again immediately so a
          // Realtime broadcast sent before SUBSCRIBED cannot strand that note
          // behind the five-minute push reconcile.
          if (options.onReady !== undefined && !cancelled()) continue;
        }
        if (cancelled()) break;
        noteCycle();
        await waitForTrigger(false);
        continue;
      }

      const emittedSignals: SignalRecord[] = [];
      if (alertAfter === null) {
        sweepSeenAlertIds.clear();
        alertCyclePages = 0;
      }
      for (const row of page.signals) {
        if (cancelled()) break;
        const alreadyEmittedAlert = row.system_alert !== undefined &&
          seenAlertRoutes.get(row.system_alert.alert_id) === row.created_at;
        if (row.system_alert) {
          seenAlertRoutes.set(row.system_alert.alert_id, row.created_at);
          sweepSeenAlertIds.add(row.system_alert.alert_id);
        }
        if (!alreadyEmittedAlert) {
          await options.emit(row);
          emittedSignals.push(row);
        }
        cursor = cursorOf(row);
        await options.store.write(cursor);
      }
      let continueAlertBurst = false;
      if (!cancelled()) {
        const openAlerts = page.openSystemAlerts ?? [];
        for (const alertRow of openAlerts) {
          if (cancelled()) break;
          const alertId = alertRow.system_alert?.alert_id ?? alertRow.id;
          sweepSeenAlertIds.add(alertId);
          if (seenAlertRoutes.get(alertId) === alertRow.created_at) continue;
          seenAlertRoutes.set(alertId, alertRow.created_at);
          await options.emit(alertRow);
          emittedSignals.push(alertRow);
        }
        const lastOpenAlert = openAlerts.length > 0 ? openAlerts[openAlerts.length - 1]! : null;
        const nextAlertCursor = lastOpenAlert ? cursorOf(lastOpenAlert) : null;
        const advancedAlertCursor = nextAlertCursor !== null && (
          alertAfter === null ||
          nextAlertCursor.created_at !== alertAfter.created_at ||
          nextAlertCursor.id !== alertAfter.id
        );
        if (page.openSystemAlertsHasMore === true) {
          if (advancedAlertCursor) {
            alertAfter = nextAlertCursor;
            alertCyclePages += 1;
            if (alertCyclePages < MAX_ALERT_PAGES_PER_CYCLE) {
              continueAlertBurst = true;
            } else {
              // Cycle budget reached: keep alertAfter and sweepSeenAlertIds, yield, and resume next cycle.
              alertCyclePages = 0;
            }
          } else {
            alertAfter = null;
            sweepSeenAlertIds.clear();
            alertCyclePages = 0;
          }
        } else {
          // End of open_system_alerts feed: prune resolved/rerouted routes and reset for next sweep.
          for (const tracked of seenAlertRoutes.keys()) {
            if (!sweepSeenAlertIds.has(tracked)) seenAlertRoutes.delete(tracked);
          }
          sweepSeenAlertIds.clear();
          alertAfter = null;
          alertCyclePages = 0;
        }
      }
      if (emittedSignals.length > 0) {
        await options.afterEmitBatch?.(emittedSignals);
      }
      if (cancelled()) break;

      if (!ready) {
        ready = true;
        await options.onReady?.();
        // Existing cursors can have rows on their first page. Surface those
        // first, then read once more for anything onReady posted.
        if (options.onReady !== undefined && !cancelled()) continue;
      }

      const fullPage = page.rawCount >= pageLimit;
      if (fullPage || continueAlertBurst) {
        await wait(0);
        continue;
      }
      noteCycle();
      await waitForTrigger(emittedSignals.length > 0);
    } catch (error) {
      if (cancelled()) break;
      const http = followHttpDetails(error);
      const retryable = isRetryableFollowError(error) ||
        http?.status === 429 ||
        (http !== null && http.status >= 500);
      if (!retryable) {
        return {
          reason: "error",
          error: error instanceof Error ? error : new Error(String(error)),
        };
      }
      attempt += 1;
      const delayMs = nextFollowBackoffMs(
        attempt,
        http?.retryAfterMs ?? null,
        random,
      );
      const typed = error instanceof Error ? error : new Error(String(error));
      options.onRetry?.(typed, delayMs);
      await waitWithStdoutChecks(delayMs);
    }
  }
  return { reason: "cancelled" };
}
