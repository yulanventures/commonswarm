import { randomUUID } from "node:crypto";
import type { SignalRecord } from "../cloud/command-client.js";
import type { CloudTarget } from "../cloud/config.js";
import type { HostSessionEvents, SanitizedSessionUpdate } from "../host/types.js";
import type { ListenerRuntimeEvent, ListenerRuntimeModel } from "./runtime.js";
import {
  MESSAGE_STATUS_THROTTLE_MS,
  acpToolKindLabel,
  type MessageStatusFrame,
  type MessageStatusLabel,
} from "./message-status.js";
import type {
  ListenerPromptMode,
  ListenerPromptResult,
} from "./types.js";

export const ACTIVITY_FRAME_INTERVAL_MS = 750;
export const ACTIVITY_HEARTBEAT_MS = 15_000;
export const ACTIVITY_TOOL_TITLE_MAX = 160;
export const ACTIVITY_REQUEST_TIMEOUT_MS = 5_000;

export type ActivityPublishErrorCode =
  | "activity_credential_failed"
  | "activity_request_timeout"
  | "activity_transport_failed"
  | "activity_http_rejected"
  | "activity_publish_unknown";

export class AgentActivityPublishError extends Error {
  constructor(
    readonly code: Exclude<ActivityPublishErrorCode, "activity_publish_unknown">,
    cause?: unknown,
  ) {
    super("activity frame publish failed", { cause });
    this.name = "AgentActivityPublishError";
  }
}

export function activityPublishErrorCode(error: unknown): ActivityPublishErrorCode {
  return error instanceof AgentActivityPublishError
    ? error.code
    : "activity_publish_unknown";
}

export type ListenerActivityPhase =
  | "claimed"
  | "prompting"
  | "tool-running"
  | "replying"
  | "idle";

export interface AgentActivityFrameRequest {
  version: 1;
  workspaceId: string;
  streamId: string;
  sequence: number;
  phase: ListenerActivityPhase;
  signalId: string | null;
  toolTitle: string | null;
  elapsedMs: number;
}

export interface AgentActivityTransport {
  publish(frame: AgentActivityFrameRequest): Promise<void>;
}

export interface ListenerActivityCredentialSession {
  bearer(): Promise<string>;
}

interface ActivityClock {
  now(): number;
  setTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimer(timer: ReturnType<typeof setTimeout>): void;
}

const SYSTEM_CLOCK: ActivityClock = {
  now: Date.now,
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (timer) => clearTimeout(timer),
};

const TERMINAL_TOOL_STATUSES = new Set([
  "cancelled",
  "completed",
  "done",
  "failed",
  "rejected",
]);

export class AgentActivityEndpointTransport implements AgentActivityTransport {
  private readonly fetcher: typeof fetch;

  constructor(
    private readonly target: CloudTarget,
    private readonly credentialSession: ListenerActivityCredentialSession,
    fetcher?: typeof fetch,
    private readonly requestTimeoutMs = ACTIVITY_REQUEST_TIMEOUT_MS,
  ) {
    this.fetcher = fetcher ?? fetch;
  }

  async publish(frame: AgentActivityFrameRequest): Promise<void> {
    let credential: string;
    try {
      credential = await this.credentialSession.bearer();
    } catch (error) {
      throw new AgentActivityPublishError("activity_credential_failed", error);
    }
    const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
    let response: Response;
    try {
      response = await this.fetcher(
        `${this.target.url}/functions/v1/activity`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${credential}`,
            apikey: this.target.anonKey,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            version: frame.version,
            workspace_id: frame.workspaceId,
            stream_id: frame.streamId,
            sequence: frame.sequence,
            phase: frame.phase,
            signal_id: frame.signalId,
            tool_title: frame.toolTitle,
            elapsed_ms: frame.elapsedMs,
          }),
          signal: timeoutSignal,
        },
      );
    } catch (error) {
      throw new AgentActivityPublishError(
        timeoutSignal.aborted
          ? "activity_request_timeout"
          : "activity_transport_failed",
        error,
      );
    }
    // Body cancellation is connection cleanup after the server answered. It
    // cannot change the publish outcome and must not create a false failure.
    await response.body?.cancel().catch(() => undefined);
    if (!response.ok) {
      throw new AgentActivityPublishError("activity_http_rejected");
    }
  }
}

interface ListenerActivityControllerOptions {
  workspaceId: string;
  transport: AgentActivityTransport;
  streamId?: string;
  clock?: ActivityClock;
  onPublishFailure?: (code: ActivityPublishErrorCode) => void;
  /** Opt-in message status: Working with a coarse label from the ACP tool kind, then idle. */
  messageStatus?: {
    enabled: () => Promise<boolean>;
    publish: (frame: MessageStatusFrame) => Promise<boolean>;
  };
}

/** A Working snapshot expires after two minutes on the server; renew well before that. */
export const MESSAGE_STATUS_RENEW_MS = 60_000;
const MESSAGE_STATUS_OPT_IN_CHECK_MS = 30_000;

/**
 * Coalesce the structured live-steering view chosen in SWARM-CLOUD §2.13.
 *
 * Frames are ephemeral and re-derivable from the listener's current turn. They
 * are never read back after the final signal, so RAM and best-effort Realtime
 * are within the durable-by-default boundary. Raw terminal bytes, stderr, and
 * message bodies have no field in this type and cannot enter the transport.
 */
export class ListenerActivityController {
  readonly events: HostSessionEvents;
  private readonly clock: ActivityClock;
  private readonly streamId: string;
  private sequence = 0;
  private phase: ListenerActivityPhase = "idle";
  private signalId: string | null = null;
  private signalStartedAt: number | null = null;
  private readonly runningTools = new Map<string, string>();
  private latestToolId: string | null = null;
  private dirty = false;
  private sending = false;
  private closed = false;
  private lastSentAt = Number.NEGATIVE_INFINITY;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly toolLabels = new Map<string, MessageStatusLabel>();
  private statusSequence = 0;
  private statusKey: string | null = null;
  private statusSentAt = Number.NEGATIVE_INFINITY;
  private statusSending = false;
  private statusOptIn: { value: boolean; at: number } | null = null;
  private statusTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: ListenerActivityControllerOptions) {
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.streamId = options.streamId ?? randomUUID();
    this.events = { update: (update) => this.onSessionUpdate(update) };
  }

  onRuntimeEvent(event: ListenerRuntimeEvent): void {
    if (event.type === "ready") {
      this.setIdle();
    } else if (event.type === "delivery_claim" && event.signalId !== null) {
      this.beginSignal(event.signalId);
    } else if (event.type === "routing_decision") {
      this.beginSignal(event.signalId);
    } else if (event.type === "effect") {
      this.setIdle();
    }
  }

  instrumentModel(model: ListenerRuntimeModel): ListenerRuntimeModel {
    return {
      start: async () => await model.start(),
      prompt: async (
        signal: SignalRecord,
        mode: ListenerPromptMode,
        prompt: string,
        attempt: number,
      ): Promise<ListenerPromptResult> => {
        this.beginSignal(signal.id);
        this.setPhase("prompting");
        const result = await model.prompt(signal, mode, prompt, attempt);
        this.runningTools.clear();
    this.toolLabels.clear();
        this.latestToolId = null;
        this.setPhase("replying");
        return result;
      },
      cancel: () => model.cancel(),
      close: async () => await model.close(),
    };
  }

  close(): void {
    this.closed = true;
    if (this.timer !== null) this.clock.clearTimer(this.timer);
    if (this.heartbeatTimer !== null) this.clock.clearTimer(this.heartbeatTimer);
    if (this.statusTimer !== null) this.clock.clearTimer(this.statusTimer);
    this.timer = null;
    this.heartbeatTimer = null;
    this.statusTimer = null;
  }

  private onSessionUpdate(update: SanitizedSessionUpdate): void {
    if (this.signalId === null) return;
    if (update.kind !== "tool_call" && update.kind !== "tool_call_update") return;
    const id = update.toolCallId;
    if (!id) return;
    const status = update.status?.toLowerCase();
    if (status && TERMINAL_TOOL_STATUSES.has(status)) {
      this.runningTools.delete(id);
      this.toolLabels.delete(id);
      if (this.latestToolId === id) {
        this.latestToolId = [...this.runningTools.keys()].at(-1) ?? null;
      }
      this.setPhase(this.runningTools.size > 0 ? "tool-running" : "prompting");
      return;
    }
    // The tool title never leaves this process: the activity topic reaches every member, and
    // pattern redaction cannot remove arbitrary paths or secrets. The request carries a fixed
    // placeholder; the edge broadcasts no title at all.
    this.runningTools.set(id, "Tool");
    // The label comes from the tool kind only; the title never reaches a status frame.
    if (update.toolKind !== undefined || !this.toolLabels.has(id)) {
      this.toolLabels.set(id, acpToolKindLabel(update.toolKind));
    }
    this.latestToolId = id;
    this.setPhase("tool-running");
  }

  private beginSignal(signalId: string): void {
    if (this.signalId === signalId) return;
    this.signalId = signalId;
    this.signalStartedAt = this.clock.now();
    this.runningTools.clear();
    this.toolLabels.clear();
    this.latestToolId = null;
    this.setPhase("claimed");
  }

  private setIdle(): void {
    this.signalId = null;
    this.signalStartedAt = null;
    this.runningTools.clear();
    this.toolLabels.clear();
    this.latestToolId = null;
    this.setPhase("idle");
  }

  private setPhase(phase: ListenerActivityPhase): void {
    this.phase = phase;
    if (this.heartbeatTimer !== null) {
      this.clock.clearTimer(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.dirty = true;
    this.schedule();
  }

  private armHeartbeat(): void {
    if (this.closed || this.heartbeatTimer !== null) return;
    this.heartbeatTimer = this.clock.setTimer(() => {
      this.heartbeatTimer = null;
      this.dirty = true;
      this.schedule();
    }, ACTIVITY_HEARTBEAT_MS);
  }

  private schedule(): void {
    if (this.closed || this.timer !== null || this.sending) return;
    const delay = Math.max(
      0,
      this.lastSentAt + ACTIVITY_FRAME_INTERVAL_MS - this.clock.now(),
    );
    if (delay === 0) {
      void this.flush();
      return;
    }
    this.timer = this.clock.setTimer(() => {
      this.timer = null;
      void this.flush();
    }, delay);
  }

  private async flush(): Promise<void> {
    if (this.closed || this.sending || !this.dirty) return;
    this.dirty = false;
    this.sending = true;
    this.lastSentAt = this.clock.now();
    const toolTitle = this.latestToolId === null
      ? null
      : this.runningTools.get(this.latestToolId) ?? null;
    const frame: AgentActivityFrameRequest = {
      version: 1,
      workspaceId: this.options.workspaceId,
      streamId: this.streamId,
      sequence: ++this.sequence,
      phase: this.phase,
      signalId: this.signalId,
      toolTitle,
      elapsedMs: this.signalStartedAt === null
        ? 0
        : Math.max(0, Math.round(this.clock.now() - this.signalStartedAt)),
    };
    try {
      await this.options.transport.publish(frame);
    } catch (error) {
      // Realtime is a latency hint. A publish failure cannot change delivery,
      // the durable reply, listener liveness, or the next coalesced frame. It
      // still reaches local status through a stable code; no prose is parsed.
      this.options.onPublishFailure?.(activityPublishErrorCode(error));
    } finally {
      this.sending = false;
      if (this.dirty) this.schedule();
      else this.armHeartbeat();
    }
    void this.flushStatus();
  }

  /**
   * Opt-in message status, driven by the same coalesced flushes and heartbeat. Working names the
   * current message with a label from the running tool's kind (thinking when none); a label
   * change waits for the throttle, the same status renews every minute, and idle follows only a
   * Working this stream sent. Failures are ignored: status is a hint, never delivery state.
   */
  private async flushStatus(): Promise<void> {
    const status = this.options.messageStatus;
    if (status === undefined || this.statusSending || this.closed) return;
    const now = this.clock.now();
    const working = this.signalId !== null && this.phase !== "idle";
    const label: MessageStatusLabel | null = !working
      ? null
      : this.latestToolId === null
      ? "thinking"
      : this.toolLabels.get(this.latestToolId) ?? "using_tool";
    const key = working ? `working:${this.signalId}:${label}` : "idle";
    if (!working && (this.statusKey === null || this.statusKey === "idle")) return;
    if (key === this.statusKey && now - this.statusSentAt < MESSAGE_STATUS_RENEW_MS) return;
    if (
      working && this.statusKey !== null && this.statusKey.startsWith(`working:${this.signalId}:`) &&
      key !== this.statusKey && now - this.statusSentAt < MESSAGE_STATUS_THROTTLE_MS
    ) {
      // Send the newer label when the throttle ends, not at the next heartbeat.
      if (this.statusTimer === null) {
        this.statusTimer = this.clock.setTimer(() => {
          this.statusTimer = null;
          void this.flushStatus();
        }, this.statusSentAt + MESSAGE_STATUS_THROTTLE_MS - now);
      }
      return;
    }
    this.statusSending = true;
    try {
      if (this.statusOptIn === null || now - this.statusOptIn.at >= MESSAGE_STATUS_OPT_IN_CHECK_MS) {
        this.statusOptIn = { value: await status.enabled().catch(() => false), at: now };
      }
      if (!this.statusOptIn.value) return;
      this.statusKey = key;
      this.statusSentAt = now;
      await status.publish({
        workspaceId: this.options.workspaceId,
        streamId: this.streamId,
        sequence: ++this.statusSequence,
        state: working ? "working" : "idle",
        signalId: working ? this.signalId : null,
        label,
      }).catch(() => false);
    } finally {
      this.statusSending = false;
    }
  }
}
