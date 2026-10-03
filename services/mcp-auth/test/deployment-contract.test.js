import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { chmod, lstat, open, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";

import { exportJWK, generateKeyPair } from "jose";

import { loadConfig } from "../src/config.js";

const root = new URL("../../../", import.meta.url);
const execFileAsync = promisify(execFile);
const fixtureDirectories = [];
after(async () => {
  for (const directory of fixtureDirectories) {
    assert.match(directory, /^\/private\/tmp\/anvil-secret\.[A-Za-z0-9]+$/u);
    await execFileAsync("/Users/yulanbot/.local/bin/rm", ["-rf", directory]);
  }
});

async function text(path) {
  return await readFile(new URL(path, root), "utf8");
}

async function configFixture() {
  const { stdout } = await execFileAsync("mktemp", ["-d", "/private/tmp/anvil-secret.XXXXXX"]);
  const directory = stdout.trim();
  fixtureDirectories.push(directory);
  await chmod(directory, 0o700);
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
  return {
    directory,
    paths,
    env: {
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
    },
  };
}

test("container is pinned, unprivileged, and starts the production server", async () => {
  const dockerfile = await text("services/mcp-auth/Dockerfile");
  assert.match(dockerfile, /^FROM node:22\.[^@\s]+-bookworm-slim@sha256:[0-9a-f]{64}$/mu);
  assert.match(dockerfile, /^USER 10001:10001$/mu);
  assert.match(dockerfile, /^CMD \["node", "src\/server\.js"\]$/mu);
  assert.doesNotMatch(dockerfile, /latest/u);
});

test("OAuth Compose requires the database hostname mapping and verify-full TLS", async () => {
  const [compose, example, config] = await Promise.all([
    text("deploy/mcp-auth/compose.yaml"),
    text("deploy/mcp-auth/env.example"),
    text("services/mcp-auth/src/config.js"),
  ]);
  assert.match(
    compose,
    /extra_hosts:\n\s+- "\$\{MCP_OAUTH_DATABASE_HOST:\?[^}]+\}:\$\{MCP_OAUTH_DATABASE_ADDRESS:\?[^}]+\}"/u,
  );
  assert.match(
    compose,
    /MCP_OAUTH_DATABASE_TLS_CA_FILE: \/etc\/ssl\/yulan-internal-ca\.pem/u,
  );
  assert.match(
    compose,
    /source: \/etc\/ssl\/yulan-internal-ca\.pem[\s\S]*?target: \/etc\/ssl\/yulan-internal-ca\.pem[\s\S]*?read_only: true/u,
  );
  assert.match(compose, /sslmode=verify-full/u);
  assert.match(config, /ssl: \{ ca: tlsCa, rejectUnauthorized: true \}/u);
  assert.match(example, /^MCP_OAUTH_DATABASE_HOST=$/mu);
  assert.match(example, /^MCP_OAUTH_DATABASE_ADDRESS=$/mu);
  assert.match(example, /db\.commonswarm\.internal/u);
  assert.match(example, /172\.31\.0\.10/u);
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
  const { env } = await configFixture();
  const config = await loadConfig({ ...env, MCP_OAUTH_DATABASE_TLS_CA_FILE: "/etc/hosts" });
  assert.equal(config.publicAuthorizationEnabled, false);
  assert.equal(config.nativeLoopbackEnabled, false);
  assert.equal(config.allowedOrigins.has("https://mcp.commonswarm.com"), true);
  assert.deepEqual(config.jwks.keys.map(({ kid }) => kid), ["active", "previous"]);
  assert.equal(config.database.password, "not-a-live-secret");
  assert.equal(config.database.ssl.rejectUnauthorized, true);
});

test("public database CA policy accepts root-owned 0644 and rejects unsafe paths", async (t) => {
  const { directory, env, paths } = await configFixture();
  const publicCa = "/etc/hosts";
  const publicCaMetadata = await lstat(publicCa);
  assert.equal(publicCaMetadata.isFile(), true);
  assert.equal(publicCaMetadata.uid, 0);
  assert.equal(publicCaMetadata.mode & 0o777, 0o644);
  await assert.doesNotReject(loadConfig({ ...env, MCP_OAUTH_DATABASE_TLS_CA_FILE: publicCa }));

  await t.test("group-writable CA", async () => {
    await chmod(paths.ca, 0o660);
    await assert.rejects(loadConfig(env), /database TLS CA path must not be writable by group or other users/u);
  });

  await t.test("other-writable CA", async () => {
    await chmod(paths.ca, 0o602);
    await assert.rejects(loadConfig(env), /database TLS CA path must not be writable by group or other users/u);
  });

  await t.test("symlinked CA", async () => {
    const link = join(directory, "ca-link");
    await symlink(publicCa, link);
    await assert.rejects(
      loadConfig({ ...env, MCP_OAUTH_DATABASE_TLS_CA_FILE: link }),
      /database TLS CA path must be a regular file, not a symlink/u,
    );
  });

  await t.test("non-root-owned CA", async () => {
    await chmod(paths.ca, 0o644);
    await assert.rejects(loadConfig(env), /database TLS CA path must be owned by root \(uid 0\)/u);
  });

  await t.test("missing CA", async () => {
    await assert.rejects(
      loadConfig({ ...env, MCP_OAUTH_DATABASE_TLS_CA_FILE: join(directory, "missing-ca") }),
      /database TLS CA path must exist and be inspectable/u,
    );
  });
});

test("secret file policies still reject 0644", async (t) => {
  const secretSettings = [
    ["signing key", "MCP_OAUTH_SIGNING_KEYS_FILE", "signing"],
    ["cookie key", "MCP_OAUTH_COOKIE_KEYS_FILE", "cookies"],
    ["database credential", "MCP_OAUTH_DATABASE_CREDENTIALS_FILE", "database"],
  ];
  for (const [name, envName, pathName] of secretSettings) {
    await t.test(name, async () => {
      const { env, paths } = await configFixture();
      await chmod(paths[pathName], 0o644);
      await assert.rejects(
        loadConfig({ ...env, [envName]: paths[pathName], MCP_OAUTH_DATABASE_TLS_CA_FILE: "/etc/hosts" }),
        new RegExp(`${name} path must be a file with no permissions for other users`, "u"),
      );
    });
  }
});

test("file content is read from the descriptor whose metadata was checked", async () => {
  const { env, paths } = await configFixture();
  const checkedPath = `${paths.cookies}-checked`;
  const probe = await open(paths.cookies, constants.O_RDONLY);
  const fileHandlePrototype = Object.getPrototypeOf(probe);
  await probe.close();
  const originalStat = fileHandlePrototype.stat;
  let statCalls = 0;
  fileHandlePrototype.stat = async function (...args) {
    const metadata = await originalStat.apply(this, args);
    statCalls += 1;
    if (statCalls === 2) {
      await rename(paths.cookies, checkedPath);
      await writeFile(paths.cookies, `${"c".repeat(32)}\n${"d".repeat(32)}\n`, { mode: 0o640 });
    }
    return metadata;
  };
  let config;
  try {
    config = await loadConfig({ ...env, MCP_OAUTH_DATABASE_TLS_CA_FILE: "/etc/hosts" });
  } finally {
    fileHandlePrototype.stat = originalStat;
  }
  assert.equal(statCalls, 4);
  assert.deepEqual(config.cookieKeys, ["a".repeat(32), "b".repeat(32)]);
});

test("a FIFO file setting fails without waiting for a writer", async () => {
  const { directory, env } = await configFixture();
  const fifo = join(directory, "ca-fifo");
  await execFileAsync("mkfifo", [fifo]);
  const startedAt = performance.now();
  await assert.rejects(
    loadConfig({ ...env, MCP_OAUTH_DATABASE_TLS_CA_FILE: fifo }),
    /database TLS CA path must be a regular file/u,
  );
  assert.ok(performance.now() - startedAt < 1_000, "FIFO policy check did not fail fast");
});


test("admin activation config accepts only literal 1 and keeps missing or unreadable issuer files optional", async () => {
  const { env, directory } = await configFixture();
  const base = { ...env, MCP_OAUTH_DATABASE_TLS_CA_FILE: "/etc/hosts" };
  for (const value of [undefined, "", "0", "true", "yes", "01", "1 ", " 1", "1\n", 1, true]) {
    assert.equal((await loadConfig({ ...base, MCP_OAUTH_ADMIN_ISSUANCE_ENABLED: value })).adminIssuanceEnabled, false);
  }
  const on = { ...base, MCP_OAUTH_ADMIN_ISSUANCE_ENABLED: "1" };
  assert.equal((await loadConfig(on)).adminIssuanceEnabled, true);
  assert.equal((await loadConfig(on)).adminIssuer, undefined);
  assert.equal((await loadConfig({ ...on, MCP_OAUTH_ADMIN_ISSUER_DATABASE_CREDENTIALS_FILE: join(directory, "missing") })).adminIssuer, undefined);
  const path = join(directory, "issuer");
  await writeFile(path, JSON.stringify({ user: "commonswarm_admin_issuer", password: "synthetic-test-only" }), { mode: 0o600 });
  const configured = { ...on, MCP_OAUTH_ADMIN_ISSUER_DATABASE_CREDENTIALS_FILE: path };
  assert.equal((await loadConfig(configured)).adminIssuer.user, "commonswarm_admin_issuer");
  await chmod(path, 0o000);
  assert.equal((await loadConfig(configured)).adminIssuer, undefined);
  await chmod(path, 0o644);
  assert.equal((await loadConfig(configured)).adminIssuer, undefined);
  await chmod(path, 0o600);
  await writeFile(path, JSON.stringify({ user: "commonswarm_oauth_runtime", password: "synthetic-test-only" }));
  await assert.rejects(loadConfig(configured), /dedicated login role/u);
});
