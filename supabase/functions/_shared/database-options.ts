export interface DatabaseTlsOptions {
  ssl: {
    ca: string;
    rejectUnauthorized: true;
    servername?: string;
  };
}

/** Add the private CA only when the worker receives one. */
export function withDatabaseTls<T extends Record<string, unknown>>(
  options: T,
  encodedCa: string | undefined,
): T | (T & DatabaseTlsOptions) {
  if (encodedCa === undefined || encodedCa.length === 0) return options;

  let ca: string;
  try {
    ca = atob(encodedCa);
  } catch {
    throw new Error("SWARM_DATABASE_TLS_CA_B64 must be valid base64");
  }
  if (!ca.includes("-----BEGIN CERTIFICATE-----")) {
    throw new Error("SWARM_DATABASE_TLS_CA_B64 must decode to a PEM certificate");
  }
  return {
    ...options,
    ssl: { ca, rejectUnauthorized: true },
  };
}

export const EDGE_DATABASE_CONNECT_TIMEOUT_SECONDS = 5;
export const EDGE_DATABASE_IDLE_TIMEOUT_SECONDS = 3;
export const EDGE_DATABASE_MAX_LIFETIME_SECONDS = 300;
export const EDGE_DATABASE_KEEP_ALIVE_SECONDS = 5;

export interface EdgeDatabaseConfig {
  /** Maximum per-isolate connections. Keep minimal to avoid exhausting Postgres. */
  max: number;
  /** Idle connection timeout in seconds (default 3). */
  idle_timeout?: number;
  /** TCP + TLS + Postgres startup timeout in seconds (default 5). */
  connect_timeout?: number;
  /** Maximum connection lifetime in seconds before recycling (default 300). */
  max_lifetime?: number;
  /** TCP keep-alive initial delay in seconds (default 5). */
  keep_alive?: number;
  /** Explicit TLS options (e.g. management runtime with explicit servername). */
  ssl?: DatabaseTlsOptions["ssl"];
  /** Optional postgres.js fetch_types flag (defaults to library default). */
  fetch_types?: boolean;
}

export interface EdgeDatabaseResolvedOptions extends Record<string, unknown> {
  max: number;
  prepare: false;
  idle_timeout: number;
  connect_timeout: number;
  max_lifetime: number;
  keep_alive: number;
  backoff: (attemptNum: number) => number;
  ssl?: DatabaseTlsOptions["ssl"];
  fetch_types?: boolean;
}

/** Build shared plain postgres.js options for edge functions (no custom socket). */
export function edgeDatabaseOptions(
  config: EdgeDatabaseConfig,
  encodedCa: string | undefined,
): EdgeDatabaseResolvedOptions {
  const base: EdgeDatabaseResolvedOptions = {
    max: config.max,
    prepare: false,
    idle_timeout: config.idle_timeout ?? EDGE_DATABASE_IDLE_TIMEOUT_SECONDS,
    connect_timeout: config.connect_timeout ?? EDGE_DATABASE_CONNECT_TIMEOUT_SECONDS,
    max_lifetime: config.max_lifetime ?? EDGE_DATABASE_MAX_LIFETIME_SECONDS,
    keep_alive: config.keep_alive ?? EDGE_DATABASE_KEEP_ALIVE_SECONDS,
    // postgres.js opens connections lazily per request; disable exponential backoff
    // (default up to 20s) so failed connects during a DB restart never poison the
    // first request after Postgres returns.
    backoff: () => 0,
    ...(config.fetch_types === undefined ? {} : { fetch_types: config.fetch_types }),
  };

  if (config.ssl !== undefined) {
    if (config.ssl.rejectUnauthorized !== true) {
      throw new Error("database TLS must enforce certificate verification");
    }
    return { ...base, ssl: { ...config.ssl } };
  }

  return withDatabaseTls(base, encodedCa);
}
