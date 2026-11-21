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
  defaultAgyAgentApiRunner,
  markAgyIdle,
  parseAgyInputAddress,
  readAgyCredentialsFromFile,
  readAgyRegistration,
  registerAgyWake,
  serveAgyWakeBridge,
  sha256File,
  validateAgyAgentApiExecutable,
  validateAgyCsrfToken,
  validateCanonicalAgyLsAddress,
  type AgyAgentApiRunner,
  type AgyEndpointInspector,
  type AgyLoopbackEndpoint,
  type AgyVendorVerifier,
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

const APPROVED_TEST_VERIFIER: AgyVendorVerifier = async () => ({ ok: true, googleSigned: false });
const REJECTING_TEST_VERIFIER: AgyVendorVerifier = async () => ({ ok: false, googleSigned: false });

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

/** Pick a non-group/world-writable base dir for fixture executables (Linux /tmp is 01777). */
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
        if (!info.isDirectory() || (info.mode & 0o022) !== 0) {
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
  await chmod(fakeBin, 0o755);
  const pinnedBin = await realpath(fakeBin);
  const pinnedSha256 = await sha256File(pinnedBin);

  const realCwd = await realpath(cwd);
  return {
    dir,
    home,
    cwd: realCwd,
    profilePath,
    execRoot,
    pinnedBin,
    pinnedSha256,
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

test("C1 witness: strict 0o022 leaf/ancestor check rejects group-writable paths, unapproved binaries, and SHA-256 pin drift", async () => {
  assert.deepEqual(parseAgyInputAddress("127.0.0.1:49152"), { host: "127.0.0.1", port: 49152 });
  assert.deepEqual(parseAgyInputAddress("localhost:50051"), { host: "localhost", port: 50051 });
  assert.deepEqual(parseAgyInputAddress("[::1]:50051"), { host: "::1", port: 50051 });
  assert.deepEqual(parseAgyInputAddress("http://127.0.0.1:49152"), { host: "127.0.0.1", port: 49152 });

  for (const bad of [
    "", "   ", "0.0.0.0:49152", "10.0.0.5:49152", "example.com:443", "https://127.0.0.1:49152",
    "127.0.0.1", "127.0.0.1:0", "127.0.0.1:70000", "127.0.0.1:49152/path",
    "http://user:pass@127.0.0.1:49152", "127.0.0.1:49152?foo=1", "127.0.0.1:49152#frag", "127.0.0.1:49152\n",
  ]) {
    assert.throws(() => parseAgyInputAddress(bad), { code: "agy_ls_address_invalid" });
  }

  // Canonical validator accepts ONLY loopback IP literals — NEVER hostnames or URL schemes.
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

  // Stripped child env excludes ambient credentials, PATH, and disables proxies.
  const childEnv = buildMinimalAgyChildEnv(CANONICAL_LS, SECRET_CSRF);
  assert.equal(childEnv.ANTIGRAVITY_LS_ADDRESS, CANONICAL_LS);
  assert.equal(childEnv.ANTIGRAVITY_CSRF_TOKEN, SECRET_CSRF);
  assert.equal(childEnv.NO_PROXY, "*");
  assert.equal(childEnv.HTTP_PROXY, "");
  assert.equal(childEnv.HTTPS_PROXY, "");
  assert.equal(childEnv.ALL_PROXY, "");
  assert.equal(childEnv.PATH, undefined);

  const fx = await createBoundProfile(CONV);
  try {
    await assert.rejects(() => validateAgyAgentApiExecutable("agy", { vendorVerifier: APPROVED_TEST_VERIFIER }), { code: "agy_executable_invalid" });
    await assert.rejects(() => validateAgyAgentApiExecutable("/bin/sh", { vendorVerifier: APPROVED_TEST_VERIFIER }), { code: "agy_executable_invalid" });

    // Unapproved / unsigned binary refused (both via default verifier AND explicit rejecting verifier)!
    await assert.rejects(() => validateAgyAgentApiExecutable(fx.pinnedBin), { code: "agy_executable_unapproved" });
    await assert.rejects(
      () => validateAgyAgentApiExecutable(fx.pinnedBin, { vendorVerifier: REJECTING_TEST_VERIFIER }),
      { code: "agy_executable_unapproved" },
    );

    // Approved binary with strict 0o755 passes and returns canonical path + sha256.
    const verified = await validateAgyAgentApiExecutable(fx.pinnedBin, {
      expectedSha256: fx.pinnedSha256,
      vendorVerifier: APPROVED_TEST_VERIFIER,
    });
    assert.deepEqual(verified, { path: fx.pinnedBin, sha256: fx.pinnedSha256 });

    // SHA-256 pin drift (e.g. vendor update) fails closed with agy_executable_pin_mismatch!
    await assert.rejects(
      () => validateAgyAgentApiExecutable(fx.pinnedBin, {
        expectedSha256: "0".repeat(64),
        vendorVerifier: APPROVED_TEST_VERIFIER,
      }),
      { code: "agy_executable_pin_mismatch" },
    );

    // Group-writable leaf (0o775) is STRICTLY REFUSED!
    await chmod(fx.pinnedBin, 0o775);
    await assert.rejects(
      () => validateAgyAgentApiExecutable(fx.pinnedBin, { vendorVerifier: APPROVED_TEST_VERIFIER }),
      { code: "agy_executable_invalid" },
    );
    await chmod(fx.pinnedBin, 0o755);

    // Group-writable non-Homebrew ancestor directory (0o775) is STRICTLY REFUSED even when leaf is 0o755!
    const groupWritableParent = join(fx.execRoot, "group-writable-dir");
    await mkdir(groupWritableParent, { mode: 0o755 });
    const nestedBin = join(groupWritableParent, "antigravity");
    await writeFile(nestedBin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await chmod(nestedBin, 0o755);
    await chmod(groupWritableParent, 0o775);
    await assert.rejects(
      () => validateAgyAgentApiExecutable(nestedBin, { vendorVerifier: APPROVED_TEST_VERIFIER }),
      { code: "agy_executable_invalid" },
    );
    await chmod(groupWritableParent, 0o755);
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
          vendorVerifier: APPROVED_TEST_VERIFIER,
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

    // Valid 0600 --credentials-file succeeds, stores canonical IP literal + pid/lstart + exe SHA-256 pin,
    // and NEVER prints ls_address or csrf_token in return output!
    const beforeBinding = await readReceiveBinding(fx.profilePath, CONV);
    const registered = await registerAgyWake({
      profilePath: fx.profilePath,
      hostSessionId: CONV,
      credentialsFile: credsFile,
      endpointInspector: inspector,
      vendorVerifier: APPROVED_TEST_VERIFIER,
      runner,
    });
    const serialized = JSON.stringify(registered);
    assert.equal(registered.registered, true);
    assert.equal(registered.wake_route, "agy-agentapi");
    assert.equal(registered.wake_verified, false);
    assert.equal("ls_address" in registered, false);
    assert.equal(serialized.includes(CANONICAL_LS), false);
    assert.equal(serialized.includes("localhost:49152"), false);
    assert.equal(serialized.includes(SECRET_CSRF), false);
    assert.deepEqual(await readReceiveBinding(fx.profilePath, CONV), beforeBinding);

    const regStat = await lstat(regPath);
    assert.equal(regStat.mode & 0o777, 0o600);
    const loaded = await readAgyRegistration(fx.profilePath, CONV);
    assert.ok(loaded);
    assert.equal(loaded.ls_address, CANONICAL_LS);
    assert.equal(loaded.ls_pid, endpoint.pid);
    assert.equal(loaded.agentapi_exe, fx.pinnedBin);
    assert.equal(loaded.agentapi_exe_sha256, fx.pinnedSha256);

    // Registration lookup runs INSIDE shared receive-<scope> lock (blocked while lock held).
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
      endpointInspector: async () => {
        events.push("inspector-called-inside-lock");
        return endpoint;
      },
      vendorVerifier: APPROVED_TEST_VERIFIER,
      runner,
    }).then((r) => {
      events.push("register-finished");
      return r;
    });
    await delay(80);
    assert.deepEqual(events, ["holder-acquired"], "listener inspection must occur INSIDE receive-<scope> lock");
    releaseHolder();
    await pendingReg;
    assert.equal(events[0], "holder-acquired");
    assert.equal(events[1], "holder-releasing");
    assert.equal(events[2], "inspector-called-inside-lock");
  } finally {
    await fx.cleanup();
  }
});

test("C2 witness: detects listener replacement BETWEEN metadata and send, invalidates route on POST-send replacement, and refuses pin drift and different live sessions", async () => {
  const fx = await createBoundProfile(CONV);
  try {
    const execution = { command: process.execPath, args: [CLI_PATH] };
    const endpoint = makeEndpoint(fx.pinnedBin);

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
      credentialsJson: JSON.stringify({ ls_address: "localhost:49152", csrf_token: SECRET_CSRF }),
      endpointInspector: makeInspector(endpoint),
      vendorVerifier: APPROVED_TEST_VERIFIER,
      runner: makeSessionRunner([fx.cwd]),
    });

    // 1. REPLACEMENT BETWEEN METADATA AND SEND:
    //    Check #1 (pre-metadata) sees the valid endpoint, metadata succeeds, then listener is replaced
    //    before send -> Check #2 catches it and send-message is NEVER invoked!
    let midCalls = 0;
    const midRunnerCalls: string[][] = [];
    const midSwapAdapter = new AgyAgentApiAdapter({
      profilePath: fx.profilePath,
      vendorVerifier: APPROVED_TEST_VERIFIER,
      endpointInspector: async () => {
        midCalls += 1;
        return midCalls === 1 ? endpoint : { ...endpoint, pid: endpoint.pid + 99 };
      },
      runner: makeSessionRunner([fx.cwd], ({ args }) => {
        midRunnerCalls.push([...args]);
      }),
    });
    const midSwapRes = await midSwapAdapter.sendWake({
      hostSessionId: CONV,
      prompt: formatNativeWakePrompt(1),
      batch: 1,
      cwd: fx.cwd,
    });
    assert.equal(midSwapRes.ok, false);
    if (!midSwapRes.ok) assert.equal(midSwapRes.code, "agy_endpoint_mismatch");
    assert.equal(midCalls, 2);
    assert.equal(midRunnerCalls.length, 1);
    assert.equal(midRunnerCalls[0]![1], "get-conversation-metadata");
    assert.equal(midRunnerCalls.some((c) => c[1] === "send-message"), false, "send-message must never run after mid-dispatch replacement");
    // Post-metadata change ALSO disables the route and removes 0600 credentials!
    assert.equal(await readAgyRegistration(fx.profilePath, CONV), null);
    assert.equal((await readReceiveBinding(fx.profilePath, CONV))?.wake_unavailable_reason, "agy_endpoint_changed_after_metadata");
    assert.equal(receiveStatus(await readReceiveBinding(fx.profilePath, CONV)).wake_route, "none");

    // Re-register cleanly before pin drift and post-send witnesses.
    await registerAgyWake({
      profilePath: fx.profilePath,
      hostSessionId: CONV,
      credentialsJson: JSON.stringify({ ls_address: CANONICAL_LS, csrf_token: SECRET_CSRF }),
      endpointInspector: makeInspector(endpoint),
      vendorVerifier: APPROVED_TEST_VERIFIER,
      runner: makeSessionRunner([fx.cwd]),
    });

    // 2. PIN DRIFT WITNESS (vendor binary updated on disk -> fixed re-register diagnostic, 0 runner calls):
    await writeFile(fx.pinnedBin, "#!/bin/sh\n# updated vendor binary\nexit 0\n", { mode: 0o755 });
    await chmod(fx.pinnedBin, 0o755);
    const pinDriftCalls: string[] = [];
    const pinDriftAdapter = new AgyAgentApiAdapter({
      profilePath: fx.profilePath,
      vendorVerifier: APPROVED_TEST_VERIFIER,
      endpointInspector: makeInspector(endpoint),
      runner: async (_exe, args) => {
        pinDriftCalls.push(args.join(" "));
        return { stdout: "", stderr: "" };
      },
    });
    const pinDriftRes = await pinDriftAdapter.sendWake({
      hostSessionId: CONV,
      prompt: formatNativeWakePrompt(1),
      batch: 1,
      cwd: fx.cwd,
    });
    assert.equal(pinDriftRes.ok, false);
    if (!pinDriftRes.ok) {
      assert.equal(pinDriftRes.code, "agy_executable_pin_mismatch");
      assert.match(pinDriftRes.detail, /register-agy/);
    }
    assert.equal(pinDriftCalls.length, 0);
    // Restore original binary bytes for remaining checks.
    await writeFile(fx.pinnedBin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await chmod(fx.pinnedBin, 0o755);

    // 3. POST-SEND REPLACEMENT WITNESS (HezLead C2 condition):
    //    Check #1 (pre-metadata) and Check #2 (pre-send) pass, send-message runs, then Check #3
    //    (post-send) observes a changed listener -> marks wake_route unavailable with fixed reason,
    //    removes 0600 registration, and refuses subsequent dispatches until re-registered!
    let postChecks = 0;
    const postSwapAdapter = new AgyAgentApiAdapter({
      profilePath: fx.profilePath,
      vendorVerifier: APPROVED_TEST_VERIFIER,
      endpointInspector: async () => {
        postChecks += 1;
        return postChecks <= 2 ? endpoint : { ...endpoint, start_time: "Sat Nov 21 00:00:00 2026" };
      },
      runner: makeSessionRunner([fx.cwd]),
    });
    let clock = 1_760_000_000_000;
    const bridge = new NativeWakeBridge({
      profilePath: fx.profilePath,
      hostSessionId: CONV,
      cwd: fx.cwd,
      adapter: postSwapAdapter,
      expectedProvider: "agy",
      expectedSeat: { workspaceId: WS, principalId: AGENT },
      now: () => clock,
    });
    bridge.notifyArrival();
    clock += 6_000;
    const postDecision = await bridge.tick();
    assert.equal(postDecision.action, "error");
    if (postDecision.action === "error") {
      assert.equal(postDecision.code, "agy_endpoint_changed_after_send");
      assert.equal(postDecision.detail.includes(CANONICAL_LS), false);
      assert.equal(postDecision.detail.includes(SECRET_CSRF), false);
    }
    assert.equal(postChecks, 3);
    // 0600 registration deleted and wake_route marked unavailable on binding!
    assert.equal(await readAgyRegistration(fx.profilePath, CONV), null);
    const bindingAfterSwap = await readReceiveBinding(fx.profilePath, CONV);
    assert.ok(bindingAfterSwap);
    assert.equal(bindingAfterSwap.wake_unavailable_reason, "agy_endpoint_changed_after_send");
    const statusAfterSwap = receiveStatus(bindingAfterSwap);
    assert.equal(statusAfterSwap.wake_route, "none");
    assert.equal(statusAfterSwap.wake_verified, false);
    assert.equal(statusAfterSwap.wake_unavailable_reason, "agy_endpoint_changed_after_send");

    // Subsequent authorization refuses until explicit re-registration!
    const authBlocked = await resolveAuthorizedWakeBinding({
      profilePath: fx.profilePath,
      hostSessionId: CONV,
      expectedProvider: "agy",
    });
    assert.equal(authBlocked.ok, false);
    if (!authBlocked.ok) assert.equal(authBlocked.code, "agy_re_registration_required");

    // Re-registration restores wake_route: "agy-agentapi" cleanly!
    const rereg = await registerAgyWake({
      profilePath: fx.profilePath,
      hostSessionId: CONV,
      credentialsJson: JSON.stringify({ ls_address: CANONICAL_LS, csrf_token: SECRET_CSRF }),
      endpointInspector: makeInspector(endpoint),
      vendorVerifier: APPROVED_TEST_VERIFIER,
      runner: makeSessionRunner([fx.cwd]),
    });
    assert.equal(rereg.wake_route, "agy-agentapi");
    assert.equal((await readReceiveBinding(fx.profilePath, CONV))?.wake_unavailable_reason, null);

    // 4. NON-DISCLOSURE ON FAILURE: raw stderr containing ls_address + csrf_token never enters detail or wake-state.json.
    const leakyBridge = new NativeWakeBridge({
      profilePath: fx.profilePath,
      hostSessionId: CONV,
      cwd: fx.cwd,
      adapter: new AgyAgentApiAdapter({
        profilePath: fx.profilePath,
        vendorVerifier: APPROVED_TEST_VERIFIER,
        endpointInspector: makeInspector(endpoint),
        runner: async (_exe, args) => {
          if (args[1] === "get-conversation-metadata") {
            return { stdout: makeMetadataJson([fx.cwd]), stderr: "" };
          }
          throw Object.assign(new Error(`dial tcp ${CANONICAL_LS}: connection refused token=${SECRET_CSRF}`), {
            stderr: `rpc error: ECONNREFUSED ${CANONICAL_LS} x-csrf=${SECRET_CSRF} OPAQUE_STDERR_MARKER`,
          });
        },
      }),
      expectedProvider: "agy",
      expectedSeat: { workspaceId: WS, principalId: AGENT },
      now: () => clock,
    });
    leakyBridge.notifyArrival();
    clock += 16 * 60_000;
    const failDecision = await leakyBridge.tick();
    assert.equal(failDecision.action, "error");
    if (failDecision.action === "error") {
      assert.equal(failDecision.code, "agy_ls_unreachable");
      assert.equal(failDecision.detail.includes(SECRET_CSRF), false);
      assert.equal(failDecision.detail.includes(CANONICAL_LS), false);
      assert.equal(failDecision.detail.includes("OPAQUE_STDERR_MARKER"), false);
    }
    const wakeState = await readNativeWakeState(fx.profilePath, CONV);
    const stateJson = JSON.stringify(wakeState);
    assert.equal(stateJson.includes(SECRET_CSRF), false);
    assert.equal(stateJson.includes(CANONICAL_LS), false);
    assert.equal(stateJson.includes("OPAQUE_STDERR_MARKER"), false);
  } finally {
    await fx.cleanup();
  }
});

test("C3 witness: real held child ignoring SIGTERM is SIGKILLed within single budget before lock release so concurrent opt-out commits turn mode, plus refused-delete and held-startup witnesses", async () => {
  // Part A: Real held child process + single dispatch budget + concurrent opt-out!
  const fxHold = await createBoundProfile(CONV);
  try {
    const execution = { command: process.execPath, args: [CLI_PATH] };
    const endpoint = makeEndpoint(fxHold.pinnedBin);
    await configureAgentReceive({
      profilePath: fxHold.profilePath,
      mode: "wake",
      provider: "agy",
      hostSessionId: CONV,
      cwd: fxHold.cwd,
      experimentalAgyAgentapi: true,
      execution,
    });
    await registerAgyWake({
      profilePath: fxHold.profilePath,
      hostSessionId: CONV,
      credentialsJson: JSON.stringify({ ls_address: CANONICAL_LS, csrf_token: SECRET_CSRF }),
      endpointInspector: makeInspector(endpoint),
      vendorVerifier: APPROVED_TEST_VERIFIER,
      runner: makeSessionRunner([fxHold.cwd]),
    });

    // Write a real executable script that records its PID, ignores SIGTERM, and sleeps 60s
    // (exercising real spawn + single total budget + SIGTERM->SIGKILL + await child close before lock release!).
    const pidFile = join(fxHold.dir, "hung-child.pid");
    let childSpawned!: () => void;
    const childSpawnedPromise = new Promise<void>((r) => { childSpawned = r; });

    const realHungRunner: AgyAgentApiRunner = async (_exe, args, options) => {
      if (args[1] === "get-conversation-metadata") {
        // Consume part of the single shared budget (~200ms), then succeed.
        await delay(200);
        return { stdout: makeMetadataJson([fxHold.cwd]), stderr: "" };
      }
      // On send-message, spawn a REAL child process via defaultAgyAgentApiRunner that ignores SIGTERM!
      childSpawned();
      return defaultAgyAgentApiRunner(
        process.execPath,
        [
          "-e",
          `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on("SIGTERM", () => {}); setTimeout(() => {}, 60000);`,
        ],
        options,
      );
    };

    let clock = 1_760_000_000_000;
    const bridge = new NativeWakeBridge({
      profilePath: fxHold.profilePath,
      hostSessionId: CONV,
      cwd: fxHold.cwd,
      adapter: new AgyAgentApiAdapter({
        profilePath: fxHold.profilePath,
        endpointInspector: makeInspector(endpoint),
        vendorVerifier: APPROVED_TEST_VERIFIER,
        runner: realHungRunner,
        timeoutMs: 900, // Single total budget covering BOTH metadata (200ms) + send (~700ms remaining)
      }),
      expectedProvider: "agy",
      expectedSeat: { workspaceId: WS, principalId: AGENT },
      now: () => clock,
    });

    bridge.notifyArrival();
    clock += 6_000;
    const t0 = Date.now();
    const tickPromise = bridge.tick();
    await childSpawnedPromise;

    // Concurrently opt out to --mode turn while the real hung child holds the receive-<scope> lock!
    const optOutPromise = configureAgentReceive({
      profilePath: fxHold.profilePath,
      mode: "turn",
      provider: "agy",
      hostSessionId: CONV,
      cwd: fxHold.cwd,
      execution,
    });

    const [tickRes, optOutRes] = await Promise.all([tickPromise, optOutPromise]);
    const elapsedMs = Date.now() - t0;

    assert.equal(tickRes.action, "error");
    if (tickRes.action === "error") assert.equal(tickRes.code, "agy_dispatch_timeout");
    assert.equal(optOutRes.requested_mode, "turn");
    assert.equal(optOutRes.wake_route, "none");
    assert.ok(elapsedMs < 5_000, `bounded dispatch + opt-out must finish quickly (took ${elapsedMs}ms)`);

    // Prove the real child process was ALREADY dead before the lock was released!
    const childPidText = await readFile(pidFile, "utf8").catch(() => "");
    const childPid = Number.parseInt(childPidText.trim(), 10);
    if (Number.isSafeInteger(childPid) && childPid > 0) {
      let alive = true;
      try {
        process.kill(childPid, 0);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ESRCH") alive = false;
      }
      assert.equal(alive, false, "timed-out child process must be terminated before lock release");
    }

    // Opt-out won durably: 0600 registration removed and subsequent wake refuses.
    assert.equal(await readAgyRegistration(fxHold.profilePath, CONV), null);
    bridge.notifyArrival();
    clock += 16 * 60_000;
    const nextTick = await bridge.tick();
    assert.equal(nextTick.action, "binding_inactive");
  } finally {
    await fxHold.cleanup();
  }

  // Part B: Refused delete witness (durable opt-out before cleanup + explicit cleanup failure report).
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
      vendorVerifier: APPROVED_TEST_VERIFIER,
      runner: makeSessionRunner([fxA.cwd]),
    });

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

    const bindingAfter = await readReceiveBinding(fxA.profilePath, CONV);
    assert.ok(bindingAfter);
    assert.equal(bindingAfter.requested_mode, "turn");
    assert.equal(wakeRouteForBinding(bindingAfter), "none");
  } finally {
    await fxA.cleanup();
  }

  // Part C: Startup held across opt-out witness (bridge startup checks live route under receive-<scope> lock).
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
      vendorVerifier: APPROVED_TEST_VERIFIER,
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

    await dirReachedPromise;
    await configureAgentReceive({
      profilePath: fxB.profilePath,
      mode: "turn",
      provider: "agy",
      hostSessionId: CONV,
      cwd: fxB.cwd,
      execution,
    });

    releaseDirectoryFetch();
    await assert.rejects(servePromise, { code: "wake_opted_out" });

    const bindingAfter = await readReceiveBinding(fxB.profilePath, CONV);
    assert.ok(bindingAfter);
    assert.equal(bindingAfter.requested_mode, "turn");
    assert.equal(bindingAfter.channel_pid, null);
    assert.equal(bindingAfter.channel_instance_id, null);
    assert.equal(bindingAfter.channel_heartbeat_at, null);
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

    const helpOut = await execFileAsync(process.execPath, [CLI_PATH, "--help"], { env: cleanEnv });
    assert.match(helpOut.stdout, /register-agy/);

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

    const endpoint = makeEndpoint(fx.pinnedBin);
    await registerAgyWake({
      profilePath: fx.profilePath,
      hostSessionId: CONV,
      credentialsJson: JSON.stringify({ ls_address: CANONICAL_LS, csrf_token: SECRET_CSRF }),
      endpointInspector: makeInspector(endpoint),
      vendorVerifier: APPROVED_TEST_VERIFIER,
      runner: makeSessionRunner([fx.cwd]),
    });

    const adapter = new AgyAgentApiAdapter({
      profilePath: fx.profilePath,
      endpointInspector: makeInspector(endpoint),
      vendorVerifier: APPROVED_TEST_VERIFIER,
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
