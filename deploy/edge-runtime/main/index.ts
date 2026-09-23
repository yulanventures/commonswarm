import {
  COMMAND_TEST_HOOKS,
  FUNCTION_ENV_NAMES,
  type FunctionName,
  isWorkerLimitError,
  mainEnvironmentProblems,
  mainJsonResponse,
  resolveGatewayRequest,
  rewriteFunctionRequest,
  WORKER_LIMIT_BODY,
  WORKER_LIMIT_STATUS,
  withWorkerRetiredRetry,
} from "./router.ts";
import { createWorkerObserver, localMetricsResponse } from "./observability.ts";

declare const EdgeRuntime: {
  applySupabaseTag(original: Request, cloned: Request): void;
  getRuntimeMetrics(): Promise<unknown>;
  userWorkers: {
    create(options: {
      servicePath: string;
      memoryLimitMb: number;
      workerTimeoutMs: number;
      noModuleCache: boolean;
      envVars: Array<[string, string]>;
    }): Promise<{ key: string; fetch(request: Request): Promise<Response> }>;
    memStats(): Promise<Map<string, unknown> | Record<string, unknown>>;
  };
};

const FUNCTIONS_ROOT = "/var/tmp/commonswarm-functions";

// Four workers at 96 MiB use at most 384 MiB. The 512 MiB container limit keeps
// 128 MiB for the main runtime, module cache, and process overhead.
const USER_WORKER_MEMORY_MB = 96;

// The hosted free-plan wall-clock limit is 150 seconds. This is long enough for
// the planned 50-second H0 poll while still ending stuck work.
const USER_WORKER_TIMEOUT_MS = 150_000;
const workerObserver = createWorkerObserver(EdgeRuntime.userWorkers, console.log);

// The runtime has no main-worker lifecycle callback. Its worker inventory lets
// us observe ended isolate keys without changing user workers or their limits.
let observingWorkers = false;
setInterval(async () => {
  if (observingWorkers) return;
  observingWorkers = true;
  try {
    await workerObserver.observeEnded();
  } catch {
    // A failed inventory is not evidence that any worker ended.
  } finally {
    observingWorkers = false;
  }
}, 5_000);

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

async function handle(request: Request, peerHostname: string): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health") {
    return mainJsonResponse(200, { status: "ok" });
  }
  const metrics = await localMetricsResponse(
    request,
    peerHostname,
    () => EdgeRuntime.getRuntimeMetrics(),
  );
  if (metrics !== null) return metrics;
  // This keeps bare-path, unknown-function, and preflight behavior in one pure
  // resolver. Kong answers a known function's preflight before the worker;
  // unknown names keep its normal 404. Non-OPTIONS preserve function CORS.
  const gateway = resolveGatewayRequest(request);
  if (gateway.response !== null) return gateway.response;
  const route = gateway.route;

  // Supabase's Kong removes only /functions/v1. Preserve the function name,
  // the remaining path, the query, method, headers, body, and signal.
  // Clone before the first fetch so a retired worker can be replaced even if
  // fetch disturbed the first request body. The bounded retry covers both
  // userWorkers.create and worker.fetch, matching the upstream main service.
  const attemptRequests = [request, request.clone()] as const;
  return await withWorkerRetiredRetry(async (attemptNumber) => {
    const original = attemptRequests[attemptNumber];
    const worker = await workerObserver.create(route.functionName, {
      servicePath: `${FUNCTIONS_ROOT}/${route.functionName}`,
      memoryLimitMb: USER_WORKER_MEMORY_MB,
      workerTimeoutMs: USER_WORKER_TIMEOUT_MS,
      noModuleCache: false,
      envVars: environmentFor(route.functionName),
    });
    const forwarded = rewriteFunctionRequest(original, route.pathname);
    EdgeRuntime.applySupabaseTag(original, forwarded);
    return await worker.fetch(forwarded);
  });
}

Deno.serve((request, info) =>
  handle(request, info.remoteAddr.hostname).catch((error: unknown) => {
    if (isWorkerLimitError(error)) {
      return mainJsonResponse(WORKER_LIMIT_STATUS, WORKER_LIMIT_BODY);
    }
    console.error("edge-runtime request failed", error);
    return mainJsonResponse(500, { error: "internal_error" });
  })
);
