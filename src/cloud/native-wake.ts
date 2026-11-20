/**
 * Shared native-wake bridge for interactive agent sessions (Codex, Claude Code, Antigravity).
 *
 * Security & cost invariants:
 *   1. Fixed text ONLY: "New CommonSwarm messages (batch N): run cswarm check". Never include
 *      message body, sender, or subject (queued text can arrive with user trust).
 *   2. Wake only the seat's bound session ID; never start a new session or headless worker.
 *   3. Cost controls: wake only on fresh arrival, 5 s debounce, >= 2 min per-seat floor,
 *      at most 1 pending wake per seat until `cswarm check` clears it, and at most 1 retry
 *      after 15 minutes before marking `wake_failed_at` and stopping (C1a raises the alert).
 */
import { dirname, join } from "node:path";
import { readdir } from "node:fs/promises";
import {
  AgentSetupError,
  privatePath,
  profileScopeKey,
  readAgentProfile,
} from "./agent-profile.js";
import {
  checkedHostSessionId,
  readReceiveBinding,
  updateReceiveBinding,
  type ReceiveBinding,
} from "./agent-receive.js";
import {
  readSecureJsonFileIfPresent,
  withFileLock,
  writeSecureJsonFile,
} from "./storage.js";

export const NATIVE_WAKE_ROUTES = [
  "codex-queue",
  "claude-socket",
  "channel",
  "agy-agentapi",
  "none",
] as const;
export type NativeWakeRoute = (typeof NATIVE_WAKE_ROUTES)[number];

export const NATIVE_WAKE_DEBOUNCE_MS = 5_000;
export const NATIVE_WAKE_MIN_INTERVAL_MS = 2 * 60_000;
export const NATIVE_WAKE_RETRY_AFTER_MS = 15 * 60_000;

/** Fixed prompt pattern enforced both when generating and right before invoking any host adapter. */
export const NATIVE_WAKE_PROMPT_RE =
  /^New CommonSwarm messages \(batch ([1-9]\d*)\): run cswarm check$/;

export function formatNativeWakePrompt(batch: number): string {
  if (!Number.isSafeInteger(batch) || batch < 1) {
    throw new AgentSetupError("wake_batch_invalid", "Wake batch counter must be a positive integer.");
  }
  return `New CommonSwarm messages (batch ${batch}): run cswarm check`;
}

export function assertFixedNativeWakePrompt(prompt: string): void {
  if (!NATIVE_WAKE_PROMPT_RE.test(prompt)) {
    throw new AgentSetupError(
      "wake_prompt_unsafe",
      "Native wake prompts must be fixed text with a batch counter and never include message content.",
    );
  }
}

export function wakeRouteForBinding(binding: ReceiveBinding | null): NativeWakeRoute {
  if (!binding || binding.requested_mode !== "wake") return "none";
  if (binding.provider === "codex") return "codex-queue";
  if (binding.provider === "claude" || binding.provider === "grok-bot") return "channel";
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
 * Find any receive binding for this profile when --host-session-id was not passed explicitly.
 * Used by `cswarm whoami` and `cswarm check` (whose fixed wake prompt runs `cswarm check`).
 */
export async function findProfileReceiveBinding(
  profilePath: string,
  hostSessionId?: string,
): Promise<ReceiveBinding | null> {
  const profile = privatePath(profilePath);
  if (hostSessionId !== undefined) {
    return await readReceiveBinding(profile, hostSessionId).catch(() => null);
  }
  const opened = await readAgentProfile(profile).catch(() => null);
  if (opened?.host_session_id) {
    const direct = await readReceiveBinding(profile, opened.host_session_id).catch(() => null);
    if (direct !== null) return direct;
  }
  const dir = dirname(profile);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  let best: ReceiveBinding | null = null;
  for (const name of entries) {
    if (!name.startsWith("receive-") || !name.endsWith(".json")) continue;
    const raw = await readSecureJsonFileIfPresent(join(dir, name), 32 * 1024).catch(() => null);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as Partial<ReceiveBinding>;
      if (parsed.profile !== profile || typeof parsed.host_session_id !== "string") continue;
      const verified = await readReceiveBinding(profile, parsed.host_session_id).catch(() => null);
      if (!verified) continue;
      if (best === null || (verified.requested_mode === "wake" && best.requested_mode !== "wake")) {
        best = verified;
      }
    } catch { /* ignore damaged sibling */ }
  }
  return best;
}

/**
 * Called by `cswarm check` once this seat checks its inbox:
 *   1. Clears pending_batch / retry_sent_at / wake_failed_at so future arrivals can wake again.
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
  const targetHosts = new Set<string>();
  if (options.hostSessionId && options.hostSessionId !== "manual") {
    targetHosts.add(checkedHostSessionId(options.hostSessionId));
  }
  if (binding?.host_session_id && binding.host_session_id !== "manual") {
    targetHosts.add(binding.host_session_id);
  }
  const route = wakeRouteForBinding(binding);
  for (const host of targetHosts) {
    const existing = await readNativeWakeState(profile, host).catch(() => null);
    if (existing !== null) {
      await updateNativeWakeState(profile, host, existing.route, (state) => ({
        ...state,
        pending_batch: null,
        pending_sent_at: null,
        retry_sent_at: null,
        wake_failed_at: null,
        last_ack_at: nowIso,
        last_error: null,
      })).catch(() => undefined);
    } else if (route !== "none") {
      await updateNativeWakeState(profile, host, route, (state) => ({
        ...state,
        last_ack_at: nowIso,
      })).catch(() => undefined);
    }
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
  | { action: "error"; code: string; detail: string }
  | { action: "idle" };

export interface NativeWakeBridgeOptions {
  profilePath: string;
  hostSessionId: string;
  cwd: string;
  adapter: NativeWakeAdapter;
  debounceMs?: number;
  minIntervalMs?: number;
  retryAfterMs?: number;
  now?: () => number;
}

/**
 * Per-seat stateful wake scheduler enforcing debounce, rate floor, single pending wake,
 * and single 15-minute retry before failing closed to `wake_failed`.
 */
export class NativeWakeBridge {
  private readonly profilePath: string;
  private readonly hostSessionId: string;
  private readonly cwd: string;
  private readonly adapter: NativeWakeAdapter;
  private readonly debounceMs: number;
  private readonly minIntervalMs: number;
  private readonly retryAfterMs: number;
  private readonly now: () => number;
  private arrivalQueuedAtMs: number | null = null;
  private inFlight = false;

  constructor(options: NativeWakeBridgeOptions) {
    this.profilePath = privatePath(options.profilePath);
    this.hostSessionId = checkedHostSessionId(options.hostSessionId);
    this.cwd = options.cwd;
    this.adapter = options.adapter;
    this.debounceMs = options.debounceMs ?? NATIVE_WAKE_DEBOUNCE_MS;
    this.minIntervalMs = options.minIntervalMs ?? NATIVE_WAKE_MIN_INTERVAL_MS;
    this.retryAfterMs = options.retryAfterMs ?? NATIVE_WAKE_RETRY_AFTER_MS;
    this.now = options.now ?? Date.now;
  }

  /** Record a fresh arrival; coalesced by the 5 s debounce window. */
  notifyArrival(): void {
    const t = this.now();
    if (this.arrivalQueuedAtMs === null) {
      this.arrivalQueuedAtMs = t;
    }
  }

  /** Inspect state and send at most one fixed-text wake if eligible (or handle 15-min retry / failure). */
  async tick(signal?: AbortSignal): Promise<NativeWakeDecision> {
    if (this.inFlight) return { action: "idle" };
    this.inFlight = true;
    try {
      const nowMs = this.now();
      const nowIso = new Date(nowMs).toISOString();
      const state =
        (await readNativeWakeState(this.profilePath, this.hostSessionId)) ??
        emptyNativeWakeState(this.profilePath, this.hostSessionId, this.adapter.route);

      // 1. Existing unacked pending wake: enforce 1 pending wake + 1 retry after 15 min -> wake_failed.
      if (state.pending_batch !== null && state.pending_sent_at !== null) {
        this.arrivalQueuedAtMs = null; // Pending wake already covers fresh arrivals until cswarm check runs.
        if (state.wake_failed_at !== null) {
          return { action: "wake_failed", batch: state.pending_batch };
        }
        const sentAtMs = Date.parse(state.pending_sent_at);
        if (state.retry_sent_at === null) {
          if (nowMs - sentAtMs < this.retryAfterMs) {
            return { action: "pending", batch: state.pending_batch };
          }
          return await this.dispatchWake(state, true, nowMs, nowIso, signal);
        }
        const retryAtMs = Date.parse(state.retry_sent_at);
        if (nowMs - retryAtMs >= this.retryAfterMs) {
          await updateNativeWakeState(
            this.profilePath,
            this.hostSessionId,
            this.adapter.route,
            (cur) => ({
              ...cur,
              wake_failed_at: cur.wake_failed_at ?? nowIso,
            }),
          );
          return { action: "wake_failed", batch: state.pending_batch };
        }
        return { action: "pending", batch: state.pending_batch };
      }

      // 2. No pending wake: only wake when something actually arrived.
      if (this.arrivalQueuedAtMs === null) {
        return { action: "idle" };
      }

      // 3. 5 s debounce coalescing bursts into one wake.
      const debounceDue = this.arrivalQueuedAtMs + this.debounceMs;
      if (nowMs < debounceDue) {
        return { action: "debouncing", dueAtMs: debounceDue };
      }

      // 4. Per-seat floor: at most one wake every 2 minutes.
      if (state.last_wake_at !== null) {
        const lastWakeMs = Date.parse(state.last_wake_at);
        const rateDue = lastWakeMs + this.minIntervalMs;
        if (Number.isFinite(lastWakeMs) && nowMs < rateDue) {
          return { action: "rate_limited", dueAtMs: rateDue };
        }
      }

      return await this.dispatchWake(state, false, nowMs, nowIso, signal);
    } finally {
      this.inFlight = false;
    }
  }

  private async dispatchWake(
    state: NativeWakeState,
    isRetry: boolean,
    nowMs: number,
    nowIso: string,
    signal?: AbortSignal,
  ): Promise<NativeWakeDecision> {
    const nextBatch = state.batch + 1;
    const prompt = formatNativeWakePrompt(nextBatch);
    assertFixedNativeWakePrompt(prompt);
    const outcome = await this.adapter.sendWake({
      hostSessionId: this.hostSessionId,
      prompt,
      batch: nextBatch,
      cwd: this.cwd,
      ...(signal ? { signal } : {}),
    });
    if (!outcome.ok) {
      await updateNativeWakeState(
        this.profilePath,
        this.hostSessionId,
        this.adapter.route,
        (cur) => ({
          ...cur,
          route: this.adapter.route,
          last_error: `${outcome.code}: ${outcome.detail}`.slice(0, 240),
        }),
      );
      return { action: "error", code: outcome.code, detail: outcome.detail };
    }
    this.arrivalQueuedAtMs = null;
    const sentIso = new Date(Math.max(nowMs, this.now())).toISOString();
    await updateNativeWakeState(
      this.profilePath,
      this.hostSessionId,
      this.adapter.route,
      (cur) => ({
        ...cur,
        route: this.adapter.route,
        batch: nextBatch,
        pending_batch: nextBatch,
        pending_sent_at: isRetry ? (cur.pending_sent_at ?? sentIso) : sentIso,
        retry_sent_at: isRetry ? sentIso : null,
        last_wake_at: sentIso,
        wake_failed_at: null,
        last_error: null,
      }),
    );
    return { action: "sent", batch: nextBatch, retry: isRetry };
  }
}
