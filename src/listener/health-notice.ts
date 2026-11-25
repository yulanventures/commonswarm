import { join } from "node:path";
import { quoteAgentArgument } from "../cloud/agent-onboarding-contract.js";
import {
  readNativeWakeState,
  type NativeWakeRoute,
} from "../cloud/native-wake.js";
import {
  readSecureJsonFileIfPresent,
  writeSecureJsonFile,
} from "../cloud/storage.js";
import { SECRET_SHAPE_RE } from "../host/credential-redaction.js";
import { formatSeatAgo } from "../protocol/seat-status.js";
import {
  LISTENER_RUNNING_STATES,
  listenerPaths,
  readListenerStatusIfPresent,
  type ListenerPaths,
  type ListenerProviderId,
  type ListenerStatusState,
} from "./control.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_ERROR_CODE_RE = /^[a-z0-9_-]{1,96}$/;
const MAX_ATTENDED_CANARY_BYTES = 4 * 1024;

export const ATTENDED_CANARY_STATES = [
  "proved",
  "stalled_observed",
  "stalled_watcher",
] as const;
export type AttendedCanaryPersistedState = (typeof ATTENDED_CANARY_STATES)[number];

export interface AttendedCanaryPersistedStatus {
  version: 1;
  state: AttendedCanaryPersistedState;
  updated_at: string;
  workspace_id: string;
  principal_id: string;
  last_check_at: string | null;
}

export interface LocalListenerHealthSummary {
  state: ListenerStatusState | "missing";
  effective_state: ListenerStatusState | "missing";
  pid_alive: boolean | null;
  error_code: string | null;
  updated_at: string | null;
  provider: ListenerProviderId | null;
}

export interface LocalNativeWakeHealthSummary {
  failed: boolean;
  failed_at: string | null;
  error: string | null;
  route: NativeWakeRoute | null;
}

export interface LocalAttendedCanaryHealthSummary {
  state: AttendedCanaryPersistedState;
  updated_at: string;
  last_check_at: string | null;
  cleared_by_check: boolean;
}

export interface LocalSeatWakeHealth {
  healthy: boolean;
  listener: LocalListenerHealthSummary;
  native_wake: LocalNativeWakeHealthSummary | null;
  attended_canary: LocalAttendedCanaryHealthSummary | null;
  warnings: string[];
}

export interface CheckLocalSeatWakeHealthOptions {
  profileId: string;
  workspaceId: string;
  principalId: string;
  profilePath?: string;
  hostSessionId?: string;
  stateDirectory?: string;
  now?: number;
  isProcessAlive?: (pid: number) => boolean;
}

export function sanitizeNoticeText(value: string, maxLength = 96): string {
  const cleaned = value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length === 0 || SECRET_SHAPE_RE.test(cleaned)) {
    return "";
  }
  return cleaned.slice(0, maxLength);
}

function safeErrorCode(raw: string | null | undefined, fallback: string): string {
  if (typeof raw === "string" && SAFE_ERROR_CODE_RE.test(raw)) {
    return raw;
  }
  return fallback;
}

function safeWakeError(raw: string | null | undefined): string {
  if (typeof raw !== "string") return "unknown";
  if (SAFE_ERROR_CODE_RE.test(raw)) return raw;
  const cleaned = sanitizeNoticeText(raw, 96);
  return cleaned.length > 0 ? cleaned : "wake_failed";
}

function formatAgeFromIso(iso: string | null | undefined, now: number): string {
  if (!iso) return "unknown time ago";
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return "unknown time ago";
  return formatSeatAgo(Math.max(0, now - parsed));
}

export function isLocalPidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    if (code === "ESRCH") return false;
    return true;
  }
}

export function attendedCanaryStatePath(paths: ListenerPaths): string {
  return join(paths.instanceDirectory, "attended-canary.json");
}

function parseAttendedCanaryStatus(raw: string): AttendedCanaryPersistedStatus | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const row = parsed as Record<string, unknown>;
  const allowedKeys = new Set([
    "version",
    "state",
    "updated_at",
    "workspace_id",
    "principal_id",
    "last_check_at",
  ]);
  for (const key of Object.keys(row)) {
    if (!allowedKeys.has(key)) return null;
  }
  const state = row.state;
  const lastCheckAt = row.last_check_at === undefined ? null : row.last_check_at;
  if (
    row.version !== 1 ||
    typeof state !== "string" ||
    !(ATTENDED_CANARY_STATES as readonly string[]).includes(state) ||
    typeof row.updated_at !== "string" ||
    !Number.isFinite(Date.parse(row.updated_at)) ||
    typeof row.workspace_id !== "string" ||
    !UUID_RE.test(row.workspace_id) ||
    typeof row.principal_id !== "string" ||
    !UUID_RE.test(row.principal_id) ||
    !(lastCheckAt === null || (typeof lastCheckAt === "string" && Number.isFinite(Date.parse(lastCheckAt))))
  ) {
    return null;
  }
  return {
    version: 1,
    state: state as AttendedCanaryPersistedState,
    updated_at: row.updated_at,
    workspace_id: row.workspace_id.toLowerCase(),
    principal_id: row.principal_id.toLowerCase(),
    last_check_at: lastCheckAt,
  };
}

export async function readAttendedCanaryStatusIfPresent(
  paths: ListenerPaths,
): Promise<AttendedCanaryPersistedStatus | null> {
  try {
    const raw = await readSecureJsonFileIfPresent(
      attendedCanaryStatePath(paths),
      MAX_ATTENDED_CANARY_BYTES,
    );
    return raw === null ? null : parseAttendedCanaryStatus(raw);
  } catch {
    return null;
  }
}

export async function writeAttendedCanaryStatus(
  paths: ListenerPaths,
  input: {
    state: AttendedCanaryPersistedState;
    updated_at: string;
    workspace_id: string;
    principal_id: string;
    last_check_at?: string | null;
  },
): Promise<void> {
  if (
    !UUID_RE.test(input.workspace_id) ||
    !UUID_RE.test(input.principal_id) ||
    !Number.isFinite(Date.parse(input.updated_at)) ||
    !(ATTENDED_CANARY_STATES as readonly string[]).includes(input.state)
  ) {
    throw new Error("invalid attended canary status payload");
  }
  const lastCheckAt = input.last_check_at ?? null;
  if (lastCheckAt !== null && !Number.isFinite(Date.parse(lastCheckAt))) {
    throw new Error("invalid attended canary last_check_at timestamp");
  }
  const payload: AttendedCanaryPersistedStatus = {
    version: 1,
    state: input.state,
    updated_at: input.updated_at,
    workspace_id: input.workspace_id.toLowerCase(),
    principal_id: input.principal_id.toLowerCase(),
    last_check_at: lastCheckAt,
  };
  await writeSecureJsonFile(
    attendedCanaryStatePath(paths),
    JSON.stringify(payload),
  );
}

/**
 * When `cswarm check` succeeds for a seat whose local attended-canary file recorded
 * `stalled_observed`, stamp `last_check_at` so stale watcher warnings clear immediately.
 * Never creates a file or directory when no canary status file is present.
 */
export async function clearStalledAttendedCanaryOnCheck(options: {
  profileId: string;
  workspaceId: string;
  principalId: string;
  stateDirectory?: string;
  now?: number;
}): Promise<boolean> {
  if (!UUID_RE.test(options.workspaceId) || !UUID_RE.test(options.principalId)) {
    return false;
  }
  let paths: ListenerPaths;
  try {
    paths = listenerPaths({
      profileId: options.profileId,
      workspaceId: options.workspaceId,
      principalId: options.principalId,
      ...(options.stateDirectory !== undefined ? { stateDirectory: options.stateDirectory } : {}),
    });
  } catch {
    return false;
  }
  const existing = await readAttendedCanaryStatusIfPresent(paths);
  if (existing === null || existing.state !== "stalled_observed") {
    return false;
  }
  const nowIso = new Date(options.now ?? Date.now()).toISOString();
  await writeAttendedCanaryStatus(paths, {
    state: existing.state,
    updated_at: existing.updated_at,
    workspace_id: existing.workspace_id,
    principal_id: existing.principal_id,
    last_check_at: nowIso,
  });
  return true;
}

function listenerFixCommand(options: {
  provider: ListenerProviderId;
  profilePath?: string;
  hostSessionId?: string;
  workspaceId: string;
}): string {
  if (options.profilePath) {
    const hostPart = options.hostSessionId
      ? ` --host-session-id ${quoteAgentArgument(options.hostSessionId)}`
      : "";
    return `cswarm listen start --profile ${quoteAgentArgument(options.profilePath)}${hostPart} --provider ${options.provider}`;
  }
  return `cswarm listen status --workspace-id ${options.workspaceId}`;
}

/**
 * Fast, strictly local-only (zero network calls) wake & listener health inspection
 * for a seat. Only emits warnings when local state proves a broken listener, a failed
 * native wake, or an uncleared stalled attended canary. Clean environments emit zero warnings.
 */
export async function checkLocalSeatWakeHealth(
  options: CheckLocalSeatWakeHealthOptions,
): Promise<LocalSeatWakeHealth> {
  const now = options.now ?? Date.now();
  const isProcessAlive = options.isProcessAlive ?? isLocalPidAlive;
  const warnings: string[] = [];

  const listenerSummary: LocalListenerHealthSummary = {
    state: "missing",
    effective_state: "missing",
    pid_alive: null,
    error_code: null,
    updated_at: null,
    provider: null,
  };

  let paths: ListenerPaths | null = null;
  if (UUID_RE.test(options.workspaceId) && UUID_RE.test(options.principalId)) {
    try {
      paths = listenerPaths({
        profileId: options.profileId,
        workspaceId: options.workspaceId,
        principalId: options.principalId,
        ...(options.stateDirectory !== undefined ? { stateDirectory: options.stateDirectory } : {}),
      });
    } catch {
      paths = null;
    }
  }

  // 1. Local cswarm listen status.json
  if (paths !== null) {
    try {
      const status = await readListenerStatusIfPresent(paths);
      if (status !== null) {
        listenerSummary.state = status.state;
        listenerSummary.effective_state = status.state;
        listenerSummary.updated_at = status.updatedAt;
        listenerSummary.provider = status.provider;
        listenerSummary.error_code = status.lastErrorCode
          ? safeErrorCode(status.lastErrorCode, "unknown")
          : null;

        if (status.state === "failed") {
          const code = safeErrorCode(status.lastErrorCode, "unknown");
          listenerSummary.error_code = code;
          const age = formatAgeFromIso(status.updatedAt, now);
          const fix = listenerFixCommand({
            provider: status.provider,
            profilePath: options.profilePath,
            hostSessionId: options.hostSessionId,
            workspaceId: options.workspaceId,
          });
          warnings.push(
            `cswarm: warning: local listener is failed (${code}, stopped ${age}). Fix: ${fix}`,
          );
        } else if (LISTENER_RUNNING_STATES.includes(status.state)) {
          const alive = isProcessAlive(status.pid);
          listenerSummary.pid_alive = alive;
          if (!alive) {
            listenerSummary.effective_state = "failed";
            listenerSummary.error_code = "unclean_exit";
            const age = formatAgeFromIso(status.updatedAt, now);
            const fix = listenerFixCommand({
              provider: status.provider,
              profilePath: options.profilePath,
              hostSessionId: options.hostSessionId,
              workspaceId: options.workspaceId,
            });
            warnings.push(
              `cswarm: warning: local listener is failed (unclean_exit, stopped ${age}). Fix: ${fix}`,
            );
          }
        }
      }
    } catch {
      // Malformed or inaccessible local status must never break a succeeded command.
    }
  }

  // 2. Local native wake state (wake-state-<hash>.json)
  let nativeWakeSummary: LocalNativeWakeHealthSummary | null = null;
  if (options.profilePath && options.hostSessionId) {
    try {
      const wakeState = await readNativeWakeState(
        options.profilePath,
        options.hostSessionId,
      );
      if (wakeState !== null) {
        const failed = wakeState.wake_failed_at !== null;
        const sanitizedError = failed ? safeWakeError(wakeState.last_error) : null;
        nativeWakeSummary = {
          failed,
          failed_at: wakeState.wake_failed_at,
          error: sanitizedError,
          route: wakeState.route,
        };
        if (failed) {
          const age = formatAgeFromIso(wakeState.wake_failed_at, now);
          const fix = `cswarm receive status --profile ${quoteAgentArgument(options.profilePath)} --host-session-id ${quoteAgentArgument(options.hostSessionId)}`;
          warnings.push(
            `cswarm: warning: native wake failed (${sanitizedError}, ${age}). Fix: ${fix}`,
          );
        }
      }
    } catch {
      // Ignore invalid profile paths or unreadable local wake state.
    }
  }

  // 3. Local attended-watcher canary state (attended-canary.json)
  let attendedCanarySummary: LocalAttendedCanaryHealthSummary | null = null;
  if (paths !== null) {
    const canary = await readAttendedCanaryStatusIfPresent(paths);
    if (canary !== null) {
      const updatedMs = Date.parse(canary.updated_at);
      const lastCheckMs = canary.last_check_at ? Date.parse(canary.last_check_at) : NaN;
      const clearedByCheck =
        Number.isFinite(lastCheckMs) &&
        Number.isFinite(updatedMs) &&
        lastCheckMs >= updatedMs;
      attendedCanarySummary = {
        state: canary.state,
        updated_at: canary.updated_at,
        last_check_at: canary.last_check_at,
        cleared_by_check: clearedByCheck,
      };
      if (canary.state === "stalled_observed" && !clearedByCheck) {
        const age = formatAgeFromIso(canary.updated_at, now);
        warnings.push(
          `cswarm: warning: watcher is polling without waking this session (canary stalled at observed, ${age}). Fix: run cswarm inbox --notify under a waking host (or add --exit-on-arrival) or switch to cswarm receive`,
        );
      }
    }
  }

  return {
    healthy: warnings.length === 0,
    listener: listenerSummary,
    native_wake: nativeWakeSummary,
    attended_canary: attendedCanarySummary,
    warnings,
  };
}
