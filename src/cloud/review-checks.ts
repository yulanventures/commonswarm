/**
 * Revision-bound review checks (C3): Cloud API client, seat resolver, and text renderer.
 */
import { randomUUID } from "node:crypto";
import type { CloudTarget } from "./config.js";
import type { SignalDirectory } from "./signals.js";

export type ReviewCheckVerdict = "pass" | "hold";
export type ReviewCheckStatus = "pending" | "hold" | "satisfied";

export interface ReviewCheckSeat {
  kind: "user" | "agent";
  id: string;
}

export interface ReviewCheckSeatInfo extends ReviewCheckSeat {
  name: string | null;
}

export interface ReviewCheckStamp {
  seat_kind: "user" | "agent";
  seat_id: string;
  name: string | null;
  verdict: ReviewCheckVerdict | null;
  head_sha: string | null;
  note: string | null;
  stamped_at: string | null;
  stale: boolean;
  effective_verdict: ReviewCheckVerdict | "pending";
}

export interface ReviewCheckRecord {
  check_id: string;
  workspace_id: string;
  subject: {
    kind: "pr";
    repo: string;
    ref: string;
  };
  head_sha: string;
  conversation_id: string | null;
  thread_root_id: string | null;
  required_seats: ReviewCheckSeatInfo[];
  stamps: ReviewCheckStamp[];
  status: ReviewCheckStatus;
  satisfied: boolean;
  satisfied_head_sha: string | null;
  satisfied_signal_id: string | null;
  satisfied_at: string | null;
  created_by: ReviewCheckSeat;
  created_at: string;
  updated_at: string;
}

export interface ReviewCheckOpenResult {
  review_check: ReviewCheckRecord;
  created: boolean;
  head_changed: boolean;
}

export interface ReviewCheckStampResult {
  review_check: ReviewCheckRecord;
  satisfied_now: boolean;
  satisfied_signal_id: string | null;
}

export interface ReviewCheckReadResult {
  review_check?: ReviewCheckRecord | null;
  review_checks?: ReviewCheckRecord[];
}

export class ReviewCheckError extends Error {
  readonly code: string;
  readonly status: number;
  readonly currentHeadSha?: string;

  constructor(code: string, message: string, status: number, currentHeadSha?: string) {
    super(message);
    this.name = "ReviewCheckError";
    this.code = code;
    this.status = status;
    this.currentHeadSha = currentHeadSha;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA_RE = /^[0-9a-f]{7,64}$/i;
const CTRL_RE = /[\u0000-\u001f\u007f]/u;

export function normalizeReviewCheckSha(value: string): string {
  const sha = value.trim().toLowerCase();
  if (!SHA_RE.test(sha)) {
    throw new ReviewCheckError("invalid_request", "head_sha must be a 7 to 64 character hex commit SHA.", 400);
  }
  return sha;
}

export function normalizeReviewCheckRepo(value: string): string {
  const repo = value.trim();
  if (repo.length < 1 || repo.length > 160 || CTRL_RE.test(repo)) {
    throw new ReviewCheckError("invalid_request", "repo must be 1 to 160 printable characters.", 400);
  }
  return repo;
}

export function normalizeReviewCheckRef(value: string): string {
  const ref = value.trim().replace(/^#/, "");
  if (ref.length < 1 || ref.length > 80 || CTRL_RE.test(ref)) {
    throw new ReviewCheckError("invalid_request", "pr reference must be 1 to 80 printable characters.", 400);
  }
  return ref;
}

/** Resolve seat selectors (`agent:<uuid>`, `user:<uuid>`, `<uuid>`, or exact member/agent name). */
export function resolveReviewCheckSeats(
  selectors: readonly string[],
  directory: SignalDirectory,
): ReviewCheckSeat[] {
  if (selectors.length < 1 || selectors.length > 20) {
    throw new ReviewCheckError("invalid_request", "Supply between 1 and 20 required seats.", 400);
  }
  const out: ReviewCheckSeat[] = [];
  const seen = new Set<string>();
  const add = (seat: ReviewCheckSeat) => {
    const key = `${seat.kind}:${seat.id}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(seat);
    }
  };

  for (const raw of selectors) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const explicit = trimmed.match(/^(agent|user):([0-9a-f-]{36})$/i);
    if (explicit && UUID_RE.test(explicit[2]!)) {
      add({ kind: explicit[1]!.toLowerCase() as "agent" | "user", id: explicit[2]!.toLowerCase() });
      continue;
    }
    if (UUID_RE.test(trimmed)) {
      const lowered = trimmed.toLowerCase();
      const agent = directory.agents.find(a => a.principal_id.toLowerCase() === lowered);
      const user = directory.members.find(m => m.user_id.toLowerCase() === lowered);
      if (agent && !user) { add({ kind: "agent", id: lowered }); continue; }
      if (user && !agent) { add({ kind: "user", id: lowered }); continue; }
      if (agent && user) {
        throw new ReviewCheckError("invalid_seat", `Seat UUID "${trimmed}" matches both a person and an agent; prefix with agent: or user:.`, 400);
      }
      throw new ReviewCheckError("invalid_seat", `No active workspace seat found for UUID "${trimmed}".`, 400);
    }
    const needle = trimmed.replace(/^@/, "").toLowerCase();
    const matchingAgents = directory.agents.filter(a => a.name.trim().toLowerCase() === needle);
    const matchingUsers = directory.members.filter(m => (m.display_name ?? "").trim().toLowerCase() === needle);
    const total = matchingAgents.length + matchingUsers.length;
    if (total === 0) {
      throw new ReviewCheckError("invalid_seat", `No workspace seat matches "${trimmed}".`, 400);
    }
    if (total > 1) {
      throw new ReviewCheckError("invalid_seat", `Seat selector "${trimmed}" is ambiguous; pass agent:<uuid> or user:<uuid>.`, 400);
    }
    if (matchingAgents.length === 1) {
      add({ kind: "agent", id: matchingAgents[0]!.principal_id.toLowerCase() });
    } else {
      add({ kind: "user", id: matchingUsers[0]!.user_id.toLowerCase() });
    }
  }
  if (out.length === 0) {
    throw new ReviewCheckError("invalid_request", "Supply at least one required seat.", 400);
  }
  return out;
}

async function postReviewCheckCommand(
  target: CloudTarget,
  token: string,
  workspaceId: string,
  command: Record<string, unknown>,
  options: { commandId?: string; fetcher?: typeof fetch; signal?: AbortSignal } = {},
): Promise<Record<string, unknown>> {
  const fetcher = options.fetcher ?? fetch;
  const endpoint = `${target.url.replace(/\/+$/, "")}/functions/v1/command`;
  const response = await fetcher(endpoint, {
    method: "POST",
    ...(options.signal ? { signal: options.signal } : {}),
    headers: {
      authorization: `Bearer ${token}`,
      apikey: target.anonKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      command_id: options.commandId ?? randomUUID(),
      client_version: "0.1.0",
      workspace_id: workspaceId,
      stream: { kind: "workspace" },
      command,
    }),
  });
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) {
    const code = typeof body?.error === "string" ? body.error : `http_${response.status}`;
    const message = typeof body?.message === "string" ? body.message : `Review check command failed (${code}).`;
    const currentHeadSha = typeof body?.current_head_sha === "string" ? body.current_head_sha : undefined;
    throw new ReviewCheckError(code, message, response.status, currentHeadSha);
  }
  return body ?? {};
}

export async function openReviewCheck(
  target: CloudTarget,
  token: string,
  workspaceId: string,
  input: {
    repo: string;
    ref: string;
    headSha: string;
    requiredSeats: ReviewCheckSeat[];
    conversationId?: string | null;
    threadRootId?: string | null;
    commandId?: string;
    fetcher?: typeof fetch;
    signal?: AbortSignal;
  },
): Promise<ReviewCheckOpenResult> {
  const body = await postReviewCheckCommand(
    target,
    token,
    workspaceId,
    {
      kind: "review_check_open",
      subject_repo: normalizeReviewCheckRepo(input.repo),
      subject_ref: normalizeReviewCheckRef(input.ref),
      head_sha: normalizeReviewCheckSha(input.headSha),
      required_seats: input.requiredSeats,
      ...(input.conversationId ? { conversation_id: input.conversationId.toLowerCase() } : {}),
      ...(input.threadRootId ? { thread_root_id: input.threadRootId.toLowerCase() } : {}),
    },
    { commandId: input.commandId, fetcher: input.fetcher, signal: input.signal },
  );
  return {
    review_check: body.review_check as ReviewCheckRecord,
    created: Boolean(body.created),
    head_changed: Boolean(body.head_changed),
  };
}

export async function stampReviewCheck(
  target: CloudTarget,
  token: string,
  workspaceId: string,
  input: {
    checkId: string;
    headSha: string;
    verdict: ReviewCheckVerdict;
    note?: string | null;
    commandId?: string;
    fetcher?: typeof fetch;
    signal?: AbortSignal;
  },
): Promise<ReviewCheckStampResult> {
  if (!UUID_RE.test(input.checkId)) {
    throw new ReviewCheckError("invalid_request", "check_id must be a UUID.", 400);
  }
  if (input.verdict !== "pass" && input.verdict !== "hold") {
    throw new ReviewCheckError("invalid_request", 'verdict must be "pass" or "hold".', 400);
  }
  const trimmedNote = input.note?.trim();
  const body = await postReviewCheckCommand(
    target,
    token,
    workspaceId,
    {
      kind: "review_check_stamp",
      check_id: input.checkId.toLowerCase(),
      head_sha: normalizeReviewCheckSha(input.headSha),
      verdict: input.verdict,
      ...(trimmedNote ? { note: trimmedNote } : {}),
    },
    { commandId: input.commandId, fetcher: input.fetcher, signal: input.signal },
  );
  return {
    review_check: body.review_check as ReviewCheckRecord,
    satisfied_now: Boolean(body.satisfied_now),
    satisfied_signal_id: typeof body.satisfied_signal_id === "string" ? body.satisfied_signal_id : null,
  };
}

export async function readReviewChecks(
  target: CloudTarget,
  token: string,
  workspaceId: string,
  input: {
    checkId?: string;
    repo?: string;
    ref?: string;
    threadRootId?: string;
    conversationId?: string;
    limit?: number;
    fetcher?: typeof fetch;
    signal?: AbortSignal;
  } = {},
): Promise<ReviewCheckReadResult> {
  const fetcher = input.fetcher ?? fetch;
  const endpoint = `${target.url.replace(/\/+$/, "")}/functions/v1/read`;
  const payload: Record<string, unknown> = {
    resource: "review_checks",
    workspace_id: workspaceId,
    ...(input.checkId ? { check_id: input.checkId.toLowerCase() } : {}),
    ...(input.repo && input.ref
      ? { subject_repo: normalizeReviewCheckRepo(input.repo), subject_ref: normalizeReviewCheckRef(input.ref) }
      : {}),
    ...(input.threadRootId ? { thread_root_id: input.threadRootId.toLowerCase() } : {}),
    ...(input.conversationId ? { conversation_id: input.conversationId.toLowerCase() } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
  };
  const response = await fetcher(endpoint, {
    method: "POST",
    ...(input.signal ? { signal: input.signal } : {}),
    headers: {
      authorization: `Bearer ${token}`,
      apikey: target.anonKey,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) {
    const code = typeof body?.error === "string" ? body.error : `http_${response.status}`;
    const message = typeof body?.message === "string" ? body.message : `Review check read failed (${code}).`;
    throw new ReviewCheckError(code, message, response.status);
  }
  return {
    ...(body && "review_check" in body ? { review_check: (body.review_check as ReviewCheckRecord | null) ?? null } : {}),
    ...(body && "review_checks" in body ? { review_checks: Array.isArray(body.review_checks) ? body.review_checks as ReviewCheckRecord[] : [] } : {}),
  };
}

export function renderReviewCheck(check: ReviewCheckRecord): string {
  const lines = [
    `${check.subject.repo}#${check.subject.ref} @ ${check.head_sha.slice(0, 9)} [${check.status}] (id: ${check.check_id})`,
  ];
  for (const stamp of check.stamps) {
    const label = stamp.name ?? stamp.seat_id;
    const status = stamp.stale && stamp.verdict && stamp.head_sha
      ? `pending (stale ${stamp.verdict} @ ${stamp.head_sha.slice(0, 9)})`
      : stamp.effective_verdict;
    const note = !stamp.stale && stamp.note ? ` - ${stamp.note}` : "";
    lines.push(`  - ${label}: ${status}${note}`);
  }
  return `${lines.join("\n")}\n`;
}
