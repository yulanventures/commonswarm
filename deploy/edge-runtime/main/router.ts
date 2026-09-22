export const FUNCTION_NAMES = [
  "command",
  "read",
  "capability",
  "activity",
  "h0",
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
export const REQUIRED_MAIN_ENV = [
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SWARM_SELF_SERVE",
] as const;
export const SELF_SERVE_ENV_REASON =
  "SWARM_SELF_SERVE must equal 1 because production workspace creation requires self-serve mode";
const FUNCTION_NAME_SET = new Set<string>(FUNCTION_NAMES);
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

export function resolveGatewayRequest(request: Request): GatewayResolution {
  const pathname = new URL(request.url).pathname;
  if (isFunctionsBasePath(pathname)) {
    return { route: null, response: kongNoRouteResponse() };
  }
  const route = resolveFunctionRoute(pathname);
  if (route === null) {
    return { route: null, response: functionNotFoundResponse() };
  }
  if (request.method === "OPTIONS") {
    return { route: null, response: gatewayPreflight(request) };
  }
  return { route, response: null };
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
export function resolveFunctionRoute(pathname: string): FunctionRoute | null {
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

const DATABASE_ENV = [
  "SWARM_DATABASE_URL",
  "SUPABASE_DB_URL",
  "SWARM_DATABASE_TLS_CA_B64",
] as const;

export const FUNCTION_ENV_NAMES: Record<FunctionName, readonly string[]> = {
  command: [
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
  ],
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
  // H0 is document-only today and reads no environment. The poll lane must add
  // every variable it starts reading here; the source-closure test enforces it.
  h0: [],
};

export const COMMAND_TEST_HOOKS = new Set([
  "SWARM_CMD_TEST_SLEEP_AFTER_STEP",
  "SWARM_CMD_TEST_ROLLBACK_BEFORE_STEP",
]);
