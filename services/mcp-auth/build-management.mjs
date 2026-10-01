// Build the existing lane-2 transaction path for the Node container. No second
// implementation of grant/consent writes and no public management HTTP route.
import { build } from "esbuild";

await build({
  absWorkingDir: new URL("../../", import.meta.url).pathname,
  entryPoints: ["supabase/functions/command/index.ts"],
  outfile: "services/mcp-auth/src/management-command.generated.js",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  define: { "Deno.env.get": "managementEnvGet", "import.meta.main": "false" },
  banner: { js: 'import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);\nimport { managementEnvGet } from "./management-runtime.js";' },
  plugins: [{
    name: "deno-npm-specifiers",
    setup(builder) {
      builder.onResolve({ filter: /^npm:/ }, async (args) => {
        const name = args.path.slice(4).replace(/@[^@/]+$/u, "");
        return await builder.resolve(name, { resolveDir: args.resolveDir, kind: args.kind });
      });
    },
  }],
});
