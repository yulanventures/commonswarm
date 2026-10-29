import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { test } from "node:test";

/* Wren, 2026-08-10. Every unknown flag reported "--X requires a value", because anything outside
 * BOOLEAN_FLAGS is assumed to take one. A flag that DOES NOT EXIST was reported as a flag used
 * wrongly. Found when someone on 0.1.11 tried `--reveal-anon-key`, which only exists on a later
 * build, and was told it "requires a value" — the error blamed the reader for the version.
 *
 * AGENTS.md records the other cost: a control written with a bare `--not-a-real-flag` died in the
 * parser before reaching the gate it was meant to exercise, and passed for the wrong reason. */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const cli = resolve(root, "dist", "cli.js");

async function runAsync(
  args: string[],
  stdin = "",
): Promise<{ code: number; stdout: string; stderr: string; pid: number }> {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: root,
    env: {
      ...process.env,
      SWARM_CLOUD_URL: "",
      SWARM_CLOUD_ANON_KEY: "",
      SWARM_CLOUD_WORKSPACE_ID: "",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  assert.ok(child.pid !== undefined);
  child.stdin.end(stdin);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => stdout += chunk);
  child.stderr.on("data", (chunk: string) => stderr += chunk);
  const code = await new Promise<number>((resolveCode, reject) => {
    child.once("error", reject);
    child.once("close", (status) => resolveCode(status ?? 1));
  });
  return { code, stdout, stderr, pid: child.pid };
}

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const EXPECTED_PRINCIPAL = "22222222-2222-4222-8222-222222222222";
const AUTHENTICATED_PRINCIPAL = "33333333-3333-4333-8333-333333333333";
const OWNER = "44444444-4444-4444-8444-444444444444";
const TOKEN_ID = "55555555-5555-4555-8555-555555555555";
const RUN_ID = "66666666-6666-4666-8666-666666666666";
const AGENT_TOKEN = `swm_agt_${"a".repeat(43)}`;
const ARTIFACT = JSON.stringify({
  agent_token: AGENT_TOKEN,
  message:
    "Agent credential minted. It is bound to this task and run so the agent's work stays scoped and attributable.",
  principal_id: EXPECTED_PRINCIPAL,
  run_id: RUN_ID,
  status: "accepted",
  token_id: TOKEN_ID,
  expires_at: "2099-01-01T00:00:00.000Z",
});

test("whoami trusts the live credential identity and file input keeps the token out of ps", async () => {
  let releaseResponse: (() => void) | undefined;
  let requestReached: (() => void) | undefined;
  let requestCount = 0;
  const reached = new Promise<void>((resolveReached) => requestReached = resolveReached);
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${AGENT_TOKEN}`);
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    requestCount += 1;
    if (requestCount > 1) {
      response.end(JSON.stringify({ grants: [] }));
      return;
    }
    requestReached?.();
    await new Promise<void>((resolveRelease) => releaseResponse = resolveRelease);
    response.end(JSON.stringify({
      members: [{ user_id: OWNER, display_name: "Operator" }],
      agents: [{
        principal_id: AUTHENTICATED_PRINCIPAL,
        name: "MrSentry",
        owner_user_id: OWNER,
      }],
      identity: {
        credential_valid: true,
        principal_id: AUTHENTICATED_PRINCIPAL,
        owner_user_id: OWNER,
        workspace_id: WORKSPACE,
      },
    }));
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const directory = await mkdtemp(resolve(tmpdir(), "cswarm-token-file-"));
  const credentialPath = resolve(directory, "quill-credential.json");
  await writeFile(credentialPath, ARTIFACT, { mode: 0o600 });
  await chmod(credentialPath, 0o600);
  const args = [
    "whoami",
    "--agent-token-file",
    credentialPath,
    "--url",
    `http://127.0.0.1:${address.port}`,
    "--anon-key",
    "public-anon",
    "--workspace-id",
    WORKSPACE,
    "--json",
  ];
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.ok(child.pid !== undefined);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => stdout += chunk);
  child.stderr.on("data", (chunk: string) => stderr += chunk);
  try {
    await reached;
    const processListing = execFileSync("ps", ["-p", String(child.pid), "-o", "command="], {
      encoding: "utf8",
    });
    assert.match(processListing, /--agent-token-file/);
    assert.doesNotMatch(processListing, new RegExp(AGENT_TOKEN));
    releaseResponse?.();
    const code = await new Promise<number>((resolveCode, reject) => {
      child.once("error", reject);
      child.once("close", (status) => resolveCode(status ?? 1));
    });
    assert.equal(code, 0, stderr);
    const identity = JSON.parse(stdout) as Record<string, unknown>;
    assert.equal(identity.principal_id, AUTHENTICATED_PRINCIPAL);
    assert.equal(identity.display_name, "MrSentry");
    assert.equal(identity.owner_user_id, OWNER);
    assert.equal(identity.owner_display_name, "Operator");
    assert.equal(identity.workspace_id, WORKSPACE);
    assert.equal(identity.credential_valid, true);
    assert.equal(identity.credential_metadata_match, false);
    assert.match(stderr, /WARNING: the credential authenticated as MrSentry/);
    assert.match(stderr, new RegExp(AUTHENTICATED_PRINCIPAL));
  } finally {
    releaseResponse?.();
    child.kill();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("agent token file accepts 0600, refuses 0644, and missing has a distinct code", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "cswarm-token-mode-"));
  const credentialPath = resolve(directory, "credential.json");
  try {
    await writeFile(credentialPath, ARTIFACT, { mode: 0o600 });
    await chmod(credentialPath, 0o644);
    const common = [
      "members",
      "--agent-token-file",
      credentialPath,
      "--url",
      "http://127.0.0.1:1",
      "--anon-key",
      "public-anon",
      "--workspace-id",
      WORKSPACE,
    ];
    const insecure = await runAsync(common);
    assert.equal(insecure.code, 1);
    assert.match(insecure.stderr, /agent_token_file_unreadable/);
    assert.match(insecure.stderr, /must be mode 0600 \(found 644\)/);

    await rm(credentialPath);
    const missing = await runAsync(common);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /agent_token_file_missing/);
    assert.doesNotMatch(missing.stderr, /ECONNREFUSED/, "a missing secret reached the network");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("--agent-token-stdin still authenticates the same whoami path", async () => {
  let requestCount = 0;
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${AGENT_TOKEN}`);
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    requestCount += 1;
    if (requestCount > 1) {
      response.end(JSON.stringify({ grants: [] }));
      return;
    }
    response.end(JSON.stringify({
      members: [{ user_id: OWNER, display_name: "Operator" }],
      agents: [{
        principal_id: AUTHENTICATED_PRINCIPAL,
        name: "MrSentry",
        owner_user_id: OWNER,
      }],
      identity: {
        credential_valid: true,
        principal_id: AUTHENTICATED_PRINCIPAL,
        owner_user_id: OWNER,
        workspace_id: WORKSPACE,
      },
    }));
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const result = await runAsync([
      "whoami",
      "--agent-token-stdin",
      "--url",
      `http://127.0.0.1:${address.port}`,
      "--anon-key",
      "public-anon",
      "--workspace-id",
      WORKSPACE,
      "--json",
    ], ARTIFACT);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(
      (JSON.parse(result.stdout) as Record<string, unknown>).principal_id,
      AUTHENTICATED_PRINCIPAL,
    );
  } finally {
    server.close();
  }
});
