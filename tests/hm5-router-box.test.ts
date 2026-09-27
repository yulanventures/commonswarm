import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  DISABLED_FUNCTION_NAMES,
  FUNCTION_DISABLED_BODY,
  FUNCTION_DISABLED_STATUS,
  FUNCTION_ENV_NAMES,
  FUNCTION_NAMES,
  MCP_ENV_NAMES,
  resolveFunctionRoute,
  resolveGatewayRequest,
} from "../deploy/edge-runtime/main/router.js";

const repoRoot = process.cwd();

async function source(path: string): Promise<string> {
  return await readFile(resolve(repoRoot, path), "utf8");
}

test("HM5 prepares MCP without routing to its absent worker module", async () => {
  assert.deepEqual(FUNCTION_NAMES, [
    "command",
    "read",
    "capability",
    "activity",
    "h0",
    "mcp",
  ]);
  assert.deepEqual(DISABLED_FUNCTION_NAMES, ["mcp"]);
  assert.equal(resolveFunctionRoute("/functions/v1/mcp"), null);

  for (const path of [
    "/functions/v1/mcp",
    "/functions/v1/mcp/",
    "/functions/v1/mcp/.well-known/oauth-protected-resource/mcp",
  ]) {
    const resolution = resolveGatewayRequest(
      new Request(`https://edge.test${path}`, { method: "POST" }),
    );
    assert.equal(resolution.route, null, `${path} exposed a worker route`);
    assert.equal(resolution.response?.status, FUNCTION_DISABLED_STATUS);
    assert.deepEqual(await resolution.response?.json(), FUNCTION_DISABLED_BODY);
  }

  const main = await source("deploy/edge-runtime/main/index.ts");
  assert.match(main, /prepared-but-disabled function returns/);
  assert.equal(
    await readFile(resolve(repoRoot, "supabase/functions/mcp/index.ts"), "utf8")
      .then(() => true, () => false),
    false,
    "a worker appeared; replace the dark-route test with runnable-worker gates",
  );
});

test("HM5 MCP environment is explicit and excludes OAuth secrets", () => {
  const expected = [
    "SWARM_DATABASE_URL",
    "SUPABASE_DB_URL",
    "SWARM_DATABASE_TLS_CA_B64",
    "SUPABASE_URL",
    "SUPABASE_ANON_KEY",
    "SWARM_ENV",
    "SWARM_MCP_ISSUER",
    "SWARM_MCP_RESOURCE",
    "SWARM_MCP_JWKS_URL",
    "SWARM_MCP_ALLOWED_ORIGINS",
    "SWARM_MCP_MAX_BODY_BYTES",
    "SWARM_MCP_MAX_RESPONSE_BYTES",
    "SWARM_MCP_REQUEST_TIMEOUT_MS",
    "SWARM_MCP_MAX_CONCURRENT_REQUESTS",
    "SWARM_MCP_JWKS_CACHE_TTL_SECONDS",
    "SWARM_MCP_CLOCK_SKEW_SECONDS",
  ];
  assert.deepEqual(MCP_ENV_NAMES, expected);
  assert.deepEqual(FUNCTION_ENV_NAMES.mcp, expected);

  const forbidden =
    /SERVICE_ROLE|SIGNING|COOKIE|REFRESH|DATABASE_CREDENTIAL|PASSWORD|PRIVATE_KEY|SECRET|TOKEN/;
  assert.deepEqual(MCP_ENV_NAMES.filter((name) => forbidden.test(name)), []);
  assert.equal(MCP_ENV_NAMES.includes("SUPABASE_SERVICE_ROLE_KEY" as never), false);
});

test("HM5 OAuth Compose fixes the box resource and secret-file boundaries", async () => {
  const compose = await source("deploy/mcp-auth/compose.yaml");
  assert.match(compose, /^name: commonswarm-oauth$/m);
  assert.match(
    compose,
    /image: \$\{MCP_OAUTH_IMAGE:\?[^\n]*sha256 digest\}/,
  );
  assert.match(
    compose,
    /127\.0\.0\.1:\$\{MCP_OAUTH_HOST_PORT:\?[^}]+\}:3490/,
  );
  assert.doesNotMatch(compose, /(?:0\.0\.0\.0|\[::\]):[^\n]*:3490/);
  assert.match(compose, /^\s+mem_limit: 512m$/m);
  assert.match(compose, /^\s+cpus: 1\.0$/m);
  assert.match(compose, /^\s+restart: unless-stopped$/m);
  assert.match(compose, /healthcheck:[\s\S]*?interval: 10s[\s\S]*?timeout: 3s[\s\S]*?retries: 6[\s\S]*?start_period: 20s/);
  assert.match(compose, /Connection: 'close'/);
  assert.match(compose, /await response\.body\?\.cancel\(\)/);
  assert.match(compose, /process\.exit\(response\.ok \? 0 : 1\)/);
  assert.match(compose, /driver: json-file[\s\S]*?max-size: 10m[\s\S]*?max-file: "3"/);
  assert.match(compose, /name: commonswarm-net\n\s+external: true/);
  assert.match(compose, /MCP_OAUTH_SIGNING_KEYS_FILE: \/run\/commonswarm-oauth\/signing-keys\.pem/);
  assert.match(compose, /MCP_OAUTH_COOKIE_KEYS_FILE: \/run\/commonswarm-oauth\/cookie-keys/);
  assert.match(compose, /MCP_OAUTH_DATABASE_CREDENTIALS_FILE: \/run\/commonswarm-oauth\/database-credentials/);
  assert.match(compose, /MCP_OAUTH_DATABASE_TLS_CA_FILE: \/run\/commonswarm-oauth\/yulan-internal-ca\.pem/);

  for (const file of [
    "signing-keys.pem",
    "cookie-keys",
    "database-credentials",
    "yulan-internal-ca.pem",
  ]) {
    assert.match(
      compose,
      new RegExp(`source: /etc/commonswarm-oauth/${file.replace(".", "\\.")}[\\s\\S]*?read_only: true`),
    );
  }
});

test("HM5 OAuth env example contains names but no values", async () => {
  const example = await source("deploy/mcp-auth/env.example");
  const assignments = [...example.matchAll(/^([A-Z][A-Z0-9_]*)=(.*)$/gm)];
  assert.ok(assignments.length > 0);
  assert.deepEqual(
    assignments.filter((match) => match[2] !== "").map((match) => match[1]),
    [],
  );
  assert.equal(
    new Set(assignments.map((match) => match[1])).size,
    assignments.length,
  );
});

test("HM5 Caddy and release documents preserve the dark deployment contract", async () => {
  const [caddy, release, runbook, verification, stackEnv] = await Promise.all([
    source("deploy/supabase-stack/commonswarm-mcp.caddy"),
    source("deploy/RELEASE-TO-BOX.md"),
    source("deploy/mcp-auth/RUNBOOK.md"),
    source("deploy/mcp-auth/VERIFICATION.md"),
    source("deploy/supabase-stack/env.example"),
  ]);

  assert.match(caddy, /^mcp\.commonswarm\.com \{$/m);
  assert.match(caddy, /\(mcp_resource_active\)[\s\S]*?method POST[\s\S]*?rewrite \* \/functions\/v1\/mcp\n\s+reverse_proxy 127\.0\.0\.1:9000/);
  assert.match(caddy, /\(mcp_resource_active\)[\s\S]*?method GET HEAD[\s\S]*?functions\/v1\/mcp\/\.well-known\/oauth-protected-resource\/mcp/);
  assert.match(caddy, /\(mcp_oauth_active\)[\s\S]*?reverse_proxy 127\.0\.0\.1:\{\$MCP_OAUTH_HOST_PORT\}/);
  assert.match(caddy, /@mcp_unavailable path \/mcp \/\.well-known\/oauth-protected-resource\/mcp\n\s+handle @mcp_unavailable \{[\s\S]*?feature_disabled[\s\S]*?503/);
  assert.match(caddy, /@oauth_unavailable[\s\S]*?feature_disabled[\s\S]*?503/);
  const activeSite = caddy.slice(caddy.indexOf("mcp.commonswarm.com {"));
  assert.doesNotMatch(activeSite, /import mcp_(?:resource|oauth)_active/);
  assert.doesNotMatch(activeSite, /method (?:POST|GET|HEAD)/);

  const releasePlaceholder =
    "OAuth service release: written with HM lane 6's box plan, when the service exists.";
  assert.equal(release.split(releasePlaceholder).length - 1, 1);
  assert.doesNotMatch(release, /^## 6A\. OAuth service release/m);
  const placeholderIndex = release.indexOf(releasePlaceholder);
  const nextSectionIndex = release.indexOf("## 7. Stack or edge image pin bump");
  assert.ok(placeholderIndex >= 0 && placeholderIndex < nextSectionIndex);

  for (const document of [runbook, verification]) {
    assert.doesNotMatch(document, /^## (?:Preflight|Release|Rollback)$/m);
    assert.doesNotMatch(
      document,
      /(?:docker compose|systemctl|caddy validate|ss -ltnp|```sh)/,
    );
  }
  assert.match(runbook, /commonswarm-oauth/);
  assert.match(runbook, /\/home\/commonswarm\/oauth\/releases\/<sha>/);
  assert.match(runbook, /\/home\/commonswarm\/oauth\/current/);
  assert.match(runbook, /Yulan Ventures\s+Infra/);
  assert.match(runbook, /`kid` rotation contract/);
  assert.match(runbook, /3490` through `3499/);
  assert.match(verification, /Python-urllib\/3\.12/);
  assert.match(verification, /Browser Integrity Check and bot challenges/);

  assert.match(
    stackEnv,
    /^GOTRUE_URI_ALLOW_LIST=https:\/\/commonswarm\.com\/app,https:\/\/www\.commonswarm\.com\/app,http:\/\/127\.0\.0\.1:\*\/callback,https:\/\/mcp\.commonswarm\.com\/oauth\/callback\/gotrue$/m,
  );
});
