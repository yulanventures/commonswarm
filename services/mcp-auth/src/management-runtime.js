// This is a lexical build adapter, not a Deno global or a process.env mutation.
// The credential stays in memory after being read from its protected file.
let settings;

export function configureManagementRuntime(config) {
  if (!config.management?.databaseUrl || !config.supabaseUrl || !config.database?.ssl?.ca) {
    throw new Error("lane-2 management configuration is required");
  }
  if (settings) throw new Error("lane-2 management runtime is already configured");
  settings = new Map([
    ["SWARM_DATABASE_URL", config.management.databaseUrl],
    ["SWARM_DATABASE_TLS_CA_B64", Buffer.from(config.database.ssl.ca).toString("base64")],
    ["SUPABASE_URL", config.supabaseUrl],
    ["SUPABASE_ANON_KEY", config.supabaseAnonKey],
    ["SWARM_ENV", "production"],
  ]);
}

export function managementEnvGet(name) {
  if (!settings) throw new Error("lane-2 management runtime is not configured");
  return settings.get(name);
}
