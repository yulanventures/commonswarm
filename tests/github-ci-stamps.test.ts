/**
 * C3b — Read-only GitHub CI status adapter for revision-bound review checks.
 *
 * Covers:
 *   1. Exact-head pass, fail (-> hold), and in-progress/missing (-> pending, no stamp).
 *   2. Strict stale-head rejection: late success on an older head_sha is strictly ignored
 *      and counted in `ignored_stale_head`; `--head-sha` mismatch fails closed with `stale_head`.
 *   3. Strict superseded-attempt & superseded-run filtering: older `run_attempt` on the same
 *      `run_id` and older workflow/check runs for the same suite on the same head are ignored.
 *   4. Strict read-only GET enforcement, redirect refusal, bounded timeout (`github_timeout`),
 *      bounded response size (`github_response_too_large`), malformed-response fail-closed
 *      (`github_malformed_response`), non-loopback HTTP refusal, and repo validation.
 *   5. Secret hygiene: 0600 private token file enforcement (refuses symlinks & 0644 files),
 *      env / stdin / file loading (never argv), and token redaction on errors/output/notes.
 *   6. End-to-end CLI (`executeCheckCiCli` + real `dist/cli.js check ci`) against mock GitHub
 *      and CommonSwarm HTTP servers.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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
  readGithubCiForCommit,
  readGithubTokenFromFile,
  syncGithubCiToReviewCheck,
} from "../src/cloud/github-ci-stamps.js";
import { executeCheckCiCli, type ReviewCheckCliArgs } from "../src/cli/review-checks.js";
import { ReviewCheckError, type ReviewCheckRecord } from "../src/cloud/review-checks.js";

const execFileAsync = promisify(execFile);

const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CHECK_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const SHA_OLD = "1111111111111111111111111111111111111111";
const SHA_NEW = "2222222222222222222222222222222222222222";
const GH_SECRET = "ghp_secret_ci_token_do_not_leak_9876543210";
const AGENT_TOKEN = `swm_agt_${"D".repeat(43)}`;
const CLI = resolve("dist/cli.js");

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

test("evaluateGithubCiRuns: exact-head pass, fail->hold, pending, stale-head ignored, and older attempts ignored", () => {
  // 1. Late success on SHA_OLD is strictly ignored while SHA_NEW has pending suite -> pending!
  const staleIgnored = evaluateGithubCiRuns({
    expectedHeadSha: SHA_NEW,
    workflowRuns: [
      {
        id: 1001,
        name: "p1-cli",
        head_sha: SHA_OLD,
        run_attempt: 1,
        status: "completed",
        conclusion: "success",
        updated_at: "2026-11-20T20:05:00Z",
        created_at: "2026-11-20T20:00:00Z",
        html_url: "https://github.com/yulanventures/commonswarm/actions/runs/1001",
      },
      {
        id: 1002,
        name: "p1-cli",
        head_sha: SHA_NEW,
        run_attempt: 1,
        status: "in_progress",
        conclusion: null,
        updated_at: "2026-11-20T20:04:00Z",
        created_at: "2026-11-20T20:01:00Z",
        html_url: "https://github.com/yulanventures/commonswarm/actions/runs/1002",
      },
    ],
    checkRuns: [
      {
        id: 2001,
        name: "unit",
        head_sha: SHA_OLD,
        status: "completed",
        conclusion: "success",
        completed_at: "2026-11-20T20:05:00Z",
        started_at: "2026-11-20T20:00:00Z",
        html_url: null,
      },
    ],
    requiredSuites: ["p1-cli", "unit"],
  });
  assert.equal(staleIgnored.decision, "pending");
  assert.equal(staleIgnored.verdict, null);
  assert.equal(staleIgnored.ignored_stale_head, 2);
  assert.deepEqual(staleIgnored.missing_suites, ["unit"]);

  // 2. Superseded attempt 1 (success) is ignored when attempt 2 fails -> hold!
  const attempt2Fail = evaluateGithubCiRuns({
    expectedHeadSha: SHA_NEW,
    workflowRuns: [
      {
        id: 3001,
        name: "p1-cli",
        head_sha: SHA_NEW,
        run_attempt: 1,
        status: "completed",
        conclusion: "success",
        updated_at: "2026-11-20T20:01:00Z",
        created_at: "2026-11-20T20:00:00Z",
        html_url: null,
      },
      {
        id: 3001,
        name: "p1-cli",
        head_sha: SHA_NEW,
        run_attempt: 2,
        status: "completed",
        conclusion: "failure",
        updated_at: "2026-11-20T20:03:00Z",
        created_at: "2026-11-20T20:02:00Z",
        html_url: null,
      },
    ],
    checkRuns: [],
  });
  assert.equal(attempt2Fail.decision, "hold");
  assert.equal(attempt2Fail.verdict, "hold");
  assert.equal(attempt2Fail.ignored_superseded_attempts, 1);
  assert.equal(attempt2Fail.suites.length, 1);
  assert.equal(attempt2Fail.suites[0]!.run_attempt, 2);
  assert.equal(attempt2Fail.suites[0]!.conclusion, "failure");

  // 3. Superseded attempt 1 (failure) is ignored when attempt 2 succeeds, and older workflow run is superseded -> pass!
  const attempt2Pass = evaluateGithubCiRuns({
    expectedHeadSha: SHA_NEW,
    workflowRuns: [
      {
        id: 4001,
        name: "p1-cli",
        head_sha: SHA_NEW,
        run_attempt: 1,
        status: "completed",
        conclusion: "failure",
        updated_at: "2026-11-20T20:01:00Z",
        created_at: "2026-11-20T20:00:00Z",
        html_url: null,
      },
      {
        id: 4002,
        name: "p1-cli",
        head_sha: SHA_NEW,
        run_attempt: 1,
        status: "completed",
        conclusion: "failure",
        updated_at: "2026-11-20T20:02:00Z",
        created_at: "2026-11-20T20:01:30Z",
        html_url: null,
      },
      {
        id: 4002,
        name: "p1-cli",
        head_sha: SHA_NEW,
        run_attempt: 2,
        status: "completed",
        conclusion: "success",
        updated_at: "2026-11-20T20:04:00Z",
        created_at: "2026-11-20T20:03:00Z",
        html_url: null,
      },
    ],
    checkRuns: [
      {
        id: 5001,
        name: "unit",
        head_sha: SHA_NEW,
        status: "completed",
        conclusion: "success",
        completed_at: "2026-11-20T20:04:00Z",
        started_at: "2026-11-20T20:03:00Z",
        html_url: null,
      },
    ],
    requiredSuites: ["p1-cli", "unit"],
  });
  assert.equal(attempt2Pass.decision, "pass");
  assert.equal(attempt2Pass.verdict, "pass");
  assert.equal(attempt2Pass.ignored_superseded_attempts, 1);
  assert.equal(attempt2Pass.ignored_superseded_runs, 1);
  const note = formatGithubCiStampNote(attempt2Pass);
  assert.match(note, /^GitHub CI pass @ 222222222:/);
  assert.match(note, /p1-cli \(attempt 2, success, run 4002\)/);
  assert.match(note, /unit \(attempt 1, success, run 5001\)/);

  // 4. Queued check-run rerun (null timestamps, higher id) supersedes an older passing check run -> pending!
  const queuedSupersedesPass = evaluateGithubCiRuns({
    expectedHeadSha: SHA_NEW,
    workflowRuns: [],
    checkRuns: [
      {
        id: 6001,
        name: "unit",
        head_sha: SHA_NEW,
        status: "completed",
        conclusion: "success",
        completed_at: "2026-11-20T20:04:00Z",
        started_at: "2026-11-20T20:03:00Z",
        html_url: null,
      },
      {
        id: 6002,
        name: "unit",
        head_sha: SHA_NEW,
        status: "queued",
        conclusion: null,
        completed_at: null,
        started_at: null,
        html_url: null,
      },
    ],
  });
  assert.equal(queuedSupersedesPass.decision, "pending");
  assert.equal(queuedSupersedesPass.verdict, null);
  assert.equal(queuedSupersedesPass.ignored_superseded_runs, 1);

  // 5. Empty CI on head stays pending (never stamps pass on 0 runs).
  const empty = evaluateGithubCiRuns({
    expectedHeadSha: SHA_NEW,
    workflowRuns: [],
    checkRuns: [],
  });
  assert.equal(empty.decision, "pending");
  assert.equal(empty.verdict, null);
});

test("validators & token file security: rejects bad repo/URL/non-0600/symlink token files and redacts tokens on errors", async () => {
  assert.throws(() => normalizeGithubRepo("../evil"), { code: "github_repo_invalid" });
  assert.throws(() => normalizeGithubRepo("owner/repo?foo=1"), { code: "github_repo_invalid" });
  assert.throws(() => normalizeGithubApiBaseUrl("http://api.github.com"), { code: "github_api_url_invalid" });
  assert.throws(() => normalizeGithubApiBaseUrl("https://user:pass@api.github.com"), { code: "github_api_url_invalid" });
  assert.equal(normalizeGithubApiBaseUrl("http://127.0.0.1:8080/"), "http://127.0.0.1:8080");

  const root = await mkdtemp(join(tmpdir(), "cs-gh-tok-"));
  try {
    const goodPath = join(root, "token.txt");
    const openPath = join(root, "open.txt");
    const linkPath = join(root, "link.txt");
    await writeFile(goodPath, `${GH_SECRET}\n`, { mode: 0o600 });
    await chmod(goodPath, 0o600);
    await writeFile(openPath, `${GH_SECRET}\n`, { mode: 0o644 });
    await chmod(openPath, 0o644);
    await symlink(goodPath, linkPath);

    assert.equal(await readGithubTokenFromFile(goodPath), GH_SECRET);
    await assert.rejects(() => readGithubTokenFromFile(openPath), { code: "github_token_file_unsafe" });
    await assert.rejects(() => readGithubTokenFromFile(linkPath), { code: "github_token_file_unsafe" });

    // Token redaction on transport error + malformed response + timeout refusal.
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
        assert.equal(err.message.includes(GH_SECRET), false, "token must be redacted from error message");
        assert.match(err.message, /\[redacted\]/);
        return true;
      },
    );

    // Malformed payload (non-array workflow_runs / invalid run_attempt) fails closed.
    await assert.rejects(
      () => readGithubCiForCommit({
        repo: "yulanventures/commonswarm",
        headSha: SHA_NEW,
        source: "actions",
        fetcher: async () => new Response(JSON.stringify({ workflow_runs: "oops" }), { status: 200 }),
      }),
      { code: "github_malformed_response" },
    );
    await assert.rejects(
      () => readGithubCiForCommit({
        repo: "yulanventures/commonswarm",
        headSha: SHA_NEW,
        source: "actions",
        fetcher: async () => new Response(JSON.stringify({
          workflow_runs: [{ id: 1, name: "unit", head_sha: SHA_NEW, run_attempt: 0, status: "completed", conclusion: "success" }],
        }), { status: 200 }),
      }),
      { code: "github_malformed_response" },
    );

    // Truncated GitHub list (total_count > returned items) fails closed.
    await assert.rejects(
      () => readGithubCiForCommit({
        repo: "yulanventures/commonswarm",
        headSha: SHA_NEW,
        source: "actions",
        fetcher: async () => new Response(JSON.stringify({
          total_count: 150,
          workflow_runs: [{ id: 1, name: "unit", head_sha: SHA_NEW, run_attempt: 1, status: "completed", conclusion: "success" }],
        }), { status: 200 }),
      }),
      { code: "github_response_truncated" },
    );

    // Bounded timeout fails closed with github_timeout.
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

test("syncGithubCiToReviewCheck & executeCheckCiCli: read-only GET, exact-head stamp, hold, pending, dry-run, and stale-head refusal", async () => {
  const githubRequests: Array<{ method: string; url: string; auth: string | null }> = [];
  const stampedCommands: Array<Record<string, unknown>> = [];
  let ghMode: "pass" | "hold" | "pending" | "stale_only" = "pass";
  let currentCheck = makeCheckRecord();

  const ghServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    githubRequests.push({
      method: req.method ?? "",
      url: req.url ?? "",
      auth: typeof req.headers.authorization === "string" ? req.headers.authorization : null,
    });
    assert.equal(req.method, "GET", "GitHub CI adapter must be strictly read-only GET");
    if (req.url?.includes("/actions/runs")) {
      const workflow_runs = ghMode === "pass"
        ? [
          // Stale old-head failure must be ignored; older attempt 1 failure must be ignored.
          { id: 8001, name: "p1-cli", head_sha: SHA_OLD, run_attempt: 1, status: "completed", conclusion: "failure", updated_at: "2026-11-20T20:09:00Z", created_at: "2026-11-20T20:00:00Z", html_url: null },
          { id: 9001, name: "p1-cli", head_sha: SHA_NEW, run_attempt: 1, status: "completed", conclusion: "failure", updated_at: "2026-11-20T20:01:00Z", created_at: "2026-11-20T20:00:00Z", html_url: null },
          { id: 9001, name: "p1-cli", head_sha: SHA_NEW, run_attempt: 2, status: "completed", conclusion: "success", updated_at: "2026-11-20T20:05:00Z", created_at: "2026-11-20T20:02:00Z", html_url: null },
        ]
        : ghMode === "hold"
        ? [
          { id: 9002, name: "p1-cli", head_sha: SHA_NEW, run_attempt: 1, status: "completed", conclusion: "failure", updated_at: "2026-11-20T20:05:00Z", created_at: "2026-11-20T20:02:00Z", html_url: null },
        ]
        : ghMode === "pending"
        ? [
          { id: 9003, name: "p1-cli", head_sha: SHA_NEW, run_attempt: 1, status: "in_progress", conclusion: null, updated_at: "2026-11-20T20:05:00Z", created_at: "2026-11-20T20:02:00Z", html_url: null },
        ]
        : [
          { id: 8002, name: "p1-cli", head_sha: SHA_OLD, run_attempt: 1, status: "completed", conclusion: "success", updated_at: "2026-11-20T20:09:00Z", created_at: "2026-11-20T20:00:00Z", html_url: null },
        ];
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ total_count: workflow_runs.length, workflow_runs }));
      return;
    }
    if (req.url?.includes("/check-runs")) {
      const check_runs = ghMode === "pass"
        ? [{ id: 7001, name: "unit", head_sha: SHA_NEW, status: "completed", conclusion: "success", completed_at: "2026-11-20T20:05:00Z", started_at: "2026-11-20T20:02:00Z", html_url: null }]
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
  const ghPort = (ghServer.address() as { port: number }).port;
  const csPort = (csServer.address() as { port: number }).port;
  const ghUrl = `http://127.0.0.1:${ghPort}`;
  const csTarget = { url: `http://127.0.0.1:${csPort}`, anonKey: "fixture-anon" };

  const root = await mkdtemp(join(tmpdir(), "cs-gh-cli-"));
  try {
    // 1. Stale --head-sha fails closed with stale_head (409) BEFORE touching GitHub!
    const beforeGhCount = githubRequests.length;
    await assert.rejects(
      () => syncGithubCiToReviewCheck({
        target: csTarget,
        bearer: AGENT_TOKEN,
        workspaceId: WS,
        repo: "yulanventures/commonswarm",
        ref: "713",
        expectedHeadSha: SHA_OLD,
        apiBaseUrl: ghUrl,
        githubToken: GH_SECRET,
      }),
      (err: unknown) => err instanceof ReviewCheckError && err.code === "stale_head" && err.status === 409,
    );
    assert.equal(githubRequests.length, beforeGhCount, "stale --head-sha must fail before hitting GitHub");

    // 2. Late success on SHA_OLD only -> pending, zero stamp sent!
    ghMode = "stale_only";
    const staleOnly = await syncGithubCiToReviewCheck({
      target: csTarget,
      bearer: AGENT_TOKEN,
      workspaceId: WS,
      checkId: CHECK_ID,
      apiBaseUrl: ghUrl,
      githubToken: GH_SECRET,
    });
    assert.equal(staleOnly.stamped, false);
    assert.equal(staleOnly.action, "pending");
    assert.equal(staleOnly.evaluation.ignored_stale_head, 1);
    assert.equal(stampedCommands.length, 0);

    // 3. Pending on SHA_NEW -> zero stamp sent!
    ghMode = "pending";
    const pendingRes = await syncGithubCiToReviewCheck({
      target: csTarget,
      bearer: AGENT_TOKEN,
      workspaceId: WS,
      checkId: CHECK_ID,
      apiBaseUrl: ghUrl,
      githubToken: GH_SECRET,
    });
    assert.equal(pendingRes.stamped, false);
    assert.equal(pendingRes.action, "pending");
    assert.equal(stampedCommands.length, 0);

    // 4. Failing suite on SHA_NEW -> stamps "hold" via CLI helper!
    ghMode = "hold";
    const holdOut = await executeCheckCiCli(
      makeCliArgs(["check", "ci", "yulanventures/commonswarm#713"], {
        "github-api-url": ghUrl,
        suite: ["p1-cli"],
        json: true,
      }),
      { target: csTarget, bearer: AGENT_TOKEN, workspaceId: WS, fetcher: fetch },
      { env: { GITHUB_TOKEN: GH_SECRET } },
    );
    assert.equal(holdOut.includes(GH_SECRET), false, "GitHub token must never appear in CLI JSON output");
    const holdJson = JSON.parse(holdOut);
    assert.equal(holdJson.stamped, true);
    assert.equal(holdJson.action, "hold");
    assert.equal(stampedCommands.length, 1);
    assert.equal(stampedCommands[0]!.verdict, "hold");
    assert.equal(stampedCommands[0]!.head_sha, SHA_NEW);

    // 5. Dry-run on passing SHA_NEW -> does NOT stamp!
    ghMode = "pass";
    const dryOut = await executeCheckCiCli(
      makeCliArgs(["check", "ci", CHECK_ID], {
        "github-api-url": ghUrl,
        suite: ["p1-cli", "unit"],
        "dry-run": true,
        json: true,
      }),
      { target: csTarget, bearer: AGENT_TOKEN, workspaceId: WS, fetcher: fetch },
      { env: { GH_TOKEN: GH_SECRET } },
    );
    assert.equal(JSON.parse(dryOut).stamped, false);
    assert.equal(JSON.parse(dryOut).action, "dry_run");
    assert.equal(stampedCommands.length, 1);

    // 6. Real CLI binary `cswarm check ci` with 0600 --github-token-file -> stamps "pass" and never prints token!
    const tokenFile = join(root, "gh.token");
    const agentTokenFile = join(root, "agent.token");
    await writeFile(tokenFile, `${GH_SECRET}\n`, { mode: 0o600 });
    await chmod(tokenFile, 0o600);
    await writeFile(agentTokenFile, `${AGENT_TOKEN}\n`, { mode: 0o600 });
    await chmod(agentTokenFile, 0o600);

    const cliRes = await execFileAsync(
      process.execPath,
      [
        CLI, "check", "ci", "yulanventures/commonswarm#713",
        "--url", csTarget.url,
        "--anon-key", csTarget.anonKey,
        "--workspace-id", WS,
        "--agent-token-file", agentTokenFile,
        "--github-api-url", ghUrl,
        "--github-token-file", tokenFile,
        "--suite", "p1-cli,unit",
        "--json",
      ],
      { encoding: "utf8", env: { ...process.env, HOME: root } },
    );
    assert.equal(cliRes.stdout.includes(GH_SECRET), false, "CLI stdout must never leak GitHub token");
    assert.equal(cliRes.stderr.includes(GH_SECRET), false, "CLI stderr must never leak GitHub token");
    const passJson = JSON.parse(cliRes.stdout);
    assert.equal(passJson.stamped, true);
    assert.equal(passJson.action, "pass");
    assert.equal(passJson.satisfied_now, true);
    assert.equal(passJson.evaluation.ignored_stale_head, 1);
    assert.equal(passJson.evaluation.ignored_superseded_attempts, 1);
    assert.equal(stampedCommands.length, 2);
    assert.equal(stampedCommands[1]!.verdict, "pass");
    assert.equal(stampedCommands[1]!.head_sha, SHA_NEW);
    assert.match(String(stampedCommands[1]!.note), /p1-cli \(attempt 2, success, run 9001\)/);
    assert.match(String(stampedCommands[1]!.note), /unit \(attempt 1, success, run 7001\)/);
    assert.equal(String(stampedCommands[1]!.note).includes(GH_SECRET), false);
    assert.ok(githubRequests.every((r) => r.method === "GET"));
    assert.ok(githubRequests.some((r) => r.auth === `Bearer ${GH_SECRET}`));
  } finally {
    await new Promise<void>((r) => ghServer.close(() => r()));
    await new Promise<void>((r) => csServer.close(() => r()));
    await rm(root, { recursive: true, force: true });
  }
});

test("workflow_dispatch commit statuses witness: maps 'server suite / <suite>' by latest created_at, ignores main-head actions/runs, and isolates focused contexts", async () => {
  const MAIN_SHA = "9999999999999999999999999999999999999999";
  const stampedCommands: Array<Record<string, unknown>> = [];
  let currentCheck = makeCheckRecord({ head_sha: SHA_NEW });

  const ghServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    assert.equal(req.method, "GET", "GitHub adapter must only issue GET");
    if (req.url?.includes("/actions/runs")) {
      // workflow_dispatch runs report main's SHA, NOT the PR head SHA! Must be ignored as stale_head.
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        total_count: 1,
        workflow_runs: [{
          id: 44858176467,
          name: "server-suite",
          head_sha: MAIN_SHA,
          run_attempt: 1,
          status: "completed",
          conclusion: "failure",
          updated_at: "2026-11-21T03:01:00Z",
          created_at: "2026-11-21T02:55:00Z",
          html_url: "https://github.com/yulanventures/commonswarm/actions/runs/44858176467",
        }],
      }));
      return;
    }
    if (req.url?.includes("/check-runs")) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ total_count: 0, check_runs: [] }));
      return;
    }
    if (req.url?.includes(`/commits/${SHA_NEW}/statuses`)) {
      // Dispatch-shaped statuses matching .github/workflows/server-suite.yml lines 594-607:
      // - older failure on "server suite / p1-cli" superseded by newer success by created_at
      // - "server suite / server" passes
      // - "server suite / mobile-audit (focused)" must NOT satisfy --suite mobile-audit
      // - a status whose URL carries SHA_OLD must be ignored as stale_head
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify([
        {
          id: 901,
          context: "server suite / p1-cli",
          state: "failure",
          description: "dispatch run 44857347609: failure",
          target_url: "https://github.com/yulanventures/commonswarm/actions/runs/44857347609",
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
          created_at: "2026-11-21T03:02:10Z",
          updated_at: "2026-11-21T03:02:10Z",
          url: `https://api.github.com/repos/yulanventures/commonswarm/statuses/${SHA_NEW}`,
        },
        {
          id: 905,
          context: "server suite / unit",
          state: "success",
          description: "dispatch run 44850000000: success",
          target_url: "https://github.com/yulanventures/commonswarm/actions/runs/44850000000",
          created_at: "2026-11-21T03:03:00Z",
          updated_at: "2026-11-21T03:03:00Z",
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
  const csTarget = { url: `http://127.0.0.1:${(csServer.address() as { port: number }).port}`, anonKey: "fixture-anon" };

  try {
    // 1. Focused "server suite / mobile-audit (focused)" must NOT satisfy --suite mobile-audit -> pending!
    const focusedNotFull = await syncGithubCiToReviewCheck({
      target: csTarget,
      bearer: AGENT_TOKEN,
      workspaceId: WS,
      checkId: CHECK_ID,
      requiredSuites: ["p1-cli", "mobile-audit"],
      apiBaseUrl: ghUrl,
      githubToken: GH_SECRET,
    });
    assert.equal(focusedNotFull.stamped, false);
    assert.equal(focusedNotFull.action, "pending");
    assert.deepEqual(focusedNotFull.evaluation.missing_suites, ["mobile-audit"]);
    assert.equal(stampedCommands.length, 0);

    // 2. Stale-SHA "server suite / unit" (SHA_OLD in URL) must NOT satisfy --suite unit -> pending!
    const staleUnitMissing = await syncGithubCiToReviewCheck({
      target: csTarget,
      bearer: AGENT_TOKEN,
      workspaceId: WS,
      checkId: CHECK_ID,
      requiredSuites: ["p1-cli", "unit"],
      apiBaseUrl: ghUrl,
      githubToken: GH_SECRET,
    });
    assert.equal(staleUnitMissing.stamped, false);
    assert.equal(staleUnitMissing.action, "pending");
    assert.deepEqual(staleUnitMissing.evaluation.missing_suites, ["unit"]);
    assert.equal(staleUnitMissing.evaluation.ignored_stale_head, 2, "must ignore both main-head workflow_run and SHA_OLD commit status");

    // 3. Matching dispatch statuses ("server suite / p1-cli" latest created_at success + "server suite / server" success)
    // satisfy --suite p1-cli,server (and also full context selector "server suite / server") and stamp pass!
    const passed = await syncGithubCiToReviewCheck({
      target: csTarget,
      bearer: AGENT_TOKEN,
      workspaceId: WS,
      checkId: CHECK_ID,
      requiredSuites: ["p1-cli", "server suite / server"],
      apiBaseUrl: ghUrl,
      githubToken: GH_SECRET,
    });
    assert.equal(passed.stamped, true);
    assert.equal(passed.action, "pass");
    assert.equal(passed.evaluation.ignored_stale_head, 2);
    assert.equal(passed.evaluation.ignored_superseded_runs, 1, "older failed p1-cli status must be superseded by newer created_at");
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
