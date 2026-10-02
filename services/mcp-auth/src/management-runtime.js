// This is a lexical build adapter, not a Deno global or a process.env mutation.
// The credential stays in memory after being read from its protected file.
let settings;
let databaseTls;

export function configureManagementRuntime(config) {
  if (!config.management?.databaseUrl || !config.supabaseUrl || !config.database?.ssl?.ca) {
    throw new Error("lane-2 management configuration is required");
  }
  if (settings) throw new Error("lane-2 management runtime is already configured");
  databaseTls = {
    ca: config.database.ssl.ca,
    servername: config.database.host,
    rejectUnauthorized: true,
  };
  settings = new Map([
    ["SWARM_DATABASE_URL", config.management.databaseUrl],
    ["SWARM_DATABASE_TLS_CA_B64", Buffer.from(config.database.ssl.ca).toString("base64")],
    ["SUPABASE_URL", config.supabaseUrl],
    ["SUPABASE_ANON_KEY", config.supabaseAnonKey],
    ["SWARM_ENV", "production"],
  ]);
}

// The Node adapter passes this object directly to postgres.js, whose TLS
// connection merges ssl into tls.connect options. Never inherit URL TLS flags.
export function managementDatabaseOptions(options) {
  if (!databaseTls?.servername) throw new Error("management TLS is not configured");
  return { ...options, ssl: { ...databaseTls } };
}

export function managementEnvGet(name) {
  if (!settings) throw new Error("lane-2 management runtime is not configured");
  return settings.get(name);
}

// Importing the command bundle must not allocate connection objects. Resolve
// the pool only on the first command/read; closing an unused binding is a no-op.
export function lazyManagementDatabase(create) {
  let database;
  const get = () => (database ??= create());
  return new Proxy(function () {}, {
    apply(_target, _receiver, args) { return Reflect.apply(get(), undefined, args); },
    get(_target, name) {
      if (name === "end") return (...args) => database?.end(...args);
      const value = get()[name];
      return typeof value === "function" ? value.bind(database) : value;
    },
  });
}
