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

const FUNCTION_PREFIX = "/functions/v1/";
export const FUNCTIONS_BASE_PATH = "/functions/v1";
export const KONG_NO_ROUTE_BODY = {
  message: "no Route matched with those values",
} as const;
const FUNCTION_NAME_SET = new Set<string>(FUNCTION_NAMES);

export function isFunctionsBasePath(pathname: string): boolean {
  return pathname === FUNCTIONS_BASE_PATH;
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

const DATABASE_ENV = ["SWARM_DATABASE_URL", "SUPABASE_DB_URL"] as const;

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
