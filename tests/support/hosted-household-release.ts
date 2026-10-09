import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type * as Tools from '../../supabase/functions/mcp/tools.js';
import type * as Protocol from '../../supabase/functions/mcp/protocol.js';

/** Compile the real hosted boundary with the next release's source switch.
 * No runtime override is added to production. The file-transport environment
 * gate remains independent so tests cover both release decisions. */
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
      const settings = ${JSON.stringify(flags)};
      const priorDeno = Object.getOwnPropertyDescriptor(globalThis, 'Deno');
      Object.defineProperty(globalThis, 'Deno', { value: { env: { get: name => settings[name] } }, configurable: true });` },
    footer: { js: `
      if (priorDeno) Object.defineProperty(globalThis, 'Deno', priorDeno); else Reflect.deleteProperty(globalThis, 'Deno');
      // ${randomUUID()}` },
    plugins: enabled ? [{ name: 'next-household-release', setup(builder) {
      builder.onLoad({ filter: /\/mcp\/household-release\.ts$/ }, async ({ path }) => ({
        contents: (await readFile(path, 'utf8')).replace(
          'HOSTED_HOUSEHOLD_TOOLS_ENABLED = false;', 'HOSTED_HOUSEHOLD_TOOLS_ENABLED = true;',
        ), loader: 'ts',
      }));
    } }] : [],
  });
  return await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0]!.text).toString('base64')}`);
}
