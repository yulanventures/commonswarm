/** Brain M3b: hosted MCP seats save, search, read and forget workspace memories against local
 * Supabase. Each capability binds its exact memory operation, the seat's own workspace is the only
 * one it reaches, and both SWARM_BRAIN_MEMORY and SWARM_BRAIN_MEMORY_HOSTED must be on. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import postgres from "postgres";

const commandUrl = new URL("../../supabase/functions/command/index.ts", import.meta.url);
const readUrl = new URL("../../supabase/functions/read/index.ts", import.meta.url);
const authUrl = new URL("../../supabase/functions/_shared/hosted-seat-auth.ts", import.meta.url);

interface LocalEnvironment { API_URL: string; ANON_KEY: string; DB_URL: string; SERVICE_ROLE_KEY: string }
interface Fixture { owner: string; workspace: string; grant: string; principalA: string; principalB: string; handleA: string; handleB: string }
interface Result { status: number; body: Record<string, unknown> }
type Step =
  | { op: "command"; handle: string; tool: string; command_id?: string; command: Record<string, unknown> }
  | { op: "read"; handle: string; tool: string; input: Record<string, unknown> };

let local: LocalEnvironment;
let sql: postgres.Sql;
let harnessDir: string;
let harnessPath: string;

// One Deno process runs a list of hosted calls, each with a fresh capability for its tool.
const harnessSource = `
const input = JSON.parse(await new Response(Deno.stdin.readable).text());
const command = await import(${JSON.stringify(commandUrl.href)});
const read = await import(${JSON.stringify(readUrl.href)});
const auth = await import(${JSON.stringify(authUrl.href)});

async function capability(handle, tool, use) {
  return await command.db.begin(async (tx) => await auth.authenticateHostedSeatCapability(tx, {
    grantId: input.grant, providerGrantId: "provider-" + input.grant, handle, tool,
    providerStatus: async () => ({ active: true }),
  }, use));
}

const results = [];
for (const step of input.steps) {
  const cap = await capability(step.handle, step.tool, step.op === "read" ? "read" : "command");
  if (cap === null) { results.push({ status: 403, body: { error: "no_capability" } }); continue; }
  if (step.op === "read") {
    results.push(await read.handleHostedRead({ workspace_id: input.workspace, ...step.input }, cap));
  } else {
    results.push(await command.handleHostedCommand({ command_id: step.command_id ?? "mcpmem_" + crypto.randomUUID(),
      client_version: "0.1.80", workspace_id: input.workspace, stream: { kind: "workspace" }, command: step.command }, cap));
  }
}
console.log("HOSTED_MEMORY_RESULT:" + JSON.stringify(results));
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
  harnessDir = mkdtempSync(join(tmpdir(), "hosted-memory-"));
  harnessPath = join(harnessDir, "hosted-memory-harness.ts");
  writeFileSync(harnessPath, harnessSource);
});

after(async () => {
  await sql.end();
  rmSync(harnessDir, { recursive: true, force: true });
});

async function seedFixture(): Promise<Fixture> {
  const handle = () => `seat_${randomUUID().replaceAll("-", "").slice(0, 22)}`;
  const f: Fixture = {
    owner: randomUUID(), workspace: randomUUID(), grant: randomUUID(),
    principalA: randomUUID(), principalB: randomUUID(), handleA: handle(), handleB: handle(),
  };
  const digest = new Uint8Array(32).fill(9);
  await sql.begin(async (tx) => {
    await tx`INSERT INTO auth.users (id, aud, role, email)
      VALUES (${f.owner}::uuid, 'authenticated', 'authenticated', ${`memory-${f.owner}@example.test`})`;
    await tx`INSERT INTO swarm.users (user_id, display_name) VALUES (${f.owner}::uuid, 'Hosted memory owner')`;
    await tx`INSERT INTO swarm.workspaces (workspace_id, name, created_by) VALUES (${f.workspace}::uuid, 'Hosted memory', ${f.owner}::uuid)`;
    await tx`INSERT INTO swarm.memberships (workspace_id, user_id, role) VALUES (${f.workspace}::uuid, ${f.owner}::uuid, 'owner')`;
    await tx`INSERT INTO swarm.streams (stream_id, workspace_id, kind) VALUES (${randomUUID()}::uuid, ${f.workspace}::uuid, 'workspace')`;
    for (const [principal, name] of [[f.principalA, "Memory A"], [f.principalB, "Memory B"]]) {
      await tx`INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name, transport, turn_only)
        VALUES (${principal}::uuid, ${f.workspace}::uuid, ${f.owner}::uuid, ${name}, 'hosted_mcp', true)`;
    }
    await tx`INSERT INTO swarm.hosted_mcp_grants (
      grant_id, provider_grant_id, owner_user_id, home_workspace_id, client_id, resource,
      selected_workspace_ids, manifest_digest, interaction_ref, state, created_at, activated_at
    ) VALUES (
      ${f.grant}::uuid, ${`provider-${f.grant}`}, ${f.owner}::uuid, ${f.workspace}::uuid, 'hosted-memory-client',
      'https://mcp.commonswarm.com/mcp', ${[f.workspace]}::uuid[], ${digest}, 'hosted-memory', 'active',
      statement_timestamp(), statement_timestamp()
    )`;
    await tx`INSERT INTO swarm.hosted_mcp_grant_workspaces (grant_id, workspace_id, owner_user_id, manifest_digest, consent_receipt_id, consented_at)
      VALUES (${f.grant}::uuid, ${f.workspace}::uuid, ${f.owner}::uuid, ${digest}, ${randomUUID()}::uuid, statement_timestamp())`;
    for (const [principal, name, h] of [[f.principalA, "Memory A", f.handleA], [f.principalB, "Memory B", f.handleB]]) {
      const seat = randomUUID();
      await tx`INSERT INTO swarm.hosted_mcp_seats (seat_id, grant_id, workspace_id, owner_user_id, principal_id, name, created_at)
        VALUES (${seat}::uuid, ${f.grant}::uuid, ${f.workspace}::uuid, ${f.owner}::uuid, ${principal}::uuid, ${name}, statement_timestamp())`;
      await tx`INSERT INTO swarm.hosted_mcp_seat_handles (handle, seat_id, grant_id, workspace_id, principal_id, created_at)
        VALUES (${h}, ${seat}::uuid, ${f.grant}::uuid, ${f.workspace}::uuid, ${principal}::uuid, statement_timestamp())`;
    }
  });
  return f;
}

function run(f: Fixture, steps: Step[], flags: { memory?: boolean; hosted?: boolean } = {}): Result[] {
  const result = spawnSync("deno", [
    "run", "--no-lock", "--config", "supabase/functions/command/deno.json",
    "--allow-env", "--allow-net", "--allow-read", harnessPath,
  ], {
    cwd: process.cwd(), encoding: "utf8",
    input: JSON.stringify({ grant: f.grant, workspace: f.workspace, steps }),
    env: {
      PATH: process.env.PATH ?? "",
      ...(process.env.DENO_DIR ? { DENO_DIR: process.env.DENO_DIR } : {}),
      SWARM_ENV: "test", SWARM_DATABASE_URL: local.DB_URL, SUPABASE_DB_URL: local.DB_URL,
      SUPABASE_URL: local.API_URL, SUPABASE_ANON_KEY: local.ANON_KEY, SUPABASE_SERVICE_ROLE_KEY: local.SERVICE_ROLE_KEY,
      ...(flags.memory === false ? {} : { SWARM_BRAIN_MEMORY: "1" }),
      ...(flags.hosted === false ? {} : { SWARM_BRAIN_MEMORY_HOSTED: "1" }),
    },
    timeout: 120_000,
  });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const line = result.stdout.trim().split("\n").reverse().find((entry) => entry.startsWith("HOSTED_MEMORY_RESULT:"));
  assert.equal(typeof line, "string", result.stdout);
  return JSON.parse((line ?? "").slice("HOSTED_MEMORY_RESULT:".length)) as Result[];
}

const save = (handle: string, statement: string, extra: Record<string, unknown> = {}, commandId?: string): Step => ({
  op: "command", handle, tool: "memory_save", ...(commandId === undefined ? {} : { command_id: commandId }),
  command: { kind: "memory_save", memory_kind: "convention", subject: "release day", statement, evidence: [], ...extra },
});

test("a hosted seat saves, searches, reads and forgets its own memory, as its agent", async () => {
  const f = await seedFixture();
  const [created, replayed, search, duplicate] = run(f, [
    save(f.handleA, "Releases go out on Tuesdays.", {}, "mcpmem_first_save"),
    save(f.handleA, "Releases go out on Tuesdays.", {}, "mcpmem_first_save"),
    { op: "read", handle: f.handleA, tool: "memory_search", input: { resource: "memory_search", query: "tuesday", limit: 5 } },
    save(f.handleB, "Releases go out on Tuesdays."),
  ]);
  assert.equal(created!.status, 200, JSON.stringify(created));
  assert.equal(created!.body.memory_outcome, "created");
  const memory = created!.body.memory as { memory_id: string; revision: number };
  assert.deepEqual(replayed, created, "the same request_id replays the stored result");
  assert.equal(search!.status, 200, JSON.stringify(search));
  assert.equal(search!.body.untrusted_content, true);
  assert.ok(search!.body.context, "hosted reads carry the connection context");
  const rows = search!.body.memories as Array<{ memory_id: string; author: { kind: string; id: string } }>;
  assert.deepEqual(rows.map((row) => row.memory_id), [memory.memory_id]);
  assert.deepEqual(rows[0]!.author, { kind: "agent", id: f.principalA }, "authorship comes from the seat's agent");
  assert.equal(duplicate!.body.memory_outcome, "duplicate", "another seat saving the same statement changes nothing");

  const [conflict, updated, detail, notMine, forgotten, gone] = run(f, [
    save(f.handleB, "Releases go out on Wednesdays."),
    save(f.handleB, "Releases go out on Wednesdays.", { expected_revision: memory.revision }),
    { op: "read", handle: f.handleA, tool: "memory_get", input: { resource: "memory_get", memory_id: memory.memory_id } },
    { op: "command", handle: f.handleB, tool: "memory_forget", command: { kind: "memory_forget", memory_id: memory.memory_id } },
    { op: "command", handle: f.handleA, tool: "memory_forget", command: { kind: "memory_forget", memory_id: memory.memory_id } },
    { op: "read", handle: f.handleA, tool: "memory_get", input: { resource: "memory_get", memory_id: memory.memory_id } },
  ]);
  assert.equal(conflict!.status, 409);
  assert.equal(conflict!.body.error, "memory_exists");
  assert.equal((conflict!.body.memory as { revision: number }).revision, memory.revision);
  assert.equal(updated!.body.memory_outcome, "updated", JSON.stringify(updated));
  assert.equal(updated!.body.previous_statement, "Releases go out on Tuesdays.");
  assert.equal(detail!.status, 200, JSON.stringify(detail));
  assert.equal((detail!.body.versions as unknown[]).length, 2);
  assert.equal(notMine!.status, 404, "only the original author's agent can forget it");
  assert.equal(forgotten!.body.memory_outcome, "forgotten", JSON.stringify(forgotten));
  assert.equal(gone!.status, 404);
  assert.equal(gone!.body.error, "not_found");
});

test("each capability carries only its own memory operation, in its own workspace", async () => {
  const f = await seedFixture();
  const [seeded] = run(f, [save(f.handleA, "Deploys need a backup first.")]);
  const memoryId = (seeded!.body.memory as { memory_id: string }).memory_id;
  const results = run(f, [
    // Writes: another tool can't send a memory command, and a memory tool can't send anything else.
    { op: "command", handle: f.handleA, tool: "note", command: { kind: "memory_save", memory_kind: "fact", subject: "x", statement: "y" } },
    { op: "command", handle: f.handleA, tool: "memory_save", command: { kind: "memory_forget", memory_id: memoryId } },
    { op: "command", handle: f.handleA, tool: "memory_forget", command: { kind: "memory_save", memory_kind: "fact", subject: "x", statement: "y" } },
    { op: "command", handle: f.handleA, tool: "memory_save", command: { kind: "post_signal", signal_kind: "note", body: "hi",
      to_user_id: null, to_agent_principal_id: null, in_reply_to: null, about: null } },
    { op: "command", handle: f.handleA, tool: "memory_save", command: { kind: "memory_save", memory_kind: "fact", subject: "x",
      statement: "y", extra: true } },
    // Reads: each capability reads only its own resource, and only the seat's workspace.
    { op: "read", handle: f.handleA, tool: "memory_search", input: { resource: "memory_get", memory_id: memoryId } },
    { op: "read", handle: f.handleA, tool: "memory_get", input: { resource: "memory_search", query: null, limit: 5 } },
    { op: "read", handle: f.handleA, tool: "channel_read", input: { resource: "memory_search", query: null, limit: 5 } },
    { op: "read", handle: f.handleA, tool: "memory_search", input: { resource: "memory_search", query: null, limit: 5, workspace_id: randomUUID() } },
    { op: "read", handle: f.handleA, tool: "memory_search", input: { resource: "memory_search", query: "x".repeat(201), limit: 5 } },
  ]);
  for (const [index, result] of results.entries()) {
    assert.ok(result.status === 403 || result.status === 400, `step ${index}: ${JSON.stringify(result)}`);
    assert.equal(JSON.stringify(result).includes("Deploys need a backup"), false, `step ${index} leaks no memory text`);
  }
});

test("hosted memory needs both switches; local memory alone isn't enough", async () => {
  const f = await seedFixture();
  for (const flags of [{ hosted: false }, { memory: false }]) {
    const results = run(f, [
      save(f.handleA, "Off means off."),
      { op: "read", handle: f.handleA, tool: "memory_search", input: { resource: "memory_search", query: null, limit: 5 } },
      { op: "read", handle: f.handleA, tool: "memory_get", input: { resource: "memory_get", memory_id: randomUUID() } },
    ], flags);
    for (const result of results) {
      assert.equal(result.status, 404, `${JSON.stringify(flags)}: ${JSON.stringify(result)}`);
      assert.equal(result.body.error, "memory_unavailable");
    }
  }
  const [count] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM swarm.memories WHERE workspace_id = ${f.workspace}::uuid`;
  assert.equal(count!.n, 0, "nothing was saved while either switch was off");
});
