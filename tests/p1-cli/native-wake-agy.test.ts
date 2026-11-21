import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { AGENT_CREDENTIAL_MESSAGE_D088 } from "../../src/cloud/agent-credential-input.js";
import { checkAgentMessages } from "../../src/cloud/agent-check.js";
import { parseAgentConnection, profileScopeKey, saveAgentProfile } from "../../src/cloud/agent-profile.js";
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
  buildMinimalAgyChildEnv,
  markAgyIdle,
  parseAgyInputAddress,
  readAgyCredentialsFromFile,
  readAgyRegistration,
  registerAgyWake,
  serveAgyWakeBridge,
  validateAgyAgentApiExecutable,
  validateAgyCsrfToken,
  validateCanonicalAgyLsAddress,
  type AgyAgentApiRunner,
  type AgyEndpointInspector,
  type AgyLoopbackEndpoint,
} from "../../src/cloud/native-wake-agy.js";
import { withFileLock } from "../../src/cloud/storage.js";
import type { WakeHandle } from "../../src/listener/wake.js";

const execFileAsync = promisify(execFile);

const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWNER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CONV = "f2f34cfa-137e-4308-85d8-1aa68b02aff9";
const OTHER_CONV = "f2f34cfa-137e-4308-85d8-1aa68b02affa";
const SIGNAL_1 = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1";
const TOKEN = `swm_agt_${"A".repeat(43)}`;
const SECRET_CSRF = "csrf-super-secret-token-9f8e7d6c5b4a";
const CANONICAL_LS = "127.0.0.1:49152";
const SELF_UID = typeof process.getuid === "function" ? process.getuid() : 0;
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

/** Pick a non-world-writable base dir for fixture executables (Linux /tmp is 01777). */
function safeExecBaseDir(): string {
  const candidates = [process.env.RUNNER_TEMP, tmpdir(), dirname(process.cwd())].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
  for (const base of candidates) {
    try {
      let cur = resolve(base);
      let ok = true;
      for (;;) {
        const info = statSync(cur);
        if (!info.isDirectory() || (info.mode & 0o002) !== 0) {
          ok = false;
          break;
        }
        const parent = dirname(cur);
        if (parent === cur) break;
        cur = parent;
      }
      if (ok) return base;
    } catch { /* try next */ }
  }
  return dirname(process.cwd());
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

  const execRoot = await mkdtemp(join(safeExecBaseDir(), "cswarm-agy-bin-"));
  await chmod(execRoot, 0o700);
  const fakeBin = join(execRoot, "antigravity");
  await writeFile(fakeBin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const pinnedBin = await realpath(fakeBin);

  const realCwd = await realpath(cwd);
  return {
    dir,
    home,
    cwd: realCwd,
    profilePath,
    execRoot,
    pinnedBin,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
      await rm(execRoot, { recursive: true, force: true });
    },
  };
}

function makeEndpoint(pinnedBin: string, overrides: Partial<AgyLoopbackEndpoint> = {}): AgyLoopbackEndpoint {
  return {
    canonical_address: CANONICAL_LS,
    pid: 42424,
    uid: SELF_UID,
    start_time: "Fri Nov 20 14:39:44 2026",
    executable: pinnedBin,
    ...overrides,
  };
}

function makeInspector(endpoint: AgyLoopbackEndpoint | null): AgyEndpointInspector {
  return async () => endpoint;
}

function makeMetadataJson(workspaceDirs: readonly string[]): string {
  return JSON.stringify({
    response: {
      conversationMetadata: {
        metadata: {
          workspaces: workspaceDirs.map((dir) => ({
            workspaceFolderAbsoluteUri: pathToFileURL(dir).href,
          })),
        },
      },
    },
  });
}

function makeSessionRunner(
  workspaceDirs: readonly string[],
  onCall?: (call: { executable: string; args: readonly string[]; env: NodeJS.ProcessEnv }) => void,
): AgyAgentApiRunner {
  return async (executable, args, options) => {
    onCall?.({ executable, args, env: options.env });
    if (args[0] === "agentapi" && args[1] === "get-conversation-metadata") {
      return { stdout: makeMetadataJson(workspaceDirs), stderr: "" };
    }
    return { stdout: JSON.stringify({ response: {} }), stderr: "" };
  };
}

test("C1 & C2 validation: canonical IP literal only, stripped child env, full ancestor executable trust walk", async () => {
  assert.deepEqual(parseAgyInputAddress("127.0.0.1:49152"), { host: "127.0.0.1", port: 49152 });
  assert.deepEqual(parseAgyInputAddress("localhost:50051"), { host: "localhost", port: 50051 });
  assert.deepEqual(parseAgyInputAddress("[::1]:50051"), { host: "::1", port: 50051 });
  assert.deepEqual(parseAgyInputAddress("http://127.0.0.1:49152"), { host: "127.0.0.1", port: 49152 });

  for (const bad of [
    "",
    "   ",
    "0.0.0.0:49152",
    "10.0.0.5:49152",
    "example.com:443",
    "https://127.0.0.1:49152",
    "127.0.0.1",
    "127.0.0.1:0",
    "127.0.0.1:70000",
    "127.0.0.1:49152/path",
    "http://user:pass@127.0.0.1:49152",
    "127.0.0.1:49152?foo=1",
    "127.0.0.1:49152#frag",
    "127.0.0.1:49152\n",
  ]) {
    assert.throws(() => parseAgyInputAddress(bad), { code: "agy_ls_address_invalid" }, `must reject ${JSON.stringify(bad)}`);
  }

  // Canonical validator accepts ONLY loopback IP literals — NEVER hostnames or URL schemes!
  assert.deepEqual(validateCanonicalAgyLsAddress("127.0.0.1:49152"), {
    canonical: "127.0.0.1:49152",
    host: "127.0.0.1",
    port: 49152,
  });
  assert.deepEqual(validateCanonicalAgyLsAddress("[::1]:49152"), {
    canonical: "[::1]:49152",
    host: "::1",
    port: 49152,
  });
  for (const nonCanonical of ["localhost:49152", "http://127.0.0.1:49152", "0.0.0.0:49152", "127.0.0.1:0"]) {
    assert.throws(() => validateCanonicalAgyLsAddress(nonCanonical), { code: "agy_ls_address_invalid" });
  }

  // CSRF token validation never leaks raw token.
  assert.equal(validateAgyCsrfToken(SECRET_CSRF), SECRET_CSRF);
  for (const badToken of ["", "   ", "tok\nen", "tok\ren", "tok en", "tok\x00en", "x".repeat(513)]) {
    assert.throws(
      () => validateAgyCsrfToken(badToken),
      (err: { code?: string; message?: string }) =>
        err.code === "agy_csrf_token_invalid" && (!badToken || !String(err.message).includes(badToken)),
    );
  }

  // Minimal stripped child env excludes ambient credentials, PATH, and disables proxies.
  const childEnv = buildMinimalAgyChildEnv(CANONICAL_LS, SECRET_CSRF);
  assert.equal(childEnv.ANTIGRAVITY_LS_ADDRESS, CANONICAL_LS);
  assert.equal(childEnv.ANTIGRAVITY_CSRF_TOKEN, SECRET_CSRF);
  assert.equal(childEnv.NO_PROXY, "*");
  assert.equal(childEnv.HTTP_PROXY, "");
  assert.equal(childEnv.HTTPS_PROXY, "");
  assert.equal(childEnv.ALL_PROXY, "");
  assert.equal(childEnv.PATH, undefined, "stripped child env must not inherit PATH");
  assert.equal(childEnv.CSWARM_AGENT_TOKEN, undefined);

  // Full ancestor trust walk: rejects relative names, non-agy binaries, world-writable leaf, AND world-writable ancestor dir!
  const fx = await createBoundProfile(CONV);
  try {
    await assert.rejects(() => validateAgyAgentApiExecutable("agy"), { code: "agy_executable_invalid" });
    await assert.rejects(() => validateAgyAgentApiExecutable("/bin/sh"), { code: "agy_executable_invalid" });
    assert.equal(await validateAgyAgentApiExecutable(fx.pinnedBin), fx.pinnedBin);

    // World-writable leaf refused.
    await chmod(fx.pinnedBin, 0o777);
    await assert.rejects(() => validateAgyAgentApiExecutable(fx.pinnedBin), { code: "agy_executable_invalid" });
    await chmod(fx.pinnedBin, 0o755);

    // World-writable ancestor directory refused even when leaf is 0o755!
    const badParent = join(fx.execRoot, "world-writable-dir");
    await mkdir(badParent, { mode: 0o755 });
    const nestedBin = join(badParent, "antigravity");
    await writeFile(nestedBin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await chmod(badParent, 0o777);
    await assert.rejects(() => validateAgyAgentApiExecutable(nestedBin), { code: "agy_executable_invalid" });
    await chmod(badParent, 0o755);
  } finally {
    await fx.cleanup();
  }
});

test("experimental feature flag gates --provider agy --mode wake and reports wake_route: agy-agentapi, wake_verified: false", async () => {
  const fx = await createBoundProfile(CONV);
  try {
    const execution = { command: process.execPath, args: [CLI_PATH] };

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
    assert.equal(wakeRouteForBinding(await readReceiveBinding(fx.profilePath, CONV)), "agy-agentapi");
  } finally {
    await fx.cleanup();
  }
});

test("C1 witness: registration accepts ONLY 0600 file or stdin (never env), never prints ls_address or csrf_token, and serializes under receive lock", async () => {
  const fx = await createBoundProfile(CONV);
  try {
    const execution = { command: process.execPath, args: [CLI_PATH] };
    const regPath = agyRegistrationPath(fx.profilePath, CONV);
    const endpoint = makeEndpoint(fx.pinnedBin);
    const inspector = makeInspector(endpoint);
    const runner = makeSessionRunner([fx.cwd]);

    await configureAgentReceive({
      profilePath: fx.profilePath,
      mode: "wake",
      provider: "agy",
      hostSessionId: CONV,
      cwd: fx.cwd,
      experimentalAgyAgentapi: true,
      execution,
    });

    // Refuses when neither --credentials-file nor stdin is provided (NEVER falls back to process.env).
    const prevAddr = process.env.ANTIGRAVITY_LS_ADDRESS;
    const prevCsrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
    process.env.ANTIGRAVITY_LS_ADDRESS = CANONICAL_LS;
    process.env.ANTIGRAVITY_CSRF_TOKEN = SECRET_CSRF;
    try {
      await assert.rejects(
        registerAgyWake({
          profilePath: fx.profilePath,
          hostSessionId: CONV,
          endpointInspector: inspector,
          runner,
        }),
        { code: "agy_credentials_input_required" },
      );
    } finally {
      if (prevAddr === undefined) delete process.env.ANTIGRAVITY_LS_ADDRESS;
      else process.env.ANTIGRAVITY_LS_ADDRESS = prevAddr;
      if (prevCsrf === undefined) delete process.env.ANTIGRAVITY_CSRF_TOKEN;
      else process.env.ANTIGRAVITY_CSRF_TOKEN = prevCsrf;
    }
    await assert.rejects(lstat(regPath), { code: "ENOENT" });

    // Refuses non-0600 file and symlink for --credentials-file.
    const credsFile = join(fx.dir, "agy-creds.json");
    await writeFile(credsFile, JSON.stringify({ ls_address: "localhost:49152", csrf_token: SECRET_CSRF }), { mode: 0o644 });
    await chmod(credsFile, 0o644);
    await assert.rejects(() => readAgyCredentialsFromFile(credsFile), { code: "agy_credentials_file_unsafe" });

    await chmod(credsFile, 0o600);
    const credsLink = join(fx.dir, "agy-creds-link.json");
    await symlink(credsFile, credsLink);
    await assert.rejects(() => readAgyCredentialsFromFile(credsLink), { code: "agy_credentials_file_unsafe" });

    // Valid 0600 --credentials-file succeeds, canonicalizes localhost -> 127.0.0.1, pins executable + pid/lstart,
    // and NEVER prints ls_address or csrf_token in return output!
    const beforeBinding = await readReceiveBinding(fx.profilePath, CONV);
    const registered = await registerAgyWake({
      profilePath: fx.profilePath,
      hostSessionId: CONV,
      credentialsFile: credsFile,
      endpointInspector: inspector,
      runner,
    });
    const serialized = JSON.stringify(registered);
    assert.equal(registered.registered, true);
    assert.equal(registered.wake_route, "agy-agentapi");
    assert.equal(registered.wake_verified, false);
    assert.equal("ls_address" in registered, false, "registration output must never expose ls_address");
    assert.equal(serialized.includes(CANONICAL_LS), false, "registration output must never contain canonical LS address");
    assert.equal(serialized.includes("localhost:49152"), false, "registration output must never contain input LS address");
    assert.equal(serialized.includes(SECRET_CSRF), false, "registration output must never contain CSRF token");
    assert.deepEqual(await readReceiveBinding(fx.profilePath, CONV), beforeBinding, "register-agy must not mutate receive binding");

    // 0600 file stores canonical IP literal + listening process metadata + pinned executable.
    const regStat = await lstat(regPath);
    assert.equal(regStat.mode & 0o777, 0o600);
    const loaded = await readAgyRegistration(fx.profilePath, CONV);
    assert.ok(loaded);
    assert.equal(loaded.ls_address, CANONICAL_LS);
    assert.equal(loaded.ls_pid, endpoint.pid);
    assert.equal(loaded.ls_uid, SELF_UID);
    assert.equal(loaded.ls_start_time, endpoint.start_time);
    assert.equal(loaded.agentapi_exe, fx.pinnedBin);
    assert.equal(loaded.csrf_token, SECRET_CSRF);

    // Stdin registration also works and blocks on the shared receive-<scope> lock.
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

    const stdinStream = Readable.from([JSON.stringify({ ls_address: CANONICAL_LS, csrf_token: SECRET_CSRF })]);
    const pendingReg = registerAgyWake({
      profilePath: fx.profilePath,
      hostSessionId: CONV,
      stdin: stdinStream,
      endpointInspector: inspector,
      runner,
    }).then((r) => {
      events.push("register-finished");
      return r;
    });
    await delay(80);
    assert.deepEqual(events, ["holder-acquired"], "register-agy must wait on receive-<scope> lock");
    releaseHolder();
    await pendingReg;
    assert.deepEqual(events, ["holder-acquired", "holder-releasing", "register-finished"]);
  } finally {
    await fx.cleanup();
  }
});

test("C2 witness: binds registration to provider session evidence, refuses different live session and replaced endpoint before presenting credentials, and keeps error/wake-state diagnostics secret- and address-free", async () => {
  const fx = await createBoundProfile(CONV);
  try {
    const execution = { command: process.execPath, args: [CLI_PATH] };
    const endpoint = makeEndpoint(fx.pinnedBin);
    const regPath = agyRegistrationPath(fx.profilePath, CONV);

    await configureAgentReceive({
      profilePath: fx.profilePath,
      mode: "wake",
      provider: "agy",
      hostSessionId: CONV,
      cwd: fx.cwd,
      experimentalAgyAgentapi: true,
      execution,
    });

    // 1. Registration refuses when provider metadata belongs to a DIFFERENT workspace/session!
    await assert.rejects(
      registerAgyWake({
        profilePath: fx.profilePath,
        hostSessionId: CONV,
        credentialsJson: JSON.stringify({ ls_address: CANONICAL_LS, csrf_token: SECRET_CSRF }),
        endpointInspector: makeInspector(endpoint),
        runner: makeSessionRunner(["/some/other/unrelated/workspace"]),
      }),
      { code: "agy_session_mismatch" },
    );
    await assert.rejects(lstat(regPath), { code: "ENOENT" });

    // 2. Registration refuses when LS reports trajectory not found (different live session).
    await assert.rejects(
      registerAgyWake({
        profilePath: fx.profilePath,
        hostSessionId: CONV,
        credentialsJson: JSON.stringify({ ls_address: CANONICAL_LS, csrf_token: SECRET_CSRF }),
        endpointInspector: makeInspector(endpoint),
        runner: async () => ({
          stdout: JSON.stringify({ response: {}, error: "rpc error: code = NotFound desc = trajectory not found" }),
          stderr: "",
        }),
      }),
      { code: "agy_session_mismatch" },
    );
    await assert.rejects(lstat(regPath), { code: "ENOENT" });

    // 3. Valid registration succeeds with matching provider session evidence.
    await registerAgyWake({
      profilePath: fx.profilePath,
      hostSessionId: CONV,
      credentialsJson: JSON.stringify({ ls_address: "localhost:49152", csrf_token: SECRET_CSRF }),
      endpointInspector: makeInspector(endpoint),
      runner: makeSessionRunner([fx.cwd]),
    });

    // 4. REPLACED ENDPOINT WITNESS: a different process (new PID or start_time) listening on the
    //    EXACT same canonical port 127.0.0.1:49152 is REFUSED BEFORE presenting CSRF token (0 runner calls)!
    const replacedCalls: string[] = [];
    const replacedAdapter = new AgyAgentApiAdapter({
      profilePath: fx.profilePath,
      endpointInspector: makeInspector({ ...endpoint, pid: endpoint.pid + 1 }),
      runner: async (_exe, args) => {
        replacedCalls.push(args.join(" "));
        return { stdout: "", stderr: "" };
      },
    });
    const replacedResult = await replacedAdapter.sendWake({
      hostSessionId: CONV,
      prompt: formatNativeWakePrompt(1),
      batch: 1,
      cwd: fx.cwd,
    });
    assert.equal(replacedResult.ok, false);
    if (!replacedResult.ok) {
      assert.equal(replacedResult.code, "agy_endpoint_mismatch");
      assert.equal(replacedResult.detail.includes(CANONICAL_LS), false);
      assert.equal(replacedResult.detail.includes(SECRET_CSRF), false);
    }
    assert.equal(replacedCalls.length, 0, "CSRF token must NEVER be presented to a replaced endpoint on a reused port");

    // 5. DIFFERENT LIVE SESSION WITNESS: same LS process, but get-conversation-metadata shows a different
    //    workspace -> refused with agy_session_mismatch and send-message is NEVER invoked!
    const sessionCalls: string[][] = [];
    const wrongSessionAdapter = new AgyAgentApiAdapter({
      profilePath: fx.profilePath,
      endpointInspector: makeInspector(endpoint),
      runner: makeSessionRunner(["/unrelated/session/workspace"], ({ args }) => {
        sessionCalls.push([...args]);
      }),
    });
    const wrongSessionRes = await wrongSessionAdapter.sendWake({
      hostSessionId: CONV,
      prompt: formatNativeWakePrompt(1),
      batch: 1,
      cwd: fx.cwd,
    });
    assert.equal(wrongSessionRes.ok, false);
    if (!wrongSessionRes.ok) assert.equal(wrongSessionRes.code, "agy_session_mismatch");
    assert.equal(sessionCalls.length, 1);
    assert.equal(sessionCalls[0]![1], "get-conversation-metadata");
    assert.equal(sessionCalls.some((c) => c[1] === "send-message"), false, "send-message must never run on mismatched session");

    // 6. POSITIVE DISPATCH: pinned binary, stripped child env (NO_PROXY=*, no PATH, no ambient creds), canonical IP literal!
    const okCalls: Array<{ executable: string; args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
    const okAdapter = new AgyAgentApiAdapter({
      profilePath: fx.profilePath,
      endpointInspector: makeInspector(endpoint),
      runner: makeSessionRunner([fx.cwd], (c) => okCalls.push(c)),
    });
    const okRes = await okAdapter.sendWake({
      hostSessionId: CONV,
      prompt: formatNativeWakePrompt(1),
      batch: 1,
      cwd: fx.cwd,
    });
    assert.deepEqual(okRes, { ok: true });
    assert.equal(okCalls.length, 2);
    assert.equal(okCalls[0]!.executable, fx.pinnedBin);
    assert.deepEqual(okCalls[0]!.args, ["agentapi", "get-conversation-metadata", CONV]);
    assert.equal(okCalls[1]!.executable, fx.pinnedBin);
    assert.deepEqual(okCalls[1]!.args, [
      "agentapi",
      "send-message",
      "--title=CommonSwarm",
      CONV,
      "New CommonSwarm messages (batch 1): run cswarm check",
    ]);
    assert.equal(okCalls[1]!.args.join(" ").includes(SECRET_CSRF), false);
    assert.equal(okCalls[1]!.args.join(" ").includes(CANONICAL_LS), false);
    assert.equal(okCalls[1]!.env.ANTIGRAVITY_LS_ADDRESS, CANONICAL_LS);
    assert.equal(okCalls[1]!.env.ANTIGRAVITY_CSRF_TOKEN, SECRET_CSRF);
    assert.equal(okCalls[1]!.env.PATH, undefined);
    assert.equal(okCalls[1]!.env.NO_PROXY, "*");
    assert.equal(okCalls[1]!.env.HTTP_PROXY, "");

    // 7. NON-DISCLOSURE ON FAILURE: raw subprocess stderr containing ls_address + csrf_token is NEVER copied
    //    into decision.detail OR wake-state.json (fixed static diagnostics only)!
    const leakyRunner: AgyAgentApiRunner = async (_exe, args) => {
      if (args[1] === "get-conversation-metadata") {
        return { stdout: makeMetadataJson([fx.cwd]), stderr: "" };
      }
      const err = Object.assign(new Error(`dial tcp ${CANONICAL_LS}: connection refused token=${SECRET_CSRF}`), {
        stderr: `rpc error: ECONNREFUSED ${CANONICAL_LS} x-csrf=${SECRET_CSRF} OPAQUE_STDERR_MARKER`,
      });
      throw err;
    };
    let clock = 1_760_000_000_000;
    const bridge = new NativeWakeBridge({
      profilePath: fx.profilePath,
      hostSessionId: CONV,
      cwd: fx.cwd,
      adapter: new AgyAgentApiAdapter({
        profilePath: fx.profilePath,
        endpointInspector: makeInspector(endpoint),
        runner: leakyRunner,
      }),
      expectedProvider: "agy",
      expectedSeat: { workspaceId: WS, principalId: AGENT },
      now: () => clock,
    });
    bridge.notifyArrival();
    clock += 6_000;
    const failDecision = await bridge.tick();
    assert.equal(failDecision.action, "error");
    if (failDecision.action === "error") {
      assert.equal(failDecision.code, "agy_ls_unreachable");
      assert.equal(failDecision.detail.includes(SECRET_CSRF), false);
      assert.equal(failDecision.detail.includes(CANONICAL_LS), false);
      assert.equal(failDecision.detail.includes("OPAQUE_STDERR_MARKER"), false);
    }
    const wakeState = await readNativeWakeState(fx.profilePath, CONV);
    assert.ok(wakeState);
    const stateJson = JSON.stringify(wakeState);
    assert.equal(stateJson.includes(SECRET_CSRF), false, "wake-state.json must never contain CSRF token");
    assert.equal(stateJson.includes(CANONICAL_LS), false, "wake-state.json must never contain LS address");
    assert.equal(stateJson.includes("OPAQUE_STDERR_MARKER"), false, "wake-state.json must never contain raw stderr");
  } finally {
    await fx.cleanup();
  }
});

test("C3 witness: opt-out persists --mode turn even when credential cleanup fails, and bridge startup held across opt-out never writes a runtime marker", async () => {
  // Part A: Refused delete witness (durable opt-out before cleanup + explicit cleanup failure report).
  const fxA = await createBoundProfile(CONV);
  try {
    const execution = { command: process.execPath, args: [CLI_PATH] };
    const endpoint = makeEndpoint(fxA.pinnedBin);
    await configureAgentReceive({
      profilePath: fxA.profilePath,
      mode: "wake",
      provider: "agy",
      hostSessionId: CONV,
      cwd: fxA.cwd,
      experimentalAgyAgentapi: true,
      execution,
    });
    await registerAgyWake({
      profilePath: fxA.profilePath,
      hostSessionId: CONV,
      credentialsJson: JSON.stringify({ ls_address: CANONICAL_LS, csrf_token: SECRET_CSRF }),
      endpointInspector: makeInspector(endpoint),
      runner: makeSessionRunner([fxA.cwd]),
    });

    // Replace wake-agy-<scope>.json with a directory so deleteSecureJsonFile fails on opt-out.
    const regPath = agyRegistrationPath(fxA.profilePath, CONV);
    await rm(regPath, { force: true });
    await mkdir(regPath, { mode: 0o700 });
    await writeFile(join(regPath, "blocker"), "x", { mode: 0o600 });

    await assert.rejects(
      configureAgentReceive({
        profilePath: fxA.profilePath,
        mode: "turn",
        provider: "agy",
        hostSessionId: CONV,
        cwd: fxA.cwd,
        execution,
      }),
      { code: "agy_registration_cleanup_failed" },
    );

    // Even though cleanup threw, turn mode MUST already be durably persisted!
    const bindingAfter = await readReceiveBinding(fxA.profilePath, CONV);
    assert.ok(bindingAfter);
    assert.equal(bindingAfter.requested_mode, "turn");
    assert.equal(bindingAfter.experimental_agy_agentapi, false);
    assert.equal(wakeRouteForBinding(bindingAfter), "none");
    const authAfter = await resolveAuthorizedWakeBinding({
      profilePath: fxA.profilePath,
      hostSessionId: CONV,
      expectedProvider: "agy",
    });
    assert.equal(authAfter.ok, false);
    if (!authAfter.ok) assert.equal(authAfter.code, "wake_opted_out");
  } finally {
    await fxA.cleanup();
  }

  // Part B: Startup held across opt-out witness (bridge startup checks live route under receive-<scope> lock).
  let releaseDirectoryFetch!: () => void;
  let directoryFetchReached!: () => void;
  const dirReachedPromise = new Promise<void>((r) => { directoryFetchReached = r; });
  const dirReleasePromise = new Promise<void>((r) => { releaseDirectoryFetch = r; });

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      res.setHeader("Content-Type", "application/json");
      if (url.pathname === "/functions/v1/read" && body.resource === "members") {
        directoryFetchReached();
        await dirReleasePromise;
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
      res.end(JSON.stringify({ signals: [], has_more: false, pending_delivery_count: 0, capabilities: {} }));
    });
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const fxB = await createBoundProfile(CONV, baseUrl);
  try {
    const execution = { command: process.execPath, args: [CLI_PATH] };
    const endpoint = makeEndpoint(fxB.pinnedBin);
    await configureAgentReceive({
      profilePath: fxB.profilePath,
      mode: "wake",
      provider: "agy",
      hostSessionId: CONV,
      cwd: fxB.cwd,
      experimentalAgyAgentapi: true,
      execution,
    });
    await registerAgyWake({
      profilePath: fxB.profilePath,
      hostSessionId: CONV,
      credentialsJson: JSON.stringify({ ls_address: CANONICAL_LS, csrf_token: SECRET_CSRF }),
      endpointInspector: makeInspector(endpoint),
      runner: makeSessionRunner([fxB.cwd]),
    });

    const dispatched: number[] = [];
    const servePromise = serveAgyWakeBridge({
      profilePath: fxB.profilePath,
      hostSessionId: CONV,
      adapter: {
        route: "agy-agentapi",
        async sendWake() {
          dispatched.push(1);
          return { ok: true };
        },
      },
      wake: {
        setTopic() {},
        noteClaim() {},
        noteWakeClaim() {},
        canClaimOnWake() { return true; },
        async next() { return "deadline" as const; },
        async close() {},
      } as unknown as WakeHandle,
    });

    // Hold bridge startup in-flight during its initial directory read, then opt out to --mode turn!
    await dirReachedPromise;
    const optOutRes = await configureAgentReceive({
      profilePath: fxB.profilePath,
      mode: "turn",
      provider: "agy",
      hostSessionId: CONV,
      cwd: fxB.cwd,
      execution,
    });
    assert.equal(optOutRes.requested_mode, "turn");
    assert.equal(await readAgyRegistration(fxB.profilePath, CONV), null);

    // Release held startup: bridge MUST honor opt-out under receive-<scope> lock and NEVER stamp a runtime marker!
    releaseDirectoryFetch();
    await assert.rejects(servePromise, { code: "wake_opted_out" });

    const bindingAfter = await readReceiveBinding(fxB.profilePath, CONV);
    assert.ok(bindingAfter);
    assert.equal(bindingAfter.requested_mode, "turn");
    assert.equal(bindingAfter.channel_pid, null, "opted-out bridge startup must never install channel_pid");
    assert.equal(bindingAfter.channel_instance_id, null, "opted-out bridge startup must never install channel_instance_id");
    assert.equal(bindingAfter.channel_heartbeat_at, null, "opted-out bridge startup must never install channel_heartbeat_at");
    assert.equal(receiveStatus(bindingAfter).channel_running, false);
    assert.equal(dispatched.length, 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await fxB.cleanup();
  }
});

test("serveAgyWakeBridge + requestReceiveCanary + markAgyIdle + cswarm check verify wake_verified: true, and CLI help/configure work cleanly", async () => {
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

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  let fx: Awaited<ReturnType<typeof createBoundProfile>> | null = null;
  const abort = new AbortController();
  const dispatched: Array<{ hostSessionId: string; prompt: string }> = [];
  let serveDone: Promise<void> | null = null;
  try {
    fx = await createBoundProfile(CONV, baseUrl);
    const cleanEnv: NodeJS.ProcessEnv = { ...process.env, HOME: fx.home };
    delete cleanEnv.ANTIGRAVITY_LS_ADDRESS;
    delete cleanEnv.ANTIGRAVITY_CSRF_TOKEN;

    // CLI --help succeeds cleanly (verifies receive.register-agy handler help flags entry).
    const helpOut = await execFileAsync(process.execPath, [CLI_PATH, "--help"], { env: cleanEnv });
    assert.match(helpOut.stdout, /register-agy/);

    // CLI configure --provider agy --mode wake --experimental-agy-agentapi works end-to-end.
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

    // CLI receive status never discloses ls_address or csrf_token.
    const statusOut = await execFileAsync(process.execPath, [
      CLI_PATH, "receive", "status",
      "--profile", fx.profilePath,
      "--host-session-id", CONV,
      "--json",
    ], { env: cleanEnv });
    const statusJson = JSON.parse(statusOut.stdout);
    assert.equal(statusJson.wake_route, "agy-agentapi");
    assert.equal(statusJson.wake_verified, false);

    // Full bridge canary lifecycle -> wake_verified: true only after live idle canary + cswarm check!
    const endpoint = makeEndpoint(fx.pinnedBin);
    await registerAgyWake({
      profilePath: fx.profilePath,
      hostSessionId: CONV,
      credentialsJson: JSON.stringify({ ls_address: CANONICAL_LS, csrf_token: SECRET_CSRF }),
      endpointInspector: makeInspector(endpoint),
      runner: makeSessionRunner([fx.cwd]),
    });

    const adapter = new AgyAgentApiAdapter({
      profilePath: fx.profilePath,
      endpointInspector: makeInspector(endpoint),
      runner: makeSessionRunner([fx.cwd], ({ args }) => {
        if (args[1] === "send-message") {
          dispatched.push({ hostSessionId: args[3]!, prompt: args[4]! });
        }
      }),
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

    for (let i = 0; i < 40; i++) {
      const b = await readReceiveBinding(fx.profilePath, CONV);
      if (receiveStatus(b).channel_running) break;
      await delay(50);
    }
    const liveBeforeCanary = receiveStatus(await readReceiveBinding(fx.profilePath, CONV));
    assert.equal(liveBeforeCanary.channel_running, true);
    assert.equal(liveBeforeCanary.wake_route, "agy-agentapi");
    assert.equal(liveBeforeCanary.wake_verified, false);

    await requestReceiveCanary(fx.profilePath, CONV);
    await markAgyIdle(fx.profilePath, CONV);

    for (let i = 0; i < 60; i++) {
      if (dispatched.length > 0) break;
      await delay(50);
    }
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0]!.hostSessionId, CONV);
    assert.equal(dispatched[0]!.prompt, "New CommonSwarm messages (batch 1): run cswarm check");
    assert.equal(receiveStatus(await readReceiveBinding(fx.profilePath, CONV)).wake_verified, false);

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

    // Wrong conversation ID is rejected by resolveAuthorizedWakeBinding.
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
    await new Promise<void>((r) => server.close(() => r()));
    await fx?.cleanup();
  }
});
