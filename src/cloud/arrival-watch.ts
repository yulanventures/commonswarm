import { homedir, platform } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { basename, dirname, join } from "node:path";
import { link, lstat, open, readFile, rename, unlink } from "node:fs/promises";
import type { SignalRecord } from "./command-client.js";
import type { CloudTarget } from "./config.js";
import { printedCommand } from "./wake-lease-constants.js";
import {
  followHttpDetails,
  isRetryableFollowError,
  nextFollowBackoffMs,
  signalAddressesAgent,
  SIGNAL_FOLLOW_PAGE_LIMIT,
  type AgentSignalPage,
  type SignalCursor,
} from "./signals.js";
import {
  ensureSecureStateDirectory,
  cleanupDeadOwnerTemps,
  HOST_ID_LOCK_INCOMPLETE_GRACE_MS,
  publishCompleteOwnerFile,
  readSecureJsonFile,
  removePublishedOwnerFile,
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
  options: NotifyRestartOptions, holder: "this watcher" | "watcher" | "h0_poll" | "unclaimed" = "unclaimed"): string {
  const state = { "this watcher": "nothing is watching this inbox now", watcher: "another watcher holds this inbox now", h0_poll: "H0 poll holds this inbox now", unclaimed: "this watcher had not claimed the inbox lease" }[holder];
  const prose = `inbox --notify stopped because of ${signal} and ${state}; restart it under the session's Monitor`;
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

/** Read-only host-id file inspection for resume's diagnostic wording. */
export async function arrivalHostIdFileState(lockPath: string): Promise<"present" | "missing" | "unreadable"> {
  try {
    await readFile(join(dirname(lockPath), "host-id"), "utf8");
    return "present";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
  }
}

/** Stable across watcher restarts on this machine and state root. */
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
        // The host id is unchanged; the fingerprint only binds it from this start onward.
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
  return `inbox --notify is already running for this agent as pid ${pid}.`;
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
  options: { onBeforePublish?: () => Promise<void>; onBeforeStaleMove?: () => Promise<void> } = {},
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
        continue;
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
      const moved = `${path}.${process.pid}.${randomUUID().replaceAll("-", "")}.stale`;
      try { await rename(path, moved); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      const movedRaw = await readFile(moved, "utf8").catch(() => null);
      if (movedRaw !== observedRaw) {
        await link(moved, path).catch(error => {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        });
        await unlink(moved).catch(() => undefined);
        continue;
      }
      await unlink(moved);
      await cleanupDeadOwnerTemps(dirname(path), basename(path));
      if (existing !== null) replacedDeadPredecessor = true;
    }
    throw new Error(`arrival watch lock could not be acquired at ${path}; retry when its owner exits`);
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

/** A matching live local lock plus the server's watcher id proves this host holds it. */
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
    await removePublishedOwnerFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

/** True when the lock file names a live pid. Never pgrep; the lock path is the evidence. */
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

/** True when the snippet dropped text, i.e. the one-line body exceeded the cap. */
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

/* A snippet is a preview, and a preview must say where the whole text is. The
 * numbers are the run-time lengths, never typed copy, so the phrase cannot drift
 * from ARRIVAL_SNIPPET_MAX. Empty when nothing was cut. */
export function arrivalSnippetSuffix(
  notification: Pick<ArrivalNotification, "snippet" | "body" | "workspace_id">,
): string {
  if (!arrivalSnippetWasCut(notification.body)) return "";
  const shown = notification.snippet.length.toLocaleString("en-US");
  const total = notification.body.length.toLocaleString("en-US");
  return ` (${shown} of ${total} chars; full text: ${arrivalFullTextCommand(notification.workspace_id)})`;
}

/** Collapse a message body to one bounded, terminal-safe notification snippet. */
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

/** The exact CLI shape needed to answer the signal named by a notification. */
/* Matches the hook's reply hint deliberately. The url and anon key come from the
 * agent's saved target, so repeating them here only bloated every notification —
 * the anon key is a JWT, and a monitor line carrying it is unreadable on a phone
 * and teaches an agent to paste credentials into commands. Found by dogfooding
 * this feature within minutes of shipping it. */
export function arrivalReplyCommand(
  signalId: string,
  workspaceId: string,
): string {
  return `cswarm reply ${signalId} "<answer>" --workspace-id ${workspaceId}`;
}

/** Build the stable fields shared by readable and JSON monitor output. */
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
    reply_command: arrivalReplyCommand(signal.id, workspaceId),
  };
}

/** Render exactly one readable line for one monitor notification. */
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

/** Write and flush one monitor line; a dead pipe becomes a typed terminal stop. */
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

/**
 * Read-only arrival loop. It never imports or calls delivery claim/ack code.
 * The cursor is saved after each successfully emitted line, so a normal restart
 * resumes after that line while messages received during downtime remain newer.
 *
 * A `wake` hint on the inbox page it already reads is optional. With a topic it
 * waits on the shared WakeSubscriber: a wake does one read; while subscribed
 * the only timer is the 5-minute reconcile; CHANNEL_ERROR/CLOSED return the
 * existing 60 s poll. A server without `wake` keeps today's poll unchanged.
 */
export async function runArrivalWatch(options: {
  workspaceId: string;
  principalId: string;
  store: ArrivalCursorStore;
  readPage(request: ArrivalWatchPageRequest): Promise<AgentSignalPage>;
  emit(signal: SignalRecord): Promise<void>;
  /** Runs after one page's lines were emitted, with only those lines. */
  afterEmitBatch?: (signals: readonly SignalRecord[]) => Promise<void> | void;
  onRetry?: (error: Error, delayMs: number) => void;
  onRecovery?: () => void;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  pollMs?: number;
  random?: () => number;
  now?: () => number;
  /** Shared Realtime subscriber. Absent: poll only, as before this lane. */
  wake?: WakeHandle;
  reconcileMs?: number;
  /** Present only for the CLI monitor; other callers retain their wait behavior. */
  stdoutConsumer?: StdoutConsumerAdapter;
  stdoutCheckIntervalMs?: number;
}): Promise<ArrivalWatchStop> {
  const pollMs = options.pollMs ?? ARRIVAL_WATCH_POLL_MS;
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

  /** Poll cadence while not subscribed; 5-minute reconcile while push. */
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
      // Parsed hints are valid; a closed subscriber is ignored.
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
        // A deadline that has already passed must still yield to cancellation.
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
        baseline,
        limit: baseline ? 1 : SIGNAL_FOLLOW_PAGE_LIMIT,
      });
      assertCursorPage(page);
      applyWakeHint(page);
      /* THE RECIPIENT SET, not the scalar column.
       *
       * RETIRED 2026-09-05: this refused any row whose `to_agent` was not this
       * principal. From L2 (merge 060ff67) the read edge returns a signal to
       * EVERY agent the sender named, and the scalar column holds only the
       * first, so a signal naming this agent at position 1 made a correct read
       * throw here. That was reachable in production before this lane; waking
       * every recipient is what makes it routine.
       *
       * The undirected arm is unchanged: `to` and `to_agent` both null is the
       * broadcast question and a multi-recipient signal answers it "no". */
      if (page.signals.some((row) =>
        row.workspace_id !== options.workspaceId ||
        !(
          signalAddressesAgent(row, options.principalId) ||
          (row.to === null && row.to_agent === null)
        )
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
        if (cancelled()) break;
        noteCycle();
        await waitForTrigger(false);
        continue;
      }

      const emittedSignals: SignalRecord[] = [];
      for (const row of page.signals) {
        if (cancelled()) break;
        await options.emit(row);
        emittedSignals.push(row);
        cursor = cursorOf(row);
        await options.store.write(cursor);
      }
      if (emittedSignals.length > 0) {
        await options.afterEmitBatch?.(emittedSignals);
      }
      if (cancelled()) break;

      const fullPage = page.rawCount >= SIGNAL_FOLLOW_PAGE_LIMIT;
      if (fullPage) {
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
