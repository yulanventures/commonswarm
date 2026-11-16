/** The hosted reply_target read against local Supabase, through handleHostedRead with real seat
 * capabilities: it admits exactly what channel_read (swarm_read.channel_messages) would show, and
 * answers expired, addressed, hidden and unknown targets with the same null. The hosted reply then
 * places itself from that answer: a thread reply for the live message, and for the others the
 * private reply the server refuses the same way. */
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
const toolsUrl = new URL("../../supabase/functions/mcp/signal-tools.ts", import.meta.url);

interface LocalEnvironment { API_URL: string; ANON_KEY: string; DB_URL: string; SERVICE_ROLE_KEY: string }
interface Fixture { owner: string; workspace: string; grant: string; principalA: string; principalB: string; handleA: string; handleB: string }
interface Result { status: number; body: Record<string, unknown> }
type Step =
  | { op: "read"; handle: string; tool: string; input: Record<string, unknown> }
  | { op: "reply"; handle: string; signal_id: string; request_id: string };

let local: LocalEnvironment;
let sql: postgres.Sql;
let harnessDir: string;
let harnessPath: string;

// One Deno process runs the hosted calls, each with a fresh capability for its tool. A reply step does
// what mcp/index.ts does: reply_target with a channel_read capability, placement, then the command.
const harnessSource = `
const input = JSON.parse(await new Response(Deno.stdin.readable).text());
const command = await import(${JSON.stringify(commandUrl.href)});
const read = await import(${JSON.stringify(readUrl.href)});
const auth = await import(${JSON.stringify(authUrl.href)});
const tools = await import(${JSON.stringify(toolsUrl.href)});

async function capability(handle, tool, use) {
  return await command.db.begin(async (tx) => await auth.authenticateHostedSeatCapability(tx, {
    grantId: input.grant, providerGrantId: "provider-" + input.grant, handle, tool,
    providerStatus: async () => ({ active: true }),
  }, use));
}

const results = [];
for (const step of input.steps) {
  if (step.op === "read") {
    const cap = await capability(step.handle, step.tool, "read");
    if (cap === null) { results.push({ status: 403, body: { error: "no_capability" } }); continue; }
    results.push(await read.handleHostedRead({ workspace_id: input.workspace, ...step.input }, cap));
    continue;
  }
  const args = { seat: step.handle, signal_id: step.signal_id, body: "picked it up", request_id: step.request_id };
  const reader = await capability(step.handle, "channel_read", "read");
  const target = await read.handleHostedRead({ resource: "reply_target", workspace_id: input.workspace, signal_id: step.signal_id }, reader);
  const placement = tools.hostedReplyPlacement(args, target.body.thread_root_id ?? null, target.body.author ?? null);
  const mentions = tools.hostedMentions("reply", args, null, placement);
  const cap = await capability(step.handle, "reply", "command");
  const sent = await tools.sendHostedSignal("reply", args, input.workspace,
    { mentions, placement, implicitAuthor: tools.hostedImplicitAuthor(args, null, placement) },
    (body) => command.handleHostedCommand(body, cap));
  results.push({ status: sent.result.status, body: { ...sent.result.body, placement, author_not_notified: sent.authorNotNotified } });
}
console.log("HOSTED_REPLY_TARGET_RESULT:" + JSON.stringify(results));
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
  harnessDir = mkdtempSync(join(tmpdir(), "hosted-reply-target-"));
  harnessPath = join(harnessDir, "hosted-reply-target-harness.ts");
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
      VALUES (${f.owner}::uuid, 'authenticated', 'authenticated', ${`reply-target-${f.owner}@example.test`})`;
    await tx`INSERT INTO swarm.users (user_id, display_name) VALUES (${f.owner}::uuid, 'Reply target owner')`;
    await tx`INSERT INTO swarm.workspaces (workspace_id, name, created_by) VALUES (${f.workspace}::uuid, 'Reply target', ${f.owner}::uuid)`;
    await tx`INSERT INTO swarm.memberships (workspace_id, user_id, role) VALUES (${f.workspace}::uuid, ${f.owner}::uuid, 'owner')`;
    await tx`INSERT INTO swarm.streams (stream_id, workspace_id, kind) VALUES (${randomUUID()}::uuid, ${f.workspace}::uuid, 'workspace')`;
    for (const [principal, name] of [[f.principalA, "Target A"], [f.principalB, "Target B"]]) {
      await tx`INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name, transport, turn_only)
        VALUES (${principal}::uuid, ${f.workspace}::uuid, ${f.owner}::uuid, ${name}, 'hosted_mcp', true)`;
    }
    await tx`INSERT INTO swarm.hosted_mcp_grants (
      grant_id, provider_grant_id, owner_user_id, home_workspace_id, client_id, resource,
      selected_workspace_ids, manifest_digest, interaction_ref, state, created_at, activated_at
    ) VALUES (
      ${f.grant}::uuid, ${`provider-${f.grant}`}, ${f.owner}::uuid, ${f.workspace}::uuid, 'hosted-reply-target-client',
      'https://mcp.commonswarm.com/mcp', ${[f.workspace]}::uuid[], ${digest}, 'hosted-reply-target', 'active',
      statement_timestamp(), statement_timestamp()
    )`;
    await tx`INSERT INTO swarm.hosted_mcp_grant_workspaces (grant_id, workspace_id, owner_user_id, manifest_digest, consent_receipt_id, consented_at)
      VALUES (${f.grant}::uuid, ${f.workspace}::uuid, ${f.owner}::uuid, ${digest}, ${randomUUID()}::uuid, statement_timestamp())`;
    for (const [principal, name, h] of [[f.principalA, "Target A", f.handleA], [f.principalB, "Target B", f.handleB]]) {
      const seat = randomUUID();
      await tx`INSERT INTO swarm.hosted_mcp_seats (seat_id, grant_id, workspace_id, owner_user_id, principal_id, name, created_at)
        VALUES (${seat}::uuid, ${f.grant}::uuid, ${f.workspace}::uuid, ${f.owner}::uuid, ${principal}::uuid, ${name}, statement_timestamp())`;
      await tx`INSERT INTO swarm.hosted_mcp_seat_handles (handle, seat_id, grant_id, workspace_id, principal_id, created_at)
        VALUES (${h}, ${seat}::uuid, ${f.grant}::uuid, ${f.workspace}::uuid, ${principal}::uuid, statement_timestamp())`;
    }
  });
  return f;
}

function run(f: Fixture, steps: Step[]): Result[] {
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
      SWARM_CHAT_MENTIONS: "1",
    },
    timeout: 120_000,
  });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const line = result.stdout.trim().split("\n").reverse().find((entry) => entry.startsWith("HOSTED_REPLY_TARGET_RESULT:"));
  assert.equal(typeof line, "string", result.stdout);
  return JSON.parse((line ?? "").slice("HOSTED_REPLY_TARGET_RESULT:".length)) as Result[];
}

/** One message, written as the command edge stores it; `age` puts created_at and until in the past. */
async function message(f: Fixture, fields: {
  from?: string; fromKind?: "user" | "agent"; channel?: string | null; toUser?: string | null;
  threadRoot?: string | null; expired?: boolean;
} = {}): Promise<string> {
  const id = randomUUID();
  const created = fields.expired ? sql`statement_timestamp() - interval '2 hours'` : sql`statement_timestamp()`;
  const until = fields.expired ? sql`statement_timestamp() - interval '1 hour'` : sql`statement_timestamp() + interval '1 day'`;
  await sql`INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, kind, body, until, created_at,
      channel_id, to_user_id, thread_root_id)
    VALUES (${id}::uuid, ${f.workspace}::uuid, ${fields.from ?? f.owner}::uuid, ${fields.fromKind ?? "user"}, 'note',
      ${`reply target ${id}`}, ${until}, ${created}, ${fields.channel ?? null}::uuid, ${fields.toUser ?? null}::uuid,
      ${fields.threadRoot ?? null}::uuid)`;
  return id;
}

const target = (f: Fixture, signalId: string, extra: Partial<{ handle: string; tool: string; workspace_id: string }> = {}): Step => ({
  op: "read", handle: extra.handle ?? f.handleA, tool: extra.tool ?? "channel_read",
  input: { resource: "reply_target", signal_id: signalId, ...(extra.workspace_id === undefined ? {} : { workspace_id: extra.workspace_id }) },
});

test("reply_target admits what channel_read shows and answers every other target with the same null", { timeout: 180_000 }, async () => {
  const f = await seedFixture();
  const live = await message(f);
  const liveChild = await message(f, { from: f.principalB, fromKind: "agent", threadRoot: live });
  const expired = await message(f, { expired: true });
  const addressed = await message(f, { toUser: f.owner });
  const lock = randomUUID();
  await sql`INSERT INTO swarm.channels (channel_id, workspace_id, slug, created_by_principal, created_by_kind, created_at, visibility)
    VALUES (${lock}::uuid, ${f.workspace}::uuid, ${`lock-${lock.slice(0, 8)}`}, ${f.owner}::uuid, 'user', statement_timestamp(), 'private')`;
  await sql`INSERT INTO swarm.channel_members (workspace_id, channel_id, member_kind, agent_principal_id, added_by_kind, added_by_principal)
    VALUES (${f.workspace}::uuid, ${lock}::uuid, 'agent', ${f.principalB}::uuid, 'user', ${f.owner}::uuid)`;
  const hidden = await message(f, { from: f.principalB, fromKind: "agent", channel: lock });
  const unknown = randomUUID();

  const [liveRead, childRead, expiredRead, addressedRead, hiddenRead, unknownRead, wrongTool, wrongWorkspace, memberRead] = run(f, [
    target(f, live), target(f, liveChild), target(f, expired), target(f, addressed), target(f, hidden), target(f, unknown),
    target(f, live, { tool: "members" }),
    target(f, live, { workspace_id: randomUUID() }),
    // The channel's member reads its message: the private-channel gate is channel_read's, not a blanket refusal.
    target(f, hidden, { handle: f.handleB }),
  ]);
  assert.equal(liveRead!.status, 200, JSON.stringify(liveRead));
  assert.equal(liveRead!.body.thread_root_id, live);
  assert.deepEqual(liveRead!.body.author, { kind: "user", id: f.owner });
  assert.equal(childRead!.body.thread_root_id, live, "a message inside a thread answers its root");
  assert.deepEqual(childRead!.body.author, { kind: "agent", id: f.principalB });

  const answer = (result: Result | undefined) => ({ status: result!.status, thread_root_id: result!.body.thread_root_id, author: result!.body.author });
  const none = { status: 200, thread_root_id: null, author: null };
  for (const [name, result] of [["expired", expiredRead], ["addressed", addressedRead], ["hidden", hiddenRead], ["unknown", unknownRead]] as const) {
    assert.deepEqual(answer(result), none, name);
    assert.deepEqual(Object.keys(result!.body).sort(), Object.keys(unknownRead!.body).sort(), `${name} has the unknown id's shape`);
  }
  assert.equal(wrongTool!.status, 403, JSON.stringify(wrongTool));
  assert.equal(wrongWorkspace!.status, 403, JSON.stringify(wrongWorkspace));
  assert.equal(memberRead!.body.thread_root_id, hidden);
  assert.equal(memberRead!.body.author, null, "a seat is never its own author to notify");
  assert.equal(JSON.stringify([expiredRead, addressedRead, hiddenRead, unknownRead, wrongTool, wrongWorkspace]).includes("reply target"), false,
    "no message text in any answer");
});

test("the hosted reply places itself from reply_target: a thread for the live message, the old private refusal for the rest", { timeout: 180_000 }, async () => {
  const f = await seedFixture();
  const live = await message(f);
  const expired = await message(f, { expired: true });
  const unknown = randomUUID();
  const [toLive, toExpired, toUnknown] = run(f, [
    { op: "reply", handle: f.handleA, signal_id: live, request_id: `rt_live_${randomUUID().slice(0, 8)}` },
    { op: "reply", handle: f.handleA, signal_id: expired, request_id: `rt_expired_${randomUUID().slice(0, 8)}` },
    { op: "reply", handle: f.handleA, signal_id: unknown, request_id: `rt_unknown_${randomUUID().slice(0, 8)}` },
  ]);
  assert.equal(toLive!.status, 200, JSON.stringify(toLive));
  assert.deepEqual(toLive!.body.placement, { placement: "thread", threadRootId: live, author: { kind: "user", id: f.owner } });
  const stored = await sql<{ thread_root_id: string | null; in_reply_to: string | null }[]>`
    SELECT thread_root_id, in_reply_to FROM swarm.signals WHERE id = ${String((toLive!.body.signal as { id: string }).id)}::uuid`;
  assert.deepEqual({ thread_root_id: stored[0]!.thread_root_id, in_reply_to: stored[0]!.in_reply_to }, { thread_root_id: live, in_reply_to: null });
  const mentioned = await sql<{ mentioned_user_id: string | null }[]>`
    SELECT mentioned_user_id FROM swarm.signal_mentions WHERE signal_id = ${String((toLive!.body.signal as { id: string }).id)}::uuid`;
  assert.deepEqual(Array.from(mentioned, (row) => row.mentioned_user_id), [f.owner], "the reply notifies the author it answers");

  // Expired and unknown alike: placed privately, and refused by the server as a private reply always was.
  for (const [name, result, id] of [["expired", toExpired, expired], ["unknown", toUnknown, unknown]] as const) {
    assert.deepEqual(result!.body.placement, { placement: "private", inReplyTo: id, advisory: null }, name);
    assert.equal(result!.status, 403, `${name}: ${JSON.stringify(result)}`);
    assert.equal(result!.body.error, "forbidden");
  }
});
