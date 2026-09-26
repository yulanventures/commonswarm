import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";
import {
  loginProviderLabel,
  LOGIN_PROVIDERS,
} from "../../src/cloud/auth.js";
import { encodeInviteLink } from "../../src/cloud/invite-link.js";

const CLI = resolve("dist/cli.js");

type CliResult = {
  code: number;
  stdout: string;
  stderr: string;
};

async function fixtureServer(): Promise<{
  url: string;
  requests(): number;
  expectChallenge(challenge: string): void;
  close(): Promise<void>;
}> {
  let requestCount = 0;
  let expectedChallenge: string | null = null;
  const workspaceId = randomUUID();
  const server = createServer(async (request, response) => {
    requestCount += 1;
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "POST" && url.pathname === "/auth/v1/token") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        auth_code?: string;
        code_verifier?: string;
      };
      assert.equal(body.auth_code, "provider-test-code");
      assert.ok(body.code_verifier);
      assert.equal(
        createHash("sha256").update(body.code_verifier).digest("base64url"),
        expectedChallenge,
      );
      const now = new Date().toISOString();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        access_token: "provider-test-access-token",
        token_type: "bearer",
        expires_in: 3600,
        refresh_token: "provider-test-refresh-token",
        user: {
          id: "11111111-1111-4111-8111-111111111111",
          aud: "authenticated",
          role: "authenticated",
          email: "provider@example.test",
          email_confirmed_at: now,
          confirmed_at: now,
          last_sign_in_at: now,
          app_metadata: {},
          user_metadata: {},
          identities: [],
          created_at: now,
          updated_at: now,
          is_anonymous: false,
        },
      }));
      return;
    }
    if (request.method === "POST" && url.pathname === "/functions/v1/command") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        command?: { device_id?: string };
      };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        status: "accepted",
        ok: true,
        event_ids: [],
        device_id: body.command?.device_id,
      }));
      return;
    }
    if (request.method === "GET" && url.pathname === "/rest/v1/memberships") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([{ workspace_id: workspaceId }]));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests: () => requestCount,
    expectChallenge(challenge) {
      expectedChallenge = challenge;
    },
    close: () => new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
    }),
  };
}

function startCli(home: string, args: string[]): {
  result: Promise<CliResult>;
  authorizationUrl: Promise<URL>;
  writeInput(value: string): void;
  stop(): void;
} {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, "config"),
    SWARM_AGENT_STATE_DIR: join(home, "agent-state"),
    SWARM_ALLOW_INSECURE_STORE: "1",
  };
  delete environment.SWARM_CLOUD_URL;
  delete environment.SWARM_CLOUD_ANON_KEY;
  delete environment.SWARM_CLOUD_WORKSPACE_ID;
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd: process.cwd(),
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let stderrLines = "";
  let resolveAuthorization!: (url: URL) => void;
  let rejectAuthorization!: (error: Error) => void;
  let authorizationFound = false;
  const authorizationUrl = new Promise<URL>((resolveUrl, rejectUrl) => {
    resolveAuthorization = resolveUrl;
    rejectAuthorization = rejectUrl;
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => stdout += chunk);
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
    stderrLines += chunk;
    while (stderrLines.includes("\n")) {
      const newline = stderrLines.indexOf("\n");
      const line = stderrLines.slice(0, newline).trim();
      stderrLines = stderrLines.slice(newline + 1);
      if (authorizationFound) continue;
      try {
        const url = new URL(line);
        if (url.pathname !== "/auth/v1/authorize") continue;
        authorizationFound = true;
        resolveAuthorization(url);
      } catch {
        // Other stderr lines are login narration.
      }
    }
  });
  const result = new Promise<CliResult>((resolveResult, rejectResult) => {
    child.once("error", (error) => {
      if (!authorizationFound) rejectAuthorization(error);
      rejectResult(error);
    });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      const error = new Error(`CLI timed out: ${stderr}`);
      if (!authorizationFound) rejectAuthorization(error);
      rejectResult(error);
    }, 10_000);
    child.once("close", (status) => {
      clearTimeout(timeout);
      if (!authorizationFound) {
        rejectAuthorization(new Error("CLI exited before printing an authorization URL"));
      }
      resolveResult({ code: status ?? 1, stdout, stderr });
    });
  });
  return {
    result,
    authorizationUrl,
    writeInput(value) {
      child.stdin.end(value);
    },
    stop() {
      child.kill("SIGTERM");
    },
  };
}

async function runLogin(
  server: Awaited<ReturnType<typeof fixtureServer>>,
  provider?: string,
): Promise<{ result: CliResult; authorizationUrl: URL }> {
  const home = await mkdtemp(join(tmpdir(), "cswarm-login-provider-"));
  try {
    const args = [
      "login",
      "--url",
      server.url,
      "--anon-key",
      "provider-test-anon-key",
      "--force-file-store",
      "--no-browser",
      ...(provider === undefined ? [] : ["--provider", provider]),
    ];
    const running = startCli(home, args);
    const authorizationUrl = await running.authorizationUrl;
    server.expectChallenge(authorizationUrl.searchParams.get("code_challenge") ?? "");
    const callback = new URL(authorizationUrl.searchParams.get("redirect_to") ?? "");
    callback.searchParams.set("code", "provider-test-code");
    const callbackResponse = await fetch(callback);
    assert.equal(callbackResponse.status, 200);
    return { result: await running.result, authorizationUrl };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function runCli(home: string, args: string[]): Promise<CliResult> {
  const running = startCli(home, args);
  void running.authorizationUrl.catch(() => undefined);
  return await running.result;
}

test("built login CLI selects the requested provider and defaults to Google", { timeout: 30_000 }, async () => {
  const server = await fixtureServer();
  try {
    for (const [flag, expected] of [
      [undefined, LOGIN_PROVIDERS[0]],
      ["github", "github"],
      ["google", "google"],
    ] as const) {
      const { result, authorizationUrl } = await runLogin(server, flag);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(authorizationUrl.searchParams.get("provider"), expected);
      assert.match(
        result.stderr,
        new RegExp(`Open this URL in a browser to sign in with ${loginProviderLabel(expected)}:`),
      );
    }
  } finally {
    await server.close();
  }
});

test("invalid login providers exit 2 before any request", async () => {
  for (const value of ["gitlab", ""]) {
    const server = await fixtureServer();
    const home = await mkdtemp(join(tmpdir(), "cswarm-login-provider-invalid-"));
    try {
      const result = await runCli(home, [
        "login",
        "--provider",
        value,
        "--url",
        server.url,
        "--anon-key",
        "provider-test-anon-key",
        "--no-browser",
      ]);
      assert.equal(result.code, 2);
      assert.equal(result.stdout, "");
      assert.equal(
        result.stderr,
        `cswarm: --provider must be one of: ${LOGIN_PROVIDERS.join(", ")}\n`,
      );
      assert.equal(server.requests(), 0);
    } finally {
      await server.close();
      await rm(home, { recursive: true, force: true });
    }
  }
});

test("login help derives its provider option from LOGIN_PROVIDERS", async () => {
  const home = await mkdtemp(join(tmpdir(), "cswarm-login-provider-help-"));
  try {
    const result = await runCli(home, ["login", "--help"]);
    const defaultLabel = loginProviderLabel(LOGIN_PROVIDERS[0]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`\\[--provider ${LOGIN_PROVIDERS.join("\\|")}\\]`));
    assert.match(result.stdout, new RegExp(`${defaultLabel} is the default provider\\.`));
    assert.equal(result.stderr, "");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("built invite acceptance retains its existing GitHub sign-in", async () => {
  const server = await fixtureServer();
  const home = await mkdtemp(join(tmpdir(), "cswarm-login-provider-accept-"));
  try {
    const link = encodeInviteLink({
      v: 1,
      url: server.url,
      anon_key: "provider-test-anon-key",
      workspace_id: randomUUID(),
      invitation_token: `swm_inv_${randomBytes(32).toString("base64url")}`,
      workspace_name: "Provider test",
      inviter_display_name: "Taylor",
      inviter_user_id: randomUUID(),
    });
    const running = startCli(home, [
      "accept",
      "--link-stdin",
      "--no-browser",
      "--force-file-store",
    ]);
    running.writeInput(`${link}\n`);
    const authorizationUrl = await running.authorizationUrl;
    running.stop();
    const result = await running.result;

    assert.equal(authorizationUrl.searchParams.get("provider"), "github");
    assert.match(result.stdout, /This will sign you in with GitHub/);
    assert.match(
      result.stderr,
      /Open this URL in a browser to sign in with GitHub:/,
    );
    assert.doesNotMatch(result.stderr, /sign in with Github:/);
  } finally {
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});
