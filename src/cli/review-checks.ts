/**
 * CLI helpers for revision-bound review checks (`cswarm check open|stamp|status`).
 */
import type { CloudTarget } from "../cloud/config.js";
import { readAgentSignalDirectory } from "../cloud/signals.js";
import {
  openReviewCheck,
  readReviewChecks,
  renderReviewCheck,
  resolveReviewCheckSeats,
  ReviewCheckError,
  stampReviewCheck,
  type ReviewCheckVerdict,
} from "../cloud/review-checks.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ReviewCheckCliArgs {
  positionals: string[];
  has(name: string): boolean;
  optional(name: string): string | undefined;
  all(name: string): string[];
}

export interface ReviewCheckCliAuth {
  target: CloudTarget;
  bearer: string;
  workspaceId: string;
  fetcher: typeof fetch;
}

export function parseSubjectSelector(
  positional: string | undefined,
  subjectRepoFlag: string | undefined,
  prFlag: string | undefined,
): { repo: string; ref: string } | null {
  if (subjectRepoFlag || prFlag) {
    if (!subjectRepoFlag || !prFlag) {
      throw new ReviewCheckError("invalid_request", "Supply both --subject-repo and --pr, or pass <owner/repo>#<pr>.", 400);
    }
    return { repo: subjectRepoFlag.trim(), ref: prFlag.trim().replace(/^#/, "") };
  }
  if (!positional) return null;
  const hashIndex = positional.lastIndexOf("#");
  if (hashIndex > 0 && hashIndex < positional.length - 1) {
    return {
      repo: positional.slice(0, hashIndex).trim(),
      ref: positional.slice(hashIndex + 1).trim(),
    };
  }
  return null;
}

export async function executeCheckOpenCli(
  args: ReviewCheckCliArgs,
  auth: ReviewCheckCliAuth,
): Promise<string> {
  const subject = parseSubjectSelector(
    args.positionals[2],
    args.optional("subject-repo"),
    args.optional("pr"),
  );
  if (!subject) {
    throw new ReviewCheckError(
      "invalid_request",
      "Usage: cswarm check open <owner/repo>#<pr> --head-sha <sha> --seat <name|uuid> [--seat ...]",
      400,
    );
  }
  const headSha = args.optional("head-sha");
  if (!headSha) {
    throw new ReviewCheckError("invalid_request", "--head-sha <sha> is required.", 400);
  }
  const rawSeats = args
    .all("seat")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  if (rawSeats.length === 0) {
    throw new ReviewCheckError("invalid_request", "Supply at least one --seat <name|uuid>.", 400);
  }
  const needsDirectory = rawSeats.some((s) => !/^(agent|user):[0-9a-f-]{36}$/i.test(s));
  const directory = needsDirectory
    ? await readAgentSignalDirectory(auth.target, auth.bearer, auth.workspaceId, { fetcher: auth.fetcher })
    : { members: [], agents: [] };
  const requiredSeats = resolveReviewCheckSeats(rawSeats, directory);
  const result = await openReviewCheck(auth.target, auth.bearer, auth.workspaceId, {
    checkId: args.optional("check-id") ?? null,
    repo: subject.repo,
    ref: subject.ref,
    headSha,
    requiredSeats,
    conversationId: args.optional("conversation-id") ?? null,
    threadRootId: args.optional("thread-root-id") ?? null,
    fetcher: auth.fetcher,
  });
  if (args.has("json")) {
    return `${JSON.stringify(result, null, 2)}\n`;
  }
  return renderReviewCheck(result.review_check);
}

export async function executeCheckStampCli(
  args: ReviewCheckCliArgs,
  auth: ReviewCheckCliAuth,
): Promise<string> {
  const headSha = args.optional("head-sha");
  if (!headSha) {
    throw new ReviewCheckError("invalid_request", "--head-sha <sha> is required.", 400);
  }
  const rawVerdict = args.optional("verdict")?.trim().toLowerCase();
  if (rawVerdict !== "pass" && rawVerdict !== "hold") {
    throw new ReviewCheckError("invalid_request", '--verdict must be "pass" or "hold".', 400);
  }
  let checkId = args.optional("check-id");
  const pos = args.positionals[2];
  if (!checkId && pos && UUID_RE.test(pos)) {
    checkId = pos;
  }
  if (!checkId) {
    const subject = parseSubjectSelector(pos, args.optional("subject-repo"), args.optional("pr"));
    if (!subject) {
      throw new ReviewCheckError(
        "invalid_request",
        "Supply <check-id>, --check-id <uuid>, or <owner/repo>#<pr>.",
        400,
      );
    }
    const found = await readReviewChecks(auth.target, auth.bearer, auth.workspaceId, {
      repo: subject.repo,
      ref: subject.ref,
      fetcher: auth.fetcher,
    });
    if (!found.review_check) {
      throw new ReviewCheckError("not_found", "Review check not found.", 404);
    }
    checkId = found.review_check.check_id;
  }
  const result = await stampReviewCheck(auth.target, auth.bearer, auth.workspaceId, {
    checkId,
    headSha,
    verdict: rawVerdict as ReviewCheckVerdict,
    note: args.optional("note") ?? null,
    fetcher: auth.fetcher,
  });
  if (args.has("json")) {
    return `${JSON.stringify(result, null, 2)}\n`;
  }
  return renderReviewCheck(result.review_check);
}

export async function executeCheckStatusCli(
  args: ReviewCheckCliArgs,
  auth: ReviewCheckCliAuth,
): Promise<string> {
  const pos = args.positionals[2];
  let checkId = args.optional("check-id");
  if (!checkId && pos && UUID_RE.test(pos)) {
    checkId = pos;
  }
  const subject = !checkId
    ? parseSubjectSelector(pos, args.optional("subject-repo"), args.optional("pr"))
    : null;
  const rawLimit = args.optional("limit");
  const limit = rawLimit !== undefined ? Number(rawLimit) : undefined;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 50)) {
    throw new ReviewCheckError("invalid_request", "--limit must be an integer between 1 and 50.", 400);
  }
  const result = await readReviewChecks(auth.target, auth.bearer, auth.workspaceId, {
    ...(checkId ? { checkId } : {}),
    ...(subject ? { repo: subject.repo, ref: subject.ref } : {}),
    ...(args.optional("thread-root-id") ? { threadRootId: args.optional("thread-root-id") } : {}),
    ...(args.optional("conversation-id") ? { conversationId: args.optional("conversation-id") } : {}),
    ...(limit !== undefined ? { limit } : {}),
    fetcher: auth.fetcher,
  });
  if (args.has("json")) {
    return `${JSON.stringify(result, null, 2)}\n`;
  }
  if (result.review_check) {
    return renderReviewCheck(result.review_check);
  }
  const list = result.review_checks ?? [];
  if (list.length === 0) return "No review checks.\n";
  return list.map(renderReviewCheck).join("\n");
}
