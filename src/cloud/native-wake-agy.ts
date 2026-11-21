/**
 * Experimental native Antigravity wake adapter (`agy agentapi send-message`) behind an
 * explicit feature flag (`--provider agy --mode wake --experimental-agy-agentapi`).
 *
 * HezLead narrow scope decisions on #716 (2026-11-20):
 *   1. C1 — Short-lived child env handoff, approved build allowlist & Option B Homebrew ancestor trust:
 *      - The vendor Antigravity CLI (`antigravity agentapi send-message` / `get-conversation-metadata`)
 *        reads `ANTIGRAVITY_LS_ADDRESS` and `ANTIGRAVITY_CSRF_TOKEN` ONLY from its own child process
 *        environment (verified on Antigravity 1.5.11: no flags, stdin, or credentials-file option).
 *        ONLY the pinned, short-lived `antigravity` child receives canonical `ANTIGRAVITY_LS_ADDRESS`
 *        and `ANTIGRAVITY_CSRF_TOKEN` in an otherwise stripped minimal env for that single short call.
 *      - NEVER read or set those credentials in `cswarm`'s own process env or any long-lived process;
 *        `cswarm receive register-agy` accepts ONLY an owned 0600 file (`--credentials-file`) or stdin;
 *        never print `ls_address`, `csrf_token`, or raw subprocess output (fixed diagnostics only).
 *      - Executable trust (Option B + shipped approved build digest allowlist):
 *        Every candidate executable's SHA-256 digest MUST appear in `APPROVED_AGY_BINARY_DIGESTS`
 *        BEFORE any token-bearing child is launched or the Homebrew ancestor exception can apply,
 *        AND on dispatch must also match the registered `agentapi_exe_sha256`. Leaf binary must be
 *        owned by root or current UID, strictly non-group/world-writable (`0o022`), free of macOS
 *        ACLs, and pass strict Apple `codesign` for Google LLC (`TeamIdentifier=EQHXZ8M8AV`,
 *        `Identifier=cli`) on macOS. All ancestor directories up to `/` reject world-write,
 *        group-write (`0o022`), and macOS ACLs, EXCEPT macOS Homebrew ancestors with gid `0` (wheel)
 *        or `80` (admin) ONLY when the leaf passes strict Google LLC `codesign` AND the approved
 *        SHA-256 digest allowlist. Unknown/upgraded digests fail closed with `agy_executable_pin_mismatch`.
 *   2. C2 — Irreducible loopback TCP TOCTOU residual risk (accepted behind experimental flag):
 *      - Antigravity's local language server listens only on plain loopback TCP (no Unix domain socket,
 *        no `SO_PEERCRED`, no mTLS), and `antigravity agentapi` opens a new HTTP/2 gRPC TCP connection
 *        per invocation (empirically verified to reject HTTP 302 redirects off loopback).
 *      - Mandatory mitigations enforced here:
 *        (a) Registration listener lookup runs inside the shared `receive-<scope>` lock, and post-probe
 *            listener re-verification ALWAYS runs even when `get-conversation-metadata` fails.
 *        (b) Dispatch re-verifies the exact listener `(canonical_address, pid, uid, start_time, exe,
 *            sha256)` BEFORE `get-conversation-metadata`, AFTER `get-conversation-metadata` (before
 *            `send-message`), AND AFTER `send-message` (even on error).
 *        (c) On any detected change, route retirement persists `wake_unavailable_reason` to the receive
 *            binding FIRST, then deletes the 0600 registration file, surfacing any cleanup or persistence
 *            failure without swallowing it. `receive configure` in wake mode never clears a retired route;
 *            only a verified `register-agy` (or opt-out to `--mode turn`) clears it.
 *   3. C3 — Common absolute deadline across the full lock hold:
 *      - A single absolute deadline (`AGY_DISPATCH_TOTAL_BUDGET_MS = 8_000`, inside opt-out's 20s lock
 *        wait) governs BOTH registration and dispatch across ALL verification subprocesses (`ls`,
 *        `codesign`, `lsof`, `ps`), vendor child calls, reserved postchecks, and child termination.
 *        Every subprocess runs via `spawn` with `SIGTERM -> SIGKILL` escalation and awaits `"close"`
 *        before settling and releasing the shared `receive-<scope>` lock.
 */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import { lstat, open, readdir, readFile, readlink, realpath, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createWakeSubscriber, type WakeHandle } from "../listener/wake.js";
import { assertProfileIdentity } from "./agent-check.js";
import { boundProfileCommands } from "./agent-onboarding-contract.js";
import {
  AgentSetupError,
  ONBOARDING_UUID,
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
  receiveBindingPath,
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
  deleteSecureJsonFile,
  FileLockTimeoutError,
  readSecureJsonFileIfPresent,
  withFileLock,
  writeSecureJsonFile,
} from "./storage.js";

const AGY_WAKE_HEARTBEAT_MS = 5_000;
const AGY_WAKE_POLL_MS = 30_000;
/** Single absolute lock-hold budget across all verifications, vendor calls, postchecks, and child close. */
const AGY_DISPATCH_TOTAL_BUDGET_MS = 8_000;
/** Portion of AGY_DISPATCH_TOTAL_BUDGET_MS reserved inside the absolute deadline for postchecks. */
const AGY_POSTCHECK_RESERVE_MS = 1_500;
const AGY_CHILD_KILL_GRACE_MS = 400;
const AGY_REGISTRATION_MAX_BYTES = 16 * 1024;
const AGY_LS_ADDRESS_MAX_CHARS = 256;
const AGY_CSRF_TOKEN_MAX_CHARS = 512;
const AGY_EXECUTABLE_MAX_CHARS = 1024;
const AGY_CONTROL_OR_SPACE_RE = /[\x00-\x20\x7f]/;
const AGY_CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;
const AGY_EXECUTABLE_BASENAME_RE = /^(agy|antigravity)(\.exe)?$/i;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const CANONICAL_LOOPBACK_ADDR_RE = /^(127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})$/;
const LOOPBACK_INPUT_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const MACOS_HOMEBREW_ADMIN_GIDS = new Set([0, 80]);
const GOOGLE_DEVELOPER_TEAM_ID = "EQHXZ8M8AV";
const GOOGLE_DEVELOPER_AUTHORITY = `Developer ID Application: Google LLC (${GOOGLE_DEVELOPER_TEAM_ID})`;
const AGY_UNREACHABLE_RE =
  /econnrefused|connection refused|connect error|failed to connect|dial tcp|401|403|unauthorized|unauthenticated|forbidden|csrf|unavailable|connection reset|socket hang up|etimedout|eof/i;

/**
 * Shipped allowlist of approved Antigravity CLI binary SHA-256 digests (versioned per vendor release).
 * First registration, re-registration after an upgrade, and dispatch MUST match an entry here before
 * any token-bearing child is launched or the macOS Homebrew ancestor exception can apply.
 */
export const APPROVED_AGY_BINARY_DIGESTS: Readonly<
  Record<string, { version: string; platform: string }>
> = Object.freeze({
  "3f669d53b6a9807b161c327bf6ce33cdd24ecbf3026edcbb7347c004d1a2d9f2": {
    version: "1.5.11,6132547114106880",
    platform: "darwin-arm64",
  },
});

const DEFAULT_APPROVED_DIGEST_SET: ReadonlySet<string> = new Set(
  Object.keys(APPROVED_AGY_BINARY_DIGESTS),
);

export interface AgyRegistrationRecord {
  version: 1;
  profile: string;
  host_session_id: string;
  /** Canonical loopback IP literal only: `127.0.0.1:<port>` or `[::1]:<port>`. */
  ls_address: string;
  ls_pid: number;
  ls_uid: number;
  ls_start_time: string;
  agentapi_exe: string;
  agentapi_exe_sha256: string;
  csrf_token: string;
  registered_at: string;
}

export interface AgyLoopbackEndpoint {
  /** Strictly `127.0.0.1:<port>` or `[::1]:<port>`. */
  canonical_address: string;
  pid: number;
  uid: number;
  start_time: string;
  executable: string;
}

export interface AgyCredentialsPayload {
  ls_address: string;
  csrf_token: string;
  agentapi_exe?: string;
}

export interface AgyVendorVerificationResult {
  ok: boolean;
  /** True only when verified as Apple-notarized Google LLC (`EQHXZ8M8AV`). */
  googleSigned: boolean;
}

export type AgyVendorVerifier = (
  resolvedExecutablePath: string,
  options?: { deadlineMs?: number; timeoutMs?: number; signal?: AbortSignal },
) => Promise<AgyVendorVerificationResult>;

export type AgyEndpointInspector = (input: {
  host: "127.0.0.1" | "::1" | "localhost";
  port: number;
  deadlineMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}) => Promise<AgyLoopbackEndpoint | null>;

function remainingFromDeadline(deadlineMs?: number, fallbackMs = AGY_DISPATCH_TOTAL_BUDGET_MS): number {
  if (deadlineMs === undefined) return fallbackMs;
  return deadlineMs - Date.now();
}

function splitTotalBudget(totalTimeoutMs: number): {
  totalDeadlineMs: number;
  mainDeadlineMs: number;
} {
  const now = Date.now();
  const safeTotal = Math.max(100, totalTimeoutMs);
  const reserve = Math.min(AGY_POSTCHECK_RESERVE_MS, Math.max(50, Math.floor(safeTotal * 0.25)));
  return {
    totalDeadlineMs: now + safeTotal,
    mainDeadlineMs: now + Math.max(50, safeTotal - reserve),
  };
}

/**
 * Parse a registration-time loopback address input (`127.0.0.1:<port>`, `[::1]:<port>`,
 * `localhost:<port>`, or `http://` of those). Rejects non-loopback hosts, `https://`,
 * paths, credentials, queries, fragments, control chars, and invalid ports.
 */
export function parseAgyInputAddress(raw: unknown): {
  host: "127.0.0.1" | "::1" | "localhost";
  port: number;
} {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > AGY_LS_ADDRESS_MAX_CHARS) {
    throw new AgentSetupError(
      "agy_ls_address_invalid",
      "Antigravity language-server address must be a local loopback host and TCP port.",
    );
  }
  if (AGY_CONTROL_OR_SPACE_RE.test(raw) || /[@?#]/.test(raw)) {
    throw new AgentSetupError(
      "agy_ls_address_invalid",
      "Antigravity language-server address must not contain whitespace, control characters, credentials, query, or fragment.",
    );
  }
  const hasScheme = raw.includes("://");
  let parsed: URL;
  try {
    parsed = new URL(hasScheme ? raw : `http://${raw}`);
  } catch {
    throw new AgentSetupError(
      "agy_ls_address_invalid",
      "Antigravity language-server address must be a valid local loopback host:port.",
    );
  }
  if (parsed.protocol !== "http:") {
    throw new AgentSetupError(
      "agy_ls_address_invalid",
      "Antigravity language-server address must be bare host:port or http:// loopback only.",
    );
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new AgentSetupError(
      "agy_ls_address_invalid",
      "Antigravity language-server address must not include credentials, query, or fragment.",
    );
  }
  if (parsed.pathname !== "" && parsed.pathname !== "/") {
    throw new AgentSetupError(
      "agy_ls_address_invalid",
      "Antigravity language-server address must not include a path.",
    );
  }
  if (!hasScheme && raw.endsWith("/")) {
    throw new AgentSetupError(
      "agy_ls_address_invalid",
      "Antigravity language-server address must not include a trailing slash.",
    );
  }
  const hostRaw = parsed.hostname.toLowerCase();
  if (!LOOPBACK_INPUT_HOSTS.has(hostRaw)) {
    throw new AgentSetupError(
      "agy_ls_address_invalid",
      "Antigravity language-server address must target local loopback only (127.0.0.1, [::1], or localhost).",
    );
  }
  if (!/^[0-9]{1,5}$/.test(parsed.port)) {
    throw new AgentSetupError(
      "agy_ls_address_invalid",
      "Antigravity language-server address must include an explicit TCP port (1-65535).",
    );
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new AgentSetupError(
      "agy_ls_address_invalid",
      "Antigravity language-server address port must be between 1 and 65535.",
    );
  }
  const normalizedHost: "127.0.0.1" | "::1" | "localhost" =
    hostRaw === "[::1]" || hostRaw === "::1"
      ? "::1"
      : hostRaw === "127.0.0.1"
        ? "127.0.0.1"
        : "localhost";
  return { host: normalizedHost, port };
}

/**
 * Validate a persisted/canonical loopback IP literal (`127.0.0.1:<port>` or `[::1]:<port>`).
 * Hostnames such as `localhost` and URL schemes are strictly refused here so the child never
 * performs independent DNS/host resolution.
 */
export function validateCanonicalAgyLsAddress(raw: unknown): {
  canonical: string;
  host: "127.0.0.1" | "::1";
  port: number;
} {
  if (typeof raw !== "string" || !CANONICAL_LOOPBACK_ADDR_RE.test(raw)) {
    throw new AgentSetupError(
      "agy_ls_address_invalid",
      "Antigravity registration requires a canonical loopback IP literal (127.0.0.1:<port> or [::1]:<port>).",
    );
  }
  const match = CANONICAL_LOOPBACK_ADDR_RE.exec(raw)!;
  const hostLiteral = match[1]!;
  const port = Number.parseInt(match[2]!, 10);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new AgentSetupError(
      "agy_ls_address_invalid",
      "Antigravity language-server port must be between 1 and 65535.",
    );
  }
  return {
    canonical: `${hostLiteral}:${port}`,
    host: hostLiteral === "[::1]" ? "::1" : "127.0.0.1",
    port,
  };
}

/** Validate CSRF token without ever echoing its value in error text. */
export function validateAgyCsrfToken(raw: unknown): string {
  if (
    typeof raw !== "string" ||
    raw.length === 0 ||
    raw.length > AGY_CSRF_TOKEN_MAX_CHARS ||
    AGY_CONTROL_OR_SPACE_RE.test(raw)
  ) {
    throw new AgentSetupError(
      "agy_csrf_token_invalid",
      "Antigravity CSRF token must be a non-empty single-line token without whitespace or control characters.",
    );
  }
  return raw;
}

function validateAgyExecutablePathShape(raw: unknown): string {
  if (
    typeof raw !== "string" ||
    raw.length === 0 ||
    raw.length > AGY_EXECUTABLE_MAX_CHARS ||
    AGY_CONTROL_CHAR_RE.test(raw) ||
    !isAbsolute(raw) ||
    !AGY_EXECUTABLE_BASENAME_RE.test(basename(raw))
  ) {
    throw new AgentSetupError(
      "agy_executable_invalid",
      "Antigravity executable must be an absolute path to a trusted agy or antigravity binary.",
    );
  }
  return raw;
}

function isTrustedOwnerUid(uid: number): boolean {
  if (typeof process.getuid !== "function") return true;
  const selfUid = process.getuid();
  return uid === 0 || uid === selfUid;
}

function isHomebrewAncestorPath(dirPath: string): boolean {
  return (
    dirPath === "/opt/homebrew" ||
    dirPath.startsWith("/opt/homebrew/") ||
    dirPath === "/usr/local/Caskroom" ||
    dirPath.startsWith("/usr/local/Caskroom/")
  );
}

/** Compute lowercase 64-hex SHA-256 digest of a file on disk. */
export async function sha256File(filePath: string): Promise<string> {
  return new Promise<string>((resolveHash, rejectHash) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", rejectHash);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

export type AgyAgentApiRunner = (
  executable: string,
  args: readonly string[],
  options: {
    cwd: string;
    timeoutMs: number;
    env: NodeJS.ProcessEnv;
    signal?: AbortSignal;
  },
) => Promise<{ stdout: string; stderr: string }>;

/**
 * Bounded `spawn`-based runner (C3): enforces `timeoutMs` and `options.signal`, escalates
 * `SIGTERM` -> `SIGKILL` after grace, and ALWAYS awaits the child `"close"` event before settling
 * so no timed-out verification or vendor child can survive past release of the `receive-<scope>` lock.
 */
export const defaultAgyAgentApiRunner: AgyAgentApiRunner = (executable, args, options) =>
  new Promise((resolveRun, rejectRun) => {
    const maxBytes = 64 * 1024;
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

    if (options.timeoutMs <= 0) {
      rejectRun(Object.assign(new Error("agy_child_timeout"), { code: "ETIMEDOUT", stdout: "", stderr: "" }));
      return;
    }

    let child;
    try {
      child = spawn(executable, [...args], {
        cwd: options.cwd,
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      rejectRun(error);
      return;
    }

    const terminateChild = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        child.kill("SIGTERM");
      } catch { /* already gone */ }
      if (!killTimer) {
        killTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            try {
              child.kill("SIGKILL");
            } catch { /* already gone */ }
          }
        }, AGY_CHILD_KILL_GRACE_MS);
        killTimer.unref?.();
      }
    };

    const onAbort = () => {
      aborted = true;
      terminateChild();
    };
    if (options.signal) {
      if (options.signal.aborted) {
        aborted = true;
        terminateChild();
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminateChild();
    }, options.timeoutMs);

    const cleanupTimers = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (options.signal) options.signal.removeEventListener("abort", onAbort);
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdoutBytes < maxBytes) {
        const take = chunk.subarray(0, maxBytes - stdoutBytes);
        stdoutChunks.push(take);
        stdoutBytes += take.length;
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrBytes < maxBytes) {
        const take = chunk.subarray(0, maxBytes - stderrBytes);
        stderrChunks.push(take);
        stderrBytes += take.length;
      }
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      rejectRun(error);
    });

    child.on("close", (code, sig) => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (timedOut) {
        const err = Object.assign(new Error("agy_child_timeout"), {
          code: "ETIMEDOUT",
          stdout,
          stderr,
        });
        rejectRun(err);
        return;
      }
      if (aborted) {
        const err = Object.assign(new Error("agy_child_aborted"), {
          code: "ABORT_ERR",
          stdout,
          stderr,
        });
        rejectRun(err);
        return;
      }
      if (code !== 0) {
        const err = Object.assign(new Error(`agy_child_exit_${code ?? sig ?? "unknown"}`), {
          code: code ?? sig ?? "ERR",
          stdout,
          stderr,
        });
        rejectRun(err);
        return;
      }
      resolveRun({ stdout, stderr });
    });
  });

/**
 * Inspect macOS extended ACLs via `/bin/ls -led` (absolute path, stripped env)
 * sharing the caller's absolute `deadlineMs` (C3).
 */
async function hasMacOsAcl(
  targetPath: string,
  deadlineMs?: number,
  signal?: AbortSignal,
): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  const rem = remainingFromDeadline(deadlineMs);
  if (rem <= 0) {
    throw new AgentSetupError("agy_dispatch_timeout", "Antigravity verification exceeded its bounded budget.");
  }
  try {
    const res = await defaultAgyAgentApiRunner("/bin/ls", ["-led", targetPath], {
      cwd: "/",
      env: {},
      timeoutMs: rem,
      ...(signal ? { signal } : {}),
    });
    const lines = res.stdout
      .split(/\r?\n/)
      .filter((line) => line.length > 0);
    if (lines.length === 0) return true;
    const modeToken = lines[0]!.trim().split(/\s+/)[0] ?? "";
    if (modeToken.includes("+") || lines.length > 1) return true;
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ETIMEDOUT") {
      throw new AgentSetupError("agy_dispatch_timeout", "Antigravity verification exceeded its bounded budget.");
    }
    return true;
  }
}

/**
 * Default vendor build verification on macOS using `/usr/bin/codesign` (absolute path, stripped env)
 * sharing the caller's absolute `deadlineMs` across both `--verify` and `-dvv` subprocesses (C3).
 */
export const defaultAgyVendorVerifier: AgyVendorVerifier = async (resolvedPath, options) => {
  if (process.platform !== "darwin") {
    return { ok: false, googleSigned: false };
  }
  const deadlineMs =
    options?.deadlineMs ??
    (options?.timeoutMs !== undefined ? Date.now() + options.timeoutMs : Date.now() + AGY_DISPATCH_TOTAL_BUDGET_MS);

  const rem1 = remainingFromDeadline(deadlineMs);
  if (rem1 <= 0) {
    throw new AgentSetupError("agy_dispatch_timeout", "Antigravity signature verification exceeded its bounded budget.");
  }
  try {
    await defaultAgyAgentApiRunner("/usr/bin/codesign", ["--verify", "--strict", resolvedPath], {
      cwd: "/",
      env: {},
      timeoutMs: rem1,
      ...(options?.signal ? { signal: options.signal } : {}),
    });
    const rem2 = remainingFromDeadline(deadlineMs);
    if (rem2 <= 0) {
      throw new AgentSetupError("agy_dispatch_timeout", "Antigravity signature verification exceeded its bounded budget.");
    }
    const detail = await defaultAgyAgentApiRunner("/usr/bin/codesign", ["-dvv", resolvedPath], {
      cwd: "/",
      env: {},
      timeoutMs: rem2,
      ...(options?.signal ? { signal: options.signal } : {}),
    });
    const combined = `${detail.stdout}\n${detail.stderr}`;
    const hasAuthority = combined.includes(`Authority=${GOOGLE_DEVELOPER_AUTHORITY}`);
    const hasTeam = combined.includes(`TeamIdentifier=${GOOGLE_DEVELOPER_TEAM_ID}`);
    const hasIdentifier = combined.includes("Identifier=cli");
    return { ok: hasAuthority && hasTeam && hasIdentifier, googleSigned: hasAuthority && hasTeam && hasIdentifier };
  } catch (error) {
    if (error instanceof AgentSetupError) throw error;
    if ((error as NodeJS.ErrnoException)?.code === "ETIMEDOUT") {
      throw new AgentSetupError("agy_dispatch_timeout", "Antigravity signature verification exceeded its bounded budget.");
    }
    return { ok: false, googleSigned: false };
  }
};

/**
 * Pin and verify a trusted Antigravity executable (C1 + HezLead Option B + C3 common deadline):
 * - Canonicalized via `realpath` (never resolved through `PATH`).
 * - Leaf binary: regular non-symlink executable owned by root or current UID, strictly NO group-write
 *   or world-write (`(mode & 0o022) === 0`), NO macOS ACLs.
 * - Approved build digest check: SHA-256 MUST match `approvedDigests` (defaults to the shipped
 *   `APPROVED_AGY_BINARY_DIGESTS` allowlist) AND `expectedSha256` (if supplied) BEFORE any token-bearing
 *   child is launched or the Homebrew ancestor exception can apply.
 * - Vendor signature check: strict Google LLC codesign (`EQHXZ8M8AV`) on macOS (or injectable verifier).
 * - Full ancestor directory walk up to `/`: owned by root or current UID, NO macOS ACLs, NEVER
 *   world-writable (`0o002`), and NEVER group-writable (`0o020`) EXCEPT macOS Homebrew ancestors
 *   with gid 0 (wheel) or 80 (admin) ONLY when the leaf passes BOTH strict Google LLC codesign AND
 *   the approved SHA-256 digest allowlist.
 */
export async function validateAgyAgentApiExecutable(
  raw: unknown,
  options?: {
    expectedSha256?: string;
    approvedDigests?: ReadonlySet<string>;
    vendorVerifier?: AgyVendorVerifier;
    deadlineMs?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<{ path: string; sha256: string }> {
  const deadlineMs =
    options?.deadlineMs ??
    (options?.timeoutMs !== undefined ? Date.now() + options.timeoutMs : undefined);
  const checkBudget = () => {
    if (deadlineMs !== undefined && deadlineMs - Date.now() <= 0) {
      throw new AgentSetupError("agy_dispatch_timeout", "Antigravity verification exceeded its bounded budget.");
    }
  };

  checkBudget();
  const shaped = validateAgyExecutablePathShape(raw);
  let resolved: string;
  try {
    resolved = await realpath(shaped);
  } catch {
    throw new AgentSetupError(
      "agy_executable_invalid",
      "Antigravity executable does not resolve to an accessible binary.",
    );
  }
  if (!isAbsolute(resolved) || !AGY_EXECUTABLE_BASENAME_RE.test(basename(resolved))) {
    throw new AgentSetupError(
      "agy_executable_invalid",
      "Antigravity executable must resolve to a trusted agy or antigravity binary.",
    );
  }
  let leafInfo;
  try {
    leafInfo = await lstat(resolved);
  } catch {
    throw new AgentSetupError(
      "agy_executable_invalid",
      "Antigravity executable could not be inspected on disk.",
    );
  }
  if (
    !leafInfo.isFile() ||
    leafInfo.isSymbolicLink() ||
    (leafInfo.mode & 0o111) === 0 ||
    (leafInfo.mode & 0o022) !== 0 ||
    !isTrustedOwnerUid(leafInfo.uid)
  ) {
    throw new AgentSetupError(
      "agy_executable_invalid",
      "Antigravity executable must be an owned regular executable file with no group or world write permissions.",
    );
  }

  checkBudget();
  let sha256: string;
  try {
    sha256 = await sha256File(resolved);
  } catch {
    throw new AgentSetupError(
      "agy_executable_invalid",
      "Antigravity executable digest could not be computed.",
    );
  }

  // C1: Require an approved digest from an independent allowlist BEFORE vendor calls or Homebrew exception!
  const approvedSet = options?.approvedDigests ?? DEFAULT_APPROVED_DIGEST_SET;
  if (!approvedSet.has(sha256)) {
    throw new AgentSetupError(
      "agy_executable_pin_mismatch",
      "Pinned Antigravity executable is not in the approved build allowlist. Re-run cswarm receive register-agy with an approved build.",
    );
  }
  if (options?.expectedSha256 !== undefined && sha256 !== options.expectedSha256) {
    throw new AgentSetupError(
      "agy_executable_pin_mismatch",
      "Pinned Antigravity executable changed or updated. Re-run cswarm receive register-agy.",
    );
  }

  if (await hasMacOsAcl(resolved, deadlineMs, options?.signal)) {
    throw new AgentSetupError(
      "agy_executable_invalid",
      "Antigravity executable must not have extended ACL permissions.",
    );
  }

  checkBudget();
  const verifier = options?.vendorVerifier ?? defaultAgyVendorVerifier;
  const vendorCheck = await verifier(resolved, {
    ...(deadlineMs !== undefined ? { deadlineMs, timeoutMs: Math.max(1, deadlineMs - Date.now()) } : {}),
    ...(options?.signal ? { signal: options.signal } : {}),
  });
  if (!vendorCheck.ok) {
    throw new AgentSetupError(
      "agy_executable_unapproved",
      "Antigravity executable did not pass approved vendor build verification.",
    );
  }

  let cursor = dirname(resolved);
  for (;;) {
    checkBudget();
    let dirInfo;
    try {
      dirInfo = await lstat(cursor);
    } catch {
      throw new AgentSetupError(
        "agy_executable_invalid",
        "Antigravity executable ancestor directory could not be verified.",
      );
    }
    if (!dirInfo.isDirectory() || (dirInfo.mode & 0o002) !== 0 || !isTrustedOwnerUid(dirInfo.uid)) {
      throw new AgentSetupError(
        "agy_executable_invalid",
        "Antigravity executable ancestor directories must be owned by root or the current user and never world-writable.",
      );
    }
    if ((dirInfo.mode & 0o020) !== 0) {
      // HezLead Option B: allow root/admin group (gid 0 or 80) on macOS Homebrew ancestors ONLY when
      // the leaf binary passed BOTH strict Google LLC codesign AND the approved SHA-256 allowlist.
      const allowedHomebrewAdmin =
        process.platform === "darwin" &&
        vendorCheck.googleSigned &&
        approvedSet.has(sha256) &&
        isHomebrewAncestorPath(cursor) &&
        MACOS_HOMEBREW_ADMIN_GIDS.has(dirInfo.gid);
      if (!allowedHomebrewAdmin) {
        throw new AgentSetupError(
          "agy_executable_invalid",
          "Antigravity executable ancestor directories must not be group-writable.",
        );
      }
    }
    if (await hasMacOsAcl(cursor, deadlineMs, options?.signal)) {
      throw new AgentSetupError(
        "agy_executable_invalid",
        "Antigravity executable ancestor directories must not have extended ACL permissions.",
      );
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return { path: resolved, sha256 };
}

/**
 * Parse registration credentials payload supplied over a 0600 file or stdin.
 * Never echoes any input values in error messages.
 */
export function parseAgyCredentialsPayload(raw: string): AgyCredentialsPayload {
  if (Buffer.byteLength(raw, "utf8") > AGY_REGISTRATION_MAX_BYTES) {
    throw new AgentSetupError(
      "agy_credentials_invalid",
      "Antigravity registration input exceeds the maximum allowed size.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AgentSetupError(
      "agy_credentials_invalid",
      "Antigravity registration input must be a valid JSON object containing ls_address and csrf_token.",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AgentSetupError(
      "agy_credentials_invalid",
      "Antigravity registration input must be a JSON object.",
    );
  }
  const obj = parsed as Record<string, unknown>;
  const allowedKeys = new Set(["ls_address", "csrf_token", "agentapi_exe"]);
  for (const key of Object.keys(obj)) {
    if (!allowedKeys.has(key)) {
      throw new AgentSetupError(
        "agy_credentials_invalid",
        "Antigravity registration input contains an unsupported field.",
      );
    }
  }
  parseAgyInputAddress(obj.ls_address);
  const csrfToken = validateAgyCsrfToken(obj.csrf_token);
  const agentapiExe =
    obj.agentapi_exe === undefined
      ? undefined
      : validateAgyExecutablePathShape(obj.agentapi_exe);
  return {
    ls_address: obj.ls_address as string,
    csrf_token: csrfToken,
    ...(agentapiExe !== undefined ? { agentapi_exe: agentapiExe } : {}),
  };
}

/** Read registration credentials from an owned 0600 regular file (no symlinks via O_NOFOLLOW). */
export async function readAgyCredentialsFromFile(filePath: string): Promise<AgyCredentialsPayload> {
  if (
    typeof filePath !== "string" ||
    filePath.length === 0 ||
    AGY_CONTROL_CHAR_RE.test(filePath) ||
    !isAbsolute(filePath)
  ) {
    throw new AgentSetupError(
      "agy_credentials_file_unsafe",
      "--credentials-file must be an absolute path to a private 0600 regular file.",
    );
  }
  const openFlags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  let handle;
  try {
    handle = await open(filePath, openFlags);
  } catch {
    throw new AgentSetupError(
      "agy_credentials_file_unsafe",
      "Could not open --credentials-file as a non-symlink regular file.",
    );
  }
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      (typeof process.getuid === "function" && info.uid !== process.getuid()) ||
      (info.mode & 0o077) !== 0 ||
      info.size > AGY_REGISTRATION_MAX_BYTES
    ) {
      throw new AgentSetupError(
        "agy_credentials_file_unsafe",
        "--credentials-file must be an owned regular file with 0600 permissions.",
      );
    }
    const raw = await handle.readFile({ encoding: "utf8" });
    return parseAgyCredentialsPayload(raw);
  } finally {
    await handle.close();
  }
}

/** Read registration credentials from a bounded stdin stream (max 16 KB). */
export async function readAgyCredentialsFromStdin(
  stream: NodeJS.ReadableStream = process.stdin,
): Promise<AgyCredentialsPayload> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
    total += buf.length;
    if (total > AGY_REGISTRATION_MAX_BYTES) {
      throw new AgentSetupError(
        "agy_credentials_invalid",
        "Antigravity registration input from stdin exceeds the maximum allowed size.",
      );
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    throw new AgentSetupError(
      "agy_credentials_input_required",
      "Supply Antigravity registration JSON via --credentials-file <0600-path> or piped stdin.",
    );
  }
  return parseAgyCredentialsPayload(raw);
}

/**
 * Minimal stripped child environment for the pinned short-lived `antigravity agentapi` call.
 * Strips ALL ambient process variables, credentials, PATH, and proxy configuration.
 * Only canonical loopback `ANTIGRAVITY_LS_ADDRESS` and `ANTIGRAVITY_CSRF_TOKEN` are supplied
 * under HezLead's #716 C1 narrow scope decision.
 */
export function buildMinimalAgyChildEnv(
  canonicalLsAddress: string,
  csrfToken: string,
): NodeJS.ProcessEnv {
  const checked = validateCanonicalAgyLsAddress(canonicalLsAddress);
  const token = validateAgyCsrfToken(csrfToken);
  let homeDir: string | undefined;
  try {
    homeDir = homedir();
  } catch {
    homeDir = undefined;
  }
  let tempDir: string | undefined;
  try {
    tempDir = tmpdir();
  } catch {
    tempDir = undefined;
  }
  return {
    ...(homeDir ? { HOME: homeDir } : {}),
    ...(tempDir ? { TMPDIR: tempDir } : {}),
    NO_PROXY: "*",
    no_proxy: "*",
    HTTP_PROXY: "",
    HTTPS_PROXY: "",
    ALL_PROXY: "",
    http_proxy: "",
    https_proxy: "",
    all_proxy: "",
    CMUX_ANTIGRAVITY_HOOKS_DISABLED: "1",
    ANTIGRAVITY_LS_ADDRESS: checked.canonical,
    ANTIGRAVITY_CSRF_TOKEN: token,
  };
}

/**
 * Inspect the live loopback-only TCP listener on macOS using absolute `/usr/sbin/lsof` + `/bin/ps`
 * via the bounded spawn runner, sharing the caller's single absolute `deadlineMs` (C3).
 */
async function inspectMacOsLoopbackListener(input: {
  host: "127.0.0.1" | "::1" | "localhost";
  port: number;
  deadlineMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<AgyLoopbackEndpoint | null> {
  const deadlineMs =
    input.deadlineMs ??
    (input.timeoutMs !== undefined ? Date.now() + input.timeoutMs : Date.now() + AGY_DISPATCH_TOTAL_BUDGET_MS);

  const rem1 = remainingFromDeadline(deadlineMs);
  if (rem1 <= 0) {
    throw new AgentSetupError("agy_dispatch_timeout", "Antigravity listener inspection exceeded its bounded budget.");
  }
  let lsofStdout: string;
  try {
    const res = await defaultAgyAgentApiRunner(
      "/usr/sbin/lsof",
      ["-nP", `-iTCP:${input.port}`, "-sTCP:LISTEN", "-F", "pun"],
      {
        cwd: "/",
        env: {},
        timeoutMs: rem1,
        ...(input.signal ? { signal: input.signal } : {}),
      },
    );
    lsofStdout = res.stdout;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ETIMEDOUT") {
      throw new AgentSetupError("agy_dispatch_timeout", "Antigravity listener inspection exceeded its bounded budget.");
    }
    return null;
  }

  const wantedNames = new Set<string>();
  if (input.host === "127.0.0.1" || input.host === "localhost") {
    wantedNames.add(`127.0.0.1:${input.port}`);
  }
  if (input.host === "::1" || input.host === "localhost") {
    wantedNames.add(`[::1]:${input.port}`);
  }

  let currentPid: number | null = null;
  let currentUid: number | null = null;
  const matches = new Map<number, { pid: number; uid: number; canonical: string }>();

  for (const rawLine of lsofStdout.split(/\r?\n/)) {
    if (!rawLine) continue;
    const tag = rawLine[0];
    const value = rawLine.slice(1);
    if (tag === "p") {
      const pid = Number.parseInt(value, 10);
      currentPid = Number.isSafeInteger(pid) && pid > 0 ? pid : null;
      currentUid = null;
    } else if (tag === "u") {
      const uid = Number.parseInt(value, 10);
      currentUid = Number.isSafeInteger(uid) && uid >= 0 ? uid : null;
    } else if (tag === "n" && currentPid !== null && currentUid !== null) {
      if (wantedNames.has(value)) {
        const existing = matches.get(currentPid);
        if (!existing || value.startsWith("127.0.0.1:")) {
          matches.set(currentPid, { pid: currentPid, uid: currentUid, canonical: value });
        }
      }
    }
  }

  if (matches.size !== 1) return null;
  const [match] = matches.values();
  if (!match) return null;
  if (typeof process.getuid === "function" && match.uid !== process.getuid()) return null;

  const rem2 = remainingFromDeadline(deadlineMs);
  if (rem2 <= 0) {
    throw new AgentSetupError("agy_dispatch_timeout", "Antigravity listener inspection exceeded its bounded budget.");
  }
  let psStdout: string;
  try {
    const res = await defaultAgyAgentApiRunner(
      "/bin/ps",
      ["-ww", "-p", String(match.pid), "-o", "uid=,lstart=,comm="],
      {
        cwd: "/",
        env: {},
        timeoutMs: rem2,
        ...(input.signal ? { signal: input.signal } : {}),
      },
    );
    psStdout = res.stdout.trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ETIMEDOUT") {
      throw new AgentSetupError("agy_dispatch_timeout", "Antigravity listener inspection exceeded its bounded budget.");
    }
    return null;
  }
  const psMatch = /^(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/.exec(
    psStdout,
  );
  if (!psMatch) return null;
  const psUid = Number.parseInt(psMatch[1]!, 10);
  const startTime = psMatch[2]!.trim();
  const commPath = psMatch[3]!.trim();
  if (psUid !== match.uid) return null;
  if (typeof process.getuid === "function" && psUid !== process.getuid()) return null;

  let resolvedExe: string;
  try {
    resolvedExe = await realpath(validateAgyExecutablePathShape(commPath));
  } catch {
    return null;
  }
  return {
    canonical_address: match.canonical,
    pid: match.pid,
    uid: psUid,
    start_time: startTime,
    executable: resolvedExe,
  };
}

/**
 * Inspect the live loopback-only TCP listener on Linux via `/proc/net/tcp{,6}` and `/proc/<pid>`.
 * Zero external subprocesses, zero PATH lookup, refuses wildcard listeners and untrusted binaries.
 */
async function inspectLinuxLoopbackListener(input: {
  host: "127.0.0.1" | "::1" | "localhost";
  port: number;
  deadlineMs?: number;
}): Promise<AgyLoopbackEndpoint | null> {
  if (input.deadlineMs !== undefined && input.deadlineMs - Date.now() <= 0) {
    throw new AgentSetupError("agy_dispatch_timeout", "Antigravity listener inspection exceeded its bounded budget.");
  }
  const portHex = input.port.toString(16).toUpperCase().padStart(4, "0");
  const candidates: Array<{ inode: string; canonical: string }> = [];

  if (input.host === "127.0.0.1" || input.host === "localhost") {
    const raw4 = await readFile("/proc/net/tcp", "utf8").catch(() => "");
    for (const line of raw4.split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 10) continue;
      if (cols[1] === `0100007F:${portHex}` && cols[3] === "0A" && cols[9]) {
        candidates.push({ inode: cols[9]!, canonical: `127.0.0.1:${input.port}` });
      }
    }
  }
  if (input.host === "::1" || input.host === "localhost") {
    const raw6 = await readFile("/proc/net/tcp6", "utf8").catch(() => "");
    for (const line of raw6.split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 10) continue;
      if (
        cols[1] === `00000000000000000000000001000000:${portHex}` &&
        cols[3] === "0A" &&
        cols[9]
      ) {
        candidates.push({ inode: cols[9]!, canonical: `[::1]:${input.port}` });
      }
    }
  }
  if (candidates.length === 0) return null;
  const wantedInodes = new Map(candidates.map((c) => [`socket:[${c.inode}]`, c.canonical]));
  const selfUid = typeof process.getuid === "function" ? process.getuid() : null;

  const procEntries = await readdir("/proc").catch(() => [] as string[]);
  const matchedPids = new Map<number, string>();
  for (const entry of procEntries) {
    if (input.deadlineMs !== undefined && input.deadlineMs - Date.now() <= 0) {
      throw new AgentSetupError("agy_dispatch_timeout", "Antigravity listener inspection exceeded its bounded budget.");
    }
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number.parseInt(entry, 10);
    const procStat = await stat(`/proc/${entry}`).catch(() => null);
    if (!procStat || (selfUid !== null && procStat.uid !== selfUid)) continue;
    const fds = await readdir(`/proc/${entry}/fd`).catch(() => [] as string[]);
    for (const fd of fds) {
      const target = await readlink(`/proc/${entry}/fd/${fd}`).catch(() => "");
      const canonical = wantedInodes.get(target);
      if (canonical) {
        matchedPids.set(pid, canonical);
        break;
      }
    }
  }
  if (matchedPids.size !== 1) return null;
  const [[pid, canonical]] = matchedPids.entries();
  const exeRaw = await readlink(`/proc/${pid}/exe`).catch(() => "");
  const statRaw = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
  const rparen = statRaw.lastIndexOf(")");
  if (rparen === -1) return null;
  const afterComm = statRaw.slice(rparen + 2).trim().split(/\s+/);
  const startTicks = afterComm[19];
  if (!startTicks || !/^\d+$/.test(startTicks)) return null;

  let resolvedExe: string;
  try {
    resolvedExe = await realpath(validateAgyExecutablePathShape(exeRaw));
  } catch {
    return null;
  }
  return {
    canonical_address: canonical,
    pid,
    uid: selfUid ?? 0,
    start_time: startTicks,
    executable: resolvedExe,
  };
}

export const defaultAgyEndpointInspector: AgyEndpointInspector = async (input) => {
  if (process.platform === "darwin") {
    return inspectMacOsLoopbackListener(input);
  }
  if (process.platform === "linux") {
    return inspectLinuxLoopbackListener(input);
  }
  return null;
};

export function agyRegistrationPath(profilePath: string, hostSessionId: string): string {
  const profile = privatePath(profilePath);
  const host = checkedHostSessionId(hostSessionId);
  return join(dirname(profile), `wake-agy-${profileScopeKey(host)}.json`);
}

function parseAgyRegistration(
  raw: string,
  expectedProfile: string,
  expectedHost: string,
): AgyRegistrationRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AgentSetupError(
      "agy_registration_invalid",
      "Antigravity wake registration file is damaged. Re-run cswarm receive register-agy.",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AgentSetupError(
      "agy_registration_invalid",
      "Antigravity wake registration file is invalid. Re-run cswarm receive register-agy.",
    );
  }
  const r = parsed as Record<string, unknown>;
  if (
    r.version !== 1 ||
    r.profile !== expectedProfile ||
    r.host_session_id !== expectedHost ||
    typeof r.host_session_id !== "string" ||
    !ONBOARDING_UUID.test(r.host_session_id) ||
    typeof r.ls_pid !== "number" ||
    !Number.isSafeInteger(r.ls_pid) ||
    r.ls_pid <= 0 ||
    typeof r.ls_uid !== "number" ||
    !Number.isSafeInteger(r.ls_uid) ||
    r.ls_uid < 0 ||
    typeof r.ls_start_time !== "string" ||
    r.ls_start_time.length === 0 ||
    r.ls_start_time.length > 128 ||
    AGY_CONTROL_CHAR_RE.test(r.ls_start_time) ||
    typeof r.agentapi_exe_sha256 !== "string" ||
    !SHA256_HEX_RE.test(r.agentapi_exe_sha256) ||
    typeof r.registered_at !== "string" ||
    !Number.isFinite(Date.parse(r.registered_at))
  ) {
    throw new AgentSetupError(
      "agy_registration_invalid",
      "Antigravity wake registration does not match this profile and conversation. Re-run cswarm receive register-agy.",
    );
  }
  const canonicalAddr = validateCanonicalAgyLsAddress(r.ls_address);
  const csrfToken = validateAgyCsrfToken(r.csrf_token);
  const agentapiExe = validateAgyExecutablePathShape(r.agentapi_exe);
  return {
    version: 1,
    profile: expectedProfile,
    host_session_id: expectedHost,
    ls_address: canonicalAddr.canonical,
    ls_pid: r.ls_pid,
    ls_uid: r.ls_uid,
    ls_start_time: r.ls_start_time,
    agentapi_exe: agentapiExe,
    agentapi_exe_sha256: r.agentapi_exe_sha256,
    csrf_token: csrfToken,
    registered_at: r.registered_at,
  };
}

export async function readAgyRegistration(
  profilePath: string,
  hostSessionId: string,
): Promise<AgyRegistrationRecord | null> {
  const profile = privatePath(profilePath);
  const host = checkedHostSessionId(hostSessionId);
  const raw = await readSecureJsonFileIfPresent(
    agyRegistrationPath(profile, host),
    AGY_REGISTRATION_MAX_BYTES,
  );
  if (raw === null) return null;
  return parseAgyRegistration(raw, profile, host);
}

export async function removeAgyRegistration(
  profilePath: string,
  hostSessionId: string,
): Promise<void> {
  const path = agyRegistrationPath(profilePath, hostSessionId);
  await deleteSecureJsonFile(path);
}

/**
 * C2: Durable route retirement while the caller already holds `receive-<scope>` lock.
 * 1. Persist `wake_unavailable_reason` + `wake_verified_at: null` onto `receive-<scope>.json` FIRST.
 * 2. Delete `wake-agy-<scope>.json` SECOND.
 * Never swallows persistence or cleanup failures — callers surface them explicitly!
 */
async function retireAgyWakeRouteUnlocked(
  profilePath: string,
  hostSessionId: string,
  reason: string,
): Promise<{ retired: boolean; cleanupFailed: boolean; markerFailed: boolean }> {
  let markerFailed = false;
  let retired = false;
  try {
    const current = await readReceiveBinding(profilePath, hostSessionId);
    if (current && current.provider === "agy" && current.requested_mode === "wake") {
      const next = {
        ...current,
        wake_verified_at: null,
        wake_unavailable_reason: reason,
      };
      await writeSecureJsonFile(receiveBindingPath(profilePath, hostSessionId), JSON.stringify(next));
      retired = true;
    }
  } catch {
    markerFailed = true;
  }

  let cleanupFailed = false;
  try {
    await deleteSecureJsonFile(agyRegistrationPath(profilePath, hostSessionId));
  } catch {
    cleanupFailed = true;
  }
  return { retired, cleanupFailed, markerFailed };
}

function pathMatchesWorkspace(bindingCwd: string, workspacePath: string): boolean {
  const normBinding = resolve(bindingCwd);
  const normWorkspace = resolve(workspacePath);
  if (normBinding === normWorkspace) return true;
  const prefix = normWorkspace.endsWith(sep) ? normWorkspace : `${normWorkspace}${sep}`;
  return normBinding.startsWith(prefix);
}

/**
 * Verify provider session evidence via `agentapi get-conversation-metadata <conv-uuid>`:
 * proves the verified loopback language server owns `<conv-uuid>` AND that at least one
 * workspace folder in the conversation's metadata covers `expectedCwd`.
 * Never echoes address, CSRF token, or raw subprocess output in errors.
 */
export async function verifyAgyConversationSession(options: {
  executable: string;
  canonicalLsAddress: string;
  csrfToken: string;
  hostSessionId: string;
  expectedCwd: string;
  runner?: AgyAgentApiRunner;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<{ ok: true } | { ok: false; code: string; detail: string }> {
  const runner = options.runner ?? defaultAgyAgentApiRunner;
  const timeoutMs = options.timeoutMs ?? AGY_DISPATCH_TOTAL_BUDGET_MS;
  if (timeoutMs <= 0) {
    return {
      ok: false,
      code: "agy_dispatch_timeout",
      detail: "Antigravity session verification exceeded its bounded budget.",
    };
  }
  const childEnv = buildMinimalAgyChildEnv(options.canonicalLsAddress, options.csrfToken);
  const argv = ["agentapi", "get-conversation-metadata", options.hostSessionId] as const;

  let stdout: string;
  try {
    const res = await runner(options.executable, argv, {
      cwd: options.expectedCwd,
      timeoutMs,
      env: childEnv,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    stdout = res.stdout;
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
    const combined = `${err.stderr ?? ""} ${err.stdout ?? ""} ${err.message ?? ""}`;
    if (err.code === "ENOENT") {
      return {
        ok: false,
        code: "agy_not_found",
        detail: "Pinned Antigravity CLI executable was not found.",
      };
    }
    if (err.code === "ETIMEDOUT") {
      return {
        ok: false,
        code: "agy_dispatch_timeout",
        detail: "Antigravity session verification timed out within its bounded budget.",
      };
    }
    if (/not_found|notfound|trajectory not found/i.test(combined)) {
      return {
        ok: false,
        code: "agy_session_mismatch",
        detail: "Antigravity language server does not own this bound conversation.",
      };
    }
    if (AGY_UNREACHABLE_RE.test(combined) || err.code === "ECONNREFUSED") {
      return {
        ok: false,
        code: "agy_ls_unreachable",
        detail: "Antigravity language server is unreachable or rejected credentials. Re-run cswarm receive register-agy.",
      };
    }
    return {
      ok: false,
      code: "agy_agentapi_failed",
      detail: "Antigravity session verification failed.",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return {
      ok: false,
      code: "agy_session_mismatch",
      detail: "Antigravity session metadata response was not valid JSON.",
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      code: "agy_session_mismatch",
      detail: "Antigravity session metadata response was invalid.",
    };
  }
  const top = parsed as Record<string, unknown>;
  if (typeof top.error === "string" && top.error.length > 0) {
    if (AGY_UNREACHABLE_RE.test(top.error)) {
      return {
        ok: false,
        code: "agy_ls_unreachable",
        detail: "Antigravity language server rejected credentials. Re-run cswarm receive register-agy.",
      };
    }
    return {
      ok: false,
      code: "agy_session_mismatch",
      detail: "Antigravity language server does not own this bound conversation.",
    };
  }
  const response = top.response as Record<string, unknown> | undefined;
  const convMeta = response?.conversationMetadata as Record<string, unknown> | undefined;
  const metadata = convMeta?.metadata as Record<string, unknown> | undefined;
  const workspaces = metadata?.workspaces;
  if (!Array.isArray(workspaces) || workspaces.length === 0) {
    return {
      ok: false,
      code: "agy_session_mismatch",
      detail: "Antigravity session metadata did not report any workspace folders.",
    };
  }

  const expectedReal = await realpath(options.expectedCwd).catch(() => resolve(options.expectedCwd));
  let workspaceMatched = false;
  for (const ws of workspaces) {
    if (!ws || typeof ws !== "object" || Array.isArray(ws)) continue;
    const uri = (ws as Record<string, unknown>).workspaceFolderAbsoluteUri;
    if (typeof uri !== "string" || !uri.startsWith("file://")) continue;
    let wsFsPath: string;
    try {
      wsFsPath = fileURLToPath(uri);
    } catch {
      continue;
    }
    const wsReal = await realpath(wsFsPath).catch(() => resolve(wsFsPath));
    if (pathMatchesWorkspace(expectedReal, wsReal) || pathMatchesWorkspace(options.expectedCwd, wsFsPath)) {
      workspaceMatched = true;
      break;
    }
  }
  if (!workspaceMatched) {
    return {
      ok: false,
      code: "agy_session_mismatch",
      detail: "Antigravity session workspace does not match this seat's bound directory.",
    };
  }
  return { ok: true };
}

/**
 * Private 0600 registration (`cswarm receive register-agy`).
 * - Accepts credentials ONLY via a 0600 `--credentials-file`, piped stdin, or explicit `credentialsJson`
 *   — NEVER from `cswarm`'s own `process.env` or argv.
 * - Enforces a single common absolute deadline inside the shared `receive-<scope>` lock covering
 *   listener inspection, approved-digest + codesign + ACL verification, `get-conversation-metadata`,
 *   AND mandatory post-probe listener re-verification (even when the metadata probe fails!).
 * - If post-probe verification detects an endpoint change, retires any affected saved registration
 *   (persisting `wake_unavailable_reason` FIRST, then deleting the 0600 file, surfacing any failure).
 * - Clears `wake_unavailable_reason` ONLY after a fully verified registration; never prints address or token.
 */
export async function registerAgyWake(options: {
  profilePath: string;
  hostSessionId: string;
  credentialsFile?: string;
  credentialsJson?: string;
  stdin?: NodeJS.ReadableStream;
  endpointInspector?: AgyEndpointInspector;
  vendorVerifier?: AgyVendorVerifier;
  approvedDigests?: ReadonlySet<string>;
  runner?: AgyAgentApiRunner;
  timeoutMs?: number;
  now?: () => number;
}) {
  const profile = privatePath(options.profilePath);
  const host = checkedHostSessionId(options.hostSessionId);
  // Enforce profile/session binding first so mismatched session IDs return profile_other_session.
  await readAgentProfile(profile, host);
  if (!ONBOARDING_UUID.test(host)) {
    throw new AgentSetupError(
      "agy_conversation_id_required",
      "Antigravity wake registration requires this session's conversation UUID as --host-session-id.",
    );
  }
  if (options.credentialsFile !== undefined && options.credentialsJson !== undefined) {
    throw new AgentSetupError(
      "agy_credentials_input_conflict",
      "Supply either --credentials-file or stdin, not both.",
    );
  }

  let payload: AgyCredentialsPayload;
  if (options.credentialsFile !== undefined) {
    payload = await readAgyCredentialsFromFile(options.credentialsFile);
  } else if (options.credentialsJson !== undefined) {
    payload = parseAgyCredentialsPayload(options.credentialsJson);
  } else if (options.stdin !== undefined) {
    payload = await readAgyCredentialsFromStdin(options.stdin);
  } else {
    throw new AgentSetupError(
      "agy_credentials_input_required",
      "Pass Antigravity credentials via --credentials-file <0600-path> or --stdin (never env or argv).",
    );
  }

  const parsedAddr = parseAgyInputAddress(payload.ls_address);
  const inspector = options.endpointInspector ?? defaultAgyEndpointInspector;
  const nowMs = (options.now ?? Date.now)();
  const nowIso = new Date(nowMs).toISOString();

  return withFileLock(
    dirname(profile),
    `receive-${profileScopeKey(host)}`,
    async () => {
      const { totalDeadlineMs, mainDeadlineMs } = splitTotalBudget(
        options.timeoutMs ?? AGY_DISPATCH_TOTAL_BUDGET_MS,
      );
      const auth = await resolveAuthorizedWakeBinding({
        profilePath: profile,
        hostSessionId: host,
        expectedProvider: "agy",
        allowUnavailableForRegistration: true,
      });
      if (!auth.ok) {
        throw new AgentSetupError(auth.code, auth.detail);
      }

      // C2 & C3: Perform listener lookup INSIDE the shared receive-<scope> lock under common deadline.
      const inspectRem = mainDeadlineMs - Date.now();
      if (inspectRem <= 0) {
        throw new AgentSetupError("agy_dispatch_timeout", "Antigravity registration exceeded its bounded budget.");
      }
      const endpoint = await inspector({
        host: parsedAddr.host,
        port: parsedAddr.port,
        deadlineMs: mainDeadlineMs,
        timeoutMs: inspectRem,
      });
      if (!endpoint) {
        throw new AgentSetupError(
          "agy_endpoint_mismatch",
          "No verified local Antigravity loopback listener owned by this user matched the supplied port.",
        );
      }
      const canonicalAddr = validateCanonicalAgyLsAddress(endpoint.canonical_address);
      if (canonicalAddr.port !== parsedAddr.port) {
        throw new AgentSetupError(
          "agy_endpoint_mismatch",
          "Verified Antigravity listener port did not match the supplied address.",
        );
      }
      if (typeof process.getuid === "function" && endpoint.uid !== process.getuid()) {
        throw new AgentSetupError(
          "agy_endpoint_mismatch",
          "Verified Antigravity listener must be owned by the current user.",
        );
      }

      // C1: Validate executable against independent approved digest allowlist + codesign + strict 0o022/ACL
      // BEFORE launching ANY token-bearing child!
      const pinned = await validateAgyAgentApiExecutable(endpoint.executable, {
        ...(options.approvedDigests ? { approvedDigests: options.approvedDigests } : {}),
        ...(options.vendorVerifier ? { vendorVerifier: options.vendorVerifier } : {}),
        deadlineMs: mainDeadlineMs,
      });
      if (payload.agentapi_exe !== undefined) {
        const explicitChecked = await validateAgyAgentApiExecutable(payload.agentapi_exe, {
          expectedSha256: pinned.sha256,
          ...(options.approvedDigests ? { approvedDigests: options.approvedDigests } : {}),
          ...(options.vendorVerifier ? { vendorVerifier: options.vendorVerifier } : {}),
          deadlineMs: mainDeadlineMs,
        });
        if (explicitChecked.path !== pinned.path) {
          throw new AgentSetupError(
            "agy_endpoint_mismatch",
            "Supplied agentapi_exe does not match the live Antigravity listener executable.",
          );
        }
      }

      // C2: Repeat the exact listener check IMMEDIATELY before the first token-bearing metadata call
      // (closing the gap while executable validation ran).
      const preMetaRem = mainDeadlineMs - Date.now();
      if (preMetaRem <= 0) {
        throw new AgentSetupError("agy_dispatch_timeout", "Antigravity registration exceeded its bounded budget.");
      }
      const preMetaEndpoint = await inspector({
        host: canonicalAddr.host,
        port: canonicalAddr.port,
        deadlineMs: mainDeadlineMs,
        timeoutMs: preMetaRem,
      });
      if (
        !preMetaEndpoint ||
        preMetaEndpoint.canonical_address !== canonicalAddr.canonical ||
        preMetaEndpoint.pid !== endpoint.pid ||
        preMetaEndpoint.uid !== endpoint.uid ||
        preMetaEndpoint.start_time !== endpoint.start_time ||
        preMetaEndpoint.executable !== pinned.path
      ) {
        throw new AgentSetupError(
          "agy_endpoint_mismatch",
          "Antigravity loopback listener changed before session verification. Retry cswarm receive register-agy.",
        );
      }

      // Verify provider session evidence BEFORE saving the 0600 credential record.
      const verified = await verifyAgyConversationSession({
        executable: pinned.path,
        canonicalLsAddress: canonicalAddr.canonical,
        csrfToken: payload.csrf_token,
        hostSessionId: host,
        expectedCwd: auth.binding.cwd,
        timeoutMs: mainDeadlineMs - Date.now(),
        ...(options.runner ? { runner: options.runner } : {}),
      });

      // C2: ALWAYS run post-probe listener + digest recheck (even when verifyAgyConversationSession failed!)
      // strictly within totalDeadlineMs; if changed, retire any saved registration before throwing!
      let postProbeStillMatches = false;
      const postRem = totalDeadlineMs - Date.now();
      if (postRem > 0) {
        try {
          const postExe = await validateAgyAgentApiExecutable(pinned.path, {
            expectedSha256: pinned.sha256,
            ...(options.approvedDigests ? { approvedDigests: options.approvedDigests } : {}),
            ...(options.vendorVerifier ? { vendorVerifier: options.vendorVerifier } : {}),
            deadlineMs: totalDeadlineMs,
          });
          const postMetaEndpoint = await inspector({
            host: canonicalAddr.host,
            port: canonicalAddr.port,
            deadlineMs: totalDeadlineMs,
            timeoutMs: Math.max(1, totalDeadlineMs - Date.now()),
          });
          postProbeStillMatches = Boolean(
            postMetaEndpoint &&
              postMetaEndpoint.canonical_address === canonicalAddr.canonical &&
              postMetaEndpoint.pid === endpoint.pid &&
              postMetaEndpoint.uid === endpoint.uid &&
              postMetaEndpoint.start_time === endpoint.start_time &&
              postMetaEndpoint.executable === postExe.path,
          );
        } catch {
          postProbeStillMatches = false;
        }
      }

      if (!postProbeStillMatches) {
        const retired = await retireAgyWakeRouteUnlocked(
          profile,
          host,
          "agy_endpoint_changed_during_registration",
        );
        if (retired.markerFailed || retired.cleanupFailed) {
          throw new AgentSetupError(
            "agy_endpoint_changed_cleanup_failed",
            "Antigravity loopback listener changed during registration; wake route retired, but local cleanup failed. Remove the registration file and retry cswarm receive register-agy.",
          );
        }
        throw new AgentSetupError(
          "agy_endpoint_mismatch",
          "Antigravity loopback listener changed during registration verification; wake route retired. Retry cswarm receive register-agy.",
        );
      }

      if (!verified.ok) {
        throw new AgentSetupError(verified.code, verified.detail);
      }

      const record: AgyRegistrationRecord = {
        version: 1,
        profile,
        host_session_id: host,
        ls_address: canonicalAddr.canonical,
        ls_pid: endpoint.pid,
        ls_uid: endpoint.uid,
        ls_start_time: endpoint.start_time,
        agentapi_exe: pinned.path,
        agentapi_exe_sha256: pinned.sha256,
        csrf_token: payload.csrf_token,
        registered_at: nowIso,
      };
      await writeSecureJsonFile(agyRegistrationPath(profile, host), JSON.stringify(record));

      // Clear wake_unavailable_reason ONLY after verified registration completes.
      let bindingForStatus = auth.binding;
      if (auth.binding.wake_unavailable_reason) {
        bindingForStatus = { ...auth.binding, wake_unavailable_reason: null };
        await writeSecureJsonFile(receiveBindingPath(profile, host), JSON.stringify(bindingForStatus));
      }
      const status = receiveStatus(bindingForStatus, nowMs, auth.profile.host_session_id, profile);
      // Never print ls_address or csrf_token in output.
      return {
        registered: true,
        profile,
        host_session_id: host,
        wake_route: "agy-agentapi" as const,
        registered_at: nowIso,
        wake_verified: status.wake_verified,
        next_action: boundProfileCommands(
          "Antigravity wake credentials verified and saved to a 0600 file. Start cswarm receive serve, run cswarm receive test, end this turn and run cswarm receive idle, then confirm wake_verified: true with cswarm receive status.",
          profile,
          auth.profile.host_session_id,
        ),
      };
    },
    { timeoutMs: 20_000 },
  );
}

/** Explicit idle assertion for Antigravity wake canary verification (no Stop hook on agy). */
export async function markAgyIdle(profilePath: string, hostSessionId: string) {
  const profile = privatePath(profilePath);
  const host = checkedHostSessionId(hostSessionId);
  const openedProfile = await readAgentProfileForIdle(profile, host);
  await updateReceiveBinding(profile, host, (binding) => {
    if (
      binding.provider !== "agy" ||
      binding.requested_mode !== "wake" ||
      binding.experimental_agy_agentapi !== true ||
      binding.wake_unavailable_reason ||
      !receiveStatus(binding).channel_running
    ) {
      throw new AgentSetupError(
        "channel_not_running",
        "Start this Antigravity session's receive serve process first.",
      );
    }
    return { ...binding, idle: true, last_turn_ended_at: new Date().toISOString() };
  });
  return {
    state: "idle_declared",
    next_action: boundProfileCommands(
      "The receiver can now send the pending wake test. After this same session runs cswarm check, check cswarm receive status.",
      profile,
      openedProfile.host_session_id,
    ),
  };
}

async function readAgentProfileForIdle(profilePath: string, hostSessionId: string) {
  const auth = await resolveAuthorizedWakeBinding({
    profilePath,
    hostSessionId,
    expectedProvider: "agy",
  });
  if (!auth.ok) {
    throw new AgentSetupError(auth.code, auth.detail);
  }
  return auth.profile;
}

export interface AgyAgentApiAdapterOptions {
  profilePath: string;
  runner?: AgyAgentApiRunner;
  endpointInspector?: AgyEndpointInspector;
  vendorVerifier?: AgyVendorVerifier;
  approvedDigests?: ReadonlySet<string>;
  /** Single absolute lock-hold budget across all verifications, vendor calls, and postchecks (default 8_000ms). */
  timeoutMs?: number;
}

/**
 * Invokes `<pinned-antigravity> agentapi send-message --title=CommonSwarm <conversation-uuid> "<fixed text>"`:
 * - Single common absolute deadline (`AGY_DISPATCH_TOTAL_BUDGET_MS = 8_000`, inside opt-out's 20s wait)
 *   shared across ALL verification subprocesses, both vendor child calls, reserved postchecks, and close-wait.
 * - Verifies approved build allowlist + registered SHA-256 pin + strict `0o022`/ACL + Google LLC codesign.
 * - Verifies exact live loopback listener BEFORE and AFTER each token-bearing call; any change persists
 *   `wake_unavailable_reason` FIRST, then removes the 0600 registration, surfacing any cleanup failure.
 * - Emits ONLY fixed static diagnostic codes and text.
 */
export class AgyAgentApiAdapter implements NativeWakeAdapter {
  readonly route = "agy-agentapi" as const;
  private readonly profilePath: string;
  private readonly runner: AgyAgentApiRunner;
  private readonly endpointInspector: AgyEndpointInspector;
  private readonly vendorVerifier?: AgyVendorVerifier;
  private readonly approvedDigests?: ReadonlySet<string>;
  private readonly timeoutMs: number;

  constructor(options: AgyAgentApiAdapterOptions) {
    this.profilePath = privatePath(options.profilePath);
    this.runner = options.runner ?? defaultAgyAgentApiRunner;
    this.endpointInspector = options.endpointInspector ?? defaultAgyEndpointInspector;
    this.vendorVerifier = options.vendorVerifier;
    this.approvedDigests = options.approvedDigests;
    this.timeoutMs = options.timeoutMs ?? AGY_DISPATCH_TOTAL_BUDGET_MS;
  }

  private async verifyEndpointMatches(
    registration: AgyRegistrationRecord,
    canonicalAddr: { canonical: string; host: "127.0.0.1" | "::1"; port: number },
    pinnedPath: string,
    deadlineMs: number,
    signal?: AbortSignal,
  ): Promise<{ ok: true } | { ok: false; timedOut: boolean }> {
    const rem = deadlineMs - Date.now();
    if (rem <= 0) return { ok: false, timedOut: true };
    let liveEndpoint: AgyLoopbackEndpoint | null;
    try {
      liveEndpoint = await this.endpointInspector({
        host: canonicalAddr.host,
        port: canonicalAddr.port,
        deadlineMs,
        timeoutMs: rem,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (
        (error instanceof AgentSetupError && error.code === "agy_dispatch_timeout") ||
        (error as NodeJS.ErrnoException)?.code === "ETIMEDOUT"
      ) {
        return { ok: false, timedOut: true };
      }
      return { ok: false, timedOut: false };
    }
    const currentUid = typeof process.getuid === "function" ? process.getuid() : registration.ls_uid;
    const matches = Boolean(
      liveEndpoint &&
        liveEndpoint.canonical_address === canonicalAddr.canonical &&
        liveEndpoint.pid === registration.ls_pid &&
        liveEndpoint.uid === registration.ls_uid &&
        liveEndpoint.uid === currentUid &&
        liveEndpoint.start_time === registration.ls_start_time &&
        liveEndpoint.executable === pinnedPath,
    );
    return matches ? { ok: true } : { ok: false, timedOut: false };
  }

  private async retireAndReport(
    hostSessionId: string,
    reason: string,
    normalCode: string,
    normalDetail: string,
  ): Promise<{ ok: false; code: string; detail: string }> {
    const retired = await retireAgyWakeRouteUnlocked(this.profilePath, hostSessionId, reason);
    if (retired.markerFailed || retired.cleanupFailed) {
      return {
        ok: false,
        code: "agy_endpoint_changed_cleanup_failed",
        detail: "Antigravity endpoint changed; wake route disabled, but local cleanup failed. Remove the registration file and re-run cswarm receive register-agy.",
      };
    }
    return { ok: false, code: normalCode, detail: normalDetail };
  }

  async sendWake(input: {
    hostSessionId: string;
    prompt: string;
    batch: number;
    cwd: string;
    signal?: AbortSignal;
  }): Promise<{ ok: true } | { ok: false; code: string; detail: string }> {
    const { totalDeadlineMs, mainDeadlineMs } = splitTotalBudget(this.timeoutMs);

    if (!ONBOARDING_UUID.test(input.hostSessionId)) {
      return {
        ok: false,
        code: "agy_conversation_id_invalid",
        detail: "Antigravity native wake requires a bound conversation UUID.",
      };
    }
    try {
      assertFixedNativeWakePrompt(input.prompt);
    } catch {
      return {
        ok: false,
        code: "wake_prompt_unsafe",
        detail: "Refused non-fixed wake prompt.",
      };
    }

    let registration: AgyRegistrationRecord | null;
    try {
      registration = await readAgyRegistration(this.profilePath, input.hostSessionId);
    } catch (error) {
      const code = error instanceof AgentSetupError ? error.code : "agy_registration_invalid";
      return {
        ok: false,
        code,
        detail: "Antigravity wake registration is invalid. Re-run cswarm receive register-agy.",
      };
    }
    if (registration === null) {
      return {
        ok: false,
        code: "agy_not_registered",
        detail: "Antigravity wake is not registered for this conversation. Run cswarm receive register-agy.",
      };
    }

    let canonicalAddr: { canonical: string; host: "127.0.0.1" | "::1"; port: number };
    try {
      canonicalAddr = validateCanonicalAgyLsAddress(registration.ls_address);
    } catch {
      return {
        ok: false,
        code: "agy_ls_address_invalid",
        detail: "Antigravity registration does not contain a canonical loopback IP literal.",
      };
    }

    // C1 & C3: Re-verify approved allowlist + SHA-256 pin + strict 0o022/ACL + codesign under mainDeadlineMs.
    let pinned: { path: string; sha256: string };
    try {
      pinned = await validateAgyAgentApiExecutable(registration.agentapi_exe, {
        expectedSha256: registration.agentapi_exe_sha256,
        ...(this.approvedDigests ? { approvedDigests: this.approvedDigests } : {}),
        ...(this.vendorVerifier ? { vendorVerifier: this.vendorVerifier } : {}),
        deadlineMs: mainDeadlineMs,
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } catch (error) {
      const code = error instanceof AgentSetupError ? error.code : "agy_executable_invalid";
      if (code === "agy_dispatch_timeout") {
        return {
          ok: false,
          code: "agy_dispatch_timeout",
          detail: "Antigravity executable verification exceeded its bounded dispatch budget.",
        };
      }
      if (code === "agy_executable_pin_mismatch") {
        return {
          ok: false,
          code: "agy_executable_pin_mismatch",
          detail: "Pinned Antigravity executable changed or updated. Re-run cswarm receive register-agy.",
        };
      }
      if (code === "agy_executable_unapproved") {
        return {
          ok: false,
          code: "agy_executable_unapproved",
          detail: "Antigravity executable did not pass approved vendor build verification.",
        };
      }
      return {
        ok: false,
        code: "agy_executable_invalid",
        detail: "Pinned Antigravity executable failed trust verification.",
      };
    }

    // C2 Check #1 (before get-conversation-metadata): Verify exact loopback listener BEFORE presenting CSRF token!
    const preCheck = await this.verifyEndpointMatches(
      registration,
      canonicalAddr,
      pinned.path,
      mainDeadlineMs,
      input.signal,
    );
    if (!preCheck.ok) {
      if (preCheck.timedOut) {
        return {
          ok: false,
          code: "agy_dispatch_timeout",
          detail: "Antigravity listener verification exceeded its bounded dispatch budget.",
        };
      }
      return this.retireAndReport(
        input.hostSessionId,
        "agy_endpoint_mismatch",
        "agy_endpoint_mismatch",
        "Registered Antigravity language server is no longer listening on its verified loopback endpoint; wake route disabled. Re-run cswarm receive register-agy.",
      );
    }

    const metaBudget = mainDeadlineMs - Date.now();
    if (metaBudget <= 0) {
      return {
        ok: false,
        code: "agy_dispatch_timeout",
        detail: "Antigravity wake dispatch exceeded its bounded budget.",
      };
    }

    // C2: Verify the bound conversation UUID & workspace still belong to this exact LS.
    const sessionCheck = await verifyAgyConversationSession({
      executable: pinned.path,
      canonicalLsAddress: canonicalAddr.canonical,
      csrfToken: registration.csrf_token,
      hostSessionId: input.hostSessionId,
      expectedCwd: input.cwd,
      runner: this.runner,
      timeoutMs: metaBudget,
      ...(input.signal ? { signal: input.signal } : {}),
    });

    // C2 Check #2 (AFTER get-conversation-metadata / BEFORE send-message):
    // Strictly within totalDeadlineMs (no fresh time past totalDeadlineMs!).
    const postMetaDeadline = sessionCheck.ok ? mainDeadlineMs : totalDeadlineMs;
    let postMetaStillMatches = false;
    if (postMetaDeadline - Date.now() > 0) {
      try {
        const postMetaExe = await validateAgyAgentApiExecutable(registration.agentapi_exe, {
          expectedSha256: registration.agentapi_exe_sha256,
          ...(this.approvedDigests ? { approvedDigests: this.approvedDigests } : {}),
          ...(this.vendorVerifier ? { vendorVerifier: this.vendorVerifier } : {}),
          deadlineMs: postMetaDeadline,
          ...(input.signal ? { signal: input.signal } : {}),
        });
        const ep = await this.verifyEndpointMatches(
          registration,
          canonicalAddr,
          postMetaExe.path,
          postMetaDeadline,
          input.signal,
        );
        postMetaStillMatches = ep.ok;
      } catch {
        postMetaStillMatches = false;
      }
    }
    if (!postMetaStillMatches) {
      if (!sessionCheck.ok && sessionCheck.code === "agy_dispatch_timeout") {
        // Fail safe: a token-bearing metadata call timed out before postcheck completed.
        // Persist wake_unavailable_reason locally (no new subprocess) so next wake needs re-registration.
        return this.retireAndReport(
          input.hostSessionId,
          "agy_dispatch_timeout",
          "agy_dispatch_timeout",
          "Antigravity wake timed out before post-call endpoint verification completed; wake route disabled. Re-run cswarm receive register-agy.",
        );
      }
      return this.retireAndReport(
        input.hostSessionId,
        "agy_endpoint_changed_after_metadata",
        "agy_endpoint_mismatch",
        "Antigravity language server changed after session check; wake route disabled. Re-run cswarm receive register-agy.",
      );
    }
    if (!sessionCheck.ok) {
      return sessionCheck;
    }

    // Secrets MUST NEVER enter argv: pass canonical LS address and CSRF token strictly in stripped child env.
    const argv = [
      "agentapi",
      "send-message",
      "--title=CommonSwarm",
      input.hostSessionId,
      input.prompt,
    ] as const;
    if (argv.some((arg) => arg.includes(registration.csrf_token) || arg.includes(canonicalAddr.canonical))) {
      return {
        ok: false,
        code: "agy_secret_in_argv_refused",
        detail: "Refused wake command containing sensitive endpoint data in argv.",
      };
    }

    const sendBudget = mainDeadlineMs - Date.now();
    if (sendBudget <= 0) {
      return {
        ok: false,
        code: "agy_dispatch_timeout",
        detail: "Antigravity wake dispatch exceeded its bounded budget.",
      };
    }
    const childEnv = buildMinimalAgyChildEnv(canonicalAddr.canonical, registration.csrf_token);

    let sendFailure: { ok: false; code: string; detail: string } | null = null;
    try {
      const res = await this.runner(pinned.path, argv, {
        cwd: input.cwd,
        timeoutMs: sendBudget,
        env: childEnv,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const trimmed = res.stdout.trim();
      if (trimmed.startsWith("{")) {
        try {
          const parsed = JSON.parse(trimmed) as Record<string, unknown>;
          if (typeof parsed.error === "string" && parsed.error.length > 0) {
            sendFailure = AGY_UNREACHABLE_RE.test(parsed.error)
              ? {
                  ok: false,
                  code: "agy_ls_unreachable",
                  detail: "Antigravity language server is unreachable or rejected credentials. Re-run cswarm receive register-agy.",
                }
              : {
                  ok: false,
                  code: "agy_agentapi_failed",
                  detail: "Antigravity wake command reported an error.",
                };
          }
        } catch { /* non-JSON stdout on exit 0 is success */ }
      }
    } catch (error) {
      const err = error as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
      const combined = `${err.stderr ?? ""} ${err.stdout ?? ""} ${err.message ?? ""}`;
      if (err.code === "ENOENT") {
        sendFailure = {
          ok: false,
          code: "agy_not_found",
          detail: "Pinned Antigravity CLI executable was not found.",
        };
      } else if (err.code === "ETIMEDOUT") {
        sendFailure = {
          ok: false,
          code: "agy_dispatch_timeout",
          detail: "Antigravity wake command timed out within its bounded dispatch budget.",
        };
      } else if (AGY_UNREACHABLE_RE.test(combined) || err.code === "ECONNREFUSED") {
        sendFailure = {
          ok: false,
          code: "agy_ls_unreachable",
          detail: "Antigravity language server is unreachable or rejected credentials. Re-run cswarm receive register-agy.",
        };
      } else {
        sendFailure = {
          ok: false,
          code: "agy_agentapi_failed",
          detail: "Antigravity wake command failed.",
        };
      }
    }

    // C2 Check #3 (POST-send) strictly within totalDeadlineMs (using the reserved postcheck window,
    // NEVER allocating fresh time past totalDeadlineMs!).
    let postSendStillMatches = false;
    if (totalDeadlineMs - Date.now() > 0) {
      try {
        const postExe = await validateAgyAgentApiExecutable(registration.agentapi_exe, {
          expectedSha256: registration.agentapi_exe_sha256,
          ...(this.approvedDigests ? { approvedDigests: this.approvedDigests } : {}),
          ...(this.vendorVerifier ? { vendorVerifier: this.vendorVerifier } : {}),
          deadlineMs: totalDeadlineMs,
          ...(input.signal ? { signal: input.signal } : {}),
        });
        const ep = await this.verifyEndpointMatches(
          registration,
          canonicalAddr,
          postExe.path,
          totalDeadlineMs,
          input.signal,
        );
        postSendStillMatches = ep.ok;
      } catch {
        postSendStillMatches = false;
      }
    }

    if (!postSendStillMatches) {
      if (sendFailure?.code === "agy_dispatch_timeout") {
        // Fail safe: a token-bearing send-message call timed out before postcheck completed.
        // Persist wake_unavailable_reason locally (no new subprocess) so next wake needs re-registration.
        return this.retireAndReport(
          input.hostSessionId,
          "agy_dispatch_timeout",
          "agy_dispatch_timeout",
          "Antigravity wake timed out before post-call endpoint verification completed; wake route disabled. Re-run cswarm receive register-agy.",
        );
      }
      return this.retireAndReport(
        input.hostSessionId,
        "agy_endpoint_changed_after_send",
        "agy_endpoint_changed_after_send",
        "Antigravity language server changed during wake dispatch; wake route marked unavailable. Re-run cswarm receive register-agy.",
      );
    }

    if (sendFailure) return sendFailure;
    return { ok: true };
  }
}

function agyCanaryBody(nonce: string): string {
  return `CommonSwarm wake test ${nonce}. Confirm receipt in this session. No reply or other work is needed.`;
}

async function readCheckCursor(profilePath: string): Promise<SignalCursor | null> {
  const raw = await readSecureJsonFileIfPresent(
    join(dirname(profilePath), "check.json"),
    16 * 1024 * 1024,
  ).catch(() => null);
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

export interface ServeAgyWakeBridgeOptions {
  profilePath: string;
  hostSessionId: string;
  adapter?: NativeWakeAdapter;
  endpointInspector?: AgyEndpointInspector;
  vendorVerifier?: AgyVendorVerifier;
  approvedDigests?: ReadonlySet<string>;
  debounceMs?: number;
  minIntervalMs?: number;
  retryAfterMs?: number;
  pollMs?: number;
  heartbeatMs?: number;
  fetcher?: typeof fetch;
  wake?: WakeHandle;
  now?: () => number;
  signal?: AbortSignal;
}

/**
 * Long-lived bridge for `cswarm receive serve --profile P --host-session-id <conv>`
 * on an experimental Antigravity seat. Watches read-only inbox arrivals and nudges the bound
 * agy conversation via `antigravity agentapi send-message` with fixed text only.
 */
export async function serveAgyWakeBridge(options: ServeAgyWakeBridgeOptions): Promise<void> {
  const profilePath = privatePath(options.profilePath);
  const host = checkedHostSessionId(options.hostSessionId);
  if (!ONBOARDING_UUID.test(host)) {
    throw new AgentSetupError(
      "agy_conversation_id_required",
      "Antigravity wake requires this session's conversation UUID as --host-session-id.",
    );
  }
  const initialAuth = await resolveAuthorizedWakeBinding({
    profilePath,
    hostSessionId: host,
    expectedProvider: "agy",
  });
  if (!initialAuth.ok) {
    throw new AgentSetupError(initialAuth.code, initialAuth.detail);
  }
  const initialReg = await readAgyRegistration(profilePath, host);
  if (initialReg === null) {
    throw new AgentSetupError(
      "agy_not_registered",
      "Register Antigravity credentials first with cswarm receive register-agy.",
    );
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
  const pollMs = options.pollMs ?? AGY_WAKE_POLL_MS;
  const heartbeatMs = options.heartbeatMs ?? AGY_WAKE_HEARTBEAT_MS;
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
  const adapter =
    options.adapter ??
    new AgyAgentApiAdapter({
      profilePath,
      ...(options.endpointInspector ? { endpointInspector: options.endpointInspector } : {}),
      ...(options.vendorVerifier ? { vendorVerifier: options.vendorVerifier } : {}),
      ...(options.approvedDigests ? { approvedDigests: options.approvedDigests } : {}),
    });
  const bridge = new NativeWakeBridge({
    profilePath,
    hostSessionId: host,
    cwd: initial.cwd,
    adapter,
    expectedProvider: "agy",
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
  let installedRuntimeMarker = false;
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

  // C3: Atomically re-verify live wake route, registration, and single-receiver ownership
  // under the shared `receive-<scope>` lock BEFORE writing any runtime marker.
  try {
    await withFileLock(
      dirname(profilePath),
      `receive-${profileScopeKey(host)}`,
      async () => {
        const liveAuth = await resolveAuthorizedWakeBinding({
          profilePath,
          hostSessionId: host,
          expectedProvider: "agy",
          expectedSeat: {
            workspaceId: profile.workspace_id,
            principalId: profile.principal_id,
          },
        });
        if (!liveAuth.ok || wakeRouteForBinding(liveAuth.binding) !== "agy-agentapi") {
          throw new AgentSetupError(
            liveAuth.ok ? "wake_opted_out" : liveAuth.code,
            liveAuth.ok ? "This seat is no longer opted into experimental Antigravity wake mode." : liveAuth.detail,
          );
        }
        const liveReg = await readAgyRegistration(profilePath, host);
        if (liveReg === null) {
          throw new AgentSetupError(
            "agy_not_registered",
            "Register Antigravity credentials first with cswarm receive register-agy.",
          );
        }
        if (receiveStatus(liveAuth.binding, now()).channel_running) {
          throw new AgentSetupError("channel_already_running", "This session already has a live wake bridge.");
        }
        const nextBinding = {
          ...liveAuth.binding,
          channel_instance_id: runtimeId,
          channel_pid: process.pid,
          channel_heartbeat_at: new Date(now()).toISOString(),
          wake_verified_at: null,
          canary: liveAuth.binding.canary
            ? { ...liveAuth.binding.canary, emitted_while_idle: false, received_at: null }
            : null,
        };
        await writeSecureJsonFile(receiveBindingPath(profilePath, host), JSON.stringify(nextBinding));
        installedRuntimeMarker = true;
      },
      { timeoutMs: 20_000 },
    );
  } catch (error) {
    stop();
    if (options.signal) options.signal.removeEventListener("abort", externalAbort);
    await wake.close();
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    throw error;
  }

  let touching = false;
  const bindingStillOwned = async (): Promise<boolean> => {
    const current = await readReceiveBinding(profilePath, host).catch(() => null);
    return (
      current !== null &&
      current.requested_mode === "wake" &&
      current.experimental_agy_agentapi === true &&
      !current.wake_unavailable_reason &&
      current.channel_instance_id === runtimeId
    );
  };
  const touch = async (): Promise<void> => {
    if (stopped || abort.signal.aborted || touching) return;
    touching = true;
    try {
      if (bridge.isDispatching()) {
        if (!(await bindingStillOwned())) stop();
        return;
      }
      await updateReceiveBinding(profilePath, host, (b) => {
        if (
          b.channel_instance_id !== runtimeId ||
          b.requested_mode !== "wake" ||
          b.experimental_agy_agentapi !== true ||
          b.wake_unavailable_reason
        ) {
          stop();
          return b;
        }
        return { ...b, channel_heartbeat_at: new Date(now()).toISOString() };
      });
    } catch (error) {
      if (error instanceof FileLockTimeoutError) {
        if (!(await bindingStillOwned())) stop();
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
        expectedProvider: "agy",
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

        if (binding.canary && binding.canary.signal_id === null && binding.idle) {
          const result = await sender.sendSignal({
            workspaceId: profile.workspace_id,
            credential: token,
            commandId: `canary_${binding.canary.nonce.replace(/-/g, "")}`,
            command: {
              kind: "post_signal",
              signal_kind: "note",
              body: agyCanaryBody(binding.canary.nonce),
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
          process.stderr.write(`CommonSwarm agy wake: ${decision.code}. Check cswarm receive status.\n`);
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
        const code = error instanceof AgentSetupError ? error.code : "agy_wake_poll_failed";
        if (code !== lastErrorCode) {
          process.stderr.write(`CommonSwarm agy wake: ${code}. Check cswarm receive status.\n`);
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
    if (installedRuntimeMarker) {
      await updateReceiveBinding(profilePath, host, (b) =>
        b.channel_instance_id === runtimeId
          ? { ...b, channel_pid: null, channel_heartbeat_at: null, wake_verified_at: null }
          : b,
      ).catch(() => undefined);
    }
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  }
}
