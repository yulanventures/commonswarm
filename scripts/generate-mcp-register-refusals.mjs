import { readFile, writeFile } from "node:fs/promises";

const command = await readFile("supabase/functions/command/index.ts", "utf8");
const start = command.indexOf("async function registerAgentSeat(");
const end = command.indexOf("async function ", start + 1);
if (start < 0 || end < 0) throw new Error("registerAgentSeat source boundary missing");
const handler = command.slice(start, end);
const rows = new Map();
function add(status, code) {
  if (rows.has(code) && rows.get(code) !== Number(status)) throw new Error(`conflicting status for ${code}`);
  rows.set(code, Number(status));
}
for (const match of handler.matchAll(/return\s*\{\s*status:\s*(\d+),\s*body:\s*\{\s*error:\s*"([a-z_]+)"/g)) add(match[1], match[2]);
for (const match of handler.matchAll(/\n\s*(\d{3}),\s*\n\s*"([a-z_]+)",/g)) add(match[1], match[2]);
const conflicts = await readFile("supabase/functions/command/registration-conflicts.ts", "utf8");
for (const match of conflicts.matchAll(/status:\s*(\d+),\s*code:\s*"([a-z_]+)"/g)) add(match[1], match[2]);
const h0Forward = await readFile("supabase/functions/h0/forward.ts", "utf8");
for (const match of h0Forward.matchAll(/return json\((\d+),\s*\{ error: "([a-z_]+)" \}\)/g)) {
  if (Number(match[1]) < 500) add(match[1], match[2]);
}
const h0Core = await readFile("supabase/functions/h0/core.ts", "utf8");
for (const match of h0Core.matchAll(/return json\((404),\s*\{ error: "([a-z_]+)" \}\)/g)) add(match[1], match[2]);
if (rows.size < 9) throw new Error("register refusal enumeration unexpectedly small");
// Classify from the registration flow, before and after an existing seat can be found.
// A command-id conflict can occur on either side and cannot prove seat state.
const beforeAttempt = handler.slice(0, handler.indexOf("const attemptRows"));
const unused = new Set([...beforeAttempt.matchAll(/error:\s*"([a-z_]+)"/g)].map(match => match[1]));
unused.delete("command_id_conflict");
if (!/if \(credential\.seats_used >= credential\.seat_cap\)/.test(handler)) throw new Error("seat-cap guard missing");
if (!/if \(live >= FREE_TIER_PRINCIPAL_LIMIT\)/.test(handler)) throw new Error("principal-limit guard missing");
unused.add("principal_limit_reached");
for (const code of ["method_not_allowed", "payload_too_large", "not_found"]) unused.add(code);
const existingSeat = new Set([...conflicts.matchAll(/code:\s*"([a-z_]+)"/g)].map(match => match[1]));
existingSeat.add("join_credential_seat_cap_reached");
for (const code of [...unused, ...existingSeat]) if (!rows.has(code)) throw new Error(`classified refusal missing: ${code}`);
for (const code of existingSeat) if (unused.has(code)) throw new Error(`refusal has contradictory seat state: ${code}`);
const sorted = values => Object.fromEntries([...values].sort().map(code => [code, rows.get(code)]));
const output = `/** Generated from the h0 register and command handlers. Run node scripts/generate-mcp-register-refusals.mjs. */\nexport const REGISTER_REFUSALS: Readonly<Record<string, number>> = ${JSON.stringify(Object.fromEntries([...rows].sort(([a], [b]) => a.localeCompare(b))), null, 2)};\nexport const REGISTER_UNUSED_REFUSALS: Readonly<Record<string, number>> = ${JSON.stringify(sorted(unused), null, 2)};\nexport const REGISTER_EXISTING_SEAT_REFUSALS: Readonly<Record<string, number>> = ${JSON.stringify(sorted(existingSeat), null, 2)};\n`;
if (process.argv.includes("--check")) {
  const actual = await readFile("src/cloud/mcp-register-refusals.ts", "utf8");
  if (actual !== output) throw new Error("generated register refusal set is stale");
} else {
  await writeFile("src/cloud/mcp-register-refusals.ts", output);
}
