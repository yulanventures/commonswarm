import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  DISABLED_FUNCTION_NAMES,
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

test("HM7 keeps MCP dark in the main router until explicitly enabled", async () => {
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
  assert.deepEqual(resolveFunctionRoute("/functions/v1/mcp", true), {
    functionName: "mcp",
    pathname: "/mcp",
  });

  for (const path of [
    "/functions/v1/mcp",
    "/functions/v1/mcp/",
    "/functions/v1/mcp/.well-known/oauth-protected-resource/mcp",
  ]) {
    for (const method of ["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"]) {
      const dark = resolveGatewayRequest(
        new Request(`https://edge.test${path}`, { method }),
        false,
      );
      assert.equal(dark.route, null);
      assert.equal(dark.response?.status, 503);
      assert.deepEqual(await dark.response?.json(), {
        error: "feature_disabled",
        feature: "hosted_mcp",
        message: "Hosted MCP is not available yet.",
      });
    }

    const enabled = resolveGatewayRequest(
      new Request(`https://edge.test${path}`, { method: "POST" }),
      true,
    );
    assert.equal(enabled.route?.functionName, "mcp");
    assert.equal(enabled.response, null);
  }

  const main = await source("deploy/edge-runtime/main/index.ts");
  assert.match(
    main,
    /const mcpPublicEnvironmentValue = Deno\.env\.get\(MCP_PUBLIC_ENABLED_ENV\);/,
  );
  assert.equal(
    (main.match(/Deno\.env\.get\(MCP_PUBLIC_ENABLED_ENV\)/g) ?? []).length,
    1,
  );
  assert.match(main, /return await handleGatewayRequest\(/);
  assert.equal(
    await readFile(resolve(repoRoot, "supabase/functions/mcp/index.ts"), "utf8")
      .then(() => true, () => false),
    true,
    "the routed worker module must exist",
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
    "SWARM_MCP_PUBLIC_ENABLED",
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
  assert.match(compose, /MCP_OAUTH_DATABASE_TLS_CA_FILE: \/etc\/ssl\/yulan-internal-ca\.pem/);

  for (const file of [
    "signing-keys.pem",
    "cookie-keys",
    "database-credentials",
  ]) {
    assert.match(
      compose,
      new RegExp(`source: /etc/commonswarm-oauth/${file.replace(".", "\\.")}[\\s\\S]*?read_only: true`),
    );
  }
  assert.match(
    compose,
    /source: \/etc\/ssl\/yulan-internal-ca\.pem[\s\S]*?target: \/etc\/ssl\/yulan-internal-ca\.pem[\s\S]*?read_only: true/,
  );
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

test("HM6 Caddy activates OAuth only and preserves the dark MCP resource contract", async () => {
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
  const activeSite = caddy.slice(caddy.indexOf("mcp.commonswarm.com {"));
  assert.equal((activeSite.match(/import mcp_oauth_active/g) ?? []).length, 1);
  assert.doesNotMatch(activeSite, /import mcp_resource_active/);
  assert.doesNotMatch(activeSite, /hosted_mcp_oauth/);
  assert.match(caddy, /@oauth_health \{\s*method GET HEAD\s*path \/health/);
  assert.match(caddy, /@oauth_metadata \{\s*method GET HEAD\s*path \/\.well-known\/oauth-authorization-server \/\.well-known\/openid-configuration \/jwks/);
  assert.match(caddy, /@oauth_authorize \{\s*method GET HEAD\s*path \/authorize/);
  assert.match(caddy, /@oauth_post \{\s*method POST\s*path \/token \/interaction\/\*/);
  assert.match(caddy, /@oauth_browser_get \{\s*method GET HEAD\s*path \/interaction\/\* \/oauth\/callback\/gotrue/);
  assert.doesNotMatch(caddy, /\/connections(?:\/|\s)/);

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

test("nightly backup and restore paths include the OAuth schema", async () => {
  const oauthSchema = "commonswarm_oauth";
  const paths = {
    lib: "deploy/supabase-stack/migrate/lib.sh",
    dump: "deploy/supabase-stack/migrate/dump-source.sh",
    dumpDatabase: "deploy/supabase-stack/backup/dump-database.sh",
    runBackup: "deploy/supabase-stack/backup/run-backup.sh",
    upload: "deploy/supabase-stack/backup/upload-snapshot.py",
    restore: "deploy/supabase-stack/migrate/restore-target.sh",
    restoreDrill: "deploy/supabase-stack/backup/restore-drill.py",
    testH0Upgrade: "deploy/supabase-stack/migrate/test-h0-upgrade.py",
    verify: "deploy/supabase-stack/migrate/verify-counts.sh",
    verifyPostUpgrade: "deploy/supabase-stack/migrate/verify-post-upgrade-counts.sh",
  } as const;
  const sources = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([name, path]) => [
    name,
    await source(path),
  ]))) as Record<keyof typeof paths, string>;

  function audit(values: typeof sources): string[] {
    const errors: string[] = [];
    const requireList = (name: string, value: string, pattern: RegExp) => {
      const list = pattern.exec(value)?.[1];
      if (!list) errors.push(`${name} schema list is missing`);
      else {
        const names: string[] = list.match(/[a-z][a-z0-9_]*/g) ?? [];
        if (!names.includes(oauthSchema)) {
          errors.push(`${name} lacks ${oauthSchema}`);
        }
      }
    };
    requireList("canonical selected schemas", values.lib,
      /selected_schema_csv\(\) \{\s*printf '%s' "([^"]+)"/);
    requireList("pg_dump schemas", values.dump, /^schemas=\(([^)]+)\)$/m);
    requireList("dump table counts", values.dump,
      /FROM pg_tables\s+WHERE schemaname = ANY \(string_to_array\('([^']+)'/);
    requireList("restore table-count verification", values.verify,
      /FROM pg_tables\s+WHERE schemaname = ANY \(string_to_array\('([^']+)'/);
    requireList("post-upgrade table-count verification", values.verifyPostUpgrade,
      /FROM pg_tables\s+WHERE schemaname = ANY \(string_to_array\('([^']+)'/);
    requireList("H0 restore-verification fixture", values.testH0Upgrade,
      /FROM pg_tables WHERE schemaname IN \(([^)]+)\)/);
    requireList("offsite backup manifest validation", values.upload,
      /REQUIRED_DATABASE_SCHEMAS = frozenset\(\{([\s\S]*?)\}\)/);
    requireList("restore-drill manifest validation", values.restoreDrill,
      /REQUIRED_DATABASE_SCHEMAS = frozenset\(\{([\s\S]*?)\}\)/);

    if (!values.dumpDatabase.includes('bash "$stack_dir/migrate/dump-source.sh" backup')) {
      errors.push("nightly database dump does not use dump-source.sh");
    }
    if (!values.runBackup.includes('bash "$stack_dir/backup/dump-database.sh" "$artifact"')) {
      errors.push("nightly backup does not use dump-database.sh");
    }
    if (!values.upload.includes("validate_manifest((artifact / 'manifest.txt').read_text())")) {
      errors.push("offsite upload does not validate the schema manifest");
    }
    if (!values.restore.includes('expected_schemas="$(selected_schema_csv)"') ||
        !values.restore.includes('"$manifest_schemas" != "$expected_schemas"')) {
      errors.push("restore does not require the canonical schema manifest");
    }
    if (!values.restoreDrill.includes("validate_manifest((artifact / 'manifest.txt').read_text())") ||
        !values.restoreDrill.includes("'commonswarm_oauth.provider_artifacts'")) {
      errors.push("restore drill does not validate OAuth schema coverage");
    }
    if (!values.restoreDrill.includes(
      "'restore-target.sh', 'prepare-target.sh', 'restore-cron-jobs.sh', 'verify-counts.sh'",
    )) {
      errors.push("restore drill no longer runs the schema restore and verification scripts");
    }
    return errors;
  }

  assert.deepEqual(audit(sources), []);

  // Positive controls: each independently maintained schema list must fail
  // the same audit when its OAuth entry is removed.
  for (const name of [
    "lib", "dump", "verify", "verifyPostUpgrade", "testH0Upgrade", "upload", "restoreDrill",
  ] as const) {
    const mutated = { ...sources, [name]: sources[name].replace(oauthSchema, "removed_oauth_schema") };
    assert.match(audit(mutated).join("\n"), new RegExp(`lacks ${oauthSchema}`), name);
  }
});
