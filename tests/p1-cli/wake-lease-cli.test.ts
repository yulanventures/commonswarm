import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { EXIT_NOTIFY_LEASE_LOST } from "../../src/cloud/wake-lease-constants.js";
import { cloudTarget } from "../../src/cloud/config.js";
import { defaultSessionContextPath, newSessionBinding, writeSessionContext } from "../../src/cloud/session-context.js";
import { AGENT_SESSION_ID_HEADER } from "../../src/cloud/session-contract.js";

const workspace = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const principal = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

type FixtureMode = "refuse" | "takeover" | "supersede" | "status" | "lifecycle" | "claim_retry" | "claim_inflight" |
  "unmanaged" | "session_conflict" | "session_expired" | "session_retired" |
  "session_proof_invalid" | "session_proof_missing" | "profile_unauthorized" | "profile_forbidden" | "profile_unreachable" | "profile_transport";
async function fixture(mode: FixtureMode, anonKey = "public-test-key") {
  const root = await mkdtemp(join(tmpdir(), "cswarm-wake-lease-cli-"));
  const credential = join(root, "agent.json");
  await writeFile(credential, JSON.stringify({ message: "Agent credential minted. It is bound to this run, so the agent's work is attributable to it.", status: "accepted", principal_id: principal,
    token_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    run_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    agent_token: `swm_agt_${"A".repeat(43)}`, expires_at: "2030-01-01T00:00:00Z" }), { mode: 0o600 });
  const seen: Array<Record<string, unknown>> = [];
  let lease: { watcher: unknown; hostId: unknown; generation: number } | null = null;
  let claimAttempts = 0;
  let liveSession: { session_id: string; generation: number } | null = null;
  let membersReads = 0;
  let slowVerification = false;
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => raw += chunk);
    request.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      if (request.url === "/functions/v1/command") {
        const command = body.command as Record<string, unknown>;
        seen.push(command);
        if (command.kind === "claim_wake_lease" && mode === "claim_retry" && ++claimAttempts <= 2) {
          response.writeHead(503).end("unavailable");
          return;
        }
        if (command.kind === "claim_wake_lease" && mode === "claim_inflight") {
          setTimeout(() => response.writeHead(503).end("unavailable"), 1500);
          return;
        }
        if (command.kind === "claim_wake_lease" && mode === "session_proof_missing" &&
            request.headers[AGENT_SESSION_ID_HEADER] !== undefined) {
          response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, generation: 1 }));
          return;
        }
        if (command.kind === "claim_wake_lease" && mode.startsWith("session_")) {
          response.writeHead(mode === "session_conflict" ? 409 : mode === "session_retired" ? 403 : 401,
            { "content-type": "application/json" }).end(JSON.stringify({ error: mode }));
          return;
        }
        if (mode === "lifecycle") {
          if (command.kind === "claim_wake_lease") {
            if (lease !== null && lease.hostId !== command.host_id && command.take_over !== true) {
              response.writeHead(409, { "content-type": "application/json" }).end(JSON.stringify({
                error: "notify_held_elsewhere", surface: "watcher", host_label: "other-host",
              }));
              return;
            }
            lease = { watcher: command.watcher_id, hostId: command.host_id,
              generation: (lease?.generation ?? 0) + 1 };
            response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
              ok: true, generation: lease.generation,
            }));
            return;
          }
          if (command.kind === "release_wake_lease") {
            const released = lease?.watcher === command.watcher_id && lease?.generation === command.generation;
            if (released) lease = null;
            response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, released }));
            return;
          }
        }
        if (command.kind === "claim_wake_lease" && mode === "refuse") {
          if (command.take_over === true) {
            response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
              ok: true, status: "accepted", generation: 2,
            }));
            return;
          }
          response.writeHead(409, { "content-type": "application/json" }).end(JSON.stringify({
            error: "notify_held_elsewhere", surface: "watcher", host_label: "other-host",
            lease_age_ms: 1000,
          }));
          return;
        }
        if (command.kind === "renew_wake_lease" && mode === "supersede") {
          response.writeHead(409, { "content-type": "application/json" }).end(JSON.stringify({
            error: "wake_lease_superseded", surface: "watcher", host_label: "new-host",
          }));
          return;
        }
        if (command.kind === "renew_wake_lease" && mode.startsWith("session_")) {
          response.writeHead(mode === "session_conflict" ? 409 : mode === "session_retired" ? 403 : 401,
            { "content-type": "application/json" }).end(JSON.stringify({ error: mode }));
          return;
        }
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          ok: true, status: "accepted", generation: 1,
        }));
        return;
      }
      if (body.resource === "agent_wake_lease") {
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          lease: { watcher_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
            host_label: "remote-host", generation: 3, renewed_age_ms: 1200 },
        }));
        return;
      }
      if (body.resource === "files") {
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ files: [] }));
        return;
      }
      if (body.resource === "members") {
        membersReads += 1;
        if (mode === "profile_transport") { response.destroy(); return; }
        if (mode === "profile_unauthorized" || mode === "profile_forbidden" || mode === "profile_unreachable") {
          response.writeHead(mode === "profile_unauthorized" ? 401 : mode === "profile_forbidden" ? 403 : 503,
            { "content-type": "application/json" }).end(JSON.stringify({ error: "refused" }));
          return;
        }
        const send = () => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          members: [], agents: [{ principal_id: principal, owner_user_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", name: "Fixture seat",
            ...(mode === "unmanaged" ? {} : { managed_at: "2026-09-25T00:00:00Z" }),
            ...(liveSession ? { ...liveSession, is_live: true, lifecycle_state: "enabled" } : {}) }], identity: { credential_valid: true,
            owner_user_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
            principal_id: principal, workspace_id: workspace },
        }));
        if (slowVerification) setTimeout(send, 1500); else send();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        signals: [], capabilities: { sender_owner_relation: 1, cursor_after: 1 },
      }));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let child: ChildProcess | null = null;
  const start = (takeOver = false, sessionContextPath?: string, profilePath?: string, hostSessionId?: string, stdin = false) => {
    child = spawn(process.execPath, ["--import", "tsx", resolve("src/cli.ts"),
      "inbox", "--notify", ...(profilePath ? ["--profile", profilePath, "--host-session-id", hostSessionId!] :
        [stdin ? "--agent-token-stdin" : "--agent-token-file", ...(stdin ? [] : [credential]),
          "--url", `http://127.0.0.1:${address.port}`, "--anon-key", anonKey, "--workspace-id", workspace]),
      ...(takeOver ? ["--take-over"] : []),
      ...(sessionContextPath ? ["--session-context", sessionContextPath] : [])], {
      env: { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state"),
        NODE_ENV: "test", CSWARM_TEST_WAKE_RENEW_MS: "150" },
      stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"],
    });
    if (stdin) child.stdin?.end(JSON.stringify({ message: "Agent credential minted. It is bound to this run, so the agent's work is attributable to it.", status: "accepted", principal_id: principal,
      token_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", run_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", agent_token: `swm_agt_${"A".repeat(43)}`, expires_at: "2030-01-01T00:00:00Z" }));
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => stderr += chunk.toString());
    const running = child;
    const exit = new Promise<{ code: number | null; stderr: string }>((done, reject) => {
      const timer = setTimeout(() => { running.kill("SIGKILL"); reject(new Error("watcher timeout")); }, 10_000);
      running.once("exit", (code) => { clearTimeout(timer); done({ code, stderr }); });
      running.once("error", reject);
    });
    return { exit, stop: () => running.kill("SIGTERM"), interrupt: () => running.kill("SIGINT"),
      crash: () => running.kill("SIGKILL") };
  };
  const status = async () => {
    const running = spawn(process.execPath, ["--import", "tsx", resolve("src/cli.ts"),
      "listen", "status", "--agent-token-file", credential,
      "--url", `http://127.0.0.1:${address.port}`, "--anon-key", anonKey,
      "--workspace-id", workspace, "--state-dir", join(root, "listeners"), "--json"], {
      env: { ...process.env, HOME: root, XDG_STATE_HOME: join(root, "state") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child = running;
    let stdout = "";
    let stderr = "";
    running.stdout?.on("data", (chunk: Buffer) => stdout += chunk.toString());
    running.stderr?.on("data", (chunk: Buffer) => stderr += chunk.toString());
    const code = await new Promise<number | null>((done, reject) => {
      const timer = setTimeout(() => { running.kill("SIGKILL"); reject(new Error("status timeout")); }, 5000);
      running.once("exit", (value) => { clearTimeout(timer); done(value); });
      running.once("error", reject);
    });
    return { code, stdout, stderr };
  };
  const cleanup = async () => {
    if (child && child.exitCode === null) child.kill("SIGKILL");
    await new Promise<void>((done) => server.close(() => done()));
    await rm(root, { recursive: true, force: true });
  };
  return { start, status, seen, cleanup, root, credential, anonKey, url: `http://127.0.0.1:${address.port}`,
    verificationStarted() { return membersReads > 0; },
    slowVerification() { slowVerification = true; },
    setLiveSession(value: { session_id: string; generation: number } | null) { liveSession = value; } };
}

test("a fresh remote holder refuses start with host and takeover command", { timeout: 8000 }, async () => {
  const f = await fixture("refuse");
  try {
    const watch = f.start();
    const result = await watch.exit;
    assert.equal(result.code, EXIT_NOTIFY_LEASE_LOST, result.stderr);
    assert.match(result.stderr, /notify_held_elsewhere.*other-host.*--take-over/);
    assert.equal(f.seen[0]?.kind, "claim_wake_lease");
    assert.match(String(f.seen[0]?.host_id), /^[0-9a-f-]{36}$/);
    assert.equal(Object.hasOwn(f.seen[0] ?? {}, "local_lock_held"), false);
  } finally { await f.cleanup(); }
});

test("the non-stdin holder command runs exactly as printed through the shell", { timeout: 8_000 }, async () => {
  const f = await fixture("refuse");
  let child: ChildProcess | null = null;
  try {
    const refusal = await f.start().exit;
    assert.equal(refusal.code, 76, refusal.stderr);
    const command = refusal.stderr.split("\n").find(line => line.startsWith("cswarm inbox --notify "));
    assert.ok(command, refusal.stderr);
    assert.ok(command.endsWith("--take-over"), command);
    const bin = join(f.root, "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "cswarm"), `#!/bin/sh\nexec '${process.execPath}' --import tsx '${resolve("src/cli.ts")}' "$@"\n`, { mode: 0o755 });
    child = spawn("/bin/sh", ["-c", command], {
      env: { ...process.env, HOME: f.root, XDG_CONFIG_HOME: join(f.root, "config"),
        XDG_STATE_HOME: join(f.root, "state"), NODE_ENV: "test", PATH: `${bin}:${process.env.PATH ?? ""}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const running = child;
    let stderr = "";
    running.stderr?.on("data", (chunk: Buffer) => stderr += chunk.toString());
    const exit = new Promise<number | null>((done, reject) => {
      const timer = setTimeout(() => { running.kill("SIGKILL"); reject(new Error("holder command timeout")); }, 5000);
      running.once("exit", code => { clearTimeout(timer); done(code); });
      running.once("error", reject);
    });
    const deadline = Date.now() + 3000;
    while (f.seen.filter(row => row.kind === "claim_wake_lease").length < 2 && Date.now() < deadline) {
      await new Promise(done => setTimeout(done, 20));
    }
    assert.equal(f.seen.filter(row => row.kind === "claim_wake_lease").length, 2, stderr);
    assert.equal(f.seen[1]?.take_over, true);
    running.kill("SIGTERM");
    assert.equal(await exit, 143, stderr);
  } finally { if (child?.exitCode === null) child.kill("SIGKILL"); await f.cleanup(); }
});

test("unmanaged credential starts and holds a lease until clean stop", { timeout: 10_000 }, async () => {
  const f = await fixture("unmanaged");
  try {
    const watch = f.start();
    const deadline = Date.now() + 4000;
    while (!f.seen.some(command => command.kind === "renew_wake_lease") && Date.now() < deadline) {
      await new Promise(done => setTimeout(done, 20));
    }
    assert.ok(f.seen.some(command => command.kind === "claim_wake_lease"));
    assert.ok(f.seen.some(command => command.kind === "renew_wake_lease"));
    watch.stop();
    assert.equal((await watch.exit).code, 143);
    assert.ok(f.seen.some(command => command.kind === "release_wake_lease"));
  } finally { await f.cleanup(); }
});

test("SIGINT releases the held lease before exit 130", { timeout: 10_000 }, async () => {
  const f = await fixture("lifecycle");
  try {
    const watch = f.start();
    const deadline = Date.now() + 4000;
    while (!f.seen.some(command => command.kind === "renew_wake_lease") && Date.now() < deadline) {
      await new Promise(done => setTimeout(done, 20));
    }
    assert.ok(f.seen.some(command => command.kind === "renew_wake_lease"));
    watch.interrupt();
    assert.equal((await watch.exit).code, 130);
    assert.equal(f.seen.filter(command => command.kind === "release_wake_lease").length, 1);
  } finally { await f.cleanup(); }
});

test("clean stop releases immediately and crash restarts with the same host id", { timeout: 20_000 }, async () => {
  const f = await fixture("lifecycle");
  const waitForClaims = async (count: number) => {
    const deadline = Date.now() + 4000;
    while (f.seen.filter(command => command.kind === "claim_wake_lease").length < count && Date.now() < deadline) {
      await new Promise(done => setTimeout(done, 20));
    }
    assert.equal(f.seen.filter(command => command.kind === "claim_wake_lease").length, count);
    const renewDeadline = Date.now() + 2000;
    while (f.seen.filter(command => command.kind === "renew_wake_lease").length < count && Date.now() < renewDeadline) {
      await new Promise(done => setTimeout(done, 20));
    }
    assert.ok(f.seen.filter(command => command.kind === "renew_wake_lease").length >= count);
  };
  try {
    const first = f.start();
    await waitForClaims(1);
    first.stop();
    assert.equal((await first.exit).code, 143);
    assert.equal(f.seen.filter(command => command.kind === "release_wake_lease").length, 1);
    const second = f.start();
    await waitForClaims(2);
    second.crash();
    await second.exit;
    const third = f.start();
    await waitForClaims(3);
    assert.equal(f.seen.filter(command => command.kind === "claim_wake_lease")[0]?.host_id,
      f.seen.filter(command => command.kind === "claim_wake_lease")[2]?.host_id);
    assert.equal(f.seen.filter(command => command.kind === "release_wake_lease").length, 1);
    third.stop();
    assert.equal((await third.exit).code, 143);
  } finally { await f.cleanup(); }
});

test("transient start claim retries with one notice before watching", { timeout: 15_000 }, async () => {
  const f = await fixture("claim_retry");
  try {
    const watch = f.start();
    const deadline = Date.now() + 8500;
    while (!f.seen.some(command => command.kind === "renew_wake_lease") && Date.now() < deadline) {
      await new Promise(done => setTimeout(done, 20));
    }
    assert.equal(f.seen.filter(command => command.kind === "claim_wake_lease").length, 3);
    assert.ok(f.seen.some(command => command.kind === "renew_wake_lease"));
    watch.stop();
    const result = await watch.exit;
    assert.equal(result.code, 143, result.stderr);
    assert.equal(result.stderr.match(/wake lease claim is unavailable/g)?.length, 1);
  } finally { await f.cleanup(); }
});

test("SIGTERM during claim backoff keeps exit 143 and one stop sentence", { timeout: 8000 }, async () => {
  const f = await fixture("claim_retry");
  try {
    const watch = f.start();
    const deadline = Date.now() + 4000;
    while (f.seen.length < 1 && Date.now() < deadline) await new Promise(done => setTimeout(done, 20));
    assert.equal(f.seen[0]?.kind, "claim_wake_lease");
    await new Promise(done => setTimeout(done, 100));
    watch.stop();
    const result = await watch.exit;
    assert.equal(result.code, 143, result.stderr);
    assert.equal(result.stderr.match(/nothing is watching this inbox now/g)?.length, 1);
  } finally { await f.cleanup(); }
});

test("SIGINT during an in-flight claim keeps exit 130 and one stop sentence", { timeout: 8000 }, async () => {
  const f = await fixture("claim_inflight");
  try {
    const watch = f.start();
    const deadline = Date.now() + 4000;
    while (f.seen.length < 1 && Date.now() < deadline) await new Promise(done => setTimeout(done, 20));
    assert.equal(f.seen[0]?.kind, "claim_wake_lease");
    watch.interrupt();
    const result = await watch.exit;
    assert.equal(result.code, 130, result.stderr);
    assert.equal(result.stderr.match(/nothing is watching this inbox now/g)?.length, 1);
  } finally { await f.cleanup(); }
});

test("takeover sends the fresh-lease override", { timeout: 8000 }, async () => {
  const f = await fixture("takeover");
  try {
    const watch = f.start(true);
    const deadline = Date.now() + 3000;
    while (f.seen.length < 1 && Date.now() < deadline) await new Promise(done => setTimeout(done, 10));
    assert.equal(f.seen[0]?.take_over, true);
    watch.stop();
    assert.equal((await watch.exit).code, 143);
  } finally { await f.cleanup(); }
});

test("timer renewal supersession exits with the holder and non-restartable code", { timeout: 8000 }, async () => {
  const f = await fixture("supersede");
  try {
    const result = await f.start().exit;
    assert.equal(result.code, EXIT_NOTIFY_LEASE_LOST, result.stderr);
    assert.match(result.stderr, /wake_lease_superseded.*must not be restarted.*new-host/);
    assert.ok(f.seen.some(command => command.kind === "renew_wake_lease"));
  } finally { await f.cleanup(); }
});

test("stdin holder and supersession refusals give words and no pasteable command", { timeout: 16_000 }, async () => {
  for (const [mode, code] of [["refuse", "notify_held_elsewhere"], ["supersede", "wake_lease_superseded"]] as const) {
    const f = await fixture(mode);
    try {
      const result = await f.start(false, undefined, undefined, undefined, true).exit;
      assert.equal(result.code, 76, result.stderr);
      assert.match(result.stderr, new RegExp(code));
      assert.match(result.stderr, /same way it was started, with the agent token on stdin/);
      assert.doesNotMatch(result.stderr, /<credential-file>|^cswarm inbox --notify/gm);
      if (mode === "refuse") {
        assert.match(result.stderr, /adding --take-over/);
      } else {
        assert.ok(f.seen.some(command => command.kind === "renew_wake_lease"));
      }
    } finally { await f.cleanup(); }
  }
});

test("every session fence refusal on start uses its own sentence and exit", { timeout: 15_000 }, async () => {
  const sentences = {
    session_conflict: /another live session owns this seat.*moved elsewhere/i,
    session_expired: /host session ended.*resume output/i,
    session_retired: /host session was retired.*new live session/i,
    session_proof_invalid: /managed seat's watcher needs a valid session proof.*resume output/i,
    session_proof_missing: /managed seat's watcher needs a live session proof.*resume output/i,
  } as const;
  for (const code of ["session_conflict", "session_expired", "session_retired",
    "session_proof_invalid", "session_proof_missing"] as const) {
    const f = await fixture(code);
    try {
      const result = await f.start().exit;
      assert.equal(result.code, EXIT_NOTIFY_LEASE_LOST, `${code}: ${result.stderr}`);
      assert.match(result.stderr, sentences[code]);
      assert.match(result.stderr, /must not be restarted by a supervisor/);
      assert.doesNotMatch(result.stderr, /supervisor; [A-Z]/);
      assert.doesNotMatch(result.stderr, /<path>|<valid-path>/);
      assert.doesNotMatch(result.stderr, /cswarm session start/i);
      for (const other of Object.keys(sentences) as Array<keyof typeof sentences>) if (other !== code) {
        assert.doesNotMatch(result.stderr, sentences[other]);
      }
    } finally { await f.cleanup(); }
  }
});

async function liveContext(f: Awaited<ReturnType<typeof fixture>>, tokenFile = f.credential,
  hostSessionId = "live-host-session", fileName?: string): Promise<string> {
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(f.root, "config");
  try {
    const context = { ...newSessionBinding({ target: cloudTarget(f.url, f.anonKey),
      workspaceId: workspace, principalId: principal, provider: "claude", mode: "interactive",
      hostSessionId, tokenFile }), generation: 1 };
    const defaultPath = defaultSessionContextPath(workspace, principal, context.session_id);
    const path = fileName === undefined ? defaultPath : join(dirname(defaultPath), fileName);
    await writeSessionContext(path, context);
    f.setLiveSession({ session_id: context.session_id, generation: context.generation });
    return path;
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
  }
}

test("start refusal uses the non-default context file it read in a runnable remedy", { timeout: 12_000 }, async () => {
  const f = await fixture("session_proof_missing");
  let child: ChildProcess | null = null;
  try {
    const contextPath = await liveContext(f, f.credential, "live-host-session", "custom-name.json");
    const refused = await f.start().exit;
    assert.equal(refused.code, 76, refused.stderr);
    assert.doesNotMatch(refused.stderr, /cswarm session start/i);
    const printed = refused.stderr.split("\n").find(line => line.startsWith("cswarm inbox --notify "));
    assert.ok(printed, refused.stderr);
    assert.ok(printed.includes(`--session-context ${contextPath}`), printed);
    const bin = join(f.root, "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "cswarm"), `#!/bin/sh\nexec '${process.execPath}' --import tsx '${resolve("src/cli.ts")}' "$@"\n`, { mode: 0o755 });
    child = spawn("/bin/sh", ["-c", printed!], {
      env: { ...process.env, HOME: f.root, XDG_CONFIG_HOME: join(f.root, "config"),
        XDG_STATE_HOME: join(f.root, "state"), NODE_ENV: "test", PATH: `${bin}:${process.env.PATH ?? ""}` }, stdio: ["ignore", "pipe", "pipe"],
    });
    const running = child;
    let stderr = "";
    running.stderr?.on("data", (chunk: Buffer) => stderr += chunk.toString());
    const exit = new Promise<number | null>((done, reject) => {
      const timer = setTimeout(() => { running.kill("SIGKILL"); reject(new Error("printed remedy timeout")); }, 6000);
      running.once("exit", (code) => { clearTimeout(timer); done(code); });
      running.once("error", reject);
    });
    const deadline = Date.now() + 4000;
    while (f.seen.filter(command => command.kind === "claim_wake_lease").length < 2 && Date.now() < deadline) {
      await new Promise(done => setTimeout(done, 20));
    }
    assert.equal(f.seen.filter(command => command.kind === "claim_wake_lease").length, 2, stderr);
    running.kill("SIGTERM");
    assert.equal(await exit, 143, stderr);
    assert.equal(f.seen.some(command => command.kind === "acquire_agent_session"), false);
    assert.deepEqual(await readdir(join(f.root, "config", "cswarm", "sessions", workspace, principal)),
      [`${contextPath.split("/").at(-1)}`]);
  } finally { if (child?.exitCode === null) child.kill("SIGKILL"); await f.cleanup(); }
});

test("a long exit-76 remedy prints a complete command that the real CLI accepts", { timeout: 12_000 }, async () => {
  const f = await fixture("session_proof_missing", `public-test-${"A".repeat(1100)}`);
  let child: ChildProcess | null = null;
  try {
    const contextPath = await liveContext(f);
    const result = await f.start().exit;
    assert.equal(result.code, 76, "long refusal must retain its exit status");
    assert.ok(result.stderr.length > 1100, "the command must exceed the generic CLI error cap");
    assert.match(result.stderr, /must not be restarted by a supervisor/);
    assert.match(result.stderr, /session_proof_missing/);
    assert.match(result.stderr, /; exit 76\.\ncswarm inbox --notify /);
    const printed = result.stderr.split("\n").find(line => line.startsWith("cswarm inbox --notify "));
    assert.ok(printed?.endsWith(`--session-context ${contextPath}`), result.stderr);
    const bin = join(f.root, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "cswarm"), `#!/bin/sh\nexec '${process.execPath}' --import tsx '${resolve("src/cli.ts")}' "$@"\n`, { mode: 0o755 });
    child = spawn("/bin/sh", ["-c", printed!], {
      env: { ...process.env, HOME: f.root, XDG_CONFIG_HOME: join(f.root, "config"),
        XDG_STATE_HOME: join(f.root, "state"), NODE_ENV: "test", PATH: `${bin}:${process.env.PATH ?? ""}` }, stdio: ["ignore", "pipe", "pipe"],
    });
    const running = child;
    let stderr = "";
    running.stderr?.on("data", (chunk: Buffer) => stderr += chunk.toString());
    const exit = new Promise<number | null>((done, reject) => {
      const timer = setTimeout(() => { running.kill("SIGKILL"); reject(new Error("printed command timeout")); }, 6000);
      running.once("exit", code => { clearTimeout(timer); done(code); });
      running.once("error", reject);
    });
    const deadline = Date.now() + 4000;
    while (f.seen.filter(command => command.kind === "claim_wake_lease").length < 2 && Date.now() < deadline) {
      await new Promise(done => setTimeout(done, 20));
    }
    assert.equal(f.seen.filter(command => command.kind === "claim_wake_lease").length, 2, stderr);
    running.kill("SIGTERM");
    assert.equal(await exit, 143, stderr);
    assert.equal(f.seen.some(command => command.kind === "acquire_agent_session"), false);
  } finally { if (child?.exitCode === null) child.kill("SIGKILL"); await f.cleanup(); }
});

test("two verified files are named as ambiguous and never produce a restart command", { timeout: 12_000 }, async () => {
  const f = await fixture("session_proof_missing");
  try {
    const contextPath = await liveContext(f);
    const copyPath = join(dirname(contextPath), "copy.json");
    await writeFile(copyPath, await readFile(contextPath), { mode: 0o600 });
    const refused = await f.start().exit;
    assert.equal(refused.code, 76, refused.stderr);
    assert.match(refused.stderr, /more than one live session context file.*verified/);
    assert.doesNotMatch(refused.stderr, /no live session context.*verified/);
    assert.doesNotMatch(refused.stderr, /run cswarm inbox --notify/);
    const resumed = await runResume(f);
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.ok(resumed.stdout.includes(`Live session context on this host: ${contextPath}`));
    assert.ok(resumed.stdout.includes(`Live session context on this host: ${copyPath}`));
  } finally { await f.cleanup(); }
});

test("supplied session-context path reaches the real CLI refusal sentence", { timeout: 8000 }, async () => {
  const f = await fixture("session_proof_invalid");
  try {
    const path = await liveContext(f);
    const result = await f.start(false, path).exit;
    assert.equal(result.code, 76, result.stderr);
    assert.ok(result.stderr.includes(`the operator's --session-context path ${path} was refused`));
    assert.doesNotMatch(result.stderr, /cswarm session start/i);
    assert.equal(f.seen[0]?.kind, "claim_wake_lease");
  } finally { await f.cleanup(); }
});

async function runResume(f: Awaited<ReturnType<typeof fixture>>, json = false) {
  const bin = join(f.root, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "ps"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const child = spawn(process.execPath, ["--import", "tsx", resolve("src/cli.ts"), "resume",
    "--agent-token-file", f.credential, "--workspace-id", workspace,
    "--url", f.url, "--anon-key", "public-test-key", ...(json ? ["--json"] : [])], {
    env: { ...process.env, HOME: f.root, XDG_CONFIG_HOME: join(f.root, "config"), XDG_STATE_HOME: join(f.root, "state"),
      PATH: `${bin}:${process.env.PATH ?? ""}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => stdout += chunk.toString());
  child.stderr?.on("data", (chunk: Buffer) => stderr += chunk.toString());
  const code = await new Promise<number | null>((done, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("resume timeout")); }, 6000);
    child.once("exit", value => { clearTimeout(timer); done(value); });
    child.once("error", error => { clearTimeout(timer); reject(error); });
  });
  return { code, stdout, stderr };
}

async function runProfileResume(f: Awaited<ReturnType<typeof fixture>>, profilePath: string, host: string) {
  const child = spawn(process.execPath, ["--import", "tsx", resolve("src/cli.ts"), "resume",
    "--profile", profilePath, "--host-session-id", host, "--url", f.url], {
    env: { ...process.env, HOME: f.root, XDG_CONFIG_HOME: join(f.root, "config"),
      XDG_STATE_HOME: join(f.root, "state") }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => stdout += chunk.toString());
  child.stderr?.on("data", (chunk: Buffer) => stderr += chunk.toString());
  const code = await new Promise<number | null>((done, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("profile resume timeout")); }, 6000);
    child.once("exit", value => { clearTimeout(timer); done(value); });
    child.once("error", reject);
  });
  return { code, stdout, stderr };
}

test("refusal fallback leads to real resume output with a verified path or explicit absence", { timeout: 20_000 }, async () => {
  const f = await fixture("session_proof_missing");
  try {
    const absent = await f.start().exit;
    assert.equal(absent.code, 76, absent.stderr);
    assert.match(absent.stderr, /resume output/);
    assert.doesNotMatch(absent.stderr, /run cswarm inbox --notify/);
    const empty = await runResume(f);
    assert.equal(empty.code, 0, empty.stderr);
    assert.match(empty.stdout, /no live session on this host was verified for this seat/);
    assert.doesNotMatch(empty.stdout, /cswarm inbox --notify/);
    const emptyJson = await runResume(f, true);
    assert.equal(emptyJson.code, 0, emptyJson.stderr);
    assert.deepEqual(JSON.parse(emptyJson.stdout).live_session_context_paths, []);
    assert.equal(JSON.parse(emptyJson.stdout).live_session_context_verification_unavailable, false);
    const contextPath = await liveContext(f);
    const refused = await f.start().exit;
    assert.equal(refused.code, 76, refused.stderr);
    assert.match(refused.stderr, /--session-context/);
    const resumed = await runResume(f);
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.ok(resumed.stdout.includes(`Live session context on this host: ${contextPath}`));
    assert.doesNotMatch(resumed.stdout, /cswarm inbox --notify/);
    const machine = await runResume(f, true);
    assert.equal(machine.code, 0, machine.stderr);
    assert.deepEqual(JSON.parse(machine.stdout).live_session_context_paths, [contextPath]);
    f.setLiveSession(null);
    const stale = await f.start().exit;
    assert.equal(stale.code, 76, stale.stderr);
    assert.doesNotMatch(stale.stderr, /run cswarm inbox --notify/);
    const staleResume = await runResume(f);
    assert.equal(staleResume.code, 0, staleResume.stderr);
    assert.match(staleResume.stdout, /no live session on this host was verified for this seat/);
    assert.ok(!staleResume.stdout.includes(contextPath));
    f.setLiveSession({ session_id: basename(contextPath, ".json"), generation: 1 });
    await rm(contextPath);
    const removed = await f.start().exit;
    assert.equal(removed.code, 76, removed.stderr);
    assert.doesNotMatch(removed.stderr, /run cswarm inbox --notify/);
    const removedResume = await runResume(f);
    assert.equal(removedResume.code, 0, removedResume.stderr);
    assert.match(removedResume.stdout, /no live session on this host was verified for this seat/);
    const foreign = { ...newSessionBinding({ target: cloudTarget(f.url, "public-test-key"),
      workspaceId: workspace, principalId: "99999999-9999-4999-8999-999999999999", provider: "claude",
      mode: "interactive", hostSessionId: "foreign-host", tokenFile: f.credential }), generation: 1 };
    const priorConfig = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = join(f.root, "config");
    let foreignPath: string;
    try {
      foreignPath = defaultSessionContextPath(workspace, principal, foreign.session_id);
      await writeSessionContext(foreignPath, foreign);
    } finally {
      if (priorConfig === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = priorConfig;
    }
    f.setLiveSession({ session_id: foreign.session_id, generation: 1 });
    const otherSeat = await f.start().exit;
    assert.equal(otherSeat.code, 76, otherSeat.stderr);
    assert.doesNotMatch(otherSeat.stderr, /run cswarm inbox --notify/);
    const otherSeatResume = await runResume(f);
    assert.equal(otherSeatResume.code, 0, otherSeatResume.stderr);
    assert.match(otherSeatResume.stdout, /no live session on this host was verified for this seat/);
    assert.ok(!otherSeatResume.stdout.includes(foreignPath));
  } finally { await f.cleanup(); }
});

test("unmanaged resume gives a runnable watcher command without context guidance", { timeout: 8_000 }, async () => {
  const f = await fixture("unmanaged");
  let child: ChildProcess | null = null;
  try {
    const resumed = await runResume(f);
    assert.equal(resumed.code, 0, resumed.stderr);
    const command = resumed.stdout.split("\n").find(line => line.startsWith("cswarm inbox --notify "));
    assert.ok(command, resumed.stdout);
    assert.ok(command.includes(`--url ${f.url}`));
    assert.doesNotMatch(resumed.stdout, /after its context is verified/);
    assert.doesNotMatch(resumed.stdout, /--session-context/);
    const bin = join(f.root, "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "cswarm"), `#!/bin/sh\nexec '${process.execPath}' --import tsx '${resolve("src/cli.ts")}' "$@"\n`, { mode: 0o755 });
    child = spawn("/bin/sh", ["-c", command], {
      env: { ...process.env, HOME: f.root, XDG_CONFIG_HOME: join(f.root, "config"),
        XDG_STATE_HOME: join(f.root, "state"), NODE_ENV: "test", PATH: `${bin}:${process.env.PATH ?? ""}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const running = child;
    let stderr = "";
    running.stderr?.on("data", (chunk: Buffer) => stderr += chunk.toString());
    const exit = new Promise<number | null>((done, reject) => {
      const timer = setTimeout(() => { running.kill("SIGKILL"); reject(new Error("resume command timeout")); }, 5000);
      running.once("exit", code => { clearTimeout(timer); done(code); });
      running.once("error", reject);
    });
    const deadline = Date.now() + 3000;
    while (!f.seen.some(row => row.kind === "claim_wake_lease") && Date.now() < deadline) {
      await new Promise(done => setTimeout(done, 20));
    }
    assert.equal(f.seen.filter(row => row.kind === "claim_wake_lease").length, 1, stderr);
    running.kill("SIGTERM");
    assert.equal(await exit, 143, stderr);
  } finally { if (child?.exitCode === null) child.kill("SIGKILL"); await f.cleanup(); }
});

test("signals during the live-context verification read keep the stop sentence and exit code", { timeout: 16_000 }, async () => {
  for (const [signal, expected] of [["SIGTERM", 143], ["SIGINT", 130]] as const) {
    const f = await fixture("session_proof_missing");
    try {
      await liveContext(f);
      f.slowVerification();
      const watcher = f.start();
      const deadline = Date.now() + 4000;
      while (!f.verificationStarted() && Date.now() < deadline) {
        await new Promise(done => setTimeout(done, 20));
      }
      assert.equal(f.verificationStarted(), true, `${signal} must reach the slow verification read`);
      if (signal === "SIGTERM") watcher.stop(); else watcher.interrupt();
      const result = await watcher.exit;
      assert.equal(result.code, expected, result.stderr);
      assert.equal((result.stderr.match(/nothing is watching this inbox now/g) ?? []).length, 1, result.stderr);
      assert.equal(f.seen.filter(command => command.kind === "claim_wake_lease").length, 0);
    } finally { await f.cleanup(); }
  }
});

test("profile start names its host session context and never repeats the refused command", { timeout: 12_000 }, async () => {
  const f = await fixture("session_proof_invalid");
  try {
    const profileDir = join(f.root, "profile");
    const profilePath = join(profileDir, "profile.json");
    const profileCredential = join(profileDir, "credential.json");
    await mkdir(profileDir, { recursive: true, mode: 0o700 });
    await writeFile(profileCredential, await readFile(f.credential), { mode: 0o600 });
    const host = "profile-host";
    await writeFile(profilePath, JSON.stringify({ version: 1, url: f.url, anon_key: "public-test-key",
      workspace_id: workspace, principal_id: principal, credential_file: profileCredential, host_session_id: host }), { mode: 0o600 });
    const contextPath = await liveContext(f, profileCredential, host, "profile-context.json");
    const refused = await f.start(false, undefined, profilePath, host).exit;
    assert.equal(refused.code, 76, refused.stderr);
    assert.ok(refused.stderr.includes(`the profile's host session context ${contextPath} was refused`));
    assert.match(refused.stderr, /resume output/);
    assert.doesNotMatch(refused.stderr, /run cswarm inbox --notify/);
    const resumed = await runProfileResume(f, profilePath, host);
    assert.equal(resumed.code, 0, resumed.stderr);
    const snapshot = JSON.parse(resumed.stdout);
    assert.deepEqual(snapshot.live_session_context_paths, [contextPath]);
    assert.deepEqual(snapshot.live_session_context_lines, [`Live session context on this host: ${contextPath}`]);
    f.setLiveSession(null);
    const absent = await f.start(false, undefined, profilePath, host).exit;
    assert.equal(absent.code, 76, absent.stderr);
    assert.match(absent.stderr, /no live session context.*resume output/);
    assert.doesNotMatch(absent.stderr, /run cswarm inbox --notify/);
  } finally { await f.cleanup(); }
});

test("profile resume keeps its snapshot when the credential file is missing", { timeout: 8_000 }, async () => {
  const f = await fixture("unmanaged");
  try {
    const profileDir = join(f.root, "profile");
    await mkdir(profileDir, { mode: 0o700 });
    const profilePath = join(profileDir, "profile.json");
    const missing = join(profileDir, "credential.json");
    await writeFile(profilePath, JSON.stringify({ version: 1, url: f.url, anon_key: f.anonKey,
      workspace_id: workspace, principal_id: principal, credential_file: missing, host_session_id: "missing-host" }), { mode: 0o600 });
    const result = await runProfileResume(f, profilePath, "missing-host");
    assert.equal(result.code, 0, result.stderr);
    const snapshot = JSON.parse(result.stdout);
    assert.equal(snapshot.authenticated_now, false);
    assert.match(snapshot.live_session_context_lines[0], /could not verify because the credential file is missing/);
    assert.ok(snapshot.live_session_context_lines[0].includes(missing));
  } finally { await f.cleanup(); }
});

test("profile resume distinguishes refused credentials from an unavailable service", { timeout: 10_000 }, async () => {
  for (const [mode, pattern] of [["profile_unauthorized", /service refused this credential \(expired or revoked\).*turn check/],
    ["profile_forbidden", /service refused this credential \(expired or revoked\).*turn check/],
    ["profile_unreachable", /read service returned an error.*after it recovers/],
    ["profile_transport", /could not verify with the read service.*reachable/]] as const) {
    const f = await fixture(mode);
    try {
      const profileDir = join(f.root, "profile");
      await mkdir(profileDir, { mode: 0o700 });
      const profilePath = join(profileDir, "profile.json");
      const credential = join(profileDir, "credential.json");
      await writeFile(credential, await readFile(f.credential), { mode: 0o600 });
      await writeFile(profilePath, JSON.stringify({ version: 1, url: f.url, anon_key: f.anonKey,
        workspace_id: workspace, principal_id: principal, credential_file: credential, host_session_id: "refusal-host" }), { mode: 0o600 });
      await liveContext(f, credential, "refusal-host");
      const result = await runProfileResume(f, profilePath, "refusal-host");
      assert.equal(result.code, 0, result.stderr);
      assert.match(JSON.parse(result.stdout).live_session_context_lines[0], pattern);
    } finally { await f.cleanup(); }
  }
});

test("stdin proof refusal explains the pipe step without an unverified command", { timeout: 8000 }, async () => {
  const f = await fixture("session_proof_missing");
  try {
    const refused = await f.start(false, undefined, undefined, undefined, true).exit;
    assert.equal(refused.code, 76, refused.stderr);
    assert.match(refused.stderr, /pipe the same credential on stdin/);
    assert.doesNotMatch(refused.stderr, /run cswarm inbox --notify/);
  } finally { await f.cleanup(); }
});

test("every stdin session refusal includes pipe guidance", { timeout: 30_000 }, async () => {
  for (const mode of ["session_conflict", "session_expired", "session_retired",
    "session_proof_invalid", "session_proof_missing"] as const) {
    const f = await fixture(mode);
    try {
      const refused = await f.start(false, undefined, undefined, undefined, true).exit;
      assert.equal(refused.code, 76, refused.stderr);
      assert.match(refused.stderr, new RegExp(mode));
      assert.match(refused.stderr, /agent token on stdin|pipe the same credential on stdin/);
      assert.doesNotMatch(refused.stderr, /run cswarm inbox --notify/);
    } finally { await f.cleanup(); }
  }
});

test("a noncanonical spelling of the refused context is recognized as the same file", { timeout: 10_000 }, async () => {
  const f = await fixture("session_proof_invalid");
  try {
    const contextPath = await liveContext(f);
    const folder = dirname(contextPath);
    const noncanonical = `${folder}/../${basename(folder)}/${basename(contextPath)}`;
    const refused = await f.start(false, noncanonical).exit;
    assert.equal(refused.code, 76, refused.stderr);
    assert.match(refused.stderr, /this context was refused/);
    assert.doesNotMatch(refused.stderr, /run cswarm inbox --notify/);
    assert.doesNotMatch(refused.stderr, /retry from that host session using this path/);
  } finally { await f.cleanup(); }
});

test("listen status shows remote lease without claiming mail observation", { timeout: 8000 }, async () => {
  const f = await fixture("status");
  try {
    const result = await f.status();
    assert.equal(result.code, 0, result.stderr);
    const json = JSON.parse(result.stdout) as { wake_lease: Record<string, unknown> };
    assert.equal(json.wake_lease.host_label, "remote-host");
    assert.equal(json.wake_lease.generation, 3);
    assert.equal(json.wake_lease.renewed_age_ms, 1200);
    assert.equal(json.wake_lease.held_by_this_host, false);
    assert.equal(json.wake_lease.renewal_is_mail_observation, false);
  } finally { await f.cleanup(); }
});
