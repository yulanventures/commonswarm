import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  AGENT_CHECK_OUTPUT_ALLOWANCE_MS,
  AGENT_CHECK_STARTUP_ALLOWANCE_MS,
  AGENT_CHECK_TIMEOUT_MS,
  AGENT_CHECK_WRITE_BACK_MARGIN_MS,
  HOST_HOOK_TIMEOUT_SECONDS,
  hostHookCheckDeadlineAt,
} from "../../src/cloud/agent-check-budget.js";
import { AGENT_CREDENTIAL_MESSAGE_D088 } from "../../src/cloud/agent-credential-input.js";
import { checkAgentMessages } from "../../src/cloud/agent-check.js";
import { profileScopeKey } from "../../src/cloud/agent-profile.js";
import { mergeReceiveHooks, receiveBindingPath } from "../../src/cloud/agent-receive.js";
import type { SignalRecord } from "../../src/cloud/command-client.js";
import { usage } from "../../src/cli.js";
import { HOOK_CHECK_TIMEOUT_MS } from "../../src/listener/hook.js";

const WORKSPACE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PRINCIPAL_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWNER_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TOKEN = `swm_agt_${"A".repeat(43)}`;
/** Independent host contract: Claude Code documents hook timeout in whole seconds. */
const DOCUMENTED_HOST_HOOK_TIMEOUT_SECONDS = 5;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cliPath = join(repoRoot, "src", "cli.ts");
const tsxImport = import.meta.resolve("tsx");
let root: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "cswarm-check-budget-test-"));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

function signal(index: number): SignalRecord {
  return {
    id: `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`,
    workspace_id: WORKSPACE_ID,
    from: OWNER_ID,
    from_kind: "user",
    to: null,
    to_agent: PRINCIPAL_ID,
    in_reply_to: null,
    about: null,
    kind: "ask",
    body: `message ${index}`,
    until: "2099-01-01T00:00:00.000Z",
    created_at: `2026-09-16T00:00:0${index}.000Z`,
    sender_owner_relation: "same_owner",
  };
}

async function profile(): Promise<string> {
  const directory = await mkdtemp(join(root, "profile-"));
  const credentialFile = join(directory, "credential.json");
  const profilePath = join(directory, "profile.json");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(credentialFile, JSON.stringify({
    message: AGENT_CREDENTIAL_MESSAGE_D088,
    status: "accepted",
    principal_id: PRINCIPAL_ID,
    token_id: "11111111-1111-4111-8111-111111111111",
    run_id: "22222222-2222-4222-8222-222222222222",
    agent_token: TOKEN,
    expires_at: "2099-01-01T00:00:00.000Z",
  }), { mode: 0o600 });
  await writeFile(profilePath, JSON.stringify({
    version: 1,
    url: "http://127.0.0.1:9",
    anon_key: "public-test",
    workspace_id: WORKSPACE_ID,
    principal_id: PRINCIPAL_ID,
    credential_file: credentialFile,
  }), { mode: 0o600 });
  return profilePath;
}

function fetcher(rows: SignalRecord[], waitMs: number): typeof fetch {
  return (async (_input: unknown, init?: RequestInit) => {
    await delay(waitMs, undefined, { signal: init?.signal ?? undefined });
    const body = JSON.parse(String(init?.body));
    if (body.resource === "members") return new Response(JSON.stringify({
      members: [{ user_id: OWNER_ID, display_name: "Owner" }],
      agents: [{ principal_id: PRINCIPAL_ID, name: "Agent", owner_user_id: OWNER_ID }],
      identity: {
        credential_valid: true,
        principal_id: PRINCIPAL_ID,
        workspace_id: WORKSPACE_ID,
        owner_user_id: OWNER_ID,
      },
    }), { status: 200 });
    if (body.resource === "signals") return new Response(JSON.stringify({
      signals: rows.filter(row => !body.after_id || row.id > body.after_id),
      capabilities: { sender_owner_relation: 1, cursor_after: 1 },
    }), { status: 200 });
    throw new Error(`unexpected resource: ${body.resource}`);
  }) as typeof fetch;
}

test("check budget plus measured allowances equals the host-hook ceiling", () => {
  assert.equal(HOST_HOOK_TIMEOUT_SECONDS, DOCUMENTED_HOST_HOOK_TIMEOUT_SECONDS);
  assert.equal(
    AGENT_CHECK_TIMEOUT_MS + AGENT_CHECK_STARTUP_ALLOWANCE_MS + AGENT_CHECK_OUTPUT_ALLOWANCE_MS,
    DOCUMENTED_HOST_HOOK_TIMEOUT_SECONDS * 1_000,
  );
});

test("receive hook settings use the exported host-hook ceiling", () => {
  const settings = mergeReceiveHooks({}, "cswarm check", null, false);
  const hooks = settings.hooks as Record<string, unknown>;
  const groups = hooks.UserPromptSubmit as Array<{ hooks: Array<{ timeout: number }> }>;
  assert.equal(groups[0]?.hooks[0]?.timeout, DOCUMENTED_HOST_HOOK_TIMEOUT_SECONDS);
});

test("a hook check deadline counts from process start and ends before the process deadline", () => {
  // Process started 1,200 ms before "now": the check must end at start + ceiling - output - write-back margin.
  assert.equal(
    hostHookCheckDeadlineAt(10_000, 1_200),
    10_000 - 1_200 + DOCUMENTED_HOST_HOOK_TIMEOUT_SECONDS * 1_000 - AGENT_CHECK_OUTPUT_ALLOWANCE_MS - AGENT_CHECK_WRITE_BACK_MARGIN_MS,
  );
});

test("an absolute deadline shortens the check budget and leaves the cursor unchanged", { timeout: 10_000 }, async () => {
  const profilePath = await profile();
  const first = signal(1);
  await checkAgentMessages({ profilePath, fetcher: fetcher([first], 0), present: async () => {} });
  const started = Date.now();
  let presented = false;
  await assert.rejects(checkAgentMessages({
    profilePath,
    fetcher: fetcher([first, signal(2)], 1_000),
    deadlineAtMs: Date.now() + 300,
    present: async () => { presented = true; },
  }), { code: "check_timeout" });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 900, `the absolute deadline did not bound the check: ${elapsed}ms`);
  assert.equal(presented, false);
  const state = JSON.parse(await readFile(join(dirname(profilePath), "check.json"), "utf8"));
  assert.equal(state.cursor.id, first.id);
});

test("a lock left by a dead process is taken at once, not after the stale window", { timeout: 10_000 }, async () => {
  const profilePath = await profile();
  const dead = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  const deadPid = dead.pid!;
  await new Promise<void>(resolveExit => dead.once("close", () => resolveExit()));
  await writeFile(join(dirname(profilePath), "check.lock"), JSON.stringify({ pid: deadPid, createdAt: Date.now() }), { mode: 0o600 });
  const started = Date.now();
  const result = await checkAgentMessages({ profilePath, fetcher: fetcher([signal(1)], 0), present: async () => {} });
  const elapsed = Date.now() - started;
  assert.deepEqual(result.messages.map(row => row.id), [signal(1).id]);
  assert.ok(elapsed < 1_000, `a dead owner's lock was waited on for ${elapsed}ms`);
});

test("process.exit while holding a file lock removes that lock", { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(root, "exit-lock-"));
  const storage = join(repoRoot, "src", "cloud", "storage.ts");
  const child = spawn(process.execPath, [
    "--import", tsxImport, "--input-type=module", "-e",
    `import { withFileLock } from ${JSON.stringify(storage)};
     await withFileLock(${JSON.stringify(directory)}, "check", async () => { process.stdout.write("held"); process.exit(0); });`,
  ], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => stdout += String(chunk));
  child.stderr.on("data", chunk => stderr += String(chunk));
  const status = await new Promise<number | null>(resolveStatus => child.once("close", resolveStatus));
  assert.equal(status, 0, stderr);
  assert.equal(stdout, "held");
  await assert.rejects(access(join(directory, "check.lock")), { code: "ENOENT" });
});

test("usage states the listener hook budget generated from its constant", () => {
  assert.match(usage(), new RegExp(`hook check has its own ${HOOK_CHECK_TIMEOUT_MS / 1_000}s ceiling`));
});

test("check succeeds below its budget and times out without moving the cursor above it", { timeout: 20_000 }, async () => {
  const profilePath = await profile();
  const first = signal(1);
  const below = await checkAgentMessages({
    profilePath,
    /* 600 ms below the budget, not 100: in-budget work (profile, lock, credential) under host load took more than
     * 100 ms in a full gate run. This row proves the check enforces the constant, whatever its value; a revert to a
     * typed 3,000 is caught by the ceiling-arithmetic test above, not here. */
    fetcher: fetcher([first], AGENT_CHECK_TIMEOUT_MS - 600),
    present: async () => {},
  });
  assert.deepEqual(below.messages.map(row => row.id), [first.id]);

  const second = signal(2);
  await assert.rejects(checkAgentMessages({
    profilePath,
    fetcher: fetcher([first, second], AGENT_CHECK_TIMEOUT_MS + 300),
    present: async () => {},
  }), { code: "check_timeout" });
  const timedOutState = JSON.parse(await readFile(join(dirname(profilePath), "check.json"), "utf8"));
  assert.equal(timedOutState.cursor.id, first.id);

  const after = await checkAgentMessages({
    profilePath,
    fetcher: fetcher([first, second], 0),
    present: async () => {},
  });
  assert.deepEqual(after.messages.map(row => row.id), [second.id]);
});

test("lock contention from another process becomes check_timeout without moving the cursor", { timeout: 10_000 }, async () => {
  const profilePath = await profile();
  const first = signal(1);
  await checkAgentMessages({
    profilePath,
    fetcher: fetcher([first], 0),
    present: async () => {},
  });

  const lockPath = join(dirname(profilePath), "check.lock");
  const holder = spawn(process.execPath, [join(repoRoot, "tests/fixtures/hold-file-lock.mjs"), lockPath], {
    cwd: repoRoot,
    env: { ...process.env, HOME: await mkdtemp(join(root, "lock-home-")) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let holderError = "";
  holder.stderr.setEncoding("utf8");
  holder.stderr.on("data", chunk => holderError += chunk);
  await new Promise<void>((resolveReady, rejectReady) => {
    holder.once("error", rejectReady);
    holder.stdout.once("data", chunk => {
      if (String(chunk) !== "ready\n") rejectReady(new Error(`lock holder was not ready: ${String(chunk)}`));
      else resolveReady();
    });
  });

  try {
    const started = Date.now();
    await assert.rejects(checkAgentMessages({
      profilePath,
      fetcher: fetcher([first, signal(2)], 0),
      present: async () => {},
    }), { code: "check_timeout" });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < AGENT_CHECK_TIMEOUT_MS + 250, `lock timeout took ${elapsed}ms`);
    const state = JSON.parse(await readFile(join(dirname(profilePath), "check.json"), "utf8"));
    assert.equal(state.cursor.id, first.id);
  } finally {
    holder.stdin.end();
    const status = await new Promise<number | null>(resolveStatus => holder.once("close", resolveStatus));
    assert.equal(status, 0, holderError);
  }
});

async function writeReceiveBinding(profilePath: string, host: string, cwd: string): Promise<void> {
  const canonicalCwd = await realpath(cwd);
  await writeFile(receiveBindingPath(profilePath, host), JSON.stringify({
    version: 1,
    profile: profilePath,
    host_session_id: host,
    provider: "codex",
    requested_mode: "turn",
    cwd: canonicalCwd,
    hook_file: null,
    hook_command: null,
    turn_verified_at: null,
    last_turn_started_at: null,
    last_turn_ended_at: null,
    idle: false,
    channel_config: null,
    channel_instance_id: null,
    channel_pid: null,
    channel_heartbeat_at: null,
    wake_verified_at: null,
    canary: null,
  }), { mode: 0o600 });
}

async function runReceiveHook(profilePath: string, host: string, cwd: string, preloadDelayMs: number) {
  const home = await mkdtemp(join(root, "hook-home-"));
  const canonicalCwd = await realpath(cwd);
  const started = Date.now();
  const child = spawn(process.execPath, [
    "--import", tsxImport, cliPath,
    "check", "--profile", profilePath, "--hook", "--host-session-id", host,
  ], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, "config"),
      SWARM_AGENT_STATE_DIR: join(home, "agent-state"),
      CSWARM_TEST_PRELOAD_DELAY_MS: String(preloadDelayMs),
      NODE_OPTIONS: `--max-old-space-size=4096 --import=${join(repoRoot, "tests/fixtures/receive-hanging-fetch.mjs")}`,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => stdout += chunk);
  child.stderr.on("data", chunk => stderr += chunk);
  child.stdin.end(JSON.stringify({ session_id: host, cwd: canonicalCwd, hook_event_name: "UserPromptSubmit" }));
  const safety = setTimeout(() => child.kill("SIGKILL"), 6_000);
  const status = await new Promise<number | null>((resolveStatus, rejectStatus) => {
    child.once("error", rejectStatus);
    child.once("close", resolveStatus);
  });
  clearTimeout(safety);
  return { status, stdout, stderr, elapsed: Date.now() - started };
}

test("receive hook exits after timeout output even when transport keeps the process alive", { timeout: 15_000 }, async () => {
  const profilePath = await profile();
  const host = "check-budget-session";
  const cwd = await mkdtemp(join(root, "hook-project-"));
  await writeReceiveBinding(profilePath, host, cwd);
  const expected = `CommonSwarm check failed (check_timeout); the inbox was not proved empty. Run cswarm check --profile '${profilePath}' to see the error.\n`;

  for (const preloadDelayMs of [0, 1_200]) {
    // A failure is printed only when it changed, so each run starts without the previous diagnostic.
    const diagnostic = join(dirname(profilePath), `check-error-${profileScopeKey(host)}.json`);
    await rm(diagnostic, { force: true });
    const result = await runReceiveHook(profilePath, host, cwd, preloadDelayMs);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, expected);
    assert.ok(
      result.elapsed < DOCUMENTED_HOST_HOOK_TIMEOUT_SECONDS * 1_000,
      `receive hook took ${result.elapsed}ms with ${preloadDelayMs}ms preload`,
    );
    if (preloadDelayMs === 0) {
      // Lower bound: the check used its derived budget, so a revert to a shorter typed budget fails here.
      assert.ok(result.elapsed >= AGENT_CHECK_TIMEOUT_MS - 300, `receive hook gave up after ${result.elapsed}ms`);
    }
    // The CHECK aborted itself (its catch path records the diagnostic); the process hard exit writes none.
    assert.equal(JSON.parse(await readFile(diagnostic, "utf8")), "check_timeout");
    await assert.rejects(access(join(dirname(profilePath), "check.lock")), { code: "ENOENT" });
  }
});
