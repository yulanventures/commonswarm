/**
 * Sender ask withdrawal & replacement: dedicated command module
 * (kept separate from command/index.ts, modeled on waiting-dismissals.ts).
 * Exact sender authorization, open-ask checks, idempotency, locking, and
 * read-time Waiting/Archived propagation live in 20261125000001_ask_withdrawals.sql.
 */
import type postgres from "postgres";

type Sql = postgres.TransactionSql<Record<string, unknown>>;

export const ASK_WITHDRAWAL_COMMAND_KINDS = [
  "withdraw_ask",
] as const;
export type AskWithdrawalCommandKind = typeof ASK_WITHDRAWAL_COMMAND_KINDS[number];

export interface WithdrawAskCommand {
  kind: "withdraw_ask";
  signal_id: string;
}

export type AskWithdrawalParse =
  | { ok: true; command: WithdrawAskCommand }
  | { ok: false; status: 400; reason: string };

export type AskWithdrawalOutcome =
  | {
    ok: true;
    response: Record<string, unknown>;
    channel_id: string | null;
  }
  | {
    ok: false;
    status: 400 | 403 | 404;
    error: string;
    message: string;
    reason: string;
  };

export const ASK_WITHDRAWAL_NOT_FOUND_BODY = {
  error: "not_found",
  message: "No open ask of yours has that id.",
} as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isAskWithdrawalCommandKind(kind: unknown): kind is AskWithdrawalCommandKind {
  return typeof kind === "string" &&
    (ASK_WITHDRAWAL_COMMAND_KINDS as readonly string[]).includes(kind);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export function parseAskWithdrawalCommand(cmd: Record<string, unknown>): AskWithdrawalParse {
  if (!isAskWithdrawalCommandKind(cmd.kind)) {
    return { ok: false, status: 400, reason: "Unknown ask withdrawal command." };
  }
  if (!exactKeys(cmd, ["kind", "signal_id"])) {
    return {
      ok: false,
      status: 400,
      reason: "withdraw_ask takes signal_id only.",
    };
  }
  if (!isUuid(cmd.signal_id)) {
    return {
      ok: false,
      status: 400,
      reason: "signal_id must be the UUID of an open ask you sent.",
    };
  }
  return {
    ok: true,
    command: {
      kind: "withdraw_ask",
      signal_id: cmd.signal_id.toLowerCase(),
    },
  };
}

export async function applyWithdrawAsk(
  tx: Sql,
  workspaceId: string,
  actorKind: "user" | "agent",
  actorId: string,
  signalId: string,
  replacedBySignalId: string | null = null,
): Promise<AskWithdrawalOutcome> {
  const [row] = await tx<{ result: Record<string, unknown> }[]>`
    SELECT swarm.withdraw_ask(
      ${workspaceId}::uuid,
      ${actorKind},
      ${actorId}::uuid,
      ${signalId}::uuid,
      ${replacedBySignalId}::uuid
    ) AS result
  `;

  const result = row?.result ?? {};
  const status = typeof result.status === "string" ? result.status : "invalid_request";

  if (status === "ok") {
    const channelId = typeof result.channel_id === "string" && UUID_RE.test(result.channel_id)
      ? result.channel_id.toLowerCase()
      : null;
    const replacedBy = typeof result.replaced_by_signal_id === "string" && UUID_RE.test(result.replaced_by_signal_id)
      ? result.replaced_by_signal_id.toLowerCase()
      : null;
    return {
      ok: true,
      channel_id: channelId,
      response: {
        signal_id: signalId.toLowerCase(),
        withdrawn: Boolean(result.withdrawn),
        ...(typeof result.created === "boolean" ? { created: result.created } : {}),
        ...(typeof result.withdrawn_at === "string" ? { withdrawn_at: result.withdrawn_at } : {}),
        ...(replacedBy !== null ? { replaced_by_signal_id: replacedBy } : {}),
      },
    };
  }

  if (status === "not_found") {
    return {
      ok: false,
      status: 404,
      error: ASK_WITHDRAWAL_NOT_FOUND_BODY.error,
      message: ASK_WITHDRAWAL_NOT_FOUND_BODY.message,
      reason: "ask_not_found",
    };
  }

  if (status === "forbidden") {
    return {
      ok: false,
      status: 403,
      error: "forbidden",
      message: "You cannot withdraw asks in this workspace.",
      reason: "ask_withdrawal_forbidden",
    };
  }

  return {
    ok: false,
    status: 400,
    error: "invalid_request",
    message: "Invalid ask withdrawal parameters.",
    reason: "ask_withdrawal_invalid_request",
  };
}

/** Preserve withdraw_ask and post_signal supersedes fields on idempotency replay. */
export function askWithdrawalReplayFields(response: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (typeof response.superseded_signal_id === "string" && UUID_RE.test(response.superseded_signal_id)) {
    fields.superseded_signal_id = response.superseded_signal_id.toLowerCase();
  }
  if (typeof response.withdrawn === "boolean" && typeof response.signal_id === "string" && UUID_RE.test(response.signal_id)) {
    fields.signal_id = response.signal_id.toLowerCase();
    fields.withdrawn = response.withdrawn;
    if (typeof response.created === "boolean") fields.created = response.created;
    if (typeof response.withdrawn_at === "string") fields.withdrawn_at = response.withdrawn_at;
    if (typeof response.replaced_by_signal_id === "string" && UUID_RE.test(response.replaced_by_signal_id)) {
      fields.replaced_by_signal_id = response.replaced_by_signal_id.toLowerCase();
    }
  }
  return fields;
}
