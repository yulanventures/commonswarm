/**
 * Waiting on you per-person dismissals (Slice 1): dedicated command module
 * (kept separate from command/index.ts, modeled on review-checks.ts).
 * Every visibility, membership, eligibility, locking, and audit-view rule lives in
 * 20261124000001_waiting_dismissals.sql; this module validates the wire shape,
 * maps SQL outcomes to typed HTTP responses, and reauthorizes idempotency replays.
 */
import type postgres from "postgres";

type Sql = postgres.TransactionSql<Record<string, unknown>>;

export const WAITING_DISMISSAL_COMMAND_KINDS = [
  "dismiss_waiting_item",
  "restore_waiting_item",
] as const;
export type WaitingDismissalCommandKind = typeof WAITING_DISMISSAL_COMMAND_KINDS[number];

export const WAITING_DISMISSAL_ITEM_KINDS = ["ask", "todo", "review"] as const;
export type WaitingDismissalItemKind = typeof WAITING_DISMISSAL_ITEM_KINDS[number];

export type WaitingDismissalCommand =
  | {
    kind: "dismiss_waiting_item";
    item_kind: WaitingDismissalItemKind;
    item_id: string;
  }
  | {
    kind: "restore_waiting_item";
    item_kind: WaitingDismissalItemKind;
    item_id: string;
  };

export type WaitingDismissalParse =
  | { ok: true; command: WaitingDismissalCommand }
  | { ok: false; status: 400; reason: string };

export type WaitingDismissalOutcome =
  | { ok: true; response: Record<string, unknown> }
  | {
    ok: false;
    status: 400 | 403 | 404;
    error: string;
    message: string;
    reason: string;
  };

export const WAITING_ITEM_NOT_FOUND_BODY = {
  error: "not_found",
  message: "Waiting item not found.",
} as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isWaitingDismissalCommandKind(kind: unknown): kind is WaitingDismissalCommandKind {
  return typeof kind === "string" &&
    (WAITING_DISMISSAL_COMMAND_KINDS as readonly string[]).includes(kind);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export function parseWaitingDismissalCommand(cmd: Record<string, unknown>): WaitingDismissalParse {
  if (!isWaitingDismissalCommandKind(cmd.kind)) {
    return { ok: false, status: 400, reason: "Unknown waiting dismissal command." };
  }
  if (!exactKeys(cmd, ["kind", "item_kind", "item_id"])) {
    return {
      ok: false,
      status: 400,
      reason: `${cmd.kind} takes item_kind and item_id.`,
    };
  }
  if (
    typeof cmd.item_kind !== "string" ||
    !(WAITING_DISMISSAL_ITEM_KINDS as readonly string[]).includes(cmd.item_kind)
  ) {
    return {
      ok: false,
      status: 400,
      reason: 'item_kind must be "ask", "todo", or "review".',
    };
  }
  if (!isUuid(cmd.item_id)) {
    return { ok: false, status: 400, reason: "item_id must be a UUID." };
  }
  return {
    ok: true,
    command: {
      kind: cmd.kind,
      item_kind: cmd.item_kind as WaitingDismissalItemKind,
      item_id: cmd.item_id.toLowerCase(),
    },
  };
}

export async function applyWaitingDismissalCommand(
  tx: Sql,
  workspaceId: string,
  userId: string,
  command: WaitingDismissalCommand,
): Promise<WaitingDismissalOutcome> {
  const [row] = command.kind === "dismiss_waiting_item"
    ? await tx<{ result: Record<string, unknown> }[]>`
      SELECT swarm.dismiss_waiting_item(
        ${workspaceId}::uuid,
        ${userId}::uuid,
        ${command.item_kind},
        ${command.item_id}::uuid
      ) AS result
    `
    : await tx<{ result: Record<string, unknown> }[]>`
      SELECT swarm.restore_waiting_item(
        ${workspaceId}::uuid,
        ${userId}::uuid,
        ${command.item_kind},
        ${command.item_id}::uuid
      ) AS result
    `;

  const result = row?.result ?? {};
  const status = typeof result.status === "string" ? result.status : "invalid_request";

  if (status === "ok") {
    if (command.kind === "dismiss_waiting_item") {
      return {
        ok: true,
        response: {
          item_kind: command.item_kind,
          item_id: command.item_id,
          dismissed: Boolean(result.dismissed),
          ...(typeof result.dismissed_at === "string" ? { dismissed_at: result.dismissed_at } : {}),
        },
      };
    }
    return {
      ok: true,
      response: {
        item_kind: command.item_kind,
        item_id: command.item_id,
        restored: Boolean(result.restored),
        ...(typeof result.restored_at === "string" ? { restored_at: result.restored_at } : {}),
      },
    };
  }

  if (status === "not_found") {
    return {
      ok: false,
      status: 404,
      error: WAITING_ITEM_NOT_FOUND_BODY.error,
      message: WAITING_ITEM_NOT_FOUND_BODY.message,
      reason: "waiting_item_not_found",
    };
  }

  if (status === "forbidden") {
    return {
      ok: false,
      status: 403,
      error: "forbidden",
      message: "You cannot modify waiting items in this workspace.",
      reason: "waiting_dismissal_forbidden",
    };
  }

  return {
    ok: false,
    status: 400,
    error: "invalid_request",
    message: "Invalid waiting dismissal parameters.",
    reason: "waiting_dismissal_invalid_request",
  };
}

/** Reauthorize a stored dismiss/restore receipt against the caller's live Waiting eligibility.
 *  Returns null when authorized (caller receives the original receipt), or the uniform 404 otherwise. */
export async function reauthorizeWaitingDismissalReplay(
  tx: Sql,
  workspaceId: string,
  userId: string,
  itemKind: WaitingDismissalItemKind,
  itemId: string,
): Promise<{ status: 404; body: Record<string, unknown> } | null> {
  const [row] = await tx<{ allowed: boolean }[]>`
    SELECT swarm.waiting_dismissal_replay_allowed(
      ${workspaceId}::uuid,
      ${userId}::uuid,
      ${itemKind},
      ${itemId}::uuid
    ) AS allowed
  `;
  if (row?.allowed === true) return null;
  return {
    status: 404,
    body: { ...WAITING_ITEM_NOT_FOUND_BODY },
  };
}

/** Preserve waiting dismissal fields on idempotency replay without touching other stored responses. */
export function waitingDismissalReplayFields(response: Record<string, unknown>): Record<string, unknown> {
  if (
    typeof response.item_kind !== "string" ||
    !(WAITING_DISMISSAL_ITEM_KINDS as readonly string[]).includes(response.item_kind) ||
    typeof response.item_id !== "string"
  ) {
    return {};
  }
  return {
    item_kind: response.item_kind,
    item_id: response.item_id,
    ...(typeof response.dismissed === "boolean" ? { dismissed: response.dismissed } : {}),
    ...(typeof response.dismissed_at === "string" ? { dismissed_at: response.dismissed_at } : {}),
    ...(typeof response.restored === "boolean" ? { restored: response.restored } : {}),
    ...(typeof response.restored_at === "string" ? { restored_at: response.restored_at } : {}),
  };
}
