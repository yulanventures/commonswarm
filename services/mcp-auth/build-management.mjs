// Build the existing lane-2 transaction path for the Node container. No second
// implementation of grant/consent writes and no public management HTTP route.
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import "./build-admin-policy.mjs";

await build({
  absWorkingDir: new URL("../../", import.meta.url).pathname,
  entryPoints: ["supabase/functions/command/index.ts"],
  outfile: "services/mcp-auth/src/management-command.generated.js",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  external: ["postgres"],
  define: { "Deno.env.get": "managementEnvGet", "import.meta.main": "false" },
  banner: { js: 'import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);\nimport { managementEnvGet, managementDatabaseOptions, lazyManagementDatabase } from "./management-runtime.js";' },
  plugins: [{
    name: "deno-npm-specifiers",
    setup(builder) {
      builder.onResolve({ filter: /^npm:/ }, async (args) => {
        const name = args.path.slice(4).replace(/@[^@/]+$/u, "");
        if (name === "postgres") return { path: name, external: true };
        return await builder.resolve(name, { resolveDir: args.resolveDir, kind: args.kind });
      });
      builder.onLoad({ filter: /\/supabase\/functions\/command\/index\.ts$/ }, async (args) => {
        const source = await readFile(args.path, "utf8");
        const pool = /export const db = postgres\(databaseUrl, withDatabaseTls\(\{[\s\S]*?\}, Deno\.env\.get\("SWARM_DATABASE_TLS_CA_B64"\)\)\);/gu;
        const matches = [...source.matchAll(pool)];
        if (matches.length !== 1 || !/\bmax: 2,/u.test(matches[0][0])) {
          throw new Error("management pool adapter requires exactly one max-2 pool");
        }
        return { loader: "ts", contents: source.replace(pool, (value) =>
          value.replace("db = postgres(", "db = lazyManagementDatabase(() => postgres(")
            .replace("withDatabaseTls(", "managementDatabaseOptions(")
            .replace(/\);$/u, "));")) };
      });
    },
  }],
});
