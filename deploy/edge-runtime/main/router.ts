export const FUNCTION_NAMES = [
  "command",
  "read",
  "capability",
  "activity",
  "h0",
  "mcp",
  "admin",
] as const;

export type FunctionName = (typeof FUNCTION_NAMES)[number];

export interface FunctionRoute {
  functionName: FunctionName;
  pathname: string;
}

export type GatewayResolution =
  | { route: FunctionRoute; response: null }
  | { route: null; response: Response };

const FUNCTION_PREFIX = "/functions/v1/";
export const FUNCTIONS_BASE_PATH = "/functions/v1";
export const KONG_NO_ROUTE_BODY = {
  message: "no Route matched with those values",
} as const;
export const KONG_PREFLIGHT_METHODS =
  "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS,TRACE,CONNECT";
export const KONG_FUNCTION_NOT_FOUND_BODY = "Function not found";
export const WORKER_LIMIT_BODY = {
  code: "WORKER_LIMIT",
  message:
    "Worker failed to respond due to a resource limit (please check logs)",
} as const;
export const WORKER_LIMIT_STATUS = 504;
// These functions are dark unless their main-runtime gate explicitly enables
// them. Keep the gate in this router so no preflight or user worker can start
// while a function is dark.
export const DISABLED_FUNCTION_NAMES = ["mcp"] as const satisfies readonly FunctionName[];
export const FUNCTION_DISABLED_BODY = {
  error: "feature_disabled",
  feature: "hosted_mcp",
  message: "Hosted MCP is not available yet.",
} as const;
export const FUNCTION_DISABLED_STATUS = 503;
export const MCP_PUBLIC_ENABLED_ENV = "SWARM_MCP_PUBLIC_ENABLED";
export const REQUIRED_MAIN_ENV = [
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SWARM_SELF_SERVE",
] as const;
export const SELF_SERVE_ENV_REASON =
  "SWARM_SELF_SERVE must equal 1 because production workspace creation requires self-serve mode";
const FUNCTION_NAME_SET = new Set<string>(FUNCTION_NAMES);
const DISABLED_FUNCTION_NAME_SET = new Set<string>(DISABLED_FUNCTION_NAMES);
const WORKER_LIMIT_ERROR_NAMES = new Set([
  "InvalidWorkerCreation",
  "WorkerRequestIdleTimeout",
  "WorkerRequestCancelled",
]);

export function isFunctionsBasePath(pathname: string): boolean {
  return pathname === FUNCTIONS_BASE_PATH;
}

export function isFunctionsGatewayPath(pathname: string): boolean {
  return pathname.startsWith(`${FUNCTIONS_BASE_PATH}/`);
}

export function gatewayPreflight(request: Request): Response {
  const requestedHeaders = request.headers.get(
    "access-control-request-headers",
  );
  return new Response(null, {
    status: 200,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": KONG_PREFLIGHT_METHODS,
      ...(requestedHeaders === null
        ? {}
        : { "access-control-allow-headers": requestedHeaders }),
    },
  });
}

export function mainJsonResponse(
  status: number,
  body: Record<string, unknown>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    },
  });
}

export function functionNotFoundResponse(): Response {
  return new Response(KONG_FUNCTION_NOT_FOUND_BODY, {
    status: 404,
    headers: {
      "content-type": "text/plain; charset=UTF-8",
      "access-control-allow-origin": "*",
    },
  });
}

export function functionDisabledResponse(): Response {
  return mainJsonResponse(FUNCTION_DISABLED_STATUS, FUNCTION_DISABLED_BODY);
}

export function isMcpPublicEnabled(value: string | undefined): boolean {
  return value === "1";
}

function isFunctionDisabled(
  functionName: FunctionName,
  mcpPublicEnabled: boolean,
): boolean {
  if (!DISABLED_FUNCTION_NAME_SET.has(functionName)) return false;
  return functionName !== "mcp" || !mcpPublicEnabled;
}

export function kongNoRouteResponse(): Response {
  return mainJsonResponse(404, KONG_NO_ROUTE_BODY);
}

export function mainEnvironmentProblems(
  environment: (name: string) => string | undefined,
): string[] {
  const problems: string[] = REQUIRED_MAIN_ENV.filter(
    (name) => name !== "SWARM_SELF_SERVE" && !environment(name),
  );
  if (!environment("SWARM_DATABASE_URL") && !environment("SUPABASE_DB_URL")) {
    problems.push("SWARM_DATABASE_URL or SUPABASE_DB_URL");
  }
  const selfServe = environment("SWARM_SELF_SERVE");
  if (selfServe !== "1") {
    problems.push(SELF_SERVE_ENV_REASON);
  }
  return problems;
}

export function resolveGatewayRequest(
  request: Request,
  mcpPublicEnabled = false,
): GatewayResolution {
  const pathname = new URL(request.url).pathname;
  if (isFunctionsBasePath(pathname)) {
    return { route: null, response: kongNoRouteResponse() };
  }
  const route = resolvePreparedFunctionRoute(pathname);
  if (route === null) {
    return { route: null, response: functionNotFoundResponse() };
  }
  // A dark function is not runnable. Keep the response here, before preflight
  // or worker creation, until its main-runtime gate is explicitly enabled.
  if (isFunctionDisabled(route.functionName, mcpPublicEnabled)) {
    return { route: null, response: functionDisabledResponse() };
  }
  if (request.method === "OPTIONS") {
    return { route: null, response: gatewayPreflight(request) };
  }
  return { route, response: null };
}

export async function handleGatewayRequest(
  request: Request,
  mcpPublicEnabled: boolean,
  invokeWorker: (route: FunctionRoute, request: Request) => Promise<Response>,
): Promise<Response> {
  const gateway = resolveGatewayRequest(request, mcpPublicEnabled);
  if (gateway.response !== null) return gateway.response;
  return await invokeWorker(gateway.route, request);
}

export function rewriteFunctionRequest(
  request: Request,
  pathname: string,
): Request {
  const url = new URL(request.url);
  url.pathname = pathname;
  return new Request(url, request);
}

export function isWorkerLimitError(error: unknown): boolean {
  return error instanceof Error && WORKER_LIMIT_ERROR_NAMES.has(error.name);
}

export function isWorkerAlreadyRetired(error: unknown): boolean {
  return error instanceof Error && error.name === "WorkerAlreadyRetired";
}

/** Retry one create-and-fetch attempt when the selected worker retired. */
export async function withWorkerRetiredRetry<T>(
  attempt: (attemptNumber: 0 | 1) => Promise<T>,
): Promise<T> {
  try {
    return await attempt(0);
  } catch (error) {
    if (!isWorkerAlreadyRetired(error)) throw error;
    return await attempt(1);
  }
}

/**
 * Match the public Supabase Functions path and produce the path that Kong gives
 * a hosted function. Only the fixed prefix is removed. The function name and
 * the rest of the path stay intact.
 */
function resolvePreparedFunctionRoute(pathname: string): FunctionRoute | null {
  // The admin resource has a canonical public path outside the Functions prefix.
  // Both ingress forms reach the same worker; proof htu stays the public /admin URI.
  if (pathname === "/admin" || pathname.startsWith("/admin/")) {
    return { functionName: "admin", pathname };
  }
  if (!pathname.startsWith(FUNCTION_PREFIX)) return null;

  const publicPath = pathname.slice(FUNCTION_PREFIX.length);
  const slash = publicPath.indexOf("/");
  const functionName = slash === -1 ? publicPath : publicPath.slice(0, slash);
  if (!FUNCTION_NAME_SET.has(functionName)) return null;

  const suffix = slash === -1 ? "" : publicPath.slice(slash);
  return {
    functionName: functionName as FunctionName,
    pathname: `/${functionName}${suffix}`,
  };
}

/** Return only routes whose worker is available and enabled in the main service. */
export function resolveFunctionRoute(
  pathname: string,
  mcpPublicEnabled = false,
): FunctionRoute | null {
  const route = resolvePreparedFunctionRoute(pathname);
  if (route === null || isFunctionDisabled(route.functionName, mcpPublicEnabled)) {
    return null;
  }
  return route;
}

const DATABASE_ENV = [
  "SWARM_DATABASE_URL",
  "SUPABASE_DB_URL",
  "SWARM_DATABASE_TLS_CA_B64",
] as const;

const COMMAND_ENV = [
  ...DATABASE_ENV,
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SWARM_ENV",
  "SWARM_COMMAND_ALLOWED_ORIGINS",
  "SWARM_CAPABILITY_URLS",
  "SWARM_SELF_SERVE",
  "SWARM_CMD_TEST_SLEEP_AFTER_STEP",
  "SWARM_CMD_TEST_ROLLBACK_BEFORE_STEP",
] as const;

// H0 forwards only register_agent_seat and post_signal. File storage is unreachable.
export const H0_COMMAND_ENV_EXCLUSIONS = ["SUPABASE_SERVICE_ROLE_KEY"] as const;
const H0_COMMAND_ENV = COMMAND_ENV.filter(
  (name) => !H0_COMMAND_ENV_EXCLUSIONS.some((excluded) => excluded === name),
);

// This is the complete environment boundary for the future hosted MCP resource
// worker. It intentionally contains public Supabase configuration and the
// worker's own database connection, but no OAuth-service credential material.
export const MCP_ENV_NAMES = [
  ...DATABASE_ENV,
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
  MCP_PUBLIC_ENABLED_ENV,
] as const;

export const FUNCTION_ENV_NAMES: Record<FunctionName, readonly string[]> = {
  command: COMMAND_ENV,
  read: [
    ...DATABASE_ENV,
    "SUPABASE_URL",
    "SUPABASE_ANON_KEY",
    "SWARM_ENV",
    "SWARM_COMMAND_ALLOWED_ORIGINS",
  ],
  capability: [
    ...DATABASE_ENV,
    "SWARM_ENV",
    "SWARM_CAPABILITY_URLS",
    "SWARM_CAPABILITY_ALLOWED_ORIGINS",
  ],
  activity: DATABASE_ENV,
  // Forwarded verbs call command's handler in the H0 worker.
  h0: H0_COMMAND_ENV,
  mcp: MCP_ENV_NAMES,
  // The admin entry delegates to the account command adapter, including its
  // worker-delivery boundary. It needs the same reviewed environment.
  admin: COMMAND_ENV,
};

export const COMMAND_TEST_HOOKS = new Set([
  "SWARM_CMD_TEST_SLEEP_AFTER_STEP",
  "SWARM_CMD_TEST_ROLLBACK_BEFORE_STEP",
]);
