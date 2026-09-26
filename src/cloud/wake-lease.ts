import { randomUUID } from "node:crypto";
import { commandEndpoint, readEndpoint, type CloudTarget } from "./config.js";
import { CLIENT_PROTOCOL_VERSION } from "./config.js";
import { isAgentSessionErrorCode } from "./session-contract.js";
import {
  NOTIFY_LEASE_EXITS, WAKE_LEASE_RENEW_MS, wakeLeaseExitSentence, wakeLeaseRule,
  type NotifyLeaseCode, type WakeLeasePhase,
} from "./wake-lease-constants.js";

export interface AgentWakeLease {
  watcher_id: string;
  host_label: string;
  generation: number;
  renewed_age_ms: number;
}

export class WakeLeaseLostError extends Error {
  readonly exitCode: number;
  constructor(
    readonly code: NotifyLeaseCode,
    readonly surface: "watcher" | "h0_poll" | "session",
    readonly host: string | null,
    restartCommand: string | null,
    phase: WakeLeasePhase = "renew",
    sessionContextPath?: string,
    remedyCommand?: string,
    contextSource?: "operator" | "profile",
    fallback?: string,
  ) {
    super(wakeLeaseExitSentence(code, surface === "session" ? "watcher" : surface,
      host, restartCommand, phase, sessionContextPath, remedyCommand, contextSource, fallback));
    this.name = "WakeLeaseLostError";
    this.exitCode = wakeLeaseRule(code, phase).exit;
  }
}

export class WakeLeaseTransientError extends Error {
  constructor(readonly status: number | null, cause?: unknown) {
    super(status === null ? "wake lease transport failed" : `wake lease command failed (HTTP ${status})`, { cause });
    this.name = "WakeLeaseTransientError";
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export async function sendWakeLeaseCommand(options: {
  target: CloudTarget;
  workspaceId: string;
  token: string;
  command: Record<string, unknown>;
  restartCommand: string | null;
  sessionContextPath?: string;
  remedyCommand?: string;
  contextSource?: "operator" | "profile";
  fallback?: string;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  const cancel = () => controller.abort();
  options.signal?.addEventListener("abort", cancel, { once: true });
  try {
    let response: Response;
    try {
      response = await (options.fetcher ?? fetch)(commandEndpoint(options.target), {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.token}`,
          apikey: options.target.anonKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          command_id: randomUUID(), client_version: CLIENT_PROTOCOL_VERSION,
          workspace_id: options.workspaceId, stream: { kind: "workspace" },
          command: options.command,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new WakeLeaseTransientError(null, error);
    }
    let body: Record<string, unknown> | null;
    try { body = asObject(await response.json()); }
    catch (error) {
      if (response.status === 429 || response.status >= 500) {
        throw new WakeLeaseTransientError(response.status, error);
      }
      throw error;
    }
    if (response.status === 409 && body &&
        (body.error === "notify_held_elsewhere" || body.error === "wake_lease_superseded")) {
      throw new WakeLeaseLostError(
        body.error, body.surface === "h0_poll" ? "h0_poll" : "watcher",
        typeof body.host_label === "string" ? body.host_label : null,
        options.restartCommand, options.command.kind === "claim_wake_lease" ? "start" : "renew",
        options.sessionContextPath, options.remedyCommand, options.contextSource, options.fallback,
      );
    }
    if (body && typeof body.error === "string" &&
        isAgentSessionErrorCode(body.error) && body.error in NOTIFY_LEASE_EXITS) {
      throw new WakeLeaseLostError(body.error as NotifyLeaseCode,
        "session", null, options.restartCommand,
        options.command.kind === "claim_wake_lease" ? "start" : "renew", options.sessionContextPath, options.remedyCommand,
        options.contextSource, options.fallback);
    }
    if (!response.ok || !body || body.ok !== true) {
      if (response.status === 429 || response.status >= 500) {
        throw new WakeLeaseTransientError(response.status);
      }
      throw new Error(`wake lease command failed (HTTP ${response.status})`);
    }
    return body;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
  }
}

export async function readAgentWakeLease(
  target: CloudTarget, workspaceId: string, token: string,
  fetcher: typeof fetch = fetch,
): Promise<AgentWakeLease | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetcher(readEndpoint(target), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, apikey: target.anonKey,
        "content-type": "application/json" },
      body: JSON.stringify({ resource: "agent_wake_lease", workspace_id: workspaceId }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`wake lease read failed (HTTP ${response.status})`);
    const payload = asObject(await response.json());
    if (!payload || payload.lease === null) return null;
    const row = asObject(payload.lease);
    const generation = typeof row?.generation === "string" ? Number(row.generation) : row?.generation;
    const renewedAge = typeof row?.renewed_age_ms === "string"
      ? Number(row.renewed_age_ms) : row?.renewed_age_ms;
    if (!row || typeof row.watcher_id !== "string" || typeof row.host_label !== "string" ||
        !Number.isSafeInteger(generation) || !Number.isSafeInteger(renewedAge)) {
      throw new Error("wake lease read returned malformed data");
    }
    return { watcher_id: row.watcher_id, host_label: row.host_label,
      generation: generation as number, renewed_age_ms: renewedAge as number };
  } finally {
    clearTimeout(timer);
  }
}

/** An independent timer: push mode may go five minutes without a read. */
export function startWakeLeaseRenewal(options: {
  renew(): Promise<void>;
  lost(error: WakeLeaseLostError): void;
  failed?(error: unknown): void;
  intervalMs?: number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}): () => void {
  const interval = options.intervalMs ?? WAKE_LEASE_RENEW_MS;
  const arm = options.setTimer ?? setTimeout;
  const clear = options.clearTimer ?? clearTimeout;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let failures = 0;
  const tick = async () => {
    if (stopped) return;
    try {
      await options.renew();
      failures = 0;
    } catch (error) {
      if (error instanceof WakeLeaseLostError) {
        stopped = true;
        options.lost(error);
        return;
      }
      if (!(error instanceof WakeLeaseTransientError)) {
        stopped = true;
        options.failed?.(error);
        return;
      }
      failures += 1;
    }
    if (!stopped) timer = arm(tick, failures === 0 ? interval :
      Math.min(interval, 1000 * 2 ** Math.min(failures, 6)));
  };
  timer = arm(tick, interval);
  return () => { stopped = true; if (timer !== null) clear(timer); };
}
