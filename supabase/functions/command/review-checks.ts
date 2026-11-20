/**
 * Revision-bound review checks (C3): dedicated command module (kept separate from command/index.ts).
 * Every authority, lock, head-invalidation, and once-only satisfied thread note rule lives in
 * 20261120000005_review_checks.sql; this module validates the wire shape and maps SQL outcomes.
 */
import type postgres from "postgres";

type Sql = postgres.TransactionSql<Record<string, unknown>>;

export const REVIEW_CHECK_COMMAND_KINDS = [
  "review_check_open",
  "review_check_stamp",
] as const;
export type ReviewCheckCommandKind = typeof REVIEW_CHECK_COMMAND_KINDS[number];

export const REVIEW_CHECK_VERDICTS = ["pass", "hold"] as const;
export type ReviewCheckVerdict = typeof REVIEW_CHECK_VERDICTS[number];

export const REVIEW_CHECK_SEATS_MAX = 20;

export interface ReviewCheckSeat {
  kind: "user" | "agent";
  id: string;
}

export type ReviewCheckCommand =
  | {
    kind: "review_check_open";
    subject_repo: string;
    subject_ref: string;
    head_sha: string;
    required_seats: ReviewCheckSeat[];
    conversation_id: string | null;
    thread_root_id: string | null;
  }
  | {
    kind: "review_check_stamp";
    check_id: string;
    head_sha: string;
    verdict: ReviewCheckVerdict;
    note: string | null;
  };

export type ReviewCheckParse =
  | { ok: true; command: ReviewCheckCommand }
  | { ok: false; status: 400; reason: string };

export interface ReviewCheckActor {
  kind: "user" | "agent";
  id: string;
}

export type ReviewCheckOutcome =
  | { ok: true; response: Record<string, unknown> }
  | {
    ok: false;
    status: 400 | 403 | 404 | 409;
    error: string;
    message: string;
    reason: string;
    extra?: Record<string, unknown>;
  };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA_RE = /^[0-9a-f]{7,64}$/i;
const CTRL_RE = /[\x00-\x1f\x7f]/;

export function isReviewCheckCommandKind(kind: unknown): kind is ReviewCheckCommandKind {
  return typeof kind === "string" &&
    (REVIEW_CHECK_COMMAND_KINDS as readonly string[]).includes(kind);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

function parseSeat(value: unknown): ReviewCheckSeat | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!exactKeys(row, ["kind", "id"])) return null;
  if ((row.kind !== "user" && row.kind !== "agent") || !isUuid(row.id)) return null;
  return { kind: row.kind, id: row.id.toLowerCase() };
}

export function parseReviewCheckCommand(cmd: Record<string, unknown>): ReviewCheckParse {
  if (cmd.kind === "review_check_open") {
    const allowed = [
      "kind",
      "subject_repo",
      "subject_ref",
      "head_sha",
      "required_seats",
      ...(Object.hasOwn(cmd, "conversation_id") ? ["conversation_id"] : []),
      ...(Object.hasOwn(cmd, "thread_root_id") ? ["thread_root_id"] : []),
    ];
    if (!exactKeys(cmd, allowed)) {
      return {
        ok: false,
        status: 400,
        reason: "review_check_open takes subject_repo, subject_ref, head_sha, required_seats, and optionally conversation_id and thread_root_id.",
      };
    }
    const repo = typeof cmd.subject_repo === "string" ? cmd.subject_repo.trim() : "";
    if (repo.length < 1 || repo.length > 160 || CTRL_RE.test(repo)) {
      return { ok: false, status: 400, reason: "subject_repo must be 1 to 160 printable characters." };
    }
    const ref = typeof cmd.subject_ref === "string" ? cmd.subject_ref.trim() : "";
    if (ref.length < 1 || ref.length > 80 || CTRL_RE.test(ref)) {
      return { ok: false, status: 400, reason: "subject_ref must be 1 to 80 printable characters." };
    }
    const sha = typeof cmd.head_sha === "string" ? cmd.head_sha.trim().toLowerCase() : "";
    if (!SHA_RE.test(sha)) {
      return { ok: false, status: 400, reason: "head_sha must be a 7 to 64 character hex commit SHA." };
    }
    if (!Array.isArray(cmd.required_seats) || cmd.required_seats.length < 1 || cmd.required_seats.length > REVIEW_CHECK_SEATS_MAX) {
      return {
        ok: false,
        status: 400,
        reason: `required_seats must list 1 to ${REVIEW_CHECK_SEATS_MAX} seats as {"kind":"user"|"agent","id":"<uuid>"}.`,
      };
    }
    const seats: ReviewCheckSeat[] = [];
    const seen = new Set<string>();
    for (const raw of cmd.required_seats) {
      const seat = parseSeat(raw);
      if (seat === null) {
        return {
          ok: false,
          status: 400,
          reason: 'Each required seat must be {"kind":"user"|"agent","id":"<uuid>"}.',
        };
      }
      const key = `${seat.kind}:${seat.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        seats.push(seat);
      }
    }
    const conversationId = cmd.conversation_id === undefined || cmd.conversation_id === null
      ? null
      : isUuid(cmd.conversation_id)
      ? cmd.conversation_id.toLowerCase()
      : undefined;
    if (conversationId === undefined) {
      return { ok: false, status: 400, reason: "conversation_id must be a UUID or null." };
    }
    const threadRootId = cmd.thread_root_id === undefined || cmd.thread_root_id === null
      ? null
      : isUuid(cmd.thread_root_id)
      ? cmd.thread_root_id.toLowerCase()
      : undefined;
    if (threadRootId === undefined) {
      return { ok: false, status: 400, reason: "thread_root_id must be a UUID or null." };
    }
    return {
      ok: true,
      command: {
        kind: "review_check_open",
        subject_repo: repo,
        subject_ref: ref,
        head_sha: sha,
        required_seats: seats,
        conversation_id: conversationId,
        thread_root_id: threadRootId,
      },
    };
  }

  if (cmd.kind === "review_check_stamp") {
    const allowed = [
      "kind",
      "check_id",
      "head_sha",
      "verdict",
      ...(Object.hasOwn(cmd, "note") ? ["note"] : []),
    ];
    if (!exactKeys(cmd, allowed)) {
      return {
        ok: false,
        status: 400,
        reason: "review_check_stamp takes check_id, head_sha, verdict, and optionally note.",
      };
    }
    if (!isUuid(cmd.check_id)) {
      return { ok: false, status: 400, reason: "check_id must be a UUID." };
    }
    const sha = typeof cmd.head_sha === "string" ? cmd.head_sha.trim().toLowerCase() : "";
    if (!SHA_RE.test(sha)) {
      return { ok: false, status: 400, reason: "head_sha must be a 7 to 64 character hex commit SHA." };
    }
    if (typeof cmd.verdict !== "string" || !(REVIEW_CHECK_VERDICTS as readonly string[]).includes(cmd.verdict)) {
      return { ok: false, status: 400, reason: 'verdict must be "pass" or "hold".' };
    }
    let note: string | null = null;
    if (cmd.note !== undefined && cmd.note !== null) {
      if (typeof cmd.note !== "string") {
        return { ok: false, status: 400, reason: "note must be a string or null." };
      }
      const trimmed = cmd.note.trim();
      if (trimmed.length > 2000) {
        return { ok: false, status: 400, reason: "note must be at most 2000 characters." };
      }
      note = trimmed.length > 0 ? trimmed : null;
    }
    return {
      ok: true,
      command: {
        kind: "review_check_stamp",
        check_id: cmd.check_id.toLowerCase(),
        head_sha: sha,
        verdict: cmd.verdict as ReviewCheckVerdict,
        note,
      },
    };
  }

  return { ok: false, status: 400, reason: "Unknown review check command." };
}

export async function applyReviewCheckCommand(
  tx: Sql,
  workspaceId: string,
  actor: ReviewCheckActor,
  command: ReviewCheckCommand,
): Promise<ReviewCheckOutcome> {
  if (command.kind === "review_check_open") {
    const [row] = await tx<{ result: Record<string, unknown> }[]>`
      SELECT swarm.review_check_open(
        ${workspaceId}::uuid,
        ${actor.kind},
        ${actor.id}::uuid,
        ${command.subject_repo},
        ${command.subject_ref},
        ${command.head_sha},
        ${tx.json(command.required_seats as unknown as postgres.JSONValue)}::jsonb,
        ${command.conversation_id}::uuid,
        ${command.thread_root_id}::uuid
      ) AS result
    `;
    const result = row?.result ?? {};
    const status = typeof result.status === "string" ? result.status : "invalid_request";
    if (status === "ok") {
      return {
        ok: true,
        response: {
          review_check: result.check,
          created: Boolean(result.created),
          head_changed: Boolean(result.head_changed),
        },
      };
    }
    if (status === "not_found") {
      return {
        ok: false,
        status: 404,
        error: "not_found",
        message: "The review check target conversation or thread was not found.",
        reason: "review_check_target_not_found",
      };
    }
    if (status === "forbidden") {
      return {
        ok: false,
        status: 403,
        error: "forbidden",
        message: "You cannot open a review check in this workspace.",
        reason: "review_check_forbidden",
      };
    }
    if (status === "invalid_seat") {
      return {
        ok: false,
        status: 400,
        error: "invalid_seat",
        message: "Every required seat must be an active member of this workspace with access to the target conversation.",
        reason: "review_check_invalid_seat",
      };
    }
    return {
      ok: false,
      status: 400,
      error: "invalid_request",
      message: "Invalid review check parameters.",
      reason: "review_check_invalid_request",
    };
  }

  const [row] = await tx<{ result: Record<string, unknown> }[]>`
    SELECT swarm.review_check_stamp(
      ${workspaceId}::uuid,
      ${actor.kind},
      ${actor.id}::uuid,
      ${command.check_id}::uuid,
      ${command.head_sha},
      ${command.verdict},
      ${command.note}
    ) AS result
  `;
  const result = row?.result ?? {};
  const status = typeof result.status === "string" ? result.status : "invalid_request";
  if (status === "ok") {
    return {
      ok: true,
      response: {
        review_check: result.check,
        satisfied_now: Boolean(result.satisfied_now),
        satisfied_signal_id: result.satisfied_signal_id ?? null,
      },
    };
  }
  if (status === "not_found") {
    return {
      ok: false,
      status: 404,
      error: "not_found",
      message: "Review check not found.",
      reason: "review_check_not_found",
    };
  }
  if (status === "not_required_seat") {
    return {
      ok: false,
      status: 403,
      error: "not_required_seat",
      message: "Only a required seat named on this review check can stamp its own row.",
      reason: "review_check_not_required_seat",
    };
  }
  if (status === "stale_head") {
    const currentHead = typeof result.current_head_sha === "string" ? result.current_head_sha : null;
    return {
      ok: false,
      status: 409,
      error: "stale_head",
      message: currentHead
        ? `Head SHA has moved to ${currentHead}. Re-verify the current head before stamping.`
        : "Head SHA has moved. Re-verify the current head before stamping.",
      reason: "review_check_stale_head",
      ...(currentHead ? { extra: { current_head_sha: currentHead } } : {}),
    };
  }
  if (status === "forbidden") {
    return {
      ok: false,
      status: 403,
      error: "forbidden",
      message: "You cannot stamp a review check in this workspace.",
      reason: "review_check_forbidden",
    };
  }
  return {
    ok: false,
    status: 400,
    error: "invalid_request",
    message: "Invalid review check stamp parameters.",
    reason: "review_check_invalid_request",
  };
}

/** Conversation ID stored on a review_check replay, if scoped to a conversation. */
export function storedReviewCheckConversationId(response: Record<string, unknown>): string | undefined {
  const check = response.review_check;
  if (!check || typeof check !== "object" || Array.isArray(check)) return undefined;
  const convId = (check as Record<string, unknown>).conversation_id;
  return typeof convId === "string" && UUID_RE.test(convId) ? convId : undefined;
}

/** Preserve review check fields on idempotency replay without touching other stored responses. */
export function reviewCheckReplayFields(response: Record<string, unknown>): Record<string, unknown> {
  if (response.review_check === undefined || response.review_check === null || typeof response.review_check !== "object") {
    return {};
  }
  return {
    review_check: response.review_check,
    ...(typeof response.created === "boolean" ? { created: response.created } : {}),
    ...(typeof response.head_changed === "boolean" ? { head_changed: response.head_changed } : {}),
    ...(typeof response.satisfied_now === "boolean" ? { satisfied_now: response.satisfied_now } : {}),
    ...(response.satisfied_signal_id === null || typeof response.satisfied_signal_id === "string"
      ? { satisfied_signal_id: response.satisfied_signal_id }
      : {}),
  };
}
