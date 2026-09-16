import {
  COMMAND_TEST_HOOKS,
  FUNCTION_ENV_NAMES,
  resolveFunctionRoute,
  type FunctionName,
} from "./router.ts";

declare const EdgeRuntime: {
  applySupabaseTag(original: Request, cloned: Request): void;
  userWorkers: {
    create(options: {
      servicePath: string;
      memoryLimitMb: number;
      workerTimeoutMs: number;
      noModuleCache: boolean;
      envVars: Array<[string, string]>;
    }): Promise<{ fetch(request: Request): Promise<Response> }>;
  };
};

const FUNCTIONS_ROOT = "/var/tmp/commonswarm-functions";

// Supabase's hosted limit is the reference. It also prevents one function from
// consuming the box. Each user worker gets at most 256 MiB.
const USER_WORKER_MEMORY_MB = 256;

// The hosted free-plan wall-clock limit is 150 seconds. This is long enough for
// the planned 50-second H0 poll while still ending stuck work.
const USER_WORKER_TIMEOUT_MS = 150_000;

const REQUIRED_ENV = [
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;

function assertRequiredEnvironment(): void {
  const missing = REQUIRED_ENV.filter((name) => !Deno.env.get(name));
  if (!Deno.env.get("SWARM_DATABASE_URL") && !Deno.env.get("SUPABASE_DB_URL")) {
    missing.push("SWARM_DATABASE_URL or SUPABASE_DB_URL" as typeof missing[number]);
  }
  if (missing.length > 0) {
    throw new Error(`edge-runtime environment is missing: ${missing.join(", ")}`);
  }
}

assertRequiredEnvironment();

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function environmentFor(functionName: FunctionName): Array<[string, string]> {
  const isTest = Deno.env.get("SWARM_ENV") === "test";
  const entries: Array<[string, string]> = [];
  for (const name of FUNCTION_ENV_NAMES[functionName]) {
    // These hooks can change command transaction timing or force rollback.
    // Keep them out of a non-test worker even if a stale host file has them.
    if (!isTest && COMMAND_TEST_HOOKS.has(name)) continue;
    const value = Deno.env.get(name);
    if (value !== undefined) entries.push([name, value]);
  }
  return entries;
}

async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health") {
    return json(200, { status: "ok" });
  }

  const route = resolveFunctionRoute(url.pathname);
  if (route === null) {
    return json(404, { error: "function_not_found" });
  }

  const worker = await EdgeRuntime.userWorkers.create({
    servicePath: `${FUNCTIONS_ROOT}/${route.functionName}`,
    memoryLimitMb: USER_WORKER_MEMORY_MB,
    workerTimeoutMs: USER_WORKER_TIMEOUT_MS,
    noModuleCache: false,
    envVars: environmentFor(route.functionName),
  });

  // Supabase's Kong removes only /functions/v1. Preserve the function name,
  // the remaining path, the query, method, headers, body, and signal.
  url.pathname = route.pathname;
  const forwarded = new Request(url, request);
  EdgeRuntime.applySupabaseTag(request, forwarded);
  return await worker.fetch(forwarded);
}

Deno.serve((request) =>
  handle(request).catch((error: unknown) => {
    console.error("edge-runtime request failed", error);
    return json(500, { error: "internal_error" });
  })
);
