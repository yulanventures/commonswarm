import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  FUNCTION_ENV_NAMES,
  FUNCTION_NAMES,
  functionNotFoundResponse,
  FUNCTIONS_BASE_PATH,
  gatewayPreflight,
  isFunctionsBasePath,
  isFunctionsGatewayPath,
  isWorkerLimitError,
  KONG_FUNCTION_NOT_FOUND_BODY,
  KONG_NO_ROUTE_BODY,
  KONG_PREFLIGHT_METHODS,
  mainEnvironmentProblems,
  mainJsonResponse,
  REQUIRED_MAIN_ENV,
  resolveFunctionRoute,
  resolveGatewayRequest,
  rewriteFunctionRequest,
  SELF_SERVE_ENV_REASON,
  WORKER_LIMIT_BODY,
  WORKER_LIMIT_STATUS,
  withWorkerRetiredRetry,
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
  const sourceFiles = (await filesBelow(directory)).filter((path) =>
    path.endsWith(".ts")
  );
  const used = new Set<string>();
  const envPattern = /Deno\.env\.get\(\s*["']([A-Z0-9_]+)["']\s*\)/g;
  for (const file of sourceFiles) {
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(envPattern)) used.add(match[1]!);
  }
  return used;
}

test("edge runtime env example lists every function environment name", async () => {
  const used = await denoEnvironmentNames(
    resolve(repoRoot, "supabase/functions"),
  );

  const example = await readFile(
    resolve(repoRoot, "deploy/edge-runtime/env.example"),
    "utf8",
  );
  const listed = new Set(
    [...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((match) =>
      match[1]!
    ),
  );
  assert.deepEqual([...listed].sort(), [...used].sort());
});

test("H0 source reads only environment names passed to its worker", async () => {
  const used = await denoEnvironmentNames(
    resolve(repoRoot, "supabase/functions/h0"),
  );
  const passed = new Set(FUNCTION_ENV_NAMES.h0);
  const missing = [...used].filter((name) => !passed.has(name)).sort();
  assert.deepEqual(missing, []);
});

test("every database worker receives the optional private CA", () => {
  for (const functionName of ["command", "read", "capability", "activity"] as const) {
    assert.ok(
      FUNCTION_ENV_NAMES[functionName].includes("SWARM_DATABASE_TLS_CA_B64"),
      `${functionName} does not receive SWARM_DATABASE_TLS_CA_B64`,
    );
  }
  assert.equal(FUNCTION_ENV_NAMES.h0.includes("SWARM_DATABASE_TLS_CA_B64"), false);
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
    assert.deepEqual(
      resolveFunctionRoute(`/functions/v1/${functionName}/deep/path`),
      {
        functionName,
        pathname: `/${functionName}/deep/path`,
      },
    );
    assert.deepEqual(resolveFunctionRoute(`/functions/v1/${functionName}/`), {
      functionName,
      pathname: `/${functionName}/`,
    });
  }
  assert.equal(resolveFunctionRoute("/functions/v1/unknown"), null);
  assert.equal(resolveFunctionRoute("/functions/v1/command-extra"), null);
  assert.equal(resolveFunctionRoute("/command"), null);
  assert.equal(resolveFunctionRoute("/functions/v1"), null);
  assert.equal(FUNCTIONS_BASE_PATH, "/functions/v1");
  assert.equal(isFunctionsBasePath("/functions/v1"), true);
  assert.equal(isFunctionsBasePath("/functions/v1/"), false);
  assert.equal(isFunctionsGatewayPath("/functions/v1/command"), true);
  assert.equal(isFunctionsGatewayPath("/functions/v1/not-a-function"), true);
  assert.equal(isFunctionsGatewayPath("/functions/v1"), false);
  assert.deepEqual(KONG_NO_ROUTE_BODY, {
    message: "no Route matched with those values",
  });
});

test("edge runtime request rewrite preserves query, method, headers, and body", async () => {
  const original = new Request(
    "https://edge.test/functions/v1/command/deep/path?cursor=one%2Ftwo&limit=3",
    {
      method: "POST",
      headers: {
        authorization: "Bearer test-only-placeholder",
        apikey: "test-only-placeholder",
        "content-type": "application/json",
        "x-client-info": "router-test",
      },
      body: '{"test":true}',
    },
  );
  const route = resolveFunctionRoute(new URL(original.url).pathname);
  assert.deepEqual(route, {
    functionName: "command",
    pathname: "/command/deep/path",
  });
  const rewritten = rewriteFunctionRequest(original, route.pathname);
  const url = new URL(rewritten.url);
  assert.equal(url.pathname, "/command/deep/path");
  assert.equal(url.search, "?cursor=one%2Ftwo&limit=3");
  assert.equal(rewritten.method, "POST");
  assert.equal(
    rewritten.headers.get("authorization"),
    "Bearer test-only-placeholder",
  );
  assert.equal(rewritten.headers.get("apikey"), "test-only-placeholder");
  assert.equal(rewritten.headers.get("x-client-info"), "router-test");
  assert.equal(await rewritten.text(), '{"test":true}');
});

test("edge runtime matches Kong preflight and unknown-function responses", async () => {
  const preflightRequest = new Request(
    "https://edge.test/functions/v1/command?kept=yes",
    {
      method: "OPTIONS",
      headers: {
        "access-control-request-headers":
          "authorization,x-client-info,apikey,content-type",
      },
    },
  );
  const directPreflight = gatewayPreflight(preflightRequest);
  const preflightResolution = resolveGatewayRequest(preflightRequest);
  assert.equal(preflightResolution.route, null);
  assert.ok(preflightResolution.response);
  const preflight = preflightResolution.response;
  assert.equal(preflight.status, 200);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
  assert.equal(
    preflight.headers.get("access-control-allow-headers"),
    "authorization,x-client-info,apikey,content-type",
  );
  assert.equal(
    preflight.headers.get("access-control-allow-methods"),
    "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS,TRACE,CONNECT",
  );
  assert.equal(
    KONG_PREFLIGHT_METHODS,
    "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS,TRACE,CONNECT",
  );
  assert.equal(await preflight.text(), "");
  assert.equal(directPreflight.status, 200);

  const unknownResolution = resolveGatewayRequest(
    new Request(
      "https://edge.test/functions/v1/not-a-function",
      { method: "OPTIONS" },
    ),
  );
  assert.equal(unknownResolution.route, null);
  assert.ok(unknownResolution.response);
  const unknown = unknownResolution.response;
  assert.equal(unknown.status, 404);
  assert.equal(
    unknown.headers.get("content-type"),
    "text/plain; charset=UTF-8",
  );
  assert.equal(unknown.headers.get("access-control-allow-origin"), "*");
  assert.equal(await unknown.text(), KONG_FUNCTION_NOT_FOUND_BODY);

  const directUnknown = functionNotFoundResponse();
  assert.equal(directUnknown.status, 404);
  assert.equal(directUnknown.headers.get("access-control-allow-origin"), "*");

  const bare = resolveGatewayRequest(
    new Request("https://edge.test/functions/v1"),
  );
  assert.equal(bare.route, null);
  assert.ok(bare.response);
  assert.equal(bare.response.status, 404);
  assert.equal(bare.response.headers.get("access-control-allow-origin"), "*");
  assert.deepEqual(await bare.response.json(), KONG_NO_ROUTE_BODY);

  for (
    const [status, body] of [
      [WORKER_LIMIT_STATUS, WORKER_LIMIT_BODY],
      [500, { error: "internal_error" }],
    ] as const
  ) {
    const response = mainJsonResponse(status, body);
    assert.equal(response.status, status);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.deepEqual(await response.json(), body);
  }
});

test("edge runtime requires the production feature gate at boot", () => {
  assert.deepEqual(REQUIRED_MAIN_ENV, [
    "SUPABASE_URL",
    "SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SWARM_SELF_SERVE",
  ]);

  const environment = new Map<string, string>([
    ["SUPABASE_URL", "local-test-url"],
    ["SUPABASE_ANON_KEY", "local-test-anon"],
    ["SUPABASE_SERVICE_ROLE_KEY", "local-test-service-role"],
    ["SUPABASE_DB_URL", "local-test-database"],
    ["SWARM_SELF_SERVE", "1"],
  ]);
  const get = (name: string) => environment.get(name);
  assert.deepEqual(mainEnvironmentProblems(get), []);

  for (const invalid of ["", "0", "true", " 1"]) {
    environment.set("SWARM_SELF_SERVE", invalid);
    assert.deepEqual(mainEnvironmentProblems(get), [SELF_SERVE_ENV_REASON]);
  }

  environment.delete("SWARM_SELF_SERVE");
  assert.deepEqual(mainEnvironmentProblems(get), [SELF_SERVE_ENV_REASON]);
});

test("edge runtime retries retired create or fetch once and maps pool limits", async () => {
  let attempts = 0;
  const worker = await withWorkerRetiredRetry(async () => {
    attempts += 1;
    if (attempts === 1) {
      const error = new Error("presentation text is irrelevant");
      error.name = "WorkerAlreadyRetired";
      throw error;
    }
    return { id: "worker" };
  });
  assert.deepEqual(worker, { id: "worker" });
  assert.equal(attempts, 2);

  attempts = 0;
  await assert.rejects(
    withWorkerRetiredRetry(async () => {
      attempts += 1;
      const error = new Error("presentation text is irrelevant");
      error.name = "WorkerAlreadyRetired";
      throw error;
    }),
    { name: "WorkerAlreadyRetired" },
  );
  assert.equal(attempts, 2);

  const original = new Request("https://edge.test/functions/v1/command", {
    method: "POST",
    body: '{"retry":"body"}',
  });
  const retryRequests = [original, original.clone()] as const;
  let fetchAttempts = 0;
  const response = await withWorkerRetiredRetry(async (attemptNumber) => {
    const body = await retryRequests[attemptNumber].text();
    fetchAttempts += 1;
    if (fetchAttempts === 1) {
      const error = new Error("presentation text is irrelevant");
      error.name = "WorkerAlreadyRetired";
      throw error;
    }
    return new Response(body);
  });
  assert.equal(fetchAttempts, 2);
  assert.equal(await response.text(), '{"retry":"body"}');

  for (
    const name of [
      "InvalidWorkerCreation",
      "WorkerRequestIdleTimeout",
      "WorkerRequestCancelled",
    ]
  ) {
    const error = new Error("presentation text is irrelevant");
    error.name = name;
    assert.equal(isWorkerLimitError(error), true);
  }
  assert.equal(
    isWorkerLimitError(new Error("WorkerRequestIdleTimeout")),
    false,
  );
  assert.equal(WORKER_LIMIT_STATUS, 504);
  assert.deepEqual(WORKER_LIMIT_BODY, {
    code: "WORKER_LIMIT",
    message:
      "Worker failed to respond due to a resource limit (please check logs)",
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
  assert.match(compose, /COMMONSWARM_EDGE_NETWORK_MODE:-bridge/);
  assert.match(compose, /COMMONSWARM_EDGE_DB_ADDRESS:-172\.31\.0\.10/);
  assert.match(
    compose,
    /env_file:[\s\S]*?path: \$\{COMMONSWARM_EDGE_ENV_FILE:-\/home\/commonswarm\/\.env\}/,
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

  const parallelism = Number(
    compose.match(/- --max-parallelism\s*\n\s*- "(\d+)"/)?.[1],
  );
  const readTimeout = Number(
    compose.match(/- --request-read-timeout\s*\n\s*- "(\d+)"/)?.[1],
  );
  const workerIdleTimeout = Number(
    compose.match(/- --user-worker-request-idle-timeout\s*\n\s*- "(\d+)"/)?.[1],
  );
  const gracefulExitTimeout = Number(
    compose.match(/- --graceful-exit-timeout\s*\n\s*- "(\d+)"/)?.[1],
  );
  const stopGracePeriod = Number(
    compose.match(/stop_grace_period:\s*(\d+)s/)?.[1],
  );
  const containerMemory = Number(compose.match(/mem_limit:\s*(\d+)m/)?.[1]);
  const workerMemory = Number(
    main.match(/USER_WORKER_MEMORY_MB\s*=\s*(\d+)/)?.[1],
  );

  assert.equal(containerMemory, 512);
  assert.equal(parallelism, 4);
  assert.equal(workerMemory, 96);
  assert.equal(parallelism * workerMemory, 384);
  assert.ok(parallelism * workerMemory <= containerMemory);
  assert.equal(readTimeout, 60_000);
  assert.equal(workerIdleTimeout, 150_000);
  assert.equal(gracefulExitTimeout, 70);
  assert.equal(stopGracePeriod, 80);
  assert.ok(stopGracePeriod > gracefulExitTimeout);
  assert.match(command, /const MAX_BODY_BYTES = 128 \* 1024;/);
});

test("main service retries WorkerAlreadyRetired around create and fetch", async () => {
  const main = await readFile(
    resolve(repoRoot, "deploy/edge-runtime/main/index.ts"),
    "utf8",
  );
  assert.match(main, /const attemptRequests = \[request, request\.clone\(\)\]/);
  const retryStart = main.indexOf(
    "return await withWorkerRetiredRetry(async (attemptNumber) => {",
  );
  assert.notEqual(retryStart, -1);
  const fetchInsideRetry = main.indexOf(
    "return await worker.fetch(forwarded);",
    retryStart,
  );
  assert.ok(fetchInsideRetry > retryStart);
  assert.ok(
    main.indexOf("EdgeRuntime.userWorkers.create", retryStart) <
      fetchInsideRetry,
  );
  assert.ok(
    main.slice(fetchInsideRetry).startsWith(
      "return await worker.fetch(forwarded);\n  });",
    ),
  );
});

test("Caddy keeps function parity and uses an HTTP/1.1 realtime upstream", async () => {
  const live = await readFile(
    resolve(repoRoot, "deploy/supabase-stack/commonswarm-api.caddy"),
    "utf8",
  );
  const maintenance = await readFile(
    resolve(repoRoot, "deploy/supabase-stack/commonswarm-api-maintenance.caddy"),
    "utf8",
  );
  const globalServers = await readFile(
    resolve(repoRoot, "deploy/edge-runtime/caddy-global-servers.caddy"),
    "utf8",
  );
  const boxRoutes = maintenance.slice(
    maintenance.indexOf("(box_routes) {"),
    maintenance.indexOf("\napi.commonswarm.com {"),
  );
  const publicSite = maintenance.slice(
    maintenance.indexOf("\napi.commonswarm.com {"),
    maintenance.indexOf("\nedge-staging.commonswarm.com {"),
  );

  for (const source of [live, boxRoutes]) {
    assert.match(source, /@edge_functions path \/functions\/v1 \/functions\/v1\/\*/);
    assert.match(source, /response_header_timeout 165s/);
    assert.match(
      source,
      /handle_errors \{[\s\S]*?@edge_function_error path \/functions\/v1 \/functions\/v1\/\*[\s\S]*?header Access-Control-Allow-Origin "\*"/,
    );
    assert.match(
      source,
      /@supabase_realtime path \/realtime\/v1 \/realtime\/v1\/\*[\s\S]*?flush_interval -1[\s\S]*?versions 1\.1/,
    );
    assert.equal(
      (source.match(/header_up X-Forwarded-For \{http\.request\.client_ip\}/g) ?? []).length,
      1,
    );
    assert.doesNotMatch(source, /supabase\.co\b/i);
  }

  assert.ok(publicSite.length > 0 && boxRoutes.length > 0);
  assert.doesNotMatch(publicSite, /reverse_proxy/);
  assert.doesNotMatch(publicSite, /\bimport\b/);
  assert.match(publicSite, /@maintenance_preflight method OPTIONS/);
  assert.match(publicSite, /Access-Control-Allow-Headers "authorization, apikey, content-type, x-client-info"/);
  assert.match(publicSite, /Access-Control-Allow-Methods "GET, HEAD, OPTIONS, POST, PUT, PATCH, DELETE"/);
  assert.match(publicSite, /Access-Control-Max-Age "300"/);
  assert.match(publicSite, /Retry-After "300"/);
  assert.match(publicSite, /Access-Control-Allow-Origin "\*"/);
  assert.match(publicSite, /\\"error\\":\\"maintenance\\"/);
  assert.match(
    maintenance.slice(maintenance.indexOf("\nedge-staging.commonswarm.com {")),
    /import box_routes/,
  );
  assert.doesNotMatch(maintenance, /supabase\.co\b/i);
  assert.match(
    globalServers,
    /trusted_proxies static 173\.245\.48\.0\/20[\s\S]*?2c0f:f248::\/32/,
  );
  assert.match(globalServers, /trusted_proxies_strict/);
  assert.match(
    globalServers,
    /client_ip_headers CF-Connecting-IP X-Forwarded-For/,
  );
  assert.match(
    live,
    /handle \/auth\/v1\/\* \{\s*uri strip_prefix \/auth\/v1\s*reverse_proxy 127\.0\.0\.1:18001/,
  );
  assert.match(
    live,
    /handle \/rest\/v1\/\* \{\s*uri strip_prefix \/rest\/v1\s*reverse_proxy 127\.0\.0\.1:18002/,
  );
  assert.match(
    live,
    /handle \/storage\/v1\/\* \{\s*uri strip_prefix \/storage\/v1\s*reverse_proxy 127\.0\.0\.1:18004/,
  );
  assert.match(
    live,
    /reverse_proxy 127\.0\.0\.1:18003 \{\s*header_up Host realtime-dev\s*header_up X-Forwarded-Host \{host\}\s*flush_interval -1\s*transport http \{\s*versions 1\.1/,
  );
});

test("Caddy site import cannot contain a global options block", async () => {
  const live = await readFile(
    resolve(repoRoot, "deploy/supabase-stack/commonswarm-api.caddy"),
    "utf8",
  );
  const maintenance = await readFile(
    resolve(repoRoot, "deploy/supabase-stack/commonswarm-api-maintenance.caddy"),
    "utf8",
  );
  const globalServers = await readFile(
    resolve(repoRoot, "deploy/edge-runtime/caddy-global-servers.caddy"),
    "utf8",
  );

  assert.doesNotMatch(live, /^\s*\{\s*$/m);
  assert.doesNotMatch(maintenance, /^\s*\{\s*$/m);
  assert.match(
    globalServers,
    /^# Reference for the lines INSIDE the box main Caddyfile's global options/m,
  );
  assert.match(globalServers, /^servers \{/m);
  assert.doesNotMatch(globalServers, /^\s*\{\s*$/m);
});
