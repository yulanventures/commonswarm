import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const [sourceRoot, profilePath] = process.argv.slice(2);
if (!sourceRoot || !profilePath) throw new Error("source-signal-read needs source root and profile");
const profileUrl = pathToFileURL(resolve(sourceRoot, "src/cloud/agent-profile.ts")).href;
const signalsUrl = pathToFileURL(resolve(sourceRoot, "src/cloud/signals.ts")).href;
const { openProfileCredential, profileTarget, readAgentProfile } =
  await import(profileUrl) as typeof import("../../src/cloud/agent-profile.js");
const { readAgentSignalPage } =
  await import(signalsUrl) as typeof import("../../src/cloud/signals.js");
const profile = await readAgentProfile(profilePath);
const credential = await openProfileCredential(profile);
const token = await credential.bearer();
const started = performance.now();
await readAgentSignalPage(
  profileTarget(profile),
  { kind: "agent", token },
  { workspaceId: profile.workspace_id, inbox: true, ascending: true, limit: 1 },
);
process.stdout.write(`${JSON.stringify({ duration_ms: performance.now() - started })}\n`);
