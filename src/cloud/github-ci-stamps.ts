/**
 * C3b — Read-only GitHub CI status adapter for revision-bound review checks.
 *
 * Security & correctness invariants:
 *   - Strictly READ-ONLY against GitHub: issues ONLY HTTP GET requests with `redirect: "error"`.
 *   - Exact-head binding: validates every returned run's `head_sha` and strictly ignores any
 *     run/check whose `head_sha` differs from the review check's current `head_sha`.
 *   - Superseded-attempt filtering: within each workflow `run_id`, keeps ONLY the highest
 *     `run_attempt`; across runs for the same suite on the same head, keeps ONLY the latest run.
 *   - Fail closed: bounded timeout (`GITHUB_CI_TIMEOUT_MS`), bounded response size
 *     (`GITHUB_CI_MAX_BYTES`), strict response-schema validation (`github_malformed_response`),
 *     and strict `status === "completed" && conclusion === "success"` pass rule.
 *   - Secret hygiene: GitHub tokens are accepted ONLY via env (`GITHUB_TOKEN`/`GH_TOKEN`),
 *     a private 0600 file (`--github-token-file`), or stdin (`--github-token-stdin`) — never
 *     CLI argv — and are redacted from all error messages and never written to notes/stdout.
 */
import { lstat, readFile } from "node:fs/promises";
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

export const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";
export const GITHUB_CI_TIMEOUT_MS = 10_000;
export const GITHUB_CI_MAX_BYTES = 2 * 1024 * 1024;
export const GITHUB_CI_NOTE_MAX = 2_000;
export const GITHUB_CI_SOURCES = ["all", "actions", "checks"] as const;
export type GithubCiSource = (typeof GITHUB_CI_SOURCES)[number];

const GITHUB_REPO_RE = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
const FULL_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;
const TOKEN_FILE_MAX_BYTES = 4096;

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
  head_sha: string;
  run_attempt: number;
  status: string;
  conclusion: string | null;
  updated_at: string | null;
  created_at: string | null;
  html_url: string | null;
}

export interface GithubCheckRunRaw {
  id: number;
  name: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
  completed_at: string | null;
  started_at: string | null;
  html_url: string | null;
}

export type GithubCiSuiteState = "pass" | "fail" | "pending";

export interface GithubCiSuiteResult {
  source: "workflow_run" | "check_run";
  suite: string;
  head_sha: string;
  run_id: number;
  run_attempt: number;
  status: string;
  conclusion: string | null;
  state: GithubCiSuiteState;
  updated_at: string | null;
  html_url: string | null;
}

export interface GithubCiEvaluation {
  head_sha: string;
  decision: "pass" | "hold" | "pending";
  verdict: ReviewCheckVerdict | null;
  suites: GithubCiSuiteResult[];
  missing_suites: string[];
  ignored_stale_head: number;
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
      "GitHub API base URL must use https:// (or http:// on loopback for local fixtures).",
      400,
    );
  }
  return parsed.toString().replace(/\/+$/, "");
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

export async function readGithubTokenFromFile(filePath: string): Promise<string> {
  const myUid = process.getuid ? process.getuid() : null;
  let info;
  try {
    info = await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new GithubCiError("github_token_file_missing", "GitHub token file does not exist.", 400);
    }
    throw error;
  }
  const mode = info.mode & 0o777;
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size > TOKEN_FILE_MAX_BYTES ||
    (myUid !== null && info.uid !== myUid) ||
    (mode & 0o077) !== 0
  ) {
    throw new GithubCiError(
      "github_token_file_unsafe",
      "GitHub token file must be a private 0600 regular file owned by the current user.",
      400,
    );
  }
  const content = await readFile(filePath, "utf8");
  return validateGithubToken(content);
}

function parseTimestampMs(raw: unknown): number {
  if (typeof raw !== "string" || raw.length === 0) return 0;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : 0;
}

function parseOptionalString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new GithubCiError("github_malformed_response", `GitHub response field "${field}" must be a string or null.`, 502);
  }
  return value;
}

function parseWorkflowRunsPayload(payload: unknown): GithubWorkflowRunRaw[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new GithubCiError("github_malformed_response", "GitHub actions/runs response must be a JSON object.", 502);
  }
  const rawList = (payload as Record<string, unknown>).workflow_runs;
  if (!Array.isArray(rawList)) {
    throw new GithubCiError("github_malformed_response", 'GitHub actions/runs response is missing "workflow_runs" array.', 502);
  }
  const totalCount = (payload as Record<string, unknown>).total_count;
  if (typeof totalCount === "number" && Number.isSafeInteger(totalCount) && totalCount > rawList.length) {
    throw new GithubCiError(
      "github_response_truncated",
      `GitHub actions/runs returned ${rawList.length} of ${totalCount} runs; refusing to evaluate a truncated CI list.`,
      502,
    );
  }
  const out: GithubWorkflowRunRaw[] = [];
  for (const item of rawList) {
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
    const conclusion = parseOptionalString(r.conclusion, "conclusion");
    out.push({
      id: r.id,
      name: r.name.trim(),
      head_sha: r.head_sha.trim().toLowerCase(),
      run_attempt: attempt,
      status: r.status.trim().toLowerCase(),
      conclusion: conclusion === null ? null : conclusion.trim().toLowerCase(),
      updated_at: parseOptionalString(r.updated_at, "updated_at"),
      created_at: parseOptionalString(r.created_at, "created_at"),
      html_url: parseOptionalString(r.html_url, "html_url"),
    });
  }
  return out;
}

function parseCheckRunsPayload(payload: unknown): GithubCheckRunRaw[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new GithubCiError("github_malformed_response", "GitHub check-runs response must be a JSON object.", 502);
  }
  const rawList = (payload as Record<string, unknown>).check_runs;
  if (!Array.isArray(rawList)) {
    throw new GithubCiError("github_malformed_response", 'GitHub check-runs response is missing "check_runs" array.', 502);
  }
  const totalCount = (payload as Record<string, unknown>).total_count;
  if (typeof totalCount === "number" && Number.isSafeInteger(totalCount) && totalCount > rawList.length) {
    throw new GithubCiError(
      "github_response_truncated",
      `GitHub check-runs returned ${rawList.length} of ${totalCount} checks; refusing to evaluate a truncated CI list.`,
      502,
    );
  }
  const out: GithubCheckRunRaw[] = [];
  for (const item of rawList) {
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
    const conclusion = parseOptionalString(r.conclusion, "conclusion");
    out.push({
      id: r.id,
      name: r.name.trim(),
      head_sha: r.head_sha.trim().toLowerCase(),
      status: r.status.trim().toLowerCase(),
      conclusion: conclusion === null ? null : conclusion.trim().toLowerCase(),
      completed_at: parseOptionalString(r.completed_at, "completed_at"),
      started_at: parseOptionalString(r.started_at, "started_at"),
      html_url: parseOptionalString(r.html_url, "html_url"),
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
}): Promise<unknown> {
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

  try {
    return JSON.parse(rawText);
  } catch {
    throw new GithubCiError("github_malformed_response", "GitHub API returned invalid JSON.", 502);
  }
}

export async function readGithubCiForCommit(options: {
  repo: string;
  headSha: string;
  source?: GithubCiSource;
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
}> {
  const repo = normalizeGithubRepo(options.repo);
  const headSha = normalizeReviewCheckSha(options.headSha);
  const source: GithubCiSource = options.source ?? "all";
  if (!(GITHUB_CI_SOURCES as readonly string[]).includes(source)) {
    throw new GithubCiError("invalid_request", `source must be one of: ${GITHUB_CI_SOURCES.join(", ")}.`, 400);
  }
  const apiBaseUrl = normalizeGithubApiBaseUrl(options.apiBaseUrl);
  const token = options.token ? validateGithubToken(options.token) : null;
  const timeoutMs = options.timeoutMs ?? GITHUB_CI_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? GITHUB_CI_MAX_BYTES;
  const fetcher = options.fetcher ?? fetch;
  const encodedOwner = encodeURIComponent(repo.owner);
  const encodedName = encodeURIComponent(repo.name);

  let workflowRuns: GithubWorkflowRunRaw[] = [];
  let checkRuns: GithubCheckRunRaw[] = [];

  if (source === "all" || source === "actions") {
    const actionsUrl = `${apiBaseUrl}/repos/${encodedOwner}/${encodedName}/actions/runs?head_sha=${encodeURIComponent(headSha)}&per_page=100`;
    const payload = await githubReadOnlyGetJson({
      url: actionsUrl,
      token,
      timeoutMs,
      maxBytes,
      fetcher,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    workflowRuns = parseWorkflowRunsPayload(payload);
  }

  if (source === "all" || source === "checks") {
    const checksUrl = `${apiBaseUrl}/repos/${encodedOwner}/${encodedName}/commits/${encodeURIComponent(headSha)}/check-runs?per_page=100`;
    const payload = await githubReadOnlyGetJson({
      url: checksUrl,
      token,
      timeoutMs,
      maxBytes,
      fetcher,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    checkRuns = parseCheckRunsPayload(payload);
  }

  return {
    repo: repo.full,
    head_sha: headSha,
    workflow_runs: workflowRuns,
    check_runs: checkRuns,
  };
}

function classifySuiteState(status: string, conclusion: string | null): GithubCiSuiteState {
  if (status !== "completed") return "pending";
  // Fail closed: ONLY explicit "success" passes a revision-bound review check.
  return conclusion === "success" ? "pass" : "fail";
}

function isNewerWorkflowRun(candidate: GithubWorkflowRunRaw, current: GithubWorkflowRunRaw): boolean {
  if (candidate.id === current.id) {
    return candidate.run_attempt > current.run_attempt;
  }
  const candTs = Math.max(parseTimestampMs(candidate.updated_at), parseTimestampMs(candidate.created_at));
  const currTs = Math.max(parseTimestampMs(current.updated_at), parseTimestampMs(current.created_at));
  if (candTs !== currTs) return candTs > currTs;
  if (candidate.id !== current.id) return candidate.id > current.id;
  return candidate.run_attempt > current.run_attempt;
}

function isNewerCheckRun(candidate: GithubCheckRunRaw, current: GithubCheckRunRaw): boolean {
  const candTs = Math.max(parseTimestampMs(candidate.completed_at), parseTimestampMs(candidate.started_at));
  const currTs = Math.max(parseTimestampMs(current.completed_at), parseTimestampMs(current.started_at));
  // If either check run is queued without timestamps yet, rely on monotonically increasing GitHub run id.
  if (candTs === 0 || currTs === 0) {
    return candidate.id > current.id;
  }
  if (candTs !== currTs) return candTs > currTs;
  return candidate.id > current.id;
}

/**
 * Pure deterministic evaluator:
 *   1. Strictly ignores any workflow/check run whose `head_sha !== expectedHeadSha`.
 *   2. Within each workflow `run_id`, keeps ONLY the highest `run_attempt` (ignores older attempts).
 *   3. Within each suite name on `expectedHeadSha`, keeps ONLY the latest run.
 *   4. Applies optional `--suite` required filter; missing required suites keep decision `"pending"`.
 *   5. Any failing suite -> `"hold"`; any pending/missing/empty -> `"pending"`; all passing -> `"pass"`.
 */
export function evaluateGithubCiRuns(options: {
  expectedHeadSha: string;
  workflowRuns: readonly GithubWorkflowRunRaw[];
  checkRuns: readonly GithubCheckRunRaw[];
  requiredSuites?: readonly string[];
}): GithubCiEvaluation {
  const expectedHeadSha = normalizeReviewCheckSha(options.expectedHeadSha);
  let ignoredStaleHead = 0;
  let ignoredSupersededAttempts = 0;
  let ignoredSupersededRuns = 0;

  // Step 1 & 2 for workflow runs: filter exact head_sha, then collapse per run_id to highest run_attempt.
  const latestAttemptByRunId = new Map<number, GithubWorkflowRunRaw>();
  for (const run of options.workflowRuns) {
    const sha = run.head_sha.trim().toLowerCase();
    if (sha !== expectedHeadSha) {
      ignoredStaleHead += 1;
      continue;
    }
    const existing = latestAttemptByRunId.get(run.id);
    if (!existing) {
      latestAttemptByRunId.set(run.id, run);
    } else if (run.run_attempt > existing.run_attempt) {
      latestAttemptByRunId.set(run.id, run);
      ignoredSupersededAttempts += 1;
    } else {
      ignoredSupersededAttempts += 1;
    }
  }

  // Step 3 for workflow runs: collapse multiple runs of the same workflow suite on this head to the latest run.
  const latestWorkflowBySuite = new Map<string, GithubWorkflowRunRaw>();
  for (const run of latestAttemptByRunId.values()) {
    const key = run.name.trim().toLowerCase();
    const existing = latestWorkflowBySuite.get(key);
    if (!existing) {
      latestWorkflowBySuite.set(key, run);
    } else if (isNewerWorkflowRun(run, existing)) {
      latestWorkflowBySuite.set(key, run);
      ignoredSupersededRuns += 1;
    } else {
      ignoredSupersededRuns += 1;
    }
  }

  // Step 1 & 3 for check runs: filter exact head_sha, then collapse per check name to the latest run.
  const latestCheckBySuite = new Map<string, GithubCheckRunRaw>();
  for (const run of options.checkRuns) {
    const sha = run.head_sha.trim().toLowerCase();
    if (sha !== expectedHeadSha) {
      ignoredStaleHead += 1;
      continue;
    }
    const key = run.name.trim().toLowerCase();
    const existing = latestCheckBySuite.get(key);
    if (!existing) {
      latestCheckBySuite.set(key, run);
    } else if (isNewerCheckRun(run, existing)) {
      latestCheckBySuite.set(key, run);
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
      head_sha: expectedHeadSha,
      run_id: run.id,
      run_attempt: run.run_attempt,
      status: run.status,
      conclusion: run.conclusion,
      state: classifySuiteState(run.status, run.conclusion),
      updated_at: run.updated_at ?? run.created_at,
      html_url: run.html_url,
    });
  }
  for (const run of latestCheckBySuite.values()) {
    allSuites.push({
      source: "check_run",
      suite: run.name,
      head_sha: expectedHeadSha,
      run_id: run.id,
      run_attempt: 1,
      status: run.status,
      conclusion: run.conclusion,
      state: classifySuiteState(run.status, run.conclusion),
      updated_at: run.completed_at ?? run.started_at,
      html_url: run.html_url,
    });
  }

  const required = (options.requiredSuites ?? [])
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const missingSuites: string[] = [];
  let selectedSuites: GithubCiSuiteResult[];

  if (required.length > 0) {
    const seenRequired = new Set<string>();
    const dedupedRequired: string[] = [];
    for (const req of required) {
      const lower = req.toLowerCase();
      if (!seenRequired.has(lower)) {
        seenRequired.add(lower);
        dedupedRequired.push(req);
      }
    }
    selectedSuites = [];
    for (const req of dedupedRequired) {
      const lower = req.toLowerCase();
      const matches = allSuites.filter((entry) => entry.suite.toLowerCase() === lower);
      if (matches.length === 0) {
        missingSuites.push(req);
      } else {
        selectedSuites.push(...matches);
      }
    }
  } else {
    selectedSuites = allSuites;
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
    decision,
    verdict: decision === "pending" ? null : decision,
    suites: selectedSuites,
    missing_suites: missingSuites,
    ignored_stale_head: ignoredStaleHead,
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
  requiredSuites?: readonly string[];
  source?: GithubCiSource;
  apiBaseUrl?: string;
  githubToken?: string | null;
  timeoutMs?: number;
  maxBytes?: number;
  dryRun?: boolean;
  commandId?: string;
  fetcher?: typeof fetch;
  githubFetcher?: typeof fetch;
  signal?: AbortSignal;
}): Promise<GithubCiSyncResult> {
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

  const rawCi = await readGithubCiForCommit({
    repo: check.subject.repo,
    headSha: pinnedHeadSha,
    ...(options.source ? { source: options.source } : {}),
    ...(options.apiBaseUrl ? { apiBaseUrl: options.apiBaseUrl } : {}),
    ...(options.githubToken !== undefined ? { token: options.githubToken } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
    fetcher: options.githubFetcher ?? options.fetcher ?? fetch,
    ...(options.signal ? { signal: options.signal } : {}),
  });

  const evaluation = evaluateGithubCiRuns({
    expectedHeadSha: pinnedHeadSha,
    workflowRuns: rawCi.workflow_runs,
    checkRuns: rawCi.check_runs,
    ...(options.requiredSuites ? { requiredSuites: options.requiredSuites } : {}),
  });
  const note = formatGithubCiStampNote(evaluation);

  if (options.dryRun || evaluation.verdict === null) {
    return {
      stamped: false,
      action: options.dryRun ? "dry_run" : "pending",
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
    result.evaluation.ignored_superseded_attempts > 0 ||
    result.evaluation.ignored_superseded_runs > 0
  ) {
    lines.push(
      `Ignored: stale_head=${result.evaluation.ignored_stale_head}, superseded_attempts=${result.evaluation.ignored_superseded_attempts}, superseded_runs=${result.evaluation.ignored_superseded_runs}`,
    );
  }
  lines.push(renderReviewCheck(result.review_check).trimEnd());
  return `${lines.join("\n")}\n`;
}
