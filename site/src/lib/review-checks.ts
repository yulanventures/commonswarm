/**
 * Revision-bound review checks (C3): browser wire types, strict fail-closed parsers,
 * command/read payload builders, and pure thread-card view helpers.
 *
 * Matches the server contract in PR #710 (`supabase/functions/{read,command}/review-checks.ts`
 * and `20261120000005_review_checks.sql`). Every untrusted string (repo, ref, seat name, note,
 * head_sha) is validated here and rendered exclusively via textContent.
 */

export type ReviewCheckVerdict = "pass" | "hold";
export type ReviewCheckEffectiveVerdict = ReviewCheckVerdict | "pending";
export type ReviewCheckStatus = "pending" | "hold" | "satisfied";
export type ReviewCheckSeatKind = "user" | "agent";

export interface ReviewCheckSeat {
  kind: ReviewCheckSeatKind;
  id: string;
}

export interface ReviewCheckSeatInfo extends ReviewCheckSeat {
  name: string | null;
}

export interface ReviewCheckStamp {
  seatKind: ReviewCheckSeatKind;
  seatId: string;
  name: string | null;
  verdict: ReviewCheckVerdict | null;
  headSha: string | null;
  note: string | null;
  stampedAt: string | null;
  stale: boolean;
  effectiveVerdict: ReviewCheckEffectiveVerdict;
}

export interface ReviewCheckRecord {
  checkId: string;
  workspaceId: string;
  subject: {
    kind: "pr";
    repo: string;
    ref: string;
  };
  headSha: string;
  conversationId: string | null;
  channelId: string | null;
  threadRootId: string | null;
  requiredSeats: ReviewCheckSeatInfo[];
  stamps: ReviewCheckStamp[];
  status: ReviewCheckStatus;
  satisfied: boolean;
  satisfiedHeadSha: string | null;
  satisfiedSignalId: string | null;
  satisfiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ReviewChecksReadOutcome =
  | { status: "ready"; checks: ReviewCheckRecord[] }
  | { status: "unsupported"; message: string }
  | { status: "denied"; message: string }
  | { status: "failed"; message: string };

export type StampReviewCheckResult =
  | {
    ok: true;
    reviewCheck: ReviewCheckRecord;
    satisfiedNow: boolean;
    satisfiedSignalId: string | null;
  }
  | {
    ok: false;
    status: number;
    error: string | null;
    message: string;
    currentHeadSha?: string;
  };

export const REVIEW_CHECK_NOTE_MAX = 500;
export const REVIEW_CHECK_STAMP_FAILED = "Couldn't record that verdict. Try again.";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FULL_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const UNSUPPORTED_READ_ERRORS = new Set([
  "unknown_resource",
  "invalid_resource",
  "unsupported_resource",
]);

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nullableUuid(value: unknown): string | null {
  return typeof value === "string" && UUID_RE.test(value) ? value.toLowerCase() : null;
}

function nullableSha(value: unknown): string | null {
  return typeof value === "string" && FULL_SHA_RE.test(value) ? value.toLowerCase() : null;
}

function errorSentence(body: Record<string, unknown>, fallback: string): string {
  return typeof body.message === "string" && body.message.trim().length > 0
    ? body.message.trim()
    : fallback;
}

/** First 9 hex characters of a commit SHA, matching CLI `renderReviewCheck`. */
export function shortReviewSha(sha: string): string {
  return sha.trim().toLowerCase().slice(0, 9);
}

/** Trim and collapse leading/trailing whitespace on an optional stamp note. */
export function cleanReviewCheckNote(raw: string): string {
  return raw.trim().slice(0, REVIEW_CHECK_NOTE_MAX);
}

export function parseReviewCheckSeatInfo(value: unknown): ReviewCheckSeatInfo | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const kind = row.kind === "user" || row.kind === "agent" ? row.kind : null;
  const id = nullableUuid(row.id);
  if (!kind || !id) return null;
  return { kind, id, name: nullableText(row.name) };
}

export function parseReviewCheckStamp(value: unknown): ReviewCheckStamp | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const seatKind = row.seat_kind === "user" || row.seat_kind === "agent" ? row.seat_kind : null;
  const seatId = nullableUuid(row.seat_id);
  if (!seatKind || !seatId) return null;
  const verdict = row.verdict === "pass" || row.verdict === "hold" ? row.verdict : null;
  const effectiveVerdict =
    row.effective_verdict === "pass" ||
    row.effective_verdict === "hold" ||
    row.effective_verdict === "pending"
      ? row.effective_verdict
      : "pending";
  return {
    seatKind,
    seatId,
    name: nullableText(row.name),
    verdict,
    headSha: nullableSha(row.head_sha),
    note: nullableText(row.note),
    stampedAt: nullableText(row.stamped_at),
    stale: row.stale === true,
    effectiveVerdict,
  };
}

export function parseReviewCheckRecord(value: unknown): ReviewCheckRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const checkId = nullableUuid(row.check_id);
  const workspaceId = nullableUuid(row.workspace_id);
  const headSha = nullableSha(row.head_sha);
  const subjectRaw =
    row.subject && typeof row.subject === "object" && !Array.isArray(row.subject)
      ? (row.subject as Record<string, unknown>)
      : null;
  const repo = subjectRaw ? nullableText(subjectRaw.repo) : null;
  const ref = subjectRaw ? nullableText(subjectRaw.ref) : null;
  const status =
    row.status === "pending" || row.status === "hold" || row.status === "satisfied"
      ? row.status
      : null;
  if (!checkId || !workspaceId || !headSha || !subjectRaw || subjectRaw.kind !== "pr" || !repo || !ref || !status) {
    return null;
  }
  if (!Array.isArray(row.required_seats) || !Array.isArray(row.stamps)) return null;
  const requiredSeats: ReviewCheckSeatInfo[] = [];
  for (const item of row.required_seats) {
    const parsed = parseReviewCheckSeatInfo(item);
    if (!parsed) return null;
    requiredSeats.push(parsed);
  }
  const stamps: ReviewCheckStamp[] = [];
  for (const item of row.stamps) {
    const parsed = parseReviewCheckStamp(item);
    if (!parsed) return null;
    stamps.push(parsed);
  }
  const createdAt = nullableText(row.created_at) ?? "";
  const updatedAt = nullableText(row.updated_at) ?? "";
  return {
    checkId,
    workspaceId,
    subject: { kind: "pr", repo, ref },
    headSha,
    conversationId: nullableUuid(row.conversation_id),
    channelId: nullableUuid(row.channel_id),
    threadRootId: nullableUuid(row.thread_root_id),
    requiredSeats,
    stamps,
    status,
    satisfied: row.satisfied === true,
    satisfiedHeadSha: nullableSha(row.satisfied_head_sha),
    satisfiedSignalId: nullableUuid(row.satisfied_signal_id),
    satisfiedAt: nullableText(row.satisfied_at),
    createdAt,
    updatedAt,
  };
}

export function buildReviewChecksReadRequest(
  workspaceId: string,
  options: {
    checkId?: string | null;
    threadRootId?: string | null;
    conversationId?: string | null;
    limit?: number;
  } = {},
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    resource: "review_checks",
    workspace_id: workspaceId.toLowerCase(),
  };
  if (options.checkId) payload.check_id = options.checkId.toLowerCase();
  if (options.threadRootId) payload.thread_root_id = options.threadRootId.toLowerCase();
  if (options.conversationId) payload.conversation_id = options.conversationId.toLowerCase();
  if (options.limit !== undefined) payload.limit = Math.max(1, Math.min(50, Math.trunc(options.limit)));
  return payload;
}

export function reviewCheckStampCommand(
  checkId: string,
  headSha: string,
  verdict: ReviewCheckVerdict,
  note?: string | null,
): Record<string, unknown> {
  const cleanedNote = typeof note === "string" ? cleanReviewCheckNote(note) : "";
  return {
    kind: "review_check_stamp",
    check_id: checkId.toLowerCase(),
    head_sha: headSha.trim().toLowerCase(),
    verdict,
    ...(cleanedNote.length > 0 ? { note: cleanedNote } : {}),
  };
}

export function parseReviewChecksReadOutcome(
  status: number,
  body: Record<string, unknown>,
): ReviewChecksReadOutcome {
  if (status === 200) {
    if (Array.isArray(body.review_checks)) {
      const checks: ReviewCheckRecord[] = [];
      for (const item of body.review_checks) {
        const parsed = parseReviewCheckRecord(item);
        if (!parsed) return { status: "failed", message: "Review check response was malformed." };
        checks.push(parsed);
      }
      return { status: "ready", checks };
    }
    if (body.review_check !== undefined) {
      if (body.review_check === null) return { status: "ready", checks: [] };
      const parsed = parseReviewCheckRecord(body.review_check);
      if (!parsed) return { status: "failed", message: "Review check response was malformed." };
      return { status: "ready", checks: [parsed] };
    }
    return { status: "failed", message: "Review check response was malformed." };
  }
  const code = typeof body.error === "string" ? body.error : "";
  if ((status === 400 || status === 404) && UNSUPPORTED_READ_ERRORS.has(code)) {
    return { status: "unsupported", message: errorSentence(body, "Review checks are unavailable on this server.") };
  }
  if (status === 403 || status === 404) {
    return { status: "denied", message: errorSentence(body, "Review checks are unavailable in this conversation.") };
  }
  return { status: "failed", message: errorSentence(body, "Couldn't load review checks.") };
}

export function parseStampReviewCheckOutcome(
  status: number,
  body: Record<string, unknown>,
): StampReviewCheckResult {
  if (status === 200 && body.status === "accepted") {
    const parsed = parseReviewCheckRecord(body.review_check);
    if (parsed) {
      return {
        ok: true,
        reviewCheck: parsed,
        satisfiedNow: body.satisfied_now === true,
        satisfiedSignalId: nullableUuid(body.satisfied_signal_id),
      };
    }
  }
  const error = typeof body.error === "string" ? body.error : null;
  const currentHeadSha = nullableSha(body.current_head_sha) ?? undefined;
  if (status === 409 && error === "stale_head") {
    return {
      ok: false,
      status,
      error,
      ...(currentHeadSha ? { currentHeadSha } : {}),
      message: currentHeadSha
        ? `Head moved to ${shortReviewSha(currentHeadSha)}. Check refreshed — verify the new head before stamping.`
        : "Head moved. Check refreshed — verify the new head before stamping.",
    };
  }
  return {
    ok: false,
    status,
    error,
    message: errorSentence(body, REVIEW_CHECK_STAMP_FAILED),
  };
}

/** Returns the viewer's own required seat row iff the signed-in user is named on this check. */
export function viewerRequiredStamp(
  check: Pick<ReviewCheckRecord, "stamps">,
  viewerUserId: string | null | undefined,
): ReviewCheckStamp | null {
  if (!viewerUserId) return null;
  const target = viewerUserId.toLowerCase();
  return check.stamps.find((stamp) => stamp.seatKind === "user" && stamp.seatId === target) ?? null;
}

/** Group thread-bound review checks by `threadRootId`, sorted newest-updated first. */
export function groupReviewChecksByThreadRoot(
  checks: readonly ReviewCheckRecord[],
): Map<string, ReviewCheckRecord[]> {
  const byRoot = new Map<string, ReviewCheckRecord[]>();
  const sorted = [...checks].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt) || left.checkId.localeCompare(right.checkId),
  );
  for (const check of sorted) {
    if (!check.threadRootId) continue;
    const list = byRoot.get(check.threadRootId);
    if (list) list.push(check);
    else byRoot.set(check.threadRootId, [check]);
  }
  return byRoot;
}

/** Upsert a freshly stamped review check into a thread-root map without mutating the previous map. */
export function upsertReviewCheckInMap(
  current: ReadonlyMap<string, readonly ReviewCheckRecord[]>,
  updated: ReviewCheckRecord,
): Map<string, ReviewCheckRecord[]> {
  const next = new Map<string, ReviewCheckRecord[]>();
  for (const [rootId, list] of current) {
    next.set(rootId, list.filter((item) => item.checkId !== updated.checkId));
  }
  if (updated.threadRootId) {
    const existing = next.get(updated.threadRootId) ?? [];
    existing.unshift(updated);
    existing.sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) || left.checkId.localeCompare(right.checkId),
    );
    next.set(updated.threadRootId, existing);
  }
  for (const [rootId, list] of next) {
    if (list.length === 0) next.delete(rootId);
  }
  return next;
}

export interface ReviewCheckStatusSummary {
  label: string;
  countLabel: string;
  tone: "ready" | "hold" | "pending";
  passedCount: number;
  holdCount: number;
  requiredCount: number;
}

/** Concise status pill and progress count for the card header (never relies on colour alone). */
export function reviewCheckStatusSummary(
  check: Pick<ReviewCheckRecord, "status" | "stamps">,
): ReviewCheckStatusSummary {
  const requiredCount = check.stamps.length;
  let passedCount = 0;
  let holdCount = 0;
  for (const stamp of check.stamps) {
    if (stamp.effectiveVerdict === "pass") passedCount += 1;
    else if (stamp.effectiveVerdict === "hold") holdCount += 1;
  }
  if (check.status === "satisfied") {
    return {
      label: "Ready",
      countLabel: `${passedCount}/${requiredCount}`,
      tone: "ready",
      passedCount,
      holdCount,
      requiredCount,
    };
  }
  if (check.status === "hold") {
    return {
      label: "Hold",
      countLabel: `${passedCount}/${requiredCount}`,
      tone: "hold",
      passedCount,
      holdCount,
      requiredCount,
    };
  }
  return {
    label: "Pending",
    countLabel: `${passedCount}/${requiredCount}`,
    tone: "pending",
    passedCount,
    holdCount,
    requiredCount,
  };
}
