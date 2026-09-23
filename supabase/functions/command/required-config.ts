/** Import-time requirements shared by the command worker and H0's lazy forward. */
export const COMMAND_REQUIRED_ENV = [
  ["SWARM_DATABASE_URL", "SUPABASE_DB_URL"],
  ["SUPABASE_URL"],
  ["SUPABASE_ANON_KEY"],
] as const;

export function commandRequiredConfig(
  get: (name: string) => string | undefined,
): { databaseUrl: string; supabaseUrl: string; supabaseAnonKey: string } | null {
  const databaseUrl = get(COMMAND_REQUIRED_ENV[0][0]) ?? get(COMMAND_REQUIRED_ENV[0][1]);
  const supabaseUrl = get(COMMAND_REQUIRED_ENV[1][0]);
  const supabaseAnonKey = get(COMMAND_REQUIRED_ENV[2][0]);
  return databaseUrl && supabaseUrl && supabaseAnonKey
    ? { databaseUrl, supabaseUrl, supabaseAnonKey }
    : null;
}
