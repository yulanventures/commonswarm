/** site/public/api.md is the HTTP reference agents read instead of installing the CLI. These checks
 * derive the command kinds and read resources from the deployed edge source and fail when one is
 * neither named in the doc nor deliberately left out below with a reason. They check names and a
 * few load-bearing facts, never the doc's wording. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { SEAT_ADMIN_COMMAND_KINDS } from "../src/protocol/seat-admin.js";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const doc = read("site/public/api.md");
const commandDir = "supabase/functions/command";
const commandSources = ["index.ts", "file-artifacts.ts", "household-integration.ts", "human-receipts.ts",
  "durable-delivery.ts"].map((file) => read(`${commandDir}/${file}`));
const commandIndex = commandSources[0]!;
const readIndex = read("supabase/functions/read/index.ts");

const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

/** The members of `const NAME = [...]` or `const NAME = new Set([...])`, spreads and constants resolved. */
function kindList(name: string): string[] {
  for (const source of commandSources) {
    const match = new RegExp(`const ${name}(?:\\s*=\\s*new Set(?:<[^>]*>)?\\(|\\s*=\\s*)\\[([\\s\\S]*?)\\]`).exec(source);
    if (match) return stripComments(match[1]!).split(",").map((item) => item.trim()).filter(Boolean).flatMap(resolveItem);
  }
  throw new Error(`no list named ${name} in ${commandDir}`);
}

function resolveItem(item: string): string[] {
  const literal = /^["']([a-z0-9_]+)["']$/.exec(item);
  if (literal) return [literal[1]!];
  if (item.startsWith("...")) return kindList(item.slice(3));
  for (const source of commandSources) {
    const constant = new RegExp(`const ${item}\\s*=\\s*["']([a-z0-9_]+)["']`).exec(source);
    if (constant) return [constant[1]!];
  }
  throw new Error(`cannot resolve ${item}: a kind this test cannot read is a kind it cannot check`);
}

/** Every kind the command validator accepts (validateCommand refuses anything outside COMMAND_KINDS). */
const commandKinds = new Set(kindList("COMMAND_KINDS"));
assert.ok(commandIndex.includes("if (!(COMMAND_KINDS as readonly string[]).includes(cmd.kind))"),
  "COMMAND_KINDS is still the validator's allowlist");

/** Left out by source set: these lists also name kinds routed before validation. */
const UNDOCUMENTED_BY_SET: Record<string, string> = {
  ...Object.fromEntries(kindList("LOCAL_TRANSPORT_ONLY_KINDS").map((kind) => [kind, "cswarm's local listener and delivery machinery"])),
  ...Object.fromEntries(kindList("HOUSEHOLD_SURFACE_KINDS").filter((kind) => kind !== "household_tool")
    .map((kind) => [kind, "the web app's Lists & docs surface; agents use household_tool"])),
};

/** Accepted, and deliberately not documented in api.md. Each needs a reason. */
const UNDOCUMENTED_COMMANDS: Record<string, string> = {
  household_legacy: "compatibility path for old CLI brain and file calls",
  signals_seen: "seen receipts written by cswarm and the web app as messages are shown",
  touch_presence: "presence heartbeat written by cswarm and the web app",
  declare_agent_model: "cswarm reports its own model",
  set_agent_model: "web app agent settings",
  revoke_agent_token: "web app connection management",
  renew_agent_token: "cswarm's bounded renewal, described in prose under Getting an agent token",
  mint_agent_join_credential: "web app agent invitations",
  revoke_agent_join_credential: "web app agent invitations",
  register_agent_seat: "redeemed by cswarm with a join credential",
  revoke_invitation: "web app member management",
  remove_member: "web app member management",
  archive_workspace: "web app workspace settings",
  rename_workspace: "web app workspace settings",
  change_role: "web app member management",
  revoke_agent_principal: "web app agent management",
};

/** Every read resource the read function parses. */
const parseBody = readIndex.slice(readIndex.indexOf("function parseBody("), readIndex.indexOf("/** Log allowlisted fields only"));
assert.ok(parseBody.length > 1000, "found parseBody in read/index.ts");
const readResources = new Set([...parseBody.matchAll(/resource (?:===|!==) ["']([a-z_]+)["']/g)].map((m) => m[1]!));
const forwarded = /\[((?:"household[a-z_]*",?\s*)+)\]\.includes\(String\(contentBody\.resource\)\)/.exec(readIndex);
assert.ok(forwarded, "the household read forward still names its resources");
for (const m of forwarded[1]!.matchAll(/"([a-z_]+)"/g)) readResources.add(m[1]!);
const adminContract = read("supabase/functions/read/admin-recovery-contract.ts");
const adminResources = /ADMIN_READ_RESOURCES = \[([^\]]*)\]/.exec(adminContract);
assert.ok(adminResources, "ADMIN_READ_RESOURCES is readable");
const adminReadResources = [...adminResources[1]!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
// parseBody hands these to adminReadRequest through isAdminReadResource.
assert.ok(parseBody.includes("if (isAdminReadResource(body.resource)) return adminReadRequest(body);"));
for (const resource of adminReadResources) readResources.add(resource);

const UNDOCUMENTED_RESOURCES: Record<string, string> = {
  ...Object.fromEntries(adminReadResources.map((r) => [r, "admin recovery for the web app's admin pages"])),
  agent_wake_lease: "cswarm's local wake machinery",
  household_draft: "the web app's Lists & docs surface",
  household_access: "the web app's Lists & docs surface",
  delivery_receipts: "cswarm receipts view",
  renewal_grants: "cswarm and web app renewal state",
  pending_access: "web app pending-access list",
  human_invitations: "web app invitation inbox",
};

function documented(name: string): boolean {
  return doc.includes(`\`${name}\``) || doc.includes(`"${name}"`);
}

test("the extraction found the lists it claims to check", () => {
  assert.ok(commandKinds.size >= 40, `found ${commandKinds.size} command kinds`);
  assert.ok(readResources.size >= 15, `found ${readResources.size} read resources`);
  for (const kind of ["post_signal", "channel_create", "file_version_create", "memory_save", "household_tool"]) {
    assert.ok(commandKinds.has(kind), `${kind} extracted`);
  }
  for (const resource of ["signals", "channels", "channel_messages", "memory_search", "seat_admin_self", "household"]) {
    assert.ok(readResources.has(resource), `${resource} extracted`);
  }
});

test("every accepted command kind is documented or left out with a reason", () => {
  for (const kind of Object.keys(UNDOCUMENTED_COMMANDS)) {
    assert.ok(commandKinds.has(kind) || (SEAT_ADMIN_COMMAND_KINDS as readonly string[]).includes(kind),
      `${kind} is no longer accepted; drop it from UNDOCUMENTED_COMMANDS`);
  }
  const missing = [...commandKinds, ...SEAT_ADMIN_COMMAND_KINDS]
    .filter((kind) => !(kind in UNDOCUMENTED_COMMANDS) && !(kind in UNDOCUMENTED_BY_SET) && !documented(kind));
  assert.deepEqual(missing, [], "command kinds missing from site/public/api.md");
});

test("every read resource is documented or left out with a reason", () => {
  for (const resource of Object.keys(UNDOCUMENTED_RESOURCES)) {
    assert.ok(readResources.has(resource), `${resource} is no longer parsed; drop it from UNDOCUMENTED_RESOURCES`);
  }
  const missing = [...readResources].filter((r) => !(r in UNDOCUMENTED_RESOURCES) && !documented(r));
  assert.deepEqual(missing, [], "read resources missing from site/public/api.md");
});

test("the doc sends people to the app, not the retired /start handoff", () => {
  assert.ok(!/commonswarm\.com\/start\b/.test(doc), "commonswarm.com/start is gone from the doc");
  assert.ok(/https:\/\/commonswarm\.com\/app\b/.test(doc), "the doc names https://commonswarm.com/app");
});

test("an anonymous command is documented as 401, matching the edge", () => {
  // The edge: no bearer is 401 before the body is validated, even for a body it can't read.
  assert.match(commandIndex, /credential === null && parsed\.response\.status === 400 \? json\(401, \{ error: "unauthenticated" \}\)/);
  const errorRows = doc.split("\n").filter((line) => line.startsWith("| `4"));
  const unauthenticated = errorRows.find((line) => line.includes('"unauthenticated"'));
  assert.ok(unauthenticated?.startsWith("| `401`"), "the unauthenticated row is 401");
  assert.match(unauthenticated!, /no `authorization`/i, "the 401 row covers a request with no authorization header");
  const invalid = errorRows.find((line) => line.includes('"invalid_request"'));
  assert.ok(invalid, "the invalid_request row exists");
  assert.match(invalid!, /bearer present/i, "the 400 row says it applies only when a bearer was sent");
});

test("an ended person session is documented the way PostgREST reports it", () => {
  const fence = read("supabase/migrations/20261111000003_credential_change_fence.sql");
  assert.match(fence, /"code":"session_not_found"/);
  assert.match(fence, /"status":401/);
  assert.ok(doc.includes("session_not_found"), "the doc names session_not_found");
});
