import { build } from 'esbuild';
import { randomUUID } from 'node:crypto';
import type * as Tools from '../../supabase/functions/mcp/tools.js';
import type * as Protocol from '../../supabase/functions/mcp/protocol.js';

/** Compile the real hosted boundary with isolated server settings.
 * Enabled tests set the to-do/list env gate; production source is unchanged. */
export async function hostedHouseholdRelease(
  enabled = false,
  flags: Record<string, string | undefined> = {},
): Promise<typeof Tools & typeof Protocol> {
  const bundled = await build({
    stdin: {
      contents: `export * from './supabase/functions/mcp/tools.ts';
        export * from './supabase/functions/mcp/protocol.ts';`,
      resolveDir: process.cwd(), loader: 'ts',
    },
    bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022', logLevel: 'silent',
    banner: { js: `
      const settings = ${JSON.stringify({ ...flags, ...(enabled ? { SWARM_MCP_TODOS_LISTS_ENABLED: '1' } : {}) })};
      const priorDeno = Object.getOwnPropertyDescriptor(globalThis, 'Deno');
      Object.defineProperty(globalThis, 'Deno', { value: { env: { get: name => settings[name] } }, configurable: true });` },
    footer: { js: `
      if (priorDeno) Object.defineProperty(globalThis, 'Deno', priorDeno); else Reflect.deleteProperty(globalThis, 'Deno');
      // ${randomUUID()}` },
  });
  return await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0]!.text).toString('base64')}`);
}
