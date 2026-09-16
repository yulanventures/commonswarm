import {
  COMMAND_TEST_HOOKS,
  createWorkerWithRetiredRetry,
  FUNCTION_ENV_NAMES,
  type FunctionName,
  isWorkerLimitError,
  mainEnvironmentProblems,
  mainJsonResponse,
  resolveGatewayRequest,
  rewriteFunctionRequest,
  WORKER_LIMIT_BODY,
  WORKER_LIMIT_STATUS,
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

// Four workers at 96 MiB use at most 384 MiB. The 512 MiB container limit keeps
// 128 MiB for the main runtime, module cache, and process overhead.
const USER_WORKER_MEMORY_MB = 96;

// The hosted free-plan wall-clock limit is 150 seconds. This is long enough for
// the planned 50-second H0 poll while still ending stuck work.
const USER_WORKER_TIMEOUT_MS = 150_000;

function assertRequiredEnvironment(): void {
  const problems = mainEnvironmentProblems((name) => Deno.env.get(name));
  if (problems.length > 0) {
    throw new Error(
      `edge-runtime environment is invalid: ${problems.join(", ")}`,
    );
  }
}

assertRequiredEnvironment();

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
    return mainJsonResponse(200, { status: "ok" });
  }
  // This keeps bare-path, unknown-function, and preflight behavior in one pure
  // resolver. Kong answers a known function's preflight before the worker;
  // unknown names keep its normal 404. Non-OPTIONS preserve function CORS.
  const gateway = resolveGatewayRequest(request);
  if (gateway.response !== null) return gateway.response;
  const route = gateway.route;

  const worker = await createWorkerWithRetiredRetry(() =>
    EdgeRuntime.userWorkers.create({
      servicePath: `${FUNCTIONS_ROOT}/${route.functionName}`,
      memoryLimitMb: USER_WORKER_MEMORY_MB,
      workerTimeoutMs: USER_WORKER_TIMEOUT_MS,
      noModuleCache: false,
      envVars: environmentFor(route.functionName),
    })
  );

  // Supabase's Kong removes only /functions/v1. Preserve the function name,
  // the remaining path, the query, method, headers, body, and signal.
  const forwarded = rewriteFunctionRequest(request, route.pathname);
  EdgeRuntime.applySupabaseTag(request, forwarded);
  return await worker.fetch(forwarded);
}

Deno.serve((request) =>
  handle(request).catch((error: unknown) => {
    if (isWorkerLimitError(error)) {
      return mainJsonResponse(WORKER_LIMIT_STATUS, WORKER_LIMIT_BODY);
    }
    console.error("edge-runtime request failed", error);
    return mainJsonResponse(500, { error: "internal_error" });
  })
);
