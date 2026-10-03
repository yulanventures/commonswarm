/** Shared transport types for the edge command handler and its MCP adapter.
 * Keep this boundary free of runtime imports so Node tests can use the same
 * contract without loading the Deno entry point or its database dependencies.
 */
export interface HostedCommandInput {
  command_id?: unknown;
  client_version?: unknown;
  client_build?: unknown;
  workspace_id?: unknown;
  stream?: unknown;
  command?: unknown;
  [key: string]: unknown;
}

export interface CommandResult {
  status: number;
  headers?: Record<string, string>;
  body: Record<string, unknown>;
}
