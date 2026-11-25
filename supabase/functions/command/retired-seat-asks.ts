/**
 * Retired/disconnected seat ask clearing: dedicated command module
 * (modeled on ask-withdrawals.ts and waiting-dismissals.ts).
 * Lock-free lifecycle epoch storage, cutoff writes, disconnected-seat checks,
 * and blind replay reauthorization live in 20261125000002_retired_seat_asks_prep.sql.
 */
import type postgres from "postgres";

type Sql = postgres.TransactionSql<Record<string, unknown>>;

export const RETIRED_SEAT_ASK_COMMAND_KINDS = [
  "clear_retired_seat_asks",
] as const;
export type RetiredSeatAskCommandKind = typeof RETIRED_SEAT_ASK_COMMAND_KINDS[number];

export interface ClearRetiredSeatAsksCommand {
  kind: "clear_retired_seat_asks";
  principal_id: string;
}

export type RetiredSeatAskParse =
  | { ok: true; command: ClearRetiredSeatAsksCommand }
  | { ok: false; status: 400; reason: string };

export interface RetiredSeatAskStoredFields {
  principal_id: string;
  cutoff_epoch: number;
  cleared_at: string;
}

export interface RetiredSeatAskWireFields {
  principal_id: string;
  cleared_at: string;
}

export type RetiredSeatAskOutcome =
  | {
    ok: true;
    storedResponse: RetiredSeatAskStoredFields;
    wireResponse: RetiredSeatAskWireFields;
  }
  | {
    ok: false;
    status: 400 | 403 | 404 | 409 | 503;
    error: string;
    message: string;
    reason: string;
  };

export const RETIRED_SEAT_NOT_FOUND_BODY = {
  error: "not_found",
  message: "No agent seat with that id was found in this workspace.",
} as const;

export const RETIRED_SEAT_STILL_LIVE_BODY = {
  error: "seat_still_live",
  message: "Turn off this agent's key or remove it from the workspace before clearing its open asks.",
} as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isRetiredSeatAskCommandKind(kind: unknown): kind is RetiredSeatAskCommandKind {
  return typeof kind === "string" &&
    (RETIRED_SEAT_ASK_COMMAND_KINDS as readonly string[]).includes(kind);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

function positiveInteger(value: unknown): number | null {
  const num = typeof value === "number"
    ? value
    : typeof value === "string" && /^[1-9][0-9]*$/.test(value)
    ? Number(value)
    : NaN;
  return Number.isSafeInteger(num) && num >= 1 ? num : null;
}

export function parseRetiredSeatAskCommand(cmd: Record<string, unknown>): RetiredSeatAskParse {
  if (!isRetiredSeatAskCommandKind(cmd.kind)) {
    return { ok: false, status: 400, reason: "Unknown retired seat ask command." };
  }
  if (!exactKeys(cmd, ["kind", "principal_id"])) {
    return {
      ok: false,
      status: 400,
      reason: "clear_retired_seat_asks takes principal_id only.",
    };
  }
  if (!isUuid(cmd.principal_id)) {
    return {
      ok: false,
      status: 400,
      reason: "principal_id must be a UUID.",
    };
  }
  return {
    ok: true,
    command: {
      kind: "clear_retired_seat_asks",
      principal_id: cmd.principal_id.toLowerCase(),
    },
  };
}

export async function applyClearRetiredSeatAsks(
  tx: Sql,
  workspaceId: string,
  actorUserId: string,
  principalId: string,
): Promise<RetiredSeatAskOutcome> {
  const [row] = await tx<{ result: Record<string, unknown> }[]>`
    SELECT swarm.clear_retired_seat_asks(
      ${workspaceId}::uuid,
      ${actorUserId}::uuid,
      ${principalId}::uuid
    ) AS result
  `;

  const result = row?.result ?? {};
  const status = typeof result.status === "string" ? result.status : "invalid_request";

  if (status === "ok") {
    const normalizedPrincipal = isUuid(result.principal_id)
      ? result.principal_id.toLowerCase()
      : principalId.toLowerCase();
    const cutoffEpoch = positiveInteger(result.cutoff_epoch);
    const clearedAt = typeof result.cleared_at === "string" && result.cleared_at.length > 0
      ? result.cleared_at
      : null;
    if (cutoffEpoch === null || clearedAt === null) {
      throw new Error("clear_retired_seat_asks returned incomplete cutoff payload");
    }
    return {
      ok: true,
      storedResponse: {
        principal_id: normalizedPrincipal,
        cutoff_epoch: cutoffEpoch,
        cleared_at: clearedAt,
      },
      wireResponse: {
        principal_id: normalizedPrincipal,
        cleared_at: clearedAt,
      },
    };
  }

  if (status === "clearing_not_enabled") {
    return {
      ok: false,
      status: 503,
      error: "service_unavailable",
      message: "Clearing retired seat asks is not enabled yet.",
      reason: "clearing_not_enabled",
    };
  }

  if (status === "seat_still_live") {
    return {
      ok: false,
      status: 409,
      error: RETIRED_SEAT_STILL_LIVE_BODY.error,
      message: RETIRED_SEAT_STILL_LIVE_BODY.message,
      reason: "seat_still_live",
    };
  }

  if (status === "not_found") {
    return {
      ok: false,
      status: 404,
      error: RETIRED_SEAT_NOT_FOUND_BODY.error,
      message: RETIRED_SEAT_NOT_FOUND_BODY.message,
      reason: "seat_not_found",
    };
  }

  if (status === "forbidden") {
    return {
      ok: false,
      status: 403,
      error: "forbidden",
      message: "You cannot clear retired seat asks in this workspace.",
      reason: "clear_retired_seat_asks_forbidden",
    };
  }

  return {
    ok: false,
    status: 400,
    error: "invalid_request",
    message: "Invalid clear retired seat asks parameters.",
    reason: "clear_retired_seat_asks_invalid_request",
  };
}

/**
 * Reauthorize releasing a stored clear_retired_seat_asks receipt to the calling person.
 * Calls read-only zero-lock swarm.seat_ask_clear_release_allowed against the stored
 * (principal_id, cutoff_epoch, cleared_at) tuple. Deliberately omits seat liveness so
 * authorized retries after reconnect succeed immediately without touching agent_ask_lifecycle.
 */
export async function reauthorizeRetiredSeatAskClearReplay(
  tx: Sql,
  workspaceId: string,
  actorUserId: string,
  storedResponse: Record<string, unknown>,
  commandPrincipalId: string,
): Promise<{ status: 404; body: Record<string, unknown> } | null> {
  const storedPrincipal = isUuid(storedResponse.principal_id)
    ? storedResponse.principal_id.toLowerCase()
    : null;
  const normalizedCommandPrincipal = isUuid(commandPrincipalId)
    ? commandPrincipalId.toLowerCase()
    : null;
  const cutoffEpoch = positiveInteger(storedResponse.cutoff_epoch);
  const clearedAt = typeof storedResponse.cleared_at === "string" &&
      storedResponse.cleared_at.length > 0
    ? storedResponse.cleared_at
    : null;

  if (
    !isUuid(workspaceId) ||
    !isUuid(actorUserId) ||
    storedPrincipal === null ||
    normalizedCommandPrincipal === null ||
    storedPrincipal !== normalizedCommandPrincipal ||
    cutoffEpoch === null ||
    clearedAt === null
  ) {
    return { status: 404, body: { ...RETIRED_SEAT_NOT_FOUND_BODY } };
  }

  const [row] = await tx<{ allowed: boolean }[]>`
    SELECT swarm.seat_ask_clear_release_allowed(
      ${workspaceId}::uuid,
      ${actorUserId}::uuid,
      ${storedPrincipal}::uuid,
      ${cutoffEpoch}::bigint,
      ${clearedAt}::timestamptz
    ) AS allowed
  `;
  if (row?.allowed === true) return null;
  return { status: 404, body: { ...RETIRED_SEAT_NOT_FOUND_BODY } };
}

/**
 * Build the blind public wire fields for clear_retired_seat_asks replay.
 * Strips internal cutoff_epoch (stored in idempotency_keys.response for replay
 * verification only) and never surfaces counts, signal IDs, or channel IDs.
 */
export function retiredSeatAskReplayFields(
  response: Record<string, unknown>,
): Record<string, unknown> {
  if (
    !isUuid(response.principal_id) ||
    typeof response.cleared_at !== "string" ||
    response.cleared_at.length === 0
  ) {
    return {};
  }
  return {
    principal_id: response.principal_id.toLowerCase(),
    cleared_at: response.cleared_at,
  };
}

/**
 * Leak-free audit detail for accepted/replayed clear_retired_seat_asks rows:
 * carries principal_id=<uuid> only (never counts, signal IDs, or channel IDs).
 * Refused calls must pass ignoredIdentity directly so probed UUIDs are not echoed.
 */
export function retiredSeatAskAuditDetail(
  principalId: string,
  ignoredIdentity: string | null,
): string {
  const token = `principal_id=${principalId.toLowerCase()}`;
  return ignoredIdentity ? `${ignoredIdentity}; ${token}` : token;
}
