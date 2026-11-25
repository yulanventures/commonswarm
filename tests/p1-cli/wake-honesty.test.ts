import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { AGENT_CREDENTIAL_MESSAGE_D088 } from "../../src/cloud/agent-credential-input.js";
import { saveAgentProfile } from "../../src/cloud/agent-profile.js";
import { cloudTarget } from "../../src/cloud/config.js";
import { DeliveryHttpError, DeliveryProtocolError } from "../../src/cloud/delivery.js";
import { nativeWakeStatePath } from "../../src/cloud/native-wake.js";
import { RenewalReauthorisationRequired, RenewalRevoked } from "../../src/cloud/renewal.js";
import { ListenerCredentialStateMismatchError } from "../../src/cloud/signals.js";
import { credentialStore, writeSecureJsonFile } from "../../src/cloud/storage.js";
import {
  readWorkspaceAgentWakePath,
  renderStatus,
} from "../../src/cloud/workspaces.js";
import {
  attendedCanaryStatePath,
  checkLocalSeatWakeHealth,
  clearStalledAttendedCanaryOnCheck,
  isRestartableListenerStop,
  ListenerCapabilityError,
  ListenerH0SeatError,
  listenerPaths,
  readAttendedCanaryStatusIfPresent,
  writeAttendedCanaryStatus,
  writeListenerStatus,
  type ListenerStatus,
} from "../../src/listener/index.js";
import { classifySeatStatus } from "../../src/protocol/seat-status.js";

const WS = "11111111-1111-4111-8111-111111111111";
const OWNER = "22222222-2222-4222-8222-222222222222";
const AGENT = "33333333-3333-4333-8333-333333333333";
const AGENT_2 = "44444444-4444-4444-8444-444444444444";
const INSTANCE = "55555555-5555-4555-8555-555555555555";
const SIG_BASE = "66666666-6666-4666-8666-666666666666";
const SIG_NEW = "77777777-7777-4777-8777-777777777777";
const TOKEN = `swm_agt_${"z".repeat(43)}`;
const ANON_KEY = "test-anon-key-public";
const CLI_PATH = resolve("dist/cli.js");

function makeStatus(overrides: Partial<ListenerStatus> = {}): ListenerStatus {
  const nowIso = "2026-11-24T12:00:00.000Z";
  return {
    version: 1,
    instanceId: INSTANCE,
    provider: "claude",
    profileId: "prof-test",
    workspaceId: WS,
    principalId: AGENT,
    pid: 999999,
    state: "failed",
    startedAt: "2026-11-24T11:00:00.000Z",
    readyAt: null,
    updatedAt: nowIso,
    stoppedAt: nowIso,
    lastSignalId: null,
    lastErrorCode: "delivery_unreachable",
    lastErrorDetail: null,
    lastWorkerStderrTail: null,
    deliveryMode: "durable_claim",
    pendingDeliveryCount: 0,
    lastTerminalDeliveryFailureCount: 0,
    lastTerminalDeliveryFailureAt: null,
    lastClaimAt: null,
    lastAckAt: null,
    lastAckOutcome: null,
    consecutiveAckFailureCount: 0,
    logPath: "/tmp/events.ndjson",
    ...overrides,
  };
}

async function runCli(
  dir: string,
  args: string[],
  options: { stdin?: string; extraEnv?: Record<string, string> } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env: {
        ...process.env,
        HOME: dir,
        XDG_CONFIG_HOME: join(dir, "config"),
        XDG_STATE_HOME: join(dir, "xdg-state"),
        SWARM_AGENT_STATE_DIR: join(dir, "state"),
        SWARM_CLOUD_URL: "",
        SWARM_CLOUD_ANON_KEY: "",
        SWARM_CLOUD_WORKSPACE_ID: "",
        ...(options.extraEnv ?? {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (options.stdin !== undefined) {
      child.stdin.end(options.stdin);
    } else {
      child.stdin.end();
    }
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", rejectRun);
    child.once("close", (status) => {
      resolveRun({ code: status ?? 1, stdout, stderr });
    });
  });
}

test("checkLocalSeatWakeHealth stays silent when clean and warns on failed listener, dead PID, native wake failure, and stalled canary", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cswarm-health-notice-"));
  chmodSync(dir, 0o700);
  try {
    const stateDirectory = join(dir, "listeners");
    const profilePath = join(dir, "profile.json");
    const now = Date.parse("2026-11-24T12:15:00.000Z");

    // 1. Clean environment -> healthy, zero warnings
    const clean = await checkLocalSeatWakeHealth({
      profileId: "prof-test",
      workspaceId: WS,
      principalId: AGENT,
      profilePath,
      hostSessionId: "sess-1",
      stateDirectory,
      now,
    });
    assert.equal(clean.healthy, true);
    assert.deepEqual(clean.warnings, []);
    assert.equal(clean.listener.state, "missing");

    // 2. Failed listener status.json -> sanitized warning with error code, age, fix command
    const paths = listenerPaths({
      profileId: "prof-test",
      workspaceId: WS,
      principalId: AGENT,
      stateDirectory,
    });
    await writeListenerStatus(paths, makeStatus({
      state: "failed",
      lastErrorCode: "delivery_unreachable",
      updatedAt: "2026-11-24T12:00:00.000Z",
    }));
    const failed = await checkLocalSeatWakeHealth({
      profileId: "prof-test",
      workspaceId: WS,
      principalId: AGENT,
      profilePath,
      hostSessionId: "sess-1",
      stateDirectory,
      now,
    });
    assert.equal(failed.healthy, false);
    assert.equal(failed.listener.effective_state, "failed");
    assert.equal(failed.listener.error_code, "delivery_unreachable");
    assert.equal(failed.warnings.length, 1);
    assert.match(failed.warnings[0]!, /local listener is failed \(delivery_unreachable, stopped 15 min ago\)/);
    assert.match(failed.warnings[0]!, /cswarm listen start --profile/);
    assert.match(failed.warnings[0]!, /--provider claude/);

    // 3. Running state with dead PID -> unclean_exit warning; alive PID -> silent
    await writeListenerStatus(paths, makeStatus({
      state: "ready",
      lastErrorCode: null,
      stoppedAt: null,
      pid: 424242,
      updatedAt: "2026-11-24T12:10:00.000Z",
    }));
    const deadPid = await checkLocalSeatWakeHealth({
      profileId: "prof-test",
      workspaceId: WS,
      principalId: AGENT,
      stateDirectory,
      now,
      isProcessAlive: () => false,
    });
    assert.equal(deadPid.healthy, false);
    assert.equal(deadPid.listener.effective_state, "failed");
    assert.equal(deadPid.listener.error_code, "unclean_exit");
    assert.match(deadPid.warnings[0]!, /unclean_exit, stopped 5 min ago/);
    assert.match(deadPid.warnings[0]!, /cswarm listen status --workspace-id/);

    const alivePid = await checkLocalSeatWakeHealth({
      profileId: "prof-test",
      workspaceId: WS,
      principalId: AGENT,
      stateDirectory,
      now,
      isProcessAlive: () => true,
    });
    assert.equal(alivePid.healthy, true);
    assert.deepEqual(alivePid.warnings, []);

    // 4. Native wake failure with secret-shaped error text is scrubbed and warns
    const wakePath = nativeWakeStatePath(profilePath, "sess-1");
    await writeSecureJsonFile(wakePath, JSON.stringify({
      version: 1,
      profile: profilePath,
      host_session_id: "sess-1",
      route: "codex-queue",
      batch: 2,
      pending_batch: 2,
      pending_sent_at: "2026-11-24T11:50:00.000Z",
      retry_sent_at: "2026-11-24T12:05:00.000Z",
      last_wake_at: "2026-11-24T12:05:00.000Z",
      last_ack_at: null,
      wake_failed_at: "2026-11-24T12:10:00.000Z",
      last_error: `failed with ${TOKEN} \u001b[31mboom\u001b[0m`,
    }));
    const wakeFailed = await checkLocalSeatWakeHealth({
      profileId: "prof-test",
      workspaceId: WS,
      principalId: AGENT,
      profilePath,
      hostSessionId: "sess-1",
      stateDirectory,
      now,
      isProcessAlive: () => true,
    });
    assert.equal(wakeFailed.healthy, false);
    assert.equal(wakeFailed.native_wake?.failed, true);
    assert.equal(wakeFailed.native_wake?.error, "wake_failed");
    assert.doesNotMatch(wakeFailed.warnings.join("\n"), /swm_agt_/);
    assert.doesNotMatch(wakeFailed.warnings.join("\n"), /\u001b/);
    assert.match(wakeFailed.warnings[0]!, /native wake failed \(wake_failed, 5 min ago\)/);
    assert.match(wakeFailed.warnings[0]!, /cswarm receive status/);

    // 5. Stalled attended canary warns until cleared by cswarm check
    await writeAttendedCanaryStatus(paths, {
      state: "stalled_observed",
      updated_at: "2026-11-24T12:00:00.000Z",
      workspace_id: WS,
      principal_id: AGENT,
    });
    const canaryMode = statSync(attendedCanaryStatePath(paths)).mode & 0o777;
    assert.equal(canaryMode, 0o600);
    const stalled = await checkLocalSeatWakeHealth({
      profileId: "prof-test",
      workspaceId: WS,
      principalId: AGENT,
      stateDirectory,
      now,
      isProcessAlive: () => true,
    });
    assert.equal(stalled.healthy, false);
    assert.equal(stalled.attended_canary?.state, "stalled_observed");
    assert.equal(stalled.attended_canary?.cleared_by_check, false);
    assert.match(stalled.warnings[0]!, /watcher is polling without waking this session/);

    const cleared = await clearStalledAttendedCanaryOnCheck({
      profileId: "prof-test",
      workspaceId: WS,
      principalId: AGENT,
      stateDirectory,
      now,
    });
    assert.equal(cleared, true);
    const afterClear = await checkLocalSeatWakeHealth({
      profileId: "prof-test",
      workspaceId: WS,
      principalId: AGENT,
      stateDirectory,
      now: now + 60_000,
      isProcessAlive: () => true,
    });
    assert.equal(afterClear.healthy, true);
    assert.equal(afterClear.attended_canary?.cleared_by_check, true);
    assert.deepEqual(afterClear.warnings, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readWorkspaceAgentWakePath and renderStatus align with classifySeatStatus and degrade gracefully", async () => {
  const target = cloudTarget("http://127.0.0.1:54321", ANON_KEY);

  // Graceful degradation on 404 / PGRST205
  const missing = await readWorkspaceAgentWakePath(
    target,
    "human-token",
    WS,
    async () => new Response(JSON.stringify({ code: "PGRST205" }), { status: 404 }),
  );
  assert.deepEqual(missing, { available: false, rows: [] });

  // Valid agent_wake_path rows
  const ok = await readWorkspaceAgentWakePath(
    target,
    "human-token",
    WS,
    async () => new Response(JSON.stringify([
      {
        workspace_id: WS,
        principal_id: AGENT,
        oldest_unobserved_at: "2026-11-24T11:50:00.000Z",
        unseen_count: 3,
      },
    ]), { status: 200, headers: { "content-type": "application/json" } }),
  );
  assert.equal(ok.available, true);
  assert.deepEqual(ok.rows, [
    {
      principal_id: AGENT,
      oldest_unobserved_at: "2026-11-24T11:50:00.000Z",
      unseen_count: 3,
    },
  ]);

  // renderStatus renders classified seat_status.line + local listener failure note instead of hardcoded "live"
  const now = Date.parse("2026-11-24T12:00:00.000Z");
  const notListeningStatus = classifySeatStatus({
    transport: "local",
    turnOnly: false,
    connection: "live",
    presence: {
      last_command_at: "2026-11-24T10:00:00.000Z",
      client_build: null,
      watcher_at: null,
      channel_at: null,
      listener_at: "2026-11-24T09:00:00.000Z",
      turn_at: null,
      last_ack_via: null,
      last_ack_at: null,
      current_client_build: null,
    },
  }, now);
  const rendered = renderStatus({
    userId: OWNER,
    identityLabel: "owner@example.test",
    projectCount: 1,
    selected: { workspace_id: WS, name: "Launch", role: "owner", archived: false },
    now,
    status: {
      members: [{ user_id: OWNER, name: "Owner", role: "owner", you: true }],
      agents: [
        {
          principal_id: AGENT,
          name: "WatcherBot",
          owner_user_id: OWNER,
          owner_name: "Owner",
          transport: "local",
          turn_only: false,
          revoked: false,
          this_machine: true,
          seat_status: notListeningStatus,
          local_listener_failure: "delivery_unreachable",
        },
        {
          principal_id: AGENT_2,
          name: "LegacyBot",
          owner_user_id: OWNER,
          owner_name: "Owner",
          transport: "local",
          turn_only: false,
          revoked: false,
          this_machine: false,
        },
      ],
      tasks: [],
    },
  });
  assert.match(rendered, /WatcherBot .* Not listening · last active 2 h ago \(local listener failed: delivery_unreachable\)/);
  assert.doesNotMatch(rendered, /WatcherBot .* — live —/);
  assert.match(rendered, /LegacyBot .* — live —/);
});

test("whoami and agent CLI commands emit local failed-listener warnings to stderr while keeping --json stdout pure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cswarm-whoami-health-"));
  chmodSync(dir, 0o700);
  const previousHome = process.env.HOME;
  process.env.HOME = dir;
  const nowIso = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
      const reply = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (req.url === "/functions/v1/read" && body.resource === "members") {
        return reply(200, {
          members: [{ user_id: OWNER, display_name: "Owner" }],
          agents: [
            {
              principal_id: AGENT,
              name: "HealthAgent",
              owner_user_id: OWNER,
              transport: "local",
              turn_only: false,
              last_command_at: nowIso,
              client_build: null,
              watcher_at: null,
              channel_at: null,
              listener_at: nowIso,
              turn_at: null,
              last_ack_via: null,
              last_ack_at: null,
              current_client_build: null,
            },
          ],
          identity: {
            credential_valid: true,
            principal_id: AGENT,
            owner_user_id: OWNER,
            workspace_id: WS,
            workspace_name: "Ops Workspace",
          },
        });
      }
      if (req.url === "/functions/v1/read" && body.resource === "renewal_grants") {
        return reply(200, { grants: [] });
      }
      if (req.url === "/functions/v1/read" && body.resource === "conversations") {
        return reply(200, { conversations: [] });
      }
      return reply(404, { error: "not_found" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const profilePath = join(dir, "profile.json");
    await saveAgentProfile(
      profilePath,
      {
        version: 1,
        url,
        anon_key: ANON_KEY,
        workspace_id: WS,
        principal_id: AGENT,
        credential: {
          message: AGENT_CREDENTIAL_MESSAGE_D088,
          status: "accepted",
          principal_id: AGENT,
          token_id: "99999999-9999-4999-8999-999999999999",
          run_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          agent_token: TOKEN,
          expires_at: "2099-01-01T00:00:00.000Z",
        },
      },
      undefined,
      "session-health-1",
    );

    // Clean state: zero stderr on members --json and whoami --json
    const cleanMembers = await runCli(dir, [
      "members",
      "--profile",
      profilePath,
      "--host-session-id",
      "session-health-1",
      "--json",
    ]);
    assert.equal(cleanMembers.code, 0, cleanMembers.stderr);
    assert.equal(cleanMembers.stderr, "");
    assert.doesNotThrow(() => JSON.parse(cleanMembers.stdout));

    const cleanWhoami = await runCli(dir, [
      "whoami",
      "--profile",
      profilePath,
      "--host-session-id",
      "session-health-1",
      "--json",
    ]);
    assert.equal(cleanWhoami.code, 0, cleanWhoami.stderr);
    assert.equal(cleanWhoami.stderr, "");
    const cleanJson = JSON.parse(cleanWhoami.stdout) as Record<string, any>;
    assert.equal(cleanJson.seat.status, "active");
    assert.equal(cleanJson.seat_status.kind, "not_listening");
    assert.equal(cleanJson.listener_health.healthy, true);

    // Plant failed listener status.json under XDG_STATE_HOME/cswarm/listeners
    const target = cloudTarget(url, ANON_KEY);
    const paths = listenerPaths({
      profileId: target.profileId,
      workspaceId: WS,
      principalId: AGENT,
      stateDirectory: join(dir, "xdg-state", "cswarm", "listeners"),
    });
    await writeListenerStatus(paths, makeStatus({
      profileId: target.profileId,
      state: "failed",
      lastErrorCode: "delivery_unreachable",
      updatedAt: nowIso,
    }));

    // Ordinary agent command (members --json) warns on stderr, keeps stdout valid JSON
    const failedMembers = await runCli(dir, [
      "members",
      "--profile",
      profilePath,
      "--host-session-id",
      "session-health-1",
      "--json",
    ]);
    assert.equal(failedMembers.code, 0, failedMembers.stderr);
    assert.doesNotThrow(() => JSON.parse(failedMembers.stdout));
    assert.match(failedMembers.stderr, /cswarm: warning: local listener is failed \(delivery_unreachable/);
    assert.doesNotMatch(failedMembers.stderr, /swm_agt_/);

    // whoami --json reports listener_health and keeps stdout pure JSON
    const failedWhoamiJson = await runCli(dir, [
      "whoami",
      "--profile",
      profilePath,
      "--host-session-id",
      "session-health-1",
      "--json",
    ]);
    assert.equal(failedWhoamiJson.code, 0, failedWhoamiJson.stderr);
    const parsedWhoami = JSON.parse(failedWhoamiJson.stdout) as Record<string, any>;
    assert.equal(parsedWhoami.seat.status, "active");
    assert.equal(parsedWhoami.listener_health.healthy, false);
    assert.equal(parsedWhoami.seat.listener_health.listener.effective_state, "failed");
    assert.match(failedWhoamiJson.stderr, /cswarm: warning: local listener is failed/);

    // whoami human text surfaces Seat status and Listener health
    const failedWhoamiText = await runCli(dir, [
      "whoami",
      "--profile",
      profilePath,
      "--host-session-id",
      "session-health-1",
    ]);
    assert.equal(failedWhoamiText.code, 0, failedWhoamiText.stderr);
    assert.match(failedWhoamiText.stdout, /Seat status: Not listening/);
    assert.match(failedWhoamiText.stdout, /Listener health: local listener is failed \(delivery_unreachable/);

    // --help and --version never emit local health notices
    const helpRes = await runCli(dir, ["--help"]);
    assert.equal(helpRes.code, 0);
    assert.equal(helpRes.stderr, "");
    const verRes = await runCli(dir, ["--version"]);
    assert.equal(verRes.code, 0);
    assert.equal(verRes.stderr, "");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("inbox --notify --exit-on-arrival exits 0 cleanly after first post-baseline arrival and releases wake lease", { timeout: 15_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cswarm-exit-on-arrival-"));
  chmodSync(dir, 0o700);
  let readCalls = 0;
  const commands: string[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
      const command = body.command as Record<string, unknown> | undefined;
      if (req.url === "/functions/v1/command" && command) {
        commands.push(String(command.kind));
        if (command.kind === "claim_wake_lease") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, status: "accepted", generation: 1 }));
          return;
        }
        if (command.kind === "release_wake_lease") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, released: true }));
          return;
        }
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unexpected_command" }));
        return;
      }
      if (req.url === "/functions/v1/read" && body.resource === "signals") {
        readCalls += 1;
        if (readCalls === 1) {
          // Baseline page (pre-existing signal) - must NOT trigger exit
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            signals: [
              {
                id: SIG_BASE,
                workspace_id: WS,
                from: OWNER,
                from_kind: "user",
                to: null,
                to_agent: AGENT,
                in_reply_to: null,
                about: null,
                kind: "note",
                body: "Old baseline message",
                until: "2099-01-01T00:00:00.000Z",
                created_at: "2026-11-24T10:00:00.000Z",
              },
            ],
            capabilities: { cursor_after: 1 },
          }));
          return;
        }
        // Second read: real post-baseline arrival
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          signals: [
            {
              id: SIG_NEW,
              workspace_id: WS,
              from: OWNER,
              from_kind: "user",
              to: null,
              to_agent: AGENT,
              in_reply_to: null,
              about: null,
              kind: "ask",
              body: "Wake up now",
              until: "2099-01-01T00:00:00.000Z",
              created_at: "2026-11-24T10:05:00.000Z",
            },
          ],
          capabilities: { cursor_after: 1 },
        }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const credential = JSON.stringify({
      message: AGENT_CREDENTIAL_MESSAGE_D088,
      status: "accepted",
      principal_id: AGENT,
      token_id: "99999999-9999-4999-8999-999999999999",
      run_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      agent_token: TOKEN,
      expires_at: "2099-01-01T00:00:00.000Z",
    });
    const res = await runCli(
      dir,
      [
        "inbox",
        "--notify",
        "--exit-on-arrival",
        "--agent-token-stdin",
        "--url",
        url,
        "--anon-key",
        ANON_KEY,
        "--workspace-id",
        WS,
      ],
      { stdin: credential },
    );
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /Wake up now/);
    assert.doesNotMatch(res.stdout, /Old baseline message/);
    assert.ok(commands.includes("claim_wake_lease"));
    assert.ok(commands.includes("release_wake_lease"));
    assert.equal(commands.includes("post_signal"), false, "exit-on-arrival must not post a self-canary note");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("inbox --notify emits a stderr warning at startup when stdout is redirected to a regular file and stays silent on a pipe", { timeout: 15_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cswarm-not-pipe-"));
  chmodSync(dir, 0o700);
  const outFile = join(dir, "stdout.log");
  let readCalls = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
      const command = body.command as Record<string, unknown> | undefined;
      if (req.url === "/functions/v1/command" && command?.kind === "claim_wake_lease") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, status: "accepted", generation: 1 }));
        return;
      }
      if (req.url === "/functions/v1/command" && command?.kind === "release_wake_lease") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, released: true }));
        return;
      }
      if (req.url === "/functions/v1/read" && body.resource === "signals") {
        readCalls += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          signals: readCalls % 2 === 1
            ? []
            : [{
                id: SIG_NEW,
                workspace_id: WS,
                from: OWNER,
                from_kind: "user",
                to: null,
                to_agent: AGENT,
                in_reply_to: null,
                about: null,
                kind: "note",
                body: "Arrived",
                until: "2099-01-01T00:00:00.000Z",
                created_at: "2026-11-24T10:05:00.000Z",
              }],
          capabilities: { cursor_after: 1 },
        }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const outFd = openSync(outFile, "w");
  try {
    const credential = JSON.stringify({
      message: AGENT_CREDENTIAL_MESSAGE_D088,
      status: "accepted",
      principal_id: AGENT,
      token_id: "99999999-9999-4999-8999-999999999999",
      run_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      agent_token: TOKEN,
      expires_at: "2099-01-01T00:00:00.000Z",
    });
    const notifyArgs = [
      "inbox",
      "--notify",
      "--exit-on-arrival",
      "--agent-token-stdin",
      "--url",
      url,
      "--anon-key",
      ANON_KEY,
      "--workspace-id",
      WS,
    ];
    const child = spawn(process.execPath, [CLI_PATH, ...notifyArgs], {
      env: {
        ...process.env,
        HOME: dir,
        XDG_STATE_HOME: join(dir, "xdg-state-file"),
        SWARM_CLOUD_URL: "",
        SWARM_CLOUD_ANON_KEY: "",
        SWARM_CLOUD_WORKSPACE_ID: "",
      },
      stdio: ["pipe", outFd, "pipe"],
    });
    child.stdin!.end(credential);
    let stderr = "";
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => { stderr += chunk; });
    const code = await new Promise<number>((resolveExit, rejectExit) => {
      child.once("error", rejectExit);
      child.once("close", (status) => resolveExit(status ?? 1));
    });
    assert.equal(code, 0, stderr);
    assert.match(stderr, /stdout is redirected to a file or sink rather than a live pipe/);
    assert.match(readFileSync(outFile, "utf8"), /Arrived/);

    const piped = await runCli(dir, notifyArgs, {
      stdin: credential,
      extraEnv: { XDG_STATE_HOME: join(dir, "xdg-state-pipe") },
    });
    assert.equal(piped.code, 0, piped.stderr);
    assert.doesNotMatch(piped.stderr, /stdout is redirected to a file or sink/);
    assert.match(piped.stdout, /Arrived/);
  } finally {
    closeSync(outFd);
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isRestartableListenerStop restarts unwrapped transient Node/undici network errors and keeps permanent stops terminal", () => {
  const transientCodes = [
    "ECONNRESET",
    "ETIMEDOUT",
    "EAI_AGAIN",
    "ENOTFOUND",
    "ECONNREFUSED",
    "EPIPE",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
    "UND_ERR_SOCKET",
  ];
  for (const code of transientCodes) {
    const direct = Object.assign(new Error(`direct ${code}`), { code });
    assert.equal(
      isRestartableListenerStop({ reason: "fatal", error: direct }),
      true,
      `direct ${code} should be restartable`,
    );
    const wrapped = new TypeError("fetch failed", { cause: direct });
    assert.equal(
      isRestartableListenerStop({ reason: "fatal", error: wrapped }),
      true,
      `cause-wrapped ${code} should be restartable`,
    );
  }

  const dualStack = new AggregateError([
    Object.assign(new Error("v4"), { code: "ECONNREFUSED" }),
    Object.assign(new Error("v6"), { code: "ECONNREFUSED" }),
  ], "connect refused");
  assert.equal(isRestartableListenerStop({ reason: "fatal", error: dualStack }), true);

  // Permanent stops MUST remain terminal (false)
  const permanentErrors: Array<[string, Error]> = [
    ["RenewalRevoked", new RenewalRevoked("renewal_grant_revoked", "grant revoked")],
    ["RenewalReauthorisationRequired", new RenewalReauthorisationRequired("horizon_reached", AGENT, "horizon ended")],
    ["ListenerCredentialStateMismatchError", new ListenerCredentialStateMismatchError()],
    ["ListenerH0SeatError", new ListenerH0SeatError()],
    ["DeliveryProtocolError", new DeliveryProtocolError("bad protocol")],
    ["400 invalid_request", new DeliveryHttpError(400, "invalid_request", "bad request", null, true)],
    ["409 command_id_conflict", new DeliveryHttpError(409, "command_id_conflict", "conflict", null, true)],
    ["413 payload_too_large", new DeliveryHttpError(413, "payload_too_large", "too big", null, true)],
    ["426 upgrade_required", new DeliveryHttpError(426, "upgrade_required", "upgrade", null, true)],
    ["delivery_configuration_missing", new ListenerCapabilityError("delivery_configuration_missing", "missing")],
    ["plain unknown Error", new Error("something unexpected")],
  ];
  for (const [label, error] of permanentErrors) {
    assert.equal(
      isRestartableListenerStop({ reason: "fatal", error }),
      false,
      `${label} must remain terminal`,
    );
  }
});

test("cswarm check clears a persisted stalled_observed attended canary so subsequent commands emit zero warning", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cswarm-check-clear-canary-"));
  chmodSync(dir, 0o700);
  const previousHome = process.env.HOME;
  process.env.HOME = dir;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
      const reply = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (req.url === "/functions/v1/read" && body.resource === "members") {
        return reply(200, {
          members: [{ user_id: OWNER, display_name: "Owner" }],
          agents: [{ principal_id: AGENT, name: "CanaryAgent", owner_user_id: OWNER }],
          identity: {
            credential_valid: true,
            principal_id: AGENT,
            owner_user_id: OWNER,
            workspace_id: WS,
            workspace_name: "Canary Workspace",
          },
        });
      }
      if (req.url === "/functions/v1/read" && body.resource === "signals") {
        return reply(200, { signals: [], capabilities: { cursor_after: 1 } });
      }
      if (req.url === "/functions/v1/command") {
        return reply(200, { ok: true, status: "accepted", event_ids: [] });
      }
      return reply(404, { error: "not_found" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const profilePath = join(dir, "profile.json");
    await saveAgentProfile(
      profilePath,
      {
        version: 1,
        url,
        anon_key: ANON_KEY,
        workspace_id: WS,
        principal_id: AGENT,
        credential: {
          message: AGENT_CREDENTIAL_MESSAGE_D088,
          status: "accepted",
          principal_id: AGENT,
          token_id: "99999999-9999-4999-8999-999999999999",
          run_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          agent_token: TOKEN,
          expires_at: "2099-01-01T00:00:00.000Z",
        },
      },
      undefined,
      "session-canary-1",
    );
    const target = cloudTarget(url, ANON_KEY);
    const paths = listenerPaths({
      profileId: target.profileId,
      workspaceId: WS,
      principalId: AGENT,
      stateDirectory: join(dir, "xdg-state", "cswarm", "listeners"),
    });
    await writeAttendedCanaryStatus(paths, {
      state: "stalled_observed",
      updated_at: new Date(Date.now() - 120_000).toISOString(),
      workspace_id: WS,
      principal_id: AGENT,
    });

    // Before check: members warns about stalled canary
    const beforeCheck = await runCli(dir, [
      "members",
      "--profile",
      profilePath,
      "--host-session-id",
      "session-canary-1",
      "--json",
    ]);
    assert.equal(beforeCheck.code, 0, beforeCheck.stderr);
    assert.match(beforeCheck.stderr, /watcher is polling without waking this session/);

    // Running cswarm check clears stalled_observed and emits zero warning
    const checkRes = await runCli(dir, [
      "check",
      "--profile",
      profilePath,
      "--host-session-id",
      "session-canary-1",
      "--json",
    ]);
    assert.equal(checkRes.code, 0, checkRes.stderr);
    assert.equal(checkRes.stderr, "");
    const updatedCanary = await readAttendedCanaryStatusIfPresent(paths);
    assert.ok(updatedCanary?.last_check_at);

    // After check: members emits zero stderr
    const afterCheck = await runCli(dir, [
      "members",
      "--profile",
      profilePath,
      "--host-session-id",
      "session-canary-1",
      "--json",
    ]);
    assert.equal(afterCheck.code, 0, afterCheck.stderr);
    assert.equal(afterCheck.stderr, "");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cswarm status aligns with classifySeatStatus in text and --json, appends local failed listener note, and degrades on 404", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cswarm-status-align-"));
  chmodSync(dir, 0o700);
  const deviceId = "88888888-8888-4888-8888-888888888888";
  const recentIso = new Date(Date.now() - 15_000).toISOString();
  const staleIso = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
  const waitingIso = new Date(Date.now() - 10 * 60_000).toISOString();
  let servePresence = true;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const resource = reqUrl.pathname.split("/").pop() ?? "";
    const reply = (status: number, payload: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (reqUrl.pathname === "/functions/v1/read") {
      req.resume();
      req.on("end", () => {
        reply(200, { grants: [] });
      });
      return;
    }
    if (reqUrl.pathname === "/auth/v1/token") {
      req.resume();
      req.on("end", () => {
        reply(200, {
          access_token: "human-access-token",
          refresh_token: "human-refresh-token-next",
          expires_in: 3600,
          token_type: "bearer",
          user: { id: OWNER, email: "owner@example.test" },
        });
      });
      return;
    }
    if (resource === "memberships") {
      return reply(200, [{ workspace_id: WS, user_id: OWNER, role: "owner" }]);
    }
    if (resource === "workspaces") {
      return reply(200, [{ workspace_id: WS, name: "Launch", archived_at: null }]);
    }
    if (resource === "member_profiles") {
      return reply(200, [{ workspace_id: WS, user_id: OWNER, display_name: "Owner", role: "owner" }]);
    }
    if (resource === "agent_principals") {
      return reply(200, [
        {
          workspace_id: WS,
          principal_id: AGENT,
          owner_user_id: OWNER,
          name: "StuckBot",
          revoked_at: null,
          transport: "local",
          turn_only: false,
        },
        {
          workspace_id: WS,
          principal_id: AGENT_2,
          owner_user_id: OWNER,
          name: "LiveBot",
          revoked_at: null,
          transport: "local",
          turn_only: false,
        },
      ]);
    }
    if (resource === "agent_runs") {
      return reply(200, [{ principal_id: AGENT, device_id: deviceId }]);
    }
    if (resource === "tasks" || resource === "signals" || resource === "renewal_grants" || resource === "agent_renewal_grants") {
      return reply(200, []);
    }
    if (resource === "agent_presence") {
      if (!servePresence) return reply(404, { code: "PGRST205" });
      return reply(200, [
        {
          workspace_id: WS,
          principal_id: AGENT,
          last_command_at: staleIso,
          client_build: null,
          watcher_at: null,
          channel_at: null,
          listener_at: staleIso,
          turn_at: null,
          last_ack_via: null,
          last_ack_at: null,
          current_client_build: null,
        },
        {
          workspace_id: WS,
          principal_id: AGENT_2,
          last_command_at: recentIso,
          client_build: null,
          watcher_at: recentIso,
          channel_at: null,
          listener_at: null,
          turn_at: null,
          last_ack_via: "unclaimed",
          last_ack_at: recentIso,
          current_client_build: null,
        },
      ]);
    }
    if (resource === "agent_wake_path") {
      if (!servePresence) return reply(404, { code: "PGRST205" });
      return reply(200, [
        {
          workspace_id: WS,
          principal_id: AGENT,
          oldest_unobserved_at: waitingIso,
          unseen_count: 2,
        },
      ]);
    }
    return reply(404, { error: "not_found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const previousHome = process.env.HOME;
  const previousXdgConfig = process.env.XDG_CONFIG_HOME;
  const previousXdgState = process.env.XDG_STATE_HOME;
  process.env.HOME = dir;
  process.env.XDG_CONFIG_HOME = join(dir, "config");
  process.env.XDG_STATE_HOME = join(dir, "xdg-state");
  try {
    const target = cloudTarget(url, ANON_KEY);
    const store = await credentialStore({ target, forceFile: true });
    await store.write({
      version: 1,
      refreshToken: "human-refresh-token",
      generation: 1,
      userId: OWNER,
      deviceId,
    });
    await store.writeProfile({
      version: 1,
      userId: OWNER,
      workspaceId: WS,
      email: "owner@example.test",
      principalId: null,
      principalName: null,
      pendingCommands: {},
    });

    // Plant local failed listener status.json for StuckBot
    const stuckPaths = listenerPaths({
      profileId: target.profileId,
      workspaceId: WS,
      principalId: AGENT,
      stateDirectory: join(dir, "xdg-state", "cswarm", "listeners"),
    });
    await writeListenerStatus(stuckPaths, makeStatus({
      profileId: target.profileId,
      state: "failed",
      lastErrorCode: "delivery_unreachable",
      updatedAt: staleIso,
    }));

    // 1. Human text output shows classified status + local failure note
    const textRes = await runCli(dir, [
      "status",
      "--url",
      url,
      "--anon-key",
      ANON_KEY,
      "--workspace-id",
      WS,
      "--force-file-store",
    ]);
    assert.equal(textRes.code, 0, textRes.stderr);
    assert.match(textRes.stdout, /StuckBot .* Waiting since .* 2 unseen \(local listener failed: delivery_unreachable\)/);
    assert.match(textRes.stdout, /LiveBot .* Listening · verified/);
    assert.doesNotMatch(textRes.stdout, /StuckBot .* — live —/);

    // 2. JSON output preserves existing fields and adds seat_status
    const jsonRes = await runCli(dir, [
      "status",
      "--url",
      url,
      "--anon-key",
      ANON_KEY,
      "--workspace-id",
      WS,
      "--force-file-store",
      "--json",
    ]);
    assert.equal(jsonRes.code, 0, jsonRes.stderr);
    const parsed = JSON.parse(jsonRes.stdout) as { agents: Array<Record<string, any>> };
    const stuck = parsed.agents.find((a) => a.principal_id === AGENT);
    const live = parsed.agents.find((a) => a.principal_id === AGENT_2);
    assert.equal(stuck?.seat_status?.kind, "waiting");
    assert.equal(stuck?.seat_status?.unseen_count, 2);
    assert.equal(stuck?.local_listener_failure, "delivery_unreachable");
    assert.equal(live?.seat_status?.kind, "listening");

    // 3. Degrades gracefully when agent_presence and agent_wake_path return 404
    servePresence = false;
    const degradedRes = await runCli(dir, [
      "status",
      "--url",
      url,
      "--anon-key",
      ANON_KEY,
      "--workspace-id",
      WS,
      "--force-file-store",
      "--json",
    ]);
    assert.equal(degradedRes.code, 0, degradedRes.stderr);
    const degradedParsed = JSON.parse(degradedRes.stdout) as { agents: Array<Record<string, any>> };
    assert.equal(degradedParsed.agents.length, 2);
    assert.equal(degradedParsed.agents[0]?.seat_status, undefined);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdgConfig;
    if (previousXdgState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousXdgState;
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
});
