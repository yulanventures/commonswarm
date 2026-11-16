/** Choice questions v2: a hosted MCP seat sends a choice ask through its ask tool only, as one
 * ask_choice, against local Supabase. Every other hosted tool is refused it, no hosted tool may send
 * answer_choice, and SWARM_INTERACTIVE_REPLIES must be on. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import postgres from "postgres";

const commandUrl = new URL("../../supabase/functions/command/index.ts", import.meta.url);
const authUrl = new URL("../../supabase/functions/_shared/hosted-seat-auth.ts", import.meta.url);

interface LocalEnvironment { API_URL: string; ANON_KEY: string; DB_URL: string; SERVICE_ROLE_KEY: string }
interface Fixture { owner: string; workspace: string; grant: string; principal: string; handle: string }
interface Result { status: number; body: Record<string, unknown> }
interface Step { tool: string; command: Record<string, unknown> }

let local: LocalEnvironment;
let sql: postgres.Sql;
let harnessDir: string;
let harnessPath: string;

// One Deno process runs a list of hosted calls, each with a fresh capability for its tool.
const harnessSource = `
const input = JSON.parse(await new Response(Deno.stdin.readable).text());
const command = await import(${JSON.stringify(commandUrl.href)});
const auth = await import(${JSON.stringify(authUrl.href)});

const results = [];
for (const step of input.steps) {
  const cap = await command.db.begin(async (tx) => await auth.authenticateHostedSeatCapability(tx, {
    grantId: input.grant, providerGrantId: "provider-" + input.grant, handle: input.handle, tool: step.tool,
    providerStatus: async () => ({ active: true }),
  }, "command"));
  if (cap === null) { results.push({ status: 403, body: { error: "no_capability" } }); continue; }
  results.push(await command.handleHostedCommand({ command_id: "mcpchoice_" + crypto.randomUUID(),
    client_version: "0.1.80", workspace_id: input.workspace, stream: { kind: "workspace" }, command: step.command }, cap));
}
console.log("HOSTED_CHOICE_RESULT:" + JSON.stringify(results));
await command.db.end({ timeout: 2 });
`;

before(() => {
  const status = JSON.parse(execFileSync("supabase", ["status", "-o", "json"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  })) as Partial<LocalEnvironment>;
  assert.ok(status.API_URL && status.ANON_KEY && status.DB_URL && status.SERVICE_ROLE_KEY);
  local = status as LocalEnvironment;
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(new URL(local.DB_URL).hostname));
  sql = postgres(local.DB_URL, { prepare: false, max: 5 });
  harnessDir = mkdtempSync(join(tmpdir(), "hosted-choice-"));
  harnessPath = join(harnessDir, "hosted-choice-harness.ts");
  writeFileSync(harnessPath, harnessSource);
});

after(async () => {
  await sql.end();
  rmSync(harnessDir, { recursive: true, force: true });
});

async function seedFixture(): Promise<Fixture> {
  const f: Fixture = {
    owner: randomUUID(), workspace: randomUUID(), grant: randomUUID(), principal: randomUUID(),
    handle: `seat_${randomUUID().replaceAll("-", "").slice(0, 22)}`,
  };
  const digest = new Uint8Array(32).fill(7);
  await sql.begin(async (tx) => {
    await tx`INSERT INTO auth.users (id, aud, role, email)
      VALUES (${f.owner}::uuid, 'authenticated', 'authenticated', ${`choice-${f.owner}@example.test`})`;
    await tx`INSERT INTO swarm.users (user_id, display_name) VALUES (${f.owner}::uuid, 'Hosted choice owner')`;
    await tx`INSERT INTO swarm.workspaces (workspace_id, name, created_by) VALUES (${f.workspace}::uuid, 'Hosted choices', ${f.owner}::uuid)`;
    await tx`INSERT INTO swarm.memberships (workspace_id, user_id, role) VALUES (${f.workspace}::uuid, ${f.owner}::uuid, 'owner')`;
    await tx`INSERT INTO swarm.streams (stream_id, workspace_id, kind) VALUES (${randomUUID()}::uuid, ${f.workspace}::uuid, 'workspace')`;
    await tx`INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name, transport, turn_only)
      VALUES (${f.principal}::uuid, ${f.workspace}::uuid, ${f.owner}::uuid, 'Choice seat', 'hosted_mcp', true)`;
    await tx`INSERT INTO swarm.hosted_mcp_grants (
      grant_id, provider_grant_id, owner_user_id, home_workspace_id, client_id, resource,
      selected_workspace_ids, manifest_digest, interaction_ref, state, created_at, activated_at
    ) VALUES (
      ${f.grant}::uuid, ${`provider-${f.grant}`}, ${f.owner}::uuid, ${f.workspace}::uuid, 'hosted-choice-client',
      'https://mcp.commonswarm.com/mcp', ${[f.workspace]}::uuid[], ${digest}, 'hosted-choice', 'active',
      statement_timestamp(), statement_timestamp()
    )`;
    await tx`INSERT INTO swarm.hosted_mcp_grant_workspaces (grant_id, workspace_id, owner_user_id, manifest_digest, consent_receipt_id, consented_at)
      VALUES (${f.grant}::uuid, ${f.workspace}::uuid, ${f.owner}::uuid, ${digest}, ${randomUUID()}::uuid, statement_timestamp())`;
    const seat = randomUUID();
    await tx`INSERT INTO swarm.hosted_mcp_seats (seat_id, grant_id, workspace_id, owner_user_id, principal_id, name, created_at)
      VALUES (${seat}::uuid, ${f.grant}::uuid, ${f.workspace}::uuid, ${f.owner}::uuid, ${f.principal}::uuid, 'Choice seat', statement_timestamp())`;
    await tx`INSERT INTO swarm.hosted_mcp_seat_handles (handle, seat_id, grant_id, workspace_id, principal_id, created_at)
      VALUES (${f.handle}, ${seat}::uuid, ${f.grant}::uuid, ${f.workspace}::uuid, ${f.principal}::uuid, statement_timestamp())`;
  });
  return f;
}

function run(f: Fixture, steps: Step[], interactive = true): Result[] {
  const result = spawnSync("deno", [
    "run", "--no-lock", "--config", "supabase/functions/command/deno.json",
    "--allow-env", "--allow-net", "--allow-read", harnessPath,
  ], {
    cwd: process.cwd(), encoding: "utf8",
    input: JSON.stringify({ grant: f.grant, workspace: f.workspace, handle: f.handle, steps }),
    env: {
      PATH: process.env.PATH ?? "",
      ...(process.env.DENO_DIR ? { DENO_DIR: process.env.DENO_DIR } : {}),
      SWARM_ENV: "test", SWARM_DATABASE_URL: local.DB_URL, SUPABASE_DB_URL: local.DB_URL,
      SUPABASE_URL: local.API_URL, SUPABASE_ANON_KEY: local.ANON_KEY, SUPABASE_SERVICE_ROLE_KEY: local.SERVICE_ROLE_KEY,
      ...(interactive ? { SWARM_INTERACTIVE_REPLIES: "1" } : {}),
    },
    timeout: 120_000,
  });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const line = result.stdout.trim().split("\n").reverse().find((entry) => entry.startsWith("HOSTED_CHOICE_RESULT:"));
  assert.equal(typeof line, "string", result.stdout);
  return JSON.parse((line ?? "").slice("HOSTED_CHOICE_RESULT:".length)) as Result[];
}

const OPTIONS = [
  { id: "cancel", label: "Cancel the release", recommended: true },
  { id: "ship", label: "Ship it", description: "Tonight, after CI" },
];

test("a hosted seat's ask tool sends one ask_choice; no other tool can, and none can answer", async () => {
  const f = await seedFixture();
  const ask = (extra: Record<string, unknown> = {}) => ({
    kind: "ask_choice", body: "Which release plan?", to_user_id: f.owner, about: null, options: OPTIONS, multi: true, ...extra,
  });
  const [sent, extraKey, asNote, asReply, answering, unaddressed] = run(f, [
    { tool: "ask", command: ask() },
    { tool: "ask", command: ask({ attachments: [] }) },
    { tool: "note", command: ask() },
    { tool: "reply", command: ask() },
    { tool: "ask", command: { kind: "answer_choice", signal_id: randomUUID(), option_id: "ship" } },
    { tool: "ask", command: ask({ to_user_id: null }) },
  ]);
  assert.equal(sent!.status, 200, JSON.stringify(sent));
  assert.deepEqual(sent!.body.choice_options, OPTIONS);
  const askId = (sent!.body.signal as { id: string }).id;
  const stored = (await sql`
    SELECT c.multi, s.from_kind, s.from_principal, s.to_user_id
    FROM swarm.ask_choices c JOIN swarm.signals s ON s.id = c.signal_id
    WHERE c.signal_id = ${askId}::uuid`).map((row) => ({ ...row }));
  assert.deepEqual(stored, [{ multi: true, from_kind: "agent", from_principal: f.principal, to_user_id: f.owner }]);
  for (const [name, refused] of [["a key ask_choice doesn't take", extraKey], ["the note tool", asNote],
    ["the reply tool", asReply], ["answer_choice from the ask tool", answering]] as const) {
    assert.deepEqual({ status: refused!.status, body: refused!.body }, { status: 403, body: { error: "forbidden" } }, name);
  }
  assert.equal(unaddressed!.status, 200, `an ask addressed to nobody: ${JSON.stringify(unaddressed)}`);
});

test("a hosted choice ask is refused while SWARM_INTERACTIVE_REPLIES is off", async () => {
  const f = await seedFixture();
  const [off] = run(f, [{ tool: "ask", command: {
    kind: "ask_choice", body: "Which?", to_user_id: f.owner, about: null, options: OPTIONS,
  } }], false);
  assert.equal(off!.status, 404, JSON.stringify(off));
  assert.equal(off!.body.error, "interactive_replies_unavailable");
});
