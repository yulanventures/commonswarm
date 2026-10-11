/** Read the server-owned to-do/list switch once at worker startup. Only exact
 * "1" enables the registry catalog and calls; client input cannot enable them.
 * Docs and file tools remain unavailable regardless of other feature gates. */
const runtime = (globalThis as typeof globalThis & {
  Deno?: { env: { get(name: string): string | undefined } };
}).Deno;
export const HOSTED_HOUSEHOLD_TOOLS_ENABLED = runtime?.env.get('SWARM_MCP_TODOS_LISTS_ENABLED') === '1';
