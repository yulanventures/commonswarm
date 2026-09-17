import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();
const stackDir = join(root, "deploy", "supabase-stack");
const [
  compose,
  envExample,
  migrationEnvExample,
  caddy,
  maintenanceCaddy,
  fallbackCaddy,
  edgeCaddy,
  runtimeRoles,
  prepareTarget,
  dumpSource,
  setupRealtime,
  readOnlyScript,
  copyStorage,
] = await Promise.all([
  readFile(join(stackDir, "compose.yaml"), "utf8"),
  readFile(join(stackDir, "env.example"), "utf8"),
  readFile(join(stackDir, "migration.env.example"), "utf8"),
  readFile(join(stackDir, "commonswarm-api.caddy"), "utf8"),
  readFile(join(stackDir, "commonswarm-api-maintenance.caddy"), "utf8"),
  readFile(join(stackDir, "commonswarm-api-fallback.caddy"), "utf8"),
  readFile(join(root, "deploy", "edge-runtime", "commonswarm.caddy"), "utf8"),
  readFile(join(stackDir, "postgres", "10-runtime-roles.sh"), "utf8"),
  readFile(join(stackDir, "migrate", "prepare-target.sh"), "utf8"),
  readFile(join(stackDir, "migrate", "dump-source.sh"), "utf8"),
  readFile(join(stackDir, "migrate", "setup-realtime.sh"), "utf8"),
  readFile(join(stackDir, "migrate", "source-read-only.sh"), "utf8"),
  readFile(join(stackDir, "migrate", "copy-storage.mjs"), "utf8"),
]);

const memory = {
  postgres: 1536,
  gotrue: 300,
  postgrest: 300,
  realtime: 512,
  "storage-api": 300,
} as const;

const images = {
  postgres: "public.ecr.aws/supabase/postgres:17.6.1.147",
  gotrue: "public.ecr.aws/supabase/gotrue:v2.197.0",
  postgrest: "public.ecr.aws/supabase/postgrest:v14.5",
  realtime: "public.ecr.aws/supabase/realtime:v2.86.3",
  "storage-api": "public.ecr.aws/supabase/storage-api:v1.77.5",
} as const;

function serviceBlock(source: string, name: string): string {
  const marker = `  ${name}:\n`;
  const start = source.indexOf(marker, source.indexOf("services:\n"));
  if (start < 0) return "";
  const rest = source.slice(start + marker.length);
  const next = rest.search(/^  [a-z][a-z0-9-]*:\n/m);
  return next < 0 ? rest : rest.slice(0, next);
}

function requiredEnvNames(source: string): Set<string> {
  const names = new Set<string>();
  for (const match of source.matchAll(/commonswarm\.required-env:\s*>-\n((?: {8}.+\n?)+)/g)) {
    for (const name of match[1]!.match(/[A-Z][A-Z0-9_]+/g) ?? []) names.add(name);
  }
  return names;
}

function envNames(source: string): Set<string> {
  return new Set(
    [...source.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]!),
  );
}

function validateStack(
  composeSource: string,
  envSource: string,
  caddySource: string,
): string[] {
  const errors: string[] = [];
  const declared = envNames(envSource);
  for (const name of requiredEnvNames(composeSource)) {
    if (!declared.has(name)) errors.push(`env missing ${name}`);
  }

  for (const [service, expected] of Object.entries(memory)) {
    const block = serviceBlock(composeSource, service);
    if (!block) {
      errors.push(`service missing ${service}`);
      continue;
    }
    const actual = Number(block.match(/mem_limit:\s*(\d+)m/)?.[1] ?? NaN);
    if (actual !== expected) errors.push(`memory ${service}`);
  }
  for (const [service, expected] of Object.entries(images)) {
    const block = serviceBlock(composeSource, service);
    if (!block.includes(`image: ${expected}`)) errors.push(`image ${service}`);
  }
  const postgres = serviceBlock(composeSource, "postgres");
  if (/^ {4}ports:/m.test(postgres) || /^ {6}-\s*["']?127\.0\.0\.1:\d+:5432/m.test(postgres)) {
    errors.push("postgres port published");
  }
  if (!/ipv4_address:\s*172\.31\.0\.10/.test(postgres)) errors.push("postgres fixed ip");
  if (!/pg_isready -h 172\.31\.0\.10[\s\S]*-d "\$\$\{POSTGRES_DB\}"/.test(postgres)) {
    errors.push("postgres bridge health path");
  }
  if (/PGPASSWORD/.test(postgres)) errors.push("postgres health password");
  if (!/name:\s*commonswarm-net\n\s+external:\s*true/.test(composeSource)) {
    errors.push("external network");
  }

  const total = Object.values(memory).reduce((sum, value) => sum + value, 0) + 512 + 600;
  if (total > 4096) errors.push("memory over 4 GiB");
  if (!/edge-runtime-external:\s*512m/.test(composeSource)) errors.push("edge memory");
  if (!/reserved-headroom:\s*600m/.test(composeSource)) errors.push("headroom");
  if (!/NODE_EXTRA_CA_CERTS/.test(serviceBlock(composeSource, "storage-api"))) {
    errors.push("storage CA trust");
  }
  for (const forbidden of [
    "SOURCE_DATABASE_URL",
    "SOURCE_SERVICE_ROLE_KEY",
    "TARGET_SERVICE_ROLE_KEY",
    "CUTOVER_CONFIRM",
  ]) {
    if (declared.has(forbidden)) errors.push(`service env contains ${forbidden}`);
    if (!envNames(migrationEnvExample).has(forbidden)) errors.push(`migration env missing ${forbidden}`);
    if (composeSource.includes(forbidden) || composeSource.includes("migration.env")) {
      errors.push(`compose receives ${forbidden}`);
    }
  }

  if (/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\./.test(composeSource)) {
    errors.push("JWT-shaped compose value");
  }
  if (/swm_agt_[A-Za-z0-9_-]+/.test(composeSource)) errors.push("agent token in compose");
  if (/^\s+(?:JWT_SECRET|POSTGRES_PASSWORD|API_JWT_SECRET|SERVICE_KEY|AWS_SECRET_ACCESS_KEY):\s*\S+/m.test(composeSource)) {
    errors.push("secret-like compose value");
  }

  const routes: Array<[string, string]> = [
    ["handle /auth/v1/*", "reverse_proxy 127.0.0.1:18001"],
    ["handle /rest/v1/*", "reverse_proxy 127.0.0.1:18002"],
    ["handle @supabase_realtime", "reverse_proxy 127.0.0.1:18003"],
    ["handle /storage/v1/*", "reverse_proxy 127.0.0.1:18004"],
    ["handle @edge_functions", "reverse_proxy 127.0.0.1:9000"],
  ];
  for (const [route, upstream] of routes) {
    const routeAt = caddySource.indexOf(route);
    const upstreamAt = caddySource.indexOf(upstream, routeAt);
    if (routeAt < 0 || upstreamAt < routeAt || upstreamAt > routeAt + 500) {
      errors.push(`route ${route}`);
    }
  }
  const realtimeTransports = caddySource.match(
    /flush_interval -1[\s\S]{0,120}transport http \{[\s\S]{0,80}versions 1\.1/g,
  ) ?? [];
  if (realtimeTransports.length !== 1) {
    errors.push("realtime no-buffer http1");
  }
  if (!caddySource.includes("api.commonswarm.com, edge-staging.commonswarm.com")) errors.push("staging host");
  if (!caddySource.includes("header_up X-Forwarded-For {http.request.client_ip}")) errors.push("client ip");
  if (!caddySource.includes("response_header_timeout 165s")) errors.push("function timeout");
  if (!caddySource.includes('header Access-Control-Allow-Origin "*"')) errors.push("function error CORS");
  return errors;
}

test("self-hosted stack contract is complete", () => {
  assert.deepEqual(validateStack(compose, envExample, caddy), []);
});

test("stack controls reject their named mutations", () => {
  const mutations: Array<[string, string, string, string, RegExp]> = [
    ["missing env", compose, envExample.replace(/^POSTGRES_PASSWORD=\n/m, ""), caddy, /env missing POSTGRES_PASSWORD/],
    [
      "postgres port",
      compose.replace("    restart: unless-stopped\n    init: true", "    restart: unless-stopped\n    ports:\n      - \"127.0.0.1:55432:5432\"\n    init: true"),
      envExample,
      caddy,
      /postgres port published/,
    ],
    ["memory split", compose.replace("    mem_limit: 300m\n    env_file: \*stack-env", "    mem_limit: 700m\n    env_file: *stack-env"), envExample, caddy, /memory gotrue/],
    [
      "production image pin",
      compose.replace("supabase/gotrue:v2.197.0", "supabase/gotrue:v2.196.0"),
      envExample,
      caddy,
      /image gotrue/,
    ],
    [
      "postgres wrong health address",
      compose.replace("pg_isready -h 172.31.0.10", "pg_isready -h 127.0.0.1"),
      envExample,
      caddy,
      /postgres bridge health path/,
    ],
    [
      "compose secret",
      compose.replace("    init: true\n    mem_limit: 1536m", "    init: true\n    JWT_SECRET: hardcoded-value\n    mem_limit: 1536m"),
      envExample,
      caddy,
      /secret-like compose value/,
    ],
    ["auth upstream", compose, envExample, caddy.replace("127.0.0.1:18001", "127.0.0.1:18999"), /route handle \/auth/],
    [
      "function timeout",
      compose, envExample,
      caddy.replace("response_header_timeout 165s", "response_header_timeout 65s"),
      /function timeout/,
    ],
    [
      "storage CA",
      compose.replace("        NODE_EXTRA_CA_CERTS\n", ""),
      envExample,
      caddy,
      /storage CA trust/,
    ],
    ["realtime buffering", compose, envExample, caddy.replace("\t\t\t\tversions 1.1", "\t\t\t\tversions 2"), /realtime no-buffer http1/],
  ];

  for (const [name, mutatedCompose, mutatedEnv, mutatedCaddy, expected] of mutations) {
    const errors = validateStack(mutatedCompose, mutatedEnv, mutatedCaddy).join("\n");
    assert.match(errors, expected, `${name} mutation was not rejected`);
  }
});

function sharedCaddyDirectives(source: string): string[] {
  const patterns = new Set([
    "api.commonswarm.com, edge-staging.commonswarm.com {",
    "@edge_functions path /functions/v1 /functions/v1/*",
    "handle @edge_functions {",
    "header_up X-Forwarded-For {http.request.client_ip}",
    "response_header_timeout 165s",
    "handle_errors {",
    "@edge_function_error path /functions/v1 /functions/v1/*",
    'header Access-Control-Allow-Origin "*"',
    "handle /auth/v1/* {",
    "handle /rest/v1/* {",
    "handle /storage/v1/* {",
    "@supabase_realtime path /realtime/v1 /realtime/v1/*",
    "handle @supabase_realtime {",
    "handle {",
  ]);
  const site = source.slice(source.indexOf("api.commonswarm.com, edge-staging.commonswarm.com {"));
  return site.split("\n").map((line) => line.trim()).filter((line) => patterns.has(line));
}

test("post-N-db and fallback Caddy files keep the landed N-edge frame", () => {
  assert.deepEqual(sharedCaddyDirectives(caddy), sharedCaddyDirectives(edgeCaddy));
  assert.equal(fallbackCaddy, edgeCaddy);
  assert.match(maintenanceCaddy, /@maintenance_write method POST PUT PATCH DELETE/);
  assert.match(maintenanceCaddy, /@maintenance_auth path \/auth\/v1\/\*/);
  assert.match(maintenanceCaddy, /Retry-After "300"/);
  assert.match(maintenanceCaddy, /Access-Control-Allow-Origin "\*"/);
  assert.match(maintenanceCaddy, /\\"error\\":\\"maintenance\\"/);
  // During the window the public host is served from the frozen Supabase origin, never from the box services that are
  // still being restored; only the staging host reaches the box, for the decision-point checklist.
  const publicSite = maintenanceCaddy.slice(maintenanceCaddy.indexOf("\napi.commonswarm.com {"), maintenanceCaddy.indexOf("\nedge-staging.commonswarm.com {"));
  const stagingSite = maintenanceCaddy.slice(maintenanceCaddy.indexOf("\nedge-staging.commonswarm.com {"));
  assert.ok(publicSite.length > 0 && stagingSite.length > 0, "maintenance file must define the public and staging sites separately");
  assert.doesNotMatch(publicSite, /127\.0\.0\.1:(9000|1800[1-4])|import box_routes/);
  assert.match(publicSite, /import supabase_origin/);
  assert.match(publicSite, /import supabase_realtime_origin/);
  assert.match(stagingSite, /import box_routes/);
});

test("all three Caddy alternatives adapt with Caddy 2.11", (context) => {
  const docker = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (docker.status !== 0) {
    context.skip("Docker is absent");
    return;
  }
  for (const name of [
    "commonswarm-api.caddy",
    "commonswarm-api-maintenance.caddy",
    "commonswarm-api-fallback.caddy",
  ]) {
    const path = join(stackDir, name);
    const adapted = spawnSync("docker", [
      "run", "--rm", "-v", `${path}:/etc/caddy/Caddyfile:ro`,
      "caddy:2.11", "caddy", "adapt", "--config", "/etc/caddy/Caddyfile",
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
    assert.equal(adapted.status, 0, `${name}: ${adapted.stderr.slice(-500)}`);
  }
});

function migrationErrors(values: {
  roles: string;
  prepare: string;
  dump: string;
  setup: string;
  freeze: string;
  copy: string;
}): string[] {
  const errors: string[] = [];
  if (!/CREATE ROLE backup_ro[\s\S]*\sBYPASSRLS(?:;|\s)/.test(values.roles) ||
      !/ALTER ROLE backup_ro\s+BYPASSRLS/.test(values.prepare)) errors.push("backup BYPASSRLS");
  if (!values.dump.includes("pg_export_snapshot") || !values.dump.includes("--snapshot \"$snapshot\"")) {
    errors.push("one dump snapshot");
  }
  if (!values.setup.includes("GET DIAGNOSTICS affected = ROW_COUNT") || !values.setup.includes("affected <> 1")) {
    errors.push("Realtime update count");
  }
  if (!values.freeze.includes("commonswarm_cutover_write_freeze") || !values.freeze.includes("UNDO:")) {
    errors.push("freeze trigger or undo");
  }
  if (/process\.env\.(?:SOURCE|TARGET)_SERVICE_ROLE_KEY/.test(values.copy)) {
    errors.push("storage key in process env");
  }
  if (!values.prepare.includes("assert_target_identity") || !values.setup.includes("assert_target_identity")) {
    errors.push("target identity guard");
  }
  if (!values.prepare.includes("CREATE EXTENSION IF NOT EXISTS pg_net") ||
      !values.prepare.includes("CREATE EXTENSION IF NOT EXISTS pg_graphql")) {
    errors.push("required source extensions");
  }
  return errors;
}

test("migration safety contracts are present", () => {
  assert.deepEqual(migrationErrors({
    roles: runtimeRoles,
    prepare: prepareTarget,
    dump: dumpSource,
    setup: setupRealtime,
    freeze: readOnlyScript,
    copy: copyStorage,
  }), []);
});

test("migration safety controls reject their named mutations", () => {
  const original = {
    roles: runtimeRoles,
    prepare: prepareTarget,
    dump: dumpSource,
    setup: setupRealtime,
    freeze: readOnlyScript,
    copy: copyStorage,
  };
  const mutations: Array<[string, typeof original, RegExp]> = [
    ["backup RLS", { ...original, roles: runtimeRoles.replaceAll("BYPASSRLS", "NOBYPASSRLS") }, /backup BYPASSRLS/],
    ["snapshot", { ...original, dump: dumpSource.replace("--snapshot \"$snapshot\"", "") }, /one dump snapshot/],
    ["Realtime update", { ...original, setup: setupRealtime.replace("affected <> 1", "affected < 0") }, /Realtime update count/],
    ["freeze trigger", { ...original, freeze: readOnlyScript.replaceAll("commonswarm_cutover_write_freeze", "removed_freeze") }, /freeze trigger or undo/],
    ["target identity", { ...original, prepare: prepareTarget.replace("assert_target_identity", "true") }, /target identity guard/],
    ["storage key environment", { ...original, copy: `${copyStorage}\nprocess.env.SOURCE_SERVICE_ROLE_KEY` }, /storage key in process env/],
    ["source extensions", { ...original, prepare: prepareTarget.replace("CREATE EXTENSION IF NOT EXISTS pg_net", "SELECT") }, /required source extensions/],
  ];
  for (const [name, mutation, expected] of mutations) {
    assert.match(migrationErrors(mutation).join("\n"), expected, `${name} mutation was not rejected`);
  }
});

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
      "CUTOVER_CONFIRM=COMMONSWARM_N_DB_WINDOW",
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
    };
    const valid = spawnSync(script, ["source-read-only.sh", directory, "enable", "source"], {
      env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(valid.status, 0, valid.stderr);
    const args = valid.stdout.trim().split("\n");
    assert.deepEqual(args.slice(-3), ["/work/migrate/source-read-only.sh", "enable", "source"]);
    const invalid = spawnSync(script, ["prepare-target.sh", directory, "extra"], {
      env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(invalid.status, 64);
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
