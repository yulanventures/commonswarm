import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  FUNCTIONS_BASE_PATH,
  FUNCTION_ENV_NAMES,
  FUNCTION_NAMES,
  KONG_NO_ROUTE_BODY,
  isFunctionsBasePath,
  resolveFunctionRoute,
} from "../../deploy/edge-runtime/main/router.js";

const repoRoot = process.cwd();

async function filesBelow(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  }));
  return nested.flat();
}

async function denoEnvironmentNames(directory: string): Promise<Set<string>> {
  const sourceFiles = (await filesBelow(directory)).filter((path) => path.endsWith(".ts"));
  const used = new Set<string>();
  const envPattern = /Deno\.env\.get\(\s*["']([A-Z0-9_]+)["']\s*\)/g;
  for (const file of sourceFiles) {
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(envPattern)) used.add(match[1]!);
  }
  return used;
}

test("edge runtime env example lists every function environment name", async () => {
  const used = await denoEnvironmentNames(resolve(repoRoot, "supabase/functions"));

  const example = await readFile(
    resolve(repoRoot, "deploy/edge-runtime/env.example"),
    "utf8",
  );
  const listed = new Set(
    [...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]!),
  );
  assert.deepEqual([...listed].sort(), [...used].sort());
});

test("H0 source reads only environment names passed to its worker", async () => {
  const used = await denoEnvironmentNames(resolve(repoRoot, "supabase/functions/h0"));
  const passed = new Set(FUNCTION_ENV_NAMES.h0);
  const missing = [...used].filter((name) => !passed.has(name)).sort();
  assert.deepEqual(missing, []);
});

test("edge runtime router strips only /functions/v1 and maps all five functions", () => {
  assert.deepEqual(FUNCTION_NAMES, [
    "command",
    "read",
    "capability",
    "activity",
    "h0",
  ]);
  for (const functionName of FUNCTION_NAMES) {
    assert.deepEqual(resolveFunctionRoute(`/functions/v1/${functionName}`), {
      functionName,
      pathname: `/${functionName}`,
    });
    assert.deepEqual(resolveFunctionRoute(`/functions/v1/${functionName}/deep/path`), {
      functionName,
      pathname: `/${functionName}/deep/path`,
    });
  }
  assert.equal(resolveFunctionRoute("/functions/v1/unknown"), null);
  assert.equal(resolveFunctionRoute("/functions/v1/command-extra"), null);
  assert.equal(resolveFunctionRoute("/command"), null);
  assert.equal(resolveFunctionRoute("/functions/v1"), null);
  assert.equal(FUNCTIONS_BASE_PATH, "/functions/v1");
  assert.equal(isFunctionsBasePath("/functions/v1"), true);
  assert.equal(isFunctionsBasePath("/functions/v1/"), false);
  assert.deepEqual(KONG_NO_ROUTE_BODY, {
    message: "no Route matched with those values",
  });
});

test("edge runtime Compose binds only loopback and contains no secret value", async () => {
  const compose = await readFile(
    resolve(repoRoot, "deploy/edge-runtime/compose.yaml"),
    "utf8",
  );
  const published = [...compose.matchAll(/^\s*-\s*["']([^"']*:\d+)["']\s*$/gm)]
    .map((match) => match[1]!)
    .filter((value) => /:\d+:\d+$/.test(value));
  assert.deepEqual(published, ["127.0.0.1:9000:9000"]);
  assert.doesNotMatch(compose, /(?:0\.0\.0\.0|\[::\]):9000:9000/);
  assert.match(
    compose,
    /env_file:[\s\S]*?path: \/home\/commonswarm\/\.env/,
  );

  const secretShapes = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/,
    /\b(?:sbp_|sb_secret_|swm_agt_)[A-Za-z0-9_-]{12,}/,
    /postgres(?:ql)?:\/\/[^\s:@]+:[^\s@]+@/,
    /^\s*(?:password|secret|token|api[_-]?key)\s*:\s*\S+/im,
  ];
  for (const shape of secretShapes) assert.doesNotMatch(compose, shape);
});

test("edge runtime memory and request limits fit the box budget", async () => {
  const compose = await readFile(
    resolve(repoRoot, "deploy/edge-runtime/compose.yaml"),
    "utf8",
  );
  const main = await readFile(
    resolve(repoRoot, "deploy/edge-runtime/main/index.ts"),
    "utf8",
  );
  const command = await readFile(
    resolve(repoRoot, "supabase/functions/command/index.ts"),
    "utf8",
  );

  const parallelism = Number(compose.match(/- --max-parallelism\s*\n\s*- "(\d+)"/)?.[1]);
  const readTimeout = Number(
    compose.match(/- --request-read-timeout\s*\n\s*- "(\d+)"/)?.[1],
  );
  const containerMemory = Number(compose.match(/mem_limit:\s*(\d+)m/)?.[1]);
  const workerMemory = Number(main.match(/USER_WORKER_MEMORY_MB\s*=\s*(\d+)/)?.[1]);

  assert.equal(containerMemory, 512);
  assert.equal(parallelism, 4);
  assert.equal(workerMemory, 96);
  assert.equal(parallelism * workerMemory, 384);
  assert.ok(parallelism * workerMemory <= containerMemory);
  assert.equal(readTimeout, 60_000);
  assert.match(command, /const MAX_BODY_BYTES = 128 \* 1024;/);
});

test("Caddy keeps function parity and uses an HTTP/1.1 realtime upstream", async () => {
  const caddy = await readFile(
    resolve(repoRoot, "deploy/edge-runtime/commonswarm.caddy"),
    "utf8",
  );
  assert.match(caddy, /@edge_functions path \/functions\/v1 \/functions\/v1\/\*/);
  assert.match(caddy, /response_header_timeout 165s/);
  assert.match(caddy, /\(supabase_realtime_origin\)[\s\S]*?flush_interval -1/);
  assert.match(caddy, /\(supabase_realtime_origin\)[\s\S]*?versions 1\.1/);
  assert.match(
    caddy,
    /handle \/realtime\/v1\/\* \{\s*import supabase_realtime_origin\s*\}/,
  );
});
