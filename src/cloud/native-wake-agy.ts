/**
 * Experimental native Antigravity wake adapter (`agy agentapi send-message`) behind an
 * explicit feature flag (`--provider agy --mode wake --experimental-agy-agentapi`).
 *
 * Security & operational invariants:
 *   - Explicit experimental opt-in required: never activates without `--experimental-agy-agentapi`
 *     recorded on the live `receive-<scope>.json` binding.
 *   - Env-only 0600 registration (`cswarm receive register-agy`): reads ANTIGRAVITY_LS_ADDRESS and
 *     ANTIGRAVITY_CSRF_TOKEN strictly from process env (never argv/stdout/stderr/logs), validates
 *     loopback LS address (127.0.0.1 / localhost / [::1]) and single-line non-control-char values,
 *     and serializes registration and opt-out deletion under the exact shared `receive-<scope>` lock.
 *   - Refuses registration unless the live binding is already `provider: "agy"`, `requested_mode: "wake"`,
 *     and `experimental_agy_agentapi: true` on a private host-bound profile; never writes in turn mode
 *     or silently mutates receive routes.
 *   - Fixed text ONLY (assertFixedNativeWakePrompt right before execFile); passes LS address and
 *     CSRF token strictly via child env (never argv); redacts CSRF token from every error detail.
 *   - Fails loudly on stale/restarted agy LS or missing registration (never silently drops).
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
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

const execFileAsync = promisify(execFile);

const AGY_WAKE_HEARTBEAT_MS = 5_000;
const AGY_WAKE_POLL_MS = 30_000;
const AGY_AGENTAPI_TIMEOUT_MS = 12_000;
const AGY_REGISTRATION_MAX_BYTES = 16 * 1024;
const AGY_LS_ADDRESS_MAX_CHARS = 256;
const AGY_CSRF_TOKEN_MAX_CHARS = 512;
const AGY_EXECUTABLE_MAX_CHARS = 1024;
const AGY_CONTROL_OR_SPACE_RE = /[\x00-\x20\x7f]/;
const AGY_CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;
const AGY_EXECUTABLE_BASENAME_RE = /^(agy|antigravity)(\.exe)?$/i;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const AGY_UNREACHABLE_RE =
  /econnrefused|connection refused|connect error|failed to connect|dial tcp|401|403|unauthorized|unauthenticated|forbidden|csrf|unavailable|connection reset|socket hang up|etimedout|eof/i;

export interface AgyRegistrationRecord {
  version: 1;
  profile: string;
  host_session_id: string;
  ls_address: string;
  csrf_token: string;
  agentapi_exe?: string;
  registered_at: string;
}

/** Validate ANTIGRAVITY_LS_ADDRESS: strictly local loopback host:port (or http(s)://loopback:port). */
export function validateAgyLsAddress(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > AGY_LS_ADDRESS_MAX_CHARS) {
    throw new AgentSetupError(
      "agy_ls_address_invalid",
      "ANTIGRAVITY_LS_ADDRESS must be set in the environment to a local loopback address (127.0.0.1, localhost, or [::1] with port).",
    );
  }
  if (AGY_CONTROL_OR_SPACE_RE.test(raw) || /[@?#]/.test(raw)) {
    throw new AgentSetupError(
      "agy_ls_address_invalid",
      "ANTIGRAVITY_LS_ADDRESS must not contain whitespace, control characters, credentials, query, or fragment.",
    );
  }
  const hasScheme = raw.includes("://");
  let parsed: URL;
  try {
    parsed = new URL(hasScheme ? raw : `http://${raw}`);
  } catch {
    throw new AgentSetupError(
      "agy_ls_address_invalid",
      "ANTIGRAVITY_LS_ADDRESS must be a valid local loopback host:port or http(s)://loopback:port.",
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new AgentSetupError(
      "agy_ls_address_invalid",
      "ANTIGRAVITY_LS_ADDRESS scheme must be http or https when supplied.",
    );
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new AgentSetupError(
      "agy_ls_address_invalid",
      "ANTIGRAVITY_LS_ADDRESS must not include credentials, query, or fragment.",
    );
  }
  if (parsed.pathname !== "" && parsed.pathname !== "/") {
    throw new AgentSetupError(
      "agy_ls_address_invalid",
      "ANTIGRAVITY_LS_ADDRESS must not include a path.",
    );
  }
  if (!hasScheme && raw.endsWith("/")) {
    throw new AgentSetupError(
      "agy_ls_address_invalid",
      "ANTIGRAVITY_LS_ADDRESS must not include a trailing slash without a scheme.",
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new AgentSetupError(
      "agy_ls_address_invalid",
      "ANTIGRAVITY_LS_ADDRESS must target local loopback only (127.0.0.1, localhost, or [::1]).",
    );
  }
  if (!/^[0-9]{1,5}$/.test(parsed.port)) {
    throw new AgentSetupError(
      "agy_ls_address_invalid",
      "ANTIGRAVITY_LS_ADDRESS must include an explicit TCP port (1-65535).",
    );
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new AgentSetupError(
      "agy_ls_address_invalid",
      "ANTIGRAVITY_LS_ADDRESS port must be between 1 and 65535.",
    );
  }
  return raw;
}

/** Validate ANTIGRAVITY_CSRF_TOKEN without ever echoing its value in error text. */
export function validateAgyCsrfToken(raw: unknown): string {
  if (
    typeof raw !== "string" ||
    raw.length === 0 ||
    raw.length > AGY_CSRF_TOKEN_MAX_CHARS ||
    AGY_CONTROL_OR_SPACE_RE.test(raw)
  ) {
    throw new AgentSetupError(
      "agy_csrf_token_invalid",
      "ANTIGRAVITY_CSRF_TOKEN must be set in the environment to a non-empty single-line token without whitespace or control characters.",
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
      "ANTIGRAVITY_AGENTAPI_EXE must be an absolute path to a non-world-writable agy or antigravity executable.",
    );
  }
  return raw;
}

/** Validate optional ANTIGRAVITY_AGENTAPI_EXE: canonical executable agy/antigravity binary, not world-writable. */
export async function validateAgyAgentApiExecutable(raw: unknown): Promise<string> {
  const shaped = validateAgyExecutablePathShape(raw);
  let resolved: string;
  try {
    resolved = await realpath(shaped);
  } catch {
    throw new AgentSetupError(
      "agy_executable_invalid",
      "ANTIGRAVITY_AGENTAPI_EXE does not resolve to an accessible agy or antigravity executable.",
    );
  }
  if (!isAbsolute(resolved) || !AGY_EXECUTABLE_BASENAME_RE.test(basename(resolved))) {
    throw new AgentSetupError(
      "agy_executable_invalid",
      "ANTIGRAVITY_AGENTAPI_EXE must resolve to an agy or antigravity executable.",
    );
  }
  let info;
  try {
    info = await stat(resolved);
  } catch {
    throw new AgentSetupError(
      "agy_executable_invalid",
      "ANTIGRAVITY_AGENTAPI_EXE could not be verified on disk.",
    );
  }
  if (!info.isFile() || (info.mode & 0o111) === 0 || (info.mode & 0o002) !== 0) {
    throw new AgentSetupError(
      "agy_executable_invalid",
      "ANTIGRAVITY_AGENTAPI_EXE must be an executable regular file and not world-writable.",
    );
  }
  return resolved;
}

/** Redact CSRF token occurrences (raw and URL-encoded) from any error detail or stderr snippet. */
export function redactAgySecrets(text: string, csrfToken?: string | null): string {
  if (!text) return "";
  let redacted = text;
  if (csrfToken && csrfToken.length > 0) {
    redacted = redacted.split(csrfToken).join("[REDACTED]");
    try {
      const encoded = encodeURIComponent(csrfToken);
      if (encoded !== csrfToken && encoded.length > 0) {
        redacted = redacted.split(encoded).join("[REDACTED]");
      }
    } catch { /* ignore */ }
  }
  return redacted;
}

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
      "Antigravity wake registration file is damaged. Re-run cswarm receive register-agy inside the active agy session.",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AgentSetupError(
      "agy_registration_invalid",
      "Antigravity wake registration file is invalid. Re-run cswarm receive register-agy inside the active agy session.",
    );
  }
  const r = parsed as Record<string, unknown>;
  if (
    r.version !== 1 ||
    r.profile !== expectedProfile ||
    r.host_session_id !== expectedHost ||
    typeof r.host_session_id !== "string" ||
    !ONBOARDING_UUID.test(r.host_session_id) ||
    typeof r.registered_at !== "string" ||
    !Number.isFinite(Date.parse(r.registered_at))
  ) {
    throw new AgentSetupError(
      "agy_registration_invalid",
      "Antigravity wake registration does not match this profile and conversation. Re-run cswarm receive register-agy.",
    );
  }
  const lsAddress = validateAgyLsAddress(r.ls_address);
  const csrfToken = validateAgyCsrfToken(r.csrf_token);
  const agentapiExe =
    r.agentapi_exe === undefined ? undefined : validateAgyExecutablePathShape(r.agentapi_exe);
  return {
    version: 1,
    profile: expectedProfile,
    host_session_id: expectedHost,
    ls_address: lsAddress,
    csrf_token: csrfToken,
    ...(agentapiExe !== undefined ? { agentapi_exe: agentapiExe } : {}),
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
 * Env-only 0600 registration (`cswarm receive register-agy`).
 * Reads ANTIGRAVITY_LS_ADDRESS and ANTIGRAVITY_CSRF_TOKEN strictly from env, serializes under the
 * shared `receive-<scope>` lock, refuses unless the live binding is already `provider: "agy"` +
 * `requested_mode: "wake"` + `experimental_agy_agentapi: true`, and never mutates receive routes.
 */
export async function registerAgyWake(options: {
  profilePath: string;
  hostSessionId: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}) {
  const profile = privatePath(options.profilePath);
  const host = checkedHostSessionId(options.hostSessionId);
  if (!ONBOARDING_UUID.test(host)) {
    throw new AgentSetupError(
      "agy_conversation_id_required",
      "Antigravity wake registration requires this session's conversation UUID as --host-session-id.",
    );
  }
  const env = options.env ?? process.env;
  const lsAddress = validateAgyLsAddress(env.ANTIGRAVITY_LS_ADDRESS);
  const csrfToken = validateAgyCsrfToken(env.ANTIGRAVITY_CSRF_TOKEN);
  const rawAgentApiExe = env.ANTIGRAVITY_AGENTAPI_EXE;
  const agentapiExe =
    typeof rawAgentApiExe === "string" && rawAgentApiExe.length > 0
      ? await validateAgyAgentApiExecutable(rawAgentApiExe)
      : undefined;
  const nowMs = (options.now ?? Date.now)();
  const nowIso = new Date(nowMs).toISOString();

  return withFileLock(
    dirname(profile),
    `receive-${profileScopeKey(host)}`,
    async () => {
      const auth = await resolveAuthorizedWakeBinding({
        profilePath: profile,
        hostSessionId: host,
        expectedProvider: "agy",
      });
      if (!auth.ok) {
        throw new AgentSetupError(auth.code, auth.detail);
      }
      const record: AgyRegistrationRecord = {
        version: 1,
        profile,
        host_session_id: host,
        ls_address: lsAddress,
        csrf_token: csrfToken,
        ...(agentapiExe !== undefined ? { agentapi_exe: agentapiExe } : {}),
        registered_at: nowIso,
      };
      await writeSecureJsonFile(agyRegistrationPath(profile, host), JSON.stringify(record));
      const status = receiveStatus(auth.binding, nowMs, auth.profile.host_session_id, profile);
      return {
        registered: true,
        profile,
        host_session_id: host,
        wake_route: "agy-agentapi" as const,
        ls_address: lsAddress,
        registered_at: nowIso,
        wake_verified: status.wake_verified,
        next_action: boundProfileCommands(
          "Antigravity wake credentials saved to a 0600 file. Start cswarm receive serve, run cswarm receive test, end this turn and run cswarm receive idle, then confirm wake_verified: true with cswarm receive status.",
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

const defaultAgyAgentApiRunner: AgyAgentApiRunner = async (executable, args, options) => {
  const result = await execFileAsync(executable, [...args], {
    cwd: options.cwd,
    timeout: options.timeoutMs,
    maxBuffer: 64 * 1024,
    env: options.env,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return {
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
};

export interface AgyAgentApiAdapterOptions {
  profilePath: string;
  agyExecutable?: string;
  runner?: AgyAgentApiRunner;
  timeoutMs?: number;
  baseEnv?: NodeJS.ProcessEnv;
}

/**
 * Invokes `agy agentapi send-message --title=CommonSwarm <conversation-uuid> "<fixed text>"`,
 * reading ANTIGRAVITY_LS_ADDRESS and ANTIGRAVITY_CSRF_TOKEN from the 0600 registration file and
 * passing them strictly via child env (never argv), with CSRF token redaction on every error path.
 */
export class AgyAgentApiAdapter implements NativeWakeAdapter {
  readonly route = "agy-agentapi" as const;
  private readonly profilePath: string;
  private readonly explicitExecutable?: string;
  private readonly runner: AgyAgentApiRunner;
  private readonly timeoutMs: number;
  private readonly baseEnv: NodeJS.ProcessEnv;

  constructor(options: AgyAgentApiAdapterOptions) {
    this.profilePath = privatePath(options.profilePath);
    this.explicitExecutable = options.agyExecutable;
    this.runner = options.runner ?? defaultAgyAgentApiRunner;
    this.timeoutMs = options.timeoutMs ?? AGY_AGENTAPI_TIMEOUT_MS;
    this.baseEnv = options.baseEnv ?? process.env;
  }

  async sendWake(input: {
    hostSessionId: string;
    prompt: string;
    batch: number;
    cwd: string;
    signal?: AbortSignal;
  }): Promise<{ ok: true } | { ok: false; code: string; detail: string }> {
    if (!ONBOARDING_UUID.test(input.hostSessionId)) {
      return {
        ok: false,
        code: "agy_conversation_id_invalid",
        detail: "Antigravity native wake requires a bound conversation UUID.",
      };
    }
    try {
      assertFixedNativeWakePrompt(input.prompt);
    } catch (error) {
      return {
        ok: false,
        code: "wake_prompt_unsafe",
        detail: error instanceof Error ? error.message : "Unsafe wake prompt refused.",
      };
    }

    let registration: AgyRegistrationRecord | null;
    try {
      registration = await readAgyRegistration(this.profilePath, input.hostSessionId);
    } catch (error) {
      const code = error instanceof AgentSetupError ? error.code : "agy_registration_invalid";
      const detail = error instanceof Error ? error.message : "Antigravity wake registration is invalid.";
      return { ok: false, code, detail: detail.slice(0, 240) };
    }
    if (registration === null) {
      return {
        ok: false,
        code: "agy_not_registered",
        detail: "Antigravity wake is not registered for this conversation. Run cswarm receive register-agy inside the active agy session.",
      };
    }

    let executable = this.explicitExecutable ?? "agy";
    if (!this.explicitExecutable && registration.agentapi_exe) {
      try {
        executable = await validateAgyAgentApiExecutable(registration.agentapi_exe);
      } catch (error) {
        const code = error instanceof AgentSetupError ? error.code : "agy_executable_invalid";
        const detail = error instanceof Error ? error.message : "Antigravity executable is invalid.";
        return { ok: false, code, detail: detail.slice(0, 240) };
      }
    }

    // Secrets MUST NEVER enter argv: pass LS address and CSRF token strictly via child env.
    const argv = [
      "agentapi",
      "send-message",
      "--title=CommonSwarm",
      input.hostSessionId,
      input.prompt,
    ] as const;
    if (argv.some((arg) => arg.includes(registration.csrf_token))) {
      return {
        ok: false,
        code: "agy_secret_in_argv_refused",
        detail: "Refused wake command containing CSRF secret in argv.",
      };
    }

    const childEnv: NodeJS.ProcessEnv = {
      ...this.baseEnv,
      CMUX_ANTIGRAVITY_HOOKS_DISABLED: "1",
      ANTIGRAVITY_LS_ADDRESS: registration.ls_address,
      ANTIGRAVITY_CSRF_TOKEN: registration.csrf_token,
    };

    try {
      await this.runner(executable, argv, {
        cwd: input.cwd,
        timeoutMs: this.timeoutMs,
        env: childEnv,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      return { ok: true };
    } catch (error) {
      const err = error as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
      const rawDetail =
        (typeof err.stderr === "string" && err.stderr.trim()) ||
        (typeof err.stdout === "string" && err.stdout.trim()) ||
        err.message ||
        "agy_agentapi_failed";
      const safeDetail = redactAgySecrets(rawDetail, registration.csrf_token);
      if (err.code === "ENOENT") {
        return {
          ok: false,
          code: "agy_not_found",
          detail: `Antigravity CLI executable not found: ${safeDetail}`.slice(0, 240),
        };
      }
      if (AGY_UNREACHABLE_RE.test(safeDetail) || err.code === "ECONNREFUSED" || err.code === "ETIMEDOUT") {
        return {
          ok: false,
          code: "agy_ls_unreachable",
          detail: `Antigravity language server unreachable or rejected token (restarted or stale registration). Re-run cswarm receive register-agy. (${safeDetail})`.slice(0, 240),
        };
      }
      return {
        ok: false,
        code: "agy_agentapi_failed",
        detail: safeDetail.slice(0, 240),
      };
    }
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
  agyExecutable?: string;
  adapter?: NativeWakeAdapter;
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
 * agy conversation via `agy agentapi send-message` with fixed text only.
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
      "Register Antigravity local LS credentials first: run cswarm receive register-agy inside the active agy session.",
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
      ...(options.agyExecutable ? { agyExecutable: options.agyExecutable } : {}),
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
    if (binding && receiveStatus(binding, now()).channel_running) {
      throw new AgentSetupError("channel_already_running", "This session already has a live wake bridge.");
    }
    await updateReceiveBinding(profilePath, host, (b) => ({
      ...b,
      channel_instance_id: runtimeId,
      channel_pid: process.pid,
      channel_heartbeat_at: new Date(now()).toISOString(),
      wake_verified_at: null,
      canary: b.canary ? { ...b.canary, emitted_while_idle: false, received_at: null } : null,
    }));
  });

  let touching = false;
  const bindingStillOwned = async (): Promise<boolean> => {
    const current = await readReceiveBinding(profilePath, host).catch(() => null);
    return (
      current !== null &&
      current.requested_mode === "wake" &&
      current.experimental_agy_agentapi === true &&
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
        if (b.channel_instance_id !== runtimeId || b.requested_mode !== "wake" || b.experimental_agy_agentapi !== true) {
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
          process.stderr.write(`CommonSwarm agy wake: ${decision.code}: ${decision.detail}\n`);
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
    await updateReceiveBinding(profilePath, host, (b) =>
      b.channel_instance_id === runtimeId
        ? { ...b, channel_pid: null, channel_heartbeat_at: null, wake_verified_at: null }
        : b,
    ).catch(() => undefined);
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  }
}
