/**
 * Revision-bound review checks (C3): read edge module.
 * All visibility and workspace-membership checks live in swarm.review_check_read
 * (20261120000005_review_checks.sql).
 */
import type postgres from "npm:postgres@3.4.9";

type Sql = postgres.TransactionSql<Record<string, unknown>>;

export interface ReviewCheckReadRequest {
  resource: "review_checks";
  workspace_id: string;
  check_id: string | null;
  subject_repo: string | null;
  subject_ref: string | null;
  thread_root_id: string | null;
  conversation_id: string | null;
  limit: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CTRL_RE = /[\x00-\x1f\x7f]/;
const ALLOWED_KEYS = new Set([
  "resource",
  "workspace_id",
  "check_id",
  "subject_repo",
  "subject_ref",
  "thread_root_id",
  "conversation_id",
  "limit",
]);

export function isReviewCheckReadResource(resource: unknown): resource is "review_checks" {
  return resource === "review_checks";
}

export function isReviewCheckReadRequest(
  body: { resource: string },
): body is ReviewCheckReadRequest {
  return body.resource === "review_checks";
}

export function parseReviewCheckReadRequest(
  body: Record<string, unknown>,
): ReviewCheckReadRequest | null {
  if (body.resource !== "review_checks") return null;
  if (!Object.keys(body).every((key) => ALLOWED_KEYS.has(key))) return null;
  if (typeof body.workspace_id !== "string" || !UUID_RE.test(body.workspace_id)) return null;

  const parseOptionalUuid = (value: unknown): string | null | undefined => {
    if (value === undefined || value === null) return null;
    return typeof value === "string" && UUID_RE.test(value) ? value.toLowerCase() : undefined;
  };
  const checkId = parseOptionalUuid(body.check_id);
  const threadRootId = parseOptionalUuid(body.thread_root_id);
  const conversationId = parseOptionalUuid(body.conversation_id);
  if (checkId === undefined || threadRootId === undefined || conversationId === undefined) {
    return null;
  }

  let subjectRepo: string | null = null;
  let subjectRef: string | null = null;
  if (body.subject_repo !== undefined && body.subject_repo !== null) {
    if (typeof body.subject_repo !== "string") return null;
    const trimmed = body.subject_repo.trim();
    if (trimmed.length < 1 || trimmed.length > 160 || CTRL_RE.test(trimmed)) return null;
    subjectRepo = trimmed;
  }
  if (body.subject_ref !== undefined && body.subject_ref !== null) {
    if (typeof body.subject_ref !== "string") return null;
    const trimmed = body.subject_ref.trim();
    if (trimmed.length < 1 || trimmed.length > 80 || CTRL_RE.test(trimmed)) return null;
    subjectRef = trimmed;
  }
  if ((subjectRepo === null) !== (subjectRef === null)) return null;

  let limit = 20;
  if (body.limit !== undefined) {
    if (typeof body.limit !== "number" || !Number.isInteger(body.limit) || body.limit < 1 || body.limit > 50) {
      return null;
    }
    limit = body.limit;
  }

  return {
    resource: "review_checks",
    workspace_id: body.workspace_id.toLowerCase(),
    check_id: checkId,
    subject_repo: subjectRepo,
    subject_ref: subjectRef,
    thread_root_id: threadRootId,
    conversation_id: conversationId,
    limit,
  };
}

export async function executeReviewCheckRead(
  tx: Sql,
  body: ReviewCheckReadRequest,
  actor: { kind: "user" | "agent"; id: string },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const [row] = await tx<{ result: Record<string, unknown> }[]>`
    SELECT swarm.review_check_read(
      ${body.workspace_id}::uuid,
      ${actor.kind},
      ${actor.id}::uuid,
      ${body.check_id}::uuid,
      ${body.subject_repo},
      ${body.subject_ref},
      ${body.thread_root_id}::uuid,
      ${body.conversation_id}::uuid,
      ${body.limit}
    ) AS result
  `;
  const result = row?.result ?? {};
  const status = typeof result.status === "string" ? result.status : "not_found";
  if (status === "forbidden") {
    return { status: 403, body: { error: "forbidden", message: "You cannot read review checks in this workspace." } };
  }
  if (status === "not_found") {
    return { status: 404, body: { error: "not_found", message: "Review check not found." } };
  }
  if (body.check_id !== null || (body.subject_repo !== null && body.subject_ref !== null)) {
    return { status: 200, body: { review_check: result.check ?? null } };
  }
  return {
    status: 200,
    body: { review_checks: Array.isArray(result.checks) ? result.checks : [] },
  };
}
