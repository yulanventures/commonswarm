/**
 * Observe surfaced deliveries: tell the service this agent has seen these messages (check's
 * unclaimed `observed` ack), in as few requests as the edge allows.
 *
 * One batched request per UNCLAIMED_OBSERVATION_BATCH_MAX ids. An edge that predates the batch
 * shape answers 400; from then on this call sends the single-id shape older edges accept, at most
 * OBSERVATION_FALLBACK_CONCURRENCY at a time. Every id ends in exactly one bucket: observed,
 * refused (a final answer from the edge, never worth retrying) or failed (transport, 5xx, 401, 429
 * or the deadline: worth retrying later). Never throws.
 */
import { randomUUID } from "node:crypto";
import type { SignalRecord } from "./command-client.js";
import type { CloudTarget } from "./config.js";
import {
  DeliveryCommandClient,
  DeliveryHttpError,
  UNCLAIMED_OBSERVATION_BATCH_MAX,
} from "./delivery.js";
import { signalReachesAgent } from "./signals.js";

export const OBSERVATION_FALLBACK_CONCURRENCY = 4;
/** Below this much time left, no new request starts. */
export const OBSERVATION_MIN_REMAINING_MS = 50;

export interface DeliveryObservationOutcome {
  observed: string[];
  refused: string[];
  failed: string[];
  /** True when the edge refused the batch shape and the single-id fallback ran. */
  fellBack: boolean;
}

/** The single-id answers check has always treated as final for an id. */
function singleRefusalIsFinal(error: unknown): boolean {
  return error instanceof DeliveryHttpError &&
    (error.status === 403 || error.status === 404 || error.status === 409 ||
      (error.status === 400 && error.code === "invalid_request"));
}

/** A whole batch refused with an answer that is final for each id (the same statuses, never 400). */
function batchRefusalIsFinal(error: unknown): boolean {
  return error instanceof DeliveryHttpError &&
    (error.status === 403 || error.status === 404 || error.status === 409);
}

export async function observeUnclaimedDeliveries(options: {
  target: CloudTarget;
  fetcher: typeof fetch;
  credential: string;
  workspaceId: string;
  signalIds: readonly string[];
  /** Absolute wall-clock deadline for every request this call makes. */
  deadlineAtMs: number;
  /** Ceiling for any one request. */
  requestTimeoutMs?: number;
  now?: () => number;
}): Promise<DeliveryObservationOutcome> {
  const now = options.now ?? Date.now;
  const ids = [...new Set(options.signalIds.map((id) => id.toLowerCase()))];
  const outcome: DeliveryObservationOutcome = { observed: [], refused: [], failed: [], fellBack: false };
  const client = () => {
    const remaining = Math.floor(options.deadlineAtMs - now());
    return new DeliveryCommandClient(options.target, options.fetcher, {
      deadlineMs: Math.max(1, Math.min(options.requestTimeoutMs ?? remaining, remaining)),
    });
  };
  const timeLeft = () => options.deadlineAtMs - now() >= OBSERVATION_MIN_REMAINING_MS;

  const single = async (batch: readonly string[]) => {
    let next = 0;
    const worker = async () => {
      while (next < batch.length) {
        const id = batch[next++]!;
        if (!timeLeft()) {
          outcome.failed.push(id);
          continue;
        }
        try {
          await client().observeUnclaimedAgentDelivery({
            workspaceId: options.workspaceId, credential: options.credential,
            commandId: randomUUID(), signalId: id,
          });
          outcome.observed.push(id);
        } catch (error) {
          (singleRefusalIsFinal(error) ? outcome.refused : outcome.failed).push(id);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(OBSERVATION_FALLBACK_CONCURRENCY, batch.length) }, worker));
  };

  for (let offset = 0; offset < ids.length; offset += UNCLAIMED_OBSERVATION_BATCH_MAX) {
    const batch = ids.slice(offset, offset + UNCLAIMED_OBSERVATION_BATCH_MAX);
    if (outcome.fellBack) {
      await single(batch);
      continue;
    }
    if (!timeLeft()) {
      outcome.failed.push(...batch);
      continue;
    }
    try {
      const answered = await client().observeUnclaimedAgentDeliveries({
        workspaceId: options.workspaceId, credential: options.credential,
        commandId: randomUUID(), signalIds: batch,
      });
      outcome.observed.push(...answered.observed);
      outcome.refused.push(...answered.refused);
    } catch (error) {
      if (error instanceof DeliveryHttpError && error.status === 400) {
        // An edge older than the batch shape: nothing was observed, so every id goes again singly.
        outcome.fellBack = true;
        await single(batch);
      } else {
        (batchRefusalIsFinal(error) ? outcome.refused : outcome.failed).push(...batch);
      }
    }
  }
  return outcome;
}

/** How long `cswarm inbox` and `inbox --notify` spend observing what they just printed. */
export const SURFACED_OBSERVATION_BUDGET_MS = 3_000;

/**
 * The printed rows whose delivery this agent observes: an ask or a note that reaches it (addressed
 * or mentioned) and is not a reaction note (whose id is a reaction's). `excludeOwn` leaves out what
 * the agent wrote itself, so a watcher never observes the attended-seat canary it posted (that
 * note asks the seat itself to run check). With no principal id (a bare token), every ask and note
 * of the agent's inbox read is named and the edge refuses any that does not reach the agent.
 */
export function surfacedDeliveryIds(
  rows: readonly SignalRecord[],
  principalId: string | null,
  options: { excludeOwn?: boolean } = {},
): string[] {
  return [...new Set(rows.filter((row) =>
    (row.kind === "ask" || row.kind === "note") && row.reaction === undefined &&
    (principalId === null || signalReachesAgent(row, principalId)) &&
    !(options.excludeOwn === true && row.from_kind === "agent" && row.from === principalId)
  ).map((row) => row.id))];
}

/**
 * Observe what was just printed, after it was printed. Best effort and bounded: at most `budgetMs`
 * (sooner if `signal` aborts), never throws, and the output, cursor and exit status never depend
 * on it. What is not observed now stays waiting for the next read, check or listener.
 */
export async function observeSurfacedDeliveries(options: {
  target: CloudTarget;
  fetcher: typeof fetch;
  credential: string;
  workspaceId: string;
  signalIds: readonly string[];
  budgetMs?: number;
  signal?: AbortSignal;
}): Promise<DeliveryObservationOutcome | null> {
  if (options.signalIds.length === 0 || options.signal?.aborted) return null;
  const external = options.signal;
  const fetcher = (external === undefined ? options.fetcher : (async (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    options.fetcher(input, { ...init, signal: init?.signal ? AbortSignal.any([external, init.signal]) : external }))) as typeof fetch;
  try {
    return await observeUnclaimedDeliveries({
      target: options.target, fetcher, credential: options.credential,
      workspaceId: options.workspaceId, signalIds: options.signalIds,
      deadlineAtMs: Date.now() + (options.budgetMs ?? SURFACED_OBSERVATION_BUDGET_MS),
    });
  } catch {
    return null;
  }
}
