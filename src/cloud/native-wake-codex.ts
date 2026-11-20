/**
 * Native Codex wake adapter (`codex queue --thread <CODEX_THREAD_ID> --message "<fixed>"`)
 * and standalone `cswarm receive serve` bridge for Codex interactive TUI sessions.
 *
 * Security & operational invariants:
 *   - Fixed text ONLY (verified by assertFixedNativeWakePrompt right before execFile).
 *   - Bound session UUID ONLY (ONBOARDING_UUID); never passes --resume or --remote.
 *   - Read-only arrival detection: never claims/acks deliveries before the Codex session itself
 *     runs `cswarm check`, so C1a `agent_unseen` remains truthful if a wake is missed.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { createWakeSubscriber, type WakeHandle } from "../listener/wake.js";
import { assertProfileIdentity } from "./agent-check.js";
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
import { readSecureJsonFileIfPresent, withFileLock } from "./storage.js";

const execFileAsync = promisify(execFile);

const CODEX_WAKE_HEARTBEAT_MS = 5_000;
const CODEX_WAKE_POLL_MS = 30_000;
const CODEX_QUEUE_TIMEOUT_MS = 15_000;

export type CodexQueueRunner = (
  executable: string,
  args: readonly string[],
  options: { cwd: string; timeoutMs: number; signal?: AbortSignal },
) => Promise<{ stdout: string; stderr: string }>;

const defaultCodexQueueRunner: CodexQueueRunner = async (executable, args, options) => {
  const result = await execFileAsync(executable, [...args], {
    cwd: options.cwd,
    timeout: options.timeoutMs,
    maxBuffer: 64 * 1024,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return {
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
};

export interface CodexQueueAdapterOptions {
  codexExecutable?: string;
  runner?: CodexQueueRunner;
  timeoutMs?: number;
}

/**
 * Calls `codex queue --thread <uuid> --message "<fixed text>"` with NO `--resume` and NO `--remote`.
 */
export class CodexQueueAdapter implements NativeWakeAdapter {
  readonly route = "codex-queue" as const;
  private readonly executable: string;
  private readonly runner: CodexQueueRunner;
  private readonly timeoutMs: number;

  constructor(options: CodexQueueAdapterOptions = {}) {
    this.executable = options.codexExecutable ?? "codex";
    this.runner = options.runner ?? defaultCodexQueueRunner;
    this.timeoutMs = options.timeoutMs ?? CODEX_QUEUE_TIMEOUT_MS;
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
        code: "codex_thread_id_invalid",
        detail: "Codex native wake requires a bound session UUID ($CODEX_THREAD_ID).",
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
    // Never pass --resume or --remote: queueing writes into ~/.codex/queue_1.sqlite and the
    // already-open interactive Codex TUI polls and dispatches only when idle.
    const argv = ["queue", "--thread", input.hostSessionId, "--message", input.prompt] as const;
    try {
      await this.runner(this.executable, argv, {
        cwd: input.cwd,
        timeoutMs: this.timeoutMs,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      return { ok: true };
    } catch (error) {
      const err = error as NodeJS.ErrnoException & { stderr?: string };
      const code = err.code === "ENOENT" ? "codex_not_found" : "codex_queue_failed";
      const detail = (typeof err.stderr === "string" && err.stderr.trim()) || err.message || code;
      return { ok: false, code, detail: detail.slice(0, 240) };
    }
  }
}

function codexCanaryBody(nonce: string): string {
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

export interface ServeCodexWakeBridgeOptions {
  profilePath: string;
  hostSessionId: string;
  codexExecutable?: string;
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
 * Long-lived bridge for `cswarm receive serve --profile P --host-session-id "$CODEX_THREAD_ID"`
 * on a Codex seat. Watches read-only inbox arrivals (Realtime push + bounded reconcile poll) and
 * nudges the bound Codex TUI via `codex queue` with fixed text only.
 */
export async function serveCodexWakeBridge(options: ServeCodexWakeBridgeOptions): Promise<void> {
  const profilePath = privatePath(options.profilePath);
  const host = options.hostSessionId;
  if (!ONBOARDING_UUID.test(host)) {
    throw new AgentSetupError(
      "codex_thread_id_required",
      "Codex wake requires this session's $CODEX_THREAD_ID UUID as --host-session-id.",
    );
  }
  const initialAuth = await resolveAuthorizedWakeBinding({
    profilePath,
    hostSessionId: host,
    expectedProvider: "codex",
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
  const pollMs = options.pollMs ?? CODEX_WAKE_POLL_MS;
  const heartbeatMs = options.heartbeatMs ?? CODEX_WAKE_HEARTBEAT_MS;
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
  const adapter = options.adapter ?? new CodexQueueAdapter({
    ...(options.codexExecutable ? { codexExecutable: options.codexExecutable } : {}),
  });
  const bridge = new NativeWakeBridge({
    profilePath,
    hostSessionId: host,
    cwd: initial.cwd,
    adapter,
    expectedProvider: "codex",
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
    // Anchor baseline before announcing channel_running so any arrival after startup wakes.
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

  const touch = async () =>
    updateReceiveBinding(profilePath, host, (b) => {
      if (b.channel_instance_id !== runtimeId || b.requested_mode !== "wake") {
        stop();
        return b;
      }
      return { ...b, channel_heartbeat_at: new Date(now()).toISOString() };
    });

  try {
    heartbeat = setInterval(() => {
      void touch().catch(stop);
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
        expectedProvider: "codex",
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

        // Emit self-addressed canary once the session is idle (proven by Stop hook or explicit idle).
        if (binding.canary && binding.canary.signal_id === null && binding.idle) {
          const result = await sender.sendSignal({
            workspaceId: profile.workspace_id,
            credential: token,
            commandId: `canary_${binding.canary.nonce.replace(/-/g, "")}`,
            command: {
              kind: "post_signal",
              signal_kind: "note",
              body: codexCanaryBody(binding.canary.nonce),
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
        if (decision.action === "error" && decision.code !== lastErrorCode) {
          process.stderr.write(`CommonSwarm codex wake: ${decision.code}: ${decision.detail}\n`);
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
        const code = error instanceof AgentSetupError ? error.code : "codex_wake_poll_failed";
        if (code !== lastErrorCode) {
          process.stderr.write(`CommonSwarm codex wake: ${code}. Check cswarm receive status.\n`);
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
