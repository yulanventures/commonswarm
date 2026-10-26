import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, rmSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { once } from "node:events";
import { createRequire } from "node:module";
import {
  environment, finalizeRunResources, ISOLATED_STATE_ENV,
  isolatedStateEnv, runTable,
} from "../../scripts/timeout-table/run.mjs";
import { AGENT_CREDENTIAL_MESSAGE_D088 } from "../../src/cloud/agent-credential-input.js";
import { readJsonLines, runChild, withPrivateProfile } from "../../scripts/timeout-table/core.mjs";

const { originWriteKind, describeOriginWriteRules } = createRequire(import.meta.url)(
  "../../scripts/timeout-table/writes.cjs",
) as { originWriteKind: (method: string, path: string) => string | null; describeOriginWriteRules: () => string };

const repo = resolve(import.meta.dirname, "../..");

async function listen(delayMs: () => number) {
  let requests = 0;
  let receivedSecret = false;
  let elapsedDelayMs = 0;
  const server = createServer(async (request, response) => {
    requests += 1;
    receivedSecret ||= request.headers.authorization === "Bearer secret-shaped-value";
    const delay = delayMs();
    await new Promise(resolvePromise => setTimeout(resolvePromise, delay));
    elapsedDelayMs += delay;
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"external":{}}');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    get requests() { return requests; },
    get receivedSecret() { return receivedSecret; },
    get elapsedDelayMs() { return elapsedDelayMs; },
  };
}

test("preload rewrites only the origin and logs no header, body, query, or secret", async (t) => {
  const original = await listen(() => 0);
  const target = await listen(() => 5);
  t.after(() => original.server.close());
  t.after(() => target.server.close());
  const directory = await mkdtemp(join(tmpdir(), "timeout-preload-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const log = join(directory, "fetch.jsonl");
  await writeFile(log, "", { mode: 0o600 });
  const code = `fetch(${JSON.stringify(`${original.url}/functions/v1/read?token=query-secret`)},{method:'POST',headers:{authorization:'Bearer secret-shaped-value'},body:'body-secret'}).then(r=>r.arrayBuffer()).then(()=>process.exit(0),()=>process.exit(1))`;
  const result = await runChild(process.execPath, ["-e", code], { env: {
    ...process.env,
    NODE_OPTIONS: `--require=${join(repo, "scripts/timeout-table/preload.cjs")}`,
    TIMEOUT_TABLE_BASE_URL: target.url,
    TIMEOUT_TABLE_PROFILE_ORIGIN: original.url,
    TIMEOUT_TABLE_FETCH_LOG: log,
  } });
  assert.equal(result.code, 0);
  assert.equal(original.requests, 0);
  assert.equal(target.requests, 1);
  assert.equal(target.receivedSecret, true);
  const raw = await readFile(log, "utf8");
  assert.doesNotMatch(raw, /secret|token|authorization|header|body|query/i);
  assert.deepEqual((await readJsonLines(log)).map(row => ({ method: row.method, path: row.path, status: row.status })),
    [{ method: "POST", path: "/functions/v1/read", status: 200 }]);
});

test("preload duration includes the response body and does not forward writes or other origins", async (t) => {
  const original = await listen(() => 0);
  let commandHits = 0;
  let otherHits = 0;
  const bodyTarget = createServer((request, response) => {
    if ((request.url ?? "").startsWith("/functions/v1/command")) {
      commandHits += 1;
      response.writeHead(200); response.end("{}");
      return;
    }
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.write("head");
    setTimeout(() => { response.end("x".repeat(32)); }, 120);
  });
  bodyTarget.listen(0, "127.0.0.1");
  await once(bodyTarget, "listening");
  const other = createServer((_request, response) => {
    otherHits += 1;
    response.writeHead(200); response.end("{}");
  });
  other.listen(0, "127.0.0.1");
  await once(other, "listening");
  t.after(() => original.server.close());
  t.after(() => bodyTarget.close());
  t.after(() => other.close());
  const bodyAddress = bodyTarget.address();
  const otherAddress = other.address();
  assert.ok(bodyAddress && typeof bodyAddress === "object");
  assert.ok(otherAddress && typeof otherAddress === "object");
  const bodyUrl = `http://127.0.0.1:${bodyAddress.port}`;
  const otherUrl = `http://127.0.0.1:${otherAddress.port}`;
  const directory = await mkdtemp(join(tmpdir(), "timeout-preload-body-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const log = join(directory, "fetch.jsonl");
  await writeFile(log, "", { mode: 0o600 });
  const env = {
    ...process.env,
    NODE_OPTIONS: `--require=${join(repo, "scripts/timeout-table/preload.cjs")}`,
    TIMEOUT_TABLE_BASE_URL: bodyUrl,
    TIMEOUT_TABLE_PROFILE_ORIGIN: original.url,
    TIMEOUT_TABLE_FETCH_LOG: log,
  };
  const body = await runChild(process.execPath, ["-e",
    `fetch(${JSON.stringify(`${original.url}/functions/v1/read`)}).then(r=>r.arrayBuffer()).then(()=>process.exit(0),()=>process.exit(1))`], { env });
  assert.equal(body.code, 0);
  const bodyRow = (await readJsonLines(log)).at(-1);
  assert.ok((bodyRow?.duration_ms ?? 0) >= 100, `body duration ${bodyRow?.duration_ms}`);

  const write = await runChild(process.execPath, ["-e",
    `fetch(${JSON.stringify(`${original.url}/functions/v1/command`)},{method:'POST',body:'{}'}).then(()=>process.exit(0),()=>process.exit(1))`], { env });
  assert.notEqual(write.code, 0);
  assert.equal(commandHits, 0);
  assert.equal(originWriteKind("POST", "/functions/v1/command"), "command");

  const leaked = await runChild(process.execPath, ["-e",
    `fetch(${JSON.stringify(`${otherUrl}/storage/v1/object`)}).then(()=>process.exit(0),()=>process.exit(1))`], { env });
  assert.notEqual(leaked.code, 0);
  assert.equal(otherHits, 0);

  const relative = await runChild(process.execPath, ["-e",
    "fetch('/functions/v1/read').then(()=>process.exit(0),()=>process.exit(1))"], { env });
  assert.notEqual(relative.code, 0);
  const relativeRows = await readJsonLines(log);
  assert.equal(relativeRows.some(row => row.path === "/functions/v1/read" && row.status === "BLOCKED"), true);

  const relativeQuery = await runChild(process.execPath, ["-e",
    "fetch('/api/query?token=secret123').then(()=>process.exit(0),()=>process.exit(1))"], { env });
  assert.notEqual(relativeQuery.code, 0);
  const queryLog = await readFile(log, "utf8");
  assert.doesNotMatch(queryLog, /secret123|token=/);
  const queryRows = await readJsonLines(log);
  assert.equal(queryRows.some(row => row.path === "/api/query" && row.status === "BLOCKED"), true);

  const relativeWs = await runChild(process.execPath, ["-e", `
    try { new WebSocket("/realtime/v1/websocket?token=ws-secret"); process.exit(0); }
    catch { process.exit(2); }
  `], { env });
  assert.equal(relativeWs.code, 2);
  const wsLog = await readFile(log, "utf8");
  assert.doesNotMatch(wsLog, /ws-secret|token=/);
  const wsRows = await readJsonLines(log);
  assert.equal(wsRows.some(row => row.method === "CONNECT" && row.path === "/realtime/v1/websocket" && row.status === "BLOCKED"), true);
});

test("private profile copy is removed after success and injected failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "timeout-profile-test-"));
  await chmod(directory, 0o700);
  const credential = join(directory, "credential.json");
  const profile = join(directory, "profile.json");
  await writeFile(credential, '{"token":"secret-shaped-value","expires_at":"2099-01-01T00:00:00Z"}', { mode: 0o600 });
  await writeFile(join(directory, "sibling-secret.txt"), "other-secret", { mode: 0o600 });
  await writeFile(profile, JSON.stringify({ version: 1, url: "http://127.0.0.1:1", anon_key: "public", workspace_id: "00000000-0000-4000-8000-000000000001", principal_id: "00000000-0000-4000-8000-000000000002", credential_file: credential }), { mode: 0o600 });
  try {
    let successRoot = "";
    await withPrivateProfile(profile, async copy => {
      successRoot = copy.root;
      assert.equal((await stat(copy.root)).mode & 0o777, 0o700);
      assert.equal((await stat(copy.profilePath)).mode & 0o777, 0o600);
      assert.notEqual(copy.profile.credential_file, credential);
      assert.doesNotMatch(await readFile(copy.profile.credential_file, "utf8"), /expires_at/);
      await assert.rejects(stat(join(copy.root, "profile", "sibling-secret.txt")), { code: "ENOENT" });
    });
    await assert.rejects(stat(successRoot), { code: "ENOENT" });

    let failureRoot = "";
    await assert.rejects(withPrivateProfile(profile, async copy => {
      failureRoot = copy.root;
      throw new Error("injected failure");
    }), /injected failure/);
    await assert.rejects(stat(failureRoot), { code: "ENOENT" });
    assert.equal(await readFile(credential, "utf8"), '{"token":"secret-shaped-value","expires_at":"2099-01-01T00:00:00Z"}');

    const namedCredential = join(directory, "named-credential.json");
    const profileNamedCredential = join(directory, "credential.json");
    await writeFile(namedCredential, '{"token":"secret-shaped-value"}', { mode: 0o600 });
    await writeFile(profileNamedCredential, JSON.stringify({
      version: 1, url: "http://127.0.0.1:1", anon_key: "public",
      workspace_id: "00000000-0000-4000-8000-000000000001",
      principal_id: "00000000-0000-4000-8000-000000000002",
      credential_file: namedCredential,
    }), { mode: 0o600 });
    await withPrivateProfile(profileNamedCredential, async copy => {
      assert.notEqual(copy.profilePath, copy.profile.credential_file);
      assert.equal((await stat(copy.profilePath)).isFile(), true);
      assert.equal((await stat(copy.profile.credential_file)).isFile(), true);
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function porcelainWorktrees(gitRepo: string): string[] {
  const listed = execFileSync("git", ["-C", gitRepo, "worktree", "list", "--porcelain"], { encoding: "utf8" });
  return listed.split("\n").filter(line => line.startsWith("worktree ")).map(line => line.slice("worktree ".length));
}

async function waitForFile(path: string, timeoutMs = 15_000, diagnostic = () => "") {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      await stat(path);
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 15));
    }
  }
  throw new Error(`timed out waiting for ${path}: ${diagnostic()}`);
}

type ExitPaths = {
  tempRoot: string;
  worktreePath: string;
  copyRoot: string;
  profilePath: string;
  credentialFile: string;
};

async function spawnExitFixture(t: { after: (fn: () => void) => void }, mode: "exit13" | "sigterm" | "sighup" | "sigint") {
  const home = await mkdtemp(join(tmpdir(), "timeout-table-home-"));
  t.after(() => { rmSync(home, { recursive: true, force: true }); });
  // Cleanup needs a real worktree, but never writes the checkout's shared
  // Git metadata. Give each child a tiny, disposable source repository.
  const gitRepo = join(home, "source-repo");
  await mkdir(gitRepo);
  execFileSync("git", ["init", "-q", gitRepo], { stdio: "ignore" });
  execFileSync("git", ["-C", gitRepo, "-c", "user.name=Cleanup fixture",
    "-c", "user.email=cleanup@commonswarm.local", "-c", "core.hooksPath=/dev/null",
    "commit", "--allow-empty", "--no-gpg-sign", "-qm", "Synthetic cleanup source"], { stdio: "ignore" });
  const profileDir = join(home, "profile-src");
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  await chmod(profileDir, 0o700);
  const credential = join(profileDir, "credential.json");
  const profile = join(profileDir, "profile.json");
  const credentialBody = '{"token":"secret-shaped-value","expires_at":"2099-01-01T00:00:00Z"}';
  await writeFile(credential, credentialBody, { mode: 0o600 });
  await writeFile(profile, JSON.stringify({
    version: 1,
    url: "http://127.0.0.1:1",
    anon_key: "public",
    workspace_id: "00000000-0000-4000-8000-000000000001",
    principal_id: "00000000-0000-4000-8000-000000000002",
    credential_file: credential,
  }), { mode: 0o600 });
  const marker = join(home, "marker.json");
  const fixture = join(repo, "tests/p1-cli/timeout-table-exit-fixture.mjs");
  const child = spawn(process.execPath, [fixture, mode, marker, profile, gitRepo], {
    cwd: home,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/local/bin", HOME: home },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", chunk => { stderr += chunk; });
  const killTimer = setTimeout(() => child.kill("SIGKILL"), 20_000);
  const closed = once(child, "close") as Promise<[number | null, NodeJS.Signals | null]>;
  closed.then(() => clearTimeout(killTimer), () => clearTimeout(killTimer));
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  let paths: ExitPaths | null = null;
  t.after(() => {
    if (!paths) return;
    try {
      execFileSync("git", ["-C", gitRepo, "worktree", "remove", "--force", paths.worktreePath], {
        stdio: ["ignore", "ignore", "ignore"],
        timeout: 10_000,
      });
    } catch { /* leftover only if the test failed */ }
    try { rmSync(paths.tempRoot, { recursive: true, force: true }); } catch { /* already gone */ }
  });
  return {
    child, closed, marker, credential, credentialBody, gitRepo,
    get stderr() { return stderr; },
    get paths() { return paths; },
    set paths(value: ExitPaths | null) { paths = value; },
  };
}

async function assertArtifactsPresent(paths: ExitPaths, gitRepo: string) {
  assert.equal((await stat(paths.tempRoot)).isDirectory(), true);
  assert.equal((await stat(paths.copyRoot)).isDirectory(), true);
  assert.equal((await stat(paths.profilePath)).isFile(), true);
  assert.equal((await stat(paths.credentialFile)).isFile(), true);
  assert.ok(
    porcelainWorktrees(gitRepo).includes(paths.worktreePath),
    `worktree not registered: ${paths.worktreePath}`,
  );
}

async function assertArtifactsGone(paths: ExitPaths, gitRepo: string) {
  await assert.rejects(stat(paths.tempRoot), { code: "ENOENT" });
  await assert.rejects(stat(paths.copyRoot), { code: "ENOENT" });
  await assert.rejects(stat(paths.profilePath), { code: "ENOENT" });
  await assert.rejects(stat(paths.credentialFile), { code: "ENOENT" });
  assert.ok(
    !porcelainWorktrees(gitRepo).includes(paths.worktreePath),
    `worktree still registered: ${paths.worktreePath}`,
  );
  assert.equal(porcelainWorktrees(gitRepo).length, 1, "the source checkout survives cleanup");
}

test("unexpected exit 13 removes the profile copy and the git worktree", async t => {
  const session = await spawnExitFixture(t, "exit13");
  await waitForFile(session.marker, 15_000, () => session.stderr);
  session.paths = JSON.parse(await readFile(session.marker, "utf8")) as ExitPaths;
  await assertArtifactsPresent(session.paths, session.gitRepo);
  await writeFile(`${session.marker}.go`, "go", { mode: 0o600 });
  const [code, signal] = await session.closed;
  assert.equal(signal, null, session.stderr);
  assert.equal(code, 13, session.stderr);
  await assertArtifactsGone(session.paths, session.gitRepo);
  assert.equal(await readFile(session.credential, "utf8"), session.credentialBody);
});

test("SIGTERM removes the profile copy and the git worktree", async t => {
  const session = await spawnExitFixture(t, "sigterm");
  await waitForFile(session.marker, 15_000, () => session.stderr);
  session.paths = JSON.parse(await readFile(session.marker, "utf8")) as ExitPaths;
  await assertArtifactsPresent(session.paths, session.gitRepo);
  session.child.kill("SIGTERM");
  const [code, signal] = await session.closed;
  assert.equal(signal, null, session.stderr);
  assert.equal(code, 143, session.stderr);
  await assertArtifactsGone(session.paths, session.gitRepo);
  assert.equal(await readFile(session.credential, "utf8"), session.credentialBody);
});

test("SIGHUP removes the profile copy and the git worktree", async t => {
  const session = await spawnExitFixture(t, "sighup");
  await waitForFile(session.marker, 15_000, () => session.stderr);
  session.paths = JSON.parse(await readFile(session.marker, "utf8")) as ExitPaths;
  await assertArtifactsPresent(session.paths, session.gitRepo);
  session.child.kill("SIGHUP");
  const [code, signal] = await session.closed;
  assert.equal(signal, null, session.stderr);
  assert.equal(code, 129, session.stderr);
  await assertArtifactsGone(session.paths, session.gitRepo);
  assert.equal(await readFile(session.credential, "utf8"), session.credentialBody);
});

test("finalizeRunResources deletes the temp root before uninstalling signals", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "timeout-table-finalize-"));
  const resources = { repo, tempRoot, worktreePath: null };
  let uninstalled = false;
  finalizeRunResources(resources, () => {
    assert.equal(existsSync(tempRoot), false, "temp root still present at uninstall");
    uninstalled = true;
  });
  assert.equal(uninstalled, true);
  await assert.rejects(stat(tempRoot), { code: "ENOENT" });
});

test("SIGINT removes the profile copy and the git worktree", async t => {
  const session = await spawnExitFixture(t, "sigint");
  await waitForFile(session.marker, 15_000, () => session.stderr);
  session.paths = JSON.parse(await readFile(session.marker, "utf8")) as ExitPaths;
  await assertArtifactsPresent(session.paths, session.gitRepo);
  session.child.kill("SIGINT");
  const [code, signal] = await session.closed;
  assert.equal(signal, null, session.stderr);
  assert.equal(code, 130, session.stderr);
  await assertArtifactsGone(session.paths, session.gitRepo);
  assert.equal(await readFile(session.credential, "utf8"), session.credentialBody);
});

test("measurement children do not create or change parent state directories", async t => {
  const sentinel = await mkdtemp(join(tmpdir(), "timeout-table-sentinel-"));
  t.after(() => rm(sentinel, { recursive: true, force: true }));
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(ISOLATED_STATE_ENV)) {
    previous[key] = process.env[key];
    process.env[key] = join(sentinel, key);
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  await writeFile(join(sentinel, "MARKER"), "keep", { mode: 0o600 });
  const copyRoot = await mkdtemp(join(tmpdir(), "timeout-table-isolated-"));
  t.after(() => rm(copyRoot, { recursive: true, force: true }));
  const log = join(copyRoot, "fetch.jsonl");
  await writeFile(log, "", { mode: 0o600 });
  const env = environment("http://127.0.0.1:1", {
    root: copyRoot,
    profile: { url: "http://127.0.0.1:9", anon_key: "public" },
  }, log);
  assert.deepEqual(Object.keys(ISOLATED_STATE_ENV).sort(), [
    "CLAUDE_CONFIG_DIR", "GROK_HOME", "HOME", "SWARM_AGENT_STATE_DIR",
    "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR", "XDG_STATE_HOME",
  ].sort());
  const isolated = isolatedStateEnv(copyRoot);
  for (const key of Object.keys(ISOLATED_STATE_ENV)) {
    assert.equal(env[key], isolated[key], key);
    assert.equal(env[key]!.startsWith(copyRoot), true, key);
    assert.notEqual(env[key], process.env[key], key);
  }
  const script = `
    import { cloudTarget } from ${JSON.stringify(join(repo, "src/cloud/config.ts"))};
    import { agentCredentialStore, defaultAgentCredentialDirectory } from ${JSON.stringify(join(repo, "src/cloud/agent-credential.ts"))};
    import { defaultListenerStateDirectory } from ${JSON.stringify(join(repo, "src/listener/file-store.ts"))};
    import { ensureSecureStateDirectory } from ${JSON.stringify(join(repo, "src/cloud/storage.ts"))};
    const cred = defaultAgentCredentialDirectory();
    const listener = defaultListenerStateDirectory();
    await ensureSecureStateDirectory(listener);
    const store = await agentCredentialStore({
      target: cloudTarget("http://127.0.0.1:1", "public"),
      lineageKey: ${JSON.stringify("a".repeat(32))},
    });
    await store.withLock(async () => {});
    process.stdout.write(JSON.stringify({
      cred, listener,
      swarm: process.env.SWARM_AGENT_STATE_DIR,
      xdg: process.env.XDG_STATE_HOME,
      home: process.env.HOME,
    }));
  `;
  const result = await runChild(process.execPath, ["--import", "tsx", "-e", script], { env });
  assert.equal(result.code, 0, result.stderr);
  const reported = JSON.parse(result.stdout) as { cred: string; listener: string; swarm: string; xdg: string; home: string };
  assert.equal(reported.home, copyRoot);
  assert.equal(reported.swarm.startsWith(copyRoot), true);
  assert.equal(reported.xdg.startsWith(copyRoot), true);
  assert.equal(reported.cred.startsWith(copyRoot), true);
  assert.equal(reported.listener.startsWith(copyRoot), true);
  const listed = execFileSync("find", [sentinel, "-print"], { encoding: "utf8" }).trim().split("\n").sort();
  assert.deepEqual(listed, [sentinel, join(sentinel, "MARKER")].sort());
});

test("runTable does not write to the origin and will not PASS unacknowledged NOT MEASURED rows", async t => {
  const workspace = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const principal = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const writes: string[] = [];
  const server = createServer((request, response) => {
    const url = request.url ?? "";
    if (request.method === "POST" && (url === "/functions/v1/command" || url === "/functions/v1/activity")) {
      writes.push(`${request.method} ${url}`);
    }
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", chunk => { raw += chunk; });
    request.on("end", () => {
      let body: Record<string, unknown> = {};
      try { body = raw ? JSON.parse(raw) as Record<string, unknown> : {}; } catch { body = {}; }
      if (url.startsWith("/auth/v1/settings")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"external":{}}');
        return;
      }
      if (url === "/functions/v1/read" && body.resource === "members") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          members: [],
          agents: [{ principal_id: principal, name: "Agent", owner_user_id: principal }],
          identity: {
            credential_valid: true, principal_id: principal, workspace_id: workspace, owner_user_id: principal,
          },
        }));
        return;
      }
      if (url === "/functions/v1/read" && body.resource === "signals") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          signals: [],
          capabilities: { sender_owner_relation: 1, cursor_after: 1 },
        }));
        return;
      }
      if (url === "/functions/v1/read" && body.resource === "channels") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ channels: [] }));
        return;
      }
      if (url === "/functions/v1/read" && body.resource === "files") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ files: [] }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;
  const home = await mkdtemp(join(tmpdir(), "timeout-table-run-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const sentinel = await mkdtemp(join(tmpdir(), "timeout-table-run-sentinel-"));
  t.after(() => rm(sentinel, { recursive: true, force: true }));
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(ISOLATED_STATE_ENV)) {
    previous[key] = process.env[key];
    process.env[key] = join(sentinel, key);
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  await writeFile(join(sentinel, "MARKER"), "keep", { mode: 0o600 });
  const profileDir = join(home, "profile-src");
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  await chmod(profileDir, 0o700);
  const credential = join(profileDir, "credential.json");
  const profile = join(profileDir, "profile.json");
  await writeFile(credential, JSON.stringify({
    message: AGENT_CREDENTIAL_MESSAGE_D088,
    status: "accepted",
    principal_id: principal,
    token_id: "11111111-1111-4111-8111-111111111111",
    run_id: "22222222-2222-4222-8222-222222222222",
    agent_token: `swm_agt_${"A".repeat(43)}`,
    expires_at: "2099-01-01T00:00:00.000Z",
  }), { mode: 0o600 });
  await writeFile(profile, JSON.stringify({
    version: 1, url, anon_key: "public", workspace_id: workspace, principal_id: principal,
    credential_file: credential,
  }), { mode: 0o600 });
  const signalId = "src/cloud/signals.ts:SIGNAL_READ_TIMEOUT_MS";
  const channelId = "src/cloud/channels.ts:timeoutMs";
  const incomplete = [signalId];
  await assert.rejects(runTable({
    baseUrl: url, profile, client: null, runs: 1, pauseMs: 0, ref: "HEAD",
    sourceTimeoutMs: 120_000, mapping: join(repo, "scripts/timeout-table/mapping.json"),
    output: null, acknowledgeNotMeasured: [],
  }), /NOT MEASURED without --acknowledge-not-measured/);
  const result = await runTable({
    baseUrl: url, profile, client: null, runs: 2, pauseMs: 0, ref: "HEAD",
    sourceTimeoutMs: 120_000, mapping: join(repo, "scripts/timeout-table/mapping.json"),
    output: null, acknowledgeNotMeasured: incomplete,
  });
  assert.equal(writes.length, 0);
  assert.match(result.report, /\| NOT MEASURED \|/);
  assert.match(result.report, /signal-read/);
  assert.equal(result.status.fails.length, 0);
  assert.deepEqual([...result.status.notMeasured].sort(), [...incomplete].sort());
  assert.equal((result.measurements.get("auth-settings") as { durations: number[] }).durations.length, 2);

  const silentClient = join(home, "silent-client.mjs");
  await writeFile(silentClient, `process.argv.includes("--version") && process.exit(0);\nprocess.exit(0);\n`, { mode: 0o700 });
  await assert.rejects(runTable({
    baseUrl: url, profile, client: silentClient, runs: 1, pauseMs: 0, ref: "HEAD",
    sourceTimeoutMs: 120_000, mapping: join(repo, "scripts/timeout-table/mapping.json"),
    output: null, acknowledgeNotMeasured: incomplete,
  }), /NOT MEASURED without --acknowledge-not-measured/);
  const silent = await runTable({
    baseUrl: url, profile, client: silentClient, runs: 1, pauseMs: 0, ref: "HEAD",
    sourceTimeoutMs: 120_000, mapping: join(repo, "scripts/timeout-table/mapping.json"),
    output: null, acknowledgeNotMeasured: [...incomplete, channelId, "src/cloud/files.ts:REQUEST_TIMEOUT_MS"],
  });
  assert.match(silent.report, /src\/cloud\/channels.ts:timeoutMs.*NOT MEASURED/);
  assert.equal(silent.status.fails.length, 0);
  assert.ok(silent.status.notMeasured.includes(channelId));

  const timeoutClient = join(home, "timeout-client.mjs");
  await writeFile(timeoutClient, `
if (process.argv.includes("--version")) process.exit(0);
if (process.argv[2] === "check" || process.argv[1] && process.argv.includes("check")) {
  process.stdout.write(JSON.stringify({ error: { code: "check_timeout" } }) + "\\n");
  process.exit(1);
}
process.exit(0);
`, { mode: 0o700 });
  const notRun = await runTable({
    baseUrl: url, profile, client: timeoutClient, runs: 1, pauseMs: 0, ref: "HEAD",
    sourceTimeoutMs: 120_000, mapping: join(repo, "scripts/timeout-table/mapping.json"),
    output: null, acknowledgeNotMeasured: [...incomplete, channelId, "src/cloud/files.ts:REQUEST_TIMEOUT_MS"],
  });
  assert.match(notRun.report, /AGENT_CHECK_TIMEOUT_MS.*NOT RUN/);
  assert.equal(notRun.status.fails.length, 0);

  const noisyClient = join(home, "noisy-client.mjs");
  await writeFile(noisyClient, `
if (process.argv.includes("--version")) process.exit(0);
process.stderr.write("channel boom\\n");
process.exit(7);
`, { mode: 0o700 });
  await assert.rejects(runTable({
    baseUrl: url, profile, client: noisyClient, runs: 1, pauseMs: 0, ref: "HEAD",
    sourceTimeoutMs: 120_000, mapping: join(repo, "scripts/timeout-table/mapping.json"),
    output: null, acknowledgeNotMeasured: incomplete,
  }), /channel boom/);
  const listed = execFileSync("find", [sentinel, "-print"], { encoding: "utf8" }).trim().split("\n").sort();
  assert.deepEqual(listed, [sentinel, join(sentinel, "MARKER")].sort());
});
