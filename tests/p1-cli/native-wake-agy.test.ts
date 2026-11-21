import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { test } from "node:test";
import { AGENT_CREDENTIAL_MESSAGE_D088 } from "../../src/cloud/agent-credential-input.js";
import { checkAgentMessages } from "../../src/cloud/agent-check.js";
import { parseAgentConnection, saveAgentProfile } from "../../src/cloud/agent-profile.js";
import {
  configureAgentReceive,
  readReceiveBinding,
  receiveStatus,
  requestReceiveCanary,
} from "../../src/cloud/agent-receive.js";
import {
  formatNativeWakePrompt,
  NativeWakeBridge,
  readNativeWakeState,
  resolveAuthorizedWakeBinding,
  wakeRouteForBinding,
} from "../../src/cloud/native-wake.js";
import {
  AgyAgentApiAdapter,
  agyRegistrationPath,
  markAgyIdle,
  readAgyRegistration,
  redactAgySecrets,
  registerAgyWake,
  serveAgyWakeBridge,
  validateAgyAgentApiExecutable,
  validateAgyCsrfToken,
  validateAgyLsAddress,
} from "../../src/cloud/native-wake-agy.js";
import type { WakeHandle } from "../../src/listener/wake.js";
import { withFileLock } from "../../src/cloud/storage.js";
import { profileScopeKey } from "../../src/cloud/agent-profile.js";

const execFileAsync = promisify(execFile);

const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWNER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CONV = "f2f34cfa-137e-4308-85d8-1aa68b02aff9";
const OTHER_CONV = "f2f34cfa-137e-4308-85d8-1aa68b02affa";
const SIGNAL_1 = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1";
const TOKEN = `swm_agt_${"A".repeat(43)}`;
const SECRET_CSRF = "csrf-super-secret-token-9f8e7d6c5b4a";
const LS_ADDR = "127.0.0.1:49152";
const CLI_PATH = process.env.CSWARM_TEST_CLI ?? resolve("dist/cli.js");

function connectionEnvelope(url = "http://127.0.0.1:9") {
  return parseAgentConnection(JSON.stringify({
    version: 1,
    url,
    anon_key: "fixture-key",
    workspace_id: WS,
    principal_id: AGENT,
    credential: {
      message: AGENT_CREDENTIAL_MESSAGE_D088,
      status: "accepted",
      principal_id: AGENT,
      token_id: "11111111-1111-4111-8111-111111111111",
      run_id: "22222222-2222-4222-8222-222222222222",
      agent_token: TOKEN,
      expires_at: "2099-01-01T00:00:00.000Z",
    },
  }));
}

async function createBoundProfile(hostSessionId: string | undefined = CONV, url = "http://127.0.0.1:9") {
  const dir = await mkdtemp(join(tmpdir(), "cswarm-agy-wake-"));
  const home = join(dir, "home");
  const cwd = join(dir, "project");
  const profileDir = join(home, ".config", "cswarm", "agy-seat");
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  await mkdir(cwd, { recursive: true });
  const profilePath = join(profileDir, "profile.json");
  await saveAgentProfile(profilePath, connectionEnvelope(url), "Test Workspace", hostSessionId);
  return {
    dir,
    home,
    cwd,
    profilePath,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

test("agy validation rejects non-loopback LS addresses, control chars, and invalid CSRF tokens without leaking secrets", () => {
  assert.equal(validateAgyLsAddress("127.0.0.1:49152"), "127.0.0.1:49152");
  assert.equal(validateAgyLsAddress("localhost:50051"), "localhost:50051");
  assert.equal(validateAgyLsAddress("[::1]:50051"), "[::1]:50051");
  assert.equal(validateAgyLsAddress("http://127.0.0.1:49152"), "http://127.0.0.1:49152");
  assert.equal(validateAgyLsAddress("https://localhost:49152"), "https://localhost:49152");
  assert.equal(validateAgyLsAddress("http://[::1]:49152"), "http://[::1]:49152");

  for (const bad of [
    "",
    "   ",
    "0.0.0.0:49152",
    "10.0.0.5:49152",
    "192.168.1.1:49152",
    "example.com:443",
    "http://evil.test:8080",
    "127.0.0.1",
    "127.0.0.1:0",
    "127.0.0.1:70000",
    "127.0.0.1:49152/path",
    "http://127.0.0.1:49152/path",
    "http://user:pass@127.0.0.1:49152",
    "127.0.0.1:49152?foo=1",
    "127.0.0.1:49152#frag",
    "127.0.0.1:49152\n",
    "127.0.0.1:49152\r",
    "127.0.0.1:49152\x00",
    "ftp://127.0.0.1:49152",
  ]) {
    assert.throws(() => validateAgyLsAddress(bad), { code: "agy_ls_address_invalid" }, `must reject ${JSON.stringify(bad)}`);
  }

  assert.equal(validateAgyCsrfToken(SECRET_CSRF), SECRET_CSRF);
  for (const badToken of ["", "   ", "tok\nen", "tok\ren", "tok en", "tok\ten", "tok\x00en", "x".repeat(513)]) {
    assert.throws(
      () => validateAgyCsrfToken(badToken),
      (err: { code?: string; message?: string }) =>
        err.code === "agy_csrf_token_invalid" && (!badToken || !String(err.message).includes(badToken)),
    );
  }

  const encoded = encodeURIComponent("tok/with+chars=1");
  assert.equal(
    redactAgySecrets(`failed with tok/with+chars=1 and ${encoded}`, "tok/with+chars=1"),
    "failed with [REDACTED] and [REDACTED]",
  );
});

test("experimental feature flag gates --provider agy --mode wake and reports wake_route: agy-agentapi, wake_verified: false", async () => {
  const fx = await createBoundProfile(CONV);
  try {
    const execution = { command: process.execPath, args: [CLI_PATH] };

    // Refuses wake without explicit --experimental-agy-agentapi opt-in.
    await assert.rejects(
      configureAgentReceive({
        profilePath: fx.profilePath,
        mode: "wake",
        provider: "agy",
        hostSessionId: CONV,
        cwd: fx.cwd,
        execution,
      }),
      { code: "agy_agentapi_experimental_flag_required" },
    );

    // Refuses --experimental-agy-agentapi in turn mode or on non-agy providers.
    await assert.rejects(
      configureAgentReceive({
        profilePath: fx.profilePath,
        mode: "turn",
        provider: "agy",
        hostSessionId: CONV,
        cwd: fx.cwd,
        experimentalAgyAgentapi: true,
        execution,
      }),
      { code: "experimental_agy_flag_requires_wake" },
    );
    await assert.rejects(
      configureAgentReceive({
        profilePath: fx.profilePath,
        mode: "wake",
        provider: "codex",
        hostSessionId: CONV,
        cwd: fx.cwd,
        experimentalAgyAgentapi: true,
        execution,
      }),
      { code: "experimental_agy_flag_unsupported" },
    );

    // Refuses mismatched session ID on host-bound profile.
    await assert.rejects(
      configureAgentReceive({
        profilePath: fx.profilePath,
        mode: "wake",
        provider: "agy",
        hostSessionId: "not-a-uuid",
        cwd: fx.cwd,
        experimentalAgyAgentapi: true,
        execution,
      }),
      { code: "profile_other_session" },
    );

    // Refuses non-UUID conversation ID even when profile is bound to that non-UUID ID.
    const nonUuidFx = await createBoundProfile("not-a-uuid");
    try {
      await assert.rejects(
        configureAgentReceive({
          profilePath: nonUuidFx.profilePath,
          mode: "wake",
          provider: "agy",
          hostSessionId: "not-a-uuid",
          cwd: nonUuidFx.cwd,
          experimentalAgyAgentapi: true,
          execution,
        }),
        { code: "agy_conversation_id_required" },
      );
    } finally {
      await nonUuidFx.cleanup();
    }

    // Explicit opt-in succeeds and reports wake_route: "agy-agentapi", wake_verified: false.
    const configured = await configureAgentReceive({
      profilePath: fx.profilePath,
      mode: "wake",
      provider: "agy",
      hostSessionId: CONV,
      cwd: fx.cwd,
      experimentalAgyAgentapi: true,
      execution,
    });
    assert.equal(configured.requested_mode, "wake");
    assert.equal(configured.effective_mode, "turn");
    assert.equal(configured.wake_route, "agy-agentapi");
    assert.equal(configured.wake_verified, false);
    assert.match(configured.host_step ?? "", /register-agy/);

    const binding = await readReceiveBinding(fx.profilePath, CONV);
    assert.ok(binding);
    assert.equal(binding.provider, "agy");
    assert.equal(binding.experimental_agy_agentapi, true);
    assert.equal(wakeRouteForBinding(binding), "agy-agentapi");
    const status = receiveStatus(binding, Date.now(), CONV, fx.profilePath);
    assert.equal(status.wake_route, "agy-agentapi");
    assert.equal(status.wake_verified, false);
  } finally {
    await fx?.cleanup();
  }
});

test("registerAgyWake enforces env-only 0600 storage, refuses turn/missing/other-provider bindings, and opt-out deletes 0600 file under shared lock", async () => {
  const fx = await createBoundProfile(CONV);
  try {
    const execution = { command: process.execPath, args: [CLI_PATH] };
    const regPath = agyRegistrationPath(fx.profilePath, CONV);

    // Refuses when no receive binding exists.
    await assert.rejects(
      registerAgyWake({
        profilePath: fx.profilePath,
        hostSessionId: CONV,
        env: { ANTIGRAVITY_LS_ADDRESS: LS_ADDR, ANTIGRAVITY_CSRF_TOKEN: SECRET_CSRF },
      }),
      { code: "receive_binding_missing" },
    );
    await assert.rejects(lstat(regPath), { code: "ENOENT" });

    // Refuses in turn mode and never writes 0600 file or mutates binding.
    await configureAgentReceive({
      profilePath: fx.profilePath,
      mode: "turn",
      provider: "agy",
      hostSessionId: CONV,
      cwd: fx.cwd,
      execution,
    });
    const beforeTurnBinding = await readReceiveBinding(fx.profilePath, CONV);
    await assert.rejects(
      registerAgyWake({
        profilePath: fx.profilePath,
        hostSessionId: CONV,
        env: { ANTIGRAVITY_LS_ADDRESS: LS_ADDR, ANTIGRAVITY_CSRF_TOKEN: SECRET_CSRF },
      }),
      { code: "wake_opted_out" },
    );
    await assert.rejects(lstat(regPath), { code: "ENOENT" });
    assert.deepEqual(await readReceiveBinding(fx.profilePath, CONV), beforeTurnBinding);

    // Opt into experimental agy wake -> register-agy succeeds via env only and never leaks CSRF token.
    await configureAgentReceive({
      profilePath: fx.profilePath,
      mode: "wake",
      provider: "agy",
      hostSessionId: CONV,
      cwd: fx.cwd,
      experimentalAgyAgentapi: true,
      execution,
    });
    const beforeWakeBinding = await readReceiveBinding(fx.profilePath, CONV);

    const registered = await registerAgyWake({
      profilePath: fx.profilePath,
      hostSessionId: CONV,
      env: { ANTIGRAVITY_LS_ADDRESS: LS_ADDR, ANTIGRAVITY_CSRF_TOKEN: SECRET_CSRF },
    });
    assert.equal(registered.registered, true);
    assert.equal(registered.wake_route, "agy-agentapi");
    assert.equal(registered.wake_verified, false);
    assert.equal(registered.ls_address, LS_ADDR);
    assert.equal(JSON.stringify(registered).includes(SECRET_CSRF), false, "register output must never leak CSRF token");
    assert.deepEqual(await readReceiveBinding(fx.profilePath, CONV), beforeWakeBinding, "register-agy must not mutate receive binding");

    // Verify 0600 file permissions and content.
    const stat = await lstat(regPath);
    assert.equal(stat.mode & 0o777, 0o600);
    const loaded = await readAgyRegistration(fx.profilePath, CONV);
    assert.ok(loaded);
    assert.equal(loaded.ls_address, LS_ADDR);
    assert.equal(loaded.csrf_token, SECRET_CSRF);
    assert.equal(loaded.host_session_id, CONV);

    // Lock serialization proof: hold receive-<scope> lock while register-agy waits, opt-out runs cleanly after.
    const lockName = `receive-${profileScopeKey(CONV)}`;
    const events: string[] = [];
    let releaseHolder!: () => void;
    const holderReady = new Promise<void>((res) => {
      void withFileLock(dirname(fx.profilePath), lockName, async () => {
        events.push("holder-acquired");
        res();
        await new Promise<void>((r) => { releaseHolder = r; });
        events.push("holder-releasing");
      });
    });
    await holderReady;

    const pendingRegister = registerAgyWake({
      profilePath: fx.profilePath,
      hostSessionId: CONV,
      env: { ANTIGRAVITY_LS_ADDRESS: "http://127.0.0.1:49153", ANTIGRAVITY_CSRF_TOKEN: SECRET_CSRF },
    }).then((r) => {
      events.push("register-finished");
      return r;
    });
    await delay(80);
    assert.deepEqual(events, ["holder-acquired"], "register-agy must block on shared receive-<scope> lock");
    releaseHolder();
    const reg2 = await pendingRegister;
    assert.equal(reg2.ls_address, "http://127.0.0.1:49153");
    assert.deepEqual(events, ["holder-acquired", "holder-releasing", "register-finished"]);

    // Switching to --mode turn deletes the 0600 registration file and resets wake_route to "none".
    const optedOut = await configureAgentReceive({
      profilePath: fx.profilePath,
      mode: "turn",
      provider: "agy",
      hostSessionId: CONV,
      cwd: fx.cwd,
      execution,
    });
    assert.equal(optedOut.requested_mode, "turn");
    assert.equal(optedOut.wake_route, "none");
    await assert.rejects(lstat(regPath), { code: "ENOENT" }, "opt-out must delete 0600 registration file");
    assert.equal(await readAgyRegistration(fx.profilePath, CONV), null);
  } finally {
    await fx?.cleanup();
  }
});

test("AgyAgentApiAdapter passes secrets strictly via child env (never argv), enforces fixed prompt, redacts CSRF token, and fails loudly on restarted LS", async () => {
  const fx = await createBoundProfile(CONV);
  try {
    const execution = { command: process.execPath, args: [CLI_PATH] };
    await configureAgentReceive({
      profilePath: fx.profilePath,
      mode: "wake",
      provider: "agy",
      hostSessionId: CONV,
      cwd: fx.cwd,
      experimentalAgyAgentapi: true,
      execution,
    });

    // Missing registration fails loudly (agy_not_registered).
    const calls: Array<{ executable: string; args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
    const adapter = new AgyAgentApiAdapter({
      profilePath: fx.profilePath,
      agyExecutable: "/usr/local/bin/agy-test",
      baseEnv: { PATH: process.env.PATH ?? "" },
      runner: async (executable, args, options) => {
        calls.push({ executable, args, env: options.env });
        return { stdout: "sent\n", stderr: "" };
      },
    });
    const unregistered = await adapter.sendWake({
      hostSessionId: CONV,
      prompt: formatNativeWakePrompt(1),
      batch: 1,
      cwd: fx.cwd,
    });
    assert.equal(unregistered.ok, false);
    if (!unregistered.ok) assert.equal(unregistered.code, "agy_not_registered");
    assert.equal(calls.length, 0);

    // Register via env, then verify exact argv + child env separation.
    await registerAgyWake({
      profilePath: fx.profilePath,
      hostSessionId: CONV,
      env: { ANTIGRAVITY_LS_ADDRESS: LS_ADDR, ANTIGRAVITY_CSRF_TOKEN: SECRET_CSRF },
    });

    // Refuses non-fixed prompt before touching subprocess.
    const unsafe = await adapter.sendWake({
      hostSessionId: CONV,
      prompt: "Untrusted teammate message text",
      batch: 1,
      cwd: fx.cwd,
    });
    assert.equal(unsafe.ok, false);
    if (!unsafe.ok) assert.equal(unsafe.code, "wake_prompt_unsafe");
    assert.equal(calls.length, 0);

    // Fixed prompt dispatches cleanly with secrets strictly in child env, never argv.
    const okResult = await adapter.sendWake({
      hostSessionId: CONV,
      prompt: formatNativeWakePrompt(1),
      batch: 1,
      cwd: fx.cwd,
    });
    assert.deepEqual(okResult, { ok: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.executable, "/usr/local/bin/agy-test");
    assert.deepEqual(calls[0]!.args, [
      "agentapi",
      "send-message",
      "--title=CommonSwarm",
      CONV,
      "New CommonSwarm messages (batch 1): run cswarm check",
    ]);
    assert.equal(calls[0]!.args.join(" ").includes(SECRET_CSRF), false, "CSRF token must NEVER appear in argv");
    assert.equal(calls[0]!.args.join(" ").includes(LS_ADDR), false, "LS address must NEVER appear in argv");
    assert.equal(calls[0]!.env.ANTIGRAVITY_LS_ADDRESS, LS_ADDR);
    assert.equal(calls[0]!.env.ANTIGRAVITY_CSRF_TOKEN, SECRET_CSRF);

    // Restarted / stale LS fails loudly with agy_ls_unreachable AND redacts CSRF token from error detail!
    const failingAdapter = new AgyAgentApiAdapter({
      profilePath: fx.profilePath,
      baseEnv: {},
      runner: async () => {
        const err = Object.assign(new Error(`dial tcp ${LS_ADDR}: connect: connection refused (token=${SECRET_CSRF})`), {
          stderr: `Error: ECONNREFUSED ${LS_ADDR} header x-csrf=${SECRET_CSRF}`,
        });
        throw err;
      },
    });
    const nowMs = 1_760_000_000_000;
    let clock = nowMs;
    const bridge = new NativeWakeBridge({
      profilePath: fx.profilePath,
      hostSessionId: CONV,
      cwd: fx.cwd,
      adapter: failingAdapter,
      expectedProvider: "agy",
      expectedSeat: { workspaceId: WS, principalId: AGENT },
      now: () => clock,
    });
    bridge.notifyArrival();
    clock += 6_000;
    const failedDecision = await bridge.tick();
    assert.equal(failedDecision.action, "error");
    if (failedDecision.action === "error") {
      assert.equal(failedDecision.code, "agy_ls_unreachable");
      assert.equal(failedDecision.detail.includes(SECRET_CSRF), false, "error detail must redact CSRF token");
      assert.match(failedDecision.detail, /\[REDACTED\]/);
    }
    const wakeState = await readNativeWakeState(fx.profilePath, CONV);
    assert.ok(wakeState);
    assert.equal(wakeState.route, "agy-agentapi");
    assert.equal((wakeState.last_error ?? "").includes(SECRET_CSRF), false, "wake-state.json must never store CSRF token");
  } finally {
    await fx?.cleanup();
  }
});

test("CLI cswarm receive configure + register-agy + receive status work end-to-end with zero secret echo", async () => {
  const fx = await createBoundProfile(CONV);
  try {
    const cleanEnv: NodeJS.ProcessEnv = { ...process.env, HOME: fx.home };
    delete cleanEnv.ANTIGRAVITY_LS_ADDRESS;
    delete cleanEnv.ANTIGRAVITY_CSRF_TOKEN;

    // Without --experimental-agy-agentapi -> exits non-zero.
    await assert.rejects(
      execFileAsync(process.execPath, [
        CLI_PATH, "receive", "configure",
        "--profile", fx.profilePath,
        "--host-session-id", CONV,
        "--provider", "agy",
        "--mode", "wake",
        "--cwd", fx.cwd,
        "--json",
      ], { env: cleanEnv }),
    );

    // With --experimental-agy-agentapi -> succeeds and reports wake_route: agy-agentapi, wake_verified: false.
    const cfgOut = await execFileAsync(process.execPath, [
      CLI_PATH, "receive", "configure",
      "--profile", fx.profilePath,
      "--host-session-id", CONV,
      "--provider", "agy",
      "--mode", "wake",
      "--experimental-agy-agentapi",
      "--cwd", fx.cwd,
      "--json",
    ], { env: cleanEnv });
    const cfgJson = JSON.parse(cfgOut.stdout);
    assert.equal(cfgJson.wake_route, "agy-agentapi");
    assert.equal(cfgJson.wake_verified, false);

    // register-agy reads ONLY from env and prints zero secret bytes.
    const regOut = await execFileAsync(process.execPath, [
      CLI_PATH, "receive", "register-agy",
      "--profile", fx.profilePath,
      "--host-session-id", CONV,
      "--json",
    ], {
      env: {
        ...cleanEnv,
        ANTIGRAVITY_LS_ADDRESS: LS_ADDR,
        ANTIGRAVITY_CSRF_TOKEN: SECRET_CSRF,
      },
    });
    assert.equal(regOut.stdout.includes(SECRET_CSRF), false);
    assert.equal(regOut.stderr.includes(SECRET_CSRF), false);
    const regJson = JSON.parse(regOut.stdout);
    assert.equal(regJson.registered, true);
    assert.equal(regJson.wake_route, "agy-agentapi");
    assert.equal(regJson.wake_verified, false);

    // receive status reports agy-agentapi and wake_verified: false until idle canary passes.
    const statusOut = await execFileAsync(process.execPath, [
      CLI_PATH, "receive", "status",
      "--profile", fx.profilePath,
      "--host-session-id", CONV,
      "--json",
    ], { env: cleanEnv });
    const statusJson = JSON.parse(statusOut.stdout);
    assert.equal(statusJson.wake_route, "agy-agentapi");
    assert.equal(statusJson.wake_verified, false);
  } finally {
    await fx?.cleanup();
  }
});

test("serveAgyWakeBridge + requestReceiveCanary + markAgyIdle + cswarm check verify wake_verified: true only after live idle canary", async () => {
  const signals: Array<Record<string, unknown>> = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      res.setHeader("Content-Type", "application/json");
      if (url.pathname === "/functions/v1/read" && body.resource === "members") {
        res.end(JSON.stringify({
          identity: {
            credential_valid: true,
            principal_id: AGENT,
            workspace_id: WS,
            owner_user_id: OWNER,
            workspace_name: "Test Workspace",
          },
          members: [{ user_id: OWNER, display_name: "Owner", role: "owner" }],
          agents: [{ principal_id: AGENT, name: "Agy Seat", owner_user_id: OWNER }],
        }));
        return;
      }
      if (url.pathname === "/functions/v1/read" && body.resource === "signals") {
        const afterAt = typeof body.after_created_at === "string" ? Date.parse(body.after_created_at) : -Infinity;
        const afterId = typeof body.after_id === "string" ? body.after_id : "";
        const filtered = signals.filter((s) => {
          const ts = Date.parse(String(s.created_at));
          return ts > afterAt || (ts === afterAt && String(s.id) > afterId);
        });
        res.end(JSON.stringify({
          signals: filtered,
          has_more: false,
          pending_delivery_count: filtered.length,
          capabilities: { cursor_after: 1, delivery_claim: 1, delivery_ack: 1, sender_owner_relation: 1 },
        }));
        return;
      }
      if (url.pathname === "/functions/v1/command" && body.command?.kind === "post_signal") {
        const created = {
          id: SIGNAL_1,
          workspace_id: WS,
          from: AGENT,
          from_kind: "agent",
          to: null,
          to_agent: AGENT,
          in_reply_to: null,
          about: null,
          kind: "note",
          body: body.command.body,
          attachments: [],
          until: new Date(Date.now() + 300_000).toISOString(),
          created_at: new Date().toISOString(),
          sender_owner_relation: "same_owner",
          channel_id: null,
          thread_root_id: null,
          audience: "private",
          recipients: [{ kind: "agent", id: AGENT, position: 0 }],
        };
        signals.push(created);
        res.end(JSON.stringify({ ok: true, status: "accepted", event_ids: [], events: [], signal: created }));
        return;
      }
      if (url.pathname === "/functions/v1/command") {
        res.end(JSON.stringify({ ok: true, status: "accepted", event_ids: [] }));
        return;
      }
      res.end(JSON.stringify({ grants: [] }));
    });
  });

  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  let fx: Awaited<ReturnType<typeof createBoundProfile>> | null = null;
  const abort = new AbortController();
  const dispatched: Array<{ hostSessionId: string; prompt: string; batch: number }> = [];
  let serveDone: Promise<void> | null = null;
  try {
    fx = await createBoundProfile(CONV, baseUrl);
    const execution = { command: process.execPath, args: [CLI_PATH] };
    await configureAgentReceive({
      profilePath: fx.profilePath,
      mode: "wake",
      provider: "agy",
      hostSessionId: CONV,
      cwd: fx.cwd,
      experimentalAgyAgentapi: true,
      execution,
    });
    await registerAgyWake({
      profilePath: fx.profilePath,
      hostSessionId: CONV,
      env: { ANTIGRAVITY_LS_ADDRESS: LS_ADDR, ANTIGRAVITY_CSRF_TOKEN: SECRET_CSRF },
    });

    const adapter = new AgyAgentApiAdapter({
      profilePath: fx.profilePath,
      runner: async (_exe, args, opts) => {
        assert.equal(opts.env.ANTIGRAVITY_LS_ADDRESS, LS_ADDR);
        assert.equal(opts.env.ANTIGRAVITY_CSRF_TOKEN, SECRET_CSRF);
        dispatched.push({ hostSessionId: args[3]!, prompt: args[4]!, batch: dispatched.length + 1 });
        return { stdout: "", stderr: "" };
      },
    });

    serveDone = serveAgyWakeBridge({
      profilePath: fx.profilePath,
      hostSessionId: CONV,
      adapter,
      debounceMs: 10,
      minIntervalMs: 10,
      pollMs: 50,
      heartbeatMs: 500,
      wake: {
        setTopic() {},
        noteClaim() {},
        noteWakeClaim() {},
        canClaimOnWake() { return true; },
        async next({ until, signal }: { until: number; signal?: AbortSignal }) {
          const ms = Math.max(0, until - Date.now());
          await delay(Math.min(ms, 25), undefined, { signal }).catch(() => undefined);
          return "deadline" as const;
        },
        async close() {},
      } as unknown as WakeHandle,
      signal: abort.signal,
    });

    // Wait for channel_running = true.
    for (let i = 0; i < 40; i++) {
      const b = await readReceiveBinding(fx.profilePath, CONV);
      if (receiveStatus(b).channel_running) break;
      await delay(50);
    }
    const liveBeforeCanary = receiveStatus(await readReceiveBinding(fx.profilePath, CONV));
    assert.equal(liveBeforeCanary.channel_running, true);
    assert.equal(liveBeforeCanary.wake_route, "agy-agentapi");
    assert.equal(liveBeforeCanary.wake_verified, false);

    // Request canary + declare idle -> bridge posts canary and dispatches fixed-text wake via AgyAgentApiAdapter!
    await requestReceiveCanary(fx.profilePath, CONV);
    await markAgyIdle(fx.profilePath, CONV);

    for (let i = 0; i < 60; i++) {
      if (dispatched.length > 0) break;
      await delay(50);
    }
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0]!.hostSessionId, CONV);
    assert.equal(dispatched[0]!.prompt, "New CommonSwarm messages (batch 1): run cswarm check");

    // Still unverified until cswarm check surfaces the canary signal!
    assert.equal(receiveStatus(await readReceiveBinding(fx.profilePath, CONV)).wake_verified, false);

    // Simulate the woken agy session running cswarm check -> acknowledges wake and sets wake_verified: true!
    const checked = await checkAgentMessages({
      profilePath: fx.profilePath,
      hostSessionId: CONV,
      present: async () => {},
    });
    assert.equal(checked.messages.some((m) => m.id === SIGNAL_1), true);
    const verifiedStatus = receiveStatus(await readReceiveBinding(fx.profilePath, CONV));
    assert.equal(verifiedStatus.wake_route, "agy-agentapi");
    assert.equal(verifiedStatus.wake_verified, true);
    assert.equal(verifiedStatus.effective_mode, "wake");

    // Verify wrong conversation ID is rejected by resolveAuthorizedWakeBinding.
    const wrongConvAuth = await resolveAuthorizedWakeBinding({
      profilePath: fx.profilePath,
      hostSessionId: OTHER_CONV,
      expectedProvider: "agy",
    });
    assert.equal(wrongConvAuth.ok, false);
  } finally {
    abort.abort();
    await serveDone?.catch(() => undefined);
    server.closeAllConnections();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await fx?.cleanup();
  }
});

test("validateAgyAgentApiExecutable rejects unsafe paths, captures valid ANTIGRAVITY_AGENTAPI_EXE, and concurrent opt-out serializes with wake dispatch", async () => {
  const fx = await createBoundProfile(CONV);
  try {
    const execution = { command: process.execPath, args: [CLI_PATH] };
    await configureAgentReceive({
      profilePath: fx.profilePath,
      mode: "wake",
      provider: "agy",
      hostSessionId: CONV,
      cwd: fx.cwd,
      experimentalAgyAgentapi: true,
      execution,
    });

    // Reject relative path, non-agy basename, control chars, and world-writable executable.
    await assert.rejects(() => validateAgyAgentApiExecutable("agy"), { code: "agy_executable_invalid" });
    await assert.rejects(() => validateAgyAgentApiExecutable("/bin/sh"), { code: "agy_executable_invalid" });
    await assert.rejects(() => validateAgyAgentApiExecutable("/usr/bin/agy\n"), { code: "agy_executable_invalid" });

    const binDir = join(fx.dir, "bin");
    await mkdir(binDir, { recursive: true, mode: 0o700 });
    const fakeBin = join(binDir, "antigravity");
    await writeFile(fakeBin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await chmod(fakeBin, 0o777);
    await assert.rejects(() => validateAgyAgentApiExecutable(fakeBin), { code: "agy_executable_invalid" });

    await chmod(fakeBin, 0o755);
    const resolvedBin = await validateAgyAgentApiExecutable(fakeBin);
    assert.ok(resolvedBin.endsWith("/antigravity"));

    // registerAgyWake stores validated ANTIGRAVITY_AGENTAPI_EXE; adapter uses it without explicit override.
    await registerAgyWake({
      profilePath: fx.profilePath,
      hostSessionId: CONV,
      env: {
        ANTIGRAVITY_LS_ADDRESS: LS_ADDR,
        ANTIGRAVITY_CSRF_TOKEN: SECRET_CSRF,
        ANTIGRAVITY_AGENTAPI_EXE: fakeBin,
      },
    });
    const loaded = await readAgyRegistration(fx.profilePath, CONV);
    assert.equal(loaded?.agentapi_exe, resolvedBin);

    const usedExecutables: string[] = [];
    const autoAdapter = new AgyAgentApiAdapter({
      profilePath: fx.profilePath,
      baseEnv: {},
      runner: async (exe, _args, opts) => {
        usedExecutables.push(exe);
        assert.equal(opts.env.CMUX_ANTIGRAVITY_HOOKS_DISABLED, "1");
        assert.equal(opts.env.ANTIGRAVITY_LS_ADDRESS, LS_ADDR);
        assert.equal(opts.env.ANTIGRAVITY_CSRF_TOKEN, SECRET_CSRF);
        return { stdout: "", stderr: "" };
      },
    });
    const ok = await autoAdapter.sendWake({
      hostSessionId: CONV,
      prompt: formatNativeWakePrompt(1),
      batch: 1,
      cwd: fx.cwd,
    });
    assert.deepEqual(ok, { ok: true });
    assert.deepEqual(usedExecutables, [resolvedBin]);

    // If the registered executable is later made world-writable, dispatch fails closed!
    await chmod(fakeBin, 0o777);
    const tampered = await autoAdapter.sendWake({
      hostSessionId: CONV,
      prompt: formatNativeWakePrompt(1),
      batch: 1,
      cwd: fx.cwd,
    });
    assert.equal(tampered.ok, false);
    if (!tampered.ok) assert.equal(tampered.code, "agy_executable_invalid");
    await chmod(fakeBin, 0o755);

    // Concurrent opt-out (--mode turn) vs NativeWakeBridge dispatch serialize under receive-<scope> lock:
    // opt-out waits for in-flight dispatch to release lock, deletes 0600 registration, and next tick refuses dispatch!
    let dispatchStarted!: () => void;
    let releaseDispatch!: () => void;
    const dispatchStartedPromise = new Promise<void>((r) => { dispatchStarted = r; });
    const releaseDispatchPromise = new Promise<void>((r) => { releaseDispatch = r; });
    const blockingAdapter = new AgyAgentApiAdapter({
      profilePath: fx.profilePath,
      baseEnv: {},
      runner: async () => {
        dispatchStarted();
        await releaseDispatchPromise;
        return { stdout: "", stderr: "" };
      },
    });
    let clock = 1_760_000_000_000;
    const bridge = new NativeWakeBridge({
      profilePath: fx.profilePath,
      hostSessionId: CONV,
      cwd: fx.cwd,
      adapter: blockingAdapter,
      expectedProvider: "agy",
      expectedSeat: { workspaceId: WS, principalId: AGENT },
      now: () => clock,
    });
    bridge.notifyArrival();
    clock += 6_000;
    const tick1Promise = bridge.tick();
    await dispatchStartedPromise;

    let optOutFinished = false;
    const optOutPromise = configureAgentReceive({
      profilePath: fx.profilePath,
      mode: "turn",
      provider: "agy",
      hostSessionId: CONV,
      cwd: fx.cwd,
      execution,
    }).then((res) => {
      optOutFinished = true;
      return res;
    });
    await delay(80);
    assert.equal(optOutFinished, false, "opt-out must wait while in-flight agy wake dispatch holds receive-<scope> lock");
    releaseDispatch();

    const [tick1, optOut] = await Promise.all([tick1Promise, optOutPromise]);
    assert.equal(tick1.action, "sent");
    assert.equal(optOut.requested_mode, "turn");
    assert.equal(await readAgyRegistration(fx.profilePath, CONV), null);

    // Subsequent arrival after opt-out MUST NOT dispatch!
    bridge.notifyArrival();
    clock += 130_000;
    const tick2 = await bridge.tick();
    assert.equal(tick2.action, "binding_inactive");
  } finally {
    await fx?.cleanup();
  }
});
