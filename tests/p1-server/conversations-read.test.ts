/**
 * Conversations Step 2b (20261120000001) against real Postgres and served command/read functions:
 *  1. Member reads (`conversations`, `conversation_history`), cursor pagination (before/after),
 *     unread + mention counts, read-mark reset, and unjoined public-channel preview.
 *  2. Leave-hiding (group DM leave is final; private channel remove/re-invite) and uniform
 *     404 conversation_not_found non-oracle across unknown, left, inaccessible, and foreign-workspace IDs.
 *  3. V4 C2 human-only agent oversight (`conversation_oversight`, `conversation_oversight_history`):
 *     single-agent binding across BOTH membership and per-message audience on legacy addressed rows,
 *     refusal of narrower 2-other-member rows even when the human owns the other agent, denial when
 *     the human has left_at set, private-channel privacy wall (#433), and agent credential 403 refusal.
 *  4. DM / group-DM thread reply unblock (`conversation_id` + `thread_root_id`): 1:1 DM threads,
 *     group-DM agent-wake threads, 1-level-deep refusal, broadcast_to_channel refusal, cross-conversation
 *     and narrower-addressed root refusals, departed-member refusal, SQL privilege boundaries, and rollback drill.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { awaitFunctionRunning, observeFunctionCli } from "../support/edge-readiness.js";
import {
  parseConversationHistoryResponse,
  parseConversationsListResponse,
  parseOversightHistoryResponse,
  parseOversightListResponse,
} from "../../site/src/lib/conversations.js";

type Local = { API_URL: string; ANON_KEY: string; DB_URL: string; SERVICE_ROLE_KEY: string };
type Person = { id: string; jwt: string };
type Agent = { id: string; token: string; name: string };
type Row = Record<string, unknown>;

let local: Local;
let sql: postgres.Sql;
let admin: SupabaseClient;
let functionProcess: ReturnType<typeof spawn> | undefined;
let functionLogs = "";
let envDir: string | undefined;
let workspace: string;
let otherWorkspace: string;
let ann: Person; // owner
let ben: Person; // member
let cat: Person; // member
let annBotA: Agent; // owned by ann
let annBotB: Agent; // second agent owned by ann (tests single-agent binding in V4 C2)
let benBot: Agent; // owned by ben

function localEnvironment(): Local {
  const parsed = JSON.parse(execFileSync("supabase", ["status", "-o", "json"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000,
  })) as Partial<Local>;
  assert.ok(parsed.API_URL?.startsWith("http://127.0.0.1:"));
  assert.ok(parsed.ANON_KEY && parsed.DB_URL && parsed.SERVICE_ROLE_KEY);
  assert.equal(new URL(parsed.DB_URL!).hostname, "127.0.0.1");
  return parsed as Local;
}

async function createUser(label: string, name: string): Promise<Person> {
  const email = `${label}-${randomUUID()}@example.test`;
  const password = `T-${randomBytes(24).toString("base64url")}!`;
  const created = await admin.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { full_name: name },
  });
  assert.ifError(created.error);
  assert.ok(created.data.user);
  const client = createClient(local.API_URL, local.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const signed = await client.auth.signInWithPassword({ email, password });
  assert.ifError(signed.error);
  assert.ok(signed.data.session?.access_token);
  return { id: created.data.user!.id.toLowerCase(), jwt: signed.data.session!.access_token };
}

async function send(
  bearer: string,
  command: Row,
  ws: string = workspace,
  commandId: string = randomUUID(),
): Promise<{ status: number; body: Row }> {
  const response = await fetch(`${local.API_URL}/functions/v1/command`, {
    method: "POST",
    signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify({
      command_id: commandId,
      client_version: "0.1.0",
      workspace_id: ws,
      stream: { kind: "workspace" },
      command,
    }),
  });
  return { status: response.status, body: await response.json() as Row };
}

async function readResource(bearer: string, payload: Row): Promise<{ status: number; body: Row }> {
  const response = await fetch(`${local.API_URL}/functions/v1/read`, {
    method: "POST",
    signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${bearer}`, apikey: local.ANON_KEY, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() as Row };
}

const ok = (result: { status: number; body: Row }, label = ""): Row => {
  assert.equal(result.status, 200, `${label} ${JSON.stringify(result.body)} ${functionLogs.slice(-1500)}`);
  return result.body;
};

const note = (extra: Row = {}): Row => ({
  kind: "post_signal",
  signal_kind: "note",
  body: `conv2b ${randomUUID()}`,
  to_user_id: null,
  about: null,
  to_agent_principal_id: null,
  in_reply_to: null,
  ...extra,
});

const posted = async (bearer: string, extra: Row = {}, ws: string = workspace): Promise<Row> =>
  ok(await send(bearer, note(extra), ws), "post").signal as Row;

const uRef = (p: Person) => ({ kind: "user", id: p.id });
const aRef = (a: Agent) => ({ kind: "agent", id: a.id });

async function addWorkspaceMember(ws: string, person: Person, role: "owner" | "admin" | "member"): Promise<void> {
  const [{ id }] = await sql<{ id: string }[]>`
    INSERT INTO swarm.users (user_id, display_name) VALUES (${person.id}::uuid, ${role})
    ON CONFLICT (user_id) DO UPDATE SET display_name = EXCLUDED.display_name
    RETURNING user_id AS id
  `;
  assert.equal(id, person.id);
  await sql`
    INSERT INTO swarm.memberships (workspace_id, user_id, role, created_at)
    VALUES (${ws}::uuid, ${person.id}::uuid, ${role}, statement_timestamp())
    ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role, revoked_at = NULL
  `;
}

async function createAgent(owner: Person, name: string, ws: string = workspace): Promise<Agent> {
  const principalId = randomUUID();
  const deviceId = randomUUID();
  const runId = randomUUID();
  const rawToken = `swm_agt_${randomBytes(32).toString("base64url").slice(0, 43)}`;
  const hash = createHash("sha256").update(rawToken).digest();
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name, created_at)
      VALUES (${principalId}::uuid, ${ws}::uuid, ${owner.id}::uuid, ${name}, statement_timestamp())
    `;
    await tx`
      INSERT INTO swarm.agent_workspace_memberships (workspace_id, principal_id, owner_user_id, created_at)
      VALUES (${ws}::uuid, ${principalId}::uuid, ${owner.id}::uuid, statement_timestamp())
      ON CONFLICT (workspace_id, principal_id) DO NOTHING
    `;
    await tx`
      INSERT INTO swarm.agent_runs (run_id, principal_id, device_id)
      VALUES (${runId}::uuid, ${principalId}::uuid, ${deviceId}::uuid)
    `;
    await tx`
      INSERT INTO swarm.agent_tokens (token_id, principal_id, run_id, scopes, token_hash, expires_at, lineage_id)
      VALUES (
        ${randomUUID()}::uuid, ${principalId}::uuid, ${runId}::uuid,
        ${tx.json(["post_signal", "read_signals"])}::jsonb,
        ${hash}, statement_timestamp() + interval '4 hours', ${randomUUID()}::uuid
      )
    `;
  });
  return { id: principalId, token: rawToken, name };
}

async function expectDeniedAs(role: string, queryFn: (tx: postgres.TransactionSql) => Promise<unknown>): Promise<void> {
  await assert.rejects(
    async () => {
      await sql.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL ROLE ${role}`);
        await queryFn(tx);
      });
    },
    (err: unknown) => {
      const code = (err as { code?: string })?.code;
      return code === "42501";
    },
    `expected SQLSTATE 42501 as ${role}`,
  );
}

before(async () => {
  local = localEnvironment();
  sql = postgres(local.DB_URL, { max: 4 });
  admin = createClient(local.API_URL, local.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  ann = await createUser("conv2b-ann", "Ann");
  ben = await createUser("conv2b-ben", "Ben");
  cat = await createUser("conv2b-cat", "Cat");

  workspace = randomUUID();
  otherWorkspace = randomUUID();
  for (const ws of [workspace, otherWorkspace]) {
    await sql`
      INSERT INTO swarm.workspaces (workspace_id, name, created_by, created_at)
      VALUES (${ws}::uuid, ${`conv2b-${ws.slice(0, 6)}`}, ${ann.id}::uuid, statement_timestamp())
    `;
    await sql`
      INSERT INTO swarm.streams (stream_id, workspace_id, kind, created_at)
      VALUES (${randomUUID()}::uuid, ${ws}::uuid, 'workspace', statement_timestamp())
    `;
  }
  await addWorkspaceMember(workspace, ann, "owner");
  await addWorkspaceMember(workspace, ben, "member");
  await addWorkspaceMember(workspace, cat, "member");
  await addWorkspaceMember(otherWorkspace, ann, "owner");

  annBotA = await createAgent(ann, "AnnBotA", workspace);
  annBotB = await createAgent(ann, "AnnBotB", workspace);
  benBot = await createAgent(ben, "BenBot", workspace);

  envDir = mkdtempSync(join(tmpdir(), "cswarm-conv2b-env-"));
  const envFile = join(envDir, "edge.env");
  writeFileSync(envFile, "SWARM_ENV=test\nSWARM_CHAT_MENTIONS=1\n", { mode: 0o600 });

  functionProcess = spawn("supabase", ["functions", "serve", "--no-verify-jwt", "--env-file", envFile], {
    cwd: process.cwd(),
    env: { ...process.env, SWARM_ENV: "test" },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const cliState = observeFunctionCli(functionProcess);
  let startupSeen = false;
  const observe = (chunk: Buffer) => {
    functionLogs = (functionLogs + chunk.toString("utf8")).slice(-20_000);
    startupSeen ||= functionLogs.includes("Serving functions on");
  };
  functionProcess.stdout?.on("data", observe);
  functionProcess.stderr?.on("data", observe);
  const bootDeadline = Date.now() + 60_000;
  while (!startupSeen) {
    if (Date.now() >= bootDeadline || functionProcess.exitCode !== null) {
      throw new Error(`local functions serve did not start: ${functionLogs}`);
    }
    await delay(250);
  }
  await awaitFunctionRunning({
    url: `${local.API_URL}/functions/v1/command`,
    fetcher: fetch,
    timeoutMs: 30_000,
    sleep: (ms) => delay(ms),
    now: () => Date.now(),
    diagnostics: () => `local command function not ready: ${functionLogs}`,
    cliState,
  });
  await awaitFunctionRunning({
    url: `${local.API_URL}/functions/v1/read`,
    fetcher: fetch,
    timeoutMs: 30_000,
    sleep: (ms) => delay(ms),
    now: () => Date.now(),
    diagnostics: () => `local read function not ready: ${functionLogs}`,
    cliState,
  });
}, { timeout: 60_000 });

after(async () => {
  functionProcess?.kill("SIGTERM");
  await sql?.end({ timeout: 5 });
  if (envDir) rmSync(envDir, { recursive: true, force: true });
});

test("1. Member reads: conversations list, public preview, unread/mention counts, mark-read, and cursor pagination", { timeout: 60_000 }, async () => {
  // Ann creates a public channel #design (ann auto-joins; annBotA does NOT auto-join).
  const createdCh = ok(await send(ann.jwt, {
    kind: "channel_create", slug: "design", description: "Design room",
  }), "create #design");
  const chId = String((createdCh.channel as Row).channel_id);

  // Ann posts 5 messages into #design, mentioning ben on the 4th and adding a reaction on the 5th.
  const msgs: Row[] = [];
  for (let i = 1; i <= 5; i++) {
    await delay(15);
    const extra: Row = { conversation_id: chId, body: `design msg ${i}` };
    if (i === 4) extra.mentions = [uRef(ben)];
    msgs.push(await posted(ann.jwt, extra));
  }
  ok(await send(ann.jwt, { kind: "add_reaction", signal_id: String(msgs[4]!.id), emoji: "🔥" }), "react");

  // Ben joins #design? First check preview before joining: ben has NOT joined #design yet!
  const benListBefore = ok(await readResource(ben.jwt, {
    resource: "conversations", workspace_id: workspace, include_archived: false,
  }), "ben list before join");
  const parsedBenList = parseConversationsListResponse(benListBefore);
  const designBefore = parsedBenList.find((c) => c.conversationId === chId);
  assert.ok(designBefore, "public channel appears in conversations directory");
  assert.equal(designBefore!.joined, false, "unjoined public channel reports joined=false");
  assert.equal(designBefore!.slug, "design");

  // Unjoined public channel preview reads history cleanly with browser decoder compatibility.
  const previewRes = await readResource(ben.jwt, {
    resource: "conversation_history", workspace_id: workspace, conversation_id: chId,
    limit: 2, include_mentions: true, include_reactions: true,
  });
  const preview = parseConversationHistoryResponse(previewRes.status, previewRes.body, (r) => ({ id: String(r.id) }));
  assert.equal(preview.ok, true);
  if (!preview.ok) return;
  assert.equal(preview.conversation.joined, false);
  assert.equal(preview.hasMore, true);
  assert.deepEqual(preview.messages.map((m) => m.id), [String(msgs[3]!.id), String(msgs[4]!.id)]);
  assert.equal(preview.nextBefore?.id, String(msgs[3]!.id));
  assert.equal(preview.nextAfter?.id, String(msgs[4]!.id));
  // Verify mentions & reactions came back on the raw JSON rows.
  const rawMsgs = previewRes.body.messages as Row[];
  assert.equal((rawMsgs[0]!.mentions as Row[]).length, 1);
  assert.equal((rawMsgs[1]!.reactions as Row[]).length, 1);

  // Page backward with before cursor -> msgs[1], msgs[2].
  const olderRes = ok(await readResource(ben.jwt, {
    resource: "conversation_history", workspace_id: workspace, conversation_id: chId,
    before_created_at: preview.nextBefore!.createdAt, before_id: preview.nextBefore!.id, limit: 2,
  }), "page backward");
  assert.equal(olderRes.has_more, true);
  assert.deepEqual((olderRes.messages as Row[]).map((m) => m.id), [String(msgs[1]!.id), String(msgs[2]!.id)]);

  // Page forward with after cursor from msgs[1] -> msgs[2], msgs[3].
  const newerRes = ok(await readResource(ben.jwt, {
    resource: "conversation_history", workspace_id: workspace, conversation_id: chId,
    after_created_at: String(msgs[1]!.created_at), after_id: String(msgs[1]!.id), limit: 2,
  }), "page forward");
  assert.equal(newerRes.has_more, true);
  assert.deepEqual((newerRes.messages as Row[]).map((m) => m.id), [String(msgs[2]!.id), String(msgs[3]!.id)]);

  // Ben joins #design -> unread_count = 5, mention_count = 1; mark_read through msgs[4] resets both to 0!
  ok(await send(ben.jwt, { kind: "conversation_join", conversation_id: chId }), "ben join #design");
  const benJoinedList = parseConversationsListResponse(ok(await readResource(ben.jwt, {
    resource: "conversations", workspace_id: workspace,
  }), "ben joined list"));
  const designJoined = benJoinedList.find((c) => c.conversationId === chId)!;
  assert.equal(designJoined.joined, true);
  assert.equal(designJoined.unreadCount, 5);
  assert.equal(designJoined.mentionCount, 1);

  ok(await send(ben.jwt, {
    kind: "conversation_mark_read", conversation_id: chId, through_signal_id: String(msgs[4]!.id),
  }), "mark read");
  const benReadList = parseConversationsListResponse(ok(await readResource(ben.jwt, {
    resource: "conversations", workspace_id: workspace,
  }), "ben after mark-read"));
  const designRead = benReadList.find((c) => c.conversationId === chId)!;
  assert.equal(designRead.unreadCount, 0);
  assert.equal(designRead.mentionCount, 0);
  assert.equal(designRead.readThroughId, String(msgs[4]!.id));

  // Agent token can list and read conversations too.
  const agentList = parseConversationsListResponse(ok(await readResource(annBotA.token, {
    resource: "conversations", workspace_id: workspace,
  }), "agent list"));
  assert.ok(agentList.some((c) => c.kind === "general" && c.joined));
  assert.ok(agentList.some((c) => c.conversationId === chId && !c.joined));
});

test("2. Leave-hiding & uniform 404 conversation_not_found non-oracle (group DM, private channel, foreign workspace)", { timeout: 60_000 }, async () => {
  // Open a group DM with ann, ben, cat.
  const grpOpen = ok(await send(ann.jwt, {
    kind: "conversation_open", members: [uRef(ben), uRef(cat)],
  }), "open group");
  const grpId = String((grpOpen.conversation as Row).conversation_id);
  await posted(ann.jwt, { conversation_id: grpId, body: "group secret" });

  // Cat reads group before leaving -> 200.
  const catBefore = ok(await readResource(cat.jwt, {
    resource: "conversation_history", workspace_id: workspace, conversation_id: grpId,
  }), "cat before leave");
  assert.equal((catBefore.messages as Row[]).length, 1);

  // Cat leaves group -> immediately hidden from conversations list AND uniform 404 on history!
  ok(await send(cat.jwt, { kind: "conversation_leave", conversation_id: grpId }), "cat leave");
  const catListAfter = parseConversationsListResponse(ok(await readResource(cat.jwt, {
    resource: "conversations", workspace_id: workspace,
  }), "cat list after leave"));
  assert.equal(catListAfter.some((c) => c.conversationId === grpId), false);

  const unknownId = randomUUID();
  const resLeft = await readResource(cat.jwt, {
    resource: "conversation_history", workspace_id: workspace, conversation_id: grpId,
  });
  const resUnknown = await readResource(cat.jwt, {
    resource: "conversation_history", workspace_id: workspace, conversation_id: unknownId,
  });
  assert.equal(resLeft.status, 404);
  assert.equal(resUnknown.status, 404);
  assert.deepEqual(resLeft.body, resUnknown.body, "left group and unknown UUID must return byte-identical 404");

  // Private channel remove hides history, re-invite restores it!
  const priv = ok(await send(ann.jwt, {
    kind: "channel_create", slug: "priv-hide", visibility: "private", members: [uRef(ben)],
  }), "create priv");
  const privId = String((priv.channel as Row).channel_id);
  await posted(ann.jwt, { conversation_id: privId, body: "private history" });

  // Cat (never a member) gets identical 404.
  const resInaccessible = await readResource(cat.jwt, {
    resource: "conversation_history", workspace_id: workspace, conversation_id: privId,
  });
  assert.equal(resInaccessible.status, 404);
  assert.deepEqual(resInaccessible.body, resUnknown.body);

  // Ben reads -> 200; removed -> 404; re-added -> 200 with full history!
  assert.equal((await readResource(ben.jwt, {
    resource: "conversation_history", workspace_id: workspace, conversation_id: privId,
  })).status, 200);
  ok(await send(ann.jwt, { kind: "channel_member_remove", channel_id: privId, member: uRef(ben) }), "remove ben");
  const benRemoved = await readResource(ben.jwt, {
    resource: "conversation_history", workspace_id: workspace, conversation_id: privId,
  });
  assert.equal(benRemoved.status, 404);
  assert.deepEqual(benRemoved.body, resUnknown.body);

  ok(await send(ann.jwt, { kind: "channel_member_add", channel_id: privId, members: [uRef(ben)] }), "re-add ben");
  const benRestored = ok(await readResource(ben.jwt, {
    resource: "conversation_history", workspace_id: workspace, conversation_id: privId,
  }), "ben restored");
  assert.equal((benRestored.messages as Row[]).length, 1);

  // Foreign-workspace isolation for agent token.
  const foreignList = ok(await readResource(annBotA.token, {
    resource: "conversations", workspace_id: otherWorkspace,
  }), "foreign agent list");
  assert.deepEqual(foreignList.conversations, []);
  const foreignHist = await readResource(annBotA.token, {
    resource: "conversation_history", workspace_id: otherWorkspace, conversation_id: privId,
  });
  assert.equal(foreignHist.status, 404);
  assert.deepEqual(foreignHist.body, resUnknown.body);
});

test("3. V4 C2 human-only oversight: single-agent dual gate on addressed rows, left_at denial, and private-channel wall", { timeout: 60_000 }, async () => {
  // Agent token is refused 403 on oversight routes.
  const agentOverList = await readResource(annBotA.token, {
    resource: "conversation_oversight", workspace_id: workspace, agent_principal_id: annBotA.id,
  });
  assert.equal(agentOverList.status, 403);
  assert.equal(agentOverList.body.error, "credential_kind_forbidden");

  // Unowned agent (benBot) returns uniform 404 to ann.
  const unownedOver = await readResource(ann.jwt, {
    resource: "conversation_oversight", workspace_id: workspace, agent_principal_id: benBot.id,
  });
  assert.equal(unownedOver.status, 404);
  assert.equal(unownedOver.body.error, "conversation_not_found");

  // Private channel with ben + annBotA ONLY (ann is NOT a member): MUST NOT leak through oversight!
  const benPriv = ok(await send(ben.jwt, {
    kind: "channel_create", slug: "ben-priv-bot", visibility: "private", members: [aRef(annBotA)],
  }), "ben priv with annBotA");
  const benPrivId = String((benPriv.channel as Row).channel_id);
  await posted(ben.jwt, { conversation_id: benPrivId, body: "private channel secret for annBotA" });

  // Group DM with ben, annBotA (ann's), annBotB (ann's), cat (ann is NOT a member):
  const grpOpen = ok(await send(ben.jwt, {
    kind: "conversation_open", members: [aRef(annBotA), aRef(annBotB), uRef(cat)],
  }), "open oversight group");
  const grpId = String((grpOpen.conversation as Row).conversation_id);
  const convMsg = await posted(ben.jwt, { conversation_id: grpId, body: "everyone in group" });

  // Verify ann's member `conversations` list NEVER contains grpId or benPrivId!
  const annMemberList = parseConversationsListResponse(ok(await readResource(ann.jwt, {
    resource: "conversations", workspace_id: workspace,
  }), "ann member list"));
  assert.equal(annMemberList.some((c) => c.conversationId === grpId), false, "oversight group must NEVER enter member list");
  assert.equal(annMemberList.some((c) => c.conversationId === benPrivId), false, "private channel must NEVER enter member list");

  // Ann's oversight list for annBotA lists grpId (read_only: true, no unread/notify fields) and EXCLUDES benPrivId!
  const annOverList = parseOversightListResponse(ok(await readResource(ann.jwt, {
    resource: "conversation_oversight", workspace_id: workspace, agent_principal_id: annBotA.id,
  }), "ann oversight list"));
  assert.ok(annOverList.some((c) => c.conversationId === grpId && c.readOnly === true));
  assert.equal(annOverList.some((c) => c.conversationId === benPrivId), false, "private channel must NOT appear in oversight");

  // Private channel oversight history returns 404.
  const privOverHist = await readResource(ann.jwt, {
    resource: "conversation_oversight_history", workspace_id: workspace,
    conversation_id: benPrivId, agent_principal_id: annBotA.id,
  });
  assert.equal(privOverHist.status, 404);

  // Verify V4 C2 dual-gate on the SAME conversation using `conversation_signals` with `audience = 'addressed'`
  // (via a thread reply under convMsg? Wait: a thread reply in grpId with `audience = 'addressed'`!):
  // Let's plant a backfilled/pre-existing signal (older creation_xact_id so deferred trigger won't run on it) directly
  // in grpId with audience='addressed' to test BOTH halves of V4 C2!
  const narrowForA = randomUUID();
  const narrowOnlyB = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`
      INSERT INTO swarm.signals (id, workspace_id, from_kind, from_principal, to_agent_principal_id, kind, body, until, created_at)
      VALUES
        (${narrowForA}::uuid, ${workspace}::uuid, 'user', ${ben.id}::uuid, ${annBotA.id}::uuid,
         'note', 'legacy narrow for A', statement_timestamp() + interval '1 day', statement_timestamp() + interval '3 seconds'),
        (${narrowOnlyB}::uuid, ${workspace}::uuid, 'user', ${ben.id}::uuid, ${annBotB.id}::uuid,
         'note', 'legacy narrow ONLY for B', statement_timestamp() + interval '1 day', statement_timestamp() + interval '4 seconds')
    `;
    await tx`
      INSERT INTO swarm.conversation_signals (signal_id, workspace_id, conversation_id, created_at, audience)
      VALUES
        (${narrowForA}::uuid, ${workspace}::uuid, ${grpId}::uuid, statement_timestamp() + interval '3 seconds', 'addressed'),
        (${narrowOnlyB}::uuid, ${workspace}::uuid, ${grpId}::uuid, statement_timestamp() + interval '4 seconds', 'addressed')
    `;
  });

  const overHistRes = await readResource(ann.jwt, {
    resource: "conversation_oversight_history", workspace_id: workspace,
    conversation_id: grpId, agent_principal_id: annBotA.id,
  });
  const overHist = parseOversightHistoryResponse(overHistRes.status, overHistRes.body, (r) => ({ id: String(r.id) }));
  assert.equal(overHist.ok, true);
  if (!overHist.ok) return;
  const seenIds = overHist.messages.map((m) => m.id);
  assert.ok(seenIds.includes(String(convMsg.id)), "conversation-audience row visible");
  assert.ok(seenIds.includes(narrowForA), "V4 C2 positive: legacy addressed row where annBotA IS recipient is visible");
  assert.ok(!seenIds.includes(narrowOnlyB), "V4 C2 negative: legacy addressed row for ben+annBotB MUST be hidden from annBotA oversight even though ann owns annBotB");

  // Human with left_at set is DENIED oversight even while their owned agent remains a live member!
  const grpWithAnn = ok(await send(ann.jwt, {
    kind: "conversation_open", members: [uRef(ben), aRef(annBotA)],
  }), "open group with ann + ben + annBotA");
  const grpWithAnnId = String((grpWithAnn.conversation as Row).conversation_id);
  await posted(ben.jwt, { conversation_id: grpWithAnnId, body: "before ann left" });
  ok(await send(ann.jwt, { kind: "conversation_leave", conversation_id: grpWithAnnId }), "ann leaves group");

  const overAfterLeaveList = parseOversightListResponse(ok(await readResource(ann.jwt, {
    resource: "conversation_oversight", workspace_id: workspace, agent_principal_id: annBotA.id,
  }), "oversight list after ann left"));
  assert.equal(overAfterLeaveList.some((c) => c.conversationId === grpWithAnnId), false, "left_at human must NOT see left group in oversight list");
  const overAfterLeaveHist = await readResource(ann.jwt, {
    resource: "conversation_oversight_history", workspace_id: workspace,
    conversation_id: grpWithAnnId, agent_principal_id: annBotA.id,
  });
  assert.equal(overAfterLeaveHist.status, 404, "left_at human must get 404 on oversight history");
});

test("4. DM & group-DM thread replies unblock, security fences, SQL privilege denials, and clean rollback", { timeout: 60_000 }, async () => {
  // Open 1:1 DM (ann <-> ben) and another 1:1 DM (ann <-> cat).
  const dmAB = String(((ok(await send(ann.jwt, {
    kind: "conversation_open", members: [uRef(ben)],
  }), "open dmAB")).conversation as Row).conversation_id);
  const dmAC = String(((ok(await send(ann.jwt, {
    kind: "conversation_open", members: [uRef(cat)],
  }), "open dmAC")).conversation as Row).conversation_id);

  const rootAB = await posted(ann.jwt, { conversation_id: dmAB, body: "DM root" });
  const rootAC = await posted(ann.jwt, { conversation_id: dmAC, body: "Other DM root" });

  // Reply in 1:1 DM thread using conversation_id + thread_root_id -> 200!
  const replyAB = await posted(ben.jwt, {
    conversation_id: dmAB, thread_root_id: String(rootAB.id), body: "DM thread reply",
  });
  assert.equal(replyAB.thread_root_id, rootAB.id);

  // Verify reply appears in dmAB conversation_history with thread_root_id!
  const histAB = ok(await readResource(ann.jwt, {
    resource: "conversation_history", workspace_id: workspace, conversation_id: dmAB,
  }), "dmAB history");
  assert.ok((histAB.messages as Row[]).some((m) => m.id === replyAB.id && m.thread_root_id === rootAB.id));

  // 1-level-deep enforcement: replying to replyAB as thread_root_id -> 400 thread_root_is_a_reply!
  const nested = await send(ann.jwt, note({
    conversation_id: dmAB, thread_root_id: String(replyAB.id), body: "nested reply",
  }));
  assert.equal(nested.status, 400);
  assert.equal(nested.body.error, "thread_root_is_a_reply");

  // broadcast_to_channel: true in DM -> 400 conversation_address!
  const bcast = await send(ann.jwt, note({
    conversation_id: dmAB, thread_root_id: String(rootAB.id), broadcast_to_channel: true, body: "bad bcast",
  }));
  assert.equal(bcast.status, 400);
  assert.equal(bcast.body.error, "conversation_address");

  // Cross-conversation root (dmAB conversation_id + dmAC root) -> 404 thread_root_not_found!
  const cross = await send(ann.jwt, note({
    conversation_id: dmAB, thread_root_id: String(rootAC.id), body: "cross conv",
  }));
  assert.equal(cross.status, 404);
  assert.equal(cross.body.error, "thread_root_not_found");

  // Group DM agent thread reply waking specific agent via `to`!
  const grpAgents = String(((ok(await send(ann.jwt, {
    kind: "conversation_open", members: [aRef(annBotA), aRef(benBot)],
  }), "open agent group")).conversation as Row).conversation_id);
  const grpRoot = await posted(ann.jwt, { conversation_id: grpAgents, body: "group thread root" });
  const agentReply = await posted(annBotA.token, {
    conversation_id: grpAgents, thread_root_id: String(grpRoot.id), to: [aRef(benBot)], body: "agent thread reply",
  });
  assert.equal(agentReply.thread_root_id, grpRoot.id);

  // Unaddressed group-DM post (annBotA posts without waking benBot -> audience='conversation'):
  // benBot can read it in conversation_history AND mark read through it (Step 2b mark_read upgrade).
  const unaddressedPost = await posted(annBotA.token, {
    conversation_id: grpAgents, body: "group update not waking benBot",
  });
  ok(await send(benBot.token, {
    kind: "conversation_mark_read", conversation_id: grpAgents, read_through_signal_id: String(unaddressedPost.id),
  }), "benBot marks read through unaddressed audience=conversation group post");

  // Narrower legacy `addressed` root in grpAgents (ann -> annBotA ONLY, excluding benBot):
  // hanging a conversation-audience thread reply off it MUST be refused (404 thread_root_not_found)!
  const narrowRootId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`
      INSERT INTO swarm.signals (id, workspace_id, from_kind, from_principal, to_agent_principal_id, kind, body, until, created_at)
      VALUES (${narrowRootId}::uuid, ${workspace}::uuid, 'user', ${ann.id}::uuid, ${annBotA.id}::uuid,
              'note', 'narrow root excluding benBot', statement_timestamp() + interval '1 day', statement_timestamp())
    `;
    await tx`
      INSERT INTO swarm.conversation_signals (signal_id, workspace_id, conversation_id, created_at, audience)
      VALUES (${narrowRootId}::uuid, ${workspace}::uuid, ${grpAgents}::uuid, statement_timestamp(), 'addressed')
    `;
  });
  const narrowThread = await send(ann.jwt, note({
    conversation_id: grpAgents, thread_root_id: narrowRootId, body: "attempt to leak narrow root",
  }));
  assert.equal(narrowThread.status, 404);
  assert.equal(narrowThread.body.error, "thread_root_not_found");

  // SQL privilege boundary checks: authenticated & anon CANNOT call Step 2b functions directly.
  for (const role of ["authenticated", "anon"]) {
    await expectDeniedAs(role, (tx) => tx`SELECT swarm_read.conversations(${workspace}::uuid, false)`);
    await expectDeniedAs(role, (tx) => tx`SELECT swarm_read.conversation_history(${workspace}::uuid, ${dmAB}::uuid)`);
    await expectDeniedAs(role, (tx) => tx`SELECT swarm_read.conversation_oversight(${workspace}::uuid, ${annBotA.id}::uuid)`);
    await expectDeniedAs(role, (tx) => tx`SELECT swarm_read.conversation_oversight_history(${workspace}::uuid, ${dmAB}::uuid, ${annBotA.id}::uuid)`);
    await expectDeniedAs(role, (tx) => tx`SELECT * FROM swarm.conversation_thread_root(${workspace}::uuid, ${dmAB}::uuid, ${String(rootAB.id)}::uuid)`);
  }

  // Rollback + re-apply drill inside a rolled-back transaction (leaves live DB untouched).
  const rollbackSql = readFileSync(
    new URL("../../deploy/release-proofs/conversations-2b/20261120000001-rollback.sql", import.meta.url),
    "utf8",
  );
  const migrationSql = readFileSync(
    new URL("../../supabase/migrations/20261120000001_conversations_reads.sql", import.meta.url),
    "utf8",
  );
  await sql.begin(async (tx) => {
    await tx.unsafe(rollbackSql);
    const [{ gone }] = await tx<{ gone: boolean }[]>`
      SELECT to_regprocedure('swarm_read.conversations(uuid,boolean)') IS NULL
         AND to_regprocedure('swarm_read.conversation_oversight_history(uuid,uuid,uuid,timestamptz,uuid,timestamptz,uuid,integer,boolean,boolean)') IS NULL
         AND to_regprocedure('swarm.conversation_thread_root(uuid,uuid,uuid)') IS NULL AS gone
    `;
    assert.equal(gone, true, "rollback must drop every Step 2b function cleanly");
    await tx.unsafe(migrationSql);
    const [{ back }] = await tx<{ back: boolean }[]>`
      SELECT to_regprocedure('swarm_read.conversations(uuid,boolean)') IS NOT NULL
         AND to_regprocedure('swarm.conversation_thread_root(uuid,uuid,uuid)') IS NOT NULL AS back
    `;
    assert.equal(back, true, "migration must re-apply cleanly after rollback");
    throw new Error("ROLLBACK_DRILL_OK");
  }).catch((err: unknown) => {
    assert.equal((err as Error).message, "ROLLBACK_DRILL_OK");
  });
});
