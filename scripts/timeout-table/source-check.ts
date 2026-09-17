import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const [sourceRoot, profilePath, timeoutText] = process.argv.slice(2);
if (!sourceRoot || !profilePath || !timeoutText) throw new Error("source-check needs source root, profile, and timeout");
const moduleUrl = pathToFileURL(resolve(sourceRoot, "src/cloud/agent-check.ts")).href;
const { checkAgentMessages } = await import(moduleUrl) as typeof import("../../src/cloud/agent-check.js");
const started = performance.now();
await checkAgentMessages({
  profilePath,
  timeoutMs: Number(timeoutText),
  present: async () => {},
});
process.stdout.write(`${JSON.stringify({ duration_ms: performance.now() - started })}\n`);
