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

function serializerSource(source: string): string {
  const start = source.indexOf("function agentCredentialArtifact(");
  const endMarker = "\n}\n\nasync function stdinCredential";
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, "agentCredentialArtifact is no longer extractable");
  return source.slice(start, end + 2);
}

async function runCli(
  args: string[],
  environment: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [
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
      ...environment,
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
  home: string,
): Promise<Record<string, unknown>> {
  const agentToken = `swm_agt_${randomBytes(32).toString("base64url")}`;
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
      JSON.parse(Buffer.concat(chunks).toString("utf8"));
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
        grant_kind: "timeboxed",
        horizon_expires_at: "2099-10-28T00:00:00.000Z",
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
      stateDirectory: join(home, ".cswarm", "credentials.d"),
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
    ], { HOME: home });
    assert.equal(result.code, 0, result.stderr);
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
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("python3", ["-c", python, ...args], {
    encoding: "utf8",
  });
  assert.equal(result.error, undefined);
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

test("HM2 plan accepts the released mint artifact and rejects a missing agent_token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cswarm-hm2-plan-"));
  try {
    const headCli = await readFile("src/cli.ts", "utf8");
    const releasedCli = execFileSync(
      "git",
      ["show", `${RELEASE_COMMIT}:src/cli.ts`],
      { encoding: "utf8" },
    );
    assert.equal(
      serializerSource(headCli),
      serializerSource(releasedCli),
      "HEAD serializer must remain identical to released cswarm 0.1.80",
    );
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      version?: string;
    };
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
