/** Hosted MCP file_ls / file_get against local Supabase (manual `server` suite).
 *
 * Covers the HezSec conditions for MCP parity phase 1: full seat revalidation on every
 * call, the seat's own workspace on every query, the message ACL for signal_id, live
 * file/version state (household, tombstone, cross-workspace), and no signed path or
 * storage error crossing into what the agent sees. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import postgres from "postgres";

const commandUrl = new URL("../../supabase/functions/command/index.ts", import.meta.url);
const readUrl = new URL("../../supabase/functions/read/index.ts", import.meta.url);
const authUrl = new URL("../../supabase/functions/_shared/hosted-seat-auth.ts", import.meta.url);
const contentUrl = new URL("../../supabase/functions/mcp/file-content.ts", import.meta.url);

interface LocalEnvironment { API_URL: string; ANON_KEY: string; DB_URL: string; SERVICE_ROLE_KEY: string }
interface Fixture {
  owner: string; ownerJwt: string; workspace: string; grant: string;
  principalA: string; principalB: string; seatA: string; handleA: string; handleB: string;
}
interface Result { status: number; body: Record<string, unknown> }

let local: LocalEnvironment;
let sql: postgres.Sql;
let admin: SupabaseClient;
let harnessDir: string;
let harnessPath: string;

const harnessSource = `
const input = JSON.parse(await new Response(Deno.stdin.readable).text());
const command = await import(${JSON.stringify(commandUrl.href)});
const read = await import(${JSON.stringify(readUrl.href)});
const auth = await import(${JSON.stringify(authUrl.href)});
const content = await import(${JSON.stringify(contentUrl.href)});

async function capability(handle, tool, use) {
  return await command.db.begin(async (tx) => await auth.authenticateHostedSeatCapability(tx, {
    grantId: input.grant, providerGrantId: "provider-" + input.grant, handle, tool,
    providerStatus: async () => ({ active: true }),
  }, use));
}

async function owner(cmd) {
  const response = await command.handleRequest(new Request("http://local/functions/v1/command", {
    method: "POST",
    headers: { authorization: "Bearer " + input.ownerJwt, "content-type": "application/json" },
    body: JSON.stringify({ command_id: crypto.randomUUID(), client_version: "0.1.0",
      workspace_id: input.workspace, stream: { kind: "workspace" }, command: cmd }),
  }));
  return { status: response.status, body: await response.json() };
}

async function upload(name, contentType, text) {
  const bytes = new TextEncoder().encode(text);
  const fileId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const created = await owner({ kind: "file_version_create", file_id: fileId, version_id: versionId,
    name, declared_size_bytes: bytes.length, content_type: contentType });
  if (created.status !== 200) return created;
  const put = await fetch(input.apiUrl + created.body.upload_path, {
    method: "PUT", headers: { "content-type": contentType }, body: bytes });
  if (!put.ok) return { status: put.status, body: { error: "put_failed" } };
  return await owner({ kind: "file_version_commit", file_id: fileId, version_id: versionId, sha256: null });
}

async function ls(handle, extra = {}) {
  const cap = await capability(handle, "file_ls", "read");
  if (cap === null) return { status: 403, body: { error: "forbidden" } };
  return await read.handleHostedRead({ resource: "files", workspace_id: input.workspace, ...extra }, cap);
}

async function get(handle, fileId, versionN = null, tool = "file_get") {
  const cap = await capability(handle, tool, "command");
  if (cap === null) return { status: 403, body: { error: "forbidden" } };
  const result = await command.handleHostedCommand({ command_id: "mcpfile_" + crypto.randomUUID(),
    client_version: "0.1.80", workspace_id: input.workspace, stream: { kind: "workspace" },
    command: { kind: "file_download_url", file_id: fileId, version_n: versionN } }, cap);
  if (result.status !== 200) return result;
  // The same reader the hosted tool uses; the signed path stays in this process.
  const bytes = await content.readObjectPage(input.apiUrl, String(result.body.download_path), input.offset ?? 0, 64);
  const page = content.textPage(bytes, input.offset ?? 0, Number(result.body.size_bytes), 64);
  return { status: 200, body: { name: result.body.name, version_n: result.body.version_n, page } };
}

const op = input.operation;
let result;
if (op === "upload") result = await upload(input.name, input.contentType, input.text);
else if (op === "note") result = await owner({ kind: "post_signal", signal_kind: "note", body: "files for you",
  to_user_id: null, to_agent_principal_id: input.to, in_reply_to: null, about: null,
  attachments: input.attachments });
else if (op === "tombstone") result = await owner({ kind: "file_tombstone", file_id: input.fileId });
else if (op === "ls") result = await ls(input.handle, input.extra ?? {});
else if (op === "get") result = await get(input.handle, input.fileId, input.versionN ?? null, input.tool ?? "file_get");
else if (op === "wrong-kind") {
  // A file_get capability cannot carry any other command, and no other tool can download.
  const fileCap = await capability(input.handle, "file_get", "command");
  const noteCap = await capability(input.handle, "note", "command");
  const base = { client_version: "0.1.80", workspace_id: input.workspace, stream: { kind: "workspace" } };
  result = {
    tombstone: await command.handleHostedCommand({ ...base, command_id: crypto.randomUUID(),
      command: { kind: "file_tombstone", file_id: input.fileId } }, fileCap),
    extraKey: await command.handleHostedCommand({ ...base, command_id: crypto.randomUUID(),
      command: { kind: "file_download_url", file_id: input.fileId, version_n: null, url: "x" } }, fileCap),
    viaNote: await command.handleHostedCommand({ ...base, command_id: crypto.randomUUID(),
      command: { kind: "file_download_url", file_id: input.fileId, version_n: null } }, noteCap),
  };
} else throw new Error("unknown operation");
console.log("HOSTED_FILES_RESULT:" + JSON.stringify(result));
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
  admin = createClient(local.API_URL, local.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  harnessDir = mkdtempSync(join(tmpdir(), "hosted-files-"));
  harnessPath = join(harnessDir, "hosted-files-harness.ts");
  writeFileSync(harnessPath, harnessSource);
});

after(async () => {
  await sql.end();
  rmSync(harnessDir, { recursive: true, force: true });
});

async function createAuthUser(label: string): Promise<{ id: string; jwt: string }> {
  const email = `${label}-${randomUUID()}@example.test`;
  const password = `T-${randomBytes(24).toString("base64url")}!`;
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  assert.ifError(created.error);
  const client = createClient(local.API_URL, local.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const signedIn = await client.auth.signInWithPassword({ email, password });
  assert.ifError(signedIn.error);
  return { id: created.data.user!.id, jwt: signedIn.data.session!.access_token };
}

async function seedFixture(label: string): Promise<Fixture> {
  const owner = await createAuthUser(label);
  const handle = () => `seat_${randomUUID().replaceAll("-", "").slice(0, 22)}`;
  const f: Fixture = {
    owner: owner.id, ownerJwt: owner.jwt, workspace: randomUUID(), grant: randomUUID(),
    principalA: randomUUID(), principalB: randomUUID(), seatA: randomUUID(),
    handleA: handle(), handleB: handle(),
  };
  const seatB = randomUUID();
  const digest = new Uint8Array(32).fill(7);
  await sql.begin(async (tx) => {
    await tx`INSERT INTO swarm.users (user_id, display_name) VALUES (${f.owner}::uuid, 'Hosted files owner')`;
    await tx`INSERT INTO swarm.workspaces (workspace_id, name, created_by) VALUES (${f.workspace}::uuid, 'Hosted files', ${f.owner}::uuid)`;
    await tx`INSERT INTO swarm.memberships (workspace_id, user_id, role) VALUES (${f.workspace}::uuid, ${f.owner}::uuid, 'owner')`;
    await tx`INSERT INTO swarm.streams (stream_id, workspace_id, kind) VALUES (${randomUUID()}::uuid, ${f.workspace}::uuid, 'workspace')`;
    for (const [principal, name] of [[f.principalA, "Files A"], [f.principalB, "Files B"]]) {
      await tx`INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name, transport, turn_only)
        VALUES (${principal}::uuid, ${f.workspace}::uuid, ${f.owner}::uuid, ${name}, 'hosted_mcp', true)`;
    }
    await tx`INSERT INTO swarm.hosted_mcp_grants (
      grant_id, provider_grant_id, owner_user_id, home_workspace_id, client_id, resource,
      selected_workspace_ids, manifest_digest, interaction_ref, state, created_at, activated_at
    ) VALUES (
      ${f.grant}::uuid, ${`provider-${f.grant}`}, ${f.owner}::uuid, ${f.workspace}::uuid, 'hosted-files-client',
      'https://mcp.commonswarm.com/mcp', ${[f.workspace]}::uuid[], ${digest}, 'hosted-files', 'active',
      statement_timestamp(), statement_timestamp()
    )`;
    await tx`INSERT INTO swarm.hosted_mcp_grant_workspaces (grant_id, workspace_id, owner_user_id, manifest_digest, consent_receipt_id, consented_at)
      VALUES (${f.grant}::uuid, ${f.workspace}::uuid, ${f.owner}::uuid, ${digest}, ${randomUUID()}::uuid, statement_timestamp())`;
    for (const [seat, principal, name, h] of [[f.seatA, f.principalA, "Files A", f.handleA], [seatB, f.principalB, "Files B", f.handleB]]) {
      await tx`INSERT INTO swarm.hosted_mcp_seats (seat_id, grant_id, workspace_id, owner_user_id, principal_id, name, created_at)
        VALUES (${seat}::uuid, ${f.grant}::uuid, ${f.workspace}::uuid, ${f.owner}::uuid, ${principal}::uuid, ${name}, statement_timestamp())`;
      await tx`INSERT INTO swarm.hosted_mcp_seat_handles (handle, seat_id, grant_id, workspace_id, principal_id, created_at)
        VALUES (${h}, ${seat}::uuid, ${f.grant}::uuid, ${f.workspace}::uuid, ${principal}::uuid, statement_timestamp())`;
    }
  });
  return f;
}

function run<T>(f: Fixture, input: Record<string, unknown>): T {
  const result = spawnSync("deno", [
    "run", "--no-lock", "--config", "supabase/functions/command/deno.json",
    "--allow-env", "--allow-net", "--allow-read", harnessPath,
  ], {
    cwd: process.cwd(), encoding: "utf8",
    input: JSON.stringify({ grant: f.grant, workspace: f.workspace, ownerJwt: f.ownerJwt, apiUrl: local.API_URL, ...input }),
    env: {
      PATH: process.env.PATH ?? "",
      ...(process.env.DENO_DIR ? { DENO_DIR: process.env.DENO_DIR } : {}),
      SWARM_ENV: "test", SWARM_DATABASE_URL: local.DB_URL, SUPABASE_DB_URL: local.DB_URL,
      SUPABASE_URL: local.API_URL, SUPABASE_ANON_KEY: local.ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY: local.SERVICE_ROLE_KEY,
    },
    timeout: 90_000,
  });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const line = result.stdout.trim().split("\n").reverse().find((entry) => entry.startsWith("HOSTED_FILES_RESULT:"));
  assert.equal(typeof line, "string", result.stdout);
  return JSON.parse((line ?? "").slice("HOSTED_FILES_RESULT:".length)) as T;
}

function uploaded(f: Fixture, name: string, text: string, contentType = "text/plain"): { file_id: string; version_n: number } {
  const result = run<Result>(f, { operation: "upload", name, contentType, text });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return { file_id: String(result.body.file_id), version_n: Number(result.body.version_n) };
}

function noSecret(value: unknown): void {
  const text = JSON.stringify(value);
  assert.equal(/storage\/v1|token=|download_path|upload_path/u.test(text), false, text);
}

test("file_ls lists the seat's workspace and file_get pages text from the resolved version", async () => {
  const fixture = await seedFixture("hosted-files-owner");
  {
    const notes = uploaded(fixture, "notes.txt", "Grocery list: eggs, milk, bread €");
    const listed = run<Result>(fixture, { operation: "ls", handle: fixture.handleA });
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    const files = listed.body.files as Array<Record<string, unknown>>;
    assert.ok(files.some((row) => row.file_id === notes.file_id && row.version_n === notes.version_n && row.name === "notes.txt"));
    assert.equal(typeof listed.body.content_warning, "string");

    const first = run<Result>(fixture, { operation: "get", handle: fixture.handleA, fileId: notes.file_id, versionN: notes.version_n });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal((first.body.page as { text: string }).text, "Grocery list: eggs, milk, bread €");
    noSecret(first.body);
    const paged = run<Result>(fixture, { operation: "get", handle: fixture.handleA, fileId: notes.file_id, offset: 14 });
    assert.equal((paged.body.page as { text: string; offset: number }).text, "eggs, milk, bread €");
  }
});

test("signal_id lists attachments only for a message addressed to this seat", async () => {
  const f = await seedFixture("hosted-files-signal");
  const report = uploaded(f, "report.md", "# Report\n", "text/markdown");
  const posted = run<Result>(f, { operation: "note", to: f.principalA, attachments: [report] });
  assert.equal(posted.status, 200, JSON.stringify(posted.body));
  const signalId = String((posted.body.signal as { id: string }).id);

  const addressed = run<Result>(f, { operation: "ls", handle: f.handleA, extra: { signal_id: signalId } });
  assert.equal(addressed.status, 200, JSON.stringify(addressed.body));
  assert.deepEqual((addressed.body.files as Array<Record<string, unknown>>).map((row) => [row.file_id, row.version_n]),
    [[report.file_id, report.version_n]]);
  const other = run<Result>(f, { operation: "ls", handle: f.handleB, extra: { signal_id: signalId } });
  assert.deepEqual(other, { status: 403, body: { error: "signal_unavailable" } });
  const unknown = run<Result>(f, { operation: "ls", handle: f.handleA, extra: { signal_id: randomUUID() } });
  assert.deepEqual(unknown, { status: 403, body: { error: "signal_unavailable" } }, "no existence oracle");
});

test("file_get refuses another workspace, household files, tombstones and revoked seats", async () => {
  const f = await seedFixture("hosted-files-gates");
  const foreignOwner = await seedFixture("hosted-files-foreign");
  const foreign = uploaded(foreignOwner, "secret.txt", "other workspace");
  const crossGet = run<Result>(f, { operation: "get", handle: f.handleA, fileId: foreign.file_id });
  assert.equal(crossGet.status, 404, JSON.stringify(crossGet.body));
  assert.equal(crossGet.body.error, "file_not_found");
  const crossList = run<Result>(f, { operation: "ls", handle: f.handleA });
  assert.equal((crossList.body.files as Array<Record<string, unknown>>).some((row) => row.file_id === foreign.file_id), false);

  const managed = uploaded(f, "managed.txt", "household");
  await sql`UPDATE swarm.files SET household_managed = true WHERE file_id = ${managed.file_id}::uuid`;
  const managedGet = run<Result>(f, { operation: "get", handle: f.handleA, fileId: managed.file_id });
  assert.equal(managedGet.status, 403);
  assert.equal(managedGet.body.error, "household_managed_file");

  const removed = uploaded(f, "removed.txt", "gone");
  assert.equal(run<Result>(f, { operation: "tombstone", fileId: removed.file_id }).status, 200);
  const removedGet = run<Result>(f, { operation: "get", handle: f.handleA, fileId: removed.file_id });
  assert.equal(removedGet.status, 409);
  assert.equal(removedGet.body.error, "file_tombstoned");
  const afterTombstone = run<Result>(f, { operation: "ls", handle: f.handleA });
  assert.equal((afterTombstone.body.files as Array<Record<string, unknown>>).some((row) => row.file_id === removed.file_id), false);

  const live = uploaded(f, "live.txt", "still here");
  await sql`UPDATE swarm.hosted_mcp_seats SET revoked_at = statement_timestamp() WHERE seat_id = ${f.seatA}::uuid`;
  await sql`UPDATE swarm.hosted_mcp_seat_handles SET revoked_at = statement_timestamp() WHERE seat_id = ${f.seatA}::uuid`;
  assert.equal(run<Result>(f, { operation: "get", handle: f.handleA, fileId: live.file_id }).status, 403);
  assert.equal(run<Result>(f, { operation: "ls", handle: f.handleA }).status, 403);
  // Owner membership alone is not enough: the owner is still a member here.
  assert.equal(run<Result>(f, { operation: "get", handle: f.handleB, fileId: live.file_id }).status, 200, "sibling seat control");
});

test("a file_get capability carries only an exact download, and no other tool can download", async () => {
  const f = await seedFixture("hosted-files-kinds");
  const file = uploaded(f, "kinds.txt", "kinds");
  const result = run<Record<string, Result>>(f, { operation: "wrong-kind", handle: f.handleA, fileId: file.file_id });
  assert.deepEqual(result.tombstone, { status: 403, body: { error: "forbidden" } });
  assert.deepEqual(result.extraKey, { status: 403, body: { error: "forbidden" } });
  assert.deepEqual(result.viaNote, { status: 403, body: { error: "forbidden" } });
});
