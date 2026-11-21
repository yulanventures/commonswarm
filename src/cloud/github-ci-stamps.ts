/**
 * C3b — Read-only GitHub CI status adapter for revision-bound review checks.
 *
 * Security & correctness invariants:
 *   - Separate credentials & fetchers by service: GitHub reads NEVER use CommonSwarm's
 *     session-proof-injecting fetcher, NEVER send GitHub credentials to any origin other than
 *     `https://api.github.com`, and NEVER allow non-trusted `--github-api-url` overrides to
 *     stamp review checks (overrides are credential-free and diagnostic `--dry-run` only).
 *   - Atomic token & policy file opens: `open(..., O_RDONLY | O_NOFOLLOW)` + `fstat` on the
 *     opened handle + bounded read from that same handle (zero `lstat`->`readFile` TOCTOU).
 *   - Strictly READ-ONLY against GitHub: issues ONLY HTTP GET requests with `redirect: "error"`.
 *   - Trusted publisher & expected-suite policy: machine-written stamps (non-`--dry-run`)
 *     REQUIRE an explicit trusted policy pinning the exact expected suites AND their workflow
 *     path, GitHub App (`app_slug`/`app_id`), or commit-status publisher (`creator_login`/
 *     `creator_id`). Same-name results from untrusted publishers are strictly ignored.
 *   - Completeness & immutable ordering: fails closed on ANY `Link: rel="next"` continuation
 *     (even on short pages), missing/invalid/mismatched `total_count`, or missing/invalid
 *     creation timestamps; uses `run_attempt` within the same workflow `run_id` and immutable
 *     `created_at` / provider `id` across distinct runs (never mutable `updated_at`/`completed_at`).
 */
import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import type { CloudTarget } from "./config.js";
import {
  normalizeReviewCheckSha,
  readReviewChecks,
  renderReviewCheck,
  ReviewCheckError,
  stampReviewCheck,
  type ReviewCheckRecord,
  type ReviewCheckVerdict,
} from "./review-checks.js";

export const TRUSTED_GITHUB_API_ORIGIN = "https://api.github.com";
export const DEFAULT_GITHUB_API_BASE_URL = TRUSTED_GITHUB_API_ORIGIN;
export const GITHUB_CI_TIMEOUT_MS = 10_000;
export const GITHUB_CI_MAX_BYTES = 2 * 1024 * 1024;
export const GITHUB_CI_NOTE_MAX = 2_000;
export const GITHUB_CI_SOURCES = ["all", "actions", "checks", "statuses"] as const;
export type GithubCiSource = (typeof GITHUB_CI_SOURCES)[number];

const GITHUB_REPO_RE = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
const FULL_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;
const TOKEN_FILE_MAX_BYTES = 4096;
const POLICY_FILE_MAX_BYTES = 64 * 1024;
const COMMIT_STATUS_STATES = new Set<GithubCommitStatusState>(["pending", "success", "failure", "error"]);

export class GithubCiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 502) {
    super(message);
    this.name = "GithubCiError";
    this.code = code;
    this.status = status;
  }
}

export interface GithubWorkflowRunRaw {
  id: number;
  name: string;
  path: string | null;
  workflow_id: number | null;
  head_sha: string;
  run_attempt: number;
  status: string;
  conclusion: string | null;
  created_at: string;
  updated_at: string | null;
  html_url: string | null;
}

export interface GithubCheckRunRaw {
  id: number;
  name: string;
  app_slug: string | null;
  app_id: number | null;
  head_sha: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  html_url: string | null;
}

export type GithubCommitStatusState = "pending" | "success" | "failure" | "error";

export interface GithubCommitStatusRaw {
  id: number;
  context: string;
  state: GithubCommitStatusState;
  head_sha: string;
  creator_login: string | null;
  creator_id: number | null;
  description: string | null;
  target_url: string | null;
  created_at: string;
  updated_at: string | null;
}

export type GithubCiSuiteRule =
  | {
      kind: "workflow_run";
      suite: string;
      workflow_path: string;
      workflow_id?: number;
    }
  | {
      kind: "check_run";
      suite: string;
      app_slug?: string;
      app_id?: number;
    }
  | {
      kind: "commit_status";
      context: string;
      creator_login?: string;
      creator_id?: number;
      target_url_prefix?: string;
    };

export interface GithubCiPolicy {
  version: 1;
  repo: string;
  required: GithubCiSuiteRule[];
}

export type GithubCiSuiteState = "pass" | "fail" | "pending";

export interface GithubCiSuiteResult {
  source: "workflow_run" | "check_run" | "commit_status";
  suite: string;
  publisher: string | null;
  head_sha: string;
  run_id: number;
  run_attempt: number;
  status: string;
  conclusion: string | null;
  state: GithubCiSuiteState;
  created_at: string | null;
  html_url: string | null;
}

export interface GithubCiEvaluation {
  head_sha: string;
  policy_enforced: boolean;
  decision: "pass" | "hold" | "pending";
  verdict: ReviewCheckVerdict | null;
  suites: GithubCiSuiteResult[];
  missing_suites: string[];
  ignored_stale_head: number;
  ignored_untrusted_publisher: number;
  ignored_superseded_attempts: number;
  ignored_superseded_runs: number;
}

export interface GithubCiSyncResult {
  stamped: boolean;
  action: "pass" | "hold" | "pending" | "dry_run";
  check_id: string;
  repo: string;
  ref: string;
  head_sha: string;
  evaluation: GithubCiEvaluation;
  note: string;
  review_check: ReviewCheckRecord;
  satisfied_now: boolean;
  satisfied_signal_id: string | null;
}

export function sanitizeGithubErrorDetail(detail: string, token?: string | null): string {
  const scrubbed = token && token.length > 0 ? detail.replaceAll(token, "[redacted]") : detail;
  return scrubbed.replaceAll(/[\r\n]+/g, " ").trim().slice(0, 300) || "github_ci_request_failed";
}

export function normalizeGithubRepo(raw: string): { owner: string; name: string; full: string } {
  const trimmed = raw.trim();
  if (!GITHUB_REPO_RE.test(trimmed)) {
    throw new GithubCiError(
      "github_repo_invalid",
      'GitHub repository must be "<owner>/<repo>" without traversal or whitespace.',
      400,
    );
  }
  const [owner, name] = trimmed.split("/") as [string, string];
  if (owner === "." || owner === ".." || name === "." || name === "..") {
    throw new GithubCiError(
      "github_repo_invalid",
      'GitHub repository must be "<owner>/<repo>" without traversal segments.',
      400,
    );
  }
  return { owner, name, full: `${owner}/${name}` };
}

export function normalizeGithubApiBaseUrl(raw?: string | null): string {
  const value = (raw ?? DEFAULT_GITHUB_API_BASE_URL).trim();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new GithubCiError("github_api_url_invalid", "GitHub API base URL must be a valid URL.", 400);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new GithubCiError(
      "github_api_url_invalid",
      "GitHub API base URL must not include credentials, query parameters, or fragments.",
      400,
    );
  }
  const isLoopback =
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "::1" ||
    parsed.hostname === "[::1]" ||
    parsed.hostname === "localhost";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback)) {
    throw new GithubCiError(
      "github_api_url_invalid",
      "GitHub API base URL must use https:// (or http:// on loopback for local diagnostic fixtures).",
      400,
    );
  }
  return parsed.toString().replace(/\/+$/, "");
}

export function isTrustedGithubApiOrigin(apiBaseUrl: string): boolean {
  return normalizeGithubApiBaseUrl(apiBaseUrl) === TRUSTED_GITHUB_API_ORIGIN;
}

export function validateGithubToken(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 1024 || CONTROL_CHAR_RE.test(trimmed)) {
    throw new GithubCiError(
      "github_token_invalid",
      "GitHub token must be a non-empty single-line token without control characters.",
      400,
    );
  }
  return trimmed;
}

async function readBoundedLocalFileNoFollow(options: {
  filePath: string;
  maxBytes: number;
  requirePrivate0600: boolean;
  missingCode: string;
  unsafeCode: string;
  label: string;
}): Promise<string> {
  const myUid = process.getuid ? process.getuid() : null;
  const openFlags =
    fsConstants.O_RDONLY |
    (typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0) |
    (typeof fsConstants.O_NONBLOCK === "number" ? fsConstants.O_NONBLOCK : 0);
  let handle;
  try {
    handle = await open(options.filePath, openFlags);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new GithubCiError(options.missingCode, `${options.label} does not exist.`, 400);
    }
    if (code === "ELOOP" || code === "EMLINK") {
      throw new GithubCiError(options.unsafeCode, `${options.label} must not be a symbolic link.`, 400);
    }
    throw error;
  }
  try {
    const info = await handle.stat();
    const mode = info.mode & 0o777;
    if (
      !info.isFile() ||
      info.size > options.maxBytes ||
      (myUid !== null && info.uid !== myUid) ||
      (options.requirePrivate0600 && (mode & 0o077) !== 0) ||
      (!options.requirePrivate0600 && (mode & 0o022) !== 0)
    ) {
      throw new GithubCiError(
        options.unsafeCode,
        options.requirePrivate0600
          ? `${options.label} must be a private 0600 regular file owned by the current user.`
          : `${options.label} must be an owned, non-group/world-writable regular file.`,
        400,
      );
    }
    const buf = Buffer.alloc(options.maxBytes + 1);
    let offset = 0;
    while (offset < buf.length) {
      const { bytesRead } = await handle.read(buf, offset, buf.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > options.maxBytes) {
      throw new GithubCiError(options.unsafeCode, `${options.label} exceeded ${options.maxBytes} bytes.`, 400);
    }
    return buf.subarray(0, offset).toString("utf8");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function readGithubTokenFromFile(filePath: string): Promise<string> {
  const content = await readBoundedLocalFileNoFollow({
    filePath,
    maxBytes: TOKEN_FILE_MAX_BYTES,
    requirePrivate0600: true,
    missingCode: "github_token_file_missing",
    unsafeCode: "github_token_file_unsafe",
    label: "GitHub token file",
  });
  return validateGithubToken(content);
}

export function parseGithubCiPolicy(raw: unknown): GithubCiPolicy {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new GithubCiError("github_policy_invalid", "GitHub CI policy must be a JSON object.", 400);
  }
  const obj = raw as Record<string, unknown>;
  if (obj.version !== 1) {
    throw new GithubCiError("github_policy_invalid", "GitHub CI policy version must be 1.", 400);
  }
  if (typeof obj.repo !== "string") {
    throw new GithubCiError("github_policy_invalid", "GitHub CI policy must specify repo.", 400);
  }
  const repo = normalizeGithubRepo(obj.repo).full;
  if (!Array.isArray(obj.required) || obj.required.length < 1 || obj.required.length > 50) {
    throw new GithubCiError("github_policy_invalid", "GitHub CI policy must list 1 to 50 required suite rules.", 400);
  }
  const rules: GithubCiSuiteRule[] = [];
  const seenRuleKeys = new Set<string>();
  for (const item of obj.required) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new GithubCiError("github_policy_invalid", "Each GitHub CI policy rule must be an object.", 400);
    }
    const r = item as Record<string, unknown>;
    if (r.kind === "workflow_run") {
      if (
        typeof r.suite !== "string" || r.suite.trim().length === 0 || CONTROL_CHAR_RE.test(r.suite) ||
        typeof r.workflow_path !== "string" || !r.workflow_path.trim().startsWith(".github/workflows/") ||
        r.workflow_path.split("/").some((seg) => seg === "." || seg === "..") ||
        CONTROL_CHAR_RE.test(r.workflow_path)
      ) {
        throw new GithubCiError(
          "github_policy_invalid",
          'workflow_run policy rule requires non-empty "suite" and clean "workflow_path" starting with ".github/workflows/".',
          400,
        );
      }
      if (r.workflow_id !== undefined && (typeof r.workflow_id !== "number" || !Number.isSafeInteger(r.workflow_id) || r.workflow_id < 1)) {
        throw new GithubCiError("github_policy_invalid", "workflow_run policy rule workflow_id must be a positive integer.", 400);
      }
      const key = `workflow_run:${r.suite.trim().toLowerCase()}`;
      if (seenRuleKeys.has(key)) {
        throw new GithubCiError("github_policy_invalid", `Duplicate workflow_run policy rule for "${r.suite.trim()}".`, 400);
      }
      seenRuleKeys.add(key);
      rules.push({
        kind: "workflow_run",
        suite: r.suite.trim(),
        workflow_path: r.workflow_path.trim(),
        ...(r.workflow_id !== undefined ? { workflow_id: r.workflow_id as number } : {}),
      });
      continue;
    }
    if (r.kind === "check_run") {
      if (typeof r.suite !== "string" || r.suite.trim().length === 0 || CONTROL_CHAR_RE.test(r.suite)) {
        throw new GithubCiError("github_policy_invalid", 'check_run policy rule requires non-empty "suite".', 400);
      }
      const hasSlug = typeof r.app_slug === "string" && r.app_slug.trim().length > 0 && !CONTROL_CHAR_RE.test(r.app_slug);
      const hasId = typeof r.app_id === "number" && Number.isSafeInteger(r.app_id) && r.app_id >= 1;
      if (!hasSlug && !hasId) {
        throw new GithubCiError("github_policy_invalid", 'check_run policy rule must pin "app_slug" and/or "app_id".', 400);
      }
      const key = `check_run:${r.suite.trim().toLowerCase()}`;
      if (seenRuleKeys.has(key)) {
        throw new GithubCiError("github_policy_invalid", `Duplicate check_run policy rule for "${r.suite.trim()}".`, 400);
      }
      seenRuleKeys.add(key);
      rules.push({
        kind: "check_run",
        suite: r.suite.trim(),
        ...(hasSlug ? { app_slug: (r.app_slug as string).trim() } : {}),
        ...(hasId ? { app_id: r.app_id as number } : {}),
      });
      continue;
    }
    if (r.kind === "commit_status") {
      if (typeof r.context !== "string" || r.context.trim().length === 0 || CONTROL_CHAR_RE.test(r.context)) {
        throw new GithubCiError("github_policy_invalid", 'commit_status policy rule requires exact full "context".', 400);
      }
      const hasLogin = typeof r.creator_login === "string" && r.creator_login.trim().length > 0 && !CONTROL_CHAR_RE.test(r.creator_login);
      const hasId = typeof r.creator_id === "number" && Number.isSafeInteger(r.creator_id) && r.creator_id >= 1;
      if (!hasLogin && !hasId) {
        throw new GithubCiError("github_policy_invalid", 'commit_status policy rule must pin "creator_login" and/or "creator_id".', 400);
      }
      if (r.target_url_prefix !== undefined && (typeof r.target_url_prefix !== "string" || !r.target_url_prefix.startsWith("https://") || CONTROL_CHAR_RE.test(r.target_url_prefix))) {
        throw new GithubCiError("github_policy_invalid", 'commit_status policy rule "target_url_prefix" must be an https:// URL prefix.', 400);
      }
      const key = `commit_status:${r.context.trim().toLowerCase()}`;
      if (seenRuleKeys.has(key)) {
        throw new GithubCiError("github_policy_invalid", `Duplicate commit_status policy rule for "${r.context.trim()}".`, 400);
      }
      seenRuleKeys.add(key);
      rules.push({
        kind: "commit_status",
        context: r.context.trim(),
        ...(hasLogin ? { creator_login: (r.creator_login as string).trim() } : {}),
        ...(hasId ? { creator_id: r.creator_id as number } : {}),
        ...(typeof r.target_url_prefix === "string" ? { target_url_prefix: r.target_url_prefix } : {}),
      });
      continue;
    }
    throw new GithubCiError("github_policy_invalid", 'Policy rule kind must be "workflow_run", "check_run", or "commit_status".', 400);
  }
  return { version: 1, repo, required: rules };
}

export async function readGithubCiPolicyFile(filePath: string): Promise<GithubCiPolicy> {
  const raw = await readBoundedLocalFileNoFollow({
    filePath,
    maxBytes: POLICY_FILE_MAX_BYTES,
    requirePrivate0600: false,
    missingCode: "github_policy_file_missing",
    unsafeCode: "github_policy_file_unsafe",
    label: "GitHub CI policy file",
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new GithubCiError("github_policy_invalid", "GitHub CI policy file is not valid JSON.", 400);
  }
  return parseGithubCiPolicy(parsed);
}

function parseRequiredTimestampMs(raw: unknown, field: string): { iso: string; ms: number } {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new GithubCiError("github_malformed_response", `GitHub response is missing required "${field}" timestamp.`, 502);
  }
  const iso = raw.trim();
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) {
    throw new GithubCiError("github_malformed_response", `GitHub response has invalid "${field}" timestamp.`, 502);
  }
  return { iso, ms };
}

function parseOptionalString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new GithubCiError("github_malformed_response", `GitHub response field "${field}" must be a string or null.`, 502);
  }
  return value;
}

function assertPageCompleteness(
  endpointName: string,
  listLength: number,
  totalCount: unknown,
  hasNextPage: boolean,
  requireTotalCount: boolean,
): void {
  if (hasNextPage) {
    throw new GithubCiError(
      "github_response_truncated",
      `GitHub ${endpointName} response includes a next-page continuation; refusing to evaluate an incomplete CI list.`,
      502,
    );
  }
  if (!requireTotalCount) return;
  if (typeof totalCount !== "number" || !Number.isSafeInteger(totalCount) || totalCount < 0) {
    throw new GithubCiError(
      "github_malformed_response",
      `GitHub ${endpointName} response is missing a valid non-negative integer total_count.`,
      502,
    );
  }
  if (totalCount > listLength) {
    throw new GithubCiError(
      "github_response_truncated",
      `GitHub ${endpointName} returned ${listLength} of ${totalCount} items; refusing to evaluate a truncated CI list.`,
      502,
    );
  }
  if (totalCount < listLength) {
    throw new GithubCiError(
      "github_malformed_response",
      `GitHub ${endpointName} total_count (${totalCount}) is smaller than returned items (${listLength}).`,
      502,
    );
  }
}

function parseWorkflowRunsPayload(payload: unknown, hasNextPage: boolean): GithubWorkflowRunRaw[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new GithubCiError("github_malformed_response", "GitHub actions/runs response must be a JSON object.", 502);
  }
  const obj = payload as Record<string, unknown>;
  if (!Array.isArray(obj.workflow_runs)) {
    throw new GithubCiError("github_malformed_response", 'GitHub actions/runs response is missing "workflow_runs" array.', 502);
  }
  assertPageCompleteness("actions/runs", obj.workflow_runs.length, obj.total_count, hasNextPage, true);

  const out: GithubWorkflowRunRaw[] = [];
  for (const item of obj.workflow_runs) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new GithubCiError("github_malformed_response", "GitHub workflow run entry must be an object.", 502);
    }
    const r = item as Record<string, unknown>;
    if (
      typeof r.id !== "number" ||
      !Number.isSafeInteger(r.id) ||
      r.id < 1 ||
      typeof r.name !== "string" ||
      r.name.trim().length === 0 ||
      typeof r.head_sha !== "string" ||
      !FULL_SHA_RE.test(r.head_sha.trim()) ||
      typeof r.status !== "string" ||
      r.status.trim().length === 0
    ) {
      throw new GithubCiError("github_malformed_response", "GitHub workflow run entry is missing required id, name, head_sha, or status.", 502);
    }
    const attempt = r.run_attempt === undefined ? 1 : r.run_attempt;
    if (typeof attempt !== "number" || !Number.isSafeInteger(attempt) || attempt < 1) {
      throw new GithubCiError("github_malformed_response", "GitHub workflow run entry has an invalid run_attempt.", 502);
    }
    const createdAt = parseRequiredTimestampMs(r.created_at, "created_at");
    const conclusion = parseOptionalString(r.conclusion, "conclusion");
    const path = parseOptionalString(r.path, "path");
    let workflowId: number | null = null;
    if (r.workflow_id !== undefined && r.workflow_id !== null) {
      if (typeof r.workflow_id !== "number" || !Number.isSafeInteger(r.workflow_id) || r.workflow_id < 1) {
        throw new GithubCiError("github_malformed_response", "GitHub workflow run entry has an invalid workflow_id.", 502);
      }
      workflowId = r.workflow_id;
    }
    out.push({
      id: r.id,
      name: r.name.trim(),
      path: path === null ? null : path.trim(),
      workflow_id: workflowId,
      head_sha: r.head_sha.trim().toLowerCase(),
      run_attempt: attempt,
      status: r.status.trim().toLowerCase(),
      conclusion: conclusion === null ? null : conclusion.trim().toLowerCase(),
      created_at: createdAt.iso,
      updated_at: parseOptionalString(r.updated_at, "updated_at"),
      html_url: parseOptionalString(r.html_url, "html_url"),
    });
  }
  return out;
}

function parseCheckRunsPayload(payload: unknown, hasNextPage: boolean): GithubCheckRunRaw[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new GithubCiError("github_malformed_response", "GitHub check-runs response must be a JSON object.", 502);
  }
  const obj = payload as Record<string, unknown>;
  if (!Array.isArray(obj.check_runs)) {
    throw new GithubCiError("github_malformed_response", 'GitHub check-runs response is missing "check_runs" array.', 502);
  }
  assertPageCompleteness("check-runs", obj.check_runs.length, obj.total_count, hasNextPage, true);

  const out: GithubCheckRunRaw[] = [];
  for (const item of obj.check_runs) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new GithubCiError("github_malformed_response", "GitHub check run entry must be an object.", 502);
    }
    const r = item as Record<string, unknown>;
    if (
      typeof r.id !== "number" ||
      !Number.isSafeInteger(r.id) ||
      r.id < 1 ||
      typeof r.name !== "string" ||
      r.name.trim().length === 0 ||
      typeof r.head_sha !== "string" ||
      !FULL_SHA_RE.test(r.head_sha.trim()) ||
      typeof r.status !== "string" ||
      r.status.trim().length === 0
    ) {
      throw new GithubCiError("github_malformed_response", "GitHub check run entry is missing required id, name, head_sha, or status.", 502);
    }
    let appSlug: string | null = null;
    let appId: number | null = null;
    if (r.app !== undefined && r.app !== null) {
      if (typeof r.app !== "object" || Array.isArray(r.app)) {
        throw new GithubCiError("github_malformed_response", "GitHub check run app field must be an object or null.", 502);
      }
      const appObj = r.app as Record<string, unknown>;
      const rawSlug = parseOptionalString(appObj.slug, "app.slug");
      appSlug = rawSlug === null ? null : rawSlug.trim();
      if (appObj.id !== undefined && appObj.id !== null) {
        if (typeof appObj.id !== "number" || !Number.isSafeInteger(appObj.id) || appObj.id < 1) {
          throw new GithubCiError("github_malformed_response", "GitHub check run app.id must be a positive integer.", 502);
        }
        appId = appObj.id;
      }
    }
    const conclusion = parseOptionalString(r.conclusion, "conclusion");
    out.push({
      id: r.id,
      name: r.name.trim(),
      app_slug: appSlug,
      app_id: appId,
      head_sha: r.head_sha.trim().toLowerCase(),
      status: r.status.trim().toLowerCase(),
      conclusion: conclusion === null ? null : conclusion.trim().toLowerCase(),
      started_at: parseOptionalString(r.started_at, "started_at"),
      completed_at: parseOptionalString(r.completed_at, "completed_at"),
      html_url: parseOptionalString(r.html_url, "html_url"),
    });
  }
  return out;
}

function extractCommitStatusSha(rec: Record<string, unknown>, requestedSha: string): string {
  const explicit = typeof rec.head_sha === "string"
    ? rec.head_sha.trim()
    : typeof rec.sha === "string"
    ? rec.sha.trim()
    : null;
  if (explicit !== null) {
    if (!FULL_SHA_RE.test(explicit)) {
      throw new GithubCiError("github_malformed_response", "GitHub commit status entry has an invalid SHA.", 502);
    }
    return explicit.toLowerCase();
  }
  if (typeof rec.url === "string" && rec.url.length > 0) {
    const match = /\/statuses\/([0-9a-f]{40}|[0-9a-f]{64})(?:$|[?#])/i.exec(rec.url);
    if (match) return match[1]!.toLowerCase();
  }
  return requestedSha;
}

function parseCommitStatusesPayload(
  payload: unknown,
  requestedSha: string,
  hasNextPage: boolean,
): GithubCommitStatusRaw[] {
  if (!Array.isArray(payload)) {
    throw new GithubCiError("github_malformed_response", "GitHub commits/{sha}/statuses response must be a JSON array.", 502);
  }
  assertPageCompleteness("commits/{sha}/statuses", payload.length, null, hasNextPage, false);

  const out: GithubCommitStatusRaw[] = [];
  for (const item of payload) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new GithubCiError("github_malformed_response", "GitHub commit status entry must be an object.", 502);
    }
    const r = item as Record<string, unknown>;
    const rawState = typeof r.state === "string" ? r.state.trim().toLowerCase() : "";
    if (
      typeof r.id !== "number" ||
      !Number.isSafeInteger(r.id) ||
      r.id < 1 ||
      typeof r.context !== "string" ||
      r.context.trim().length === 0 ||
      !COMMIT_STATUS_STATES.has(rawState as GithubCommitStatusState)
    ) {
      throw new GithubCiError(
        "github_malformed_response",
        "GitHub commit status entry is missing required id, context, or valid state.",
        502,
      );
    }
    const createdAt = parseRequiredTimestampMs(r.created_at, "created_at");
    let creatorLogin: string | null = null;
    let creatorId: number | null = null;
    if (r.creator !== undefined && r.creator !== null) {
      if (typeof r.creator !== "object" || Array.isArray(r.creator)) {
        throw new GithubCiError("github_malformed_response", "GitHub commit status creator must be an object or null.", 502);
      }
      const creatorObj = r.creator as Record<string, unknown>;
      const rawLogin = parseOptionalString(creatorObj.login, "creator.login");
      creatorLogin = rawLogin === null ? null : rawLogin.trim();
      if (creatorObj.id !== undefined && creatorObj.id !== null) {
        if (typeof creatorObj.id !== "number" || !Number.isSafeInteger(creatorObj.id) || creatorObj.id < 1) {
          throw new GithubCiError("github_malformed_response", "GitHub commit status creator.id must be a positive integer.", 502);
        }
        creatorId = creatorObj.id;
      }
    }
    out.push({
      id: r.id,
      context: r.context.trim(),
      state: rawState as GithubCommitStatusState,
      head_sha: extractCommitStatusSha(r, requestedSha),
      creator_login: creatorLogin,
      creator_id: creatorId,
      description: parseOptionalString(r.description, "description"),
      target_url: parseOptionalString(r.target_url, "target_url"),
      created_at: createdAt.iso,
      updated_at: parseOptionalString(r.updated_at, "updated_at"),
    });
  }
  return out;
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new GithubCiError("github_response_too_large", `GitHub API response exceeded ${maxBytes} bytes.`, 502);
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new GithubCiError("github_response_too_large", `GitHub API response exceeded ${maxBytes} bytes.`, 502);
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function githubReadOnlyGetJson(options: {
  url: string;
  token?: string | null;
  timeoutMs: number;
  maxBytes: number;
  fetcher: typeof fetch;
  signal?: AbortSignal;
}): Promise<{ payload: unknown; hasNextPage: boolean }> {
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs);
  const combinedSignal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "commonswarm-c3b-ci-adapter",
  };
  if (options.token) {
    headers.authorization = `Bearer ${options.token}`;
  }

  let response: Response;
  try {
    response = await options.fetcher(options.url, {
      method: "GET",
      redirect: "error",
      headers,
      signal: combinedSignal,
    });
  } catch (error) {
    if (timeoutSignal.aborted) {
      throw new GithubCiError(
        "github_timeout",
        `GitHub CI status request timed out after ${options.timeoutMs} ms.`,
        504,
      );
    }
    const detail = sanitizeGithubErrorDetail(error instanceof Error ? error.message : String(error), options.token);
    throw new GithubCiError("github_transport_error", `GitHub CI status request failed: ${detail}`, 502);
  }

  let rawText: string;
  try {
    rawText = await readBoundedText(response, options.maxBytes);
  } catch (error) {
    if (error instanceof GithubCiError) throw error;
    if (timeoutSignal.aborted) {
      throw new GithubCiError(
        "github_timeout",
        `GitHub CI response body timed out after ${options.timeoutMs} ms.`,
        504,
      );
    }
    const detail = sanitizeGithubErrorDetail(error instanceof Error ? error.message : String(error), options.token);
    throw new GithubCiError("github_transport_error", `Failed reading GitHub CI response: ${detail}`, 502);
  }

  if (!response.ok) {
    let apiMessage = "";
    try {
      const parsed = JSON.parse(rawText) as { message?: unknown };
      if (typeof parsed?.message === "string") apiMessage = parsed.message;
    } catch { /* ignore non-JSON error body */ }
    const safeDetail = sanitizeGithubErrorDetail(apiMessage || `HTTP ${response.status}`, options.token);
    if (response.status === 401 || response.status === 403) {
      const remaining = response.headers.get("x-ratelimit-remaining");
      if (remaining === "0") {
        throw new GithubCiError("github_rate_limited", `GitHub API rate limit exceeded: ${safeDetail}`, 429);
      }
      throw new GithubCiError("github_auth_failed", `GitHub API authentication/authorization failed (${response.status}): ${safeDetail}`, response.status);
    }
    if (response.status === 404) {
      throw new GithubCiError("github_not_found", `GitHub repository or commit not found (${response.status}): ${safeDetail}`, 404);
    }
    if (response.status === 429) {
      throw new GithubCiError("github_rate_limited", `GitHub API rate limited (${response.status}): ${safeDetail}`, 429);
    }
    throw new GithubCiError("github_http_error", `GitHub API returned HTTP ${response.status}: ${safeDetail}`, response.status);
  }

  const linkHeader = response.headers.get("link") ?? "";
  const hasNextPage = /;\s*rel=(?:"[^"]*\bnext\b[^"]*"|'[^']*\bnext\b[^']*'|next(?=[;\s,]|$))/i.test(linkHeader);
  try {
    return { payload: JSON.parse(rawText), hasNextPage };
  } catch {
    throw new GithubCiError("github_malformed_response", "GitHub API returned invalid JSON.", 502);
  }
}

export async function readGithubCiForCommit(options: {
  repo: string;
  headSha: string;
  source?: GithubCiSource;
  /** Optional explicit subset of GitHub endpoints to read (used by policy-enforced sync). */
  sources?: readonly Exclude<GithubCiSource, "all">[];
  apiBaseUrl?: string;
  token?: string | null;
  timeoutMs?: number;
  maxBytes?: number;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
}): Promise<{
  repo: string;
  head_sha: string;
  workflow_runs: GithubWorkflowRunRaw[];
  check_runs: GithubCheckRunRaw[];
  commit_statuses: GithubCommitStatusRaw[];
}> {
  const repo = normalizeGithubRepo(options.repo);
  const headSha = normalizeReviewCheckSha(options.headSha);
  const source: GithubCiSource = options.source ?? "all";
  if (!(GITHUB_CI_SOURCES as readonly string[]).includes(source)) {
    throw new GithubCiError("invalid_request", `source must be one of: ${GITHUB_CI_SOURCES.join(", ")}.`, 400);
  }
  const activeSources = new Set<Exclude<GithubCiSource, "all">>(
    options.sources && options.sources.length > 0
      ? options.sources
      : source === "all"
      ? ["actions", "checks", "statuses"]
      : [source],
  );
  const apiBaseUrl = normalizeGithubApiBaseUrl(options.apiBaseUrl);
  const token = options.token ? validateGithubToken(options.token) : null;
  if (token !== null && !isTrustedGithubApiOrigin(apiBaseUrl)) {
    throw new GithubCiError(
      "github_untrusted_origin_token_refused",
      `GitHub credentials may only be sent to ${TRUSTED_GITHUB_API_ORIGIN}; alternate --github-api-url overrides must remain credential-free.`,
      400,
    );
  }
  const timeoutMs = options.timeoutMs ?? GITHUB_CI_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? GITHUB_CI_MAX_BYTES;
  const fetcher = options.fetcher ?? fetch;
  const encodedOwner = encodeURIComponent(repo.owner);
  const encodedName = encodeURIComponent(repo.name);

  let workflowRuns: GithubWorkflowRunRaw[] = [];
  let checkRuns: GithubCheckRunRaw[] = [];
  let commitStatuses: GithubCommitStatusRaw[] = [];

  if (activeSources.has("actions")) {
    const actionsUrl = `${apiBaseUrl}/repos/${encodedOwner}/${encodedName}/actions/runs?head_sha=${encodeURIComponent(headSha)}&per_page=100`;
    const { payload, hasNextPage } = await githubReadOnlyGetJson({
      url: actionsUrl,
      token,
      timeoutMs,
      maxBytes,
      fetcher,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    workflowRuns = parseWorkflowRunsPayload(payload, hasNextPage);
  }

  if (activeSources.has("checks")) {
    const checksUrl = `${apiBaseUrl}/repos/${encodedOwner}/${encodedName}/commits/${encodeURIComponent(headSha)}/check-runs?per_page=100`;
    const { payload, hasNextPage } = await githubReadOnlyGetJson({
      url: checksUrl,
      token,
      timeoutMs,
      maxBytes,
      fetcher,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    checkRuns = parseCheckRunsPayload(payload, hasNextPage);
  }

  if (activeSources.has("statuses")) {
    const statusesUrl = `${apiBaseUrl}/repos/${encodedOwner}/${encodedName}/commits/${encodeURIComponent(headSha)}/statuses?per_page=100`;
    const { payload, hasNextPage } = await githubReadOnlyGetJson({
      url: statusesUrl,
      token,
      timeoutMs,
      maxBytes,
      fetcher,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    commitStatuses = parseCommitStatusesPayload(payload, headSha, hasNextPage);
  }

  return {
    repo: repo.full,
    head_sha: headSha,
    workflow_runs: workflowRuns,
    check_runs: checkRuns,
    commit_statuses: commitStatuses,
  };
}

function classifySuiteState(status: string, conclusion: string | null): GithubCiSuiteState {
  if (status !== "completed") return "pending";
  // Fail closed: ONLY explicit "success" passes a revision-bound review check.
  return conclusion === "success" ? "pass" : "fail";
}

/**
 * Stable creation/provider ordering across distinct workflow runs (NEVER mutable `updated_at`):
 *   - Same `id`: higher `run_attempt` wins.
 *   - Distinct `id`: later immutable `created_at` wins, tie-broken by higher monotonic `id`.
 */
function isNewerWorkflowRun(candidate: GithubWorkflowRunRaw, current: GithubWorkflowRunRaw): boolean {
  if (candidate.id === current.id) {
    return candidate.run_attempt > current.run_attempt;
  }
  const candCreated = parseRequiredTimestampMs(candidate.created_at, "created_at").ms;
  const currCreated = parseRequiredTimestampMs(current.created_at, "created_at").ms;
  if (candCreated !== currCreated) return candCreated > currCreated;
  return candidate.id > current.id;
}

/**
 * Stable provider ordering across distinct check runs (NEVER mutable `completed_at`):
 * GitHub assigns monotonically increasing check-run IDs at creation time, so a newer queued or
 * failing check run always supersedes an older late-finishing run.
 */
function isNewerCheckRun(candidate: GithubCheckRunRaw, current: GithubCheckRunRaw): boolean {
  return candidate.id > current.id;
}

/**
 * Stable creation ordering across commit statuses for the same context (NEVER mutable `updated_at`):
 * later immutable `created_at` wins, tie-broken by higher monotonic `id`.
 */
function isNewerCommitStatus(candidate: GithubCommitStatusRaw, current: GithubCommitStatusRaw): boolean {
  const candCreated = parseRequiredTimestampMs(candidate.created_at, "created_at").ms;
  const currCreated = parseRequiredTimestampMs(current.created_at, "created_at").ms;
  if (candCreated !== currCreated) return candCreated > currCreated;
  return candidate.id > current.id;
}

function classifyCommitStatusState(state: GithubCommitStatusState): {
  status: string;
  conclusion: string | null;
  suiteState: GithubCiSuiteState;
} {
  if (state === "pending") {
    return { status: "pending", conclusion: null, suiteState: "pending" };
  }
  if (state === "success") {
    return { status: "completed", conclusion: "success", suiteState: "pass" };
  }
  return { status: "completed", conclusion: state, suiteState: "fail" };
}

function parseDispatchRunMeta(status: GithubCommitStatusRaw): { runId: number; runAttempt: number } {
  let runId = status.id;
  let runAttempt = 1;
  if (status.target_url) {
    const urlRun = /\/actions\/runs\/(\d+)(?:\/attempts\/(\d+))?/i.exec(status.target_url);
    if (urlRun) {
      const parsedId = Number.parseInt(urlRun[1]!, 10);
      if (Number.isSafeInteger(parsedId) && parsedId > 0) runId = parsedId;
      if (urlRun[2]) {
        const parsedAttempt = Number.parseInt(urlRun[2], 10);
        if (Number.isSafeInteger(parsedAttempt) && parsedAttempt > 0) runAttempt = parsedAttempt;
      }
    }
  }
  if (runId === status.id && status.description) {
    const descRun = /\bdispatch run (\d+)\b/i.exec(status.description);
    if (descRun) {
      const parsedId = Number.parseInt(descRun[1]!, 10);
      if (Number.isSafeInteger(parsedId) && parsedId > 0) runId = parsedId;
    }
  }
  return { runId, runAttempt };
}

function suiteMatchesDiagnosticSelector(entry: GithubCiSuiteResult, selectorLower: string): boolean {
  const fullLower = entry.suite.toLowerCase();
  if (fullLower === selectorLower) return true;
  if (entry.source === "commit_status") {
    const slashIdx = fullLower.lastIndexOf(" / ");
    if (slashIdx >= 0) {
      const suffix = fullLower.slice(slashIdx + 3).trim();
      if (suffix === selectorLower) return true;
    }
  }
  return false;
}

function workflowMatchesRule(run: GithubWorkflowRunRaw, rule: Extract<GithubCiSuiteRule, { kind: "workflow_run" }>): boolean {
  if (run.name.toLowerCase() !== rule.suite.toLowerCase()) return false;
  if (run.path === null || run.path !== rule.workflow_path) return false;
  if (rule.workflow_id !== undefined && run.workflow_id !== rule.workflow_id) return false;
  return true;
}

function checkRunMatchesRule(run: GithubCheckRunRaw, rule: Extract<GithubCiSuiteRule, { kind: "check_run" }>): boolean {
  if (run.name.toLowerCase() !== rule.suite.toLowerCase()) return false;
  if (rule.app_slug !== undefined && (run.app_slug === null || run.app_slug.toLowerCase() !== rule.app_slug.toLowerCase())) {
    return false;
  }
  if (rule.app_id !== undefined && run.app_id !== rule.app_id) return false;
  return true;
}

function commitStatusMatchesRule(status: GithubCommitStatusRaw, rule: Extract<GithubCiSuiteRule, { kind: "commit_status" }>): boolean {
  if (status.context.toLowerCase() !== rule.context.toLowerCase()) return false;
  if (rule.creator_login !== undefined && (status.creator_login === null || status.creator_login.toLowerCase() !== rule.creator_login.toLowerCase())) {
    return false;
  }
  if (rule.creator_id !== undefined && status.creator_id !== rule.creator_id) return false;
  if (rule.target_url_prefix !== undefined && (status.target_url === null || !status.target_url.startsWith(rule.target_url_prefix))) {
    return false;
  }
  return true;
}

function collapseWorkflowRunsByAttempt(
  runs: readonly GithubWorkflowRunRaw[],
  expectedHeadSha: string,
): { kept: GithubWorkflowRunRaw[]; ignoredStaleHead: number; ignoredSupersededAttempts: number } {
  let ignoredStaleHead = 0;
  let ignoredSupersededAttempts = 0;
  const byRunId = new Map<number, GithubWorkflowRunRaw>();
  for (const run of runs) {
    if (run.head_sha.trim().toLowerCase() !== expectedHeadSha) {
      ignoredStaleHead += 1;
      continue;
    }
    parseRequiredTimestampMs(run.created_at, "created_at");
    const existing = byRunId.get(run.id);
    if (!existing) {
      byRunId.set(run.id, run);
    } else if (run.run_attempt > existing.run_attempt) {
      byRunId.set(run.id, run);
      ignoredSupersededAttempts += 1;
    } else {
      ignoredSupersededAttempts += 1;
    }
  }
  return { kept: [...byRunId.values()], ignoredStaleHead, ignoredSupersededAttempts };
}

/**
 * Pure deterministic evaluator:
 *   - Policy mode (`policy` provided, REQUIRED for stamping): evaluates EVERY required rule
 *     strictly against exact-head runs/statuses from the pinned trusted publisher (`workflow_path`,
 *     `app_slug`/`app_id`, or `creator_login`/`creator_id` + exact full `context`). Same-name
 *     results from untrusted publishers are ignored (`ignored_untrusted_publisher++`).
 *   - Diagnostic mode (no `policy`, `--dry-run` only): summarizes exact-head runs/statuses with
 *     optional `--suite` filtering.
 */
export function evaluateGithubCiRuns(options: {
  expectedHeadSha: string;
  workflowRuns: readonly GithubWorkflowRunRaw[];
  checkRuns: readonly GithubCheckRunRaw[];
  commitStatuses?: readonly GithubCommitStatusRaw[];
  policy?: GithubCiPolicy | null;
  requiredSuites?: readonly string[];
}): GithubCiEvaluation {
  const expectedHeadSha = normalizeReviewCheckSha(options.expectedHeadSha);
  const wfCollapsed = collapseWorkflowRunsByAttempt(options.workflowRuns, expectedHeadSha);
  let ignoredStaleHead = wfCollapsed.ignoredStaleHead;
  const ignoredSupersededAttempts = wfCollapsed.ignoredSupersededAttempts;
  let ignoredSupersededRuns = 0;
  let ignoredUntrustedPublisher = 0;

  const exactChecks: GithubCheckRunRaw[] = [];
  for (const run of options.checkRuns) {
    if (run.head_sha.trim().toLowerCase() !== expectedHeadSha) {
      ignoredStaleHead += 1;
      continue;
    }
    exactChecks.push(run);
  }
  const exactStatuses: GithubCommitStatusRaw[] = [];
  for (const status of options.commitStatuses ?? []) {
    if (status.head_sha.trim().toLowerCase() !== expectedHeadSha) {
      ignoredStaleHead += 1;
      continue;
    }
    parseRequiredTimestampMs(status.created_at, "created_at");
    exactStatuses.push(status);
  }

  const missingSuites: string[] = [];
  const selectedSuites: GithubCiSuiteResult[] = [];
  const policy = options.policy ?? null;

  if (policy !== null) {
    for (const rule of policy.required) {
      if (rule.kind === "workflow_run") {
        const sameName = wfCollapsed.kept.filter((r) => r.name.toLowerCase() === rule.suite.toLowerCase());
        const trusted = sameName.filter((r) => workflowMatchesRule(r, rule));
        ignoredUntrustedPublisher += sameName.length - trusted.length;
        if (trusted.length === 0) {
          missingSuites.push(rule.suite);
          continue;
        }
        let latest = trusted[0]!;
        for (let i = 1; i < trusted.length; i += 1) {
          ignoredSupersededRuns += 1;
          if (isNewerWorkflowRun(trusted[i]!, latest)) latest = trusted[i]!;
        }
        selectedSuites.push({
          source: "workflow_run",
          suite: latest.name,
          publisher: latest.path,
          head_sha: expectedHeadSha,
          run_id: latest.id,
          run_attempt: latest.run_attempt,
          status: latest.status,
          conclusion: latest.conclusion,
          state: classifySuiteState(latest.status, latest.conclusion),
          created_at: latest.created_at,
          html_url: latest.html_url,
        });
      } else if (rule.kind === "check_run") {
        const sameName = exactChecks.filter((r) => r.name.toLowerCase() === rule.suite.toLowerCase());
        const trusted = sameName.filter((r) => checkRunMatchesRule(r, rule));
        ignoredUntrustedPublisher += sameName.length - trusted.length;
        if (trusted.length === 0) {
          missingSuites.push(rule.suite);
          continue;
        }
        let latest = trusted[0]!;
        for (let i = 1; i < trusted.length; i += 1) {
          ignoredSupersededRuns += 1;
          if (isNewerCheckRun(trusted[i]!, latest)) latest = trusted[i]!;
        }
        selectedSuites.push({
          source: "check_run",
          suite: latest.name,
          publisher: latest.app_slug ?? (latest.app_id !== null ? `app:${latest.app_id}` : null),
          head_sha: expectedHeadSha,
          run_id: latest.id,
          run_attempt: 1,
          status: latest.status,
          conclusion: latest.conclusion,
          state: classifySuiteState(latest.status, latest.conclusion),
          created_at: latest.started_at,
          html_url: latest.html_url,
        });
      } else {
        const sameContext = exactStatuses.filter((s) => s.context.toLowerCase() === rule.context.toLowerCase());
        const trusted = sameContext.filter((s) => commitStatusMatchesRule(s, rule));
        ignoredUntrustedPublisher += sameContext.length - trusted.length;
        if (trusted.length === 0) {
          missingSuites.push(rule.context);
          continue;
        }
        let latest = trusted[0]!;
        for (let i = 1; i < trusted.length; i += 1) {
          ignoredSupersededRuns += 1;
          if (isNewerCommitStatus(trusted[i]!, latest)) latest = trusted[i]!;
        }
        const classified = classifyCommitStatusState(latest.state);
        const { runId, runAttempt } = parseDispatchRunMeta(latest);
        selectedSuites.push({
          source: "commit_status",
          suite: latest.context,
          publisher: latest.creator_login ?? (latest.creator_id !== null ? `user:${latest.creator_id}` : null),
          head_sha: expectedHeadSha,
          run_id: runId,
          run_attempt: runAttempt,
          status: classified.status,
          conclusion: classified.conclusion,
          state: classified.suiteState,
          created_at: latest.created_at,
          html_url: latest.target_url,
        });
      }
    }
  } else {
    // Diagnostic-only mode (cannot stamp): collapse latest per suite/context across exact-head runs.
    const latestWorkflowBySuite = new Map<string, GithubWorkflowRunRaw>();
    for (const run of wfCollapsed.kept) {
      const key = run.name.trim().toLowerCase();
      const existing = latestWorkflowBySuite.get(key);
      if (!existing) latestWorkflowBySuite.set(key, run);
      else if (isNewerWorkflowRun(run, existing)) {
        latestWorkflowBySuite.set(key, run);
        ignoredSupersededRuns += 1;
      } else {
        ignoredSupersededRuns += 1;
      }
    }
    const latestCheckBySuite = new Map<string, GithubCheckRunRaw>();
    for (const run of exactChecks) {
      const key = run.name.trim().toLowerCase();
      const existing = latestCheckBySuite.get(key);
      if (!existing) latestCheckBySuite.set(key, run);
      else if (isNewerCheckRun(run, existing)) {
        latestCheckBySuite.set(key, run);
        ignoredSupersededRuns += 1;
      } else {
        ignoredSupersededRuns += 1;
      }
    }
    const latestStatusByContext = new Map<string, GithubCommitStatusRaw>();
    for (const status of exactStatuses) {
      const key = status.context.trim().toLowerCase();
      const existing = latestStatusByContext.get(key);
      if (!existing) latestStatusByContext.set(key, status);
      else if (isNewerCommitStatus(status, existing)) {
        latestStatusByContext.set(key, status);
        ignoredSupersededRuns += 1;
      } else {
        ignoredSupersededRuns += 1;
      }
    }

    const allSuites: GithubCiSuiteResult[] = [];
    for (const run of latestWorkflowBySuite.values()) {
      allSuites.push({
        source: "workflow_run",
        suite: run.name,
        publisher: run.path,
        head_sha: expectedHeadSha,
        run_id: run.id,
        run_attempt: run.run_attempt,
        status: run.status,
        conclusion: run.conclusion,
        state: classifySuiteState(run.status, run.conclusion),
        created_at: run.created_at,
        html_url: run.html_url,
      });
    }
    for (const run of latestCheckBySuite.values()) {
      allSuites.push({
        source: "check_run",
        suite: run.name,
        publisher: run.app_slug ?? (run.app_id !== null ? `app:${run.app_id}` : null),
        head_sha: expectedHeadSha,
        run_id: run.id,
        run_attempt: 1,
        status: run.status,
        conclusion: run.conclusion,
        state: classifySuiteState(run.status, run.conclusion),
        created_at: run.started_at,
        html_url: run.html_url,
      });
    }
    for (const status of latestStatusByContext.values()) {
      const classified = classifyCommitStatusState(status.state);
      const { runId, runAttempt } = parseDispatchRunMeta(status);
      allSuites.push({
        source: "commit_status",
        suite: status.context,
        publisher: status.creator_login ?? (status.creator_id !== null ? `user:${status.creator_id}` : null),
        head_sha: expectedHeadSha,
        run_id: runId,
        run_attempt: runAttempt,
        status: classified.status,
        conclusion: classified.conclusion,
        state: classified.suiteState,
        created_at: status.created_at,
        html_url: status.target_url,
      });
    }

    const required = (options.requiredSuites ?? []).map((s) => s.trim()).filter((s) => s.length > 0);
    if (required.length > 0) {
      const seenRequired = new Set<string>();
      const addedKeys = new Set<string>();
      for (const req of required) {
        const lower = req.toLowerCase();
        if (seenRequired.has(lower)) continue;
        seenRequired.add(lower);
        const matches = allSuites.filter((entry) => suiteMatchesDiagnosticSelector(entry, lower));
        if (matches.length === 0) {
          missingSuites.push(req);
        } else {
          for (const match of matches) {
            const dedupKey = `${match.source}:${match.suite.toLowerCase()}:${match.run_id}`;
            if (!addedKeys.has(dedupKey)) {
              addedKeys.add(dedupKey);
              selectedSuites.push(match);
            }
          }
        }
      }
    } else {
      selectedSuites.push(...allSuites);
    }
  }

  selectedSuites.sort((a, b) =>
    a.suite.localeCompare(b.suite) || a.source.localeCompare(b.source) || a.run_id - b.run_id,
  );

  const hasFail = selectedSuites.some((s) => s.state === "fail");
  const hasPending = selectedSuites.some((s) => s.state === "pending");
  let decision: "pass" | "hold" | "pending";
  if (hasFail) {
    decision = "hold";
  } else if (missingSuites.length > 0 || hasPending || selectedSuites.length === 0) {
    decision = "pending";
  } else {
    decision = "pass";
  }

  return {
    head_sha: expectedHeadSha,
    policy_enforced: policy !== null,
    decision,
    verdict: decision === "pending" ? null : decision,
    suites: selectedSuites,
    missing_suites: missingSuites,
    ignored_stale_head: ignoredStaleHead,
    ignored_untrusted_publisher: ignoredUntrustedPublisher,
    ignored_superseded_attempts: ignoredSupersededAttempts,
    ignored_superseded_runs: ignoredSupersededRuns,
  };
}

export function formatGithubCiStampNote(evaluation: GithubCiEvaluation): string {
  const shortSha = evaluation.head_sha.slice(0, 9);
  const prefix = `GitHub CI ${evaluation.decision} @ ${shortSha}`;
  const parts: string[] = evaluation.suites.map((suite) => {
    const outcome = suite.status === "completed" ? (suite.conclusion ?? "unknown") : suite.status;
    return `${suite.suite} (attempt ${suite.run_attempt}, ${outcome}, run ${suite.run_id})`;
  });
  for (const missing of evaluation.missing_suites) {
    parts.push(`${missing} (missing)`);
  }
  if (parts.length === 0) {
    return `${prefix}: no runs on head`;
  }
  const full = `${prefix}: ${parts.join("; ")}`;
  if (full.length <= GITHUB_CI_NOTE_MAX) return full;
  return `${full.slice(0, GITHUB_CI_NOTE_MAX - 3)}...`;
}

export async function syncGithubCiToReviewCheck(options: {
  target: CloudTarget;
  bearer: string;
  workspaceId: string;
  checkId?: string;
  repo?: string;
  ref?: string;
  expectedHeadSha?: string;
  policy?: GithubCiPolicy | null;
  requiredSuites?: readonly string[];
  source?: GithubCiSource;
  apiBaseUrl?: string;
  githubToken?: string | null;
  timeoutMs?: number;
  maxBytes?: number;
  dryRun?: boolean;
  commandId?: string;
  /** Fetcher dedicated to CommonSwarm API calls (may carry session-proof headers). */
  fetcher?: typeof fetch;
  /** Independent fetcher dedicated strictly to GitHub API calls (defaults to plain global `fetch`, NEVER `options.fetcher`). */
  githubFetcher?: typeof fetch;
  signal?: AbortSignal;
}): Promise<GithubCiSyncResult> {
  const apiBaseUrl = normalizeGithubApiBaseUrl(options.apiBaseUrl);
  const dryRun = Boolean(options.dryRun);
  const policy = options.policy ? parseGithubCiPolicy(options.policy) : null;

  // Enforce origin & policy boundaries BEFORE making external requests.
  if (!dryRun) {
    if (!isTrustedGithubApiOrigin(apiBaseUrl)) {
      throw new GithubCiError(
        "github_untrusted_origin_stamp_refused",
        `Only ${TRUSTED_GITHUB_API_ORIGIN} evidence can stamp a review check; alternate --github-api-url overrides require --dry-run.`,
        400,
      );
    }
    if (policy === null) {
      throw new GithubCiError(
        "github_policy_required",
        "Stamping a review check from GitHub CI requires a trusted --policy-file pinning required suites and publisher identities (or pass --dry-run for diagnostic inspection).",
        400,
      );
    }
    if (options.source !== undefined && options.source !== "all") {
      throw new GithubCiError(
        "github_policy_source_mismatch",
        'Policy-enforced stamping reads all required sources automatically; use --dry-run for custom --source diagnostics.',
        400,
      );
    }
    if (options.requiredSuites && options.requiredSuites.length > 0) {
      throw new GithubCiError(
        "github_policy_suite_override_refused",
        "Cannot override policy required suites with --suite when stamping; pass --dry-run for ad-hoc diagnostics.",
        400,
      );
    }
  }

  const found = await readReviewChecks(options.target, options.bearer, options.workspaceId, {
    ...(options.checkId ? { checkId: options.checkId } : {}),
    ...(options.repo && options.ref ? { repo: options.repo, ref: options.ref } : {}),
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const check = found.review_check;
  if (!check) {
    throw new ReviewCheckError("not_found", "Review check not found.", 404);
  }
  if (policy !== null && policy.repo.toLowerCase() !== check.subject.repo.toLowerCase()) {
    throw new GithubCiError(
      "github_policy_repo_mismatch",
      `GitHub CI policy targets ${policy.repo}, not review check repository ${check.subject.repo}.`,
      400,
    );
  }

  const pinnedHeadSha = normalizeReviewCheckSha(check.head_sha);
  if (options.expectedHeadSha !== undefined) {
    const requestedSha = normalizeReviewCheckSha(options.expectedHeadSha);
    if (requestedSha !== pinnedHeadSha) {
      throw new ReviewCheckError(
        "stale_head",
        `Review check head_sha is ${pinnedHeadSha}, not ${requestedSha}. Refusing stale CI sync.`,
        409,
        pinnedHeadSha,
      );
    }
  }

  // Strictly separate GitHub fetcher from CommonSwarm's session-proof fetcher!
  const effectiveSource: GithubCiSource = options.source ?? "all";
  const policySources: Exclude<GithubCiSource, "all">[] | undefined =
    policy !== null
      ? [...new Set(policy.required.map((rule) =>
          rule.kind === "workflow_run" ? "actions" : rule.kind === "check_run" ? "checks" : "statuses",
        ))]
      : undefined;
  const rawCi = await readGithubCiForCommit({
    repo: check.subject.repo,
    headSha: pinnedHeadSha,
    source: effectiveSource,
    ...(policySources ? { sources: policySources } : {}),
    apiBaseUrl,
    token: options.githubToken ?? null,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
    fetcher: options.githubFetcher ?? fetch,
    ...(options.signal ? { signal: options.signal } : {}),
  });

  const evaluation = evaluateGithubCiRuns({
    expectedHeadSha: pinnedHeadSha,
    workflowRuns: rawCi.workflow_runs,
    checkRuns: rawCi.check_runs,
    commitStatuses: rawCi.commit_statuses,
    policy,
    ...(policy === null && options.requiredSuites ? { requiredSuites: options.requiredSuites } : {}),
  });
  const note = formatGithubCiStampNote(evaluation);

  if (dryRun || evaluation.verdict === null) {
    return {
      stamped: false,
      action: dryRun ? "dry_run" : "pending",
      check_id: check.check_id,
      repo: check.subject.repo,
      ref: check.subject.ref,
      head_sha: pinnedHeadSha,
      evaluation,
      note,
      review_check: check,
      satisfied_now: false,
      satisfied_signal_id: null,
    };
  }

  const stamped = await stampReviewCheck(options.target, options.bearer, options.workspaceId, {
    checkId: check.check_id,
    headSha: pinnedHeadSha,
    verdict: evaluation.verdict,
    note,
    ...(options.commandId ? { commandId: options.commandId } : {}),
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  return {
    stamped: true,
    action: evaluation.verdict,
    check_id: check.check_id,
    repo: check.subject.repo,
    ref: check.subject.ref,
    head_sha: pinnedHeadSha,
    evaluation,
    note,
    review_check: stamped.review_check,
    satisfied_now: stamped.satisfied_now,
    satisfied_signal_id: stamped.satisfied_signal_id,
  };
}

export function renderGithubCiSyncResult(result: GithubCiSyncResult): string {
  const lines = [
    `${result.note}`,
    `Action: ${result.action}${result.stamped ? " (stamped)" : " (not stamped)"}`,
  ];
  if (
    result.evaluation.ignored_stale_head > 0 ||
    result.evaluation.ignored_untrusted_publisher > 0 ||
    result.evaluation.ignored_superseded_attempts > 0 ||
    result.evaluation.ignored_superseded_runs > 0
  ) {
    lines.push(
      `Ignored: stale_head=${result.evaluation.ignored_stale_head}, untrusted_publisher=${result.evaluation.ignored_untrusted_publisher}, superseded_attempts=${result.evaluation.ignored_superseded_attempts}, superseded_runs=${result.evaluation.ignored_superseded_runs}`,
    );
  }
  lines.push(renderReviewCheck(result.review_check).trimEnd());
  return `${lines.join("\n")}\n`;
}
