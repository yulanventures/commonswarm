/** Brain M3b: read the server-owned memory switches once at worker startup. Hosted memory tools
 * are listed and callable only when both are exactly "1"; the command and read edges check the
 * same two switches again. Client input cannot enable them. */
const runtime = (globalThis as typeof globalThis & {
  Deno?: { env: { get(name: string): string | undefined } };
}).Deno;
export const HOSTED_MEMORY_TOOLS_ENABLED = runtime?.env.get("SWARM_BRAIN_MEMORY") === "1" &&
  runtime?.env.get("SWARM_BRAIN_MEMORY_HOSTED") === "1";
