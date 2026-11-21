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
  APPROVED_AGY_BINARY_DIGESTS,
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
  const approvedDigests = new Set([pinnedSha256]);

  const realCwd = await realpath(cwd);
  return {
    dir,
    home,
    cwd: realCwd,
    profilePath,
    execRoot,
    pinnedBin,
    pinnedSha256,
    approvedDigests,
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

function assertProcessDead(pid: number, label: string): void {
  assert.ok(Number.isSafeInteger(pid) && pid > 0, `${label}: expected valid recorded child PID, got ${pid}`);
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") alive = false;
  }
  assert.equal(alive, false, `${label}: child process ${pid} must be terminated before lock release`);
}

test("C1 witness: shipped approved digest allowlist blocks first registration of unknown digests with zero token-bearing children, plus strict 0o022 and vendor signature checks", async () => {
  // Shipped allowlist carries version metadata and 64-hex SHA-256 digests.
  const shippedDigests = Object.keys(APPROVED_AGY_BINARY_DIGESTS);
  assert.ok(shippedDigests.length >= 1);
  assert.match(shippedDigests[0]!, /^[0-9a-f]{64}$/);
  assert.ok(APPROVED_AGY_BINARY_DIGESTS[shippedDigests[0]!]!.version.length > 0);

  assert.deepEqual(parseAgyInputAddress("127.0.0.1:49152"), { host: "127.0.0.1", port: 49152 });
  assert.deepEqual(parseAgyInputAddress("localhost:50051"), { host: "localhost", port: 50051 });
  assert.deepEqual(parseAgyInputAddress("[::1]:50051"), { host: "::1", port: 50051 });
  assert.deepEqual(validateCanonicalAgyLsAddress("127.0.0.1:49152"), {
    canonical: "127.0.0.1:49152",
    host: "127.0.0.1",
    port: 49152,
  });
  for (const nonCanonical of ["localhost:49152", "http://127.0.0.1:49152", "0.0.0.0:49152"]) {
    assert.throws(() => validateCanonicalAgyLsAddress(nonCanonical), { code: "agy_ls_address_invalid" });
  }

  const childEnv = buildMinimalAgyChildEnv(CANONICAL_LS, SECRET_CSRF);
  assert.equal(childEnv.ANTIGRAVITY_LS_ADDRESS, CANONICAL_LS);
  assert.equal(childEnv.ANTIGRAVITY_CSRF_TOKEN, SECRET_CSRF);
  assert.equal(childEnv.NO_PROXY, "*");
  assert.equal(childEnv.HTTP_PROXY, "");
  assert.equal(childEnv.PATH, undefined);

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

    // FIRST-REGISTRATION WRONG-DIGEST WITNESS (uses default shipped APPROVED_AGY_BINARY_DIGESTS):
    // Even if vendorVerifier passes, an unapproved digest is REFUSED on first registration with
    // agy_executable_pin_mismatch and ZERO token-bearing children launched!
    const runnerCalls: string[] = [];
    await assert.rejects(
      registerAgyWake({
        profilePath: fx.profilePath,
        hostSessionId: CONV,
        credentialsJson: JSON.stringify({ ls_address: CANONICAL_LS, csrf_token: SECRET_CSRF }),
        endpointInspector: makeInspector(makeEndpoint(fx.pinnedBin)),
        vendorVerifier: APPROVED_TEST_VERIFIER,
        runner: async (_exe, args) => {
          runnerCalls.push(args.join(" "));
          return { stdout: "", stderr: "" };
        },
      }),
      { code: "agy_executable_pin_mismatch" },
    );
    assert.equal(runnerCalls.length, 0, "unapproved first-registration digest must launch ZERO token-bearing children");
    assert.equal(await readAgyRegistration(fx.profilePath, CONV), null);

    // Unapproved vendor signature refused even when digest is in test allowlist!
    await assert.rejects(
      () => validateAgyAgentApiExecutable(fx.pinnedBin, {
        approvedDigests: fx.approvedDigests,
        vendorVerifier: REJECTING_TEST_VERIFIER,
      }),
      { code: "agy_executable_unapproved" },
    );

    // Group-writable leaf (0o775) refused!
    await chmod(fx.pinnedBin, 0o775);
    await assert.rejects(
      () => validateAgyAgentApiExecutable(fx.pinnedBin, {
        approvedDigests: fx.approvedDigests,
        vendorVerifier: APPROVED_TEST_VERIFIER,
      }),
      { code: "agy_executable_invalid" },
    );
    await chmod(fx.pinnedBin, 0o755);

    // Group-writable non-Homebrew ancestor directory (0o775) refused!
    const groupWritableParent = join(fx.execRoot, "group-writable-dir");
    await mkdir(groupWritableParent, { mode: 0o755 });
    const nestedBin = join(groupWritableParent, "antigravity");
    await writeFile(nestedBin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await chmod(nestedBin, 0o755);
    const nestedSha = await sha256File(nestedBin);
    await chmod(groupWritableParent, 0o775);
    await assert.rejects(
      () => validateAgyAgentApiExecutable(nestedBin, {
        approvedDigests: new Set([nestedSha]),
        vendorVerifier: APPROVED_TEST_VERIFIER,
      }),
      { code: "agy_executable_invalid" },
    );
    await chmod(groupWritableParent, 0o755);
  } finally {
    await fx.cleanup();
  }
});

test("C1 witness: registration accepts ONLY 0600 file or stdin (never env), never prints ls_address or csrf_token, and inspects inside receive lock", async () => {
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

    // Refuses non-0600 file and symlink for --credentials-file.
    const credsFile = join(fx.dir, "agy-creds.json");
    await writeFile(credsFile, JSON.stringify({ ls_address: "localhost:49152", csrf_token: SECRET_CSRF }), { mode: 0o644 });
    await chmod(credsFile, 0o644);
    await assert.rejects(() => readAgyCredentialsFromFile(credsFile), { code: "agy_credentials_file_unsafe" });
    await chmod(credsFile, 0o600);
    const credsLink = join(fx.dir, "agy-creds-link.json");
    await symlink(credsFile, credsLink);
    await assert.rejects(() => readAgyCredentialsFromFile(credsLink), { code: "agy_credentials_file_unsafe" });

    // Valid 0600 --credentials-file succeeds without printing ls_address or csrf_token.
    const registered = await registerAgyWake({
      profilePath: fx.profilePath,
      hostSessionId: CONV,
      credentialsFile: credsFile,
      endpointInspector: inspector,
      vendorVerifier: APPROVED_TEST_VERIFIER,
      approvedDigests: fx.approvedDigests,
      runner,
    });
    const serialized = JSON.stringify(registered);
    assert.equal(registered.registered, true);
    assert.equal("ls_address" in registered, false);
    assert.equal(serialized.includes(CANONICAL_LS), false);
    assert.equal(serialized.includes("localhost:49152"), false);
    assert.equal(serialized.includes(SECRET_CSRF), false);

    const regStat = await lstat(regPath);
    assert.equal(regStat.mode & 0o777, 0o600);
    const loaded = await readAgyRegistration(fx.profilePath, CONV);
    assert.equal(loaded?.agentapi_exe_sha256, fx.pinnedSha256);

    // Stdin registration inspects listener strictly inside receive-<scope> lock.
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
        events.push("inspector-inside-lock");
        return endpoint;
      },
      vendorVerifier: APPROVED_TEST_VERIFIER,
      approvedDigests: fx.approvedDigests,
      runner,
    });
    await delay(80);
    assert.deepEqual(events, ["holder-acquired"]);
    releaseHolder();
    await pendingReg;
    assert.equal(events[2], "inspector-inside-lock");
  } finally {
    await fx.cleanup();
  }
});

test("C2 witness: ambiguous failed registration probe still runs postcheck & retires route, and changed endpoint with refused cleanup sticks across configure and retry with zero credential-bearing calls", async () => {
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

    // Establish initial valid registration.
    await registerAgyWake({
      profilePath: fx.profilePath,
      hostSessionId: CONV,
      credentialsJson: JSON.stringify({ ls_address: CANONICAL_LS, csrf_token: SECRET_CSRF }),
      endpointInspector: makeInspector(endpoint),
      vendorVerifier: APPROVED_TEST_VERIFIER,
      approvedDigests: fx.approvedDigests,
      runner: makeSessionRunner([fx.cwd]),
    });
    assert.ok(await readAgyRegistration(fx.profilePath, CONV));

    // 1. AMBIGUOUS FAILED REGISTRATION PROBE + POSTCHECK FAILURE WITNESS:
    //    Re-registration's metadata probe fails ambiguously AND listener swaps after the probe.
    //    Postcheck MUST still run, retire the previously saved registration, and set wake_unavailable_reason!
    let regInspectCalls = 0;
    await assert.rejects(
      registerAgyWake({
        profilePath: fx.profilePath,
        hostSessionId: CONV,
        credentialsJson: JSON.stringify({ ls_address: CANONICAL_LS, csrf_token: SECRET_CSRF }),
        endpointInspector: async () => {
          regInspectCalls += 1;
          return regInspectCalls === 1 ? endpoint : { ...endpoint, pid: endpoint.pid + 77 };
        },
        vendorVerifier: APPROVED_TEST_VERIFIER,
        approvedDigests: fx.approvedDigests,
        runner: async () => {
          throw Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" });
        },
      }),
      { code: "agy_endpoint_mismatch" },
    );
    assert.equal(regInspectCalls, 2, "failed registration probe must still run postcheck");
    assert.equal(await readAgyRegistration(fx.profilePath, CONV), null, "affected saved registration must be deleted");
    const retiredAfterReg = await readReceiveBinding(fx.profilePath, CONV);
    assert.equal(retiredAfterReg?.wake_unavailable_reason, "agy_endpoint_changed_during_registration");
    assert.equal(receiveStatus(retiredAfterReg).wake_route, "none");

    // Re-register cleanly so we can test changed endpoint + refused cleanup + configure + retry!
    await registerAgyWake({
      profilePath: fx.profilePath,
      hostSessionId: CONV,
      credentialsJson: JSON.stringify({ ls_address: CANONICAL_LS, csrf_token: SECRET_CSRF }),
      endpointInspector: makeInspector(endpoint),
      vendorVerifier: APPROVED_TEST_VERIFIER,
      approvedDigests: fx.approvedDigests,
      runner: makeSessionRunner([fx.cwd]),
    });
    assert.equal((await readReceiveBinding(fx.profilePath, CONV))?.wake_unavailable_reason, null);

    // 2. CHANGED ENDPOINT WITH REFUSED CLEANUP + CONFIGURE + RETRY WITH ZERO CREDENTIAL-BEARING CALLS:
    //    During send-message, replace wake-agy-<scope>.json with a non-empty directory so cleanup fails,
    //    and swap the listener on Check #3 (post-send).
    let dispatchInspects = 0;
    let clock = 1_760_000_000_000;
    const bridge = new NativeWakeBridge({
      profilePath: fx.profilePath,
      hostSessionId: CONV,
      cwd: fx.cwd,
      adapter: new AgyAgentApiAdapter({
        profilePath: fx.profilePath,
        vendorVerifier: APPROVED_TEST_VERIFIER,
        approvedDigests: fx.approvedDigests,
        endpointInspector: async () => {
          dispatchInspects += 1;
          return dispatchInspects <= 2 ? endpoint : { ...endpoint, pid: endpoint.pid + 88 };
        },
        runner: async (_exe, args) => {
          if (args[1] === "get-conversation-metadata") {
            return { stdout: makeMetadataJson([fx.cwd]), stderr: "" };
          }
          // Simulate refused cleanup on disk right before post-send retirement runs!
          await rm(regPath, { force: true });
          await mkdir(regPath, { mode: 0o700 });
          await writeFile(join(regPath, "blocker"), "x", { mode: 0o600 });
          return { stdout: JSON.stringify({ response: {} }), stderr: "" };
        },
      }),
      expectedProvider: "agy",
      expectedSeat: { workspaceId: WS, principalId: AGENT },
      now: () => clock,
    });

    bridge.notifyArrival();
    clock += 6_000;
    const postDecision = await bridge.tick();
    assert.equal(postDecision.action, "error");
    if (postDecision.action === "error") {
      assert.equal(postDecision.code, "agy_endpoint_changed_cleanup_failed");
      assert.equal(postDecision.detail.includes(CANONICAL_LS), false);
      assert.equal(postDecision.detail.includes(SECRET_CSRF), false);
    }
    // Unavailable marker MUST be durably persisted even though cleanup failed!
    const bindingAfterRefusedCleanup = await readReceiveBinding(fx.profilePath, CONV);
    assert.equal(bindingAfterRefusedCleanup?.wake_unavailable_reason, "agy_endpoint_changed_after_send");
    assert.equal(receiveStatus(bindingAfterRefusedCleanup).wake_route, "none");

    // Running `receive configure --provider agy --mode wake --experimental-agy-agentapi` MUST NOT clear the disabled route!
    const reconfigured = await configureAgentReceive({
      profilePath: fx.profilePath,
      mode: "wake",
      provider: "agy",
      hostSessionId: CONV,
      cwd: fx.cwd,
      experimentalAgyAgentapi: true,
      execution,
    });
    assert.equal(reconfigured.wake_route, "none", "configure in wake mode must NEVER clear a retired wake route");
    assert.equal(reconfigured.wake_unavailable_reason, "agy_endpoint_changed_after_send");

    // Retry dispatch after configure -> MUST refuse with ZERO credential-bearing calls!
    const retryRunnerCalls: string[] = [];
    const retryBridge = new NativeWakeBridge({
      profilePath: fx.profilePath,
      hostSessionId: CONV,
      cwd: fx.cwd,
      adapter: new AgyAgentApiAdapter({
        profilePath: fx.profilePath,
        vendorVerifier: APPROVED_TEST_VERIFIER,
        approvedDigests: fx.approvedDigests,
        endpointInspector: makeInspector(endpoint),
        runner: async (_exe, args) => {
          retryRunnerCalls.push(args.join(" "));
          return { stdout: "", stderr: "" };
        },
      }),
      expectedProvider: "agy",
      expectedSeat: { workspaceId: WS, principalId: AGENT },
      now: () => clock,
    });
    retryBridge.notifyArrival();
    clock += 16 * 60_000;
    const retryDecision = await retryBridge.tick();
    assert.equal(retryDecision.action, "binding_inactive");
    if (retryDecision.action === "binding_inactive") {
      assert.equal(retryDecision.code, "agy_re_registration_required");
    }
    assert.equal(retryRunnerCalls.length, 0, "retired route retry must launch ZERO credential-bearing calls");
  } finally {
    await fx.cleanup();
  }
});

test("C3 witness: common absolute deadline bounds BOTH a held verification subprocess AND a held vendor child (requiring valid PID + dead at opt-out settlement), plus refused-delete and held-startup witnesses", async () => {
  // Part A: Held VERIFICATION subprocess (e.g. hung codesign/lsof child) + concurrent opt-out!
  const fxVerify = await createBoundProfile(CONV);
  try {
    const execution = { command: process.execPath, args: [CLI_PATH] };
    const endpoint = makeEndpoint(fxVerify.pinnedBin);
    await configureAgentReceive({
      profilePath: fxVerify.profilePath,
      mode: "wake",
      provider: "agy",
      hostSessionId: CONV,
      cwd: fxVerify.cwd,
      experimentalAgyAgentapi: true,
      execution,
    });
    await registerAgyWake({
      profilePath: fxVerify.profilePath,
      hostSessionId: CONV,
      credentialsJson: JSON.stringify({ ls_address: CANONICAL_LS, csrf_token: SECRET_CSRF }),
      endpointInspector: makeInspector(endpoint),
      vendorVerifier: APPROVED_TEST_VERIFIER,
      approvedDigests: fxVerify.approvedDigests,
      runner: makeSessionRunner([fxVerify.cwd]),
    });

    const verifyPidFile = join(fxVerify.dir, "hung-verify-child.pid");
    let verifySpawned!: () => void;
    const verifySpawnedPromise = new Promise<void>((r) => { verifySpawned = r; });

    const hungVerificationInspector: AgyEndpointInspector = async (input) => {
      verifySpawned();
      const rem = input.deadlineMs !== undefined ? input.deadlineMs - Date.now() : (input.timeoutMs ?? 500);
      await defaultAgyAgentApiRunner(
        process.execPath,
        [
          "-e",
          `require("node:fs").writeFileSync(${JSON.stringify(verifyPidFile)}, String(process.pid)); process.on("SIGTERM", () => {}); setTimeout(() => {}, 60000);`,
        ],
        { cwd: fxVerify.cwd, env: {}, timeoutMs: rem, ...(input.signal ? { signal: input.signal } : {}) },
      );
      return endpoint;
    };

    let clock = 1_760_000_000_000;
    const verifyBridge = new NativeWakeBridge({
      profilePath: fxVerify.profilePath,
      hostSessionId: CONV,
      cwd: fxVerify.cwd,
      adapter: new AgyAgentApiAdapter({
        profilePath: fxVerify.profilePath,
        endpointInspector: hungVerificationInspector,
        vendorVerifier: APPROVED_TEST_VERIFIER,
        approvedDigests: fxVerify.approvedDigests,
        runner: makeSessionRunner([fxVerify.cwd]),
        timeoutMs: 900,
      }),
      expectedProvider: "agy",
      expectedSeat: { workspaceId: WS, principalId: AGENT },
      now: () => clock,
    });

    verifyBridge.notifyArrival();
    clock += 6_000;
    const t0 = Date.now();
    const tickPromise = verifyBridge.tick();
    await verifySpawnedPromise;
    await delay(80); // let child write its PID

    const optOutPromise = configureAgentReceive({
      profilePath: fxVerify.profilePath,
      mode: "turn",
      provider: "agy",
      hostSessionId: CONV,
      cwd: fxVerify.cwd,
      execution,
    });

    const [tickRes, optOutRes] = await Promise.all([tickPromise, optOutPromise]);
    const elapsedMs = Date.now() - t0;
    assert.equal(tickRes.action, "error");
    if (tickRes.action === "error") assert.equal(tickRes.code, "agy_dispatch_timeout");
    assert.equal(optOutRes.requested_mode, "turn");
    assert.ok(elapsedMs < 5_000, `hung verification subprocess + opt-out must finish within budget (${elapsedMs}ms)`);

    // REQUIRED valid recorded verification child PID + dead at opt-out settlement!
    const verifyPid = Number.parseInt((await readFile(verifyPidFile, "utf8")).trim(), 10);
    assertProcessDead(verifyPid, "held verification subprocess");
  } finally {
    await fxVerify.cleanup();
  }

  // Part B: Held VENDOR child ignoring SIGTERM + concurrent opt-out!
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
      approvedDigests: fxHold.approvedDigests,
      runner: makeSessionRunner([fxHold.cwd]),
    });

    const pidFile = join(fxHold.dir, "hung-vendor-child.pid");
    let childSpawned!: () => void;
    const childSpawnedPromise = new Promise<void>((r) => { childSpawned = r; });

    const realHungRunner: AgyAgentApiRunner = async (_exe, args, options) => {
      if (args[1] === "get-conversation-metadata") {
        await delay(150);
        return { stdout: makeMetadataJson([fxHold.cwd]), stderr: "" };
      }
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
        approvedDigests: fxHold.approvedDigests,
        runner: realHungRunner,
        timeoutMs: 1_000,
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
    await delay(80);

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
    assert.ok(elapsedMs < 5_000, `bounded dispatch + opt-out must finish quickly (${elapsedMs}ms)`);

    // REQUIRED valid recorded vendor child PID + dead at opt-out settlement!
    const vendorPid = Number.parseInt((await readFile(pidFile, "utf8")).trim(), 10);
    assertProcessDead(vendorPid, "held vendor child");

    assert.equal(await readAgyRegistration(fxHold.profilePath, CONV), null);
  } finally {
    await fxHold.cleanup();
  }

  // Part C: Refused delete witness (durable opt-out before cleanup).
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
      approvedDigests: fxA.approvedDigests,
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
    assert.equal(bindingAfter?.requested_mode, "turn");
    assert.equal(wakeRouteForBinding(bindingAfter), "none");
  } finally {
    await fxA.cleanup();
  }

  // Part D: Startup held across opt-out witness.
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
      approvedDigests: fxB.approvedDigests,
      runner: makeSessionRunner([fxB.cwd]),
    });

    const servePromise = serveAgyWakeBridge({
      profilePath: fxB.profilePath,
      hostSessionId: CONV,
      adapter: { route: "agy-agentapi", async sendWake() { return { ok: true }; } },
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
    assert.equal(bindingAfter?.requested_mode, "turn");
    assert.equal(bindingAfter?.channel_pid, null);
    assert.equal(bindingAfter?.channel_instance_id, null);
    assert.equal(receiveStatus(bindingAfter).channel_running, false);
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
      approvedDigests: fx.approvedDigests,
      runner: makeSessionRunner([fx.cwd]),
    });

    const adapter = new AgyAgentApiAdapter({
      profilePath: fx.profilePath,
      endpointInspector: makeInspector(endpoint),
      vendorVerifier: APPROVED_TEST_VERIFIER,
      approvedDigests: fx.approvedDigests,
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
