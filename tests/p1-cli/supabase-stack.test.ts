import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();
const stackDir = join(root, "deploy", "supabase-stack");
const { STORAGE_UPLOAD_ORIGINS } = await import(join(root, "deploy", "edge-runtime", "check-caddy-adapted.mjs"));
const storageUploadOrigins = STORAGE_UPLOAD_ORIGINS as readonly string[];
const [
  compose,
  envExample,
  migrationEnvExample,
  apiCaddy,
  edgeStagingCaddy,
  apiMaintenanceCaddy,
  edgeStagingMaintenanceCaddy,
  mcpCaddy,
  runtimeRoles,
  prepareTarget,
  dumpSource,
  setupRealtime,
  readOnlyScript,
  copyStorage,
  migrationLib,
  restoreTarget,
  restoreStorageMetadata,
  verifyCounts,
  restoreCronJobs,
  seedRealtimeTenant,
  makePgService,
  pgHba,
  runbook,
] = await Promise.all([
  readFile(join(stackDir, "compose.yaml"), "utf8"),
  readFile(join(stackDir, "env.example"), "utf8"),
  readFile(join(stackDir, "migration.env.example"), "utf8"),
  readFile(join(stackDir, "commonswarm-api.caddy"), "utf8"),
  readFile(join(stackDir, "commonswarm-edge-staging.caddy"), "utf8"),
  readFile(join(stackDir, "commonswarm-api-maintenance.caddy"), "utf8"),
  readFile(join(stackDir, "commonswarm-edge-staging-maintenance.caddy"), "utf8"),
  readFile(join(stackDir, "commonswarm-mcp.caddy"), "utf8"),
  readFile(join(stackDir, "postgres", "10-runtime-roles.sh"), "utf8"),
  readFile(join(stackDir, "migrate", "prepare-target.sh"), "utf8"),
  readFile(join(stackDir, "migrate", "dump-source.sh"), "utf8"),
  readFile(join(stackDir, "migrate", "setup-realtime.sh"), "utf8"),
  readFile(join(stackDir, "migrate", "source-read-only.sh"), "utf8"),
  readFile(join(stackDir, "migrate", "copy-storage.mjs"), "utf8"),
  readFile(join(stackDir, "migrate", "lib.sh"), "utf8"),
  readFile(join(stackDir, "migrate", "restore-target.sh"), "utf8"),
  readFile(join(stackDir, "migrate", "restore-storage-metadata.sh"), "utf8"),
  readFile(join(stackDir, "migrate", "verify-counts.sh"), "utf8"),
  readFile(join(stackDir, "migrate", "restore-cron-jobs.sh"), "utf8"),
  readFile(join(stackDir, "migrate", "seed-realtime-tenant.sh"), "utf8"),
  readFile(join(stackDir, "migrate", "make-pg-service.mjs"), "utf8"),
  readFile(join(stackDir, "postgres", "pg_hba.conf"), "utf8"),
  readFile(join(stackDir, "RUNBOOK.md"), "utf8"),
]);

// Production enables GitHub, Google and email sign-in (read-only /auth/v1/settings, 2026-09-17). The box GoTrue must
// enable the same providers, and each OAuth callback must be the box's public auth URL.

// Access-log contract: Caddy sources in, missing or reordered redactions out.
// Request secrets and response Locations have separate required inventories.

test("adapted Caddy checker accepts the split pair and rejects host and route gaps", async () => {
  const checker = join(root, "deploy", "edge-runtime", "check-caddy-adapted.mjs");
  const directory = await mkdtemp(join(tmpdir(), "caddy-checker-"));
  try {
    const pair = syntheticLivePair();
    const pairPath = join(directory, "pair.json");
    await writeFile(pairPath, JSON.stringify(pair));
    const checked = spawnSync(
      process.execPath,
      [checker, pairPath, "live", "without-trusted-proxies"],
      { encoding: "utf8" },
    );
    assert.equal(checked.status, 0, checked.stderr);

    const missingHost = structuredClone(pair);
    const missingHostRoutes = adaptedRoutes(missingHost);
    const missingHostIndex = missingHostRoutes.findIndex((route) =>
      testRouteHosts(route).includes("api.commonswarm.com")
    );
    assert.ok(missingHostIndex >= 0);
    missingHostRoutes.splice(missingHostIndex, 1);
    await assertCheckerRejects(
      directory,
      checker,
      missingHost,
      "missing-host.json",
      "live",
      "without-trusted-proxies",
      /site api\.commonswarm\.com exactly once/,
    );

    const duplicateHost = structuredClone(pair);
    const duplicateHostRoutes = adaptedRoutes(duplicateHost);
    const duplicateRoute = duplicateHostRoutes.find((route) =>
      testRouteHosts(route).includes("api.commonswarm.com")
    );
    assert.ok(duplicateRoute);
    duplicateHostRoutes.push(structuredClone(duplicateRoute));
    await assertCheckerRejects(
      directory,
      checker,
      duplicateHost,
      "duplicate-host.json",
      "live",
      "without-trusted-proxies",
      /site api\.commonswarm\.com exactly once/,
    );

    const missingRoute = structuredClone(pair);
    const apiRoute = adaptedRoutes(missingRoute).find((route) =>
      testRouteHosts(route).includes("api.commonswarm.com")
    );
    assert.ok(apiRoute);
    assert.equal(removeProxyDial(apiRoute, "127.0.0.1:9000"), true);
    await assertCheckerRejects(
      directory,
      checker,
      missingRoute,
      "missing-route.json",
      "live",
      "without-trusted-proxies",
      /api\.commonswarm\.com route dials/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("deployment Caddy files adapt and reject Storage CORS scope mutations", async (context) => {
  // CI uses Caddy 2.11 in Docker; a supplied binary runs the same controls locally.
  const caddyBinary = process.env.CADDY_BINARY;
  if (!caddyBinary) {
    const docker = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (docker.status !== 0) {
      context.skip("Docker is absent and CADDY_BINARY is unset");
      return;
    }
  }
  const adapt = (directory: string) => caddyBinary
    ? spawnSync(caddyBinary, ["adapt", "--config", "Caddyfile"], {
      cwd: directory, encoding: "utf8", timeout: 120_000,
      env: { ...process.env, MCP_OAUTH_HOST_PORT: "3490" },
    })
    : spawnSync("docker", [
      "run", "--rm", "-e", "MCP_OAUTH_HOST_PORT=3490", "-v", `${directory}:/srv:ro`, "-w", "/srv",
      "caddy:2.11", "caddy", "adapt", "--config", "/srv/Caddyfile",
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
  const checker = join(root, "deploy", "edge-runtime", "check-caddy-adapted.mjs");
  const fixture = join(root, "deploy", "edge-runtime", "build-caddy-validation-fixture.mjs");
  const profiles = [
    ["live", [
      join(stackDir, "commonswarm-api.caddy"),
      join(stackDir, "commonswarm-edge-staging.caddy"),
    ]],
    ["maintenance", [
      join(stackDir, "commonswarm-api-maintenance.caddy"),
      join(stackDir, "commonswarm-edge-staging-maintenance.caddy"),
    ]],
    ["mcp-oauth", [join(stackDir, "commonswarm-mcp.caddy")]],
  ] as const;
  for (const [profile, sitePaths] of profiles) {
    for (const trustMode of ["without-trusted-proxies", "with-trusted-proxies"] as const) {
      const directory = await mkdtemp(join(tmpdir(), "caddy-adapt-"));
      try {
        const built = spawnSync(process.execPath, [fixture, directory, trustMode, ...sitePaths], { encoding: "utf8" });
        assert.equal(built.status, 0, built.stderr);
        const adapted = adapt(directory);
        assert.equal(adapted.status, 0, `${profile} ${trustMode}: ${adapted.stderr.slice(-500)}`);
        if (profile === "mcp-oauth") continue;
        const jsonPath = join(directory, "adapted.json");
        await writeFile(jsonPath, adapted.stdout);
        const checked = spawnSync(process.execPath, [checker, jsonPath, profile, trustMode], { encoding: "utf8" });
        assert.equal(checked.status, 0, `${profile} ${trustMode}: ${checked.stderr}`);
        if (profile === "live" && trustMode === "without-trusted-proxies") {
          const sitePath = join(directory, "sites", "10-commonswarm-api.caddy");
          const original = await readFile(sitePath, "utf8");
          const sourceControls: Array<[string, string, RegExp]> = [
            ["upload matcher moved to fallback", original
              .replace("handle @signed_upload {", "handle {")
              .replace("# Preserve every other Storage route and method.\n\t\t\thandle {",
                "# Preserve every other Storage route and method.\n\t\t\thandle @signed_upload {"),
              /signed upload before fallback/],
            ["upload Origin expressions removed", original.replace(/^\s*expression `.*Origin.*`\n/gm, ""),
              /signed upload matcher-bound CORS/],
            ["upload path broadened", original.replace("path /storage/v1/object/upload/sign/*", "path /storage/v1/*"),
              /signed upload path and methods/],
          ];
          for (const [name, source, expected] of sourceControls) {
            await context.test(`rejects ${name}`, async () => {
              assert.notEqual(source, original, "control must mutate the source");
              await writeFile(sitePath, source);
              const mutated = adapt(directory);
              assert.equal(mutated.status, 0, mutated.stderr);
              await assertCheckerRejects(directory, checker, JSON.parse(mutated.stdout), "source-control.json",
                profile, trustMode, expected);
            });
          }
          await writeFile(sitePath, original);
          const jsonControls: Array<[string, (site: JsonObject) => void, RegExp]> = [
            ["swapped Storage proxy header policies", (site) => {
              const proxies = jsonObjects(site).filter((value) => value.handler === "reverse_proxy" &&
                (value.upstreams as JsonObject[])?.[0]?.dial === "127.0.0.1:18004");
              assert.equal(proxies.length, 2);
              [proxies[0]!.headers, proxies[1]!.headers] = [proxies[1]!.headers, proxies[0]!.headers];
            }, /signed upload matcher-bound CORS/],
            ["missing Storage proxy", (site) => {
              assert.equal(removeProxyDial(site, "127.0.0.1:18004"), true);
            }, /api\.commonswarm\.com route dials/],
            ["upload methods broadened", (site) => {
              const route = uploadBranch(site);
              (route.match as JsonObject[])[0]!.method = ["OPTIONS", "PUT", "GET"];
            }, /signed upload path and methods/],
            ["preflight request method changed", (site) => {
              for (const value of jsonObjects(site)) {
                if (value.header) (value.header as JsonObject)["Access-Control-Request-Method"] = ["POST"];
              }
            }, /signed upload matcher-bound CORS/],
            ["204 response without preflight matcher", (site) => {
              const route = jsonObjects(site).find((value) =>
                (value.handle as JsonObject[] | undefined)?.some((handler) => handler.status_code === 204));
              assert.ok(route);
              delete route.match;
            }, /signed upload matcher-bound CORS/],
            ["upload prefix stripping removed", (site) => {
              const rewrite = jsonObjects(uploadBranch(site)).find((value) => value.handler === "rewrite");
              assert.ok(rewrite);
              delete rewrite.strip_path_prefix;
            }, /signed upload matcher-bound CORS/],
            ["PUT header without matcher", (site) => {
              const route = jsonObjects(uploadBranch(site)).find((value) =>
                (value.match as JsonObject[] | undefined)?.[0]?.method?.toString() === "PUT");
              assert.ok(route);
              delete route.match;
            }, /signed upload matcher-bound CORS/],
            ["preflight header no longer deferred", (site) => {
              const response = jsonObjects(uploadBranch(site)).find((value) =>
                (value.set as JsonObject | undefined)?.["Access-Control-Max-Age"]);
              assert.ok(response);
              delete response.deferred;
            }, /signed upload matcher-bound CORS/],
            ["extra allowed Origin", (site) => {
              for (const value of jsonObjects(uploadBranch(site))) {
                if (typeof value.expr === "string") value.expr = value.expr.replace("]", ', "https://untrusted.example"]');
              }
            }, /signed upload matcher-bound CORS/],
            ["fallback prefix stripping removed", (site) => {
              const rewrite = jsonObjects(site).filter((value) => value.handler === "rewrite" &&
                value.strip_path_prefix === "/storage/v1").at(-1);
              assert.ok(rewrite);
              delete rewrite.strip_path_prefix;
            }, /fallback Storage prefix and unchanged upstream CORS/],
          ];
          for (const [name, mutate, expected] of jsonControls) {
            await context.test(`rejects ${name}`, async () => {
              const config = JSON.parse(adapted.stdout) as unknown;
              const site = adaptedRoutes(config).find((route) => testRouteHosts(route).includes("api.commonswarm.com"));
              assert.ok(site);
              const before = JSON.stringify(site);
              mutate(site);
              assert.notEqual(JSON.stringify(site), before, "control must mutate adapted JSON");
              await assertCheckerRejects(directory, checker, config, "json-control.json", profile, trustMode, expected);
            });
          }
        }
        if (profile === "maintenance" && trustMode === "without-trusted-proxies") {
          const hostMutation = adapted.stdout.replace("127.0.0.1:9000", "example.supabase.co:443");
          const hostPath = join(directory, "host.json");
          await writeFile(hostPath, hostMutation);
          const hostChecked = spawnSync(process.execPath, [checker, hostPath, profile, trustMode], { encoding: "utf8" });
          assert.notEqual(hostChecked.status, 0);
          assert.match(`${hostChecked.stderr}\n${hostChecked.stdout}`, /supabase\.co host/);
          const stripped = JSON.parse(adapted.stdout) as unknown;
          stripHeader(stripped, "Retry-After");
          const retryPath = join(directory, "retry.json");
          await writeFile(retryPath, JSON.stringify(stripped));
          const retryChecked = spawnSync(process.execPath, [checker, retryPath, profile, trustMode], { encoding: "utf8" });
          assert.notEqual(retryChecked.status, 0);
          assert.match(`${retryChecked.stderr}\n${retryChecked.stdout}`, /maintenance Retry-After/);
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
});

type JsonObject = Record<string, unknown>;

function syntheticLivePair(): JsonObject {
  const hosts = ["api.commonswarm.com", "edge-staging.commonswarm.com"];
  const siteRoute = (host: string): JsonObject => ({
    match: [{ host: [host] }],
    handle: [{
      handler: "subroute",
      routes: [{
        handle: [
          { handler: "reverse_proxy", upstreams: [{ dial: "127.0.0.1:18001" }] },
          { handler: "reverse_proxy", upstreams: [{ dial: "127.0.0.1:18002" }] },
          {
            handler: "reverse_proxy",
            upstreams: [{ dial: "127.0.0.1:18003" }],
            transport: { versions: ["1.1"] },
            flush_interval: -1,
            headers: { request: { set: { Host: ["realtime-dev"] } } },
          },
          {
            handler: "reverse_proxy",
            upstreams: [{ dial: "127.0.0.1:9000" }],
            headers: { request: { set: { "X-Forwarded-For": ["{http.request.client_ip}"] } } },
            transport: { response_header_timeout: 165_000_000_000 },
          },
        ],
      }, syntheticStorageRoute()],
    }],
  });
  const errorRoute = (host: string): JsonObject => ({
    match: [{ host: [host] }],
    handle: [{
      handler: "subroute",
      routes: [{
        match: [{ path: ["/functions/v1", "/functions/v1/*"] }],
        handle: [{
          handler: "headers",
          response: { set: { "Access-Control-Allow-Origin": ["*"] } },
        }],
      }],
    }],
  });
  return {
    apps: {
      http: {
        servers: {
          srv0: {
            routes: hosts.map(siteRoute),
            errors: { routes: hosts.map(errorRoute) },
          },
        },
      },
    },
  };
}

function syntheticStorageRoute(): JsonObject {
  const expression = {
    expr: `{http.request.header.Origin} in ${JSON.stringify(storageUploadOrigins).replaceAll(",", ", ")}`,
  };
  const put = [{ expression: { ...expression, name: "upload_put" }, method: ["PUT"] }];
  const preflight = [{ expression: { ...expression, name: "upload_preflight" },
    header: { "Access-Control-Request-Method": ["PUT"] }, method: ["OPTIONS"] }];
  const rewrite = { handler: "rewrite", strip_path_prefix: "/storage/v1" };
  const proxy = { handler: "reverse_proxy", upstreams: [{ dial: "127.0.0.1:18004" }] };
  return {
    match: [{ path: ["/storage/v1/*"] }],
    handle: [{ handler: "subroute", routes: [{
      handle: [{ handler: "subroute", routes: [
        {
          group: "storage",
          match: [{ path: ["/storage/v1/object/upload/sign/*"], method: ["OPTIONS", "PUT"] }],
          handle: [{ handler: "subroute", routes: [
            { match: put, handle: [{ handler: "headers", response: {
              deferred: true, set: { "Access-Control-Allow-Origin": ["{http.request.header.Origin}"] },
            } }] },
            { match: preflight, handle: [{ handler: "headers", response: {
              deferred: true, set: {
                "Access-Control-Allow-Headers": ["content-type"],
                "Access-Control-Allow-Methods": ["PUT, OPTIONS"],
                "Access-Control-Allow-Origin": ["{http.request.header.Origin}"],
                "Access-Control-Max-Age": ["600"],
              },
            } }] },
            { handle: [{ handler: "headers", response: { deferred: true, set: { Vary: ["Origin"] } } }, rewrite] },
            { match: preflight, handle: [{ handler: "static_response", status_code: 204 }] },
            { handle: [{ ...proxy, headers: { response: { delete: ["Access-Control-*"] } } }] },
          ] }],
        },
        { group: "storage", handle: [{ handler: "subroute", routes: [{ handle: [rewrite, proxy] }] }] },
      ] }],
    }] }],
  };
}

function jsonObjects(value: unknown, out: JsonObject[] = []): JsonObject[] {
  if (!value || typeof value !== "object") return out;
  if (!Array.isArray(value)) out.push(value as JsonObject);
  for (const child of Object.values(value)) jsonObjects(child, out);
  return out;
}

function uploadBranch(site: JsonObject): JsonObject {
  const route = jsonObjects(site).find((value) =>
    (value.match as JsonObject[] | undefined)?.some((matcher) =>
      (matcher.path as string[] | undefined)?.includes("/storage/v1/object/upload/sign/*")));
  assert.ok(route);
  return route;
}

function adaptedRoutes(config: unknown): JsonObject[] {
  const apps = (config as JsonObject).apps as JsonObject;
  const http = apps.http as JsonObject;
  const servers = Object.values(http.servers as JsonObject) as JsonObject[];
  assert.equal(servers.length, 1);
  return servers[0]!.routes as JsonObject[];
}

function testRouteHosts(route: JsonObject): string[] {
  return ((route.match ?? []) as JsonObject[]).flatMap((matcher) =>
    Array.isArray(matcher.host) ? matcher.host as string[] : []
  );
}

function removeProxyDial(value: unknown, dial: string): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    const index = value.findIndex((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return false;
      const record = item as JsonObject;
      const upstreams = record.upstreams as JsonObject[] | undefined;
      return record.handler === "reverse_proxy" && upstreams?.[0]?.dial === dial;
    });
    if (index >= 0) {
      value.splice(index, 1);
      return true;
    }
    return value.some((child) => removeProxyDial(child, dial));
  }
  return Object.values(value as JsonObject).some((child) => removeProxyDial(child, dial));
}

async function assertCheckerRejects(
  directory: string,
  checker: string,
  config: unknown,
  fileName: string,
  profile: "live" | "maintenance",
  trustMode: "with-trusted-proxies" | "without-trusted-proxies",
  expected: RegExp,
): Promise<void> {
  const path = join(directory, fileName);
  await writeFile(path, JSON.stringify(config));
  const checked = spawnSync(process.execPath, [checker, path, profile, trustMode], { encoding: "utf8" });
  assert.notEqual(checked.status, 0, fileName);
  assert.match(`${checked.stderr}\n${checked.stdout}`, expected, fileName);
}

function stripHeader(value: unknown, name: string): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const child of value) stripHeader(child, name);
    return;
  }
  const record = value as Record<string, unknown>;
  delete record[name];
  for (const child of Object.values(record)) stripHeader(child, name);
}

test("run-db-tool passes only validated trailing arguments", async () => {
  const directory = await mkdtemp(join(tmpdir(), "commonswarm-run-db-tool-"));
  try {
    const bin = join(directory, "bin");
    const serviceEnv = join(directory, "service.env");
    const migrationEnv = join(directory, "migration.env");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(bin));
    const password = String.fromCharCode(97, 35, 32, 98, 39, 99, 92, 100);
    await writeFile(serviceEnv, `JWT_SECRET=${Buffer.from("local-jwt").toString("base64url")}\n`, { mode: 0o600 });
    await writeFile(migrationEnv, [
      `SOURCE_DATABASE_URL=postgresql://postgres:${encodeURIComponent(password)}@host.docker.internal:54322/postgres`,
      `TARGET_DATABASE_URL=postgresql://supabase_admin:${encodeURIComponent(password)}@db.commonswarm.internal/postgres`,
      "CUTOVER_CONFIRM=",
      "",
    ].join("\n"), { mode: 0o600 });
    const fakeDocker = join(bin, "docker");
    await writeFile(fakeDocker, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o700 });
    await chmod(fakeDocker, 0o700);
    const script = join(stackDir, "migrate", "run-db-tool.sh");
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      COMMONSWARM_ENV_FILE: serviceEnv,
      COMMONSWARM_MIGRATION_ENV_FILE: migrationEnv,
      CUTOVER_CONFIRM: "caller-only-confirm-value",
    };
    const valid = spawnSync(script, ["source-read-only.sh", directory, "enable", "source"], {
      env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(valid.status, 0, valid.stderr);
    const args = valid.stdout.trim().split("\n");
    assert.deepEqual(args.slice(-3), ["/work/migrate/source-read-only.sh", "enable", "source"]);
    const confirmationAt = args.indexOf("CUTOVER_CONFIRM");
    assert.ok(confirmationAt > 0 && args[confirmationAt - 1] === "--env", "CUTOVER_CONFIRM was not forwarded by name");
    assert.doesNotMatch(valid.stdout, /caller-only-confirm-value/, "CUTOVER_CONFIRM value reached docker argv");
    const invalid = spawnSync(script, ["prepare-target.sh", directory, "extra"], {
      env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(invalid.status, 64);
    const cronSource = spawnSync(script, ["restore-cron-jobs.sh", directory, "source"], {
      env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(cronSource.status, 64, cronSource.stderr);
    const cronTarget = spawnSync(script, ["restore-cron-jobs.sh", directory, "target"], {
      env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(cronTarget.status, 0, cronTarget.stderr);
    assert.deepEqual(cronTarget.stdout.trim().split("\n").slice(-2), ["/work/migrate/restore-cron-jobs.sh", "target"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("make-pg-service refuses an options URL parameter and does not print the URL", async () => {
  const directory = await mkdtemp(join(tmpdir(), "commonswarm-options-url-"));
  const secret = "options-url-secret-must-stay-hidden";
  const optionValue = "-ccommonswarm.stack_identity=n-db-target-v1";
  const runService = async (url: string) => {
    const migrationEnv = join(directory, "migration.env");
    await writeFile(migrationEnv, `TARGET_DATABASE_URL=${url}\n`, { mode: 0o600 });
    return spawnSync(process.execPath, [join(stackDir, "migrate", "make-pg-service.mjs")], {
      env: {
        ...process.env,
        COMMONSWARM_MIGRATION_ENV_FILE: migrationEnv,
        PG_SERVICE_OUTPUT: join(directory, "pg_service.conf"),
        PG_PASS_OUTPUT: join(directory, "pgpass"),
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  };
  try {
    const url = `postgresql://supabase_admin:${encodeURIComponent(secret)}@172.31.0.10/postgres?sslmode=disable&options=${encodeURIComponent(optionValue)}`;
    const result = await runService(url);
    assert.notEqual(result.status, 0, "options URL parameter was accepted");
    assert.match(result.stderr, /\boptions\b/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(secret));
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /postgresql:\/\//);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /172\.31\.0\.10/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /n-db-target-v1/);
    const upper = await runService(url.replace("options=", "Options="));
    assert.notEqual(upper.status, 0, "Options URL parameter was accepted");
    assert.match(upper.stderr, /\boptions\b/);
    assert.doesNotMatch(`${upper.stdout}\n${upper.stderr}`, /n-db-target-v1/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("make-pg-service refuses quoted values without printing the value", async () => {
  const directory = await mkdtemp(join(tmpdir(), "commonswarm-quoted-env-"));
  const secretValue = "quoted-value-must-stay-hidden";
  try {
    const migrationEnv = join(directory, "migration.env");
    await writeFile(migrationEnv, `TARGET_DATABASE_URL="${secretValue}"\n`, { mode: 0o600 });
    const result = spawnSync(process.execPath, [join(stackDir, "migrate", "make-pg-service.mjs")], {
      env: {
        ...process.env,
        COMMONSWARM_MIGRATION_ENV_FILE: migrationEnv,
        PG_SERVICE_OUTPUT: join(directory, "pg_service.conf"),
        PG_PASS_OUTPUT: join(directory, "pgpass"),
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.notEqual(result.status, 0, "quoted environment value was accepted");
    assert.match(result.stderr, /TARGET_DATABASE_URL/);
    assert.doesNotMatch(result.stderr, new RegExp(secretValue));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("database pass file authenticates passwords with spaces and punctuation", async (context) => {
  const docker = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (docker.status !== 0) {
    context.skip("Docker is absent");
    return;
  }

  const id = randomUUID().slice(0, 8);
  const network = `commonswarm-pgpass-${id}`;
  const container = `commonswarm-pgpass-${id}`;
  const directory = await mkdtemp(join(tmpdir(), "commonswarm-pgpass-"));
  const passwordFile = join(directory, "password");
  const serviceFile = join(directory, "pg_service.conf");
  const passFile = join(directory, "pgpass");
  const migrationEnv = join(directory, "migration.env");
  const password = `a# b'c"d\\e:f-${id}`;
  try {
    await writeFile(passwordFile, password, { mode: 0o600 });
    await writeFile(migrationEnv, [
      `TARGET_DATABASE_URL=postgresql://probe_user:${encodeURIComponent(password)}@db.commonswarm.internal/postgres?sslmode=disable`,
      "",
    ].join("\n"), { mode: 0o600 });
    const createdNetwork = spawnSync("docker", ["network", "create", network], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(createdNetwork.status, 0, createdNetwork.stderr);
    const started = spawnSync("docker", [
      "run", "-d", "--name", container, "--network", network,
      "--network-alias", "db.commonswarm.internal",
      "-e", "POSTGRES_USER=probe_user",
      "-e", "POSTGRES_PASSWORD_FILE=/run/secrets/password",
      "-v", `${passwordFile}:/run/secrets/password:ro`,
      "postgres:17.11",
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    assert.equal(started.status, 0, started.stderr);

    let ready = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      // Over TCP: during initdb the image runs a temporary server on the socket only, then restarts it.
      const probe = spawnSync("docker", ["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "probe_user"], {
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      });
      if (probe.status === 0) {
        ready = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.equal(ready, true, "temporary PostgreSQL did not become ready");

    const generated = spawnSync(process.execPath, [join(stackDir, "migrate", "make-pg-service.mjs")], {
      env: {
        ...process.env,
        PG_SERVICE_OUTPUT: serviceFile,
        PG_PASS_OUTPUT: passFile,
        COMMONSWARM_MIGRATION_ENV_FILE: migrationEnv,
        COMMONSWARM_LOCAL_REHEARSAL: "1",
        COMMONSWARM_LOCAL_TARGET_HOSTS: "db.commonswarm.internal",
        COMMONSWARM_LOCAL_TARGET_ADDRESS: "127.0.0.1",
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(generated.status, 0, generated.stderr);

    const authenticated = spawnSync("docker", [
      "run", "--rm", "--network", network,
      "-e", "PGSERVICEFILE=/run/config/pg_service.conf",
      "-e", "PGPASSFILE=/run/config/pgpass",
      "-v", `${directory}:/run/config:ro`,
      "postgres:17.11", "psql", "service=target", "-Atc", "SELECT current_user",
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
    assert.equal(authenticated.status, 0, authenticated.stderr);
    assert.equal(authenticated.stdout.trim(), "probe_user");
  } finally {
    spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" });
    spawnSync("docker", ["network", "rm", network], { stdio: "ignore" });
    await rm(directory, { recursive: true, force: true });
  }
});
