import { build } from "esbuild";

// Consent and enforcement share the lane-1 map and v2 validator. No copied registry.
await build({
  absWorkingDir: new URL("../../", import.meta.url).pathname,
  entryPoints: ["src/protocol/admin-policy.ts"],
  outfile: "services/mcp-auth/src/admin-policy.generated.js",
  bundle: true, platform: "node", target: "node22", format: "esm",
  banner: { js: "// Generated from src/protocol/admin-policy.ts; do not edit." },
});
