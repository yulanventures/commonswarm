/**
 * Native Claude Code inbox-socket wake adapter (Option (a): 0600 messaging-token registration
 * + `~/.claude/sessions/<pid>.json` `status === "idle"` gate + fixed-text-only Unix socket write)
 * and standalone `cswarm receive serve` bridge for Claude Code interactive sessions.
 *
 * Security & operational invariants:
 *   - Fixed text ONLY: "New CommonSwarm messages (batch N): run cswarm check" (checked by
 *     assertFixedNativeWakePrompt immediately before writing to the socket).
 *   - Secrets boundary: NEVER reads `~/.claude/sessions/*.key` or another process's environment.
 *     The messaging token comes ONLY from the session itself via its own env (`CLAUDE_CODE_MESSAGING_TOKEN`
 *     + `CLAUDE_CODE_MESSAGING_SOCKET`) saved into a 0600 file (`wake-claude-<scope>.json`) inside the
 *     private profile directory. Tokens are NEVER accepted on CLI argv, printed, logged, or returned.
 *   - Bound session ONLY: matches `sessionId === hostSessionId`, live PID, `cwd === binding.cwd`,
 *     `status === "idle"`, and canonicalized owned Unix domain socket (`lstat` non-symlink, same UID).
 *   - Read-only arrival detection: never claims/acks deliveries or advances `check.json` before
 *     the Claude session itself runs `cswarm check`, keeping C1a `agent_unseen` truthful.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, readdir, readFile, realpath, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createWakeSubscriber, type WakeHandle } from "../listener/wake.js";
import { assertProfileIdentity } from "./agent-check.js";
import {
  AgentSetupError,
  openProfileCredential,
  privatePath,
  profileScopeKey,
  profileSessionContext,
  profileTarget,
  readAgentProfile,
} from "./agent-profile.js";
import {
  checkedHostSessionId,
  readReceiveBinding,
  receiveStatus,
  updateReceiveBinding,
} from "./agent-receive.js";
import { ThinCommandClient } from "./command-client.js";
import {
  assertFixedNativeWakePrompt,
  NativeWakeBridge,
  resolveAuthorizedWakeBinding,
  wakeRouteForBinding,
  type NativeWakeAdapter,
} from "./native-wake.js";
import {
  checkClaudePeerAuthHelper,
  type ClaudePeerAuthProbeOptions,
} from "./claude-peer-auth.js";
import {
  RenewalReauthorisationRequired,
  RenewalRevoked,
  RenewalSuspended,
} from "./renewal.js";
import { AgentSessionClient } from "./session-client.js";
import { AgentSessionManager } from "./session-manager.js";
import { sessionProofOf, type SessionContextDocument } from "./session-context.js";
import { bindSessionProof } from "./session-proof.js";
import {
  compareSignalCursor,
  readAgentSignalDirectory,
  readAgentSignalPage,
  signalReachesAgent,
  type SignalCursor,
} from "./signals.js";
import {
  FileLockTimeoutError,
  readSecureJsonFileIfPresent,
  withFileLock,
  writeSecureJsonFile,
} from "./storage.js";

export const CLAUDE_WAKE_ENV_SOCKET = "CLAUDE_CODE_MESSAGING_SOCKET";
export const CLAUDE_WAKE_ENV_TOKEN = "CLAUDE_CODE_MESSAGING_TOKEN";
const CLAUDE_WAKE_REGISTRATION_MAX_BYTES = 16 * 1024;
const CLAUDE_SESSION_META_MAX_BYTES = 64 * 1024;
const CLAUDE_SOCKET_TIMEOUT_MS = 5_000;
const CLAUDE_WAKE_HEARTBEAT_MS = 5_000;
const CLAUDE_WAKE_POLL_MS = 30_000;
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

export interface ClaudeWakeRegistration {
  version: 1;
  profile: string;
  host_session_id: string;
  socket_path: string;
  token: string;
  registered_at: string;
}

export interface ClaudeSessionRegistryEntry {
  sessionId: string;
  pid: number;
  status: string;
  messagingSocketPath: string;
  cwd: string | null;
  peerProtocol: number | null;
  updatedAtMs: number;
}

export type ClaudeSessionRegistryInspection =
  | { found: true; entry: ClaudeSessionRegistryEntry }
  | { found: false; reason: string };

export type ClaudeSocketTransport = (input: {
  socketPath: string;
  lines: readonly string[];
  expectedPid: number;
  expectedUid: number;
  timeoutMs: number;
  signal?: AbortSignal;
  peerAuthOptions?: ClaudePeerAuthProbeOptions;
}) => Promise<void>;

export function claudeWakeRegistrationPath(profilePath: string, hostSessionId: string): string {
  const profile = privatePath(profilePath);
  const host = checkedHostSessionId(hostSessionId);
  return join(dirname(profile), `wake-claude-${profileScopeKey(host)}.json`);
}

function defaultClaudeSessionsDir(): string {
  return join(homedir(), ".claude", "sessions");
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function validateClaudeMessagingToken(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 4096 || CONTROL_CHAR_RE.test(raw)) {
    throw new AgentSetupError(
      "claude_wake_token_invalid",
      `${CLAUDE_WAKE_ENV_TOKEN} must be a non-empty single-line messaging token from this Claude session.`,
    );
  }
  return raw;
}

const CLAUDE_WAKE_LOCK_TIMEOUT_MS = 2_000;

/**
 * Enforce a canonical Unix socket path whose entire directory chain prevents replacement
 * by another local principal:
 *   1. No non-root symlink anywhere along the raw input path (allows macOS root-owned /tmp -> private/tmp).
 *   2. Every canonical ancestor directory from / down to dirname(socket) is owned by root or the
 *      current UID, and any group/world-writable ancestor (e.g. /private/tmp) must carry the sticky bit.
 *   3. The socket's immediate canonical parent directory must be private (0700, owned by current UID),
 *      preventing any other local principal from traversing, unlinking, or replacing the socket before connect.
 *   4. The socket entry itself must be an owned, non-symlink, non-group/world-writable Unix domain socket.
 */
export async function validateClaudeSocketPath(raw: unknown): Promise<{ socketPath: string; canonicalPath: string }> {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 1024 || CONTROL_CHAR_RE.test(raw) || !isAbsolute(raw)) {
    throw new AgentSetupError(
      "claude_wake_socket_invalid",
      `${CLAUDE_WAKE_ENV_SOCKET} must be an absolute path to this Claude session's Unix inbox socket.`,
    );
  }
  const myUid = process.getuid ? process.getuid() : null;

  // 1. Reject any "." / ".." traversal or non-root symlink along the raw input path.
  const rawParts = raw.split("/").filter((part) => part.length > 0);
  if (rawParts.length === 0 || rawParts.some((part) => part === "." || part === "..")) {
    throw new AgentSetupError(
      "claude_wake_socket_unsafe",
      "The Claude inbox socket path must be a normalized absolute path without traversal segments.",
    );
  }
  let rawCursor = "";
  for (let i = 0; i < rawParts.length; i += 1) {
    rawCursor = `${rawCursor}/${rawParts[i]!}`;
    let stepInfo;
    try {
      stepInfo = await lstat(rawCursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new AgentSetupError(
          "claude_wake_socket_missing",
          "The Claude inbox socket path does not exist on this host. Run this inside the live Claude session.",
        );
      }
      throw error;
    }
    if (stepInfo.isSymbolicLink()) {
      const isFinal = i === rawParts.length - 1;
      if (isFinal || stepInfo.uid !== 0) {
        throw new AgentSetupError(
          "claude_wake_socket_unsafe",
          "The Claude inbox socket path must not traverse a user-writable or non-root symlink.",
        );
      }
    }
  }

  // 2. Canonicalize parent directory and verify every directory ancestor from / down to parent.
  const canonicalDir = await realpath(dirname(raw));
  const canonicalPath = join(canonicalDir, basename(raw));
  const dirParts = canonicalDir.split("/").filter((part) => part.length > 0);
  const ancestors: string[] = ["/"];
  let acc = "";
  for (const part of dirParts) {
    acc = `${acc}/${part}`;
    ancestors.push(acc);
  }
  for (let i = 0; i < ancestors.length; i += 1) {
    const ancestor = ancestors[i]!;
    const dirInfo = await lstat(ancestor);
    if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink()) {
      throw new AgentSetupError(
        "claude_wake_socket_unsafe",
        "The Claude inbox socket parent chain must consist exclusively of real directories.",
      );
    }
    const mode = dirInfo.mode & 0o7777;
    if (myUid !== null && dirInfo.uid !== 0 && dirInfo.uid !== myUid) {
      throw new AgentSetupError(
        "claude_wake_socket_unsafe",
        "The Claude inbox socket directory chain must be owned by root or the current user.",
      );
    }
    const isImmediateParent = i === ancestors.length - 1;
    if (isImmediateParent) {
      if ((myUid !== null && dirInfo.uid !== myUid) || (mode & 0o077) !== 0) {
        throw new AgentSetupError(
          "claude_wake_socket_unsafe",
          "The Claude inbox socket directory must be a private 0700 directory owned by the current user.",
        );
      }
    } else if ((mode & 0o022) !== 0 && (mode & 0o1000) === 0) {
      throw new AgentSetupError(
        "claude_wake_socket_unsafe",
        "A writable ancestor directory of the Claude inbox socket is missing the sticky bit.",
      );
    }
  }

  // 3. Verify the canonical socket entry itself.
  let info;
  try {
    info = await lstat(canonicalPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new AgentSetupError(
        "claude_wake_socket_missing",
        "The Claude inbox socket path does not exist on this host. Run this inside the live Claude session.",
      );
    }
    throw error;
  }
  const sockMode = info.mode & 0o7777;
  if (
    !info.isSocket() ||
    info.isSymbolicLink() ||
    (myUid !== null && info.uid !== myUid) ||
    (sockMode & 0o022) !== 0
  ) {
    throw new AgentSetupError(
      "claude_wake_socket_unsafe",
      "The Claude inbox socket must be an owned, non-symlink, non-group/world-writable Unix domain socket.",
    );
  }
  return { socketPath: canonicalPath, canonicalPath };
}

function parseClaudeWakeRegistration(
  raw: string,
  expectedProfile: string,
  expectedHost: string,
): ClaudeWakeRegistration | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const r = parsed as Record<string, unknown>;
  if (
    r.version !== 1 ||
    r.profile !== expectedProfile ||
    r.host_session_id !== expectedHost ||
    typeof r.socket_path !== "string" ||
    !isAbsolute(r.socket_path) ||
    CONTROL_CHAR_RE.test(r.socket_path) ||
    typeof r.token !== "string" ||
    r.token.length === 0 ||
    r.token.length > 4096 ||
    CONTROL_CHAR_RE.test(r.token) ||
    typeof r.registered_at !== "string" ||
    !Number.isFinite(Date.parse(r.registered_at))
  ) {
    return null;
  }
  return r as unknown as ClaudeWakeRegistration;
}

export async function readClaudeWakeRegistration(
  profilePath: string,
  hostSessionId: string,
): Promise<ClaudeWakeRegistration | null> {
  const profile = privatePath(profilePath);
  const host = checkedHostSessionId(hostSessionId);
  const raw = await readSecureJsonFileIfPresent(
    claudeWakeRegistrationPath(profile, host),
    CLAUDE_WAKE_REGISTRATION_MAX_BYTES,
  );
  if (raw === null) return null;
  return parseClaudeWakeRegistration(raw, profile, host);
}

export async function clearClaudeWakeRegistration(
  profilePath: string,
  hostSessionId: string,
): Promise<void> {
  const path = claudeWakeRegistrationPath(profilePath, hostSessionId);
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/**
 * Inspect `~/.claude/sessions/*.json` for the bound Claude session.
 * Strictly ignores `*.key` and any symlink, non-JSON, non-owned, or oversized file.
 */
export async function inspectClaudeSessionRegistry(options: {
  hostSessionId: string;
  expectedCwd?: string;
  sessionsDir?: string;
  isPidAlive?: (pid: number) => boolean;
}): Promise<ClaudeSessionRegistryInspection> {
  const host = checkedHostSessionId(options.hostSessionId);
  const dir = options.sessionsDir ?? defaultClaudeSessionsDir();
  const alive = options.isPidAlive ?? processAlive;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { found: false, reason: "claude_sessions_dir_missing" };
    }
    return { found: false, reason: "claude_sessions_dir_unreadable" };
  }

  let expectedCanonicalCwd: string | null = null;
  if (options.expectedCwd) {
    expectedCanonicalCwd = await realpath(options.expectedCwd).catch(() => options.expectedCwd!);
  }

  let best: ClaudeSessionRegistryEntry | null = null;
  let sawDeadMatch = false;
  let sawCwdMismatch = false;

  for (const name of names) {
    // Hard boundary: NEVER touch *.key or any non-.json file in ~/.claude/sessions/.
    if (!name.endsWith(".json")) continue;
    const filePath = join(dir, name);
    let info;
    try {
      info = await lstat(filePath);
    } catch {
      continue;
    }
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size > CLAUDE_SESSION_META_MAX_BYTES ||
      (process.getuid && info.uid !== process.getuid())
    ) {
      continue;
    }
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const rec = parsed as Record<string, unknown>;
    if (rec.sessionId !== host) continue;
    const pid = rec.pid;
    if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 1) continue;
    if (!alive(pid)) {
      sawDeadMatch = true;
      continue;
    }
    if (
      typeof rec.messagingSocketPath !== "string" ||
      !isAbsolute(rec.messagingSocketPath) ||
      CONTROL_CHAR_RE.test(rec.messagingSocketPath) ||
      typeof rec.status !== "string"
    ) {
      continue;
    }
    const rawCwd = typeof rec.cwd === "string" && rec.cwd.length > 0 ? rec.cwd : null;
    if (expectedCanonicalCwd !== null) {
      if (rawCwd === null) {
        sawCwdMismatch = true;
        continue;
      }
      const entryCwd = await realpath(rawCwd).catch(() => rawCwd);
      if (entryCwd !== expectedCanonicalCwd) {
        sawCwdMismatch = true;
        continue;
      }
    }
    const updatedAtMs = Math.max(
      typeof rec.statusUpdatedAt === "number" && Number.isFinite(rec.statusUpdatedAt) ? rec.statusUpdatedAt : 0,
      typeof rec.updatedAt === "number" && Number.isFinite(rec.updatedAt) ? rec.updatedAt : 0,
      info.mtimeMs,
    );
    const entry: ClaudeSessionRegistryEntry = {
      sessionId: host,
      pid,
      status: rec.status,
      messagingSocketPath: rec.messagingSocketPath,
      cwd: rawCwd,
      peerProtocol: typeof rec.peerProtocol === "number" ? rec.peerProtocol : null,
      updatedAtMs,
    };
    if (best === null || entry.updatedAtMs >= best.updatedAtMs) {
      best = entry;
    }
  }

  if (best !== null) {
    return { found: true, entry: best };
  }
  if (sawCwdMismatch) {
    return { found: false, reason: "claude_session_cwd_mismatch" };
  }
  if (sawDeadMatch) {
    return { found: false, reason: "claude_session_not_running" };
  }
  return { found: false, reason: "claude_session_not_found" };
}

/**
 * Save this Claude session's `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN`
 * (from its own process environment — never argv) into a 0600 registration file bound to this
 * private profile and host session ID.
 */
export async function registerClaudeWakeSocket(options: {
  profilePath: string;
  hostSessionId: string;
  env?: NodeJS.ProcessEnv;
  sessionsDir?: string;
  isPidAlive?: (pid: number) => boolean;
  now?: () => number;
}): Promise<{
  registered: true;
  host_session_id: string;
  wake_route: ReturnType<typeof wakeRouteForBinding>;
  registered_at: string;
}> {
  const profile = privatePath(options.profilePath);
  const host = checkedHostSessionId(options.hostSessionId);
  const opened = await readAgentProfile(profile, host);
  if (opened.host_session_id === undefined || opened.host_session_id !== host) {
    throw new AgentSetupError(
      "profile_not_host_bound",
      "Claude inbox-socket wake requires a host-bound profile matching this session's ID.",
    );
  }
  const env = options.env ?? process.env;
  const socketValidated = await validateClaudeSocketPath(env[CLAUDE_WAKE_ENV_SOCKET]);
  const token = validateClaudeMessagingToken(env[CLAUDE_WAKE_ENV_TOKEN]);

  const nowIso = new Date((options.now ?? Date.now)()).toISOString();
  return withFileLock(dirname(profile), `receive-${profileScopeKey(host)}`, async () => {
    const binding = await readReceiveBinding(profile, host);
    if (!binding) {
      throw new AgentSetupError(
        "receive_not_configured",
        "Configure Claude socket wake mode first (cswarm receive configure --provider claude --mode wake --wake-transport socket).",
      );
    }
    if (binding.provider !== "claude") {
      throw new AgentSetupError(
        "receive_provider_mismatch",
        `Claude inbox-socket registration only applies to --provider claude (this binding is ${binding.provider}).`,
      );
    }
    if (binding.requested_mode !== "wake") {
      throw new AgentSetupError(
        "wake_opted_out",
        "Cannot register a Claude inbox-socket token while this seat is in turn mode. Opt into wake mode first.",
      );
    }
    if (binding.wake_transport !== "socket") {
      throw new AgentSetupError(
        "wake_transport_mismatch",
        "Cannot register a Claude inbox-socket token while wake transport is channel. Reconfigure with --wake-transport socket first.",
      );
    }
    const inspected = await inspectClaudeSessionRegistry({
      hostSessionId: host,
      expectedCwd: binding.cwd,
      ...(options.sessionsDir ? { sessionsDir: options.sessionsDir } : {}),
      ...(options.isPidAlive ? { isPidAlive: options.isPidAlive } : {}),
    });
    if (!inspected.found) {
      throw new AgentSetupError(
        inspected.reason,
        `No matching live Claude session found in ~/.claude/sessions for this host session ID (${inspected.reason}).`,
      );
    }
    const liveValidated = await validateClaudeSocketPath(inspected.entry.messagingSocketPath);
    if (liveValidated.canonicalPath !== socketValidated.canonicalPath) {
      throw new AgentSetupError(
        "claude_wake_socket_mismatch",
        "The Claude inbox socket in this shell does not match the live session registry entry for this host session ID.",
      );
    }

    const registration: ClaudeWakeRegistration = {
      version: 1,
      profile,
      host_session_id: host,
      socket_path: socketValidated.canonicalPath,
      token,
      registered_at: nowIso,
    };
    await writeSecureJsonFile(claudeWakeRegistrationPath(profile, host), JSON.stringify(registration));
    return {
      registered: true as const,
      host_session_id: host,
      wake_route: wakeRouteForBinding(binding),
      registered_at: nowIso,
    };
  }, { timeoutMs: CLAUDE_WAKE_LOCK_TIMEOUT_MS });
}

/**
 * Best-effort refresh invoked inside `receiveHookEvent` (SessionStart / UserPromptSubmit / Stop)
 * or `configureAgentReceive` after verifying `event.session_id === binding.host_session_id` and `cwd`.
 * Serialized on the shared `receive-<scope>` lock and re-verifies live socket opt-in + positive
 * live session registry match inside the lock so a delayed hook can NEVER recreate a bearer after opt-out.
 */
export async function refreshClaudeWakeSocketFromHookEnv(options: {
  profilePath: string;
  hostSessionId: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  sessionsDir?: string;
  isPidAlive?: (pid: number) => boolean;
  now?: () => number;
  alreadyLocked?: boolean;
  /** Test seam invoked before acquiring the receive lock to simulate a delayed hook racing opt-out. */
  beforeLock?: () => Promise<void> | void;
}): Promise<boolean> {
  const env = options.env ?? process.env;
  const rawSocket = env[CLAUDE_WAKE_ENV_SOCKET];
  const rawToken = env[CLAUDE_WAKE_ENV_TOKEN];
  if (!rawSocket || !rawToken) return false;
  try {
    const profile = privatePath(options.profilePath);
    const host = checkedHostSessionId(options.hostSessionId);
    const opened = await readAgentProfile(profile, host);
    if (opened.host_session_id !== host) return false;
    const token = validateClaudeMessagingToken(rawToken);
    if (options.beforeLock !== undefined) {
      await options.beforeLock();
    }

    const runLocked = async (): Promise<boolean> => {
      const binding = await readReceiveBinding(profile, host).catch(() => null);
      if (
        !binding ||
        binding.provider !== "claude" ||
        binding.requested_mode !== "wake" ||
        binding.wake_transport !== "socket"
      ) {
        return false;
      }
      const socketValidated = await validateClaudeSocketPath(rawSocket);
      const inspected = await inspectClaudeSessionRegistry({
        hostSessionId: host,
        expectedCwd: binding.cwd,
        ...(options.sessionsDir ? { sessionsDir: options.sessionsDir } : {}),
        ...(options.isPidAlive ? { isPidAlive: options.isPidAlive } : {}),
      });
      if (!inspected.found) {
        return false;
      }
      const liveValidated = await validateClaudeSocketPath(inspected.entry.messagingSocketPath);
      if (liveValidated.canonicalPath !== socketValidated.canonicalPath) {
        return false;
      }
      const registration: ClaudeWakeRegistration = {
        version: 1,
        profile,
        host_session_id: host,
        socket_path: socketValidated.canonicalPath,
        token,
        registered_at: new Date((options.now ?? Date.now)()).toISOString(),
      };
      await writeSecureJsonFile(claudeWakeRegistrationPath(profile, host), JSON.stringify(registration));
      return true;
    };

    if (options.alreadyLocked) {
      return await runLocked();
    }
    return await withFileLock(
      dirname(profile),
      `receive-${profileScopeKey(host)}`,
      runLocked,
      { timeoutMs: CLAUDE_WAKE_LOCK_TIMEOUT_MS },
    );
  } catch {
    return false;
  }
}

function sanitizeSocketDetail(detail: string, token: string): string {
  const scrubbed = token.length > 0 ? detail.replaceAll(token, "[redacted]") : detail;
  return scrubbed.replaceAll(/[\r\n]+/g, " ").trim().slice(0, 200) || "claude_socket_write_failed";
}

/**
 * Python helper invoked over a private stdin pipe (never argv/env for the token) that connects to
 * the canonical Unix socket and verifies kernel-authenticated peer credentials BEFORE writing a
 * single auth byte:
 *   - macOS: LOCAL_PEERPID (SOL_LOCAL=0, 0x002) + getpeereid()
 *   - Linux: SO_PEERCRED (SOL_SOCKET, SO_PEERCRED)
 * Fails closed (exit 41/42) with zero bytes written if peer identity cannot be verified or does
 * not match the pinned Claude session PID and current user UID.
 */
const CLAUDE_PEER_AUTH_SENDER_PY = [
  "import ctypes, errno, socket, struct, sys",
  "sock_path = sys.argv[1]",
  "expected_pid = int(sys.argv[2])",
  "expected_uid = int(sys.argv[3])",
  "timeout_s = max(0.05, float(sys.argv[4]))",
  "payload = sys.stdin.buffer.read()",
  "s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)",
  "s.settimeout(timeout_s)",
  "try:",
  "    try:",
  "        s.connect(sock_path)",
  "    except OSError as e:",
  "        if e.errno == errno.ENOENT:",
  "            sys.stderr.write('ENOENT\\n'); sys.exit(43)",
  "        if e.errno == errno.ECONNREFUSED:",
  "            sys.stderr.write('ECONNREFUSED\\n'); sys.exit(44)",
  "        sys.stderr.write(f'CONNECT_ERROR:{e.errno}\\n'); sys.exit(45)",
  "    if sys.platform == 'darwin':",
  "        libc = ctypes.CDLL(None)",
  "        libc.getsockopt.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint32)]",
  "        libc.getsockopt.restype = ctypes.c_int",
  "        pid = ctypes.c_int(0)",
  "        plen = ctypes.c_uint32(ctypes.sizeof(pid))",
  "        if libc.getsockopt(s.fileno(), 0, 0x002, ctypes.byref(pid), ctypes.byref(plen)) != 0:",
  "            sys.stderr.write('peer_cred_unavailable\\n'); sys.exit(41)",
  "        libc.getpeereid.argtypes = [ctypes.c_int, ctypes.POINTER(ctypes.c_uint32), ctypes.POINTER(ctypes.c_uint32)]",
  "        libc.getpeereid.restype = ctypes.c_int",
  "        euid = ctypes.c_uint32(0)",
  "        egid = ctypes.c_uint32(0)",
  "        if libc.getpeereid(s.fileno(), ctypes.byref(euid), ctypes.byref(egid)) != 0:",
  "            sys.stderr.write('peer_cred_unavailable\\n'); sys.exit(41)",
  "        peer_pid, peer_uid = pid.value, euid.value",
  "    elif sys.platform.startswith('linux'):",
  "        so_peercred = getattr(socket, 'SO_PEERCRED', 17)",
  "        cred = s.getsockopt(socket.SOL_SOCKET, so_peercred, struct.calcsize('=iII'))",
  "        peer_pid, peer_uid, _ = struct.unpack('=iII', cred)",
  "    else:",
  "        sys.stderr.write('peer_cred_unsupported\\n'); sys.exit(41)",
  "    if peer_pid != expected_pid or peer_uid != expected_uid:",
  "        sys.stderr.write(f'peer_mismatch:got_pid={peer_pid},got_uid={peer_uid}\\n')",
  "        sys.exit(42)",
  "    s.sendall(payload)",
  "    s.shutdown(socket.SHUT_WR)",
  "finally:",
  "    s.close()",
].join("\n");

function minimalPeerAuthEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "SYSTEMROOT"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

class ClaudeSocketPeerError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ClaudeSocketPeerError";
  }
}

const defaultClaudeSocketTransport: ClaudeSocketTransport = async ({
  socketPath,
  lines,
  expectedPid,
  expectedUid,
  timeoutMs,
  signal,
  peerAuthOptions,
}) => {
  const availability = checkClaudePeerAuthHelper(peerAuthOptions);
  if (!availability.available) {
    throw new ClaudeSocketPeerError(
      "claude_wake_peer_auth_unavailable",
      `Unable to authenticate connected Claude socket peer (${availability.reason}); refusing to send bearer.`,
    );
  }
  await new Promise<void>((resolvePromise, rejectPromise) => {
    if (signal?.aborted) {
      rejectPromise(new Error("claude socket wake aborted"));
      return;
    }
    const payload = `${lines.join("\n")}\n`;
    const timeoutSeconds = (Math.max(100, timeoutMs) / 1000).toFixed(3);
    const child = spawn(
      availability.pythonPath,
      ["-c", CLAUDE_PEER_AUTH_SENDER_PY, socketPath, String(expectedPid), String(expectedUid), timeoutSeconds],
      {
        stdio: ["pipe", "ignore", "pipe"],
        env: minimalPeerAuthEnv(),
      },
    );
    let stderr = "";
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      if (err) rejectPromise(err);
      else resolvePromise();
    };
    const killChild = () => {
      try { child.kill("SIGKILL"); } catch { /* already exited */ }
    };
    const onAbort = () => {
      killChild();
      finish(new Error("claude socket wake aborted"));
    };
    const timer = setTimeout(() => {
      killChild();
      finish(new Error("claude socket wake timed out"));
    }, timeoutMs);
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < 512) stderr += chunk;
    });
    child.once("error", (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        finish(new ClaudeSocketPeerError(
          "claude_wake_peer_auth_unavailable",
          "Unable to authenticate connected Claude socket peer (python3 unavailable); refusing to send bearer.",
        ));
        return;
      }
      finish(err instanceof Error ? err : new Error(String(err)));
    });
    child.once("close", (code) => {
      if (code === 0) {
        finish();
        return;
      }
      const detail = stderr.trim();
      if (code === 41) {
        finish(new ClaudeSocketPeerError(
          "claude_wake_peer_auth_unavailable",
          `Unable to authenticate connected Claude socket peer (${detail || "peer_cred_unavailable"}); refusing to send bearer.`,
        ));
        return;
      }
      if (code === 42) {
        finish(new ClaudeSocketPeerError(
          "claude_wake_peer_mismatch",
          `Connected Unix socket peer does not match pinned Claude session pid=${expectedPid} uid=${expectedUid} (${detail || "peer_mismatch"}); zero auth bytes sent.`,
        ));
        return;
      }
      if (code === 43) {
        finish(new ClaudeSocketPeerError("claude_wake_socket_missing", "Claude inbox socket disappeared before connect."));
        return;
      }
      if (code === 44) {
        finish(new ClaudeSocketPeerError("claude_wake_socket_refused", "Claude inbox socket refused connection."));
        return;
      }
      finish(new Error(detail || `claude socket peer-auth helper exited with code ${String(code)}`));
    });
    child.stdin?.once("error", () => { /* ignore EPIPE if helper rejected peer before reading stdin */ });
    child.stdin?.end(payload, "utf8");
  });
};

export interface ClaudeSocketAdapterOptions {
  profilePath: string;
  sessionsDir?: string;
  timeoutMs?: number;
  transport?: ClaudeSocketTransport;
  isPidAlive?: (pid: number) => boolean;
  peerAuthOptions?: ClaudePeerAuthProbeOptions;
}

/**
 * Native Claude Code inbox-socket adapter.
 * Sends strictly two NDJSON lines on a single Unix socket connection:
 *   1. `{"type":"auth","token":"<token>"}`
 *   2. `{"type":"user","message":{"role":"user","content":"New CommonSwarm messages (batch N): run cswarm check"}}`
 * Only dispatches when the bound session's `~/.claude/sessions/<pid>.json` reports `status === "idle"`
 * and matches the registered owned Unix socket.
 */
export class ClaudeSocketAdapter implements NativeWakeAdapter {
  readonly route = "claude-socket" as const;
  private readonly profilePath: string;
  private readonly sessionsDir: string | undefined;
  private readonly timeoutMs: number;
  private readonly transport: ClaudeSocketTransport;
  private readonly isPidAlive: ((pid: number) => boolean) | undefined;
  private readonly peerAuthOptions: ClaudePeerAuthProbeOptions | undefined;

  constructor(options: ClaudeSocketAdapterOptions) {
    this.profilePath = privatePath(options.profilePath);
    this.sessionsDir = options.sessionsDir;
    this.timeoutMs = options.timeoutMs ?? CLAUDE_SOCKET_TIMEOUT_MS;
    this.transport = options.transport ?? defaultClaudeSocketTransport;
    this.isPidAlive = options.isPidAlive;
    this.peerAuthOptions = options.peerAuthOptions;
  }

  private async resolveLiveIdleTarget(hostSessionId: string, cwd: string): Promise<
    | { ok: true; registration: ClaudeWakeRegistration; entry: ClaudeSessionRegistryEntry; canonicalPath: string }
    | { ok: false; deferrable: boolean; code: string; detail: string }
  > {
    const registration = await readClaudeWakeRegistration(this.profilePath, hostSessionId).catch(() => null);
    if (registration === null) {
      return {
        ok: false,
        deferrable: false,
        code: "claude_wake_token_missing",
        detail: "No 0600 Claude inbox-socket registration exists for this session. Run cswarm receive register-socket inside the Claude session.",
      };
    }

    const inspected = await inspectClaudeSessionRegistry({
      hostSessionId,
      expectedCwd: cwd,
      ...(this.sessionsDir ? { sessionsDir: this.sessionsDir } : {}),
      ...(this.isPidAlive ? { isPidAlive: this.isPidAlive } : {}),
    });
    if (!inspected.found) {
      return {
        ok: false,
        deferrable: false,
        code: inspected.reason,
        detail: `Bound Claude session ${hostSessionId} is not live in the session registry (${inspected.reason}).`,
      };
    }
    if (inspected.entry.status !== "idle") {
      return {
        ok: false,
        deferrable: true,
        code: "claude_session_busy",
        detail: `Claude session status is ${inspected.entry.status}; waiting until idle.`,
      };
    }

    let validated: { socketPath: string; canonicalPath: string };
    try {
      validated = await validateClaudeSocketPath(registration.socket_path);
    } catch (error) {
      return {
        ok: false,
        deferrable: false,
        code: error instanceof AgentSetupError ? error.code : "claude_wake_socket_invalid",
        detail: error instanceof Error ? error.message : "Claude inbox socket is unavailable.",
      };
    }
    let registryValidated: { socketPath: string; canonicalPath: string };
    try {
      registryValidated = await validateClaudeSocketPath(inspected.entry.messagingSocketPath);
    } catch (error) {
      return {
        ok: false,
        deferrable: false,
        code: error instanceof AgentSetupError ? error.code : "claude_wake_socket_invalid",
        detail: error instanceof Error ? error.message : "Live Claude inbox socket is unavailable.",
      };
    }
    if (registryValidated.canonicalPath !== validated.canonicalPath) {
      return {
        ok: false,
        deferrable: false,
        code: "claude_wake_socket_mismatch",
        detail: "Registered Claude inbox socket no longer matches the live session registry. Re-run cswarm receive register-socket.",
      };
    }
    return { ok: true, registration, entry: inspected.entry, canonicalPath: validated.canonicalPath };
  }

  async isReadyToWake(input: {
    hostSessionId: string;
    cwd: string;
  }): Promise<{ ready: true } | { ready: false; reason: string }> {
    const inspected = await inspectClaudeSessionRegistry({
      hostSessionId: input.hostSessionId,
      expectedCwd: input.cwd,
      ...(this.sessionsDir ? { sessionsDir: this.sessionsDir } : {}),
      ...(this.isPidAlive ? { isPidAlive: this.isPidAlive } : {}),
    });
    if (inspected.found && inspected.entry.status !== "idle") {
      return { ready: false, reason: `status=${inspected.entry.status}` };
    }
    return { ready: true };
  }

  async sendWake(input: {
    hostSessionId: string;
    prompt: string;
    batch: number;
    cwd: string;
    signal?: AbortSignal;
  }): Promise<{ ok: true } | { ok: false; code: string; detail: string }> {
    try {
      assertFixedNativeWakePrompt(input.prompt);
    } catch (error) {
      return {
        ok: false,
        code: "wake_prompt_unsafe",
        detail: error instanceof Error ? error.message : "Unsafe wake prompt refused.",
      };
    }

    const target = await this.resolveLiveIdleTarget(input.hostSessionId, input.cwd);
    if (!target.ok) {
      return { ok: false, code: target.code, detail: target.detail };
    }

    const expectedUid = process.getuid ? process.getuid() : -1;
    if (expectedUid < 0) {
      return {
        ok: false,
        code: "claude_wake_peer_auth_unavailable",
        detail: "Cannot determine local UID to authenticate Claude inbox socket peer.",
      };
    }

    const authLine = JSON.stringify({ type: "auth", token: target.registration.token });
    const userLine = JSON.stringify({
      type: "user",
      message: { role: "user", content: input.prompt },
    });

    try {
      await this.transport({
        socketPath: target.canonicalPath,
        lines: [authLine, userLine],
        expectedPid: target.entry.pid,
        expectedUid,
        timeoutMs: this.timeoutMs,
        ...(input.signal ? { signal: input.signal } : {}),
        ...(this.peerAuthOptions ? { peerAuthOptions: this.peerAuthOptions } : {}),
      });
      return { ok: true };
    } catch (error) {
      if (error instanceof ClaudeSocketPeerError) {
        return {
          ok: false,
          code: error.code,
          detail: sanitizeSocketDetail(error.message, target.registration.token),
        };
      }
      const err = error as NodeJS.ErrnoException;
      const code =
        err.code === "ENOENT"
          ? "claude_wake_socket_missing"
          : err.code === "ECONNREFUSED"
          ? "claude_wake_socket_refused"
          : "claude_socket_write_failed";
      const detail = sanitizeSocketDetail(err.message || code, target.registration.token);
      return { ok: false, code, detail };
    }
  }
}

function claudeCanaryBody(nonce: string): string {
  return `CommonSwarm wake test ${nonce}. Confirm receipt in this session. No reply or other work is needed.`;
}

async function readCheckCursor(profilePath: string): Promise<SignalCursor | null> {
  const raw = await readSecureJsonFileIfPresent(join(dirname(profilePath), "check.json"), 16 * 1024 * 1024).catch(() => null);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as { cursor?: unknown };
    if (
      parsed &&
      parsed.cursor &&
      typeof parsed.cursor === "object" &&
      typeof (parsed.cursor as Record<string, unknown>).id === "string" &&
      typeof (parsed.cursor as Record<string, unknown>).created_at === "string"
    ) {
      return {
        id: (parsed.cursor as { id: string }).id,
        created_at: (parsed.cursor as { created_at: string }).created_at,
      };
    }
  } catch { /* ignore unreadable check cursor */ }
  return null;
}

export interface ServeClaudeWakeBridgeOptions {
  profilePath: string;
  hostSessionId: string;
  sessionsDir?: string;
  adapter?: NativeWakeAdapter;
  debounceMs?: number;
  minIntervalMs?: number;
  retryAfterMs?: number;
  pollMs?: number;
  heartbeatMs?: number;
  fetcher?: typeof fetch;
  wake?: WakeHandle;
  isPidAlive?: (pid: number) => boolean;
  now?: () => number;
  signal?: AbortSignal;
  /** Test seam invoked right before the shared-lock startup mutation to test startup racing a route change. */
  beforeStartupLock?: () => Promise<void> | void;
}

/**
 * Long-lived bridge for `cswarm receive serve --profile P --host-session-id <claude-session-id>`
 * on a Claude Code seat configured with `wake_transport: "socket"`. Watches read-only inbox arrivals
 * (Realtime push + bounded reconcile poll) and nudges the bound idle Claude session over its Unix
 * inbox socket with fixed text only.
 */
export async function serveClaudeWakeBridge(options: ServeClaudeWakeBridgeOptions): Promise<void> {
  const profilePath = privatePath(options.profilePath);
  const host = checkedHostSessionId(options.hostSessionId);
  const initialAuth = await resolveAuthorizedWakeBinding({
    profilePath,
    hostSessionId: host,
    expectedProvider: "claude",
    expectedWakeTransport: "socket",
  });
  if (!initialAuth.ok) {
    throw new AgentSetupError(initialAuth.code, initialAuth.detail);
  }
  const profile = initialAuth.profile;
  const initial = initialAuth.binding;
  if (receiveStatus(initial).channel_running) {
    throw new AgentSetupError(
      "channel_already_running",
      "This session already has a live wake bridge. Keep one receiver.",
    );
  }

  const now = options.now ?? Date.now;
  const pollMs = options.pollMs ?? CLAUDE_WAKE_POLL_MS;
  const heartbeatMs = options.heartbeatMs ?? CLAUDE_WAKE_HEARTBEAT_MS;
  const runtimeId = randomUUID();
  const abort = new AbortController();
  const externalAbort = () => abort.abort();
  if (options.signal) {
    if (options.signal.aborted) abort.abort();
    else options.signal.addEventListener("abort", externalAbort, { once: true });
  }

  const baseFetch = options.fetcher ?? fetch;
  let manager: AgentSessionManager | null = null;
  const target = profileTarget(profile);
  const managed = await profileSessionContext(profile, host);
  const context: SessionContextDocument | null = managed?.context ?? null;
  const authenticatedFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const proof = manager?.currentProof() ?? (context ? sessionProofOf(context) : null);
    return bindSessionProof(baseFetch, proof)(input, {
      ...init,
      redirect: "error",
      signal: init?.signal ? AbortSignal.any([init.signal, abort.signal]) : abort.signal,
    });
  }) as typeof fetch;

  const credential = await openProfileCredential(profile, authenticatedFetch);
  const firstToken = await credential.bearer();
  assertProfileIdentity(
    profile,
    await readAgentSignalDirectory(target, firstToken, profile.workspace_id, {
      fetcher: authenticatedFetch,
      signal: abort.signal,
      deadlineMs: now() + 10_000,
    }),
  );
  if (context) {
    manager = new AgentSessionManager({
      client: new AgentSessionClient({ target, fetcher: authenticatedFetch }),
      credential: () => credential.bearer(),
      workspaceId: profile.workspace_id,
      context,
      contextPath: managed!.path,
    });
  }

  const sender = new ThinCommandClient(target, authenticatedFetch, { signalRequestTimeoutMs: 10_000 });
  const adapter = options.adapter ?? new ClaudeSocketAdapter({
    profilePath,
    ...(options.sessionsDir ? { sessionsDir: options.sessionsDir } : {}),
    ...(options.isPidAlive ? { isPidAlive: options.isPidAlive } : {}),
  });
  const bridge = new NativeWakeBridge({
    profilePath,
    hostSessionId: host,
    cwd: initial.cwd,
    adapter,
    expectedProvider: "claude",
    expectedWakeTransport: "socket",
    expectedSeat: {
      workspaceId: profile.workspace_id,
      principalId: profile.principal_id,
    },
    ...(options.debounceMs !== undefined ? { debounceMs: options.debounceMs } : {}),
    ...(options.minIntervalMs !== undefined ? { minIntervalMs: options.minIntervalMs } : {}),
    ...(options.retryAfterMs !== undefined ? { retryAfterMs: options.retryAfterMs } : {}),
    now,
  });
  const wake: WakeHandle = options.wake ?? createWakeSubscriber({ target });

  let stopped = false;
  let lastPoll = 0;
  let lastErrorCode: string | null = null;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let cursor: SignalCursor | null = await readCheckCursor(profilePath);
  if (cursor === null) {
    const baseline = await readAgentSignalPage(
      target,
      { kind: "agent", token: firstToken },
      {
        workspaceId: profile.workspace_id,
        inbox: true,
        ascending: false,
        limit: 20,
        includeStale: false,
      },
      { fetcher: authenticatedFetch, signal: abort.signal, deadlineMs: now() + 10_000 },
    );
    const baselineReachable = baseline.signals.filter(
      (row) => row.workspace_id === profile.workspace_id && signalReachesAgent(row, profile.principal_id),
    );
    if (baselineReachable.length > 0) {
      const newest = baselineReachable.reduce((best, item) =>
        compareSignalCursor({ id: item.id, created_at: item.created_at }, { id: best.id, created_at: best.created_at }) > 0
          ? item
          : best,
      );
      cursor = { id: newest.id, created_at: newest.created_at };
    }
    if (baseline.wake?.topic) wake.setTopic(baseline.wake.topic);
    lastPoll = now();
    wake.noteClaim(lastPoll);
  }

  const stop = () => {
    stopped = true;
    abort.abort();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  await withFileLock(dirname(profilePath), `channel-start-${profileScopeKey(host)}`, async () => {
    const binding = await readReceiveBinding(profilePath, host);
    if (!binding || binding.provider !== "claude" || binding.requested_mode !== "wake" || binding.wake_transport !== "socket") {
      throw new AgentSetupError(
        binding?.requested_mode !== "wake" ? "wake_opted_out" : "wake_transport_mismatch",
        "Claude socket wake is not active for this session.",
      );
    }
    if (receiveStatus(binding, now()).channel_running) {
      throw new AgentSetupError("channel_already_running", "This session already has a live wake bridge.");
    }
    if (options.beforeStartupLock !== undefined) {
      await options.beforeStartupLock();
    }
    // Recheck the selected route and running marker INSIDE the shared receive-<scope> lock
    // so a concurrent route/mode switch can never receive stale bridge runtime state.
    await updateReceiveBinding(profilePath, host, (b) => {
      if (b.provider !== "claude" || b.requested_mode !== "wake" || b.wake_transport !== "socket") {
        throw new AgentSetupError(
          b.requested_mode !== "wake" ? "wake_opted_out" : "wake_transport_mismatch",
          "Claude socket wake is no longer active for this session.",
        );
      }
      if (receiveStatus(b, now()).channel_running) {
        throw new AgentSetupError("channel_already_running", "This session already has a live wake bridge.");
      }
      return {
        ...b,
        channel_instance_id: runtimeId,
        channel_pid: process.pid,
        channel_heartbeat_at: new Date(now()).toISOString(),
        wake_verified_at: null,
        canary: b.canary ? { ...b.canary, emitted_while_idle: false, received_at: null } : null,
      };
    });
  });

  let touching = false;
  const bindingStillOwned = async (): Promise<boolean> => {
    const current = await readReceiveBinding(profilePath, host).catch(() => null);
    return (
      current !== null &&
      current.requested_mode === "wake" &&
      current.wake_transport === "socket" &&
      current.channel_instance_id === runtimeId
    );
  };
  const touch = async (): Promise<void> => {
    if (stopped || abort.signal.aborted || touching) return;
    touching = true;
    try {
      if (bridge.isDispatching()) {
        if (!(await bindingStillOwned())) {
          stop();
        }
        return;
      }
      await updateReceiveBinding(profilePath, host, (b) => {
        if (b.channel_instance_id !== runtimeId || b.requested_mode !== "wake" || b.wake_transport !== "socket") {
          stop();
          return b;
        }
        return { ...b, channel_heartbeat_at: new Date(now()).toISOString() };
      });
    } catch (error) {
      if (error instanceof FileLockTimeoutError) {
        if (!(await bindingStillOwned())) {
          stop();
        }
        return;
      }
      stop();
    } finally {
      touching = false;
    }
  };

  try {
    heartbeat = setInterval(() => {
      void touch();
    }, heartbeatMs);
    manager?.start();

    while (!stopped && !abort.signal.aborted) {
      if (manager && manager.dispatchState() !== "running") {
        throw new AgentSetupError(
          "channel_session_expired",
          "The managed session stopped. Renew or restart that same session before enabling wake again.",
        );
      }
      const liveAuth = await resolveAuthorizedWakeBinding({
        profilePath,
        hostSessionId: host,
        expectedProvider: "claude",
        expectedWakeTransport: "socket",
        expectedSeat: {
          workspaceId: profile.workspace_id,
          principalId: profile.principal_id,
        },
      });
      if (!liveAuth.ok || liveAuth.binding.channel_instance_id !== runtimeId) {
        break;
      }
      const binding = liveAuth.binding;

      try {
        const token = await credential.bearer();

        // Emit self-addressed canary once the Claude session is proven idle (Stop hook or registry status === "idle").
        if (binding.canary && binding.canary.signal_id === null) {
          let isIdle = binding.idle;
          if (!isIdle) {
            const inspected = await inspectClaudeSessionRegistry({
              hostSessionId: host,
              expectedCwd: binding.cwd,
              ...(options.sessionsDir ? { sessionsDir: options.sessionsDir } : {}),
              ...(options.isPidAlive ? { isPidAlive: options.isPidAlive } : {}),
            });
            isIdle = inspected.found && inspected.entry.status === "idle";
          }
          if (isIdle) {
            const result = await sender.sendSignal({
              workspaceId: profile.workspace_id,
              credential: token,
              commandId: `canary_${binding.canary.nonce.replace(/-/g, "")}`,
              command: {
                kind: "post_signal",
                signal_kind: "note",
                body: claudeCanaryBody(binding.canary.nonce),
                to_user_id: null,
                to_agent_principal_id: profile.principal_id,
                in_reply_to: null,
                about: null,
                until_ms: 5 * 60_000,
              },
              signal: abort.signal,
            });
            if (result.response.status !== "accepted") {
              throw new AgentSetupError("canary_refused", "The service did not accept the wake test.");
            }
            const canaryId = result.response.signal?.id;
            if (!canaryId) {
              throw new AgentSetupError("canary_outcome_unknown", "The service did not name the accepted wake test.");
            }
            await updateReceiveBinding(profilePath, host, (b) =>
              b.canary?.nonce === binding.canary?.nonce
                ? { ...b, canary: { ...b.canary!, signal_id: canaryId, emitted_while_idle: true } }
                : b,
            );
            lastPoll = 0;
          }
        }

        // Read-only arrival check (never claims or advances check.json).
        if (now() - lastPoll >= pollMs) {
          const checkCursor = await readCheckCursor(profilePath);
          if (checkCursor && (!cursor || compareSignalCursor(checkCursor, cursor) > 0)) {
            cursor = checkCursor;
          }
          const page = await readAgentSignalPage(
            target,
            { kind: "agent", token },
            {
              workspaceId: profile.workspace_id,
              inbox: true,
              ascending: true,
              limit: 20,
              ...(cursor !== null ? { after: cursor } : {}),
              includeStale: false,
            },
            { fetcher: authenticatedFetch, signal: abort.signal, deadlineMs: now() + 10_000 },
          );
          lastPoll = now();
          wake.noteClaim(lastPoll);
          if (page.wake?.topic) wake.setTopic(page.wake.topic);

          const reachable = page.signals.filter(
            (row) => row.workspace_id === profile.workspace_id && signalReachesAgent(row, profile.principal_id),
          );
          if (reachable.length > 0) {
            let fresh = 0;
            for (const row of reachable) {
              const next = { id: row.id, created_at: row.created_at };
              if (cursor === null || compareSignalCursor(next, cursor) > 0) {
                cursor = next;
                fresh += 1;
              }
            }
            if (fresh > 0) {
              bridge.notifyArrival();
            }
          }
        }

        const decision = await bridge.tick(abort.signal);
        if (decision.action === "binding_inactive") {
          break;
        }
        if (decision.action === "sent" || decision.action === "error") {
          await touch();
        }
        if (decision.action === "error" && decision.code !== lastErrorCode) {
          process.stderr.write(`CommonSwarm claude wake: ${decision.code}: ${decision.detail}\n`);
          lastErrorCode = decision.code;
        } else if (decision.action === "sent") {
          lastErrorCode = null;
        }

        const waitUntil = Math.min(lastPoll + pollMs, now() + 250);
        const reason = await wake.next({ until: waitUntil, signal: abort.signal });
        if (reason === "wake" && wake.canClaimOnWake(now())) {
          wake.noteWakeClaim(now());
          lastPoll = 0;
        }
      } catch (error) {
        if (abort.signal.aborted) break;
        if (
          error instanceof RenewalReauthorisationRequired ||
          error instanceof RenewalRevoked ||
          error instanceof RenewalSuspended
        ) {
          throw error;
        }
        const code = error instanceof AgentSetupError ? error.code : "claude_wake_poll_failed";
        if (code !== lastErrorCode) {
          process.stderr.write(`CommonSwarm claude wake: ${code}. Check cswarm receive status.\n`);
          lastErrorCode = code;
        }
        await delay(2_000, undefined, { signal: abort.signal }).catch(() => undefined);
      }
    }
  } catch (error) {
    if (!abort.signal.aborted) throw error;
  } finally {
    stop();
    if (options.signal) options.signal.removeEventListener("abort", externalAbort);
    if (heartbeat) clearInterval(heartbeat);
    manager?.stopTimers();
    await wake.close();
    await updateReceiveBinding(profilePath, host, (b) =>
      b.channel_instance_id === runtimeId
        ? { ...b, channel_pid: null, channel_heartbeat_at: null, wake_verified_at: null }
        : b,
    ).catch(() => undefined);
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  }
}
