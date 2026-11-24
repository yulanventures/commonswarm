import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readFile, rename, unlink, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  AgentSetupError,
  listAgentProfiles,
  privatePath,
  profileTarget,
  readAgentProfile,
  type AgentProfile,
} from "../cloud/agent-profile.js";
import { RECEIVE_HEARTBEAT_MAX_AGE_MS } from "../cloud/agent-receive.js";
import { arrivalWatchLockPath, legacyArrivalWatchLockPath } from "../cloud/arrival-watch.js";
import type { CloudTarget } from "../cloud/config.js";
import { AGENT_SESSION_TTL_MS } from "../cloud/session-contract.js";
import { defaultSessionRootDirectory } from "../cloud/session-context.js";
import { resolveClaudeExecutable, resolvePackagedClaudeBridge } from "../host/claude.js";
import { resolveCodexExecutable } from "../host/codex.js";
import {
  LISTENER_RUNNING_STATES,
  listenerPaths,
  queryListenerControl,
  readListenerStatus,
} from "../listener/control.js";
import { defaultListenerStateDirectory } from "../listener/file-store.js";
import { AcpHarness } from "./acp-harness.js";
import { clearHarnessRecord, containPrevious, ContainmentError, recordHarness } from "./containment.js";
import { CloudLinkError, openCloudLink, type CloudLinkHandle, type OpenCloudLinkOptions } from "./cloud-link.js";
import { recover, reduceAll } from "./core.js";
import { Journal } from "./journal.js";
import { prepareLaunch, type LaunchDescription, type PreparedLaunch } from "./launch.js";
import type { Clock, HarnessPort, IdGenerator, OperatorPort, OperatorReportKind } from "./ports.js";
import { EngineRunner, type StopReason } from "./runner.js";
import {
  acquireSeatLock,
  probeSeatLock,
  SeatLockError,
  seatLockKey,
  type SeatLockHandle,
  type SeatLockProbeState,
} from "./seat-lock.js";

export const ENGINE_ALLOW_LIVE_ENV = "CSWARM_ENGINE_ALLOW_LIVE";
export const ENGINE_HARNESSES = ["claude", "codex"] as const;
export type EngineHarnessKind = (typeof ENGINE_HARNESSES)[number];

export const ENGINE_EXIT_OK = 0;
export const ENGINE_EXIT_ERROR = 1;
export const ENGINE_EXIT_USAGE = 2;
export const ENGINE_EXIT_LIVE_DISABLED = 3;
export const ENGINE_EXIT_SEAT_LOCKED = 4;
export const ENGINE_EXIT_LEGACY_RECEIVER = 5;
export const ENGINE_EXIT_NOT_MANAGED = 6;
export const ENGINE_EXIT_SESSION_LOST = 7;

export type EngineStopReason =
  | StopReason
  | "live_disabled"
  | "profile_invalid"
  | "seat_unsupported"
  | "seat_not_managed"
  | "seat_locked"
  | "seat_lock_failed"
  | "containment_failed"
  | "legacy_receiver_running"
  | "seat_busy"
  | "cloud_open_failed"
  | "harness_launch_failed";

export type EngineSignalName = "SIGINT" | "SIGTERM" | "SIGHUP";

export interface EngineSignalTarget {
  on(signal: EngineSignalName, listener: () => void): unknown;
  off(signal: EngineSignalName, listener: () => void): unknown;
}

export type LegacyReceiverKind = "listener" | "receive_channel" | "inbox_notify" | "session_receiver";

export interface LegacyReceiverDetection {
  readonly kind: LegacyReceiverKind;
  readonly pid?: number;
}

export interface EngineContainmentOps {
  readonly containPrevious: typeof containPrevious;
  readonly recordHarness: typeof recordHarness;
  readonly clearHarnessRecord: typeof clearHarnessRecord;
}

export interface HarnessFactoryInput {
  readonly harness: EngineHarnessKind;
  readonly launch: LaunchDescription;
  readonly cwd: string;
  readonly seatDir: string;
  readonly mode: "deny_only";
  readonly onSpawned: (pid: number) => Promise<void>;
}

export interface EngineOperatorEvent {
  readonly event:
    | "started"
    | "seat_locked"
    | "previous_contained"
    | "journal_opened"
    | "preflight_ok"
    | "session_acquired"
    | "harness_ready"
    | "message_accepted"
    | "turn_started"
    | "turn_finished"
    | "turn_failed"
    | "reply_posted"
    | "interrupted_notice_posted"
    | "unknown_reply_outcome"
    | "session_lost"
    | "stopping"
    | "harness_closed"
    | "session_released"
    | "journal_closed"
    | "seat_unlocked"
    | "stopped";
  readonly at: number;
  readonly seat?: string;
  readonly workspace?: string;
  readonly harness?: EngineHarnessKind;
  readonly journalDir?: string;
  readonly lockKey?: string;
  readonly outcome?: string;
  readonly recoveredRecords?: number;
  readonly owedReplies?: number;
  readonly sessionId?: string;
  readonly generation?: number;
  readonly mode?: "deny_only";
  readonly messageId?: string;
  readonly commandId?: string;
  readonly signal?: EngineSignalName;
  readonly escalated?: boolean;
  readonly reason?: EngineStopReason;
  readonly exitCode?: number;
  readonly legacyReceiver?: LegacyReceiverKind;
  readonly serverCode?: string;
}

export interface EngineRunOptions {
  readonly harness: EngineHarnessKind;
  readonly profilePath?: string;
  readonly hostSessionId?: string;
  readonly cwd?: string;
  readonly json?: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly stateRoot?: string;
  readonly listenerStateDir?: string;
  readonly arrivalWatchStateDir?: string;
  readonly sessionStateDir?: string;
  readonly executable?: string;
  readonly clock?: Clock;
  readonly generateId?: IdGenerator;
  readonly writeStderr?: (line: string) => void;
  readonly onOperatorEvent?: (event: EngineOperatorEvent) => void;
  readonly signalTarget?: EngineSignalTarget;
  readonly openCloudLink?: (options: OpenCloudLinkOptions) => Promise<CloudLinkHandle>;
  readonly createHarness?: (input: HarnessFactoryInput) => HarnessPort;
  readonly containment?: EngineContainmentOps;
  readonly takeoverWaitMs?: number;
  readonly pollMinMs?: number;
  readonly pollMaxMs?: number;
  readonly handshakeTimeoutMs?: number;
  readonly turnBudgetMs?: number;
  readonly killGraceMs?: number;
  readonly containmentGraceMs?: number;
  readonly containmentLookupTimeoutMs?: number;
  readonly replyRetryHorizonMs?: number;
  readonly compactAfterRecords?: number;
  readonly settledIdCap?: number;
  readonly requestTimeoutMs?: number;
}

export interface EngineRunResult {
  readonly reason: EngineStopReason;
  readonly exitCode: number;
  readonly seat?: string;
  readonly workspaceId?: string;
  readonly serverReason?: string;
  readonly legacyReceiver?: LegacyReceiverKind;
}

export interface EngineStatusOptions {
  readonly profilePath?: string;
  readonly hostSessionId?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly stateRoot?: string;
  readonly settledIdCap?: number;
}

export interface EngineStatusReport {
  readonly seat: string;
  readonly workspaceId: string;
  readonly lockHeld: boolean;
  readonly lockState: SeatLockProbeState;
  readonly journal: {
    readonly exists: boolean;
    readonly accepted: number;
    readonly running: number;
    readonly finished: number;
    readonly unposted: number;
  };
  readonly lastStopReason: EngineStopReason | null;
  readonly lastExitCode: number | null;
  readonly lastStoppedAt: number | null;
}

export interface PreparedHarnessSpawnRequest {
  readonly harness: EngineHarnessKind;
  readonly mode: "deny_only";
  readonly shell: false;
  readonly description: LaunchDescription;
  readonly prepared: PreparedLaunch;
}

const DEFAULT_LIMITS = {
  handshakeMs: 30_000,
  turnMs: 10 * 60 * 1_000,
  killGraceMs: 5_000,
  containmentGraceMs: 5_000,
  containmentLookupMs: 5_000,
  pollMinMs: 1_000,
  pollMaxMs: 15_000,
  replyRetryHorizonMs: 12 * 60 * 60 * 1_000,
  compactAfterRecords: 200,
  settledIdCap: 10_000,
  cloudRequestMs: 30_000,
  listenerStartLockStaleMs: 10_000,
  listenerProbeMs: 250,
} as const;

const LAST_STOP_FILE = "last-stop.json";
const MAX_LAST_STOP_BYTES = 4096;
const MAX_LOCK_BYTES = 1024;
const MAX_RECEIVE_BYTES = 32 * 1024;
const SIGNAL_NAMES: readonly EngineSignalName[] = ["SIGINT", "SIGTERM", "SIGHUP"];

const HARNESS_CONFIG_ENV: Readonly<Record<EngineHarnessKind, string>> = {
  claude: "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
};

export function isEngineHarness(value: string): value is EngineHarnessKind {
  return value === "claude" || value === "codex";
}

export function defaultEngineStateRoot(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const xdg = env.XDG_STATE_HOME;
  return xdg && isAbsolute(xdg) ? join(xdg, "cswarm", "engine") : join(homedir(), ".cswarm", "engine");
}

function defaultArrivalWatchStateDir(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const xdg = env.XDG_STATE_HOME;
  return xdg && isAbsolute(xdg)
    ? join(xdg, "cswarm", "arrival-cursors")
    : join(homedir(), ".cswarm", "arrival-cursors");
}

function errnoCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && typeof (err as { code?: unknown }).code === "string"
    ? (err as { code: string }).code
    : undefined;
}

function pidIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errnoCode(err) !== "ESRCH";
  }
}

export async function resolveEngineProfilePath(explicitPath?: string): Promise<string> {
  if (explicitPath !== undefined) return privatePath(explicitPath);
  const listed = await listAgentProfiles();
  const valid = listed.profiles.filter((row) => !row.error);
  if (valid.length === 1) return valid[0]!.path;
  if (valid.length === 0) {
    throw new AgentSetupError(
      "profile_missing",
      "No saved agent profile found. Pass --profile <absolute-path>.",
    );
  }
  throw new AgentSetupError(
    "profile_ambiguous",
    "Multiple saved agent profiles exist on this machine. Pass --profile <absolute-path>.",
  );
}

export function resolveHarnessExecutable(
  harness: EngineHarnessKind,
  options?: { readonly executable?: string; readonly pathEnv?: string },
): string {
  if (options?.executable !== undefined) {
    return harness === "claude"
      ? resolveClaudeExecutable(options.executable, options.pathEnv)
      : resolveCodexExecutable(options.executable, options.pathEnv);
  }
  if (harness === "claude") {
    try {
      return resolvePackagedClaudeBridge(options?.pathEnv);
    } catch {
      return resolveClaudeExecutable("claude-agent-acp", options?.pathEnv);
    }
  }
  return resolveCodexExecutable("codex-acp", options?.pathEnv);
}

export function buildHarnessLaunchDescription(input: {
  readonly harness: EngineHarnessKind;
  readonly executable: string;
  readonly cwd: string;
  readonly seatDir: string;
}): LaunchDescription {
  return {
    executable: input.executable,
    args: [],
    cwd: resolve(input.cwd),
    configRootEnv: {
      name: HARNESS_CONFIG_ENV[input.harness],
      value: join(input.seatDir, "config-root", input.harness),
    },
  };
}

export async function prepareHarnessSpawnRequest(input: {
  readonly harness: EngineHarnessKind;
  readonly executable: string;
  readonly cwd: string;
  readonly seatDir: string;
  readonly parentEnv?: Readonly<Record<string, string | undefined>>;
}): Promise<PreparedHarnessSpawnRequest> {
  const description = buildHarnessLaunchDescription(input);
  if (description.configRootEnv !== undefined) {
    await ensurePrivateDirectory(dirname(description.configRootEnv.value));
    await ensurePrivateDirectory(description.configRootEnv.value);
  }
  const prepared = await prepareLaunch(description, {
    parentEnv: input.parentEnv ?? process.env,
  });
  return {
    harness: input.harness,
    mode: "deny_only",
    shell: false,
    description,
    prepared,
  };
}

async function ensurePrivateDirectory(dirPath: string): Promise<void> {
  let exists = true;
  try {
    const st = await lstat(dirPath);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new Error("Engine state path must be a real directory");
    }
  } catch (err) {
    if (errnoCode(err) === "ENOENT") exists = false;
    else throw err;
  }
  if (!exists) {
    await mkdir(dirPath, { recursive: true, mode: 0o700 });
    await chmod(dirPath, 0o700);
  }
  const handle = await open(
    dirPath,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const st = await handle.stat();
    if (!st.isDirectory()) throw new Error("Engine state path must be a directory");
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
      throw new Error("Engine state directory must be owned by the current user");
    }
    if ((st.mode & 0o077) !== 0) {
      throw new Error("Engine state directory must not allow group or other permissions");
    }
  } finally {
    await handle.close().catch(() => {});
  }
}

interface LastStopRecord {
  readonly version: 1;
  readonly reason: EngineStopReason;
  readonly exitCode: number;
  readonly at: number;
}

async function writeLastStopRecord(seatDir: string, record: LastStopRecord): Promise<void> {
  const targetPath = join(seatDir, LAST_STOP_FILE);
  const tmpPath = join(seatDir, `.${LAST_STOP_FILE}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  let fh: FileHandle | null = null;
  let renamed = false;
  try {
    fh = await open(
      tmpPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await fh.chmod(0o600);
    await fh.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    await fh.sync();
    await fh.close();
    fh = null;
    await rename(tmpPath, targetPath);
    renamed = true;
  } catch {
    // Best-effort status metadata; never alter shutdown exit code.
  } finally {
    if (fh !== null) await fh.close().catch(() => {});
    if (!renamed) await unlink(tmpPath).catch(() => {});
  }
}

async function readLastStopRecord(seatDir: string): Promise<LastStopRecord | null> {
  const filePath = join(seatDir, LAST_STOP_FILE);
  let fh: FileHandle;
  try {
    fh = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    return null;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size <= 0 || st.size > MAX_LAST_STOP_BYTES) return null;
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) return null;
    if ((st.mode & 0o077) !== 0) return null;
    const parsed: unknown = JSON.parse(await fh.readFile("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const row = parsed as Record<string, unknown>;
    if (
      row.version !== 1 ||
      typeof row.reason !== "string" ||
      typeof row.exitCode !== "number" ||
      !Number.isSafeInteger(row.exitCode) ||
      typeof row.at !== "number" ||
      !Number.isFinite(row.at)
    ) {
      return null;
    }
    return {
      version: 1,
      reason: row.reason as EngineStopReason,
      exitCode: row.exitCode,
      at: row.at,
    };
  } catch {
    return null;
  } finally {
    await fh.close().catch(() => {});
  }
}

async function readSmallRegularFile(filePath: string, maxBytes: number): Promise<string | null> {
  let fh: FileHandle;
  try {
    fh = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    return null;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size <= 0 || st.size > maxBytes) return null;
    return await fh.readFile("utf8");
  } catch {
    return null;
  } finally {
    await fh.close().catch(() => {});
  }
}

async function detectLegacyListener(
  target: CloudTarget,
  workspaceId: string,
  principalId: string,
  now: number,
  stateDirectory?: string,
): Promise<LegacyReceiverDetection | null> {
  const paths = listenerPaths({
    profileId: target.profileId,
    workspaceId,
    principalId,
    stateDirectory: stateDirectory ?? defaultListenerStateDirectory(),
  });

  // 1. Live status.json written by the legacy listener supervisor.
  const status = await readListenerStatus(paths).catch(() => null);
  if (
    status !== null &&
    LISTENER_RUNNING_STATES.includes(status.state) &&
    pidIsAlive(status.pid)
  ) {
    return { kind: "listener", pid: status.pid };
  }

  // 2. Startup lock held while a legacy listener is starting up.
  const startLockPath = join(paths.instanceDirectory, "starting.lock");
  const startLockInfo = await lstat(startLockPath).catch(() => null);
  if (startLockInfo !== null && startLockInfo.isFile()) {
    const raw = await readSmallRegularFile(startLockPath, MAX_LOCK_BYTES);
    const parsedPid = raw !== null ? Number(raw.trim()) : Number.NaN;
    if (Number.isSafeInteger(parsedPid) && parsedPid > 0 && pidIsAlive(parsedPid)) {
      return { kind: "listener", pid: parsedPid };
    }
    if (now - startLockInfo.mtimeMs >= 0 && now - startLockInfo.mtimeMs < DEFAULT_LIMITS.listenerStartLockStaleMs) {
      return { kind: "listener" };
    }
  }

  // 3. Control socket bound by a live legacy listener.
  const socketInfo = await lstat(paths.socketPath).catch(() => null);
  if (socketInfo !== null) {
    try {
      const live = await queryListenerControl(paths, "status", DEFAULT_LIMITS.listenerProbeMs);
      if (LISTENER_RUNNING_STATES.includes(live.state)) {
        return { kind: "listener", pid: live.pid };
      }
    } catch {
      // Stale socket file without a live listener.
    }
  }

  return null;
}

async function detectLegacyReceiveChannel(
  profilePath: string,
  now: number,
): Promise<LegacyReceiverDetection | null> {
  const dir = dirname(profilePath);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith("receive-") || !entry.name.endsWith(".json")) {
      continue;
    }
    const raw = await readSmallRegularFile(join(dir, entry.name), MAX_RECEIVE_BYTES);
    if (raw === null) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
    const row = parsed as Record<string, unknown>;
    const pid = row.channel_pid;
    if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) continue;
    if (!pidIsAlive(pid)) continue;
    const heartbeat = row.channel_heartbeat_at;
    if (heartbeat === null || heartbeat === undefined) {
      return { kind: "receive_channel", pid };
    }
    if (typeof heartbeat === "string") {
      const heartbeatMs = Date.parse(heartbeat);
      if (
        Number.isFinite(heartbeatMs) &&
        now - heartbeatMs >= 0 &&
        now - heartbeatMs <= RECEIVE_HEARTBEAT_MAX_AGE_MS
      ) {
        return { kind: "receive_channel", pid };
      }
    }
  }
  return null;
}

async function detectLegacyInboxNotify(
  target: CloudTarget,
  workspaceId: string,
  principalId: string,
  stateDir: string,
): Promise<LegacyReceiverDetection | null> {
  const lockPaths = [
    arrivalWatchLockPath(target, workspaceId, principalId, stateDir),
    legacyArrivalWatchLockPath(target, workspaceId, principalId, stateDir),
  ];
  for (const lockPath of lockPaths) {
    const raw = await readSmallRegularFile(lockPath, MAX_LOCK_BYTES);
    if (raw === null) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
    const row = parsed as Record<string, unknown>;
    if (row.version === 1 && typeof row.pid === "number" && Number.isSafeInteger(row.pid) && pidIsAlive(row.pid)) {
      return { kind: "inbox_notify", pid: row.pid };
    }
  }
  return null;
}

async function detectLegacySessionReceiver(
  target: CloudTarget,
  workspaceId: string,
  principalId: string,
  sessionStateDir: string,
): Promise<LegacyReceiverDetection | null> {
  const dir = join(sessionStateDir, workspaceId.toLowerCase(), principalId.toLowerCase());
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".receiver.lock")) continue;
    const lockPath = join(dir, entry.name);
    const raw = await readSmallRegularFile(lockPath, MAX_LOCK_BYTES);
    if (raw === null) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
    const row = parsed as Record<string, unknown>;
    if (
      row.version !== 1 ||
      typeof row.pid !== "number" ||
      !Number.isSafeInteger(row.pid) ||
      !pidIsAlive(row.pid)
    ) {
      continue;
    }
    // If a sibling session context JSON exists, scope to the same deployment profile_id.
    const stem = entry.name.slice(0, -".receiver.lock".length);
    const ctxRaw = await readFile(join(dir, `${stem}.json`), "utf8").catch(() => null);
    if (ctxRaw !== null) {
      try {
        const ctx = JSON.parse(ctxRaw) as Record<string, unknown>;
        if (typeof ctx.profile_id === "string" && ctx.profile_id !== target.profileId) {
          continue;
        }
      } catch {
        // Corrupt sibling context: fail closed on the live receiver lock.
      }
    }
    return { kind: "session_receiver", pid: row.pid };
  }
  return null;
}

export async function detectLegacyReceiver(input: {
  readonly target: CloudTarget;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly profilePath: string;
  readonly now: number;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly listenerStateDir?: string;
  readonly arrivalWatchStateDir?: string;
  readonly sessionStateDir?: string;
}): Promise<LegacyReceiverDetection | null> {
  const listener = await detectLegacyListener(
    input.target,
    input.workspaceId,
    input.principalId,
    input.now,
    input.listenerStateDir,
  );
  if (listener !== null) return listener;

  const channel = await detectLegacyReceiveChannel(input.profilePath, input.now);
  if (channel !== null) return channel;

  const notify = await detectLegacyInboxNotify(
    input.target,
    input.workspaceId,
    input.principalId,
    input.arrivalWatchStateDir ?? defaultArrivalWatchStateDir(input.env),
  );
  if (notify !== null) return notify;

  return detectLegacySessionReceiver(
    input.target,
    input.workspaceId,
    input.principalId,
    input.sessionStateDir ?? defaultSessionRootDirectory(),
  );
}

function safeToken(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]/g, "_");
}

export function formatOperatorEvent(event: EngineOperatorEvent, json: boolean): string {
  if (json) return `${JSON.stringify(event)}\n`;
  const parts: string[] = [`engine`, `event=${event.event}`];
  if (event.seat !== undefined) parts.push(`seat=${safeToken(event.seat)}`);
  if (event.workspace !== undefined) parts.push(`workspace=${safeToken(event.workspace)}`);
  if (event.harness !== undefined) parts.push(`harness=${safeToken(event.harness)}`);
  if (event.journalDir !== undefined) parts.push(`journal_dir=${safeToken(event.journalDir)}`);
  if (event.lockKey !== undefined) parts.push(`lock_key=${safeToken(event.lockKey)}`);
  if (event.mode !== undefined) parts.push(`mode=${safeToken(event.mode)}`);
  if (event.sessionId !== undefined) parts.push(`session_id=${safeToken(event.sessionId)}`);
  if (event.generation !== undefined) parts.push(`generation=${event.generation}`);
  if (event.recoveredRecords !== undefined) parts.push(`recovered_records=${event.recoveredRecords}`);
  if (event.owedReplies !== undefined) parts.push(`owed_replies=${event.owedReplies}`);
  if (event.messageId !== undefined) parts.push(`message_id=${safeToken(event.messageId)}`);
  if (event.commandId !== undefined) parts.push(`command_id=${safeToken(event.commandId)}`);
  if (event.outcome !== undefined) parts.push(`outcome=${safeToken(event.outcome)}`);
  if (event.signal !== undefined) parts.push(`signal=${safeToken(event.signal)}`);
  if (event.escalated !== undefined) parts.push(`escalated=${event.escalated}`);
  if (event.legacyReceiver !== undefined) parts.push(`legacy_receiver=${safeToken(event.legacyReceiver)}`);
  if (event.serverCode !== undefined) parts.push(`server_code=${safeToken(event.serverCode)}`);
  if (event.reason !== undefined) parts.push(`reason=${safeToken(event.reason)}`);
  if (event.exitCode !== undefined) parts.push(`exit_code=${event.exitCode}`);
  return `${parts.join(" ")}\n`;
}

function exitCodeForStopReason(reason: EngineStopReason): number {
  switch (reason) {
    case "stopped":
      return ENGINE_EXIT_OK;
    case "live_disabled":
      return ENGINE_EXIT_LIVE_DISABLED;
    case "seat_locked":
      return ENGINE_EXIT_SEAT_LOCKED;
    case "legacy_receiver_running":
      return ENGINE_EXIT_LEGACY_RECEIVER;
    case "seat_not_managed":
    case "seat_unsupported":
      return ENGINE_EXIT_NOT_MANAGED;
    case "authority_lost":
      return ENGINE_EXIT_SESSION_LOST;
    default:
      return ENGINE_EXIT_ERROR;
  }
}

export async function inspectEngineStatus(options: EngineStatusOptions = {}): Promise<EngineStatusReport> {
  const env = options.env ?? process.env;
  const stateRoot = options.stateRoot ?? defaultEngineStateRoot(env);
  const profilePath = await resolveEngineProfilePath(options.profilePath);
  const profile = await readAgentProfile(profilePath, options.hostSessionId);
  const target = profileTarget(profile);
  const lockIdentity = {
    deployment: target.url,
    workspaceId: profile.workspace_id,
    principalId: profile.principal_id,
  };
  const key = seatLockKey(lockIdentity);
  const seatDir = join(resolve(stateRoot), "seats", key);
  const journalPath = join(seatDir, "journal.ndjson");

  const lockState = await probeSeatLock({ root: stateRoot, ...lockIdentity });
  const inspected = await Journal.inspect(journalPath);
  const state = reduceAll(inspected.records, {
    settledIdCap: options.settledIdCap ?? DEFAULT_LIMITS.settledIdCap,
  });
  const lastStop = await readLastStopRecord(seatDir);

  return {
    seat: profile.principal_id,
    workspaceId: profile.workspace_id,
    lockHeld: lockState === "held",
    lockState,
    journal: {
      exists: inspected.exists,
      accepted: state.pending !== null ? 1 : 0,
      running: state.active !== null ? 1 : 0,
      finished: state.settled.size + state.owedReplies.length,
      unposted: state.owedReplies.length,
    },
    lastStopReason: lastStop?.reason ?? null,
    lastExitCode: lastStop?.exitCode ?? null,
    lastStoppedAt: lastStop?.at ?? null,
  };
}

export function renderEngineStatus(report: EngineStatusReport, json: boolean): string {
  if (json) {
    return `${JSON.stringify({
      seat: report.seat,
      workspace_id: report.workspaceId,
      lock_held: report.lockHeld,
      lock_state: report.lockState,
      journal: report.journal,
      last_stop_reason: report.lastStopReason,
      last_exit_code: report.lastExitCode,
      last_stopped_at: report.lastStoppedAt,
    })}\n`;
  }
  return [
    `Seat: ${report.seat} (workspace ${report.workspaceId})`,
    `Lock: ${report.lockHeld ? "held" : report.lockState}`,
    `Journal: accepted=${report.journal.accepted} running=${report.journal.running} finished=${report.journal.finished} unposted=${report.journal.unposted}`,
    `Last stop: ${report.lastStopReason ?? "none"}`,
  ].join("\n") + "\n";
}

export async function runEngine(options: EngineRunOptions): Promise<EngineRunResult> {
  const env = options.env ?? process.env;
  const clock: Clock = options.clock ?? { now: () => Date.now() };
  const generateId: IdGenerator = options.generateId ?? randomUUID;
  const json = options.json === true;
  const writeStderr = options.writeStderr ?? ((line: string) => { process.stderr.write(line); });
  const emit = (event: Omit<EngineOperatorEvent, "at">): void => {
    const full: EngineOperatorEvent = { ...event, at: clock.now() } as EngineOperatorEvent;
    writeStderr(formatOperatorEvent(full, json));
    try {
      options.onOperatorEvent?.(full);
    } catch {
      // Best-effort observer callback.
    }
  };

  // Gate check: live runs (using a real harness) require CSWARM_ENGINE_ALLOW_LIVE=1,
  // checked BEFORE taking the seat lock and BEFORE any network call.
  const isLiveRun = options.createHarness === undefined;
  if (isLiveRun && env[ENGINE_ALLOW_LIVE_ENV] !== "1") {
    emit({
      event: "stopped",
      harness: options.harness,
      reason: "live_disabled",
      exitCode: ENGINE_EXIT_LIVE_DISABLED,
    });
    if (!json) {
      writeStderr(
        `cswarm engine run: live runs are not enabled yet. Set ${ENGINE_ALLOW_LIVE_ENV}=1 only on a dedicated test seat after verifying the security conditions.\n`,
      );
    }
    return { reason: "live_disabled", exitCode: ENGINE_EXIT_LIVE_DISABLED };
  }

  // Step a: resolve the seat (deployment, workspace, seat) from the CLI profile.
  let profilePath: string;
  let profile: AgentProfile;
  let target: CloudTarget;
  try {
    profilePath = await resolveEngineProfilePath(options.profilePath);
    profile = await readAgentProfile(profilePath, options.hostSessionId);
    target = profileTarget(profile);
  } catch (err) {
    if (err instanceof AgentSetupError && (err.code === "profile_other_session" || err.code === "host_session_required")) {
      throw err;
    }
    emit({
      event: "stopped",
      harness: options.harness,
      reason: "profile_invalid",
      exitCode: ENGINE_EXIT_ERROR,
    });
    return { reason: "profile_invalid", exitCode: ENGINE_EXIT_ERROR };
  }

  const stateRoot = resolve(options.stateRoot ?? defaultEngineStateRoot(env));
  const lockIdentity = {
    deployment: target.url,
    workspaceId: profile.workspace_id,
    principalId: profile.principal_id,
  };
  let lockKey: string;
  try {
    lockKey = seatLockKey(lockIdentity);
  } catch {
    emit({
      event: "stopped",
      seat: profile.principal_id,
      workspace: profile.workspace_id,
      harness: options.harness,
      reason: "seat_lock_failed",
      exitCode: ENGINE_EXIT_ERROR,
    });
    return {
      reason: "seat_lock_failed",
      exitCode: ENGINE_EXIT_ERROR,
      seat: profile.principal_id,
      workspaceId: profile.workspace_id,
    };
  }

  const seatDir = join(stateRoot, "seats", lockKey);
  const journalDirName = basename(seatDir);
  const journalPath = join(seatDir, "journal.ndjson");
  const containment = options.containment ?? { containPrevious, recordHarness, clearHarnessRecord };
  const openCloud = options.openCloudLink ?? openCloudLink;
  const signalTarget: EngineSignalTarget = options.signalTarget ?? process;

  emit({
    event: "started",
    seat: profile.principal_id,
    workspace: profile.workspace_id,
    harness: options.harness,
    journalDir: journalDirName,
  });

  // Step b: take the seat lock and hold it until the very end (including child shutdown).
  let seatLock: SeatLockHandle | null = null;
  try {
    seatLock = await acquireSeatLock({ root: stateRoot, ...lockIdentity });
  } catch (err) {
    const isLocked = err instanceof SeatLockError && err.code === "seat_locked";
    const reason: EngineStopReason = isLocked ? "seat_locked" : "seat_lock_failed";
    const exitCode = exitCodeForStopReason(reason);
    emit({
      event: "stopped",
      seat: profile.principal_id,
      workspace: profile.workspace_id,
      harness: options.harness,
      reason,
      exitCode,
    });
    if (!json && isLocked) {
      writeStderr("cswarm engine run: another runner already holds the seat lock for this seat.\n");
    }
    return {
      reason,
      exitCode,
      seat: profile.principal_id,
      workspaceId: profile.workspace_id,
    };
  }

  emit({
    event: "seat_locked",
    seat: profile.principal_id,
    lockKey: seatLock.key,
  });

  let journal: Journal | null = null;
  let cloudLink: CloudLinkHandle | null = null;
  let harnessPort: HarnessPort | null = null;
  let runner: EngineRunner | null = null;
  let runnerOwnsJournal = false;
  let cloudLinkClosed = false;
  let authorityLost = false;
  let stopRequested = false;
  let signalCount = 0;
  let seatDirReady = false;
  const openAbort = new AbortController();

  const onSignal = (signal: EngineSignalName): void => {
    signalCount += 1;
    stopRequested = true;
    const escalated = signalCount > 1;
    emit({ event: "stopping", seat: profile.principal_id, signal, escalated });
    openAbort.abort();
    if (runner !== null) {
      if (escalated) {
        void runner.escalateStop();
      } else {
        void runner.stop();
      }
    }
  };
  const signalListeners = new Map<EngineSignalName, () => void>();
  for (const sig of SIGNAL_NAMES) {
    const fn = () => onSignal(sig);
    signalListeners.set(sig, fn);
    signalTarget.on(sig, fn);
  }

  const releaseAllBeforeRunner = async (): Promise<void> => {
    if (harnessPort !== null) {
      try {
        await harnessPort.close?.();
      } catch {
        // Best-effort close on startup abort.
      }
      harnessPort = null;
      emit({ event: "harness_closed", harness: options.harness });
      await containment.clearHarnessRecord({ dir: seatDir }).catch(() => {});
    }
    if (cloudLink !== null && !cloudLinkClosed) {
      cloudLinkClosed = true;
      const sid = cloudLink.sessionId;
      await cloudLink.close().catch(() => {});
      if (!authorityLost) {
        emit({ event: "session_released", seat: profile.principal_id, sessionId: sid });
      }
    }
    if (journal !== null && !runnerOwnsJournal) {
      try {
        await journal.flush();
        await journal.close();
      } catch {
        // Best-effort close on startup failure.
      }
      journal = null;
      emit({ event: "journal_closed", journalDir: journalDirName });
    }
  };

  const finishAndReleaseLock = async (
    reason: EngineStopReason,
    extra?: { readonly serverReason?: string; readonly serverCode?: string; readonly legacyReceiver?: LegacyReceiverKind },
  ): Promise<EngineRunResult> => {
    const exitCode = exitCodeForStopReason(reason);
    if (seatDirReady) {
      await writeLastStopRecord(seatDir, {
        version: 1,
        reason,
        exitCode,
        at: clock.now(),
      });
    }
    if (seatLock !== null) {
      const key = seatLock.key;
      seatLock.release();
      seatLock = null;
      emit({ event: "seat_unlocked", seat: profile.principal_id, lockKey: key });
    }
    emit({
      event: "stopped",
      seat: profile.principal_id,
      workspace: profile.workspace_id,
      harness: options.harness,
      reason,
      exitCode,
      ...(extra?.legacyReceiver !== undefined ? { legacyReceiver: extra.legacyReceiver } : {}),
      ...(extra?.serverCode !== undefined ? { serverCode: extra.serverCode } : {}),
    });
    if (!json) {
      if (reason === "seat_not_managed" && extra?.serverReason) {
        writeStderr(`cswarm engine run: ${extra.serverReason}\n`);
      } else if (reason === "legacy_receiver_running" && extra?.legacyReceiver) {
        writeStderr(
          `cswarm engine run: refused to start because a legacy ${extra.legacyReceiver} receiver is running for this seat.\n`,
        );
      }
    }
    return {
      reason,
      exitCode,
      seat: profile.principal_id,
      workspaceId: profile.workspace_id,
      ...(extra?.serverReason !== undefined ? { serverReason: extra.serverReason } : {}),
      ...(extra?.legacyReceiver !== undefined ? { legacyReceiver: extra.legacyReceiver } : {}),
    };
  };

  try {
    // Step c: contain anything a previous runner left behind before touching journal or network.
    try {
      await ensurePrivateDirectory(join(stateRoot, "seats"));
      await ensurePrivateDirectory(seatDir);
      seatDirReady = true;
      const contained = await containment.containPrevious({
        dir: seatDir,
        graceMs: options.containmentGraceMs ?? DEFAULT_LIMITS.containmentGraceMs,
        lookupTimeoutMs: options.containmentLookupTimeoutMs ?? DEFAULT_LIMITS.containmentLookupMs,
      });
      emit({ event: "previous_contained", outcome: contained.outcome });
    } catch (err) {
      void (err instanceof ContainmentError ? err.code : "containment_failed");
      return await finishAndReleaseLock("containment_failed");
    }

    if (stopRequested) {
      return await finishAndReleaseLock("stopped");
    }

    // Step d: open the journal, rebuild state, and apply recovery rules durably.
    let recovered: ReturnType<typeof recover>;
    try {
      journal = await Journal.open(journalPath);
      recovered = recover(journal.records, clock.now(), {
        replyRetryHorizonMs: options.replyRetryHorizonMs ?? DEFAULT_LIMITS.replyRetryHorizonMs,
        settledIdCap: options.settledIdCap ?? DEFAULT_LIMITS.settledIdCap,
        generateId,
      });
      if (recovered.records.length > 0) {
        await journal.appendAll(recovered.records);
      }
      emit({
        event: "journal_opened",
        journalDir: journalDirName,
        recoveredRecords: recovered.records.length,
        owedReplies: recovered.state.owedReplies.length,
      });
      for (const record of recovered.records) {
        if (record.type === "turn_finished" && record.outcome === "interrupted") {
          emit({ event: "turn_finished", messageId: record.messageId, outcome: "interrupted" });
        }
      }
    } catch {
      await releaseAllBeforeRunner();
      return await finishAndReleaseLock("journal_failed");
    }

    if (stopRequested) {
      await releaseAllBeforeRunner();
      return await finishAndReleaseLock("stopped");
    }

    // Step e: preflight: refuse to start if a legacy receiver for the same seat is running.
    const legacy = await detectLegacyReceiver({
      target,
      workspaceId: profile.workspace_id,
      principalId: profile.principal_id,
      profilePath,
      now: clock.now(),
      env,
      listenerStateDir: options.listenerStateDir,
      arrivalWatchStateDir: options.arrivalWatchStateDir,
      sessionStateDir: options.sessionStateDir,
    });
    if (legacy !== null) {
      await releaseAllBeforeRunner();
      return await finishAndReleaseLock("legacy_receiver_running", { legacyReceiver: legacy.kind });
    }
    emit({ event: "preflight_ok", seat: profile.principal_id });

    if (stopRequested) {
      await releaseAllBeforeRunner();
      return await finishAndReleaseLock("stopped");
    }

    // Step f: start the cloud link and acquire the managed session.
    const onAuthorityLost = (): void => {
      if (authorityLost) return;
      authorityLost = true;
      emit({ event: "session_lost", seat: profile.principal_id });
      runner?.loseAuthority();
    };

    try {
      cloudLink = await openCloud({
        profilePath,
        onAuthorityLost,
        takeoverWaitMs: options.takeoverWaitMs ?? AGENT_SESSION_TTL_MS,
        pollMinMs: options.pollMinMs ?? DEFAULT_LIMITS.pollMinMs,
        pollMaxMs: options.pollMaxMs ?? DEFAULT_LIMITS.pollMaxMs,
        requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_LIMITS.cloudRequestMs,
        provider: options.harness,
        clock,
        generateId,
        signal: openAbort.signal,
      });
    } catch (err) {
      await releaseAllBeforeRunner();
      if (err instanceof CloudLinkError) {
        if (err.code === "session_not_managed") {
          return await finishAndReleaseLock("seat_not_managed", {
            serverCode: err.code,
            serverReason: err.serverReason ?? err.message,
          });
        }
        if (err.code === "seat_unsupported") {
          return await finishAndReleaseLock("seat_unsupported", {
            serverCode: err.seatKind ?? err.code,
            serverReason: err.message,
          });
        }
        if (err.code === "seat_busy") {
          return await finishAndReleaseLock("seat_busy");
        }
        if (err.code === "open_aborted" && stopRequested) {
          return await finishAndReleaseLock("stopped");
        }
      }
      if (stopRequested) {
        return await finishAndReleaseLock("stopped");
      }
      return await finishAndReleaseLock("cloud_open_failed");
    }

    emit({
      event: "session_acquired",
      seat: profile.principal_id,
      sessionId: cloudLink.sessionId,
      generation: cloudLink.generation,
    });

    if (stopRequested) {
      await releaseAllBeforeRunner();
      return await finishAndReleaseLock("stopped");
    }

    // Step g: build the launch description and harness in DENY-ONLY mode, then run turns one at a time.
    const effectiveCwd = resolve(options.cwd ?? process.cwd());
    let launch: LaunchDescription;
    try {
      const executable = options.createHarness !== undefined && options.executable === undefined
        ? process.execPath
        : resolveHarnessExecutable(options.harness, {
            executable: options.executable,
            pathEnv: env.PATH,
          });
      launch = buildHarnessLaunchDescription({
        harness: options.harness,
        executable,
        cwd: effectiveCwd,
        seatDir,
      });
      if (launch.configRootEnv !== undefined) {
        await ensurePrivateDirectory(dirname(launch.configRootEnv.value));
        await ensurePrivateDirectory(launch.configRootEnv.value);
      }
    } catch {
      await releaseAllBeforeRunner();
      return await finishAndReleaseLock("harness_launch_failed");
    }

    const onSpawned = async (pid: number): Promise<void> => {
      await containment.recordHarness({
        dir: seatDir,
        pid,
        lookupTimeoutMs: options.containmentLookupTimeoutMs ?? DEFAULT_LIMITS.containmentLookupMs,
      });
    };

    try {
      harnessPort = options.createHarness !== undefined
        ? options.createHarness({
            harness: options.harness,
            launch,
            cwd: effectiveCwd,
            seatDir,
            mode: "deny_only",
            onSpawned,
          })
        : new AcpHarness({
            launch,
            launchOptions: { parentEnv: env },
            handshakeTimeoutMs: options.handshakeTimeoutMs ?? DEFAULT_LIMITS.handshakeMs,
            turnBudgetMs: options.turnBudgetMs ?? DEFAULT_LIMITS.turnMs,
            killGraceMs: options.killGraceMs ?? DEFAULT_LIMITS.killGraceMs,
            onSpawned,
          });
    } catch {
      await releaseAllBeforeRunner();
      return await finishAndReleaseLock("harness_launch_failed");
    }

    emit({ event: "harness_ready", harness: options.harness, mode: "deny_only" });

    const operator: OperatorPort = {
      report(kind: OperatorReportKind, detail: Readonly<Record<string, unknown>>): void {
        const messageId = typeof detail.messageId === "string" ? detail.messageId : undefined;
        const commandId = typeof detail.commandId === "string" ? detail.commandId : undefined;
        switch (kind) {
          case "message_accepted":
            emit({ event: "message_accepted", ...(messageId ? { messageId } : {}) });
            break;
          case "turn_started":
            emit({ event: "turn_started", ...(messageId ? { messageId } : {}) });
            break;
          case "turn_finished":
            emit({
              event: "turn_finished",
              ...(messageId ? { messageId } : {}),
              ...(typeof detail.outcome === "string" ? { outcome: detail.outcome } : {}),
            });
            break;
          case "turn_failed":
            // Never forward raw detail.error strings; they may contain tokens, paths, or traffic.
            emit({ event: "turn_failed", ...(messageId ? { messageId } : {}) });
            break;
          case "reply_posted":
            emit({
              event: "reply_posted",
              ...(messageId ? { messageId } : {}),
              ...(commandId ? { commandId } : {}),
            });
            break;
          case "interrupted_notice_posted":
            emit({
              event: "interrupted_notice_posted",
              ...(messageId ? { messageId } : {}),
              ...(commandId ? { commandId } : {}),
            });
            break;
          case "unknown_reply_outcome":
            emit({
              event: "unknown_reply_outcome",
              ...(messageId ? { messageId } : {}),
              ...(commandId ? { commandId } : {}),
            });
            break;
          case "runner_stopped":
            // Journal has just been flushed and closed by EngineRunner.finishShutdown().
            emit({ event: "journal_closed", journalDir: journalDirName });
            break;
        }
      },
    };

    const activeCloudLink = cloudLink;
    const activeJournal = journal;
    runner = new EngineRunner({
      journalPath,
      harness: harnessPort,
      cloud: activeCloudLink.port,
      clock,
      replyRetryHorizonMs: options.replyRetryHorizonMs ?? DEFAULT_LIMITS.replyRetryHorizonMs,
      compactAfterRecords: options.compactAfterRecords ?? DEFAULT_LIMITS.compactAfterRecords,
      settledIdCap: options.settledIdCap ?? DEFAULT_LIMITS.settledIdCap,
      generateId,
      operator,
      preopenedJournal: { journal: activeJournal, recovered },
      onHarnessClosed: async () => {
        emit({ event: "harness_closed", harness: options.harness });
        await containment.clearHarnessRecord({ dir: seatDir }).catch(() => {});
      },
      onBeforeJournalClose: async () => {
        if (!cloudLinkClosed) {
          cloudLinkClosed = true;
          await activeCloudLink.close().catch(() => {});
          if (!authorityLost) {
            emit({
              event: "session_released",
              seat: profile.principal_id,
              sessionId: activeCloudLink.sessionId,
            });
          }
        }
      },
    });
    runnerOwnsJournal = true;
    harnessPort = null;

    if (authorityLost) {
      runner.loseAuthority();
    } else if (stopRequested) {
      if (signalCount > 1) void runner.escalateStop();
      else void runner.stop();
    }

    await runner.start();
    if (stopRequested) {
      if (signalCount > 1) void runner.escalateStop();
      else void runner.stop();
    }
    const runResult = await runner.done;
    journal = null;

    return await finishAndReleaseLock(runResult.reason);
  } finally {
    for (const [sig, fn] of signalListeners) {
      signalTarget.off(sig, fn);
    }
    if (seatLock !== null) {
      seatLock.release();
      seatLock = null;
    }
  }
}
