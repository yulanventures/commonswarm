import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();
const stackDir = join(root, "deploy", "supabase-stack");
const [compose, envExample, caddy] = await Promise.all([
  readFile(join(stackDir, "compose.yaml"), "utf8"),
  readFile(join(stackDir, "env.example"), "utf8"),
  readFile(join(stackDir, "commonswarm-api.caddy"), "utf8"),
]);

const memory = {
  postgres: 1536,
  gotrue: 300,
  postgrest: 300,
  realtime: 512,
  "storage-api": 300,
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
  const postgres = serviceBlock(composeSource, "postgres");
  if (/^ {4}ports:/m.test(postgres) || /^ {6}-\s*["']?127\.0\.0\.1:\d+:5432/m.test(postgres)) {
    errors.push("postgres port published");
  }
  if (!/ipv4_address:\s*172\.31\.0\.10/.test(postgres)) errors.push("postgres fixed ip");
  if (!/name:\s*commonswarm-net\n\s+external:\s*true/.test(composeSource)) {
    errors.push("external network");
  }

  const total = Object.values(memory).reduce((sum, value) => sum + value, 0) + 512 + 600;
  if (total > 4096) errors.push("memory over 4 GiB");
  if (!/edge-runtime-external:\s*512m/.test(composeSource)) errors.push("edge memory");
  if (!/reserved-headroom:\s*600m/.test(composeSource)) errors.push("headroom");

  if (/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\./.test(composeSource)) {
    errors.push("JWT-shaped compose value");
  }
  if (/swm_agt_[A-Za-z0-9_-]+/.test(composeSource)) errors.push("agent token in compose");
  if (/^\s+(?:JWT_SECRET|POSTGRES_PASSWORD|API_JWT_SECRET|SERVICE_KEY|AWS_SECRET_ACCESS_KEY):\s*\S+/m.test(composeSource)) {
    errors.push("secret-like compose value");
  }

  const routes: Array<[string, string]> = [
    ["handle_path /auth/v1/*", "reverse_proxy 127.0.0.1:18001"],
    ["handle_path /rest/v1/*", "reverse_proxy 127.0.0.1:18002"],
    ["handle /realtime/v1/websocket*", "reverse_proxy 127.0.0.1:18003"],
    ["handle_path /storage/v1/*", "reverse_proxy 127.0.0.1:18004"],
    ["handle /functions/v1/*", "reverse_proxy 127.0.0.1:9000"],
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
  if (realtimeTransports.length !== 2) {
    errors.push("realtime no-buffer http1");
  }
  for (const line of caddySource.split("\n")) {
    if (line.includes("ukezjcnxjvkpkeezxaew.supabase.co") && !/^\s*#/.test(line)) {
      errors.push("fallback active");
    }
  }
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
      "compose secret",
      compose.replace("    init: true\n    mem_limit: 1536m", "    init: true\n    JWT_SECRET: hardcoded-value\n    mem_limit: 1536m"),
      envExample,
      caddy,
      /secret-like compose value/,
    ],
    ["auth upstream", compose, envExample, caddy.replace("127.0.0.1:18001", "127.0.0.1:18999"), /route handle_path \/auth/],
    [
      "fallback uncommented",
      compose,
      envExample,
      caddy.replace("# \treverse_proxy https://ukezjcnxjvkpkeezxaew.supabase.co", "\treverse_proxy https://ukezjcnxjvkpkeezxaew.supabase.co"),
      /fallback active/,
    ],
    ["realtime buffering", compose, envExample, caddy.replace("\t\t\t\tversions 1.1", "\t\t\t\tversions 2"), /realtime no-buffer http1/],
  ];

  for (const [name, mutatedCompose, mutatedEnv, mutatedCaddy, expected] of mutations) {
    const errors = validateStack(mutatedCompose, mutatedEnv, mutatedCaddy).join("\n");
    assert.match(errors, expected, `${name} mutation was not rejected`);
  }
});
