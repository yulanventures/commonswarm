import { open } from "node:fs/promises";
import type { CloudTarget } from "../cloud/config.js";
import {
  ThinCommandClient,
} from "../cloud/command-client.js";
import {
  DeliveryReceiptReadError,
  deliveryReceiptState,
  readAgentDeliveryReceipts,
  type DeliveryReceipt,
  type DeliveryReceiptRow,
} from "../cloud/delivery-receipts.js";
import { SignalReadTimeoutError } from "../cloud/signals.js";
import {
  readAgentWakeLease,
  type AgentWakeLease,
  WakeLeaseReadError,
} from "../cloud/wake-lease.js";
import {
  ATTENDED_CANARY_HOPS,
  ATTENDED_CANARY_WATCHER_WAIT_MS,
} from "../cloud/wake-lease-constants.js";
import type { ListenerPaths } from "./control.js";
import { FileHookSurfaceStore } from "./hook.js";
import {
  isStoredListenerRouteDecision,
  listenerAttendanceSurfaceRemedy,
  type StoredListenerRouteDecision,
} from "./main-routing.js";

const LOG_TAIL_BYTES = 256 * 1024;

export { ATTENDED_CANARY_HOPS };

export type AttendedCanaryStalledHop = "watcher_polled" | "observed";
export type AttendedCanaryWatcherPollState = "proved" | "unproved" | "not_observed";

export interface AttendedAttendanceCanaryResult {
  signalId: string;
  acceptedAt: string;
  watcherPolledAt: string | null;
  watcherPollState: AttendedCanaryWatcherPollState;
  observedAt: string | null;
  wakeLeaseReadError: { status: number | null } | null;
  receiptReadErrorCode: "transport" | "http" | "protocol" | "not_author" | "timeout" | null;
  stalledAt: AttendedCanaryStalledHop | null;
}

export interface AttendedAttendanceCanaryOptions {
  target: CloudTarget;
  workspaceId: string;
  principalId: string;
  watcherId: string;
  generation: number | null;
  credential: () => Promise<string>;
  checkWaitMs: number;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  pollMs?: number;
  /** Test seam. Production derives this from WAKE_LEASE_RENEW_MS. */
  watcherWaitMs?: number;
  readWakeLease?: () => Promise<AgentWakeLease | null>;
  /** Notify waits here until its Monitor has emitted the accepted self-note. */
  afterAccepted?: (signalId: string) => Promise<void> | void;
}

export type ListenerCanaryStalledHop =
  | "claimed"
  | "routed"
  | "surfaced"
  | "observed";

export interface ListenerAttendanceCanaryResult {
  signalId: string;
  acceptedAt: string;
  claimedAt: string | null;
  routeDecision: StoredListenerRouteDecision | null;
  routedAt: string | null;
  pendingForMainCount: number | null;
  surfacedAt: string | null;
  observedAt: string | null;
  receiptReadErrorCode: "transport" | "http" | "protocol" | "not_author" | "timeout" | null;
  stalledAt: ListenerCanaryStalledHop | null;
}

export interface ListenerAttendanceCanaryOptions {
  target: CloudTarget;
  workspaceId: string;
  principalId: string;
  paths: ListenerPaths;
  credential: () => Promise<string>;
  waitMs: number;
  fetcher?: typeof fetch;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  pollMs?: number;
}

interface CanaryLogEvidence {
  claimedAt: string | null;
  routeDecision: StoredListenerRouteDecision | null;
  routedAt: string | null;
}

function agentReceipt(
  receipts: readonly DeliveryReceiptRow[],
  principalId: string,
): DeliveryReceipt | null {
  for (const receipt of receipts) {
    if (
      "recipient_agent_principal_id" in receipt &&
      receipt.recipient_agent_principal_id === principalId
    ) {
      return receipt;
    }
  }
  return null;
}

function attendedSleep(
  milliseconds: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    if (milliseconds <= 0 || signal?.aborted) {
      resolve();
      return;
    }
    signal?.addEventListener("abort", finish, { once: true });
    timer = setTimeout(finish, milliseconds);
  });
}

/** Post one self-note and prove the attended watcher and in-session check hops. */
export async function runAttendedAttendanceCanary(
  options: AttendedAttendanceCanaryOptions,
): Promise<AttendedAttendanceCanaryResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds) =>
    attendedSleep(milliseconds, options.signal));
  const client = new ThinCommandClient(options.target, options.fetcher, {
    signalRequestTimeoutMs: Math.max(1, options.checkWaitMs),
  });
  const posted = await client.sendSignal({
    workspaceId: options.workspaceId,
    credential: await options.credential(),
    signal: options.signal,
    command: {
      kind: "post_signal",
      signal_kind: "note",
      body: "CommonSwarm attended-seat canary. Run cswarm check in this session; no reply is needed.",
      to_user_id: null,
      to_agent_principal_id: options.principalId,
      in_reply_to: null,
      about: null,
      until_ms: 10 * 60_000,
    },
  });
  const signal = posted.response.signal!;
  const signalId = signal.id;
  const acceptedMs = Date.parse(signal.created_at);
  const acceptedAt = Number.isFinite(acceptedMs)
    ? signal.created_at
    : new Date(now()).toISOString();
  await options.afterAccepted?.(signalId);
  const watcherDeadline = now() +
    (options.watcherWaitMs ?? ATTENDED_CANARY_WATCHER_WAIT_MS);
  let observedDeadline: number | null = null;
  let expectedGeneration = options.generation;
  let leaseBaseline: { receivedAt: number; renewedAgeMs: number } | null = null;
  let watcherPolledAt: string | null = null;
  let watcherPollState: AttendedCanaryWatcherPollState = "not_observed";
  let observedAt: string | null = null;
  let wakeLeaseReadError: AttendedAttendanceCanaryResult["wakeLeaseReadError"] = null;
  let receiptReadErrorCode: AttendedAttendanceCanaryResult["receiptReadErrorCode"] = null;

  while (!options.signal?.aborted) {
    if (
      watcherPollState === "not_observed" &&
      now() >= watcherDeadline
    ) break;
    const sampledAt = now();
    if (watcherPollState === "not_observed") {
      try {
        const lease = options.readWakeLease
          ? await options.readWakeLease()
          : await readAgentWakeLease(
            options.target,
            options.workspaceId,
            await options.credential(),
            options.fetcher,
            options.signal,
          );
        const receivedAt = now();
        wakeLeaseReadError = null;
        if (
          lease !== null &&
          lease.watcher_id === options.watcherId &&
          (expectedGeneration === null || lease.generation === expectedGeneration)
        ) {
          expectedGeneration ??= lease.generation;
          const expectedAge = leaseBaseline === null
            ? null
            // The baseline age was measured before its response arrived. Using
            // that arrival as the lower bound prevents response latency from
            // looking like a lease-age reset.
            : leaseBaseline.renewedAgeMs + Math.max(0, sampledAt - leaseBaseline.receivedAt);
          if (expectedAge !== null && lease.renewed_age_ms + 1 < expectedAge) {
            // The baseline and this sample were both requested after the
            // note was accepted. Their age reset proves an intervening
            // renewal without pretending the request-start clock is the
            // server's query time. Record when that proof arrived locally.
            watcherPolledAt = new Date(receivedAt).toISOString();
            watcherPollState = "proved";
            observedDeadline = receivedAt + options.checkWaitMs;
          } else if (leaseBaseline === null) {
            // Both samples are after acceptance. A later age reset therefore
            // proves a renewal after the canary note, without comparing clocks.
            leaseBaseline = { receivedAt, renewedAgeMs: lease.renewed_age_ms };
          }
        }
      } catch (error) {
        if (error instanceof WakeLeaseReadError &&
            (error.status === 400 || error.status === 404)) {
          wakeLeaseReadError = null;
          watcherPollState = "unproved";
          observedDeadline = now() + options.checkWaitMs;
        } else {
          wakeLeaseReadError = {
            status: error instanceof WakeLeaseReadError ? error.status : null,
          };
          receiptReadErrorCode = null;
        }
      }
    }

    // A missing legacy view is unproved, but an unavailable current view is a
    // service-read failure. It says nothing about whether the watcher polled.
    if (wakeLeaseReadError !== null) break;

    // The hops are ordered. Receipt reads cannot prove `observed` until the
    // watcher hop is proved (or is unprovable on a pre-2b deployment). This
    // also preserves the entire watcher deadline for lease reads instead of
    // starting a receipt request with only a few milliseconds left.
    if (watcherPollState === "not_observed") {
      if (now() >= watcherDeadline) break;
      await sleep(Math.min(options.pollMs ?? 250, watcherDeadline - now()));
      continue;
    }

    const finalDeadline = observedDeadline!;
    if (now() >= finalDeadline) break;
    try {
      const report = await readAgentDeliveryReceipts(
        options.target,
        await options.credential(),
        options.workspaceId,
        signalId,
        {
          ...(options.fetcher ? { fetcher: options.fetcher } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
          deadlineMs: finalDeadline,
          now,
        },
      );
      receiptReadErrorCode = null;
      const receipt = agentReceipt(report.receipts, options.principalId);
      if (receipt !== null) {
        const state = deliveryReceiptState(receipt, now());
        if (state === "observed" || state === "replied") observedAt = receipt.acked_at;
      }
    } catch (error) {
      // An observed ACK is immutable. A later read failure cannot undo it or
      // turn a completed hop into a contradictory pass-with-error result.
      if (observedAt === null) {
        receiptReadErrorCode = error instanceof DeliveryReceiptReadError
          ? error.code
          : error instanceof SignalReadTimeoutError
          ? "timeout"
          : "transport";
      }
    }

    if (observedAt !== null) break;
    if (now() >= finalDeadline) break;
    await sleep(Math.min(options.pollMs ?? 250, finalDeadline - now()));
  }

  const stalledAt = wakeLeaseReadError !== null ||
      (receiptReadErrorCode !== null && observedAt === null)
    ? null
    : watcherPollState === "not_observed"
    ? "watcher_polled"
    : observedAt === null
    ? "observed"
    : null;
  return {
    signalId,
    acceptedAt,
    watcherPolledAt,
    watcherPollState,
    observedAt,
    wakeLeaseReadError,
    receiptReadErrorCode,
    stalledAt,
  };
}

/** Render the attended hops and the exact recovery action for the first stall. */
export function renderAttendedAttendanceCanary(
  result: AttendedAttendanceCanaryResult,
): string {
  if (result.wakeLeaseReadError !== null) {
    const credentialRefused = result.wakeLeaseReadError.status === 401 ||
      result.wakeLeaseReadError.status === 403;
    return [
      `Canary note: ${result.signalId}.`,
      `ACCEPTED: yes at ${result.acceptedAt}.`,
      `WAKE LEASE READ: failed (${result.wakeLeaseReadError.status === null
        ? "transport"
        : `HTTP ${result.wakeLeaseReadError.status}`}).`,
      credentialRefused
        ? "Canary incomplete: watcher polling is unknown because the wake-lease service refused this credential. Next: re-establish this seat's credential, then retry `cswarm listen canary`."
        : "Canary incomplete: watcher polling is unknown because the wake-lease service read failed. Next: retry `cswarm listen canary` when the read works.",
    ].join("\n");
  }
  const watcher = result.watcherPollState === "proved"
    ? `yes at ${result.watcherPolledAt}`
    : result.watcherPollState === "unproved"
    ? "unproved because this deployment does not expose the wake-lease view"
    : "no";
  const lines = [
    `Canary note: ${result.signalId}.`,
    `ACCEPTED: yes at ${result.acceptedAt}.`,
    `WATCHER_POLLED: ${watcher}.`,
    `OBSERVED: ${result.observedAt === null ? "no" : `yes at ${result.observedAt}`}.`,
  ];
  if (result.receiptReadErrorCode !== null) {
    lines.push(`RECEIPT READ: failed (${result.receiptReadErrorCode}).`);
    lines.push("Canary incomplete: observation is unknown because the receipt read failed. Next: retry `cswarm listen canary` when the read works.");
    return lines.join("\n");
  }
  if (result.stalledAt === "watcher_polled") {
    lines.push("STALLED: watcher_polled. Next: restart `cswarm inbox --notify` under the same session Monitor.");
  } else if (result.stalledAt === "observed") {
    lines.push("STALLED: observed. Next: run `cswarm check` in the session.");
  } else if (result.watcherPollState === "unproved") {
    lines.push("Canary completed: the note was observed, but watcher_polled remains unproved until the deployment exposes the wake-lease view. Next: update the read service before treating watcher polling as proved.");
  } else {
    lines.push("Canary passed: every required attended hop was measured. Next: no action is needed.");
  }
  return lines.join("\n");
}

async function readLogTail(path: string): Promise<string> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
  try {
    const size = (await handle.stat()).size;
    const start = Math.max(0, size - LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    let text = buffer.toString("utf8");
    if (start > 0) {
      const newline = text.indexOf("\n");
      text = newline < 0 ? "" : text.slice(newline + 1);
    }
    return text;
  } finally {
    await handle.close();
  }
}

async function logEvidence(
  path: string,
  signalId: string,
): Promise<CanaryLogEvidence> {
  let claimedAt: string | null = null;
  let routeDecision: StoredListenerRouteDecision | null = null;
  let routedAt: string | null = null;
  for (const line of (await readLogTail(path)).split("\n")) {
    if (line.length === 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    if (row.signal_id !== signalId || typeof row.ts !== "string") continue;
    if (row.event === "listener_delivery_claim") claimedAt = row.ts;
    if (
      row.event === "listener_routing_decision" &&
      typeof row.route_decision === "string" &&
      isStoredListenerRouteDecision(row.route_decision)
    ) {
      routeDecision = row.route_decision;
      routedAt = row.ts;
    }
  }
  return { claimedAt, routeDecision, routedAt };
}

/** Post one self-note and measure every listener attendance hop before the deadline. */
export async function runListenerAttendanceCanary(
  options: ListenerAttendanceCanaryOptions,
): Promise<ListenerAttendanceCanaryResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const startedAt = now();
  const deadlineMs = startedAt + options.waitMs;
  const client = new ThinCommandClient(options.target, options.fetcher, {
    signalRequestTimeoutMs: options.waitMs,
  });
  const posted = await client.sendSignal({
    workspaceId: options.workspaceId,
    credential: await options.credential(),
    command: {
      kind: "post_signal",
      signal_kind: "note",
      body: "CommonSwarm listener attendance canary. No reply is needed.",
      to_user_id: null,
      to_agent_principal_id: options.principalId,
      in_reply_to: null,
      about: null,
      until_ms: 10 * 60_000,
    },
  });
  const signalId = posted.response.signal!.id;

  let claimedAt: string | null = null;
  let routeDecision: StoredListenerRouteDecision | null = null;
  let routedAt: string | null = null;
  let pendingForMainCount: number | null = null;
  let surfacedAt: string | null = null;
  let observedAt: string | null = null;
  let receiptReadErrorCode: ListenerAttendanceCanaryResult["receiptReadErrorCode"] = null;

  while (true) {
    const log = await logEvidence(options.paths.logPath, signalId);
    claimedAt ??= log.claimedAt;
    routeDecision ??= log.routeDecision;
    routedAt ??= log.routedAt;

    const hook = await new FileHookSurfaceStore(
      options.paths.instanceDirectory,
    ).evidence();
    if (hook.surfacedSignalIds.includes(signalId)) {
      surfacedAt ??= new Date(now()).toISOString();
    }

    if (now() >= deadlineMs) break;

    try {
      const report = await readAgentDeliveryReceipts(
        options.target,
        await options.credential(),
        options.workspaceId,
        signalId,
        {
          ...(options.fetcher ? { fetcher: options.fetcher } : {}),
          deadlineMs,
          now,
        },
      );
      receiptReadErrorCode = null;
      const receipt = agentReceipt(report.receipts, options.principalId);
      if (receipt !== null) {
        claimedAt ??= receipt.delivered_at;
        if (receipt.ack_outcome === "queued") {
          routeDecision ??= "main";
          routedAt ??= receipt.acked_at;
          pendingForMainCount = receipt.pending_for_main_count ?? null;
        }
        const state = deliveryReceiptState(receipt, now());
        if (state === "observed" || state === "replied") {
          observedAt = receipt.acked_at;
        }
      }
    } catch (error) {
      receiptReadErrorCode = error instanceof DeliveryReceiptReadError
        ? error.code
        : error instanceof SignalReadTimeoutError
        ? "timeout"
        : "transport";
    }

    const complete = claimedAt !== null && routeDecision !== null &&
      (routeDecision === "worker" || surfacedAt !== null) &&
      observedAt !== null;
    if (complete || now() >= deadlineMs) break;
    await sleep(Math.min(options.pollMs ?? 250, deadlineMs - now()));
  }

  const stalledAt = claimedAt === null
    ? "claimed"
    : routeDecision === null
    ? "routed"
    : routeDecision === "main" && surfacedAt === null
    ? "surfaced"
    : observedAt === null
    ? "observed"
    : null;
  return {
    signalId,
    acceptedAt: new Date(startedAt).toISOString(),
    claimedAt,
    routeDecision,
    routedAt,
    pendingForMainCount,
    surfacedAt,
    observedAt,
    receiptReadErrorCode,
    stalledAt,
  };
}

/** Render hop evidence and the exact next step for the first stalled hop. */
export function renderListenerAttendanceCanary(
  result: ListenerAttendanceCanaryResult,
  workspaceId: string,
  principalId: string,
): string {
  const statusCommand =
    `cswarm listen status --workspace-id ${workspaceId} --principal-id ${principalId}`;
  const route = result.routeDecision === "main"
    ? `queued for the interactive session${
      result.pendingForMainCount === null
        ? ""
        : ` (${result.pendingForMainCount} in queue)`
    }`
    : result.routeDecision === "worker"
    ? "legacy worker route in this log (cannot be started again)"
    : "not measured";
  const lines = [
    `Canary note: ${result.signalId}.`,
    `ACCEPTED: yes at ${result.acceptedAt}.`,
    `CLAIMED: ${result.claimedAt === null ? "no" : `yes at ${result.claimedAt}`}.`,
    `QUEUED: ${route}.`,
    `SURFACED: ${
      result.routeDecision === "worker"
        ? "not required for a legacy worker log"
        : result.surfacedAt === null
        ? "no"
        : `yes at ${result.surfacedAt}`
    }.`,
    `OBSERVED: ${result.observedAt === null ? "no" : `yes at ${result.observedAt}`}.`,
  ];
  if (result.receiptReadErrorCode !== null) {
    lines.push(`RECEIPT READ: failed (${result.receiptReadErrorCode}).`);
  }
  if (result.stalledAt === null) {
    lines.push("Canary passed: every required hop was measured.");
  } else if (result.stalledAt === "surfaced") {
    lines.push(
      `STALLED: surfaced. Next: ${listenerAttendanceSurfaceRemedy("hook", principalId)}.`,
    );
  } else {
    lines.push(`STALLED: ${result.stalledAt}. Next: ${statusCommand}`);
  }
  return lines.join("\n");
}
