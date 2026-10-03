import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmod, lstat, writeFile } from "node:fs/promises";
import { randomInt } from "node:crypto";
import { resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { exportJWK, generateKeyPair } from "jose";

import { loadConfig } from "../src/config.js";
import { createProductionManagementBindings } from "../src/management-bindings.js";
import { startServer } from "../src/server.js";

const exec = promisify(execFile);

async function fixture(t) {
  const { stdout } = await exec("mktemp", ["-d", "/private/tmp/anvil-secret.XXXXXX"]);
  const directory = stdout.trim();
  assert.match(directory, /^\/private\/tmp\/anvil-secret\.[A-Za-z0-9]+$/u);
  await chmod(directory, 0o700);
  t.after(async () => {
    assert.equal(resolve(directory), directory);
    // Use the installed guard, including for synthetic fixture credentials.
    await exec("rm", ["-rf", directory]);
  });
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const files = {
    signing: JSON.stringify({ keys: [{ ...await exportJWK(privateKey), kid: "test", alg: "ES256", use: "sig" }] }),
    cookies: `${"a".repeat(32)}\n${"b".repeat(32)}\n`,
    database: JSON.stringify({ user: "fixture", password: "synthetic" }),
    management: JSON.stringify({ databaseUrl: "postgresql://fixture:synthetic@db.commonswarm.internal:5432/postgres" }),
  };
  for (const [name, content] of Object.entries(files)) {
    await writeFile(`${directory}/${name}`, content, { mode: 0o600 });
  }
  let caPath;
  for (const candidate of ["/etc/ssl/cert.pem", "/etc/ssl/certs/ca-certificates.crt"]) {
    const metadata = await lstat(candidate).catch(() => null);
    if (metadata?.isFile() && metadata.uid === 0 && (metadata.mode & 0o022) === 0) {
      caPath = candidate;
      break;
    }
  }
  assert.ok(caPath, "fixture requires an existing root-owned public CA bundle");
  return {
    // HOME is inherited unchanged. No GoTrue or PostgreSQL requests are made.
    ...process.env,
    PORT: String(randomInt(49152, 65536)),
    MCP_OAUTH_SIGNING_KEYS_FILE: `${directory}/signing`,
    MCP_OAUTH_COOKIE_KEYS_FILE: `${directory}/cookies`,
    MCP_OAUTH_DATABASE_CREDENTIALS_FILE: `${directory}/database`,
    MCP_OAUTH_MANAGEMENT_DATABASE_CREDENTIALS_FILE: `${directory}/management`,
    MCP_OAUTH_DATABASE_TLS_CA_FILE: caPath,
    MCP_OAUTH_ACTIVE_SIGNING_KID: "test",
    MCP_OAUTH_PUBLIC_ORIGIN: "https://mcp.commonswarm.com",
    MCP_OAUTH_ALLOWED_ORIGINS: "https://commonswarm.com",
    MCP_OAUTH_GOTRUE_URL: "https://api.commonswarm.com/auth/v1",
    MCP_OAUTH_GOTRUE_PROVIDER: "github",
    MCP_OAUTH_DATABASE_HOST: "db.commonswarm.internal",
    MCP_OAUTH_DATABASE_NAME: "postgres",
    SUPABASE_URL: "https://api.commonswarm.com",
    SUPABASE_ANON_KEY: "synthetic-anon-key",
  };
}

async function entrypoint(t, env) {
  const child = spawn(process.execPath, [new URL("../src/server.js", import.meta.url).pathname], {
    env, stdio: ["ignore", "ignore", "pipe"],
  });
  let diagnostic = "";
  child.stderr.on("data", (chunk) => { diagnostic += chunk; });
  const closed = new Promise((accept) => child.once("close", accept));
  t.after(async () => { child.kill("SIGTERM"); await closed; });
  const root = `http://127.0.0.1:${env.PORT}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode === 1 && diagnostic.includes("mcp-auth failed to start (EPERM)")) {
      t.skip("sandbox denies listening sockets; entrypoint cleared the binding gate and reached listen");
      return null;
    }
    assert.equal(child.exitCode, null, `entrypoint exited before discovery: ${diagnostic}`);
    try {
      const response = await fetch(`${root}/.well-known/oauth-authorization-server`);
      assert.equal(response.status, 200);
      await response.body.cancel();
      return root;
    } catch (error) {
      if (error instanceof assert.AssertionError) throw error;
      await delay(50);
    }
  }
  assert.fail("entrypoint did not serve discovery within 5 seconds");
}

test("real node src/server.js entrypoint starts enabled and leaves disabled mode dark without management inputs; absent issuer keeps admin closed", async (t) => {
  for (const enabled of [false, true]) {
    await t.test(enabled ? "enabled bindings" : "disabled unchanged", async (t) => {
      const env = await fixture(t);
      env.MCP_OAUTH_PUBLIC_AUTHORIZATION_ENABLED = enabled ? "1" : "0";
      env.MCP_OAUTH_ADMIN_ISSUANCE_ENABLED = "1";
      delete env.MCP_OAUTH_ADMIN_ISSUER_DATABASE_CREDENTIALS_FILE;
      if (!enabled) delete env.MCP_OAUTH_MANAGEMENT_DATABASE_CREDENTIALS_FILE;
      const root = await entrypoint(t, env);
      if (root === null) return;
      const response = await fetch(`${root}/authorize`, {
        redirect: "manual", headers: { accept: "application/json" },
      });
      assert.equal(response.status, enabled ? 400 : 503);
      if (enabled) assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
      await response.body.cancel();
      const gate = await fetch(`${root}/admin/gate`);
      assert.equal(gate.status, 200);
      assert.deepEqual(await gate.json(), { state: "closed" });
    });
  }
});

test("enabled configuration requires the protected management credential; disabled configuration ignores it", async (t) => {
  const env = await fixture(t);
  delete env.MCP_OAUTH_MANAGEMENT_DATABASE_CREDENTIALS_FILE;
  env.MCP_OAUTH_PUBLIC_AUTHORIZATION_ENABLED = "1";
  await assert.rejects(loadConfig(env), /MCP_OAUTH_MANAGEMENT_DATABASE_CREDENTIALS_FILE is required/u);
  env.MCP_OAUTH_PUBLIC_AUTHORIZATION_ENABLED = "0";
  assert.deepEqual(await createProductionManagementBindings(await loadConfig(env)), {});
});

test("production entrypoint invokes the bundled management handler; OFF imports no bundle and allocates no pool", async (t) => {
  for (const enabled of [false, true]) {
    await t.test(enabled ? "enabled real bundled handler with stub DB" : "disabled no management database", async (t) => {
      const env = await fixture(t);
      env.MCP_OAUTH_PUBLIC_AUTHORIZATION_ENABLED = enabled ? "1" : "0";
      if (!enabled) delete env.MCP_OAUTH_MANAGEMENT_DATABASE_CREDENTIALS_FILE;
      const { stdout } = await exec(process.execPath,
        [new URL("fixtures/management-entrypoint.js", import.meta.url).pathname], { env, timeout: 10_000 });
      assert.match(stdout, enabled ? /real bundled revoke.*PASS/u : /zero management bundle imports, pools or queries PASS/u);
    });
  }
});

test("production bindings refuse unverified identities and non-management commands before database work", async (t) => {
  const env = await fixture(t);
  env.MCP_OAUTH_PUBLIC_AUTHORIZATION_ENABLED = "1";
  const config = await loadConfig(env);
  await assert.rejects(startServer({ config }), /requires lane-2 management command and workspace-read bindings/u);
  const bindings = await createProductionManagementBindings(config);
  t.after(bindings.closeManagement);
  await assert.rejects(bindings.managementWorkspaceReader({ userId: "20000000-0000-4000-8000-000000000001" }),
    { code: "authentication_required" });
  await assert.rejects(bindings.managementCommand({ command: { kind: "begin_hosted_mcp_grant" } }, null),
    { code: "authentication_required" });
  assert.deepEqual(await bindings.managementCommand({ command: { kind: "post_signal" } }, {
    userId: "20000000-0000-4000-8000-000000000001", identityVerified: true,
  }), { status: 403, body: { error: "forbidden" } });
});
