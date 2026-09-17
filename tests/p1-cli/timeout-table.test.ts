import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { rmSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { once } from "node:events";
import { enumerateRepository } from "../../scripts/timeout-table/enumerate.mjs";
import { validateMapping } from "../../scripts/timeout-table/mapping.mjs";
import { markdownReport } from "../../scripts/timeout-table/run.mjs";
import { readJsonLines, runChild, summarize, withPrivateProfile } from "../../scripts/timeout-table/core.mjs";

const repo = resolve(import.meta.dirname, "../..");

async function listen(delayMs: () => number) {
  let requests = 0;
  let receivedSecret = false;
  const server = createServer(async (request, response) => {
    requests += 1;
    receivedSecret ||= request.headers.authorization === "Bearer secret-shaped-value";
    await new Promise(resolvePromise => setTimeout(resolvePromise, delayMs()));
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
  };
}

test("timeout inventory and mapping are exact in both directions", async () => {
  const inventory = enumerateRepository({ repo });
  const released = enumerateRepository({ repo, ref: "v0.1.71" });
  assert.deepEqual(released.map(row => row.id), inventory.map(row => row.id));
  const mapping = JSON.parse(await readFile(join(repo, "scripts/timeout-table/mapping.json"), "utf8"));
  assert.equal(validateMapping(inventory, mapping), true);

  const missing = structuredClone(mapping);
  delete missing.rows[inventory[0]!.id];
  assert.throws(() => validateMapping(inventory, missing), /missing=/);

  const stale = structuredClone(mapping);
  stale.rows["src/not-present.ts:1:TIMEOUT_MS"] = structuredClone(mapping.rows[inventory[0]!.id]);
  assert.throws(() => validateMapping(inventory, stale), /stale=/);
});

test("delayed local endpoint makes the rendered row pass below half-budget and fail above it", async (t) => {
  let delay = 15;
  const target = await listen(() => delay);
  t.after(() => target.server.close());
  const durations: number[] = [];
  for (let index = 0; index < 5; index += 1) {
    const started = performance.now();
    const response = await fetch(`${target.url}/functions/v1/read`);
    await response.arrayBuffer();
    durations.push(performance.now() - started);
  }
  assert.equal(summarize(durations, 100).gate, "PASS");

  delay = 70;
  const slow: number[] = [];
  for (let index = 0; index < 5; index += 1) {
    const started = performance.now();
    const response = await fetch(`${target.url}/functions/v1/read`);
    await response.arrayBuffer();
    slow.push(performance.now() - started);
  }
  assert.equal(summarize(slow, 100).gate, "FAIL");

  const id = "fixture.ts:1:TIMEOUT_MS";
  const report = markdownReport({
    baseUrl: target.url,
    inventory: [{ id, value_ms: 100, unit_note: "milliseconds" }],
    mapping: { rows: { [id]: { class: "network-api", scope: "per-request", endpoints: ["/functions/v1/read"], operation: { name: "fixture", class: "safe-read" } } } },
    measurements: new Map([["fixture", { durations: slow, realTimeouts: 0 }]]), startup: null,
  });
  assert.match(report, /\| FAIL \|/);
});

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

test("private profile copy is removed after success and injected failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "timeout-profile-test-"));
  await chmod(directory, 0o700);
  const credential = join(directory, "credential.json");
  const profile = join(directory, "profile.json");
  await writeFile(credential, '{"token":"secret-shaped-value","expires_at":"2099-01-01T00:00:00Z"}', { mode: 0o600 });
  await writeFile(profile, JSON.stringify({ version: 1, url: "http://127.0.0.1:1", anon_key: "public", workspace_id: "00000000-0000-4000-8000-000000000001", principal_id: "00000000-0000-4000-8000-000000000002", credential_file: credential }), { mode: 0o600 });
  try {
    let successRoot = "";
    await withPrivateProfile(profile, async copy => {
      successRoot = copy.root;
      assert.equal((await stat(copy.root)).mode & 0o777, 0o700);
      assert.equal((await stat(copy.profilePath)).mode & 0o777, 0o600);
      assert.notEqual(copy.profile.credential_file, credential);
      assert.doesNotMatch(await readFile(copy.profile.credential_file, "utf8"), /expires_at/);
    });
    await assert.rejects(stat(successRoot), { code: "ENOENT" });

    let failureRoot = "";
    await assert.rejects(withPrivateProfile(profile, async copy => {
      failureRoot = copy.root;
      throw new Error("injected failure");
    }), /injected failure/);
    await assert.rejects(stat(failureRoot), { code: "ENOENT" });
    assert.equal(await readFile(credential, "utf8"), '{"token":"secret-shaped-value","expires_at":"2099-01-01T00:00:00Z"}');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function porcelainWorktrees(gitRepo: string): string[] {
  const listed = execFileSync("git", ["-C", gitRepo, "worktree", "list", "--porcelain"], { encoding: "utf8" });
  return listed.split("\n").filter(line => line.startsWith("worktree ")).map(line => line.slice("worktree ".length));
}

async function waitForFile(path: string, timeoutMs = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      await stat(path);
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 15));
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

type ExitPaths = {
  tempRoot: string;
  worktreePath: string;
  copyRoot: string;
  profilePath: string;
  credentialFile: string;
};

async function spawnExitFixture(t: { after: (fn: () => void) => void }, mode: "exit13" | "sigterm") {
  const home = await mkdtemp(join(tmpdir(), "timeout-table-home-"));
  t.after(() => { rmSync(home, { recursive: true, force: true }); });
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
  const child = spawn(process.execPath, [fixture, mode, marker, profile, repo], {
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
      execFileSync("git", ["-C", repo, "worktree", "remove", "--force", paths.worktreePath], {
        stdio: ["ignore", "ignore", "ignore"],
        timeout: 10_000,
      });
    } catch { /* leftover only if the test failed */ }
    try { rmSync(paths.tempRoot, { recursive: true, force: true }); } catch { /* already gone */ }
  });
  return {
    child, closed, marker, credential, credentialBody,
    get stderr() { return stderr; },
    get paths() { return paths; },
    set paths(value: ExitPaths | null) { paths = value; },
  };
}

async function assertArtifactsPresent(paths: ExitPaths) {
  assert.equal((await stat(paths.tempRoot)).isDirectory(), true);
  assert.equal((await stat(paths.copyRoot)).isDirectory(), true);
  assert.equal((await stat(paths.profilePath)).isFile(), true);
  assert.equal((await stat(paths.credentialFile)).isFile(), true);
  assert.ok(
    porcelainWorktrees(repo).includes(paths.worktreePath),
    `worktree not registered: ${paths.worktreePath}`,
  );
}

async function assertArtifactsGone(paths: ExitPaths) {
  await assert.rejects(stat(paths.tempRoot), { code: "ENOENT" });
  await assert.rejects(stat(paths.copyRoot), { code: "ENOENT" });
  await assert.rejects(stat(paths.profilePath), { code: "ENOENT" });
  await assert.rejects(stat(paths.credentialFile), { code: "ENOENT" });
  assert.ok(
    !porcelainWorktrees(repo).includes(paths.worktreePath),
    `worktree still registered: ${paths.worktreePath}`,
  );
}

test("unexpected exit 13 removes the profile copy and the git worktree", async t => {
  const session = await spawnExitFixture(t, "exit13");
  await waitForFile(session.marker);
  session.paths = JSON.parse(await readFile(session.marker, "utf8")) as ExitPaths;
  await assertArtifactsPresent(session.paths);
  await writeFile(`${session.marker}.go`, "go", { mode: 0o600 });
  const [code, signal] = await session.closed;
  assert.equal(signal, null, session.stderr);
  assert.equal(code, 13, session.stderr);
  await assertArtifactsGone(session.paths);
  assert.equal(await readFile(session.credential, "utf8"), session.credentialBody);
});

test("SIGTERM removes the profile copy and the git worktree", async t => {
  const session = await spawnExitFixture(t, "sigterm");
  await waitForFile(session.marker);
  session.paths = JSON.parse(await readFile(session.marker, "utf8")) as ExitPaths;
  await assertArtifactsPresent(session.paths);
  session.child.kill("SIGTERM");
  const [code, signal] = await session.closed;
  assert.equal(signal, null, session.stderr);
  assert.equal(code, 143, session.stderr);
  await assertArtifactsGone(session.paths);
  assert.equal(await readFile(session.credential, "utf8"), session.credentialBody);
});
