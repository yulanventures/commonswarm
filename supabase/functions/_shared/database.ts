import postgres from "npm:postgres@3.4.9";
import { edgeDatabaseOptions, type EdgeDatabaseConfig } from "./database-options.ts";

export type { EdgeDatabaseConfig } from "./database-options.ts";

/** Open a bounded, self-recovering Postgres client for an edge worker isolate. */
export function createEdgeDatabase(
  databaseUrl: string,
  config: EdgeDatabaseConfig,
  encodedCa: string | undefined = Deno.env.get("SWARM_DATABASE_TLS_CA_B64"),
): postgres.Sql {
  const options = edgeDatabaseOptions(config, encodedCa);
  return postgres(databaseUrl, options as postgres.Options<Record<string, never>>);
}
