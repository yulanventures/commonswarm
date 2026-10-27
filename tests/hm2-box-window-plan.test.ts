import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cloudTarget } from "../src/cloud/config.js";
import { credentialStore } from "../src/cloud/storage.js";

const PLAN = "docs/evidence/2026-09-28-box-hm2/BOX-WINDOW.md";
const RELEASE_COMMIT = "9b1c132c";
const WORKSPACE = "00000000-0000-4000-8000-000000000001";
const PRINCIPAL = "00000000-0000-4000-8000-000000000002";
const RUN = "00000000-0000-4000-8000-000000000003";
const TASK = "00000000-0000-4000-8000-000000000004";
const USER = "00000000-0000-4000-8000-000000000005";
const DEVICE = "00000000-0000-4000-8000-000000000006";
const TOKEN_ID = "00000000-0000-4000-8000-000000000007";

// HM2 isolation must preserve HOME, never write under the real home, and never
// read personal configuration (Git global/system config, user site-packages,
// shell rc files, or credential stores). Read-only repository and dependency
// assets under the real home are allowed.
function gitEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const isolated = { ...environment };
  // GIT_CONFIG_COUNT/KEY_*/VALUE_* and GIT_CONFIG_PARAMETERS can inject settings
  // even when the global config is disabled. Drop all inherited config inputs.
  for (const key of Object.keys(isolated)) {
    if (key.startsWith("GIT_CONFIG")) delete isolated[key];
  }
  return {
    ...isolated,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

function releasedFile(path: string, environment: NodeJS.ProcessEnv = process.env): string {
  return execFileSync("git", ["show", `${RELEASE_COMMIT}:${path}`], {
    encoding: "utf8",
    env: gitEnvironment(environment),
  });
}

function serializerSource(source: string): string {
  const start = source.indexOf("function agentCredentialArtifact(");
  const endMarker = "\n}\n\nasync function stdinCredential";
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, "agentCredentialArtifact is no longer extractable");
  return source.slice(start, end + 2);
}

async function runCli(
  args: string[],
  fixtureDirectory: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  // Isolate the child's credential paths without changing HOME or accessing
  // the real user's keychain. This preload exists only in this test process.
  const preload = `
    import os from 'node:os';
    import { syncBuiltinESMExports } from 'node:module';
    os.homedir = () => process.env.CSWARM_HM2_FIXTURE_DIRECTORY;
    syncBuiltinESMExports();
  `;
  const child = spawn(process.execPath, [
    "--import",
    `data:text/javascript,${encodeURIComponent(preload)}`,
    "--import",
    "tsx",
    "src/cli.ts",
    ...args,
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SWARM_CLOUD_URL: "",
      SWARM_CLOUD_ANON_KEY: "",
      SWARM_CLOUD_WORKSPACE_ID: "",
      XDG_STATE_HOME: join(fixtureDirectory, ".local", "state"),
      CSWARM_HM2_FIXTURE_DIRECTORY: fixtureDirectory,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => stdout += chunk);
  child.stderr.on("data", (chunk: string) => stderr += chunk);
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status) => resolve(status ?? 1));
  });
  return { code, stdout, stderr };
}

async function credentialFromRealSerializer(
  fixtureDirectory: string,
): Promise<Record<string, unknown>> {
  const agentToken = `swm_agt_${randomBytes(32).toString("base64url")}`;
  const calls: Array<{ path: string; body: unknown }> = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    if (url.pathname === "/auth/v1/token") {
      const now = new Date().toISOString();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        access_token: "access-refreshed",
        token_type: "bearer",
        expires_in: 3600,
        refresh_token: "refresh-token-refreshed",
        user: {
          id: USER,
          aud: "authenticated",
          role: "authenticated",
          email: "hm2-plan@example.test",
          email_confirmed_at: now,
          phone: "",
          confirmed_at: now,
          last_sign_in_at: now,
          app_metadata: { provider: "email", providers: ["email"] },
          user_metadata: {},
          identities: [],
          created_at: now,
          updated_at: now,
          is_anonymous: false,
        },
      }));
      return;
    }
    if (url.pathname === "/functions/v1/command") {
      calls.push({ path: url.pathname, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        status: "accepted",
        ok: true,
        event_ids: [],
        events: [],
        token_id: TOKEN_ID,
        principal_id: PRINCIPAL,
        run_id: RUN,
        agent_token: agentToken,
        expires_at: "2099-09-28T00:00:00.000Z",
        grant_kind: "standing",
        horizon_expires_at: null,
        connection_expires_at: null,
        connection_expired_at: null,
      }));
      return;
    }
    if (url.pathname === "/functions/v1/read") {
      calls.push({ path: url.pathname, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      // Current mint confirms possession and identity before exporting the
      // credential. Model that real boundary, preserving the historical plan.
      if (request.headers.authorization !== `Bearer ${agentToken}`) {
        response.writeHead(401).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        members: [{ user_id: USER, display_name: "HM2 fixture owner" }],
        agents: [{ principal_id: PRINCIPAL, owner_user_id: USER, name: "HM2 fixture agent" }],
        identity: {
          credential_valid: true,
          workspace_id: WORKSPACE,
          principal_id: PRINCIPAL,
          owner_user_id: USER,
          run_id: RUN,
        },
      }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}`;
    const target = cloudTarget(url, "anon");
    const store = await credentialStore({
      target,
      stateDirectory: join(fixtureDirectory, ".cswarm", "credentials.d"),
      forceFile: true,
      platform: "linux",
      warn: () => undefined,
    });
    await store.write({
      version: 1,
      refreshToken: "refresh-token-seed",
      generation: 0,
      deviceId: DEVICE,
      userId: USER,
    });
    const result = await runCli([
      "token",
      "mint",
      "--workspace-id",
      WORKSPACE,
      "--principal-id",
      PRINCIPAL,
      "--run-id",
      RUN,
      "--task-id",
      TASK,
      "--epoch",
      "1",
      "--url",
      url,
      "--anon-key",
      "anon",
      "--force-file-store",
      "--json",
    ], fixtureDirectory);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(calls.map((call) => call.path), ["/functions/v1/command", "/functions/v1/read"]);
    const mint = calls[0]!.body as { command: Record<string, unknown> };
    assert.deepEqual(mint.command, {
      kind: "mint_agent_token",
      principal_id: PRINCIPAL,
      run_id: RUN,
      task_id: TASK,
      epoch: 1,
      device_id: DEVICE,
      renewal_kind: "standing",
    });
    assert.deepEqual(calls[1]!.body, { resource: "members", workspace_id: WORKSPACE });
    return JSON.parse(result.stdout) as Record<string, unknown>;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function stepBlocks(plan: string): Array<{ step: string; body: string }> {
  const blocks: Array<{ step: string; body: string }> = [];
  const pattern = /```sh\n# step: ([^\n]+)\n([\s\S]*?)\n```/g;
  for (const match of plan.matchAll(pattern)) {
    blocks.push({ step: match[1]!, body: match[2]! });
  }
  assert.equal(
    blocks.length,
    [...plan.matchAll(/^# step: /gm)].length,
    "every step shell block must be extractable",
  );
  return blocks;
}

function credentialChecks(plan: string): Array<{ step: string; python: string }> {
  const checks: Array<{ step: string; python: string }> = [];
  for (const block of stepBlocks(plan)) {
    for (const match of block.body.matchAll(/<<'PY'\n([\s\S]*?)\nPY/g)) {
      const python = match[1]!;
      if (/\bcredential\s*=\s*json\./.test(python)) {
        checks.push({ step: block.step, python });
      }
    }
  }
  return checks;
}

function runPython(
  python: string,
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
): { status: number | null; stdout: string; stderr: string } {
  // -I ignores PYTHONPATH/PYTHONHOME and disables the user's site directory,
  // so sitecustomize/usercustomize cannot execute code against the real home.
  const result = spawnSync("python3", ["-I", "-c", python, ...args], {
    encoding: "utf8",
    env: environment,
  });
  assert.equal(result.error, undefined);
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

test("HM2 subprocesses ignore inherited Git configuration and Python startup hooks without changing HOME", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cswarm-hm2-isolation-"));
  try {
    const config = join(directory, "poison.gitconfig");
    const marker = join(directory, "startup-ran");
    await writeFile(config, "[invalid config\n");
    // All poison files and the startup write are confined to this fixture.
    // Never create canaries, or substitute HOME, under the actual user's home.
    const environment = {
      ...process.env,
      GIT_CONFIG_GLOBAL: config,
      GIT_CONFIG_SYSTEM: config,
      GIT_CONFIG_NOSYSTEM: "0",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "invalid-key-without-section",
      GIT_CONFIG_VALUE_0: "poison",
      GIT_CONFIG_PARAMETERS: "malformed-inherited-config",
    };
    const isolated = gitEnvironment(environment);
    assert.equal(isolated.HOME, process.env.HOME);
    assert.deepEqual(Object.keys(isolated).filter(key => key.startsWith("GIT_CONFIG")).sort(),
      ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_SYSTEM"]);
    assert.equal(isolated.GIT_CONFIG_GLOBAL, "/dev/null");
    assert.equal(isolated.GIT_CONFIG_SYSTEM, "/dev/null");
    assert.equal(isolated.GIT_CONFIG_NOSYSTEM, "1");
    assert.equal(JSON.parse(releasedFile("package.json", environment)).version, "0.1.80");
    // Mutation control: inheriting configuration instead of sanitizing it must
    // fail the very same git show. Its config paths still point only at fixtures.
    const inheritedGit = spawnSync("git", ["show", `${RELEASE_COMMIT}:package.json`], {
      encoding: "utf8", env: environment,
    });
    assert.equal(inheritedGit.error, undefined);
    assert.notEqual(inheritedGit.status, 0);
    assert.match(inheritedGit.stderr, /config/i);

    await writeFile(join(directory, "sitecustomize.py"),
      `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text("startup ran")\n`);
    const pythonEnvironment: NodeJS.ProcessEnv = { ...process.env, PYTHONPATH: directory, PYTHONUSERBASE: directory };
    const check = "import site, sys; assert sys.flags.isolated == 1; assert site.ENABLE_USER_SITE is False";
    const python = runPython(check, [], pythonEnvironment);
    assert.equal(python.status, 0, python.stderr);
    await assert.rejects(readFile(marker), { code: "ENOENT" });
    // Mutation control: removing -I executes the fixture's startup hook and
    // fails the isolation assertion. It writes only the owned fixture marker.
    const inheritedPython = spawnSync("python3", ["-c", check], {
      encoding: "utf8", env: pythonEnvironment,
    });
    assert.equal(inheritedPython.error, undefined);
    assert.notEqual(inheritedPython.status, 0);
    assert.match(inheritedPython.stderr, /AssertionError/);
    assert.equal(await readFile(marker, "utf8"), "startup ran");
    assert.equal(pythonEnvironment.HOME, process.env.HOME);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("HM2 plan accepts the released mint artifact and rejects a missing agent_token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cswarm-hm2-plan-"));
  try {
    const headCli = await readFile("src/cli.ts", "utf8");
    const releasedCli = releasedFile("src/cli.ts");
    assert.equal(
      serializerSource(headCli),
      serializerSource(releasedCli),
      "HEAD serializer must remain identical to released cswarm 0.1.80",
    );
    // The plan pins the RELEASED artifact, so read the version at RELEASE_COMMIT: a later
    // CLI version bump on HEAD must not break this pin while the serializer stays identical.
    const packageJson = JSON.parse(
      releasedFile("package.json"),
    ) as { version?: string };
    assert.equal(packageJson.version, "0.1.80");

    const credential = await credentialFromRealSerializer(directory);
    assert.equal(credential.principal_id, PRINCIPAL);
    assert.equal(credential.token_id, TOKEN_ID);
    assert.equal(typeof credential.agent_token, "string");
    const token = credential.agent_token as string;

    const plan = await readFile(PLAN, "utf8");
    const checks = credentialChecks(plan);
    assert.deepEqual(
      checks.map((check) => check.step),
      ["hm2-local-mint-after-edge", "hm2-local-cleanup-and-evidence"],
    );

    const fixtureRoot = join(directory, "fixture");
    const anonFile = join(directory, "anon-key.txt");
    const credentialFile = join(directory, "credential.json");
    const connectionFile = join(directory, "connection.json");
    await mkdir(fixtureRoot, { recursive: true });
    await writeFile(anonFile, "non-secret-test-anon\n", { mode: 0o600 });
    await writeFile(join(fixtureRoot, "hm-local-first-ack.txt"), "{}\n");
    await writeFile(join(fixtureRoot, "pending.json"), JSON.stringify({
      signal: { id: "00000000-0000-4000-8000-000000000008" },
    }));
    await writeFile(join(fixtureRoot, "hm-local-seat-before.txt"), "t\n");
    await writeFile(join(fixtureRoot, "hm-local-wake-after.txt"), "t\n");
    for (const slug of ["local", "sender"]) {
      const seat = join(fixtureRoot, slug);
      await mkdir(seat, { recursive: true });
      await writeFile(join(seat, "principal.json"), JSON.stringify({
        principal_id: PRINCIPAL,
      }));
      await writeFile(join(seat, "revoked.json"), JSON.stringify({
        status: "accepted",
        principal_id: PRINCIPAL,
      }));
    }

    const writeCredential = async (value: Record<string, unknown>) => {
      const serialized = JSON.stringify(value);
      await writeFile(credentialFile, serialized);
      for (const slug of ["local", "sender"]) {
        await writeFile(
          join(fixtureRoot, slug, "credential-mint.json"),
          serialized,
        );
      }
    };
    const argsFor = (step: string): string[] => {
      if (step === "hm2-local-mint-after-edge") {
        return [anonFile, credentialFile, connectionFile, WORKSPACE, PRINCIPAL];
      }
      return [
        fixtureRoot,
        "72c57e0d76d0aa86fe4f811a2cf51499919fed20",
        "123456",
      ];
    };

    for (const check of checks) {
      await writeCredential(credential);
      const positive = runPython(check.python, argsFor(check.step));
      assert.equal(positive.status, 0, `${check.step}: ${positive.stderr}`);
      assert.doesNotMatch(positive.stdout + positive.stderr, new RegExp(token));

      const missingToken = { ...credential };
      delete missingToken.agent_token;
      await writeCredential(missingToken);
      const negative = runPython(check.python, argsFor(check.step));
      assert.notEqual(negative.status, 0, `${check.step} accepted a missing token field`);
      assert.match(
        negative.stderr,
        /credential is missing required non-empty string field "agent_token"/,
      );
      assert.doesNotMatch(negative.stdout + negative.stderr, new RegExp(token));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
