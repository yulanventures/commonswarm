import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { exportJWK, generateKeyPair } from "jose";

import { loadConfig } from "../src/config.js";

const root = new URL("../../../", import.meta.url);

async function text(path) {
  return await readFile(new URL(path, root), "utf8");
}

test("container is pinned, unprivileged, and starts the production server", async () => {
  const dockerfile = await text("services/mcp-auth/Dockerfile");
  assert.match(dockerfile, /^FROM node:22\.[^@\s]+-bookworm-slim@sha256:[0-9a-f]{64}$/mu);
  assert.match(dockerfile, /^USER 10001:10001$/mu);
  assert.match(dockerfile, /^CMD \["node", "src\/server\.js"\]$/mu);
  assert.doesNotMatch(dockerfile, /latest/u);
});

test("migration has no transaction control and proofs have the required safe shape", async () => {
  const migration = await text("supabase/migrations/20260928000003_hm_oauth_store.sql");
  const superuserOnlyRoleAttribute = /\b(?:NO)?(?:SUPERUSER|REPLICATION|BYPASSRLS)\b/iu;
  assert.match("CREATE ROLE positive_control NOSUPERUSER", superuserOnlyRoleAttribute);
  assert.doesNotMatch(migration, superuserOnlyRoleAttribute);
  assert.doesNotMatch(migration, /^\s*(BEGIN|COMMIT);/gmu);
  assert.match(migration, /CREATE SCHEMA commonswarm_oauth AUTHORIZATION swarm_admin/u);
  assert.match(migration, /LOGIN NOINHERIT NOCREATEDB NOCREATEROLE/u);
  assert.match(migration, /commonswarm_oauth_runtime has unsafe role attributes/u);
  assert.doesNotMatch(migration, /ALTER ROLE commonswarm_oauth_runtime\s+LOGIN/u);
  assert.match(migration, /REVOKE ALL ON SCHEMA swarm FROM commonswarm_oauth_runtime/u);
  assert.match(migration, /Apply after 20260928000002_hm_hosted_authority\.sql/u);
  assert.match(migration, /ALTER DEFAULT PRIVILEGES FOR ROLE swarm_admin\s+REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC/u);
  const catalog = await text("deploy/release-proofs/item-hm/20260928000003-catalog.sql");
  assert.match(catalog, /AS catalog_ok\s*\n\\gset\s*$/u);
  assert.match(catalog, /to_regclass\('commonswarm_oauth\.provider_artifacts'\)/u);
  assert.match(catalog, /AS lane_2_authority_present\s*\n\\gset/u);
  assert.match(catalog, /count\(\*\) FILTER \(WHERE contype = 'c'\) = 29/u);
  assert.doesNotMatch(catalog, /has_(?:table|function|schema)_privilege\([^)]*'[^']*,[^']*'\)/su);
  const functional = await text("deploy/release-proofs/item-hm/20260928000003-functional.sql");
  assert.match(functional, /AS lane_2_authority_present\s*\n\\gset/u);
  assert.doesNotMatch(functional, /has_(?:table|function|schema)_privilege\([^)]*'[^']*,[^']*'\)/su);
  const server = await text("services/mcp-auth/src/server.js");
  assert.match(server, /WHERE commonswarm_oauth\.cimd_cache\.expires_at <= statement_timestamp\(\)/u);
  const rollback = await text("deploy/release-proofs/item-hm/20260928000003-rollback.sql");
  assert.doesNotMatch(rollback, superuserOnlyRoleAttribute);
  for (const object of ["provider_artifacts", "refresh_family_tombstones", "browser_sessions",
    "interactions", "cimd_cache", "consent_orchestration"]) {
    assert.match(rollback, new RegExp(`DROP TABLE commonswarm_oauth\\.${object}`, "u"));
  }
  assert.match(rollback, /DROP ROLE commonswarm_oauth_runtime/u);
  assert.match(rollback, /unexpected ownership remains/u);
  assert.match(rollback, /grants or dependencies remain/u);
  assert.doesNotMatch(rollback, /role membership remains/u);
});

test("protected-file configuration defaults dark and orders the active signing kid first", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-auth-config-"));
  const paths = Object.fromEntries(["signing", "cookies", "database", "ca"].map(
    (name) => [name, join(directory, name)],
  ));
  const keys = [];
  for (const kid of ["previous", "active"]) {
    const { privateKey } = await generateKeyPair("ES256", { extractable: true });
    keys.push({ ...await exportJWK(privateKey), alg: "ES256", kid, use: "sig" });
  }
  await writeFile(paths.signing, JSON.stringify({ keys }));
  await writeFile(paths.cookies, `${"a".repeat(32)}\n${"b".repeat(32)}\n`);
  await writeFile(paths.database, JSON.stringify({ user: "runtime", password: "not-a-live-secret" }));
  await writeFile(paths.ca, "test-ca");
  await Promise.all(Object.values(paths).map((path) => chmod(path, 0o640)));
  const config = await loadConfig({
    MCP_OAUTH_SIGNING_KEYS_FILE: paths.signing,
    MCP_OAUTH_COOKIE_KEYS_FILE: paths.cookies,
    MCP_OAUTH_DATABASE_CREDENTIALS_FILE: paths.database,
    MCP_OAUTH_DATABASE_TLS_CA_FILE: paths.ca,
    MCP_OAUTH_ACTIVE_SIGNING_KID: "active",
    MCP_OAUTH_ISSUER: "https://mcp.commonswarm.com",
    MCP_OAUTH_RESOURCE: "https://mcp.commonswarm.com/mcp",
    MCP_OAUTH_PUBLIC_ORIGIN: "https://mcp.commonswarm.com",
    MCP_OAUTH_ALLOWED_ORIGINS: "https://commonswarm.com,https://www.commonswarm.com",
    MCP_OAUTH_GOTRUE_URL: "https://api.commonswarm.com/auth/v1",
    MCP_OAUTH_GOTRUE_PROVIDER: "github",
    SUPABASE_ANON_KEY: "public-test-anon-key",
    MCP_OAUTH_DATABASE_HOST: "db.internal",
    MCP_OAUTH_DATABASE_NAME: "postgres",
  });
  assert.equal(config.publicAuthorizationEnabled, false);
  assert.equal(config.nativeLoopbackEnabled, false);
  assert.equal(config.allowedOrigins.has("https://mcp.commonswarm.com"), true);
  assert.deepEqual(config.jwks.keys.map(({ kid }) => kid), ["active", "previous"]);
  assert.equal(config.database.password, "not-a-live-secret");
  assert.equal(config.database.ssl.rejectUnauthorized, true);
});
