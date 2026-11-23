/**
 * C3b — Read-only GitHub CI status adapter for revision-bound review checks.
 *
 * Covers:
 *   1. Credential separation & origin pinning (HezSec C1):
 *      - Independent GitHub fetcher (never uses CommonSwarm's session-proof fetcher; zero
 *        CommonSwarm proof headers or bearer reach GitHub, zero GitHub token reaches CommonSwarm).
 *      - GitHub credentials pinned strictly to https://api.github.com; alternate --github-api-url
 *        overrides are credential-free (ambient GITHUB_TOKEN/GH_TOKEN suppressed, explicit token
 *        refused) and diagnostic (--dry-run) only (cannot stamp).
 *      - Atomic O_NOFOLLOW + O_NONBLOCK + fstat ownership/mode/type token & policy file opens
 *        (refuses symlinks, FIFOs, directories, and non-0600 files).
 *   2. Trusted publisher & expected-suite policy (HezSec C2):
 *      - Machine-written stamps require a trusted policy pinning required suites and publisher
 *        identities (workflow_path, check_run app_slug/app_id, or commit_status exact context +
 *        creator_login/creator_id).
 *      - Missing required suites stay pending; same-name results from untrusted publishers are
 *        strictly ignored; complete trusted controls stamp pass.
 *      - workflow_dispatch commit-status contexts ("server suite / p1-cli", "server suite / server")
 *        verified under trusted policy while isolating "server suite / mobile-audit (focused)".
 *   3. Completeness & immutable latest-run selection (HezSec C3):
 *      - Fails closed on ANY Link rel="next" continuation (even on a 1-item short page) across
 *        actions/runs, check-runs, and commits/{sha}/statuses.
 *      - Fails closed on missing/invalid/mismatched total_count and missing/invalid created_at.
 *      - Late-finishing older runs (higher updated_at/completed_at) NEVER override a newer pending
 *        or failed run across workflow runs, check runs, and commit statuses.
 *   4. End-to-end CLI (`executeCheckCiCli` + real `dist/cli.js check ci`) verification.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chmod, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  evaluateGithubCiRuns,
  formatGithubCiStampNote,
  GithubCiError,
  normalizeGithubApiBaseUrl,
  normalizeGithubRepo,
  parseGithubCiPolicy,
  readGithubCiForCommit,
  readGithubCiPolicyFile,
  readGithubTokenFromFile,
  syncGithubCiToReviewCheck,
  TRUSTED_GITHUB_API_ORIGIN,
  type GithubCiPolicy,
} from "../src/cloud/github-ci-stamps.js";
import { executeCheckCiCli, type ReviewCheckCliArgs } from "../src/cli/review-checks.js";
import { ReviewCheckError, type ReviewCheckRecord } from "../src/cloud/review-checks.js";
import {
  AGENT_SESSION_GENERATION_HEADER,
  AGENT_SESSION_ID_HEADER,
  AGENT_SESSION_KEY_HEADER,
  type AgentSessionProof,
} from "../src/cloud/session-contract.js";
import { bindSessionProof } from "../src/cloud/session-proof.js";

const execFileAsync = promisify(execFile);

const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CHECK_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const SHA_OLD = "1111111111111111111111111111111111111111";
const SHA_NEW = "2222222222222222222222222222222222222222";
const GH_SECRET = "ghp_secret_ci_token_do_not_leak_9876543210";
const CS_PROOF_SECRET = "cs_session_proof_secret_never_send_to_github";
const AGENT_TOKEN = `swm_agt_${"D".repeat(43)}`;
const CLI = resolve("dist/cli.js");

const TRUSTED_MIXED_POLICY: GithubCiPolicy = {
  version: 1,
  repo: "yulanventures/commonswarm",
  required: [
    { kind: "workflow_run", suite: "p1-cli", workflow_path: ".github/workflows/server-suite.yml" },
    { kind: "check_run", suite: "unit", app_slug: "github-actions" },
  ],
};

function makeCheckRecord(overrides: Partial<ReviewCheckRecord> = {}): ReviewCheckRecord {
  return {
    check_id: CHECK_ID,
    workspace_id: WS,
    subject: { kind: "pr", repo: "yulanventures/commonswarm", ref: "713" },
    head_sha: SHA_NEW,
    conversation_id: null,
    thread_root_id: null,
    required_seats: [{ kind: "agent", id: AGENT, name: "CI Watcher" }],
    stamps: [{
      seat_kind: "agent",
      seat_id: AGENT,
      name: "CI Watcher",
      verdict: null,
      head_sha: null,
      note: null,
      stamped_at: null,
      stale: false,
      effective_verdict: "pending",
    }],
    status: "pending",
    satisfied: false,
    satisfied_head_sha: null,
    satisfied_signal_id: null,
    satisfied_at: null,
    created_by: { kind: "agent", id: AGENT },
    created_at: "2026-11-20T20:00:00.000Z",
    updated_at: "2026-11-20T20:00:00.000Z",
    ...overrides,
  };
}

function makeCliArgs(
  positionals: string[],
  flags: Record<string, string | boolean | string[]> = {},
): ReviewCheckCliArgs {
  return {
    positionals,
    has(name: string) {
      return Object.hasOwn(flags, name) && flags[name] !== false && flags[name] !== undefined;
    },
    optional(name: string) {
      const value = flags[name];
      if (typeof value === "string") return value;
      if (Array.isArray(value)) return value[value.length - 1];
      return undefined;
    },
    all(name: string) {
      const value = flags[name];
      if (typeof value === "string") return [value];
      if (Array.isArray(value)) return value;
      return [];
    },
  };
}

/**
 * Creates a GitHub-origin-preserving fetcher that routes https://api.github.com/* to a local
 * mock server WITHOUT changing the adapter's origin checks (so tests exercise real trusted-origin
 * policy and credential separation end-to-end).
 */
function makeTrustedGithubProxyFetcher(localBaseUrl: string): typeof fetch {
  return (input, init) => {
    const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    assert.ok(
      rawUrl.startsWith(`${TRUSTED_GITHUB_API_ORIGIN}/`),
      `trusted GitHub fetcher must only target ${TRUSTED_GITHUB_API_ORIGIN}, got ${rawUrl}`,
    );
    const rewritten = `${localBaseUrl}${rawUrl.slice(TRUSTED_GITHUB_API_ORIGIN.length)}`;
    return fetch(rewritten, init);
  };
}

test("evaluateGithubCiRuns: policy enforcement, stale-head, superseded attempts, untrusted publishers, and immutable ordering (late-finishing older run)", () => {
  // 1. Late success on SHA_OLD is strictly ignored while SHA_NEW has pending suite -> pending.
  const staleIgnored = evaluateGithubCiRuns({
    expectedHeadSha: SHA_NEW,
    policy: TRUSTED_MIXED_POLICY,
    workflowRuns: [
      {
        id: 1001,
        name: "p1-cli",
        path: ".github/workflows/server-suite.yml",
        workflow_id: 10,
        head_sha: SHA_OLD,
        run_attempt: 1,
        status: "completed",
        conclusion: "success",
        created_at: "2026-11-20T20:00:00Z",
        updated_at: "2026-11-20T20:05:00Z",
        html_url: "https://github.com/yulanventures/commonswarm/actions/runs/1001",
      },
      {
        id: 1002,
        name: "p1-cli",
        path: ".github/workflows/server-suite.yml",
        workflow_id: 10,
        head_sha: SHA_NEW,
        run_attempt: 1,
        status: "in_progress",
        conclusion: null,
        created_at: "2026-11-20T20:01:00Z",
        updated_at: "2026-11-20T20:04:00Z",
        html_url: "https://github.com/yulanventures/commonswarm/actions/runs/1002",
      },
    ],
    checkRuns: [
      {
        id: 2001,
        name: "unit",
        app_slug: "github-actions",
        app_id: 15368,
        head_sha: SHA_OLD,
        status: "completed",
        conclusion: "success",
        started_at: "2026-11-20T20:00:00Z",
        completed_at: "2026-11-20T20:05:00Z",
        html_url: null,
      },
    ],
  });
  assert.equal(staleIgnored.policy_enforced, true);
  assert.equal(staleIgnored.decision, "pending");
  assert.equal(staleIgnored.verdict, null);
  assert.equal(staleIgnored.ignored_stale_head, 2);
  assert.deepEqual(staleIgnored.missing_suites, ["unit"]);

  // 2. Superseded attempt 1 (success) is ignored when attempt 2 fails -> hold.
  const attempt2Fail = evaluateGithubCiRuns({
    expectedHeadSha: SHA_NEW,
    policy: {
      version: 1,
      repo: "yulanventures/commonswarm",
      required: [{ kind: "workflow_run", suite: "p1-cli", workflow_path: ".github/workflows/server-suite.yml" }],
    },
    workflowRuns: [
      {
        id: 3001,
        name: "p1-cli",
        path: ".github/workflows/server-suite.yml",
        workflow_id: 10,
        head_sha: SHA_NEW,
        run_attempt: 1,
        status: "completed",
        conclusion: "success",
        created_at: "2026-11-20T20:00:00Z",
        updated_at: "2026-11-20T20:01:00Z",
        html_url: null,
      },
      {
        id: 3001,
        name: "p1-cli",
        path: ".github/workflows/server-suite.yml",
        workflow_id: 10,
        head_sha: SHA_NEW,
        run_attempt: 2,
        status: "completed",
        conclusion: "failure",
        created_at: "2026-11-20T20:02:00Z",
        updated_at: "2026-11-20T20:03:00Z",
        html_url: null,
      },
    ],
    checkRuns: [],
  });
  assert.equal(attempt2Fail.decision, "hold");
  assert.equal(attempt2Fail.verdict, "hold");
  assert.equal(attempt2Fail.ignored_superseded_attempts, 1);
  assert.equal(attempt2Fail.suites[0]!.run_attempt, 2);

  // 3. HezSec C2 witness: same-name results from untrusted publishers are strictly ignored!
  const untrustedIgnored = evaluateGithubCiRuns({
    expectedHeadSha: SHA_NEW,
    policy: {
      version: 1,
      repo: "yulanventures/commonswarm",
      required: [
        { kind: "workflow_run", suite: "p1-cli", workflow_path: ".github/workflows/server-suite.yml" },
        { kind: "check_run", suite: "unit", app_slug: "github-actions" },
        { kind: "commit_status", context: "server suite / server", creator_login: "github-actions[bot]" },
      ],
    },
    workflowRuns: [
      {
        id: 4100,
        name: "p1-cli",
        path: ".github/workflows/spoofed-p1-cli.yml",
        workflow_id: 999,
        head_sha: SHA_NEW,
        run_attempt: 1,
        status: "completed",
        conclusion: "success",
        created_at: "2026-11-20T20:00:00Z",
        updated_at: "2026-11-20T20:01:00Z",
        html_url: null,
      },
    ],
    checkRuns: [
      {
        id: 4200,
        name: "unit",
        app_slug: "untrusted-third-party-app",
        app_id: 99999,
        head_sha: SHA_NEW,
        status: "completed",
        conclusion: "success",
        started_at: "2026-11-20T20:00:00Z",
        completed_at: "2026-11-20T20:01:00Z",
        html_url: null,
      },
    ],
    commitStatuses: [
      {
        id: 4300,
        context: "server suite / server",
        state: "success",
        head_sha: SHA_NEW,
        creator_login: "random-repo-writer",
        creator_id: 7777,
        description: "spoofed green",
        target_url: "https://example.com/spoof",
        created_at: "2026-11-20T20:00:00Z",
        updated_at: "2026-11-20T20:00:00Z",
      },
    ],
  });
  assert.equal(untrustedIgnored.decision, "pending");
  assert.equal(untrustedIgnored.verdict, null);
  assert.equal(untrustedIgnored.ignored_untrusted_publisher, 3);
  assert.deepEqual(untrustedIgnored.missing_suites, ["p1-cli", "unit", "server suite / server"]);

  // 4. HezSec C3 witness: late-finishing older workflow_run (higher updated_at) NEVER beats newer pending/failed run!
  const lateOlderWorkflowVsNewerPending = evaluateGithubCiRuns({
    expectedHeadSha: SHA_NEW,
    policy: {
      version: 1,
      repo: "yulanventures/commonswarm",
      required: [{ kind: "workflow_run", suite: "p1-cli", workflow_path: ".github/workflows/server-suite.yml" }],
    },
    workflowRuns: [
      {
        id: 5001,
        name: "p1-cli",
        path: ".github/workflows/server-suite.yml",
        workflow_id: 10,
        head_sha: SHA_NEW,
        run_attempt: 1,
        status: "completed",
        conclusion: "success",
        created_at: "2026-11-20T20:00:00Z",
        updated_at: "2026-11-20T20:15:00Z", // finished LATE!
        html_url: null,
      },
      {
        id: 5002,
        name: "p1-cli",
        path: ".github/workflows/server-suite.yml",
        workflow_id: 10,
        head_sha: SHA_NEW,
        run_attempt: 1,
        status: "in_progress",
        conclusion: null,
        created_at: "2026-11-20T20:05:00Z", // created LATER!
        updated_at: "2026-11-20T20:06:00Z",
        html_url: null,
      },
    ],
    checkRuns: [],
  });
  assert.equal(lateOlderWorkflowVsNewerPending.decision, "pending");
  assert.equal(lateOlderWorkflowVsNewerPending.suites[0]!.run_id, 5002);

  // 5. HezSec C3 witness: late-finishing older check_run (higher completed_at) NEVER beats newer failed check_run!
  const lateOlderCheckVsNewerFailure = evaluateGithubCiRuns({
    expectedHeadSha: SHA_NEW,
    policy: {
      version: 1,
      repo: "yulanventures/commonswarm",
      required: [{ kind: "check_run", suite: "unit", app_slug: "github-actions" }],
    },
    workflowRuns: [],
    checkRuns: [
      {
        id: 6001,
        name: "unit",
        app_slug: "github-actions",
        app_id: 15368,
        head_sha: SHA_NEW,
        status: "completed",
        conclusion: "success",
        started_at: "2026-11-20T20:00:00Z",
        completed_at: "2026-11-20T20:15:00Z", // finished LATE!
        html_url: null,
      },
      {
        id: 6002,
        name: "unit",
        app_slug: "github-actions",
        app_id: 15368,
        head_sha: SHA_NEW,
        status: "completed",
        conclusion: "failure",
        started_at: "2026-11-20T20:05:00Z",
        completed_at: "2026-11-20T20:06:00Z", // failed earlier, newer check_run id!
        html_url: null,
      },
    ],
  });
  assert.equal(lateOlderCheckVsNewerFailure.decision, "hold");
  assert.equal(lateOlderCheckVsNewerFailure.verdict, "hold");
  assert.equal(lateOlderCheckVsNewerFailure.suites[0]!.run_id, 6002);

  // 5b. HezSec C3 witness: late-finishing older check_run NEVER beats newer pending (queued) check_run!
  const lateOlderCheckVsNewerPending = evaluateGithubCiRuns({
    expectedHeadSha: SHA_NEW,
    policy: {
      version: 1,
      repo: "yulanventures/commonswarm",
      required: [{ kind: "check_run", suite: "unit", app_slug: "github-actions" }],
    },
    workflowRuns: [],
    checkRuns: [
      {
        id: 6101,
        name: "unit",
        app_slug: "github-actions",
        app_id: 15368,
        head_sha: SHA_NEW,
        status: "completed",
        conclusion: "success",
        started_at: "2026-11-20T20:00:00Z",
        completed_at: "2026-11-20T20:20:00Z",
        html_url: null,
      },
      {
        id: 6102,
        name: "unit",
        app_slug: "github-actions",
        app_id: 15368,
        head_sha: SHA_NEW,
        status: "queued",
        conclusion: null,
        started_at: null,
        completed_at: null,
        html_url: null,
      },
    ],
  });
  assert.equal(lateOlderCheckVsNewerPending.decision, "pending");
  assert.equal(lateOlderCheckVsNewerPending.verdict, null);
  assert.equal(lateOlderCheckVsNewerPending.suites[0]!.run_id, 6102);

  // 6. HezSec C3 witness: late-updated older commit_status NEVER beats newer failed commit_status!
  const lateOlderStatusVsNewerFailure = evaluateGithubCiRuns({
    expectedHeadSha: SHA_NEW,
    policy: {
      version: 1,
      repo: "yulanventures/commonswarm",
      required: [{ kind: "commit_status", context: "server suite / server", creator_login: "github-actions[bot]" }],
    },
    workflowRuns: [],
    checkRuns: [],
    commitStatuses: [
      {
        id: 7001,
        context: "server suite / server",
        state: "success",
        head_sha: SHA_NEW,
        creator_login: "github-actions[bot]",
        creator_id: 41898282,
        description: "dispatch run 100: success",
        target_url: "https://github.com/yulanventures/commonswarm/actions/runs/100",
        created_at: "2026-11-20T20:00:00Z",
        updated_at: "2026-11-20T20:15:00Z",
      },
      {
        id: 7002,
        context: "server suite / server",
        state: "failure",
        head_sha: SHA_NEW,
        creator_login: "github-actions[bot]",
        creator_id: 41898282,
        description: "dispatch run 200: failure",
        target_url: "https://github.com/yulanventures/commonswarm/actions/runs/200",
        created_at: "2026-11-20T20:05:00Z",
        updated_at: "2026-11-20T20:05:00Z",
      },
    ],
  });
  assert.equal(lateOlderStatusVsNewerFailure.decision, "hold");
  assert.equal(lateOlderStatusVsNewerFailure.suites[0]!.run_id, 200);

  // 7. Complete trusted control passes cleanly and formats note.
  const completeTrusted = evaluateGithubCiRuns({
    expectedHeadSha: SHA_NEW,
    policy: TRUSTED_MIXED_POLICY,
    workflowRuns: [
      {
        id: 4002,
        name: "p1-cli",
        path: ".github/workflows/server-suite.yml",
        workflow_id: 10,
        head_sha: SHA_NEW,
        run_attempt: 1,
        status: "completed",
        conclusion: "failure",
        created_at: "2026-11-20T20:01:30Z",
        updated_at: "2026-11-20T20:02:00Z",
        html_url: null,
      },
      {
        id: 4002,
        name: "p1-cli",
        path: ".github/workflows/server-suite.yml",
        workflow_id: 10,
        head_sha: SHA_NEW,
        run_attempt: 2,
        status: "completed",
        conclusion: "success",
        created_at: "2026-11-20T20:03:00Z",
        updated_at: "2026-11-20T20:04:00Z",
        html_url: null,
      },
    ],
    checkRuns: [
      {
        id: 5001,
        name: "unit",
        app_slug: "github-actions",
        app_id: 15368,
        head_sha: SHA_NEW,
        status: "completed",
        conclusion: "success",
        started_at: "2026-11-20T20:03:00Z",
        completed_at: "2026-11-20T20:04:00Z",
        html_url: null,
      },
    ],
  });
  assert.equal(completeTrusted.decision, "pass");
  assert.equal(completeTrusted.verdict, "pass");
  assert.equal(completeTrusted.ignored_superseded_attempts, 1);
  const note = formatGithubCiStampNote(completeTrusted);
  assert.match(note, /^GitHub CI pass @ 222222222:/);
  assert.match(note, /p1-cli \(attempt 2, success, run 4002\)/);
  assert.match(note, /unit \(attempt 1, success, run 5001\)/);

  // 8. Diagnostic mode without policy never produces a stamp verdict.
  const diagnosticOnly = evaluateGithubCiRuns({
    expectedHeadSha: SHA_NEW,
    requiredSuites: ["p1-cli"],
    workflowRuns: [
      {
        id: 4009,
        name: "p1-cli",
        path: ".github/workflows/server-suite.yml",
        workflow_id: 10,
        head_sha: SHA_NEW,
        run_attempt: 1,
        status: "completed",
        conclusion: "success",
        created_at: "2026-11-20T20:03:00Z",
        updated_at: "2026-11-20T20:04:00Z",
        html_url: null,
      },
    ],
    checkRuns: [],
  });
  assert.equal(diagnosticOnly.policy_enforced, false);
  assert.equal(diagnosticOnly.decision, "pass");
  assert.equal(diagnosticOnly.verdict, null);

  // 9. Lead item: formatGithubCiStampNote replaces control characters and newlines with single spaces.
  const sanitizedNote = formatGithubCiStampNote({
    ...completeTrusted,
    suites: [
      {
        ...completeTrusted.suites[0]!,
        suite: "p1-cli\r\n\t\x1b[31m\x00red\x7f",
        status: "completed",
        conclusion: "success\n\x07spoofed",
      },
    ],
    missing_suites: ["unit\r\nmissing\x1fcheck"],
  });
  assert.equal(/[\x00-\x1f\x7f]/.test(sanitizedNote), false, "stamp note must contain zero control characters or newlines");
  assert.match(sanitizedNote, /p1-cli \[31m red \(attempt 2, success spoofed, run 4002\)/);
  assert.match(sanitizedNote, /unit missing check \(missing\)/);
});

test("HezSec C1 & C3 protocol witnesses: atomic O_NOFOLLOW token file, untrusted-origin token refusal, short-page Link next, invalid total_count, missing created_at", async () => {
  assert.throws(() => normalizeGithubRepo("../evil"), { code: "github_repo_invalid" });
  assert.throws(() => normalizeGithubRepo("owner/repo?foo=1"), { code: "github_repo_invalid" });
  assert.throws(() => normalizeGithubApiBaseUrl("http://api.github.com"), { code: "github_api_url_invalid" });
  assert.throws(() => normalizeGithubApiBaseUrl("https://user:pass@api.github.com"), { code: "github_api_url_invalid" });
  assert.throws(() => normalizeGithubApiBaseUrl("https://evil.example"), { code: "github_api_url_invalid" });
  assert.throws(() => normalizeGithubApiBaseUrl("http://localhost:8080"), { code: "github_api_url_invalid" });
  assert.throws(() => normalizeGithubApiBaseUrl("https://localhost:8080"), { code: "github_api_url_invalid" });
  assert.throws(() => normalizeGithubApiBaseUrl("https://api.github.com/extra"), { code: "github_api_url_invalid" });
  assert.throws(() => normalizeGithubApiBaseUrl("http://127.0.0.1"), { code: "github_api_url_invalid" });
  assert.equal(normalizeGithubApiBaseUrl("https://api.github.com/"), "https://api.github.com");
  assert.equal(normalizeGithubApiBaseUrl("http://127.0.0.1:8080/"), "http://127.0.0.1:8080");
  assert.equal(normalizeGithubApiBaseUrl("http://[::1]:8080/"), "http://[::1]:8080");

  // Policy validator rejects traversal workflow_path and duplicate rules.
  assert.throws(
    () => parseGithubCiPolicy({
      version: 1,
      repo: "yulanventures/commonswarm",
      required: [{ kind: "workflow_run", suite: "unit", workflow_path: ".github/workflows/../evil.yml" }],
    }),
    { code: "github_policy_invalid" },
  );
  assert.throws(
    () => parseGithubCiPolicy({
      version: 1,
      repo: "yulanventures/commonswarm",
      required: [
        { kind: "check_run", suite: "unit", app_slug: "github-actions" },
        { kind: "check_run", suite: "unit", app_slug: "github-actions" },
      ],
    }),
    { code: "github_policy_invalid" },
  );

  const root = await mkdtemp(join(tmpdir(), "cs-gh-sec-"));
  try {
    // 1. Atomic O_NOFOLLOW + O_NONBLOCK + fstat token file checks (and swap-before-open witness).
    const tokenPath = join(root, "token.txt");
    const openPath = join(root, "open.txt");
    const dirPath = join(root, "dir.txt");
    const fifoPath = join(root, "fifo.txt");
    await writeFile(tokenPath, `${GH_SECRET}\n`, { mode: 0o600 });
    await chmod(tokenPath, 0o600);
    await writeFile(openPath, `${GH_SECRET}\n`, { mode: 0o644 });
    await chmod(openPath, 0o644);
    await mkdir(dirPath, { mode: 0o700 });

    assert.equal(await readGithubTokenFromFile(tokenPath), GH_SECRET);
    await assert.rejects(() => readGithubTokenFromFile(openPath), { code: "github_token_file_unsafe" });
    await assert.rejects(() => readGithubTokenFromFile(dirPath), { code: "github_token_file_unsafe" });

    // Swap safe token file to wrong mode (0644) before open -> refused via fstat on opened handle!
    await chmod(tokenPath, 0o644);
    await assert.rejects(
      () => readGithubTokenFromFile(tokenPath),
      (err: unknown) => {
        assert.ok(err instanceof GithubCiError);
        assert.equal(err.code, "github_token_file_unsafe");
        assert.equal(err.message.includes(root), false, "error message must never include local filesystem path");
        return true;
      },
    );
    await chmod(tokenPath, 0o600);

    // Swap safe token file to a symlink before open -> refused via O_NOFOLLOW!
    const targetSecret = join(root, "real.txt");
    await writeFile(targetSecret, `${GH_SECRET}\n`, { mode: 0o600 });
    await chmod(targetSecret, 0o600);
    await unlink(tokenPath);
    await symlink(targetSecret, tokenPath);
    await assert.rejects(() => readGithubTokenFromFile(tokenPath), { code: "github_token_file_unsafe" });

    // Swap to a FIFO -> O_NONBLOCK opens immediately and fstat rejects non-regular file without hanging!
    await execFileAsync("mkfifo", ["-m", "0600", fifoPath]);
    await assert.rejects(() => readGithubTokenFromFile(fifoPath), { code: "github_token_file_unsafe" });

    // Policy file rejects symlinks & group-writable files.
    const policyPath = join(root, "policy.json");
    const policyLink = join(root, "policy-link.json");
    await writeFile(policyPath, JSON.stringify(TRUSTED_MIXED_POLICY), { mode: 0o644 });
    await chmod(policyPath, 0o644);
    assert.equal((await readGithubCiPolicyFile(policyPath)).repo, "yulanventures/commonswarm");
    await chmod(policyPath, 0o664);
    await assert.rejects(() => readGithubCiPolicyFile(policyPath), { code: "github_policy_file_unsafe" });
    await chmod(policyPath, 0o644);
    await symlink(policyPath, policyLink);
    await assert.rejects(() => readGithubCiPolicyFile(policyLink), { code: "github_policy_file_unsafe" });

    // 2. HezSec C1: sending a GitHub token to a non-trusted origin is refused before any fetch!
    let untrustedFetchCalls = 0;
    await assert.rejects(
      () => readGithubCiForCommit({
        repo: "yulanventures/commonswarm",
        headSha: SHA_NEW,
        apiBaseUrl: "http://127.0.0.1:9999",
        token: GH_SECRET,
        fetcher: async () => {
          untrustedFetchCalls += 1;
          return new Response("{}", { status: 200 });
        },
      }),
      { code: "github_untrusted_origin_token_refused" },
    );
    assert.equal(untrustedFetchCalls, 0);

    // 3. Token redaction on transport error.
    await assert.rejects(
      () => readGithubCiForCommit({
        repo: "yulanventures/commonswarm",
        headSha: SHA_NEW,
        token: GH_SECRET,
        fetcher: async () => {
          throw new Error(`network fail carrying ${GH_SECRET}`);
        },
      }),
      (err: unknown) => {
        assert.ok(err instanceof GithubCiError);
        assert.equal(err.code, "github_transport_error");
        assert.equal(err.message.includes(GH_SECRET), false, "token must be redacted");
        assert.match(err.message, /\[redacted\]/);
        return true;
      },
    );

    // 4. HezSec C3: SHORT 1-item page with Link rel="next" fails closed on ALL THREE endpoints!
    const nextLinkHeader = {
      "content-type": "application/json",
      link: '<https://api.github.com/repos/yulanventures/commonswarm/x?page=2>; rel="next"',
    };
    await assert.rejects(
      () => readGithubCiForCommit({
        repo: "yulanventures/commonswarm",
        headSha: SHA_NEW,
        source: "actions",
        fetcher: async () => new Response(JSON.stringify({
          total_count: 1,
          workflow_runs: [{
            id: 1, name: "unit", path: ".github/workflows/server-suite.yml", head_sha: SHA_NEW,
            run_attempt: 1, status: "completed", conclusion: "success", created_at: "2026-11-20T20:00:00Z",
          }],
        }), { status: 200, headers: nextLinkHeader }),
      }),
      { code: "github_response_truncated" },
    );
    await assert.rejects(
      () => readGithubCiForCommit({
        repo: "yulanventures/commonswarm",
        headSha: SHA_NEW,
        source: "checks",
        fetcher: async () => new Response(JSON.stringify({
          total_count: 1,
          check_runs: [{
            id: 1, name: "unit", head_sha: SHA_NEW, status: "completed", conclusion: "success",
            app: { id: 15368, slug: "github-actions" },
          }],
        }), { status: 200, headers: nextLinkHeader }),
      }),
      { code: "github_response_truncated" },
    );
    await assert.rejects(
      () => readGithubCiForCommit({
        repo: "yulanventures/commonswarm",
        headSha: SHA_NEW,
        source: "statuses",
        fetcher: async () => new Response(JSON.stringify([{
          id: 1, context: "server suite / unit", state: "success",
          created_at: "2026-11-20T20:00:00Z", creator: { login: "github-actions[bot]", id: 41898282 },
        }]), { status: 200, headers: nextLinkHeader }),
      }),
      { code: "github_response_truncated" },
    );

    // 5. HezSec C3: missing / invalid / smaller total_count fails closed!
    for (const badTotal of [undefined, "1", -1, 0]) {
      await assert.rejects(
        () => readGithubCiForCommit({
          repo: "yulanventures/commonswarm",
          headSha: SHA_NEW,
          source: "actions",
          fetcher: async () => new Response(JSON.stringify({
            ...(badTotal !== undefined ? { total_count: badTotal } : {}),
            workflow_runs: [{
              id: 1, name: "unit", path: ".github/workflows/server-suite.yml", head_sha: SHA_NEW,
              run_attempt: 1, status: "completed", conclusion: "success", created_at: "2026-11-20T20:00:00Z",
            }],
          }), { status: 200 }),
        }),
        { code: "github_malformed_response" },
      );
      await assert.rejects(
        () => readGithubCiForCommit({
          repo: "yulanventures/commonswarm",
          headSha: SHA_NEW,
          source: "checks",
          fetcher: async () => new Response(JSON.stringify({
            ...(badTotal !== undefined ? { total_count: badTotal } : {}),
            check_runs: [{
              id: 1, name: "unit", head_sha: SHA_NEW, status: "completed", conclusion: "success",
            }],
          }), { status: 200 }),
        }),
        { code: "github_malformed_response" },
      );
    }
    await assert.rejects(
      () => readGithubCiForCommit({
        repo: "yulanventures/commonswarm",
        headSha: SHA_NEW,
        source: "checks",
        fetcher: async () => new Response(JSON.stringify({
          total_count: 150,
          check_runs: [{
            id: 1, name: "unit", head_sha: SHA_NEW, status: "completed", conclusion: "success",
          }],
        }), { status: 200 }),
      }),
      { code: "github_response_truncated" },
    );

    // 6. HezSec C3: missing or invalid created_at fails closed on workflow_runs and statuses!
    await assert.rejects(
      () => readGithubCiForCommit({
        repo: "yulanventures/commonswarm",
        headSha: SHA_NEW,
        source: "actions",
        fetcher: async () => new Response(JSON.stringify({
          total_count: 1,
          workflow_runs: [{
            id: 1, name: "unit", head_sha: SHA_NEW, run_attempt: 1, status: "completed", conclusion: "success",
          }],
        }), { status: 200 }),
      }),
      { code: "github_malformed_response" },
    );
    await assert.rejects(
      () => readGithubCiForCommit({
        repo: "yulanventures/commonswarm",
        headSha: SHA_NEW,
        source: "statuses",
        fetcher: async () => new Response(JSON.stringify([{
          id: 1, context: "server suite / unit", state: "success", created_at: "not-a-timestamp",
        }]), { status: 200 }),
      }),
      { code: "github_malformed_response" },
    );

    // 7. Bounded timeout fails closed with github_timeout.
    await assert.rejects(
      () => readGithubCiForCommit({
        repo: "yulanventures/commonswarm",
        headSha: SHA_NEW,
        source: "actions",
        timeoutMs: 40,
        fetcher: async (_url, init) => new Promise<Response>((_res, rej) => {
          init?.signal?.addEventListener("abort", () => rej(new Error("aborted")), { once: true });
        }),
      }),
      { code: "github_timeout" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("HezSec C1 + C2 end-to-end: separate credentials/fetchers, no CS proof on GitHub, no GH bearer at alternate origin, policy-bound stamping, and real CLI", async () => {
  const realSessionProof: AgentSessionProof = {
    session_id: "12345678-1234-4123-8123-123456789abc",
    generation: 3,
    key: "K".repeat(43),
  };
  const githubRequests: Array<{
    method: string;
    url: string;
    auth: string | null;
    csProof: string | null;
    sessionId: string | null;
    sessionGen: string | null;
    sessionKey: string | null;
  }> = [];
  const csRequests: Array<{
    url: string;
    auth: string | null;
    csProof: string | null;
    sessionId: string | null;
    sessionGen: string | null;
    sessionKey: string | null;
  }> = [];
  const stampedCommands: Array<Record<string, unknown>> = [];
  let ghMode: "pass" | "hold" | "pending" | "untrusted_only" = "pass";
  let currentCheck = makeCheckRecord();

  const ghServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    githubRequests.push({
      method: req.method ?? "",
      url: req.url ?? "",
      auth: typeof req.headers.authorization === "string" ? req.headers.authorization : null,
      csProof: typeof req.headers["x-swarm-session-proof"] === "string" ? req.headers["x-swarm-session-proof"] : null,
      sessionId: typeof req.headers[AGENT_SESSION_ID_HEADER] === "string" ? req.headers[AGENT_SESSION_ID_HEADER] : null,
      sessionGen: typeof req.headers[AGENT_SESSION_GENERATION_HEADER] === "string" ? req.headers[AGENT_SESSION_GENERATION_HEADER] : null,
      sessionKey: typeof req.headers[AGENT_SESSION_KEY_HEADER] === "string" ? req.headers[AGENT_SESSION_KEY_HEADER] : null,
    });
    assert.equal(req.method, "GET", "GitHub CI adapter must be strictly read-only GET");
    if (req.url?.includes("/actions/runs")) {
      const workflow_runs = ghMode === "pass"
        ? [
          { id: 8001, name: "p1-cli", path: ".github/workflows/server-suite.yml", workflow_id: 10, head_sha: SHA_OLD, run_attempt: 1, status: "completed", conclusion: "failure", created_at: "2026-11-20T20:00:00Z", updated_at: "2026-11-20T20:09:00Z", html_url: null },
          { id: 9001, name: "p1-cli", path: ".github/workflows/server-suite.yml", workflow_id: 10, head_sha: SHA_NEW, run_attempt: 1, status: "completed", conclusion: "failure", created_at: "2026-11-20T20:00:00Z", updated_at: "2026-11-20T20:01:00Z", html_url: null },
          { id: 9001, name: "p1-cli", path: ".github/workflows/server-suite.yml", workflow_id: 10, head_sha: SHA_NEW, run_attempt: 2, status: "completed", conclusion: "success", created_at: "2026-11-20T20:02:00Z", updated_at: "2026-11-20T20:05:00Z", html_url: null },
        ]
        : ghMode === "hold"
        ? [
          { id: 9002, name: "p1-cli", path: ".github/workflows/server-suite.yml", workflow_id: 10, head_sha: SHA_NEW, run_attempt: 1, status: "completed", conclusion: "failure", created_at: "2026-11-20T20:02:00Z", updated_at: "2026-11-20T20:05:00Z", html_url: null },
        ]
        : ghMode === "pending"
        ? [
          // Only p1-cli is green; required "unit" check_run has not appeared yet -> must stay pending!
          { id: 9003, name: "p1-cli", path: ".github/workflows/server-suite.yml", workflow_id: 10, head_sha: SHA_NEW, run_attempt: 1, status: "completed", conclusion: "success", created_at: "2026-11-20T20:02:00Z", updated_at: "2026-11-20T20:05:00Z", html_url: null },
        ]
        : [
          // Same-name run from UNTRUSTED workflow path!
          { id: 9004, name: "p1-cli", path: ".github/workflows/untrusted.yml", workflow_id: 99, head_sha: SHA_NEW, run_attempt: 1, status: "completed", conclusion: "success", created_at: "2026-11-20T20:02:00Z", updated_at: "2026-11-20T20:05:00Z", html_url: null },
        ];
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ total_count: workflow_runs.length, workflow_runs }));
      return;
    }
    if (req.url?.includes("/check-runs")) {
      const check_runs = ghMode === "pass"
        ? [{ id: 7001, name: "unit", app: { id: 15368, slug: "github-actions" }, head_sha: SHA_NEW, status: "completed", conclusion: "success", started_at: "2026-11-20T20:02:00Z", completed_at: "2026-11-20T20:05:00Z", html_url: null }]
        : ghMode === "untrusted_only"
        ? [{ id: 7002, name: "unit", app: { id: 88888, slug: "other-app" }, head_sha: SHA_NEW, status: "completed", conclusion: "success", started_at: "2026-11-20T20:02:00Z", completed_at: "2026-11-20T20:05:00Z", html_url: null }]
        : [];
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ total_count: check_runs.length, check_runs }));
      return;
    }
    if (req.url?.includes("/statuses")) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify([]));
      return;
    }
    res.writeHead(404).end();
  });

  const csServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    csRequests.push({
      url: req.url ?? "",
      auth: typeof req.headers.authorization === "string" ? req.headers.authorization : null,
      csProof: typeof req.headers["x-swarm-session-proof"] === "string" ? req.headers["x-swarm-session-proof"] : null,
      sessionId: typeof req.headers[AGENT_SESSION_ID_HEADER] === "string" ? req.headers[AGENT_SESSION_ID_HEADER] : null,
      sessionGen: typeof req.headers[AGENT_SESSION_GENERATION_HEADER] === "string" ? req.headers[AGENT_SESSION_GENERATION_HEADER] : null,
      sessionKey: typeof req.headers[AGENT_SESSION_KEY_HEADER] === "string" ? req.headers[AGENT_SESSION_KEY_HEADER] : null,
    });
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      if (req.url === "/functions/v1/read" && body.resource === "review_checks") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ review_check: currentCheck }));
        return;
      }
      if (req.url === "/functions/v1/command" && body.command?.kind === "review_check_stamp") {
        stampedCommands.push(body.command);
        currentCheck = makeCheckRecord({
          status: body.command.verdict === "pass" ? "satisfied" : "hold",
          satisfied: body.command.verdict === "pass",
          stamps: [{
            seat_kind: "agent",
            seat_id: AGENT,
            name: "CI Watcher",
            verdict: body.command.verdict,
            head_sha: body.command.head_sha,
            note: body.command.note,
            stamped_at: "2026-11-20T20:06:00.000Z",
            stale: false,
            effective_verdict: body.command.verdict,
          }],
        });
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          review_check: currentCheck,
          satisfied_now: body.command.verdict === "pass",
          satisfied_signal_id: body.command.verdict === "pass" ? "99999999-9999-4999-8999-999999999999" : null,
        }));
        return;
      }
      res.writeHead(404).end();
    });
  });

  await new Promise<void>((r) => ghServer.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => csServer.listen(0, "127.0.0.1", r));
  const ghUrl = `http://127.0.0.1:${(ghServer.address() as { port: number }).port}`;
  const csTarget = { url: `http://127.0.0.1:${(csServer.address() as { port: number }).port}`, anonKey: "fixture-anon", profileId: "fixture" };
  const trustedGhFetcher = makeTrustedGithubProxyFetcher(ghUrl);

  // Real CommonSwarm session-proof-injecting fetcher from src/cloud/session-proof.ts
  // (plus the synthetic header check kept for backwards compatibility).
  const realBoundFetcher = bindSessionProof(fetch, realSessionProof);
  const csSessionProofFetcher: typeof fetch = (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("x-swarm-session-proof", CS_PROOF_SECRET);
    return realBoundFetcher(input, { ...init, headers });
  };

  const root = await mkdtemp(join(tmpdir(), "cs-gh-cli-"));
  try {
    const policyFile = join(root, "ci-policy.json");
    const tokenFile = join(root, "gh.token");
    const agentTokenFile = join(root, "agent.token");
    await writeFile(policyFile, JSON.stringify(TRUSTED_MIXED_POLICY), { mode: 0o644 });
    await chmod(policyFile, 0o644);
    await writeFile(tokenFile, `${GH_SECRET}\n`, { mode: 0o600 });
    await chmod(tokenFile, 0o600);
    await writeFile(agentTokenFile, `${AGENT_TOKEN}\n`, { mode: 0o600 });
    await chmod(agentTokenFile, 0o600);

    // 1. HezSec C1: alternate --github-api-url + ambient GITHUB_TOKEN + --dry-run sends ZERO Authorization header!
    const beforeAlt = githubRequests.length;
    const altDryOut = await executeCheckCiCli(
      makeCliArgs(["check", "ci", CHECK_ID], {
        "github-api-url": ghUrl,
        "dry-run": true,
        json: true,
      }),
      { target: csTarget, bearer: AGENT_TOKEN, workspaceId: WS, fetcher: csSessionProofFetcher },
      { env: { GITHUB_TOKEN: GH_SECRET } },
    );
    assert.equal(JSON.parse(altDryOut).action, "dry_run");
    const altReqs = githubRequests.slice(beforeAlt);
    assert.ok(altReqs.length >= 1);
    assert.ok(altReqs.every((r) => r.auth === null), "alternate origin MUST NOT receive ambient GitHub bearer");
    assert.ok(altReqs.every((r) => r.csProof === null), "GitHub request MUST NOT receive CommonSwarm session-proof header");

    // 2. HezSec C1: alternate --github-api-url + explicit --github-token-file is REFUSED before any request!
    const beforeExplicitRefuse = githubRequests.length;
    await assert.rejects(
      () => executeCheckCiCli(
        makeCliArgs(["check", "ci", CHECK_ID], {
          "github-api-url": ghUrl,
          "github-token-file": tokenFile,
          "dry-run": true,
        }),
        { target: csTarget, bearer: AGENT_TOKEN, workspaceId: WS, fetcher: csSessionProofFetcher },
      ),
      { code: "github_untrusted_origin_token_refused" },
    );
    assert.equal(githubRequests.length, beforeExplicitRefuse);

    // 3. HezSec C1: alternate --github-api-url WITHOUT --dry-run is REFUSED from stamping!
    await assert.rejects(
      () => executeCheckCiCli(
        makeCliArgs(["check", "ci", CHECK_ID], {
          "github-api-url": ghUrl,
          "policy-file": policyFile,
        }),
        { target: csTarget, bearer: AGENT_TOKEN, workspaceId: WS, fetcher: csSessionProofFetcher },
      ),
      { code: "github_untrusted_origin_stamp_refused" },
    );
    assert.equal(stampedCommands.length, 0);

    // 4. HezSec C2: stamping without --policy-file is REFUSED (even on trusted origin with --suite)!
    await assert.rejects(
      () => executeCheckCiCli(
        makeCliArgs(["check", "ci", CHECK_ID], { suite: ["p1-cli"] }),
        { target: csTarget, bearer: AGENT_TOKEN, workspaceId: WS, fetcher: csSessionProofFetcher },
        { env: { GITHUB_TOKEN: GH_SECRET }, githubFetcher: trustedGhFetcher },
      ),
      { code: "github_policy_required" },
    );
    // 4b. HezSec C2: arbitrary --source or --suite overrides are REFUSED when stamping, and stay diagnostic on --dry-run!
    await assert.rejects(
      () => executeCheckCiCli(
        makeCliArgs(["check", "ci", CHECK_ID], { "policy-file": policyFile, source: "actions" }),
        { target: csTarget, bearer: AGENT_TOKEN, workspaceId: WS, fetcher: csSessionProofFetcher },
        { env: { GITHUB_TOKEN: GH_SECRET }, githubFetcher: trustedGhFetcher },
      ),
      { code: "github_policy_source_mismatch" },
    );
    await assert.rejects(
      () => executeCheckCiCli(
        makeCliArgs(["check", "ci", CHECK_ID], { "policy-file": policyFile, suite: ["p1-cli"] }),
        { target: csTarget, bearer: AGENT_TOKEN, workspaceId: WS, fetcher: csSessionProofFetcher },
        { env: { GITHUB_TOKEN: GH_SECRET }, githubFetcher: trustedGhFetcher },
      ),
      { code: "github_policy_suite_override_refused" },
    );
    const diagPartialOut = await executeCheckCiCli(
      makeCliArgs(["check", "ci", CHECK_ID], { source: "actions", suite: ["p1-cli"], "dry-run": true, json: true }),
      { target: csTarget, bearer: AGENT_TOKEN, workspaceId: WS, fetcher: csSessionProofFetcher },
      { env: { GITHUB_TOKEN: GH_SECRET }, githubFetcher: trustedGhFetcher },
    );
    const diagPartialJson = JSON.parse(diagPartialOut);
    assert.equal(diagPartialJson.stamped, false);
    assert.equal(diagPartialJson.action, "dry_run");
    assert.equal(diagPartialJson.evaluation.policy_enforced, false);
    assert.equal(diagPartialJson.evaluation.verdict, null);
    assert.equal(stampedCommands.length, 0);

    // 4c. HezSec C1: --agent-token-stdin together with --github-token-stdin is refused cleanly (400 invalid_request)!
    await assert.rejects(
      () => executeCheckCiCli(
        makeCliArgs(["check", "ci", CHECK_ID], { "agent-token-stdin": true, "github-token-stdin": true }),
        { target: csTarget, bearer: AGENT_TOKEN, workspaceId: WS, fetcher: csSessionProofFetcher },
      ),
      (err: unknown) => err instanceof GithubCiError && err.code === "invalid_request" && err.status === 400,
    );

    // 5. Stale --head-sha fails closed with stale_head (409) BEFORE touching GitHub!
    const beforeStale = githubRequests.length;
    await assert.rejects(
      () => syncGithubCiToReviewCheck({
        target: csTarget,
        bearer: AGENT_TOKEN,
        workspaceId: WS,
        repo: "yulanventures/commonswarm",
        ref: "713",
        expectedHeadSha: SHA_OLD,
        policy: TRUSTED_MIXED_POLICY,
        githubToken: GH_SECRET,
        fetcher: csSessionProofFetcher,
        githubFetcher: trustedGhFetcher,
      }),
      (err: unknown) => err instanceof ReviewCheckError && err.code === "stale_head" && err.status === 409,
    );
    assert.equal(githubRequests.length, beforeStale);

    // 6. HezSec C2: missing required CI ("unit" not yet present while "p1-cli" is green) -> pending, 0 stamps!
    ghMode = "pending";
    const pendingRes = await syncGithubCiToReviewCheck({
      target: csTarget,
      bearer: AGENT_TOKEN,
      workspaceId: WS,
      checkId: CHECK_ID,
      policy: TRUSTED_MIXED_POLICY,
      githubToken: GH_SECRET,
      fetcher: csSessionProofFetcher,
      githubFetcher: trustedGhFetcher,
    });
    assert.equal(pendingRes.stamped, false);
    assert.equal(pendingRes.action, "pending");
    assert.deepEqual(pendingRes.evaluation.missing_suites, ["unit"]);
    assert.equal(stampedCommands.length, 0);

    // 7. HezSec C2: same-name green results from UNTRUSTED publishers -> ignored, pending, 0 stamps!
    ghMode = "untrusted_only";
    const untrustedRes = await syncGithubCiToReviewCheck({
      target: csTarget,
      bearer: AGENT_TOKEN,
      workspaceId: WS,
      checkId: CHECK_ID,
      policy: TRUSTED_MIXED_POLICY,
      githubToken: GH_SECRET,
      fetcher: csSessionProofFetcher,
      githubFetcher: trustedGhFetcher,
    });
    assert.equal(untrustedRes.stamped, false);
    assert.equal(untrustedRes.action, "pending");
    assert.equal(untrustedRes.evaluation.ignored_untrusted_publisher, 2);
    assert.deepEqual(untrustedRes.evaluation.missing_suites, ["p1-cli", "unit"]);
    assert.equal(stampedCommands.length, 0);

    // 8. Trusted failing suite -> stamps "hold" via CLI helper!
    ghMode = "hold";
    const holdOut = await executeCheckCiCli(
      makeCliArgs(["check", "ci", "yulanventures/commonswarm#713"], {
        "policy-file": policyFile,
        json: true,
      }),
      { target: csTarget, bearer: AGENT_TOKEN, workspaceId: WS, fetcher: csSessionProofFetcher },
      { env: { GITHUB_TOKEN: GH_SECRET }, githubFetcher: trustedGhFetcher },
    );
    assert.equal(holdOut.includes(GH_SECRET), false, "GitHub token must never appear in CLI JSON output");
    const holdJson = JSON.parse(holdOut);
    assert.equal(holdJson.stamped, true);
    assert.equal(holdJson.action, "hold");
    assert.equal(stampedCommands.length, 1);
    assert.equal(stampedCommands[0]!.verdict, "hold");

    // 9. Complete trusted control on https://api.github.com -> stamps "pass"!
    ghMode = "pass";
    const beforeTrustedPass = githubRequests.length;
    const passOut = await executeCheckCiCli(
      makeCliArgs(["check", "ci", "yulanventures/commonswarm#713"], {
        "policy-file": policyFile,
        "github-token-file": tokenFile,
        json: true,
      }),
      { target: csTarget, bearer: AGENT_TOKEN, workspaceId: WS, fetcher: csSessionProofFetcher },
      { githubFetcher: trustedGhFetcher },
    );
    assert.equal(passOut.includes(GH_SECRET), false, "GitHub token must never leak in output");
    const passJson = JSON.parse(passOut);
    assert.equal(passJson.stamped, true);
    assert.equal(passJson.action, "pass");
    assert.equal(passJson.satisfied_now, true);
    assert.equal(passJson.evaluation.policy_enforced, true);
    assert.equal(passJson.evaluation.ignored_stale_head, 1);
    assert.equal(passJson.evaluation.ignored_superseded_attempts, 1);
    assert.equal(stampedCommands.length, 2);
    assert.equal(stampedCommands[1]!.verdict, "pass");
    assert.match(String(stampedCommands[1]!.note), /p1-cli \(attempt 2, success, run 9001\)/);
    assert.match(String(stampedCommands[1]!.note), /unit \(attempt 1, success, run 7001\)/);

    // HezSec C1 credential separation assertions across EVERY recorded request:
    const trustedReqs = githubRequests.slice(beforeTrustedPass);
    assert.ok(trustedReqs.length === 2, "policy with workflow_run+check_run queries actions+checks");
    assert.ok(trustedReqs.every((r) => r.auth === `Bearer ${GH_SECRET}`), "trusted origin receives GitHub token");
    assert.ok(githubRequests.every((r) => r.method === "GET"));
    assert.ok(githubRequests.every((r) => r.csProof === null), "NO GitHub request may ever carry CommonSwarm session-proof header");
    assert.ok(githubRequests.every((r) => r.sessionId === null && r.sessionGen === null && r.sessionKey === null), "NO GitHub request may ever carry real CommonSwarm session-proof headers");
    assert.ok(githubRequests.every((r) => r.auth !== `Bearer ${AGENT_TOKEN}`), "NO GitHub request may ever carry CommonSwarm bearer");
    assert.ok(csRequests.length >= 2);
    assert.ok(csRequests.every((r) => r.csProof === CS_PROOF_SECRET), "CommonSwarm requests still carry session-proof");
    assert.ok(
      csRequests.every(
        (r) =>
          r.sessionId === realSessionProof.session_id &&
          r.sessionGen === String(realSessionProof.generation) &&
          r.sessionKey === realSessionProof.key,
      ),
      "CommonSwarm requests carry real bindSessionProof headers",
    );
    assert.ok(csRequests.every((r) => r.auth !== `Bearer ${GH_SECRET}`), "NO CommonSwarm request may ever carry GitHub token");

    // 10. Real CLI binary `cswarm check ci --dry-run` against loopback fixture with ambient GITHUB_TOKEN:
    // succeeds credential-free (0 Authorization sent to loopback fixture) and never prints token.
    const beforeRealCli = githubRequests.length;
    const cliRes = await execFileAsync(
      process.execPath,
      [
        CLI, "check", "ci", "yulanventures/commonswarm#713",
        "--url", csTarget.url,
        "--anon-key", csTarget.anonKey,
        "--workspace-id", WS,
        "--agent-token-file", agentTokenFile,
        "--github-api-url", ghUrl,
        "--policy-file", policyFile,
        "--dry-run",
        "--json",
      ],
      { encoding: "utf8", env: { ...process.env, HOME: root, GITHUB_TOKEN: GH_SECRET } },
    );
    assert.equal(cliRes.stdout.includes(GH_SECRET), false, "CLI stdout must never leak GitHub token");
    assert.equal(cliRes.stderr.includes(GH_SECRET), false, "CLI stderr must never leak GitHub token");
    const cliJson = JSON.parse(cliRes.stdout);
    assert.equal(cliJson.stamped, false);
    assert.equal(cliJson.action, "dry_run");
    assert.equal(cliJson.evaluation.decision, "pass");
    const realCliGhReqs = githubRequests.slice(beforeRealCli);
    assert.ok(realCliGhReqs.length >= 1);
    assert.ok(realCliGhReqs.every((r) => r.auth === null), "real CLI MUST NOT send ambient GITHUB_TOKEN to alternate origin");

    // Real CLI binary refuses stamping from alternate --github-api-url (non-zero exit).
    await assert.rejects(
      () => execFileAsync(
        process.execPath,
        [
          CLI, "check", "ci", "yulanventures/commonswarm#713",
          "--url", csTarget.url,
          "--anon-key", csTarget.anonKey,
          "--workspace-id", WS,
          "--agent-token-file", agentTokenFile,
          "--github-api-url", ghUrl,
          "--policy-file", policyFile,
        ],
        { encoding: "utf8", env: { ...process.env, HOME: root, GITHUB_TOKEN: GH_SECRET } },
      ),
      (err: unknown) => {
        const stderr = (err as { stderr?: string }).stderr ?? "";
        assert.match(stderr, /https:\/\/api\.github\.com/);
        assert.equal(stderr.includes(GH_SECRET), false);
        return true;
      },
    );

    // Real CLI binary refuses --agent-token-stdin together with --github-token-stdin cleanly (invalid_request, not EOF).
    await assert.rejects(
      () => execFileAsync(
        process.execPath,
        [
          CLI, "check", "ci", "yulanventures/commonswarm#713",
          "--url", csTarget.url,
          "--anon-key", csTarget.anonKey,
          "--workspace-id", WS,
          "--agent-token-stdin",
          "--github-token-stdin",
          "--json",
        ],
        { encoding: "utf8" },
      ),
      (err: unknown) => {
        const stdout = (err as { stdout?: string }).stdout ?? "";
        const parsed = JSON.parse(stdout) as { ok?: boolean; error?: { code?: string; message?: string } };
        assert.equal(parsed.ok, false);
        assert.equal(parsed.error?.code, "invalid_request");
        assert.match(parsed.error?.message ?? "", /--agent-token-stdin.*--github-token-stdin/);
        return true;
      },
    );
  } finally {
    await new Promise<void>((r) => ghServer.close(() => r()));
    await new Promise<void>((r) => csServer.close(() => r()));
    await rm(root, { recursive: true, force: true });
  }
});

test("workflow_dispatch commit statuses witness: trusted publisher policy, exact context pinning, latest created_at, and focused-context isolation", async () => {
  const stampedCommands: Array<Record<string, unknown>> = [];
  let currentCheck = makeCheckRecord({ head_sha: SHA_NEW });

  const ghServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    assert.equal(req.method, "GET", "GitHub adapter must only issue GET");
    if (req.url?.includes(`/commits/${SHA_NEW}/statuses`)) {
      // Dispatch-shaped statuses matching .github/workflows/server-suite.yml lines 594-607:
      // - older failure on "server suite / p1-cli" superseded by newer success by created_at
      // - "server suite / server" passes from github-actions[bot]
      // - spoofed "server suite / unit" from untrusted creator must be ignored
      // - "server suite / mobile-audit (focused)" must NOT satisfy "server suite / mobile-audit"
      // - stale SHA_OLD status must be ignored as stale_head
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify([
        {
          id: 901,
          context: "server suite / p1-cli",
          state: "failure",
          description: "dispatch run 44857347609: failure",
          target_url: "https://github.com/yulanventures/commonswarm/actions/runs/44857347609",
          creator: { login: "github-actions[bot]", id: 41898282 },
          created_at: "2026-11-21T02:50:00Z",
          updated_at: "2026-11-21T02:50:00Z",
          url: `https://api.github.com/repos/yulanventures/commonswarm/statuses/${SHA_NEW}`,
        },
        {
          id: 902,
          context: "server suite / p1-cli",
          state: "success",
          description: "dispatch run 44858176467: success",
          target_url: "https://github.com/yulanventures/commonswarm/actions/runs/44858176467/attempts/2",
          creator: { login: "github-actions[bot]", id: 41898282 },
          created_at: "2026-11-21T03:01:30Z",
          updated_at: "2026-11-21T03:01:30Z",
          url: `https://api.github.com/repos/yulanventures/commonswarm/statuses/${SHA_NEW}`,
        },
        {
          id: 903,
          context: "server suite / server",
          state: "success",
          description: "dispatch run 44858179999: success",
          target_url: "https://github.com/yulanventures/commonswarm/actions/runs/44858179999",
          creator: { login: "github-actions[bot]", id: 41898282 },
          created_at: "2026-11-21T03:02:00Z",
          updated_at: "2026-11-21T03:02:00Z",
          url: `https://api.github.com/repos/yulanventures/commonswarm/statuses/${SHA_NEW}`,
        },
        {
          id: 904,
          context: "server suite / mobile-audit (focused)",
          state: "success",
          description: "dispatch run 44858180000: success, 1 screen(s)",
          target_url: "https://github.com/yulanventures/commonswarm/actions/runs/44858180000",
          creator: { login: "github-actions[bot]", id: 41898282 },
          created_at: "2026-11-21T03:02:10Z",
          updated_at: "2026-11-21T03:02:10Z",
          url: `https://api.github.com/repos/yulanventures/commonswarm/statuses/${SHA_NEW}`,
        },
        {
          id: 905,
          context: "server suite / unit",
          state: "success",
          description: "spoofed by random writer",
          target_url: "https://github.com/yulanventures/commonswarm/actions/runs/44850000000",
          creator: { login: "random-writer", id: 55555 },
          created_at: "2026-11-21T03:03:00Z",
          updated_at: "2026-11-21T03:03:00Z",
          url: `https://api.github.com/repos/yulanventures/commonswarm/statuses/${SHA_NEW}`,
        },
        {
          id: 906,
          context: "server suite / site",
          state: "success",
          description: "dispatch run 44850000001: success",
          target_url: "https://github.com/yulanventures/commonswarm/actions/runs/44850000001",
          creator: { login: "github-actions[bot]", id: 41898282 },
          created_at: "2026-11-21T03:03:10Z",
          updated_at: "2026-11-21T03:03:10Z",
          url: `https://api.github.com/repos/yulanventures/commonswarm/statuses/${SHA_OLD}`,
        },
      ]));
      return;
    }
    res.writeHead(404).end();
  });

  const csServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      if (req.url === "/functions/v1/read" && body.resource === "review_checks") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ review_check: currentCheck }));
        return;
      }
      if (req.url === "/functions/v1/command" && body.command?.kind === "review_check_stamp") {
        stampedCommands.push(body.command);
        currentCheck = makeCheckRecord({ status: "satisfied", satisfied: true });
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          review_check: currentCheck,
          satisfied_now: true,
          satisfied_signal_id: "99999999-9999-4999-8999-999999999999",
        }));
        return;
      }
      res.writeHead(404).end();
    });
  });

  await new Promise<void>((r) => ghServer.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => csServer.listen(0, "127.0.0.1", r));
  const ghUrl = `http://127.0.0.1:${(ghServer.address() as { port: number }).port}`;
  const csTarget = { url: `http://127.0.0.1:${(csServer.address() as { port: number }).port}`, anonKey: "fixture-anon", profileId: "fixture" };
  const trustedGhFetcher = makeTrustedGithubProxyFetcher(ghUrl);

  try {
    // 1. Focused "server suite / mobile-audit (focused)" must NOT satisfy exact context "server suite / mobile-audit"!
    const focusedNotFull = await syncGithubCiToReviewCheck({
      target: csTarget,
      bearer: AGENT_TOKEN,
      workspaceId: WS,
      checkId: CHECK_ID,
      policy: {
        version: 1,
        repo: "yulanventures/commonswarm",
        required: [
          { kind: "commit_status", context: "server suite / p1-cli", creator_login: "github-actions[bot]" },
          { kind: "commit_status", context: "server suite / mobile-audit", creator_login: "github-actions[bot]" },
        ],
      },
      githubToken: GH_SECRET,
      githubFetcher: trustedGhFetcher,
    });
    assert.equal(focusedNotFull.stamped, false);
    assert.equal(focusedNotFull.action, "pending");
    assert.deepEqual(focusedNotFull.evaluation.missing_suites, ["server suite / mobile-audit"]);
    assert.equal(stampedCommands.length, 0);

    // 2. Spoofed "server suite / unit" from random-writer + stale SHA_OLD "server suite / site" both rejected -> pending!
    const spoofAndStale = await syncGithubCiToReviewCheck({
      target: csTarget,
      bearer: AGENT_TOKEN,
      workspaceId: WS,
      checkId: CHECK_ID,
      policy: {
        version: 1,
        repo: "yulanventures/commonswarm",
        required: [
          { kind: "commit_status", context: "server suite / unit", creator_login: "github-actions[bot]" },
          { kind: "commit_status", context: "server suite / site", creator_login: "github-actions[bot]" },
        ],
      },
      githubToken: GH_SECRET,
      githubFetcher: trustedGhFetcher,
    });
    assert.equal(spoofAndStale.stamped, false);
    assert.equal(spoofAndStale.action, "pending");
    assert.equal(spoofAndStale.evaluation.ignored_untrusted_publisher, 1);
    assert.equal(spoofAndStale.evaluation.ignored_stale_head, 1);
    assert.deepEqual(spoofAndStale.evaluation.missing_suites, ["server suite / unit", "server suite / site"]);
    assert.equal(stampedCommands.length, 0);

    // 3. Trusted dispatch statuses ("server suite / p1-cli" latest created_at success + "server suite / server" success)
    // with exact context + creator_login + target_url_prefix stamp pass!
    const passed = await syncGithubCiToReviewCheck({
      target: csTarget,
      bearer: AGENT_TOKEN,
      workspaceId: WS,
      checkId: CHECK_ID,
      policy: {
        version: 1,
        repo: "yulanventures/commonswarm",
        required: [
          {
            kind: "commit_status",
            context: "server suite / p1-cli",
            creator_login: "github-actions[bot]",
            target_url_prefix: "https://github.com/yulanventures/commonswarm/actions/runs/",
          },
          {
            kind: "commit_status",
            context: "server suite / server",
            creator_login: "github-actions[bot]",
            target_url_prefix: "https://github.com/yulanventures/commonswarm/actions/runs/",
          },
        ],
      },
      githubToken: GH_SECRET,
      githubFetcher: trustedGhFetcher,
    });
    assert.equal(passed.stamped, true);
    assert.equal(passed.action, "pass");
    assert.equal(passed.evaluation.ignored_stale_head, 1);
    assert.equal(passed.evaluation.ignored_superseded_runs, 1);
    assert.equal(stampedCommands.length, 1);
    assert.equal(stampedCommands[0]!.verdict, "pass");
    assert.equal(stampedCommands[0]!.head_sha, SHA_NEW);
    assert.match(String(stampedCommands[0]!.note), /server suite \/ p1-cli \(attempt 2, success, run 44858176467\)/);
    assert.match(String(stampedCommands[0]!.note), /server suite \/ server \(attempt 1, success, run 44858179999\)/);
  } finally {
    await new Promise<void>((r) => ghServer.close(() => r()));
    await new Promise<void>((r) => csServer.close(() => r()));
  }
});
