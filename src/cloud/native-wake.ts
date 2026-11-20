/**
 * Shared native-wake bridge (fixed text only, bound session only, shared cost controls).
 *
 * Security & cost invariants:
 *   - Fixed text ONLY: "New CommonSwarm messages (batch N): run cswarm check".
 *     Message bodies, senders, subjects, and channel names must NEVER enter the wake prompt.
 *   - Bound session ONLY: live verification against the private host-bound profile and its
 *     opted-in receive binding happens inside the shared file lock immediately before dispatch.
 *   - Shared cross-entry-point reservation: `cswarm listen` and `cswarm receive serve` share one
 *     file-locked state file, charge attempts & rate slots BEFORE subprocess execution, and keep
 *     the budget spent on refused or ambiguous subprocess results so loops cannot spin.
 *   - Cost controls:
 *       * wake only when something arrives;
 *       * 5 s debounce coalescing bursts;
 *       * at most 1 wake every 2 minutes per seat;
 *       * 1 pending wake per seat until `cswarm check` acknowledges;
 *       * 1 retry after 15 minutes, then `wake_failed` (C1a `agent_unseen` surfaces to lead/sender).
 */
import { dirname, join } from "node:path";
import {
  AgentSetupError,
  ONBOARDING_UUID,
  privatePath,
  profileScopeKey,
  readAgentProfile,
  type AgentProfile,
} from "./agent-profile.js";
import {
  checkedHostSessionId,
  readReceiveBinding,
  updateReceiveBinding,
  type ReceiveBinding,
} from "./agent-receive.js";

type ReceiveProvider = ReceiveBinding["provider"];
import { readSecureJsonFileIfPresent, withFileLock, writeSecureJsonFile } from "./storage.js";

export const NATIVE_WAKE_DEBOUNCE_MS = 5_000;
export const NATIVE_WAKE_MIN_INTERVAL_MS = 2 * 60_000;
export const NATIVE_WAKE_RETRY_AFTER_MS = 15 * 60_000;

export const NATIVE_WAKE_ROUTES = [
  "codex-queue",
  "claude-socket",
  "channel",
  "agy-agentapi",
  "none",
] as const;
export type NativeWakeRoute = (typeof NATIVE_WAKE_ROUTES)[number];

const FIXED_NATIVE_WAKE_PROMPT_RE = /^New CommonSwarm messages \(batch ([1-9][0-9]*)\): run cswarm check$/;

/** Build the ONLY wake prompt text allowed across every native wake adapter. */
export function formatNativeWakePrompt(batch: number): string {
  if (!Number.isSafeInteger(batch) || batch < 1) {
    throw new Error("wake batch must be a positive integer");
  }
  return `New CommonSwarm messages (batch ${batch}): run cswarm check`;
}

/** Hard invariant check immediately before any wake adapter submits a prompt to a host session. */
export function assertFixedNativeWakePrompt(prompt: string): number {
  const match = FIXED_NATIVE_WAKE_PROMPT_RE.exec(prompt);
  if (!match) {
    throw new Error("refusing non-fixed native wake prompt");
  }
  return Number.parseInt(match[1]!, 10);
}

/** Map a local receive binding to its public wake route label (`whoami` and `receive status`). */
export function wakeRouteForBinding(binding: ReceiveBinding | null): NativeWakeRoute {
  if (!binding || binding.requested_mode !== "wake") return "none";
  if (binding.provider === "codex") return "codex-queue";
  if (binding.provider === "claude") return "channel";
  if (binding.provider === "grok-bot") return "channel";
  return "none";
}

export interface NativeWakeState {
  version: 1;
  profile: string;
  host_session_id: string;
  route: NativeWakeRoute;
  batch: number;
  pending_batch: number | null;
  pending_sent_at: string | null;
  retry_sent_at: string | null;
  last_wake_at: string | null;
  last_ack_at: string | null;
  wake_failed_at: string | null;
  last_error: string | null;
}

export interface NativeWakeAdapter {
  readonly route: Exclude<NativeWakeRoute, "none">;
  sendWake(input: {
    hostSessionId: string;
    prompt: string;
    batch: number;
    cwd: string;
    signal?: AbortSignal;
  }): Promise<{ ok: true } | { ok: false; code: string; detail: string }>;
}

export interface WakeSeatExpectation {
  workspaceId: string;
  principalId: string;
}

export type AuthorizedWakeBindingResult =
  | { ok: true; profile: AgentProfile; binding: ReceiveBinding }
  | { ok: false; code: string; detail: string };

export function nativeWakeStatePath(profilePath: string, hostSessionId: string): string {
  const profile = privatePath(profilePath);
  const host = checkedHostSessionId(hostSessionId);
  return join(dirname(profile), `wake-state-${profileScopeKey(host)}.json`);
}

function emptyNativeWakeState(
  profile: string,
  hostSessionId: string,
  route: NativeWakeRoute,
): NativeWakeState {
  return {
    version: 1,
    profile,
    host_session_id: hostSessionId,
    route,
    batch: 0,
    pending_batch: null,
    pending_sent_at: null,
    retry_sent_at: null,
    last_wake_at: null,
    last_ack_at: null,
    wake_failed_at: null,
    last_error: null,
  };
}

function parseNativeWakeState(
  raw: string,
  expectedProfile: string,
  expectedHost: string,
): NativeWakeState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const s = parsed as Record<string, unknown>;
  const nullableTime = (v: unknown) =>
    v === null || (typeof v === "string" && Number.isFinite(Date.parse(v)));
  if (
    s.version !== 1 ||
    s.profile !== expectedProfile ||
    s.host_session_id !== expectedHost ||
    typeof s.route !== "string" ||
    !(NATIVE_WAKE_ROUTES as readonly string[]).includes(s.route) ||
    typeof s.batch !== "number" ||
    !Number.isSafeInteger(s.batch) ||
    s.batch < 0 ||
    !(s.pending_batch === null || (typeof s.pending_batch === "number" && Number.isSafeInteger(s.pending_batch) && s.pending_batch >= 1)) ||
    !nullableTime(s.pending_sent_at) ||
    !nullableTime(s.retry_sent_at) ||
    !nullableTime(s.last_wake_at) ||
    !nullableTime(s.last_ack_at) ||
    !nullableTime(s.wake_failed_at) ||
    !(s.last_error === null || typeof s.last_error === "string")
  ) {
    return null;
  }
  return s as unknown as NativeWakeState;
}

export async function readNativeWakeState(
  profilePath: string,
  hostSessionId: string,
): Promise<NativeWakeState | null> {
  const profile = privatePath(profilePath);
  const host = checkedHostSessionId(hostSessionId);
  const raw = await readSecureJsonFileIfPresent(nativeWakeStatePath(profile, host), 16 * 1024);
  if (raw === null) return null;
  return parseNativeWakeState(raw, profile, host);
}

async function updateNativeWakeState(
  profilePath: string,
  hostSessionId: string,
  route: NativeWakeRoute,
  mutate: (current: NativeWakeState) => NativeWakeState,
): Promise<NativeWakeState> {
  const profile = privatePath(profilePath);
  const host = checkedHostSessionId(hostSessionId);
  const path = nativeWakeStatePath(profile, host);
  return withFileLock(dirname(path), `wake-state-${profileScopeKey(host)}`, async () => {
    const raw = await readSecureJsonFileIfPresent(path, 16 * 1024);
    const current =
      (raw !== null ? parseNativeWakeState(raw, profile, host) : null) ??
      emptyNativeWakeState(profile, host, route);
    const next = mutate(current);
    await writeSecureJsonFile(path, JSON.stringify(next));
    return next;
  }, { timeoutMs: 2_000 });
}

/**
 * Look up the exact receive binding for this profile and host session.
 * Never scans the profile directory for sibling bindings.
 */
export async function findProfileReceiveBinding(
  profilePath: string,
  hostSessionId?: string,
): Promise<ReceiveBinding | null> {
  const profile = privatePath(profilePath);
  let opened: AgentProfile;
  try {
    opened = await readAgentProfile(profile, hostSessionId);
  } catch {
    return null;
  }
  const targetHost = opened.host_session_id ?? hostSessionId;
  if (targetHost === undefined) return null;
  if (hostSessionId !== undefined && opened.host_session_id !== undefined && hostSessionId !== opened.host_session_id) {
    return null;
  }
  const binding = await readReceiveBinding(profile, targetHost).catch(() => null);
  if (!binding || binding.profile !== profile || binding.host_session_id !== targetHost) {
    return null;
  }
  return binding;
}

/**
 * Live authorization check for native wake dispatch.
 * Requires an existing private host-bound profile matching this exact seat/profile/session tuple
 * and a receive binding for the expected provider that is still opted into `wake` mode.
 */
export async function resolveAuthorizedWakeBinding(options: {
  profilePath: string;
  hostSessionId?: string;
  expectedProvider: ReceiveProvider;
  expectedSeat?: WakeSeatExpectation;
}): Promise<AuthorizedWakeBindingResult> {
  let profile: string;
  try {
    profile = privatePath(options.profilePath);
  } catch (error) {
    return {
      ok: false,
      code: error instanceof AgentSetupError ? error.code : "profile_path_invalid",
      detail: error instanceof Error ? error.message : "Invalid profile path.",
    };
  }
  if (options.hostSessionId === undefined) {
    return {
      ok: false,
      code: "host_session_required",
      detail: "Native wake requires an explicit bound --host-session-id.",
    };
  }
  let host: string;
  try {
    host = checkedHostSessionId(options.hostSessionId);
  } catch (error) {
    return {
      ok: false,
      code: error instanceof AgentSetupError ? error.code : "host_session_invalid",
      detail: error instanceof Error ? error.message : "Invalid host session ID.",
    };
  }
  let opened: AgentProfile;
  try {
    opened = await readAgentProfile(profile, host);
  } catch (error) {
    return {
      ok: false,
      code: error instanceof AgentSetupError ? error.code : "profile_unreadable",
      detail: error instanceof Error ? error.message : "Profile could not be verified.",
    };
  }
  if (opened.host_session_id === undefined || opened.host_session_id !== host) {
    return {
      ok: false,
      code: "profile_not_host_bound",
      detail: "Native wake requires a private host-bound profile matching this session.",
    };
  }
  if (
    options.expectedSeat !== undefined &&
    (opened.workspace_id !== options.expectedSeat.workspaceId ||
      opened.principal_id !== options.expectedSeat.principalId)
  ) {
    return {
      ok: false,
      code: "wake_seat_mismatch",
      detail: "Wake profile workspace or principal does not match this listener seat.",
    };
  }
  if (options.expectedProvider === "codex" && !ONBOARDING_UUID.test(host)) {
    return {
      ok: false,
      code: "codex_thread_id_required",
      detail: "Codex native wake requires a bound $CODEX_THREAD_ID UUID.",
    };
  }
  const binding = await readReceiveBinding(profile, host).catch(() => null);
  if (!binding) {
    return {
      ok: false,
      code: "receive_binding_missing",
      detail: "No receive binding exists for this profile and host session.",
    };
  }
  if (binding.profile !== profile || binding.host_session_id !== host) {
    return {
      ok: false,
      code: "receive_binding_mismatch",
      detail: "Receive binding does not match this profile and host session.",
    };
  }
  if (binding.provider !== options.expectedProvider) {
    return {
      ok: false,
      code: "receive_provider_mismatch",
      detail: `Receive binding belongs to provider ${binding.provider}, not ${options.expectedProvider}.`,
    };
  }
  if (binding.requested_mode !== "wake") {
    return {
      ok: false,
      code: "wake_opted_out",
      detail: "This seat is no longer opted into wake mode.",
    };
  }
  return { ok: true, profile: opened, binding };
}

/**
 * Called by `cswarm check` once this seat checks its inbox:
 *   1. Clears pending_batch / retry_sent_at / wake_failed_at so future arrivals can wake again
 *      (preserving `last_wake_at` so the 2-minute rate floor remains enforced).
 *   2. For a codex-queue binding with an idle-emitted canary whose signal was surfaced by this
 *      check, marks wake_verified_at so `receive status` and `whoami` report wake_verified: true.
 */
export async function acknowledgeNativeWakeOnCheck(options: {
  profilePath: string;
  hostSessionId?: string;
  surfacedSignalIds?: readonly string[];
  now?: () => number;
}): Promise<void> {
  const nowMs = (options.now ?? Date.now)();
  const nowIso = new Date(nowMs).toISOString();
  const profile = privatePath(options.profilePath);
  const binding = await findProfileReceiveBinding(profile, options.hostSessionId);
  const targetHost = binding?.host_session_id ??
    (options.hostSessionId && options.hostSessionId !== "manual"
      ? checkedHostSessionId(options.hostSessionId)
      : null);
  if (targetHost === null || targetHost === "manual") return;

  const route = wakeRouteForBinding(binding);
  const existing = await readNativeWakeState(profile, targetHost).catch(() => null);
  if (existing !== null) {
    await updateNativeWakeState(profile, targetHost, existing.route, (state) => ({
      ...state,
      pending_batch: null,
      pending_sent_at: null,
      retry_sent_at: null,
      wake_failed_at: null,
      last_ack_at: nowIso,
      last_error: null,
    })).catch(() => undefined);
  } else if (route !== "none") {
    await updateNativeWakeState(profile, targetHost, route, (state) => ({
      ...state,
      last_ack_at: nowIso,
    })).catch(() => undefined);
  }

  if (
    binding &&
    binding.provider === "codex" &&
    binding.requested_mode === "wake" &&
    binding.canary !== null &&
    binding.canary.emitted_while_idle &&
    binding.canary.signal_id !== null &&
    binding.canary.received_at === null &&
    (options.surfacedSignalIds ?? []).includes(binding.canary.signal_id)
  ) {
    const canaryNonce = binding.canary.nonce;
    await updateReceiveBinding(profile, binding.host_session_id, (current) => {
      if (
        current.requested_mode !== "wake" ||
        current.canary === null ||
        current.canary.nonce !== canaryNonce ||
        !current.canary.emitted_while_idle
      ) {
        return current;
      }
      return {
        ...current,
        wake_verified_at: nowIso,
        canary: { ...current.canary, received_at: nowIso },
      };
    }).catch(() => undefined);
  }
}

export type NativeWakeDecision =
  | { action: "sent"; batch: number; retry: boolean }
  | { action: "debouncing"; dueAtMs: number }
  | { action: "rate_limited"; dueAtMs: number }
  | { action: "pending"; batch: number }
  | { action: "wake_failed"; batch: number }
  | { action: "binding_inactive"; code: string; detail: string }
  | { action: "error"; code: string; detail: string }
  | { action: "idle" };

export interface NativeWakeBridgeOptions {
  profilePath: string;
  hostSessionId: string;
  cwd: string;
  adapter: NativeWakeAdapter;
  expectedProvider?: ReceiveProvider;
  expectedSeat?: WakeSeatExpectation;
  debounceMs?: number;
  minIntervalMs?: number;
  retryAfterMs?: number;
  now?: () => number;
  /** Test seam invoked after a wake is durably reserved and before acquiring the receive dispatch lock. */
  beforeDispatch?: (batch: number) => Promise<void> | void;
}

function defaultProviderForRoute(route: Exclude<NativeWakeRoute, "none">): ReceiveProvider {
  if (route === "codex-queue") return "codex";
  return "claude";
}

type ReservationOutcome =
  | { kind: "decision"; decision: NativeWakeDecision }
  | { kind: "dispatch"; batch: number; isRetry: boolean; cwd: string };

/**
 * Per-seat stateful wake scheduler enforcing live binding verification, cross-process atomic
 * reservation before dispatch, 5 s debounce, 2-minute rate floor, single pending wake, and
 * single 15-minute retry before failing closed to `wake_failed`.
 */
export class NativeWakeBridge {
  private readonly profilePath: string;
  private readonly hostSessionId: string;
  private readonly cwd: string;
  private readonly adapter: NativeWakeAdapter;
  private readonly expectedProvider: ReceiveProvider;
  private readonly expectedSeat: WakeSeatExpectation | undefined;
  private readonly debounceMs: number;
  private readonly minIntervalMs: number;
  private readonly retryAfterMs: number;
  private readonly now: () => number;
  private readonly beforeDispatch: ((batch: number) => Promise<void> | void) | undefined;
  private arrivalQueuedAtMs: number | null = null;
  private inFlight = false;

  constructor(options: NativeWakeBridgeOptions) {
    this.profilePath = privatePath(options.profilePath);
    this.hostSessionId = checkedHostSessionId(options.hostSessionId);
    this.cwd = options.cwd;
    this.adapter = options.adapter;
    this.expectedProvider = options.expectedProvider ?? defaultProviderForRoute(options.adapter.route);
    this.expectedSeat = options.expectedSeat;
    this.debounceMs = options.debounceMs ?? NATIVE_WAKE_DEBOUNCE_MS;
    this.minIntervalMs = options.minIntervalMs ?? NATIVE_WAKE_MIN_INTERVAL_MS;
    this.retryAfterMs = options.retryAfterMs ?? NATIVE_WAKE_RETRY_AFTER_MS;
    this.now = options.now ?? Date.now;
    this.beforeDispatch = options.beforeDispatch;
  }

  /** Record a fresh arrival; coalesced by the 5 s debounce window. */
  notifyArrival(): void {
    const t = this.now();
    if (this.arrivalQueuedAtMs === null) {
      this.arrivalQueuedAtMs = t;
    }
  }

  /**
   * Atomically verify the live binding, reserve at most one wake slot under the shared file lock,
   * and dispatch the fixed-text wake subprocess if reserved.
   */
  async tick(signal?: AbortSignal): Promise<NativeWakeDecision> {
    if (this.inFlight) return { action: "idle" };
    this.inFlight = true;
    try {
      const statePath = nativeWakeStatePath(this.profilePath, this.hostSessionId);
      const lockName = `wake-state-${profileScopeKey(this.hostSessionId)}`;
      const reservation = await withFileLock<ReservationOutcome>(
        dirname(statePath),
        lockName,
        async () => {
          const auth = await resolveAuthorizedWakeBinding({
            profilePath: this.profilePath,
            hostSessionId: this.hostSessionId,
            expectedProvider: this.expectedProvider,
            ...(this.expectedSeat ? { expectedSeat: this.expectedSeat } : {}),
          });
          if (!auth.ok) {
            this.arrivalQueuedAtMs = null;
            return {
              kind: "decision",
              decision: { action: "binding_inactive", code: auth.code, detail: auth.detail },
            };
          }

          const nowMs = this.now();
          const nowIso = new Date(nowMs).toISOString();
          const raw = await readSecureJsonFileIfPresent(statePath, 16 * 1024);
          const state =
            (raw !== null ? parseNativeWakeState(raw, this.profilePath, this.hostSessionId) : null) ??
            emptyNativeWakeState(this.profilePath, this.hostSessionId, this.adapter.route);

          // 1. Existing unacked pending wake: enforce 1 pending wake + 1 retry after 15 min -> wake_failed.
          if (state.pending_batch !== null && state.pending_sent_at !== null) {
            this.arrivalQueuedAtMs = null;
            if (state.wake_failed_at !== null) {
              return { kind: "decision", decision: { action: "wake_failed", batch: state.pending_batch } };
            }
            const sentAtMs = Date.parse(state.pending_sent_at);
            if (state.retry_sent_at === null) {
              if (nowMs - sentAtMs < this.retryAfterMs) {
                return { kind: "decision", decision: { action: "pending", batch: state.pending_batch } };
              }
              // Reserve the single retry slot BEFORE releasing the lock / running the subprocess.
              const nextBatch = state.batch + 1;
              const reserved: NativeWakeState = {
                ...state,
                route: this.adapter.route,
                batch: nextBatch,
                pending_batch: nextBatch,
                pending_sent_at: state.pending_sent_at,
                retry_sent_at: nowIso,
                last_wake_at: nowIso,
                wake_failed_at: null,
                last_error: null,
              };
              await writeSecureJsonFile(statePath, JSON.stringify(reserved));
              return { kind: "dispatch", batch: nextBatch, isRetry: true, cwd: auth.binding.cwd };
            }
            const retryAtMs = Date.parse(state.retry_sent_at);
            if (nowMs - retryAtMs >= this.retryAfterMs) {
              const failed: NativeWakeState = {
                ...state,
                wake_failed_at: state.wake_failed_at ?? nowIso,
              };
              await writeSecureJsonFile(statePath, JSON.stringify(failed));
              return { kind: "decision", decision: { action: "wake_failed", batch: state.pending_batch } };
            }
            return { kind: "decision", decision: { action: "pending", batch: state.pending_batch } };
          }

          // 2. No pending wake: only wake when something actually arrived.
          if (this.arrivalQueuedAtMs === null) {
            return { kind: "decision", decision: { action: "idle" } };
          }

          // 3. 5 s debounce coalescing bursts into one wake.
          const debounceDue = this.arrivalQueuedAtMs + this.debounceMs;
          if (nowMs < debounceDue) {
            return { kind: "decision", decision: { action: "debouncing", dueAtMs: debounceDue } };
          }

          // 4. Per-seat floor: at most one wake every 2 minutes.
          if (state.last_wake_at !== null) {
            const lastWakeMs = Date.parse(state.last_wake_at);
            const rateDue = lastWakeMs + this.minIntervalMs;
            if (Number.isFinite(lastWakeMs) && nowMs < rateDue) {
              return { kind: "decision", decision: { action: "rate_limited", dueAtMs: rateDue } };
            }
          }

          // Reserve the initial wake slot and charge the rate floor BEFORE subprocess execution.
          const nextBatch = state.batch + 1;
          this.arrivalQueuedAtMs = null;
          const reserved: NativeWakeState = {
            ...state,
            route: this.adapter.route,
            batch: nextBatch,
            pending_batch: nextBatch,
            pending_sent_at: nowIso,
            retry_sent_at: null,
            last_wake_at: nowIso,
            wake_failed_at: null,
            last_error: null,
          };
          await writeSecureJsonFile(statePath, JSON.stringify(reserved));
          return { kind: "dispatch", batch: nextBatch, isRetry: false, cwd: auth.binding.cwd };
        },
        { timeoutMs: 2_000 },
      );

      if (reservation.kind === "decision") {
        return reservation.decision;
      }

      if (this.beforeDispatch !== undefined) {
        await this.beforeDispatch(reservation.batch);
      }

      const prompt = formatNativeWakePrompt(reservation.batch);
      assertFixedNativeWakePrompt(prompt);

      // Hold the exact same receive-<scope> lock that configureAgentReceive(--mode turn) uses,
      // re-check live opt-in immediately before execFile, and serialize subprocess execution
      // against opt-out so a wake can NEVER be queued after opt-out completes.
      const receiveLockName = `receive-${profileScopeKey(this.hostSessionId)}`;
      const dispatchOutcome = await withFileLock<
        | { kind: "binding_inactive"; code: string; detail: string }
        | { kind: "ok" }
        | { kind: "error"; code: string; detail: string }
      >(
        dirname(this.profilePath),
        receiveLockName,
        async () => {
          const liveAuth = await resolveAuthorizedWakeBinding({
            profilePath: this.profilePath,
            hostSessionId: this.hostSessionId,
            expectedProvider: this.expectedProvider,
            ...(this.expectedSeat ? { expectedSeat: this.expectedSeat } : {}),
          });
          if (!liveAuth.ok) {
            return { kind: "binding_inactive", code: liveAuth.code, detail: liveAuth.detail };
          }
          try {
            const outcome = await this.adapter.sendWake({
              hostSessionId: this.hostSessionId,
              prompt,
              batch: reservation.batch,
              cwd: liveAuth.binding.cwd || reservation.cwd || this.cwd,
              ...(signal ? { signal } : {}),
            });
            return outcome.ok
              ? { kind: "ok" }
              : { kind: "error", code: outcome.code, detail: outcome.detail };
          } catch (error) {
            return {
              kind: "error",
              code: "wake_dispatch_ambiguous",
              detail: error instanceof Error ? error.message : "Wake adapter threw unexpectedly.",
            };
          }
        },
        { timeoutMs: 20_000 },
      );

      if (dispatchOutcome.kind === "binding_inactive") {
        await updateNativeWakeState(
          this.profilePath,
          this.hostSessionId,
          this.adapter.route,
          (cur) => ({
            ...cur,
            route: this.adapter.route,
            last_error: `${dispatchOutcome.code}: ${dispatchOutcome.detail}`.slice(0, 240),
          }),
        );
        return {
          action: "binding_inactive",
          code: dispatchOutcome.code,
          detail: dispatchOutcome.detail,
        };
      }
      if (dispatchOutcome.kind === "error") {
        // Keep the charged reservation (pending_batch, retry_sent_at, last_wake_at) intact so
        // refused or ambiguous subprocess results cannot bypass the rate floor or single-retry cap.
        await updateNativeWakeState(
          this.profilePath,
          this.hostSessionId,
          this.adapter.route,
          (cur) => ({
            ...cur,
            route: this.adapter.route,
            last_error: `${dispatchOutcome.code}: ${dispatchOutcome.detail}`.slice(0, 240),
          }),
        );
        return { action: "error", code: dispatchOutcome.code, detail: dispatchOutcome.detail };
      }
      return { action: "sent", batch: reservation.batch, retry: reservation.isRetry };
    } finally {
      this.inFlight = false;
    }
  }
}
